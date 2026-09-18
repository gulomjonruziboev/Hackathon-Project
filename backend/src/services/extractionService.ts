import { env } from '../config/env.js';
import { loadClinicalContent, matchMedicationsByName, type ClinicalContent } from '../content/loader.js';
import {
  EXTRACTION_SCHEMA_VERSION,
  PROMPT_VERSION,
  estimateTokens,
  type ExtractedFact,
  type ExtractionPayload,
} from '../llm/extractionSchema.js';
import {
  LLMError,
  extractionGate,
  getAdapter,
  type LLMAdapter,
  type ProviderMetadata,
} from '../llm/LLMAdapter.js';
import { RecordedDemoAdapter } from '../llm/recordedDemoProvider.js';
import { ExtractionCacheModel, type DocumentRecord } from '../models/index.js';
import { sha256 } from '../utils/canonical.js';
import { normalizeForQuoteMatch, quoteFoundInText } from '../utils/text.js';
import { isKnownObservationCode, toCanonical } from '../utils/units.js';
import { pageForQuote } from './documentText.js';

export type ExtractionMode = 'live' | 'recorded_demo';

export type MedicationMatch = {
  status: 'exact' | 'ambiguous' | 'unsupported';
  candidates: Array<{ ingredient_code: string; ingredient_name: string }>;
};

export type CandidateFact = {
  index: number;
  kind: ExtractedFact['kind'];
  code: string;
  raw_value: string | null;
  normalized_value: number | null;
  unit: string | null;
  normalized_unit: string | null;
  unit_conversion_note: string | null;
  observed_at: string | null;
  medication_status: 'current' | 'past' | 'unclear' | null;
  source_page: number | null;
  source_quote: string;
  source_quote_verified: boolean;
  medication_match: MedicationMatch | null;
  needs_review: boolean;
  /** Non-null means the doctor cannot confirm this candidate as-is. */
  blocked_reason: string | null;
};

export type ExtractionOutcome = {
  status: 'COMPLETED' | 'MANUAL_REQUIRED';
  candidates: CandidateFact[];
  warnings: string[];
  metadata: ProviderMetadata;
  provider: string;
  providerModel: string;
  modelRevision: string | null;
  isRecordedDemo: boolean;
  repairAttempted: boolean;
  chunkCount: number;
  pageSelection: number[];
  errorCode: string | null;
  errorMessage: string | null;
};

/* ------------------------------ cache key ------------------------------ */

/**
 * Supplement 9: `clinic_id + patient_id + document_sha256 + page_selection +
 * parser_version + model_version + prompt_version + schema_version`.
 * clinic_id is part of the key, so a cached result can never leak across
 * clinics (AI-06).
 */
export function buildCacheKey(parts: {
  clinicId: string;
  patientId: string;
  documentSha256: string;
  pageSelection: number[];
  parserVersion: string;
  modelVersion: string;
  promptVersion: string;
  schemaVersion: string;
}): string {
  return sha256(
    [
      parts.clinicId,
      parts.patientId,
      parts.documentSha256,
      parts.pageSelection.join('.') || 'all',
      parts.parserVersion,
      parts.modelVersion,
      parts.promptVersion,
      parts.schemaVersion,
    ].join('|'),
  );
}

/* ------------------------------ chunking ------------------------------ */

export function selectPages(pages: string[], selection: number[] | null): { pages: string[]; numbers: number[] } {
  if (!selection || selection.length === 0) {
    return { pages, numbers: pages.map((_, i) => i + 1) };
  }
  const numbers = [...new Set(selection)].filter((n) => n >= 1 && n <= pages.length).sort((a, b) => a - b);
  return { pages: numbers.map((n) => pages[n - 1] ?? ''), numbers };
}

export type TextChunk = { text: string; pageLabel: string };

/**
 * Split on line boundaries so a table row or a date + value stay together
 * (supplement 9: "Jadval satri va sana konteksti bo'linmaydi").
 */
export function chunkPages(pages: string[], pageNumbers: number[], maxTokens: number): TextChunk[] {
  const chunks: TextChunk[] = [];
  let buffer: string[] = [];
  let bufferTokens = 0;
  let firstPage = pageNumbers[0] ?? 1;
  let lastPage = firstPage;

  const flush = () => {
    if (buffer.length === 0) return;
    chunks.push({
      text: buffer.join('\n'),
      pageLabel: firstPage === lastPage ? `${firstPage}-sahifa` : `${firstPage}–${lastPage}-sahifa`,
    });
    buffer = [];
    bufferTokens = 0;
  };

  for (let p = 0; p < pages.length; p += 1) {
    const pageNumber = pageNumbers[p] ?? p + 1;
    for (const line of (pages[p] ?? '').split(/\r?\n/)) {
      const lineTokens = estimateTokens(line) + 1;
      if (bufferTokens > 0 && bufferTokens + lineTokens > maxTokens) {
        flush();
        firstPage = pageNumber;
      }
      if (buffer.length === 0) firstPage = pageNumber;
      buffer.push(line);
      bufferTokens += lineTokens;
      lastPage = pageNumber;
    }
  }
  flush();

  return chunks.length > 0 ? chunks : [{ text: '', pageLabel: `${firstPage}-sahifa` }];
}

