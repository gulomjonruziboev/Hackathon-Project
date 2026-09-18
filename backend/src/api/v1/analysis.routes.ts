import { Router } from 'express';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { requireSession, sessionOf } from '../../middleware/auth.js';
import { ApiError } from '../../middleware/error.js';
import {
  AnalysisModel,
  DecisionModel,
  ProfileRevisionModel,
  ScenarioModel,
  type Analysis,
  type Scenario,
  type ScenarioAction,
} from '../../models/index.js';
import {
  getAnalysisOrThrow,
  markStaleAnalyses,
  runAnalysis,
  withFreshStaleFlag,
} from '../../services/analysisService.js';
import { recordAudit } from '../../services/auditService.js';
import { compareAnalyses } from '../../services/comparisonService.js';
import {
  NO_FINDING_TEXT,
  NO_REVIEWED_RULES_TEXT,
  buildWhyPanel,
} from '../../services/explanationService.js';
import { beginIdempotent, finishIdempotent } from '../../services/idempotency.js';
import { buildFinalRegimen, validateActionDosing } from '../../services/scenarioService.js';
import { pathParam } from '../../utils/http.js';
import { toIso } from '../../utils/dates.js';

export const analysisRouter: Router = Router();

function serializeAnalysis(analysis: Analysis) {
  const hasReviewedRules = analysis.findings.length > 0;
  return {
    id: String(analysis._id),
    patient_id: analysis.patient_id,
    scenario_id: analysis.scenario_id,
    scenario_label: analysis.scenario_label,
    scenario_version: analysis.scenario_version,
    profile_revision_id: analysis.profile_revision_id,
    ruleset_version: analysis.ruleset_version,
    ruleset_checksum: analysis.ruleset_checksum,
    catalog_version: analysis.catalog_version,
    input_hash: analysis.input_hash,
    status: analysis.status,
    stale: analysis.stale,
    findings: analysis.findings.map((f) => ({ ...f, why: buildWhyPanel(f, analysis) })),
    /** Kept in a separate bucket: unreviewed rules never enter the clinical set. */
    illustrative_findings: analysis.illustrative_findings.map((f) => ({ ...f, why: buildWhyPanel(f, analysis) })),
    rule_evaluations: analysis.rule_evaluations,
    coverage: analysis.coverage,
    missing_data: analysis.missing_data,
    is_synthetic: analysis.is_synthetic,
    error_code: analysis.error_code,
    created_at: toIso(analysis.created_at),
    empty_state_text: hasReviewedRules ? null : NO_REVIEWED_RULES_TEXT,
    no_finding_text: NO_FINDING_TEXT,
    validation_notice:
      'Sintetik ma’lumot. Klinik validatsiya bajarilmagan — natija shifokor qarorining o‘rnini bosmaydi.',
  };
}

/* ------------------------------ scenario update ------------------------------ */

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

const patchScenarioSchema = z.object({
  /** Optimistic concurrency: the client states the version it edited (spec 12.3). */
  expected_version: z.number().int().positive(),
  label: z.string().min(1).max(40).optional(),
  actions: z.array(actionSchema).max(50),
});

