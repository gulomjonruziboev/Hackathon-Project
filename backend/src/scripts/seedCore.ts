import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { REPO_ROOT, env } from '../config/env.js';
import { loadClinicalContent } from '../content/loader.js';
import { syncClinicalContent } from '../content/sync.js';
import { ClinicModel, PatientModel, UserModel } from '../models/index.js';
import { parseIsoDate } from '../utils/dates.js';

const seedFileSchema = z.object({
  note: z.string().optional(),
  clinics: z.array(z.object({ key: z.string(), name: z.string() })),
  users: z.array(
    z.object({
      clinic_key: z.string(),
      email: z.string(),
      display_name: z.string(),
      role: z.enum(['doctor', 'admin']),
      password_env: z.string(),
    }),
  ),
  patients: z.array(
    z.object({
      clinic_key: z.string(),
      synthetic_code: z.string(),
      birth_date: z.string(),
      model_sex: z.enum(['female', 'male', 'unknown']),
      document: z.string().nullable(),
      scenario_note: z.string().optional(),
    }),
  ),
});

export type SeedResult = {
  clinics: number;
  users: number;
  patients: number;
  medications: number;
  rules: number;
  evidence: number;
  rulesetVersion: string;
  reviewedRules: number;
  illustrativeRules: number;
  accounts: Array<{ email: string; role: string; clinic: string }>;
  /** Only populated for passwords this run had to generate. */
  generatedPasswords: Array<{ variable: string; value: string }>;
};

/**
 * Demo passwords never live in code (UI-01). They come from the environment;
 * when absent, a random one is generated and handed back to the caller so it
 * can be shown exactly once.
 */
function resolvePassword(variable: string, generated: Map<string, string>): string {
  const fromEnv = process.env[variable];
  if (fromEnv && fromEnv.length >= 8) return fromEnv;

  const existing = generated.get(variable);
  if (existing) return existing;

  const value = randomBytes(9).toString('base64url');
  generated.set(variable, value);
  return value;
}

/** Idempotent: re-running seed must not multiply clinics, users or patients. */
export async function runSeed(): Promise<SeedResult> {
  const config = env();
  if (config.APP_ENV === 'production') {
    throw new Error('Seed production muhitida ishlamaydi.');
  }

  const content = loadClinicalContent();
  const raw = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'demo-data', 'patients.json'), 'utf8'));
  const seed = seedFileSchema.parse(raw);
  const generated = new Map<string, string>();

  const clinicIds = new Map<string, string>();
  const clinicNames = new Map<string, string>();
  for (const clinic of seed.clinics) {
    const existing = await ClinicModel.findOne({ name: clinic.name });
    const doc = existing ?? (await ClinicModel.create({ name: clinic.name }));
    clinicIds.set(clinic.key, String(doc._id));
    clinicNames.set(clinic.key, clinic.name);
  }

  for (const user of seed.users) {
    const clinicId = clinicIds.get(user.clinic_key);
    if (!clinicId) throw new Error(`Noma'lum clinic_key: ${user.clinic_key}`);
    const password = resolvePassword(user.password_env, generated);

    await UserModel.updateOne(
      { email: user.email.toLowerCase() },
      {
        $set: {
          clinic_id: clinicId,
          display_name: user.display_name,
          role: user.role,
          active: true,
          password_hash: await bcrypt.hash(password, 10),
        },
      },
      { upsert: true },
    );
  }

  for (const patient of seed.patients) {
    const clinicId = clinicIds.get(patient.clinic_key);
    if (!clinicId) throw new Error(`Noma'lum clinic_key: ${patient.clinic_key}`);
    const birthDate = parseIsoDate(patient.birth_date);
    if (!birthDate) throw new Error(`Noto'g'ri birth_date: ${patient.birth_date}`);

    await PatientModel.updateOne(
      { clinic_id: clinicId, synthetic_code: patient.synthetic_code },
      {
        $set: { birth_date: birthDate, model_sex: patient.model_sex, is_synthetic: true },
        // Allergy status stays UNKNOWN until a doctor confirms it (spec 8.1).
        $setOnInsert: { allergy_status: 'UNKNOWN', current_profile_revision_id: null },
      },
      { upsert: true },
    );
  }

  const counts = await syncClinicalContent(content);
  const enabled = content.rules.filter((r) => r.enabled);

  return {
    clinics: seed.clinics.length,
    users: seed.users.length,
    patients: seed.patients.length,
    ...counts,
    rulesetVersion: content.rulesetVersion,
    reviewedRules: enabled.filter((r) => r.review_status === 'reviewed').length,
    illustrativeRules: enabled.filter((r) => r.review_status === 'illustrative').length,
    accounts: seed.users.map((u) => ({
      email: u.email,
      role: u.role,
      clinic: clinicNames.get(u.clinic_key) ?? u.clinic_key,
    })),
    generatedPasswords: [...generated.entries()].map(([variable, value]) => ({ variable, value })),
  };
}

export function printSeedResult(result: SeedResult): void {
  console.log(
    JSON.stringify(
      {
        clinics: result.clinics,
        users: result.users,
        patients: result.patients,
        medications: result.medications,
        rules: result.rules,
        evidence: result.evidence,
        ruleset_version: result.rulesetVersion,
        reviewed_rules: result.reviewedRules,
        illustrative_rules: result.illustrativeRules,
      },
      null,
      2,
    ),
  );

  console.log('\nDemo hisoblar:');
  for (const account of result.accounts) console.log(`  ${account.email}  (${account.role}, ${account.clinic})`);

  if (result.generatedPasswords.length > 0) {
    console.log('\nQuyidagi parollar tasodifiy yaratildi — .env fayliga ko‘chirib qo‘ying:');
    for (const { variable, value } of result.generatedPasswords) console.log(`  ${variable}=${value}`);
    console.log('  (Bu qiymatlar boshqa chiqarilmaydi.)');
  }

  console.log('\nDemo hujjatlar: demo-data/synthetic-documents/ — UI orqali yuklang.\n');
}
