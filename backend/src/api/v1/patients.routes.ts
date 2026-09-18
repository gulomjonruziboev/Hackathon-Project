import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Router } from 'express';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { loadClinicalContent } from '../../content/loader.js';
import { requireSession, sessionOf } from '../../middleware/auth.js';
import { ApiError } from '../../middleware/error.js';
import { assertRealFormat, singleDocument } from '../../middleware/upload.js';
import {
  AuditEventModel,
  ClinicalFactModel,
  DocumentModel,
  MedicationStatementModel,
  PatientModel,
  ProfileRevisionModel,
  ScenarioModel,
  type Patient,
  type ScenarioAction,
} from '../../models/index.js';
import { recordAudit } from '../../services/auditService.js';
import { markStaleAnalyses } from '../../services/analysisService.js';
import { extractDocumentText } from '../../services/documentText.js';
import { createProfileRevision, getCurrentRevision } from '../../services/profileService.js';
import { buildFinalRegimen, validateActionDosing } from '../../services/scenarioService.js';
import { sha256 } from '../../utils/canonical.js';
import { parseIsoDate, toIso, yearsBetween } from '../../utils/dates.js';
import { isKnownObservationCode, toCanonical } from '../../utils/units.js';
import { pathParam } from '../../utils/http.js';

export const patientsRouter: Router = Router();

async function findPatientOrThrow(clinicId: string, patientId: string): Promise<Patient> {
  // Cross-clinic ids are indistinguishable from missing ones (spec 3, AT-02).
  const patient = await PatientModel.findOne({ _id: patientId, clinic_id: clinicId }).lean<Patient | null>();
  if (!patient) throw ApiError.notFound('Bemor topilmadi.');
  return patient;
}

/* ------------------------------ list & profile ------------------------------ */

