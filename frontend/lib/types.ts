export type Role = 'doctor' | 'admin';

export type Me = {
  user: { id: string; email: string; display_name: string; role: Role; clinic: { id: string; name: string } };
  app_env: string;
  is_demo: boolean;
};

export type PatientListItem = {
  id: string;
  synthetic_code: string;
  age: number;
  is_synthetic: boolean;
  allergy_status: AllergyStatus;
  confirmed_conditions: string[];
  last_updated_at: string | null;
  profile_revision_id: string | null;
};

export type AllergyStatus = 'UNKNOWN' | 'KNOWN_NONE' | 'PRESENT';
export type FactStatus = 'EXTRACTED' | 'CONFIRMED' | 'REJECTED' | 'SUPERSEDED' | 'CONFLICTED';
export type FactKind = 'observation' | 'condition' | 'allergy' | 'medication';

export type SnapshotFact = {
  fact_id: string;
  kind: FactKind;
  code: string;
  display_name: string | null;
  raw_value: string | null;
  normalized_value: number | null;
  unit: string | null;
  normalized_unit: string | null;
  observed_at: string | null;
  status: FactStatus;
  conflict_note: string | null;
  source: { kind: string; document_id: string | null; page: number | null; quote: string | null; quote_verified: boolean };
};

export type SnapshotMedication = {
  statement_id: string;
  ingredient_code: string;
  ingredient_name: string;
  dose_value: number | null;
  dose_unit: string | null;
  route: string | null;
  frequency_per_day: number | null;
  status: 'active' | 'stopped' | 'unconfirmed';
  source_fact_id: string | null;
  supported_checks: string[];
  unsupported_checks: string[];
};

export type PatientProfile = {
  id: string;
  synthetic_code: string;
  age: number;
  model_sex: string;
  is_synthetic: boolean;
  allergy_status: AllergyStatus;
  profile_revision: { id: string; revision_no: number; confirmed_at: string | null } | null;
  conditions: SnapshotFact[];
  allergies: SnapshotFact[];
  observations: SnapshotFact[];
  medications: SnapshotMedication[];
  timeline: Array<{
    kind: FactKind;
    code: string;
    label: string;
    value: number | null;
    unit: string | null;
    observed_at: string | null;
    source: string;
    status: FactStatus;
  }>;
  data_gaps: { conflicting: string[]; undated: string[]; allergy_unknown: boolean };
};

export type DocumentItem = {
  id: string;
  filename: string;
  mime_type: string;
  page_count: number | null;
  status: string;
  is_synthetic: boolean;
  created_at?: string;
  text_preview?: string;
};

export type MedicationMatch = {
  status: 'exact' | 'ambiguous' | 'unsupported';
  candidates: Array<{ ingredient_code: string; ingredient_name: string }>;
};

export type CandidateFact = {
  index: number;
  kind: FactKind;
  code: string;
  raw_value: string | null;
  normalized_value: number | null;
  unit: string | null;
  normalized_unit: string | null;
  unit_conversion_note: string | null;
  observed_at: string | null;
  medication_status: 'current' | 'past' | 'unclear' | null;
  source_page: number | null;
  source_quote: string;
  source_quote_verified: boolean;
  medication_match: MedicationMatch | null;
  needs_review: boolean;
  blocked_reason: string | null;
};

export type ProviderUsage = {
  provider: string;
  model_id: string;
  model_revision: string | null;
  prompt_version: string;
  schema_version: string;
  latency_ms: number;
  input_tokens: number | null;
  output_tokens: number | null;
  finish_status: string | null;
  cache_hit: boolean;
};

export type Extraction = {
  id: string;
  document_id: string;
  status: 'PENDING' | 'COMPLETED' | 'FAILED' | 'MANUAL_REQUIRED';
  error_code: string | null;
  error_message: string | null;
  provider: string;
  provider_model: string;
  model_revision: string | null;
  page_selection: number[];
  chunk_count: number;
  is_recorded_demo: boolean;
  cache_hit: boolean;
  repair_attempted: boolean;
  usage: ProviderUsage;
  warnings: string[];
  candidates: CandidateFact[];
  confirmed_at: string | null;
  resulting_profile_revision_id: string | null;
  manual_entry_available: boolean;
  document?: { id: string; filename: string; text: string } | null;
};

export type Severity = 'high' | 'moderate' | 'review_required' | 'info';
export type ReviewStatus = 'draft' | 'illustrative' | 'reviewed';

export type EvidenceRef = {
  evidence_id: string;
  title: string;
  url: string | null;
  section: string | null;
  verification_status: string;
};

