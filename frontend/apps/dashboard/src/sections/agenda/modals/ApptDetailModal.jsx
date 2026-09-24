// ApptDetailModal — full appointment detail: lifecycle actions, note edit, margin,
// reschedule via availability + move, freed-slot waitlist hand-off on cancel/no-show.
// Il pannello tiene lo stato e i comandi (salvataggio, check-in, incasso,
// no-show, annullamento); la copia dell'appuntamento, la caparra e gli
// spostamenti stanno negli hook (useApptCopy, useDepositActions,
// useMoveFromPanel), i pezzi del dettaglio in detail/ e «Riprogramma» in
// RescheduleFlow.jsx. Dettaglio, no-show e annullamento restano lo stesso
// <DkPanel> reso da qui: cambiando schermata il pannello non si rimonta (né
// riparte l'animazione d'ingresso, né cambia il suo posto fra i livelli di Esc).
import React, { useEffect, useRef, useState } from 'react';
import { ApiError, toastApiError, nameIn, Icon, timeLabel, fmtDateIt, toDateStr, statusMeta, depositMeta } from '@youty/shared';
import DkPanel from '../../../ui/DkPanel.jsx';
import FlowSteps from '../FlowSteps.jsx';
import { useDash } from '../../../ctx.jsx';
import { aStartMin, aEndMin, wlMatches, noShowSteps, cancelSteps, lateCancel, hmToMin, slotStep, LAST_START_MIN } from '../lib.js';
import {
  itemsSig, joinReason, MAX_ITEM_MIN, handoverOps, otherOpNames, itemSpans, gapNotes, TERMINAL,
} from './rules.js';
import { withForceRetry } from '../lib/retry.js';
import * as agendaApi from '../agendaApi.js';
import RescheduleFlow from './RescheduleFlow.jsx';
import { useApptCopy } from '../hooks/useApptCopy.js';
import { useDepositActions } from '../hooks/useDepositActions.js';
import { useMoveFromPanel } from '../hooks/useMoveFromPanel.js';
import DetailFooter from './detail/DetailFooter.jsx';
import ClientMetaBar from './detail/ClientMetaBar.jsx';
import WhoWhenCard from './detail/WhoWhenCard.jsx';
import DepositCard from './detail/DepositCard.jsx';
import NoteEditor from './detail/NoteEditor.jsx';
import MarginSection from './detail/MarginSection.jsx';
import ServicesReadOnly from './detail/ServicesReadOnly.jsx';
import ServicesEditor from './detail/ServicesEditor.jsx';
import ReasonPicker from './detail/ReasonPicker.jsx';
import WhoCancels from './detail/WhoCancels.jsx';

// Motivazioni predefinite: il titolare può sostituirle dalle Impostazioni
// (settings.no_show_reasons / cancel_reasons); qui restano come fallback.
const NOSHOW_REASONS = [['cliente', 'Mancata presenza', 'No-show'], ['salute', 'Malattia / imprevisto', 'Illness / emergency'], ['altro', 'Altro', 'Other']];
const CANCEL_REASONS = [['cliente', 'Richiesta cliente', 'Client request'], ['salute', 'Malattia', 'Illness'], ['agenda', 'Sovrapposizione', 'Schedule clash'], ['altro', 'Altro', 'Other']];
const customReasons = (list, fallback) => (Array.isArray(list) && list.length ? list.map((r, i) => ['c' + i, r, r]) : fallback);

