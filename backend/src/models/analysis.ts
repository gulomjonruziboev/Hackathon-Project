import { Schema, model } from 'mongoose';
import { baseOptions, uuidId, type BaseFields } from './base.js';

export const ANALYSIS_STATUSES = ['COMPLETED', 'PARTIAL', 'BLOCKED', 'FAILED'] as const;
export const RULE_EVAL_STATUSES = [
  'TRIGGERED',
  'NOT_TRIGGERED',
  'NOT_APPLICABLE',
  'NOT_EVALUABLE',
  'ERROR',
] as const;
export const SEVERITIES = ['high', 'moderate', 'review_required', 'info'] as const;

export type AnalysisStatus = (typeof ANALYSIS_STATUSES)[number];
export type RuleEvalStatus = (typeof RULE_EVAL_STATUSES)[number];
export type Severity = (typeof SEVERITIES)[number];

export type ScenarioAction =
  | {
      type: 'add';
      ingredient_code: string;
      dose_value: number | null;
      dose_unit: string | null;
      route: string | null;
      frequency_per_day: number | null;
      duration_days: number | null;
    }
  | {
      type: 'modify';
      medication_statement_id: string;
      dose_value: number | null;
      dose_unit: string | null;
      route: string | null;
      frequency_per_day: number | null;
      duration_days: number | null;
    }
  | { type: 'stop'; medication_statement_id: string };

export type RegimenItem = {
  ingredient_code: string;
  ingredient_name: string;
  classes: string[];
  dose_value: number | null;
  dose_unit: string | null;
  route: string | null;
  frequency_per_day: number | null;
  duration_days: number | null;
  origin: 'existing' | 'added' | 'modified';
  medication_statement_id: string | null;
  supported_checks: string[];
  unsupported_checks: string[];
  in_catalog: boolean;
};

export type EvidenceRef = {
  evidence_id: string;
  title: string;
  url: string | null;
  section: string | null;
  verification_status: string;
};

export type Finding = {
  id: string;
  rule_id: string;
  rule_version: number;
  review_status: 'draft' | 'illustrative' | 'reviewed';
  threshold_origin: string;
  category: string;
  dimension: string;
  severity: Severity;
  message: string;
  /** The exact facts and parameters the message was rendered from (FR-12). */
  triggering_facts: Array<{ code: string; value: string | null; observed_at: string | null; fact_id: string | null }>;
  params: Record<string, number | string>;
  evidence_refs: EvidenceRef[];
  clinical_note: string;
  grouped_rule_ids: string[];
};

export type RuleEvaluation = {
  rule_id: string;
  rule_version: number;
  review_status: 'draft' | 'illustrative' | 'reviewed';
  dimension: string;
  status: RuleEvalStatus;
  missing_fields: string[];
  reason: string | null;
};

export type Coverage = {
  evaluated_count: number;
  not_evaluable_count: number;
  not_applicable_count: number;
  error_count: number;
  illustrative_count: number;
  unsupported_medication_ids: string[];
  unevaluated_dimensions: string[];
};

export type Scenario = BaseFields & {
  clinic_id: string;
  patient_id: string;
  profile_revision_id: string;
  version: number;
  label: string;
  derived_from_scenario_id: string | null;
  actions: ScenarioAction[];
  /** Server-computed result of applying actions to the confirmed regimen (UF-02.4). */
  final_regimen: RegimenItem[];
  status: 'draft' | 'analyzed';
  created_by: string | null;
};

export type Analysis = BaseFields & {
  clinic_id: string;
  patient_id: string;
  scenario_id: string;
  scenario_version: number;
  scenario_label: string;
  profile_revision_id: string;
  ruleset_version: string;
  ruleset_checksum: string;
  catalog_version: string;
  input_hash: string;
  status: AnalysisStatus;
  stale: boolean;
  /** Only findings from rules with review_status === "reviewed" (spec 10.2). */
  findings: Finding[];
  /** Findings from unreviewed rules, kept strictly out of the clinical set. */
  illustrative_findings: Finding[];
  rule_evaluations: RuleEvaluation[];
  coverage: Coverage;
  missing_data: Array<{ field: string; reason: string }>;
  is_synthetic: boolean;
  error_code: string | null;
  created_by: string | null;
};

export type Decision = BaseFields & {
  clinic_id: string;
  patient_id: string;
  analysis_id: string;
  comparison_id: string | null;
  selected_scenario_id: string | null;
  action: 'accept_a' | 'accept_b' | 'accept' | 'reject_all';
  reason: string;
  actor_id: string;
};

const scenarioSchema = new Schema<Scenario>(
  {
    ...uuidId,
    clinic_id: { type: String, required: true, index: true },
    patient_id: { type: String, required: true, index: true },
    profile_revision_id: { type: String, required: true },
    version: { type: Number, required: true, default: 1 },
    label: { type: String, required: true },
    derived_from_scenario_id: { type: String, default: null },
    actions: { type: [Object], default: [] },
    final_regimen: { type: [Object], default: [] },
    status: { type: String, enum: ['draft', 'analyzed'], default: 'draft' },
    created_by: { type: String, default: null },
  },
  baseOptions,
);
scenarioSchema.index({ patient_id: 1, label: 1, version: -1 });

/**
 * Findings and per-rule evaluations are embedded: an analysis is an immutable
 * snapshot, so there is nothing to join and nothing to update afterwards.
 */
const analysisSchema = new Schema<Analysis>(
  {
    ...uuidId,
    clinic_id: { type: String, required: true, index: true },
    patient_id: { type: String, required: true, index: true },
    scenario_id: { type: String, required: true, index: true },
    scenario_version: { type: Number, required: true },
    scenario_label: { type: String, required: true },
    profile_revision_id: { type: String, required: true },
    ruleset_version: { type: String, required: true },
    ruleset_checksum: { type: String, required: true },
    catalog_version: { type: String, required: true },
    input_hash: { type: String, required: true, index: true },
    status: { type: String, enum: ANALYSIS_STATUSES, required: true },
    stale: { type: Boolean, default: false },
    findings: { type: [Object], default: [] },
    illustrative_findings: { type: [Object], default: [] },
    rule_evaluations: { type: [Object], default: [] },
    coverage: { type: Object, required: true },
    missing_data: { type: [Object], default: [] },
    is_synthetic: { type: Boolean, default: true },
    error_code: { type: String, default: null },
    created_by: { type: String, default: null },
  },
  baseOptions,
);

const decisionSchema = new Schema<Decision>(
  {
    ...uuidId,
    clinic_id: { type: String, required: true, index: true },
    patient_id: { type: String, required: true, index: true },
    analysis_id: { type: String, required: true, index: true },
    comparison_id: { type: String, default: null },
    selected_scenario_id: { type: String, default: null },
    action: { type: String, enum: ['accept_a', 'accept_b', 'accept', 'reject_all'], required: true },
    reason: { type: String, required: true },
    actor_id: { type: String, required: true },
  },
  baseOptions,
);

export const ScenarioModel = model<Scenario>('Scenario', scenarioSchema);
export const AnalysisModel = model<Analysis>('Analysis', analysisSchema);
export const DecisionModel = model<Decision>('Decision', decisionSchema);
