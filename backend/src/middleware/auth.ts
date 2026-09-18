import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { CookieOptions, NextFunction, Request, Response } from 'express';
import { env } from '../config/env.js';
import { SessionModel, UserModel } from '../models/index.js';
import { ApiError } from './error.js';

export const SESSION_COOKIE = 'twinrx_session';
export const CSRF_COOKIE = 'twinrx_csrf';
export const CSRF_HEADER = 'x-csrf-token';

export type SessionContext = {
  sessionId: string;
  userId: string;
  clinicId: string;
  role: 'doctor' | 'admin';
  email: string;
  displayName: string;
};

declare global {
  namespace Express {
    interface Request {
      session?: SessionContext;
    }
  }
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function cookieOptions(maxAgeMs: number): CookieOptions {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: env().COOKIE_SECURE,
    path: '/',
    maxAge: maxAgeMs,
  };
}

export async function createSession(
  res: Response,
  user: { _id: string; clinic_id: string; role: 'doctor' | 'admin'; email: string; display_name: string },
): Promise<{ csrfToken: string }> {
  const token = randomBytes(32).toString('base64url');
  const csrfToken = randomBytes(24).toString('base64url');
  const ttlMs = env().SESSION_TTL_HOURS * 3_600_000;

  await SessionModel.create({
    user_id: user._id,
    clinic_id: user.clinic_id,
    role: user.role,
    token_hash: hashToken(token),
    csrf_token: csrfToken,
    expires_at: new Date(Date.now() + ttlMs),
  });

  res.cookie(SESSION_COOKIE, token, cookieOptions(ttlMs));
  // Readable by the SPA on purpose: it is the double-submit half of CSRF protection.
  res.cookie(CSRF_COOKIE, csrfToken, { ...cookieOptions(ttlMs), httpOnly: false });
  return { csrfToken };
}

export async function destroySession(req: Request, res: Response): Promise<void> {
  const token = req.cookies?.[SESSION_COOKIE];
  if (token) {
    await SessionModel.updateOne({ token_hash: hashToken(token) }, { $set: { revoked_at: new Date() } });
  }
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  res.clearCookie(CSRF_COOKIE, { path: '/' });
}

/** Attaches req.session when a live session cookie is present. Never throws. */
export async function loadSession(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const token = req.cookies?.[SESSION_COOKIE];
    if (!token) return next();
    const session = await SessionModel.findOne({
      token_hash: hashToken(token),
      revoked_at: null,
      expires_at: { $gt: new Date() },
    }).lean();
    if (!session) return next();

    const user = await UserModel.findById(session.user_id).lean();
    if (!user || !user.active) return next();

    req.session = {
      sessionId: String(session._id),
      userId: String(user._id),
      // clinic_id always comes from the server session, never from the client (spec 3).
      clinicId: String(user.clinic_id),
      role: user.role as 'doctor' | 'admin',
      email: user.email,
      displayName: user.display_name,
    };
    next();
  } catch (err) {
    next(err);
  }
}

export function requireSession(req: Request, _res: Response, next: NextFunction): void {
  if (!req.session) return next(ApiError.unauthorized());
  next();
}

export function requireRole(...roles: Array<'doctor' | 'admin'>) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.session) return next(ApiError.unauthorized());
    if (!roles.includes(req.session.role)) return next(ApiError.forbidden());
    next();
  };
}

export function sessionOf(req: Request): SessionContext {
  if (!req.session) throw ApiError.unauthorized();
  return req.session;
}

/** Double-submit CSRF for cookie-authenticated writes (spec 13). */
export function csrfProtection(req: Request, _res: Response, next: NextFunction): void {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (!req.session) return next(ApiError.unauthorized());

  const header = req.get(CSRF_HEADER) ?? '';
  const cookie = req.cookies?.[CSRF_COOKIE] ?? '';
  const a = Buffer.from(header);
  const b = Buffer.from(cookie);
  if (a.length === 0 || a.length !== b.length || !timingSafeEqual(a, b)) {
    return next(new ApiError(403, 'CSRF_TOKEN_INVALID', 'CSRF tokeni mos kelmadi.'));
  }
  next();
}
