import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { canonicalJson, sha256 } from '../utils/canonical.js';
import { env } from '../config/env.js';

/* ------------------------------ schemas ------------------------------ */

const productSchema = z.object({
  form: z.string(),
  strength_value: z.number(),
  strength_unit: z.string(),
});

const medicationSchema = z.object({
  ingredient_code: z.string().min(1),
  ingredient_name: z.string().min(1),
  aliases: z.array(z.string()).default([]),
  classes: z.array(z.string()).default([]),
  allowed_forms: z.array(z.string()).default([]),
  allowed_units: z.array(z.string()).default([]),
  routes: z.array(z.string()).default([]),
  products: z.array(productSchema).default([]),
  supported_checks: z.array(z.string()).default([]),
  unsupported_checks: z.array(z.string()).default([]),
});

const medicationsFileSchema = z.object({
  catalog_version: z.string(),
  note: z.string().optional(),
  medications: z.array(medicationSchema).min(1),
});

/** Declarative predicate tree. Anything not listed here is rejected at load time. */
const predicateSchema: z.ZodType<Predicate> = z.lazy(() =>
  z.union([
    z.object({ op: z.literal('always') }),
    z.object({ op: z.literal('never') }),
    z.object({ op: z.literal('regimen_has_ingredient'), ingredient_code: z.string() }),
    z.object({ op: z.literal('regimen_has_class'), class: z.string() }),
    z.object({ op: z.literal('regimen_has_duplicate_ingredient') }),
    z.object({ op: z.literal('allergy_matches_regimen') }),
    z.object({
      op: z.literal('regimen_has_class_count'),
      class: z.string(),
      cmp: z.enum(['lt', 'lte', 'gt', 'gte', 'eq']),
      value: z.number().optional(),
      param: z.string().optional(),
    }),
    z.object({
      op: z.literal('fact_compare'),
      code: z.string(),
      cmp: z.enum(['lt', 'lte', 'gt', 'gte', 'eq']),
      value: z.number().optional(),
      param: z.string().optional(),
    }),
    z.object({
      op: z.literal('fact_between'),
      code: z.string(),
      min: z.number().optional(),
      max: z.number().optional(),
      min_param: z.string().optional(),
      max_param: z.string().optional(),
    }),
    z.object({ op: z.literal('fact_exists'), code: z.string() }),
    z.object({ op: z.literal('has_condition_any'), codes: z.array(z.string()).min(1) }),
    z.object({ all: z.array(predicateSchema).min(1) }),
    z.object({ any: z.array(predicateSchema).min(1) }),
    z.object({ none: z.array(predicateSchema).min(1) }),
    z.object({}).strict(),
  ]),
);

const ruleSchema = z.object({
  id: z.string().min(1),
  version: z.number().int().positive(),
  enabled: z.boolean(),
  category: z.string(),
  dimension: z.string(),
  review_status: z.enum(['draft', 'illustrative', 'reviewed']),
  threshold_origin: z.enum(['mechanical', 'source_pending_verification', 'source_verified']),
  reviewed_by: z.string().nullable(),
  reviewed_at: z.string().nullable(),
  required_fields: z.array(z.string()).default([]),
  freshness: z
    .object({ fact_code: z.string(), max_age_days: z.number().int().positive() })
    .nullable()
    .default(null),
  params: z.record(z.string(), z.union([z.number(), z.string()])).default({}),
  applicability: predicateSchema,
  condition: predicateSchema,
  severity: z.enum(['high', 'moderate', 'review_required', 'info']),
  message_template: z.string().min(1),
  evidence_ids: z.array(z.string()).default([]),
  clinical_note: z.string().default(''),
});

const rulesetFileSchema = z.object({
  ruleset_version: z.string(),
  release_status: z.string(),
  reviewed_at: z.string().nullable(),
  reviewed_by: z.string().nullable(),
  note: z.string().optional(),
  severity_scale: z.array(z.string()).default([]),
  dimensions_supported: z.array(z.string()).default([]),
  dimensions_unsupported: z.array(z.string()).default([]),
  rules: z.array(ruleSchema),
});

const evidenceFileSchema = z.object({
  evidence_version: z.string(),
  note: z.string().optional(),
  sources: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      url: z.string().nullable(),
      section: z.string().nullable(),
      content_version: z.string().nullable(),
      accessed_at: z.string().nullable(),
      verification_status: z.enum(['pending_review', 'verified', 'not_applicable']),
      license_note: z.string().nullable(),
    }),
  ),
});

/* ------------------------------ types ------------------------------ */

export type Comparator = 'lt' | 'lte' | 'gt' | 'gte' | 'eq';

