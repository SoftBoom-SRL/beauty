// desktop-automazioni.jsx — master list + inline builder & WhatsApp preview
const { useState: useStateDau, useRef: useRefDau } = React;

const DK_CHANNELS = [
  { id: 'whatsapp', icon: 'whatsapp', label: 'WhatsApp', color: '#3F9D58' },
  { id: 'call', icon: 'phone', label: { it: 'Chiamata', en: 'Call' }, color: 'var(--info)' },
  { id: 'sms', icon: 'message', label: 'SMS', color: 'var(--op-lina)' },
];
const DK_SAMPLE = { '{nome}': 'Sofia', '{name}': 'Sofia', '{data}': 'gio 14 nov', '{date}': 'Thu 14 Nov', '{ora}': '15:30', '{time}': '15:30', '{servizio}': 'semipermanente', '{service}': 'gel polish', '{link}': 'theparlour.it/r' };
const dkRender = (s) => s.replace(/\{[^}]+\}/g, m => DK_SAMPLE[m] || m);

/* ---- catalogo eventi (cosa fa partire l'automazione) ---- */
const DK_EVENTS = [
  { id: 'new_client', icon: 'user', label: { it: 'Nuovo cliente iscritto', en: 'New client signed up' }, hint: { it: 'Alla prima registrazione del cliente', en: 'When a client first registers' } },
  { id: 'next_appt', icon: 'calendar', label: { it: 'Prossimo appuntamento', en: 'Upcoming appointment' }, hint: { it: 'In base a un appuntamento in agenda', en: 'Relative to a booked appointment' } },
  { id: 'visit_done', icon: 'check', label: { it: 'Visita completata', en: 'Visit completed' }, hint: { it: 'Quando una visita viene chiusa', en: 'When a visit is closed out' } },
  { id: 'birthday', icon: 'cake', label: { it: 'Compleanno cliente', en: 'Client birthday' }, hint: { it: 'Nella data di nascita del cliente', en: 'On the client’s date of birth' } },
  { id: 'inactive', icon: 'revive', label: { it: 'Cliente inattivo', en: 'Inactive client' }, hint: { it: 'Dopo un periodo senza visite', en: 'After a period with no visits' } },
  { id: 'slot_free', icon: 'gap', label: { it: 'Slot liberato', en: 'Slot freed up' }, hint: { it: 'Quando si libera un posto in agenda', en: 'When a calendar slot opens up' } },
];
const dkEvent = (id) => DK_EVENTS.find(e => e.id === id) || DK_EVENTS[0];

/* ---- campi e operatori per i filtri (condizioni SE) ---- */
const DK_FIELDS = [
  { id: 'services', type: 'num', unit: '', label: { it: 'Numero di servizi', en: 'Number of services' } },
  { id: 'spent', type: 'money', unit: '€', label: { it: 'Totale speso', en: 'Total spent' } },
  { id: 'lastDays', type: 'num', unit: { it: 'gg', en: 'd' }, label: { it: 'Giorni dall’ultima visita', en: 'Days since last visit' } },
  { id: 'vip', type: 'bool', label: { it: 'Cliente VIP', en: 'VIP client' } },
  { id: 'consent', type: 'bool', label: { it: 'Consenso marketing', en: 'Marketing consent' } },
];
const dkField = (id) => DK_FIELDS.find(f => f.id === id) || DK_FIELDS[0];
const DK_OPS_NUM = [['gt', '>'], ['gte', '≥'], ['lt', '<'], ['lte', '≤'], ['eq', '=']];

/* ---- filtri rapidi preimpostati (ex segmenti) ---- */
const DK_QUICK = [
  { id: 'new', label: { it: 'Nuovi', en: 'New' } },
  { id: 'consent', label: { it: 'Con consenso', en: 'With consent' } },
  { id: 'dormant', label: { it: 'Dormienti', en: 'Dormant' } },
  { id: 'all', label: { it: 'Tutti', en: 'All' } },
];

