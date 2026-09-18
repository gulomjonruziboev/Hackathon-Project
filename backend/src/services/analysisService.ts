import { loadClinicalContent } from '../content/loader.js';
import { ApiError } from '../middleware/error.js';
import {
  AnalysisModel,
  PatientModel,
  ProfileRevisionModel,
  ScenarioModel,
  type Analysis,
  type AnalysisStatus,
  type Scenario,
} from '../models/index.js';
import { hashCanonical } from '../utils/canonical.js';
import { getRevisionOrThrow } from './profileService.js';
import { evaluateRules } from './ruleEngine.js';

/**
 * The analysis is keyed by everything that can change its result, so the same
 * confirmed inputs on the same versions reproduce the same structural output
 * (FR-09, AT-13).
 */
function inputHash(scenario: Scenario, rulesetChecksum: string, catalogVersion: string, factsFingerprint: string): string {
  return hashCanonical({
    profile_revision_id: scenario.profile_revision_id,
    facts: factsFingerprint,
    regimen: scenario.final_regimen.map((item) => ({
      ingredient_code: item.ingredient_code,
      dose_value: item.dose_value,
      dose_unit: item.dose_unit,
      route: item.route,
      frequency_per_day: item.frequency_per_day,
      duration_days: item.duration_days,
    })),
    ruleset_checksum: rulesetChecksum,
    catalog_version: catalogVersion,
  });
}

function overallStatus(result: ReturnType<typeof evaluateRules>): AnalysisStatus {
  if (result.coverage.error_count > 0) return 'PARTIAL';
  if (result.coverage.not_evaluable_count > 0) return 'PARTIAL';
  return 'COMPLETED';
}

export async function runAnalysis(options: {
  clinicId: string;
  patientId: string;
  scenarioId: string;
  userId: string;
  now?: Date;
}): Promise<Analysis> {
  const scenario = await ScenarioModel.findOne({
    _id: options.scenarioId,
    clinic_id: options.clinicId,
  }).lean<Scenario | null>();
  if (!scenario) throw ApiError.notFound('Ssenariy topilmadi.');

  const patient = await PatientModel.findOne({ _id: scenario.patient_id, clinic_id: options.clinicId }).lean();
  if (!patient) throw ApiError.notFound('Bemor topilmadi.');

  const revision = await getRevisionOrThrow(options.clinicId, scenario.profile_revision_id);
  const content = loadClinicalContent();

  // BLOCKED: nothing confirmed to compute on, or no supported plan (spec 10.3).
  if (revision.facts_snapshot.length === 0) {
    return persist(scenario, String(revision._id), {
      clinicId: options.clinicId,
      userId: options.userId,
      status: 'BLOCKED',
      errorCode: 'NO_CONFIRMED_PROFILE',
      content,
      result: {
        evaluations: [],
        findings: [],
        illustrativeFindings: [],
        coverage: {
          evaluated_count: 0,
          not_evaluable_count: 0,
          not_applicable_count: 0,
          error_count: 0,
          illustrative_count: 0,
          unsupported_medication_ids: [],
          unevaluated_dimensions: [...content.dimensionsUnsupported].sort(),
        },
        missingData: [{ field: 'profile', reason: 'no_confirmed_facts' }],
      },
      isSynthetic: patient.is_synthetic,
    });
  }

  const result = evaluateRules({ content, revision, regimen: scenario.final_regimen, now: options.now });

  return persist(scenario, String(revision._id), {
    clinicId: options.clinicId,
    userId: options.userId,
    status: overallStatus(result),
    errorCode: null,
    content,
    result,
    isSynthetic: patient.is_synthetic,
    factsFingerprint: hashCanonical(revision.facts_snapshot),
  });
}

async function persist(
  scenario: Scenario,
  profileRevisionId: string,
  args: {
    clinicId: string;
    userId: string;
    status: AnalysisStatus;
    errorCode: string | null;
    content: ReturnType<typeof loadClinicalContent>;
    result: ReturnType<typeof evaluateRules>;
    isSynthetic: boolean;
    factsFingerprint?: string;
  },
): Promise<Analysis> {
  const created = await AnalysisModel.create({
    clinic_id: args.clinicId,
    patient_id: scenario.patient_id,
    scenario_id: String(scenario._id),
    scenario_version: scenario.version,
    scenario_label: scenario.label,
    profile_revision_id: profileRevisionId,
    ruleset_version: args.content.rulesetVersion,
    ruleset_checksum: args.content.rulesetChecksum,
    catalog_version: args.content.catalogVersion,
    input_hash: inputHash(scenario, args.content.rulesetChecksum, args.content.catalogVersion, args.factsFingerprint ?? ''),
    status: args.status,
    stale: false,
    findings: args.result.findings,
    illustrative_findings: args.result.illustrativeFindings,
    rule_evaluations: args.result.evaluations,
    coverage: args.result.coverage,
    missing_data: args.result.missingData,
    is_synthetic: args.isSynthetic,
    error_code: args.errorCode,
    created_by: args.userId,
  });

  await ScenarioModel.updateOne({ _id: scenario._id }, { $set: { status: 'analyzed' } });
  return created.toObject() as Analysis;
}

/**
 * FR-14 / AT-15: when a newer profile revision or scenario version exists, the
 * stored analysis is marked stale rather than quietly recomputed.
 */
export async function markStaleAnalyses(options: {
  clinicId: string;
  patientId: string;
  reason: 'profile' | 'scenario';
  scenarioId?: string;
}): Promise<number> {
  const filter: Record<string, unknown> = {
    clinic_id: options.clinicId,
    patient_id: options.patientId,
    stale: false,
  };
  if (options.reason === 'scenario' && options.scenarioId) filter.scenario_id = options.scenarioId;

  const res = await AnalysisModel.updateMany(filter, { $set: { stale: true } });
  return res.modifiedCount ?? 0;
}

/** Recomputes `stale` on read, so a result can never look fresh after a change. */
export async function withFreshStaleFlag(analysis: Analysis): Promise<Analysis> {
  if (analysis.stale) return analysis;

  const [latestRevision, scenario] = await Promise.all([
    ProfileRevisionModel.findOne({ patient_id: analysis.patient_id, clinic_id: analysis.clinic_id })
      .sort({ revision_no: -1 })
      .lean(),
    ScenarioModel.findOne({ _id: analysis.scenario_id, clinic_id: analysis.clinic_id }).lean<Scenario | null>(),
  ]);

  const revisionChanged = latestRevision != null && String(latestRevision._id) !== analysis.profile_revision_id;
  const scenarioChanged = scenario != null && scenario.version !== analysis.scenario_version;

  if (!revisionChanged && !scenarioChanged) return analysis;

  await AnalysisModel.updateOne({ _id: analysis._id }, { $set: { stale: true } });
  return { ...analysis, stale: true };
}

export async function getAnalysisOrThrow(clinicId: string, analysisId: string): Promise<Analysis> {
  const analysis = await AnalysisModel.findOne({ _id: analysisId, clinic_id: clinicId }).lean<Analysis | null>();
  if (!analysis) throw ApiError.notFound('Tahlil topilmadi.');
  return withFreshStaleFlag(analysis);
}
