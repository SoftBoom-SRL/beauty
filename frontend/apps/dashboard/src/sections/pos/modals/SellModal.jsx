// SellModal — check-out of an appointment (payment & sale), opened from the Agenda with
// openModal('sell', { appointment }). `appointment` is an AppointmentOut-shaped object.
// Blocks are pre-populated from appointment.items grouped by operator; product / extra service /
// gift-card lines can be added. If deposit_status === 'paid' the deposit is deducted from the
// amount due (the API enforces Σ payments == total − deposit ±0.01, else 422).
// Submit → POST /api/sales/checkout/{appointment_id} → shows CheckoutOut.breakdown.
// Optional `onDone(checkoutOut)` prop lets the caller refetch its data.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Avatar, Icon, NumInput, toastApiError } from '@youty/shared';
import DkModal from '../../../ui/DkModal.jsx';
import { useDash } from '../../../ctx.jsx';
import PaymentsPanel from '../PaymentsPanel.jsx';
import CouponField from '../CouponField.jsx';
import ConfirmPaymentModal from '../ConfirmPaymentModal.jsx';
import CheckoutDone from '../CheckoutDone.jsx';
import { useCoupon, useCouponRoom } from '../useCoupon.js';
import { apptItemLine, checkoutDiscountPct, checkoutGiftLine, checkoutProductLine, checkoutServiceLine, toApiLine } from '../lines.js';
import useProductCatalog from '../useProductCatalog.js';
import { salesApi } from '../../../api/sales.js';
import {
  centsToEur, emptyPayments, giftPrefillRows, inputCss, lineAmount, lineCents,
  money, opName, paymentsError, resolvePayments, saleTotals, svcLabel, toCents,
} from '../lib.js';

/** Caparra detraibile: la quota ancora in cassa (`deposit_credit`, al netto dei
 *  rimborsi già fatti), in centesimi. */
// Visita senza gift card: sempre lo stesso array, così l'effetto che precompila
// il pagamento non riparte a ogni render.
const NO_GIFTS = [];

const depositCentsOf = (appt) => toCents(appt.deposit_credit ?? (appt.deposit_status === 'paid' ? appt.deposit_amount : 0) ?? 0);

