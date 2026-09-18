import type { Request } from 'express';
import { ApiError } from '../middleware/error.js';
import { IdempotencyRecordModel } from '../models/index.js';
import { hashCanonical } from '../utils/canonical.js';

export type IdempotencyHit = { replayed: true; status: number; body: unknown } | { replayed: false; key: string | null };

/**
 * Spec 12.3: the same Idempotency-Key with the same payload replays the stored
 * response; the same key with a different payload is a 409 (AT-17).
 */
export async function beginIdempotent(
  req: Request,
  scope: string,
  payload: unknown,
  ctx: { clinicId: string; userId: string },
): Promise<IdempotencyHit> {
  const key = req.get('Idempotency-Key');
  if (!key) return { replayed: false, key: null };

  const payloadHash = hashCanonical(payload);
  const existing = await IdempotencyRecordModel.findOne({ clinic_id: ctx.clinicId, scope, key }).lean();

  if (!existing) return { replayed: false, key };

  if (existing.payload_hash !== payloadHash) {
    throw ApiError.conflict(
      'IDEMPOTENCY_KEY_REUSED',
      'Bu Idempotency-Key boshqa payload bilan ishlatilgan.',
    );
  }
  return { replayed: true, status: existing.response_status, body: existing.response_body };
}

export async function finishIdempotent(
  key: string | null,
  scope: string,
  payload: unknown,
  ctx: { clinicId: string; userId: string },
  response: { status: number; body: unknown },
): Promise<void> {
  if (!key) return;
  await IdempotencyRecordModel.updateOne(
    { clinic_id: ctx.clinicId, scope, key },
    {
      $set: { response_status: response.status, response_body: response.body },
      $setOnInsert: { user_id: ctx.userId, payload_hash: hashCanonical(payload) },
    },
    { upsert: true },
  );
}