/* ---- seed per automazione: evento, offset, filtri, origine ---- */
let DK_CID = 0;
const dkConds = (arr) => arr.map(c => ({ id: 'c' + (++DK_CID), ...c }));
const DK_SEED = {
  au1: { event: 'new_client', dir: 'after', n: 5, unit: 'min', join: 'and', conds: dkConds([]), origin: 'yourang' },
  au2: { event: 'next_appt', dir: 'before', n: 24, unit: 'hour', join: 'and', conds: dkConds([{ field: 'consent', op: 'is', value: true }]), origin: 'yourang' },
  au3: { event: 'visit_done', dir: 'after', n: 3, unit: 'hour', join: 'and', conds: dkConds([{ field: 'consent', op: 'is', value: true }]), origin: 'yourang' },
  au4: { event: 'birthday', dir: 'after', n: 0, unit: 'day', join: 'and', conds: dkConds([{ field: 'consent', op: 'is', value: true }]), origin: 'yourang' },
  au5: { event: 'inactive', dir: 'after', n: 90, unit: 'day', join: 'and', conds: dkConds([{ field: 'lastDays', op: 'gte', value: 90 }]), origin: 'yourang' },
  au6: { event: 'slot_free', dir: 'after', n: 0, unit: 'min', join: 'or', conds: dkConds([{ field: 'consent', op: 'is', value: true }]), origin: 'webhook' },
};
const DK_UNITS = [
  { id: 'min', label: { it: 'minuti', en: 'minutes' }, one: { it: 'minuto', en: 'minute' } },
  { id: 'hour', label: { it: 'ore', en: 'hours' }, one: { it: 'ora', en: 'hour' } },
  { id: 'day', label: { it: 'giorni', en: 'days' }, one: { it: 'giorno', en: 'day' } },
];
const dkUnit = (id) => DK_UNITS.find(u => u.id === id) || DK_UNITS[0];
const dkOffsetPhrase = (dir, n, unit, lang) => {
  if (!n) return lang === 'en' ? 'Right away' : 'Subito';
  const u = dkUnit(unit);
  const ul = (n === 1 ? u.one : u.label)[lang];
  const d = dir === 'before' ? (lang === 'en' ? 'before' : 'prima') : (lang === 'en' ? 'after' : 'dopo');
  return lang === 'en' ? `${n} ${ul} ${d}` : `${n} ${ul} ${d}`;
};
const dkWebhookUrl = (id) => `https://hooks.yourang.app/v1/the-parlour/${id}`;

function DkAuto() {
  const { t, lang } = useDk();
  const [autos, setAutos] = useStateDau(AUTOMATIONS.map(a => ({ ...a, msgState: { it: a.msg.it, en: a.msg.en }, ...DK_SEED[a.id] })));
  const [sel, setSel] = useStateDau('au2');
  const active = autos.filter(a => a.on).length;
  const toggle = (id) => setAutos(l => l.map(a => a.id === id ? { ...a, on: !a.on } : a));
  const cur = autos.find(a => a.id === sel);
  return (
    <div style={{ display: 'flex', height: '100%', minHeight: 0 }}>
      {/* list */}
      <div style={{ width: 380, flexShrink: 0, borderRight: '1px solid var(--hair)', display: 'flex', flexDirection: 'column', background: 'var(--paper)' }}>
        <div style={{ padding: '18px 20px 14px', borderBottom: '1px solid var(--hair)' }}>
          <div className="t-meta" style={{ color: 'var(--clay-ink)' }}>{active} {t('attive', 'active')} · {autos.length} {t('disponibili', 'available')}</div>
          <div className="t-body" style={{ color: 'var(--muted)', marginTop: 4 }}>{t('Decidi quando partono e a chi. Canale e messaggio su Yourang.', 'Decide when they fire and to whom. Channel and message on Yourang.')}</div>
        </div>
        <div className="scroll" style={{ flex: 1, overflowY: 'auto', padding: 12 }}>
          {autos.map(a => {
            const on = a.id === sel; const ch = DK_CHANNELS.find(c => c.id === a.channel);
            return (
              <div key={a.id} className="dk-row" onClick={() => setSel(a.id)} style={{ padding: '13px 14px', borderRadius: 14, marginBottom: 4, background: on ? 'var(--surface)' : 'transparent', boxShadow: on ? 'var(--sh-sm)' : 'none', opacity: a.on ? 1 : 0.68 }}>
                <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                  <div style={{ width: 38, height: 38, borderRadius: 11, background: a.on ? 'var(--clay-tint)' : 'var(--paper-2)', display: 'grid', placeItems: 'center', flexShrink: 0 }}><Icon name={a.icon} size={19} color={a.on ? 'var(--clay-ink)' : 'var(--muted)'} /></div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 700, fontSize: 14.5 }}>{a.name[lang]}</div>
                    <div className="t-sm" style={{ color: 'var(--muted)', marginTop: 1 }}>{a.desc[lang]}</div>
                    {a.on && a.result[lang] !== '—' && <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 7, fontSize: 12, fontWeight: 600, color: 'var(--ok)' }}><Icon name="trend" size={13} color="var(--ok)" />{a.result[lang]}</div>}
                  </div>
                  <div onClick={e => { e.stopPropagation(); toggle(a.id); }}><Toggle on={a.on} onChange={() => toggle(a.id)} /></div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
      {/* builder */}
      <div className="scroll" style={{ flex: 1, overflowY: 'auto' }}>
        {cur && <DkBuilder a={cur} setAutos={setAutos} key={cur.id} />}
      </div>
    </div>
  );
}

