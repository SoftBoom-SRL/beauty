// desktop-comunicazioni.jsx — content-led campaigns (no discounts): launches, seasonal, storytelling
const { useState: useStateCom, useRef: useRefCom } = React;

const COM_TYPES = {
  launch:  { it: 'Lancio servizio', en: 'Service launch', icon: 'sparkle', color: '#9B86E0', tint: 'rgba(155,134,224,0.16)',
    hint: { it: 'Presenta un nuovo trattamento o servizio. Tono: novità, esclusività.', en: 'Introduce a new treatment or service. Tone: novelty, exclusivity.' },
    cta: { it: 'Prenota ora', en: 'Book now' } },
  seasonal:{ it: 'Stagionale',      en: 'Seasonal',       icon: 'calendar', color: '#6FB89A', tint: 'rgba(111,184,154,0.16)',
    hint: { it: 'Comunicazione legata alla stagione o a una ricorrenza. Tono: caldo, attuale.', en: 'Season- or occasion-led note. Tone: warm, timely.' },
    cta: { it: 'Scopri', en: 'Discover' } },
  story:   { it: 'Storytelling',    en: 'Storytelling',   icon: 'star',     color: '#E0A85A', tint: 'rgba(224,168,90,0.16)',
    hint: { it: 'Racconto del brand, della filosofia o del dietro le quinte. Tono: editoriale, lento.', en: 'Brand, philosophy or behind-the-scenes story. Tone: editorial, slow.' },
    cta: { it: '', en: '' } },
  announce:{ it: 'Annuncio',        en: 'Announcement',   icon: 'bell',     color: '#5FAEC9', tint: 'rgba(95,174,201,0.16)',
    hint: { it: 'Informazione di servizio: orari, chiusure, novità organizzative. Tono: chiaro, breve.', en: 'Service notice: hours, closures, organisational news. Tone: clear, brief.' },
    cta: { it: '', en: '' } },
};
const COM_STATUS = {
  draft:     { it: 'Bozza',         en: 'Draft',     color: 'var(--muted)',   tint: 'var(--surface-2)' },
  scheduled: { it: 'Programmata',   en: 'Scheduled', color: 'var(--info)',    tint: 'var(--surface-2)' },
  sent:      { it: 'Inviata',       en: 'Sent',      color: 'var(--ok)',      tint: 'var(--ok-tint)' },
};
const COM_SEED = [
  { id: 'cm1', type: 'launch', title: { it: 'Nuovo rituale viso "Lumière"', en: 'New "Lumière" facial ritual' }, body: { it: 'Vi presentiamo Lumière — un trattamento illuminante in cinque fasi, disponibile da questo mese su prenotazione.', en: 'Introducing Lumière — a five-step illuminating treatment, bookable from this month.' }, audTags: ['vip'], audClients: [], cta: { it: 'Prenota ora', en: 'Book now' }, status: 'scheduled', when: '2026-07-01T10:00', img: null, sent: 0, read: 0 },
  { id: 'cm2', type: 'seasonal', title: { it: 'Estate al Parlour', en: 'Summer at The Parlour' }, body: { it: 'Colori e cure pensati per la stagione. Passa a trovarci per scoprire le novità estive.', en: 'Colours and care designed for the season. Drop by to discover our summer edit.' }, audTags: [], audClients: [], cta: { it: '', en: '' }, status: 'sent', when: '2026-06-10T09:30', img: null, sent: 412, read: 318 },
  { id: 'cm3', type: 'story', title: { it: 'La nostra filosofia del gesto lento', en: 'Our philosophy of the slow gesture' }, body: { it: 'Ogni trattamento è un momento sospeso. Vi raccontiamo come nasce il nostro approccio.', en: 'Every treatment is a suspended moment. The story behind our approach.' }, audTags: [], audClients: [], cta: { it: 'Scopri', en: 'Discover' }, status: 'draft', when: '', img: null, sent: 0, read: 0 },
];
function comWhenLabel(iso, lang) {
  if (!iso) return '';
  const d = new Date(iso);
  const mon = lang === 'en' ? ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'] : ['gen','feb','mar','apr','mag','giu','lug','ago','set','ott','nov','dic'];
  return `${d.getDate()} ${mon[d.getMonth()]} ${d.getFullYear()} · ${iso.slice(11, 16)}`;
}

