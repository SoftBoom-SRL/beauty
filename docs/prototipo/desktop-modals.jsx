// desktop-modals.jsx — new appt, appt detail, sell, opportunity (desktop dialogs)
const { useState: useStateDm, useRef: useRefDm } = React;

function DkModals() {
  const { modal, closeModal, t, lang, fireToast } = useDk();
  if (!modal) return null;
  if (modal.type === 'newappt') return <NewApptModal />;
  if (modal.type === 'newclient') return <NewClientFromTopbar />;
  if (modal.type === 'apptdetail') return <ApptDetailModal id={modal.data} />;
  if (modal.type === 'sell') return <SellModal data={modal.data} />;
  if (modal.type === 'catsmgr') return <CatsMgrModal />;
  if (modal.type === 'waitlist') return <WaitListModal />;
  if (modal.type === 'freedslot') return <FreedSlotModal />;
  if (modal.type === 'opportunity') return <OpportunityModal />;
  if (modal.type === 'techsheet') {
    const d = modal.data || {};
    return <TechSheetModal clientId={d.clientId} apptId={d.apptId} apptLabel={d.apptLabel} opId={d.opId} category={d.category} onClose={closeModal} t={t} lang={lang} fireToast={fireToast} />;
  }
  return null;
}

/* ====================================================================
   New appointment — PHONE BOOKING COMPOSER
   The client calls in. The receptionist picks, per service, the
   operator the client prefers and a free slot based on availability.
   One booking can involve several operators → several timeline blocks.
   ==================================================================== */
const BK_OPEN = 9 * 60, BK_CLOSE = 19 * 60, BK_STEP = 30;
const BK_CATALOG = ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9', 's10', 's11', 's12'];
const CAT_DOT = { nail: 'var(--clay)', hair: 'var(--op-mara)', viso: 'var(--op-lina)', extra: 'var(--op-asia)' };

// busy intervals for an operator: existing appts + other lines in this booking
function bkBusy(opId, appts, lines, exceptLineId) {
  const iv = appts.filter(a => a.opId === opId && a.status !== 'noshow').map(a => [a.start, apptEnd(a)]);
  lines.forEach(l => { if (l.opId === opId && l.id !== exceptLineId && l.start != null) iv.push([l.start, l.start + svcDur(l.serviceId, opId)]); });
  return iv;
}
function bkFree(opId, start, dur, appts, lines, lineId) {
  if (start < BK_OPEN || start + dur > BK_CLOSE) return false;
  return !bkBusy(opId, appts, lines, lineId).some(([s, e]) => start < e && start + dur > s);
}
function bkFirstFree(opId, dur, after, appts, lines, lineId) {
  for (let s = Math.max(BK_OPEN, Math.ceil(after / BK_STEP) * BK_STEP); s + dur <= BK_CLOSE; s += BK_STEP) {
    if (bkFree(opId, s, dur, appts, lines, lineId)) return s;
  }
  return null;
}
// group lines → appointments (merge contiguous same-operator services)
function bkBuild(lines, clientId, deposit) {
  const byOp = {};
  lines.forEach(l => { (byOp[l.opId] = byOp[l.opId] || []).push(l); });
  const bookingId = 'bk' + Date.now();
  const out = [];
  Object.keys(byOp).forEach(opId => {
    const sorted = byOp[opId].filter(l => l.start != null).slice().sort((a, b) => a.start - b.start);
    let run = [], runEnd = null;
    const flush = () => { if (run.length) { out.push({ id: 'n' + Date.now() + Math.random().toString(36).slice(2, 6), clientId, opId, serviceIds: run.map(r => r.serviceId), start: run[0].start, status: 'confermato', deposit: deposit ? 'req' : 'none', bookingId }); run = []; } };
    sorted.forEach(l => { if (run.length && l.start !== runEnd) flush(); run.push(l); runEnd = l.start + svcDur(l.serviceId, opId); });
    flush();
  });
  return { appts: out, bookingId };
}

/* "Nuovo cliente" dal topbar — riusa lo stesso form della sezione Clienti */
function CatsMgrModal() {
  const { t, lang, fireToast, closeModal, modal } = useDk();
  return <CategoriesManager initialType={modal.data || 'clienti'} onClose={closeModal} t={t} lang={lang} fireToast={fireToast} />;
}

function NewClientFromTopbar() {
  const { t, lang, closeModal, fireToast, setTab } = useDk();
  return <NewClientModal t={t} lang={lang} onClose={closeModal}
    onCreate={(nc) => { CLIENTS.unshift(nc); closeModal(); setTab('clienti'); fireToast({ msg: t(`Cliente ${nc.name} creato`, `Client ${nc.name} created`), icon: 'check' }); }} />;
}

function NewApptModal() {
  const { t, lang, closeModal, setAppts, appts, fireToast, depositRule, modal } = useDk();
  const prefill = (modal && modal.data && modal.data.prefill) || null;
  const _pfOp = (prefill && prefill.opId) || 'sole';
  const _pfSvc = (prefill && prefill.opId) ? ((window.SERVICES.find(s => s.ops.includes(prefill.opId)) || { id: 's2' }).id) : 's2';
  const _pfStart = (prefill && prefill.start != null) ? prefill.start : 630;
  const [clientId, setClientId] = useStateDm(prefill && prefill.clientId ? prefill.clientId : 'c1');
  const [q, setQ] = useStateDm('');
  const [lines, setLines] = useStateDm([{ id: 'l1', serviceId: _pfSvc, opId: _pfOp, start: _pfStart }]);
  const [deposit, setDeposit] = useStateDm(false);
  const _todayISO = '2026-06-29';
  const [bkDate, setBkDate] = useStateDm(_todayISO);
  const [repeat, setRepeat] = useStateDm('none'); // none | weekly | biweekly | monthly
  const [repeatCount, setRepeatCount] = useStateDm(4);
  const dateLabel = (() => { const d = new Date(bkDate + 'T00:00'); const today = new Date(_todayISO + 'T00:00'); const diff = Math.round((d - today) / 86400000); const mo = (lang === 'en' ? ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'] : ['gen','feb','mar','apr','mag','giu','lug','ago','set','ott','nov','dic']); const dow = (lang === 'en' ? ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'] : ['dom','lun','mar','mer','gio','ven','sab']); const base = `${dow[d.getDay()]} ${d.getDate()} ${mo[d.getMonth()]}`; if (diff === 0) return t('Oggi', 'Today') + ' · ' + base; if (diff === 1) return t('Domani', 'Tomorrow') + ' · ' + base; return base + (diff > 1 ? ` · +${diff}g` : ''); })();
  const reliability = (cl) => Math.max(0, 100 - cl.noshow * 18 - cl.latecancel * 6);
  const autoDeposit = (() => { const cl = client(clientId); return cl && (cl.depositAlways || (depositRule.on && reliability(cl) < depositRule.threshold)); })();
  React.useEffect(() => { setDeposit(!!autoDeposit); }, [clientId]);
  const lineSeq = useRefDm(2);
  const filtered = CLIENTS.filter(c => c.name.toLowerCase().includes(q.toLowerCase())).slice(0, 4);
  const c = client(clientId);

  const valid = lines.filter(l => l.start != null);
  const price = lines.reduce((s, l) => s + svc(l.serviceId).price, 0);
  const opsInvolved = [...new Set(lines.map(l => l.opId))];
  const span = valid.length ? [Math.min(...valid.map(l => l.start)), Math.max(...valid.map(l => l.start + svcDur(l.serviceId, l.opId)))] : null;
  const hasUnscheduled = lines.some(l => l.start == null);

  function addService(serviceId) {
    const opId = svc(serviceId).ops[0];
    const dur = svcDur(serviceId, opId);
    const latest = lines.reduce((m, l) => l.start != null ? Math.max(m, l.start + svcDur(l.serviceId, l.opId)) : m, BK_OPEN);
    const start = bkFirstFree(opId, dur, latest, appts, lines, null) ?? bkFirstFree(opId, dur, BK_OPEN, appts, lines, null);
    setLines(ls => [...ls, { id: 'l' + (lineSeq.current++), serviceId, opId, start }]);
  }
  function removeLine(id) { setLines(ls => ls.filter(l => l.id !== id)); }
  function setLineOp(id, opId) {
    setLines(ls => ls.map(l => {
      if (l.id !== id) return l;
      const dur = svcDur(l.serviceId, opId);
      const keep = l.start != null && bkFree(opId, l.start, dur, appts, ls, id);
      return { ...l, opId, start: keep ? l.start : bkFirstFree(opId, dur, BK_OPEN, appts, ls, id) };
    }));
  }
  function setLineStart(id, start) { setLines(ls => ls.map(l => l.id === id ? { ...l, start } : l)); }

  function create() {
    const { appts: created } = bkBuild(lines, clientId, deposit);
    if (!created.length) return;
    const stepDays = { weekly: 7, biweekly: 14, monthly: 30 }[repeat];
    const occN = (repeat !== 'none' && stepDays) ? Math.max(1, repeatCount) : 1;
    const all = [];
    for (let k = 0; k < occN; k++) {
      const d = new Date(bkDate + 'T00:00'); d.setDate(d.getDate() + (stepDays ? k * stepDays : 0));
      const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      created.forEach(a => all.push({ ...a, id: a.id + (k ? '_r' + k : ''), date: iso }));
    }
    setAppts(l => [...l, ...all]);
    closeModal();
    const opNames = opsInvolved.map(o => op(o).name).join(', ');
    const future = bkDate !== _todayISO;
    fireToast({ msg: occN > 1 ? t(`${occN} appuntamenti ciclici creati · ${c.name.split(' ')[0]}`, `${occN} recurring appointments created · ${c.name.split(' ')[0]}`) : (future ? t(`Prenotazione creata · ${c.name.split(' ')[0]} · ${dateLabel}`, `Booking created · ${c.name.split(' ')[0]} · ${dateLabel}`) : (created.length > 1 ? t(`Prenotazione creata · ${c.name.split(' ')[0]} con ${opNames}`, `Booking created · ${c.name.split(' ')[0]} with ${opNames}`) : t('Appuntamento creato per ' + c.name.split(' ')[0], 'Appointment created for ' + c.name.split(' ')[0]))), icon: 'check', undo: t('Annulla', 'Undo'), undoFn: () => setAppts(l => l.slice(0, -all.length)) });
  }

  return (
    <DkModal open onClose={closeModal} title={t('Nuova prenotazione', 'New booking')} sub={t('Prenotazione telefonica · scegli operatore e orario per ogni servizio', 'Phone booking · pick the operator and time for each service')} width={780}
      foot={<React.Fragment>
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 14, color: 'var(--muted)' }}>
          {span && <span className="t-sm" style={{ fontWeight: 600 }}><Icon name="clock" size={14} style={{ verticalAlign: '-2px', marginRight: 4 }} />{timeLabel(span[0])}–{timeLabel(span[1])}</span>}
          {opsInvolved.length > 1 && <span className="t-sm" style={{ fontWeight: 600, color: 'var(--clay-ink)' }}><Icon name="clients" size={14} style={{ verticalAlign: '-2px', marginRight: 4 }} />{opsInvolved.length} {t('operatori', 'operators')}</span>}
        </div>
        <button className="dk-btn dk-btn--ghost" onClick={closeModal}>{t('Annulla', 'Cancel')}</button>
        <button className="dk-btn dk-btn--clay" disabled={!valid.length || hasUnscheduled} onClick={create}><Icon name="plus" size={17} color="#fff" />{t('Crea prenotazione', 'Create booking')} · {fmtEur(price, lang)}</button>
      </React.Fragment>}>
      <div style={{ display: 'grid', gridTemplateColumns: '236px 1fr', gap: 22 }}>
        {/* client */}
        <div>
          <div className="t-meta" style={{ marginBottom: 8 }}>{t('Cliente al telefono', 'Client on the call')}</div>
          <div className="dk-search" style={{ width: '100%', marginBottom: 8 }}>
            <Icon name="search" size={17} color="var(--muted-2)" />
            <input value={q} onChange={e => setQ(e.target.value)} placeholder={t('Cerca…', 'Search…')} />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {filtered.map(cl => (
              <button key={cl.id} className="dk-row" onClick={() => setClientId(cl.id)} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 8px', borderRadius: 10, background: clientId === cl.id ? 'var(--clay-tint)' : 'transparent', textAlign: 'left' }}>
                <Avatar initials={cl.initials} size={32} />
                <span style={{ flex: 1, fontWeight: 600, fontSize: 13.5, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{cl.name}</span>
                {clientId === cl.id && <Icon name="check" size={16} color="var(--clay-ink)" />}
              </button>
            ))}
          </div>
          {c && c.depositAlways && <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginTop: 12, padding: '10px 12px', background: 'var(--warn-tint)', borderRadius: 10 }}><Icon name="coupon" size={15} color="var(--warn)" /><span className="t-sm" style={{ color: 'var(--ink-2)', fontWeight: 600 }}>{t('Cliente con storico no-show · suggerito deposito', 'Past no-shows · deposit suggested')}</span></div>}
        </div>

        {/* booking builder */}
        <div>
          {/* AI ottimizzazione banner */}
          <div style={{ display: 'flex', gap: 9, alignItems: 'flex-start', padding: '10px 13px', borderRadius: 11, background: 'var(--clay-tint)', border: '1px solid color-mix(in srgb, var(--clay) 22%, transparent)', marginBottom: 14 }}>
            <Icon name="sparkle" size={15} color="var(--clay-ink)" style={{ flexShrink: 0, marginTop: 1 }} />
            <div style={{ flex: 1, fontSize: 12.5, color: 'var(--clay-ink)', lineHeight: 1.45 }}>
              <b>{t('Ottimizzazione attiva', 'Optimization on')}</b> — {t('gli orari evidenziati in viola riducono i buchi e migliorano la densità della giornata. Puoi comunque scegliere qualsiasi slot libero.', 'the times highlighted in purple reduce gaps and improve day density. You can still pick any free slot.')}
            </div>
          </div>
          {/* date — schedule for today or a future day */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14, padding: '11px 14px', borderRadius: 12, border: '1px solid var(--hair)', background: 'var(--surface)' }}>
            <Icon name="calendar" size={17} color="var(--clay-ink)" />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="t-meta" style={{ fontSize: 9.5, marginBottom: 1 }}>{t('Data', 'Date')}</div>
              <div style={{ fontWeight: 700, fontSize: 13.5, textTransform: 'capitalize' }}>{dateLabel}</div>
            </div>
            <div style={{ display: 'flex', gap: 5 }}>
              <input type="date" value={bkDate} min={_todayISO} onChange={e => setBkDate(e.target.value || _todayISO)} style={{ border: '1px solid var(--hair)', borderRadius: 8, padding: '6px 8px', fontSize: 12.5, fontFamily: 'var(--sans)', outline: 'none', cursor: 'pointer', color: 'var(--ink)' }} />
            </div>
          </div>
          {/* recurrence — cyclic appointments */}
          <div style={{ marginBottom: 18 }}>
            <div className="t-meta" style={{ marginBottom: 7 }}>{t('Ricorrenza', 'Recurrence')}</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {[['none', t('Singolo', 'One-off')], ['weekly', t('Ogni settimana', 'Weekly')], ['biweekly', t('Ogni 2 settimane', 'Every 2 weeks')], ['monthly', t('Ogni mese', 'Monthly')]].map(([k, l]) => { const on = repeat === k; return (
                <button key={k} onClick={() => setRepeat(k)} style={{ padding: '7px 12px', borderRadius: 99, fontSize: 12.5, fontWeight: 600, cursor: 'pointer', border: '1px solid ' + (on ? 'var(--clay)' : 'var(--hair)'), background: on ? 'var(--clay-tint)' : 'var(--surface)', color: on ? 'var(--clay-ink)' : 'var(--ink-2)' }}>{l}</button>
              ); })}
            </div>
            {repeat !== 'none' && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginTop: 10 }}>
                <span className="t-sm" style={{ color: 'var(--muted)' }}>{t('Per', 'For')}</span>
                <div style={{ display: 'inline-flex', alignItems: 'center', gap: 2, border: '1px solid var(--hair)', borderRadius: 8, padding: '5px 9px', background: 'var(--surface)' }}>
                  <input type="number" min={2} max={52} value={repeatCount} onChange={e => setRepeatCount(Math.max(2, Math.min(52, parseInt(e.target.value) || 2)))} style={{ width: 34, textAlign: 'right', border: 'none', outline: 'none', background: 'transparent', fontWeight: 700, fontSize: 13.5, fontFamily: 'var(--mono, monospace)' }} />
                </div>
                <span className="t-sm" style={{ color: 'var(--muted)' }}>{repeat === 'monthly' ? t('mesi', 'months') : t('volte', 'times')}</span>
                <span className="t-sm" style={{ color: 'var(--clay-ink)', fontWeight: 600, marginLeft: 'auto' }}>{repeatCount} {t('appuntamenti', 'appointments')}</span>
              </div>
            )}
          </div>
          <div className="t-meta" style={{ marginBottom: 8 }}>{t('Aggiungi i servizi richiesti', 'Add the requested services')}</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7, marginBottom: 18 }}>
            {BK_CATALOG.map(id => { const s = svc(id); return (
              <button key={id} onClick={() => addService(id)} style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '7px 12px', borderRadius: 99, fontSize: 12.5, fontWeight: 600, cursor: 'pointer', border: '1px solid var(--hair)', background: 'var(--surface)', color: 'var(--ink-2)' }}>
                <span style={{ width: 7, height: 7, borderRadius: 99, background: CAT_DOT[s.cat] }} />{svcName(s, lang)}<Icon name="plus" size={13} color="var(--muted-2)" />
              </button>); })}
          </div>

          {!lines.length ? (
            <div style={{ textAlign: 'center', padding: '28px 20px', border: '1.5px dashed var(--line-strong)', borderRadius: 14, color: 'var(--muted)' }}>
              <Icon name="calendar" size={26} color="var(--muted-2)" style={{ margin: '0 auto 8px' }} />
              <div className="t-sm" style={{ fontWeight: 600 }}>{t('Aggiungi un servizio per iniziare la prenotazione', 'Add a service to start the booking')}</div>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {lines.map((l, i) => (
                <BkLine key={l.id} line={l} idx={i} appts={appts} lines={lines} t={t} lang={lang} fromSlot={!!prefill && prefill.start != null}
                  onOp={(op) => setLineOp(l.id, op)} onStart={(s) => setLineStart(l.id, s)} onRemove={() => removeLine(l.id)} />
              ))}
            </div>
          )}

          <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '13px 16px', background: 'var(--surface-2)', borderRadius: 14, marginTop: 16 }}>
            <Icon name="coupon" size={19} color="var(--warn)" />
            <div style={{ flex: 1 }}><div style={{ fontWeight: 600, fontSize: 14 }}>{t('Richiedi deposito', 'Require deposit')}</div><div className="t-sm" style={{ color: 'var(--muted)' }}>{autoDeposit ? t('Suggerito · cliente sotto soglia affidabilità', 'Suggested · client below reliability threshold') : (lines.length + ' ' + t('servizi', 'services') + ' · ' + fmtEur(price, lang) + ' ' + t('totale', 'total'))}</div></div>
            <Toggle on={deposit} onChange={setDeposit} />
          </div>
        </div>
      </div>
    </DkModal>
  );
}

