import { Router } from 'express';
import { csrfProtection } from '../../middleware/auth.js';
import { analysisRouter } from './analysis.routes.js';
import { authRouter } from './auth.routes.js';
import { catalogRouter } from './catalog.routes.js';
import { extractionsRouter } from './extractions.routes.js';
import { patientsRouter } from './patients.routes.js';

export function buildApiRouter(): Router {
  const router = Router();

  // Login is the one write that runs before a CSRF cookie can exist; every
  // other cookie-authenticated write carries the double-submit token (spec 13).
  router.use((req, res, next) => {
    if (req.path === '/auth/login') return next();
    csrfProtection(req, res, next);
  });

  router.use(authRouter);
  router.use(catalogRouter);
  router.use(patientsRouter);
  router.use(extractionsRouter);
  router.use(analysisRouter);

  return router;
}