function DkComunicazioni() {
  const { t, lang, fireToast, clientCats } = useDk();
  const [items, setItems] = useStateCom(() => COM_SEED.map(c => ({ ...c })));
  const [q, setQ] = useStateCom('');
  const [typeF, setTypeF] = useStateCom('all');
  const [statusF, setStatusF] = useStateCom('all');
  const [edit, setEdit] = useStateCom(null);
  const seq = useRefCom(700);

  const list = items.filter(c => {
    const okS = statusF === 'all' || c.status === statusF;
    const okQ = !q || c.title[lang].toLowerCase().includes(q.toLowerCase()) || c.body[lang].toLowerCase().includes(q.toLowerCase());
    return okS && okQ;
  });
  const blank = () => ({ id: 'cm' + (seq.current++), type: 'launch', title: { it: '', en: '' }, body: { it: '', en: '' }, audTags: [], audClients: [], cta: { it: 'Prenota ora', en: 'Book now' }, status: 'draft', when: '', img: null, sent: 0, read: 0, _new: true });
  const save = (d) => { const { _new, ...rest } = d; setItems(l => _new ? [rest, ...l] : l.map(c => c.id === d.id ? rest : c)); setEdit(null); fireToast({ msg: t('Comunicazione salvata', 'Communication saved'), icon: 'check' }); };
  const del = (id) => { setItems(l => l.filter(c => c.id !== id)); setEdit(null); fireToast({ msg: t('Comunicazione eliminata', 'Communication deleted'), icon: 'x' }); };
  const audienceLabel = (c) => {
    if (!(c.audTags || []).length && !(c.audClients || []).length) return t('Tutte le clienti', 'All clients');
    const tags = (c.audTags || []).map(tid => { const cat = clientCats.find(x => x.id === tid); return cat ? (cat.name[lang] || cat.name.it) : null; }).filter(Boolean);
    const n = (c.audClients || []).length;
    return [...tags, n ? n + ' ' + t('clienti', 'clients') : null].filter(Boolean).join(' · ');
  };

  return (
    <div className="dk-page" style={{ maxWidth: 1180 }}>
      <div className="t-sm" style={{ color: 'var(--muted)', marginBottom: 16, maxWidth: 720 }}>{t('Campagne editoriali senza sconto: lancio di nuovi servizi, comunicazioni stagionali, storytelling del brand. Pensate per un posizionamento premium, dove il messaggio conta più della promozione.', 'Discount-free editorial campaigns: service launches, seasonal notes, brand storytelling. Built for a premium positioning, where the message matters more than the promotion.')}</div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 18 }}>
        <div className="dk-search" style={{ flex: 1, minWidth: 0, width: 'auto' }}>
          <Icon name="search" size={18} color="var(--muted-2)" />
          <input value={q} onChange={e => setQ(e.target.value)} placeholder={t('Cerca una comunicazione…', 'Search a communication…')} />
          {q && <button onClick={() => setQ('')} style={{ cursor: 'pointer', display: 'grid', placeItems: 'center' }}><Icon name="x" size={15} color="var(--muted-2)" /></button>}
        </div>
        <GroupedFilterMenu t={t} groups={[
          { label: t('Stato', 'Status'), value: statusF, set: setStatusF, opts: [['all', t('Tutti', 'All')], ...Object.entries(COM_STATUS).map(([k, m]) => [k, m[lang]])] },
        ]} />
        <button className="dk-btn dk-btn--clay" onClick={() => setEdit(blank())} style={{ flexShrink: 0 }}><Icon name="plus" size={17} color="#fff" />{t('Nuova comunicazione', 'New communication')}</button>
      </div>

      {list.length ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: 16 }}>
          {list.map(c => { const ty = COM_TYPES[c.type] || COM_TYPES.launch; const st = COM_STATUS[c.status]; return (
            <div key={c.id} className="dk-card dk-hovercard" onClick={() => setEdit({ ...c, title: { ...c.title }, body: { ...c.body }, audTags: [...(c.audTags || [])], audClients: [...(c.audClients || [])] })} style={{ padding: 0, overflow: 'hidden', borderLeft: '3px solid ' + ty.color }}>
              {/* cover */}
              <div style={{ height: 96, background: c.img ? `center/cover url(${c.img})` : ty.tint, display: 'flex', alignItems: 'flex-start', justifyContent: 'flex-end', padding: 14 }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: st.color, background: 'var(--surface)', padding: '4px 10px', borderRadius: 99 }}>{st[lang]}</span>
              </div>
              <div style={{ padding: 16 }}>
                <div style={{ fontWeight: 700, fontSize: 15.5, lineHeight: 1.25 }}>{c.title[lang] || t('(senza titolo)', '(untitled)')}</div>
                <div className="t-sm" style={{ color: 'var(--muted)', marginTop: 6, lineHeight: 1.45, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{c.body[lang]}</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--hair)', flexWrap: 'wrap' }}>
                  <span className="t-sm" style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: 'var(--muted)' }}><Icon name="clients" size={13} color="var(--muted-2)" />{audienceLabel(c)}</span>
                  {c.status === 'scheduled' && c.when && <span className="t-sm" style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: 'var(--info)', fontWeight: 600 }}><Icon name="clock" size={13} color="var(--info)" />{comWhenLabel(c.when, lang)}</span>}
                  {c.status === 'sent' && <span className="t-sm" style={{ marginLeft: 'auto', color: 'var(--muted-2)' }}>{c.read}/{c.sent} {t('letti', 'read')}</span>}
                </div>
              </div>
            </div>
          ); })}
        </div>
      ) : (
        <div className="dk-card" style={{ overflow: 'hidden' }}><div style={{ padding: '48px 22px' }}><EmptyState icon="message" title={t('Nessuna comunicazione', 'No communications')} sub={t('Crea la prima campagna editoriale del salone.', 'Create the salon’s first editorial campaign.')} /></div></div>
      )}

      {edit && <ComEditModal draft={edit} setDraft={setEdit} onSave={save} onDelete={del} onClose={() => setEdit(null)} t={t} lang={lang} fireToast={fireToast} clientCats={clientCats} />}
    </div>
  );
}

