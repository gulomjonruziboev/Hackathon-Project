import {
  EXTRACTION_SCHEMA_VERSION,
  PROMPT_VERSION,
  extractionPayloadSchema,
  type ExtractedFact,
} from './extractionSchema.js';
import type { ExtractionRequest, ExtractionResult, LLMAdapter } from './LLMAdapter.js';

/**
 * Offline, deterministic parser for the "yozib olingan demo" mode (main spec 9.4).
 *
 * It is NOT a model and is never used as an automatic fallback: the doctor has
 * to ask for this mode explicitly, and everything it produces is flagged
 * `is_recorded_demo` so the UI can never present it as a live AI result.
 *
 * Because it only copies substrings it actually found, its `source_quote`
 * values always survive backend verification — and instructions embedded in
 * the document text have no effect on it at all (AT-06, AI-11).
 */
export class RecordedDemoAdapter implements LLMAdapter {
  readonly name = 'recorded_demo';
  readonly modelId = 'recorded-demo-parser';
  readonly isRecordedDemo = true;
  readonly isCloud = false;

  async extract(req: ExtractionRequest): Promise<ExtractionResult> {
    const startedAt = Date.now();
    const facts: ExtractedFact[] = [];
    const warnings: string[] = [];
    const lines = req.documentText.split(/\r?\n/);

    let section: 'none' | 'diagnosis' | 'labs' | 'medications' | 'past_medications' = 'none';

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (line === '') continue;

      const upper = line.toUpperCase();
      if (/^TASHXIS/.test(upper)) {
        section = 'diagnosis';
        continue;
      }
      if (/^(LABORATORIYA|TAHLIL)/.test(upper)) {
        section = 'labs';
        continue;
      }
      if (/^(OLDIN QABUL QILGAN|TO.XTATILGAN)/.test(upper)) {
        section = 'past_medications';
        continue;
      }
      if (/^(JORIY DORILAR|DORILAR)/.test(upper)) {
        section = 'medications';
        continue;
      }
      if (/^ALLERGIYA/.test(upper)) {
        section = 'none';
        const fact = parseAllergyLine(line, warnings);
        if (fact) facts.push(fact);
        continue;
      }
      if (/^(IZOH|HUJJAT|KLINIKA|BEMOR|TUG)/.test(upper)) {
        section = 'none';
        continue;
      }

      const body = line.replace(/^[-•*]\s*/, '').trim();
      if (body === '') continue;

      if (section === 'diagnosis') {
        facts.push(makeCondition(body, line));
      } else if (section === 'labs') {
        const fact = parseObservationLine(body, line, warnings);
        if (fact) facts.push(fact);
      } else if (section === 'medications' || section === 'past_medications') {
        facts.push(
          makeMedication(body, line, req.allowedIngredientCodes, section === 'past_medications' ? 'past' : 'current'),
        );
      }
    }

    if (facts.length === 0) warnings.push('Hujjatdan hech qanday fakt ajratilmadi.');

    const payload = extractionPayloadSchema.parse({
      schema_version: EXTRACTION_SCHEMA_VERSION,
      facts,
      warnings,
    });

    return {
      payload,
      metadata: {
        provider: this.name,
        model_id: this.modelId,
        model_revision: null,
        prompt_version: PROMPT_VERSION,
        schema_version: EXTRACTION_SCHEMA_VERSION,
        latency_ms: Date.now() - startedAt,
        // No model ran, so there is no usage to report. A guess would be a lie.
        input_tokens: null,
        output_tokens: null,
        finish_status: 'stop',
        cache_hit: false,
      },
      isRecordedDemo: true,
      repairAttempted: false,
      notes: ['Yozib olingan demo rejimi: jonli AI chaqirilmadi.'],
    };
  }
}

