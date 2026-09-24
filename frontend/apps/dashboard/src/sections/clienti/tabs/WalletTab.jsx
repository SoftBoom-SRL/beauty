// WalletTab.jsx — staff view of the client's wallet: coupons, loyalty points,
// gift cards. Tutto si filtra lato server per `client_id`, anche il conto
// fedeltà: scorrere le pagine dell'elenco iscritte ordinato per punti (a pari
// merito in ordine non garantito su PostgreSQL) poteva non trovarla mai, e la
// cliente a 9 timbri su 10 risultava «non iscritta» (14-06, 07-06).
import React, { useEffect, useRef, useState } from 'react';
import { Icon, ProgressBar, fmtEurNoFree } from '@youty/shared';
import { DkModal } from '../../../ui/index.js';
import { useDash, useLive } from '../../../ctx.jsx';
import { QrGlyph } from '../components.jsx';
import { dateLabel, rewardLabel } from '../helpers.js';
import { couponsApi, giftCardsApi, loyaltyApi } from '../../../api/marketing.js';

/* Caricamento fallito: non è «nessun coupon». Prima un errore di rete si
 * leggeva come elenco vuoto, e alla cliente si diceva che non aveva buoni. */
const FAILED = 'failed';

/** → { points } se la cliente è iscritta, { points: null } se non lo è. */
async function loyaltyPointsOf(programId, clientId) {
  const res = await loyaltyApi.accounts(programId, { client_id: clientId });
  const mine = (res.items || []).find((a) => a.client_id === clientId);
  return { points: mine ? mine.points : null };
}

function LoadFailed({ msg, onRetry, t }) {
  return (
    <div className="t-sm" style={{ color: 'var(--danger)', display: 'flex', alignItems: 'center', gap: 8, padding: '6px 2px 2px', fontWeight: 600 }}>
      <Icon name="alert" size={13} color="var(--danger)" />{msg}
      <button type="button" onClick={onRetry} style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--clay-ink)', background: 'transparent', border: 'none', cursor: 'pointer' }}>{t('Riprova', 'Retry')}</button>
    </div>
  );
}

