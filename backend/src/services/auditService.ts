import { AuditEventModel } from '../models/index.js';

export type AuditInput = {
  clinicId: string;
  actorId: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  patientId?: string | null;
  requestId?: string | null;
  status?: string;
  metadata?: Record<string, unknown>;
};

/**
 * Spec 13: identifiers, action and status only. Callers must not pass document
 * text or fact values in `metadata`; counts and codes are the intended level of
 * detail.
 */
export async function recordAudit(input: AuditInput): Promise<void> {
  await AuditEventModel.create({
    clinic_id: input.clinicId,
    actor_id: input.actorId,
    action: input.action,
    entity_type: input.entityType,
    entity_id: input.entityId ?? null,
    patient_id: input.patientId ?? null,
    request_id: input.requestId ?? null,
    status: input.status ?? 'ok',
    metadata: input.metadata ?? {},
  });
}