/* ------------------------------ verification ------------------------------ */

/**
 * Backend verification of the model output (main spec 9.2, supplement 12).
 * A quote that is not present in the document text blocks the fact from being
 * confirmed at all (AT-07, AI-10).
 */
export function buildCandidates(
  payload: ExtractionPayload,
  documentText: string,
  pages: string[],
  pageNumbers: number[],
  content: ClinicalContent,
): CandidateFact[] {
  return payload.facts.map((fact, index) => {
    const verified = quoteFoundInText(fact.source_quote, documentText);
    const normalizedQuote = normalizeForQuoteMatch(fact.source_quote);
    const locatedPageIndex = verified ? pageForQuote(pages, normalizedQuote, normalizeForQuoteMatch) : null;
    const locatedPage = locatedPageIndex ? (pageNumbers[locatedPageIndex - 1] ?? locatedPageIndex) : null;

    let normalizedValue = fact.normalized_value;
    let normalizedUnit: string | null = null;
    let conversionNote: string | null = null;

    if (fact.kind === 'observation') {
      if (!isKnownObservationCode(fact.code)) {
        conversionNote = 'Noma’lum ko‘rsatkich kodi — birlik normallashtirilmadi.';
      } else if (fact.normalized_value != null) {
        const conv = toCanonical(fact.code, fact.normalized_value, fact.unit);
        if (conv.ok) {
          normalizedValue = conv.value;
          normalizedUnit = conv.unit;
          if (conv.converted) conversionNote = `Jadval bo‘yicha ${fact.unit} → ${conv.unit}.`;
        } else {
          // Spec 8.2: no LLM-invented conversion. The value stays as written and
          // any rule that needs it becomes NOT_EVALUABLE.
          conversionNote =
            conv.reason === 'missing_unit'
              ? 'Birlik ko‘rsatilmagan — konvertatsiya bajarilmadi.'
              : 'Birlik konvertatsiya jadvalida yo‘q — qiymat asl holida qoldi.';
        }
      }
    }

    const medicationMatch = fact.kind === 'medication' ? matchMedication(fact, content) : null;

    const blockedReason = !verified
      ? 'SOURCE_QUOTE_NOT_FOUND'
      : medicationMatch?.status === 'ambiguous'
        ? 'MEDICATION_AMBIGUOUS'
        : null;

    return {
      index,
      kind: fact.kind,
      code: fact.code,
      raw_value: fact.raw_value,
      normalized_value: normalizedValue,
      unit: fact.unit,
      normalized_unit: normalizedUnit,
      unit_conversion_note: conversionNote,
      observed_at: fact.observed_at,
      medication_status: fact.medication_status,
      source_page: locatedPage ?? fact.source_page,
      source_quote: fact.source_quote,
      source_quote_verified: verified,
      medication_match: medicationMatch,
      needs_review: true,
      blocked_reason: blockedReason,
    };
  });
}

function matchMedication(fact: ExtractedFact, content: ClinicalContent): MedicationMatch {
  const exact = content.medications.find((m) => m.ingredient_code === fact.code);
  if (exact) {
    return {
      status: 'exact',
      candidates: [{ ingredient_code: exact.ingredient_code, ingredient_name: exact.ingredient_name }],
    };
  }

  // UI-05: exact alias match only. Nothing is approximately mapped.
  const byName = matchMedicationsByName(content, fact.code);
  const byRaw = fact.raw_value ? matchMedicationsByName(content, (fact.raw_value.split(/[\s,]+/)[0] ?? '')) : [];
  const merged = [...byName, ...byRaw].filter(
    (m, i, arr) => arr.findIndex((x) => x.ingredient_code === m.ingredient_code) === i,
  );

  if (merged.length === 1) {
    const only = merged[0]!;
    return {
      status: 'exact',
      candidates: [{ ingredient_code: only.ingredient_code, ingredient_name: only.ingredient_name }],
    };
  }
  if (merged.length > 1) {
    return {
      status: 'ambiguous',
      candidates: merged.map((m) => ({ ingredient_code: m.ingredient_code, ingredient_name: m.ingredient_name })),
    };
  }
  return { status: 'unsupported', candidates: [] };
}

/* ------------------------------ orchestration ------------------------------ */

