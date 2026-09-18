import crypto from 'node:crypto';

/**
 * Deterministic JSON: object keys sorted, arrays kept in order.
 * Used for analysis input hashing and idempotency payload comparison, so that
 * "bir xil kirish -> bir xil strukturaviy natija" (FR-09) is verifiable.
 */
export function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const out: Record<string, unknown> = {};
  for (const [k, v] of entries) out[k] = canonicalize(v);
  return out;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function sha256(input: string | Buffer): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

export function hashCanonical(value: unknown): string {
  return sha256(canonicalJson(value));
}