const OBSERVATION_ALIASES: Array<[RegExp, string]> = [
  [/^(e-?gfr|skf)$/i, 'EGFR'],
  [/^(kreatinin|creatinine|kreatin)$/i, 'CREATININE'],
  [/^(kaliy|kalij|potassium|k\+?)$/i, 'POTASSIUM'],
  [/^(natriy|sodium|na\+?)$/i, 'SODIUM'],
  [/^(hba1c|glikirlangan gemoglobin|gliko gemoglobin)$/i, 'HBA1C'],
  [/^(uacr|albumin\/kreatinin|albumin-kreatinin nisbati)$/i, 'UACR'],
  [/^(glyukoza|glukoza|glucose|och qorinda glyukoza|qand)$/i, 'GLUCOSE_FASTING'],
  [/^(vazn|tana vazni|weight)$/i, 'WEIGHT'],
  [/^(bo['’]y|boy|height)$/i, 'HEIGHT'],
  [/^(sistolik|sistolik ad|sad|systolic)$/i, 'SYSTOLIC_BP'],
  [/^(diastolik|diastolik ad|dad|diastolic)$/i, 'DIASTOLIC_BP'],
];

function mapObservationCode(label: string): string | null {
  const trimmed = label.trim();
  for (const [pattern, code] of OBSERVATION_ALIASES) {
    if (pattern.test(trimmed)) return code;
  }
  return null;
}

/** DD.MM.YYYY at the start of a line -> YYYY-MM-DD. Never inferred from elsewhere. */
function leadingDate(body: string): { iso: string | null; rest: string } {
  const m = body.match(/^(\d{2})\.(\d{2})\.(\d{4})\s+(.*)$/);
  if (!m) return { iso: null, rest: body };
  const [, dd, mm, yyyy, rest] = m;
  return { iso: `${yyyy}-${mm}-${dd}`, rest: (rest ?? '').trim() };
}

function parseObservationLine(body: string, sourceQuote: string, warnings: string[]): ExtractedFact | null {
  const { iso, rest } = leadingDate(body);
  const m = rest.match(/^([^:]+):\s*(-?\d+(?:[.,]\d+)?)\s*(.*)$/);
  if (!m) return null;

  const [, label, valueRaw, unitRaw] = m;
  const code = mapObservationCode(label ?? '');
  if (!code) {
    warnings.push(`Noma'lum ko'rsatkich nomi o'tkazib yuborildi: ${(label ?? '').trim()}`);
    return null;
  }
  if (iso === null) {
    warnings.push(`"${(label ?? '').trim()}" qatorida sana yo'q — observed_at null qoldirildi.`);
  }

  const normalized = Number((valueRaw ?? '').replace(',', '.'));
  const unit = (unitRaw ?? '').trim().replace(/[.;,]$/, '');

  return {
    kind: 'observation',
    code,
    raw_value: `${valueRaw ?? ''}${unit ? ` ${unit}` : ''}`,
    normalized_value: Number.isFinite(normalized) ? normalized : null,
    unit: unit === '' ? null : unit,
    observed_at: iso,
    medication_status: null,
    source_page: null,
    source_quote: sourceQuote,
    needs_review: true,
  };
}

function makeCondition(body: string, sourceQuote: string): ExtractedFact {
  const codeMatch = body.match(/^([A-Z]\d{2}(?:\.\d+)?|[A-Z]{2,6})\b/);
  return {
    kind: 'condition',
    code: codeMatch?.[1] ?? body.slice(0, 40),
    raw_value: body,
    normalized_value: null,
    unit: null,
    observed_at: null,
    medication_status: null,
    source_page: null,
    source_quote: sourceQuote,
    needs_review: true,
  };
}

function makeMedication(
  body: string,
  sourceQuote: string,
  allowedCodes: string[],
  status: 'current' | 'past',
): ExtractedFact {
  const firstWord = body.split(/[\s,]+/)[0] ?? body;
  const match = allowedCodes.find((c) => c.toLowerCase() === firstWord.toLowerCase());
  return {
    kind: 'medication',
    // When nothing matches we keep the literal text: no approximate mapping (UI-05).
    code: match ?? firstWord,
    raw_value: body,
    normalized_value: null,
    unit: null,
    observed_at: null,
    medication_status: status,
    source_page: null,
    source_quote: sourceQuote,
    needs_review: true,
  };
}

function parseAllergyLine(line: string, warnings: string[]): ExtractedFact | null {
  const value = line.split(':').slice(1).join(':').trim();
  if (value === '') return null;

  const noneStated = /(yo['’]q|yoq|none|ma['’]lum emas|aniqlanmagan)/i.test(value);
  if (noneStated) {
    // Main spec 8.1: "no allergy written" is not KNOWN_NONE — only a doctor decides.
    warnings.push(
      'Hujjatda allergiya yo‘qligi yozilgan. Bu avtomatik "allergiya yo‘q" degani emas — shifokor holatni tasdiqlashi kerak.',
    );
    return {
      kind: 'allergy',
      code: 'NONE_STATED',
      raw_value: value,
      normalized_value: null,
      unit: null,
      observed_at: null,
      medication_status: null,
      source_page: null,
      source_quote: line,
      needs_review: true,
    };
  }

  const substance = (value.split(/[(,;]/)[0] ?? value).trim();
  return {
    kind: 'allergy',
    code: substance,
    raw_value: value,
    normalized_value: null,
    unit: null,
    observed_at: null,
    medication_status: null,
    source_page: null,
    source_quote: line,
    needs_review: true,
  };
}