analysisRouter.patch('/scenarios/:id', requireSession, async (req, res, next) => {
  try {
    const session = sessionOf(req);
    const body = patchScenarioSchema.parse(req.body);

    const scenario = await ScenarioModel.findOne({
      _id: pathParam(req, 'id'),
      clinic_id: session.clinicId,
    }).lean<Scenario | null>();
    if (!scenario) throw ApiError.notFound('Ssenariy topilmadi.');

    if (scenario.version !== body.expected_version) {
      throw ApiError.conflict(
        'SCENARIO_VERSION_CONFLICT',
        `Ssenariy boshqa joyda yangilangan (joriy versiya ${scenario.version}). Sahifani yangilang.`,
      );
    }

    const revision = await ProfileRevisionModel.findOne({
      _id: scenario.profile_revision_id,
      clinic_id: session.clinicId,
    }).lean();
    if (!revision) throw ApiError.notFound('Profil reviziyasi topilmadi.');

    const actions = body.actions as ScenarioAction[];
    validateActionDosing(actions);
    const finalRegimen = buildFinalRegimen(revision, actions);

    await ScenarioModel.updateOne(
      { _id: scenario._id, version: body.expected_version },
      {
        $set: {
          label: body.label ?? scenario.label,
          actions,
          final_regimen: finalRegimen,
          status: 'draft',
        },
        $inc: { version: 1 },
      },
    );

    const staleCount = await markStaleAnalyses({
      clinicId: session.clinicId,
      patientId: scenario.patient_id,
      reason: 'scenario',
      scenarioId: String(scenario._id),
    });

    await recordAudit({
      clinicId: session.clinicId,
      actorId: session.userId,
      action: 'scenario.update',
      entityType: 'scenario',
      entityId: String(scenario._id),
      patientId: scenario.patient_id,
      requestId: res.locals.requestId,
      metadata: { new_version: scenario.version + 1, stale_analyses: staleCount },
    });

    const updated = await ScenarioModel.findById(scenario._id).lean<Scenario | null>();
    res.json({ ...updated, id: String(scenario._id), stale_analyses: staleCount });
  } catch (err) {
    next(err);
  }
});

/* ------------------------------ analyze ------------------------------ */

analysisRouter.post('/scenarios/:id/analyze', requireSession, async (req, res, next) => {
  try {
    const session = sessionOf(req);
    const scenario = await ScenarioModel.findOne({
      _id: pathParam(req, 'id'),
      clinic_id: session.clinicId,
    }).lean<Scenario | null>();
    if (!scenario) throw ApiError.notFound('Ssenariy topilmadi.');

    const payload = { scenario_id: String(scenario._id), scenario_version: scenario.version };
    const idem = await beginIdempotent(req, 'analyze', payload, {
      clinicId: session.clinicId,
      userId: session.userId,
    });
    if (idem.replayed) {
      res.status(idem.status).json(idem.body);
      return;
    }

    const analysis = await runAnalysis({
      clinicId: session.clinicId,
      patientId: scenario.patient_id,
      scenarioId: String(scenario._id),
      userId: session.userId,
    });

    const body = serializeAnalysis(analysis);
    await finishIdempotent(idem.key, 'analyze', payload, { clinicId: session.clinicId, userId: session.userId }, {
      status: 201,
      body,
    });

    await recordAudit({
      clinicId: session.clinicId,
      actorId: session.userId,
      action: 'analysis.run',
      entityType: 'analysis',
      entityId: String(analysis._id),
      patientId: scenario.patient_id,
      requestId: res.locals.requestId,
      metadata: {
        status: analysis.status,
        finding_count: analysis.findings.length,
        illustrative_count: analysis.illustrative_findings.length,
        ruleset_version: analysis.ruleset_version,
      },
    });

    res.status(201).json(body);
  } catch (err) {
    next(err);
  }
});

analysisRouter.get('/analyses/:id', requireSession, async (req, res, next) => {
  try {
    const session = sessionOf(req);
    const analysis = await getAnalysisOrThrow(session.clinicId, pathParam(req, 'id'));
    res.json(serializeAnalysis(analysis));
  } catch (err) {
    next(err);
  }
});

/* ------------------------------ comparison ------------------------------ */

const comparisonSchema = z.object({
  analysis_a_id: z.string().min(1),
  analysis_b_id: z.string().min(1),
});

