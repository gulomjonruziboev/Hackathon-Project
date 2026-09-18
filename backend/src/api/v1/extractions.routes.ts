import { Router } from 'express';
import { z } from 'zod';
import { loadClinicalContent } from '../../content/loader.js';
import { PARSER_VERSION } from '../../llm/extractionSchema.js';
import { requireSession, sessionOf } from '../../middleware/auth.js';
import { ApiError } from '../../middleware/error.js';
import { rateLimit } from '../../middleware/rateLimit.js';
import {
  ClinicalFactModel,
  DocumentModel,
  ExtractionModel,
  MedicationStatementModel,
  type DocumentRecord,
  type Extraction,
} from '../../models/index.js';
import { markStaleAnalyses } from '../../services/analysisService.js';
import { recordAudit } from '../../services/auditService.js';
import { runExtraction, type CandidateFact } from '../../services/extractionService.js';
import { createProfileRevision } from '../../services/profileService.js';
import { parseIsoDate, toIso } from '../../utils/dates.js';
import { pathParam } from '../../utils/http.js';
import { isKnownObservationCode, toCanonical } from '../../utils/units.js';

export const extractionsRouter: Router = Router();

const extractRequestSchema = z.object({
  mode: z.enum(['live', 'recorded_demo']).default('live'),
  /** Supplement 9: the doctor may send only the pages that matter. */
  pages: z.array(z.number().int().positive()).max(20).nullable().default(null),
  force: z.boolean().default(false),
});

function serializeExtraction(extraction: Extraction) {
  return {
    id: String(extraction._id),
    document_id: extraction.document_id,
    status: extraction.status,
    error_code: extraction.error_code,
    error_message: extraction.error_message,
    schema_version: extraction.schema_version,
    prompt_version: extraction.prompt_version,
    parser_version: extraction.parser_version,
    provider: extraction.provider,
    provider_model: extraction.provider_model,
    model_revision: extraction.model_revision,
    page_selection: extraction.page_selection,
    chunk_count: extraction.chunk_count,
    /** UI must badge this clearly: not a live AI result (main spec 9.4). */
    is_recorded_demo: extraction.is_recorded_demo,
    cache_hit: extraction.cache_hit,
    repair_attempted: extraction.repair_attempted,
    usage: extraction.provider_metadata,
    warnings: extraction.warnings,
    candidates: extraction.candidates,
    confirmed_at: toIso(extraction.confirmed_at),
    resulting_profile_revision_id: extraction.resulting_profile_revision_id,
    manual_entry_available: true,
  };
}

/**
 * POST /documents/:id/extract
 * Returns an existing active extraction unless `force` is set, so a page reload
 * after a network error can ask for the current status (main spec 7).
 */
extractionsRouter.post(
  '/documents/:id/extract',
  requireSession,
  rateLimit({ windowMs: 60_000, max: 12, keyPrefix: 'extract' }),
  async (req, res, next) => {
    try {
      const session = sessionOf(req);
      const body = extractRequestSchema.parse(req.body ?? {});

      const document = await DocumentModel.findOne({
        _id: pathParam(req, 'id'),
        clinic_id: session.clinicId,
      }).lean<DocumentRecord | null>();
      if (!document) throw ApiError.notFound('Hujjat topilmadi.');
      if (document.status !== 'TEXT_READY') {
        throw ApiError.badRequest('DOCUMENT_TEXT_NOT_READY', 'Hujjat matni tayyor emas.');
      }

      if (!body.force) {
        const existing = await ExtractionModel.findOne({
          document_id: String(document._id),
          clinic_id: session.clinicId,
          status: { $in: ['COMPLETED', 'MANUAL_REQUIRED'] },
          confirmed_at: null,
        })
          .sort({ created_at: -1 })
          .lean<Extraction | null>();
        if (existing) {
          res.json(serializeExtraction(existing));
          return;
        }
      }

      const outcome = await runExtraction({ document, mode: body.mode, pageSelection: body.pages });

      const extraction = await ExtractionModel.create({
        clinic_id: session.clinicId,
        patient_id: document.patient_id,
        document_id: String(document._id),
        schema_version: outcome.metadata.schema_version,
        prompt_version: outcome.metadata.prompt_version,
        parser_version: document.parser_version ?? PARSER_VERSION,
        provider: outcome.provider,
        provider_model: outcome.providerModel,
        model_revision: outcome.modelRevision,
        page_selection: outcome.pageSelection,
        chunk_count: outcome.chunkCount,
        is_recorded_demo: outcome.isRecordedDemo,
        status: outcome.status,
        error_code: outcome.errorCode,
        error_message: outcome.errorMessage,
        provider_metadata: outcome.metadata,
        cache_hit: outcome.metadata.cache_hit,
        repair_attempted: outcome.repairAttempted,
        candidates: outcome.candidates,
        warnings: outcome.warnings,
        created_by: session.userId,
      });

      // Supplement 9: token spend, latency, model and status are logged — the
      // document text never is.
      await recordAudit({
        clinicId: session.clinicId,
        actorId: session.userId,
        action: 'extraction.run',
        entityType: 'extraction',
        entityId: String(extraction._id),
        patientId: document.patient_id,
        requestId: res.locals.requestId,
        status: outcome.status === 'COMPLETED' ? 'ok' : 'manual_required',
        metadata: {
          provider: outcome.provider,
          model_id: outcome.providerModel,
          latency_ms: outcome.metadata.latency_ms,
          input_tokens: outcome.metadata.input_tokens,
          output_tokens: outcome.metadata.output_tokens,
          finish_status: outcome.metadata.finish_status,
          cache_hit: outcome.metadata.cache_hit,
          candidate_count: outcome.candidates.length,
          error_code: outcome.errorCode,
        },
      });

      res.status(201).json(serializeExtraction(extraction.toObject() as Extraction));
    } catch (err) {
      next(err);
    }
  },
);

