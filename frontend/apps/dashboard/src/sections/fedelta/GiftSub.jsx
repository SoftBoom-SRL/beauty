import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, fmtEur, parseISO, Icon, EmptyState } from '@youty/shared';

/** fmtEur(0) scrive «Gratis» (convenzione dei listini servizi): un KPI o un
 *  saldo a zero è «€0», non un omaggio. */
const eur0 = (n, lang) => (Number(n) === 0 ? '€0' : fmtEur(Number(n), lang));
import { useDash } from '../../ctx.jsx';
import { GroupedFilterMenu } from '../../ui/index.js';
import QrMini from './QrMini.jsx';
import Pager from './Pager.jsx';
import GiftCardModal from './modals/GiftCardModal.jsx';
import { GC_STATUS_META, GC_PAYMENT_META, effectiveStatus, isMaskedCode } from './meta.js';

// L'elenco è paginato lato server. Prima si chiedevano le prime 200 carte e
// basta: un salone che ne ha vendute di più ne vedeva una parte senza che
// niente lo dicesse, e le mancanti erano semplicemente introvabili.
const LIMIT = 24;

const PAY_METHOD_LABELS = {
  cash: { it: 'Contanti', en: 'Cash' },
  card: { it: 'Carta', en: 'Card' },
  other: { it: 'Altro', en: 'Other' },
};

function dateLabel(iso, lang) {
  if (!iso) return '';
  return parseISO(iso).toLocaleDateString(lang === 'en' ? 'en-GB' : 'it-IT');
}

