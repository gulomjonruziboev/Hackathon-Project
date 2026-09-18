import { Schema, model } from 'mongoose';
import { baseOptions, uuidId, type BaseFields } from './base.js';

export const FACT_STATUSES = ['EXTRACTED', 'CONFIRMED', 'REJECTED', 'SUPERSEDED', 'CONFLICTED'] as const;
export const FACT_KINDS = ['observation', 'condition', 'allergy', 'medication'] as const;
export const ALLERGY_STATUSES = ['UNKNOWN', 'KNOWN_NONE', 'PRESENT'] as const;

export type FactStatus = (typeof FACT_STATUSES)[number];
export type FactKind = (typeof FACT_KINDS)[number];
export type AllergyStatus = (typeof ALLERGY_STATUSES)[number];

export type Patient = BaseFields & {
  clinic_id: string;
  synthetic_code: string;
  birth_date: Date;
  /** Spec 8: stored only because a model may require it; never inferred from a name. */
  model_sex: 'female' | 'male' | 'unknown';
  is_synthetic: boolean;
  /** UNKNOWN until a doctor confirms; absence of an allergy in a document is not KNOWN_NONE. */
  allergy_status: AllergyStatus;
  current_profile_revision_id: string | null;
  created_by: string | null;
};

export type ClinicalFact = BaseFields & {
  clinic_id: string;
  patient_id: string;
  kind: FactKind;
  code: string;
  display_name: string | null;
  raw_value: string | null;
  normalized_value: number | null;
  unit: string | null;
  normalized_unit: string | null;
  unit_conversion_note: string | null;
  observed_at: Date | null;
  status: FactStatus;
  source: 'extraction' | 'manual' | 'seed';
  source_document_id: string | null;
  source_page: number | null;
  source_quote: string | null;
  source_quote_verified: boolean;
  extraction_id: string | null;
  supersedes_id: string | null;
  conflict_note: string | null;
  confirmed_by: string | null;
  confirmed_at: Date | null;
  created_by: string | null;
};

/** One entry of `ProfileRevision.facts_snapshot`. */
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
  source: {
    kind: 'extraction' | 'manual' | 'seed';
    document_id: string | null;
    page: number | null;
    quote: string | null;
    quote_verified: boolean;
  };
};

/** One entry of `ProfileRevision.medications_snapshot`. */
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
};

export type ProfileRevision = BaseFields & {
  clinic_id: string;
  patient_id: string;
  revision_no: number;
  facts_snapshot: SnapshotFact[];
  medications_snapshot: SnapshotMedication[];
  allergy_status: AllergyStatus;
  reason: string | null;
  confirmed_by: string | null;
  confirmed_at: Date | null;
};

export type MedicationStatement = BaseFields & {
  clinic_id: string;
  patient_id: string;
  ingredient_code: string;
  dose_value: number | null;
  dose_unit: string | null;
  route: string | null;
  frequency_per_day: number | null;
  start_date: Date | null;
  end_date: Date | null;
  status: 'active' | 'stopped' | 'unconfirmed';
  source_fact_id: string | null;
};

const patientSchema = new Schema<Patient>(
  {
    ...uuidId,
    clinic_id: { type: String, required: true, index: true },
    synthetic_code: { type: String, required: true },
    birth_date: { type: Date, required: true },
    model_sex: { type: String, enum: ['female', 'male', 'unknown'], default: 'unknown' },
    is_synthetic: { type: Boolean, default: true },
    allergy_status: { type: String, enum: ALLERGY_STATUSES, default: 'UNKNOWN' },
    current_profile_revision_id: { type: String, default: null },
    created_by: { type: String, default: null },
  },
  baseOptions,
);
patientSchema.index({ clinic_id: 1, synthetic_code: 1 }, { unique: true });

/**
 * ClinicalFact is append-only: a correction supersedes the previous fact
 * instead of mutating it (spec 8).
 */
const clinicalFactSchema = new Schema<ClinicalFact>(
  {
    ...uuidId,
    clinic_id: { type: String, required: true, index: true },
    patient_id: { type: String, required: true, index: true },
    kind: { type: String, required: true, enum: FACT_KINDS },
    code: { type: String, required: true },
    display_name: { type: String, default: null },
    raw_value: { type: String, default: null },
    normalized_value: { type: Number, default: null },
    unit: { type: String, default: null },
    normalized_unit: { type: String, default: null },
    unit_conversion_note: { type: String, default: null },
    observed_at: { type: Date, default: null },
    status: { type: String, required: true, enum: FACT_STATUSES, default: 'EXTRACTED' },
    source: { type: String, required: true, enum: ['extraction', 'manual', 'seed'], default: 'extraction' },
    source_document_id: { type: String, default: null },
    source_page: { type: Number, default: null },
    source_quote: { type: String, default: null },
    source_quote_verified: { type: Boolean, default: false },
    extraction_id: { type: String, default: null },
    supersedes_id: { type: String, default: null },
    conflict_note: { type: String, default: null },
    confirmed_by: { type: String, default: null },
    confirmed_at: { type: Date, default: null },
    created_by: { type: String, default: null },
  },
  baseOptions,
);

/**
 * A ProfileRevision is the immutable snapshot the rule engine reads.
 * Analyses always pin one, so A/B comparison is like-for-like (FR-11).
 */
const profileRevisionSchema = new Schema<ProfileRevision>(
  {
    ...uuidId,
    clinic_id: { type: String, required: true, index: true },
    patient_id: { type: String, required: true, index: true },
    revision_no: { type: Number, required: true },
    facts_snapshot: { type: [Object], default: [] },
    medications_snapshot: { type: [Object], default: [] },
    allergy_status: { type: String, enum: ALLERGY_STATUSES, default: 'UNKNOWN' },
    reason: { type: String, default: null },
    confirmed_by: { type: String, default: null },
    confirmed_at: { type: Date, default: null },
  },
  baseOptions,
);
profileRevisionSchema.index({ patient_id: 1, revision_no: -1 });

const medicationStatementSchema = new Schema<MedicationStatement>(
  {
    ...uuidId,
    clinic_id: { type: String, required: true, index: true },
    patient_id: { type: String, required: true, index: true },
    ingredient_code: { type: String, required: true },
    dose_value: { type: Number, default: null },
    dose_unit: { type: String, default: null },
    route: { type: String, default: null },
    frequency_per_day: { type: Number, default: null },
    start_date: { type: Date, default: null },
    end_date: { type: Date, default: null },
    status: { type: String, enum: ['active', 'stopped', 'unconfirmed'], default: 'unconfirmed' },
    source_fact_id: { type: String, default: null },
  },
  baseOptions,
);

export const PatientModel = model<Patient>('Patient', patientSchema);
export const ClinicalFactModel = model<ClinicalFact>('ClinicalFact', clinicalFactSchema);
export const ProfileRevisionModel = model<ProfileRevision>('ProfileRevision', profileRevisionSchema);
export const MedicationStatementModel = model<MedicationStatement>('MedicationStatement', medicationStatementSchema);