patientsRouter.get('/patients', requireSession, async (req, res, next) => {
  try {
    const session = sessionOf(req);
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const limit = Math.min(Number(req.query.limit ?? 20) || 20, 100);
    const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : null;

    const filter: Record<string, unknown> = { clinic_id: session.clinicId };
    if (q) filter.synthetic_code = { $regex: q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
    if (cursor) filter._id = { $gt: cursor };

    const patients = await PatientModel.find(filter).sort({ _id: 1 }).limit(limit + 1).lean<Patient[]>();
    const page = patients.slice(0, limit);

    const items = await Promise.all(
      page.map(async (patient) => {
        const revision = await getCurrentRevision(session.clinicId, String(patient._id));
        return {
          id: String(patient._id),
          synthetic_code: patient.synthetic_code,
          age: yearsBetween(patient.birth_date),
          is_synthetic: patient.is_synthetic,
          allergy_status: patient.allergy_status,
          confirmed_conditions: (revision?.facts_snapshot ?? [])
            .filter((f) => f.kind === 'condition')
            .map((f) => f.raw_value ?? f.code),
          last_updated_at: toIso(revision?.confirmed_at ?? patient.updated_at),
          profile_revision_id: revision ? String(revision._id) : null,
        };
      }),
    );

    res.json({
      items,
      next_cursor: patients.length > limit ? String(page[page.length - 1]?._id) : null,
      is_synthetic_environment: true,
    });
  } catch (err) {
    next(err);
  }
});

patientsRouter.get('/patients/:id', requireSession, async (req, res, next) => {
  try {
    const session = sessionOf(req);
    const patient = await findPatientOrThrow(session.clinicId, pathParam(req, 'id'));
    const revision = await getCurrentRevision(session.clinicId, String(patient._id));
    const content = loadClinicalContent();

    const facts = revision?.facts_snapshot ?? [];
    const timeline = [...facts]
      .filter((f) => f.observed_at !== null)
      .sort((a, b) => (a.observed_at! < b.observed_at! ? 1 : -1))
      .map((f) => ({
        kind: f.kind,
        code: f.code,
        label: f.display_name ?? f.raw_value ?? f.code,
        value: f.normalized_value,
        unit: f.normalized_unit ?? f.unit,
        observed_at: f.observed_at,
        source: f.source,
        status: f.status,
      }));

    res.json({
      id: String(patient._id),
      synthetic_code: patient.synthetic_code,
      age: yearsBetween(patient.birth_date),
      model_sex: patient.model_sex,
      is_synthetic: patient.is_synthetic,
      allergy_status: revision?.allergy_status ?? patient.allergy_status,
      profile_revision: revision
        ? {
            id: String(revision._id),
            revision_no: revision.revision_no,
            confirmed_at: toIso(revision.confirmed_at),
          }
        : null,
      conditions: facts.filter((f) => f.kind === 'condition'),
      allergies: facts.filter((f) => f.kind === 'allergy'),
      observations: facts.filter((f) => f.kind === 'observation'),
      medications: (revision?.medications_snapshot ?? []).map((m) => ({
        ...m,
        supported_checks:
          content.medications.find((c) => c.ingredient_code === m.ingredient_code)?.supported_checks ?? [],
        unsupported_checks:
          content.medications.find((c) => c.ingredient_code === m.ingredient_code)?.unsupported_checks ?? [],
      })),
      timeline,
      data_gaps: {
        conflicting: facts.filter((f) => f.status === 'CONFLICTED').map((f) => f.code),
        undated: facts.filter((f) => f.observed_at === null).map((f) => f.code),
        allergy_unknown: (revision?.allergy_status ?? patient.allergy_status) === 'UNKNOWN',
      },
    });
  } catch (err) {
    next(err);
  }
});

/* ------------------------------ documents ------------------------------ */

patientsRouter.post('/patients/:id/documents', requireSession, singleDocument, async (req, res, next) => {
  try {
    const session = sessionOf(req);
    const patient = await findPatientOrThrow(session.clinicId, pathParam(req, 'id'));
    const file = req.file;
    if (!file) throw ApiError.badRequest('FILE_REQUIRED', 'Fayl yuborilmadi.');

    assertRealFormat(file.buffer, file.mimetype);

    const digest = sha256(file.buffer);
    const config = env();
    const extracted = await extractDocumentText(file.buffer, file.mimetype, { maxPdfPages: config.MAX_PDF_PAGES });

    // Generated key: the user-supplied filename is stored as data only (spec 13).
    const storageKey = `${session.clinicId}/${String(patient._id)}/${randomUUID()}`;
    const target = path.join(config.uploadDir, `${createHash('sha256').update(storageKey).digest('hex')}.bin`);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, file.buffer);

    const document = await DocumentModel.create({
      clinic_id: session.clinicId,
      patient_id: String(patient._id),
      storage_key: storageKey,
      filename: file.originalname,
      mime_type: file.mimetype,
      byte_size: file.size,
      sha256: digest,
      page_count: extracted.pageCount,
      extracted_text: extracted.text,
      page_texts: extracted.pages,
      parser_version: extracted.parserVersion,
      is_synthetic: patient.is_synthetic,
      status: 'TEXT_READY',
      uploaded_by: session.userId,
    });

    await recordAudit({
      clinicId: session.clinicId,
      actorId: session.userId,
      action: 'document.upload',
      entityType: 'document',
      entityId: String(document._id),
      patientId: String(patient._id),
      requestId: res.locals.requestId,
      metadata: { mime_type: file.mimetype, byte_size: file.size, page_count: extracted.pageCount },
    });

    res.status(201).json({
      id: String(document._id),
      filename: document.filename,
      mime_type: document.mime_type,
      page_count: document.page_count,
      status: document.status,
      is_synthetic: document.is_synthetic,
      text_preview: extracted.text.slice(0, 2000),
    });
  } catch (err) {
    next(err);
  }
});

patientsRouter.get('/patients/:id/documents', requireSession, async (req, res, next) => {
  try {
    const session = sessionOf(req);
    const patient = await findPatientOrThrow(session.clinicId, pathParam(req, 'id'));
    const documents = await DocumentModel.find({ clinic_id: session.clinicId, patient_id: String(patient._id) })
      .sort({ created_at: -1 })
      .lean();

    res.json({
      items: documents.map((d) => ({
        id: String(d._id),
        filename: d.filename,
        mime_type: d.mime_type,
        page_count: d.page_count,
        status: d.status,
        is_synthetic: d.is_synthetic,
        created_at: toIso(d.created_at),
      })),
    });
  } catch (err) {
    next(err);
  }
});

/* ------------------------------ manual facts ------------------------------ */