export type Predicate =
  | { op: 'always' }
  | { op: 'never' }
  | { op: 'regimen_has_ingredient'; ingredient_code: string }
  | { op: 'regimen_has_class'; class: string }
  | { op: 'regimen_has_duplicate_ingredient' }
  | { op: 'allergy_matches_regimen' }
  | { op: 'regimen_has_class_count'; class: string; cmp: Comparator; value?: number; param?: string }
  | { op: 'fact_compare'; code: string; cmp: Comparator; value?: number; param?: string }
  | { op: 'fact_between'; code: string; min?: number; max?: number; min_param?: string; max_param?: string }
  | { op: 'fact_exists'; code: string }
  | { op: 'has_condition_any'; codes: string[] }
  | { all: Predicate[] }
  | { any: Predicate[] }
  | { none: Predicate[] }
  | Record<string, never>;

export type Rule = z.infer<typeof ruleSchema>;
export type MedicationEntry = z.infer<typeof medicationSchema>;
export type EvidenceEntry = z.infer<typeof evidenceFileSchema>['sources'][number];

export type ClinicalContent = {
  catalogVersion: string;
  medications: MedicationEntry[];
  rulesetVersion: string;
  rulesetChecksum: string;
  releaseStatus: string;
  reviewedAt: string | null;
  reviewedBy: string | null;
  rules: Rule[];
  dimensionsSupported: string[];
  dimensionsUnsupported: string[];
  evidenceVersion: string;
  evidence: EvidenceEntry[];
  rulesetPayload: unknown;
};

/* ------------------------------ loading ------------------------------ */

function readJson(dir: string, file: string): unknown {
  const full = path.join(dir, file);
  if (!fs.existsSync(full)) throw new Error(`Klinik kontent fayli topilmadi: ${full}`);
  return JSON.parse(fs.readFileSync(full, 'utf8'));
}

let cache: { dir: string; content: ClinicalContent } | null = null;

export function loadClinicalContent(dir: string = env().clinicalContentDir): ClinicalContent {
  if (cache && cache.dir === dir) return cache.content;

  const medicationsFile = medicationsFileSchema.parse(readJson(dir, 'medications.json'));
  const rulesetRaw = readJson(dir, 'ruleset.json');
  const rulesetFile = rulesetFileSchema.parse(rulesetRaw);
  const evidenceFile = evidenceFileSchema.parse(readJson(dir, 'evidence.json'));

  const knownEvidence = new Set(evidenceFile.sources.map((s) => s.id));
  for (const rule of rulesetFile.rules) {
    for (const id of rule.evidence_ids) {
      if (!knownEvidence.has(id)) {
        throw new Error(`Qoida ${rule.id} mavjud bo'lmagan dalil identifikatoriga murojaat qilyapti: ${id}`);
      }
    }
    // A rule may only enter the clinical set when every source it cites is verified.
    if (rule.review_status === 'reviewed') {
      const unverified = rule.evidence_ids.filter((id) => {
        const src = evidenceFile.sources.find((s) => s.id === id);
        return src ? src.verification_status === 'pending_review' : true;
      });
      if (unverified.length > 0) {
        throw new Error(
          `Qoida ${rule.id} "reviewed" deb belgilangan, ammo dalillari tekshirilmagan: ${unverified.join(', ')}`,
        );
      }
    }
  }

  const ids = rulesetFile.rules.map((r) => r.id);
  const duplicate = ids.find((id, i) => ids.indexOf(id) !== i);
  if (duplicate) throw new Error(`Qoida identifikatori takrorlangan: ${duplicate}`);

  const content: ClinicalContent = {
    catalogVersion: medicationsFile.catalog_version,
    medications: medicationsFile.medications,
    rulesetVersion: rulesetFile.ruleset_version,
    rulesetChecksum: sha256(canonicalJson(rulesetRaw)),
    releaseStatus: rulesetFile.release_status,
    reviewedAt: rulesetFile.reviewed_at,
    reviewedBy: rulesetFile.reviewed_by,
    rules: rulesetFile.rules,
    dimensionsSupported: rulesetFile.dimensions_supported,
    dimensionsUnsupported: rulesetFile.dimensions_unsupported,
    evidenceVersion: evidenceFile.evidence_version,
    evidence: evidenceFile.sources,
    rulesetPayload: rulesetRaw,
  };

  cache = { dir, content };
  return content;
}

export function resetContentCache(): void {
  cache = null;
}

export function findMedicationByCode(content: ClinicalContent, code: string): MedicationEntry | undefined {
  return content.medications.find((m) => m.ingredient_code === code);
}

/**
 * Trade-name lookup for UI-05: exact (case-insensitive) matches only.
 * An approximate match is never silently accepted — the caller must let the
 * doctor pick when more than one candidate comes back.
 */
export function matchMedicationsByName(content: ClinicalContent, query: string): MedicationEntry[] {
  const q = query.trim().toLowerCase();
  if (q === '') return [];
  return content.medications.filter(
    (m) =>
      m.ingredient_code.toLowerCase() === q ||
      m.ingredient_name.toLowerCase() === q ||
      m.aliases.some((a) => a.toLowerCase() === q),
  );
}