/* one service line: service · operator picker · availability slot picker */
function BkLine({ line, idx, appts, lines, t, lang, onOp, onStart, onRemove, fromSlot }) {
  const s = svc(line.serviceId);
  const [showTime, setShowTime] = React.useState(false);
  const eligible = OPS.filter(o => s.ops.includes(o.id));
  const dur = svcDur(line.serviceId, line.opId);
  const slots = [];
  for (let st = BK_OPEN; st + dur <= BK_CLOSE; st += BK_STEP) slots.push(st);
  const o = op(line.opId);
  return (
    <div style={{ border: '1px solid var(--hair)', borderRadius: 14, overflow: 'hidden', background: 'var(--surface)' }}>
      {/* service header strip */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '13px 16px', background: `color-mix(in srgb, ${o.color} 16%, var(--surface))`, borderBottom: '1px solid var(--hair)' }}>
        <span style={{ width: 10, height: 10, borderRadius: 99, background: CAT_DOT[s.cat] || o.color, flexShrink: 0 }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 16, lineHeight: 1.15 }}>{svcName(s, lang)}</div>
          <div className="t-sm" style={{ color: 'var(--muted)', marginTop: 2 }}><Icon name="clock" size={12} style={{ verticalAlign: '-2px', marginRight: 3 }} />{fmtDur(dur, lang)}{line.start != null && <span> · {t('inizio', 'starts')} <b style={{ color: 'var(--ink)' }}>{timeLabel(line.start)}</b></span>}</div>
        </div>
        <span className="t-num" style={{ fontSize: 16, fontWeight: 700, flexShrink: 0 }}>{fmtEur(s.price, lang)}</span>
        <button className="dk-iconbtn" style={{ width: 30, height: 30, borderRadius: 9, flexShrink: 0 }} onClick={onRemove}><Icon name="x" size={15} /></button>
      </div>

      <div style={{ padding: '14px 16px' }}>
        {/* OPERATRICE */}
        <div className="t-meta" style={{ marginBottom: 9 }}>{t('Operatrice', 'Stylist')}</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7, marginBottom: 16 }}>
          {eligible.map(op2 => { const on = op2.id === line.opId; return (
            <button key={op2.id} onClick={() => onOp(op2.id)} style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '5px 13px 5px 5px', borderRadius: 99, cursor: 'pointer', border: '1.5px solid ' + (on ? op2.color : 'var(--hair)'), background: on ? 'color-mix(in srgb,' + op2.color + ' 18%, var(--surface))' : 'var(--surface)' }}>
              <Avatar initials={op2.initials} size={24} color={op2.color} />
              <span style={{ fontSize: 13, fontWeight: on ? 700 : 600, whiteSpace: 'nowrap' }}>{op2.name}</span>
              {on && <Icon name="check" size={14} color={op2.color} stroke={2.6} />}
            </button>); })}
        </div>

        {/* ORARIO */}
        <div className="hr" style={{ margin: '0 0 14px' }} />
        {fromSlot && !showTime ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div className="t-meta" style={{ margin: 0 }}>{t('Orario', 'Time')}</div>
            <span className="t-num" style={{ fontSize: 14, fontWeight: 700 }}>{line.start != null ? timeLabel(line.start) : '—'}</span>
            <button onClick={() => setShowTime(true)} style={{ marginLeft: 'auto', cursor: 'pointer', background: 'transparent', border: 'none', fontSize: 12.5, fontWeight: 700, color: 'var(--clay-ink)' }}>{t('Cambia orario', 'Change time')}</button>
          </div>
        ) : (
        <React.Fragment>
        <div className="t-meta" style={{ marginBottom: 9 }}>{t('Orario', 'Time')}</div>
        <div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {(() => {
              // compute optimal slots: start immediately after an existing appt OR end when one starts
              const busyRanges = bkBusy(line.opId, appts, lines, line.id);
              const optimalSet = new Set(slots.filter(st => {
                if (!bkFree(line.opId, st, dur, appts, lines, line.id)) return false;
                const end = st + dur;
                return busyRanges.some(([s, e]) => Math.abs(st - e) < 2 || Math.abs(end - s) < 2);
              }));
              return slots.map(st => {
                const free = bkFree(line.opId, st, dur, appts, lines, line.id);
                const sel = line.start === st;
                const opt = optimalSet.has(st);
                const busyAppt = !free && appts.find(a => a.opId === line.opId && a.status !== 'noshow' && st < apptEnd(a) && st + dur > a.start);
                return (
                  <button key={st} disabled={!free} onClick={() => onStart(st)} className="tabnum"
                    title={!free ? (busyAppt ? client(busyAppt.clientId).name : t('Non disponibile', 'Unavailable')) : opt ? t('Ottimale · riduce i buchi', 'Optimal · reduces gaps') : ''}
                    style={{ padding: '5px 9px', borderRadius: 8, fontSize: 12, fontWeight: 700, cursor: free ? 'pointer' : 'not-allowed', position: 'relative',
                      border: '1.5px solid ' + (sel ? 'var(--ink)' : opt ? 'var(--clay)' : free ? 'var(--hair)' : 'transparent'),
                      background: sel ? 'var(--ink)' : opt ? 'var(--clay-tint)' : free ? 'var(--surface)' : 'var(--paper-2)',
                      color: sel ? '#fff' : opt ? 'var(--clay-ink)' : free ? 'var(--ink)' : 'var(--faint)',
                      textDecoration: free ? 'none' : 'line-through' }}>
                    {timeLabel(st)}{opt && !sel && <span style={{ position: 'absolute', top: -3, right: -3, width: 7, height: 7, borderRadius: 99, background: 'var(--clay)', border: '1.5px solid var(--surface)' }} />}
                  </button>
                );
              });
            })()}
          </div>
          {line.start == null && <div className="t-sm" style={{ color: 'var(--danger)', marginTop: 6, fontWeight: 600 }}>{t('Nessuno slot libero per questo operatore — scegline un altro', 'No free slot for this operator — pick another')}</div>}
        </div>
        </React.Fragment>
        )}
      </div>
    </div>
  );
}

/* ---------- Appointment detail ---------- */
const RESCHED_REASONS = [['cliente', 'Richiesta cliente', 'Client request'], ['salute', 'Malattia / imprevisto', 'Illness / emergency'], ['agenda', 'Sovrapposizione', 'Schedule clash'], ['operatrice', 'Operatrice non disp.', 'Stylist unavailable']];
const CANCEL_REASONS = [['cliente', 'Richiesta cliente', 'Client request'], ['noshow', 'Mancata presenza', 'No-show'], ['salute', 'Malattia', 'Illness'], ['altro', 'Altro', 'Other']];

