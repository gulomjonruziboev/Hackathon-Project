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

type OllamaResponse = {
  model?: string;
  message?: { content?: string };
  done?: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
};

/**
 * Local fallback (supplement 5): Qwen3-8B through Ollama, same schema and the
 * same backend verification as the cloud path.
 *
 * It is only reachable when LOCAL_FALLBACK_ENABLED is on, which the supplement
 * ties to the model having passed the extraction benchmark first — enabling the
 * flag is a human decision recorded in docs/validation-report.md, not something
 * the code turns on for itself.
 */
export class OllamaAdapter implements LLMAdapter {
  readonly name = 'ollama';
  readonly isRecordedDemo = false;
  readonly isCloud = false;

  get modelId(): string {
    return env().OLLAMA_MODEL;
  }

  async extract(req: ExtractionRequest): Promise<ExtractionResult> {
    const config = env();
    const prompt = buildExtractionPrompt(req.documentText, req.allowedIngredientCodes, req.chunkInfo);
    const startedAt = Date.now();

    const response = await fetchWithDeadline(
      `${config.OLLAMA_BASE_URL}/api/chat`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: config.OLLAMA_MODEL,
          stream: false,
          format: EXTRACTION_JSON_SCHEMA,
          options: { temperature: 0, num_predict: config.LLM_MAX_OUTPUT_TOKENS },
          messages: [
            { role: 'system', content: EXTRACTION_SYSTEM_PROMPT },
            { role: 'user', content: prompt },
          ],
        }),
      },
      req.deadlineAt,
    );

    if (!response.ok) {
      throw new LLMError('LLM_PROVIDER_ERROR', `Ollama xatosi (${response.status}).`);
    }

    const body = (await response.json()) as OllamaResponse;
    const finishStatus = body.done_reason ?? (body.done ? 'stop' : null);
    if (finishStatus === 'length') {
      throw new LLMError('LLM_TRUNCATED_OUTPUT', 'Lokal model javobi chegarada uzilib qoldi.');
    }

    const { value, repaired } = parseModelJson(body.message?.content ?? '');
    const payload = extractionPayloadSchema.parse({
      ...(value as Record<string, unknown>),
      schema_version: EXTRACTION_SCHEMA_VERSION,
    });

    return {
      payload,
      metadata: {
        provider: this.name,
        model_id: config.OLLAMA_MODEL,
        // Ollama does not return the weight digest on /api/chat; pin it at install
        // time and record it in docs rather than inventing a value here.
        model_revision: body.model ?? null,
        prompt_version: PROMPT_VERSION,
        schema_version: EXTRACTION_SCHEMA_VERSION,
        latency_ms: Date.now() - startedAt,
        input_tokens: body.prompt_eval_count ?? null,
        output_tokens: body.eval_count ?? null,
        finish_status: finishStatus,
        cache_hit: false,
      },
      isRecordedDemo: false,
      repairAttempted: repaired,
      notes: [],
    };
  }
}
