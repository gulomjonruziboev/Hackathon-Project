import { env } from '../config/env.js';
import {
  EXTRACTION_JSON_SCHEMA,
  EXTRACTION_SCHEMA_VERSION,
  EXTRACTION_SYSTEM_PROMPT,
  PROMPT_VERSION,
  buildExtractionPrompt,
  extractionPayloadSchema,
} from './extractionSchema.js';
import {
  LLMError,
  fetchWithDeadline,
  parseModelJson,
  type ExtractionRequest,
  type ExtractionResult,
  type LLMAdapter,
} from './LLMAdapter.js';

type GroqResponse = {
  model?: string;
  choices?: Array<{ finish_reason?: string; message?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string; code?: string };
};

/**
 * Primary free-tier provider (supplement 1, 4): `openai/gpt-oss-20b` on Groq,
 * OpenAI-compatible chat completions with strict JSON-Schema structured output.
 *
 * The model id comes from configuration, never from the request, and there is
 * no silent swap to another model when this one fails (supplement 4).
 */
export class GroqAdapter implements LLMAdapter {
  readonly name = 'groq';
  readonly isRecordedDemo = false;
  readonly isCloud = true;

  get modelId(): string {
    return env().LLM_MODEL;
  }

  async extract(req: ExtractionRequest): Promise<ExtractionResult> {
    const config = env();
    if (!config.GROQ_API_KEY) {
      throw new LLMError('LLM_NOT_CONFIGURED', 'GROQ_API_KEY berilmagan.');
    }

    const prompt = buildExtractionPrompt(req.documentText, req.allowedIngredientCodes, req.chunkInfo);
    const startedAt = Date.now();
    let attempt = 0;
    let lastError: LLMError | null = null;

    // Supplement 10.3: bounded retries only, and every wait is charged to the
    // same 30 s deadline — never an unbounded retry loop.
    while (attempt <= config.LLM_MAX_RETRIES) {
      attempt += 1;
      try {
        return await this.callOnce(prompt, startedAt, req.deadlineAt);
      } catch (err) {
        if (!(err instanceof LLMError)) throw err;
        lastError = err;

        const retryable = err.code === 'LLM_RATE_LIMITED' || err.code === 'LLM_PROVIDER_ERROR';
        if (!retryable || attempt > config.LLM_MAX_RETRIES) break;

        const waitMs = err.retryAfterMs ?? 1000;
        if (Date.now() + waitMs >= req.deadlineAt) {
          throw new LLMError('LLM_TIMEOUT', 'Qayta urinish uchun vaqt budjeti yetmadi.');
        }
        await sleep(waitMs);
      }
    }

    throw lastError ?? new LLMError('LLM_PROVIDER_ERROR', 'Nomaʼlum provayder xatosi.');
  }

  private async callOnce(prompt: string, startedAt: number, deadlineAt: number): Promise<ExtractionResult> {
    const config = env();

    const response = await fetchWithDeadline(
      `${config.GROQ_BASE_URL}/chat/completions`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${config.GROQ_API_KEY}`,
        },
        body: JSON.stringify({
          model: config.LLM_MODEL,
          max_completion_tokens: config.LLM_MAX_OUTPUT_TOKENS,
          temperature: 0,
          messages: [
            { role: 'system', content: EXTRACTION_SYSTEM_PROMPT },
            { role: 'user', content: prompt },
          ],
          response_format: {
            type: 'json_schema',
            json_schema: { name: 'twinrx_extraction', strict: true, schema: EXTRACTION_JSON_SCHEMA },
          },
        }),
      },
      deadlineAt,
    );

    if (response.status === 429) {
      throw new LLMError('LLM_RATE_LIMITED', 'Groq limiti oshdi.', parseRetryAfter(response));
    }
    if (response.status === 401 || response.status === 403) {
      // Supplement 10: never rotate keys to work around a limit.
      throw new LLMError('LLM_AUTH_ERROR', 'Groq kaliti yoki ruxsati noto‘g‘ri.');
    }
    if (!response.ok) {
      throw new LLMError('LLM_PROVIDER_ERROR', `Groq API xatosi (${response.status}).`);
    }

    const body = (await response.json()) as GroqResponse;
    const choice = body.choices?.[0];
    const finishStatus = choice?.finish_reason ?? null;

    // Supplement 9: a truncated response is a failure, never a partial success.
    if (finishStatus === 'length') {
      throw new LLMError('LLM_TRUNCATED_OUTPUT', 'Model javobi chegarada uzilib qoldi.');
    }

    const content = choice?.message?.content ?? '';
    const { value, repaired } = parseModelJson(content);
    const payload = extractionPayloadSchema.parse({
      ...(value as Record<string, unknown>),
      schema_version: EXTRACTION_SCHEMA_VERSION,
    });

    return {
      payload,
      metadata: {
        provider: this.name,
        model_id: config.LLM_MODEL,
        model_revision: body.model ?? null,
        prompt_version: PROMPT_VERSION,
        schema_version: EXTRACTION_SCHEMA_VERSION,
        latency_ms: Date.now() - startedAt,
        input_tokens: body.usage?.prompt_tokens ?? null,
        output_tokens: body.usage?.completion_tokens ?? null,
        finish_status: finishStatus,
        cache_hit: false,
      },
      isRecordedDemo: false,
      repairAttempted: repaired,
      notes: [],
    };
  }
}

function parseRetryAfter(response: Response): number | null {
  const header = response.headers.get('retry-after');
  if (!header) return null;
  const seconds = Number(header);
  return Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