function ApptDetailModal({ id }) {
  const { t, lang, closeModal, setAppts, fireToast, openModal, setTab, appts, setSelClient, waitList } = useDk();
  const [flow, setFlow] = useStateDm(null); // 'reschedule' | 'cancel' | 'changesvc'
  const [reason, setReason] = useStateDm(null);
  const [note, setNote] = useStateDm('');
  const [editSvcs, setEditSvcs] = useStateDm([]);
  const [resolution, setResolution] = useStateDm('balance'); // wallet | balance | manual
  const live = appts.find(x => x.id === id);
  if (!live) return null;
  const c = client(live.clientId), o = op(live.opId);
  const set = (status) => { setAppts(l => l.map(x => x.id === id ? { ...x, status } : x)); };
  const setSelClientAndTab = () => { setSelClient(live.clientId); setTab('clienti'); };
  const siblings = live.bookingId ? appts.filter(x => x.bookingId === live.bookingId && x.id !== id) : [];
  const nowMin = 10 * 60 + 18;
  const hoursUntil = (live.start - nowMin) / 60;
  const within48 = hoursUntil < 48;
  const charge = apptTotal(live);

  const reasonLabel = (set, key) => { const r = set.find(x => x[0] === key); return r ? t(r[1], r[2]) : ''; };

  // ---- reason picker (shared by reschedule + cancel) ----
  const ReasonPicker = ({ reasons }) => (
    <div>
      <div className="t-meta" style={{ marginBottom: 9 }}>{t('Motivazione (per le statistiche)', 'Reason (for statistics)')}</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 14 }}>
        {reasons.map(([k, it, en]) => { const on = reason === k; return (
          <button key={k} onClick={() => setReason(k)} style={{ padding: '8px 14px', borderRadius: 99, fontSize: 13, fontWeight: 600, cursor: 'pointer', border: '1.5px solid ' + (on ? 'var(--ink)' : 'var(--hair)'), background: on ? 'var(--ink)' : 'var(--surface)', color: on ? '#fff' : 'var(--ink-2)' }}>{t(it, en)}</button>
        ); })}
      </div>
      <div className="t-meta" style={{ marginBottom: 8 }}>{t('Nota (facoltativa)', 'Note (optional)')}</div>
      <textarea value={note} onChange={e => setNote(e.target.value)} placeholder={t('Aggiungi un dettaglio…', 'Add a detail…')} rows={2}
        style={{ width: '100%', border: '1px solid var(--hair)', borderRadius: 12, padding: '10px 12px', fontSize: 13.5, fontFamily: 'var(--sans)', resize: 'vertical', outline: 'none', boxSizing: 'border-box', background: 'var(--surface)' }} />
    </div>
  );

  // ---- NOTES quick-access flow ----
  if (flow === 'notes') {
    const NotesUI = window.NotesTab;
    return (
      <DkModal open onClose={closeModal} title={t('Note cliente', 'Client notes')} sub={c.name} width={560}
        foot={<button className="dk-btn dk-btn--ghost" onClick={() => setFlow(null)}><Icon name="chevL" size={15} />{t('Indietro', 'Back')}</button>}>
        {NotesUI ? <NotesUI clientId={live.clientId} t={t} lang={lang} fireToast={fireToast} /> : null}
      </DkModal>
    );
  }

  // ---- RESCHEDULE flow ----
  if (flow === 'reschedule') {
    return (
      <DkModal open onClose={closeModal} title={t('Sposta appuntamento', 'Reschedule')} sub={`${c.name} · ${timeLabel(live.start)}`} width={460}
        foot={<React.Fragment>
          <button className="dk-btn dk-btn--ghost" onClick={() => { setFlow(null); setReason(null); setNote(''); }}>{t('Indietro', 'Back')}</button>
          <button className="dk-btn dk-btn--clay" disabled={!reason} onClick={() => {
              const freed = { ...live };
              closeModal();
              fireToast({ msg: t('Spostamento avviato — trascina il blocco in agenda', 'Reschedule started — drag the block in the agenda'), icon: 'calendar' });
              const matches = wlRanked((waitList || []).filter(w => w.serviceIds.some(sid => freed.serviceIds.includes(sid)) || w.serviceIds.length === 0), freed);
              if (matches.length > 0) setTimeout(() => openModal('freedslot', { appt: freed, matches }), 900);
            }}><Icon name="calendar" size={16} color="#fff" />{t('Procedi', 'Proceed')}</button>
        </React.Fragment>}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '12px 14px', borderRadius: 12, background: within48 ? 'var(--warn-tint)' : 'var(--surface-2)', marginBottom: 18 }}>
          <Icon name={within48 ? 'alert' : 'clock'} size={17} color={within48 ? 'var(--warn)' : 'var(--muted)'} />
          <div style={{ fontSize: 13, color: 'var(--ink-2)', lineHeight: 1.45 }}>
            {within48
              ? <span><b>{t('Mancano meno di 48 ore.', 'Less than 48 hours to go.')}</b> {t('Lo spostamento è consentito fino a 48h prima; oltre questa soglia conferma con la cliente.', 'Rescheduling is allowed up to 48h before; past this point, confirm with the client.')}</span>
              : t('Lo spostamento è consentito fino a 48h prima dell\'appuntamento.', 'Rescheduling is allowed up to 48h before the appointment.')}
          </div>
        </div>
        <ReasonPicker reasons={RESCHED_REASONS} />
      </DkModal>
    );
  }

  // ---- CHANGE TREATMENT flow (upgrade / downgrade before checkout) ----
  if (flow === 'changesvc') {
    const origTotal = apptTotal(live);
    const newTotal = editSvcs.reduce((s, id) => s + (svc(id) ? svc(id).price : 0), 0);
    const depPaid = live.deposit === 'paid' ? Math.round(origTotal * 0.3) : 0;
    const balance = newTotal - depPaid;
    const isDowngrade = newTotal < origTotal;
    const overpay = depPaid - newTotal; // >0 when deposit exceeds the new (lower) total
    const excess = depPaid > Math.round(newTotal * 0.5); // deposit beyond 50% of new total
    const changed = editSvcs.length && (editSvcs.length !== live.serviceIds.length || editSvcs.some(x => !live.serviceIds.includes(x)));
    const resOpts = [
      ['balance', t('Scala dal saldo', 'Deduct from balance'), t('Riduci l\u2019importo dovuto al checkout', 'Lower the amount due at checkout')],
      ['wallet', t('Credito sul wallet', 'Wallet credit'), t('Accredita la differenza per una visita futura', 'Credit the difference for a future visit')],
      ['manual', t('Gestione manuale', 'Manual handling'), t('Rimborso o accordo gestito alla cassa', 'Refund or arrangement handled at the till')],
    ];
    const toggle = (sid) => setEditSvcs(l => l.includes(sid) ? l.filter(x => x !== sid) : [...l, sid]);
    return (
      <DkModal open onClose={closeModal} title={t('Modifica trattamento', 'Change treatment')} sub={`${c.name} · ${timeLabel(live.start)}`} width={560}
        foot={<React.Fragment>
          <button className="dk-btn dk-btn--ghost" onClick={() => setFlow(null)}>{t('Indietro', 'Back')}</button>
          <button className="dk-btn dk-btn--clay" disabled={!editSvcs.length || !changed} onClick={() => {
              setAppts(l => l.map(x => x.id === id ? { ...x, serviceIds: [...editSvcs], svcChanged: true } : x));
              closeModal();
              fireToast({ msg: t('Trattamento aggiornato · saldo ricalcolato', 'Treatment updated · balance recalculated'), icon: 'check' });
            }}><Icon name="check" size={16} color="#fff" />{t('Conferma modifica', 'Confirm change')}</button>
        </React.Fragment>}>

        <div className="t-meta" style={{ marginBottom: 9 }}>{t('Servizi del trattamento', 'Treatment services')}</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7, marginBottom: 18 }}>
          {BK_CATALOG.map(sid => { const s = svc(sid); if (!s) return null; const on = editSvcs.includes(sid); return (
            <button key={sid} onClick={() => toggle(sid)} style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '7px 12px', borderRadius: 99, fontSize: 12.5, fontWeight: 600, cursor: 'pointer', border: '1px solid ' + (on ? 'var(--clay)' : 'var(--hair)'), background: on ? 'var(--clay-tint)' : 'var(--surface)', color: on ? 'var(--clay-ink)' : 'var(--ink-2)' }}>
              <span style={{ width: 7, height: 7, borderRadius: 99, background: CAT_DOT[s.cat] }} />{svcName(s, lang)}<span className="t-sm" style={{ color: on ? 'var(--clay-ink)' : 'var(--muted-2)' }}>{fmtEur(s.price, lang)}</span>
            </button>); })}
        </div>

        {/* recalculation summary */}
        <div style={{ background: 'var(--surface-2)', borderRadius: 14, padding: '14px 16px', marginBottom: excess && isDowngrade ? 14 : 0 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0' }}><span className="t-sm" style={{ color: 'var(--muted)' }}>{t('Totale precedente', 'Previous total')}</span><span className="tabnum" style={{ color: 'var(--muted)', textDecoration: newTotal !== origTotal ? 'line-through' : 'none' }}>{fmtEur(origTotal, lang)}</span></div>
          <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0' }}><span style={{ fontWeight: 700, fontSize: 14 }}>{t('Nuovo totale', 'New total')}{isDowngrade ? ' ↓' : newTotal > origTotal ? ' ↑' : ''}</span><span className="t-num" style={{ fontSize: 16, fontWeight: 700 }}>{fmtEur(newTotal, lang)}</span></div>
          {depPaid > 0 && <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', color: 'var(--ok)' }}><span className="t-sm" style={{ fontWeight: 600 }}>{t('Caparra già versata', 'Deposit already paid')} <span style={{ fontSize: 10, fontWeight: 700, background: 'var(--ok-tint)', padding: '1px 6px', borderRadius: 99, marginLeft: 2 }}>{t('BLOCCATA', 'LOCKED')}</span></span><span className="tabnum" style={{ fontWeight: 700 }}>− {fmtEur(depPaid, lang)}</span></div>}
          <div className="hr" style={{ margin: '8px 0' }} />
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}><span style={{ fontWeight: 700 }}>{balance >= 0 ? t('Saldo al checkout', 'Balance at checkout') : t('Eccedenza caparra', 'Deposit overpayment')}</span><span className="t-num" style={{ fontSize: 20, fontWeight: 700, color: balance < 0 ? 'var(--warn)' : 'var(--ink)' }}>{fmtEur(Math.abs(balance), lang)}</span></div>
        </div>

        {/* downgrade discrepancy + resolution */}
        {isDowngrade && excess && depPaid > 0 && (
          <div style={{ border: '1px solid color-mix(in srgb, var(--warn) 35%, transparent)', background: 'var(--warn-tint)', borderRadius: 14, padding: '14px 16px' }}>
            <div style={{ display: 'flex', gap: 9, alignItems: 'flex-start', marginBottom: 12 }}>
              <Icon name="alert" size={17} color="var(--warn)" style={{ flexShrink: 0, marginTop: 1 }} />
              <div className="t-sm" style={{ color: 'var(--ink-2)', lineHeight: 1.45 }}>{t(`La caparra (${fmtEur(depPaid, lang)}) supera il 50% del nuovo totale. Scegli come gestire l\u2019eccedenza di ${fmtEur(overpay, lang)}.`, `The deposit (${fmtEur(depPaid, lang)}) exceeds 50% of the new total. Choose how to handle the ${fmtEur(overpay, lang)} overpayment.`)}</div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {resOpts.map(([k, label, desc]) => { const on = resolution === k; return (
                <button key={k} onClick={() => setResolution(k)} style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '11px 13px', borderRadius: 11, cursor: 'pointer', textAlign: 'left', border: '1.5px solid ' + (on ? 'var(--clay)' : 'var(--hair)'), background: on ? 'var(--clay-tint)' : 'var(--surface)' }}>
                  <div style={{ width: 18, height: 18, borderRadius: 99, border: '2px solid ' + (on ? 'var(--clay)' : 'var(--pewter-300, #B6B4BB)'), display: 'grid', placeItems: 'center', flexShrink: 0 }}>{on && <span style={{ width: 8, height: 8, borderRadius: 99, background: 'var(--clay)' }} />}</div>
                  <div style={{ flex: 1, minWidth: 0 }}><div style={{ fontWeight: 700, fontSize: 13.5 }}>{label}</div><div className="t-sm" style={{ color: 'var(--muted)' }}>{desc}</div></div>
                </button>); })}
            </div>
          </div>
        )}
      </DkModal>
    );
  }

  // ---- NO-SHOW flow ----
  if (flow === 'noshow') {
    return (
      <DkModal open onClose={closeModal} title={t('Segna no-show', 'Mark no-show')} sub={`${c.name} · ${timeLabel(live.start)}`} width={460}
        foot={<React.Fragment>
          <button className="dk-btn dk-btn--ghost" onClick={() => setFlow(null)}>{t('Indietro', 'Back')}</button>
          <button className="dk-btn" onClick={() => {
              set('noshow'); setFlow(null); closeModal();
              const cancelled = live;
              fireToast({ msg: t(`No-show · addebitato ${fmtEur(charge, lang)} · slot liberato`, `No-show · ${fmtEur(charge, lang)} charged · slot freed`), icon: 'alert' });
              const matches = (waitList || []).filter(w => w.serviceIds.some(sid => cancelled.serviceIds.includes(sid)));
              if (matches.length > 0) setTimeout(() => openModal('freedslot', { appt: cancelled, matches }), 800);
            }}
            style={{ background: 'var(--danger)', color: '#fff' }}><Icon name="alert" size={16} color="#fff" />{t(`Conferma · addebita ${fmtEur(charge, lang)}`, `Confirm · charge ${fmtEur(charge, lang)}`)}</button>
        </React.Fragment>}>
        <div style={{ display: 'flex', gap: 11, alignItems: 'flex-start', padding: '14px 15px', borderRadius: 12, background: 'var(--danger-tint)', border: '1px solid color-mix(in srgb, var(--danger) 25%, transparent)', marginBottom: 16 }}>
          <Icon name="alert" size={18} color="var(--danger)" />
          <div style={{ fontSize: 13, color: 'var(--ink-2)', lineHeight: 1.5 }}>
            <b>{t('La cliente non si è presentata.', 'The client did not show up.')}</b> {t("Confermando, viene addebitato l'intero importo del trattamento sulla carta salvata e lo slot torna disponibile per la lista d'attesa.", 'On confirm, the full treatment amount is charged to the saved card and the slot becomes available for the waiting list.')}
          </div>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', padding: '13px 15px', borderRadius: 12, background: 'var(--surface-2)' }}>
          <span style={{ fontWeight: 700 }}>{t('Importo addebitato', 'Amount charged')}</span>
          <span className="t-num" style={{ fontSize: 22, fontWeight: 800, color: 'var(--danger)' }}>{fmtEur(charge, lang)}</span>
        </div>
        {live.deposit === 'paid' && <div className="t-sm" style={{ color: 'var(--muted)', marginTop: 10 }}>{t("La caparra già versata viene trattenuta come parte dell'importo.", 'The deposit already paid is retained as part of the amount.')}</div>}
      </DkModal>
    );
  }

  // ---- CANCEL flow ----
  if (flow === 'cancel') {
    return (
      <DkModal open onClose={closeModal} title={t('Cancella appuntamento', 'Cancel appointment')} sub={`${c.name} · ${timeLabel(live.start)}`} width={460}
        foot={<React.Fragment>
          <button className="dk-btn dk-btn--ghost" onClick={() => { setFlow(null); setReason(null); setNote(''); }}>{t('Indietro', 'Back')}</button>
          <button className="dk-btn" disabled={!reason} onClick={() => {
              const cancelled = { ...live };
              setAppts(l => l.filter(x => x.id !== id));
              closeModal();
              fireToast({ msg: within48 ? t(`Cancellato · addebitati ${fmtEur(charge, lang)}`, `Cancelled · ${fmtEur(charge, lang)} charged`) : t('Appuntamento cancellato', 'Appointment cancelled'), icon: 'x' });
              // check waiting list matches → open freed slot dialog
              const matches = (waitList || []).filter(w => w.serviceIds.some(sid => cancelled.serviceIds.includes(sid)));
              if (matches.length > 0) setTimeout(() => openModal('freedslot', { appt: cancelled, matches }), 800);
            }}
            style={{ background: 'var(--danger)', color: '#fff', opacity: reason ? 1 : 0.4 }}><Icon name="x" size={16} color="#fff" />{within48 ? t(`Cancella e addebita ${fmtEur(charge, lang)}`, `Cancel & charge ${fmtEur(charge, lang)}`) : t('Conferma cancellazione', 'Confirm cancellation')}</button>
        </React.Fragment>}>
        {within48 && (
          <div style={{ display: 'flex', gap: 11, alignItems: 'flex-start', padding: '14px 15px', borderRadius: 12, background: 'var(--danger-tint)', border: '1px solid color-mix(in srgb, var(--danger) 30%, transparent)', marginBottom: 18 }}>
            <Icon name="alert" size={18} color="var(--danger)" />
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 700, fontSize: 14, color: 'var(--danger)', marginBottom: 3 }}>{t('Addebito dell\'intero importo', 'Full amount will be charged')}</div>
              <div style={{ fontSize: 13, color: 'var(--ink-2)', lineHeight: 1.45 }}>{t(`Mancano meno di 48 ore: la cancellazione comporta l\'addebito di ${fmtEur(charge, lang)} sulla carta salvata (Stripe).`, `Under 48 hours: cancelling charges ${fmtEur(charge, lang)} to the saved card (Stripe).`)}</div>
            </div>
          </div>
        )}
        <ReasonPicker reasons={CANCEL_REASONS} />
      </DkModal>
    );
  }

  // ---- DETAIL (default) ----
  return (
    <DkModal open onClose={closeModal} title={c.name} sub={`${timeLabel(live.start)}–${timeLabel(apptEnd(live))}`} width={840}>
      {siblings.length > 0 && (
        <div style={{ display: 'flex', gap: 9, alignItems: 'flex-start', padding: '11px 13px', background: 'var(--clay-tint)', borderRadius: 12, marginBottom: 16 }}>
          <Icon name="clients" size={17} color="var(--clay-ink)" />
          <div style={{ fontSize: 13, color: 'var(--ink-2)', lineHeight: 1.45 }}>
            <span style={{ fontWeight: 700 }}>{t('Prenotazione con più operatori.', 'Multi-operator booking.')}</span>{' '}
            {t('Anche', 'Also')} {siblings.map(sb => `${op(sb.opId).name} (${timeLabel(sb.start)})`).join(', ')}.
          </div>
        </div>
      )}

      {/* client meta bar — merged into the header row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        <Avatar initials={c.initials} size={40} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 11.5, fontWeight: 700, color: segMeta(c.segment, t).color, background: 'color-mix(in srgb,' + segMeta(c.segment, t).color + ' 12%, transparent)', padding: '3px 9px', borderRadius: 99 }}>{segMeta(c.segment, t).label}</span>
            <span className="t-sm" style={{ color: 'var(--muted)' }}>{c.visits} {t('visite', 'visits')} · {fmtEur(c.value, lang)}</span>
          </div>
          {(c.phoneWa || c.phone) && <a href={'tel:' + (c.phoneWa || c.phone)} className="tabnum" style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink-2)', textDecoration: 'none' }}>{c.phoneWa || c.phone}</a>}
        </div>
        <div style={{ flex: 1 }} />
        <button className="dk-btn dk-btn--soft" style={{ height: 38, fontSize: 13, padding: '0 14px' }} onClick={() => { closeModal(); setSelClientAndTab(); }}>{t('Apri scheda cliente', 'Open client')}</button>
        {c.wa && <button className="dk-btn" style={{ height: 38, background: 'var(--clay-tint)', color: 'var(--clay-ink)', flexShrink: 0 }} onClick={() => fireToast({ msg: t('Conversazione aperta su Yourang', 'Conversation opened in Yourang'), icon: 'ext' })}><Icon name="ext" size={16} color="var(--clay-ink)" />Yourang</button>}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 18, alignItems: 'start' }}>
        {/* LEFT COLUMN — who */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>

      {/* operator hero — prominent, in the operator's colour */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 16px', borderRadius: 16, background: `color-mix(in srgb, ${o.color} 26%, #FFFFFF)` }}>
        <Avatar initials={o.initials} size={50} color={o.color} ring />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="t-meta" style={{ fontSize: 10, color: 'var(--ink-2)', opacity: 0.7, marginBottom: 1 }}>{t('Operatrice', 'Stylist')}</div>
          <div style={{ fontFamily: 'var(--serif)', fontSize: 22, fontWeight: 500, lineHeight: 1.05 }}>{o.name}</div>
          <div className="t-sm" style={{ color: 'var(--ink-2)', opacity: 0.75 }}>{o.role[lang]}</div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div className="tabnum" style={{ fontWeight: 700, fontSize: 15 }}>{timeLabel(live.start)}</div>
          <div className="t-sm" style={{ color: 'var(--ink-2)', opacity: 0.7 }}>{fmtDur(apptEnd(live) - live.start, lang)}</div>
        </div>
      </div>

      {/* deposit / caparra status */}
      {live.deposit && live.deposit !== 'none' && (() => { const dm = depositMeta(live.deposit, t); const amt = Math.round(apptTotal(live) * 0.3); return (
        <div style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '12px 14px', borderRadius: 12, background: live.deposit === 'paid' ? 'var(--ok-tint)' : 'var(--warn-tint)', border: '1px solid color-mix(in srgb, ' + dm.color + ' 28%, transparent)' }}>
          <div style={{ width: 34, height: 34, borderRadius: 10, background: live.deposit === 'paid' ? 'var(--ok)' : 'var(--surface)', border: live.deposit === 'paid' ? 'none' : '1.5px dashed var(--warn)', display: 'grid', placeItems: 'center', flexShrink: 0 }}>
            <Icon name={live.deposit === 'paid' ? 'check' : 'wallet'} size={16} color={live.deposit === 'paid' ? '#fff' : 'var(--warn)'} stroke={live.deposit === 'paid' ? 3 : 1.7} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 700, fontSize: 13.5, color: dm.color }}>{dm.label}</div>
            <div className="t-sm" style={{ color: 'var(--ink-2)' }}>{live.deposit === 'paid' ? t('Acconto di ' + fmtEur(amt, lang) + ' incassato', fmtEur(amt, lang) + ' deposit collected') : t('Acconto di ' + fmtEur(amt, lang) + ' da incassare', fmtEur(amt, lang) + ' deposit to collect')}</div>
          </div>
          {live.deposit === 'req' && <button className="dk-btn dk-btn--ghost" style={{ height: 34, fontSize: 12.5 }} onClick={() => { setAppts(l => l.map(x => x.id === id ? { ...x, deposit: 'paid' } : x)); fireToast({ msg: t('Acconto segnato come incassato', 'Deposit marked as collected'), icon: 'check' }); }}>{t('Segna incassato', 'Mark collected')}</button>}
        </div>
      ); })()}

      {/* one-off booking confirmation — compact, low-emphasis */}
      {live.confirmSent ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderRadius: 10, background: 'var(--ok-tint)' }}>
          <Icon name="check" size={14} color="var(--ok)" stroke={2.6} />
          <span className="t-sm" style={{ flex: 1, fontWeight: 600, color: 'var(--ink-2)' }}>{t('Conferma inviata', 'Confirmation sent')} · {live.confirmSent}</span>
          <button onClick={() => fireToast({ msg: t('Conferma reinviata', 'Confirmation resent'), icon: 'whatsapp' })} style={{ background: 'transparent', border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 700, color: 'var(--ink-2)' }}>{t('Reinvia', 'Resend')}</button>
        </div>
      ) : c.wa ? (
        <button onClick={() => { setAppts(l => l.map(x => x.id === id ? { ...x, confirmSent: t('oggi · ' + timeLabel(nowMin), 'today · ' + timeLabel(nowMin)) } : x)); fireToast({ msg: t('Conferma inviata via WhatsApp a ' + c.name.split(' ')[0], 'Confirmation sent via WhatsApp to ' + c.name.split(' ')[0]), icon: 'whatsapp' }); }} style={{ display: 'flex', alignItems: 'center', gap: 9, width: '100%', padding: '9px 12px', borderRadius: 10, border: '1px solid var(--hair)', background: 'var(--surface)', cursor: 'pointer' }}>
          <Icon name="whatsapp" size={16} color="#2E7D44" />
          <span style={{ flex: 1, textAlign: 'left', fontWeight: 600, fontSize: 13, color: 'var(--ink-2)' }}>{t('Invia conferma prenotazione', 'Send booking confirmation')}</span>
          <span className="t-sm" style={{ color: 'var(--muted-2)', fontWeight: 600 }}>WhatsApp</span>
        </button>
      ) : null}

      {/* tech sheet preview — inline, click to open full */}
      {window.TechSheetPreview && <window.TechSheetPreview clientId={live.clientId} t={t} lang={lang}
        onOpen={(sheetId) => openModal('techsheet', { clientId: live.clientId, viewSheetId: sheetId, apptLabel: { it: live.serviceIds.map(s => svcName(svc(s), 'it')).join(' + '), en: live.serviceIds.map(s => svcName(svc(s), 'en')).join(' + ') } })}
        onCreate={() => openModal('techsheet', { clientId: live.clientId, apptId: live.id, opId: live.opId, category: (svc(live.serviceIds[0]) || {}).cat, apptLabel: { it: live.serviceIds.map(s => svcName(svc(s), 'it')).join(' + '), en: live.serviceIds.map(s => svcName(svc(s), 'en')).join(' + ') } })} />}
      </div>

        {/* RIGHT COLUMN — what & actions */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, padding: 16, borderRadius: 16, border: '1px solid var(--hair)', background: 'color-mix(in srgb, var(--surface-2) 45%, transparent)' }}>
      {/* services */}
      <div style={{ background: 'var(--surface-2)', borderRadius: 14, padding: 14 }}>
        {live.serviceIds.map(sid => { const s = svc(sid); return <div key={sid} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0' }}><span style={{ fontWeight: 600, fontSize: 14 }}>{svcName(s, lang)}</span><span className="t-sm" style={{ color: 'var(--muted)' }}>{fmtDur(svcDur(sid, live.opId), lang)} · {fmtEur(s.price, lang)}</span></div>; })}
        <div className="hr" style={{ margin: '8px 0' }} />
        <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700 }}><span>{t('Totale', 'Total')}</span><span className="t-num" style={{ fontSize: 17 }}>{fmtEur(apptTotal(live), lang)}</span></div>
      </div>

      {/* late-arrival automation — shown until checked in */}
      {live.status !== 'checkin' && (() => { const elapsed = nowMin - live.start; const late = elapsed >= 0; const sentMsg = elapsed >= 10; return (
        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '12px 14px', borderRadius: 12, background: late ? 'var(--warn-tint)' : 'var(--surface-2)', marginBottom: 14 }}>
          <Icon name={sentMsg ? 'whatsapp' : 'clock'} size={17} color={sentMsg ? '#3F9D58' : (late ? 'var(--warn)' : 'var(--muted)')} style={{ flexShrink: 0, marginTop: 1 }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 700, fontSize: 13 }}>{sentMsg ? t('Sollecito inviato · in attesa di arrivo', 'Reminder sent · awaiting arrival') : late ? t('Cliente non ancora arrivata', 'Client not yet arrived') : t('In attesa di arrivo', 'Awaiting arrival')}</div>
            <div className="t-sm" style={{ color: 'var(--muted)', marginTop: 2, lineHeight: 1.45 }}>{sentMsg ? t('A +10 min è partito un WhatsApp automatico “Sei in arrivo?”. Registra il check-in appena arriva.', 'At +10 min an automatic “Are you on your way?” WhatsApp was sent. Check in as soon as she arrives.') : t('Se non arriva entro 10 minuti parte un sollecito WhatsApp automatico. Registra il check-in al suo arrivo.', 'If she’s 10 min late an automatic WhatsApp reminder is sent. Check in on arrival.')}</div>
          </div>
        </div>
      ); })()}

      {/* primary + management actions */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        {(live.status === 'checkin' || live.status === 'corso' || live.status === 'checkout') ? (
          <button className="dk-btn dk-btn--clay" style={{ gridColumn: '1 / -1', height: 48 }} onClick={() => { set('checkout'); openModal('sell', id); }}><Icon name="wallet" size={18} color="#fff" />{t('Check-out · incasso e vendita', 'Check-out · payment & sale')}</button>
        ) : (
          <React.Fragment>
          <button className="dk-btn dk-btn--clay" style={{ gridColumn: '1 / -1', height: 48 }} onClick={() => { set('checkin'); fireToast({ msg: t('Check-in registrato', 'Checked in'), icon: 'check' }); }}><Icon name="check" size={18} color="#fff" />{t('Check-in', 'Check in')}</button>
          <button className="dk-btn dk-btn--ghost" style={{ gridColumn: '1 / -1' }} onClick={() => openModal('sell', id)}><Icon name="wallet" size={17} />{t('Check-out · incasso e vendita', 'Check-out · payment & sale')}</button>
          </React.Fragment>
        )}
        <div style={{ gridColumn: '1 / -1', display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginTop: 2 }}>
          <button className="dk-btn dk-btn--soft" style={{ flexDirection: 'column', gap: 5, height: 60, fontSize: 12 }} onClick={() => { setEditSvcs([...live.serviceIds]); setResolution('balance'); setFlow('changesvc'); }}><Icon name="scissors" size={18} />{t('Modifica', 'Edit')}</button>
          <button className="dk-btn dk-btn--soft" style={{ flexDirection: 'column', gap: 5, height: 60, fontSize: 12 }} onClick={() => setFlow('notes')}><Icon name="edit" size={18} />{t('Note', 'Notes')}</button>
          <button className="dk-btn dk-btn--soft" style={{ flexDirection: 'column', gap: 5, height: 60, fontSize: 12 }} onClick={() => { setFlow('reschedule'); setReason(null); setNote(''); }}><Icon name="calendar" size={18} />{t('Sposta', 'Reschedule')}</button>
        </div>
      </div>
        </div>
      </div>

      {/* downgraded destructive actions — full width */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 18, paddingTop: 14, marginTop: 14, borderTop: '1px solid var(--hair)' }}>
        <button onClick={() => { setFlow('noshow'); }} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 600, color: 'var(--muted)', background: 'transparent', cursor: 'pointer', padding: '6px 8px' }}><Icon name="alert" size={15} color="var(--muted)" />No-show</button>
        <span style={{ width: 1, height: 16, background: 'var(--hair)' }} />
        <button onClick={() => { setFlow('cancel'); setReason(null); setNote(''); }} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 600, color: 'var(--muted)', background: 'transparent', cursor: 'pointer', padding: '6px 8px' }}><Icon name="x" size={15} color="var(--muted)" />{t('Cancella appuntamento', 'Cancel appointment')}</button>
      </div>
    </DkModal>
  );
}

