'use client';

import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { Badge, ErrorNotice, Loading, Notice, SyntheticBanner } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { describeUsage } from '@/lib/format';
import type { AllergyStatus, CandidateFact, Extraction } from '@/lib/types';

type DecisionState = {
  action: 'confirm' | 'reject';
  code: string;
  normalized_value: string;
  unit: string;
  observed_at: string;
  ingredient_code: string;
  active: boolean;
};

function initialDecision(candidate: CandidateFact): DecisionState {
  return {
    // A candidate whose quote could not be verified starts as rejected: the
    // backend refuses to confirm it anyway (AT-07 / AI-10).
    action: candidate.blocked_reason ? 'reject' : 'confirm',
    code: candidate.code,
    normalized_value: candidate.normalized_value == null ? '' : String(candidate.normalized_value),
    unit: candidate.unit ?? '',
    observed_at: candidate.observed_at ?? '',
    ingredient_code:
      candidate.medication_match?.status === 'exact'
        ? (candidate.medication_match.candidates[0]?.ingredient_code ?? '')
        : '',
    active: candidate.medication_status === 'current',
  };
}

export default function ExtractionReviewPage() {
  const params = useParams<{ id: string; documentId: string }>();
  const router = useRouter();
  const { id: patientId, documentId } = params;

  const [extraction, setExtraction] = useState<Extraction | null>(null);
  const [decisions, setDecisions] = useState<Record<number, DecisionState>>({});
  const [allergyStatus, setAllergyStatus] = useState<AllergyStatus>('UNKNOWN');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ code: string; message: string; requestId?: string | null } | null>(null);
  const [done, setDone] = useState<string | null>(null);

  function apply(result: Extraction) {
    setExtraction(result);
    const next: Record<number, DecisionState> = {};
    for (const candidate of result.candidates) next[candidate.index] = initialDecision(candidate);
    setDecisions(next);
  }

  async function runExtraction(mode: 'live' | 'recorded_demo', force: boolean) {
    setBusy(true);
    setError(null);
    try {
      const result = await api.post<Extraction>(`/documents/${documentId}/extract`, { mode, force });
      apply(result);
    } catch (err) {
      if (err instanceof ApiError) setError({ code: err.code, message: err.message, requestId: err.requestId });
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void runExtraction('live', false);
    // Runs once per document.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [documentId]);

  async function confirmAll() {
    if (!extraction) return;
    setBusy(true);
    setError(null);
    try {
      const payload = {
        allergy_status: allergyStatus,
        reason: 'Extraction shifokor tomonidan ko‘rib chiqildi',
        decisions: extraction.candidates.map((candidate) => {
          const d = decisions[candidate.index]!;
          const base: Record<string, unknown> = { candidate_index: candidate.index, action: d.action };
          if (d.action === 'reject') return base;

          base.code = candidate.kind === 'medication' ? d.ingredient_code || d.code : d.code;
          base.normalized_value = d.normalized_value === '' ? null : Number(d.normalized_value);
          base.unit = d.unit === '' ? null : d.unit;
          base.observed_at = d.observed_at === '' ? null : d.observed_at;
          if (candidate.kind === 'medication') {
            base.medication = { ingredient_code: d.ingredient_code || d.code, active: d.active };
          }
          return base;
        }),
      };

      const res = await api.post<{ profile_revision_id: string; revision_no: number; confirmed: number; corrected: number; rejected: number; stale_analyses: number }>(
        `/extractions/${extraction.id}/confirm`,
        payload,
      );
      setDone(
        `Profil reviziyasi #${res.revision_no} yaratildi: ${res.confirmed} ta tasdiqlandi, ${res.corrected} ta tuzatildi, ${res.rejected} ta rad etildi. ${res.stale_analyses} ta oldingi tahlil eskirgan deb belgilandi.`,
      );
    } catch (err) {
      if (err instanceof ApiError) setError({ code: err.code, message: err.message, requestId: err.requestId });
    } finally {
      setBusy(false);
    }
  }

  function update(index: number, patch: Partial<DecisionState>) {
    setDecisions((prev) => ({ ...prev, [index]: { ...prev[index]!, ...patch } }));
  }

  return (
    <AppShell>
      <h1>Extractionni tekshirish</h1>
      <SyntheticBanner />
      <ErrorNotice error={error} />

      {done ? (
        <Notice kind="ok">
          <strong>{done}</strong>
          <div className="actions" style={{ marginTop: 8 }}>
            <button type="button" onClick={() => router.push(`/patients/${patientId}`)}>
              Profilga qaytish
            </button>
            <button type="button" className="secondary" onClick={() => router.push(`/patients/${patientId}/scenarios`)}>
              Retseptni tekshirishga o‘tish
            </button>
          </div>
        </Notice>
      ) : null}

      {!extraction && busy ? <Loading what="Extraction" /> : null}

      {extraction ? (
        <>
          <div className="card muted">
            <div className="actions">
              <Badge
                label={
                  extraction.is_recorded_demo
                    ? { text: 'Yozib olingan demo — jonli AI emas', glyph: '⏺', className: 'badge-moderate' }
                    : { text: `Jonli AI · ${extraction.provider}`, glyph: '⚡', className: 'badge-ok' }
                }
              />
              <Badge label={{ text: `Model: ${extraction.provider_model}`, glyph: '⚙', className: 'badge-neutral' }} />
              {extraction.cache_hit ? (
                <Badge label={{ text: 'Keshdan olindi', glyph: '↺', className: 'badge-neutral' }} />
              ) : null}
              {extraction.repair_attempted ? (
                <Badge label={{ text: 'JSON bir marta tuzatildi', glyph: '⚒', className: 'badge-moderate' }} />
              ) : null}
            </div>
            <p className="muted-text" style={{ marginTop: 8, marginBottom: 0 }}>
              {describeUsage(extraction.usage)} · prompt {extraction.usage.prompt_version} · sxema{' '}
              {extraction.usage.schema_version} · {extraction.chunk_count} bo‘lak ·{' '}
              {extraction.page_selection.length > 0 ? `sahifalar: ${extraction.page_selection.join(', ')}` : 'barcha sahifalar'}
            </p>
          </div>

          {extraction.status === 'MANUAL_REQUIRED' ? (
            <Notice kind="warn">
              <strong>AI natijasi olinmadi: {extraction.error_message}</strong>
              <div className="muted-text mono">kod: {extraction.error_code}</div>
              <p style={{ marginTop: 8, marginBottom: 0 }}>
                Uydirma natija yaratilmaydi. Faktlarni qo‘lda kiriting yoki qayta urinib ko‘ring. Tasdiqlangan profil
                bilan qoidalar moduli ishlashda davom etadi.
              </p>
              <div className="actions" style={{ marginTop: 8 }}>
                <button type="button" onClick={() => void runExtraction('live', true)} disabled={busy}>
                  Qayta urinish
                </button>
                <button type="button" className="secondary" onClick={() => void runExtraction('recorded_demo', true)} disabled={busy}>
                  Yozib olingan demo rejimi
                </button>
              </div>
            </Notice>
          ) : null}

          {extraction.warnings.length > 0 ? (
            <Notice kind="warn">
              <strong>Ogohlantirishlar</strong>
              <ul className="list-reset">
                {extraction.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </Notice>
          ) : null}

          <div className="grid-side">
            <section className="card">
              <h2>Manba matni</h2>
              <p className="muted-text">{extraction.document?.filename}</p>
              <div className="source-pane" tabIndex={0} aria-label="Hujjatning asl matni">
                {extraction.document?.text ?? '—'}
              </div>
              <p className="muted-text">
                Hujjat matni ishonchsiz kirish hisoblanadi. Undagi ko‘rsatmalar bajarilmaydi va matn oddiy matn
                sifatida ko‘rsatiladi.
              </p>
            </section>

            <section className="card">
              <h2>Ajratilgan maydonlar ({extraction.candidates.length})</h2>
              <p className="muted-text">
                Hech bir qiymat siz “Tasdiqlash”ni bosmaguningizcha klinik tahlilda ishlatilmaydi.
              </p>

              <div className="field" style={{ maxWidth: 360 }}>
                <label htmlFor="allergy">Allergiya holati (siz tasdiqlaysiz)</label>
                <select id="allergy" value={allergyStatus} onChange={(e) => setAllergyStatus(e.target.value as AllergyStatus)}>
                  <option value="UNKNOWN">Noma’lum — allergiya tekshiruvi bajarilmaydi</option>
                  <option value="KNOWN_NONE">Allergiya yo‘qligi tasdiqlangan</option>
                  <option value="PRESENT">Allergiya bor</option>
                </select>
              </div>

              {extraction.candidates.map((candidate) => {
                const d = decisions[candidate.index];
                if (!d) return null;
                const blocked = candidate.blocked_reason != null;
                return (
                  <div
                    key={candidate.index}
                    className={`candidate ${blocked ? 'blocked' : ''} ${d.action === 'reject' ? 'rejected' : ''}`}
                  >
                    <div className="actions" style={{ justifyContent: 'space-between' }}>
                      <strong>
                        {candidate.kind} · <span className="mono">{candidate.code}</span>
                      </strong>
                      <div className="actions">
                        {candidate.source_quote_verified ? (
                          <Badge label={{ text: 'Manba tasdiqlandi', glyph: '✓', className: 'badge-ok' }} />
                        ) : (
                          <Badge label={{ text: 'Manba topilmadi', glyph: '✕', className: 'badge-high' }} />
                        )}
                        {candidate.medication_match ? (
                          <Badge
                            label={{
                              text:
                                candidate.medication_match.status === 'exact'
                                  ? 'Katalogda aniq moslik'
                                  : candidate.medication_match.status === 'ambiguous'
                                    ? 'Bir nechta moslik — tanlang'
                                    : 'Katalogda yo‘q',
                              glyph: candidate.medication_match.status === 'exact' ? '✓' : '?',
                              className:
                                candidate.medication_match.status === 'exact' ? 'badge-ok' : 'badge-moderate',
                            }}
                          />
                        ) : null}
                      </div>
                    </div>

                    <blockquote className="quote">
                      “{candidate.source_quote}”
                      {candidate.source_page ? <span className="muted-text"> · {candidate.source_page}-sahifa</span> : null}
                    </blockquote>

                    {blocked ? (
                      <Notice kind="error">
                        {candidate.blocked_reason === 'SOURCE_QUOTE_NOT_FOUND'
                          ? 'Bu faktning manba parchasi hujjat matnida topilmadi — fakt ishonchli deb qabul qilinmaydi va tasdiqlab bo‘lmaydi. Qiymatni qo‘lda kiriting.'
                          : 'Dori nomi bir nechta faol moddaga mos keldi. Quyidan aniq moddani tanlang.'}
                      </Notice>
                    ) : null}

                    {candidate.unit_conversion_note ? (
                      <p className="muted-text">{candidate.unit_conversion_note}</p>
                    ) : null}

                    <div className="field-row">
                      {candidate.kind === 'observation' ? (
                        <>
                          <div className="field">
                            <label htmlFor={`v-${candidate.index}`}>Qiymat</label>
                            <input
                              id={`v-${candidate.index}`}
                              type="number"
                              step="any"
                              value={d.normalized_value}
                              onChange={(e) => update(candidate.index, { normalized_value: e.target.value })}
                            />
                          </div>
                          <div className="field">
                            <label htmlFor={`u-${candidate.index}`}>Birlik</label>
                            <input
                              id={`u-${candidate.index}`}
                              type="text"
                              value={d.unit}
                              onChange={(e) => update(candidate.index, { unit: e.target.value })}
                            />
                          </div>
                          <div className="field">
                            <label htmlFor={`d-${candidate.index}`}>Sana</label>
                            <input
                              id={`d-${candidate.index}`}
                              type="date"
                              value={d.observed_at}
                              onChange={(e) => update(candidate.index, { observed_at: e.target.value })}
                            />
                          </div>
                        </>
                      ) : null}

                      {candidate.kind === 'medication' ? (
                        <>
                          <div className="field">
                            <label htmlFor={`m-${candidate.index}`}>Faol modda</label>
                            <select
                              id={`m-${candidate.index}`}
                              value={d.ingredient_code}
                              onChange={(e) => update(candidate.index, { ingredient_code: e.target.value })}
                            >
                              <option value="">— tanlanmagan —</option>
                              {(candidate.medication_match?.candidates ?? []).map((c) => (
                                <option key={c.ingredient_code} value={c.ingredient_code}>
                                  {c.ingredient_name} ({c.ingredient_code})
                                </option>
                              ))}
                            </select>
                          </div>
                          <div className="field">
                            <label htmlFor={`a-${candidate.index}`}>Hozir qabul qilinyaptimi?</label>
                            <select
                              id={`a-${candidate.index}`}
                              value={d.active ? 'yes' : 'no'}
                              onChange={(e) => update(candidate.index, { active: e.target.value === 'yes' })}
                            >
                              <option value="yes">Ha — faol dori</option>
                              <option value="no">Yo‘q — to‘xtatilgan</option>
                            </select>
                            <span className="muted-text">
                              Hujjatdagi holat: {candidate.medication_status ?? 'ko‘rsatilmagan'}
                            </span>
                          </div>
                        </>
                      ) : null}

                      {candidate.kind === 'condition' || candidate.kind === 'allergy' ? (
                        <div className="field">
                          <label htmlFor={`c-${candidate.index}`}>Kod / nom</label>
                          <input
                            id={`c-${candidate.index}`}
                            type="text"
                            value={d.code}
                            onChange={(e) => update(candidate.index, { code: e.target.value })}
                          />
                        </div>
                      ) : null}
                    </div>

                    <fieldset style={{ border: 'none', padding: 0, margin: 0 }}>
                      <legend className="muted-text" style={{ padding: 0 }}>
                        Qaror
                      </legend>
                      <div className="actions">
                        <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center', fontWeight: 400 }}>
                          <input
                            type="radio"
                            name={`decision-${candidate.index}`}
                            checked={d.action === 'confirm'}
                            disabled={blocked}
                            onChange={() => update(candidate.index, { action: 'confirm' })}
                          />
                          Tasdiqlash
                        </label>
                        <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center', fontWeight: 400 }}>
                          <input
                            type="radio"
                            name={`decision-${candidate.index}`}
                            checked={d.action === 'reject'}
                            onChange={() => update(candidate.index, { action: 'reject' })}
                          />
                          Rad etish
                        </label>
                      </div>
                    </fieldset>
                  </div>
                );
              })}

              {extraction.candidates.length > 0 ? (
                <div className="actions">
                  <button type="button" onClick={confirmAll} disabled={busy || done != null}>
                    {busy ? 'Saqlanmoqda…' : 'Tasdiqlash va profil reviziyasini yaratish'}
                  </button>
                </div>
              ) : (
                <p className="muted-text">Ajratilgan maydon yo‘q. Faktlarni qo‘lda kiriting.</p>
              )}
            </section>
          </div>
        </>
      ) : null}
    </AppShell>
  );
}
