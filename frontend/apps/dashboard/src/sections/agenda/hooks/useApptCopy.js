// useApptCopy — la copia dell'appuntamento nel pannello di dettaglio, le
// modifiche in sospeso (servizi e nota) e la schermata del pannello
// (dettaglio, riprogrammazione, no-show, annullamento). Ogni versione nuova
// dell'appuntamento passa da `adopt`; `reload` la rilegge dal server, e gli
// eventi live che riguardano la visita la fanno rileggere da sé.
// Lo stato vive nel pannello che chiama: cambiando schermata resta com'è.
import { useEffect, useRef, useState } from 'react';
import { ApiError } from '@youty/shared';
import { useLive } from '../../../ctx.jsx';
import { apptVersion, editRow, eventConcerns, isOlder, itemsSig, rebaseDraft, TERMINAL } from '../modals/rules.js';
import * as agendaApi from '../agendaApi.js';
import { useLatest } from './useLatest.js';

/** Ritorna la copia (`appt`, `apptRef` per chi è in volo), la bozza (`note`,
 *  `editItems` con `mkEditItems`/`itemSeq` per le righe nuove, `addingSvc`,
 *  `rowDrafts`), la schermata (`flow`), `alive` (il pannello è ancora
 *  montato), `adopt(fresh, how, extra)`, `fetchFresh()` e `reload()`. */