analysisRouter.post('/comparisons', requireSession, async (req, res, next) => {
  try {
    const session = sessionOf(req);
    const body = comparisonSchema.parse(req.body);

    const [a, b] = await Promise.all([
      AnalysisModel.findOne({ _id: body.analysis_a_id, clinic_id: session.clinicId }).lean<Analysis | null>(),
      AnalysisModel.findOne({ _id: body.analysis_b_id, clinic_id: session.clinicId }).lean<Analysis | null>(),
    ]);
    if (!a || !b) throw ApiError.notFound('Tahlil topilmadi.');

    const result = compareAnalyses(await withFreshStaleFlag(a), await withFreshStaleFlag(b));

    await recordAudit({
      clinicId: session.clinicId,
      actorId: session.userId,
      action: 'comparison.run',
      entityType: 'analysis',
      entityId: String(a._id),
      patientId: a.patient_id,
      requestId: res.locals.requestId,
      metadata: { analysis_b_id: String(b._id), diff_rows: result.findings_diff.length },
    });

    res.json(result);
  } catch (err) {
    next(err);
  }
});

/* ------------------------------ decision ------------------------------ */

const decisionSchema = z.object({
  analysis_id: z.string().min(1),
  action: z.enum(['accept_a', 'accept_b', 'accept', 'reject_all']),
  selected_scenario_id: z.string().nullable().default(null),
  comparison_id: z.string().nullable().default(null),
  reason: z.string().min(1).max(2000),
});

analysisRouter.post('/decisions', requireSession, async (req, res, next) => {
  try {
    const session = sessionOf(req);
    const body = decisionSchema.parse(req.body);

    const analysis = await AnalysisModel.findOne({
      _id: body.analysis_id,
      clinic_id: session.clinicId,
    }).lean<Analysis | null>();
    if (!analysis) throw ApiError.notFound('Tahlil topilmadi.');

    const fresh = await withFreshStaleFlag(analysis);
    if (fresh.stale) {
      throw ApiError.conflict('ANALYSIS_STALE', 'Tahlil eskirgan. Qaror saqlashdan oldin qayta hisoblang.');
    }

    const idem = await beginIdempotent(req, 'decision', body, {
      clinicId: session.clinicId,
      userId: session.userId,
    });
    if (idem.replayed) {
      res.status(idem.status).json(idem.body);
      return;
    }

    const decision = await DecisionModel.create({
      clinic_id: session.clinicId,
      patient_id: analysis.patient_id,
      analysis_id: String(analysis._id),
      comparison_id: body.comparison_id,
      selected_scenario_id: body.selected_scenario_id,
      action: body.action,
      reason: body.reason,
      actor_id: session.userId,
    });

    const responseBody = {
      id: String(decision._id),
      analysis_id: String(analysis._id),
      action: decision.action,
      selected_scenario_id: decision.selected_scenario_id,
      reason: decision.reason,
      actor_id: decision.actor_id,
      created_at: toIso(decision.created_at),
    };

    await finishIdempotent(idem.key, 'decision', body, { clinicId: session.clinicId, userId: session.userId }, {
      status: 201,
      body: responseBody,
    });

    await recordAudit({
      clinicId: session.clinicId,
      actorId: session.userId,
      action: 'decision.save',
      entityType: 'decision',
      entityId: String(decision._id),
      patientId: analysis.patient_id,
      requestId: res.locals.requestId,
      metadata: { action: body.action, analysis_id: String(analysis._id) },
    });

    res.status(201).json(responseBody);
  } catch (err) {
    next(err);
  }
});

/* ------------------------------ P1 prognosis ------------------------------ */

/** Spec 12: the endpoint exists but reports FEATURE_DISABLED until KFRE passes review. */
analysisRouter.post('/patients/:id/prognoses', requireSession, (_req, _res, next) => {
  if (!env().ENABLE_KFRE) {
    next(
      new ApiError(
        503,
        'FEATURE_DISABLED',
        '5 yillik prognoz moduli hali yoqilmagan. Formula, birliklar va qo‘llanish chegarasi tekshirilmagan.',
      ),
    );
    return;
  }
  next(
    new ApiError(
      503,
      'FEATURE_NOT_IMPLEMENTED',
      'ENABLE_KFRE yoqilgan, ammo tekshirilgan KFRE implementatsiyasi bu buildda yo‘q.',
    ),
  );
});