extractionsRouter.get('/extractions/:id', requireSession, async (req, res, next) => {
  try {
    const session = sessionOf(req);
    const extraction = await ExtractionModel.findOne({
      _id: pathParam(req, 'id'),
      clinic_id: session.clinicId,
    }).lean<Extraction | null>();
    if (!extraction) throw ApiError.notFound('Extraction topilmadi.');

    const document = await DocumentModel.findOne({
      _id: extraction.document_id,
      clinic_id: session.clinicId,
    }).lean<DocumentRecord | null>();

    res.json({
      ...serializeExtraction(extraction),
      document: document
        ? { id: String(document._id), filename: document.filename, text: document.extracted_text }
        : null,
    });
  } catch (err) {
    next(err);
  }
});

/* ------------------------------ confirmation ------------------------------ */

const decisionSchema = z.object({
  candidate_index: z.number().int().min(0),
  action: z.enum(['confirm', 'reject']),
  /** Doctor corrections; anything omitted keeps the extracted value. */
  code: z.string().min(1).optional(),
  raw_value: z.string().nullable().optional(),
  normalized_value: z.number().nullable().optional(),
  unit: z.string().nullable().optional(),
  observed_at: z.string().nullable().optional(),
  medication: z
    .object({
      ingredient_code: z.string().min(1),
      dose_value: z.number().nullable().default(null),
      dose_unit: z.string().nullable().default(null),
      route: z.string().nullable().default(null),
      frequency_per_day: z.number().int().positive().nullable().default(null),
      active: z.boolean().default(true),
    })
    .optional(),
});

const confirmSchema = z.object({
  decisions: z.array(decisionSchema).min(1).max(200),
  allergy_status: z.enum(['UNKNOWN', 'KNOWN_NONE', 'PRESENT']),
  reason: z.string().max(500).default('Extraction tasdiqlandi'),
});

/**
 * POST /extractions/:id/confirm
 * Nothing becomes CONFIRMED without this call (FR-06, AI-09), a fact whose
 * quote could not be verified cannot be confirmed at all (AT-07, AI-10), and
 * every correction is audited.
 */
