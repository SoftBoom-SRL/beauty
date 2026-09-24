// DepositDue.jsx — la caparra ancora da versare, col pulsante per pagarla.
import React from 'react';
import { ApiError, Icon, fmtEur, toDateStr, todayStr, salonTzOpts } from '@youty/shared';
import { createDepositLink } from '../api/client.js';
import { depositDueMs, depositExpired } from '../lib/appointments.js';
import { errToast } from '../lib/errors.js';

/** Caparra da versare: importo, scadenza e pulsante di pagamento.
 *  Il link si chiede al server a ogni tocco. 503 = il salone non ha i
 *  pagamenti online: si paga in sede. `onStale` (facoltativo) ricarica chi
 *  mostra l'appuntamento quando il tempo scade o il server dice che la visita
 *  non è più da pagare. */
export function DepositDue({ appt, t, lang, fireToast, compact = false, onStale }) {
  const [busy, setBusy] = React.useState(false);
  // A scadenza passata «Paga ora» sparisce da solo, anche con la pagina ferma
  // lì: un timer fino alla scadenza (setTimeout regge al più ~24 giorni: oltre
  // scatta prima e se ne rimette un altro).
  const [tick, setTick] = React.useState(0);
  const dueMs = depositDueMs(appt);
  const expired = depositExpired(appt);
  React.useEffect(() => {
    if (dueMs == null) return undefined;
    const left = dueMs - Date.now();
    if (left <= 0) return undefined;
    const id = setTimeout(() => {
      setTick((n) => n + 1);
      if (dueMs <= Date.now()) onStale?.();
    }, Math.min(left + 1000, 2147483647));
    return () => clearTimeout(id);
  }, [dueMs, tick]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!appt || appt.deposit_status !== 'required') return null;
  const amount = Number(appt.deposit_amount || 0);
  const due = appt.deposit_due_at ? new Date(appt.deposit_due_at) : null;
  const locale = lang === 'en' ? 'en-GB' : 'it-IT';
  // La scadenza è un'ora del SALONE: letta sull'orologio del telefono, «entro
  // le 10:30» diventava «09:30» per chi guarda da Londra, e la cliente pagava
  // in ritardo convinta di essere in tempo — perdendo lo slot.
  // La sola ora basta se la scadenza è oggi. Se cade domani — e con una tenuta
  // di qualche ora succede spesso — «entro le 09:30» si legge come stamattina.
  const sameDay = due && toDateStr(appt.deposit_due_at) === todayStr();
  const dueLabel = due
    ? (sameDay
      ? due.toLocaleTimeString(locale, salonTzOpts({ hour: '2-digit', minute: '2-digit' }))
      : due.toLocaleString(locale, salonTzOpts({ day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })))
    : null;

  const pay = async () => {
    if (busy || depositExpired(appt)) return;
    setBusy(true);
    try {
      // Sempre il link che il server dà ADESSO, mai `deposit_payment_link`
      // arrivato con l'appuntamento: la sessione di pagamento scade e l'importo
      // può cambiare, e solo questa chiamata la rifà. Per una visita non più
      // attiva risponde 400 con il motivo, e non si apre niente.
      const res = await createDepositLink(appt.id);
      // Dopo l'attesa il gesto è scaduto e Safari su iPhone blocca la finestra
      // nuova: il pulsante sembrava non fare niente. Si naviga nella stessa
      // scheda, e Stripe riporta qui a pagamento concluso.
      if (res?.url) window.location.assign(res.url);
      else fireToast?.({ msg: t('Link di pagamento non disponibile: contatta il salone.', 'Payment link unavailable: please contact the salon.'), icon: 'alert' });
    } catch (err) {
      if (err instanceof ApiError && err.status === 503) {
        fireToast?.({ msg: t('Il salone non accetta pagamenti online: potrai pagare in sede.', 'The salon does not take online payments: you can pay on site.'), icon: 'info' });
      } else {
        errToast(err, fireToast, t);
        if (err instanceof ApiError && err.status === 400) onStale?.();
      }
    } finally { setBusy(false); }
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 11, padding: compact ? '10px 12px' : '13px 15px', borderRadius: 'var(--r-md)', background: 'var(--warn-tint, #FDF2E3)', marginTop: 12 }}>
      <Icon name="coupon" size={18} color="var(--warn, #B4761F)" />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 700, fontSize: 13.5, color: 'var(--ink)' }}>
          {t(`Caparra di ${fmtEur(amount, lang)} da pagare`, `${fmtEur(amount, lang)} deposit to pay`)}
        </div>
        {expired ? (
          <div className="t-sm" style={{ color: 'var(--ink-2)', marginTop: 2, lineHeight: 1.4 }}>
            {t('Il tempo per pagarla è scaduto e l’orario non è più tenuto: contatta il salone.',
              'The time to pay it has run out and the slot is no longer held: please contact the salon.')}
          </div>
        ) : dueLabel && (
          <div className="t-sm" style={{ color: 'var(--ink-2)', marginTop: 2, lineHeight: 1.4 }}>
            {t(`Entro le ${dueLabel}, poi l'orario torna disponibile.`, `By ${dueLabel}, then the slot is released.`)}
          </div>
        )}
      </div>
      {!expired && (
        <button className="press" onClick={pay} disabled={busy}
          style={{ flexShrink: 0, padding: '9px 14px', borderRadius: 'var(--r-pill)', background: 'var(--brand)', color: 'var(--brand-on)', fontWeight: 700, fontSize: 13, opacity: busy ? 0.6 : 1 }}>
          {busy ? t('Attendi…', 'Wait…') : t('Paga ora', 'Pay now')}
        </button>
      )}
    </div>
  );
}
