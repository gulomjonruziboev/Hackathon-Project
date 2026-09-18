import multer from 'multer';
import type { NextFunction, Request, Response } from 'express';
import { env } from '../config/env.js';
import { ApiError } from './error.js';

const ALLOWED_MIME = new Set(['text/plain', 'application/pdf']);

/**
 * Memory storage: the file is hashed, its text extracted, and only then written
 * under a generated storage key. The user-supplied filename never becomes part
 * of a path (spec 13).
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env().MAX_UPLOAD_BYTES, files: 1 },
  fileFilter(_req, file, cb) {
    if (!ALLOWED_MIME.has(file.mimetype)) {
      cb(new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Faqat TXT va matnli PDF qabul qilinadi.'));
      return;
    }
    cb(null, true);
  },
});

export function singleDocument(req: Request, res: Response, next: NextFunction): void {
  upload.single('file')(req, res, (err: unknown) => {
    if (!err) return next();
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return next(
          new ApiError(
            413,
            'FILE_TOO_LARGE',
            `Fayl hajmi chegaradan oshdi (maksimum ${Math.round(env().MAX_UPLOAD_BYTES / 1024 / 1024)} MB).`,
          ),
        );
      }
      return next(ApiError.badRequest('UPLOAD_FAILED', 'Faylni yuklab bo‘lmadi.'));
    }
    next(err);
  });
}

/**
 * Magic-byte check: the declared MIME type alone is not trusted (spec 13).
 * A PDF must start with %PDF-, and a "text/plain" upload must not be binary.
 */
export function assertRealFormat(buffer: Buffer, mimeType: string): void {
  if (mimeType === 'application/pdf') {
    if (buffer.subarray(0, 5).toString('latin1') !== '%PDF-') {
      throw new ApiError(415, 'FILE_FORMAT_MISMATCH', 'Fayl PDF deb belgilangan, lekin PDF formatida emas.');
    }
    return;
  }
  if (mimeType === 'text/plain') {
    if (buffer.includes(0)) {
      throw new ApiError(415, 'FILE_FORMAT_MISMATCH', 'Fayl matn deb belgilangan, lekin ikkilik ma’lumot topildi.');
    }
  }
}