/* ---------- Sell ---------- */
function SellModal({ data }) {
  const id = typeof data === 'object' && data ? data.id : data;
  const { t, lang, closeModal, fireToast, appts, commission } = useDk();
  const a = appts.find(x => x.id === id);
  const [method, setMethod] = useStateDm('carta');
  const [split, setSplit] = useStateDm(false);
  const [splitA, setSplitA] = useStateDm({ m: 'contanti', amt: 0 });
  const [splitB, setSplitB] = useStateDm({ m: 'carta', amt: 0 });
  const [saving, setSaving] = useStateDm(false);
  const [giftSvc, setGiftSvc] = useStateDm([]);     // gifted service line keys
  const [prodLines, setProdLines] = useStateDm([]); // { key, pid, opId, gift, disc }
  const [pickOp, setPickOp] = useStateDm(null);     // opId whose product picker is open
  const [pickQ, setPickQ] = useStateDm('');
  const siblings = a ? appts.filter(x => x.id !== a.id && x.clientId === a.clientId && x.kind !== 'break') : [];
  const [incl, setIncl] = useStateDm(() => siblings.map(s => s.id));
  if (!a) return null;
  const checkoutAppts = [a, ...siblings.filter(s => incl.includes(s.id))];
  const multi = siblings.length > 0;
  const c = client(a.clientId);
  const prodItems = RETAIL;
  // operators involved across the included appointments
  const opsInvolved = [...new Set(checkoutAppts.map(ap => ap.opId))];
  const svcLinesOf = (opId) => checkoutAppts.filter(ap => ap.opId === opId).flatMap(ap => ap.serviceIds.map((sid, j) => ({ key: ap.id + '_' + sid + '_' + j, ap, sid, price: svc(sid).price })));
  const prodLinesOf = (opId) => prodLines.filter(l => l.opId === opId);
  const toggleGiftSvc = (k) => setGiftSvc(l => l.includes(k) ? l.filter(x => x !== k) : [...l, k]);
  const addProd = (opId, pid) => { setProdLines(l => [...l, { key: 'pl' + Date.now() + Math.round(Math.random() * 1e4), pid, opId, gift: false, disc: 0 }]); setPickOp(null); setPickQ(''); };
  const setProd = (key, patch) => setProdLines(l => l.map(x => x.key === key ? { ...x, ...patch } : x));
  const removeProd = (key) => setProdLines(l => l.filter(x => x.key !== key));
  // line value helpers
  const svcVal = (ln) => giftSvc.includes(ln.key) ? 0 : ln.price;
  const prodPrice = (l) => prodItems.find(p => p.id === l.pid).price;
  const prodVal = (l) => l.gift ? 0 : Math.round(prodPrice(l) * (1 - (l.disc || 0) / 100));
  const opSubtotal = (opId) => svcLinesOf(opId).reduce((s, ln) => s + svcVal(ln), 0) + prodLinesOf(opId).reduce((s, l) => s + prodVal(l), 0);
  const gross = opsInvolved.reduce((s, oid) => s + opSubtotal(oid), 0);
  const depPaid = checkoutAppts.reduce((s, ap) => s + (ap.deposit === 'paid' ? Math.round(apptTotal(ap) * 0.3) : 0), 0);
  const total = Math.max(0, gross - depPaid);
  const methods = [['carta', t('Carta', 'Card')], ['contanti', t('Contanti', 'Cash')], ['altro', t('Altro', 'Other')]];
  const toggleIncl = (sid) => setIncl(l => l.includes(sid) ? l.filter(x => x !== sid) : [...l, sid]);
  const splitSum = (split ? (splitA.amt || 0) + (splitB.amt || 0) : total);
  const splitOk = !split || splitSum === total;
  const autoSplitB = () => setSplitB(b => ({ ...b, amt: Math.max(0, total - (splitA.amt || 0)) }));
  const addable = (opId) => prodItems.filter(p => !pickQ || p.name[lang].toLowerCase().includes(pickQ.toLowerCase()));
  const inputCss = { border: '1px solid var(--hair)', borderRadius: 8, outline: 'none', fontSize: 13, padding: '7px 9px', fontFamily: 'var(--sans)', background: 'var(--surface)' };

  return (
    <DkModal open onClose={closeModal} title={t('Check-out · incasso e vendita', 'Check-out · payment & sale')} sub={c.name + ' · ' + t('ogni operatrice registra la sua vendita, poi un unico pagamento', 'each stylist records her sale, then one payment')} width={900}
      foot={<React.Fragment><button className="dk-btn dk-btn--ghost" onClick={closeModal} disabled={saving}>{t('Annulla', 'Cancel')}</button><button className="dk-btn dk-btn--clay" disabled={!splitOk || saving} style={saving ? { background: 'var(--ok)', borderColor: 'var(--ok)' } : null} onClick={() => { if (saving) return; setSaving(true); fireToast({ msg: t('Check-out registrato', 'Check-out recorded'), icon: 'check' }); setTimeout(closeModal, 1400); }}>{saving ? <React.Fragment><Icon name="check" size={17} color="#fff" stroke={2.6} />{t('Registrato', 'Recorded')}</React.Fragment> : <React.Fragment><Icon name="check" size={17} color="#fff" />{t('Incassa', 'Take payment')} {fmtEur(total, lang)}</React.Fragment>}</button></React.Fragment>}>

      <div style={{ display: 'grid', gridTemplateColumns: '1.1fr 0.9fr', gap: 22, alignItems: 'start' }}>
        {/* LEFT — sale grouped by operator */}
        <div>
          {multi && (
            <div style={{ marginBottom: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}><Icon name="clients" size={15} color="var(--clay-ink)" /><span className="t-meta">{t('Appuntamenti della visita', 'Appointments in this visit')}</span></div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                {[a, ...siblings].map(ap => { const apo = op(ap.opId); const isBase = ap.id === a.id; const on = isBase || incl.includes(ap.id); return (
                  <div key={ap.id} onClick={() => !isBase && toggleIncl(ap.id)} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', borderRadius: 10, cursor: isBase ? 'default' : 'pointer', border: '1px solid ' + (on ? 'var(--clay)' : 'var(--hair)'), background: on ? 'var(--clay-tint)' : 'var(--surface)' }}>
                    <div style={{ width: 18, height: 18, borderRadius: 5, border: '1.8px solid ' + (on ? 'var(--clay)' : 'var(--faint)'), background: on ? 'var(--clay)' : 'transparent', display: 'grid', placeItems: 'center', flexShrink: 0, opacity: isBase ? 0.6 : 1 }}>{on && <Icon name="check" size={12} color="#fff" stroke={2.6} />}</div>
                    <span style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{apo.name} · {ap.serviceIds.map(s => svcName(svc(s), lang)).join(' + ')}</span>
                    <span className="t-num" style={{ fontSize: 13, flexShrink: 0 }}>{fmtEur(apptTotal(ap), lang)}</span>
                  </div>
                ); })}
              </div>
            </div>
          )}

          {/* per-operator sale blocks */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {opsInvolved.map(oid => { const o = op(oid); const svcL = svcLinesOf(oid); const prodL = prodLinesOf(oid); const sub = opSubtotal(oid); return (
              <div key={oid} style={{ border: '1px solid var(--hair)', borderRadius: 14 }}>
                {/* operator header */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '11px 14px', borderRadius: '13px 13px 0 0', background: `color-mix(in srgb, ${o.color} 14%, var(--surface))` }}>
                  <Avatar initials={o.initials} size={30} color={o.color} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 700, fontSize: 14 }}>{o.name} {o.surname || ''}</div>
                    <div className="t-sm" style={{ color: 'var(--muted)' }}>{t('Vendita accreditata', 'Sale credited')}</div>
                  </div>
                  <span className="t-num" style={{ fontWeight: 700, fontSize: 15 }}>{sub === 0 ? '€0' : fmtEur(sub, lang)}</span>
                </div>
                <div style={{ padding: '4px 14px 12px' }}>
                  {/* services */}
                  {svcL.map(ln => { const s = svc(ln.sid); const gifted = giftSvc.includes(ln.key); return (
                    <div key={ln.key} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0', borderBottom: '1px solid var(--hair-2, var(--hair))' }}>
                      <Icon name="scissors" size={14} color="var(--muted-2)" style={{ flexShrink: 0 }} />
                      <span style={{ flex: 1, fontSize: 13.5, fontWeight: 600, color: gifted ? 'var(--ok)' : 'var(--ink)' }}>{svcName(s, lang)}</span>
                      <button onClick={() => toggleGiftSvc(ln.key)} title={t('Ometti pagamento', 'Comp this item')} className="dk-iconbtn" style={{ width: 26, height: 26, flexShrink: 0, background: gifted ? 'var(--ok-tint)' : 'transparent', borderRadius: 7 }}><Icon name="gift" size={14} color={gifted ? 'var(--ok)' : 'var(--muted-2)'} /></button>
                      <span className="t-num" style={{ minWidth: 54, textAlign: 'right', fontSize: 13 }}>{gifted ? <span style={{ color: 'var(--ok)', fontWeight: 700, fontSize: 12 }}>{t('Omaggio', 'Free')}</span> : fmtEur(s.price, lang)}</span>
                    </div>
                  ); })}
                  {/* sold products */}
                  {prodL.map(l => { const p = prodItems.find(x => x.id === l.pid); return (
                    <div key={l.key} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0', borderBottom: '1px solid var(--hair-2, var(--hair))' }}>
                      <Icon name="box" size={14} color="var(--muted-2)" style={{ flexShrink: 0 }} />
                      <span style={{ flex: 1, minWidth: 0, fontSize: 13.5, fontWeight: 600, color: l.gift ? 'var(--ok)' : 'var(--ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name[lang]}</span>
                      {!l.gift && <div style={{ display: 'inline-flex', alignItems: 'center', gap: 1, ...inputCss, padding: '3px 6px', height: 26 }} title={t('Sconto prodotto', 'Product discount')}><input type="number" min={0} max={100} value={l.disc || 0} onChange={e => setProd(l.key, { disc: Math.max(0, Math.min(100, parseInt(e.target.value) || 0)) })} style={{ width: 24, textAlign: 'right', border: 'none', outline: 'none', background: 'transparent', fontSize: 12.5, fontWeight: 700, fontFamily: 'var(--mono, monospace)' }} /><span className="t-sm" style={{ color: 'var(--muted-2)', fontWeight: 700 }}>%</span></div>}
                      <button onClick={() => setProd(l.key, { gift: !l.gift })} title={t('Omaggio', 'Gift')} className="dk-iconbtn" style={{ width: 26, height: 26, flexShrink: 0, background: l.gift ? 'var(--ok)' : 'transparent', borderRadius: 7 }}><Icon name="gift" size={14} color={l.gift ? '#fff' : 'var(--muted-2)'} /></button>
                      <button onClick={() => removeProd(l.key)} className="dk-iconbtn" style={{ width: 26, height: 26, flexShrink: 0, borderRadius: 7 }}><Icon name="x" size={13} color="var(--muted-2)" /></button>
                      <span className="t-num" style={{ minWidth: 54, textAlign: 'right', fontSize: 13 }}>{l.gift ? <span style={{ color: 'var(--ok)', fontWeight: 700, fontSize: 12 }}>{t('Omaggio', 'Free')}</span> : fmtEur(prodVal(l), lang)}</span>
                    </div>
                  ); })}
                  {/* add product to this operator */}
                  {pickOp === oid ? (
                    <div style={{ position: 'relative', marginTop: 10 }}>
                      <div className="dk-search" style={{ width: '100%', height: 36 }}>
                        <Icon name="search" size={15} color="var(--muted-2)" />
                        <input autoFocus value={pickQ} onChange={e => setPickQ(e.target.value)} placeholder={t('Prodotto venduto da ' + o.name + '…', 'Product sold by ' + o.name + '…')} />
                        <button onClick={() => { setPickOp(null); setPickQ(''); }} style={{ cursor: 'pointer', display: 'grid', placeItems: 'center' }}><Icon name="x" size={14} color="var(--muted-2)" /></button>
                      </div>
                      <div className="dk-card scroll" style={{ position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0, zIndex: 20, padding: 6, boxShadow: 'var(--sh-pop)', maxHeight: 200, overflowY: 'auto' }}>
                        {addable(oid).map(p => (
                          <button key={p.id} className="dk-row" onClick={() => addProd(oid, p.id)} style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '8px 10px', borderRadius: 8, textAlign: 'left' }}>
                            <Icon name="box" size={15} color="var(--muted-2)" />
                            <span style={{ flex: 1, fontWeight: 600, fontSize: 13.5 }}>{p.name[lang]}</span>
                            <span className="t-num" style={{ fontSize: 13, color: 'var(--muted)' }}>{fmtEur(p.price, lang)}</span>
                          </button>
                        ))}
                        {!addable(oid).length && <div className="t-sm" style={{ color: 'var(--muted-2)', padding: 12, textAlign: 'center' }}>{t('Nessun prodotto', 'No products')}</div>}
                      </div>
                    </div>
                  ) : (
                    <button onClick={() => { setPickOp(oid); setPickQ(''); }} style={{ display: 'inline-flex', alignItems: 'center', gap: 7, marginTop: 10, padding: '7px 12px', borderRadius: 9, border: '1px dashed var(--hair)', background: 'var(--surface)', cursor: 'pointer', fontSize: 12.5, fontWeight: 600, color: 'var(--clay-ink)' }}><Icon name="plus" size={14} color="var(--clay-ink)" />{t('Aggiungi vendita prodotto', 'Add product sale')}</button>
                  )}
                </div>
              </div>
            ); })}
          </div>
        </div>

        {/* RIGHT — single shared payment */}
        <div>
          <div className="t-meta" style={{ marginBottom: 8 }}>{t('Metodo di pagamento', 'Payment method')}</div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', marginBottom: 8 }}>
            <button onClick={() => { const next = !split; setSplit(next); if (next) { setSplitA(av => ({ ...av, amt: Math.round(total / 2) })); setSplitB(bv => ({ ...bv, amt: total - Math.round(total / 2) })); } }} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, cursor: 'pointer', background: 'transparent', border: 'none', fontSize: 12.5, fontWeight: 700, color: split ? 'var(--clay-ink)' : 'var(--muted)' }}><Icon name={split ? 'check' : 'plus'} size={13} color={split ? 'var(--clay-ink)' : 'var(--muted)'} />{t('Pagamento diviso', 'Split payment')}</button>
          </div>
          {!split ? (
            <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>{methods.map(([k, l]) => <button key={k} onClick={() => setMethod(k)} style={{ flex: 1, padding: '11px', borderRadius: 10, fontSize: 13.5, fontWeight: 600, cursor: 'pointer', border: '1px solid ' + (method === k ? 'var(--ink)' : 'var(--hair)'), background: method === k ? 'var(--ink)' : 'var(--surface)', color: method === k ? '#fff' : 'var(--ink)' }}>{l}</button>)}</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 16 }}>
              {[[splitA, setSplitA, autoSplitB], [splitB, setSplitB, () => setSplitA(av => ({ ...av, amt: Math.max(0, total - (splitB.amt || 0)) }))]].map(([part, setPart, balanceOther], idx) => (
                <div key={idx} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div style={{ display: 'flex', gap: 5, flex: 1 }}>{methods.map(([k, l]) => <button key={k} onClick={() => setPart(p => ({ ...p, m: k }))} style={{ flex: 1, padding: '9px 6px', borderRadius: 9, fontSize: 12.5, fontWeight: 600, cursor: 'pointer', border: '1px solid ' + (part.m === k ? 'var(--ink)' : 'var(--hair)'), background: part.m === k ? 'var(--ink)' : 'var(--surface)', color: part.m === k ? '#fff' : 'var(--ink)' }}>{l}</button>)}</div>
                  <div style={{ display: 'inline-flex', alignItems: 'center', gap: 3, border: '1px solid var(--hair)', borderRadius: 9, padding: '8px 10px', background: 'var(--surface)', width: 92, boxSizing: 'border-box' }}>
                    <span style={{ color: 'var(--muted-2)', fontWeight: 700 }}>€</span>
                    <input type="number" min={0} value={part.amt} onChange={e => setPart(p => ({ ...p, amt: Math.max(0, parseInt(e.target.value) || 0) }))} onBlur={balanceOther} style={{ border: 'none', outline: 'none', background: 'transparent', fontFamily: 'ui-monospace, monospace', fontWeight: 700, fontSize: 14, width: '100%' }} />
                  </div>
                </div>
              ))}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 12px', borderRadius: 10, background: splitOk ? 'var(--ok-tint)' : 'var(--warn-tint)' }}>
                <span className="t-sm" style={{ fontWeight: 700, color: splitOk ? 'var(--ok)' : 'var(--warn)', display: 'inline-flex', alignItems: 'center', gap: 5 }}><Icon name={splitOk ? 'check' : 'alert'} size={14} color={splitOk ? 'var(--ok)' : 'var(--warn)'} />{splitOk ? t('Importi corrispondenti', 'Amounts match') : t('La somma non corrisponde', 'Sum does not match')}</span>
                <span className="t-num" style={{ fontWeight: 700, color: splitOk ? 'var(--ok)' : 'var(--warn)' }}>{fmtEur(splitSum, lang)} / {fmtEur(total, lang)}</span>
              </div>
            </div>
          )}

          {/* totals — per operator + grand */}
          <div style={{ borderRadius: 12, padding: '14px 16px', border: '1px solid var(--hair)', background: 'var(--surface)' }}>
            {opsInvolved.length > 1 && opsInvolved.map(oid => { const o = op(oid); return (
              <div key={oid} style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0' }}><span className="t-sm" style={{ color: 'var(--muted)', display: 'inline-flex', alignItems: 'center', gap: 6 }}><span style={{ width: 8, height: 8, borderRadius: 99, background: o.color }} />{o.name}</span><span className="tabnum">{fmtEur(opSubtotal(oid), lang)}</span></div>
            ); })}
            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0' }}><span className="t-sm" style={{ color: 'var(--muted)' }}>{t('Totale lordo', 'Gross total')}</span><span className="tabnum">{fmtEur(gross, lang)}</span></div>
            {depPaid > 0 && <div style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0', color: 'var(--ok)' }}><span className="t-sm" style={{ fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon name="wallet" size={14} color="var(--ok)" />{t('Caparra prepagata', 'Prepaid deposit')}</span><span className="tabnum" style={{ fontWeight: 700 }}>− {fmtEur(depPaid, lang)}</span></div>}
            <div className="hr" style={{ margin: '7px 0' }} />
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}><span style={{ fontWeight: 700 }}>{depPaid > 0 ? t('Saldo da incassare', 'Balance due') : t('Totale da incassare', 'Total due')}</span><span className="t-num" style={{ fontSize: 24, fontWeight: 800 }}>{total === 0 ? '€0' : fmtEur(total, lang)}</span></div>
          </div>
        </div>
      </div>
    </DkModal>
  );
}

