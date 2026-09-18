import { randomUUID } from 'node:crypto';
import type { ClinicalContent, Comparator, Predicate, Rule } from '../content/loader.js';
import type {
  Coverage,
  Finding,
  ProfileRevision,
  RegimenItem,
  RuleEvaluation,
  SnapshotFact,
} from '../models/index.js';
import { ageInDays, parseIsoDate } from '../utils/dates.js';
import { renderTemplate } from './explanationService.js';
import { confirmedAllergies, confirmedConditions, latestObservation } from './profileService.js';

/** Three-valued logic: a predicate that needs data we do not have is `unknown`. */
type Tri = true | false | 'unknown';

type EvalContext = {
  revision: ProfileRevision;
  regimen: RegimenItem[];
  rule: Rule;
  now: Date;
  missing: Set<string>;
  bindings: Map<string, string>;
};

export type RuleEngineResult = {
  evaluations: RuleEvaluation[];
  findings: Finding[];
  illustrativeFindings: Finding[];
  coverage: Coverage;
  missingData: Array<{ field: string; reason: string }>;
};

/* ------------------------------ predicates ------------------------------ */

function compare(a: number, cmp: Comparator, b: number): boolean {
  switch (cmp) {
    case 'lt':
      return a < b;
    case 'lte':
      return a <= b;
    case 'gt':
      return a > b;
    case 'gte':
      return a >= b;
    case 'eq':
      return a === b;
  }
}

