// ApptDetailModal — full appointment detail: lifecycle actions, note edit, margin,
// reschedule via availability + move, freed-slot waitlist hand-off on cancel/no-show.
import React, { useEffect, useRef, useState } from 'react';
import { api, ApiError, Avatar, Icon, fmtEur, fmtDur, timeLabel, minutesOfDay, fmtDateIt, todayStr, toDateStr, statusMeta, depositMeta, NumInput, parseISO } from '@youty/shared';
import DkModal from '../../../ui/DkModal.jsx';
import FlowSteps from '../FlowSteps.jsx';
import { useDash } from '../../../ctx.jsx';
import { aStartMin, aEndMin, initialsOf, toastErr, fmtMoney, wlMatches, noShowSteps, cancelSteps, isoAtMin, hmToMin } from '../lib.js';

// Motivazioni predefinite: il titolare può sostituirle dalle Impostazioni
// (settings.no_show_reasons / cancel_reasons); qui restano come fallback.
const NOSHOW_REASONS = [['cliente', 'Mancata presenza', 'No-show'], ['salute', 'Malattia / imprevisto', 'Illness / emergency'], ['altro', 'Altro', 'Other']];
const CANCEL_REASONS = [['cliente', 'Richiesta cliente', 'Client request'], ['salute', 'Malattia', 'Illness'], ['agenda', 'Sovrapposizione', 'Schedule clash'], ['altro', 'Altro', 'Other']];
const customReasons = (list, fallback) => (Array.isArray(list) && list.length ? list.map((r, i) => ['c' + i, r, r]) : fallback);