function emptyMetadata(provider: string, modelId: string): ProviderMetadata {
  return {
    provider,
    model_id: modelId,
    model_revision: null,
    prompt_version: PROMPT_VERSION,
    schema_version: EXTRACTION_SCHEMA_VERSION,
    latency_ms: 0,
    input_tokens: null,
    output_tokens: null,
    finish_status: null,
    cache_hit: false,
  };
}

function manualOutcome(errorCode: string, errorMessage: string, provider: string, modelId: string): ExtractionOutcome {
  return {
    status: 'MANUAL_REQUIRED',
    candidates: [],
    warnings: [],
    metadata: emptyMetadata(provider, modelId),
    provider,
    providerModel: modelId,
    modelRevision: null,
    isRecordedDemo: false,
    repairAttempted: false,
    chunkCount: 0,
    pageSelection: [],
    errorCode,
    errorMessage,
  };
}

/**
 * Fallback order from supplement 10: cache -> configured cloud provider ->
 * local model (only when explicitly enabled) -> manual entry. There is no
 * paid-provider fallback and no silent model substitution.
 */
export async function runExtraction(options: {
  document: DocumentRecord;
  mode: ExtractionMode;
  pageSelection: number[] | null;
}): Promise<ExtractionOutcome> {
  const config = env();
  const content = loadClinicalContent();
  const allowedCodes = content.medications.map((m) => m.ingredient_code);

  const documentPages = options.document.page_texts?.length
    ? options.document.page_texts
    : [options.document.extracted_text ?? ''];
  const { pages, numbers } = selectPages(documentPages, options.pageSelection);
  const selectedText = pages.join('\n\n');

  if (options.mode === 'recorded_demo') {
    const adapter = new RecordedDemoAdapter();
    return runWithAdapter(adapter, {
      content,
      allowedCodes,
      pages,
      numbers,
      selectedText,
      chunks: [{ text: selectedText, pageLabel: 'barcha tanlangan sahifalar' }],
      deadlineAt: Date.now() + config.LLM_TIMEOUT_SECONDS * 1000,
    });
  }

  const adapters = await buildAdapterChain();
  if (adapters.length === 0) {
    return manualOutcome(
      'LLM_NOT_CONFIGURED',
      'AI provayderi sozlanmagan. Faktlarni qo‘lda kiriting.',
      'manual',
      '-',
    );
  }

  // Cache lookup before anything is sent (supplement 10.1).
  for (const adapter of adapters) {
    const cacheKey = buildCacheKey({
      clinicId: options.document.clinic_id,
      patientId: options.document.patient_id,
      documentSha256: options.document.sha256,
      pageSelection: numbers,
      parserVersion: options.document.parser_version ?? 'unknown',
      modelVersion: adapter.modelId,
      promptVersion: PROMPT_VERSION,
      schemaVersion: EXTRACTION_SCHEMA_VERSION,
    });
    const cached = await ExtractionCacheModel.findOne({ cache_key: cacheKey, clinic_id: options.document.clinic_id });
    if (cached) {
      await ExtractionCacheModel.updateOne({ _id: cached._id }, { $inc: { hit_count: 1 } });
      const payload = cached.payload as ExtractionPayload;
      const metadata = { ...(cached.provider_metadata as ProviderMetadata), cache_hit: true };
      return {
        status: 'COMPLETED',
        // A cached fact still requires doctor confirmation (supplement 9).
        candidates: buildCandidates(payload, selectedText, pages, numbers, content),
        warnings: payload.warnings ?? [],
        metadata,
        provider: cached.provider,
        providerModel: cached.model_version,
        modelRevision: metadata.model_revision ?? null,
        isRecordedDemo: false,
        repairAttempted: false,
        chunkCount: 1,
        pageSelection: numbers,
        errorCode: null,
        errorMessage: null,
      };
    }
  }

  // AI-08: synthetic-only guard, evaluated before any cloud call is made.
  const cloudBlocked = !options.document.is_synthetic && !config.ALLOW_REAL_PATIENT_DATA;

  const deadlineAt = Date.now() + config.LLM_TIMEOUT_SECONDS * 1000;
  const chunks = chunkPages(pages, numbers, config.LLM_MAX_INPUT_TOKENS_PER_CHUNK);

  let lastError: LLMError | null = null;
  for (const adapter of adapters) {
    if (adapter.isCloud && cloudBlocked) {
      lastError = new LLMError(
        'LLM_PROVIDER_ERROR',
        'Hujjat sintetik deb belgilanmagan — cloud extraction o‘chirilgan.',
      );
      continue;
    }
    if (Date.now() >= deadlineAt) {
      lastError = new LLMError('LLM_TIMEOUT', 'Umumiy 30 soniyalik budjet tugadi.');
      break;
    }

    const gate = extractionGate();
    if (!gate.tryAcquire()) {
      return manualOutcome(
        'LLM_BUSY',
        'Ayni paytda boshqa extraction bajarilmoqda. Birozdan keyin qayta urinib ko‘ring yoki qo‘lda kiriting.',
        adapter.name,
        adapter.modelId,
      );
    }

    try {
      const outcome = await runWithAdapter(adapter, {
        content,
        allowedCodes,
        pages,
        numbers,
        selectedText,
        chunks,
        deadlineAt,
      });

      const cacheKey = buildCacheKey({
        clinicId: options.document.clinic_id,
        patientId: options.document.patient_id,
        documentSha256: options.document.sha256,
        pageSelection: numbers,
        parserVersion: options.document.parser_version ?? 'unknown',
        modelVersion: adapter.modelId,
        promptVersion: PROMPT_VERSION,
        schemaVersion: EXTRACTION_SCHEMA_VERSION,
      });
      await ExtractionCacheModel.updateOne(
        { cache_key: cacheKey },
        {
          $set: { payload: outcome.rawPayload, provider_metadata: outcome.metadata },
          $setOnInsert: {
            clinic_id: options.document.clinic_id,
            patient_id: options.document.patient_id,
            document_sha256: options.document.sha256,
            page_selection: numbers,
            parser_version: options.document.parser_version ?? 'unknown',
            model_version: adapter.modelId,
            prompt_version: PROMPT_VERSION,
            schema_version: EXTRACTION_SCHEMA_VERSION,
            provider: adapter.name,
            hit_count: 0,
          },
        },
        { upsert: true },
      );

      return outcome;
    } catch (err) {
      if (!(err instanceof LLMError)) throw err;
      lastError = err;
    } finally {
      gate.release();
    }
  }

  const code = lastError?.code ?? 'LLM_PROVIDER_ERROR';
  return manualOutcome(
    code,
    lastError?.message ?? 'AI extraction bajarilmadi. Faktlarni qo‘lda kiriting.',
    adapters[0]?.name ?? 'manual',
    adapters[0]?.modelId ?? '-',
  );
}

