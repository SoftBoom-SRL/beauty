// SellModal — check-out of an appointment (payment & sale), opened from the Agenda with
// openModal('sell', { appointment }). `appointment` is an AppointmentOut-shaped object.
// Blocks are pre-populated from appointment.items grouped by operator; product / extra service /
// gift-card / package / prepaid-treatment lines can be added. If deposit_status === 'paid' the
// deposit is deducted from the amount due (the API enforces Σ payments == total − deposit ±0.01,
// else 422; with «Lascia da saldare» the payments may be less and the rest stays due).
// Conto unico: the client's other open visits of the same day (GET …/other-visits) can be ticked
// into the same bill — their lines join the blocks of their stylists (visits.js). Those of the
// same «permanenza» (one after the other: agenda/lib/stay.js) arrive already ticked.
// Submit → POST /api/sales/checkout/{appointment_id} → shows CheckoutOut.breakdown.
// Optional `onDone(checkoutOut)` prop lets the caller refetch its data.
import { useEffect, useRef, useState } from 'react';
import { Icon, toastApiError } from '@youty/shared';
import DkModal from '../../../ui/DkModal.jsx';
import { useDash } from '../../../ctx.jsx';
import PaymentsPanel from '../PaymentsPanel.jsx';
import ReceiptToggle from '../ReceiptToggle.jsx';
import CouponField from '../CouponField.jsx';
import ConfirmPaymentModal from '../ConfirmPaymentModal.jsx';
import DuesBanner from '../DuesBanner.jsx';
import CheckoutDone from '../sell/CheckoutDone.jsx';
import OperatorBlock from '../sell/OperatorBlock.jsx';
import OtherVisits from '../sell/OtherVisits.jsx';
import LinePicker from '../sell/LinePicker.jsx';
import GiftCardForm from '../sell/GiftCardForm.jsx';
import PackageForm from '../sell/PackageForm.jsx';
import PrepaidForm from '../sell/PrepaidForm.jsx';
import TotalsBox from '../sell/TotalsBox.jsx';
import { useCoupon, useCouponRoom } from '../useCoupon.js';
import usePackages from '../usePackages.js';
import useClientCredit from '../useClientCredit.js';
import {
  checkoutDiscountPct, checkoutGiftLine, checkoutPackageLine, checkoutPrepaidLine, checkoutProductLine,
  checkoutServiceLine, toApiLine,
} from '../lines.js';
import { blockOperatorIds, checkoutState, depositCentsOf, visitGifts } from '../visits.js';
import useProductCatalog from '../useProductCatalog.js';
import { stayMateIds } from '../../agenda/lib/stay.js';
import { salesApi } from '../../../api/sales.js';
import { useResource } from '../../../hooks/useResource.js';
import {
  centsToEur, dueLeftCents, giftLabel, lineCents,
  money, opName, paymentsError, resolvePayments, saleTotals, svcLabel, toCents,
} from '../lib.js';

const newKey = (prefix) => prefix + Date.now() + Math.round(Math.random() * 1e4);

