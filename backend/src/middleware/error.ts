import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';

export type FieldError = { field: string; message: string };

/** Spec 12.3 error envelope. */
export class ApiError extends Error {
  constructor(
    readonly httpStatus: number,
    readonly code: string,
    message: string,
    readonly fieldErrors: FieldError[] = [],
  ) {
    super(message);
    this.name = 'ApiError';
  }

  static badRequest(code: string, message: string, fieldErrors: FieldError[] = []) {
    return new ApiError(400, code, message, fieldErrors);
  }
  static unauthorized(message = 'Sessiya topilmadi yoki muddati tugagan.') {
    return new ApiError(401, 'UNAUTHENTICATED', message);
  }
  static forbidden(message = 'Bu amal uchun ruxsat yo‘q.') {
    return new ApiError(403, 'FORBIDDEN', message);
  }
  /** Cross-clinic access must look identical to a genuinely missing object (spec 3, AT-02). */
  static notFound(message = 'Obyekt topilmadi.') {
    return new ApiError(404, 'NOT_FOUND', message);
  }
  static conflict(code: string, message: string) {
    return new ApiError(409, code, message);
  }
  static unprocessable(code: string, message: string, fieldErrors: FieldError[] = []) {
    return new ApiError(422, code, message, fieldErrors);
  }
  static tooManyRequests(message = 'So‘rovlar chegarasi oshdi. Birozdan keyin urinib ko‘ring.') {
    return new ApiError(429, 'RATE_LIMITED', message);
  }
  static unavailable(code: string, message: string) {
    return new ApiError(503, code, message);
  }
}

export function notFoundHandler(_req: Request, _res: Response, next: NextFunction): void {
  next(ApiError.notFound('Endpoint topilmadi.'));
}

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  const requestId = res.locals.requestId ?? null;

  if (err instanceof ZodError) {
    const fieldErrors = err.issues.map((i) => ({ field: i.path.join('.') || '(root)', message: i.message }));
    res.status(422).json({
      error: { code: 'SCHEMA_VALIDATION_FAILED', message: 'So‘rov sxemasi talablarga mos emas.', field_errors: fieldErrors, request_id: requestId },
    });
    return;
  }

  if (err instanceof ApiError) {
    res.status(err.httpStatus).json({
      error: { code: err.code, message: err.message, field_errors: err.fieldErrors, request_id: requestId },
    });
    return;
  }

  // Unexpected: log server-side, return nothing internal to the client.
  console.error(`[${requestId}] ${req.method} ${req.originalUrl} unhandled error:`, err);
  res.status(500).json({
    error: { code: 'INTERNAL_ERROR', message: 'Kutilmagan server xatosi.', field_errors: [], request_id: requestId },
  });
}
