// visitLib.js — regole sulle visite della cliente (logica pura, senza React:
// la usano lib.jsx e Prenota, e i test la provano da sola).

/** Scadenza della caparra da versare, in ms (null se non c'è). */
export function depositDueMs(appt) {
  if (!appt || appt.deposit_status !== 'required' || !appt.deposit_due_at) return null;
  const ms = new Date(appt.deposit_due_at).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/** La caparra è ancora da pagare ma il tempo per farlo è finito: l'orario
 *  non è più tenuto. Il «Paga ora» restava e apriva il link vecchio: il
 *  pagamento arrivava dopo il rilascio e finiva in un rimborso, mentre il
 *  ritorno nell'app diceva «Ci vediamo in salone» (16-05). */
export function depositExpired(appt, now = Date.now()) {
  const due = depositDueMs(appt);
  return due != null && due <= now;
}
