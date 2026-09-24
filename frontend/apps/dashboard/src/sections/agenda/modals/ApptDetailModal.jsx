// ApptDetailModal — full appointment detail: lifecycle actions, note edit, margin,
// reschedule via availability + move, freed-slot waitlist hand-off on cancel/no-show.
import React, { useEffect, useRef, useState } from 'react';
import { api, ApiError, Avatar, Icon, fmtEur, fmtDur, timeLabel, minutesOfDay, fmtDateIt, todayStr, toDateStr, statusMeta, depositMeta, NumInput, parseISO } from '@youty/shared';
import DkPanel from '../../../ui/DkPanel.jsx';
import FlowSteps from '../FlowSteps.jsx';
import { useDash, useLive } from '../../../ctx.jsx';
import { aStartMin, aEndMin, initialsOf, toastErr, fmtMoney, wlMatches, noShowSteps, cancelSteps, lateCancel, isoAtMin, hmToMin } from '../lib.js';
import { depositDueLabel, apptVersion, isOlder, movedMeanwhile, eventConcerns, editRow, rebaseDraft, itemsSig, joinReason, reasonNoteMax, canMarkNoShow, MAX_ITEM_MIN, copyText, usableCode, slotReassignment } from './rules.js';

const TERMINAL = ['closed', 'no_show', 'cancelled'];

// Motivazioni predefinite: il titolare può sostituirle dalle Impostazioni
// (settings.no_show_reasons / cancel_reasons); qui restano come fallback.
const NOSHOW_REASONS = [['cliente', 'Mancata presenza', 'No-show'], ['salute', 'Malattia / imprevisto', 'Illness / emergency'], ['altro', 'Altro', 'Other']];
const CANCEL_REASONS = [['cliente', 'Richiesta cliente', 'Client request'], ['salute', 'Malattia', 'Illness'], ['agenda', 'Sovrapposizione', 'Schedule clash'], ['altro', 'Altro', 'Other']];
const customReasons = (list, fallback) => (Array.isArray(list) && list.length ? list.map((r, i) => ['c' + i, r, r]) : fallback);

/* campo orario di una riga servizio: stretto, tabellare, come gli altri numeri */
const timeCellCss = {
  width: 92, border: '1px solid var(--hair)', borderRadius: 8, padding: '5px 6px',
  fontSize: 12.5, fontFamily: 'var(--mono, monospace)', fontWeight: 700, textAlign: 'center',
  outline: 'none', background: 'var(--surface)', color: 'var(--ink)',
};

