// FlowSteps — timeline verticale numerata, sola lettura.
// Illustra "cosa succederà" in un flusso a passi (no-show / cancellazione):
// badge numerato + linea connettore + titolo a sinistra e dettaglio a destra.
// Nessuna logica di dominio: riceve `steps` già pronti dai costruttori in lib.js.
//
// steps: [{ n, title, detail?, tone?: 'default' | 'danger' | 'ok' | 'muted' }]
import React from 'react';

const TONES = {
  default: { badgeBg: 'var(--ink)', badgeFg: '#fff', border: 'none', title: 'var(--ink)', detail: 'var(--ink)' },
  danger: { badgeBg: 'var(--danger)', badgeFg: '#fff', border: 'none', title: 'var(--ink)', detail: 'var(--danger)' },
  ok: { badgeBg: 'var(--ok)', badgeFg: '#fff', border: 'none', title: 'var(--ink)', detail: 'var(--ok)' },
  muted: { badgeBg: 'var(--surface-2)', badgeFg: 'var(--muted)', border: '1.5px solid var(--hair)', title: 'var(--muted)', detail: 'var(--muted)' },
};

export default function FlowSteps({ steps }) {
  const list = steps || [];
  return (
    <div>
      {list.map((s, i) => {
        const tone = TONES[s.tone] || TONES.default;
        const last = i === list.length - 1;
        return (
          <div key={s.n ?? i} style={{ display: 'flex', gap: 12 }}>
            {/* rail: badge + connettore */}
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
              <div style={{
                width: 26, height: 26, borderRadius: '50%', flexShrink: 0,
                background: tone.badgeBg, color: tone.badgeFg, border: tone.border,
                display: 'grid', placeItems: 'center', fontSize: 13, fontWeight: 800,
                fontVariantNumeric: 'tabular-nums',
              }}>{s.n ?? i + 1}</div>
              {!last && <div style={{ flex: 1, width: 2, minHeight: 16, background: 'var(--hair)', margin: '2px 0' }} />}
            </div>
            {/* contenuto */}
            <div style={{
              flex: 1, minWidth: 0, display: 'flex', alignItems: 'baseline',
              justifyContent: 'space-between', gap: 10, paddingBottom: last ? 2 : 14, paddingTop: 3,
            }}>
              <span style={{ fontSize: 13.5, fontWeight: 600, color: tone.title, lineHeight: 1.3 }}>{s.title}</span>
              {s.detail != null && s.detail !== '' && (
                <span className="tabnum" style={{ fontSize: 13.5, fontWeight: 700, color: tone.detail, whiteSpace: 'nowrap', flexShrink: 0 }}>{s.detail}</span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