function resolveParam(ctx: EvalContext, value: number | undefined, param: string | undefined): number | null {
  if (typeof value === 'number') return value;
  if (param) {
    const raw = ctx.rule.params[param];
    if (typeof raw === 'number') return raw;
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function usableObservation(ctx: EvalContext, code: string): { value: number; fact: SnapshotFact } | null {
  const found = latestObservation(ctx.revision, code);
  if (!found) {
    ctx.missing.add(`fact:${code}`);
    return null;
  }
  if (found.conflicted) {
    // Spec 8.1 / AT-09: conflicting values are never silently resolved.
    ctx.missing.add(`fact:${code}`);
    return null;
  }
  if (found.fact.normalized_value == null) {
    ctx.missing.add(`fact:${code}`);
    return null;
  }
  return { value: found.fact.normalized_value, fact: found.fact };
}

function ingredientsOfClass(ctx: EvalContext, klass: string): RegimenItem[] {
  return ctx.regimen.filter((item) => item.classes.includes(klass));
}

function evaluate(node: Predicate, ctx: EvalContext): Tri {
  if (!node || Object.keys(node).length === 0) return true;

  if ('all' in node && Array.isArray(node.all)) {
    let sawUnknown = false;
    for (const child of node.all) {
      const r = evaluate(child, ctx);
      if (r === false) return false;
      if (r === 'unknown') sawUnknown = true;
    }
    return sawUnknown ? 'unknown' : true;
  }
  if ('any' in node && Array.isArray(node.any)) {
    let sawUnknown = false;
    for (const child of node.any) {
      const r = evaluate(child, ctx);
      if (r === true) return true;
      if (r === 'unknown') sawUnknown = true;
    }
    return sawUnknown ? 'unknown' : false;
  }
  if ('none' in node && Array.isArray(node.none)) {
    let sawUnknown = false;
    for (const child of node.none) {
      const r = evaluate(child, ctx);
      if (r === true) return false;
      if (r === 'unknown') sawUnknown = true;
    }
    return sawUnknown ? 'unknown' : true;
  }

  if (!('op' in node)) return true;

  switch (node.op) {
    case 'always':
      return true;
    case 'never':
      return false;

    case 'regimen_has_ingredient': {
      const matched = ctx.regimen.filter((i) => i.ingredient_code === node.ingredient_code);
      if (matched.length > 0) {
        ctx.bindings.set('matched_ingredients', matched.map((i) => i.ingredient_name).join(', '));
      }
      return matched.length > 0;
    }

    case 'regimen_has_class': {
      const matched = ingredientsOfClass(ctx, node.class);
      if (matched.length > 0) {
        ctx.bindings.set(`${node.class}_ingredients`, matched.map((i) => i.ingredient_name).join(', '));
      }
      return matched.length > 0;
    }

    case 'regimen_has_class_count': {
      const matched = ingredientsOfClass(ctx, node.class);
      const threshold = resolveParam(ctx, node.value, node.param);
      if (threshold == null) return 'unknown';
      if (matched.length > 0) {
        ctx.bindings.set(`${node.class}_ingredients`, matched.map((i) => i.ingredient_name).join(', '));
      }
      return compare(matched.length, node.cmp, threshold);
    }

    case 'regimen_has_duplicate_ingredient': {
      const counts = new Map<string, RegimenItem[]>();
      for (const item of ctx.regimen) {
        const list = counts.get(item.ingredient_code) ?? [];
        list.push(item);
        counts.set(item.ingredient_code, list);
      }
      const duplicates = [...counts.values()].filter((list) => list.length > 1);
      if (duplicates.length === 0) return false;
      ctx.bindings.set(
        'duplicate_ingredients',
        duplicates.map((list) => `${list[0]!.ingredient_name} (${list.length})`).join(', '),
      );
      return true;
    }

    case 'allergy_matches_regimen': {
      if (ctx.revision.allergy_status === 'UNKNOWN') {
        ctx.missing.add('allergy_status');
        return 'unknown';
      }
      if (ctx.revision.allergy_status === 'KNOWN_NONE') return false;

      const allergyCodes = confirmedAllergies(ctx.revision).map((f) => f.code.toLowerCase());
      const matched = ctx.regimen.filter(
        (item) =>
          allergyCodes.includes(item.ingredient_code.toLowerCase()) ||
          allergyCodes.includes(item.ingredient_name.toLowerCase()),
      );
      if (matched.length === 0) return false;
      ctx.bindings.set('allergy_ingredients', matched.map((i) => i.ingredient_name).join(', '));
      return true;
    }

    case 'fact_exists':
      return usableObservation(ctx, node.code) !== null ? true : 'unknown';

    case 'fact_compare': {
      const obs = usableObservation(ctx, node.code);
      if (!obs) return 'unknown';
      const threshold = resolveParam(ctx, node.value, node.param);
      if (threshold == null) return 'unknown';
      bindObservation(ctx, node.code, obs.fact, obs.value);
      return compare(obs.value, node.cmp, threshold);
    }

    case 'fact_between': {
      const obs = usableObservation(ctx, node.code);
      if (!obs) return 'unknown';
      const min = resolveParam(ctx, node.min, node.min_param);
      const max = resolveParam(ctx, node.max, node.max_param);
      if (min == null || max == null) return 'unknown';
      bindObservation(ctx, node.code, obs.fact, obs.value);
      return obs.value >= min && obs.value <= max;
    }

    case 'has_condition_any': {
      const conditions = confirmedConditions(ctx.revision);
      if (conditions.length === 0) {
        ctx.missing.add('conditions');
        return 'unknown';
      }
      // Prefix match so ICD-style codes (N18.3) satisfy a rule written for N18.
      const matched = conditions.filter((c) =>
        node.codes.some((code) => c.code.toUpperCase().startsWith(code.toUpperCase())),
      );
      if (matched.length === 0) return false;
      ctx.bindings.set('matched_conditions', matched.map((c) => c.raw_value ?? c.code).join(', '));
      return true;
    }

    default:
      return 'unknown';
  }
}

function bindObservation(ctx: EvalContext, code: string, fact: SnapshotFact, value: number): void {
  const key = code.toLowerCase();
  ctx.bindings.set(`${key}_value`, String(value));
  ctx.bindings.set(`${key}_unit`, fact.normalized_unit ?? fact.unit ?? '');
  ctx.bindings.set(`${key}_observed_at`, fact.observed_at ?? 'sana ko‘rsatilmagan');
  ctx.bindings.set(`${key}_fact_id`, fact.fact_id);
}

/* ------------------------------ engine ------------------------------ */

/**
 * Deterministic evaluation of every enabled rule against one pinned profile
 * revision and one final regimen. Same inputs, same ruleset version, same
 * structural output (FR-09).
 */
export function evaluateRules(options: {
  content: ClinicalContent;
  revision: ProfileRevision;
  regimen: RegimenItem[];
  now?: Date;
}): RuleEngineResult {
  const now = options.now ?? new Date();
  const evaluations: RuleEvaluation[] = [];
  const reviewed: Finding[] = [];
  const illustrative: Finding[] = [];
  const missingData = new Map<string, string>();

  const rules = [...options.content.rules].sort((a, b) => a.id.localeCompare(b.id));

  for (const rule of rules) {
    if (!rule.enabled) continue;

    const ctx: EvalContext = {
      revision: options.revision,
      regimen: options.regimen,
      rule,
      now,
      missing: new Set<string>(),
      bindings: new Map<string, string>(),
    };

    let status: RuleEvaluation['status'];
    let reason: string | null = null;

    try {
      const applicable = evaluate(rule.applicability, ctx);

      if (applicable === false) {
        status = 'NOT_APPLICABLE';
        reason = 'Qoida bu rejaga taalluqli emas.';
      } else {
        const declaredMissing = checkRequiredFields(rule, ctx);
        const freshnessProblem = checkFreshness(rule, ctx);

        if (applicable === 'unknown' || declaredMissing.length > 0 || freshnessProblem) {
          status = 'NOT_EVALUABLE';
          reason = freshnessProblem ?? 'Zarur tasdiqlangan ma’lumot yetishmaydi.';
          for (const field of declaredMissing) ctx.missing.add(field);
        } else {
          const outcome = evaluate(rule.condition, ctx);
          if (outcome === 'unknown') {
            status = 'NOT_EVALUABLE';
            reason = 'Shartni baholash uchun ma’lumot yetarli emas.';
          } else if (outcome === true) {
            status = 'TRIGGERED';
            const finding = buildFinding(rule, ctx, options.content);
            (rule.review_status === 'reviewed' ? reviewed : illustrative).push(finding);
          } else {
            status = 'NOT_TRIGGERED';
          }
        }
      }
    } catch (err) {
      status = 'ERROR';
      reason = err instanceof Error ? err.message : 'Qoidani bajarishda xato.';
    }

    if (status === 'NOT_EVALUABLE') {
      for (const field of ctx.missing) {
        missingData.set(field, missingReason(field, options.revision));
      }
    }

    evaluations.push({
      rule_id: rule.id,
      rule_version: rule.version,
      review_status: rule.review_status,
      dimension: rule.dimension,
      status,
      missing_fields: [...ctx.missing].sort(),
      reason,
    });
  }

  return {
    evaluations,
    findings: groupFindings(reviewed),
    illustrativeFindings: groupFindings(illustrative),
    coverage: buildCoverage(evaluations, options.regimen, options.content, illustrative.length),
    missingData: [...missingData.entries()]
      .map(([field, reason]) => ({ field, reason }))
      .sort((a, b) => a.field.localeCompare(b.field)),
  };
}

function checkRequiredFields(rule: Rule, ctx: EvalContext): string[] {
  const missing: string[] = [];
  for (const field of rule.required_fields) {
    if (field.startsWith('fact:')) {
      if (!usableObservation(ctx, field.slice('fact:'.length))) missing.push(field);
      continue;
    }
    if (field === 'allergy_status') {
      if (ctx.revision.allergy_status === 'UNKNOWN') missing.push(field);
      continue;
    }
    if (field === 'conditions') {
      if (confirmedConditions(ctx.revision).length === 0) missing.push(field);
      continue;
    }
  }
  return missing;
}

/** Spec 8.2: the staleness window is per rule — there is no global expiry. */
function checkFreshness(rule: Rule, ctx: EvalContext): string | null {
  if (!rule.freshness) return null;
  const found = latestObservation(ctx.revision, rule.freshness.fact_code);
  if (!found || found.conflicted) {
    ctx.missing.add(`fact:${rule.freshness.fact_code}`);
    return 'Qoidaga kerakli ko‘rsatkich yo‘q yoki ziddiyatli.';
  }
  const observedAt = parseIsoDate(found.fact.observed_at);
  if (!observedAt) {
    ctx.missing.add(`fact:${rule.freshness.fact_code}`);
    return 'Ko‘rsatkich sanasi noma’lum — eskirganini aniqlab bo‘lmadi.';
  }
  const age = ageInDays(observedAt, ctx.now);
  if (age > rule.freshness.max_age_days) {
    ctx.missing.add(`fact:${rule.freshness.fact_code}`);
    return `Ko‘rsatkich ${age} kunlik; qoida ${rule.freshness.max_age_days} kundan eski qiymatni ishlatmaydi.`;
  }
  return null;
}

function missingReason(field: string, revision: ProfileRevision): string {
  if (field === 'allergy_status') return 'allergy_status_unknown';
  if (field === 'conditions') return 'no_confirmed_conditions';
  const code = field.startsWith('fact:') ? field.slice('fact:'.length) : field;
  const found = latestObservation(revision, code);
  if (!found) return 'not_confirmed';
  if (found.conflicted) return 'conflicting_values';
  if (found.fact.normalized_value == null) return 'no_numeric_value';
  return 'stale_or_undated';
}

function buildFinding(rule: Rule, ctx: EvalContext, content: ClinicalContent): Finding {
  return {
    id: randomUUID(),
    rule_id: rule.id,
    rule_version: rule.version,
    review_status: rule.review_status,
    threshold_origin: rule.threshold_origin,
    category: rule.category,
    dimension: rule.dimension,
    severity: rule.severity,
    message: renderTemplate(rule.message_template, ctx.bindings, rule.params),
    triggering_facts: collectTriggeringFacts(ctx),
    params: rule.params,
    evidence_refs: rule.evidence_ids.map((id) => {
      const source = content.evidence.find((e) => e.id === id);
      return {
        evidence_id: id,
        title: source?.title ?? id,
        url: source?.url ?? null,
        section: source?.section ?? null,
        verification_status: source?.verification_status ?? 'unknown',
      };
    }),
    clinical_note: rule.clinical_note,
    grouped_rule_ids: [rule.id],
  };
}

/** Every observation the rendered message actually depends on (FR-12). */
function collectTriggeringFacts(ctx: EvalContext): Finding['triggering_facts'] {
  const facts: Finding['triggering_facts'] = [];
  for (const [key, value] of ctx.bindings) {
    if (!key.endsWith('_fact_id')) continue;
    const code = key.slice(0, -'_fact_id'.length).toUpperCase();
    facts.push({
      code,
      value: ctx.bindings.get(`${code.toLowerCase()}_value`) ?? null,
      observed_at: ctx.bindings.get(`${code.toLowerCase()}_observed_at`) ?? null,
      fact_id: value,
    });
  }
  return facts.sort((a, b) => a.code.localeCompare(b.code));
}

/**
 * Spec 10.4: repeats of the same reason are grouped while the original rule ids
 * are kept. Grouping is deliberately conservative — only findings whose
 * rendered message is identical are merged, so nothing is silently hidden.
 */
function groupFindings(findings: Finding[]): Finding[] {
  const groups = new Map<string, Finding>();
  for (const finding of findings) {
    const key = `${finding.dimension}|${finding.severity}|${finding.message}`;
    const existing = groups.get(key);
    if (existing) {
      existing.grouped_rule_ids = [...new Set([...existing.grouped_rule_ids, finding.rule_id])].sort();
      existing.evidence_refs = dedupeEvidence([...existing.evidence_refs, ...finding.evidence_refs]);
      continue;
    }
    groups.set(key, finding);
  }
  const severityOrder = { high: 0, moderate: 1, review_required: 2, info: 3 };
  return [...groups.values()].sort(
    (a, b) => severityOrder[a.severity] - severityOrder[b.severity] || a.rule_id.localeCompare(b.rule_id),
  );
}

function dedupeEvidence(refs: Finding['evidence_refs']): Finding['evidence_refs'] {
  const seen = new Map<string, Finding['evidence_refs'][number]>();
  for (const ref of refs) seen.set(ref.evidence_id, ref);
  return [...seen.values()].sort((a, b) => a.evidence_id.localeCompare(b.evidence_id));
}

function buildCoverage(
  evaluations: RuleEvaluation[],
  regimen: RegimenItem[],
  content: ClinicalContent,
  illustrativeCount: number,
): Coverage {
  const counted = (status: RuleEvaluation['status']) => evaluations.filter((e) => e.status === status).length;

  // A dimension counts as unevaluated when the ruleset declares it unsupported,
  // or when every rule touching it failed to evaluate.
  const unevaluated = new Set<string>(content.dimensionsUnsupported);
  const byDimension = new Map<string, RuleEvaluation[]>();
  for (const evaluation of evaluations) {
    const list = byDimension.get(evaluation.dimension) ?? [];
    list.push(evaluation);
    byDimension.set(evaluation.dimension, list);
  }
  for (const [dimension, list] of byDimension) {
    if (list.every((e) => e.status === 'NOT_EVALUABLE' || e.status === 'ERROR')) unevaluated.add(dimension);
  }

  // A medication is "unsupported" for a check it is not mapped to at all.
  const unsupportedMedications = regimen
    .filter((item) => !item.in_catalog || item.supported_checks.length === 0)
    .map((item) => item.ingredient_code);

  return {
    evaluated_count: counted('TRIGGERED') + counted('NOT_TRIGGERED'),
    not_evaluable_count: counted('NOT_EVALUABLE'),
    not_applicable_count: counted('NOT_APPLICABLE'),
    error_count: counted('ERROR'),
    illustrative_count: illustrativeCount,
    unsupported_medication_ids: [...new Set(unsupportedMedications)].sort(),
    unevaluated_dimensions: [...unevaluated].sort(),
  };
}
