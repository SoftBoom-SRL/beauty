// PaymentsPanel — single or split payment editor, shared by the POS cart and the SellModal.
// Controlled: `value` is the payments model from lib.js (emptyPayments()), `onChange` updates it.
// Split rows must add up to `dueCents` (the API 422s otherwise) — shows a live match indicator.
// Tutto in centesimi interi (money.js): le somme in virgola mobile dicevano
// «La somma non corrisponde» su importi giusti, o viceversa.
// `allowDue`: la cliente può pagare adesso solo una parte (`leaveDue`): col
// pagamento unico si scrive quanto paga, con quello diviso le righe possono
// sommare meno del dovuto, e il resto resta da saldare. `dueToggleLabel` è la
// scritta dell'interruttore («Lascia da saldare» in cassa, «Paga solo una
// parte» nel saldo di un conto).
// `cards`: le carte a importo della cliente (useClientCredit). Un clic paga con
// la carta; se il saldo non basta, la carta paga il suo saldo e il resto va in
// contanti (pagamento diviso).
import { Icon } from '@youty/shared';
import { PAYMENT_TOLERANCE_CENTS, canBalance, centsToEur, divHalfUp, dueLeftCents, paymentsMatch, toCents } from './money.js';
import { money, payMethods, sanitizeAmtInput } from './lib.js';

