/** Storage is always UTC (spec "Umumiy dizayn"); the frontend renders Asia/Tashkent. */

export function ageInDays(from: Date, now: Date = new Date()): number {
  return Math.floor((now.getTime() - from.getTime()) / 86_400_000);
}

export function yearsBetween(birth: Date, now: Date = new Date()): number {
  let age = now.getUTCFullYear() - birth.getUTCFullYear();
  const m = now.getUTCMonth() - birth.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < birth.getUTCDate())) age -= 1;
  return age;
}

/** Accepts YYYY-MM-DD (as UTC midnight) or a full ISO timestamp. Returns null when unusable. */
export function parseIsoDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value !== 'string' || value.trim() === '') return null;
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value.trim());
  const d = new Date(dateOnly ? `${value.trim()}T00:00:00.000Z` : value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function toIso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}
