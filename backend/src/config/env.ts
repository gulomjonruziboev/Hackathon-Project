import { z } from 'zod';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
/** twinrx/ repo root (src/config -> src -> backend -> twinrx) */
export const REPO_ROOT = path.resolve(here, '..', '..', '..');
export const BACKEND_ROOT = path.resolve(here, '..', '..');

const boolish = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())));

const schema = z.object({
  APP_ENV: z.enum(['demo', 'test', 'development', 'production']).default('demo'),
  PORT: z.coerce.number().int().positive().default(4000),
  MONGODB_URI: z.string().default(''),
  /** When true (or when MONGODB_URI is empty in demo/dev) an in-process MongoDB is started. */
  USE_IN_MEMORY_DB: boolish.default(false),
  SESSION_SECRET: z.string().min(16).default('twinrx-local-demo-secret-change-me'),
  SESSION_TTL_HOURS: z.coerce.number().int().positive().default(12),
  CORS_ORIGINS: z.string().default('http://localhost:3000'),
  COOKIE_SECURE: boolish.default(false),

  /* ---- AI (qo'shimcha TZ, 11-bo'lim) ---- */
  LLM_PROVIDER: z.enum(['groq', 'ollama', 'manual']).default('groq'),
  LLM_MODEL: z.string().default('openai/gpt-oss-20b'),
  GROQ_API_KEY: z.string().default(''),
  GROQ_BASE_URL: z.string().default('https://api.groq.com/openai/v1'),
  LLM_TIMEOUT_SECONDS: z.coerce.number().int().positive().max(120).default(30),
  LLM_MAX_CONCURRENCY: z.coerce.number().int().positive().max(8).default(1),
  LLM_MAX_RETRIES: z.coerce.number().int().min(0).max(3).default(1),
  LLM_MAX_INPUT_TOKENS_PER_CHUNK: z.coerce.number().int().positive().default(1500),
  LLM_MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().default(1000),
  /** No silent provider swapping and no billing upgrade (supplement 4, 10, AI-07). */
  ALLOW_PAID_PROVIDERS: boolish.default(false),
  /** Cloud extraction is blocked for anything not marked synthetic (AI-08). */
  ALLOW_REAL_PATIENT_DATA: boolish.default(false),
  LOCAL_FALLBACK_ENABLED: boolish.default(false),
  OLLAMA_BASE_URL: z.string().default('http://127.0.0.1:11434'),
  OLLAMA_MODEL: z.string().default('qwen3:8b'),

  ENABLE_OCR: boolish.default(false),
  ENABLE_RAG: boolish.default(false),
  ENABLE_KFRE: boolish.default(false),

  RULESET_VERSION: z.string().default('demo-1.0'),
  CLINICAL_CONTENT_DIR: z.string().default(''),
  UPLOAD_DIR: z.string().default(''),

  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(5 * 1024 * 1024),
  MAX_PDF_PAGES: z.coerce.number().int().positive().default(20),

  SEED_DOCTOR_PASSWORD: z.string().default(''),
  SEED_ADMIN_PASSWORD: z.string().default(''),
});

export type Env = z.infer<typeof schema> & {
  clinicalContentDir: string;
  uploadDir: string;
  corsOrigins: string[];
  useInMemoryDb: boolean;
};

let cached: Env | null = null;

/**
 * Hosts the backend is allowed to call for inference. A provider that is not
 * on this list can never be reached, whatever LLM_PROVIDER says (supplement 11).
 */
export const PROVIDER_HOST_ALLOWLIST = ['api.groq.com', '127.0.0.1', 'localhost'];

export function loadEnv(overrides: NodeJS.ProcessEnv = process.env): Env {
  const parsed = schema.safeParse(overrides);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Muhit o'zgaruvchilari noto'g'ri: ${issues}`);
  }
  const base = parsed.data;
  const clinicalContentDir = base.CLINICAL_CONTENT_DIR
    ? path.resolve(base.CLINICAL_CONTENT_DIR)
    : path.join(REPO_ROOT, 'clinical-content');
  const uploadDir = base.UPLOAD_DIR
    ? path.resolve(base.UPLOAD_DIR)
    : path.join(BACKEND_ROOT, 'var', 'uploads');

  const useInMemoryDb =
    base.USE_IN_MEMORY_DB || (base.MONGODB_URI === '' && base.APP_ENV !== 'production');

  if (!useInMemoryDb && base.MONGODB_URI === '') {
    throw new Error("MONGODB_URI berilmagan va in-memory rejim o'chirilgan.");
  }

  for (const url of [base.GROQ_BASE_URL, base.OLLAMA_BASE_URL]) {
    const host = safeHost(url);
    if (host && !PROVIDER_HOST_ALLOWLIST.includes(host)) {
      throw new Error(`Provayder manzili allowlistda yo'q: ${host}`);
    }
  }

  return {
    ...base,
    clinicalContentDir,
    uploadDir,
    corsOrigins: base.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean),
    useInMemoryDb,
  };
}

function safeHost(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

export function env(): Env {
  if (!cached) cached = loadEnv();
  return cached;
}

export function resetEnvCache(): void {
  cached = null;
}