export type WhyPanel = {
  finding_id: string;
  rule_id: string;
  rule_version: number;
  review_status: ReviewStatus;
  threshold_origin: string;
  severity: Severity;
  message: string;
  used_facts: Array<{ code: string; value: string | null; observed_at: string | null; fact_id: string | null }>;
  rule_params: Record<string, number | string>;
  evidence: EvidenceRef[];
  clinical_note: string;
  grouped_rule_ids: string[];
  required_review: string;
};

export type Finding = {
  id: string;
  rule_id: string;
  rule_version: number;
  review_status: ReviewStatus;
  threshold_origin: string;
  category: string;
  dimension: string;
  severity: Severity;
  message: string;
  triggering_facts: Array<{ code: string; value: string | null; observed_at: string | null; fact_id: string | null }>;
  params: Record<string, number | string>;
  evidence_refs: EvidenceRef[];
  clinical_note: string;
  grouped_rule_ids: string[];
  why: WhyPanel;
};

export type RuleEvaluation = {
  rule_id: string;
  rule_version: number;
  review_status: ReviewStatus;
  dimension: string;
  status: 'TRIGGERED' | 'NOT_TRIGGERED' | 'NOT_APPLICABLE' | 'NOT_EVALUABLE' | 'ERROR';
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

export type Analysis = {
  id: string;
  patient_id: string;
  scenario_id: string;
  scenario_label: string;
  scenario_version: number;
  profile_revision_id: string;
  ruleset_version: string;
  ruleset_checksum: string;
  catalog_version: string;
  input_hash: string;
  status: 'COMPLETED' | 'PARTIAL' | 'BLOCKED' | 'FAILED';
  stale: boolean;
  findings: Finding[];
  illustrative_findings: Finding[];
  rule_evaluations: RuleEvaluation[];
  coverage: Coverage;
  missing_data: Array<{ field: string; reason: string }>;
  is_synthetic: boolean;
  error_code: string | null;
  created_at: string | null;
  empty_state_text: string | null;
  no_finding_text: string;
  validation_notice: string;
};

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

export type Scenario = {
  id: string;
  patient_id: string;
  profile_revision_id: string;
  version: number;
  label: string;
  derived_from_scenario_id: string | null;
  actions: ScenarioAction[];
  final_regimen: RegimenItem[];
  status: 'draft' | 'analyzed';
};

export type Medication = {
  ingredient_code: string;
  ingredient_name: string;
  aliases: string[];
  classes: string[];
  allowed_forms: string[];
  allowed_units: string[];
  routes: string[];
  products: Array<{ form: string; strength_value: number; strength_unit: string }>;
  supported_checks: string[];
  unsupported_checks: string[];
};

export type ComparisonRow = {
  key: string;
  dimension: string;
  severity: Severity;
  review_status: ReviewStatus;
  message: string;
  in_a: boolean;
  in_b: boolean;
  rule_ids: string[];
};

export type Comparison = {
  a: { analysis_id: string; label: string; status: string; stale: boolean };
  b: { analysis_id: string; label: string; status: string; stale: boolean };
  profile_revision_id: string;
  ruleset_version: string;
  findings_diff: ComparisonRow[];
  illustrative_diff: ComparisonRow[];
  coverage_diff: {
    evaluated_count: [number, number];
    not_evaluable_count: [number, number];
    unevaluated_dimensions_only_in_a: string[];
    unevaluated_dimensions_only_in_b: string[];
  };
  ranking_note: string;
};

export type Capabilities = {
  app_env: string;
  is_synthetic_environment: boolean;
  ruleset: {
    version: string;
    checksum: string;
    release_status: string;
    reviewed_at: string | null;
    reviewed_by: string | null;
    enabled_rule_count: number;
    reviewed_rule_count: number;
    illustrative_rule_count: number;
  };
  catalog: { version: string; medication_count: number };
  evidence: { version: string; pending_review_count: number };
  dimensions: { supported: string[]; unsupported: string[] };
  ai: {
    provider: string;
    model_id: string;
    prompt_version: string;
    schema_version: string;
    parser_version: string;
    timeout_seconds: number;
    max_concurrency: number;
    in_flight: number;
    local_fallback_enabled: boolean;
    allow_paid_providers: boolean;
    allow_real_patient_data: boolean;
    configured: boolean;
  };
  modules: Record<string, { enabled: boolean; status: string }>;
};

export type AuditItem = {
  id: string;
  action: string;
  entity_type: string;
  entity_id: string | null;
  actor_id: string | null;
  status: string;
  request_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string | null;
};