function ComEditModal({ draft, setDraft, onSave, onDelete, onClose, t, lang, fireToast, clientCats }) {
  const [cq, setCq] = useStateCom('');
  const set = (patch) => setDraft(d => ({ ...d, ...patch }));
  const setL = (field, v) => setDraft(d => ({ ...d, [field]: { ...d[field], [lang]: v } }));
  const inputCss = { border: '1px solid var(--hair)', borderRadius: 9, outline: 'none', fontSize: 14, padding: '10px 12px', fontFamily: 'var(--sans)', background: 'var(--surface)', width: '100%', boxSizing: 'border-box' };
  const ty = COM_TYPES[draft.type] || COM_TYPES.launch;
  const onImg = (e) => { const f = e.target.files && e.target.files[0]; if (f) { const r = new FileReader(); r.onload = ev => set({ img: ev.target.result }); r.readAsDataURL(f); } };
  const aud = (!(draft.audTags || []).length && !(draft.audClients || []).length) ? t('Tutte le clienti', 'All clients') : ([...(draft.audTags || []).map(tid => { const c = clientCats.find(x => x.id === tid); return c ? (c.name[lang] || c.name.it) : null; }).filter(Boolean), (draft.audClients || []).length ? (draft.audClients.length + ' ' + t('clienti', 'clients')) : null].filter(Boolean).join(' · '));
  const canSave = (draft.title[lang] || '').trim() && (draft.body[lang] || '').trim();

  return (
    <DkModal open onClose={onClose} title={draft._new ? t('Nuova comunicazione', 'New communication') : t('Modifica comunicazione', 'Edit communication')} width={860}
      foot={<React.Fragment>
        {!draft._new && <button className="dk-btn dk-btn--ghost" style={{ marginRight: 'auto', color: 'var(--danger)' }} onClick={() => onDelete(draft.id)}><Icon name="x" size={16} color="var(--danger)" />{t('Elimina', 'Delete')}</button>}
        <button className="dk-btn dk-btn--ghost" onClick={onClose}>{t('Annulla', 'Cancel')}</button>
        <button className="dk-btn dk-btn--clay" disabled={!canSave} onClick={() => onSave(draft)}><Icon name="check" size={17} color="#fff" />{t('Salva', 'Save')}</button>
      </React.Fragment>}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 300px', gap: 22, alignItems: 'start' }}>
        {/* LEFT — editor */}
        <div>
          <div className="t-meta" style={{ marginBottom: 6 }}>{t('Titolo', 'Title')}</div>
          <input value={draft.title[lang] || ''} onChange={e => setL('title', e.target.value)} placeholder={t('es. Nuovo rituale viso "Lumière"', 'e.g. New "Lumière" facial ritual')} style={{ ...inputCss, marginBottom: 14 }} />

          <div className="t-meta" style={{ marginBottom: 6 }}>{t('Messaggio', 'Message')}</div>
          <textarea value={draft.body[lang] || ''} onChange={e => setL('body', e.target.value)} rows={5} placeholder={t('Racconta la novità con il tono del salone…', 'Tell the story in the salon’s voice…')} style={{ ...inputCss, resize: 'vertical', marginBottom: 14 }} />

          {/* image */}
          <div className="t-meta" style={{ marginBottom: 6 }}>{t('Immagine di copertina', 'Cover image')}</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 18 }}>
            <div style={{ width: 92, height: 60, borderRadius: 10, background: draft.img ? `center/cover url(${draft.img})` : ty.tint, flexShrink: 0, border: '1px solid var(--hair)', display: 'grid', placeItems: 'center' }}>{!draft.img && <Icon name={ty.icon} size={20} color={ty.color} />}</div>
            <label className="dk-btn dk-btn--ghost" style={{ cursor: 'pointer' }}><Icon name="arrowUp" size={15} />{draft.img ? t('Cambia', 'Change') : t('Carica immagine', 'Upload image')}<input type="file" accept="image/*" onChange={onImg} style={{ display: 'none' }} /></label>
            {draft.img && <button className="t-sm" onClick={() => set({ img: null })} style={{ cursor: 'pointer', color: 'var(--clay-ink)', fontWeight: 700, background: 'transparent' }}>{t('Rimuovi', 'Remove')}</button>}
          </div>

          {/* CTA — optional, always free-text */}
          {(() => { const hasCta = !!(draft.cta && (draft.cta.it || draft.cta.en)); return (
          <React.Fragment>
          <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 8 }}>
            <div className="t-meta" style={{ flex: 1 }}>{t('Pulsante azione', 'Action button')}</div>
            <button onClick={() => set({ cta: hasCta ? { it: '', en: '' } : { it: 'Prenota ora', en: 'Book now' } })} style={{ position: 'relative', width: 38, height: 22, borderRadius: 99, cursor: 'pointer', border: 'none', background: hasCta ? 'var(--clay)' : 'var(--hair)', transition: 'background 140ms' }}><span style={{ position: 'absolute', top: 2, left: hasCta ? 18 : 2, width: 18, height: 18, borderRadius: 99, background: '#fff', transition: 'left 140ms' }} /></button>
          </div>
          {hasCta
            ? <input value={draft.cta[lang] || ''} onChange={e => setL('cta', e.target.value)} placeholder={t('es. Prenota ora, Scopri, Chiamaci', 'e.g. Book now, Discover, Call us')} style={{ ...inputCss, marginBottom: 18 }} />
            : <div className="t-sm" style={{ color: 'var(--muted-2)', marginBottom: 18 }}>{t('Nessun pulsante — solo testo.', 'No button — text only.')}</div>}
          </React.Fragment>
          ); })()}

          {/* audience — reuses tag + client picker */}
          <div style={{ padding: '14px 16px', background: 'var(--surface-2)', borderRadius: 12 }}>
            <div className="t-meta" style={{ marginBottom: 3 }}>{t('Pubblico', 'Audience')}</div>
            <div className="t-sm" style={{ color: 'var(--muted)', marginBottom: 11 }}>{t('Per etichetta o per nome. Nessuna selezione = tutte le clienti.', 'By tag or by name. No selection = all clients.')}</div>
            <div className="t-sm" style={{ fontWeight: 700, color: 'var(--muted)', marginBottom: 6 }}>{t('Per etichetta', 'By tag')}</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7, marginBottom: 13 }}>
              {clientCats.map(cat => { const on = (draft.audTags || []).includes(cat.id); return (
                <button key={cat.id} onClick={() => set({ audTags: on ? draft.audTags.filter(x => x !== cat.id) : [...(draft.audTags || []), cat.id] })} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 11px', borderRadius: 99, fontSize: 12.5, fontWeight: 700, cursor: 'pointer', border: '1px solid ' + (on ? 'var(--clay)' : 'var(--hair)'), background: on ? 'var(--clay-tint)' : 'var(--surface)', color: on ? 'var(--clay-ink)' : 'var(--ink-2)' }}>
                  <span style={{ width: 8, height: 8, borderRadius: 99, background: cat.color }} />{cat.name[lang]}{on && <Icon name="check" size={12} color="var(--clay-ink)" />}
                </button>); })}
            </div>
            <div className="t-sm" style={{ fontWeight: 700, color: 'var(--muted)', marginBottom: 6 }}>{t('Per nome', 'By name')}</div>
            <div className="dk-search" style={{ width: '100%', height: 36, marginBottom: 8 }}>
              <Icon name="search" size={15} color="var(--muted-2)" />
              <input value={cq} onChange={e => setCq(e.target.value)} placeholder={t('Cerca cliente…', 'Search client…')} />
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7 }}>
              {CLIENTS.filter(c => !cq || c.name.toLowerCase().includes(cq.toLowerCase())).slice(0, 12).map(c => { const on = (draft.audClients || []).includes(c.id); return (
                <button key={c.id} onClick={() => set({ audClients: on ? draft.audClients.filter(x => x !== c.id) : [...(draft.audClients || []), c.id] })} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 11px', borderRadius: 99, fontSize: 12.5, fontWeight: 600, cursor: 'pointer', border: '1px solid ' + (on ? 'var(--clay)' : 'var(--hair)'), background: on ? 'var(--clay-tint)' : 'var(--surface)', color: on ? 'var(--clay-ink)' : 'var(--ink-2)' }}>{c.name}{on && <Icon name="check" size={12} color="var(--clay-ink)" />}</button>); })}
            </div>
            {((draft.audTags || []).length > 0 || (draft.audClients || []).length > 0) && (
              <button className="t-sm" onClick={() => set({ audTags: [], audClients: [] })} style={{ marginTop: 11, fontWeight: 600, color: 'var(--clay-ink)', cursor: 'pointer', textDecoration: 'underline', background: 'transparent' }}>{t('Azzera selezione', 'Clear selection')}</button>
            )}
          </div>
        </div>

        {/* RIGHT — WhatsApp preview + scheduling */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div>
            <div className="t-meta" style={{ marginBottom: 8 }}>{t('Anteprima WhatsApp', 'WhatsApp preview')}</div>
            <div style={{ background: '#E5DDD3', borderRadius: 14, padding: 14 }}>
              <div style={{ background: '#fff', borderRadius: '4px 14px 14px 14px', overflow: 'hidden', boxShadow: '0 1px 2px rgba(0,0,0,0.12)' }}>
                {draft.img && <div style={{ height: 110, background: `center/cover url(${draft.img})` }} />}
                <div style={{ padding: 12 }}>
                  <div style={{ fontWeight: 700, fontSize: 13.5, lineHeight: 1.3 }}>{draft.title[lang] || t('Titolo della comunicazione', 'Communication title')}</div>
                  <div style={{ fontSize: 12.5, color: '#3A3A3A', marginTop: 5, lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>{draft.body[lang] || t('Il testo del messaggio comparirà qui.', 'The message text will appear here.')}</div>
                  {draft.cta && (draft.cta[lang] || draft.cta.it || draft.cta.en) && <div style={{ marginTop: 10, paddingTop: 9, borderTop: '1px solid #ECECEC', textAlign: 'center', color: '#1F8AED', fontWeight: 700, fontSize: 13 }}>{draft.cta[lang] || draft.cta.it || draft.cta.en}</div>}
                  <div style={{ textAlign: 'right', fontSize: 10, color: '#9A9A9A', marginTop: 6 }}>The Parlour</div>
                </div>
              </div>
            </div>
          </div>

          <div>
            <div className="t-meta" style={{ marginBottom: 8 }}>{t('Invio', 'Delivery')}</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
              {[['draft', t('Salva come bozza', 'Save as draft')], ['scheduled', t('Programma invio', 'Schedule')], ['sent', t('Invia subito', 'Send now')]].map(([k, l]) => { const on = draft.status === k; const m = COM_STATUS[k]; return (
                <button key={k} onClick={() => set({ status: k })} style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '10px 12px', borderRadius: 10, cursor: 'pointer', textAlign: 'left', border: '1px solid ' + (on ? m.color : 'var(--hair)'), background: on ? m.tint : 'var(--surface)' }}>
                  <span style={{ width: 16, height: 16, borderRadius: 99, border: '1.8px solid ' + (on ? m.color : 'var(--faint)'), background: on ? m.color : 'transparent', display: 'grid', placeItems: 'center', flexShrink: 0 }}>{on && <Icon name="check" size={10} color="#fff" stroke={2.6} />}</span>
                  <span style={{ fontWeight: 700, fontSize: 13.5, color: on ? m.color : 'var(--ink)' }}>{l}</span>
                </button>
              ); })}
            </div>
            {draft.status === 'scheduled' && (
              <div style={{ marginTop: 10 }}>
                <div className="t-meta" style={{ marginBottom: 5 }}>{t('Data e ora', 'Date & time')}</div>
                <input type="datetime-local" value={draft.when || ''} onChange={e => set({ when: e.target.value })} style={inputCss} />
                <div className="t-sm" style={{ color: 'var(--muted-2)', marginTop: 6 }}>{t('Es. la mattina di un cambio stagione o di un lancio.', 'E.g. the morning of a season change or a launch.')}</div>
              </div>
            )}
          </div>

          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '11px 13px', background: 'var(--clay-tint)', borderRadius: 12 }}>
            <Icon name="clients" size={15} color="var(--clay-ink)" />
            <span className="t-sm" style={{ color: 'var(--clay-ink)', lineHeight: 1.45 }}>{t('Destinatari', 'Recipients')}: <b>{aud}</b>. {t('Inviata in WhatsApp nella lingua preferita di ogni cliente.', 'Delivered on WhatsApp in each client’s preferred language.')}</span>
          </div>
        </div>
      </div>
    </DkModal>
  );
}

Object.assign(window, { DkComunicazioni });