const manualFactSchema = z.object({
  kind: z.enum(['observation', 'condition', 'allergy', 'medication']),
  code: z.string().min(1),
  raw_value: z.string().nullable().default(null),
  normalized_value: z.number().nullable().default(null),
  unit: z.string().nullable().default(null),
  observed_at: z.string().nullable().default(null),
  /** Only for kind === 'medication'. */
  dose_value: z.number().nullable().default(null),
  dose_unit: z.string().nullable().default(null),
  route: z.string().nullable().default(null),
  frequency_per_day: z.number().nullable().default(null),
  medication_active: z.boolean().default(true),
});

const manualFactsSchema = z.object({
  facts: z.array(manualFactSchema).min(1).max(100),
  allergy_status: z.enum(['UNKNOWN', 'KNOWN_NONE', 'PRESENT']).optional(),
  reason: z.string().max(500).default('Qo‘lda kiritilgan faktlar'),
});

/**
 * Manual entry is the always-available path when AI is unavailable
 * (main spec 9.4, supplement 10.6). Facts land as CONFIRMED because a doctor
 * typed them, with source `manual`.
 */
patientsRouter.post('/patients/:id/facts', requireSession, async (req, res, next) => {
  try {
    const session = sessionOf(req);
    const patient = await findPatientOrThrow(session.clinicId, pathParam(req, 'id'));
    const body = manualFactsSchema.parse(req.body);
    const content = loadClinicalContent();

    for (const fact of body.facts) {
      if (fact.kind === 'medication') {
        const entry = content.medications.find((m) => m.ingredient_code === fact.code);
        if (!entry) {
          throw ApiError.badRequest(
            'MEDICATION_NOT_IN_CATALOG',
            `Faol modda katalogda yo‘q: ${fact.code}. Taxminiy moslashtirish bajarilmaydi.`,
          );
        }
      }

      let normalizedValue = fact.normalized_value;
      let normalizedUnit: string | null = null;
      let conversionNote: string | null = null;
      if (fact.kind === 'observation' && isKnownObservationCode(fact.code) && fact.normalized_value != null) {
        const conv = toCanonical(fact.code, fact.normalized_value, fact.unit);
        if (conv.ok) {
          normalizedValue = conv.value;
          normalizedUnit = conv.unit;
          if (conv.converted) conversionNote = `Jadval bo‘yicha ${fact.unit} → ${conv.unit}.`;
        } else {
          conversionNote = 'Birlik konvertatsiya jadvalida yo‘q — qiymat asl holida qoldi.';
        }
      }

      const created = await ClinicalFactModel.create({
        clinic_id: session.clinicId,
        patient_id: String(patient._id),
        kind: fact.kind,
        code: fact.code,
        raw_value: fact.raw_value,
        normalized_value: normalizedValue,
        unit: fact.unit,
        normalized_unit: normalizedUnit,
        unit_conversion_note: conversionNote,
        observed_at: parseIsoDate(fact.observed_at),
        status: 'CONFIRMED',
        source: 'manual',
        source_quote: null,
        source_quote_verified: false,
        confirmed_by: session.userId,
        confirmed_at: new Date(),
        created_by: session.userId,
      });

      if (fact.kind === 'medication') {
        await MedicationStatementModel.create({
          clinic_id: session.clinicId,
          patient_id: String(patient._id),
          ingredient_code: fact.code,
          dose_value: fact.dose_value,
          dose_unit: fact.dose_unit,
          route: fact.route,
          frequency_per_day: fact.frequency_per_day,
          status: fact.medication_active ? 'active' : 'stopped',
          source_fact_id: String(created._id),
        });
      }
    }

    const revision = await createProfileRevision({
      clinicId: session.clinicId,
      patientId: String(patient._id),
      userId: session.userId,
      reason: body.reason,
      allergyStatus: body.allergy_status,
    });

    const staleCount = await markStaleAnalyses({
      clinicId: session.clinicId,
      patientId: String(patient._id),
      reason: 'profile',
    });

    await recordAudit({
      clinicId: session.clinicId,
      actorId: session.userId,
      action: 'facts.manual_create',
      entityType: 'profile_revision',
      entityId: String(revision._id),
      patientId: String(patient._id),
      requestId: res.locals.requestId,
      metadata: { fact_count: body.facts.length, stale_analyses: staleCount },
    });

    res.status(201).json({
      profile_revision_id: String(revision._id),
      revision_no: revision.revision_no,
      stale_analyses: staleCount,
    });
  } catch (err) {
    next(err);
  }
});

/* ------------------------------ scenarios ------------------------------ */

const actionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('add'),
    ingredient_code: z.string().min(1),
    dose_value: z.number().nullable().default(null),
    dose_unit: z.string().nullable().default(null),
    route: z.string().nullable().default(null),
    frequency_per_day: z.number().int().positive().nullable().default(null),
    duration_days: z.number().int().positive().nullable().default(null),
  }),
  z.object({
    type: z.literal('modify'),
    medication_statement_id: z.string().min(1),
    dose_value: z.number().nullable().default(null),
    dose_unit: z.string().nullable().default(null),
    route: z.string().nullable().default(null),
    frequency_per_day: z.number().int().positive().nullable().default(null),
    duration_days: z.number().int().positive().nullable().default(null),
  }),
  z.object({ type: z.literal('stop'), medication_statement_id: z.string().min(1) }),
]);

const createScenarioSchema = z.object({
  label: z.string().min(1).max(40),
  profile_revision_id: z.string().min(1),
  actions: z.array(actionSchema).max(50).default([]),
  derived_from_scenario_id: z.string().nullable().default(null),
});

patientsRouter.post('/patients/:id/scenarios', requireSession, async (req, res, next) => {
  try {
    const session = sessionOf(req);
    const patient = await findPatientOrThrow(session.clinicId, pathParam(req, 'id'));
    const body = createScenarioSchema.parse(req.body);

    const revision = await ProfileRevisionModel.findOne({
      _id: body.profile_revision_id,
      clinic_id: session.clinicId,
      patient_id: String(patient._id),
    }).lean();
    if (!revision) throw ApiError.notFound('Profil reviziyasi topilmadi.');

    const current = await getCurrentRevision(session.clinicId, String(patient._id));
    if (current && String(current._id) !== body.profile_revision_id) {
      throw ApiError.conflict(
        'PROFILE_REVISION_CONFLICT',
        'Bemor profili yangilangan. Ssenariyni joriy reviziyada qayta yarating.',
      );
    }

    const actions = body.actions as ScenarioAction[];
    validateActionDosing(actions);
    const finalRegimen = buildFinalRegimen(revision, actions);

    const scenario = await ScenarioModel.create({
      clinic_id: session.clinicId,
      patient_id: String(patient._id),
      profile_revision_id: body.profile_revision_id,
      version: 1,
      label: body.label,
      derived_from_scenario_id: body.derived_from_scenario_id,
      actions,
      final_regimen: finalRegimen,
      status: 'draft',
      created_by: session.userId,
    });

    await recordAudit({
      clinicId: session.clinicId,
      actorId: session.userId,
      action: 'scenario.create',
      entityType: 'scenario',
      entityId: String(scenario._id),
      patientId: String(patient._id),
      requestId: res.locals.requestId,
      metadata: { label: body.label, action_count: actions.length },
    });

    res.status(201).json(scenario.toJSON());
  } catch (err) {
    next(err);
  }
});

patientsRouter.get('/patients/:id/scenarios', requireSession, async (req, res, next) => {
  try {
    const session = sessionOf(req);
    const patient = await findPatientOrThrow(session.clinicId, pathParam(req, 'id'));
    const scenarios = await ScenarioModel.find({ clinic_id: session.clinicId, patient_id: String(patient._id) })
      .sort({ created_at: -1 })
      .lean();
    res.json({ items: scenarios.map((s) => ({ ...s, id: String(s._id) })) });
  } catch (err) {
    next(err);
  }
});

/* ------------------------------ audit ------------------------------ */

patientsRouter.get('/patients/:id/audit', requireSession, async (req, res, next) => {
  try {
    const session = sessionOf(req);
    const patient = await findPatientOrThrow(session.clinicId, pathParam(req, 'id'));
    const limit = Math.min(Number(req.query.limit ?? 100) || 100, 200);

    const events = await AuditEventModel.find({ clinic_id: session.clinicId, patient_id: String(patient._id) })
      .sort({ created_at: -1 })
      .limit(limit)
      .lean();

    res.json({
      items: events.map((e) => ({
        id: String(e._id),
        action: e.action,
        entity_type: e.entity_type,
        entity_id: e.entity_id,
        actor_id: e.actor_id,
        status: e.status,
        request_id: e.request_id,
        metadata: e.metadata,
        created_at: toIso(e.created_at),
      })),
      note: 'Auditda hujjat matni saqlanmaydi — faqat identifikator, amal va status.',
    });
  } catch (err) {
    next(err);
  }
});
