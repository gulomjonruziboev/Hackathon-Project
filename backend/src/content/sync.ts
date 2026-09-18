import { loadClinicalContent, type ClinicalContent } from './loader.js';
import { EvidenceSourceModel, MedicationModel, RuleSetModel } from '../models/index.js';
import { parseIsoDate } from '../utils/dates.js';

/**
 * Mirrors the versioned files in clinical-content/ into the database so an
 * analysis can be traced back to the exact catalogue, ruleset and evidence it
 * used. The files remain the source of truth — editing rules through the web UI
 * is out of P0 scope (spec 3).
 */
export async function syncClinicalContent(content: ClinicalContent = loadClinicalContent()): Promise<{
  medications: number;
  rules: number;
  evidence: number;
}> {
  for (const med of content.medications) {
    await MedicationModel.updateOne(
      { ingredient_code: med.ingredient_code },
      { $set: { ...med, catalog_version: content.catalogVersion } },
      { upsert: true },
    );
  }

  for (const source of content.evidence) {
    await EvidenceSourceModel.updateOne(
      { source_id: source.id },
      {
        $set: {
          title: source.title,
          url: source.url,
          section: source.section,
          content_version: source.content_version,
          accessed_at: parseIsoDate(source.accessed_at),
          verification_status: source.verification_status,
          license_note: source.license_note,
        },
      },
      { upsert: true },
    );
  }

  const enabled = content.rules.filter((r) => r.enabled);
  await RuleSetModel.updateOne(
    { version: content.rulesetVersion },
    {
      $set: {
        checksum: content.rulesetChecksum,
        release_status: content.releaseStatus,
        reviewed_at: parseIsoDate(content.reviewedAt),
        reviewed_by: content.reviewedBy,
        rule_count: content.rules.length,
        reviewed_rule_count: enabled.filter((r) => r.review_status === 'reviewed').length,
        illustrative_rule_count: enabled.filter((r) => r.review_status === 'illustrative').length,
        payload: content.rulesetPayload,
      },
    },
    { upsert: true },
  );

  return { medications: content.medications.length, rules: content.rules.length, evidence: content.evidence.length };
}