export default function SellModal({ appointment, onDone, onClose }) {
  const { t, lang, services, operators, opColors, fireToast, hasScope } = useDash();
  const appt = appointment || null;
  const canSell = hasScope('sales');

  /* ---- lines, pre-populated from the appointment items ----
   * line: { key, operator_id, line_type, service_id|product_id|package_id, name, unit_price, qty,
   *         discount_pct, is_gift, value, recipient_name, extra, visit_id?, list_price?, kind?,
   *         gift_service_id?, sessions? }
   * Il pagamento parte già impostato con le gift card «a trattamento» della
   * cliente che coprono servizi di questa visita (AppointmentOut.gifts): la
   * gift card per l'importo coperto e il resto in contanti, così l'operatrice
   * non deve ricordarsi del regalo né cercare il codice. Il residuo parte da
   * quanto resta DOPO la caparra già incassata (deposit_credit, non
   * deposit_amount: dopo un rimborso parziale la quota ancora in cassa è più
   * bassa); ogni carta copre solo le righe del suo servizio (giftPrefill,
   * 07-12), e una carta a sedute dà a ciascuna riga il valore di una seduta. */
  const [start] = useState(() => checkoutState([], appt ? [appt] : []));
  const [lines, setLines] = useState(start.lines);
  const [pay, setPay] = useState(start.pay);
  const [receipt, setReceipt] = useState(true);   // scontrino emesso

  /* ---- conto unico: le altre visite della cliente di oggi ---- */
  const { data: otherVisits } = useResource(() => salesApi.otherVisits(appt.id), [appt?.id], { enabled: !!appt && canSell, fallback: [] });
  const [included, setIncluded] = useState([]);   // id delle altre visite messe nel conto
  const visitsInBill = appt ? [appt, ...(otherVisits || []).filter((v) => included.includes(v.id))] : [];
  /* Una visita spuntata o tolta cambia righe, caparre e carte: righe e
   * pagamento ripartono da capo (checkoutState), le righe aggiunte al banco
   * restano. */
  const toggleVisit = (visit) => {
    picked.current = true;
    const nextIds = included.includes(visit.id) ? included.filter((id) => id !== visit.id) : [...included, visit.id];
    const next = checkoutState(lines, [appt, ...(otherVisits || []).filter((v) => nextIds.includes(v.id))]);
    setIncluded(nextIds);
    setLines(next.lines);
    setPay(next.pay);
  };

  /* Le visite della stessa permanenza (mani alle 10 con Sole, piedi alle 11
   * con Mara) arrivano già nel conto: è una visita sola per la cliente, e
   * prima si chiudeva soltanto quella su cui si era cliccato (il titolare,
   * 15/10). Una volta sola, all'arrivo della lista, e solo se nessuno ha
   * ancora toccato le spunte; le altre visite del giorno restano da spuntare. */
  const stayIds = appt ? stayMateIds(appt, otherVisits) : [];
  const picked = useRef(false);
  useEffect(() => {
    if (picked.current || !appt || !stayIds.length) return;
    picked.current = true;
    const next = checkoutState(lines, [appt, ...(otherVisits || []).filter((v) => stayIds.includes(v.id))]);
    setIncluded(stayIds);
    setLines(next.lines);
    setPay(next.pay);
  }, [otherVisits]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ---- UI state ---- */
  const [pick, setPick] = useState(null);       // { opId, type: 'product' | 'service' }
  const [pickQ, setPickQ] = useState('');

  /* ---- products for the per-block picker: prima pagina + ricerca lato server ---- */
  const { products, list: productMatches, searching: productSearching } = useProductCatalog(pick?.type === 'product' ? pickQ : '');
  const [giftForm, setGiftForm] = useState(null);       // { opId, amt, name }
  const [pkgForm, setPkgForm] = useState(null);         // { opId, packageId }
  const [prepaidForm, setPrepaidForm] = useState(null); // { opId, serviceId, sessions, amt, edited }
  const packages = usePackages(!!pkgForm);
  const credit = useClientCredit(appt?.client?.id ?? null);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState(null);   // CheckoutOut { sale, breakdown }
  const [confirmOpen, setConfirmOpen] = useState(false); // conferma prima di finalizzare
  /* Buono sconto presentato al banco: facoltativo. I premi del programma
   * fedeltà erano emessi ma non spendibili — la cassiera poteva solo scontare
   * a mano, o dire di no. Si verifica prima di incassare (useCoupon). */
  const cp = useCoupon(t);
  const { coupon } = cp;

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

  /* ---- blocks: one per stylist, in the order their lines appear ---- */
  const blockIds = blockOperatorIds(lines);
  const blockNames = {};
  [appt, ...(otherVisits || [])].forEach((v) => (v.items || []).forEach((it) => {
    if (!(it.operator_id in blockNames)) blockNames[it.operator_id] = it.operator_name;
  }));

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
  const closeForms = () => { setPick(null); setPickQ(''); setGiftForm(null); setPkgForm(null); setPrepaidForm(null); };

  const addProduct = (opId, p) => {
    setLines((ls) => [...ls, checkoutProductLine(newKey('pl'), opId, p)]);
    closeForms();
  };
  const addService = (opId, s) => {
    setLines((ls) => [...ls, checkoutServiceLine(newKey('sl'), opId, s, lang)]);
    closeForms();
  };
  const addGiftCard = () => {
    const v = centsToEur(toCents(giftForm?.amt));
    if (!(v > 0)) return;
    setLines((ls) => [...ls, checkoutGiftLine('gl' + Date.now(), giftForm.opId, v, giftForm.name, lang)]);
    closeForms();
  };
  const addPackage = (pkg) => {
    setLines((ls) => [...ls, checkoutPackageLine(newKey('kl'), pkgForm.opId, pkg, lang)]);
    closeForms();
  };
  const addPrepaid = (service, sessions, amt) => {
    const v = centsToEur(toCents(amt));
    if (!(v > 0)) return;
    setLines((ls) => [...ls, checkoutPrepaidLine(newKey('ql'), prepaidForm.opId, service, sessions, v, lang)]);
    closeForms();
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
  // cliente deve davvero (stesso ordine di finalize_sale). Con il conto unico la
  // caparra è quella di tutte le visite del conto.
  const depositCents = visitsInBill.reduce((s, v) => s + depositCentsOf(v), 0);
  const totals = saleTotals(blockIds.flatMap((oid) => linesOf(oid)), coupon, depositCents);
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
  // «Lascia da saldare»: la cliente paga adesso solo una parte, il resto resta sul conto.
  const leftCents = dueLeftCents(pay, dueCents);
  const collectCents = Math.max(0, dueCents) - leftCents;
  const excessNote = t(
    `Caparra eccedente da restituire: ${money(centsToEur(excessCents), 'it')}. Se è stata pagata online torna sulla carta della cliente, altrimenti va restituita in cassa.`,
    `Excess deposit to return: ${money(centsToEur(excessCents), 'en')}. If it was paid online it goes back to the client's card, otherwise return it at the desk.`,
  );
  const dueNote = leftCents > 0
    ? t(`Resta da saldare: ${money(centsToEur(leftCents), 'it')}`, `Left to pay: ${money(centsToEur(leftCents), 'en')}`)
    : null;

  const applyCoupon = () => cp.applyCoupon({ baseCents: couponBaseCents, clientId: appt.client?.id ?? null });
  const gifts = visitGifts(visitsInBill);

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
        ...(leftCents > 0 ? { leave_due: true } : {}),
        ...(included.length ? { extra_appointment_ids: included } : {}),
        receipt_issued: receipt,
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

  const addButtons = (oid) => [
    ['box', t('Prodotto', 'Product'), () => { closeForms(); setPick({ opId: oid, type: 'product' }); }],
    ['scissors', t('Servizio extra', 'Extra service'), () => { closeForms(); setPick({ opId: oid, type: 'service' }); }],
    ['gift', t('Gift card', 'Gift card'), () => { closeForms(); setGiftForm({ opId: oid, amt: '50', name: '' }); }],
    ['tag', t('Pacchetto', 'Package'), () => { closeForms(); setPkgForm({ opId: oid, packageId: '' }); }],
    ['wallet', t('Già pagato', 'Prepaid'), () => { closeForms(); setPrepaidForm({ opId: oid, serviceId: '', sessions: 1, amt: 0, edited: false }); }],
  ];

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
            {saving ? t('Registrazione…', 'Recording…') : <>{t('Incassa', 'Take payment')} {money(centsToEur(collectCents), lang)}</>}
          </button>
        </>
      )}>

      <div style={{ display: 'grid', gridTemplateColumns: '1.1fr 0.9fr', gap: 22, alignItems: 'start' }}>
        {/* LEFT — sale grouped by operator */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <OtherVisits visits={otherVisits} included={included} stayIds={stayIds} onToggle={toggleVisit} clientName={appt.client?.full_name} t={t} lang={lang} />
          {blockIds.map((oid) => (
            <OperatorBlock key={oid} lines={linesOf(oid)} subtotal={opSubtotal(oid)} color={opColor(oid)} initials={opInitials(oid)} label={opLabel(oid)}
              onPatch={patchLine} onRemove={removeLine} t={t} lang={lang}>
              {/* add lines to this block */}
              {pick && pick.opId === oid
                ? <LinePicker type={pick.type} q={pickQ} onQ={setPickQ} onClose={closeForms}
                  items={pickerList} products={products} searching={productSearching}
                  onPick={(x) => (pick.type === 'product' ? addProduct(oid, x) : addService(oid, x))} t={t} lang={lang} />
                : giftForm && giftForm.opId === oid ? <GiftCardForm form={giftForm} setForm={setGiftForm} onAdd={addGiftCard} onCancel={closeForms} t={t} />
                  : pkgForm && pkgForm.opId === oid ? <PackageForm packages={packages} services={services} form={pkgForm} setForm={setPkgForm} onAdd={addPackage} onCancel={closeForms} t={t} lang={lang} />
                    : prepaidForm && prepaidForm.opId === oid ? <PrepaidForm services={services} form={prepaidForm} setForm={setPrepaidForm} onAdd={addPrepaid} onCancel={closeForms} t={t} lang={lang} />
                      : (
                        <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
                          {addButtons(oid).map(([ic, l, onClick]) => (
                            <button key={ic} onClick={onClick} style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '7px 12px', borderRadius: 9, border: '1px dashed var(--hair)', background: 'var(--surface)', cursor: 'pointer', fontSize: 12.5, fontWeight: 600, color: 'var(--clay-ink)' }}>
                              <Icon name="plus" size={13} color="var(--clay-ink)" /><Icon name={ic} size={14} color="var(--clay-ink)" />{l}
                            </button>
                          ))}
                        </div>
                      )}
            </OperatorBlock>
          ))}
        </div>

        {/* RIGHT — single shared payment */}
        <div>
          {/* conti lasciati da saldare in visite di prima: si possono pagare adesso, a parte */}
          <DuesBanner key={appt.client?.id} clientId={appt.client?.id} enabled={canSell} t={t} lang={lang} fireToast={fireToast} style={{ marginBottom: 10 }} />
          {gifts.length > 0 && (
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '10px 12px', borderRadius: 12, background: 'var(--clay-tint)', marginBottom: 10 }}>
              <Icon name="gift" size={16} color="var(--clay-ink)" style={{ marginTop: 2 }} />
              <div style={{ flex: 1, minWidth: 0, fontSize: 13 }}>
                {gifts.map((g) => (
                  <div key={g.gift_card_id ?? g.code}><b>{giftLabel(g, t)}</b> · {g.service_name} ({g.code})</div>
                ))}
                <div className="t-sm" style={{ color: 'var(--ink-2)', marginTop: 2 }}>{t('Il pagamento è già impostato con la gift card per la parte coperta.', 'The payment is already set with the gift card for the covered part.')}</div>
              </div>
            </div>
          )}
          {/* buono sconto: si verifica prima, così il pagamento parte dal dovuto giusto */}
          <CouponField cp={cp} onApply={applyCoupon} discount={discount}
            label={t('Buono sconto', 'Voucher')} placeholder={t('Codice del buono (facoltativo)', 'Voucher code (optional)')}
            style={{ marginBottom: 12 }} labelStyle={{ marginBottom: 6 }} t={t} lang={lang} />
          {dueCents > 0 ? (
            <PaymentsPanel value={pay} onChange={setPay} dueCents={dueCents} t={t} lang={lang} compact allowDue={!!appt.client} cards={credit} />
          ) : (
            <div className="t-sm" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '11px 13px', borderRadius: 12, background: 'var(--ok-tint)', color: 'var(--ok)', fontWeight: 600 }}>
              <Icon name="check" size={15} color="var(--ok)" stroke={2.4} />
              {totals.depositCents > 0
                ? t('Niente da incassare: la caparra copre il conto.', 'Nothing to collect: the deposit covers the bill.')
                : t('Niente da incassare.', 'Nothing to collect.')}
            </div>
          )}
          <ReceiptToggle value={receipt} onChange={setReceipt} t={t} style={{ marginTop: 12 }} />

          {/* totals — per operator + deposit + grand */}
          <TotalsBox blockIds={blockIds} opColor={opColor} opLabel={opLabel} opSubtotal={opSubtotal}
            gross={gross} discount={discount} coupon={coupon} deposit={deposit} deductedCents={deductedCents}
            due={due} excessCents={excessCents} excessNote={excessNote} t={t} lang={lang} />
        </div>
      </div>
    </DkModal>

    {/* conferma prima di finalizzare il check-out */}
    <ConfirmPaymentModal open={confirmOpen} saving={saving} onBack={() => setConfirmOpen(false)} onConfirm={submit}
      summary={<>{money(centsToEur(collectCents), lang)}{appt.client?.full_name ? ' · ' + appt.client.full_name : ''}{included.length ? ' · ' + t(`conto unico di ${included.length + 1} visite`, `single bill for ${included.length + 1} visits`) : ''}</>}
      note={[excessCents > 0 ? excessNote : null, dueNote].filter(Boolean).join(' ') || null} t={t} />
    </>
  );
}