/* ---------- Opportunity ---------- */
function OpportunityModal() {
  const { t, lang, closeModal, fireToast } = useDk();
  const [recips, setRecips] = useStateDm([
    { id: 'c4', name: 'Aisha Diallo' }, { id: 'cx1', name: 'Federica Mancini' }, { id: 'c5', name: 'Chiara Greco' }, { id: 'c1', name: 'Sofia Ricci' },
  ]);
  const [pickOpen, setPickOpen] = useStateDm(false);
  const [pickQ, setPickQ] = useStateDm('');
  const n = recips.length;
  const addClient = (c) => { if (!recips.some(r => r.id === c.id)) setRecips(l => [...l, { id: c.id, name: c.name }]); setPickQ(''); setPickOpen(false); };
  const removeRecip = (id) => setRecips(l => l.filter(r => r.id !== id));
  const candidates = CLIENTS.filter(c => !recips.some(r => r.id === c.id) && (!pickQ || c.name.toLowerCase().includes(pickQ.toLowerCase()))).slice(0, 8);
  return (
    <DkModal open onClose={closeModal} title={t('Riempi il buco delle 15:00', 'Fill the 15:00 gap')} sub={t('yourang ha preparato il messaggio. Controlla prima di inviare.', 'yourang drafted the message. Review before sending.')} width={560}
      foot={<React.Fragment><button className="dk-btn dk-btn--ghost" onClick={closeModal}>{t('Chiudi', 'Close')}</button><button className="dk-btn dk-btn--clay" disabled={!n} onClick={() => { closeModal(); fireToast({ msg: t(`Invio a ${n} clienti tramite yourang`, `Sending to ${n} clients via yourang`), icon: 'whatsapp' }); }}><Icon name="send" size={16} color="#fff" />{t(`Invia a ${n}`, `Send to ${n}`)}</button></React.Fragment>}>
      <div style={{ background: '#E7DED3', borderRadius: 14, padding: 14, marginBottom: 18 }}>
        <div style={{ background: '#fff', borderRadius: '4px 14px 14px 14px', padding: '11px 13px', fontSize: 14, lineHeight: 1.45, color: 'var(--ink-2)', maxWidth: '88%', boxShadow: '0 1px 1px rgba(0,0,0,0.08)' }}>
          {t('Ciao {nome}! Si è liberato uno slot oggi alle 15:00 per il tuo semipermanente. Lo vuoi? Rispondi SÌ 💫', 'Hi {name}! A slot opened today at 15:00 for your gel polish. Want it? Reply YES 💫')}
          <div style={{ textAlign: 'right', fontSize: 10, color: 'var(--muted-2)', marginTop: 4 }}>10:24 ✓✓</div>
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <span className="t-meta" style={{ flex: 1 }}>{t('Destinatari', 'Recipients')} · {n}</span>
        <button className="dk-btn dk-btn--ghost" style={{ height: 32, fontSize: 12.5, padding: '0 11px' }} onClick={() => setPickOpen(o => !o)}><Icon name="plus" size={14} />{t('Aggiungi cliente', 'Add client')}</button>
      </div>
      {pickOpen && (
        <div style={{ position: 'relative', marginBottom: 10 }}>
          <div className="dk-search" style={{ width: '100%', height: 38 }}>
            <Icon name="search" size={16} color="var(--muted-2)" />
            <input autoFocus value={pickQ} onChange={e => setPickQ(e.target.value)} placeholder={t('Cerca un cliente da aggiungere…', 'Search a client to add…')} />
            <button onClick={() => { setPickOpen(false); setPickQ(''); }} style={{ cursor: 'pointer', display: 'grid', placeItems: 'center' }}><Icon name="x" size={14} color="var(--muted-2)" /></button>
          </div>
          <div className="dk-card" style={{ position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0, zIndex: 20, padding: 6, boxShadow: 'var(--sh-pop)', maxHeight: 240, overflowY: 'auto' }}>
            {candidates.map(c => (
              <button key={c.id} className="dk-row" onClick={() => addClient(c)} style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '8px 10px', borderRadius: 9, textAlign: 'left' }}>
                <Avatar initials={c.initials} size={28} color="var(--clay)" />
                <span style={{ flex: 1, fontWeight: 600, fontSize: 13.5 }}>{c.name}</span>
                <Icon name="plus" size={15} color="var(--clay-ink)" />
              </button>
            ))}
            {!candidates.length && <div className="t-sm" style={{ color: 'var(--muted-2)', padding: 12, textAlign: 'center' }}>{t('Nessun cliente', 'No client found')}</div>}
          </div>
        </div>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
        {recips.map(r => (
          <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '9px 10px', borderRadius: 10, border: '1px solid var(--hair)' }}>
            <Avatar initials={r.name.split(' ').map(w => w[0]).join('')} size={30} />
            <span style={{ flex: 1, fontWeight: 600, fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.name}</span>
            <button onClick={() => removeRecip(r.id)} style={{ cursor: 'pointer', color: 'var(--muted-2)' }}><Icon name="x" size={15} /></button>
          </div>
        ))}
        {!recips.length && <div className="t-sm" style={{ color: 'var(--muted-2)', gridColumn: '1 / -1', padding: '14px 4px' }}>{t('Nessun destinatario. Aggiungi un cliente.', 'No recipients. Add a client.')}</div>}
      </div>
    </DkModal>
  );
}


