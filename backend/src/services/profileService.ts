import { loadClinicalContent } from '../content/loader.js';
import { ApiError } from '../middleware/error.js';
import {
  ClinicalFactModel,
  MedicationStatementModel,
  PatientModel,
  ProfileRevisionModel,
  type AllergyStatus,
  type ClinicalFact,
  type ProfileRevision,
  type SnapshotFact,
  type SnapshotMedication,
} from '../models/index.js';
import { toIso } from '../utils/dates.js';

/**
 * Two confirmed facts for the same code and the same observation date but with
 * different values are a conflict. Spec 8.1 forbids picking one arbitrarily, so
 * both are marked CONFLICTED and every rule that needs that code becomes
 * NOT_EVALUABLE.
 */
function markConflicts(facts: ClinicalFact[]): Map<string, string> {
  const conflicts = new Map<string, string>();
  const groups = new Map<string, ClinicalFact[]>();

  for (const fact of facts) {
    if (fact.kind !== 'observation') continue;
    const key = `${fact.code}|${toIso(fact.observed_at) ?? 'null'}`;
    const list = groups.get(key) ?? [];
    list.push(fact);
    groups.set(key, list);
  }

  for (const [key, list] of groups) {
    if (list.length < 2) continue;
    const values = new Set(list.map((f) => `${f.normalized_value}|${f.normalized_unit ?? f.unit ?? ''}`));
    if (values.size <= 1) continue;
    const note = `Bir xil ko‘rsatkich (${key.split('|')[0]}) uchun ${values.size} xil qiymat topildi. Tizim birini tanlamaydi.`;
    for (const fact of list) conflicts.set(String(fact._id), note);
  }

  return conflicts;
}

function toSnapshotFact(fact: ClinicalFact, conflictNote: string | null): SnapshotFact {
  return {
    fact_id: String(fact._id),
    kind: fact.kind,
    code: fact.code,
    display_name: fact.display_name,
    raw_value: fact.raw_value,
    normalized_value: fact.normalized_value,
    unit: fact.unit,
    normalized_unit: fact.normalized_unit,
    observed_at: toIso(fact.observed_at),
    status: conflictNote ? 'CONFLICTED' : fact.status,
    conflict_note: conflictNote,
    source: {
      kind: fact.source,
      document_id: fact.source_document_id,
      page: fact.source_page,
      quote: fact.source_quote,
      quote_verified: fact.source_quote_verified,
    },
  };
}

/**
 * Confirming the same document twice (or two documents listing the same lab
 * result) would otherwise leave identical duplicates in the snapshot. Exact
 * repeats are superseded, keeping the newest.
 *
 * Only *identical* facts collapse: differing values for the same code and date
 * stay as-is so `markConflicts` can flag them (spec 8.1 forbids picking one).
 */
async function supersedeExactDuplicates(clinicId: string, patientId: string): Promise<void> {
  const facts = await ClinicalFactModel.find({
    clinic_id: clinicId,
    patient_id: patientId,
    status: 'CONFIRMED',
  })
    .sort({ created_at: 1 })
    .lean<ClinicalFact[]>();

  const newestByKey = new Map<string, ClinicalFact>();
  const superseded: Array<{ id: string; supersedesId: string }> = [];

  for (const fact of facts) {
    const key = [
      fact.kind,
      fact.code,
      toIso(fact.observed_at) ?? 'null',
      String(fact.normalized_value),
      fact.normalized_unit ?? fact.unit ?? '',
      fact.raw_value ?? '',
    ].join('|');

    const previous = newestByKey.get(key);
    if (previous) superseded.push({ id: String(previous._id), supersedesId: String(fact._id) });
    newestByKey.set(key, fact);
  }

  for (const { id, supersedesId } of superseded) {
    await ClinicalFactModel.updateOne({ _id: id }, { $set: { status: 'SUPERSEDED', supersedes_id: supersedesId } });
  }
}

/**
 * Keeps at most one active statement per active ingredient. Without this a
 * second confirmation of the same drug would look like genuine duplicate
 * therapy and trigger RULE_DUPLICATE_INGREDIENT_V1 for no reason.
 */
async function collapseActiveMedications(clinicId: string, patientId: string): Promise<void> {
  const statements = await MedicationStatementModel.find({
    clinic_id: clinicId,
    patient_id: patientId,
    status: 'active',
  })
    .sort({ created_at: 1 })
    .lean();

  const newest = new Map<string, string>();
  const toStop: string[] = [];
  for (const statement of statements) {
    const previous = newest.get(statement.ingredient_code);
    if (previous) toStop.push(previous);
    newest.set(statement.ingredient_code, String(statement._id));
  }

  if (toStop.length > 0) {
    await MedicationStatementModel.updateMany(
      { _id: { $in: toStop } },
      { $set: { status: 'stopped', end_date: new Date() } },
    );
  }
}

