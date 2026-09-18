'use client';

import { FindingCard } from './FindingCard';
import { Badge, Notice } from './ui';
import { ANALYSIS_STATUS_LABEL, MISSING_REASON_LABEL, RULE_STATUS_LABEL, formatDateTime } from '@/lib/format';
import type { Analysis } from '@/lib/types';

export function AnalysisPanel({ analysis }: { analysis: Analysis }) {
  const status = ANALYSIS_STATUS_LABEL[analysis.status] ?? ANALYSIS_STATUS_LABEL.FAILED!;

  return (
    <div>
      <div className="actions" style={{ marginBottom: 8 }}>
        <Badge label={status} />
        {analysis.stale ? (
          <Badge label={{ text: 'Natija eskirgan — qayta hisoblang', glyph: '↻', className: 'badge-high' }} />
        ) : null}
        <span className="muted-text mono">
          {analysis.ruleset_version} · profil {analysis.profile_revision_id.slice(0, 8)} · {formatDateTime(analysis.created_at)}
        </span>
      </div>

      {analysis.status === 'BLOCKED' ? (
        <Notice kind="error">
          Tahlil bajarilmadi: tasdiqlangan profil yoki qo‘llab-quvvatlanadigan reja yo‘q.
          {analysis.error_code ? <span className="mono"> ({analysis.error_code})</span> : null}
        </Notice>
      ) : null}

      <h3>Klinik topilmalar</h3>
      {analysis.findings.length === 0 ? (
        <Notice kind={analysis.empty_state_text ? 'warn' : 'ok'}>
          {analysis.empty_state_text ?? analysis.no_finding_text}
        </Notice>
      ) : (
        analysis.findings.map((f) => <FindingCard key={f.id} finding={f} />)
      )}

      {analysis.illustrative_findings.length > 0 ? (
        <>
          <h3>Illyustrativ topilmalar ({analysis.illustrative_findings.length})</h3>
          <Notice kind="warn">
            Bu topilmalar klinik maslahatchi ko‘rib chiqmagan qoidalardan olingan. Ular mexanikani ko‘rsatadi va
            klinik natijalar to‘plamiga kirmaydi.
          </Notice>
          {analysis.illustrative_findings.map((f) => (
            <FindingCard key={f.id} finding={f} />
          ))}
        </>
      ) : null}

      <h3>Tekshiruv qamrovi</h3>
      <table>
        <tbody>
          <tr>
            <th scope="row">Baholangan qoidalar</th>
            <td>{analysis.coverage.evaluated_count}</td>
          </tr>
          <tr>
            <th scope="row">Baholab bo‘lmagan qoidalar</th>
            <td>{analysis.coverage.not_evaluable_count}</td>
          </tr>
          <tr>
            <th scope="row">Taalluqli bo‘lmagan qoidalar</th>
            <td>{analysis.coverage.not_applicable_count}</td>
          </tr>
          <tr>
            <th scope="row">Xato bergan qoidalar</th>
            <td>{analysis.coverage.error_count}</td>
          </tr>
          <tr>
            <th scope="row">Baholanmagan o‘lchovlar</th>
            <td>{analysis.coverage.unevaluated_dimensions.join(', ') || '—'}</td>
          </tr>
          <tr>
            <th scope="row">Qo‘llab-quvvatlanmagan dorilar</th>
            <td>{analysis.coverage.unsupported_medication_ids.join(', ') || '—'}</td>
          </tr>
        </tbody>
      </table>
      <p className="muted-text">
        Bu raqamlar xavfsizlik foizi emas. Topilmalar sonidan umumiy “xavf darajasi” hisoblanmaydi.
      </p>

      {analysis.missing_data.length > 0 ? (
        <>
          <h3>Yetishmayotgan ma’lumot</h3>
          <ul className="list-reset">
            {analysis.missing_data.map((m) => (
              <li key={m.field}>
                <span className="mono">{m.field}</span> — {MISSING_REASON_LABEL[m.reason] ?? m.reason}
              </li>
            ))}
          </ul>
        </>
      ) : null}

      <details style={{ marginTop: 12 }}>
        <summary style={{ cursor: 'pointer', fontWeight: 600 }}>
          Har bir qoida bo‘yicha natija ({analysis.rule_evaluations.length})
        </summary>
        <table style={{ marginTop: 8 }}>
          <thead>
            <tr>
              <th scope="col">Qoida</th>
              <th scope="col">O‘lchov</th>
              <th scope="col">Holat</th>
              <th scope="col">Sabab / yetishmayotgan</th>
            </tr>
          </thead>
          <tbody>
            {analysis.rule_evaluations.map((e) => (
              <tr key={e.rule_id}>
                <td className="mono">{e.rule_id}</td>
                <td>{e.dimension}</td>
                <td>
                  <Badge label={RULE_STATUS_LABEL[e.status] ?? RULE_STATUS_LABEL.ERROR!} />
                </td>
                <td className="muted-text">
                  {e.reason ?? '—'}
                  {e.missing_fields.length > 0 ? ` · ${e.missing_fields.join(', ')}` : ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>

      <p className="muted-text" style={{ marginTop: 10 }}>
        {analysis.validation_notice}
      </p>
    </div>
  );
}
