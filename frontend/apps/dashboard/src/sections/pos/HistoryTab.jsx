// HistoryTab — "Storico": sales history from GET /api/sales/ (custom envelope {count,kpi,items}),
// KPI header, filters (kind, dates, text, operator, «da saldare»), expandable rows loading
// GET /api/sales/{id}. Un conto con qualcosa da saldare ha il suo segno e, aperto, «Salda»
// (POST /api/sales/{id}/settle): il denaro entra nella cassa del giorno in cui arriva.
import { useEffect, useState } from 'react';
import { Icon, toastApiError } from '@youty/shared';
import { useDash } from '../../ctx.jsx';
import PaymentsPanel from './PaymentsPanel.jsx';
import {
  centsToApi, centsToEur, emptyPayments, inputCss, methodLabel, money, opName, paymentsError, resolvePayments,
  saleDateLabel, toCents,
} from './lib.js';
import { lineGrossCents, paidLater, saleLineLabel } from './history.js';
import { salesApi } from '../../api/sales.js';
import NoReceiptBadge from './NoReceiptBadge.jsx';
import { useDebounced } from '../../hooks/useDebounced.js';
import { useLatestRequest } from '../../hooks/useLatestRequest.js';

const LIMIT = 50;

export default function HistoryTab() {
  const { t, lang, operators, services, fireToast, hasScope } = useDash();

  /* ---- filters ---- */
  const [q, setQ] = useState('');
  const [kind, setKind] = useState('');
  const [opId, setOpId] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [dueOnly, setDueOnly] = useState(false);   // solo i conti con qualcosa da saldare
  const [receipt, setReceipt] = useState('');      // '' tutte · 'true' con scontrino · 'false' senza
  const qDeb = useDebounced(q, 300);

  /* ---- data ---- */
  const [data, setData] = useState(null);   // { count, kpi } of the current filter set
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [openId, setOpenId] = useState(null);
  const [details, setDetails] = useState({}); // sale id -> SaleDetailOut | 'loading' | 'error'
  const [settle, setSettle] = useState(null);  // { id, pay }: il saldo aperto su una vendita
  const [settleBusy, setSettleBusy] = useState(false);

  const params = (offset) => ({
    kind: kind || null, date_from: dateFrom || null, date_to: dateTo || null,
    q: qDeb || null, operator_id: opId || null, due: dueOnly ? 1 : null, receipt: receipt || null, limit: LIMIT, offset,
  });

  /* Biglietto della richiesta in corso (useLatestRequest): ogni fetch ne
   * prende uno e scarta la propria risposta se nel frattempo ne è partita
   * un'altra. Senza, premendo
   * «Carica altre vendite» e cambiando subito il filtro operatrice, le 50
   * vendite della vecchia operatrice finivano in coda alla lista nuova, con un
   * conteggio in testata che non corrispondeva. */
  const req = useLatestRequest();

  useEffect(() => {
    const seq = req.begin();
    setLoading(true);
    setOpenId(null);
    salesApi.list(params(0))
      .then((r) => { if (req.isLatest(seq)) { setData(r); setItems(r.items || []); } })
      .catch((err) => {
        if (!req.isLatest(seq)) return;
        setData({ count: 0, kpi: { revenue: 0, count: 0, items_count: 0, due_total: 0 } });
        setItems([]);
        toastApiError(err, fireToast, t);
      })
      .finally(() => { if (req.isLatest(seq)) setLoading(false); });
  }, [kind, dateFrom, dateTo, qDeb, opId, dueOnly, receipt]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadMore = async () => {
    const seq = req.begin();
    setLoadingMore(true);
    try {
      const r = await salesApi.list(params(items.length));
      if (!req.isLatest(seq)) return;
      setItems((l) => [...l, ...(r.items || [])]);
    } catch (err) {
      if (!req.isLatest(seq)) return;
      toastApiError(err, fireToast, t);
    } finally {
      setLoadingMore(false);
    }
  };

  /* Saldo di un conto dalla sua riga: paga tutto quello che resta o una parte.
   * La riga, il dettaglio e il KPI «Da saldare» si aggiornano con la risposta. */
  const doSettle = async (sale) => {
    if (settleBusy || !settle) return;
    const dueCents = toCents(sale.amount_due);
    const err = paymentsError(settle.pay, dueCents, t);
    if (err) { fireToast({ msg: err, icon: 'alert' }); return; }
    const payments = resolvePayments(settle.pay, dueCents);
    if (!payments.length) { fireToast({ msg: t('Indica quanto paga la cliente', 'Enter how much the client pays'), icon: 'alert' }); return; }
    setSettleBusy(true);
    try {
      const res = await salesApi.settle(sale.id, { payments });
      const paidCents = dueCents - toCents(res.amount_due);
      setDetails((d) => ({ ...d, [sale.id]: res }));
      setItems((list) => list.map((s) => (s.id === sale.id ? { ...s, amount_due: res.amount_due } : s)));
      setData((d) => (d ? { ...d, kpi: { ...d.kpi, due_total: centsToApi(Math.max(0, toCents(d.kpi.due_total) - paidCents)) } } : d));
      setSettle(null);
      fireToast({ msg: t(`Saldo registrato · ${money(centsToEur(paidCents), 'it')}`, `Balance recorded · ${money(centsToEur(paidCents), 'en')}`), icon: 'check' });
    } catch (e) {
      toastApiError(e, fireToast, t);
    } finally {
      setSettleBusy(false);
    }
  };

  const toggleOpen = (id) => {
    if (openId === id) { setOpenId(null); return; }
    setOpenId(id);
    if (!details[id] || details[id] === 'error') {
      setDetails((d) => ({ ...d, [id]: 'loading' }));
      salesApi.get(id)
        .then((r) => setDetails((d) => ({ ...d, [id]: r })))
        .catch((err) => {
          setDetails((d) => ({ ...d, [id]: 'error' }));
          toastApiError(err, fireToast, t);
        });
    }
  };

  if (!hasScope('sales')) {
    return (
      <div className="dk-card" style={{ padding: '36px 24px', textAlign: 'center', maxWidth: 900 }}>
        <Icon name="alert" size={26} color="var(--muted-2)" />
        <div className="t-body" style={{ color: 'var(--muted)', marginTop: 10 }}>
          {t('Serve il permesso "vendite" per vedere lo storico.', 'The "sales" permission is required to view the history.')}
        </div>
      </div>
    );
  }

  const kpi = data?.kpi || { revenue: 0, count: 0, items_count: 0, due_total: 0 };
  const lineIcon = (lt) => (lt === 'gift_card' ? 'gift' : lt === 'service' ? 'scissors' : lt === 'package' ? 'tag' : 'box');

  return (
    <div style={{ maxWidth: 900 }}>
      <div className="t-sm" style={{ color: 'var(--muted)', marginBottom: 16 }}>
        {t('Tutte le vendite registrate: check-out appuntamenti e vendite da banco.', 'All recorded sales: appointment check-outs and counter sales.')}
      </div>

      {/* KPI strip (from the API kpi envelope) */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 12, marginBottom: 18 }}>
        {loading && !data ? [...Array(4)].map((_, i) => <div key={i} className="skel" style={{ height: 92, borderRadius: 16 }} />) : [
          [t('Incasso totale', 'Total revenue'), money(kpi.revenue, lang), t('per i filtri correnti', 'for the current filters'), 'wallet'],
          [t('N° vendite', 'Sales count'), String(kpi.count), t('vendite registrate', 'recorded sales'), 'box'],
          [t('Articoli venduti', 'Items sold'), String(kpi.items_count), t('righe servizi, prodotti e gift', 'service, product & gift lines'), 'gift'],
          [t('Da saldare', 'Left to pay'), money(kpi.due_total || 0, lang), t('conti ancora aperti', 'bills still open'), 'clock'],
        ].map(([l, v, cap, ic], i) => (
          <div key={i} className="dk-card" style={{ padding: '14px 16px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 6 }}>
              <Icon name={ic} size={15} color="var(--clay-ink)" /><span className="t-meta">{l}</span>
            </div>
            <div className="t-num" style={{ fontSize: 20, fontWeight: 800 }}>{v}</div>
            <div className="t-sm" style={{ color: 'var(--muted-2)', marginTop: 2 }}>{cap}</div>
          </div>
        ))}
      </div>

      {/* search + filters */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
        <div className="dk-search" style={{ flex: 1, minWidth: 180 }}>
          <Icon name="search" size={17} color="var(--muted-2)" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('Cerca per cliente…', 'Search by client…')} />
          {q && <button className="press" onClick={() => setQ('')} style={{ cursor: 'pointer', display: 'grid', placeItems: 'center' }}><Icon name="x" size={14} color="var(--muted-2)" /></button>}
        </div>
        <select value={kind} onChange={(e) => setKind(e.target.value)} style={{ ...inputCss, cursor: 'pointer', minWidth: 130 }}>
          <option value="">{t('Tutti i tipi', 'All types')}</option>
          <option value="checkout">{t('Check-out', 'Check-out')}</option>
          <option value="pos">{t('Da banco', 'Counter')}</option>
        </select>
        <select value={opId} onChange={(e) => setOpId(e.target.value)} style={{ ...inputCss, cursor: 'pointer', minWidth: 150 }}>
          <option value="">{t('Tutte le operatrici', 'All stylists')}</option>
          {operators.map((o) => <option key={o.id} value={o.id}>{opName(o)}</option>)}
        </select>
        <select value={receipt} onChange={(e) => setReceipt(e.target.value)} style={{ ...inputCss, cursor: 'pointer', minWidth: 140 }}>
          <option value="">{t('Con e senza scontrino', 'With or without receipt')}</option>
          <option value="true">{t('Con scontrino', 'With receipt')}</option>
          <option value="false">{t('Senza scontrino', 'Without receipt')}</option>
        </select>
        <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} style={inputCss} title={t('Dal', 'From')} />
        <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} style={inputCss} title={t('Al', 'To')} />
        <button onClick={() => setDueOnly((v) => !v)} aria-pressed={dueOnly}
          style={{ ...inputCss, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6, border: '1px solid ' + (dueOnly ? 'var(--ink)' : 'var(--hair)'), fontWeight: dueOnly ? 800 : 600 }}>
          <Icon name={dueOnly ? 'check' : 'clock'} size={14} color={dueOnly ? 'var(--ink)' : 'var(--muted)'} />{t('Da saldare', 'Left to pay')}
        </button>
      </div>

      <div className="t-sm" style={{ color: 'var(--muted-2)', marginBottom: 10 }}>
        {loading ? '…' : `${data?.count ?? 0} ${t('vendite', 'sales')}`}
      </div>

      {loading ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {[...Array(5)].map((_, i) => <div key={i} className="skel" style={{ height: 66, borderRadius: 14 }} />)}
        </div>
      ) : (
        <div className="dk-card" style={{ overflow: 'hidden' }}>
          {items.map((s, i) => {
            const open = openId === s.id;
            const det = details[s.id];
            const isCheckout = s.kind === 'checkout';
            const depositDeducted = Number(s.deposit_deducted) > 0;
            const dueNow = Number(s.amount_due) > 0;
            return (
              <div key={s.id} style={{ borderTop: i ? '1px solid var(--hair)' : 'none' }}>
                <button onClick={() => toggleOpen(s.id)} style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 18px', width: '100%', textAlign: 'left', cursor: 'pointer', background: 'transparent', border: 'none' }}>
                  <div style={{ width: 38, height: 38, borderRadius: 10, background: 'var(--clay-tint)', display: 'grid', placeItems: 'center', flexShrink: 0 }}>
                    <Icon name={isCheckout ? 'scissors' : 'box'} size={17} color="var(--clay-ink)" />
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 700, fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {s.client_name || t('Da banco', 'Walk-in')}
                    </div>
                    <div className="t-sm" style={{ color: 'var(--muted)', marginTop: 2, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <span style={{ fontWeight: 600, color: 'var(--clay-ink)' }}>{isCheckout ? t('Check-out', 'Check-out') : t('Da banco', 'Counter sale')}</span>
                      {isCheckout && s.appointment_id != null && <span>· {t('app.', 'appt')} #{s.appointment_id}</span>}
                      {depositDeducted && (
                        <span style={{ color: 'var(--ok)', fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                          · <Icon name="wallet" size={13} color="var(--ok)" />{t('caparra', 'deposit')} −{money(s.deposit_deducted, lang)}
                        </span>
                      )}
                      {s.receipt_issued === false && <NoReceiptBadge t={t} />}
                      {dueNow && (
                        <span style={{ fontSize: 11.5, fontWeight: 800, color: 'var(--warn)', background: 'var(--warn-tint)', padding: '2px 8px', borderRadius: 99 }}>
                          {t('Da saldare', 'Left to pay')} {money(s.amount_due, lang)}
                        </span>
                      )}
                    </div>
                  </div>
                  <div style={{ textAlign: 'right', flexShrink: 0 }}>
                    <div className="t-num" style={{ fontSize: 16, fontWeight: 800 }}>{money(s.total, lang)}</div>
                    <div className="t-sm" style={{ color: 'var(--muted-2)' }}>{saleDateLabel(s.created_at, lang)}</div>
                  </div>
                  <Icon name="chevD" size={16} color="var(--muted-2)" style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 160ms', flexShrink: 0 }} />
                </button>

                {open && (
                  <div style={{ padding: '0 18px 16px 70px' }}>
                    {det === 'loading' || !det ? (
                      <div className="skel" style={{ height: 90, borderRadius: 12 }} />
                    ) : det === 'error' ? (
                      <div className="t-sm" style={{ color: 'var(--muted-2)' }}>{t('Dettaglio non disponibile.', 'Detail unavailable.')}</div>
                    ) : (
                      <div style={{ background: 'var(--surface-2)', borderRadius: 12, padding: '6px 14px' }}>
                        {det.lines.map((l, j) => (
                          <div key={l.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '9px 0', borderTop: j ? '1px solid var(--hair)' : 'none' }}>
                            <span style={{ display: 'flex', alignItems: 'center', gap: 9, fontSize: 13.5, fontWeight: 600, minWidth: 0 }}>
                              <Icon name={lineIcon(l.line_type)} size={15} color="var(--muted)" />
                              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {saleLineLabel(l, det, { services, lang, t })}
                                {l.qty > 1 ? ' × ' + l.qty : ''}
                              </span>
                              {l.operator_name && <span className="t-sm" style={{ color: 'var(--muted-2)', flexShrink: 0 }}>· {l.operator_name}</span>}
                              {l.discount_pct > 0 && <span className="t-sm" style={{ color: 'var(--clay-ink)', fontWeight: 700, flexShrink: 0 }}>−{l.discount_pct}%</span>}
                            </span>
                            <span className="t-num" style={{ fontWeight: 700, flexShrink: 0, color: l.is_gift ? 'var(--ok)' : 'var(--ink)' }}>
                              {l.is_gift ? t('Omaggio', 'Free') : money(centsToEur(lineGrossCents(l)), lang)}
                            </span>
                          </div>
                        ))}
                        {/* il buono sotto le righe, come sullo scontrino: le righe mostrano l'importo prima del buono */}
                        {Number(det.coupon_discount) > 0 && (
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '9px 0', borderTop: '1px solid var(--hair)', color: 'var(--clay-ink)' }}>
                            <span className="t-sm" style={{ fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                              <Icon name="coupon" size={14} color="var(--clay-ink)" />{t('Buono sconto', 'Voucher')}
                            </span>
                            <span className="t-num" style={{ fontWeight: 700 }}>−{money(det.coupon_discount, lang)}</span>
                          </div>
                        )}
                        {Number(det.deposit_deducted) > 0 && (
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '9px 0', borderTop: '1px solid var(--hair)', color: 'var(--ok)' }}>
                            <span className="t-sm" style={{ fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                              <Icon name="wallet" size={14} color="var(--ok)" />{t('Caparra detratta', 'Deposit deducted')}
                            </span>
                            <span className="t-num" style={{ fontWeight: 700 }}>−{money(det.deposit_deducted, lang)}</span>
                          </div>
                        )}
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 0', borderTop: '1px solid var(--hair)' }}>
                          <span style={{ fontWeight: 700, fontSize: 14 }}>{t('Totale', 'Total')}</span>
                          <span className="t-num" style={{ fontWeight: 800, fontSize: 16 }}>{money(det.total, lang)}</span>
                        </div>
                        {(det.covered_appointment_ids || []).length > 0 && (
                          <div className="t-sm" style={{ color: 'var(--muted)', paddingBottom: 6 }}>
                            {t(`Conto unico: chiude anche ${det.covered_appointment_ids.length === 1 ? 'un’altra visita' : det.covered_appointment_ids.length + ' altre visite'} della cliente`,
                              `Single bill: it also closed ${det.covered_appointment_ids.length === 1 ? 'another visit' : det.covered_appointment_ids.length + ' other visits'} of the client`)}
                          </div>
                        )}
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: '4px 0 10px' }}>
                          {det.payments.map((p) => (
                            <span key={p.id} style={{ fontSize: 12, fontWeight: 700, color: 'var(--ink-2)', background: 'var(--surface)', border: '1px solid var(--hair)', padding: '4px 10px', borderRadius: 99 }}>
                              {methodLabel(p.method, t)} · {money(p.amount, lang)}{p.gift_card_code ? ' · ' + p.gift_card_code : ''}
                              {/* un saldo arrivato dopo: il giorno in cui la cassa l'ha contato */}
                              {paidLater(p, det) ? ' · ' + t('saldo', 'balance') + ' ' + saleDateLabel(p.created_at, lang) : ''}
                            </span>
                          ))}
                        </div>
                        {Number(det.amount_due) > 0 && (
                          <div style={{ padding: '10px 0 12px', borderTop: '1px solid var(--hair)' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                              <span style={{ flex: 1, fontWeight: 700, color: 'var(--warn)', fontSize: 13.5 }}>
                                {t('Da saldare', 'Left to pay')} {money(det.amount_due, lang)}
                              </span>
                              {settle?.id !== s.id && hasScope('sales') && (
                                <button className="dk-btn dk-btn--soft" style={{ height: 32, fontSize: 12.5 }} onClick={() => setSettle({ id: s.id, pay: emptyPayments() })}>
                                  <Icon name="wallet" size={14} />{t('Salda', 'Settle')}
                                </button>
                              )}
                            </div>
                            {settle?.id === s.id && (
                              <div style={{ marginTop: 10 }}>
                                <PaymentsPanel value={settle.pay} onChange={(pay) => setSettle((st) => ({ ...st, pay }))} dueCents={toCents(det.amount_due)}
                                  t={t} lang={lang} compact allowDue dueToggleLabel={t('Paga solo una parte', 'Pay only part')} />
                                <div style={{ display: 'flex', gap: 8, marginTop: 10, justifyContent: 'flex-end' }}>
                                  <button className="dk-btn dk-btn--ghost" style={{ height: 34, fontSize: 12.5 }} disabled={settleBusy} onClick={() => setSettle(null)}>{t('Annulla', 'Cancel')}</button>
                                  <button className="dk-btn dk-btn--clay" style={{ height: 34, fontSize: 12.5 }} disabled={settleBusy} onClick={() => doSettle(det)}>
                                    <Icon name="check" size={14} color="#fff" />{settleBusy ? t('Registrazione…', 'Recording…') : t('Registra il saldo', 'Record the balance')}
                                  </button>
                                </div>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                    <div className="t-sm" style={{ color: 'var(--muted-2)', marginTop: 8 }}>{t('Registrazione non fiscale', 'Non-fiscal record')} · #{s.id}</div>
                  </div>
                )}
              </div>
            );
          })}
          {!items.length && (
            <div className="t-sm" style={{ color: 'var(--muted-2)', padding: '36px 16px', textAlign: 'center' }}>
              {t('Nessuna vendita per i filtri selezionati.', 'No sales for the selected filters.')}
            </div>
          )}
        </div>
      )}

      {!loading && data && items.length < data.count && (
        <button className="dk-btn dk-btn--ghost" style={{ marginTop: 14, width: '100%' }} disabled={loadingMore} onClick={loadMore}>
          {loadingMore ? t('Caricamento…', 'Loading…') : t('Carica altre vendite', 'Load more sales')}
        </button>
      )}
    </div>
  );
}
