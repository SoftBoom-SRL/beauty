// lib/flowSteps.js — i passi dell'anteprima di no-show e annullamento
// (<FlowSteps> nel pannello di dettaglio).
// Logica pura: la caricano anche i test con `node --test`.
import { timeLabel } from '@youty/shared';
import { aEndMin, aStartMin, fmtMoney } from './appt.js';

/* --- Anteprima passo-passo del flusso no-show / cancellazione -------------
 * Restituiscono l'array di passi per <FlowSteps>. I contenuti rispecchiano
 * l'esito reale del backend (apps/agenda/services/transitions.py): no-show → caparra
 * trattenuta; annullamento dal gestionale → caparra SEMPRE da rimborsare, a
 * qualunque ora (la penale vale solo per la cliente che disdice tardi
 * dall'app); senza caparra nulla. L'importo è `deposit_credit`, la quota che
 * il salone ha ancora in mano: dopo un rimborso parziale di 10 € su 30 il
 * versato diceva 30 dove in gioco ne restavano 20.
 * `matchCount` = voci di lista d'attesa compatibili (null finché in caricamento). */

const _slotStep = (appt, t) => ({
  n: 3,
  title: t('Slot liberato', 'Slot freed'),
  detail: timeLabel(aStartMin(appt)) + '–' + timeLabel(aEndMin(appt)),
  tone: 'default',
});

const _waitlistStep = (matchCount, t) => ({
  n: 4,
  title: t("Proposto alla lista d'attesa", 'Offered to the waiting list'),
  detail:
    matchCount == null
      ? '…'
      : matchCount > 0
        ? t(`${matchCount} in attesa`, `${matchCount} waiting`)
        : t('nessuno compatibile', 'none matching'),
  tone: matchCount ? 'default' : 'muted',
});

const _paid = (appt) => appt.deposit_status === 'paid';
// deposit_credit manca solo da un server più vecchio: lì vale il versato
const _depEur = (appt, lang) => fmtMoney(appt.deposit_credit ?? appt.deposit_amount, lang);

export function noShowSteps(appt, matchCount, t, lang) {
  return [
    { n: 1, title: t('No-show confermato', 'No-show confirmed'), tone: 'danger' },
    _paid(appt)
      ? { n: 2, title: t('Caparra trattenuta', 'Deposit forfeited'), detail: _depEur(appt, lang), tone: 'danger' }
      : { n: 2, title: t('Nessuna caparra', 'No deposit'), detail: '—', tone: 'muted' },
    _slotStep(appt, t),
    _waitlistStep(matchCount, t),
  ];
}

/** Disdetta tardiva: mancano meno di `minHours` ore all'inizio (le stesse ore
 *  minime dell'app cliente, `cancel_min_hours` delle impostazioni). */
export function lateCancel(appt, minHours, now = Date.now()) {
  const start = Date.parse(appt?.start);
  const hours = Number(minHours);
  if (!Number.isFinite(start) || minHours == null || !Number.isFinite(hours)) return false;
  return start - now < hours * 3600000;
}

/* Quando annulla il salone il server rimborsa sempre la caparra pagata:
 * l'anteprima scriveva «Caparra trattenuta» sotto le 24 ore, la reception
 * confermava convinta di tenerla e intanto partiva il rimborso sulla carta.
 * La disdetta della CLIENTE registrata dalla reception (`opts.byClient`) segue
 * invece le regole dell'app: sotto le ore minime (`opts.minHours`) la caparra
 * resta al salone e la disdetta si segna come tardiva. */
export function cancelSteps(appt, matchCount, t, lang, opts = {}) {
  const late = !!opts.byClient && lateCancel(appt, opts.minHours, opts.now);
  let dep;
  if (!_paid(appt)) {
    dep = { n: 2, title: t('Nessuna caparra', 'No deposit'), detail: '—', tone: 'muted' };
  } else if (late) {
    dep = { n: 2, title: t('Caparra trattenuta', 'Deposit forfeited'), detail: _depEur(appt, lang), tone: 'danger' };
  } else {
    // Il rimborso avviene su Stripe se la caparra è stata pagata online; altrimenti
    // resta «da rimborsare» finché lo staff non lo conferma dal dettaglio.
    dep = { n: 2, title: t('Caparra da rimborsare', 'Deposit to refund'), detail: _depEur(appt, lang), tone: 'default' };
  }
  return [
    {
      n: 1, title: t('Cancellazione confermata', 'Cancellation confirmed'), tone: 'danger',
      ...(late ? { detail: t('Disdetta tardiva', 'Late cancellation') } : {}),
    },
    dep,
    _slotStep(appt, t),
    _waitlistStep(matchCount, t),
  ];
}
