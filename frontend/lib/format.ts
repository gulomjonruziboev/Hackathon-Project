import type { AllergyStatus, FactStatus, Severity } from './types';

/** Spec "Umumiy dizayn": stored UTC, shown to the user in Asia/Tashkent. */
const dateTime = new Intl.DateTimeFormat('uz-UZ', {
  timeZone: 'Asia/Tashkent',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});

const dateOnly = new Intl.DateTimeFormat('uz-UZ', {
  timeZone: 'Asia/Tashkent',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return 'sana yo‘q';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? 'sana yo‘q' : dateTime.format(d);
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return 'sana yo‘q';
  // A plain YYYY-MM-DD is a calendar date, not an instant: render it as written
  // so a timezone shift can never move an observation to the previous day.
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    const [y, m, d] = iso.split('-');
    return `${d}.${m}.${y}`;
  }
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? 'sana yo‘q' : dateOnly.format(d);
}

/** Colour alone never carries meaning — each status also has a word and a glyph. */
export const SEVERITY_LABEL: Record<Severity, { text: string; glyph: string; className: string }> = {
  high: { text: 'Yuqori', glyph: '▲', className: 'badge-high' },
  moderate: { text: 'O‘rtacha', glyph: '◆', className: 'badge-moderate' },
  review_required: { text: 'Ko‘rib chiqilsin', glyph: '✱', className: 'badge-review' },
  info: { text: 'Ma’lumot', glyph: 'ℹ', className: 'badge-info' },
};

export const ANALYSIS_STATUS_LABEL: Record<string, { text: string; glyph: string; className: string }> = {
  COMPLETED: { text: 'Baholandi', glyph: '✓', className: 'badge-ok' },
  PARTIAL: { text: 'Qisman baholandi', glyph: '◐', className: 'badge-moderate' },
  BLOCKED: { text: 'Baholab bo‘lmadi', glyph: '⊘', className: 'badge-high' },
  FAILED: { text: 'Texnik xato', glyph: '✕', className: 'badge-high' },
};

export const RULE_STATUS_LABEL: Record<string, { text: string; glyph: string; className: string }> = {
  TRIGGERED: { text: 'Ishga tushdi', glyph: '▲', className: 'badge-high' },
  NOT_TRIGGERED: { text: 'Ishga tushmadi', glyph: '✓', className: 'badge-ok' },
  NOT_APPLICABLE: { text: 'Taalluqli emas', glyph: '–', className: 'badge-neutral' },
  NOT_EVALUABLE: { text: 'Baholanmadi', glyph: '?', className: 'badge-moderate' },
  ERROR: { text: 'Xato', glyph: '✕', className: 'badge-high' },
};

export const ALLERGY_LABEL: Record<AllergyStatus, { text: string; glyph: string; className: string }> = {
  UNKNOWN: { text: 'Allergiya holati noma’lum', glyph: '?', className: 'badge-moderate' },
  KNOWN_NONE: { text: 'Allergiya yo‘qligi tasdiqlangan', glyph: '✓', className: 'badge-ok' },
  PRESENT: { text: 'Allergiya bor', glyph: '▲', className: 'badge-high' },
};

export const FACT_STATUS_LABEL: Record<FactStatus, { text: string; glyph: string; className: string }> = {
  EXTRACTED: { text: 'Ajratilgan', glyph: '•', className: 'badge-neutral' },
  CONFIRMED: { text: 'Tasdiqlangan', glyph: '✓', className: 'badge-ok' },
  REJECTED: { text: 'Rad etilgan', glyph: '✕', className: 'badge-neutral' },
  SUPERSEDED: { text: 'Almashtirilgan', glyph: '↺', className: 'badge-neutral' },
  CONFLICTED: { text: 'Ziddiyatli', glyph: '⚠', className: 'badge-high' },
};

export const REVIEW_STATUS_LABEL: Record<string, { text: string; glyph: string; className: string }> = {
  reviewed: { text: 'Klinik ko‘rikdan o‘tgan', glyph: '✓', className: 'badge-ok' },
  illustrative: { text: 'Illyustrativ — klinik tasdiqlanmagan', glyph: '⚠', className: 'badge-moderate' },
  draft: { text: 'Qoralama', glyph: '•', className: 'badge-neutral' },
};

export const MISSING_REASON_LABEL: Record<string, string> = {
  not_confirmed: 'tasdiqlangan qiymat yo‘q',
  conflicting_values: 'ziddiyatli qiymatlar',
  no_numeric_value: 'sonli qiymat yo‘q',
  stale_or_undated: 'eskirgan yoki sanasiz',
  allergy_status_unknown: 'allergiya holati tasdiqlanmagan',
  no_confirmed_conditions: 'tasdiqlangan tashxis yo‘q',
  no_confirmed_facts: 'tasdiqlangan profil yo‘q',
};

export function describeUsage(usage: {
  input_tokens: number | null;
  output_tokens: number | null;
  latency_ms: number;
  cache_hit: boolean;
}): string {
  const tokens =
    usage.input_tokens == null && usage.output_tokens == null
      ? 'token hisobi berilmagan'
      : `${usage.input_tokens ?? '—'} kirish / ${usage.output_tokens ?? '—'} chiqish token`;
  return `${tokens} · ${usage.latency_ms} ms${usage.cache_hit ? ' · keshdan' : ''}`;
}
