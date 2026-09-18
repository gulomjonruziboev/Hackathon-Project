'use client';

import { useEffect, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { Badge, ErrorNotice, Loading, Notice, SyntheticBanner } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import type { Capabilities } from '@/lib/types';

/**
 * UI-07 and the honesty requirement in general: everything the demo has NOT
 * done is stated here, so nothing unfinished can be presented as working.
 */
export default function SystemPage() {
  const [caps, setCaps] = useState<Capabilities | null>(null);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await api.get<Capabilities>('/system/capabilities');
        if (!cancelled) setCaps(res);
      } catch (err) {
        if (err instanceof ApiError && err.status !== 401) setError({ code: err.code, message: err.message });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!caps) {
    return (
      <AppShell>
        <ErrorNotice error={error} />
        {!error ? <Loading what="Tizim holati" /> : null}
      </AppShell>
    );
  }

  return (
    <AppShell>
      <h1>Tizim holati va chegaralar</h1>
      <SyntheticBanner />

      <div className="grid-2">
        <section className="card">
          <h2>Qoidalar to‘plami</h2>
          <table>
            <tbody>
              <tr>
                <th scope="row">Versiya</th>
                <td className="mono">{caps.ruleset.version}</td>
              </tr>
              <tr>
                <th scope="row">Checksum</th>
                <td className="mono">{caps.ruleset.checksum.slice(0, 16)}…</td>
              </tr>
              <tr>
                <th scope="row">Release holati</th>
                <td>{caps.ruleset.release_status}</td>
              </tr>
              <tr>
                <th scope="row">Yoqilgan qoidalar</th>
                <td>{caps.ruleset.enabled_rule_count}</td>
              </tr>
              <tr>
                <th scope="row">Klinik ko‘rikdan o‘tgan</th>
                <td>{caps.ruleset.reviewed_rule_count}</td>
              </tr>
              <tr>
                <th scope="row">Illyustrativ</th>
                <td>{caps.ruleset.illustrative_rule_count}</td>
              </tr>
              <tr>
                <th scope="row">Ko‘rib chiqilgan sana / kim</th>
                <td>
                  {caps.ruleset.reviewed_at ?? '—'} / {caps.ruleset.reviewed_by ?? '—'}
                </td>
              </tr>
            </tbody>
          </table>
          {caps.ruleset.reviewed_rule_count === 0 ? (
            <Notice kind="warn">
              Hozircha hech bir qoida klinik maslahatchi tomonidan ko‘rib chiqilmagan. Shu sababli klinik topilmalar
              to‘plami bo‘sh bo‘ladi va barcha topilmalar illyustrativ deb belgilanadi.
            </Notice>
          ) : null}
        </section>

        <section className="card">
          <h2>AI konfiguratsiyasi</h2>
          <table>
            <tbody>
              <tr>
                <th scope="row">Provayder</th>
                <td className="mono">{caps.ai.provider}</td>
              </tr>
              <tr>
                <th scope="row">Model</th>
                <td className="mono">{caps.ai.model_id}</td>
              </tr>
              <tr>
                <th scope="row">Sozlangan</th>
                <td>
                  <Badge
                    label={
                      caps.ai.configured
                        ? { text: 'Kalit mavjud', glyph: '✓', className: 'badge-ok' }
                        : { text: 'Kalit yo‘q — qo‘lda kiritish', glyph: '⚠', className: 'badge-moderate' }
                    }
                  />
                </td>
              </tr>
              <tr>
                <th scope="row">Prompt / sxema / parser</th>
                <td className="mono">
                  {caps.ai.prompt_version} · {caps.ai.schema_version} · {caps.ai.parser_version}
                </td>
              </tr>
              <tr>
                <th scope="row">Deadline</th>
                <td>{caps.ai.timeout_seconds} soniya</td>
              </tr>
              <tr>
                <th scope="row">Parallel extraction</th>
                <td>
                  {caps.ai.in_flight} / {caps.ai.max_concurrency}
                </td>
              </tr>
              <tr>
                <th scope="row">Lokal zaxira (Ollama)</th>
                <td>{caps.ai.local_fallback_enabled ? 'yoqilgan' : 'o‘chirilgan'}</td>
              </tr>
              <tr>
                <th scope="row">Pullik provayder</th>
                <td>{caps.ai.allow_paid_providers ? 'ruxsat etilgan' : 'taqiqlangan'}</td>
              </tr>
              <tr>
                <th scope="row">Haqiqiy bemor ma’lumoti</th>
                <td>{caps.ai.allow_real_patient_data ? 'ruxsat etilgan' : 'bloklangan'}</td>
              </tr>
            </tbody>
          </table>
        </section>
      </div>

      <div className="grid-2">
        <section className="card">
          <h2>Qamrov</h2>
          <p>
            <strong>Qo‘llab-quvvatlanadigan o‘lchovlar:</strong> {caps.dimensions.supported.join(', ')}
          </p>
          <p>
            <strong>Baholanmaydigan o‘lchovlar:</strong> {caps.dimensions.unsupported.join(', ')}
          </p>
          <p className="muted-text">
            Katalogda {caps.catalog.medication_count} ta faol modda ({caps.catalog.version}). Katalogda dori borligi
            uning barcha xavflari tekshirilishini anglatmaydi.
          </p>
          <p className="muted-text">
            Dalil manbalari: {caps.evidence.version} · tekshirilmagan manbalar: {caps.evidence.pending_review_count}
          </p>
        </section>

        <section className="card">
          <h2>Modullar</h2>
          <table>
            <thead>
              <tr>
                <th scope="col">Modul</th>
                <th scope="col">Holat</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(caps.modules).map(([name, mod]) => (
                <tr key={name}>
                  <td className="mono">{name.toUpperCase()}</td>
                  <td>
                    <Badge
                      label={
                        mod.enabled
                          ? { text: 'Yoqilgan', glyph: '✓', className: 'badge-ok' }
                          : { text: 'Hali yoqilmagan', glyph: '○', className: 'badge-neutral' }
                      }
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <Notice kind="warn">
            5 yillik prognoz (KFRE) moduli yoqilmagan. Formula, koeffitsiyentlar, birliklar va qo‘llanish chegarasi
            tekshirilmaguncha prognoz ko‘rsatilmaydi — tasodifiy foiz yoki bezak grafigi chiqarilmaydi.
          </Notice>
        </section>
      </div>
    </AppShell>
  );
}