async function buildAdapterChain(): Promise<LLMAdapter[]> {
  const config = env();
  const chain: LLMAdapter[] = [];

  const primary = await getAdapter(config.LLM_PROVIDER);
  if (primary) chain.push(primary);

  if (config.LOCAL_FALLBACK_ENABLED && config.LLM_PROVIDER !== 'ollama') {
    const local = await getAdapter('ollama');
    if (local) chain.push(local);
  }
  return chain;
}

type RunContext = {
  content: ClinicalContent;
  allowedCodes: string[];
  pages: string[];
  numbers: number[];
  selectedText: string;
  chunks: TextChunk[];
  deadlineAt: number;
};

async function runWithAdapter(
  adapter: LLMAdapter,
  ctx: RunContext,
): Promise<ExtractionOutcome & { rawPayload: ExtractionPayload }> {
  const facts: ExtractedFact[] = [];
  const warnings: string[] = [];
  let repairAttempted = false;
  let metadata: ProviderMetadata = emptyMetadata(adapter.name, adapter.modelId);
  let totalLatency = 0;
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;

  for (let i = 0; i < ctx.chunks.length; i += 1) {
    const chunk = ctx.chunks[i]!;
    const result = await adapter.extract({
      documentText: chunk.text,
      allowedIngredientCodes: ctx.allowedCodes,
      deadlineAt: ctx.deadlineAt,
      chunkInfo: { index: i, total: ctx.chunks.length, pageLabel: chunk.pageLabel },
    });

    facts.push(...result.payload.facts);
    warnings.push(...result.payload.warnings);
    repairAttempted = repairAttempted || result.repairAttempted;
    metadata = result.metadata;
    totalLatency += result.metadata.latency_ms;
    inputTokens = addNullable(inputTokens, result.metadata.input_tokens);
    outputTokens = addNullable(outputTokens, result.metadata.output_tokens);
  }

  const rawPayload: ExtractionPayload = {
    schema_version: EXTRACTION_SCHEMA_VERSION,
    facts,
    warnings,
  };

  const aggregated: ProviderMetadata = {
    ...metadata,
    latency_ms: totalLatency,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_hit: false,
  };

  return {
    status: 'COMPLETED',
    candidates: buildCandidates(rawPayload, ctx.selectedText, ctx.pages, ctx.numbers, ctx.content),
    warnings,
    metadata: aggregated,
    provider: adapter.name,
    providerModel: adapter.modelId,
    modelRevision: aggregated.model_revision,
    isRecordedDemo: adapter.isRecordedDemo,
    repairAttempted,
    chunkCount: ctx.chunks.length,
    pageSelection: ctx.numbers,
    errorCode: null,
    errorMessage: null,
    rawPayload,
  };
}

/** Keeps null meaning "provider reported nothing" rather than silently becoming 0. */
function addNullable(acc: number | null, next: number | null): number | null {
  if (next == null) return acc;
  return (acc ?? 0) + next;
}
