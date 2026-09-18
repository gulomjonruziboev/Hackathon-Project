import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

/** Spec 14 "Kuzatuv": request id, duration and status — never patient text. */
export function requestContext(req: Request, res: Response, next: NextFunction): void {
  const requestId = randomUUID();
  res.locals.requestId = requestId;
  res.setHeader('X-Request-Id', requestId);

  const started = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    if (process.env.NODE_ENV === 'test' || process.env.VITEST) return;
    console.log(
      JSON.stringify({
        request_id: requestId,
        method: req.method,
        path: req.route?.path ? req.baseUrl + req.route.path : req.path,
        status: res.statusCode,
        duration_ms: Math.round(ms),
      }),
    );
  });

  next();
}