export function useApptCopy({ appointment, t, fireToast, onClose }) {
  const [appt, setAppt] = useState(appointment);
  const [flow, setFlow] = useState(null); // 'reschedule' | 'noshow' | 'cancel'

  /* Le risposte possono arrivare quando al posto di questo pannello ce n'è già
   * un altro (si è aperto un altro appuntamento mentre il check-in era in
   * volo): onClose e openModal sono globali, e chiudevano quello nuovo. */
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  /* note edit (salvata insieme ai servizi, dal piede del pannello) */
  const [note, setNote] = useState(appointment?.note || '');

  /* services edit → PUT /appointments/{id} with the full items list */
  const itemSeq = useRef(1);
  const mkEditItems = (list) => (list || []).map((it) => editRow(it, 'e' + (itemSeq.current++)));
  const [editItems, setEditItems] = useState(() => mkEditItems(appointment?.items));
  const [addingSvc, setAddingSvc] = useState(false);
  // orari di riga mentre si digitano (vedi commitItemStart / commitItemEnd)
  const [rowDrafts, setRowDrafts] = useState({});

  /* ---- la copia dell'appuntamento e le modifiche in sospeso ---------------
   * `appt` è l'ultima versione nota del server; servizi e nota modificati e
   * non ancora salvati sono una bozza sopra di lei. Ogni versione nuova —
   * risposta di un comando del pannello, trascinamento o ridimensionamento in
   * griglia, «Indietro», caparra pagata online, un'altra postazione — si
   * prende sempre, e la bozza ci viene riportata sopra (rebaseDraft) invece di
   * sparire. Prima un effetto su [appt] rifaceva la lista dei servizi a ogni
   * risposta: la «Piega» appena aggiunta spariva premendo «›» o inviando il
   * link della caparra (13-05), mentre `appt` non seguiva niente di quello
   * che succedeva fuori dal pannello e i suoi comandi ripartivano da una copia
   * vecchia, disfacendo o raddoppiando le modifiche fatte intanto (13-03).
   * `how`: 'mine' = risposta di un comando del pannello, 'saved' = risposta
   * del salvataggio della bozza, 'external' = arrivata da fuori. */
  const apptRef = useRef(appointment);
  const draftRef = useRef(null);
  draftRef.current = { rows: editItems, note };
  const flowRef = useLatest(flow);
  const cmdSeq = useRef(0);
  function adopt(fresh, how = 'mine', extra = {}) {
    if (!fresh) return;
    const base = apptRef.current;
    if (how === 'external' && (isOlder(fresh, base) || apptVersion(fresh) === apptVersion(base))) return;
    if (how !== 'external') cmdSeq.current += 1;
    apptRef.current = fresh;
    setAppt(fresh);
    if (how === 'saved') {
      // la bozza è stata scritta: si riparte dalla risposta (le righe hanno id
      // nuovi), ma una nota ribattuta mentre il salvataggio era in volo resta
      const rows = mkEditItems(fresh.items);
      const n = draftRef.current.note === extra.sentNote ? (fresh.note || '') : draftRef.current.note;
      draftRef.current = { rows, note: n };
      setEditItems(rows); setNote(n); setRowDrafts({}); setAddingSvc(false);
      return;
    }
    const d = draftRef.current;
    const wasDirty = itemsSig(d.rows) !== itemsSig(base?.items) || d.note !== (base?.note || '');
    const r = rebaseDraft({ base, rows: d.rows, note: d.note, theirs: fresh });
    draftRef.current = { rows: r.rows, note: r.note };
    setEditItems(r.rows); setNote(r.note);
    if (how !== 'external') return;
    const ended = TERMINAL.includes(fresh.status) && !TERMINAL.includes(base?.status);
    if (ended && flowRef.current) {
      // no-show, annullamento o riprogrammazione a metà su una visita che
      // intanto è stata chiusa o annullata: si torna al dettaglio
      setFlow(null);
      if (!wasDirty) fireToast({ msg: t('L’appuntamento è stato chiuso o annullato nel frattempo', 'The appointment was closed or cancelled in the meantime'), icon: 'info' });
    }
    if (!wasDirty) return;
    // Chi aveva modifiche in sospeso deve sapere che sotto è cambiato qualcosa
    // che le riguarda, prima di salvarle.
    if (ended) {
      fireToast({ msg: t('L’appuntamento è stato chiuso o annullato nel frattempo: le modifiche non salvate non si possono più salvare', 'The appointment was closed or cancelled in the meantime: unsaved changes can no longer be saved'), icon: 'alert' });
    } else if (r.lost) {
      fireToast({ msg: t('I servizi sono stati modificati nel frattempo: alcune tue modifiche non salvate non valevano più e sono state tolte. Controlla prima di salvare.', 'The services were changed in the meantime: some of your unsaved changes no longer applied and were dropped. Check before saving.'), icon: 'alert' });
    } else if (itemsSig(fresh.items) !== itemsSig(base?.items) || (fresh.note || '') !== (base?.note || '')) {
      fireToast({ msg: t('Servizi o nota cambiati nel frattempo: le tue modifiche non salvate sono state riportate sulla versione nuova. Controlla prima di salvare.', 'Services or note changed in the meantime: your unsaved changes were carried over to the new version. Check before saving.'), icon: 'alert' });
    }
  }

  const fetchFresh = () => agendaApi.getAppointment(apptRef.current.id);
  const reloadSeq = useRef(0);
  async function reload() {
    if (!apptRef.current?.id) return;
    const my = ++reloadSeq.current, since = cmdSeq.current;
    try {
      const fresh = await fetchFresh();
      // una risposta partita prima di un comando del pannello, o superata da un
      // ricarico più recente, riporterebbe indietro quello che si vede
      if (!alive.current || my !== reloadSeq.current || since !== cmdSeq.current) return;
      adopt(fresh, 'external');
    } catch (err) {
      if (!alive.current) return;
      if (err instanceof ApiError && err.status === 404) {
        fireToast({ msg: t('L’appuntamento non esiste più: è stato tolto con «Indietro» o da un’altra postazione', 'The appointment no longer exists: it was undone or removed from another workstation'), icon: 'info' });
        onClose?.();
      }
    }
  }
  /* Il pannello segue l'appuntamento: si rilegge a ogni evento live che lo
   * riguarda (i propri compresi — la versione uguale non cambia niente). */
  useLive(/^(appointment|deposit|sale)\./, (events) => {
    if (events.some((e) => eventConcerns(e, apptRef.current?.id))) reload();
  });
  /* Se chi ha aperto il pannello gli passa una versione nuova della stessa
   * visita (la griglia dopo «Sposta qui»), la si prende come le altre. */
  const propRef = useRef(appointment);
  useEffect(() => {
    if (!appointment || appointment === propRef.current) return;
    propRef.current = appointment;
    if (appointment.id === apptRef.current?.id) adopt(appointment, 'external');
  }, [appointment]); // eslint-disable-line react-hooks/exhaustive-deps

  return {
    appt, flow, setFlow, alive, note, setNote, editItems, setEditItems, mkEditItems, itemSeq, addingSvc, setAddingSvc,
    rowDrafts, setRowDrafts, apptRef, adopt, fetchFresh, reload,
  };
}
