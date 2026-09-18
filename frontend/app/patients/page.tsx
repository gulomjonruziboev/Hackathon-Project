'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { Badge, ErrorNotice, Loading, SyntheticBanner } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { ALLERGY_LABEL, formatDateTime } from '@/lib/format';
import type { PatientListItem } from '@/lib/types';

export default function PatientsPage() {
  const [items, setItems] = useState<PatientListItem[] | null>(null);
  const [query, setQuery] = useState('');
  const [error, setError] = useState<{ code: string; message: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await api.get<{ items: PatientListItem[] }>('/patients');
        if (!cancelled) setItems(res.items);
      } catch (err) {
        if (err instanceof ApiError && err.status !== 401) setError({ code: err.code, message: err.message });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Filtering happens client-side over the demo's three patients; the API also
  // supports `?q=` for a real dataset.
  const filtered = useMemo(() => {
    if (!items) return null;
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter(
      (p) => p.synthetic_code.toLowerCase().includes(q) || p.confirmed_conditions.some((c) => c.toLowerCase().includes(q)),
    );
  }, [items, query]);

  return (
    <AppShell>
      <h1>Bemorlar</h1>
      <SyntheticBanner />
      <ErrorNotice error={error} />

      <div className="card">
        <div className="field" style={{ maxWidth: 380 }}>
          <label htmlFor="q">Bemor kodi yoki tashxis bo‘yicha qidiruv</label>
          <input id="q" type="text" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="SYN-001" />
        </div>

        {filtered === null ? (
          <Loading what="Bemorlar ro‘yxati" />
        ) : filtered.length === 0 ? (
          <p className="muted-text">Mos bemor topilmadi.</p>
        ) : (
          <table>
            <caption className="muted-text" style={{ captionSide: 'bottom', textAlign: 'left', paddingTop: 8 }}>
              Faqat sizning klinikangiz bemorlari ko‘rinadi.
            </caption>
            <thead>
              <tr>
                <th scope="col">Bemor kodi</th>
                <th scope="col">Yosh</th>
                <th scope="col">Tasdiqlangan tashxislar</th>
                <th scope="col">Allergiya holati</th>
                <th scope="col">Oxirgi yangilanish</th>
                <th scope="col">Ma’lumot turi</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((p) => (
                <tr key={p.id}>
                  <td>
                    <Link href={`/patients/${p.id}`}>{p.synthetic_code}</Link>
                  </td>
                  <td>{p.age}</td>
                  <td>
                    {p.confirmed_conditions.length === 0 ? (
                      <span className="muted-text">tasdiqlangan tashxis yo‘q</span>
                    ) : (
                      p.confirmed_conditions.join('; ')
                    )}
                  </td>
                  <td>
                    <Badge label={ALLERGY_LABEL[p.allergy_status]} />
                  </td>
                  <td>{formatDateTime(p.last_updated_at)}</td>
                  <td>
                    <Badge label={{ text: 'Sintetik ma’lumot', glyph: '⚗', className: 'badge-neutral' }} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </AppShell>
  );
}