export default function PaymentsPanel({ value: v, onChange, dueCents, t, lang, compact = false, allowDue = false, dueToggleLabel, cards = [] }) {
  const methods = payMethods(t);
  const set = (patch) => onChange({ ...v, ...patch });
  const setRow = (i, patch) => set({ rows: v.rows.map((r, j) => (j === i ? { ...r, ...patch } : r)) });
  const removeRow = (i) => set({ rows: v.rows.filter((_, j) => j !== i) });
  const leaveDue = allowDue && !!v.leaveDue;

  const rowsSum = v.rows.reduce((s, r) => s + toCents(r.amt), 0);
  const ok = paymentsMatch(rowsSum, dueCents);
  const leftCents = leaveDue ? dueLeftCents(v, dueCents) : 0;
  const over = leaveDue && (v.split ? rowsSum : toCents(v.payNow)) - dueCents > PAYMENT_TOLERANCE_CENTS;

  const toggleSplit = () => {
    if (!v.split) {
      const half = divHalfUp(dueCents, 2);
      set({
        split: true,
        rows: [
          { method: v.method === 'gift_card' ? 'cash' : v.method, amt: centsToEur(half), code: '' },
          { method: 'card', amt: centsToEur(dueCents - half), code: '' },
        ],
      });
    } else {
      set({ split: false, rows: [] });
    }
  };
  const addRow = () => set({ rows: [...v.rows, { method: 'cash', amt: centsToEur(Math.max(0, dueCents - rowsSum)), code: '' }] });
  const balanceRow = (i) => {
    const others = v.rows.reduce((s, r, j) => (j === i ? s : s + toCents(r.amt)), 0);
    setRow(i, { amt: centsToEur(Math.max(0, dueCents - others)) });
  };

  const pickCard = (g) => {
    const bal = toCents(g.balance);
    if (bal >= dueCents) { set({ split: false, rows: [], method: 'gift_card', giftCode: g.code }); return; }
    set({
      split: true,
      rows: [
        { method: 'gift_card', amt: centsToEur(bal), code: g.code },
        { method: 'cash', amt: centsToEur(dueCents - bal), code: '' },
      ],
    });
  };
  const inUse = (g) => (v.split ? v.rows.some((r) => r.method === 'gift_card' && r.code === g.code) : v.method === 'gift_card' && v.giftCode === g.code);
  const creditChips = cards.length > 0 && (
    <div data-client-credit style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
      {cards.map((g) => {
        const on = inUse(g);
        return (
          <button key={g.id} type="button" onClick={() => pickCard(g)} aria-pressed={on}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 11px', borderRadius: 99, cursor: 'pointer', fontSize: 12.5, fontWeight: 700, border: '1px solid ' + (on ? 'var(--clay-ink)' : 'var(--hair)'), background: on ? 'var(--clay-tint)' : 'var(--surface)', color: 'var(--clay-ink)' }}>
            <Icon name={g.kind === 'prepaid' ? 'wallet' : 'gift'} size={13} color="var(--clay-ink)" />
            {g.kind === 'prepaid' ? t('Usa il credito', 'Use credit') : t('Usa la gift card', 'Use gift card')} · {money(g.balance, lang)}
          </button>
        );
      })}
    </div>
  );

  const methodBtn = (active, k, label, onPick, small) => (
    <button key={k} onClick={onPick} style={{
      flex: 1, padding: small ? '8px 4px' : '10px 4px', borderRadius: small ? 9 : 10,
      fontSize: small ? 12 : 13, fontWeight: 600, cursor: 'pointer',
      border: '1px solid ' + (active ? 'var(--ink)' : 'var(--hair)'),
      background: active ? 'var(--ink)' : 'var(--surface)', color: active ? '#fff' : 'var(--ink)',
      whiteSpace: 'nowrap',
    }}>{label}</button>
  );

  const codeInput = (val, onVal) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, border: '1px solid var(--hair)', borderRadius: 10, padding: '9px 12px', background: 'var(--surface)' }}>
      <Icon name="gift" size={15} color="var(--clay-ink)" />
      <input value={val} onChange={(e) => onVal(e.target.value.toUpperCase())}
        placeholder={t('Codice gift card…', 'Gift card code…')} spellCheck={false}
        style={{ flex: 1, border: 'none', outline: 'none', background: 'transparent', fontSize: 13.5, fontWeight: 700, fontFamily: 'ui-monospace, monospace', letterSpacing: '0.04em', minWidth: 0 }} />
    </div>
  );

  const amountBox = (val, onVal, onBlur) => (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 3, border: '1px solid var(--hair)', borderRadius: 9, padding: '7px 9px', background: 'var(--surface)', width: 88, boxSizing: 'border-box', flexShrink: 0 }}>
      <span style={{ color: 'var(--muted-2)', fontWeight: 700 }}>€</span>
      <input type="text" inputMode="decimal" value={val}
        onChange={(e) => onVal(sanitizeAmtInput(e.target.value))} onBlur={onBlur}
        placeholder="0,00"
        style={{ border: 'none', outline: 'none', background: 'transparent', fontFamily: 'ui-monospace, monospace', fontWeight: 700, fontSize: 13.5, width: '100%' }} />
    </div>
  );

  // «Resta da saldare»: quanto la cliente lascia sul conto con questi pagamenti.
  const dueNote = leaveDue && (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 12px', borderRadius: 10, marginTop: 10, background: over ? 'var(--danger-tint)' : 'var(--warn-tint)' }}>
      <span className="t-sm" style={{ fontWeight: 700, color: over ? 'var(--danger)' : 'var(--warn)', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
        <Icon name={over ? 'alert' : 'clock'} size={14} color={over ? 'var(--danger)' : 'var(--warn)'} />
        {over ? t('Più del dovuto', 'More than due') : t('Resta da saldare', 'Left to pay')}
      </span>
      <span className="t-num" style={{ fontWeight: 700, color: over ? 'var(--danger)' : 'var(--warn)' }}>{money(centsToEur(over ? 0 : leftCents), lang)}</span>
    </div>
  );

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 8, gap: 12 }}>
        <div className="t-meta" style={{ flex: 1 }}>{t('Metodo di pagamento', 'Payment method')}</div>
        {allowDue && (
          <button onClick={() => set({ leaveDue: !v.leaveDue, payNow: '' })} aria-pressed={leaveDue}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 5, cursor: 'pointer', background: 'transparent', border: 'none', fontSize: 12.5, fontWeight: 700, color: leaveDue ? 'var(--warn)' : 'var(--muted)' }}>
            <Icon name={leaveDue ? 'check' : 'clock'} size={13} color={leaveDue ? 'var(--warn)' : 'var(--muted)'} />
            {dueToggleLabel || t('Lascia da saldare', 'Leave to pay later')}
          </button>
        )}
        <button onClick={toggleSplit} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, cursor: 'pointer', background: 'transparent', border: 'none', fontSize: 12.5, fontWeight: 700, color: v.split ? 'var(--clay-ink)' : 'var(--muted)' }}>
          <Icon name={v.split ? 'check' : 'plus'} size={13} color={v.split ? 'var(--clay-ink)' : 'var(--muted)'} />
          {t('Pagamento diviso', 'Split payment')}
        </button>
      </div>
      {creditChips}

      {!v.split ? (
        <div>
          <div style={{ display: 'flex', gap: compact ? 6 : 8 }}>
            {methods.map(([k, l]) => methodBtn(v.method === k, k, l, () => set({ method: k }), compact))}
          </div>
          {v.method === 'gift_card' && codeInput(v.giftCode, (code) => set({ giftCode: code }))}
          {leaveDue && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10 }}>
              <span className="t-sm" style={{ flex: 1, color: 'var(--muted)', fontWeight: 600 }}>{t('Paga adesso', 'Paying now')}</span>
              {amountBox(v.payNow, (payNow) => set({ payNow }))}
            </div>
          )}
          {dueNote}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {v.rows.map((r, i) => (
            <div key={i}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div style={{ display: 'flex', gap: 5, flex: 1, minWidth: 0 }}>
                  {methods.map(([k, l]) => methodBtn(r.method === k, k, l, () => setRow(i, { method: k }), true))}
                </div>
                {/* con «Lascia da saldare» le righe non si pareggiano da sole: la differenza resta da saldare.
                    Nemmeno la riga di una carta a sedute (`sessions`): vale le sue sedute, e
                    abbassando i contanti la differenza finiva lì — una seduta da 30 € scalava
                    40 € dal pacchetto, e alle sedute dopo restava meno valore. */}
                {amountBox(r.amt, (amt) => setRow(i, { amt }), () => { if (canBalance(v, i, leaveDue)) balanceRow(i === 0 ? 1 : 0); })}
                {v.rows.length > 2 && (
                  <button className="dk-iconbtn" style={{ width: 28, height: 28, flexShrink: 0 }} onClick={() => removeRow(i)} title={t('Rimuovi', 'Remove')}>
                    <Icon name="x" size={13} color="var(--muted-2)" />
                  </button>
                )}
              </div>
              {r.method === 'gift_card' && codeInput(r.code, (code) => setRow(i, { code }))}
              {r.method === 'gift_card' && r.sessions > 0 && (
                <div className="t-sm" style={{ color: 'var(--clay-ink)', fontWeight: 600, marginTop: 4 }}>
                  {r.sessions === 1 ? t('Scala 1 seduta', 'Uses 1 session') : t(`Scala ${r.sessions} sedute`, `Uses ${r.sessions} sessions`)}
                </div>
              )}
            </div>
          ))}
          <button onClick={addRow} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, alignSelf: 'flex-start', padding: '6px 11px', borderRadius: 9, border: '1px dashed var(--hair)', background: 'var(--surface)', cursor: 'pointer', fontSize: 12.5, fontWeight: 600, color: 'var(--clay-ink)' }}>
            <Icon name="plus" size={13} color="var(--clay-ink)" />{t('Aggiungi metodo', 'Add method')}
          </button>
          {leaveDue ? dueNote : (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 12px', borderRadius: 10, background: ok ? 'var(--ok-tint)' : 'var(--warn-tint)' }}>
              <span className="t-sm" style={{ fontWeight: 700, color: ok ? 'var(--ok)' : 'var(--warn)', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                <Icon name={ok ? 'check' : 'alert'} size={14} color={ok ? 'var(--ok)' : 'var(--warn)'} />
                {ok ? t('Importi corrispondenti', 'Amounts match') : t('La somma non corrisponde', 'Sum does not match')}
              </span>
              <span className="t-num" style={{ fontWeight: 700, color: ok ? 'var(--ok)' : 'var(--warn)' }}>{money(centsToEur(rowsSum), lang)} / {money(centsToEur(dueCents), lang)}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
