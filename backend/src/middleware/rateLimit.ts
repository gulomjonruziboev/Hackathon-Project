import type { NextFunction, Request, Response } from 'express';
import { ApiError } from './error.js';

type Bucket = { count: number; resetAt: number };

/**
 * Small in-process limiter for the login and AI endpoints (spec 13).
 * Single-node only; a real deployment would move this to shared storage.
 */
export function rateLimit(opts: { windowMs: number; max: number; keyPrefix: string }) {
  const buckets = new Map<string, Bucket>();

  return (req: Request, _res: Response, next: NextFunction): void => {
    const now = Date.now();
    const identity = req.session?.userId ?? req.ip ?? 'unknown';
    const key = `${opts.keyPrefix}:${identity}`;

    const bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + opts.windowMs });
      return next();
    }
    if (bucket.count >= opts.max) return next(ApiError.tooManyRequests());
    bucket.count += 1;
    next();
  };
}