function DkBuilder({ a, setAutos }) {
  const { t, lang, fireToast } = useDk();
  const set = (k, v) => setAutos(l => l.map(x => x.id === a.id ? { ...x, [k]: v } : x));
  const ch = DK_CHANNELS.find(c => c.id === a.channel) || DK_CHANNELS[0];
  const chLabel = typeof ch.label === 'string' ? ch.label : ch.label[lang];
  const msgPreview = dkRender((a.msgState && a.msgState[lang]) || a.msg[lang]);
  const ev = dkEvent(a.event);

  // condition helpers
  const setConds = (fn) => set('conds', fn(a.conds));
  const addCond = () => setConds(cs => [...cs, { id: 'c' + (++DK_CID), field: 'spent', op: 'gt', value: 100 }]);
  const updCond = (id, patch) => setConds(cs => cs.map(c => c.id === id ? { ...c, ...patch } : c));
  const rmCond = (id) => setConds(cs => cs.filter(c => c.id !== id));
  // quick-preset filters seed the condition list
  const applyQuick = (id) => {
    if (id === 'all') { setConds(() => []); return; }
    const map = {
      new: { field: 'services', op: 'lte', value: 1 },
      consent: { field: 'consent', op: 'is', value: true },
      dormant: { field: 'lastDays', op: 'gte', value: 60 },
    };
    setConds(() => [{ id: 'c' + (++DK_CID), ...map[id] }]);
  };

  return (
    <div style={{ padding: '24px 28px 40px', maxWidth: 780 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 22 }}>
        <div style={{ width: 48, height: 48, borderRadius: 14, background: 'var(--clay-tint)', display: 'grid', placeItems: 'center' }}><Icon name={a.icon} size={24} color="var(--clay-ink)" /></div>
        <div style={{ flex: 1 }}>
          <div style={{ fontFamily: 'var(--serif)', fontSize: 24, fontWeight: 500 }}>{a.name[lang]}</div>
          <div className="t-sm" style={{ color: 'var(--muted)' }}>{a.desc[lang]}</div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: a.on ? 'var(--ok)' : 'var(--muted)' }}>{a.on ? t('Attiva', 'Active') : t('In pausa', 'Paused')}</span>
          <Toggle on={a.on} onChange={v => set('on', v)} />
          <button className="dk-btn dk-btn--primary" onClick={() => fireToast({ msg: t('Automazione salvata', 'Automation saved'), icon: 'check' })}>{t('Salva', 'Save')}</button>
        </div>
      </div>

      {/* reporting metrics (unchanged) */}
      {a.on && a.result[lang] !== '—' && (
        <div style={{ display: 'flex', gap: 14, marginBottom: 22 }}>
          <MiniMetric label={t('Tasso di apertura', 'Open rate')} value={a.openRate + '%'} />
          <MiniMetric label={t('Ultimo invio', 'Last sent')} value={a.lastSent[lang]} />
          <MiniMetric label={t('Risultato', 'Result')} value={a.result[lang]} wide />
        </div>
      )}

      {/* TRIGGER — la regola si configura qui: evento + tempo + filtri */}
      <div className="t-meta" style={{ margin: '0 2px 10px', display: 'flex', alignItems: 'center', gap: 7 }}>
        <Icon name="bolt" size={14} color="var(--clay-ink)" />{t('Trigger · come si configura la regola', 'Trigger · how the rule is set up')}
      </div>

      {/* a) EVENTO */}
      <DkTrigStep n="a" title={t('Evento', 'Event')} hint={t('Cosa fa partire l’automazione', 'What sets the automation off')}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 11, flex: 1, minWidth: 0 }}>
            <div style={{ width: 40, height: 40, borderRadius: 11, background: 'var(--clay-tint)', display: 'grid', placeItems: 'center', flexShrink: 0 }}><Icon name={ev.icon} size={20} color="var(--clay-ink)" /></div>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 700, fontSize: 16 }}>{ev.label[lang]}</div>
              <div className="t-sm" style={{ color: 'var(--muted)' }}>{ev.hint[lang]}</div>
            </div>
          </div>
          <DkEventMenu value={a.event} onChange={v => set('event', v)} t={t} lang={lang} />
        </div>
      </DkTrigStep>

      {/* b) TEMPO / QUANDO */}
      <DkTrigStep n="b" title={t('Tempo · quando', 'Timing · when')} hint={t('Ritardo rispetto all’evento', 'Offset relative to the event')}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <DkSeg value={a.dir} onChange={v => set('dir', v)} options={[{ value: 'before', label: t('Prima', 'Before') }, { value: 'after', label: t('Dopo', 'After') }]} />
          <DkStepper value={a.n} onChange={v => set('n', v)} />
          <DkSeg value={a.unit} onChange={v => set('unit', v)} options={DK_UNITS.map(u => ({ value: u.id, label: u.label[lang] }))} />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 13, padding: '10px 13px', background: 'var(--clay-tint)', borderRadius: 11 }}>
          <Icon name="clock" size={15} color="var(--clay-ink)" />
          <span style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--clay-ink)' }}>{dkOffsetPhrase(a.dir, a.n, a.unit, lang)} · {ev.label[lang].toLowerCase()}</span>
        </div>
        <div style={{ marginTop: 16, paddingTop: 14, borderTop: '1px solid var(--hair)' }}>
          <div className="t-meta" style={{ marginBottom: 9, display: 'flex', alignItems: 'center', gap: 6 }}><Icon name="bell" size={13} color="var(--muted)" />{t('A che ora', 'Time of day')}</div>
          <DkSeg value={a.timing} onChange={v => set('timing', v)} options={[{ value: 'now', label: t('Subito', 'Right away') }, { value: '10', label: t('Orario fisso · 10:00', 'Fixed time · 10:00') }]} />
        </div>
      </DkTrigStep>

      {/* c) FILTRI */}
      <DkTrigStep n="c" title={t('Filtri · condizioni SE', 'Filters · IF conditions')} hint={t('Devono essere vere perché scatti per quel cliente', 'Must be true for it to fire for that client')} last>
        <div className="t-meta" style={{ marginBottom: 8 }}>{t('Filtri rapidi', 'Quick filters')}</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 18 }}>
          {DK_QUICK.map(q => {
            const on = a.conds.length === (q.id === 'all' ? 0 : 1) && (q.id === 'all' || a.conds[0].field === ({ new: 'services', consent: 'consent', dormant: 'lastDays' }[q.id]));
            return <button key={q.id} onClick={() => applyQuick(q.id)} style={{ padding: '8px 15px', borderRadius: 99, fontSize: 13.5, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap', border: '1px solid ' + (on ? 'var(--ink)' : 'var(--hair)'), background: on ? 'var(--ink)' : 'var(--surface)', color: on ? '#fff' : 'var(--ink-2)' }}>{q.label[lang]}</button>;
          })}
        </div>

        {a.conds.length === 0 ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '13px 15px', borderRadius: 11, border: '1px dashed var(--line-strong)', color: 'var(--muted)', fontSize: 13.5, fontWeight: 500, marginBottom: 12 }}>
            <Icon name="clients" size={16} color="var(--muted)" />{t('Nessun filtro — scatta per tutti i clienti coinvolti dall’evento.', 'No filter — fires for every client touched by the event.')}
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 0, marginBottom: 12 }}>
            {a.conds.map((c, i) => (
              <React.Fragment key={c.id}>
                {i > 0 && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '8px 0' }}>
                    <div className="dk-seg" style={{ padding: 3 }}>
                      {[['and', t('E', 'AND')], ['or', t('O', 'OR')]].map(([k, l]) => (
                        <button key={k} className={a.join === k ? 'on' : ''} style={{ height: 28, padding: '0 13px', fontSize: 12 }} onClick={() => set('join', k)}>{l}</button>
                      ))}
                    </div>
                    <div style={{ flex: 1, height: 1, background: 'var(--hair)' }} />
                  </div>
                )}
                <DkCondRow c={c} onChange={p => updCond(c.id, p)} onRemove={() => rmCond(c.id)} t={t} lang={lang} />
              </React.Fragment>
            ))}
          </div>
        )}

        <button className="dk-btn dk-btn--soft" style={{ height: 38, fontSize: 13.5 }} onClick={addCond}><Icon name="plus" size={16} />{t('Aggiungi condizione', 'Add condition')}</button>
      </DkTrigStep>

      {/* OPERATIVITÀ · YOURANG — origine trigger + canale/messaggio in sola lettura */}
      <div className="t-meta" style={{ margin: '26px 2px 10px' }}>{t('Operatività', 'Operations')}</div>
      <div className="dk-card" style={{ padding: 20, background: 'var(--surface-2)', border: '1px solid var(--hair)', boxShadow: 'none' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 18 }}>
          <div style={{ width: 38, height: 38, borderRadius: 11, background: 'var(--ink)', display: 'grid', placeItems: 'center', flexShrink: 0 }}><Icon name="bolt" size={19} color="var(--clay-tint)" /></div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontWeight: 700, fontSize: 15.5 }}>{t('Operatività · Yourang', 'Operations · Yourang')}</span>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10.5, fontWeight: 700, color: 'var(--muted)', background: 'var(--paper-2)', padding: '2px 8px', borderRadius: 99 }}><Icon name="lock" size={11} color="var(--muted)" />{t('Sola lettura', 'Read-only')}</span>
            </div>
            <div className="t-sm" style={{ color: 'var(--muted)', marginTop: 3 }}>{t('L’esecuzione (canale, invio, dinamiche) è gestita da Yourang. Qui sono sincronizzati.', 'Execution (channel, send, dynamics) is handled by Yourang. Synced here.')}</div>
          </div>
          <button className="dk-btn dk-btn--primary" style={{ height: 40, flexShrink: 0 }} onClick={() => fireToast({ msg: t('Apertura di Yourang per canale e messaggio…', 'Opening Yourang for channel and message…'), icon: 'ext' })}><Icon name="ext" size={16} color="#fff" />{t('Apri su Yourang', 'Open in Yourang')}</button>
        </div>

        {/* ORIGINE TRIGGER — in evidenza */}
        <div className="dk-card" style={{ padding: 16, boxShadow: 'none', border: '1px solid var(--hair)', background: 'var(--surface)', marginBottom: 14 }}>
          <div className="t-meta" style={{ marginBottom: 11, display: 'flex', alignItems: 'center', gap: 6 }}><Icon name="bolt" size={13} color="var(--clay-ink)" />{t('Origine trigger', 'Trigger source')}</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            {[
              { id: 'yourang', icon: 'bolt', title: 'Yourang', desc: t('Da un’azione interna a Yourang', 'From an action inside Yourang') },
              { id: 'webhook', icon: 'ext', title: 'Webhook', desc: t('Da un sistema esterno', 'From an external system') },
            ].map(o => {
              const on = a.origin === o.id;
              return (
                <button key={o.id} onClick={() => set('origin', o.id)} style={{ textAlign: 'left', padding: '13px 14px', borderRadius: 12, cursor: 'pointer', border: '1.5px solid ' + (on ? 'var(--clay)' : 'var(--hair)'), background: on ? 'var(--clay-tint)' : 'var(--surface)', display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                  <div style={{ width: 20, height: 20, borderRadius: 99, flexShrink: 0, marginTop: 1, border: '1.5px solid ' + (on ? 'var(--clay)' : 'var(--line-strong)'), background: on ? 'var(--clay)' : 'transparent', display: 'grid', placeItems: 'center' }}>{on && <Icon name="check" size={13} color="#fff" stroke={2.6} />}</div>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 700, fontSize: 14.5, color: on ? 'var(--clay-ink)' : 'var(--ink)' }}>{o.title}</div>
                    <div className="t-sm" style={{ color: 'var(--muted)', marginTop: 1 }}>{o.desc}</div>
                  </div>
                </button>
              );
            })}
          </div>
          {a.origin === 'webhook' && (
            <div style={{ marginTop: 14 }}>
              <div className="t-meta" style={{ marginBottom: 7 }}>{t('Endpoint del webhook', 'Webhook endpoint')}</div>
              <DkCopyField value={dkWebhookUrl(a.id)} onCopy={() => fireToast({ msg: t('URL copiato', 'URL copied'), icon: 'check' })} t={t} />
              <div className="t-sm" style={{ color: 'var(--muted-2)', marginTop: 8, display: 'flex', alignItems: 'center', gap: 5 }}><Icon name="lock" size={12} color="var(--muted-2)" />{t('Chiama questo URL dal tuo sistema per innescare l’automazione.', 'Call this URL from your system to fire the automation.')}</div>
            </div>
          )}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '180px 1fr', gap: 14 }}>
          {/* active channel */}
          <div className="dk-card" style={{ padding: 14, boxShadow: 'none', border: '1px solid var(--hair)', background: 'var(--surface)' }}>
            <div className="t-meta" style={{ marginBottom: 10 }}>{t('Canale attivo', 'Active channel')}</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
              <div style={{ width: 32, height: 32, borderRadius: 9, background: 'color-mix(in srgb, ' + ch.color + ' 14%, transparent)', display: 'grid', placeItems: 'center' }}><Icon name={ch.icon} size={17} color={ch.color} /></div>
              <span style={{ fontWeight: 700, fontSize: 14.5 }}>{chLabel}</span>
            </div>
            <div className="t-sm" style={{ color: 'var(--muted-2)', marginTop: 10, display: 'flex', alignItems: 'center', gap: 5 }}><Icon name="refresh" size={12} color="var(--muted-2)" />{t('Sincronizzato', 'Synced')}</div>
          </div>
          {/* synthetic message preview */}
          <div className="dk-card" style={{ padding: 14, boxShadow: 'none', border: '1px solid var(--hair)', background: 'var(--surface)' }}>
            <div className="t-meta" style={{ marginBottom: 10 }}>{t('Anteprima messaggio', 'Message preview')}</div>
            <div style={{ display: 'flex', gap: 9 }}>
              <div style={{ width: 26, height: 26, borderRadius: 99, background: 'var(--brand, #7C4A57)', display: 'grid', placeItems: 'center', color: '#fff', fontWeight: 800, fontSize: 12, flexShrink: 0 }}>P</div>
              <div style={{ flex: 1, minWidth: 0, background: 'var(--paper-2)', borderRadius: '4px 12px 12px 12px', padding: '8px 11px', fontSize: 13, lineHeight: 1.45, color: 'var(--ink-2)', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{msgPreview}</div>
            </div>
            <div className="t-sm" style={{ color: 'var(--muted-2)', marginTop: 10 }}>{t('Testo e variabili si modificano su Yourang', 'Text and variables are edited on Yourang')}</div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---- trigger sub-step shell (labelled a / b / c) ---- */
function DkTrigStep({ n, title, hint, children, last }) {
  return (
    <div className="dk-card" style={{ padding: '16px 20px 18px', marginBottom: last ? 0 : 12 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 14 }}>
        <div style={{ width: 26, height: 26, borderRadius: 8, background: 'var(--ink)', color: '#fff', display: 'grid', placeItems: 'center', fontWeight: 700, fontSize: 13, flexShrink: 0, fontFamily: 'var(--serif)' }}>{n}</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 15 }}>{title}</div>
          <div className="t-sm" style={{ color: 'var(--muted)', marginTop: 1 }}>{hint}</div>
        </div>
      </div>
      <div style={{ paddingLeft: 38 }}>{children}</div>
    </div>
  );
}