export default function ApptDetailModal({ appointment, onMutate, onClose }) {
  const { t, lang, operators, opColors, services, serviceCategories, settings, session, fireToast, openModal, setTab, setDeepLink, setSelClient, hasScope } = useDash();
  const canWrite = hasScope('agenda');
  const [appt, setAppt] = useState(appointment);
  const [flow, setFlow] = useState(null); // 'reschedule' | 'noshow' | 'cancel' | 'split'
  const [splitItem, setSplitItem] = useState(null); // item da staccare (flow 'split')
  const [reason, setReason] = useState(null);
  const [reasonNote, setReasonNote] = useState('');
  const [busy, setBusy] = useState(false);
  const noShowReasons = customReasons(settings?.no_show_reasons, NOSHOW_REASONS);
  const cancelReasons = customReasons(settings?.cancel_reasons, CANCEL_REASONS);
  const [linkBusy, setLinkBusy] = useState(false);

  /* link di pagamento della caparra: crea (o rimanda come sollecito) e copia */
  async function sendDepositLink() {
    if (linkBusy) return;
    setLinkBusy(true);
    try {
      const res = await api.post(`/api/sales/appointments/${appt.id}/deposit-link`, {});
      setAppt((a) => ({ ...a, deposit_payment_link: res.url, deposit_due_at: res.due_at || a.deposit_due_at }));
      fireToast({ msg: appt.deposit_payment_link ? t('Sollecito inviato alla cliente', 'Reminder sent to the client') : t('Link di pagamento inviato alla cliente', 'Payment link sent to the client'), icon: 'check' });
      onMutate?.();
    } catch (err) {
      if (err instanceof ApiError && err.status === 503) fireToast({ msg: t('Pagamenti online non configurati: collega Stripe in Impostazioni → Pagamenti', 'Online payments not configured: connect Stripe in Settings → Payments'), icon: 'alert' });
      else toastErr(err, t, fireToast);
    } finally { setLinkBusy(false); }
  }
  /* Caparra incassata al banco (contanti o POS del salone). Senza questo,
   * l'unico modo di segnarla pagata era il pagamento online: dove Stripe non
   * è configurato — o quando la cliente paga di persona — il termine scadeva
   * lo stesso e lo slot si liberava da solo. */
  async function cashDeposit(method) {
    if (linkBusy) return;
    setLinkBusy(true);
    try {
      const res = await api.post(`/api/agenda/appointments/${appt.id}/deposit-cashed`, { method });
      setAppt(res);
      fireToast({ msg: t('Caparra incassata e registrata in cassa', 'Deposit cashed and recorded in the till'), icon: 'check' });
      onMutate?.();
    } catch (err) { toastErr(err, t, fireToast); }
    finally { setLinkBusy(false); }
  }

  async function restoreReleased(force = false) {
    if (busy) return;
    setBusy(true);
    try {
      const res = await api.post(`/api/agenda/appointments/${appt.id}/restore`, { force });
      setAppt(res);
      fireToast({ msg: t('Appuntamento ripristinato', 'Appointment restored'), icon: 'check' });
      onMutate?.();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && !force) fireToast({ msg: t('Lo slot non è più libero: usa «Ripristina comunque»', 'The slot is no longer free: use “Restore anyway”'), icon: 'alert' });
      else toastErr(err, t, fireToast);
    } finally { setBusy(false); }
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

  /* cancellazione "tardiva" (caparra trattenuta) se manca meno della soglia salone */
  const cancelMinH = settings?.cancel_min_hours ?? 24;
  const lateCancel = !!appt && parseISO(appt.start).getTime() - Date.now() < cancelMinH * 3600000;

  /* enrich with client stats (visits, spend, categories, deposit_always) */
  const [clientDetail, setClientDetail] = useState(null);
  useEffect(() => {
    if (appt?.client?.id) api.get(`/api/clients/${appt.client.id}`).then(setClientDetail).catch(() => {});
  }, [appt?.client?.id]);

  /* note edit */
  const [note, setNote] = useState(appointment?.note || '');
  const [savingNote, setSavingNote] = useState(false);
  const noteDirty = note !== (appt?.note || '');

  /* services edit → PUT /appointments/{id} with the full items list */
  const itemSeq = useRef(1);
  const mkEditItems = (list) => (list || []).map((it) => ({
    key: 'e' + (itemSeq.current++),
    id: it.id,                        // existing item id (undefined for new lines → creates)
    service_id: it.service_id,
    operator_id: it.operator_id ?? null,
    duration_min: it.duration_min,
    price: Number(it.price) || 0,
    name: it.service_name,
  }));
  const [editItems, setEditItems] = useState(() => mkEditItems(appointment?.items));
  const [addingSvc, setAddingSvc] = useState(false);
  const [savingItems, setSavingItems] = useState(false);
  useEffect(() => { setEditItems(mkEditItems(appt?.items)); setAddingSvc(false); }, [appt]); // eslint-disable-line react-hooks/exhaustive-deps

  /* margin (behind a small toggle) */
  const [showMargin, setShowMargin] = useState(false);
  const [margin, setMargin] = useState(null);
  useEffect(() => {
    if (showMargin && !margin && appt?.id) {
      api.get(`/api/agenda/appointments/${appt.id}/margin`).then(setMargin).catch((err) => { toastErr(err, t, fireToast); setShowMargin(false); });
    }
  }, [showMargin]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!appt) return null;
  const o = operators.find((x) => x.id === appt.operator_id);
  const col = opColors[appt.operator_id] || 'var(--clay)';
  const sm = statusMeta(appt.status, t);
  const dm = depositMeta(appt.deposit_status, t);
  const startMin = aStartMin(appt), endMin = aEndMin(appt);
  // toDateStr e non slice(0, 10): `start` è l'istante in UTC, e il giorno
  // del salone può essere quello dopo (appuntamento delle 23:30).
  const dateStr = toDateStr(appt.start);
  const terminal = ['closed', 'no_show', 'cancelled'].includes(appt.status);

  /* ---- editable services (only when live + can write) ---- */
  const itemsEditable = !terminal && canWrite;
  const svcOf = (id) => (services || []).find((s) => s.id === id);
  const activeServices = (services || []).filter((s) => s.active !== false);
  const catColor = (catId) => (serviceCategories || []).find((c) => c.id === catId)?.color || 'var(--clay)';
  const eligibleOps = (serviceId) => operators.filter((op) => (op.service_ids || []).includes(serviceId));
  const svcDisplayName = (it) => { const s = svcOf(it.service_id); return s ? (lang === 'en' && s.name_en ? s.name_en : s.name_it) : (it.name || it.service_name || ''); };
  const itemsSig = (list) => JSON.stringify((list || []).map((i) => [i.id ?? null, i.service_id, i.operator_id ?? null, Number(i.duration_min) || 0]));
  const itemsDirty = itemsSig(editItems) !== itemsSig(appt.items);
  const editTotal = editItems.reduce((s, it) => s + Number(it.price || 0), 0);

  const addServiceItem = (sid) => {
    const s = svcOf(sid);
    setEditItems((l) => [...l, { key: 'e' + (itemSeq.current++), id: undefined, service_id: sid, operator_id: null, duration_min: s?.duration_min ?? 30, price: Number(s?.price) || 0, name: s ? (lang === 'en' && s.name_en ? s.name_en : s.name_it) : '' }]);
  };
  const removeServiceItem = (key) => setEditItems((l) => l.filter((x) => x.key !== key));
  const setItemDuration = (key, raw) => setEditItems((l) => l.map((x) => (x.key === key ? { ...x, duration_min: raw === '' ? '' : Math.max(0, parseInt(raw, 10) || 0) } : x)));
  const clampItemDuration = (key) => setEditItems((l) => l.map((x) => (x.key === key ? { ...x, duration_min: Math.max(5, parseInt(x.duration_min, 10) || 5) } : x)));
  const setItemOperator = (key, opId) => setEditItems((l) => l.map((x) => (x.key === key ? { ...x, operator_id: opId } : x)));

  async function saveItems() {
    if (savingItems || !editItems.length) return;
    setSavingItems(true);
    try {
      const res = await api.put(`/api/agenda/appointments/${appt.id}`, {
        items: editItems.map((it) => ({
          ...(it.id != null ? { id: it.id } : {}),   // existing → id; new → omitted; omitted rows → removed
          service_id: it.service_id,
          operator_id: it.operator_id ?? null,
          duration_min: Math.max(5, parseInt(it.duration_min, 10) || 5),
        })),
      });
      setAppt(res);
      fireToast({ msg: t('Appuntamento aggiornato', 'Appointment updated'), icon: 'check' });
      onMutate?.();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) fireToast({ msg: t('Orario non più disponibile', 'Time no longer available'), icon: 'alert' });
      else toastErr(err, t, fireToast);
    } finally { setSavingItems(false); }
  }

  const openClient = () => { setSelClient(appt.client.id); setTab('clienti'); onClose(); };

  async function saveNote() {
    setSavingNote(true);
    try {
      const res = await api.put(`/api/agenda/appointments/${appt.id}`, { note });
      setAppt(res);
      fireToast({ msg: t('Nota salvata', 'Note saved'), icon: 'check' });
    } catch (err) { toastErr(err, t, fireToast); }
    finally { setSavingNote(false); }
  }

  async function lifecycle(action, body, toastMsg, icon) {
    if (busy) return false;
    setBusy(true);
    try {
      await api.post(`/api/agenda/appointments/${appt.id}/${action}`, body || {});
      fireToast({ msg: toastMsg, icon });
      return true;
    } catch (err) { toastErr(err, t, fireToast); return false; }
    finally { setBusy(false); }
  }

  const checkIn = async () => { if (await lifecycle('check-in', null, t('Check-in registrato', 'Checked in'), 'check')) onClose(); };
  const startAppt = async () => { if (await lifecycle('start', null, t('Trattamento avviato', 'Treatment started'), 'clock')) onClose(); };

  /* cancel / no-show → then offer the freed slot to matching waitlist entries */
  async function destroy(kind) {
    const reasons = kind === 'no-show' ? noShowReasons : cancelReasons;
    const label = (reasons.find((r) => r[0] === reason) || [])[1] || '';
    const fullReason = [label, reasonNote].filter(Boolean).join(' — ');
    const ok = await lifecycle(
      kind, { reason: fullReason },
      kind === 'no-show' ? t('No-show registrato · slot liberato', 'No-show recorded · slot freed') : t('Appuntamento cancellato · slot liberato', 'Appointment cancelled · slot freed'),
      kind === 'no-show' ? 'alert' : 'x'
    );
    if (!ok) return;
    try {
      const wl = await api.get('/api/agenda/waitlist');
      const matches = wlMatches(wl, appt);
      if (matches.length) { openModal('freedslot', { appointment: appt, matches }); return; }
    } catch { /* ignore — just close */ }
    onClose();
  }

  /* ---- reason picker (shared by no-show + cancel) ---- */
  const ReasonPicker = ({ reasons }) => (
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
      <textarea value={reasonNote} onChange={(e) => setReasonNote(e.target.value)} placeholder={t('Aggiungi un dettaglio…', 'Add a detail…')} rows={2}
        style={{ width: '100%', border: '1px solid var(--hair)', borderRadius: 12, padding: '10px 12px', fontSize: 13.5, fontFamily: 'var(--sans)', resize: 'vertical', outline: 'none', boxSizing: 'border-box', background: 'var(--surface)' }} />
    </div>
  );

  /* ---- RESCHEDULE flow ---- */
  if (flow === 'reschedule') {
    return (
      <RescheduleFlow appt={appt} t={t} lang={lang} fireToast={fireToast} busy={busy} setBusy={setBusy}
        onBack={() => setFlow(null)} onClose={onClose} onDone={onClose} />
    );
  }

  /* ---- SPLIT flow: stacca un servizio e lo sposta (anche in un altro giorno) ---- */
  if (flow === 'split' && splitItem) {
    return (
      <SplitFlow appt={appt} item={splitItem} t={t} lang={lang} fireToast={fireToast} operators={operators}
        onBack={() => { setFlow(null); setSplitItem(null); }} onClose={onClose}
        onDone={(res) => { setAppt(res.original); setFlow(null); setSplitItem(null); onMutate?.(); }} />
    );
  }

  /* ---- NO-SHOW flow ---- */
  if (flow === 'noshow') {
    return (
      <DkModal open onClose={onClose} title={t('Segna no-show', 'Mark no-show')} sub={`${appt.client?.full_name} · ${timeLabel(startMin)}`} width={460}
        foot={
          <React.Fragment>
            <button className="dk-btn dk-btn--ghost" onClick={() => setFlow(null)}>{t('Indietro', 'Back')}</button>
            <button className="dk-btn" disabled={busy} onClick={() => destroy('no-show')} style={{ background: 'var(--danger)', color: '#fff' }}>
              <Icon name="alert" size={16} color="#fff" />{t('Conferma no-show', 'Confirm no-show')}
            </button>
          </React.Fragment>
        }>
        <div className="t-meta" style={{ marginBottom: 12 }}>{t('Cosa succederà', 'What will happen')}</div>
        <div style={{ padding: '16px 16px 14px', borderRadius: 14, background: 'var(--surface-2)', marginBottom: 18 }}>
          <FlowSteps steps={noShowSteps(appt, matchCount, t, lang)} />
        </div>
        <ReasonPicker reasons={noShowReasons} />
      </DkModal>
    );
  }

  /* ---- CANCEL flow ---- */
  if (flow === 'cancel') {
    return (
      <DkModal open onClose={onClose} title={t('Cancella appuntamento', 'Cancel appointment')} sub={`${appt.client?.full_name} · ${timeLabel(startMin)}`} width={460}
        foot={
          <React.Fragment>
            <button className="dk-btn dk-btn--ghost" onClick={() => { setFlow(null); setReason(null); setReasonNote(''); }}>{t('Indietro', 'Back')}</button>
            <button className="dk-btn" disabled={!reason || busy} onClick={() => destroy('cancel')} style={{ background: 'var(--danger)', color: '#fff', opacity: reason ? 1 : 0.4 }}>
              <Icon name="x" size={16} color="#fff" />{t('Conferma cancellazione', 'Confirm cancellation')}
            </button>
          </React.Fragment>
        }>
        <div className="t-meta" style={{ marginBottom: 12 }}>{t('Cosa succederà', 'What will happen')}</div>
        <div style={{ padding: '16px 16px 14px', borderRadius: 14, background: 'var(--surface-2)', marginBottom: 18 }}>
          <FlowSteps steps={cancelSteps(appt, lateCancel, matchCount, t, lang)} />
        </div>
        <ReasonPicker reasons={cancelReasons} />
      </DkModal>
    );
  }

  /* ---- DETAIL (default) ---- */
  return (
    <DkModal open onClose={onClose} title={appt.client?.full_name} sub={`${fmtDateIt(dateStr)} · ${timeLabel(startMin)}–${timeLabel(endMin)}`} width={840}>
      {/* client meta bar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        <Avatar initials={initialsOf(appt.client?.full_name)} size={40} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 11.5, fontWeight: 700, color: sm.color, background: sm.tint, padding: '3px 9px', borderRadius: 99 }}>{sm.label}</span>
            {appt.forced && <span title={t('Inserito o spostato forzando le regole (fuori turno o sovrapposizione)', 'Inserted or moved overriding the rules (off shift or overlap)')} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 700, color: 'var(--warn)', background: 'var(--warn-tint)', padding: '3px 9px', borderRadius: 99 }}><Icon name="alert" size={11} color="var(--warn)" />{t('Forzato', 'Forced')}</span>}
            {(appt.gifts || []).length > 0 && <span title={(appt.gifts || []).map((g) => `${g.service_name} · ${g.code}${g.from_name ? ' · ' + t('da', 'from') + ' ' + g.from_name : ''}`).join('\n')} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 700, color: 'var(--clay-ink)', background: 'var(--clay-tint)', padding: '3px 9px', borderRadius: 99 }}><Icon name="gift" size={11} color="var(--clay-ink)" />{t('Regalo', 'Gift')}{(appt.gifts || [])[0]?.from_name ? ' · ' + t('da', 'from') + ' ' + appt.gifts[0].from_name : ''}</span>}
            {(clientDetail?.categories || []).slice(0, 2).map((c) => (
              <span key={c.id} style={{ fontSize: 11, fontWeight: 700, color: 'var(--ink-2)', background: c.color || 'var(--surface-2)', padding: '3px 9px', borderRadius: 99 }}>{c.name}</span>
            ))}
            {clientDetail && <span className="t-sm" style={{ color: 'var(--muted)' }}>{clientDetail.visits} {t('visite', 'visits')} · {fmtMoney(clientDetail.total_spent, lang)}</span>}
          </div>
          {appt.client?.phone && <a href={'tel:' + appt.client.phone} className="tabnum" style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink-2)', textDecoration: 'none' }}>{appt.client.phone}</a>}
        </div>
        <div style={{ flex: 1 }} />
        <button className="dk-btn dk-btn--soft" style={{ height: 38, fontSize: 13, padding: '0 14px' }} onClick={openClient}>{t('Apri scheda cliente', 'Open client')}</button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 18, alignItems: 'start' }}>
        {/* LEFT — who */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {/* operator hero */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 16px', borderRadius: 16, background: `color-mix(in srgb, ${col} 26%, #FFFFFF)` }}>
            <Avatar initials={o?.initials || initialsOf((appt.items || [])[0]?.operator_name)} size={50} color={col} ring />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="t-meta" style={{ fontSize: 10, color: 'var(--ink-2)', opacity: 0.7, marginBottom: 1 }}>{t('Operatrice', 'Stylist')}</div>
              <div style={{ fontFamily: 'var(--serif)', fontSize: 22, fontWeight: 500, lineHeight: 1.05 }}>{o ? o.first_name : (appt.items || [])[0]?.operator_name}</div>
              {o?.role_title && <div className="t-sm" style={{ color: 'var(--ink-2)', opacity: 0.75 }}>{o.role_title}</div>}
            </div>
            <div style={{ textAlign: 'right' }}>
              <div className="tabnum" style={{ fontWeight: 700, fontSize: 15 }}>{timeLabel(startMin)}</div>
              <div className="t-sm" style={{ color: 'var(--ink-2)', opacity: 0.7 }}>{fmtDur(appt.total_duration_min, lang)}</div>
            </div>
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
                      {appt.deposit_status === 'paid' && <>, {t('in cassa', 'in the till')} <b className="tabnum">{fmtEur(Number(appt.deposit_credit), lang)}</b></>}
                    </span>
                  )}
                  {appt.deposit_status === 'required' && appt.deposit_due_at && !terminal && (
                    <span> · {t('entro le', 'by')} <b className="tabnum">{new Date(appt.deposit_due_at).toLocaleString(lang === 'en' ? 'en-GB' : 'it-IT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</b>{t(', poi lo slot si libera', ', then the slot is freed')}</span>
                  )}
                </div>
                {appt.deposit_status === 'required' && !terminal && hasScope('sales') && (
                  <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
                    <button className="dk-btn dk-btn--soft" disabled={linkBusy} style={{ height: 30, fontSize: 12 }} onClick={sendDepositLink} title={t('Crea il link di pagamento Stripe e lo manda alla cliente (WhatsApp via Yourang)', 'Creates the Stripe payment link and sends it to the client (WhatsApp via Yourang)')}>
                      <Icon name="send" size={13} />{appt.deposit_payment_link ? t('Sollecita', 'Remind') : t('Invia link di pagamento', 'Send payment link')}
                    </button>
                    {appt.deposit_payment_link && (
                      <button className="dk-btn dk-btn--ghost" style={{ height: 30, fontSize: 12 }} onClick={() => { navigator.clipboard?.writeText(appt.deposit_payment_link); fireToast({ msg: t('Link copiato', 'Link copied'), icon: 'check' }); }}>
                        <Icon name="copy" size={13} />{t('Copia link', 'Copy link')}
                      </button>
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
                      setAppt(res);
                      fireToast({ msg: t('Caparra segnata come rimborsata', 'Deposit marked as refunded'), icon: 'check' });
                    } catch (err) { toastErr(err, t, fireToast); }
                    finally { setBusy(false); }
                  }}>
                  <Icon name="check" size={14} />{t('Segna rimborsata', 'Mark refunded')}
                </button>
              )}
            </div>
          )}

          {/* note edit → PUT /appointments/{id} */}
          <div>
            <div className="t-meta" style={{ marginBottom: 6 }}>{t('Nota appuntamento', 'Appointment note')}</div>
            <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder={t('Aggiungi una nota…', 'Add a note…')}
              style={{ width: '100%', border: '1px solid var(--hair)', borderRadius: 12, padding: '10px 12px', fontSize: 13.5, fontFamily: 'var(--sans)', resize: 'vertical', outline: 'none', boxSizing: 'border-box', background: 'var(--surface)' }} />
            {noteDirty && (
              <button className="dk-btn dk-btn--soft" disabled={savingNote || !canWrite} style={{ height: 34, fontSize: 12.5, marginTop: 6 }} onClick={saveNote}>
                <Icon name="check" size={14} />{savingNote ? t('Salvataggio…', 'Saving…') : t('Salva nota', 'Save note')}
              </button>
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
                  {[[t('Ricavo', 'Revenue'), margin.revenue, false], [t('Costo prodotti', 'Product cost'), margin.product_cost, true], [t('Costo fornitori', 'Supplier cost'), margin.supplier_cost, true], [t('Costo lavoro', 'Labour cost'), margin.labor_cost, true]].map(([l, v, neg], i) => (
                    <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '2px 0' }}>
                      <span className="t-sm" style={{ color: 'var(--muted)' }}>{l}</span>
                      <span className="tabnum" style={{ fontSize: 12.5 }}>{neg ? '− ' : ''}{fmtEur(Number(v), lang)}</span>
                    </div>
                  ))}
                  <div className="hr" style={{ margin: '6px 0' }} />
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                    <span style={{ fontWeight: 700, fontSize: 13.5 }}>{t('Margine stimato', 'Estimated margin')}</span>
                    <span className="t-num" style={{ fontWeight: 800, fontSize: 16, color: Number(margin.margin) >= 0 ? 'var(--ok)' : 'var(--danger)' }}>{fmtEur(Number(margin.margin), lang)} · {margin.margin_pct}%</span>
                  </div>
                </div>
              )
            )}
          </div>
        </div>

        {/* RIGHT — what & actions */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, padding: 16, borderRadius: 16, border: '1px solid var(--hair)', background: 'color-mix(in srgb, var(--surface-2) 45%, transparent)' }}>
          {/* services — read-only when terminal / no write scope, editable otherwise */}
          {!itemsEditable ? (
            <div style={{ background: 'var(--surface-2)', borderRadius: 14, padding: 14 }}>
              {(appt.items || []).map((it) => {
                const gift = (appt.gifts || []).find((g) => g.service_id === it.service_id);
                return (
                  <div key={it.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, padding: '6px 0' }}>
                    <span style={{ fontWeight: 600, fontSize: 14, flex: 1, minWidth: 0 }}>{it.service_name}{gift && <span title={`${t('Gift card', 'Gift card')} ${gift.code}`} style={{ marginLeft: 6, display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 10.5, fontWeight: 700, color: 'var(--clay-ink)', background: 'var(--clay-tint)', padding: '1px 7px', borderRadius: 99, verticalAlign: 'middle' }}><Icon name="gift" size={10} color="var(--clay-ink)" />{t('Regalo', 'Gift')}</span>}</span>
                    <span className="t-sm" style={{ color: 'var(--muted)' }}>{fmtDur(it.duration_min, lang)} · {fmtEur(Number(it.price), lang)}</span>
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
                  qui, insieme al modo per dividerla. Senza questa riga l'unico
                  indizio era un'icona muta accanto al servizio. */}
              {(appt.items || []).length > 1 && (
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 10, padding: '8px 10px', borderRadius: 10, background: 'var(--surface)', border: '1px dashed var(--hair)' }}>
                  <Icon name="calendar" size={14} color="var(--muted)" style={{ flexShrink: 0, marginTop: 1 }} />
                  <div className="t-sm" style={{ color: 'var(--ink-2)', lineHeight: 1.35 }}>
                    <b>{t(`${(appt.items || []).length} servizi in un'unica visita`, `${(appt.items || []).length} services in one visit`)}</b>{' — '}
                    {t('trascinandola in agenda si spostano tutti insieme. Per spostarne uno solo, usa «Stacca».', 'dragging it in the agenda moves them together. To move just one, use “Detach”.')}
                  </div>
                </div>
              )}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {editItems.map((it) => {
                  const s = svcOf(it.service_id);
                  const color = catColor(s?.category_id);
                  const isNew = it.id == null;
                  const eligible = isNew ? eligibleOps(it.service_id) : [];
                  return (
                    <div key={it.key} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ width: 8, height: 8, borderRadius: 99, background: color, flexShrink: 0 }} />
                        <span style={{ flex: 1, minWidth: 0, fontWeight: 600, fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {svcDisplayName(it)}
                          {(appt.gifts || []).some((g) => g.service_id === it.service_id) && <Icon name="gift" size={12} color="var(--clay-ink)" title={t('Coperto da gift card', 'Covered by a gift card')} style={{ marginLeft: 6, verticalAlign: '-2px' }} />}
                        </span>
                        {!isNew && (appt.items || []).length > 1 && (
                          <button className="dk-btn dk-btn--ghost" title={t('Stacca questo servizio e spostalo in un altro orario o giorno', 'Detach this service and move it to another time or day')} onClick={() => { const orig = (appt.items || []).find((x) => x.id === it.id); if (orig) { setSplitItem(orig); setFlow('split'); } }} style={{ height: 28, padding: '0 8px', borderRadius: 8, flexShrink: 0, fontSize: 12, fontWeight: 700, gap: 5 }}>
                            <Icon name="calendar" size={13} />{t('Stacca', 'Detach')}
                          </button>
                        )}
                        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 3, flexShrink: 0 }}>
                          <NumInput integer min={5} value={it.duration_min} emptyValue=""
                            onChange={(v) => setItemDuration(it.key, v)} onBlur={() => clampItemDuration(it.key)}
                            aria-label={t('Durata in minuti', 'Duration in minutes')}
                            style={{ width: 48, border: '1px solid var(--hair)', borderRadius: 8, padding: '4px 6px', fontSize: 12.5, fontFamily: 'var(--sans)', textAlign: 'right', outline: 'none', background: 'var(--surface)', color: 'var(--ink)' }} />
                          <span className="t-sm" style={{ color: 'var(--muted)' }}>{t('min', 'min')}</span>
                        </div>
                        <span className="t-num" style={{ fontSize: 13, fontWeight: 700, flexShrink: 0, minWidth: 46, textAlign: 'right' }}>{fmtEur(Number(it.price), lang)}</span>
                        <button className="dk-iconbtn" title={t('Rimuovi servizio', 'Remove service')} onClick={() => removeServiceItem(it.key)} style={{ width: 28, height: 28, borderRadius: 8, flexShrink: 0 }}>
                          <Icon name="x" size={14} />
                        </button>
                      </div>
                      {isNew && eligible.length > 0 && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, paddingLeft: 16 }}>
                          <Icon name="sparkle" size={12} color="var(--muted-2)" />
                          <select value={it.operator_id ?? ''} onChange={(e) => setItemOperator(it.key, e.target.value ? Number(e.target.value) : null)}
                            style={{ border: '1px solid var(--hair)', borderRadius: 8, padding: '4px 6px', fontSize: 12, fontFamily: 'var(--sans)', background: 'var(--surface)', color: 'var(--ink-2)', outline: 'none', cursor: 'pointer' }}>
                            <option value="">{t('Prima disponibile', 'First available')}</option>
                            {eligible.map((op) => <option key={op.id} value={op.id}>{op.first_name}</option>)}
                          </select>
                        </div>
                      )}
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
                        {activeServices.map((s) => (
                          <button key={s.id} onClick={() => { addServiceItem(s.id); setAddingSvc(false); }} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 10px', borderRadius: 99, fontSize: 12, fontWeight: 600, cursor: 'pointer', border: '1px solid var(--hair)', background: 'var(--surface)', color: 'var(--ink-2)' }}>
                            <span style={{ width: 7, height: 7, borderRadius: 99, background: catColor(s.category_id) }} />
                            {lang === 'en' && s.name_en ? s.name_en : s.name_it}
                            <Icon name="plus" size={12} color="var(--muted-2)" />
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
              <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700 }}>
                <span>{t('Totale', 'Total')}</span>
                <span className="t-num" style={{ fontSize: 17 }}>{fmtMoney(editTotal, lang)}</span>
              </div>
              {itemsDirty && (
                <button className="dk-btn dk-btn--soft" disabled={savingItems || !editItems.length} onClick={saveItems} style={{ height: 36, fontSize: 12.5, marginTop: 10, width: '100%' }}>
                  <Icon name="check" size={14} />{savingItems ? t('Salvataggio…', 'Saving…') : t('Salva modifiche', 'Save changes')}
                </button>
              )}
            </div>
          )}

          {/* lifecycle actions */}
          {!terminal && canWrite && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              {appt.status === 'confirmed' && (
                <button className="dk-btn dk-btn--clay" disabled={busy} style={{ gridColumn: '1 / -1', height: 48 }} onClick={checkIn}>
                  <Icon name="check" size={18} color="#fff" />{t('Check-in', 'Check in')}
                </button>
              )}
              {appt.status === 'checked_in' && (
                <button className="dk-btn dk-btn--clay" disabled={busy} style={{ gridColumn: '1 / -1', height: 48 }} onClick={startAppt}>
                  <Icon name="play" size={17} color="#fff" />{t('Inizia trattamento', 'Start treatment')}
                </button>
              )}
              <button className={'dk-btn ' + (appt.status === 'in_progress' ? 'dk-btn--clay' : 'dk-btn--ghost')} style={{ gridColumn: '1 / -1', height: appt.status === 'in_progress' ? 48 : 44 }} onClick={() => openModal('sell', { appointment: appt, onDone: onMutate })}>
                <Icon name="wallet" size={17} color={appt.status === 'in_progress' ? '#fff' : undefined} />{t('Vai al checkout', 'Go to checkout')}
              </button>
              <button className="dk-btn dk-btn--soft" style={{ gridColumn: '1 / -1' }} onClick={() => setFlow('reschedule')}>
                <Icon name="calendar" size={16} />{t('Riprogramma', 'Reschedule')}
              </button>
            </div>
          )}
          {terminal && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '11px 13px', borderRadius: 12, background: appt.auto_released ? 'var(--warn-tint)' : sm.tint }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                <Icon name={appt.auto_released ? 'alert' : sm.icon} size={16} color={appt.auto_released ? 'var(--warn)' : sm.color} />
                <span style={{ fontWeight: 700, fontSize: 13.5, color: appt.auto_released ? 'var(--warn)' : sm.color }}>{appt.auto_released ? t('Slot liberato: caparra non pagata in tempo', 'Slot freed: deposit not paid in time') : sm.label}</span>
                {appt.cancel_reason && !appt.auto_released && <span className="t-sm" style={{ color: 'var(--muted)', marginLeft: 'auto' }}>{appt.cancel_reason}</span>}
              </div>
              {appt.auto_released && canWrite && (
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  <button className="dk-btn dk-btn--soft" disabled={busy} style={{ height: 32, fontSize: 12.5 }} onClick={() => restoreReleased(false)}><Icon name="refresh" size={14} />{t('Ripristina', 'Restore')}</button>
                  <button className="dk-btn dk-btn--ghost" disabled={busy} style={{ height: 32, fontSize: 12.5 }} onClick={() => restoreReleased(true)} title={t('Anche se lo slot è stato occupato (sovrapposizione)', 'Even if the slot has been taken (overlap)')}>{t('Ripristina comunque', 'Restore anyway')}</button>
                  {appt.client?.phone && <a href={'tel:' + appt.client.phone} className="dk-btn dk-btn--ghost" style={{ height: 32, fontSize: 12.5, textDecoration: 'none' }}><Icon name="phone" size={14} />{t('Chiama', 'Call')}</a>}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* downgraded destructive actions */}
      {!terminal && canWrite && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 18, paddingTop: 14, marginTop: 14, borderTop: '1px solid var(--hair)' }}>
          <button onClick={() => { setFlow('noshow'); setReason(noShowReasons[0][0]); setReasonNote(''); }} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 600, color: 'var(--muted)', background: 'transparent', border: 'none', cursor: 'pointer', padding: '6px 8px' }}>
            <Icon name="alert" size={15} color="var(--muted)" />No-show
          </button>
          <span style={{ width: 1, height: 16, background: 'var(--hair)' }} />
          <button onClick={() => { setFlow('cancel'); setReason(null); setReasonNote(''); }} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 600, color: 'var(--muted)', background: 'transparent', border: 'none', cursor: 'pointer', padding: '6px 8px' }}>
            <Icon name="x" size={15} color="var(--muted)" />{t('Cancella appuntamento', 'Cancel appointment')}
          </button>
        </div>
      )}
    </DkModal>
  );
}