extractionsRouter.post('/extractions/:id/confirm', requireSession, async (req, res, next) => {
  try {
    const session = sessionOf(req);
    const body = confirmSchema.parse(req.body);

    const extraction = await ExtractionModel.findOne({
      _id: pathParam(req, 'id'),
      clinic_id: session.clinicId,
    }).lean<Extraction | null>();
    if (!extraction) throw ApiError.notFound('Extraction topilmadi.');
    if (extraction.confirmed_at) {
      throw ApiError.conflict('EXTRACTION_ALREADY_CONFIRMED', 'Bu extraction allaqachon tasdiqlangan.');
    }

    const content = loadClinicalContent();
    const candidates = extraction.candidates as CandidateFact[];
    let confirmedCount = 0;
    let correctedCount = 0;
    let rejectedCount = 0;

    for (const decision of body.decisions) {
      const candidate = candidates[decision.candidate_index];
      if (!candidate) {
        throw ApiError.badRequest('UNKNOWN_CANDIDATE', `Nomaʼlum candidate_index: ${decision.candidate_index}`);
      }

      if (decision.action === 'reject') {
        rejectedCount += 1;
        continue;
      }

      if (candidate.blocked_reason === 'SOURCE_QUOTE_NOT_FOUND') {
        throw ApiError.unprocessable(
          'SOURCE_QUOTE_NOT_VERIFIED',
          `Bu faktning manba parchasi hujjat matnida topilmadi (${candidate.code}). Uni tasdiqlab bo‘lmaydi — qiymatni qo‘lda kiriting.`,
        );
      }

      const kind = candidate.kind;
      const code = decision.code ?? (decision.medication?.ingredient_code ?? candidate.code);
      const corrected =
        (decision.code != null && decision.code !== candidate.code) ||
        (decision.normalized_value !== undefined && decision.normalized_value !== candidate.normalized_value) ||
        (decision.unit !== undefined && decision.unit !== candidate.unit) ||
        (decision.observed_at !== undefined && decision.observed_at !== candidate.observed_at);
      if (corrected) correctedCount += 1;

      let normalizedValue = decision.normalized_value ?? candidate.normalized_value;
      let normalizedUnit = candidate.normalized_unit;
      let conversionNote = candidate.unit_conversion_note;
      const unit = decision.unit !== undefined ? decision.unit : candidate.unit;

      if (kind === 'observation' && isKnownObservationCode(code) && normalizedValue != null) {
        const conv = toCanonical(code, normalizedValue, unit);
        if (conv.ok) {
          normalizedValue = conv.value;
          normalizedUnit = conv.unit;
          conversionNote = conv.converted ? `Jadval bo‘yicha ${unit} → ${conv.unit}.` : conversionNote;
        } else {
          normalizedUnit = null;
          conversionNote = 'Birlik konvertatsiya jadvalida yo‘q — qiymat asl holida qoldi.';
        }
      }

      if (kind === 'medication') {
        const ingredientCode = decision.medication?.ingredient_code ?? code;
        const entry = content.medications.find((m) => m.ingredient_code === ingredientCode);
        if (!entry) {
          throw ApiError.badRequest(
            'MEDICATION_NOT_IN_CATALOG',
            `Faol modda katalogda yo‘q: ${ingredientCode}. Taxminiy moslashtirish bajarilmaydi.`,
          );
        }
      }

      const fact = await ClinicalFactModel.create({
        clinic_id: session.clinicId,
        patient_id: extraction.patient_id,
        kind,
        code,
        raw_value: decision.raw_value !== undefined ? decision.raw_value : candidate.raw_value,
        normalized_value: normalizedValue,
        unit,
        normalized_unit: normalizedUnit,
        unit_conversion_note: conversionNote,
        observed_at: parseIsoDate(decision.observed_at !== undefined ? decision.observed_at : candidate.observed_at),
        status: 'CONFIRMED',
        source: 'extraction',
        source_document_id: extraction.document_id,
        source_page: candidate.source_page,
        source_quote: candidate.source_quote,
        source_quote_verified: candidate.source_quote_verified,
        extraction_id: String(extraction._id),
        confirmed_by: session.userId,
        confirmed_at: new Date(),
        created_by: session.userId,
      });
      confirmedCount += 1;

      if (kind === 'medication') {
        const med = decision.medication;
        await MedicationStatementModel.create({
          clinic_id: session.clinicId,
          patient_id: extraction.patient_id,
          ingredient_code: med?.ingredient_code ?? code,
          dose_value: med?.dose_value ?? null,
          dose_unit: med?.dose_unit ?? null,
          route: med?.route ?? null,
          frequency_per_day: med?.frequency_per_day ?? null,
          // Spec 8.1: when "currently taking" is unclear the doctor decides.
          status: (med?.active ?? candidate.medication_status === 'current') ? 'active' : 'stopped',
          source_fact_id: String(fact._id),
        });
      }
    }

    const revision = await createProfileRevision({
      clinicId: session.clinicId,
      patientId: extraction.patient_id,
      userId: session.userId,
      reason: body.reason,
      allergyStatus: body.allergy_status,
    });

    await ExtractionModel.updateOne(
      { _id: extraction._id },
      {
        $set: {
          confirmed_at: new Date(),
          confirmed_by: session.userId,
          resulting_profile_revision_id: String(revision._id),
        },
      },
    );

    const staleCount = await markStaleAnalyses({
      clinicId: session.clinicId,
      patientId: extraction.patient_id,
      reason: 'profile',
    });

    await recordAudit({
      clinicId: session.clinicId,
      actorId: session.userId,
      action: 'extraction.confirm',
      entityType: 'extraction',
      entityId: String(extraction._id),
      patientId: extraction.patient_id,
      requestId: res.locals.requestId,
      metadata: {
        confirmed: confirmedCount,
        corrected: correctedCount,
        rejected: rejectedCount,
        allergy_status: body.allergy_status,
        profile_revision_id: String(revision._id),
        stale_analyses: staleCount,
      },
    });

    res.status(201).json({
      profile_revision_id: String(revision._id),
      revision_no: revision.revision_no,
      confirmed: confirmedCount,
      corrected: correctedCount,
      rejected: rejectedCount,
      stale_analyses: staleCount,
    });
  } catch (err) {
    next(err);
  }
});
