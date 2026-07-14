// RightRail — cash-up (sales/today-summary), AI opportunities placeholder, waitlist top-3
import React from 'react';
import { Avatar, Icon } from '@youty/shared';
import { useDash } from '../../ctx.jsx';
import { fmtMoney, initialsOf, prefLabel } from './lib.js';

export default function RightRail({ summary, waitlist, onOpenLog, onOpenWaitlist, onOpenOpportunity }) {
  const { t, lang, showRevenue } = useDash();
  const active = (waitlist || []).filter((w) => w.status === 'active' || w.status === 'contacted');
  return (
    <React.Fragment>
      {showRevenue && <DailyCashUp t={t} lang={lang} summary={summary} onOpenLog={onOpenLog} />}

      {/* opportunità — AI engine arrives in phase 2, static placeholder */}
      <div style={{ marginTop: showRevenue ? 20 : 0, paddingTop: showRevenue ? 20 : 0, borderTop: showRevenue ? '4px solid var(--surface-2)' : 'none' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 12 }}>
          <div className="t-meta">{t('Opportunità di oggi', 'Today’s opportunities')}</div>
        </div>
        <button className="dk-card dk-hovercard" onClick={onOpenOpportunity} style={{ textAlign: 'left', width: '100%', padding: '12px 13px', border: '1px dashed var(--hair)', boxShadow: 'none', background: 'var(--surface)', cursor: 'pointer' }}>
          <div style={{ display: 'flex', gap: 9, alignItems: 'center' }}>
            <div style={{ width: 26, height: 26, borderRadius: 8, background: 'var(--clay-tint)', display: 'grid', placeItems: 'center', flexShrink: 0 }}>
              <Icon name="sparkle" size={13} color="var(--clay-ink)" />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 700, fontSize: 13 }}>{t('Suggerimenti AI', 'AI suggestions')}</div>
              <div className="t-sm" style={{ color: 'var(--muted)' }}>{t('Buchi da riempire, riattivazioni, last-minute', 'Gaps to fill, win-backs, last-minute')}</div>
            </div>
            <span style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--clay-ink)', background: 'var(--clay-tint)', padding: '2px 8px', borderRadius: 99, flexShrink: 0 }}>{t('Fase 2', 'Phase 2')}</span>
          </div>
        </button>
      </div>

      {/* lista d'attesa */}
      <div style={{ marginTop: 20, paddingTop: 20, borderTop: '4px solid var(--surface-2)' }}>
        <WaitListRail t={t} waitlist={active} onOpen={onOpenWaitlist} />
      </div>
    </React.Fragment>
  );
}

/* ---- cash-up card (GET /api/sales/today-summary) ---- */
function DailyCashUp({ t, lang, summary, onOpenLog }) {
  if (!summary) {
    return (
      <div>
        <div className="skel" style={{ height: 16, width: 160, marginBottom: 12 }} />
        <div className="skel" style={{ height: 120, borderRadius: 16 }} />
      </div>
    );
  }
  const total = Number(summary.total || 0);
  const checkout = Number(summary.checkout_total || 0);
  const pos = Number(summary.pos_total || 0);
  const checkoutPct = total > 0 ? Math.round((checkout / total) * 100) : 0;
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <Icon name="wallet" size={16} color="var(--clay-ink)" />
        <div className="t-meta" style={{ flex: 1 }}>{t('Riepilogo di cassa · oggi', 'Cash-up · today')}</div>
        <span className="t-sm" style={{ color: 'var(--muted-2)', fontWeight: 600 }}>{summary.count} {t('transazioni', 'txns')}</span>
      </div>
      {/* total → opens today's activity log */}
      <button onClick={onOpenLog} title={t('Apri il registro attività di oggi', 'Open today’s activity log')} style={{ display: 'block', width: '100%', textAlign: 'left', background: 'var(--ink)', borderRadius: 16, padding: '16px 18px', marginBottom: 12, border: 'none', cursor: 'pointer' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 5 }}>
          <span className="t-meta" style={{ fontSize: 10, color: 'rgba(255,255,255,0.7)' }}>{t('Vendite totali · oggi', 'Total sales · today')}</span>
          <div style={{ flex: 1 }} />
          <span style={{ fontSize: 11, fontWeight: 700, color: 'rgba(255,255,255,0.85)', display: 'inline-flex', alignItems: 'center', gap: 3 }}>{t('Registro', 'Log')}<Icon name="chevR" size={13} color="rgba(255,255,255,0.85)" /></span>
        </div>
        <div className="t-num" style={{ fontSize: 28, fontWeight: 800, color: '#fff' }}>{fmtMoney(total, lang)}</div>
        {total > 0 && (
          <React.Fragment>
            <div style={{ height: 5, borderRadius: 99, background: 'rgba(255,255,255,0.2)', overflow: 'hidden', margin: '10px 0 4px', display: 'flex' }}>
              <div style={{ height: '100%', width: checkoutPct + '%', background: '#fff', borderRadius: 99 }} />
            </div>
            <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.7)' }}>
              {t('Appuntamenti', 'Appointments')} {fmtMoney(checkout, lang)} · {t('Banco', 'Counter')} {fmtMoney(pos, lang)}
            </div>
          </React.Fragment>
        )}
      </button>
    </div>
  );
}

/* ---- waiting list rail (top 3) ---- */
function WaitListRail({ t, waitlist, onOpen }) {
  if (!waitlist || waitlist.length === 0) {
    return (
      <div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
          <div className="t-meta">{t("Lista d'attesa", 'Waiting list')}</div>
        </div>
        <button className="dk-btn dk-btn--ghost" style={{ width: '100%', fontSize: 13, borderStyle: 'dashed' }} onClick={onOpen}>
          <Icon name="clients" size={15} />{t('Nessuna richiesta · apri', 'No requests · open')}
        </button>
      </div>
    );
  }
  const top = waitlist.slice(0, 3);
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <div className="t-meta">{t("Lista d'attesa", 'Waiting list')}</div>
        <button className="dk-btn dk-btn--ghost" style={{ height: 28, fontSize: 12, padding: '0 10px' }} onClick={onOpen}>{t('Gestisci', 'Manage')}</button>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {top.map((w) => (
          <button key={w.id} className="dk-row" onClick={onOpen} style={{ display: 'flex', alignItems: 'center', gap: 9, width: '100%', textAlign: 'left', padding: '4px 2px', borderRadius: 8, border: 'none', background: 'transparent', cursor: 'pointer' }}>
            <Avatar initials={initialsOf(w.client_name)} size={30} color="var(--clay)" />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 700, fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{w.client_name}</div>
              <div className="t-sm" style={{ color: 'var(--muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{w.service_name} · {prefLabel(w, t)}</div>
            </div>
          </button>
        ))}
        {waitlist.length > 3 && <div className="t-sm" style={{ color: 'var(--muted-2)', marginTop: 2 }}>+{waitlist.length - 3} {t('altre', 'more')}</div>}
      </div>
    </div>
  );
}
