import { Schema, model } from 'mongoose';
import { baseOptions, uuidId, type BaseFields } from './base.js';

export type AuditEvent = BaseFields & {
  clinic_id: string;
  actor_id: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  patient_id: string | null;
  request_id: string | null;
  status: string;
  metadata: Record<string, unknown>;
};

export type IdempotencyRecord = BaseFields & {
  clinic_id: string;
  user_id: string;
  scope: string;
  key: string;
  payload_hash: string;
  response_status: number;
  response_body: unknown;
};

/**
 * Spec 13: the audit trail stores object ids, the action and the status —
 * never the document text itself.
 */
const auditEventSchema = new Schema<AuditEvent>(
  {
    ...uuidId,
    clinic_id: { type: String, required: true, index: true },
    actor_id: { type: String, default: null },
    action: { type: String, required: true },
    entity_type: { type: String, required: true },
    entity_id: { type: String, default: null },
    patient_id: { type: String, default: null, index: true },
    request_id: { type: String, default: null },
    status: { type: String, default: 'ok' },
    metadata: { type: Object, default: {} },
  },
  baseOptions,
);
auditEventSchema.index({ clinic_id: 1, created_at: -1 });

/** Spec 12.3: same key + same payload replays the stored result; different payload -> 409. */
const idempotencyRecordSchema = new Schema<IdempotencyRecord>(
  {
    ...uuidId,
    clinic_id: { type: String, required: true },
    user_id: { type: String, required: true },
    scope: { type: String, required: true },
    key: { type: String, required: true },
    payload_hash: { type: String, required: true },
    response_status: { type: Number, required: true },
    response_body: { type: Object, required: true },
  },
  baseOptions,
);
idempotencyRecordSchema.index({ clinic_id: 1, scope: 1, key: 1 }, { unique: true });

export const AuditEventModel = model<AuditEvent>('AuditEvent', auditEventSchema);
export const IdempotencyRecordModel = model<IdempotencyRecord>('IdempotencyRecord', idempotencyRecordSchema);
