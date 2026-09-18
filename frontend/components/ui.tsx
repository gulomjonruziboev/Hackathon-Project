'use client';

import type { ReactNode } from 'react';

export function Badge({
  label,
  className = 'badge-neutral',
}: {
  label: { text: string; glyph: string; className?: string } | string;
  className?: string;
}) {
  if (typeof label === 'string') {
    return <span className={`badge ${className}`}>{label}</span>;
  }
  return (
    <span className={`badge ${label.className ?? className}`}>
      <span className="glyph" aria-hidden="true">
        {label.glyph}
      </span>
      {label.text}
    </span>
  );
}

/** FR-16: the synthetic-data and validation caveats appear on every result page. */
export function SyntheticBanner({ extra }: { extra?: ReactNode }) {
  return (
    <div className="synthetic-banner" role="note">
      <span aria-hidden="true">⚠</span>
      <div>
        <strong>Sintetik ma’lumot · demo muhiti.</strong> TwinRx tashxis qo‘ymaydi, retsept bermaydi va davolashni
        o‘zgartirmaydi. Klinik validatsiya bajarilmagan; barcha qarorlarni shifokor qabul qiladi.
        {extra ? <div style={{ marginTop: 4 }}>{extra}</div> : null}
      </div>
    </div>
  );
}

export function Notice({
  kind = 'info',
  children,
}: {
  kind?: 'info' | 'warn' | 'error' | 'ok';
  children: ReactNode;
}) {
  const cls = kind === 'info' ? 'notice' : `notice ${kind}`;
  return (
    <div className={cls} role={kind === 'error' ? 'alert' : 'note'}>
      {children}
    </div>
  );
}

export function ErrorNotice({ error }: { error: { code: string; message: string; requestId?: string | null } | null }) {
  if (!error) return null;
  return (
    <Notice kind="error">
      <strong>{error.message}</strong>
      <div className="muted-text mono">
        kod: {error.code}
        {error.requestId ? ` · request: ${error.requestId}` : ''}
      </div>
    </Notice>
  );
}

export function Loading({ what = 'Ma’lumot' }: { what?: string }) {
  return (
    <p className="muted-text" role="status">
      {what} yuklanmoqda…
    </p>
  );
}
