// DayMoneyCard — i soldi di un giorno al passaggio sulla sua testata in vista
// settimana (GET /api/agenda/day-money): valore atteso, già fatto, entrato in
// cassa e ancora da incassare. La testata ha una cifra sola, il valore
// atteso, e non si capiva se fosse il venduto, l'incassato o il previsto (il
// titolare, 16/10). Senza hook: la mostra WeekView, che carica i dati.
import { fmtMoney } from '../lib.js';
import { dayLabel } from '../lib/calendar.js';

export const DAY_MONEY_W = 280;

/** Una riga: che cosa, quanto e da dove viene. */
function Row({ label, amount, note, tone = 'var(--ink)', lang, children = null }) {
  return (
    <div style={{ padding: '7px 0', borderTop: '1px solid var(--hair)' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <span style={{ flex: 1, fontSize: 12.5, fontWeight: 600, color: 'var(--ink-2)' }}>{label}</span>
        <span className="tabnum" style={{ fontSize: 14, fontWeight: 800, color: tone }}>{fmtMoney(amount, lang)}</span>
      </div>
      <div className="t-sm" style={{ fontSize: 11, color: 'var(--muted)', lineHeight: 1.35, marginTop: 1 }}>{note}</div>
      {children}
    </div>
  );
}

/** `tip` = { date, x, y } (sotto la testata, al centro del giorno); `money` =
 *  la risposta, 'loading' o 'error'. */
export default function DayMoneyCard({ tip, money, t, lang }) {
  const left = Math.max(8, Math.min(tip.x - DAY_MONEY_W / 2, (typeof window !== 'undefined' ? window.innerWidth : 1400) - DAY_MONEY_W - 8));
  const ready = money && typeof money === 'object';
  const num = (k) => Number(ready ? money[k] : 0) || 0;
  const pct = num('expected') > 0 ? Math.min(100, Math.round((num('done') / num('expected')) * 100)) : 0;
  return (
    <div role="tooltip" style={{ position: 'fixed', top: tip.y, left, width: DAY_MONEY_W, zIndex: 90, background: 'var(--surface)', border: '1px solid var(--hair)', borderRadius: 14, boxShadow: 'var(--sh-pop)', padding: '12px 14px 10px', pointerEvents: 'none', boxSizing: 'border-box' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6 }}>
        <span style={{ flex: 1, fontWeight: 700, fontSize: 14 }}>{dayLabel(tip.date, t)}</span>
        {ready && <span className="t-sm" style={{ color: 'var(--muted)' }}>{t(`${money.visits} visite`, `${money.visits} visits`)}</span>}
      </div>
      {money === 'error' && <div className="t-sm" style={{ color: 'var(--muted)', padding: '6px 0' }}>{t('Conti non disponibili ora: riprova fra poco.', 'Figures not available right now: try again shortly.')}</div>}
      {!ready && money !== 'error' && [0, 1, 2, 3].map((i) => <div key={i} className="skel" style={{ height: 30, borderRadius: 8, margin: '6px 0' }} />)}
      {ready && (
        <>
          <Row lang={lang} label={t('Valore atteso', 'Expected value')} amount={money.expected}
            note={t('Tutte le visite del giorno, a prezzo d’agenda (no-show esclusi): la cifra della testata.', 'All the day’s visits at agenda prices (no-shows excluded): the header figure.')} />
          <Row lang={lang} label={t('Già fatto', 'Done')} amount={money.done} tone="var(--ok)"
            note={t(`${money.closed} ${money.closed === 1 ? 'visita conclusa' : 'visite concluse'} su ${money.visits}`, `${money.closed} of ${money.visits} visits done`)}>
            <div style={{ height: 4, borderRadius: 99, background: 'var(--paper-2)', marginTop: 5, overflow: 'hidden' }}>
              <div style={{ width: pct + '%', height: '100%', borderRadius: 99, background: 'var(--ok)' }} />
            </div>
          </Row>
          <Row lang={lang} label={t('Entrato in cassa', 'Cash in')} amount={money.cash_in} tone="var(--clay-ink)"
            note={t('Il denaro arrivato quel giorno, come in Punto Vendita: anche prodotti e caparre.', 'The money that came in that day, as in Point of Sale: products and deposits too.')} />
          <Row lang={lang} label={t('Da incassare', 'To collect')} amount={money.to_collect} tone={num('to_collect') > 0 ? 'var(--warn)' : 'var(--ink)'}
            note={t('Le visite ancora da chiudere (meno la caparra già versata) e i conti lasciati da saldare.', 'Visits still to close (less deposits paid) and bills left to pay.')} />
        </>
      )}
      <div className="t-sm" style={{ color: 'var(--muted-2)', fontSize: 11, paddingTop: 6, borderTop: '1px solid var(--hair)' }}>{t('Clic: apri il giorno', 'Click: open the day')}</div>
    </div>
  );
}
