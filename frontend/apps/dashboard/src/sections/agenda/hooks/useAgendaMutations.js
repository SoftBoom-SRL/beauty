// useAgendaMutations — i gesti della vista giorno che scrivono: spostamenti
// (in griglia, «Sposta qui», su un altro giorno della striscia), stacco di un
// servizio, durata, pause, ripristino degli slot «da richiamare».
// Ogni gesto rilegge la giornata (e la pila del «torna indietro») e manda il
// suo avviso; `pending` è la sovrascrittura ottimistica che la griglia mostra
// mentre la richiesta è in volo.
// Il ricarico dopo una scrittura riuscita ha il suo `.catch`: nel `try` del
// gesto, una giornata che non si rileggeva faceva mostrare «Errore di rete»
// al posto dell'avviso del gesto, con il suo «Annulla», e la reception rifaceva
// il gesto — una seconda pausa, un secondo stacco che il server rifiuta (bug
// sospetti del 24/09, n. 49).
/* Forzatura: lo staff può andare oltre le regole (fuori turno, centro chiuso,
 * sovrapposizione) e non gli viene chiesto niente, mai. Chi lavora qui tutti
 * i giorni SA quando sta incastrando una cliente: ogni conferma era una
 * finestra da chiudere, non una protezione. Si scrive e basta, con
 * force=true, e resta l'avviso normale con «Annulla». */
import { useState } from 'react';
import { ApiError, isoAtMin, toastApiError, toDateStr } from '@youty/shared';
import { BREAK_DEFAULT_MIN } from '../constants.js';
import * as agendaApi from '../agendaApi.js';
import { aStartMin, firstName } from '../lib/appt.js';
import { isConflict, retryForced } from '../lib/retry.js';
import { moveHereTarget, moveIsNoop } from '../lib/slots.js';
import { breakAddedText, movedText, pauseMovedText, restoredText, splitText } from '../lib/toastText.js';

/** I gesti leggono ciò che serve dal render in cui si fanno (giorno a video,
 *  operatrici, permessi) e ricaricano con `fetchDay`/`fetchUndo`/`refetchAll`
 *  di useAgendaData; `undoMark`/`undoAfter` vengono da useUndo; `setSlotMenu`
 *  chiude il menu dello slot da cui è partito il gesto. */