export default function WalletTab({ c }) {
  const { t, lang, services, fireToast } = useDash();
  const [coupons, setCoupons] = useState(null);   // null = in caricamento · FAILED · []
  const [gifts, setGifts] = useState(null);
  const [loyalty, setLoyalty] = useState(null);   // [{ program, points } | { program, failed }]
  const [giftView, setGiftView] = useState(null);
  const [rev, setRev] = useState(0);
  const retry = () => setRev((n) => n + 1);

  // Saldo gift card riscattata a un'altra cassa, coupon emesso, punti del
  // premio: la scheda aperta si aggiorna da sola (14-20). Le vendite di altre
  // clienti non la riguardano.
  useLive(/^(coupon|giftcard|loyalty|sale)[._]/, (events) => {
    if (events.some((e) => e.payload?.client_id == null || e.payload.client_id === c.id)) retry();
  });

  const shownFor = useRef(null);
  useEffect(() => {
    let dead = false;
    // Scheda nuova: scheletri. Ricarica della stessa: i dati restano a video
    // finché arrivano quelli nuovi, e se la ricarica fallisce restano quelli.
    if (shownFor.current !== c.id) { setCoupons(null); setGifts(null); setLoyalty(null); shownFor.current = c.id; }
    const keepOr = (cur) => (Array.isArray(cur) ? cur : FAILED);

    // filtro lato server: cercare per nome e scremare qui lasciava fuori i
    // coupon oltre il centesimo risultato, e la scheda diceva «nessun coupon»
    couponsApi.list({ client_id: c.id })
      .then((res) => { if (!dead) setCoupons(res.items || []); })
      .catch(() => { if (!dead) setCoupons(keepOr); });

    // filtro lato server: la cliente come acquirente o destinataria
    giftCardsApi.list({ client_id: c.id })
      .then((res) => { if (!dead) setGifts(res.items || []); })
      .catch(() => { if (!dead) setGifts(keepOr); });

    loyaltyApi.list({ active: true })
      .then(async (programs) => {
        const active = (programs || []).filter((p) => p.active);
        const rows = await Promise.all(active.map(async (p) => {
          try { return { program: p, ...(await loyaltyPointsOf(p.id, c.id)) }; }
          catch { return { program: p, failed: true }; }
        }));
        if (!dead) setLoyalty(rows);
      })
      .catch(() => { if (!dead) setLoyalty(keepOr); });

    return () => { dead = true; };
  }, [c.id, rev]);

  const couponValue = (cp) => cp.kind === 'percent' ? `-${Number(cp.value)}%` : '-' + fmtEurNoFree(cp.value, lang);

  const couponList = Array.isArray(coupons) ? coupons : [];
  const available = couponList.filter((x) => x.status === 'active').length;
  const used = couponList.length - available;
  const activeGifts = (Array.isArray(gifts) ? gifts : []).filter((g) => g.status === 'active').length;

  return (
    <div style={{ maxWidth: 660 }}>
      {/* —— 1 · COUPON —— */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <Icon name="coupon" size={15} color="var(--clay-ink)" />
        <span className="t-meta">{t('Coupon · sconti', 'Coupons · discounts')}</span>
      </div>
      {coupons == null ? <div className="skel" style={{ height: 70, borderRadius: 12, marginBottom: 16 }} /> : coupons === FAILED ? (
        <LoadFailed t={t} onRetry={retry} msg={t('Coupon non caricati: non è detto che non ce ne siano.', 'Coupons not loaded: there may be some.')} />
      ) : (
        <React.Fragment>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
            <div className="dk-card" style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 12, padding: '14px 16px', boxShadow: 'none', border: '1px solid var(--hair)' }}>
              <div style={{ width: 38, height: 38, borderRadius: 11, background: 'var(--clay-tint)', display: 'grid', placeItems: 'center' }}><Icon name="clock" size={19} color="var(--clay-ink)" /></div>
              <div><div className="t-num" style={{ fontSize: 22, lineHeight: 1 }}>{available}</div><div className="t-sm" style={{ color: 'var(--muted)', marginTop: 2 }}>{t('da usare', 'available')}</div></div>
            </div>
            <div className="dk-card" style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 12, padding: '14px 16px', boxShadow: 'none', border: '1px solid var(--hair)' }}>
              <div style={{ width: 38, height: 38, borderRadius: 11, background: 'var(--paper-2)', display: 'grid', placeItems: 'center' }}><Icon name="check" size={19} color="var(--muted)" /></div>
              <div><div className="t-num" style={{ fontSize: 22, lineHeight: 1, color: 'var(--muted)' }}>{used}</div><div className="t-sm" style={{ color: 'var(--muted)', marginTop: 2 }}>{t('usati / scaduti', 'used / expired')}</div></div>
            </div>
          </div>
          {coupons.length ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {coupons.map((cp) => {
                const spent = cp.status !== 'active';
                return (
                  <div key={cp.id} className="dk-card" style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 16px 14px 18px', boxShadow: 'none', border: '1px solid var(--hair)', borderLeft: '3px solid ' + (spent ? 'var(--faint)' : 'var(--clay)'), opacity: spent ? 0.62 : 1 }}>
                    <div style={{ width: 40, height: 40, borderRadius: 11, background: spent ? 'var(--paper-2)' : 'var(--clay-tint)', display: 'grid', placeItems: 'center', flexShrink: 0 }}>
                      <Icon name="coupon" size={20} color={spent ? 'var(--muted-2)' : 'var(--clay-ink)'} />
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        <span style={{ fontWeight: 700, fontSize: 15 }}>{cp.kind === 'percent' ? t('Sconto percentuale', 'Percentage discount') : t('Sconto a importo', 'Amount discount')}</span>
                        <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11.5, fontWeight: 700, letterSpacing: '0.06em', color: 'var(--muted)', background: 'var(--paper-2)', padding: '2px 8px', borderRadius: 6 }}>{cp.code}</span>
                        {cp.origin === 'loyalty' && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10.5, fontWeight: 700, color: 'var(--clay-ink)', background: 'var(--clay-tint)', padding: '2px 8px', borderRadius: 99 }}><Icon name="star" size={11} color="var(--clay-ink)" />{t('Fedeltà · premio punti', 'Loyalty · points reward')}</span>}
                        {cp.origin !== 'loyalty' && cp.origin !== 'manual' && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10.5, fontWeight: 700, color: 'var(--ok)', background: 'var(--ok-tint)', padding: '2px 8px', borderRadius: 99 }}><Icon name="bolt" size={11} color="var(--ok)" />{t('Automatico', 'Automatic')}</span>}
                      </div>
                      <div className="t-sm" style={{ color: 'var(--muted)', marginTop: 4, display: 'flex', gap: 14, flexWrap: 'wrap' }}>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                          <Icon name="calendar" size={13} color="var(--muted-2)" />
                          {cp.redeemed_at ? t(`Usato il ${dateLabel(cp.redeemed_at, lang)}`, `Used ${dateLabel(cp.redeemed_at, lang)}`)
                            : cp.expires_at ? t(`Scade ${dateLabel(cp.expires_at, lang)}`, `Expires ${dateLabel(cp.expires_at, lang)}`)
                            : t('Nessuna scadenza', 'No expiry')}
                        </span>
                      </div>
                    </div>
                    <div style={{ textAlign: 'right', flexShrink: 0 }}>
                      <div className="t-num" style={{ fontSize: 18, color: spent ? 'var(--muted-2)' : 'var(--clay-ink)' }}>{couponValue(cp)}</div>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11.5, fontWeight: 700, marginTop: 3, color: spent ? 'var(--muted-2)' : 'var(--ok)' }}>
                        <Icon name={spent ? 'check' : 'clock'} size={12} color={spent ? 'var(--muted-2)' : 'var(--ok)'} />
                        {cp.status === 'active' ? t('Da usare', 'Available') : cp.status === 'redeemed' ? t('Usato', 'Used') : t('Scaduto', 'Expired')}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="t-sm" style={{ color: 'var(--muted-2)', padding: '2px 2px' }}>{t('Nessun coupon per questo cliente. Si assegnano da Promozioni → Coupon.', 'No coupons for this client. Assign them from Promotions → Coupons.')}</div>
          )}
        </React.Fragment>
      )}

      {/* —— 2 · FEDELTÀ —— */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '26px 0 10px', paddingTop: 20, borderTop: '1px solid var(--hair)' }}>
        <Icon name="star" size={15} color="var(--clay-ink)" />
        <span className="t-meta">{t('Fedeltà · raccolta punti', 'Loyalty · points balance')}</span>
      </div>
      {loyalty == null ? <div className="skel" style={{ height: 90, borderRadius: 12 }} /> : loyalty === FAILED ? (
        <LoadFailed t={t} onRetry={retry} msg={t('Programmi fedeltà non caricati.', 'Loyalty programs not loaded.')} />
      ) : loyalty.length ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {loyalty.map(({ program: p, points, failed }) => {
            const val = points != null ? points : 0;
            const pctDone = Math.min(100, Math.round(val / Math.max(1, p.threshold) * 100));
            const reached = val >= p.threshold;
            const left = Math.max(0, p.threshold - val);
            const u = p.type === 'stamps' ? t('timbri', 'stamps') : t('pt', 'pt');
            return (
              <div key={p.id} className="dk-card" style={{ padding: 16, boxShadow: 'none', border: '1px solid var(--hair)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
                  <div style={{ width: 32, height: 32, borderRadius: 9, background: 'var(--clay-tint)', display: 'grid', placeItems: 'center', flexShrink: 0 }}><Icon name="star" size={16} color={p.color || 'var(--clay-ink)'} /></div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 700, fontSize: 14 }}>{p.name}</div>
                    <div className="t-sm" style={{ color: 'var(--muted)' }}>{t('Premio: ', 'Reward: ')}{rewardLabel(p, services, lang)}</div>
                  </div>
                  <div className="t-num" style={{ fontSize: 16 }}>{failed ? '—' : val}<span style={{ color: 'var(--muted-2)', fontSize: 13 }}>/{p.threshold}</span></div>
                </div>
                <ProgressBar value={pctDone} color={reached ? 'var(--ok)' : (p.color || 'var(--clay)')} />
                {/* «non caricato» non è «non iscritta»: senza questa
                    distinzione una cliente con 9 timbri su 10 risultava fuori
                    dal programma e nessuno le riconosceva il premio */}
                {failed
                  ? <LoadFailed t={t} onRetry={retry} msg={t('Saldo non caricato.', 'Balance not loaded.')} />
                  : points == null
                  ? <div className="t-sm" style={{ marginTop: 8, color: 'var(--muted-2)' }}>{t('Non ancora iscritta al programma', 'Not enrolled yet')}</div>
                  : reached
                    ? <div style={{ display: 'inline-flex', alignItems: 'center', gap: 5, marginTop: 8, fontSize: 12, fontWeight: 700, color: 'var(--ok)' }}><Icon name="check" size={13} color="var(--ok)" stroke={2.4} />{t('Premio raggiunto → il coupon compare qui sopra con origine Fedeltà', 'Reward reached → the coupon appears above with Loyalty origin')}</div>
                    : <div className="t-sm" style={{ marginTop: 8, color: 'var(--muted)' }}>{t(`Mancano ${left} ${u} al premio`, `${left} ${u} to the reward`)}</div>}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="t-sm" style={{ color: 'var(--muted-2)', padding: '6px 2px 2px' }}>{t('Nessun programma fedeltà attivo.', 'No active loyalty program.')}</div>
      )}

      {/* —— 3 · GIFT CARD —— */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '26px 0 10px', paddingTop: 20, borderTop: '1px solid var(--hair)' }}>
        <Icon name="gift" size={15} color="var(--clay-ink)" />
        <span className="t-meta">{t('Gift card · buoni regalo', 'Gift cards')}</span>
        {activeGifts > 0 && <span style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--ok)', background: 'var(--ok-tint)', padding: '2px 8px', borderRadius: 99 }}>{activeGifts} {t('attive', 'active')}</span>}
      </div>
      {gifts == null ? <div className="skel" style={{ height: 76, borderRadius: 12 }} /> : gifts === FAILED ? (
        <LoadFailed t={t} onRetry={retry} msg={t('Gift card non caricate: non è detto che non ce ne siano.', 'Gift cards not loaded: there may be some.')} />
      ) : gifts.length ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {gifts.map((g) => {
            const spent = g.status !== 'active';
            const isBuyer = g.buyer_client_id === c.id;
            return (
              <div key={g.id} className="dk-card dk-row" onClick={() => setGiftView(g)} style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 16px', boxShadow: 'none', border: '1px solid var(--hair)', borderLeft: '3px solid ' + (spent ? 'var(--faint)' : 'var(--ok)'), opacity: spent ? 0.62 : 1, cursor: 'pointer' }}>
                <QrGlyph code={g.code} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <span style={{ fontWeight: 700, fontSize: 15 }}>{isBuyer ? t('Acquistata · da regalare', 'Bought · to gift') : t('Ricevuta in regalo', 'Received as a gift')}</span>
                    <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11.5, fontWeight: 700, letterSpacing: '0.06em', color: 'var(--muted)', background: 'var(--paper-2)', padding: '2px 8px', borderRadius: 6 }}>{g.code}</span>
                    {g.payment_status === 'unpaid' && <span style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--warn)', background: 'var(--warn-tint)', padding: '2px 8px', borderRadius: 99 }}>{t('Da pagare', 'Unpaid')}</span>}
                  </div>
                  <div className="t-sm" style={{ color: 'var(--muted)', marginTop: 4, display: 'flex', gap: 14, flexWrap: 'wrap' }}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                      <Icon name="user" size={13} color="var(--muted-2)" />
                      {isBuyer ? t('Destinataria: ', 'For ') : t('Regalata da ', 'From ')}{(isBuyer ? g.recipient_name : g.buyer_name) || '—'}
                    </span>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                      <Icon name="calendar" size={13} color="var(--muted-2)" />
                      {g.expires_at ? t(`Scade ${dateLabel(g.expires_at, lang)}`, `Expires ${dateLabel(g.expires_at, lang)}`) : t('Nessuna scadenza', 'No expiry')}
                    </span>
                  </div>
                </div>
                <div style={{ textAlign: 'right', flexShrink: 0 }}>
                  <div className="t-num" style={{ fontSize: 19, color: spent ? 'var(--muted-2)' : 'var(--ok)' }}>{fmtEurNoFree(g.balance, lang)}</div>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11.5, fontWeight: 700, marginTop: 3, color: spent ? 'var(--muted-2)' : 'var(--ok)' }}>
                    <Icon name={spent ? 'check' : 'clock'} size={12} color={spent ? 'var(--muted-2)' : 'var(--ok)'} />{spent ? t('Esaurita', 'Spent') : t('Attiva', 'Active')}
                  </span>
                </div>
                <Icon name="chevR" size={16} color="var(--faint)" />
              </div>
            );
          })}
        </div>
      ) : (
        <div className="t-sm" style={{ color: 'var(--muted-2)', padding: '6px 2px 2px' }}>{t('Nessuna gift card collegata a questo cliente.', 'No gift cards linked to this client.')}</div>
      )}

      {giftView && (
        <DkModal open onClose={() => setGiftView(null)} title="Gift card" sub={giftView.code} width={420}
          foot={<React.Fragment>
            <button className="dk-btn dk-btn--ghost" onClick={() => setGiftView(null)}>{t('Chiudi', 'Close')}</button>
            {giftView.status === 'active' && <button className="dk-btn dk-btn--clay" onClick={() => fireToast({ msg: t('QR pronto per la stampa', 'QR ready to print'), icon: 'check' })}><Icon name="barcode" size={16} color="#fff" />{t('Stampa QR', 'Print QR')}</button>}
          </React.Fragment>}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, padding: '6px 0 16px' }}>
            <QrGlyph code={giftView.code} size={160} />
            <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 13, fontWeight: 700, letterSpacing: '0.08em', color: 'var(--muted)', background: 'var(--paper-2)', padding: '4px 12px', borderRadius: 8 }}>{giftView.code}</span>
            <div className="t-num" style={{ fontSize: 32, color: giftView.status === 'active' ? 'var(--ok)' : 'var(--muted-2)', lineHeight: 1 }}>{fmtEurNoFree(giftView.balance, lang)}</div>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, fontWeight: 700, padding: '4px 12px', borderRadius: 99, color: giftView.status === 'active' ? 'var(--ok)' : 'var(--muted)', background: giftView.status === 'active' ? 'var(--ok-tint)' : 'var(--paper-2)' }}>
              <Icon name={giftView.status === 'active' ? 'clock' : 'check'} size={13} color={giftView.status === 'active' ? 'var(--ok)' : 'var(--muted)'} />
              {giftView.status === 'active' ? t('Attiva · da riscattare', 'Active · to redeem') : t('Esaurita', 'Spent')}
            </span>
          </div>
          <div style={{ borderTop: '1px solid var(--hair)' }}>
            {[
              [t('Tipo', 'Type'), giftView.buyer_client_id === c.id ? t('Acquistata · da regalare', 'Bought · to gift') : t('Ricevuta in regalo', 'Received as a gift')],
              [giftView.buyer_client_id === c.id ? t('Destinataria', 'For') : t('Regalata da', 'From'), (giftView.buyer_client_id === c.id ? giftView.recipient_name : giftView.buyer_name) || '—'],
              [t('Valore iniziale', 'Initial value'), fmtEurNoFree(giftView.initial_value, lang)],
              [t('Saldo', 'Balance'), fmtEurNoFree(giftView.balance, lang)],
              [t('Pagamento', 'Payment'), giftView.payment_status === 'unpaid' ? t('Da pagare', 'Unpaid') : t('Pagata', 'Paid')],
              [t('Scadenza', 'Expiry'), giftView.expires_at ? dateLabel(giftView.expires_at, lang) : t('Nessuna', 'None')],
            ].map(([l, v], i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '11px 2px', borderTop: i ? '1px solid var(--hair)' : 'none' }}>
                <span className="t-sm" style={{ color: 'var(--muted)', width: 110, flexShrink: 0 }}>{l}</span>
                <span style={{ fontWeight: 700, fontSize: 14, flex: 1, textAlign: 'right' }}>{v}</span>
              </div>
            ))}
          </div>
        </DkModal>
      )}
    </div>
  );
}