/* ---- event selector dropdown ---- */
function DkEventMenu({ value, onChange, t, lang }) {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef(null);
  React.useEffect(() => {
    if (!open) return;
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);
  return (
    <div ref={ref} style={{ position: 'relative', flexShrink: 0 }}>
      <button className="dk-btn dk-btn--soft" style={{ height: 38, fontSize: 13.5 }} onClick={() => setOpen(o => !o)}><Icon name="edit" size={15} />{t('Cambia', 'Change')}</button>
      {open && (
        <div className="dk-card" style={{ position: 'absolute', top: 'calc(100% + 6px)', right: 0, width: 280, padding: 6, zIndex: 30, boxShadow: 'var(--sh-pop)' }}>
          {DK_EVENTS.map(e => {
            const on = e.id === value;
            return (
              <button key={e.id} className="dk-row" onClick={() => { onChange(e.id); setOpen(false); }} style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '9px 10px', borderRadius: 9, textAlign: 'left' }}>
                <div style={{ width: 30, height: 30, borderRadius: 9, background: on ? 'var(--clay-tint)' : 'var(--surface-2)', display: 'grid', placeItems: 'center', flexShrink: 0 }}><Icon name={e.icon} size={16} color={on ? 'var(--clay-ink)' : 'var(--muted)'} /></div>
                <span style={{ flex: 1, fontWeight: on ? 700 : 600, fontSize: 13.5, color: on ? 'var(--ink)' : 'var(--ink-2)' }}>{e.label[lang]}</span>
                {on && <Icon name="check" size={15} color="var(--clay-ink)" stroke={2.4} />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ---- number stepper for the offset ---- */
function DkStepper({ value, onChange }) {
  const dec = () => onChange(Math.max(0, value - 1));
  const inc = () => onChange(value + 1);
  const btn = { width: 34, height: 40, display: 'grid', placeItems: 'center', cursor: 'pointer', color: 'var(--ink)', background: 'transparent' };
  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', border: '1px solid var(--hair)', borderRadius: 10, background: 'var(--surface)', overflow: 'hidden' }}>
      <button style={btn} onClick={dec} aria-label="−"><span style={{ fontSize: 19, fontWeight: 600, lineHeight: 1 }}>−</span></button>
      <input type="number" value={value} onChange={e => onChange(Math.max(0, parseInt(e.target.value) || 0))} style={{ width: 44, textAlign: 'center', border: 'none', borderLeft: '1px solid var(--hair)', borderRight: '1px solid var(--hair)', outline: 'none', background: 'transparent', fontSize: 15, fontWeight: 700, height: 40, fontVariantNumeric: 'tabular-nums' }} />
      <button style={btn} onClick={inc} aria-label="+"><span style={{ fontSize: 18, fontWeight: 600, lineHeight: 1 }}>+</span></button>
    </div>
  );
}

/* ---- one SE condition row ---- */
function DkCondRow({ c, onChange, onRemove, t, lang, fields }) {
  const FIELDS = fields || DK_FIELDS;
  const f = FIELDS.find(x => x.id === c.field) || FIELDS[0];
  const unitTxt = typeof f.unit === 'object' ? f.unit[lang] : f.unit;
  const onField = (fid) => {
    const nf = FIELDS.find(x => x.id === fid) || FIELDS[0];
    if (nf.type === 'bool') onChange({ field: fid, op: 'is', value: true });
    else if (nf.type === 'enum') onChange({ field: fid, op: 'is', value: nf.options[0].value });
    else onChange({ field: fid, op: nf.defaultOp || 'gt', value: nf.type === 'money' ? 100 : (nf.defaultValue != null ? nf.defaultValue : 1) });
  };
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap', padding: '11px 13px', borderRadius: 12, background: 'var(--surface-2)', border: '1px solid var(--hair)' }}>
      <span style={{ fontWeight: 800, fontSize: 11.5, letterSpacing: '0.08em', color: 'var(--clay-ink)', background: 'var(--clay-tint)', padding: '3px 8px', borderRadius: 6 }}>{t('SE', 'IF')}</span>
      <DkDrop value={c.field} onChange={onField} options={FIELDS.map(x => ({ value: x.id, label: x.label[lang] }))} />
      {f.type === 'bool' ? (
        <React.Fragment>
          <span style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--muted)' }}>{t('è', 'is')}</span>
          <DkSeg value={c.value ? 'y' : 'n'} onChange={v => onChange({ value: v === 'y' })} options={[{ value: 'y', label: t('Sì', 'Yes') }, { value: 'n', label: 'No' }]} style={{ padding: 3 }} />
        </React.Fragment>
      ) : f.type === 'enum' ? (
        <React.Fragment>
          <span style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--muted)' }}>{t('è', 'is')}</span>
          <DkDrop value={c.value} onChange={v => onChange({ value: v })} options={f.options} />
        </React.Fragment>
      ) : (
        <React.Fragment>
          <DkDrop value={c.op} onChange={v => onChange({ op: v })} options={DK_OPS_NUM.map(([k, s]) => ({ value: k, label: s }))} narrow />
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 5, border: '1px solid var(--hair)', borderRadius: 9, padding: '0 10px', height: 36, background: 'var(--surface)' }}>
            {f.type === 'money' && <span className="t-sm" style={{ color: 'var(--muted-2)', fontWeight: 700 }}>€</span>}
            <input type="number" value={c.value} onChange={e => onChange({ value: Math.max(0, parseInt(e.target.value) || 0) })} style={{ width: 52, border: 'none', outline: 'none', background: 'transparent', fontSize: 14.5, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }} />
            {unitTxt && f.type !== 'money' && <span className="t-sm" style={{ color: 'var(--muted-2)', fontWeight: 700 }}>{unitTxt}</span>}
          </div>
        </React.Fragment>
      )}
      <div style={{ flex: 1 }} />
      <button className="dk-iconbtn" onClick={onRemove} aria-label="remove" style={{ width: 32, height: 32, display: 'grid', placeItems: 'center', borderRadius: 9, cursor: 'pointer', color: 'var(--muted)' }}><Icon name="x" size={16} /></button>
    </div>
  );
}

/* ---- small generic dropdown (field / operator pickers) ---- */
function DkDrop({ value, onChange, options, narrow }) {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef(null);
  React.useEffect(() => {
    if (!open) return;
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);
  const cur = options.find(o => o.value === value) || options[0];
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button onClick={() => setOpen(o => !o)} style={{ display: 'inline-flex', alignItems: 'center', gap: 7, height: 36, padding: narrow ? '0 10px' : '0 12px', minWidth: narrow ? 0 : 0, border: '1px solid var(--hair)', borderRadius: 9, background: 'var(--surface)', cursor: 'pointer', fontSize: narrow ? 16 : 13.5, fontWeight: 700, color: 'var(--ink)' }}>
        {cur.label}<Icon name="chevD" size={13} color="var(--muted)" />
      </button>
      {open && (
        <div className="dk-card" style={{ position: 'absolute', top: 'calc(100% + 5px)', left: 0, minWidth: narrow ? 64 : 200, padding: 5, zIndex: 30, boxShadow: 'var(--sh-pop)' }}>
          {options.map(o => {
            const on = o.value === value;
            return (
              <button key={o.value} className="dk-row" onClick={() => { onChange(o.value); setOpen(false); }} style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '8px 9px', borderRadius: 8, textAlign: 'left' }}>
                <span style={{ flex: 1, fontWeight: on ? 700 : 600, fontSize: narrow ? 15 : 13.5, color: on ? 'var(--ink)' : 'var(--ink-2)' }}>{o.label}</span>
                {on && <Icon name="check" size={14} color="var(--clay-ink)" stroke={2.4} />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ---- read-only field with copy button (webhook url) ---- */
function DkCopyField({ value, onCopy, t }) {
  const copy = () => {
    try { navigator.clipboard && navigator.clipboard.writeText(value); } catch (e) {}
    onCopy && onCopy();
  };
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, border: '1px solid var(--hair)', borderRadius: 10, padding: '0 6px 0 12px', height: 42, background: 'var(--surface-2)' }}>
      <span style={{ flex: 1, minWidth: 0, fontFamily: 'ui-monospace, monospace', fontSize: 12.5, fontWeight: 600, color: 'var(--ink-2)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{value}</span>
      <button onClick={copy} className="dk-btn dk-btn--soft" style={{ height: 32, padding: '0 12px', fontSize: 12.5, flexShrink: 0 }} title={t('Copia', 'Copy')}><Icon name="tag" size={14} />{t('Copia', 'Copy')}</button>
    </div>
  );
}

function DkKnob({ icon, label, children }) {
  return (
    <div style={{ display: 'flex', gap: 14, padding: '16px 0', borderBottom: '1px solid var(--hair)' }}>
      <div style={{ width: 36, height: 36, borderRadius: 10, background: 'var(--surface-2)', display: 'grid', placeItems: 'center', flexShrink: 0 }}><Icon name={icon} size={18} /></div>
      <div style={{ flex: 1, minWidth: 0 }}><div className="t-meta" style={{ marginBottom: 9 }}>{label}</div>{children}</div>
    </div>
  );
}
function MiniMetric({ label, value, wide, onClick, active }) {
  return <button disabled={!onClick} onClick={onClick} className="dk-card" style={{ padding: '12px 16px', boxShadow: 'none', border: '1.5px solid ' + (active ? 'var(--clay)' : 'var(--hair)'), flex: wide ? 2 : 1, textAlign: 'left', cursor: onClick ? 'pointer' : 'default', background: active ? 'var(--clay-tint)' : undefined }}><div className="t-meta" style={{ marginBottom: 4, color: active ? 'var(--clay-ink)' : undefined }}>{label}</div><div className="t-num" style={{ fontSize: 22, color: active ? 'var(--clay-ink)' : undefined }}>{value}</div></button>;
}

Object.assign(window, { DkAuto, MiniMetric, DkCondRow, DkDrop });
