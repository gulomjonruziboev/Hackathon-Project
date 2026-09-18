import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import { env } from './config/env.js';
import { buildApiRouter } from './api/v1/index.js';
import { loadSession } from './middleware/auth.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';
import { requestContext } from './middleware/requestId.js';

export function createApp(): Express {
  const config = env();
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  app.use(helmet({ crossOriginResourcePolicy: { policy: 'same-site' } }));
  app.use(
    cors({
      // Only the configured origins; credentials are cookies, so `*` is unusable.
      origin(origin, callback) {
        if (!origin || config.corsOrigins.includes(origin)) return callback(null, true);
        callback(new Error('CORS: ruxsat etilmagan origin'));
      },
      credentials: true,
      allowedHeaders: ['Content-Type', 'X-CSRF-Token', 'Idempotency-Key'],
      exposedHeaders: ['X-Request-Id'],
    }),
  );

  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());
  app.use(requestContext);
  app.use(loadSession);

  app.use('/api/v1', buildApiRouter());

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