export default function GiftSub() {
  const { t, lang, hasScope, fireToast, services } = useDash();
  const canWrite = hasScope('marketing');
  // Incassare una carta è della cassa: «Segna pagata» e «Pagata ora» li usa
  // chi ha `sales`, come chiede il server. Prima servivano i permessi
  // marketing, che il Front desk non ha: la carta comprata dall'app restava
  // «da pagare» e al banco si vendeva una seconda carta (07-04). Una carta che
  // nasce da pagare resta invece del marketing.
  const canCash = hasScope('sales');
  const canCreate = canWrite || canCash;

  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [statusF, setStatusF] = useState('all');
  const [payF, setPayF] = useState('all');
  const [offset, setOffset] = useState(0);

  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [kpi, setKpi] = useState(null);
  const [loading, setLoading] = useState(true);
  const [edit, setEdit] = useState(null);
  const [markingId, setMarkingId] = useState(null);

  // la ricerca si scrive in `query` con un ritardo, e riporta alla prima pagina
  useEffect(() => {
    const tm = setTimeout(() => { setQuery(q); setOffset(0); }, 300);
    return () => clearTimeout(tm);
  }, [q]);

  /* Come in CouponSub: un solo effetto con filtri e offset fra le dipendenze,
   * l'offset azzerato dallo stesso gestore che cambia il filtro, e `reqSeq` a
   * scartare le risposte in ritardo (altrimenti si vede una pagina mentre il
   * pager ne annuncia un'altra). */
  const reqSeq = useRef(0);
  const setFilter = (setter) => (v) => { setter(v); setOffset(0); };

  const reload = useCallback(() => {
    const seq = ++reqSeq.current;
    setLoading(true);
    api.get('/api/marketing/gift-cards', {
      params: {
        status: statusF === 'all' ? undefined : statusF,
        payment_status: payF === 'all' ? undefined : payF,
        q: query || undefined,
        limit: LIMIT, offset,
      },
    }).then((res) => {
      if (seq !== reqSeq.current) return;
      setItems(res.items || []);
      setTotal(res.total || 0);
      setKpi(res.kpi || null);
    }).catch((err) => {
      if (seq !== reqSeq.current) return;
      setItems([]); setTotal(0); setKpi(null);
      fireToast({ msg: err instanceof ApiError ? err.message : t('Errore di rete', 'Network error'), icon: 'alert' });
    }).finally(() => { if (seq === reqSeq.current) setLoading(false); });
  }, [statusF, payF, query, offset, fireToast, t]);

  useEffect(() => { reload(); }, [reload]);

  const markPaid = async (card, method) => {
    setMarkingId(null);
    try {
      await api.post(`/api/marketing/gift-cards/${card.id}/mark-paid`, { method });
      fireToast({ msg: t('Gift card segnata come pagata', 'Gift card marked as paid'), icon: 'check' });
      reload();
    } catch (err) {
      fireToast({ msg: err instanceof ApiError ? err.message : t('Errore di rete', 'Network error'), icon: 'alert' });
    }
  };

  const handleSaved = () => {
    setEdit(null);
    fireToast({ msg: t('Gift card creata', 'Gift card created'), icon: 'check' });
    reload();
  };

  // `items` è una pagina, non tutte le carte: il numero è esatto solo quando la
  // pagina le contiene tutte, oppure quando il filtro è già «da pagare» e allora
  // il totale del server è proprio quello. Altrimenti si mostra l'etichetta
  // senza cifra, invece di un conteggio che parla solo della pagina a video.
  const pageUnpaid = items.filter((g) => g.payment_status === 'unpaid').length;
  const unpaidExact = payF === 'unpaid' ? total : (total <= items.length ? pageUnpaid : null);
  const showUnpaid = unpaidExact === null ? pageUnpaid > 0 : unpaidExact > 0;

  return (
    <React.Fragment>
      <div className="t-sm" style={{ color: 'var(--muted)', marginBottom: 16 }}>
        {t('Valore prepagato: il centro incassa subito e onora la card quando viene riscattata. Monitora qui il saldo ancora da onorare.', 'Prepaid value: the salon collects up front and honours the card when redeemed. Track the outstanding balance here.')}
      </div>

      {/* KPI header — sold / redeemed / outstanding from the API `kpi` envelope */}
      {loading && !kpi ? (
        <div className="skel" style={{ height: 104, borderRadius: 16, marginBottom: 18 }} />
      ) : (
        <div className="dk-card" style={{ display: 'flex', alignItems: 'stretch', gap: 0, padding: '16px 6px', marginBottom: 18, boxShadow: 'none', border: '1px solid var(--hair)' }}>
          {[
            [t('Valore venduto', 'Sold value'), eur0(kpi?.sold_total || 0, lang), 'var(--ink)', t('totale card emesse', 'total cards issued')],
            [t('Già riscattato', 'Already redeemed'), eur0(kpi?.redeemed_total || 0, lang), 'var(--muted)', t('valore consumato', 'value consumed')],
            [t('Da riscattare', 'Outstanding'), eur0(kpi?.outstanding || 0, lang), 'var(--clay-ink)', t('saldo da onorare', 'balance to honour')],
          ].map(([l, v, c, sub], i) => (
            <div key={i} style={{ flex: 1, padding: '2px 18px', borderLeft: i ? '1px solid var(--hair)' : 'none' }}>
              <div className="t-meta" style={{ marginBottom: 5 }}>{l}</div>
              <div className="t-num" style={{ fontSize: 24, color: c }}>{v}</div>
              <div className="t-sm" style={{ color: 'var(--muted-2)', marginTop: 2 }}>{sub}</div>
            </div>
          ))}
          <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'flex-end', gap: 8, padding: '0 14px 0 18px', borderLeft: '1px solid var(--hair)' }}>
            {showUnpaid && (
              <button onClick={() => { setPayF('unpaid'); setOffset(0); }} title={t('Mostra solo le gift card da pagare', 'Show only unpaid gift cards')}
                style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--warn)', background: 'var(--warn-tint)', padding: '3px 10px', borderRadius: 99, whiteSpace: 'nowrap', border: 'none', cursor: 'pointer' }}>
                {unpaidExact === null ? t('da pagare', 'unpaid') : `${unpaidExact} ${t('da pagare', 'unpaid')}`}
              </button>
            )}
            {canCreate && <button className="dk-btn dk-btn--clay" onClick={() => setEdit({})} style={{ whiteSpace: 'nowrap' }}><Icon name="plus" size={17} color="#fff" />{t('Nuova gift card', 'New gift card')}</button>}
          </div>
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 18 }}>
        <div className="dk-search" style={{ flex: 1, minWidth: 0, width: 'auto' }}>
          <Icon name="search" size={18} color="var(--muted-2)" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('Cerca per codice, acquirente o destinataria…', 'Search by code, buyer or recipient…')} />
          {q && <button onClick={() => setQ('')} style={{ cursor: 'pointer', display: 'grid', placeItems: 'center' }}><Icon name="x" size={15} color="var(--muted-2)" /></button>}
        </div>
        <GroupedFilterMenu t={t} groups={[
          { label: t('Stato', 'Status'), value: statusF, set: setFilter(setStatusF), opts: [['all', t('Tutte', 'All')], ['active', t('Attive', 'Active')], ['redeemed', t('Esaurite', 'Redeemed')], ['expired', t('Scadute', 'Expired')]] },
          { label: t('Pagamento', 'Payment'), value: payF, set: setFilter(setPayF), opts: [['all', t('Tutti', 'All')], ['paid', t('Pagate', 'Paid')], ['unpaid', t('Da pagare', 'Unpaid')]] },
        ]} />
      </div>

      {loading && !items.length ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(380px, 1fr))', gap: 16 }}>
          {[...Array(4)].map((_, i) => <div key={i} className="skel" style={{ height: 180, borderRadius: 16 }} />)}
        </div>
      ) : items.length ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(380px, 1fr))', gap: 16 }}>
          {items.map((g) => {
            // scaduta si legge scaduta anche se la risposta dice ancora «attiva» (07-07)
            const status = effectiveStatus(g);
            const st = GC_STATUS_META[status] || GC_STATUS_META.active;
            // codice mascherato (chi non ha marketing né cassa, C21): niente QR da usare
            const masked = isMaskedCode(g.code);
            const due = g.payment_status === 'unpaid';
            const value = Number(g.initial_value);
            const balance = Number(g.balance);
            const used = value - balance;
            const methodLabel = PAY_METHOD_LABELS[g.paid_method] ? PAY_METHOD_LABELS[g.paid_method][lang] : g.paid_method;
            return (
              <div key={g.id} className="dk-card" style={{ padding: 18, opacity: status === 'redeemed' || status === 'expired' ? 0.72 : 1, borderLeft: '3px solid ' + (due ? 'var(--warn)' : status === 'active' ? 'var(--clay)' : 'var(--faint)') }}>
                <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start' }}>
                  {masked ? (
                    <div title={t('Codice visibile a chi ha i permessi marketing o vendite', 'Code visible with the marketing or sales permission')}
                      style={{ flexShrink: 0, width: 54, height: 54, padding: 7, border: '1px solid var(--hair)', borderRadius: 10, background: 'var(--surface-2)', display: 'grid', placeItems: 'center', boxSizing: 'content-box' }}>
                      <Icon name="lock" size={20} color="var(--muted-2)" />
                    </div>
                  ) : (
                    <div style={{ flexShrink: 0, padding: 7, border: '1px solid var(--hair)', borderRadius: 10, background: '#fff' }}><QrMini code={g.code} /></div>
                  )}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                      <span className="t-num" style={{ fontSize: 24, color: 'var(--clay-ink)' }}>{eur0(value, lang)}</span>
                      {used > 0 && status === 'active' && <span className="t-sm" style={{ color: 'var(--muted)', fontWeight: 600 }}>{t('residuo', 'left')} <strong style={{ color: 'var(--ink)' }}>{eur0(balance, lang)}</strong></span>}
                    </div>
                    <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11.5, fontWeight: 700, letterSpacing: '0.06em', color: 'var(--muted)', background: 'var(--paper-2)', padding: '2px 8px', borderRadius: 6, display: 'inline-block', marginTop: 5 }}>{g.code}</span>
                    {g.gift_service_name && (
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, fontWeight: 700, color: 'var(--clay-ink)', background: 'var(--clay-tint)', padding: '2px 9px', borderRadius: 99, marginTop: 5, marginLeft: 6 }}>
                        <Icon name="gift" size={12} color="var(--clay-ink)" />{t('Trattamento', 'Treatment')}: {g.gift_service_name}
                      </span>
                    )}
                    <div className="t-sm" style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 9, color: 'var(--ink-2)', flexWrap: 'wrap' }}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                        <Icon name="user" size={13} color="var(--muted-2)" />
                        <span className="t-sm" style={{ color: 'var(--muted-2)' }}>{t('da', 'from')}</span> <strong>{g.buyer_name || '—'}</strong>
                      </span>
                      <Icon name="chevR" size={12} color="var(--muted-2)" />
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                        <Icon name="gift" size={13} color="var(--muted-2)" />
                        <span className="t-sm" style={{ color: 'var(--muted-2)' }}>{t('a', 'to')}</span> <strong>{g.recipient_name || '—'}</strong>
                      </span>
                    </div>
                  </div>
                  <span style={{ flexShrink: 0, fontSize: 11, fontWeight: 700, padding: '4px 10px', borderRadius: 99, background: st.bg, color: st.color }}>{st[lang]}</span>
                </div>

                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 14 }}>
                  {due ? (
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, fontWeight: 700, color: 'var(--warn)', background: 'var(--warn-tint)', padding: '5px 11px', borderRadius: 99 }}>
                      <Icon name="clock" size={13} color="var(--warn)" />{t('Da pagare', 'Payment due')}
                    </span>
                  ) : (
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, fontWeight: 700, color: 'var(--ok)', background: 'var(--ok-tint)', padding: '5px 11px', borderRadius: 99, whiteSpace: 'nowrap' }}>
                      <Icon name="check" size={13} color="var(--ok)" stroke={2.4} />{t('Pagata', 'Paid')}{g.paid_at ? ' · ' + dateLabel(g.paid_at, lang) : ''}{methodLabel ? ' · ' + methodLabel : ''}
                    </span>
                  )}
                  {g.delivery_date ? (
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, fontWeight: 600, color: 'var(--ink-2)', background: 'var(--surface-2)', padding: '5px 11px', borderRadius: 99 }}>
                      <Icon name="send" size={13} color="var(--muted)" />{t('Consegna', 'Delivery')} · {dateLabel(g.delivery_date, lang)}
                    </span>
                  ) : (
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, fontWeight: 600, color: 'var(--ink-2)', background: 'var(--surface-2)', padding: '5px 11px', borderRadius: 99 }}>
                      <Icon name="barcode" size={13} color="var(--muted)" />{t('Consegna a mano', 'Hand delivery')}
                    </span>
                  )}
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--hair)', position: 'relative' }}>
                  <span className="t-sm" style={{ color: 'var(--muted)', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                    <Icon name="calendar" size={13} color="var(--muted-2)" />
                    {g.expires_at ? t('Scade: ', 'Expires: ') + dateLabel(g.expires_at, lang) : t('Nessuna scadenza', 'No expiry')}
                  </span>
                  {due && canCash && status === 'active' && (
                    <button className="dk-btn dk-btn--ghost" style={{ marginLeft: 'auto', height: 32, fontSize: 12.5 }} onClick={() => setMarkingId(markingId === g.id ? null : g.id)}>
                      <Icon name="check" size={14} />{t('Segna pagata', 'Mark paid')}
                    </button>
                  )}
                  {markingId === g.id && (
                    <React.Fragment>
                      <div onClick={() => setMarkingId(null)} style={{ position: 'fixed', inset: 0, zIndex: 60 }} />
                      <div className="dk-card" style={{ position: 'absolute', bottom: 'calc(100% + 6px)', right: 0, padding: 6, zIndex: 61, boxShadow: 'var(--sh-pop)', width: 170 }}>
                        <div className="t-meta" style={{ padding: '6px 10px 6px' }}>{t('Metodo', 'Method')}</div>
                        {Object.entries(PAY_METHOD_LABELS).map(([k, l]) => (
                          <button key={k} className="dk-row" onClick={() => markPaid(g, k)} style={{ display: 'block', width: '100%', padding: '8px 10px', borderRadius: 9, textAlign: 'left', fontWeight: 600, fontSize: 13.5 }}>{l[lang]}</button>
                        ))}
                      </div>
                    </React.Fragment>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <EmptyState icon="gift" title={t('Nessuna gift card', 'No gift cards')} sub={t('Vendi la prima gift card.', 'Sell your first gift card.')}
          action={canCreate ? t('Nuova gift card', 'New gift card') : null} onAction={() => setEdit({})} />
      )}

      <Pager count={total} limit={LIMIT} offset={offset} setOffset={setOffset} t={t} />

      {edit && (
        <GiftCardModal onClose={() => setEdit(null)} onSaved={handleSaved} t={t} lang={lang} fireToast={fireToast} services={services}
          canCash={canCash} canPayLater={canWrite} />
      )}
    </React.Fragment>
  );
}