export default function ApptDetailModal({ appointment, onMutate, onClose, onShowDate }) {
  const { t, lang, operators, opColors, services, serviceCategories, settings, session, fireToast, openModal, setTab, setDeepLink, setSelClient, hasScope } = useDash();
  const canWrite = hasScope('agenda');
  /* la copia dell'appuntamento, le modifiche in sospeso e la schermata (useApptCopy) */
  const {
    appt, flow, setFlow, alive, note, setNote, editItems, setEditItems, mkEditItems, itemSeq, addingSvc, setAddingSvc,
    rowDrafts, setRowDrafts, apptRef, adopt, fetchFresh, reload,
  } = useApptCopy({ appointment, t, fireToast, onClose });
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

  const noteDirty = note !== (appt?.note || '');
  const [savingItems, setSavingItems] = useState(false);
  const [justAdded, setJustAdded] = useState(null); // riga appena aggiunta: la si porta in vista

  // caparra: link di pagamento, incasso al banco, copia del link
  const { linkBusy, linkCopyFailed, sendDepositLink, cashDeposit, copyDepositLink } = useDepositActions({ apptRef, alive, adopt, t, fireToast, onMutate });

  /* conteggio lista d'attesa compatibile per il passo ④ della timeline (anteprima) */
  const [matchCount, setMatchCount] = useState(null);
  useEffect(() => {
    if (flow !== 'noshow' && flow !== 'cancel') return;
    setMatchCount(null);
    agendaApi.getWaitlist()
      .then((wl) => setMatchCount(wlMatches(wl, appt).length))
      .catch(() => setMatchCount(null));
  }, [flow]); // eslint-disable-line react-hooks/exhaustive-deps

  /* enrich with client stats (visits, spend, categories, deposit_always) */
  const [clientDetail, setClientDetail] = useState(null);
  useEffect(() => {
    if (appt?.client?.id) agendaApi.getClient(appt.client.id).then(setClientDetail).catch(() => {});
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

  /* ---- orario, giorno e operatrice, modificabili qui (useMoveFromPanel) ---- */
  const stepMin = slotStep(settings);
  const { timeDraft, setTimeDraft, movingBusy, viewDate, showDate, shiftViewDate, applyMove } = useMoveFromPanel({
    appt, apptRef, alive, adopt, fetchFresh, reload, operators, t, fireToast, onShowDate, onMutate,
  });

  /* margin (behind a small toggle) — si rilegge quando cambiano servizi,
   * operatrici o prezzo: restava quello di prima del salvataggio (13-24). */
  const [showMargin, setShowMargin] = useState(false);
  const [margin, setMargin] = useState(null);
  const marginKey = appt ? `${appt.id}|${itemsSig(appt.items)}|${appt.total_price}|${appt.status}` : '';
  useEffect(() => {
    if (!showMargin || !appt?.id) return undefined;
    let on = true;
    setMargin(null);
    agendaApi.getMargin(appt.id)
      .then((m) => { if (on) setMargin(m); })
      .catch((err) => { if (on) { toastApiError(err, fireToast, t); setShowMargin(false); } });
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
  // chi può prendersi la visita («Passa a») e chi ne ha già una parte (rules.js)
  const visitOps = handoverOps(appt, operators);
  const partners = otherOpNames(appt, operators);

  const commitTime = () => {
    const v = timeDraft;
    setTimeDraft(null);
    if (!v || !/^\d{1,2}:\d{2}$/.test(v)) return;
    const m = hmToMin(v);
    if (!Number.isFinite(m) || m === startMin) return;
    applyMove({ startMin: Math.max(0, Math.min(LAST_START_MIN, m)) });
  };
  const svcOf = (id) => (services || []).find((s) => s.id === id);
  const activeServices = (services || []).filter((s) => s.active !== false);
  const catColor = (catId) => (serviceCategories || []).find((c) => c.id === catId)?.color || 'var(--clay)';
  const eligibleOps = (serviceId) => operators.filter((op) => (op.service_ids || []).includes(serviceId));
  const svcDisplayName = (it) => { const s = svcOf(it.service_id); return s ? nameIn(s, lang) : (it.name || it.service_name || ''); };
  const itemsDirty = itemsSig(editItems) !== itemsSig(appt.items);
  const editTotal = editItems.reduce((s, it) => s + Number(it.price || 0), 0);
  // l'orario di ogni riga, e le attese oltre la posa del listino (rules.js)
  const spans = itemSpans(editItems, startMin);
  const catalogSoak = (it) => svcOf(it.service_id)?.soak_min || 0;
  const gaps = gapNotes(editItems, spans, catalogSoak);

  /* Il servizio aggiunto va alla STESSA persona della visita, se è abilitata:
   * «prima disponibile» faceva scegliere al server una collega qualsiasi, e
   * dalla scheda non si capiva nemmeno su chi fosse finito. */
  const addServiceItem = (sid) => {
    const s = svcOf(sid);
    const eligible = eligibleOps(sid);
    const mine = eligible.some((op) => op.id === appt.operator_id) ? appt.operator_id : (eligible[0]?.id ?? null);
    const key = 'e' + (itemSeq.current++);
    setEditItems((l) => [...l, { key, id: undefined, service_id: sid, operator_id: mine, duration_min: s?.duration_min ?? 30, soak_min: s?.soak_min || 0, price: Number(s?.price) || 0, name: s ? nameIn(s, lang) : '' }]);
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
    const it = editItems[index], span = spans[index];
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
      applyMove({ startMin: Math.max(0, Math.min(LAST_START_MIN, wanted)) });
      return;
    }
    const prev = editItems[index - 1], prevSpan = spans[index - 1];
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
      // 409 = l'operatrice scelta è occupata in quella fascia (o si sfora la
      // chiusura). Come in griglia non ci si ferma: si scrive lo stesso e lo si
      // dice nell'avviso. Il 400 (non abilitata al servizio) resta un no.
      const { res, forced } = await withForceRetry((force) => agendaApi.updateAppointment(target.id, force ? { ...body, force: true } : body));
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
      } else toastApiError(err, fireToast, t);
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
  // i comandi del piede che toccano la bozza o cambiano schermata
  const discardDraft = () => { setEditItems(mkEditItems(appt.items)); setNote(appt.note || ''); };
  const openNoShow = () => { setFlow('noshow'); setReason(noShowReasons[0][0]); setReasonNote(''); };
  const openCancel = () => { setFlow('cancel'); setReason(null); setReasonNote(''); setCancelByClient(false); };

  async function lifecycle(action, body, toastMsg, icon) {
    if (busy) return false;
    setBusy(true);
    try {
      await agendaApi.appointmentAction(apptRef.current.id, action, body || {});
      fireToast({ msg: toastMsg, icon });
      return true;
    } catch (err) { toastApiError(err, fireToast, t); return false; }
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
      const wl = await agendaApi.getWaitlist();
      if (!alive.current) return;
      const matches = wlMatches(wl, freed);
      if (matches.length) { openModal('freedslot', { appointment: freed, matches }); return; }
    } catch { /* ignore — just close */ }
    if (alive.current) onClose();
  }

  /* caparra restituita alla cliente (DepositCard, «Segna rimborsata») */
  const markRefunded = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await agendaApi.markDepositRefunded(appt.id);
      if (alive.current) adopt(res);
      fireToast({ msg: t('Caparra segnata come rimborsata', 'Deposit marked as refunded'), icon: 'check' });
      onMutate?.(res);
    } catch (err) { toastApiError(err, fireToast, t); }
    finally { if (alive.current) setBusy(false); }
  };

  // motivazione e nota di no-show e annullamento (ReasonPicker)
  const reasonProps = { reason, setReason, reasonNote, setReasonNote, t, session, onClose, setDeepLink, setTab };

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
        <ReasonPicker reasons={noShowReasons} {...reasonProps} />
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
        <WhoCancels appt={appt} cancelByClient={cancelByClient} setCancelByClient={setCancelByClient} cancelMinHours={cancelMinHours} t={t} />
        <div className="t-meta" style={{ marginBottom: 12 }}>{t('Cosa succederà', 'What will happen')}</div>
        <div style={{ padding: '16px 16px 14px', borderRadius: 14, background: 'var(--surface-2)', marginBottom: 18 }}>
          <FlowSteps steps={cancelSteps(appt, matchCount, t, lang, { byClient: cancelByClient, minHours: cancelMinHours })} />
        </div>
        <ReasonPicker reasons={cancelReasons} {...reasonProps} />
      </DkPanel>
    );
  }

  /* ---- DETTAGLIO (predefinito) ----
   * Pannello laterale e non finestra centrata: l'agenda resta visibile di fianco
   * e il blocco su cui si sta intervenendo è evidenziato, così non si perde mai
   * di vista il contesto (a schermo stretto il pannello prende tutto). */
  return (
    <DkPanel onClose={onClose} title={appt.client?.full_name} sub={`${fmtDateIt(dateStr)} · ${timeLabel(startMin)}–${timeLabel(endMin)}`}
      foot={(
        <DetailFooter
          appt={appt} t={t} itemsEditable={itemsEditable} dirty={dirty} itemsDirty={itemsDirty} noteDirty={noteDirty}
          savingItems={savingItems} editItems={editItems} terminal={terminal} canWrite={canWrite} busy={busy}
          saveChanges={saveChanges} checkIn={checkIn} startAppt={startAppt} checkout={checkout} startReschedule={startReschedule}
          onDiscard={discardDraft} onNoShow={openNoShow} onCancel={openCancel}
        />
      )}>
      {/* client meta bar */}
      <ClientMetaBar appt={appt} sm={sm} clientDetail={clientDetail} t={t} lang={lang} openClient={openClient} />

      {/* Una colonna: il pannello è stretto e le due colonne del vecchio modale
          restavano sbilanciate, una piena e una mezza vuota. `order` mette per
          primo quello che si guarda per primo — i servizi — senza spostare il
          codice. */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {/* chi e quando */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, order: 2 }}>
          <WhoWhenCard
            appt={appt} o={o} col={col} t={t} lang={lang} canMove={canMove} movingBusy={movingBusy} stepMin={stepMin}
            startMin={startMin} endMin={endMin} dateStr={dateStr} timeDraft={timeDraft} setTimeDraft={setTimeDraft} commitTime={commitTime}
            viewDate={viewDate} showDate={showDate} shiftViewDate={shiftViewDate} applyMove={applyMove}
            visitOps={visitOps} partners={partners} opColors={opColors}
          />

          {/* deposit status */}
          {dm && (
            <DepositCard
              appt={appt} dm={dm} t={t} lang={lang} terminal={terminal} hasScope={hasScope} busy={busy} linkBusy={linkBusy}
              linkCopyFailed={linkCopyFailed} sendDepositLink={sendDepositLink} copyDepositLink={copyDepositLink}
              cashDeposit={cashDeposit} onMarkRefunded={markRefunded}
            />
          )}

          {/* note edit → PUT /appointments/{id} (vedi NoteEditor) */}
          <NoteEditor appt={appt} t={t} itemsEditable={itemsEditable} note={note} setNote={setNote} noteDirty={noteDirty} />

          {/* margin — behind a small toggle */}
          <MarginSection showMargin={showMargin} setShowMargin={setShowMargin} margin={margin} t={t} lang={lang} />
        </div>

        {/* che cosa si fa */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, order: 1 }}>
          {/* services — read-only when terminal / no write scope, editable otherwise */}
          {!itemsEditable ? (
            <ServicesReadOnly appt={appt} operators={operators} t={t} lang={lang} />
          ) : (
            <ServicesEditor
              appt={appt} editItems={editItems} spans={spans} gaps={gaps} startMin={startMin} justAdded={justAdded} addedRef={addedRef}
              addingSvc={addingSvc} setAddingSvc={setAddingSvc} editTotal={editTotal} itemsDirty={itemsDirty}
              operators={operators} opColors={opColors} t={t} lang={lang}
              catalog={{ svcOf, catColor, eligibleOps, svcDisplayName, catalogSoak, activeServices }}
              rows={{
                draftOf, setDraft, commitItemStart, commitItemEnd, setItemDuration, clampItemDuration, setItemOperator, setItemGap,
                removeServiceItem, addServiceItem,
              }}
            />
          )}

        </div>
      </div>

    </DkPanel>
  );
}