/**
 * Snapshot every confirmed fact and active medication into a new immutable
 * revision, and point the patient at it. Analyses pin a revision id, so an
 * older analysis keeps describing the profile it was actually computed on.
 */
export async function createProfileRevision(options: {
  clinicId: string;
  patientId: string;
  userId: string;
  reason: string;
  allergyStatus?: AllergyStatus;
}): Promise<ProfileRevision> {
  const patient = await PatientModel.findOne({ _id: options.patientId, clinic_id: options.clinicId });
  if (!patient) throw ApiError.notFound('Bemor topilmadi.');

  await supersedeExactDuplicates(options.clinicId, options.patientId);
  await collapseActiveMedications(options.clinicId, options.patientId);

  const facts = await ClinicalFactModel.find({
    patient_id: options.patientId,
    clinic_id: options.clinicId,
    status: { $in: ['CONFIRMED', 'CONFLICTED'] },
  }).lean<ClinicalFact[]>();

  const conflicts = markConflicts(facts);
  const snapshot = facts
    .map((fact) => toSnapshotFact(fact, conflicts.get(String(fact._id)) ?? null))
    .sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));

  const content = loadClinicalContent();
  const statements = await MedicationStatementModel.find({
    patient_id: options.patientId,
    clinic_id: options.clinicId,
    status: { $ne: 'stopped' },
  }).lean();

  const medications: SnapshotMedication[] = statements
    .map((s) => {
      const med = content.medications.find((m) => m.ingredient_code === s.ingredient_code);
      return {
        statement_id: String(s._id),
        ingredient_code: s.ingredient_code,
        ingredient_name: med?.ingredient_name ?? s.ingredient_code,
        dose_value: s.dose_value,
        dose_unit: s.dose_unit,
        route: s.route,
        frequency_per_day: s.frequency_per_day,
        status: s.status,
        source_fact_id: s.source_fact_id,
      };
    })
    .sort((a, b) => (a.ingredient_code < b.ingredient_code ? -1 : 1));

  const last = await ProfileRevisionModel.findOne({ patient_id: options.patientId })
    .sort({ revision_no: -1 })
    .lean();

  const allergyStatus = options.allergyStatus ?? patient.allergy_status;

  const revision = await ProfileRevisionModel.create({
    clinic_id: options.clinicId,
    patient_id: options.patientId,
    revision_no: (last?.revision_no ?? 0) + 1,
    facts_snapshot: snapshot,
    medications_snapshot: medications,
    allergy_status: allergyStatus,
    reason: options.reason,
    confirmed_by: options.userId,
    confirmed_at: new Date(),
  });

  await PatientModel.updateOne(
    { _id: options.patientId, clinic_id: options.clinicId },
    { $set: { current_profile_revision_id: String(revision._id), allergy_status: allergyStatus } },
  );

  return revision.toObject() as ProfileRevision;
}

export async function getCurrentRevision(clinicId: string, patientId: string): Promise<ProfileRevision | null> {
  return ProfileRevisionModel.findOne({ clinic_id: clinicId, patient_id: patientId })
    .sort({ revision_no: -1 })
    .lean<ProfileRevision | null>();
}

export async function getRevisionOrThrow(clinicId: string, revisionId: string): Promise<ProfileRevision> {
  const revision = await ProfileRevisionModel.findOne({ _id: revisionId, clinic_id: clinicId }).lean<ProfileRevision | null>();
  if (!revision) throw ApiError.notFound('Profil reviziyasi topilmadi.');
  return revision;
}

/** Latest usable value for a code, excluding conflicted ones (spec 8.1). */
export function latestObservation(
  revision: ProfileRevision,
  code: string,
): { fact: SnapshotFact; conflicted: boolean } | null {
  const matches = revision.facts_snapshot.filter((f) => f.kind === 'observation' && f.code === code);
  if (matches.length === 0) return null;

  const conflicted = matches.some((f) => f.status === 'CONFLICTED');
  if (conflicted) return { fact: matches[0]!, conflicted: true };

  const sorted = [...matches].sort((a, b) => {
    if (a.observed_at === b.observed_at) return 0;
    if (a.observed_at === null) return 1;
    if (b.observed_at === null) return -1;
    return a.observed_at < b.observed_at ? 1 : -1;
  });
  return { fact: sorted[0]!, conflicted: false };
}

export function confirmedConditions(revision: ProfileRevision): SnapshotFact[] {
  return revision.facts_snapshot.filter((f) => f.kind === 'condition');
}

export function confirmedAllergies(revision: ProfileRevision): SnapshotFact[] {
  return revision.facts_snapshot.filter((f) => f.kind === 'allergy' && f.code !== 'NONE_STATED');
}