/* ---- Waiting list matching helpers ---- */
function wlIsVip(clientId) {
  const c = client(clientId);
  if (!c) return false;
  if (c.segment === 'vip') return true;
  const labels = (window.__clientLabels && window.__clientLabels[clientId]) || [];
  return labels.includes('vip');
}
function wlScore(w, appt, nowMin) {
  let score = 0;
  // service match (required)
  const svcMatch = w.serviceIds.length === 0 || w.serviceIds.some(sid => appt.serviceIds.includes(sid));
  if (!svcMatch) return -1;
  score += 10;
  // VIP priority — always outranks non-VIP regardless of wait time
  if (wlIsVip(w.clientId)) score += 100;
  // full service overlap bonus
  if (w.serviceIds.every(sid => appt.serviceIds.includes(sid))) score += 5;
  // time preference match
  const hour = Math.floor(appt.start / 60);
  if (w.prefTime === 'morning' && hour < 13) score += 4;
  else if (w.prefTime === 'afternoon' && hour >= 13) score += 4;
  else if (w.prefTime === 'any') score += 2;
  // wait time bonus (each day = 1pt, assume 'Dal DD mon' → parse as index)
  const idx = ['gen','feb','mar','apr','mag','giu','lug','ago','set','ott','nov','dic'].findIndex(m => w.added.it.includes(m));
  const dayStr = w.added.it.replace(/[^0-9]/g,'').slice(0,2);
  const daysWaited = Math.min(parseInt(dayStr)||1, 30);
  score += Math.min(daysWaited * 0.3, 5);
  return score;
}
function wlRanked(waitList, appt) {
  return waitList
    .map(w => ({ w, score: wlScore(w, appt, appt.start) }))
    .filter(x => x.score >= 0)
    .sort((a, b) => b.score - a.score)
    .map(x => x.w);
}
function wlWhatsAppMsg(w, appt, lang) {
  const c = client(w.clientId);
  const svcLabel = (w.serviceIds.length ? w.serviceIds : appt.serviceIds).map(id => svcName(svc(id), lang)).join(', ');
  const slot = timeLabel(appt.start) + '–' + timeLabel(apptEnd(appt));
  if (lang === 'en') return `Hi ${c.name.split(' ')[0]}, a slot just opened up for ${svcLabel} at ${slot}. Would you like to book it? 💜 The Parlour`;
  return `Ciao ${c.name.split(' ')[0]}, si è liberato un posto per ${svcLabel} alle ${slot}. Ti interessa prenotarlo? 💜 The Parlour`;
}
/* ---- Freed slot modal: post-cancellation, offer to waiting-list clients ---- */
function FreedSlotModal() {
  const { t, lang, closeModal, modal, openModal, fireToast, waitList, setWaitList } = useDk();
  const { appt, matches: rawMatches } = modal.data || {};
  if (!appt) return null;
  const matches = rawMatches ? wlRanked(rawMatches, appt) : [];
  const best = matches[0];
  const svcLabels = appt.serviceIds.map(id => svcName(svc(id), lang)).join(', ');
  const slotLabel = timeLabel(appt.start) + '–' + timeLabel(apptEnd(appt));

  const book = (w) => {
    setWaitList(l => l.filter(x => x.id !== w.id));
    closeModal();
    // pre-fill the new appointment with the waiting-list client + services
    setTimeout(() => openModal('newappt', { prefill: { clientId: w.clientId, serviceIds: w.serviceIds.length ? w.serviceIds : appt.serviceIds, start: appt.start } }), 200);
  };
  const contact = (w) => {
    const msg = wlWhatsAppMsg(w, appt, lang);
    fireToast({ msg: t('Messaggio Yourang/WhatsApp pronto per ' + client(w.clientId).name.split(' ')[0], 'Yourang/WhatsApp message ready for ' + client(w.clientId).name.split(' ')[0]), icon: 'whatsapp' });
  };
  const dismiss = (w) => setWaitList(l => l.filter(x => x.id !== w.id));

  // AI reasoning for best match
  const aiReason = (w) => {
    const parts = [];
    const svcMatch = w.serviceIds.some(sid => appt.serviceIds.includes(sid));
    if (svcMatch) parts.push(t('servizio compatibile', 'service matches'));
    if (w.prefTime === 'morning' && appt.start < 13*60) parts.push(t('preferisce mattina ✓', 'prefers morning ✓'));
    if (w.prefTime === 'afternoon' && appt.start >= 13*60) parts.push(t('preferisce pomeriggio ✓', 'prefers afternoon ✓'));
    if (w.added.it.includes('8') || w.added.it.includes('9') || w.added.it.includes('10')) parts.push(t('in lista da 2+ giorni', 'on list 2+ days'));
    return parts.join(' · ');
  };

  return (
    <DkModal open onClose={closeModal} title={t('Slot liberato', 'Slot freed up')} sub={svcLabels + ' · ' + slotLabel} width={500}
      foot={<button className="dk-btn dk-btn--ghost" onClick={closeModal}>{t('Chiudi', 'Close')}</button>}>

      {/* AI top suggestion */}
      {best && (
        <div style={{ padding: '14px 16px', borderRadius: 14, background: 'var(--clay-tint)', border: '1.5px solid var(--clay)', marginBottom: 18 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 12 }}>
            <Icon name="sparkle" size={15} color="var(--clay-ink)" />
            <span style={{ fontWeight: 700, fontSize: 13.5, color: 'var(--clay-ink)' }}>{t('Suggerimento AI · miglior corrispondenza', 'AI suggestion · best match')}</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
            <Avatar initials={client(best.clientId).initials} size={40} color={client(best.clientId).color || 'var(--clay)'} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 700, fontSize: 15.5 }}>{client(best.clientId).name}</div>
              <div className="t-sm" style={{ color: 'var(--clay-ink)', opacity: 0.75, marginTop: 2 }}>{aiReason(best)}</div>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 9, marginTop: 13 }}>
            <button className="dk-btn dk-btn--clay" style={{ flex: 2, height: 42 }} onClick={() => book(best)}>
              <Icon name="calendar" size={16} color="#fff" />{t('Proponi', 'Propose')}
            </button>
            <button className="dk-btn dk-btn--ghost" style={{ flex: 1, height: 42 }} onClick={() => contact(best)}>
              <Icon name="whatsapp" size={16} color="#3F9D58" />{t('Contatta', 'Contact')}
            </button>
          </div>
          {best.note && <div className="t-sm" style={{ color: 'var(--clay-ink)', opacity: 0.6, marginTop: 8 }}>📝 {best.note}</div>}
        </div>
      )}

      {/* other matches */}
      {matches.length > 1 && (
        <React.Fragment>
          <div className="t-meta" style={{ marginBottom: 10 }}>{t('Altre clienti in lista', 'Other clients on the list')}</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {matches.slice(1).map(w => {
              const c = client(w.clientId);
              const svcs = w.serviceIds.map(id => svcName(svc(id), lang)).join(', ');
              const prefLabel = w.prefTime === 'custom' && w.band ? w.band : ({ any: t('Qualsiasi orario', 'Any time'), morning: t('Mattina', 'Morning'), afternoon: t('Pomeriggio', 'Afternoon') }[w.prefTime] || '');
              return (
                <div key={w.id} className="dk-card" style={{ padding: '11px 13px', display: 'flex', gap: 10, alignItems: 'center', boxShadow: 'none', border: '1px solid var(--hair)' }}>
                  <Avatar initials={c.initials} size={34} color={c.color || 'var(--clay)'} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 700, fontSize: 13.5 }}>{c.name}</div>
                    <div className="t-sm" style={{ color: 'var(--muted)' }}>{svcs || t('Qualsiasi servizio', 'Any service')} · {prefLabel}</div>
                  </div>
                  <div style={{ display: 'flex', gap: 7, flexShrink: 0 }}>
                    <button className="dk-btn dk-btn--clay" style={{ height: 34, fontSize: 12.5, padding: '0 12px' }} onClick={() => book(w)}>{t('Proponi', 'Propose')}</button>
                    <button className="dk-btn dk-btn--ghost" style={{ height: 34, fontSize: 12.5, padding: '0 12px' }} onClick={() => contact(w)}><Icon name="whatsapp" size={13} color="#3F9D58" /></button>
                    <button className="dk-iconbtn" onClick={() => dismiss(w)} style={{ width: 30, height: 34, borderRadius: 8, display: 'grid', placeItems: 'center', color: 'var(--muted-2)' }}><Icon name="x" size={13} /></button>
                  </div>
                </div>
              );
            })}
          </div>
        </React.Fragment>
      )}

      {matches.length === 0 && (
        <div className="t-sm" style={{ color: 'var(--muted-2)', textAlign: 'center', padding: 14 }}>{t('Nessuna cliente in lista per questo servizio.', 'No clients on the list for this service.')}</div>
      )}
      <div style={{ marginTop: 16, paddingTop: 14, borderTop: '1px solid var(--hair)', display: 'flex', alignItems: 'center', gap: 10 }}>
        <Icon name="plus" size={15} color="var(--muted-2)" />
        <span className="t-sm" style={{ color: 'var(--muted-2)', flex: 1 }}>{t("Vuoi proporre lo slot a un'altra cliente?", 'Want to propose this slot to another client?')}</span>
        <button className="dk-btn dk-btn--ghost" style={{ height: 34, fontSize: 13 }} onClick={() => { closeModal(); setTimeout(() => openModal('waitlist'), 200); }}>{t("Apri lista d'attesa", 'Open waiting list')}</button>
        <button className="dk-btn dk-btn--ghost" style={{ height: 34, fontSize: 13 }} onClick={() => { closeModal(); setTimeout(() => openModal('newappt'), 200); }}>{t('Nuova prenotazione', 'New booking')}</button>
      </div>
    </DkModal>
  );
}