export default function ApptDetailModal({ appointment, onMutate, onClose, onShowDate }) {
  const { t, lang, operators, opColors, services, serviceCategories, settings, session, fireToast, openModal, setTab, setDeepLink, setSelClient, hasScope } = useDash();
  const canWrite = hasScope('agenda');
  const [appt, setAppt] = useState(appointment);
  const [flow, setFlow] = useState(null); // 'reschedule' | 'noshow' | 'cancel'
  const [reason, setReason] = useState(null);
  const [reasonNote, setReasonNote] = useState('');
  // Annullamento: chi l'ha chiesto. La cliente che disdice al telefono (l'app
  // sotto le ore minime la manda dal salone) ha le regole dell'app: in ritardo
  // la caparra resta al salone. Prima la reception poteva solo annullare «come
  // salone», e la penale non si applicava mai.
  const [cancelByClient, setCancelByClient] = useState(false);
  const cancelMinHours = settings?.cancel_min_hours ?? 24;
  const [busy, setBusy] = useState(false);
  const noShowReasons = customReasons(settings?.no_show_reasons, NOSHOW_REASONS);
  const cancelReasons = customReasons(settings?.cancel_reasons, CANCEL_REASONS);
  const [linkBusy, setLinkBusy] = useState(false);

  /* Le risposte possono arrivare quando al posto di questo pannello ce n'è già
   * un altro (si è aperto un altro appuntamento mentre il check-in era in
   * volo): onClose e openModal sono globali, e chiudevano quello nuovo. */
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  /* note edit (salvata insieme ai servizi, dal piede del pannello) */
  const [note, setNote] = useState(appointment?.note || '');
  const noteDirty = note !== (appt?.note || '');

  /* services edit → PUT /appointments/{id} with the full items list */
  const itemSeq = useRef(1);
  const mkEditItems = (list) => (list || []).map((it) => editRow(it, 'e' + (itemSeq.current++)));
  const [editItems, setEditItems] = useState(() => mkEditItems(appointment?.items));
  const [addingSvc, setAddingSvc] = useState(false);
  const [savingItems, setSavingItems] = useState(false);
  const [justAdded, setJustAdded] = useState(null); // riga appena aggiunta: la si porta in vista
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
  const flowRef = useRef(flow);
  flowRef.current = flow;
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

  const fetchFresh = () => api.get(`/api/agenda/appointments/${apptRef.current.id}`);
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

  /* link di pagamento della caparra: crea (o rimanda come sollecito) e copia */
  async function sendDepositLink() {
    if (linkBusy) return;
    setLinkBusy(true);
    try {
      const cur = apptRef.current;
      const res = await api.post(`/api/sales/appointments/${cur.id}/deposit-link`, {});
      if (alive.current) adopt({ ...apptRef.current, deposit_payment_link: res.url, deposit_due_at: res.due_at || apptRef.current.deposit_due_at });
      fireToast({ msg: cur.deposit_payment_link ? t('Sollecito inviato alla cliente', 'Reminder sent to the client') : t('Link di pagamento inviato alla cliente', 'Payment link sent to the client'), icon: 'check' });
      onMutate?.(apptRef.current);
    } catch (err) {
      if (err instanceof ApiError && err.status === 503) fireToast({ msg: t('Pagamenti online non configurati: collega Stripe in Impostazioni → Pagamenti', 'Online payments not configured: connect Stripe in Settings → Payments'), icon: 'alert' });
      else toastErr(err, t, fireToast);
    } finally { if (alive.current) setLinkBusy(false); }
  }
  /* Caparra incassata al banco (contanti o POS del salone). Senza questo,
   * l'unico modo di segnarla pagata era il pagamento online: dove Stripe non
   * è configurato — o quando la cliente paga di persona — il termine scadeva
   * lo stesso e lo slot si liberava da solo. */
  async function cashDeposit(method) {
    if (linkBusy) return;
    setLinkBusy(true);
    try {
      const res = await api.post(`/api/agenda/appointments/${apptRef.current.id}/deposit-cashed`, { method });
      if (alive.current) adopt(res);
      fireToast({ msg: t('Caparra incassata e registrata in cassa', 'Deposit cashed and recorded in the till'), icon: 'check' });
      onMutate?.(res);
    } catch (err) { toastErr(err, t, fireToast); }
    finally { if (alive.current) setLinkBusy(false); }
  }

  /* conteggio lista d'attesa compatibile per il passo ④ della timeline (anteprima) */
  const [matchCount, setMatchCount] = useState(null);
  useEffect(() => {
    if (flow !== 'noshow' && flow !== 'cancel') return;
    setMatchCount(null);
    api.get('/api/agenda/waitlist')
      .then((wl) => setMatchCount(wlMatches(wl, appt).length))
      .catch(() => setMatchCount(null));
  }, [flow]); // eslint-disable-line react-hooks/exhaustive-deps

  /* enrich with client stats (visits, spend, categories, deposit_always) */
  const [clientDetail, setClientDetail] = useState(null);
  useEffect(() => {
    if (appt?.client?.id) api.get(`/api/clients/${appt.client.id}`).then(setClientDetail).catch(() => {});
  }, [appt?.client?.id]);

  /* Il servizio appena aggiunto finisce in fondo alla lista, spesso sotto il
   * bordo del pannello: lo si porta in vista e lo si illumina un istante, così
   * si vede dove è andato e su chi. */
  const addedRef = useRef(null);
  useEffect(() => {
    if (!justAdded) return undefined;
    addedRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    const id = setTimeout(() => setJustAdded(null), 1800);
    return () => clearTimeout(id);
  }, [justAdded]);

  /* ---- orario e operatrice, modificabili qui senza passare da «Riprogramma» ----
   * «Riprogramma» resta per cercare uno slot libero o un altro giorno; spostare
   * di un quarto d'ora o passare la cliente alla collega sono invece gesti da
   * fare sul posto, ed erano dietro un flusso a sé. */
  const stepMin = settings?.slot_interval_min || 15;
  const [timeDraft, setTimeDraft] = useState(null);   // "HH:MM" mentre si digita
  const [movingBusy, setMovingBusy] = useState(false);
  useEffect(() => { setTimeDraft(null); }, [appt?.start]);

  /* ---- giorno da guardare -------------------------------------------------
   * «La cliente chiama e vuole spostare»: si sfogliano i giorni da qui e
   * l'agenda di fianco li mostra man mano (giorno o settimana, quella che è
   * aperta). Finché non si preme «Sposta», non si è ancora toccato niente. */
  const [viewDate, setViewDate] = useState(() => toDateStr(appointment?.start));
  useEffect(() => { setViewDate(toDateStr(appt?.start)); }, [appt?.start]);
  const showDate = (iso) => {
    if (!iso) return;
    setViewDate(iso);
    onShowDate?.(iso);     // l'agenda accanto si sposta su quel giorno
  };
  const shiftViewDate = (days) => {
    const d = parseISO(viewDate);
    d.setDate(d.getDate() + days);
    showDate(toDateStr(d));
  };

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
      let res;
      try {
        res = await api.post(`/api/agenda/appointments/${base.id}/move`, { ...body, force: false });
      } catch (err) {
        // Slot occupato o fuori turno: si scrive lo stesso, come in griglia — chi
        // sta al banco sa quando sta incastrando. L'idoneità (400) invece no.
        if (!(err instanceof ApiError && err.status === 409)) throw err;
        res = await api.post(`/api/agenda/appointments/${base.id}/move`, { ...body, force: true });
      }
      if (alive.current) adopt(res);
      // Il gesto da annullare è questo: se ne prende l'id subito, così
      // «Annulla» non disfa un gesto fatto dopo da un'altra scheda.
      const entry = api.get('/api/agenda/undo').then((list) => (list?.[0]?.kind === 'move' ? list[0].id : null)).catch(() => null);
      const who = operators.find((x) => x.id === toOp);
      const when = day === baseDate ? timeLabel(target) : `${fmtDateIt(day)} · ${timeLabel(target)}`;
      fireToast({
        msg: reassigned
          ? t(`Passato a ${who?.first_name || ''}, ${when}`, `Moved to ${who?.first_name || ''}, ${when}`)
          : t(`Spostato · ${when}`, `Moved · ${when}`),
        icon: 'calendar',
        undo: t('Annulla', 'Undo'),
        undoFn: () => { undoMove(entry); },
      });
      onShowDate?.(day);     // l'agenda resta su quello che si è appena fatto
      onMutate?.(res);
    } catch (err) {
      if (alive.current) setTimeDraft(null);
      toastErr(err, t, fireToast);
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
      const res = await api.post('/api/agenda/undo', entryId ? { entry_id: entryId } : {});
      fireToast({ msg: t('Annullato · ' + res.label, 'Undone · ' + res.label), icon: 'undo' });
      if (res.date) onShowDate?.(res.date);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) fireToast({ msg: t('Non c\'è più niente da annullare', 'Nothing left to undo'), icon: 'info' });
      else toastErr(err, t, fireToast);
    } finally {
      if (alive.current) reload();
      onMutate?.();
    }
  }

  /* margin (behind a small toggle) — si rilegge quando cambiano servizi,
   * operatrici o prezzo: restava quello di prima del salvataggio (13-24). */
  const [showMargin, setShowMargin] = useState(false);
  const [margin, setMargin] = useState(null);
  const marginKey = appt ? `${appt.id}|${itemsSig(appt.items)}|${appt.total_price}|${appt.status}` : '';
  useEffect(() => {
    if (!showMargin || !appt?.id) return undefined;
    let on = true;
    setMargin(null);
    api.get(`/api/agenda/appointments/${appt.id}/margin`)
      .then((m) => { if (on) setMargin(m); })
      .catch((err) => { if (on) { toastErr(err, t, fireToast); setShowMargin(false); } });
    return () => { on = false; };
  }, [showMargin, marginKey]); // eslint-disable-line react-hooks/exhaustive-deps

  /* «No-show» compare quando la visita è cominciata: col pannello aperto da
   * prima dell'orario si ridisegna a quell'ora, senza doverlo riaprire. */
  const [, setClockTick] = useState(0);
  useEffect(() => {
    if (appt?.status !== 'confirmed') return undefined;
    const wait = Date.parse(appt.start) - Date.now();
    if (!(wait > 0) || wait > 12 * 3600000) return undefined;
    const id = setTimeout(() => setClockTick((n) => n + 1), wait + 1000);
    return () => clearTimeout(id);
  }, [appt?.status, appt?.start]);

  /* «Copia link»: la conferma si dà solo se la copia è riuscita; se non lo è,
   * il link resta scritto nel pannello da copiare a mano (13-25). */
  const [linkCopyFailed, setLinkCopyFailed] = useState(false);
  async function copyDepositLink() {
    const ok = await copyText(apptRef.current?.deposit_payment_link);
    if (!alive.current) return;
    setLinkCopyFailed(!ok);
    fireToast(ok
      ? { msg: t('Link copiato', 'Link copied'), icon: 'check' }
      : { msg: t('Copia non riuscita: il link è scritto nel pannello, selezionalo e copialo a mano', 'Copy failed: the link is shown in the panel, select it and copy it by hand'), icon: 'alert' });
  }

  if (!appt) return null;
  const o = operators.find((x) => x.id === appt.operator_id);
  const col = opColors[appt.operator_id] || 'var(--clay)';
  const sm = statusMeta(appt.status, t);
  const dm = depositMeta(appt.deposit_status, t);
  const startMin = aStartMin(appt), endMin = aEndMin(appt);
  // toDateStr e non slice(0, 10): `start` è l'istante in UTC, e il giorno
  // del salone può essere quello dopo (appuntamento delle 23:30).
  const dateStr = toDateStr(appt.start);
  const terminal = TERMINAL.includes(appt.status);

  /* ---- editable services (only when live + can write) ---- */
  const itemsEditable = !terminal && canWrite;
  const canMove = itemsEditable;
  /* Chi può prendersi la visita: le colleghe abilitate a TUTTI i servizi che
   * oggi sono dell'operatrice principale (sono quelli che cambiano mano, come
   * nel trascinamento in agenda). Il server rifiuterebbe le altre. */
  const mainItems = (appt.items || []).filter((it) => (it.operator_id ?? appt.operator_id) === appt.operator_id);
  const visitOps = operators.filter((op) => op.id === appt.operator_id
    || (mainItems.length > 0 && mainItems.every((it) => (op.service_ids || []).includes(it.service_id))));
  const otherOpNames = [...new Set((appt.items || [])
    .filter((it) => it.operator_id && it.operator_id !== appt.operator_id)
    .map((it) => operators.find((x) => x.id === it.operator_id)?.first_name || it.operator_name)
    .filter(Boolean))];

  const commitTime = () => {
    const v = timeDraft;
    setTimeDraft(null);
    if (!v || !/^\d{1,2}:\d{2}$/.test(v)) return;
    const m = hmToMin(v);
    if (!Number.isFinite(m) || m === startMin) return;
    applyMove({ startMin: Math.max(0, Math.min(23 * 60 + 55, m)) });
  };
  const svcOf = (id) => (services || []).find((s) => s.id === id);
  const activeServices = (services || []).filter((s) => s.active !== false);
  const catColor = (catId) => (serviceCategories || []).find((c) => c.id === catId)?.color || 'var(--clay)';
  const eligibleOps = (serviceId) => operators.filter((op) => (op.service_ids || []).includes(serviceId));
  const svcDisplayName = (it) => { const s = svcOf(it.service_id); return s ? (lang === 'en' && s.name_en ? s.name_en : s.name_it) : (it.name || it.service_name || ''); };
  const itemsDirty = itemsSig(editItems) !== itemsSig(appt.items);
  const editTotal = editItems.reduce((s, it) => s + Number(it.price || 0), 0);
  /* Orario di ogni riga: i servizi sono in fila dall'inizio della visita, posa
   * compresa. Serve a vedere subito che cosa slitta quando si cambia una durata
   * o si aggiunge un trattamento. */
  /* `to` è la fine del LAVORO (quando l'operatrice ha finito); `gap` è quello
   * che viene dopo — la posa di un colore o il buco che il salone vuole
   * lasciare — e il servizio successivo comincia di là. Tenerli separati è ciò
   * che permette di scrivere un'ora di fine senza trascinarsi dietro il
   * trattamento dopo. */
  const itemSpans = (() => {
    let cursor = startMin;
    return editItems.map((it) => {
      const from = cursor;
      const to = from + Math.max(0, parseInt(it.duration_min, 10) || 0);
      const gap = Math.max(0, parseInt(it.soak_min, 10) || 0);
      cursor = to + gap;
      return { from, to, gap, next: cursor };
    });
  })();
  /* Attesa fra un servizio e l'altro: è un avviso, non un divieto. Il listino
   * dice quanta posa ha il trattamento (il colore ne ha 30): quello che c'è in
   * più è un buco voluto, e come tale si segnala. */
  const catalogSoak = (it) => svcOf(it.service_id)?.soak_min || 0;
  const gapNotes = editItems.map((it, i) => {
    if (i >= editItems.length - 1) return null;     // dopo l'ultimo non c'è nulla da aspettare
    const extra = (itemSpans[i].gap || 0) - catalogSoak(it);
    return extra > 0 ? { index: i, minutes: extra, gap: itemSpans[i].gap } : null;
  }).filter(Boolean);

  /* Il servizio aggiunto va alla STESSA persona della visita, se è abilitata:
   * «prima disponibile» faceva scegliere al server una collega qualsiasi, e
   * dalla scheda non si capiva nemmeno su chi fosse finito. */
  const addServiceItem = (sid) => {
    const s = svcOf(sid);
    const eligible = eligibleOps(sid);
    const mine = eligible.some((op) => op.id === appt.operator_id) ? appt.operator_id : (eligible[0]?.id ?? null);
    const key = 'e' + (itemSeq.current++);
    setEditItems((l) => [...l, { key, id: undefined, service_id: sid, operator_id: mine, duration_min: s?.duration_min ?? 30, soak_min: s?.soak_min || 0, price: Number(s?.price) || 0, name: s ? (lang === 'en' && s.name_en ? s.name_en : s.name_it) : '' }]);
    setJustAdded(key);
  };
  const removeServiceItem = (key) => setEditItems((l) => l.filter((x) => x.key !== key));
  const setItemDuration = (key, raw) => setEditItems((l) => l.map((x) => (x.key === key ? { ...x, duration_min: raw === '' ? '' : Math.max(0, parseInt(raw, 10) || 0) } : x)));
  // 12 ore al massimo, come ItemEditIn sul server: un «600» battuto al posto
  // di «60» finiva in un 422 in inglese senza dire quale campo (17-12)
  const clampItemDuration = (key) => setEditItems((l) => l.map((x) => (x.key === key ? { ...x, duration_min: Math.min(MAX_ITEM_MIN, Math.max(5, parseInt(x.duration_min, 10) || 5)) } : x)));
  const setItemOperator = (key, opId) => setEditItems((l) => l.map((x) => (x.key === key ? { ...x, operator_id: opId } : x)));

  const setItemGap = (key, minutes) => setEditItems((l) => l.map((x) => (x.key === key ? { ...x, soak_min: Math.min(MAX_ITEM_MIN, Math.max(0, minutes)) } : x)));

  /* ---- ora di inizio e di fine di OGNI servizio ----------------------------
   * Ogni trattamento ha il suo orario, e fra uno e l'altro ci può essere un
   * buco: prima la fine di un servizio era per forza l'inizio del successivo, e
   * allungare il colore trascinava la piega senza chiedere niente. Adesso:
   * - fine di un servizio  → cambia la sua durata, l'attesa dopo resta com'è
   *   (quindi il trattamento dopo slitta di conseguenza);
   * - inizio di un altro   → allarga o stringe l'ATTESA prima di lui, senza
   *   toccare la durata di quello che lo precede. Il buco che resta è scritto
   *   in chiaro, con un tasto per chiuderlo: è un avviso, non un divieto;
   * - inizio del primo     → sposta tutta la visita (come in griglia).
   * L'unico limite vero: un servizio non può cominciare prima che finisca
   * quello prima (una persona sola non fa due cose insieme). Per farli davvero
   * in contemporanea si trascina il servizio nella colonna di una collega. */
  const draftOf = (key, side, value) => rowDrafts[`${key}:${side}`] ?? timeLabel(value);
  const setDraft = (key, side, v) => setRowDrafts((m) => ({ ...m, [`${key}:${side}`]: v }));
  const clearDraft = (key, side) => setRowDrafts((m) => { const n = { ...m }; delete n[`${key}:${side}`]; return n; });

  const commitItemEnd = (index, hm) => {
    const it = editItems[index], span = itemSpans[index];
    clearDraft(it.key, 'to');
    if (!/^\d{1,2}:\d{2}$/.test(hm || '')) return;
    const active = Math.min(MAX_ITEM_MIN, Math.max(5, hmToMin(hm) - span.from));
    setItemDuration(it.key, String(active));
    const next = editItems[index + 1];
    if (next && span.gap > 0) {
      fireToast({
        msg: t(`${svcDisplayName(next)} slitta alle ${timeLabel(span.from + active + span.gap)}: fra i due restano ${span.gap} minuti di attesa`,
          `${svcDisplayName(next)} shifts to ${timeLabel(span.from + active + span.gap)}: ${span.gap} minutes of waiting remain between them`),
        icon: 'clock',
      });
    }
  };
  const commitItemStart = async (index, hm) => {
    const it = editItems[index];
    clearDraft(it.key, 'from');
    if (!/^\d{1,2}:\d{2}$/.test(hm || '')) return;
    const wanted = hmToMin(hm);
    if (index === 0) {
      // è l'inizio della visita: si sposta tutto. Quello che c'è in sospeso
      // resta in bozza anche dopo lo spostamento (vedi adopt), e si salva
      // quando lo si decide.
      if (wanted === startMin) return;
      applyMove({ startMin: Math.max(0, Math.min(23 * 60 + 55, wanted)) });
      return;
    }
    const prev = editItems[index - 1], prevSpan = itemSpans[index - 1];
    const gap = wanted - prevSpan.to;
    if (gap > MAX_ITEM_MIN) {
      fireToast({ msg: t('Fra un servizio e l’altro l’attesa può essere al massimo di 12 ore', 'The wait between two services can be at most 12 hours'), icon: 'alert' });
      return;
    }
    if (gap < 0) {
      fireToast({
        msg: t(`${svcDisplayName(it)} non può cominciare prima che finisca ${svcDisplayName(prev)} (${timeLabel(prevSpan.to)}): per farli insieme trascinalo nella colonna di una collega`,
          `${svcDisplayName(it)} cannot start before ${svcDisplayName(prev)} ends (${timeLabel(prevSpan.to)}): to run them together drag it into a colleague's column`),
        icon: 'alert',
      });
      return;
    }
    setItemGap(prev.key, gap);
  };

  /* Un solo salvataggio per servizi e nota, e sta nel piede del pannello: il
   * pulsante viveva in fondo alla lista dei servizi, cioè fuori dallo schermo
   * proprio dopo aver aggiunto una riga — si modificava e non si salvava. */
  const dirty = itemsDirty || noteDirty;
  /* Il PUT manda lo stato completo dei servizi: prima si rilegge la visita e
   * si scrive sulla versione letta (`expected_updated_at`, contratto C2). Se
   * nel frattempo sono cambiati proprio servizi o nota, la bozza viene
   * riportata sulla versione nuova e si chiede di ricontrollare: prima la
   * lista vecchia rimetteva nella visita il servizio staccato in griglia
   * (pagato due volte) o cancellava quello aggiunto da una collega (13-03).
   * Il 412 (un'altra scrittura fra la rilettura e il salvataggio) non si
   * forza mai: si ricarica e lo si dice. Ritorna true se ha salvato. */
  async function saveChanges() {
    if (savingItems || !editItems.length || !dirty) return false;
    setSavingItems(true);
    try {
      const seen = apptRef.current;
      let target = seen;
      try {
        const fresh = await fetchFresh();
        if (!alive.current) return false;
        const touched = (itemsDirty && itemsSig(fresh.items) !== itemsSig(seen.items))
          || (noteDirty && (fresh.note || '') !== (seen.note || ''))
          || TERMINAL.includes(fresh.status);
        if (touched) {
          adopt(fresh, 'external');
          fireToast({ msg: t('L’appuntamento è cambiato nel frattempo: controlla le modifiche e salva di nuovo', 'The appointment changed in the meantime: check your changes and save again'), icon: 'alert' });
          return false;
        }
        target = fresh;
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) { reload(); return false; }
        // senza la rilettura resta la protezione del server (412)
      }
      const sentNote = note;
      const body = {
        ...(target.updated_at ? { expected_updated_at: target.updated_at } : {}),
        ...(itemsDirty ? {
          items: editItems.map((it) => ({
            ...(it.id != null ? { id: it.id } : {}),   // existing → id; new → omitted; omitted rows → removed
            service_id: it.service_id,
            operator_id: it.operator_id ?? null,
            duration_min: Math.min(MAX_ITEM_MIN, Math.max(5, parseInt(it.duration_min, 10) || 5)),
            // l'attesa dopo il servizio: posa del listino o buco voluto
            soak_min: Math.min(MAX_ITEM_MIN, Math.max(0, parseInt(it.soak_min, 10) || 0)),
          })),
        } : {}),
        ...(noteDirty ? { note } : {}),
      };
      let res, forced = false;
      try {
        res = await api.put(`/api/agenda/appointments/${target.id}`, body);
      } catch (err) {
        // 409 = l'operatrice scelta è occupata in quella fascia (o si sfora la
        // chiusura). Come in griglia non ci si ferma: si scrive lo stesso e lo si
        // dice nell'avviso. Il 400 (non abilitata al servizio) resta un no.
        if (!(err instanceof ApiError && err.status === 409)) throw err;
        forced = true;
        res = await api.put(`/api/agenda/appointments/${target.id}`, { ...body, force: true });
      }
      if (alive.current) adopt(res, 'saved', { sentNote });
      fireToast({
        msg: t('Appuntamento aggiornato', 'Appointment updated') + (forced ? t(' · si sovrappone a un altro impegno', ' · overlaps another booking') : ''),
        icon: forced ? 'alert' : 'check',
      });
      onMutate?.(res);
      return true;
    } catch (err) {
      if (err instanceof ApiError && err.status === 412) {
        if (alive.current) reload();
        fireToast({ msg: err.message, icon: 'alert' });
      } else toastErr(err, t, fireToast);
      return false;
    } finally { if (alive.current) setSavingItems(false); }
  }
  /* Le azioni che portano altrove partono dalla versione salvata: «Incassa»
   * con la «Piega» aggiunta e non salvata faceva il conto senza (13-05). */
  const saveFirst = async () => {
    if (!dirty || !itemsEditable) return true;
    if (!editItems.length) {
      fireToast({ msg: t('La visita è senza servizi: aggiungine uno o annulla le modifiche', 'The visit has no services: add one or discard the changes'), icon: 'alert' });
      return false;
    }
    return saveChanges();
  };

  const openClient = () => { setSelClient(appt.client.id); setTab('clienti'); onClose(); };

  async function lifecycle(action, body, toastMsg, icon) {
    if (busy) return false;
    setBusy(true);
    try {
      await api.post(`/api/agenda/appointments/${apptRef.current.id}/${action}`, body || {});
      fireToast({ msg: toastMsg, icon });
      return true;
    } catch (err) { toastErr(err, t, fireToast); return false; }
    finally { if (alive.current) setBusy(false); }
  }

  const checkIn = async () => {
    if (!(await saveFirst()) || !alive.current) return;
    if (await lifecycle('check-in', null, t('Check-in registrato', 'Checked in'), 'check') && alive.current) onClose();
  };
  const startAppt = async () => {
    if (!(await saveFirst()) || !alive.current) return;
    if (await lifecycle('start', null, t('Trattamento avviato', 'Treatment started'), 'clock') && alive.current) onClose();
  };
  const checkout = async () => {
    if (!(await saveFirst()) || !alive.current) return;
    openModal('sell', { appointment: apptRef.current, onDone: onMutate });
  };
  const startReschedule = async () => {
    if (!(await saveFirst()) || !alive.current) return;
    setFlow('reschedule');
  };

  /* cancel / no-show → then offer the freed slot to matching waitlist entries */
  async function destroy(kind) {
    const reasons = kind === 'no-show' ? noShowReasons : cancelReasons;
    const label = (reasons.find((r) => r[0] === reason) || [])[1] || '';
    const fullReason = joinReason(label, reasonNote);
    const freed = apptRef.current;
    const byClient = kind === 'cancel' && cancelByClient;
    const kept = byClient && freed.deposit_status === 'paid' && lateCancel(freed, cancelMinHours);
    const ok = await lifecycle(
      kind, { reason: fullReason, ...(kind === 'cancel' ? { by_client: byClient } : {}) },
      kind === 'no-show' ? t('No-show registrato · slot liberato', 'No-show recorded · slot freed')
        : kept ? t('Appuntamento cancellato · caparra trattenuta', 'Appointment cancelled · deposit kept')
          : t('Appuntamento cancellato · slot liberato', 'Appointment cancelled · slot freed'),
      kind === 'no-show' ? 'alert' : 'x'
    );
    if (!ok || !alive.current) return;
    onMutate?.();
    try {
      const wl = await api.get('/api/agenda/waitlist');
      if (!alive.current) return;
      const matches = wlMatches(wl, freed);
      if (matches.length) { openModal('freedslot', { appointment: freed, matches }); return; }
    } catch { /* ignore — just close */ }
    if (alive.current) onClose();
  }

  /* ---- reason picker (shared by no-show + cancel) ----
   * Si chiama come funzione e non come <ReasonPicker/>: definito qui dentro è
   * un componente nuovo a ogni render, e React rimontava la textarea a ogni
   * tasto (il campo perdeva il fuoco dopo ogni lettera). */
  const reasonPicker = ({ reasons }) => (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 9 }}>
        <div className="t-meta">{t('Motivazione (per le statistiche)', 'Reason (for statistics)')}</div>
        {session?.is_owner && (
          <button type="button" onClick={() => { onClose?.(); setDeepLink?.('reasons'); setTab('impostazioni'); }} style={{ marginLeft: 'auto', fontSize: 12, fontWeight: 700, color: 'var(--clay-ink)', cursor: 'pointer', background: 'transparent', border: 'none' }}>{t('Personalizza', 'Customise')}</button>
        )}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 14 }}>
        {reasons.map(([k, it, en]) => {
          const on = reason === k;
          return <button key={k} onClick={() => setReason(k)} style={{ padding: '8px 14px', borderRadius: 99, fontSize: 13, fontWeight: 600, cursor: 'pointer', border: '1.5px solid ' + (on ? 'var(--ink)' : 'var(--hair)'), background: on ? 'var(--ink)' : 'var(--surface)', color: on ? '#fff' : 'var(--ink-2)' }}>{t(it, en)}</button>;
        })}
      </div>
      <div className="t-meta" style={{ marginBottom: 8 }}>{t('Nota (facoltativa)', 'Note (optional)')}</div>
      {/* motivazione + nota vanno in un campo da 255 caratteri (ReasonIn): oltre,
          il no-show non veniva registrato e l'avviso era in inglese (17-12) */}
      <textarea value={reasonNote} onChange={(e) => setReasonNote(e.target.value)} placeholder={t('Aggiungi un dettaglio…', 'Add a detail…')} rows={2}
        maxLength={reasonNoteMax((reasons.find((r) => r[0] === reason) || [])[1] || '')}
        style={{ width: '100%', border: '1px solid var(--hair)', borderRadius: 12, padding: '10px 12px', fontSize: 13.5, fontFamily: 'var(--sans)', resize: 'vertical', outline: 'none', boxSizing: 'border-box', background: 'var(--surface)' }} />
    </div>
  );

  /* ---- RESCHEDULE flow ---- */
  if (flow === 'reschedule') {
    return (
      <RescheduleFlow appt={appt} t={t} lang={lang} fireToast={fireToast} busy={busy} setBusy={setBusy}
        onBack={() => setFlow(null)} onClose={onClose} onDone={onClose} onMutate={onMutate} />
    );
  }

  /* ---- NO-SHOW flow ---- */
  if (flow === 'noshow') {
    return (
      <DkPanel onClose={onClose} title={t('Segna no-show', 'Mark no-show')} sub={`${appt.client?.full_name} · ${timeLabel(startMin)}`}
        foot={
          <React.Fragment>
            <button className="dk-btn dk-btn--ghost" onClick={() => setFlow(null)}>{t('Indietro', 'Back')}</button>
            <button className="dk-btn dk-btn--danger-solid" disabled={busy} onClick={() => destroy('no-show')}>
              <Icon name="alert" size={16} color="#fff" />{t('Conferma no-show', 'Confirm no-show')}
            </button>
          </React.Fragment>
        }>
        <div className="t-meta" style={{ marginBottom: 12 }}>{t('Cosa succederà', 'What will happen')}</div>
        <div style={{ padding: '16px 16px 14px', borderRadius: 14, background: 'var(--surface-2)', marginBottom: 18 }}>
          <FlowSteps steps={noShowSteps(appt, matchCount, t, lang)} />
        </div>
        {reasonPicker({ reasons: noShowReasons })}
      </DkPanel>
    );
  }

  /* ---- CANCEL flow ---- */
  if (flow === 'cancel') {
    return (
      <DkPanel onClose={onClose} title={t('Cancella appuntamento', 'Cancel appointment')} sub={`${appt.client?.full_name} · ${timeLabel(startMin)}`}
        foot={
          <React.Fragment>
            <button className="dk-btn dk-btn--ghost" onClick={() => { setFlow(null); setReason(null); setReasonNote(''); }}>{t('Indietro', 'Back')}</button>
            <button className="dk-btn dk-btn--danger-solid" disabled={!reason || busy} onClick={() => destroy('cancel')} style={{ opacity: reason ? 1 : 0.4 }}>
              <Icon name="x" size={16} color="#fff" />{t('Conferma cancellazione', 'Confirm cancellation')}
            </button>
          </React.Fragment>
        }>
        <div className="t-meta" style={{ marginBottom: 9 }}>{t('Chi annulla', 'Who is cancelling')}</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
          {[[false, t('Il salone', 'The salon')], [true, t('La cliente, che ha disdetto', 'The client, who cancelled')]].map(([k, label]) => {
            const on = cancelByClient === k;
            return <button key={String(k)} type="button" onClick={() => setCancelByClient(k)} style={{ padding: '8px 14px', borderRadius: 99, fontSize: 13, fontWeight: 600, cursor: 'pointer', border: '1.5px solid ' + (on ? 'var(--ink)' : 'var(--hair)'), background: on ? 'var(--ink)' : 'var(--surface)', color: on ? '#fff' : 'var(--ink-2)' }}>{label}</button>;
          })}
        </div>
        <div className="t-sm" style={{ color: 'var(--muted)', lineHeight: 1.45, marginBottom: 16 }}>
          {!cancelByClient
            ? t('Il salone non può tenere la visita: la caparra torna alla cliente, senza penali.', 'The salon cannot keep the appointment: the deposit goes back to the client, with no penalty.')
            : lateCancel(appt, cancelMinHours)
              ? t(`Mancano meno di ${cancelMinHours} ore: come dall'app, la caparra resta al salone e la disdetta si segna come tardiva nella scheda della cliente.`, `Less than ${cancelMinHours} hours to go: as in the app, the salon keeps the deposit and the cancellation is marked late on the client's profile.`)
              : t(`Mancano più di ${cancelMinHours} ore: la caparra torna alla cliente, come dall'app.`, `More than ${cancelMinHours} hours to go: the deposit goes back to the client, as in the app.`)}
        </div>
        <div className="t-meta" style={{ marginBottom: 12 }}>{t('Cosa succederà', 'What will happen')}</div>
        <div style={{ padding: '16px 16px 14px', borderRadius: 14, background: 'var(--surface-2)', marginBottom: 18 }}>
          <FlowSteps steps={cancelSteps(appt, matchCount, t, lang, { byClient: cancelByClient, minHours: cancelMinHours })} />
        </div>
        {reasonPicker({ reasons: cancelReasons })}
      </DkPanel>
    );
  }

  /* ---- DETTAGLIO (predefinito) ----
   * Pannello laterale e non finestra centrata: l'agenda resta visibile di fianco
   * e il blocco su cui si sta intervenendo è evidenziato, così non si perde mai
   * di vista il contesto (a schermo stretto il pannello prende tutto). */
  return (
    <DkPanel onClose={onClose} title={appt.client?.full_name} sub={`${fmtDateIt(dateStr)} · ${timeLabel(startMin)}–${timeLabel(endMin)}`}
      foot={<React.Fragment>          {/* Le azioni comuni stanno qui sotto, sempre in vista: chi apre un
              appuntamento nove volte su dieci deve far entrare la cliente,
              incassare o spostarlo, e prima bisognava scorrere per trovarle.
              Una sola azione piena (clay): quella che fa avanzare il lavoro. */}
          {/* Modifiche in sospeso: il salvataggio sta QUI, dove si vede sempre.
              In fondo alla lista dei servizi finiva sotto il bordo del pannello
              proprio dopo aver aggiunto un trattamento. */}
          {itemsEditable && dirty && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, padding: '8px 10px', borderRadius: 12, background: 'var(--clay-tint)' }}>
              <Icon name="alert" size={15} color="var(--clay-ink)" />
              <span className="t-sm" style={{ flex: 1, minWidth: 0, color: 'var(--clay-ink)', fontWeight: 600 }}>
                {itemsDirty && noteDirty ? t('Servizi e nota da salvare', 'Services and note to save')
                  : itemsDirty ? t('Servizi da salvare', 'Services to save') : t('Nota da salvare', 'Note to save')}
              </span>
              <button className="dk-btn dk-btn--ghost" style={{ height: 32, fontSize: 12.5 }} disabled={savingItems}
                onClick={() => { setEditItems(mkEditItems(appt.items)); setNote(appt.note || ''); }}>{t('Annulla', 'Discard')}</button>
              <button className="dk-btn dk-btn--clay" style={{ height: 32, fontSize: 12.5 }} disabled={savingItems || !editItems.length} onClick={() => saveChanges()}>
                <Icon name="check" size={14} color="#fff" />{savingItems ? t('Salvataggio…', 'Saving…') : t('Salva', 'Save')}
              </button>
            </div>
          )}
          {!terminal && canWrite && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {appt.status === 'confirmed' && (
                <button className="dk-btn dk-btn--clay" disabled={busy} style={{ height: 46, width: '100%' }} onClick={checkIn}>
                  <Icon name="check" size={18} color="#fff" />{t('Check-in', 'Check in')}
                </button>
              )}
              {appt.status === 'checked_in' && (
                <button className="dk-btn dk-btn--clay" disabled={busy} style={{ height: 46, width: '100%' }} onClick={startAppt}>
                  <Icon name="play" size={17} color="#fff" />{t('Inizia trattamento', 'Start treatment')}
                </button>
              )}
              <div style={{ display: 'flex', gap: 8 }}>
                <button className={'dk-btn ' + (appt.status === 'in_progress' ? 'dk-btn--clay' : 'dk-btn--soft')} style={{ flex: 1, height: 42 }} onClick={checkout}>
                  <Icon name="wallet" size={17} color={appt.status === 'in_progress' ? '#fff' : undefined} />{t('Incassa', 'Check out')}
                </button>
                <button className="dk-btn dk-btn--soft" style={{ flex: 1, height: 42 }} onClick={startReschedule}
                  title={t('Cerca un orario libero o sposta a un altro giorno (per l’ora e la persona di oggi bastano i comandi qui sopra)', 'Find a free time or move to another day (for today’s time and stylist use the controls above)')}>
                  <Icon name="calendar" size={16} />{t('Riprogramma', 'Reschedule')}
                </button>
              </div>
            </div>
          )}
          {/* Tolgono qualcosa: colore proprio (rosso di contorno), in fondo e
              più piccole. Prima erano due scritte grigie come il resto. */}
          {!terminal && canWrite && (
            <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
              {/* Solo per chi era attesa e non è arrivata: il server rifiuta il
                  no-show di chi è già in salone o di una visita non ancora
                  cominciata (caparra trattenuta e storico sporcato). */}
              {canMarkNoShow(appt) && (
                <button className="dk-btn dk-btn--danger" style={{ flex: 1, height: 34, fontSize: 12.5 }}
                  onClick={() => { setFlow('noshow'); setReason(noShowReasons[0][0]); setReasonNote(''); }}>
                  <Icon name="alert" size={14} color="var(--danger)" />No-show
                </button>
              )}
              <button className="dk-btn dk-btn--danger" style={{ flex: 1, height: 34, fontSize: 12.5 }}
                onClick={() => { setFlow('cancel'); setReason(null); setReasonNote(''); setCancelByClient(false); }}>
                <Icon name="x" size={14} color="var(--danger)" />{t('Cancella', 'Cancel booking')}
              </button>
            </div>
          )}
      </React.Fragment>}>
      {/* client meta bar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        <Avatar initials={initialsOf(appt.client?.full_name)} size={40} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 11.5, fontWeight: 700, color: sm.color, background: sm.tint, padding: '3px 9px', borderRadius: 99 }}>{sm.label}</span>
            {appt.forced && <span title={t('Inserito o spostato forzando le regole (fuori turno o sovrapposizione)', 'Inserted or moved overriding the rules (off shift or overlap)')} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 700, color: 'var(--warn)', background: 'var(--warn-tint)', padding: '3px 9px', borderRadius: 99 }}><Icon name="alert" size={11} color="var(--warn)" />{t('Forzato', 'Forced')}</span>}
            {(appt.gifts || []).length > 0 && <span title={(appt.gifts || []).map((g) => [g.service_name, usableCode(g.code), g.from_name ? t('da', 'from') + ' ' + g.from_name : ''].filter(Boolean).join(' · ')).join('\n')} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 700, color: 'var(--clay-ink)', background: 'var(--clay-tint)', padding: '3px 9px', borderRadius: 99 }}><Icon name="gift" size={11} color="var(--clay-ink)" />{t('Regalo', 'Gift')}{(appt.gifts || [])[0]?.from_name ? ' · ' + t('da', 'from') + ' ' + appt.gifts[0].from_name : ''}</span>}
            {(clientDetail?.categories || []).slice(0, 2).map((c) => (
              <span key={c.id} style={{ fontSize: 11, fontWeight: 700, color: 'var(--ink-2)', background: c.color || 'var(--surface-2)', padding: '3px 9px', borderRadius: 99 }}>{c.name}</span>
            ))}
            {/* Lo storico si scrive solo se c'è: «visite · €0» era una riga che
                non diceva niente, e sulla scheda di una cliente nuova sembrava
                un errore. */}
            {clientDetail?.visits > 0 && <span className="t-sm" style={{ color: 'var(--muted)' }}>{clientDetail.visits} {t('visite', 'visits')} · {fmtMoney(clientDetail.total_spent, lang)}</span>}
          </div>
          {appt.client?.phone && <a href={'tel:' + appt.client.phone} className="tabnum" style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink-2)', textDecoration: 'none' }}>{appt.client.phone}</a>}
        </div>
        <div style={{ flex: 1 }} />
        <button className="dk-btn dk-btn--soft" style={{ height: 38, fontSize: 13, padding: '0 14px' }} onClick={openClient}>{t('Apri scheda cliente', 'Open client')}</button>
      </div>

      {/* Una colonna: il pannello è stretto e le due colonne del vecchio modale
          restavano sbilanciate, una piena e una mezza vuota. `order` mette per
          primo quello che si guarda per primo — i servizi — senza spostare il
          codice. */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {/* chi e quando */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, order: 2 }}>
          {/* Chi e quando — si cambiano QUI. Prima erano due scritte, e per
              spostare di un quarto d'ora o passare la cliente alla collega
              bisognava entrare in «Riprogramma», che è un'altra schermata. */}
          <div style={{ padding: '13px 15px', borderRadius: 16, background: `color-mix(in srgb, ${col} 26%, #FFFFFF)` }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
              <Avatar initials={o?.initials || initialsOf((appt.items || [])[0]?.operator_name)} size={50} color={col} ring />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="t-meta" style={{ fontSize: 10, color: 'var(--ink-2)', opacity: 0.7, marginBottom: 1 }}>{t('Operatrice', 'Stylist')}</div>
                <div style={{ fontFamily: 'var(--serif)', fontSize: 22, fontWeight: 500, lineHeight: 1.05 }}>{o ? o.first_name : (appt.items || [])[0]?.operator_name}</div>
                {o?.role_title && <div className="t-sm" style={{ color: 'var(--ink-2)', opacity: 0.75 }}>{o.role_title}</div>}
              </div>
              <div style={{ textAlign: 'right', flexShrink: 0 }}>
                <div className="t-meta" style={{ fontSize: 10, color: 'var(--ink-2)', opacity: 0.7, marginBottom: 3 }}>{t('Inizio', 'Starts')}</div>
                {canMove ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4, justifyContent: 'flex-end' }}>
                    <button className="dk-iconbtn" disabled={movingBusy} title={t(`Anticipa di ${stepMin} minuti`, `${stepMin} minutes earlier`)} aria-label={t('Anticipa', 'Earlier')}
                      onClick={() => applyMove({ startMin: Math.max(0, startMin - stepMin) })}
                      style={{ width: 28, height: 28, borderRadius: 8, background: 'rgba(255,255,255,0.65)', border: 'none' }}><Icon name="chevL" size={14} /></button>
                    <input type="time" value={timeDraft ?? timeLabel(startMin)} step={stepMin * 60} disabled={movingBusy}
                      onChange={(e) => setTimeDraft(e.target.value)} onBlur={commitTime}
                      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); } }}
                      aria-label={t('Ora di inizio', 'Start time')}
                      style={{ width: 92, border: '1px solid rgba(17,24,39,0.18)', borderRadius: 9, padding: '5px 7px', fontSize: 14, fontWeight: 700, fontFamily: 'var(--mono, monospace)', textAlign: 'center', outline: 'none', background: 'var(--surface)', color: 'var(--ink)' }} />
                    <button className="dk-iconbtn" disabled={movingBusy} title={t(`Posticipa di ${stepMin} minuti`, `${stepMin} minutes later`)} aria-label={t('Posticipa', 'Later')}
                      onClick={() => applyMove({ startMin: Math.min(23 * 60 + 55, startMin + stepMin) })}
                      style={{ width: 28, height: 28, borderRadius: 8, background: 'rgba(255,255,255,0.65)', border: 'none' }}><Icon name="chevR" size={14} /></button>
                  </div>
                ) : (
                  <div className="tabnum" style={{ fontWeight: 700, fontSize: 15 }}>{timeLabel(startMin)}</div>
                )}
                <div className="t-sm" style={{ color: 'var(--ink-2)', opacity: 0.7, marginTop: 3 }}>{fmtDur(appt.total_duration_min, lang)} · {t('fino alle', 'until')} {timeLabel(endMin)}</div>
              </div>
            </div>
            {/* Il giorno: si sfoglia da qui e l'agenda di fianco segue, così la
                cliente al telefono sente «giovedì alle dieci ho posto» mentre
                lo si sta guardando davvero. Finché non si preme «Sposta»,
                l'appuntamento non si muove. */}
            {canMove && (
              <div style={{ marginTop: 11, paddingTop: 10, borderTop: '1px dashed rgba(17,24,39,0.16)', display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
                <div className="t-meta" style={{ fontSize: 10, color: 'var(--ink-2)', opacity: 0.7 }}>{t('Giorno', 'Day')}</div>
                <button className="dk-iconbtn" onClick={() => shiftViewDate(-1)} title={t('Giorno prima', 'Previous day')} aria-label={t('Giorno prima', 'Previous day')}
                  style={{ width: 26, height: 26, borderRadius: 8, background: 'rgba(255,255,255,0.65)', border: 'none' }}><Icon name="chevL" size={13} /></button>
                <input type="date" value={viewDate} onChange={(e) => showDate(e.target.value)}
                  aria-label={t('Giorno da guardare', 'Day to look at')}
                  style={{ border: '1px solid rgba(17,24,39,0.18)', borderRadius: 9, padding: '4px 7px', fontSize: 12.5, fontFamily: 'var(--sans)', fontWeight: 600, outline: 'none', background: 'var(--surface)', color: 'var(--ink)', cursor: 'pointer' }} />
                <button className="dk-iconbtn" onClick={() => shiftViewDate(1)} title={t('Giorno dopo', 'Next day')} aria-label={t('Giorno dopo', 'Next day')}
                  style={{ width: 26, height: 26, borderRadius: 8, background: 'rgba(255,255,255,0.65)', border: 'none' }}><Icon name="chevR" size={13} /></button>
                {viewDate !== dateStr ? (
                  <button className="dk-btn dk-btn--clay" disabled={movingBusy} style={{ height: 30, fontSize: 12, padding: '0 11px' }}
                    onClick={() => applyMove({ dateIso: viewDate })}
                    title={t('Sposta l’appuntamento a questo giorno, alla stessa ora', 'Move the appointment to this day, at the same time')}>
                    <Icon name="calendar" size={13} color="#fff" />{t(`Sposta a ${fmtDateIt(viewDate, { weekday: false })}`, `Move to ${fmtDateIt(viewDate, { weekday: false })}`)}
                  </button>
                ) : (
                  <span className="t-sm" style={{ color: 'var(--ink-2)', opacity: 0.7 }}>{t('sfoglia i giorni: l’agenda ti segue', 'browse the days: the agenda follows')}</span>
                )}
              </div>
            )}
            {/* passare la visita a un'altra persona: un tocco, senza uscire di qui */}
            {canMove && visitOps.length > 1 && (
              <div style={{ marginTop: 11, paddingTop: 10, borderTop: '1px dashed rgba(17,24,39,0.16)' }}>
                <div className="t-meta" style={{ fontSize: 10, color: 'var(--ink-2)', opacity: 0.7, marginBottom: 7 }}>{t('Passa a', 'Hand over to')}</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {visitOps.map((op) => {
                    const on = op.id === appt.operator_id;
                    return (
                      <button key={op.id} type="button" disabled={movingBusy || on} onClick={() => applyMove({ operatorId: op.id })}
                        className={'dk-pill dk-pill--tint' + (on ? ' dk-pill--on' : '')}
                        style={{ '--pill-c': opColors[op.id] || 'var(--clay)', padding: '3px 10px 3px 4px', fontSize: 12, cursor: on ? 'default' : 'pointer' }}>
                        <Avatar initials={op.initials} size={20} color={opColors[op.id] || 'var(--clay)'} ring={on} />
                        <span>{op.first_name}</span>
                        {on && <Icon name="check" size={12} stroke={2.6} />}
                      </button>
                    );
                  })}
                </div>
                {otherOpNames.length > 0 && (
                  <div className="t-sm" style={{ color: 'var(--ink-2)', opacity: 0.8, marginTop: 7 }}>
                    {t(`Cambia mano solo la parte di ${o?.first_name || ''}: il resto resta a ${otherOpNames.join(', ')}.`, `Only ${o?.first_name || ''}'s part changes hands: the rest stays with ${otherOpNames.join(', ')}.`)}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* deposit status */}
          {dm && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '12px 14px', borderRadius: 12, background: appt.deposit_status === 'paid' ? 'var(--ok-tint)' : 'var(--warn-tint)', border: '1px solid color-mix(in srgb, ' + dm.color + ' 28%, transparent)' }}>
              <div style={{ width: 34, height: 34, borderRadius: 10, background: appt.deposit_status === 'paid' ? 'var(--ok)' : 'var(--surface)', border: appt.deposit_status === 'paid' ? 'none' : '1.5px dashed ' + dm.color, display: 'grid', placeItems: 'center', flexShrink: 0 }}>
                <Icon name={appt.deposit_status === 'paid' ? 'check' : 'wallet'} size={16} color={appt.deposit_status === 'paid' ? '#fff' : dm.color} stroke={appt.deposit_status === 'paid' ? 3 : 1.7} />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 700, fontSize: 13.5, color: dm.color }}>{dm.label}</div>
                <div className="t-sm" style={{ color: 'var(--ink-2)' }}>
                  {fmtEur(Number(appt.deposit_amount), lang)}
                  {/* Rimborso parziale: in cassa resta meno di quanto la cliente
                      ha versato, e al checkout si detrae quel meno. Scrivere solo
                      l'importo versato faceva leggere all'operatrice una cifra
                      che il salone non ha più. */}
                  {Number(appt.deposit_refunded_amount || 0) > 0 && (
                    <span> · {t('rimborsati', 'refunded')} <b className="tabnum">{fmtEur(Number(appt.deposit_refunded_amount), lang)}</b>
                      {/* «In cassa» ha senso finché quella quota è ancora da
                          scontare: a visita chiusa è già stata detratta dal
                          conto, e ripeterla faceva sembrare che il salone la
                          tenesse ancora da parte. */}
                      {appt.deposit_status === 'paid' && appt.status !== 'closed' && (
                        <>, {t('in cassa', 'in the till')} <b className="tabnum">{fmtEur(Number(appt.deposit_credit), lang)}</b></>
                      )}
                    </span>
                  )}
                  {/* Orario del SALONE: da un portatile con un altro fuso la
                      scadenza si leggeva spostata di ore, e la reception
                      richiamava la cliente quando il posto era già libero. */}
                  {appt.deposit_status === 'required' && appt.deposit_due_at && !terminal && (
                    <span> · {t('entro le', 'by')} <b className="tabnum">{depositDueLabel(appt.deposit_due_at, lang)}</b>{t(', poi lo slot si libera', ', then the slot is freed')}</span>
                  )}
                </div>
                {appt.deposit_status === 'required' && !terminal && hasScope('sales') && (
                  <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
                    <button className="dk-btn dk-btn--soft" disabled={linkBusy} style={{ height: 30, fontSize: 12 }} onClick={sendDepositLink} title={t('Crea il link di pagamento Stripe e lo manda alla cliente (WhatsApp via Yourang)', 'Creates the Stripe payment link and sends it to the client (WhatsApp via Yourang)')}>
                      <Icon name="send" size={13} />{appt.deposit_payment_link ? t('Sollecita', 'Remind') : t('Invia link di pagamento', 'Send payment link')}
                    </button>
                    {appt.deposit_payment_link && (
                      <button className="dk-btn dk-btn--ghost" style={{ height: 30, fontSize: 12 }} onClick={copyDepositLink}>
                        <Icon name="copy" size={13} />{t('Copia link', 'Copy link')}
                      </button>
                    )}
                    {appt.deposit_payment_link && linkCopyFailed && (
                      <input readOnly value={appt.deposit_payment_link} onFocus={(e) => e.currentTarget.select()} aria-label={t('Link di pagamento', 'Payment link')}
                        style={{ flexBasis: '100%', minWidth: 0, border: '1px solid var(--hair)', borderRadius: 8, padding: '5px 8px', fontSize: 12, fontFamily: 'var(--mono, monospace)', background: 'var(--surface)', color: 'var(--ink)', outline: 'none' }} />
                    )}
                    {/* Il salone che non incassa online non aveva nessun modo di
                        registrare la caparra pagata al banco: il termine scadeva
                        e lo slot si liberava sotto gli occhi dell'operatrice. */}
                    <button className="dk-btn dk-btn--ghost" disabled={linkBusy} style={{ height: 30, fontSize: 12 }} onClick={() => cashDeposit('cash')}
                      title={t('Segna la caparra incassata in contanti al banco: il posto non si libera più e l’incasso entra in cassa', 'Mark the deposit as cashed at the counter: the slot is no longer freed and the money is recorded in the till')}>
                      <Icon name="wallet" size={13} />{t('Incassata: contanti', 'Cashed: cash')}
                    </button>
                    <button className="dk-btn dk-btn--ghost" disabled={linkBusy} style={{ height: 30, fontSize: 12 }} onClick={() => cashDeposit('card')}
                      title={t('Segna la caparra incassata con il POS del salone', 'Mark the deposit as cashed on the salon card terminal')}>
                      <Icon name="wallet" size={13} />{t('Incassata: POS', 'Cashed: card')}
                    </button>
                  </div>
                )}
              </div>
              {appt.deposit_status === 'refund_due' && hasScope('sales') && (
                <button className="dk-btn dk-btn--soft" disabled={busy} style={{ height: 32, fontSize: 12.5, flexShrink: 0 }}
                  title={t('Conferma di aver restituito la caparra alla cliente', 'Confirm you have returned the deposit to the client')}
                  onClick={async () => {
                    if (busy) return;
                    setBusy(true);
                    try {
                      const res = await api.post(`/api/agenda/appointments/${appt.id}/deposit-refunded`, {});
                      if (alive.current) adopt(res);
                      fireToast({ msg: t('Caparra segnata come rimborsata', 'Deposit marked as refunded'), icon: 'check' });
                      onMutate?.(res);
                    } catch (err) { toastErr(err, t, fireToast); }
                    finally { if (alive.current) setBusy(false); }
                  }}>
                  <Icon name="check" size={14} />{t('Segna rimborsata', 'Mark refunded')}
                </button>
              )}
            </div>
          )}

          {/* note edit → PUT /appointments/{id}. Si scrive solo dove la si può
              anche salvare: su una visita chiusa (o senza il permesso agenda)
              il campo era modificabile, il pulsante di salvataggio non
              compariva e l'avviso rimandava a un tasto che non c'era (13-23). */}
          <div>
            <div className="t-meta" style={{ marginBottom: 6 }}>{t('Nota appuntamento', 'Appointment note')}</div>
            {itemsEditable ? (
              <React.Fragment>
                <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder={t('Aggiungi una nota…', 'Add a note…')}
                  style={{ width: '100%', border: '1px solid var(--hair)', borderRadius: 12, padding: '10px 12px', fontSize: 13.5, fontFamily: 'var(--sans)', resize: 'vertical', outline: 'none', boxSizing: 'border-box', background: 'var(--surface)' }} />
                {noteDirty && (
                  <div className="t-sm" style={{ color: 'var(--muted)', marginTop: 5 }}>{t('Nota modificata: si salva col pulsante in fondo.', 'Note changed: save it with the button below.')}</div>
                )}
              </React.Fragment>
            ) : (
              <div className="t-sm" style={{ whiteSpace: 'pre-wrap', color: appt.note ? 'var(--ink-2)' : 'var(--muted-2)', padding: '8px 12px', borderRadius: 12, background: 'var(--surface-2)' }}>
                {appt.note || t('Nessuna nota', 'No note')}
              </div>
            )}
          </div>

          {/* margin — behind a small toggle */}
          <div>
            <button onClick={() => setShowMargin((v) => !v)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer', background: 'transparent', border: 'none', fontSize: 12.5, fontWeight: 700, color: 'var(--muted)', padding: 0 }}>
              <Icon name="insights" size={14} color="var(--muted)" />{showMargin ? t('Nascondi margine', 'Hide margin') : t('Mostra margine', 'Show margin')}
              <Icon name="chevD" size={12} color="var(--muted)" style={{ transform: showMargin ? 'rotate(180deg)' : 'none', transition: 'transform 140ms' }} />
            </button>
            {showMargin && (
              !margin ? <div className="skel" style={{ height: 96, borderRadius: 12, marginTop: 8 }} /> : (
                <div style={{ background: 'var(--surface-2)', borderRadius: 12, padding: '11px 14px', marginTop: 8 }}>
                  {/* fmtMoney e non fmtEur: un costo nullo è «€0,00», non
                      «− Gratis» (e un ricavo nullo non è un omaggio) */}
                  {[[t('Ricavo', 'Revenue'), margin.revenue, false], [t('Costo prodotti', 'Product cost'), margin.product_cost, true], [t('Costo fornitori', 'Supplier cost'), margin.supplier_cost, true], [t('Costo lavoro', 'Labour cost'), margin.labor_cost, true]].map(([l, v, neg], i) => (
                    <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '2px 0' }}>
                      <span className="t-sm" style={{ color: 'var(--muted)' }}>{l}</span>
                      <span className="tabnum" style={{ fontSize: 12.5 }}>{neg && Number(v) ? '− ' : ''}{fmtMoney(v, lang)}</span>
                    </div>
                  ))}
                  <div className="hr" style={{ margin: '6px 0' }} />
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                    <span style={{ fontWeight: 700, fontSize: 13.5 }}>{t('Margine stimato', 'Estimated margin')}</span>
                    <span className="t-num" style={{ fontWeight: 800, fontSize: 16, color: Number(margin.margin) >= 0 ? 'var(--ok)' : 'var(--danger)' }}>{fmtMoney(margin.margin, lang)} · {margin.margin_pct}%</span>
                  </div>
                </div>
              )
            )}
          </div>
        </div>

        {/* che cosa si fa */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, order: 1 }}>
          {/* services — read-only when terminal / no write scope, editable otherwise */}
          {!itemsEditable ? (
            <div style={{ background: 'var(--surface-2)', borderRadius: 14, padding: 14 }}>
              {(appt.items || []).map((it) => {
                const gift = (appt.gifts || []).find((g) => g.service_id === it.service_id);
                return (
                  <div key={it.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, padding: '6px 0' }}>
                    <span style={{ fontWeight: 600, fontSize: 14, flex: 1, minWidth: 0 }}>{it.service_name}{gift && <span title={[t('Gift card', 'Gift card'), usableCode(gift.code)].filter(Boolean).join(' ')} style={{ marginLeft: 6, display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 10.5, fontWeight: 700, color: 'var(--clay-ink)', background: 'var(--clay-tint)', padding: '1px 7px', borderRadius: 99, verticalAlign: 'middle' }}><Icon name="gift" size={10} color="var(--clay-ink)" />{t('Regalo', 'Gift')}</span>}</span>
                    <span className="t-sm" style={{ color: 'var(--muted)' }}>{[operators.find((x) => x.id === it.operator_id)?.first_name || it.operator_name, fmtDur(it.duration_min, lang), fmtEur(Number(it.price), lang)].filter(Boolean).join(' · ')}</span>
                  </div>
                );
              })}
              <div className="hr" style={{ margin: '8px 0' }} />
              <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700 }}>
                <span>{t('Totale', 'Total')}</span>
                <span className="t-num" style={{ fontSize: 17 }}>{fmtMoney(appt.total_price, lang)}</span>
              </div>
            </div>
          ) : (
            <div style={{ background: 'var(--surface-2)', borderRadius: 14, padding: 14 }}>
              {/* Con più servizi la visita è una sola cosa in agenda: va detto
                  qui, insieme al modo per muoverne uno solo. */}
              {(appt.items || []).length > 1 && (
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 10, padding: '8px 10px', borderRadius: 10, background: 'var(--surface)', border: '1px dashed var(--hair)' }}>
                  <Icon name="calendar" size={14} color="var(--muted)" style={{ flexShrink: 0, marginTop: 1 }} />
                  <div className="t-sm" style={{ color: 'var(--ink-2)', lineHeight: 1.35 }}>
                    <b>{t(`${(appt.items || []).length} servizi in un'unica visita`, `${(appt.items || []).length} services in one visit`)}</b>{' — '}
                    {t('in agenda trascina un servizio per spostare solo quello, o la barra scura a sinistra per spostarli tutti insieme, anche nella colonna di un’altra operatrice.', 'in the agenda drag one service to move just that one, or the dark bar on its left to move them all together, into another stylist’s column too.')}
                  </div>
                </div>
              )}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {editItems.map((it, i) => {
                  const s = svcOf(it.service_id);
                  const color = catColor(s?.category_id);
                  const isNew = it.id == null;
                  // L'operatrice si sceglie su OGNI riga, non solo su quelle
                  // nuove: era l'unico modo per sapere su chi finiva un servizio
                  // aggiunto, e per passarne uno alla collega senza trascinare.
                  const eligible = eligibleOps(it.service_id);
                  // Chi ha già la riga resta scritta anche se nel frattempo non
                  // è più abilitata al servizio o è stata disattivata: prima
                  // nessuna pillola era accesa e non si capiva chi avesse il
                  // servizio (13-13).
                  const holder = it.operator_id != null && !eligible.some((op) => op.id === it.operator_id)
                    ? { id: it.operator_id, name: operators.find((x) => x.id === it.operator_id)?.first_name || it.operator_name || '—', active: operators.some((x) => x.id === it.operator_id) }
                    : null;
                  const span = itemSpans[i];
                  return (
                    <div key={it.key} ref={it.key === justAdded ? addedRef : undefined}
                      style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: it.key === justAdded ? '8px' : 0, margin: it.key === justAdded ? '-8px' : 0, borderRadius: 10, background: it.key === justAdded ? 'var(--clay-tint)' : 'transparent', transition: 'background 400ms' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ width: 8, height: 8, borderRadius: 99, background: color, flexShrink: 0 }} />
                        <span style={{ flex: 1, minWidth: 0, fontWeight: 600, fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {svcDisplayName(it)}
                          {(appt.gifts || []).some((g) => g.service_id === it.service_id) && <Icon name="gift" size={12} color="var(--clay-ink)" title={t('Coperto da gift card', 'Covered by a gift card')} style={{ marginLeft: 6, verticalAlign: '-2px' }} />}
                        </span>
                        <span className="t-num" style={{ fontSize: 13.5, fontWeight: 700, flexShrink: 0 }}>{fmtEur(Number(it.price), lang)}</span>
                        <button className="dk-iconbtn" title={t('Rimuovi servizio', 'Remove service')} onClick={() => removeServiceItem(it.key)} style={{ width: 28, height: 28, borderRadius: 8, flexShrink: 0 }}>
                          <Icon name="x" size={14} />
                        </button>
                      </div>
                      {/* Ora di inizio e di fine, scrivibili. Fra un servizio e
                          l'altro ci può essere un'attesa: la riga qui sotto la
                          dice e offre di chiuderla, senza imporre niente. */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, paddingLeft: 16, flexWrap: 'wrap' }}>
                        <input type="time" step={300} value={draftOf(it.key, 'from', span ? span.from : startMin)}
                          onChange={(e) => setDraft(it.key, 'from', e.target.value)}
                          onBlur={(e) => commitItemStart(i, e.target.value)}
                          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); } }}
                          title={i === 0 ? t('Inizio della visita: cambiarlo sposta tutti i servizi', 'Start of the visit: changing it moves every service') : t('Inizio: allarga o stringe l’attesa prima di questo servizio', 'Start: widens or narrows the wait before this service')}
                          aria-label={t('Ora di inizio del servizio', 'Service start time')}
                          style={timeCellCss} />
                        <span className="t-sm" style={{ color: 'var(--muted-2)' }}>→</span>
                        <input type="time" step={300} value={draftOf(it.key, 'to', span ? span.to : startMin)}
                          onChange={(e) => setDraft(it.key, 'to', e.target.value)}
                          onBlur={(e) => commitItemEnd(i, e.target.value)}
                          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); } }}
                          title={t('Fine del lavoro: quello che viene dopo è attesa', 'End of the work: what follows is waiting')}
                          aria-label={t('Ora di fine del servizio', 'Service end time')}
                          style={timeCellCss} />
                        <NumInput integer min={5} max={MAX_ITEM_MIN} value={it.duration_min} emptyValue=""
                          onChange={(v) => setItemDuration(it.key, v)} onBlur={() => clampItemDuration(it.key)}
                          aria-label={t('Durata in minuti', 'Duration in minutes')}
                          style={{ width: 48, marginLeft: 4, border: '1px solid var(--hair)', borderRadius: 8, padding: '5px 7px', fontSize: 12.5, fontFamily: 'var(--sans)', textAlign: 'right', outline: 'none', background: 'var(--surface)', color: 'var(--ink)' }} />
                        <span className="t-sm" style={{ color: 'var(--muted)' }}>{t('min', 'min')}</span>
                      </div>
                      {/* Attesa dopo questo servizio: la posa del listino è
                          normale (grigia), quella in più è un buco voluto e si
                          dice in ambra — con il tasto per chiuderlo. Nessuno
                          impedisce di lasciarlo. */}
                      {i < editItems.length - 1 && span && (span.gap > 0 || gapNotes.some((g) => g.index === i)) && (() => {
                        const extra = span.gap - catalogSoak(it);
                        const warn = extra > 0;
                        return (
                          <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginLeft: 16, padding: '5px 9px', borderRadius: 9, background: warn ? 'var(--warn-tint)' : 'var(--surface)', border: '1px dashed ' + (warn ? 'color-mix(in srgb, var(--warn) 45%, transparent)' : 'var(--hair)') }}>
                            <Icon name={warn ? 'alert' : 'clock'} size={13} color={warn ? 'var(--warn)' : 'var(--muted-2)'} />
                            <span className="t-sm" style={{ flex: 1, minWidth: 0, color: warn ? 'var(--warn)' : 'var(--muted)', fontWeight: warn ? 600 : 500 }}>
                              {catalogSoak(it) > 0 && !warn
                                ? t(`${span.gap} minuti di posa, poi ${svcDisplayName(editItems[i + 1])}`, `${span.gap} minutes of soak, then ${svcDisplayName(editItems[i + 1])}`)
                                : t(`${span.gap} minuti di attesa prima di ${svcDisplayName(editItems[i + 1])}`, `${span.gap} minutes of waiting before ${svcDisplayName(editItems[i + 1])}`)}
                            </span>
                            {/* «Chiudi il buco» solo per l'attesa in più: la
                                posa del listino non è un buco, è il colore che
                                deve fare il suo tempo. */}
                            {warn && (
                              <button type="button" onClick={() => setItemGap(it.key, catalogSoak(it))}
                                title={t('Riporta il servizio successivo subito dopo questo', 'Bring the next service right after this one')}
                                style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--clay-ink)', background: 'transparent', border: 'none', cursor: 'pointer', flexShrink: 0 }}>
                                {t('Chiudi il buco', 'Close the gap')}
                              </button>
                            )}
                          </div>
                        );
                      })()}
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, paddingLeft: 16, flexWrap: 'wrap' }}>
                        {holder && (
                          <React.Fragment>
                            <span className="dk-pill dk-pill--tint dk-pill--on" style={{ '--pill-c': opColors[holder.id] || 'var(--muted-2)', padding: '2px 9px 2px 3px', fontSize: 11.5, cursor: 'default' }}>
                              <Avatar initials={initialsOf(holder.name)} size={18} color={opColors[holder.id] || 'var(--muted-2)'} ring />
                              <span>{holder.name}</span>
                            </span>
                            <span className="t-sm" style={{ color: 'var(--warn)', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                              <Icon name="alert" size={11} color="var(--warn)" />{holder.active ? t('non più abilitata a questo servizio', 'no longer enabled for this service') : t('non più attiva', 'no longer active')}
                            </span>
                          </React.Fragment>
                        )}
                        {eligible.length > 0 ? (
                          <React.Fragment>
                            {eligible.map((op) => {
                              const on = op.id === it.operator_id;
                              return (
                                <button key={op.id} type="button" onClick={() => setItemOperator(it.key, op.id)}
                                  className={'dk-pill dk-pill--tint' + (on ? ' dk-pill--on' : '')}
                                  style={{ '--pill-c': opColors[op.id] || 'var(--clay)', padding: '2px 9px 2px 3px', fontSize: 11.5 }}>
                                  <Avatar initials={op.initials} size={18} color={opColors[op.id] || 'var(--clay)'} ring={on} />
                                  <span>{op.first_name}</span>
                                </button>
                              );
                            })}
                            {isNew && (
                              <button type="button" onClick={() => setItemOperator(it.key, null)} className={'dk-pill' + (it.operator_id === null ? ' dk-pill--on' : '')} style={{ padding: '3px 9px', fontSize: 11.5 }}>
                                <Icon name="sparkle" size={11} color={it.operator_id === null ? '#fff' : 'var(--muted-2)'} />{t('Prima disponibile', 'First available')}
                              </button>
                            )}
                          </React.Fragment>
                        ) : !holder && (
                          <span className="t-sm" style={{ color: 'var(--danger)', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                            <Icon name="alert" size={12} color="var(--danger)" />{t('Nessuna operatrice abilitata a questo servizio', 'No stylist can perform this service')}
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* add a service */}
              <div style={{ marginTop: 10 }}>
                {!addingSvc ? (
                  <button onClick={() => setAddingSvc(true)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer', background: 'transparent', border: 'none', fontSize: 12.5, fontWeight: 700, color: 'var(--clay-ink)', padding: 0 }}>
                    <Icon name="plus" size={14} color="var(--clay-ink)" />{t('Aggiungi servizio', 'Add service')}
                  </button>
                ) : (
                  <div style={{ border: '1px dashed var(--line-strong)', borderRadius: 12, padding: 10 }}>
                    <div style={{ display: 'flex', alignItems: 'center', marginBottom: 8 }}>
                      <span className="t-meta" style={{ margin: 0 }}>{t('Scegli un servizio', 'Choose a service')}</span>
                      <button onClick={() => setAddingSvc(false)} className="dk-iconbtn" style={{ width: 24, height: 24, borderRadius: 7, marginLeft: 'auto' }}><Icon name="x" size={13} /></button>
                    </div>
                    {activeServices.length ? (
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                        {/* stesso codice colore dei blocchi in agenda: la
                            pillola è tinta della sua categoria, non solo un
                            pallino accanto al nome */}
                        {activeServices.map((s) => (
                          <button key={s.id} onClick={() => { addServiceItem(s.id); setAddingSvc(false); }}
                            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 10px', borderRadius: 99, fontSize: 12, fontWeight: 600, cursor: 'pointer', border: `2px solid color-mix(in srgb, ${catColor(s.category_id)} 50%, transparent)`, background: `color-mix(in srgb, ${catColor(s.category_id)} 26%, var(--surface))`, color: 'var(--ink)' }}>
                            {lang === 'en' && s.name_en ? s.name_en : s.name_it}
                            <Icon name="plus" size={12} color="var(--ink-2)" />
                          </button>
                        ))}
                      </div>
                    ) : (
                      <div className="t-sm" style={{ color: 'var(--muted-2)' }}>{t('Nessun servizio disponibile', 'No service available')}</div>
                    )}
                  </div>
                )}
              </div>

              <div className="hr" style={{ margin: '10px 0 8px' }} />
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', fontWeight: 700 }}>
                <span>{t('Totale', 'Total')}</span>
                <span className="t-num" style={{ fontSize: 17 }}>{fmtMoney(editTotal, lang)}</span>
              </div>
              {/* Il pulsante che salva sta nel piede del pannello, sempre in
                  vista: qui resta solo il promemoria di dove guardare. */}
              {itemsDirty && (
                <div className="t-sm" style={{ color: 'var(--clay-ink)', fontWeight: 600, marginTop: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
                  <Icon name="chevD" size={13} color="var(--clay-ink)" />{t('Salva le modifiche col pulsante qui sotto', 'Save your changes with the button below')}
                </div>
              )}
            </div>
          )}

        </div>
      </div>

    </DkPanel>
  );
}

/* ---- Riprogramma: pick a new slot via availability, then POST /move ---- */
function RescheduleFlow({ appt, t, lang, fireToast, busy, setBusy, onBack, onClose, onDone, onMutate }) {
  const [manual, setManual] = useState('');
  const [needForce, setNeedForce] = useState(false); // orario fuori dagli slot liberi o appena occupato
  const needForceRef = useRef(false);
  needForceRef.current = needForce;
  const apptDay = toDateStr(appt.start);   // giorno del salone, non quello UTC
  const [date, setDate] = useState(apptDay >= todayStr() ? apptDay : todayStr());
  const [slots, setSlots] = useState(null);
  const [selStart, setSelStart] = useState(null);
  const selRef = useRef(null);
  selRef.current = selStart;
  const [reloadKey, setReloadKey] = useState(0);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const items = (appt.items || []).map((it) => ({ service_id: it.service_id, operator_id: it.operator_id }));

  /* Orari liberi PER QUESTA VISITA (contratto C1): con exclude_appointment_id
   * il server costruisce il piano dalla visita stessa — righe in ordine,
   * durate e pose scritte, operatrici — e non la conta come occupata. Prima
   * si cercava col listino di oggi e con la visita in agenda: spostarla di
   * mezz'ora non era mai possibile e gli orari proposti a una visita allungata
   * finivano in un 409 (01-05, 02-24, 13-17). `items` resta per un server che
   * non conosce ancora il parametro. Si ricarica anche quando la visita cambia
   * (il pannello la segue) o dopo un 409. */
  const version = apptVersion(appt);
  const lastDay = useRef(null);
  useEffect(() => {
    let on = true;
    const sameDay = lastDay.current === date;
    lastDay.current = date;
    if (!sameDay) { setSlots(null); setSelStart(null); setNeedForce(false); }
    api.get('/api/agenda/availability', { params: { date, items, location_id: appt.location_id, exclude_appointment_id: appt.id } })
      .then((res) => {
        if (!on) return;
        setSlots(res);
        const cur = selRef.current;
        if (sameDay && cur && !needForceRef.current && !res.some((x) => x.start === cur)) {
          setSelStart(null);
          fireToast({ msg: t(`Le ${timeLabel(minutesOfDay(cur))} non sono più libere: scegli un altro orario`, `${timeLabel(minutesOfDay(cur))} is no longer free: pick another time`), icon: 'alert' });
        }
      })
      .catch((err) => { if (on) { setSlots([]); toastErr(err, t, fireToast); } });
    return () => { on = false; };
  }, [date, version, reloadKey]); // eslint-disable-line react-hooks/exhaustive-deps

  async function move() {
    if (!selStart || busy) return;
    setBusy(true);
    const when = timeLabel(minutesOfDay(selStart));
    // La ricerca può proporre una collega per le righe di un'operatrice che
    // non si prenota più: lo spostamento la applica solo se la si manda.
    const sel = (slots || []).find((x) => x.start === selStart);
    const re = sel ? slotReassignment(appt.items, sel.assignment) : { pair: null, extra: 0 };
    const url = `/api/agenda/appointments/${appt.id}/move`;
    const body = { start: selStart, ...(re.pair ? { operator_id: re.pair.to, from_operator_id: re.pair.from } : {}) };
    try {
      let res, forced = false;
      try {
        // Sempre prima senza forzare: un orario a mano fuori dalla griglia
        // degli slot ma libero restava segnato «forzato» per niente.
        res = await api.post(url, { ...body, force: false });
      } catch (err) {
        if (!(err instanceof ApiError && err.status === 409)) throw err;
        if (!needForce) {
          // Era fra gli orari liberi: nel frattempo lo ha preso qualcun altro.
          // Si ricarica e si lascia decidere: un altro orario, o di nuovo
          // «Sposta qui» per forzare (prima l'avviso citava un «Sposta
          // comunque» che non c'era).
          if (alive.current) { setNeedForce(true); setReloadKey((k) => k + 1); }
          fireToast({ msg: t(`Le ${when} sono state appena occupate: scegli un altro orario, o premi di nuovo «Sposta qui» per spostarla comunque (resterà segnata come forzata)`, `${when} was just taken: pick another time, or press “Move here” again to move it anyway (it will be marked as forced)`), icon: 'alert' });
          return;
        }
        forced = true;
        res = await api.post(url, { ...body, force: true });
      }
      fireToast({
        msg: t('Appuntamento riprogrammato alle ' + when, 'Rescheduled to ' + when)
          + (forced ? t(' · forzato', ' · forced') : '')
          + (re.extra ? t(' · controlla chi fa i servizi: una sola operatrice non più disponibile si riassegna per volta', ' · check who performs the services: only one unavailable stylist is reassigned at a time') : ''),
        icon: forced || re.extra ? 'alert' : 'calendar',
      });
      onMutate?.(res);
      if (alive.current) onDone();
    } catch (err) {
      toastErr(err, t, fireToast);
    } finally { setBusy(false); }   // `busy` è del pannello, che può essere ancora aperto
  }
  const applyManual = () => {
    if (!manual) return;
    const minutes = hmToMin(manual);
    const exact = (slots || []).find((s) => minutesOfDay(s.start) === minutes);
    setSelStart(exact ? exact.start : isoAtMin(date, minutes));
    setNeedForce(!exact);
  };
  const anyRecommended = (slots || []).some((s) => s.recommended) && (slots || []).some((s) => s.recommended === false);

  return (
    <DkPanel onClose={onClose} title={t('Riprogramma', 'Reschedule')} sub={`${appt.client?.full_name} · ${t('attuale', 'currently')} ${fmtDateIt(apptDay, { weekday: false })} ${timeLabel(aStartMin(appt))}`}
      foot={
        <React.Fragment>
          <button className="dk-btn dk-btn--ghost" onClick={onBack}>{t('Indietro', 'Back')}</button>
          <button className="dk-btn dk-btn--clay" disabled={!selStart || busy} onClick={move}>
            <Icon name="calendar" size={16} color="#fff" />{t('Sposta qui', 'Move here')}{selStart ? ' · ' + timeLabel(minutesOfDay(selStart)) : ''}
          </button>
        </React.Fragment>
      }>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16, padding: '11px 14px', borderRadius: 12, border: '1px solid var(--hair)', background: 'var(--surface)' }}>
        <Icon name="calendar" size={17} color="var(--clay-ink)" />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="t-meta" style={{ fontSize: 9.5, marginBottom: 1 }}>{t('Nuova data', 'New date')}</div>
          <div style={{ fontWeight: 700, fontSize: 13.5 }}>{fmtDateIt(date)}</div>
        </div>
        <input type="date" value={date} min={todayStr()} onChange={(e) => setDate(e.target.value || todayStr())} style={{ border: '1px solid var(--hair)', borderRadius: 8, padding: '6px 8px', fontSize: 12.5, fontFamily: 'var(--sans)', outline: 'none', cursor: 'pointer', color: 'var(--ink)' }} />
      </div>
      <div className="t-meta" style={{ marginBottom: 9 }}>{t('Orari disponibili', 'Available times')}</div>
      {slots === null ? (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {[...Array(12)].map((_, i) => <div key={i} className="skel" style={{ width: 56, height: 30, borderRadius: 8 }} />)}
        </div>
      ) : slots.length ? (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {slots.map((s) => {
            const sel = s.start === selStart;
            const meh = s.recommended === false;
            return (
              <button key={s.start} onClick={() => { setSelStart(s.start); setNeedForce(false); }} className="tabnum" title={meh ? t('Lascerebbe un buco troppo corto per un altro servizio', 'Would leave a gap too short for another service') : ''} style={{ padding: '5px 9px', borderRadius: 8, fontSize: 12, fontWeight: 700, cursor: 'pointer', border: '1.5px solid ' + (sel ? 'var(--ink)' : 'var(--hair)'), background: sel ? 'var(--ink)' : 'var(--surface)', color: sel ? '#fff' : 'var(--ink)', opacity: meh && !sel ? 0.55 : 1 }}>
                {timeLabel(minutesOfDay(s.start))}
              </button>
            );
          })}
        </div>
      ) : (
        <div className="t-sm" style={{ color: 'var(--danger)', fontWeight: 600 }}>{t('Nessuno slot libero in questa data', 'No free slot on this date')}</div>
      )}
      {anyRecommended && <div className="t-sm" style={{ color: 'var(--muted-2)', fontSize: 11.5, marginTop: 8 }}>{t('Gli orari attenuati lascerebbero buchi invendibili.', 'Dimmed times would leave unsellable gaps.')}</div>}
      {/* orario a mano: anche fuori turno o sopra un'altra prenotazione (forzato) */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', borderRadius: 12, border: '1px dashed var(--line-strong)', marginTop: 14, flexWrap: 'wrap' }}>
        <Icon name="clock" size={16} color="var(--muted)" />
        <div style={{ flex: 1, minWidth: 160 }}>
          <div style={{ fontWeight: 700, fontSize: 13 }}>{t('Orario a mano', 'Type a time')}</div>
          <div className="t-sm" style={{ color: 'var(--muted)', fontSize: 11.5 }}>{t('Fuori turno o sovrapposto: si sposta forzando.', 'Off shift or overlapping: moved with override.')}</div>
        </div>
        <input type="time" value={manual} onChange={(e) => setManual(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); applyManual(); } }} style={{ border: '1px solid var(--hair)', borderRadius: 8, padding: '6px 8px', fontSize: 12.5, fontFamily: 'var(--mono, monospace)', fontWeight: 700, outline: 'none', width: 110 }} />
        <button className="dk-btn dk-btn--soft" disabled={!manual} style={{ height: 34, fontSize: 12.5 }} onClick={applyManual}>{t('Usa', 'Use')}</button>
      </div>
      {needForce && selStart && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '9px 12px', borderRadius: 12, background: 'var(--warn-tint)', marginTop: 10 }}>
          <Icon name="alert" size={15} color="var(--warn)" />
          <span className="t-sm" style={{ color: 'var(--ink-2)', fontWeight: 600 }}>{t(`Le ${timeLabel(minutesOfDay(selStart))} non sono fra gli orari liberi: l’appuntamento verrà spostato comunque e segnato come forzato.`, `${timeLabel(minutesOfDay(selStart))} is not a free time: the appointment will be moved anyway and marked as forced.`)}</span>
        </div>
      )}
    </DkPanel>
  );
}
