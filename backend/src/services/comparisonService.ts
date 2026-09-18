import { ApiError } from '../middleware/error.js';
import type { Analysis, Finding } from '../models/index.js';

export type ComparisonRow = {
  key: string;
  dimension: string;
  severity: Finding['severity'];
  review_status: Finding['review_status'];
  message: string;
  in_a: boolean;
  in_b: boolean;
  rule_ids: string[];
};

export type ComparisonResult = {
  a: { analysis_id: string; label: string; status: Analysis['status']; stale: boolean };
  b: { analysis_id: string; label: string; status: Analysis['status']; stale: boolean };
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
  /** Spec UF-03.4: the system never ranks one option as "best". */
  ranking_note: string;
};

function rows(findings: Finding[]): Map<string, ComparisonRow> {
  const map = new Map<string, ComparisonRow>();
  for (const finding of findings) {
    const key = `${finding.dimension}|${finding.severity}|${finding.message}`;
    map.set(key, {
      key,
      dimension: finding.dimension,
      severity: finding.severity,
      review_status: finding.review_status,
      message: finding.message,
      in_a: false,
      in_b: false,
      rule_ids: finding.grouped_rule_ids,
    });
  }
  return map;
}

function diff(a: Finding[], b: Finding[]): ComparisonRow[] {
  const left = rows(a);
  const right = rows(b);
  const keys = [...new Set([...left.keys(), ...right.keys()])].sort();

  return keys.map((key) => {
    const row = left.get(key) ?? right.get(key)!;
    return {
      ...row,
      in_a: left.has(key),
      in_b: right.has(key),
      rule_ids: [...new Set([...(left.get(key)?.rule_ids ?? []), ...(right.get(key)?.rule_ids ?? [])])].sort(),
    };
  });
}

/**
 * FR-11 / AT-14: comparison only happens when both analyses were computed on
 * the same profile revision and the same ruleset version. Anything else is a
 * 409 rather than a silently misleading diff.
 */
export function compareAnalyses(a: Analysis, b: Analysis): ComparisonResult {
  if (a.patient_id !== b.patient_id) {
    throw ApiError.badRequest('COMPARISON_PATIENT_MISMATCH', 'Taqqoslash faqat bitta bemor doirasida bajariladi.');
  }
  if (a.profile_revision_id !== b.profile_revision_id) {
    throw ApiError.conflict(
      'PROFILE_REVISION_CONFLICT',
      'Ikki tahlil turli profil reviziyasida hisoblangan. Ikkalasini bir xil reviziyada qayta hisoblang.',
    );
  }
  if (a.ruleset_checksum !== b.ruleset_checksum) {
    throw ApiError.conflict(
      'RULESET_VERSION_CONFLICT',
      'Ikki tahlil turli qoidalar versiyasida hisoblangan. Ikkalasini qayta hisoblang.',
    );
  }
  if (a.stale || b.stale) {
    throw ApiError.conflict(
      'ANALYSIS_STALE',
      'Tahlillardan biri eskirgan. Taqqoslashdan oldin qayta hisoblang.',
    );
  }

  return {
    a: { analysis_id: String(a._id), label: a.scenario_label, status: a.status, stale: a.stale },
    b: { analysis_id: String(b._id), label: b.scenario_label, status: b.status, stale: b.stale },
    profile_revision_id: a.profile_revision_id,
    ruleset_version: a.ruleset_version,
    findings_diff: diff(a.findings, b.findings),
    illustrative_diff: diff(a.illustrative_findings, b.illustrative_findings),
    coverage_diff: {
      evaluated_count: [a.coverage.evaluated_count, b.coverage.evaluated_count],
      not_evaluable_count: [a.coverage.not_evaluable_count, b.coverage.not_evaluable_count],
      unevaluated_dimensions_only_in_a: a.coverage.unevaluated_dimensions.filter(
        (d) => !b.coverage.unevaluated_dimensions.includes(d),
      ),
      unevaluated_dimensions_only_in_b: b.coverage.unevaluated_dimensions.filter(
        (d) => !a.coverage.unevaluated_dimensions.includes(d),
      ),
    },
    ranking_note:
      'TwinRx variantlarni "eng yaxshi" deb reytinglamaydi va umumiy xavf foizini hisoblamaydi. Tanlov shifokorniki.',
  };
}
