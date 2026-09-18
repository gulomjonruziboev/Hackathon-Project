import { env } from '../config/env.js';
import type { ExtractionPayload } from './extractionSchema.js';

export type ExtractionRequest = {
  documentText: string;
  allowedIngredientCodes: string[];
  /** Absolute deadline shared by the whole attempt chain (supplement 10.4). */
  deadlineAt: number;
  chunkInfo?: { index: number; total: number; pageLabel: string };
};

/** Supplement 11: exactly these fields, with null where the provider gives nothing. */
export type ProviderMetadata = {
  provider: string;
  model_id: string;
  model_revision: string | null;
  prompt_version: string;
  schema_version: string;
  latency_ms: number;
  input_tokens: number | null;
  output_tokens: number | null;
  finish_status: string | null;
  cache_hit: boolean;
};

export type ExtractionResult = {
  payload: ExtractionPayload;
  metadata: ProviderMetadata;
  /** True when the payload did not come from a live model call (main spec 9.4). */
  isRecordedDemo: boolean;
  repairAttempted: boolean;
  notes: string[];
};

export type LLMErrorCode =
  | 'LLM_TIMEOUT'
  | 'LLM_PROVIDER_ERROR'
  | 'LLM_INVALID_JSON'
  | 'LLM_TRUNCATED_OUTPUT'
  | 'LLM_RATE_LIMITED'
  | 'LLM_AUTH_ERROR'
  | 'LLM_NOT_CONFIGURED'
  | 'LLM_BUSY';

export class LLMError extends Error {
  constructor(
    readonly code: LLMErrorCode,
    message: string,
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = 'LLMError';
  }
}

/**
 * Provider-independent seam (main spec 7, supplement 11). The provider never
 * writes to the database and never decides that a fact is confirmed.
 */
export interface LLMAdapter {
  readonly name: string;
  readonly modelId: string;
  readonly isRecordedDemo: boolean;
  /** Cloud providers must refuse anything not marked synthetic (AI-08). */
  readonly isCloud: boolean;
  extract(req: ExtractionRequest): Promise<ExtractionResult>;
}

export async function getAdapter(name?: 'groq' | 'ollama' | 'manual'): Promise<LLMAdapter | null> {
  const config = env();
  switch (name ?? config.LLM_PROVIDER) {
    case 'groq': {
      const { GroqAdapter } = await import('./groqProvider.js');
      return new GroqAdapter();
    }
    case 'ollama': {
      const { OllamaAdapter } = await import('./ollamaProvider.js');
      return new OllamaAdapter();
    }
    case 'manual':
    default:
      return null;
  }
}

/** Shared JSON recovery: one repair attempt, then give up (main spec 9.2). */
export function parseModelJson(raw: string): { value: unknown; repaired: boolean } {
  try {
    return { value: JSON.parse(raw), repaired: false };
  } catch {
    /* fall through to a single repair attempt */
  }

  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced?.[1] ?? raw;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      return { value: JSON.parse(candidate.slice(start, end + 1)), repaired: true };
    } catch {
      /* repair failed */
    }
  }
  throw new LLMError('LLM_INVALID_JSON', 'Model javobi JSON sifatida o‘qilmadi.');
}

export async function fetchWithDeadline(
  url: string,
  init: RequestInit,
  deadlineAt: number,
): Promise<Response> {
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) throw new LLMError('LLM_TIMEOUT', 'Umumiy vaqt chegarasi tugadi.');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), remaining);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new LLMError('LLM_TIMEOUT', 'AI javobi vaqt chegarasida kelmadi.');
    }
    throw new LLMError('LLM_PROVIDER_ERROR', 'AI provayderiga ulanib bo‘lmadi.');
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Supplement 9: at most one external extraction runs at a time, so a free-tier
 * quota is not burned by parallel demo sessions. Callers see LLM_BUSY rather
 * than queueing indefinitely.
 */
class ConcurrencyGate {
  private active = 0;
  constructor(private readonly max: number) {}

  tryAcquire(): boolean {
    if (this.active >= this.max) return false;
    this.active += 1;
    return true;
  }

  release(): void {
    this.active = Math.max(0, this.active - 1);
  }

  get inFlight(): number {
    return this.active;
  }
}

let gate: ConcurrencyGate | null = null;

export function extractionGate(): ConcurrencyGate {
  if (!gate) gate = new ConcurrencyGate(env().LLM_MAX_CONCURRENCY);
  return gate;
}

export function resetExtractionGate(): void {
  gate = null;
}
