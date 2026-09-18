/**
 * Thin API client. Requests go to /api/v1 on this same origin (Next rewrites
 * them to Express), so the HttpOnly session cookie is sent automatically and
 * the CSRF token is read from the readable companion cookie.
 */

export type ApiErrorBody = {
  error: {
    code: string;
    message: string;
    field_errors: Array<{ field: string; message: string }>;
    request_id: string | null;
  };
};

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly fieldErrors: Array<{ field: string; message: string }> = [],
    readonly requestId: string | null = null,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

function csrfToken(): string {
  if (typeof document === 'undefined') return '';
  const match = document.cookie.match(/(?:^|;\s*)twinrx_csrf=([^;]+)/);
  return match?.[1] ? decodeURIComponent(match[1]) : '';
}

async function request<T>(method: string, path: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<T> {
  const headers: Record<string, string> = { 'X-CSRF-Token': csrfToken(), ...extraHeaders };
  let payload: BodyInit | undefined;

  if (body instanceof FormData) {
    payload = body;
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }

  const res = await fetch(`/api/v1${path}`, { method, headers, body: payload, credentials: 'same-origin' });

  if (res.status === 204) return undefined as T;

  const text = await res.text();
  const json: unknown = text ? JSON.parse(text) : null;

  if (!res.ok) {
    const err = (json as ApiErrorBody | null)?.error;
    throw new ApiError(
      res.status,
      err?.code ?? 'UNKNOWN',
      err?.message ?? `So‘rov muvaffaqiyatsiz (${res.status}).`,
      err?.field_errors ?? [],
      err?.request_id ?? null,
    );
  }

  return json as T;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown, headers?: Record<string, string>) => request<T>('POST', path, body, headers),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body),
};

/** Same key + same payload replays the stored result instead of duplicating it. */
export function idempotencyKey(scope: string): Record<string, string> {
  return { 'Idempotency-Key': `${scope}-${crypto.randomUUID()}` };
}
