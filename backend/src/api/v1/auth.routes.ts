import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { createSession, destroySession, requireSession, sessionOf } from '../../middleware/auth.js';
import { ApiError } from '../../middleware/error.js';
import { rateLimit } from '../../middleware/rateLimit.js';
import { ClinicModel, UserModel } from '../../models/index.js';
import { recordAudit } from '../../services/auditService.js';

const loginSchema = z.object({
  email: z.email('Email formati noto‘g‘ri.'),
  password: z.string().min(1, 'Parol kiritilmagan.'),
});

export const authRouter: Router = Router();

authRouter.post(
  '/auth/login',
  rateLimit({ windowMs: 60_000, max: 10, keyPrefix: 'login' }),
  async (req, res, next) => {
    try {
      const { email, password } = loginSchema.parse(req.body);
      const user = await UserModel.findOne({ email: email.toLowerCase() });

      // UI-01: one generic message, so the response never reveals which half failed.
      const invalid = ApiError.unauthorized('Email yoki parol noto‘g‘ri.');
      if (!user || !user.active) {
        await bcrypt.compare(password, '$2b$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidin');
        throw invalid;
      }
      if (!(await bcrypt.compare(password, user.password_hash))) throw invalid;

      const { csrfToken } = await createSession(res, {
        _id: String(user._id),
        clinic_id: user.clinic_id,
        role: user.role,
        email: user.email,
        display_name: user.display_name,
      });

      await recordAudit({
        clinicId: user.clinic_id,
        actorId: String(user._id),
        action: 'auth.login',
        entityType: 'user',
        entityId: String(user._id),
        requestId: res.locals.requestId,
      });

      const clinic = await ClinicModel.findById(user.clinic_id).lean();
      res.json({
        user: {
          id: String(user._id),
          email: user.email,
          display_name: user.display_name,
          role: user.role,
          clinic: { id: user.clinic_id, name: clinic?.name ?? '—' },
        },
        csrf_token: csrfToken,
        app_env: env().APP_ENV,
        is_demo: env().APP_ENV === 'demo',
      });
    } catch (err) {
      next(err);
    }
  },
);

authRouter.post('/auth/logout', requireSession, async (req, res, next) => {
  try {
    const session = sessionOf(req);
    await destroySession(req, res);
    await recordAudit({
      clinicId: session.clinicId,
      actorId: session.userId,
      action: 'auth.logout',
      entityType: 'user',
      entityId: session.userId,
      requestId: res.locals.requestId,
    });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

authRouter.get('/auth/me', requireSession, async (req, res, next) => {
  try {
    const session = sessionOf(req);
    const clinic = await ClinicModel.findById(session.clinicId).lean();
    res.json({
      user: {
        id: session.userId,
        email: session.email,
        display_name: session.displayName,
        role: session.role,
        clinic: { id: session.clinicId, name: clinic?.name ?? '—' },
      },
      app_env: env().APP_ENV,
      is_demo: env().APP_ENV === 'demo',
    });
  } catch (err) {
    next(err);
  }
});
