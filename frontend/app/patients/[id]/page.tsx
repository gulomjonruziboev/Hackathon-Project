'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { Badge, ErrorNotice, Loading, Notice, SyntheticBanner } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { ALLERGY_LABEL, FACT_STATUS_LABEL, formatDate, formatDateTime } from '@/lib/format';
import type { DocumentItem, PatientProfile } from '@/lib/types';

export default function PatientProfilePage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const patientId = params.id;

  const [profile, setProfile] = useState<PatientProfile | null>(null);
  const [documents, setDocuments] = useState<DocumentItem[]>([]);
  const [error, setError] = useState<{ code: string; message: string; requestId?: string | null } | null>(null);
  const [uploading, setUploading] = useState(false);

  const load = useCallback(async () => {
    try {
      const [p, d] = await Promise.all([
        api.get<PatientProfile>(`/patients/${patientId}`),
        api.get<{ items: DocumentItem[] }>(`/patients/${patientId}/documents`),
      ]);
      setProfile(p);
      setDocuments(d.items);
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 401) return;
        setError({ code: err.code, message: err.message, requestId: err.requestId });
      }
    }
  }, [patientId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function upload(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      const form = new FormData();
      form.append('file', file);
      const created = await api.post<DocumentItem>(`/patients/${patientId}/documents`, form);
      router.push(`/patients/${patientId}/documents/${created.id}`);
    } catch (err) {
      if (err instanceof ApiError) setError({ code: err.code, message: err.message, requestId: err.requestId });
    } finally {
      setUploading(false);
      event.target.value = '';
    }
  }

  if (!profile) {
    return (
      <AppShell>
        <ErrorNotice error={error} />
        {!error ? <Loading what="Bemor profili" /> : null}
      </AppShell>
    );
  }

  const gaps = profile.data_gaps;
  const hasGaps = gaps.conflicting.length > 0 || gaps.undated.length > 0 || gaps.allergy_unknown;

  return (
    <AppShell>
      <h1>
        {profile.synthetic_code} · {profile.age} yosh
      </h1>
      <p className="muted-text">
        Profil reviziyasi:{' '}
        {profile.profile_revision
          ? `#${profile.profile_revision.revision_no} · ${formatDateTime(profile.profile_revision.confirmed_at)}`
          : 'hali yaratilmagan'}{' '}
        · model_sex: {profile.model_sex}
      </p>

      <SyntheticBanner />
      <ErrorNotice error={error} />

      <div className="actions" style={{ marginBottom: 14 }}>
        <label htmlFor="upload" className="visually-hidden" style={{ marginBottom: 0 }}>
          Hujjat yuklash
        </label>
        <input
          id="upload"
          type="file"
          accept=".txt,text/plain,.pdf,application/pdf"
          onChange={upload}
          disabled={uploading}
          style={{ maxWidth: 320 }}
        />
        {uploading ? <span className="muted-text">Yuklanmoqda…</span> : null}
        <Link href={`/patients/${patientId}/scenarios`}>
          <button type="button">Retseptni tekshirish</button>
        </Link>
        <Link href={`/patients/${patientId}/audit`}>
          <button type="button" className="secondary">
            Audit
          </button>
        </Link>
      </div>
      <p className="muted-text" style={{ marginTop: -8 }}>
        TXT yoki matn qatlamiga ega PDF, 5 MB gacha, 20 sahifagacha. Skaner nusxasi qo‘llab-quvvatlanmaydi (OCR yo‘q).
      </p>

      {hasGaps ? (
        <Notice kind="warn">
          <strong>Ma’lumotdagi bo‘shliqlar</strong>
          <ul className="list-reset">
            {gaps.allergy_unknown ? <li>Allergiya holati tasdiqlanmagan — allergiyaga oid tekshiruv bajarilmaydi.</li> : null}
            {gaps.conflicting.length > 0 ? <li>Ziddiyatli qiymatlar: {gaps.conflicting.join(', ')}</li> : null}
            {gaps.undated.length > 0 ? <li>Sanasi yo‘q faktlar: {gaps.undated.join(', ')}</li> : null}
          </ul>
        </Notice>
      ) : null}

      <div className="grid-2">
        <section className="card">
          <h2>Tasdiqlangan holat</h2>
          <p>
            <Badge label={ALLERGY_LABEL[profile.allergy_status]} />
          </p>

          <h3>Tashxislar</h3>
          {profile.conditions.length === 0 ? (
            <p className="muted-text">Tasdiqlangan tashxis yo‘q.</p>
          ) : (
            <ul className="list-reset">
              {profile.conditions.map((c) => (
                <li key={c.fact_id}>
                  <span className="mono">{c.code}</span> — {c.raw_value ?? c.code}
                </li>
              ))}
            </ul>
          )}

          <h3>Allergiyalar</h3>
          {profile.allergies.length === 0 ? (
            <p className="muted-text">
              Tasdiqlangan allergiya yozuvi yo‘q. Bu “allergiya yo‘q” degani emas.
            </p>
          ) : (
            <ul className="list-reset">
              {profile.allergies.map((a) => (
                <li key={a.fact_id}>{a.raw_value ?? a.code}</li>
              ))}
            </ul>
          )}

          <h3>Faol dorilar</h3>
          {profile.medications.filter((m) => m.status === 'active').length === 0 ? (
            <p className="muted-text">Faol dori yo‘q.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th scope="col">Faol modda</th>
                  <th scope="col">Doza</th>
                  <th scope="col">Qo‘llab-quvvatlanadigan tekshiruvlar</th>
                </tr>
              </thead>
              <tbody>
                {profile.medications
                  .filter((m) => m.status === 'active')
                  .map((m) => (
                    <tr key={m.statement_id}>
                      <td>{m.ingredient_name}</td>
                      <td>
                        {m.dose_value ?? '—'} {m.dose_unit ?? ''}
                        {m.frequency_per_day ? ` · kuniga ${m.frequency_per_day}` : ''}
                      </td>
                      <td>
                        <div>{m.supported_checks.join(', ') || '—'}</div>
                        <div className="muted-text">Baholanmaydi: {m.unsupported_checks.join(', ') || '—'}</div>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          )}
        </section>

        <section className="card">
          <h2>Laboratoriya ko‘rsatkichlari</h2>
          {profile.observations.length === 0 ? (
            <p className="muted-text">Tasdiqlangan ko‘rsatkich yo‘q.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th scope="col">Ko‘rsatkich</th>
                  <th scope="col">Qiymat</th>
                  <th scope="col">Olingan sana</th>
                  <th scope="col">Manba</th>
                  <th scope="col">Holat</th>
                </tr>
              </thead>
              <tbody>
                {profile.observations.map((o) => (
                  <tr key={o.fact_id}>
                    <td className="mono">{o.code}</td>
                    <td>
                      {o.normalized_value ?? '—'} {o.normalized_unit ?? o.unit ?? ''}
                    </td>
                    <td>{formatDate(o.observed_at)}</td>
                    <td className="muted-text">
                      {o.source.kind === 'manual' ? 'qo‘lda kiritilgan' : 'hujjatdan'}
                      {o.source.page ? ` · ${o.source.page}-sahifa` : ''}
                    </td>
                    <td>
                      <Badge label={FACT_STATUS_LABEL[o.status]} />
                      {o.conflict_note ? <div className="muted-text">{o.conflict_note}</div> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>

      <section className="card">
        <h2>Vaqt chizig‘i</h2>
        {profile.timeline.length === 0 ? (
          <p className="muted-text">Sanasi ko‘rsatilgan tasdiqlangan fakt yo‘q.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th scope="col">Sana</th>
                <th scope="col">Tur</th>
                <th scope="col">Fakt</th>
                <th scope="col">Qiymat</th>
              </tr>
            </thead>
            <tbody>
              {profile.timeline.map((t, i) => (
                <tr key={`${t.code}-${t.observed_at}-${i}`}>
                  <td>{formatDate(t.observed_at)}</td>
                  <td>{t.kind}</td>
                  <td>{t.label}</td>
                  <td>
                    {t.value ?? '—'} {t.unit ?? ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="muted-text">
          Bu chiziq faqat mavjud tasdiqlangan ko‘rsatkichlarni ifodalaydi. Hisoblanmagan fiziologik jarayon
          simulyatsiya qilinmaydi.
        </p>
      </section>

      <section className="card">
        <h2>Hujjatlar</h2>
        {documents.length === 0 ? (
          <p className="muted-text">Hujjat yuklanmagan.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th scope="col">Fayl</th>
                <th scope="col">Tur</th>
                <th scope="col">Sahifa</th>
                <th scope="col">Yuklangan</th>
                <th scope="col" />
              </tr>
            </thead>
            <tbody>
              {documents.map((d) => (
                <tr key={d.id}>
                  <td>{d.filename}</td>
                  <td className="mono">{d.mime_type}</td>
                  <td>{d.page_count ?? '—'}</td>
                  <td>{formatDateTime(d.created_at)}</td>
                  <td>
                    <Link href={`/patients/${patientId}/documents/${d.id}`}>Extractionni tekshirish</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </AppShell>
  );
}
