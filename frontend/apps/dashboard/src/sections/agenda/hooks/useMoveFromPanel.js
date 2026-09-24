// useMoveFromPanel — ora, giorno e operatrice dal pannello di dettaglio, senza
// passare da «Riprogramma»: l'orario scritto o spostato di un passo, i giorni
// sfogliati (l'agenda di fianco li segue) e «Passa a». Prima di mandare lo
// spostamento si rilegge la visita; al 409 si forza, come in griglia; il suo
// «Annulla» passa dal «torna indietro» del server.
import { useEffect, useState } from 'react';
import { ApiError, toastApiError, addDays, minutesOfDay, toDateStr } from '@youty/shared';
import { isoAtMin } from '../lib.js';
import { movedMeanwhile } from '../modals/rules.js';
import { withForceRetry } from '../lib/retry.js';
import { panelMovedText, undoneText, nothingToUndoText } from '../lib/toastText.js';
import * as agendaApi from '../agendaApi.js';

/** `appt`, `apptRef`, `alive`, `adopt`, `fetchFresh`, `reload` vengono da
 *  useApptCopy. Ritorna la bozza dell'orario (`timeDraft`), `movingBusy`, il
 *  giorno che si guarda (`viewDate`, `showDate`, `shiftViewDate`) e
 *  `applyMove({ startMin?, operatorId?, dateIso? })`. */
export function useMoveFromPanel({ appt, apptRef, alive, adopt, fetchFresh, reload, operators, t, fireToast, onShowDate, onMutate }) {
  /* ---- orario e operatrice, modificabili qui senza passare da «Riprogramma» ----
   * «Riprogramma» resta per cercare uno slot libero o un altro giorno; spostare
   * di un quarto d'ora o passare la cliente alla collega sono invece gesti da
   * fare sul posto, ed erano dietro un flusso a sé. */
  const [timeDraft, setTimeDraft] = useState(null);   // "HH:MM" mentre si digita
  const [movingBusy, setMovingBusy] = useState(false);
  useEffect(() => { setTimeDraft(null); }, [appt?.start]);

  /* ---- giorno da guardare -------------------------------------------------
   * «La cliente chiama e vuole spostare»: si sfogliano i giorni da qui e
   * l'agenda di fianco li mostra man mano (giorno o settimana, quella che è
   * aperta). Finché non si preme «Sposta», non si è ancora toccato niente. */
  const [viewDate, setViewDate] = useState(() => toDateStr(appt?.start));   // al primo render appt = appointment
  useEffect(() => { setViewDate(toDateStr(appt?.start)); }, [appt?.start]);
  const showDate = (iso) => {
    if (!iso) return;
    setViewDate(iso);
    onShowDate?.(iso);     // l'agenda accanto si sposta su quel giorno
  };
  const shiftViewDate = (days) => showDate(toDateStr(addDays(viewDate, days)));

  /* Spostamento dal pannello. Orario, giorno e operatrice di destinazione sono
   * calcolati su quello che si vede, quindi prima di mandarli si rilegge la
   * visita: se nel frattempo un trascinamento, «Indietro» o un'altra
   * postazione l'hanno spostata, il comando si ferma e il pannello mostra la
   * versione nuova. Prima «Passa a Bea» dopo aver trascinato il blocco dalle
   * 10 alle 14 rimandava start 10:00 e disfaceva lo spostamento (13-03). */
  async function applyMove({ startMin, operatorId, dateIso }) {
    if (movingBusy) return;
    const seen = apptRef.current;
    setMovingBusy(true);
    try {
      let base = seen;
      try {
        const fresh = await fetchFresh();
        if (!alive.current) return;
        if (movedMeanwhile(seen, fresh)) {
          adopt(fresh, 'external');
          setTimeDraft(null);
          fireToast({ msg: t('L’appuntamento è cambiato nel frattempo: controlla l’orario e riprova', 'The appointment changed in the meantime: check the time and try again'), icon: 'alert' });
          return;
        }
        base = fresh;
      } catch (err) {
        // la visita non c'è più: lo dice (e chiude) il ricarico
        if (err instanceof ApiError && err.status === 404) { reload(); return; }
        // senza la rilettura si prova lo stesso: il server valida comunque
      }
      const baseDate = toDateStr(base.start);
      const day = dateIso || baseDate;
      const from = minutesOfDay(base.start);
      const target = startMin ?? from;
      const toOp = operatorId ?? base.operator_id;
      const reassigned = toOp !== base.operator_id;
      if (target === from && !reassigned && day === baseDate) return;
      const body = {
        start: isoAtMin(day, target),
        ...(reassigned ? { operator_id: toOp, from_operator_id: base.operator_id } : {}),
      };
      // Slot occupato o fuori turno (409): si scrive lo stesso, come in griglia —
      // chi sta al banco sa quando sta incastrando. L'idoneità (400) invece no.
      const { res } = await withForceRetry((force) => agendaApi.moveAppointment(base.id, { ...body, force }));
      if (alive.current) adopt(res);
      // Il gesto da annullare è questo: se ne prende l'id subito, così
      // «Annulla» non disfa un gesto fatto dopo da un'altra scheda.
      const entry = agendaApi.getUndoStack().then((list) => (list?.[0]?.kind === 'move' ? list[0].id : null)).catch(() => null);
      const who = operators.find((x) => x.id === toOp);
      fireToast({
        // il giorno si scrive solo se cambia (panelMovedText)
        msg: panelMovedText(t, { reassigned, who, day, baseDate, target }),
        icon: 'calendar',
        undo: t('Annulla', 'Undo'),
        undoFn: () => { undoMove(entry); },
      });
      onShowDate?.(day);     // l'agenda resta su quello che si è appena fatto
      onMutate?.(res);
    } catch (err) {
      if (alive.current) setTimeDraft(null);
      toastApiError(err, fireToast, t);
    } finally { if (alive.current) setMovingBusy(false); }
  }

  /* «Annulla» dell'avviso: il «torna indietro» del server, come la griglia, e
   * poi il pannello si rilegge (le righe tornano con i loro id). Prima rifaceva
   * lo spostamento al contrario forzandolo: la visita restava «Forzata», nelle
   * visite divise la parte della collega cambiava mano, e il messaggio ancora
   * trattenuto diventava un secondo «spostato» per la cliente (13-06, 03-07,
   * 17-05). Il 409 dice il motivo vero (conto chiuso, cambiata nel frattempo,
   * posto occupato): si mostra così com'è. */
  async function undoMove(entryPromise) {
    const entryId = await entryPromise;
    try {
      const res = await agendaApi.undoGesture(entryId);
      fireToast({ msg: undoneText(t, res.label), icon: 'undo' });
      if (res.date) onShowDate?.(res.date);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) fireToast({ msg: nothingToUndoText(t), icon: 'info' });
      else toastApiError(err, fireToast, t);
    } finally {
      if (alive.current) reload();
      onMutate?.();
    }
  }

  return { timeDraft, setTimeDraft, movingBusy, viewDate, showDate, shiftViewDate, applyMove };
}