export function useAgendaMutations({
  canWrite, noWrite, date, operators, t, fireToast,
  undoMark, undoAfter, fetchDay, fetchUndo, refetchAll, reloadOpenAppt, setSlotMenu,
}) {
  const [pending, setPending] = useState(null); // optimistic override { kind, id, startMin, opId, dur }

  /* Sposta la visita sul giorno a video, all'ora `startMin`, e con `opId` (se
   * diversa dalla colonna di partenza) passa di mano i servizi di quella
   * colonna. Ritorna true se il server ha scritto lo spostamento. */
  const moveAppt = async (a, startMin, opId, opts = {}) => {
    const fromMin = aStartMin(a);
    /* Colonna di PARTENZA del gesto: non è per forza quella dell'operatrice
     * principale. Una visita può avere i servizi divisi fra due colleghe, e
     * trascinando il gruppo di una devono cambiare mano i SUOI servizi — è
     * quello che dice `from_operator_id` al server. */
    const fromOp = opts.fromOp ?? a.operator_id;
    const toOp = opId ?? fromOp;
    const reassigned = toOp !== fromOp;
    // Il giorno di partenza conta quanto ora e colonna: vedi moveIsNoop.
    const fromDate = toDateStr(a.start);
    if (moveIsNoop(startMin, toOp, { startMin: fromMin, opId: fromOp, date: fromDate }, date)) return false;
    const otherDay = fromDate !== date;
    const mark = undoMark();   // voce più recente prima del gesto (vedi undoAfter)
    setPending({ kind: 'appt', id: a.id, startMin, opId: toOp, fromOp });
    try {
      await agendaApi.moveAppointment(a.id, {
        start: isoAtMin(date, startMin),
        // L'operatrice si manda solo se cambia davvero: mandarla sempre faceva
        // rivalidare l'idoneità anche a un semplice spostamento d'orario, e un
        // servizio tolto dall'elenco della collega bloccava il trascinamento.
        ...(reassigned ? { operator_id: toOp, from_operator_id: fromOp } : {}),
        force: !!opts.force,
      });
      const opName = firstName((operators.find((o) => o.id === toOp) || {}).first_name || '');
      // su un altro giorno l'avviso dice anche il giorno (movedText)
      const where = movedText(t, { opName, reassigned, otherDay, date, startMin });
      // `undoAfter` rilegge anche la pila di «torna indietro»
      const undoFn = undoAfter(mark);
      fireToast({
        msg: where,
        icon: 'calendar',
        undo: t('Annulla', 'Undo'),
        // Passa dal «torna indietro» del server, non da uno spostamento al
        // contrario: così l'orario torna quello di prima E il messaggio alla
        // cliente, se non è ancora partito, non parte affatto. Rifare la strada
        // al contrario ne avrebbe invece fatti partire due.
        undoFn,
      });
      // lo spostamento è scritto: un ricarico andato male non lo rende fallito
      await fetchDay().catch(() => {});
      return true;
    } catch (err) {
      if (retryForced(err, opts.force, canWrite)) {
        // Lo slot non è libero: si sposta comunque, senza fermare chi lavora.
        // `await` qui dentro: il `finally` deve aspettare il secondo tentativo.
        return await moveAppt(a, startMin, opId, { ...opts, force: true });
      }
      if (isConflict(err)) fireToast({ msg: t('Spostamento rifiutato', 'Move refused'), icon: 'alert' });
      else toastApiError(err, fireToast, t);
      await fetchDay().catch(() => {}); // revert to server truth
      return false;
    } finally { setPending(null); }
  };

  /* Stacco col trascinamento: il servizio esce dalla visita e diventa un
   * appuntamento a sé allo slot dove è stato lasciato. Come per lo spostamento,
   * uno slot occupato non ferma nessuno: si forza e lo si scrive nell'avviso.
   * Ma si prova PRIMA senza forzare, altrimenti ogni stacco su un orario libero
   * resterebbe marcato «forzato» in agenda senza motivo. */
  const splitItem = async (appt, item, startMin, opId, opts = {}) => {
    if (!canWrite) { noWrite(); return; }
    // `opts.dateIso`: lo stacco può finire su un altro giorno (forbici lasciate
    // sulla striscia in alto). Senza, la data era sempre quella a video e il
    // servizio restava qui.
    const iso = opts.dateIso || date;
    const otherDay = iso !== date;
    const mark = undoMark();
    setPending({ kind: 'appt', id: appt.id, startMin: aStartMin(appt), opId: appt.operator_id });
    try {
      await agendaApi.splitAppointment(appt.id, {
        item_id: item.id,
        start: isoAtMin(iso, startMin),
        operator_id: opId && opId !== item.operator_id ? opId : null,
        force: !!opts.force,
      });
      fireToast({
        msg: splitText(t, item.service_name, { otherDay, date: iso, startMin }),
        icon: 'scissors',
        undo: t('Annulla', 'Undo'),
        undoFn: undoAfter(mark),   // rilegge anche la pila di «torna indietro»
      });
      // lo stacco è scritto: un ricarico andato male non lo rende fallito
      await fetchDay().catch(() => {});
    } catch (err) {
      if (retryForced(err, opts.force)) {
        await splitItem(appt, item, startMin, opId, { ...opts, force: true });
        return;
      }
      toastApiError(err, fireToast, t);
      await fetchDay().catch(() => {});
    } finally { setPending(null); }
  };

  /* Appuntamento aperto nel pannello: con quello a video, un clic su uno spazio
   * libero vuol dire «spostalo qui» — è il gesto della cliente che chiama per
   * spostare, e prima bisognava indovinare l'orario e scriverlo a mano.
   * `slot` = il menu dello slot: { opId, startMin, ghostHit }. Clic sull'ombra
   * = stessa ora e stesse operatrici su questo giorno; clic su uno spazio
   * libero = quell'ora, con la colonna cliccata (vedi moveHereTarget). */
  const moveOpenApptHere = async (a, slot) => {
    setSlotMenu(null);
    if (!canWrite) { noWrite(); return; }
    // Si parte dall'appuntamento com'è ADESSO sul server: ora, giorno e
    // operatrice di partenza devono essere quelli veri, non quelli di quando
    // si è aperto il pannello (lì può essere cambiato, o altrove).
    let cur = a;
    try { cur = await agendaApi.getAppointment(a.id); } catch { /* si prova con la copia che c'è */ }
    const target = moveHereTarget(cur, slot);
    const from = { startMin: aStartMin(cur), opId: target.fromOp, date: toDateStr(cur.start) };
    if (moveIsNoop(target.startMin, target.opId ?? target.fromOp, from, date)) {
      // niente da mandare: lo si dice, invece di riaprire il pannello come
      // se lo spostamento fosse avvenuto
      fireToast({ msg: t('È già qui', 'Already here'), icon: 'info' });
      return;
    }
    await moveAppt(cur, target.startMin, target.opId, { fromOp: target.fromOp });
    // Il pannello NON si riapre: riaprirlo lo rimontava e perdeva le modifiche
    // non salvate (13-05). Si rilegge da sé con l'evento live dello
    // spostamento; qui si rinfresca subito la copia che muove l'ombra.
    reloadOpenAppt(a.id);
  };

  /* Rilascio sopra un giorno della striscia: stesso orario, giorno nuovo. */
  const moveApptToDate = async (a, iso, startMin, opts = {}) => {
    if (!canWrite) { noWrite(); return; }
    if (iso === date) { moveAppt(a, startMin, a.operator_id); return; }
    const mark = undoMark();
    try {
      // Come per gli spostamenti in griglia: prima senza forzare, così un giorno
      // libero non lascia l'appuntamento marcato «forzato» senza motivo.
      await agendaApi.moveAppointment(a.id, { start: isoAtMin(iso, startMin), force: !!opts.force });
      fireToast({
        msg: movedText(t, { reassigned: false, otherDay: true, date: iso, startMin }),
        icon: 'calendar',
        undo: t('Annulla', 'Undo'),
        undoFn: undoAfter(mark),
      });
      refetchAll();
    } catch (err) {
      if (retryForced(err, opts.force)) {
        await moveApptToDate(a, iso, startMin, { force: true });
        return;
      }
      toastApiError(err, fireToast, t);
      refetchAll();
    }
  };

  /* Rilascio fuori dalle regole (fuori turno, sopra un'altra cliente): il
   * blocco va dove è stato lasciato, punto. L'avviso raccontava ogni volta che
   * si stava «forzando» qualcosa — al banco lo sanno già, e il toast copriva
   * l'agenda nel momento di punta. Resta l'avviso normale dello spostamento,
   * con «Annulla». */
  const onInvalidDrop = (verdict, d, intent) => {
    // L'idoneità non si forza: il server rifiuta comunque (400) e forzare qui
    // voleva dire una chiamata sicuramente persa. Si dice perché, e basta.
    if (verdict.code === 'skill' || !canWrite || !intent) {
      fireToast({ msg: verdict.label + (verdict.detail ? ' · ' + verdict.detail : ''), icon: 'alert' });
      return;
    }
    /* «Orario passato» lo dice il badge, ma non è un motivo per forzare: allo
     * staff il server il passato lo concede, e forzando subito l'appuntamento
     * restava marcato «forzato» senza bisogno. Si prova normalmente; se poi lo
     * slot non è libero davvero, il 409 fa forzare come sempre. */
    const force = verdict.code !== 'past';
    if (intent.kind === 'split') {
      // Senza questo ramo lo stacco su uno slot non valido non faceva NULLA: il
      // blocco tornava al suo posto e non succedeva niente.
      splitItem(intent.appt, intent.item, intent.startMin, intent.opId, { force });
    } else if (intent.kind === 'appt') {
      moveAppt(intent.appt, intent.newApptStart, intent.opArg, { force, fromOp: intent.fromOp });
    } else if (intent.kind === 'pause') {
      movePause(intent.pause, intent.startMin, intent.opId);
    }
  };

  /* «da richiamare»: ripristino di uno slot liberato per caparra non pagata */
  const restoreReleased = async (a, force = false) => {
    try {
      await agendaApi.restoreAppointment(a.id, force);
      fireToast({ msg: restoredText(t, a.client?.full_name), icon: 'check' });
      refetchAll();
    } catch (err) {
      // Lo slot nel frattempo si è riempito: si rimette comunque dov'era. Chi
      // preme «ripristina» ha già deciso, e la barra di conferma era l'ennesima
      // finestra da chiudere.
      if (retryForced(err, force)) { restoreReleased(a, true); return; }
      toastApiError(err, fireToast, t);
    }
  };

  const movePause = async (p, startMin, opId) => {
    const mark = undoMark();
    setPending({ kind: 'pause', id: p.id, startMin, opId });
    try {
      await agendaApi.updatePause(p.id, { operator_id: opId, start: isoAtMin(date, startMin), duration_min: p.duration_min, note: p.note || '' });
      fireToast({
        msg: pauseMovedText(t, startMin),
        icon: 'clock',
        undo: t('Annulla', 'Undo'),
        undoFn: undoAfter(mark),   // rilegge anche la pila di «torna indietro»
      });
      // la pausa è spostata: un ricarico andato male non rende fallito il gesto
      await fetchDay().catch(() => {});
    } catch (err) { toastApiError(err, fireToast, t); await fetchDay().catch(() => {}); }
    finally { setPending(null); }
  };

  const resizePause = async (p, dur) => {
    if (dur === p.duration_min) return;
    setPending({ kind: 'pause', id: p.id, startMin: aStartMin(p), opId: p.operator_id, dur });
    try {
      await agendaApi.updatePause(p.id, { operator_id: p.operator_id, start: p.start, duration_min: dur, note: p.note || '' });
      // la durata è scritta: un ricarico andato male non rende fallito il gesto
      await fetchDay().catch(() => {});
      fetchUndo();   // la pila di «torna indietro» segue ogni gesto
    } catch (err) { toastApiError(err, fireToast, t); await fetchDay().catch(() => {}); }
    finally { setPending(null); }
  };

  const deletePause = async (p) => {
    const mark = undoMark();
    try {
      await agendaApi.deletePause(p.id);
      // `undoAfter` rilegge anche la pila di «torna indietro»
      fireToast({ msg: t('Pausa rimossa', 'Break removed'), icon: 'x', undo: t('Annulla', 'Undo'), undoFn: undoAfter(mark) });
      // la pausa è tolta: un ricarico andato male non rende fallito il gesto
      await fetchDay().catch(() => {});
    } catch (err) { toastApiError(err, fireToast, t); }
  };

  // #1 — resize del bordo inferiore di un blocco = nuova durata di QUEL servizio.
  // Invia l'intera lista item (il backend onora duration_min per item e non ritocca la caparra).
  const resizeItem = async (appt, item, newDur, opts = {}) => {
    if (!newDur || newDur === item.duration_min) return;
    try {
      const items = (appt.items || []).map((it) => ({
        id: it.id, service_id: it.service_id, operator_id: it.operator_id,
        duration_min: it.id === item.id ? newDur : it.duration_min,
      }));
      /* La lista dei servizi è quella a video: se nel frattempo l'appuntamento
       * è cambiato (un'altra postazione, il pannello) la si scriverebbe sopra
       * alle modifiche altrui. Con `updated_at` in mano si chiede al server di
       * scrivere solo se è ancora quello (contratto C2); senza — payload di un
       * server che non lo manda — si scrive come prima. */
      const body = { items, force: !!opts.force };
      if (appt.updated_at) body.expected_updated_at = appt.updated_at;
      await agendaApi.updateAppointment(appt.id, body);
      fireToast({ msg: t('Durata aggiornata', 'Duration updated'), icon: 'check' });
      // la durata è scritta: un ricarico andato male non rende fallito il gesto
      await fetchDay().catch(() => {});
      fetchUndo();   // la pila di «torna indietro» segue ogni gesto
    } catch (err) {
      // 412: l'appuntamento è cambiato nel frattempo. Mai forzare: si ricarica
      // la giornata e si dice perché il blocco è tornato com'è davvero.
      if (err instanceof ApiError && err.status === 412) {
        fireToast({ msg: t('L\'appuntamento è cambiato nel frattempo: giornata ricaricata, riprova', 'The appointment changed in the meantime: day reloaded, try again'), icon: 'alert' });
        await fetchDay().catch(() => {});
        return;
      }
      // Allungare un trattamento mentre accanto c'è un'altra cliente (o oltre
      // l'orario di chiusura) rispondeva «Orario non più disponibile» e il
      // blocco tornava com'era: al banco si allunga e basta, come per gli
      // spostamenti. Si riprova forzando, una volta sola.
      if (retryForced(err, opts.force, canWrite)) {
        await resizeItem(appt, item, newDur, { force: true });
        return;
      }
      toastApiError(err, fireToast, t);
      await fetchDay().catch(() => {});
    }
  };

  const addBreak = async (opId, startMin, dur) => {
    setSlotMenu(null);
    try {
      await agendaApi.createPause({ operator_id: opId, start: isoAtMin(date, startMin), duration_min: dur || BREAK_DEFAULT_MIN });
      const o = operators.find((x) => x.id === opId);
      fireToast({
        msg: breakAddedText(t, o?.first_name, startMin),
        icon: 'clock',
      });
      // la pausa è scritta: un ricarico andato male non rende fallito il gesto
      await fetchDay().catch(() => {});
      fetchUndo();   // la pila di «torna indietro» segue ogni gesto
    } catch (err) { toastApiError(err, fireToast, t); }
  };

  return {
    pending, moveAppt, splitItem, moveOpenApptHere, moveApptToDate, onInvalidDrop, restoreReleased,
    movePause, resizePause, deletePause, resizeItem, addBreak,
  };
}
