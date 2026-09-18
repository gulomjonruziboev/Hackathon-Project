'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { AnalysisPanel } from '@/components/AnalysisPanel';
import { AppShell } from '@/components/AppShell';
import { Badge, ErrorNotice, Loading, Notice, SyntheticBanner } from '@/components/ui';
import { api, ApiError, idempotencyKey } from '@/lib/api';
import { SEVERITY_LABEL } from '@/lib/format';
import type {
  Analysis,
  Comparison,
  Medication,
  PatientProfile,
  Scenario,
  ScenarioAction,
} from '@/lib/types';

type Draft = {
  ingredientCode: string;
  doseValue: string;
  doseUnit: string;
  route: string;
  frequency: string;
  durationDays: string;
};

const EMPTY_DRAFT: Draft = { ingredientCode: '', doseValue: '', doseUnit: '', route: '', frequency: '', durationDays: '' };

type Slot = 'A' | 'B';

export default function ScenariosPage() {
  const params = useParams<{ id: string }>();
  const patientId = params.id;

  const [profile, setProfile] = useState<PatientProfile | null>(null);
  const [catalog, setCatalog] = useState<Medication[]>([]);
  const [scenarios, setScenarios] = useState<Record<Slot, Scenario | null>>({ A: null, B: null });
  const [analyses, setAnalyses] = useState<Record<Slot, Analysis | null>>({ A: null, B: null });
  const [drafts, setDrafts] = useState<Record<Slot, Draft>>({ A: { ...EMPTY_DRAFT }, B: { ...EMPTY_DRAFT } });
  const [stops, setStops] = useState<Record<Slot, string[]>>({ A: [], B: [] });
  const [comparison, setComparison] = useState<Comparison | null>(null);
  const [decisionReason, setDecisionReason] = useState('');
  const [decisionSaved, setDecisionSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ code: string; message: string; requestId?: string | null } | null>(null);

  const load = useCallback(async () => {
    try {
      const [p, meds] = await Promise.all([
        api.get<PatientProfile>(`/patients/${patientId}`),
        api.get<{ items: Medication[] }>('/medications'),
      ]);
      setProfile(p);
      setCatalog(meds.items);
    } catch (err) {
      if (err instanceof ApiError && err.status !== 401) {
        setError({ code: err.code, message: err.message, requestId: err.requestId });
      }
    }
  }, [patientId]);

  useEffect(() => {
    void load();
  }, [load]);

  function handleError(err: unknown) {
    if (err instanceof ApiError) {
      const detail = err.fieldErrors.length > 0 ? ` (${err.fieldErrors.map((f) => f.message).join('; ')})` : '';
      setError({ code: err.code, message: err.message + detail, requestId: err.requestId });
    } else {
      setError({ code: 'NETWORK', message: 'Serverga ulanib bo‘lmadi.' });
    }
  }

  function buildActions(slot: Slot): ScenarioAction[] {
    const actions: ScenarioAction[] = stops[slot].map((id) => ({ type: 'stop', medication_statement_id: id }));
    const draft = drafts[slot];
    if (draft.ingredientCode) {
      actions.push({
        type: 'add',
        ingredient_code: draft.ingredientCode,
        dose_value: draft.doseValue === '' ? null : Number(draft.doseValue),
        dose_unit: draft.doseUnit === '' ? null : draft.doseUnit,
        route: draft.route === '' ? null : draft.route,
        frequency_per_day: draft.frequency === '' ? null : Number(draft.frequency),
        duration_days: draft.durationDays === '' ? null : Number(draft.durationDays),
      });
    }
    return actions;
  }

  async function saveScenario(slot: Slot) {
    if (!profile?.profile_revision) return;
    setBusy(true);
    setError(null);
    setComparison(null);
    try {
      const actions = buildActions(slot);
      const existing = scenarios[slot];
      const scenario = existing
        ? await api.patch<Scenario>(`/scenarios/${existing.id}`, { expected_version: existing.version, actions })
        : await api.post<Scenario>(`/patients/${patientId}/scenarios`, {
            label: slot,
            profile_revision_id: profile.profile_revision.id,
            actions,
            derived_from_scenario_id: slot === 'B' ? (scenarios.A?.id ?? null) : null,
          });
      setScenarios((prev) => ({ ...prev, [slot]: scenario }));
      // The stored analysis is now stale by definition; clear the stale view.
      setAnalyses((prev) => ({ ...prev, [slot]: null }));
    } catch (err) {
      handleError(err);
    } finally {
      setBusy(false);
    }
  }

  async function analyze(slot: Slot) {
    const scenario = scenarios[slot];
    if (!scenario) return;
    setBusy(true);
    setError(null);
    try {
      const analysis = await api.post<Analysis>(`/scenarios/${scenario.id}/analyze`, {}, idempotencyKey(`analyze-${slot}`));
      setAnalyses((prev) => ({ ...prev, [slot]: analysis }));
    } catch (err) {
      handleError(err);
    } finally {
      setBusy(false);
    }
  }

  /** UF-03.1: B starts as a copy of A, then the doctor changes what they need. */
  function copyAtoB() {
    setDrafts((prev) => ({ ...prev, B: { ...prev.A } }));
    setStops((prev) => ({ ...prev, B: [...prev.A] }));
  }

  async function compare() {
    if (!analyses.A || !analyses.B) return;
    setBusy(true);
    setError(null);
    try {
      setComparison(
        await api.post<Comparison>('/comparisons', { analysis_a_id: analyses.A.id, analysis_b_id: analyses.B.id }),
      );
    } catch (err) {
      handleError(err);
      setComparison(null);
    } finally {
      setBusy(false);
    }
  }

  async function saveDecision(action: 'accept_a' | 'accept_b' | 'reject_all') {
    const analysis = action === 'accept_b' ? analyses.B : analyses.A;
    if (!analysis) return;
    if (decisionReason.trim() === '') {
      setError({ code: 'REASON_REQUIRED', message: 'Qaror uchun qisqa izoh kiriting.' });
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.post(
        '/decisions',
        {
          analysis_id: analysis.id,
          action,
          selected_scenario_id: action === 'reject_all' ? null : (action === 'accept_b' ? scenarios.B?.id : scenarios.A?.id) ?? null,
          reason: decisionReason,
        },
        idempotencyKey('decision'),
      );
      setDecisionSaved('Qaror auditga saqlandi.');
    } catch (err) {
      handleError(err);
    } finally {
      setBusy(false);
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

  if (!profile.profile_revision) {
    return (
      <AppShell>
        <h1>Retseptni tekshirish</h1>
        <SyntheticBanner />
        <Notice kind="warn">
          Bu bemorda tasdiqlangan profil reviziyasi yo‘q. Avval hujjat yuklab, faktlarni tasdiqlang yoki qo‘lda
          kiriting. <Link href={`/patients/${patientId}`}>Profilga o‘tish</Link>
        </Notice>
      </AppShell>
    );
  }

  const activeMeds = profile.medications.filter((m) => m.status === 'active');

  return (
    <AppShell>
      <h1>
        Retsept ssenariylari · {profile.synthetic_code}
      </h1>
      <p className="muted-text">
        Ikkala variant bir xil profil reviziyasi (#{profile.profile_revision.revision_no}) va bir xil qoidalar
        versiyasida hisoblanadi.
      </p>
      <SyntheticBanner />
      <ErrorNotice error={error} />

      <div className="grid-2">
        {(['A', 'B'] as Slot[]).map((slot) => (
          <section className="card" key={slot}>
            <div className="actions" style={{ justifyContent: 'space-between' }}>
              <h2 style={{ margin: 0 }}>{slot} ssenariy</h2>
              {slot === 'B' ? (
                <button type="button" className="secondary" onClick={copyAtoB}>
                  A dan nusxa olish
                </button>
              ) : null}
            </div>

            <h3>Joriy rejadan to‘xtatish</h3>
            {activeMeds.length === 0 ? (
              <p className="muted-text">Faol dori yo‘q.</p>
            ) : (
              <ul className="list-reset">
                {activeMeds.map((m) => (
                  <li key={m.statement_id}>
                    <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center', fontWeight: 400 }}>
                      <input
                        type="checkbox"
                        checked={stops[slot].includes(m.statement_id)}
                        onChange={(e) =>
                          setStops((prev) => ({
                            ...prev,
                            [slot]: e.target.checked
                              ? [...prev[slot], m.statement_id]
                              : prev[slot].filter((id) => id !== m.statement_id),
                          }))
                        }
                      />
                      {m.ingredient_name}
                    </label>
                  </li>
                ))}
              </ul>
            )}

            <h3>Yangi dori qo‘shish</h3>
            <div className="field">
              <label htmlFor={`ing-${slot}`}>Faol modda (katalogdan)</label>
              <select
                id={`ing-${slot}`}
                value={drafts[slot].ingredientCode}
                onChange={(e) => setDrafts((prev) => ({ ...prev, [slot]: { ...prev[slot], ingredientCode: e.target.value } }))}
              >
                <option value="">— qo‘shilmaydi —</option>
                {catalog.map((m) => (
                  <option key={m.ingredient_code} value={m.ingredient_code}>
                    {m.ingredient_name} ({m.aliases.slice(0, 2).join(', ')})
                  </option>
                ))}
              </select>
              <span className="muted-text">
                Katalogda bo‘lmagan dori taxminan moslashtirilmaydi.
              </span>
            </div>

            <div className="field-row">
              <div className="field">
                <label htmlFor={`dv-${slot}`}>Doza</label>
                <input
                  id={`dv-${slot}`}
                  type="number"
                  step="any"
                  value={drafts[slot].doseValue}
                  onChange={(e) => setDrafts((prev) => ({ ...prev, [slot]: { ...prev[slot], doseValue: e.target.value } }))}
                />
              </div>
              <div className="field">
                <label htmlFor={`du-${slot}`}>Birlik</label>
                <select
                  id={`du-${slot}`}
                  value={drafts[slot].doseUnit}
                  onChange={(e) => setDrafts((prev) => ({ ...prev, [slot]: { ...prev[slot], doseUnit: e.target.value } }))}
                >
                  <option value="">—</option>
                  {(catalog.find((m) => m.ingredient_code === drafts[slot].ingredientCode)?.allowed_units ?? []).map((u) => (
                    <option key={u} value={u}>
                      {u}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor={`ro-${slot}`}>Yo‘l</label>
                <select
                  id={`ro-${slot}`}
                  value={drafts[slot].route}
                  onChange={(e) => setDrafts((prev) => ({ ...prev, [slot]: { ...prev[slot], route: e.target.value } }))}
                >
                  <option value="">—</option>
                  {(catalog.find((m) => m.ingredient_code === drafts[slot].ingredientCode)?.routes ?? []).map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor={`fr-${slot}`}>Kuniga necha marta</label>
                <input
                  id={`fr-${slot}`}
                  type="number"
                  min={1}
                  value={drafts[slot].frequency}
                  onChange={(e) => setDrafts((prev) => ({ ...prev, [slot]: { ...prev[slot], frequency: e.target.value } }))}
                />
              </div>
              <div className="field">
                <label htmlFor={`dd-${slot}`}>Davomiylik (kun)</label>
                <input
                  id={`dd-${slot}`}
                  type="number"
                  min={1}
                  value={drafts[slot].durationDays}
                  onChange={(e) => setDrafts((prev) => ({ ...prev, [slot]: { ...prev[slot], durationDays: e.target.value } }))}
                />
              </div>
            </div>

            <div className="actions">
              <button type="button" className="secondary" onClick={() => void saveScenario(slot)} disabled={busy}>
                {scenarios[slot] ? 'Ssenariyni yangilash' : 'Ssenariyni saqlash'}
              </button>
              <button type="button" onClick={() => void analyze(slot)} disabled={busy || !scenarios[slot]}>
                Tahlil qilish
              </button>
              {scenarios[slot] ? (
                <span className="muted-text mono">v{scenarios[slot]!.version}</span>
              ) : null}
            </div>

            {scenarios[slot] ? (
              <>
                <h3>Yakuniy reja</h3>
                <table>
                  <thead>
                    <tr>
                      <th scope="col">Faol modda</th>
                      <th scope="col">Doza</th>
                      <th scope="col">Manba</th>
                    </tr>
                  </thead>
                  <tbody>
                    {scenarios[slot]!.final_regimen.map((item, i) => (
                      <tr key={`${item.ingredient_code}-${i}`}>
                        <td>{item.ingredient_name}</td>
                        <td>
                          {item.dose_value ?? '—'} {item.dose_unit ?? ''}
                          {item.frequency_per_day ? ` · kuniga ${item.frequency_per_day}` : ''}
                        </td>
                        <td>
                          <Badge
                            label={{
                              text:
                                item.origin === 'added' ? 'qo‘shildi' : item.origin === 'modified' ? 'o‘zgartirildi' : 'joriy',
                              glyph: item.origin === 'existing' ? '•' : '+',
                              className: item.origin === 'existing' ? 'badge-neutral' : 'badge-review',
                            }}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            ) : null}

            {analyses[slot] ? (
              <>
                <h3>Natija</h3>
                <AnalysisPanel analysis={analyses[slot]!} />
              </>
            ) : null}
          </section>
        ))}
      </div>

      <section className="card">
        <h2>A/B taqqoslash</h2>
        <div className="actions">
          <button type="button" onClick={compare} disabled={busy || !analyses.A || !analyses.B}>
            Taqqoslash
          </button>
          {!analyses.A || !analyses.B ? (
            <span className="muted-text">Taqqoslash uchun ikkala ssenariyni ham tahlil qiling.</span>
          ) : null}
        </div>

        {comparison ? (
          <>
            <p className="muted-text">{comparison.ranking_note}</p>
            <table>
              <thead>
                <tr>
                  <th scope="col">Og‘irlik</th>
                  <th scope="col">Topilma</th>
                  <th scope="col">A</th>
                  <th scope="col">B</th>
                  <th scope="col">Qoidalar</th>
                </tr>
              </thead>
              <tbody>
                {[...comparison.findings_diff, ...comparison.illustrative_diff].map((row) => (
                  <tr key={row.key}>
                    <td>
                      <Badge label={SEVERITY_LABEL[row.severity]} />
                    </td>
                    <td>{row.message}</td>
                    <td>{row.in_a ? '✓' : '—'}</td>
                    <td>{row.in_b ? '✓' : '—'}</td>
                    <td className="mono muted-text">{row.rule_ids.join(', ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="muted-text">
              Baholangan qoidalar: A={comparison.coverage_diff.evaluated_count[0]}, B=
              {comparison.coverage_diff.evaluated_count[1]} · baholanmagan: A=
              {comparison.coverage_diff.not_evaluable_count[0]}, B={comparison.coverage_diff.not_evaluable_count[1]}
            </p>
          </>
        ) : null}
      </section>

      <section className="card">
        <h2>Qaror</h2>
        <div className="field">
          <label htmlFor="reason">Qisqa izoh (majburiy)</label>
          <textarea
            id="reason"
            value={decisionReason}
            onChange={(e) => setDecisionReason(e.target.value)}
            placeholder="Nega shu variant tanlandi yoki nega hech biri qabul qilinmadi?"
          />
        </div>
        <div className="actions">
          <button type="button" onClick={() => void saveDecision('accept_a')} disabled={busy || !analyses.A}>
            A ni tanlash
          </button>
          <button type="button" onClick={() => void saveDecision('accept_b')} disabled={busy || !analyses.B}>
            B ni tanlash
          </button>
          <button type="button" className="danger" onClick={() => void saveDecision('reject_all')} disabled={busy || !analyses.A}>
            Hech birini qabul qilmaslik
          </button>
        </div>
        {decisionSaved ? <Notice kind="ok">{decisionSaved}</Notice> : null}
        <p className="muted-text">
          TwinRx variantlarni avtomatik reytinglamaydi. Qaror va izoh audit jurnaliga yoziladi.
        </p>
      </section>
    </AppShell>
  );
}
