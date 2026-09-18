import type { Request } from 'express';
import { ApiError } from '../middleware/error.js';

/**
 * Express 5 types a route parameter as `string | string[] | undefined`.
 * A repeated or missing id is a malformed request, not a lookup that should
 * proceed with a coerced value.
 */
export function pathParam(req: Request, name: string): string {
  const value = (req.params as Record<string, unknown>)[name];
  if (typeof value !== 'string' || value === '') {
    throw ApiError.badRequest('INVALID_PATH_PARAMETER', `So‘rov yo‘lidagi "${name}" qiymati noto‘g‘ri.`);
  }
  return value;
}