export default function SellModal({ appointment, onDone, onClose }) {
  const { t, lang, services, operators, opColors, fireToast, hasScope } = useDash();
  const appt = appointment || null;
  const canSell = hasScope('sales');

  /* ---- lines, pre-populated from the appointment items ---- */
  // line: { key, operator_id, line_type, service_id|product_id, name, unit_price, qty,
  //         discount_pct, is_gift, value, recipient_name, extra }
  const [lines, setLines] = useState(() => (appt?.items || []).map(apptItemLine));
  const blockIds = useMemo(
    () => [...new Set((appt?.items || []).map((it) => it.operator_id))],
    [], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const blockNames = useMemo(() => {
    const m = {};
    (appt?.items || []).forEach((it) => { if (!(it.operator_id in m)) m[it.operator_id] = it.operator_name; });
    return m;
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /* ---- UI state ---- */
  const [pick, setPick] = useState(null);       // { opId, type: 'product' | 'service' }
  const [pickQ, setPickQ] = useState('');

  /* ---- products for the per-block picker: prima pagina + ricerca lato server ---- */
  const { products, list: productMatches, searching: productSearching } = useProductCatalog(pick?.type === 'product' ? pickQ : '');
  const [giftForm, setGiftForm] = useState(null); // { opId, amt, name }
  const [pay, setPay] = useState(emptyPayments());
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState(null);   // CheckoutOut { sale, breakdown }
  const [confirmOpen, setConfirmOpen] = useState(false); // conferma prima di finalizzare
  /* Buono sconto presentato al banco: facoltativo. I premi del programma
   * fedeltà erano emessi ma non spendibili — la cassiera poteva solo scontare
   * a mano, o dire di no. Si verifica prima di incassare (useCoupon). */
  const cp = useCoupon(t);
  const { coupon } = cp;

  /* Gift card «a trattamento» della cliente che coprono servizi di questa visita
   * (AppointmentOut.gifts): il pagamento parte già impostato con la gift card
   * per l'importo coperto e il resto in contanti, così l'operatrice non deve
   * ricordarsi del regalo né cercare il codice. */
  const gifts = appt?.gifts || NO_GIFTS;
  const giftPrefilled = useRef(false);
  useEffect(() => {
    if (giftPrefilled.current || !gifts.length || !appt) return;
    // Il residuo parte da quanto resta DOPO la caparra già incassata. Prima la
    // gift card veniva messa al suo valore pieno: con un regalo da 50 € su un
    // servizio da 50 € e 30 € di caparra, il precompilato chiedeva 50 € su un
    // dovuto di 20 € e il pulsante «Incassa» restava spento senza spiegazioni.
    // deposit_credit, non deposit_amount: dopo un rimborso parziale la quota
    // ancora in cassa è più bassa, e detrarre l'intera caparra regalerebbe alla
    // cliente soldi che il salone le ha già restituito.
    // Ogni carta copre solo le righe del suo servizio (giftPrefillRows, 07-12).
    const rows = giftPrefillRows(appt.items || [], gifts, depositCentsOf(appt));
    if (!rows) return;
    giftPrefilled.current = true;
    setPay({ split: true, method: 'cash', giftCode: '', rows });
  }, [appt, gifts]);

  /* Buono applicato e conto che cambia sotto di lui: si toglie (14-12, vedi
   * useCouponRoom). */
  const couponRoomCents = saleTotals(lines, null).couponBaseCents;
  useCouponRoom(cp, couponRoomCents, t);

  if (!appt) return null;

  // Mentre il conto si registra la finestra non si chiude (Esc, X, clic fuori):
  // chiuderla perdeva il riepilogo dell'incasso appena fatto, o lasciava la
  // cassiera a chiedersi se era passato (14-10). La pila di layers.js fa già
  // chiudere prima la conferma che sta sopra.
  const closeUnlessSaving = () => { if (!saving) onClose?.(); };

  /* ---- helpers ---- */
  const opOf = (opId) => operators.find((o) => o.id === opId) || null;
  const opLabel = (opId) => { const o = opOf(opId); return o ? opName(o) : (blockNames[opId] || '#' + opId); };
  const opColor = (opId) => opColors[opId] || 'var(--clay)';
  const opInitials = (opId) => {
    const o = opOf(opId);
    if (o?.initials) return o.initials;
    return (opLabel(opId).split(' ').map((w) => w[0]).join('') || '?').slice(0, 2).toUpperCase();
  };
  const linesOf = (opId) => lines.filter((l) => l.operator_id === opId);
  const patchLine = (key, patch) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const removeLine = (key) => setLines((ls) => ls.filter((l) => l.key !== key));

  const addProduct = (opId, p) => {
    setLines((ls) => [...ls, checkoutProductLine('pl' + Date.now() + Math.round(Math.random() * 1e4), opId, p)]);
    setPick(null); setPickQ('');
  };
  const addService = (opId, s) => {
    setLines((ls) => [...ls, checkoutServiceLine('sl' + Date.now() + Math.round(Math.random() * 1e4), opId, s, lang)]);
    setPick(null); setPickQ('');
  };
  const addGiftCard = () => {
    const v = centsToEur(toCents(giftForm?.amt));
    if (!(v > 0)) return;
    setLines((ls) => [...ls, checkoutGiftLine('gl' + Date.now(), giftForm.opId, v, giftForm.name)]);
    setGiftForm(null);
  };

  /* ---- totals & deposit rule ----
   * In centesimi con gli arrotondamenti del server (money.js), sulle stesse
   * righe che partono nel payload: il pagamento deve coincidere al centesimo
   * con il totale che il server ricalcola. */
  const opSubtotal = (opId) => centsToEur(linesOf(opId).reduce((s, l) => s + lineCents(l), 0));
  // Le gift card vendute non si scontano: emetterne una da 100 incassandone 80
  // significa regalare la differenza. È la regola del server, ripetuta qui solo
  // per far vedere lo sconto giusto prima dell'incasso.
  // Il buono si applica PRIMA della caparra: l'anticipo si detrae da ciò che la
  // cliente deve davvero (stesso ordine di finalize_sale).
  const totals = saleTotals(blockIds.flatMap((oid) => linesOf(oid)), coupon, depositCentsOf(appt));
  const gross = centsToEur(totals.grossCents);
  const couponBaseCents = totals.couponBaseCents;
  const discount = centsToEur(totals.discountCents);
  const deposit = centsToEur(totals.depositCents);
  const dueCents = totals.dueCents;
  const due = centsToEur(dueCents);
  // Caparra più alta del conto (servizi tolti dopo la prenotazione, un buono,
  // un omaggio): prima il dovuto negativo spegneva «Incassa» con «rimuovi
  // qualche omaggio», e il conto non si chiudeva senza togliere lo sconto che
  // spettava alla cliente (14-02, 05-15, 17-03). Il server detrae la caparra
  // solo fino al totale e restituisce l'eccedenza (contratto C17): si incassa
  // senza pagamenti e si dice quanto torna alla cliente.
  const deductedCents = Math.min(totals.depositCents, totals.totalCents);
  const excessCents = totals.excessCents;
  const payErr = paymentsError(pay, dueCents, t);
  const excessNote = t(
    `Caparra eccedente da restituire: ${money(centsToEur(excessCents), 'it')}. Se è stata pagata online torna sulla carta della cliente, altrimenti va restituita in cassa.`,
    `Excess deposit to return: ${money(centsToEur(excessCents), 'en')}. If it was paid online it goes back to the client's card, otherwise return it at the desk.`,
  );

  const applyCoupon = () => cp.applyCoupon({ baseCents: couponBaseCents, clientId: appt.client?.id ?? null });

  /* ---- submit ---- */
  const submit = async () => {
    if (saving) return;
    if (payErr) { fireToast({ msg: payErr, icon: 'alert' }); return; }
    setSaving(true);
    try {
      const body = {
        blocks: blockIds.map((opId) => ({
          operator_id: opId,
          lines: linesOf(opId).map((l) => toApiLine(l, checkoutDiscountPct(l))),
        })),
        payments: resolvePayments(pay, dueCents),
        ...(coupon ? { coupon_code: coupon.code } : {}),
      };
      const res = await salesApi.checkout(appt.id, body);
      setResult(res);
      fireToast({ msg: t('Check-out registrato', 'Check-out recorded'), icon: 'check' });
      if (onDone) onDone(res);
    } catch (err) {
      // 400 "Appuntamento già incassato", 422 payments mismatch / gift card balance, ...
      setConfirmOpen(false);
      toastApiError(err, fireToast, t);
    } finally {
      setSaving(false);
    }
  };

  /* ---- completion state: sale summary + per-operator breakdown ---- */
  if (result) {
    return (
      <CheckoutDone result={result} depositCents={totals.depositCents} clientName={appt.client?.full_name} onClose={onClose}
        opInitials={opInitials} opColor={opColor} opLabel={opLabel} t={t} lang={lang} />
    );
  }

  /* ---- pickers ---- */
  const pickerList = pick?.type === 'product'
    ? productMatches
    : pick
      ? services.filter((s) => s.active !== false && (!pickQ || svcLabel(s, lang).toLowerCase().includes(pickQ.toLowerCase())))
      : [];

  const renderPicker = (opId) => (
    <div style={{ position: 'relative', marginTop: 10 }}>
      <div className="dk-search" style={{ width: '100%', height: 36 }}>
        <Icon name="search" size={15} color="var(--muted-2)" />
        <input autoFocus value={pickQ} onChange={(e) => setPickQ(e.target.value)}
          placeholder={pick.type === 'product' ? t('Cerca un prodotto…', 'Search a product…') : t('Cerca un servizio…', 'Search a service…')} />
        <button onClick={() => { setPick(null); setPickQ(''); }} style={{ cursor: 'pointer', display: 'grid', placeItems: 'center' }}>
          <Icon name="x" size={14} color="var(--muted-2)" />
        </button>
      </div>
      <div className="dk-card scroll" style={{ position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0, zIndex: 20, padding: 6, boxShadow: 'var(--sh-pop)', maxHeight: 200, overflowY: 'auto' }}>
        {pick.type === 'product' && products === null && <div style={{ padding: 6 }}>{[0, 1].map((i) => <div key={i} className="skel" style={{ height: 32, borderRadius: 8, marginBottom: i === 0 ? 6 : 0 }} />)}</div>}
        {pickerList.map((x) => (
          <button key={x.id} className="dk-row" onClick={() => (pick.type === 'product' ? addProduct(opId, x) : addService(opId, x))}
            style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '8px 10px', borderRadius: 8, textAlign: 'left', cursor: 'pointer' }}>
            <Icon name={pick.type === 'product' ? 'box' : 'scissors'} size={15} color="var(--muted-2)" />
            <span style={{ flex: 1, fontWeight: 600, fontSize: 13.5, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {pick.type === 'product' ? x.name : svcLabel(x, lang)}
            </span>
            <span className="t-num" style={{ fontSize: 13, color: 'var(--muted)' }}>{money(pick.type === 'product' ? x.sale_price : x.price, lang)}</span>
          </button>
        ))}
        {!pickerList.length && (pick.type !== 'product' || products !== null) && (
          <div className="t-sm" style={{ color: 'var(--muted-2)', padding: 12, textAlign: 'center' }}>
            {pick.type === 'product' ? (productSearching ? t('Ricerca nel catalogo…', 'Searching the catalogue…') : t('Nessun prodotto', 'No products')) : t('Nessun servizio', 'No services')}
          </div>
        )}
      </div>
    </div>
  );

  const renderGiftForm = () => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
      <div style={{ display: 'inline-flex', alignItems: 'center', gap: 3, border: '1px solid var(--hair)', borderRadius: 9, padding: '7px 9px', background: 'var(--surface)', width: 84, boxSizing: 'border-box' }}>
        <span style={{ color: 'var(--muted-2)', fontWeight: 700 }}>€</span>
        <NumInput autoFocus min={1} value={giftForm.amt}
          onChange={(amt) => setGiftForm((g) => ({ ...g, amt }))}
          style={{ border: 'none', outline: 'none', background: 'transparent', fontFamily: 'ui-monospace, monospace', fontWeight: 700, fontSize: 13.5, width: '100%' }} />
      </div>
      <input value={giftForm.name} onChange={(e) => setGiftForm((g) => ({ ...g, name: e.target.value }))}
        placeholder={t('Destinatario (facolt.)', 'Recipient (optional)')} style={{ ...inputCss, flex: 1, minWidth: 120 }} />
      <button className="dk-btn dk-btn--ghost" style={{ height: 34, fontSize: 12.5, padding: '0 11px' }} disabled={!(toCents(giftForm.amt) > 0)} onClick={addGiftCard}>
        <Icon name="plus" size={13} />{t('Aggiungi', 'Add')}
      </button>
      <button className="dk-iconbtn" style={{ width: 30, height: 30 }} onClick={() => setGiftForm(null)}><Icon name="x" size={14} /></button>
    </div>
  );

  const lineIcon = (l) => (l.line_type === 'gift_card' ? 'gift' : l.line_type === 'product' ? 'box' : 'scissors');

  return (
    <>
    <DkModal open onClose={closeUnlessSaving} width={900}
      title={t('Check-out · incasso e vendita', 'Check-out · payment & sale')}
      sub={(appt.client?.full_name || '') + ' · ' + t('ogni operatrice registra la sua vendita, poi un unico pagamento', 'each stylist records her sale, then one payment')}
      foot={(
        <>
          <button className="dk-btn dk-btn--ghost" onClick={closeUnlessSaving} disabled={saving}>{t('Annulla', 'Cancel')}</button>
          <button className="dk-btn dk-btn--clay" disabled={saving || !canSell || !!payErr} onClick={() => setConfirmOpen(true)}
            title={!canSell ? t('Permesso "vendite" mancante', 'Missing "sales" permission') : (payErr || undefined)}>
            <Icon name="check" size={17} color="#fff" />
            {saving ? t('Registrazione…', 'Recording…') : <>{t('Incassa', 'Take payment')} {money(Math.max(0, due), lang)}</>}
          </button>
        </>
      )}>

      <div style={{ display: 'grid', gridTemplateColumns: '1.1fr 0.9fr', gap: 22, alignItems: 'start' }}>
        {/* LEFT — sale grouped by operator */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {blockIds.map((oid) => {
            const blockLines = linesOf(oid);
            const sub = opSubtotal(oid);
            return (
              <div key={oid} style={{ border: '1px solid var(--hair)', borderRadius: 14 }}>
                {/* operator header */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '11px 14px', borderRadius: '13px 13px 0 0', background: `color-mix(in srgb, ${opColor(oid)} 14%, var(--surface))` }}>
                  <Avatar initials={opInitials(oid)} size={30} color={opColor(oid)} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 700, fontSize: 14 }}>{opLabel(oid)}</div>
                    <div className="t-sm" style={{ color: 'var(--muted)' }}>{t('Vendita accreditata', 'Sale credited')}</div>
                  </div>
                  <span className="t-num" style={{ fontWeight: 700, fontSize: 15 }}>{money(sub, lang)}</span>
                </div>

                <div style={{ padding: '4px 14px 12px' }}>
                  {blockLines.map((l) => (
                    <div key={l.key} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0', borderBottom: '1px solid var(--hair)' }}>
                      <Icon name={lineIcon(l)} size={14} color="var(--muted-2)" style={{ flexShrink: 0 }} />
                      <span style={{ flex: 1, minWidth: 0, fontSize: 13.5, fontWeight: 600, color: l.is_gift ? 'var(--ok)' : 'var(--ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {l.name}{l.line_type === 'gift_card' && l.recipient_name ? ' · ' + l.recipient_name : ''}
                      </span>
                      {l.line_type === 'product' && !l.is_gift && (
                        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 1, border: '1px solid var(--hair)', borderRadius: 8, padding: '3px 6px', height: 26, boxSizing: 'border-box', background: 'var(--surface)', flexShrink: 0 }} title={t('Sconto prodotto', 'Product discount')}>
                          <NumInput integer min={0} max={100} value={l.discount_pct}
                            onChange={(discount_pct) => patchLine(l.key, { discount_pct })}
                            style={{ width: 24, textAlign: 'right', border: 'none', outline: 'none', background: 'transparent', fontSize: 12.5, fontWeight: 700, fontFamily: 'ui-monospace, monospace' }} />
                          <span className="t-sm" style={{ color: 'var(--muted-2)', fontWeight: 700 }}>%</span>
                        </div>
                      )}
                      {l.line_type !== 'gift_card' && (
                        <button onClick={() => patchLine(l.key, { is_gift: !l.is_gift })} title={t('Ometti pagamento', 'Comp this item')} className="dk-iconbtn"
                          style={{ width: 26, height: 26, flexShrink: 0, background: l.is_gift ? 'var(--ok-tint)' : 'transparent', borderRadius: 7 }}>
                          <Icon name="gift" size={14} color={l.is_gift ? 'var(--ok)' : 'var(--muted-2)'} />
                        </button>
                      )}
                      {l.extra && (
                        <button onClick={() => removeLine(l.key)} className="dk-iconbtn" style={{ width: 26, height: 26, flexShrink: 0, borderRadius: 7 }}>
                          <Icon name="x" size={13} color="var(--muted-2)" />
                        </button>
                      )}
                      <span className="t-num" style={{ minWidth: 54, textAlign: 'right', fontSize: 13, flexShrink: 0 }}>
                        {l.is_gift
                          ? <span style={{ color: 'var(--ok)', fontWeight: 700, fontSize: 12 }}>{t('Omaggio', 'Free')}</span>
                          : money(lineAmount(l), lang)}
                      </span>
                    </div>
                  ))}

                  {/* add lines to this block */}
                  {pick && pick.opId === oid ? renderPicker(oid)
                    : giftForm && giftForm.opId === oid ? renderGiftForm()
                      : (
                        <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
                          {[
                            ['box', t('Prodotto', 'Product'), () => { setPick({ opId: oid, type: 'product' }); setPickQ(''); setGiftForm(null); }],
                            ['scissors', t('Servizio extra', 'Extra service'), () => { setPick({ opId: oid, type: 'service' }); setPickQ(''); setGiftForm(null); }],
                            ['gift', t('Gift card', 'Gift card'), () => { setGiftForm({ opId: oid, amt: '50', name: '' }); setPick(null); }],
                          ].map(([ic, l, onClick]) => (
                            <button key={ic} onClick={onClick} style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '7px 12px', borderRadius: 9, border: '1px dashed var(--hair)', background: 'var(--surface)', cursor: 'pointer', fontSize: 12.5, fontWeight: 600, color: 'var(--clay-ink)' }}>
                              <Icon name="plus" size={13} color="var(--clay-ink)" /><Icon name={ic} size={14} color="var(--clay-ink)" />{l}
                            </button>
                          ))}
                        </div>
                      )}
                </div>
              </div>
            );
          })}
        </div>

        {/* RIGHT — single shared payment */}
        <div>
          {gifts.length > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', borderRadius: 12, background: 'var(--clay-tint)', marginBottom: 10 }}>
              <Icon name="gift" size={16} color="var(--clay-ink)" />
              <div style={{ flex: 1, minWidth: 0, fontSize: 13 }}>
                <b>{t('Regalo', 'Gift')}</b> · {gifts.map((g) => `${g.service_name} (${g.code}${g.from_name ? ' · ' + t('da', 'from') + ' ' + g.from_name : ''})`).join(', ')}
                <div className="t-sm" style={{ color: 'var(--ink-2)', marginTop: 2 }}>{t('Il pagamento è già impostato con la gift card per la parte coperta.', 'The payment is already set with the gift card for the covered part.')}</div>
              </div>
            </div>
          )}
          {/* buono sconto: si verifica prima, così il pagamento parte dal dovuto giusto */}
          <CouponField cp={cp} onApply={applyCoupon} discount={discount}
            label={t('Buono sconto', 'Voucher')} placeholder={t('Codice del buono (facoltativo)', 'Voucher code (optional)')}
            style={{ marginBottom: 12 }} labelStyle={{ marginBottom: 6 }} t={t} lang={lang} />
          {dueCents > 0 ? (
            <PaymentsPanel value={pay} onChange={setPay} dueCents={dueCents} t={t} lang={lang} compact />
          ) : (
            <div className="t-sm" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '11px 13px', borderRadius: 12, background: 'var(--ok-tint)', color: 'var(--ok)', fontWeight: 600 }}>
              <Icon name="check" size={15} color="var(--ok)" stroke={2.4} />
              {totals.depositCents > 0
                ? t('Niente da incassare: la caparra copre il conto.', 'Nothing to collect: the deposit covers the bill.')
                : t('Niente da incassare.', 'Nothing to collect.')}
            </div>
          )}

          {/* totals — per operator + deposit + grand */}
          <div style={{ borderRadius: 12, padding: '14px 16px', border: '1px solid var(--hair)', background: 'var(--surface)', marginTop: 16 }}>
            {blockIds.length > 1 && blockIds.map((oid) => (
              <div key={oid} style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0' }}>
                <span className="t-sm" style={{ color: 'var(--muted)', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ width: 8, height: 8, borderRadius: 99, background: opColor(oid) }} />{opLabel(oid)}
                </span>
                <span className="t-num" style={{ fontSize: 13 }}>{money(opSubtotal(oid), lang)}</span>
              </div>
            ))}
            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0' }}>
              <span className="t-sm" style={{ color: 'var(--muted)' }}>{t('Totale lordo', 'Gross total')}</span>
              <span className="t-num" style={{ fontSize: 13 }}>{money(gross, lang)}</span>
            </div>
            {discount > 0 && (
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0', color: 'var(--clay-ink)' }}>
                <span className="t-sm" style={{ fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <Icon name="coupon" size={14} color="var(--clay-ink)" />{t('Buono', 'Voucher')} {coupon.code}
                </span>
                <span className="t-num" style={{ fontWeight: 700, fontSize: 13 }}>−{money(discount, lang)}</span>
              </div>
            )}
            {deposit > 0 && (
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0', color: 'var(--ok)' }}>
                <span className="t-sm" style={{ fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <Icon name="wallet" size={14} color="var(--ok)" />{t('Caparra detratta', 'Deposit deducted')}
                </span>
                <span className="t-num" style={{ fontWeight: 700, fontSize: 13 }}>−{money(centsToEur(deductedCents), lang)}</span>
              </div>
            )}
            <div style={{ height: 1, background: 'var(--hair)', margin: '7px 0' }} />
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
              <span style={{ fontWeight: 700 }}>{deposit > 0 ? t('Saldo da incassare', 'Balance due') : t('Totale da incassare', 'Total due')}</span>
              <span className="t-num" style={{ fontSize: 24, fontWeight: 800 }}>{money(Math.max(0, due), lang)}</span>
            </div>
            {excessCents > 0 && (
              <div className="t-sm" style={{ color: 'var(--warn)', fontWeight: 600, marginTop: 8 }}>{excessNote}</div>
            )}
          </div>
        </div>
      </div>
    </DkModal>

    {/* conferma prima di finalizzare il check-out */}
    <ConfirmPaymentModal open={confirmOpen} saving={saving} onBack={() => setConfirmOpen(false)} onConfirm={submit}
      summary={<>{money(Math.max(0, due), lang)}{appt.client?.full_name ? ' · ' + appt.client.full_name : ''}</>}
      note={excessCents > 0 ? excessNote : null} t={t} />
    </>
  );
}