/* ---- Waiting list drawer: full list management ---- */
function WaitListModal() {
  const { t, lang, closeModal, waitList, setWaitList, openModal, fireToast } = useDk();
  const [newOpen, setNewOpen] = useStateDm(false);
  const [form, setForm] = useStateDm({ clientId: 'c1', serviceIds: [], prefTime: 'any', customFrom: '09:00', customTo: '12:00', note: '' });
  const seqW = React.useRef(900);
  const PREF_TIMES = [['any', t('Qualsiasi', 'Any')], ['morning', t('Mattina', 'Morning')], ['afternoon', t('Pomeriggio', 'Afternoon')], ['custom', t('Fascia oraria', 'Time band')]];
  const addToList = () => {
    setWaitList(l => [...l, { id: 'w' + (seqW.current++), clientId: form.clientId, serviceIds: [...form.serviceIds], opId: null, prefDays: [], prefTime: form.prefTime, band: form.prefTime === 'custom' ? (form.customFrom + '–' + form.customTo) : null, note: form.note, added: { it: 'Oggi', en: 'Today' } }]);
    setNewOpen(false); setForm({ clientId: 'c1', serviceIds: [], prefTime: 'any', customFrom: '09:00', customTo: '12:00', note: '' });
    fireToast({ msg: t('Aggiunto in lista d\'attesa', 'Added to waiting list'), icon: 'check' });
  };
  const inputCss = { border: '1px solid var(--hair)', borderRadius: 10, outline: 'none', fontSize: 14, padding: '9px 11px', fontFamily: 'var(--sans)', background: 'var(--surface)', width: '100%', boxSizing: 'border-box' };
  // VIP pinned to top, then manual array order
  const ordered = [...waitList].sort((a, b) => (wlIsVip(b.clientId) ? 1 : 0) - (wlIsVip(a.clientId) ? 1 : 0));
  const move = (id, dir) => setWaitList(l => { const i = l.findIndex(x => x.id === id); const j = i + dir; if (i < 0 || j < 0 || j >= l.length) return l; const n = [...l]; const [it] = n.splice(i, 1); n.splice(j, 0, it); return n; });
  return (
    <DkDrawer open onClose={closeModal}>
      <div style={{ padding: '22px 22px 0', borderBottom: '1px solid var(--hair)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontFamily: 'var(--serif)', fontSize: 20, fontWeight: 500 }}>{t('Lista d\'attesa', 'Waiting list')}</div>
            <div className="t-sm" style={{ color: 'var(--muted)', marginTop: 3 }}>{t('Alla cancellazione di un appuntamento, la prima cliente compatibile viene avvisata su WhatsApp. Le clienti VIP hanno la priorità.', 'When an appointment is cancelled, the first matching client is alerted on WhatsApp. VIP clients take priority.')}</div>
          </div>
          <button className="dk-iconbtn" onClick={closeModal} style={{ flexShrink: 0 }}><Icon name="x" size={19} /></button>
        </div>
      </div>
      <div className="scroll" style={{ flex: 1, overflowY: 'auto', padding: '16px 22px' }}>
        {waitList.length === 0 && <div className="t-sm" style={{ color: 'var(--muted-2)', padding: '8px 0 16px' }}>{t('Nessun cliente in lista.', 'No clients on the list.')}</div>}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 16 }}>
          {ordered.map((w, pos) => {
            const c = client(w.clientId);
            const vip = wlIsVip(w.clientId);
            const idx = waitList.findIndex(x => x.id === w.id);
            const svcs = w.serviceIds.map(id => svcName(svc(id), lang)).join(', ') || t('Qualsiasi servizio', 'Any service');
            const prefLabel = w.prefTime === 'custom' && w.band ? w.band : ({ any: t('Qualsiasi orario', 'Any time'), morning: t('Mattina', 'Morning'), afternoon: t('Pomeriggio', 'Afternoon') }[w.prefTime] || '');
            return (
              <div key={w.id} className="dk-card" style={{ padding: 14, boxShadow: 'none', border: '1px solid ' + (pos === 0 ? 'var(--clay)' : 'var(--hair)'), display: 'flex', gap: 10 }}>
                {/* position + reorder */}
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, flexShrink: 0 }}>
                  <button className="dk-iconbtn" disabled={idx <= 0} onClick={() => move(w.id, -1)} title={t('Su', 'Up')} style={{ width: 24, height: 22, borderRadius: 6, display: 'grid', placeItems: 'center', color: 'var(--muted-2)', opacity: idx <= 0 ? 0.3 : 1 }}><Icon name="chevD" size={14} style={{ transform: 'rotate(180deg)' }} /></button>
                  <span className="t-num" style={{ fontSize: 14, fontWeight: 700, color: pos === 0 ? 'var(--clay-ink)' : 'var(--muted)' }}>{pos + 1}</span>
                  <button className="dk-iconbtn" disabled={idx >= waitList.length - 1} onClick={() => move(w.id, 1)} title={t('Gi\u00f9', 'Down')} style={{ width: 24, height: 22, borderRadius: 6, display: 'grid', placeItems: 'center', color: 'var(--muted-2)', opacity: idx >= waitList.length - 1 ? 0.3 : 1 }}><Icon name="chevD" size={14} /></button>
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                    <Avatar initials={c.initials} size={36} color={c.color || 'var(--clay)'} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ fontWeight: 700, fontSize: 14 }}>{c.name}</span>
                        {vip && <span style={{ fontSize: 10, fontWeight: 800, color: '#8A6D1F', background: '#F6E7B8', padding: '1px 7px', borderRadius: 99, letterSpacing: '0.04em' }}>VIP</span>}
                        {pos === 0 && <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--clay-ink)', background: 'var(--clay-tint)', padding: '1px 7px', borderRadius: 99 }}>{t('Prossima', 'Next up')}</span>}
                      </div>
                      <div className="t-sm" style={{ color: 'var(--muted)' }}>{svcs}</div>
                    </div>
                    <button className="dk-iconbtn" title={t('Rimuovi', 'Remove')} onClick={() => setWaitList(l => l.filter(x => x.id !== w.id))} style={{ width: 30, height: 30, borderRadius: 8, display: 'grid', placeItems: 'center', color: 'var(--muted-2)', flexShrink: 0 }}><Icon name="x" size={14} /></button>
                  </div>
                  <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap', marginBottom: 10 }}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 700, color: 'var(--ink-2)', background: 'var(--surface-2)', padding: '3px 8px', borderRadius: 99 }}><Icon name="clock" size={11} color="var(--muted-2)" />{prefLabel}</span>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 600, color: 'var(--muted)', background: 'var(--surface-2)', padding: '3px 8px', borderRadius: 99 }}>{t('Dal', 'Since')} {w.added[lang]}</span>
                    {w.note && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 600, color: 'var(--muted)', background: 'var(--surface-2)', padding: '3px 8px', borderRadius: 99 }}>{w.note}</span>}
                  </div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button className="dk-btn dk-btn--clay" style={{ flex: 1, height: 36, fontSize: 13 }} onClick={() => { closeModal(); setTimeout(() => openModal('newappt', { prefill: { clientId: w.clientId, serviceIds: w.serviceIds } }), 200); }}><Icon name="calendar" size={15} color="#fff" />{t('Proponi', 'Propose')}</button>
                    <button className="dk-btn dk-btn--ghost" style={{ flex: 1, height: 36, fontSize: 13 }} onClick={() => fireToast({ msg: t('Messaggio WhatsApp pronto per ' + c.name.split(' ')[0], 'WhatsApp message ready for ' + c.name.split(' ')[0]), icon: 'whatsapp' })}><Icon name="whatsapp" size={15} color="#3F9D58" />{t('Contatta', 'Contact')}</button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
      {/* sticky footer — always-visible prominent add button */}
      {!newOpen && (
        <div style={{ flexShrink: 0, padding: '14px 22px', borderTop: '1px solid var(--hair)', background: 'var(--surface)' }}>
          <button className="dk-btn dk-btn--clay" style={{ width: '100%', height: 48, fontSize: 14.5, fontWeight: 700 }} onClick={() => setNewOpen(true)}><Icon name="plus" size={18} color="#fff" />{t('Aggiungi cliente in lista', 'Add client to list')}</button>
        </div>
      )}
      {/* add form — overlay panel on top of the list */}
      {newOpen && (
        <div style={{ position: 'absolute', inset: 0, zIndex: 5, background: 'var(--surface)', display: 'flex', flexDirection: 'column' }}>
          <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 10, padding: '18px 22px', borderBottom: '1px solid var(--hair)' }}>
            <div style={{ flex: 1, fontFamily: 'var(--serif)', fontSize: 19, fontWeight: 500 }}>{t('Aggiungi alla lista d\'attesa', 'Add to waiting list')}</div>
            <button className="dk-iconbtn" onClick={() => setNewOpen(false)} style={{ flexShrink: 0 }}><Icon name="x" size={19} /></button>
          </div>
          <div className="scroll" style={{ flex: 1, overflowY: 'auto', padding: '18px 22px' }}>
            <div style={{ marginBottom: 14 }}>
              <div className="t-meta" style={{ marginBottom: 5 }}>{t('Cliente', 'Client')}</div>
              <select value={form.clientId} onChange={e => setForm(f => ({ ...f, clientId: e.target.value }))} style={{ ...inputCss, cursor: 'pointer' }}>
                {CLIENTS.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            <div style={{ marginBottom: 14 }}>
              <div className="t-meta" style={{ marginBottom: 5 }}>{t('Servizi desiderati', 'Desired services')}</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {SERVICES.slice(0, 8).map(s => { const on = form.serviceIds.includes(s.id); return (
                  <button key={s.id} onClick={() => setForm(f => ({ ...f, serviceIds: on ? f.serviceIds.filter(x => x !== s.id) : [...f.serviceIds, s.id] }))} style={{ padding: '5px 10px', borderRadius: 99, fontSize: 12, fontWeight: 600, cursor: 'pointer', border: '1px solid ' + (on ? 'var(--clay)' : 'var(--hair)'), background: on ? 'var(--clay-tint)' : 'var(--surface)', color: on ? 'var(--clay-ink)' : 'var(--ink-2)' }}>{svcName(s, lang)}</button>
                ); })}
              </div>
            </div>
            <div style={{ marginBottom: 14 }}>
              <div className="t-meta" style={{ marginBottom: 6 }}>{t('Preferenza orario', 'Time preference')}</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {PREF_TIMES.map(([v, l]) => { const on = form.prefTime === v; return (
                  <button key={v} onClick={() => setForm(f => ({ ...f, prefTime: v }))} style={{ flex: '1 1 calc(50% - 4px)', padding: '9px', borderRadius: 10, fontSize: 13, fontWeight: 600, cursor: 'pointer', border: '1px solid ' + (on ? 'var(--clay)' : 'var(--hair)'), background: on ? 'var(--clay-tint)' : 'var(--surface)', color: on ? 'var(--clay-ink)' : 'var(--ink-2)' }}>{l}</button>
                ); })}
              </div>
              {form.prefTime === 'custom' && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10 }}>
                  <input type="time" value={form.customFrom} onChange={e => setForm(f => ({ ...f, customFrom: e.target.value }))} style={{ ...inputCss, width: 'auto', flex: 1 }} />
                  <span className="t-sm" style={{ color: 'var(--muted-2)' }}>–</span>
                  <input type="time" value={form.customTo} onChange={e => setForm(f => ({ ...f, customTo: e.target.value }))} style={{ ...inputCss, width: 'auto', flex: 1 }} />
                </div>
              )}
            </div>
            <div style={{ marginBottom: 14 }}>
              <div className="t-meta" style={{ marginBottom: 5 }}>{t('Note', 'Notes')}</div>
              <input value={form.note} onChange={e => setForm(f => ({ ...f, note: e.target.value }))} placeholder={t('es. solo mattina presto, flessibile su orari', 'e.g. early morning only, flexible on times')} style={inputCss} />
            </div>
          </div>
          <div style={{ flexShrink: 0, display: 'flex', gap: 8, padding: '14px 22px', borderTop: '1px solid var(--hair)' }}>
            <button className="dk-btn dk-btn--ghost" style={{ flex: 1 }} onClick={() => setNewOpen(false)}>{t('Annulla', 'Cancel')}</button>
            <button className="dk-btn dk-btn--clay" style={{ flex: 1 }} disabled={!form.clientId} onClick={addToList}><Icon name="check" size={16} color="#fff" />{t('Aggiungi', 'Add')}</button>
          </div>
        </div>
      )}
    </DkDrawer>
  );
}

Object.assign(window, { DkModals });
