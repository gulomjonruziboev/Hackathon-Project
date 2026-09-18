import type { Rule } from '../content/loader.js';
import type { Analysis, Finding } from '../models/index.js';
import { plainText } from '../utils/text.js';

/**
 * P0 explanations come from the rule's reviewed text template — no tokens are
 * spent and no model rewrites them (main spec 9.3, supplement 3). AI
 * simplification is a P1 feature that may only rephrase a finished finding.
 */
export function renderTemplate(template: string, bindings: Map<string, string>, params: Rule['params']): string {
  const rendered = template.replace(/\{\{([a-z0-9_:]+)\}\}/gi, (_match, token: string) => {
    if (token.startsWith('param:')) {
      const value = params[token.slice('param:'.length)];
      return value == null ? '—' : String(value);
    }
    return bindings.get(token) ?? '—';
  });
  // Extracted document text can reach a binding, so it is neutralised before
  // it ever lands in a message the UI renders (main spec 9.2).
  return plainText(rendered);
}

export type WhyPanel = {
  finding_id: string;
  rule_id: string;
  rule_version: number;
  review_status: Finding['review_status'];
  threshold_origin: string;
  severity: Finding['severity'];
  message: string;
  used_facts: Finding['triggering_facts'];
  rule_params: Record<string, number | string>;
  evidence: Finding['evidence_refs'];
  clinical_note: string;
  grouped_rule_ids: string[];
  required_review: string;
};

/** Backing data for the UI-06 "Nega?" panel: reason, facts used, source, caveat. */
export function buildWhyPanel(finding: Finding, analysis: Analysis): WhyPanel {
  const unverifiedEvidence = finding.evidence_refs.filter((e) => e.verification_status === 'pending_review');

  const requiredReview =
    finding.review_status === 'reviewed'
      ? 'Qoida klinik ko‘rikdan o‘tgan. Qaror baribir shifokorniki.'
      : `Bu qoidani klinik maslahatchi ko‘rib chiqmagan (${finding.review_status}). Topilma illyustrativ — klinik natijalar to‘plamiga kirmaydi.${
          unverifiedEvidence.length > 0
            ? ` Dalil manbalari hali tekshirilmagan: ${unverifiedEvidence.map((e) => e.evidence_id).join(', ')}.`
            : ''
        }`;

  return {
    finding_id: finding.id,
    rule_id: finding.rule_id,
    rule_version: finding.rule_version,
    review_status: finding.review_status,
    threshold_origin: finding.threshold_origin,
    severity: finding.severity,
    message: finding.message,
    used_facts: finding.triggering_facts,
    rule_params: finding.params,
    evidence: finding.evidence_refs,
    clinical_note: finding.clinical_note,
    grouped_rule_ids: finding.grouped_rule_ids,
    required_review: `${requiredReview} Qoidalar versiyasi: ${analysis.ruleset_version}.`,
  };
}

/** UI-06: the wording shown when nothing triggered. Never an absolute safety claim. */
export const NO_FINDING_TEXT =
  'Qo‘llangan qoidalar doirasida xavf aniqlanmadi. Bu to‘liq xavfsizlik kafolati emas.';

export const NO_REVIEWED_RULES_TEXT =
  'Klinik ko‘rikdan o‘tgan (reviewed) qoidalar hali yoqilmagan, shuning uchun klinik topilmalar to‘plami bo‘sh. Quyidagi illyustrativ topilmalar faqat mexanikani ko‘rsatadi.';