/* ---- Riprogramma: pick a new slot via availability, then POST /move ---- */
function RescheduleFlow({ appt, t, lang, fireToast, busy, setBusy, onBack, onClose, onDone }) {
  const [manual, setManual] = useState('');
  const [needForce, setNeedForce] = useState(false); // orario fuori dagli slot liberi o 409
  const apptDay = toDateStr(appt.start);   // giorno del salone, non quello UTC
  const [date, setDate] = useState(apptDay >= todayStr() ? apptDay : todayStr());
  const [slots, setSlots] = useState(null);
  const [selStart, setSelStart] = useState(null);
  const items = (appt.items || []).map((it) => ({ service_id: it.service_id, operator_id: it.operator_id }));

  useEffect(() => {
    let alive = true;
    setSlots(null); setSelStart(null);
    api.get('/api/agenda/availability', { params: { date, items, location_id: appt.location_id } })
      .then((res) => { if (alive) setSlots(res); })
      .catch((err) => { if (alive) { setSlots([]); toastErr(err, t, fireToast); } });
    return () => { alive = false; };
  }, [date]); // eslint-disable-line react-hooks/exhaustive-deps

  async function move(force = false) {
    if (!selStart || busy) return;
    setBusy(true);
    try {
      await api.post(`/api/agenda/appointments/${appt.id}/move`, { start: selStart, force: force || needForce });
      fireToast({ msg: t('Appuntamento riprogrammato alle ' + timeLabel(minutesOfDay(selStart)), 'Rescheduled to ' + timeLabel(minutesOfDay(selStart))) + (force || needForce ? t(' · forzato', ' · forced') : ''), icon: 'calendar' });
      onDone();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        // lo staff decide: altro orario o forzatura (straordinario, incastro)
        setNeedForce(true);
        fireToast({ msg: t('Orario occupato o fuori turno: puoi forzare con «Sposta comunque»', 'Time busy or off shift: you can override with “Move anyway”'), icon: 'alert' });
      } else toastErr(err, t, fireToast);
    } finally { setBusy(false); }
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
    <DkModal open onClose={onClose} title={t('Riprogramma', 'Reschedule')} sub={`${appt.client?.full_name} · ${t('attuale', 'currently')} ${fmtDateIt(apptDay, { weekday: false })} ${timeLabel(aStartMin(appt))}`} width={560}
      foot={
        <React.Fragment>
          <button className="dk-btn dk-btn--ghost" onClick={onBack}>{t('Indietro', 'Back')}</button>
          <button className={'dk-btn ' + (needForce ? 'dk-btn--soft' : 'dk-btn--clay')} disabled={!selStart || busy} onClick={() => move(false)} style={needForce ? { border: '1px solid var(--warn)' } : undefined}>
            <Icon name={needForce ? 'alert' : 'calendar'} size={16} color={needForce ? 'var(--warn)' : '#fff'} />{needForce ? t('Sposta comunque', 'Move anyway') : t('Sposta qui', 'Move here')}{selStart ? ' · ' + timeLabel(minutesOfDay(selStart)) : ''}
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
    </DkModal>
  );
}

