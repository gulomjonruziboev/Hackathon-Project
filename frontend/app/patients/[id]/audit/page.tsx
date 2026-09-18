'use client';

import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { ErrorNotice, Loading, Notice } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import type { AuditItem } from '@/lib/types';

export default function AuditPage() {
  const params = useParams<{ id: string }>();
  const [items, setItems] = useState<AuditItem[] | null>(null);
  const [note, setNote] = useState('');
  const [error, setError] = useState<{ code: string; message: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await api.get<{ items: AuditItem[]; note: string }>(`/patients/${params.id}/audit`);
        if (!cancelled) {
          setItems(res.items);
          setNote(res.note);
        }
      } catch (err) {
        if (err instanceof ApiError && err.status !== 401) setError({ code: err.code, message: err.message });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [params.id]);

  return (
    <AppShell>
      <h1>Audit</h1>
      <ErrorNotice error={error} />
      {note ? <Notice>{note}</Notice> : null}

      {items === null ? (
        <Loading what="Audit yozuvlari" />
      ) : items.length === 0 ? (
        <p className="muted-text">Audit yozuvi yo‘q.</p>
      ) : (
        <div className="card">
          <table>
            <thead>
              <tr>
                <th scope="col">Vaqt</th>
                <th scope="col">Amal</th>
                <th scope="col">Obyekt</th>
                <th scope="col">Holat</th>
                <th scope="col">Qo‘shimcha</th>
              </tr>
            </thead>
            <tbody>
              {items.map((e) => (
                <tr key={e.id}>
                  <td>{formatDateTime(e.created_at)}</td>
                  <td className="mono">{e.action}</td>
                  <td className="mono muted-text">
                    {e.entity_type}
                    {e.entity_id ? `/${e.entity_id.slice(0, 8)}` : ''}
                  </td>
                  <td>{e.status}</td>
                  <td className="mono muted-text">{JSON.stringify(e.metadata)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </AppShell>
  );
}
