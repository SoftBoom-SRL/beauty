// RightRail — cash-up (sales/today-summary), «da richiamare» (slot liberati per
// caparra non pagata), AI opportunities placeholder, waitlist top-3
import React from 'react';
import { Avatar, Icon, fmtDateIt, minutesOfDay, timeLabel, toDateStr } from '@youty/shared';
import { useDash } from '../../ctx.jsx';
import { fmtMoney, initialsOf, prefLabel } from './lib.js';
import { cashUpLines } from './modals/rules.js';

export default function RightRail({ summary, waitlist, released, onRestore, onRebook, onOpenAppt, onOpenLog, onOpenWaitlist, onOpenOpportunity }) {
  const { t, lang, showRevenue, hasScope } = useDash();
  const active = (waitlist || []).filter((w) => w.status === 'active' || w.status === 'contacted');
  return (
    <React.Fragment>
      {showRevenue && <DailyCashUp t={t} lang={lang} summary={summary} onOpenLog={onOpenLog} />}

      {/* slot liberati automaticamente: la cliente non ha pagato la caparra in tempo.
          Resta la traccia perché l'operatrice richiami e decida. */}
      {(released || []).length > 0 && (
        <div style={{ marginTop: showRevenue ? 20 : 0, paddingTop: showRevenue ? 20 : 0, borderTop: showRevenue ? '4px solid var(--surface-2)' : 'none' }}>
          <ReleasedRail t={t} lang={lang} released={released} canWrite={hasScope('agenda')} onRestore={onRestore} onRebook={onRebook} onOpenAppt={onOpenAppt} />
        </div>
      )}

      {/* opportunità — AI engine arrives in phase 2, static placeholder */}
      <div style={{ marginTop: showRevenue || (released || []).length ? 20 : 0, paddingTop: showRevenue || (released || []).length ? 20 : 0, borderTop: showRevenue || (released || []).length ? '4px solid var(--surface-2)' : 'none' }}>
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
  const cash = cashUpLines(summary);
  const partLabel = {
    deposit_cashed: t('caparre incassate', 'deposits cashed'),
    gift_card_redeemed: t('gift card usate', 'gift cards used'),
    deposit_used: t('caparre detratte', 'deposits deducted'),
    deposit_refunded: t('caparre rimborsate', 'deposits refunded'),
  };
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
        {/* Il denaro entrato davvero oggi, quando non coincide col venduto:
            anche con il solo incasso di una caparra (venduto zero), e al
            netto delle caparre restituite (05-16). */}
        {cash?.show && (
          <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.7)', marginTop: 3 }}
            title={t('Il venduto di oggi, meno quello già incassato in un altro giorno (gift card, caparre versate prima), più le caparre versate oggi, meno quelle restituite', 'Today’s sales, minus what was collected on another day (gift cards, deposits paid earlier), plus deposits paid today, minus deposits refunded')}>
            {t('Incassato oggi', 'Cash in today')} <b style={{ color: '#fff' }}>{fmtMoney(cash.cashIn, lang)}</b>
            {cash.parts.map((p) => <span key={p.key}> · {partLabel[p.key]} {fmtMoney(p.amount, lang)}</span>)}
          </div>
        )}
      </button>
    </div>
  );
}

/* ---- da richiamare: appuntamenti liberati per caparra non pagata ---- */
function ReleasedRail({ t, lang, released, canWrite, onRestore, onRebook, onOpenAppt }) {
  const [open, setOpen] = React.useState(true);
  const list = open ? released : released.slice(0, 2);
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <Icon name="phone" size={15} color="var(--warn)" />
        <div className="t-meta" style={{ flex: 1 }}>{t('Da richiamare · caparra non pagata', 'To call back · unpaid deposit')}</div>
        <span style={{ fontSize: 11, fontWeight: 800, color: 'var(--warn)', background: 'var(--warn-tint)', padding: '2px 8px', borderRadius: 99 }}>{released.length}</span>
      </div>
      <div className="t-sm" style={{ color: 'var(--muted)', marginBottom: 10, lineHeight: 1.4 }}>
        {t('Lo slot è stato liberato allo scadere del tempo per pagare. La cliente resta qui finché non decidi: una telefonata di cortesia, il ripristino o una nuova prenotazione.', 'The slot was freed when the payment window ran out. The client stays here until you decide: a courtesy call, a restore or a new booking.')}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {list.map((a) => {
          const future = new Date(a.start).getTime() > Date.now();
          return (
            <div key={a.id} className="dk-card" style={{ padding: '10px 11px', boxShadow: 'none', border: '1px solid var(--hair)', borderLeft: '3px solid var(--warn)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                <Avatar initials={initialsOf(a.client?.full_name)} size={30} color="var(--warn-tint)" />
                <button onClick={() => onOpenAppt && onOpenAppt(a)} style={{ flex: 1, minWidth: 0, textAlign: 'left', background: 'transparent', border: 'none', cursor: 'pointer', padding: 0 }}>
                  <div style={{ fontWeight: 700, fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{a.client?.full_name}</div>
                  <div className="t-sm tabnum" style={{ color: 'var(--muted)', fontSize: 11.5 }}>
                    {fmtDateIt(toDateStr(a.start), { weekday: false })} · {timeLabel(minutesOfDay(a.start))} · {(a.items || []).map((i) => i.service_name).join(' + ')}
                  </div>
                </button>
                {a.client?.phone && (
                  <a href={'tel:' + a.client.phone} className="dk-iconbtn" title={t('Chiama', 'Call') + ' ' + a.client.phone} style={{ width: 30, height: 30, borderRadius: 9, display: 'grid', placeItems: 'center' }}>
                    <Icon name="phone" size={14} />
                  </a>
                )}
              </div>
              <div className="t-sm" style={{ color: 'var(--warn)', fontWeight: 700, marginTop: 6, fontSize: 11.5 }}>
                {t('Caparra', 'Deposit')} {fmtMoney(a.deposit_amount, lang)} {t('non versata', 'not paid')}
              </div>
              {canWrite && (
                <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                  {future && (
                    <button className="dk-btn dk-btn--soft" style={{ height: 30, fontSize: 12, flex: 1, padding: '0 8px' }} onClick={() => onRestore && onRestore(a)} title={t('Rimetti in agenda nello stesso orario, se ancora libero', 'Put it back at the same time, if still free')}>
                      <Icon name="refresh" size={13} />{t('Ripristina', 'Restore')}
                    </button>
                  )}
                  <button className="dk-btn dk-btn--ghost" style={{ height: 30, fontSize: 12, flex: 1, padding: '0 8px' }} onClick={() => onRebook && onRebook(a)}>
                    <Icon name="calendar" size={13} />{t('Riprenota', 'Rebook')}
                  </button>
                </div>
              )}
            </div>
          );
        })}
        {released.length > 2 && (
          <button onClick={() => setOpen((o) => !o)} style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--clay-ink)', cursor: 'pointer', background: 'transparent', border: 'none', textAlign: 'left', padding: '2px 0' }}>
            {open ? t('Mostra meno', 'Show less') : t(`Mostra tutte (${released.length})`, `Show all (${released.length})`)}
          </button>
        )}
      </div>
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