/* ---- stacca un servizio: nuovo appuntamento della stessa cliente, altro orario/giorno ---- */
function SplitFlow({ appt, item, t, lang, fireToast, operators, onBack, onClose, onDone }) {
  const [date, setDate] = useState(toDateStr(appt.start));   // giorno del salone
  const [slots, setSlots] = useState(null);
  const [selStart, setSelStart] = useState(null);
  const [manual, setManual] = useState('');
  const [needForce, setNeedForce] = useState(false);
  const [busy, setBusy] = useState(false);
  const items = [{ service_id: item.service_id, operator_id: item.operator_id }];
  const op = operators.find((o) => o.id === item.operator_id);

  useEffect(() => {
    let alive = true;
    setSlots(null); setSelStart(null); setNeedForce(false);
    api.get('/api/agenda/availability', { params: { date, items, location_id: appt.location_id } })
      .then((res) => { if (alive) setSlots(res); })
      .catch((err) => { if (alive) { setSlots([]); toastErr(err, t, fireToast); } });
    return () => { alive = false; };
  }, [date]); // eslint-disable-line react-hooks/exhaustive-deps

  const applyManual = () => {
    if (!manual) return;
    const minutes = hmToMin(manual);
    const exact = (slots || []).find((s) => minutesOfDay(s.start) === minutes);
    setSelStart(exact ? exact.start : isoAtMin(date, minutes));
    setNeedForce(!exact);
  };

  async function split() {
    if (!selStart || busy) return;
    setBusy(true);
    try {
      const res = await api.post(`/api/agenda/appointments/${appt.id}/split`, { item_id: item.id, start: selStart, force: needForce });
      fireToast({ msg: t(`${item.service_name} spostato: ${fmtDateIt(toDateStr(selStart), { weekday: false })} ${timeLabel(minutesOfDay(selStart))}`, `${item.service_name} moved: ${fmtDateIt(toDateStr(selStart), { weekday: false })} ${timeLabel(minutesOfDay(selStart))}`), icon: 'calendar' });
      onDone(res);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) { setNeedForce(true); fireToast({ msg: t('Orario occupato o fuori turno: puoi forzare con «Sposta comunque»', 'Time busy or off shift: you can override with “Move anyway”'), icon: 'alert' }); }
      else toastErr(err, t, fireToast);
    } finally { setBusy(false); }
  }

  return (
    <DkModal open onClose={onClose} title={t('Stacca e sposta', 'Detach & move')} sub={`${item.service_name} · ${fmtDur(item.duration_min, lang)} · ${op ? op.first_name : ''}`} width={560}
      foot={
        <React.Fragment>
          <button className="dk-btn dk-btn--ghost" onClick={onBack}>{t('Indietro', 'Back')}</button>
          <button className={'dk-btn ' + (needForce ? 'dk-btn--soft' : 'dk-btn--clay')} disabled={!selStart || busy} onClick={split} style={needForce ? { border: '1px solid var(--warn)' } : undefined}>
            <Icon name={needForce ? 'alert' : 'calendar'} size={16} color={needForce ? 'var(--warn)' : '#fff'} />{needForce ? t('Sposta comunque', 'Move anyway') : t('Sposta qui', 'Move here')}{selStart ? ' · ' + timeLabel(minutesOfDay(selStart)) : ''}
          </button>
        </React.Fragment>
      }>
      <div className="t-sm" style={{ color: 'var(--muted)', marginBottom: 12, lineHeight: 1.45 }}>
        {t('Il servizio diventa un appuntamento a sé della stessa cliente; gli altri servizi restano all’orario attuale. La caparra resta sull’appuntamento originale.', 'The service becomes its own appointment for the same client; the other services stay at the current time. The deposit stays on the original appointment.')}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14, padding: '11px 14px', borderRadius: 12, border: '1px solid var(--hair)', background: 'var(--surface)' }}>
        <Icon name="calendar" size={17} color="var(--clay-ink)" />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="t-meta" style={{ fontSize: 9.5, marginBottom: 1 }}>{t('Nuova data', 'New date')}</div>
          <div style={{ fontWeight: 700, fontSize: 13.5 }}>{fmtDateIt(date)}</div>
        </div>
        <input type="date" value={date} min={todayStr()} onChange={(e) => setDate(e.target.value || todayStr())} style={{ border: '1px solid var(--hair)', borderRadius: 8, padding: '6px 8px', fontSize: 12.5, fontFamily: 'var(--sans)', outline: 'none', cursor: 'pointer', color: 'var(--ink)' }} />
      </div>
      <div className="t-meta" style={{ marginBottom: 9 }}>{t('Orari liberi per', 'Free times for')} {op ? op.first_name : t('l’operatrice', 'the stylist')}</div>
      {slots === null ? (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>{[...Array(10)].map((_, i) => <div key={i} className="skel" style={{ width: 56, height: 30, borderRadius: 8 }} />)}</div>
      ) : slots.length ? (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {slots.map((s) => {
            const sel = s.start === selStart;
            return (
              <button key={s.start} onClick={() => { setSelStart(s.start); setNeedForce(false); }} className="tabnum" style={{ padding: '5px 9px', borderRadius: 8, fontSize: 12, fontWeight: 700, cursor: 'pointer', border: '1.5px solid ' + (sel ? 'var(--ink)' : 'var(--hair)'), background: sel ? 'var(--ink)' : 'var(--surface)', color: sel ? '#fff' : 'var(--ink)', opacity: s.recommended === false && !sel ? 0.55 : 1 }}>
                {timeLabel(minutesOfDay(s.start))}
              </button>
            );
          })}
        </div>
      ) : (
        <div className="t-sm" style={{ color: 'var(--danger)', fontWeight: 600 }}>{t('Nessuno slot libero in questa data', 'No free slot on this date')}</div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', borderRadius: 12, border: '1px dashed var(--line-strong)', marginTop: 14, flexWrap: 'wrap' }}>
        <Icon name="clock" size={16} color="var(--muted)" />
        <div style={{ flex: 1, minWidth: 160 }}>
          <div style={{ fontWeight: 700, fontSize: 13 }}>{t('Orario a mano', 'Type a time')}</div>
          <div className="t-sm" style={{ color: 'var(--muted)', fontSize: 11.5 }}>{t('Fuori turno o sovrapposto: si sposta forzando.', 'Off shift or overlapping: moved with override.')}</div>
        </div>
        <input type="time" value={manual} onChange={(e) => setManual(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); applyManual(); } }} style={{ border: '1px solid var(--hair)', borderRadius: 8, padding: '6px 8px', fontSize: 12.5, fontFamily: 'var(--mono, monospace)', fontWeight: 700, outline: 'none', width: 110 }} />
        <button className="dk-btn dk-btn--soft" disabled={!manual} style={{ height: 34, fontSize: 12.5 }} onClick={applyManual}>{t('Usa', 'Use')}</button>
      </div>
    </DkModal>
  );
}
