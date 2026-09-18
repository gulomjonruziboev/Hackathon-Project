import { Schema, model } from 'mongoose';
import { baseOptions, uuidId, type BaseFields } from './base.js';

export type MedicationProduct = { form: string; strength_value: number; strength_unit: string };

export type Medication = BaseFields & {
  ingredient_code: string;
  ingredient_name: string;
  aliases: string[];
  classes: string[];
  allowed_forms: string[];
  allowed_units: string[];
  routes: string[];
  products: MedicationProduct[];
  supported_checks: string[];
  unsupported_checks: string[];
  catalog_version: string;
};

export type RuleSet = BaseFields & {
  version: string;
  checksum: string;
  release_status: string;
  reviewed_at: Date | null;
  reviewed_by: string | null;
  rule_count: number;
  reviewed_rule_count: number;
  illustrative_rule_count: number;
  payload: unknown;
};

export type EvidenceSource = BaseFields & {
  source_id: string;
  title: string;
  url: string | null;
  section: string | null;
  content_version: string | null;
  accessed_at: Date | null;
  verification_status: string;
  license_note: string | null;
};

const medicationSchema = new Schema<Medication>(
  {
    ...uuidId,
    ingredient_code: { type: String, required: true, unique: true },
    ingredient_name: { type: String, required: true },
    aliases: { type: [String], default: [] },
    classes: { type: [String], default: [] },
    allowed_forms: { type: [String], default: [] },
    allowed_units: { type: [String], default: [] },
    routes: { type: [String], default: [] },
    products: { type: [Object], default: [] },
    supported_checks: { type: [String], default: [] },
    unsupported_checks: { type: [String], default: [] },
    catalog_version: { type: String, required: true },
  },
  baseOptions,
);

/** Versioned, checksummed copy of clinical-content/ruleset.json (spec 8, 10.2). */
const ruleSetSchema = new Schema<RuleSet>(
  {
    ...uuidId,
    version: { type: String, required: true, unique: true },
    checksum: { type: String, required: true },
    release_status: { type: String, required: true },
    reviewed_at: { type: Date, default: null },
    reviewed_by: { type: String, default: null },
    rule_count: { type: Number, required: true },
    reviewed_rule_count: { type: Number, required: true },
    illustrative_rule_count: { type: Number, required: true },
    payload: { type: Object, required: true },
  },
  baseOptions,
);

const evidenceSourceSchema = new Schema<EvidenceSource>(
  {
    ...uuidId,
    source_id: { type: String, required: true, unique: true },
    title: { type: String, required: true },
    url: { type: String, default: null },
    section: { type: String, default: null },
    content_version: { type: String, default: null },
    accessed_at: { type: Date, default: null },
    verification_status: { type: String, required: true },
    license_note: { type: String, default: null },
  },
  baseOptions,
);

export const MedicationModel = model<Medication>('Medication', medicationSchema);
export const RuleSetModel = model<RuleSet>('RuleSet', ruleSetSchema);
export const EvidenceSourceModel = model<EvidenceSource>('EvidenceSource', evidenceSourceSchema);
