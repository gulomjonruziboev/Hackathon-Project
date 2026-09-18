'use client';

import { Badge } from './ui';
import { REVIEW_STATUS_LABEL, SEVERITY_LABEL, formatDate } from '@/lib/format';
import type { Finding } from '@/lib/types';

/**
 * UI-06: every finding shows the reason, the facts it used, the clinical source
 * and the review it still needs. Severity and missing data stay separate ideas.
 */
export function FindingCard({ finding }: { finding: Finding }) {
  const why = finding.why;
  return (
    <article className={`finding finding-${finding.severity}`}>
      <div className="finding-head">
        <Badge label={SEVERITY_LABEL[finding.severity]} />
        <Badge label={REVIEW_STATUS_LABEL[finding.review_status] ?? REVIEW_STATUS_LABEL.draft!} />
        <span className="mono muted-text">{finding.grouped_rule_ids.join(' + ')}</span>
      </div>

      <p style={{ marginBottom: 4 }}>{finding.message}</p>

      <details className="why">
        <summary>Nega?</summary>
        <div className="why-body">
          <dl>
            <dt>Qoida</dt>
            <dd className="mono">
              {finding.rule_id} · v{finding.rule_version} · {finding.category}
            </dd>

            <dt>Ishlatilgan faktlar</dt>
            <dd>
              {why.used_facts.length === 0 ? (
                <span className="muted-text">Bu qoida sonli fakt ishlatmadi — faqat reja tarkibini tekshirdi.</span>
              ) : (
                <ul className="list-reset">
                  {why.used_facts.map((f) => (
                    <li key={`${f.code}-${f.fact_id}`}>
                      <span className="mono">{f.code}</span> = {f.value ?? '—'} ({formatDate(f.observed_at)})
                    </li>
                  ))}
                </ul>
              )}
            </dd>

            <dt>Qoida parametrlari</dt>
            <dd>
              {Object.keys(why.rule_params).length === 0 ? (
                <span className="muted-text">Threshold ishlatilmagan (mexanik tekshiruv).</span>
              ) : (
                <ul className="list-reset">
                  {Object.entries(why.rule_params).map(([key, value]) => (
                    <li key={key}>
                      <span className="mono">{key}</span> = {String(value)}
                    </li>
                  ))}
                </ul>
              )}
            </dd>

            <dt>Klinik manba</dt>
            <dd>
              {why.evidence.length === 0 ? (
                <span className="muted-text">Manba ko‘rsatilmagan.</span>
              ) : (
                <ul className="list-reset">
                  {why.evidence.map((e) => (
                    <li key={e.evidence_id}>
                      {e.url ? (
                        <a href={e.url} target="_blank" rel="noreferrer noopener">
                          {e.title}
                        </a>
                      ) : (
                        e.title
                      )}
                      {e.section ? ` · ${e.section}` : ''}{' '}
                      <span className="muted-text">
                        ({e.verification_status === 'verified' ? 'tekshirilgan' : 'tekshirilmagan'})
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </dd>

            <dt>Threshold manbasi</dt>
            <dd>
              {why.threshold_origin === 'mechanical'
                ? 'Mexanik tekshiruv — klinik threshold yo‘q.'
                : why.threshold_origin === 'source_verified'
                  ? 'Manbadan tekshirilgan.'
                  : 'Manbadan tasdiqlanmagan — yoqishdan oldin tekshirilishi kerak.'}
            </dd>

            <dt>Zarur qayta ko‘rib chiqish</dt>
            <dd>{why.required_review}</dd>

            {finding.clinical_note ? (
              <>
                <dt>Izoh</dt>
                <dd>{finding.clinical_note}</dd>
              </>
            ) : null}
          </dl>
        </div>
      </details>
    </article>
  );
}
