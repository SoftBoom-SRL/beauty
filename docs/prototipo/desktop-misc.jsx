// desktop-misc.jsx — Servizi, Magazzino, Staff, Impostazioni (desktop)
const { useState: useStateDmi, useRef: useRefDmi, useEffect: useEffectDmi } = React;

/* ---------------- Servizi ---------------- */
const SVC_CATALOG_DEFAULTS = { depositOn: false, depositPct: 30, online: true, buffer: 5, patch: false, active: true };
const depoAmt = (price, pct) => Math.round(price * pct / 100);

function DkServizi() {
  const { t, lang, fireToast, svcOps, setServiceOps, svcCats, subTab, setSubTab } = useDk();
  const sub = subTab || 'servizi';
  const setSub = setSubTab;
  const [services, setServices] = useStateDmi(() => SERVICES.map(s => ({ ...s, ...svcMeta(s.id), desc: { ...svcMeta(s.id).desc } })));
  const [packages, setPackages] = useStateDmi(() => PACKAGES.map(p => ({ ...p })));
  const [editSvc, setEditSvc] = useStateDmi(null);
  const [editPkg, setEditPkg] = useStateDmi(null);
  const [catsOpen, setCatsOpen] = useStateDmi(false);
  const seq = useRefDmi(900);

  const newSvc = () => setEditSvc({ id: 's' + (seq.current++), cat: (svcCats[0] || { id: 'nail' }).id, name: { it: '', en: '' }, dur: 45, price: 40, ops: [], ...SVC_CATALOG_DEFAULTS, desc: { it: '', en: '' }, _new: true });
  const saveSvc = (d) => { setServices(l => d._new ? [...l, stripNew(d)] : l.map(s => s.id === d.id ? stripNew(d) : s)); setServiceOps(d.id, d.ops); setEditSvc(null); fireToast({ msg: t('Servizio salvato', 'Service saved'), icon: 'check' }); };
  const newPkg = () => setEditPkg({ id: 'pk' + (seq.current++), name: { it: 'Nuovo pacchetto', en: 'New package' }, occasion: { it: 'Promo', en: 'Promo' }, period: { it: 'Su prenotazione', en: 'By appointment' }, serviceIds: [], price: 0, depositPct: 30, active: true, desc: { it: '', en: '' }, _new: true });
  const savePkg = (d) => { setPackages(l => d._new ? [...l, stripNew(d)] : l.map(p => p.id === d.id ? stripNew(d) : p)); setEditPkg(null); fireToast({ msg: t('Pacchetto salvato', 'Package saved'), icon: 'check' }); };

  const tabs = [['servizi', t('Servizi', 'Services')], ['pacchetti', t('Pacchetti', 'Packages')]];

  return (
    <div className="dk-page" style={{ maxWidth: 1120 }}>
      {/* sub-tabs: Servizi / Pacchetti */}
      <div style={{ borderBottom: '1px solid var(--hair)', display: 'flex', gap: 4, marginBottom: 22 }}>
        {tabs.map(([k, l]) => (
          <button key={k} onClick={() => setSub(k)} style={{ padding: '11px 4px', marginRight: 22, fontSize: 15.5, fontWeight: 600, cursor: 'pointer', color: sub === k ? 'var(--ink)' : 'var(--muted)', borderBottom: '2px solid ' + (sub === k ? 'var(--clay)' : 'transparent'), marginBottom: -1 }}>
            {l}
          </button>
        ))}
      </div>

      {sub === 'servizi'
        ? <ServiziSub services={services} svcOps={svcOps} svcCats={svcCats} onCats={() => setCatsOpen(true)} onEdit={setEditSvc} onNew={newSvc} t={t} lang={lang} />
        : <PacchettiSub packages={packages} onEdit={setEditPkg} onNew={newPkg} t={t} lang={lang} />}

      {editSvc && <SvcEditModal draft={editSvc} setDraft={setEditSvc} cats={svcCats} onSave={saveSvc} onClose={() => setEditSvc(null)} onCats={() => setCatsOpen(true)} t={t} lang={lang} />}
      {editPkg && <PkgEditModal draft={editPkg} setDraft={setEditPkg} onSave={savePkg} onClose={() => setEditPkg(null)} t={t} lang={lang} />}
      {catsOpen && <CategoriesManager initialType="servizi" onClose={() => setCatsOpen(false)} t={t} lang={lang} fireToast={fireToast} />}
    </div>
  );
}

/* search + filter dropdown + add toolbar */
function SearchToolbar({ q, setQ, placeholder, filters, active, onFilter, onAdd, addLabel, filterTitle, extra }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 18 }}>
      <div className="dk-search" style={{ flex: 1, minWidth: 0, width: 'auto' }}>
        <Icon name="search" size={18} color="var(--muted-2)" />
        <input value={q} onChange={e => setQ(e.target.value)} placeholder={placeholder} />
        {q && <button className="press" onClick={() => setQ('')} style={{ cursor: 'pointer', display: 'grid', placeItems: 'center' }}><Icon name="x" size={15} color="var(--muted-2)" /></button>}
      </div>
      {filters && <FilterMenu options={filters.map(f => [f[0], f[1]])} active={active} onChange={onFilter} title={filterTitle} />}
      {extra}
      <button className="dk-btn dk-btn--clay" onClick={onAdd} style={{ flexShrink: 0 }}><Icon name="plus" size={17} color="#fff" />{addLabel}</button>
    </div>
  );
}

function ServiziSub({ services, svcOps, svcCats, onCats, onEdit, onNew, t, lang }) {
  const opsOf = (sid) => svcOps[sid] || [];
  const [q, setQ] = useStateDmi('');
  const [cat, setCat] = useStateDmi('all');
  const [statusF, setStatusF] = useStateDmi('all');
  const [depF, setDepF] = useStateDmi('all');
  const [onlineF, setOnlineF] = useStateDmi('all');
  const list = services.filter(s => {
    const okCat = cat === 'all' || cat === s.cat;
    const okStatus = statusF === 'all' || (statusF === 'active' && s.active) || (statusF === 'paused' && !s.active);
    const okDep = depF === 'all' || (depF === 'yes' && s.depositOn) || (depF === 'no' && !s.depositOn);
    const okOnline = onlineF === 'all' || (onlineF === 'online' && s.online) || (onlineF === 'insalon' && !s.online);
    const okQ = !q || svcName(s, lang).toLowerCase().includes(q.toLowerCase());
    return okCat && okStatus && okDep && okOnline && okQ;
  });
  const GFM = window.GroupedFilterMenu;
  return (
    <React.Fragment>
      <SearchToolbar q={q} setQ={setQ} placeholder={t('Cerca un servizio…', 'Search a service…')} onAdd={onNew} addLabel={t('Nuovo servizio', 'New service')}
        extra={<React.Fragment>
          <GFM t={t} groups={[
            { label: t('Categoria', 'Category'), value: cat, set: setCat, opts: [['all', t('Tutte', 'All')], ...svcCats.map(c => [c.id, catName(c, lang)])] },
            { label: t('Stato', 'Status'), value: statusF, set: setStatusF, opts: [['all', t('Tutti', 'All')], ['active', t('Attivi', 'Active')], ['paused', t('In pausa', 'Paused')]] },
            { label: t('Deposito', 'Deposit'), value: depF, set: setDepF, opts: [['all', t('Tutti', 'All')], ['yes', t('Con deposito', 'With deposit')], ['no', t('Senza deposito', 'No deposit')]] },
            { label: t('Prenotazione', 'Booking'), value: onlineF, set: setOnlineF, opts: [['all', t('Tutte', 'All')], ['online', t('Online', 'Online')], ['insalon', t('Solo in sede', 'In-salon only')]] },
          ]} />
          <button className="dk-btn dk-btn--ghost" onClick={onCats} style={{ flexShrink: 0 }}><Icon name="tag" size={16} />{t('Categorie', 'Categories')}</button>
        </React.Fragment>} />
      <div className="dk-card" style={{ overflow: 'hidden' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '2.7fr 0.8fr 0.72fr 1.05fr 1.05fr 44px', gap: 14, padding: '14px 22px', borderBottom: '1px solid var(--hair)', background: 'var(--surface-2)' }}>
          {[t('Servizio', 'Service'), t('Durata base', 'Base time'), t('Prezzo', 'Price'), t('Deposito', 'Deposit'), t('Operatrici', 'Stylists'), ''].map((h, i) => <div key={i} className="t-meta">{h}</div>)}
        </div>
        {list.map((s, i) => (
          <div key={s.id} className="dk-row" onClick={() => onEdit({ ...s, desc: { ...s.desc }, name: { ...s.name }, ops: [...opsOf(s.id)] })} style={{ display: 'grid', gridTemplateColumns: '2.7fr 0.8fr 0.72fr 1.05fr 1.05fr 44px', gap: 14, padding: '14px 22px', alignItems: 'center', borderTop: i ? '1px solid var(--hair)' : 'none', opacity: s.active ? 1 : 0.55 }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 600, fontSize: 14.5, lineHeight: 1.25 }}>
                {svcName(s, lang)}
                {!s.active && <span style={{ marginLeft: 8, fontSize: 10.5, fontWeight: 700, color: 'var(--muted)', background: 'var(--paper-2)', padding: '2px 7px', borderRadius: 99, whiteSpace: 'nowrap' }}>{t('In pausa', 'Paused')}</span>}
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 10px', marginTop: 6 }}>
                {s.online ? <Flag icon="globe" label={t('Online', 'Online')} on /> : <Flag icon="globe" label={t('Solo in sede', 'In-salon only')} />}
                {s.patch && <Flag icon="alert" label={t('Patch test', 'Patch test')} warn />}
              </div>
            </div>
            <div className="t-sm" style={{ color: 'var(--muted)' }}>{fmtDur(s.dur, lang)}</div>
            <div className="t-num" style={{ fontSize: 16 }}>{fmtEur(s.price, lang)}</div>
            <div>{s.depositOn
              ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12.5, fontWeight: 700, color: 'var(--warn)', background: 'var(--warn-tint)', padding: '4px 10px', borderRadius: 99 }}><Icon name="coupon" size={13} color="var(--warn)" />{s.depositPct}% · {fmtEur(depoAmt(s.price, s.depositPct), lang)}</span>
              : <span className="t-sm" style={{ color: 'var(--muted-2)' }}>{t('No', 'None')}</span>}</div>
            <div style={{ display: 'flex' }}>{opsOf(s.id).map((o, j) => <div key={o} style={{ marginLeft: j ? -8 : 0 }} title={op(o).name}><Avatar initials={op(o).initials} size={28} color={op(o).color} ring /></div>)}</div>
            <button className="dk-iconbtn" style={{ width: 34, height: 34, borderRadius: 9 }} onClick={(e) => { e.stopPropagation(); onEdit({ ...s, desc: { ...s.desc }, name: { ...s.name }, ops: [...opsOf(s.id)] }); }}><Icon name="edit" size={15} /></button>
          </div>
        ))}
        {!list.length && <div style={{ padding: '36px 22px' }}><EmptyState icon="search" title={t('Nessun servizio', 'No services')} sub={t('Prova un altro filtro o termine di ricerca.', 'Try another filter or search term.')} /></div>}
      </div>
    </React.Fragment>
  );
}

function PacchettiSub({ packages, onEdit, onNew, t, lang }) {
  const [q, setQ] = useStateDmi('');
  const [filt, setFilt] = useStateDmi('all');
  const filters = [['all', t('Tutti', 'All'), 'grid'], ['active', t('Attivi', 'Active'), 'check'], ['inactive', t('Non attivi', 'Inactive'), 'pause']];
  const list = packages.filter(p => {
    const okF = filt === 'all' || (filt === 'active' && p.active) || (filt === 'inactive' && !p.active);
    const okQ = !q || p.name[lang].toLowerCase().includes(q.toLowerCase()) || p.occasion[lang].toLowerCase().includes(q.toLowerCase());
    return okF && okQ;
  });
  return (
    <React.Fragment>
      <SearchToolbar q={q} setQ={setQ} placeholder={t('Cerca un pacchetto o occasione…', 'Search a package or occasion…')} filters={filters} active={filt} onFilter={(k) => { setFilt(k); }} onAdd={onNew} addLabel={t('Nuovo pacchetto', 'New package')} filterTitle={t('Filtra per categoria', 'Filter by category')} />
      <div className="t-sm" style={{ color: 'var(--muted)', marginBottom: 16 }}>{t('Offerte per periodo o occasione, con deposito alla prenotazione.', 'Period or occasion offers, with a deposit on booking.')}</div>
      {list.length ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(330px, 1fr))', gap: 16 }}>
          {list.map(p => {
            const orig = pkgOriginal(p), off = orig ? Math.round((1 - p.price / orig) * 100) : 0;
            return (
              <div key={p.id} className="dk-card dk-hovercard" onClick={() => onEdit({ ...p, name: { ...p.name }, occasion: { ...p.occasion }, period: { ...p.period }, desc: { ...p.desc }, serviceIds: [...p.serviceIds] })} style={{ padding: 18, opacity: p.active ? 1 : 0.6 }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <span style={{ fontWeight: 700, fontSize: 16 }}>{p.name[lang]}</span>
                      {off > 0 && <span style={{ fontSize: 11.5, fontWeight: 800, color: '#fff', background: 'var(--clay)', padding: '2px 8px', borderRadius: 99 }}>-{off}%</span>}
                    </div>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, marginTop: 6, fontSize: 11.5, fontWeight: 700, color: 'var(--op-lina)', background: 'color-mix(in srgb, var(--op-lina) 12%, transparent)', padding: '3px 9px', borderRadius: 99 }}><Icon name="sparkle" size={12} color="var(--op-lina)" />{p.occasion[lang]}</span>
                  </div>
                  <Icon name="edit" size={16} color="var(--muted-2)" />
                </div>
                <div className="t-sm" style={{ color: 'var(--muted)', margin: '12px 0 14px', lineHeight: 1.5 }}>
                  {p.serviceIds.map(id => svc(id) ? svcName(svc(id), lang) : '').filter(Boolean).join(' · ')}
                </div>
                <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between' }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                    <span className="t-num" style={{ fontSize: 24 }}>{fmtEur(p.price, lang)}</span>
                    {off > 0 && <span className="t-sm" style={{ color: 'var(--muted-2)', textDecoration: 'line-through' }}>{fmtEur(orig, lang)}</span>}
                  </div>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, fontWeight: 700, color: 'var(--warn)', background: 'var(--warn-tint)', padding: '4px 10px', borderRadius: 99 }}><Icon name="coupon" size={12} color="var(--warn)" />{t('Acconto', 'Deposit')} {fmtEur(depoAmt(p.price, p.depositPct), lang)}</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--hair)' }}>
                  <Icon name="calendar" size={14} color="var(--muted-2)" />
                  <span className="t-sm" style={{ color: 'var(--muted)' }}>{p.period[lang]}</span>
                  {!p.active && <span style={{ marginLeft: 'auto', fontSize: 10.5, fontWeight: 700, color: 'var(--muted)', background: 'var(--paper-2)', padding: '2px 8px', borderRadius: 99 }}>{t('Non attivo', 'Inactive')}</span>}
                </div>
              </div>
            );
          })}
        </div>
      ) : <EmptyState icon="search" title={t('Nessun pacchetto', 'No packages')} sub={t('Prova un altro filtro o termine di ricerca.', 'Try another filter or search term.')} action={t('Nuovo pacchetto', 'New package')} onAction={onNew} />}
    </React.Fragment>
  );
}
function stripNew(d) { const { _new, ...rest } = d; return rest; }

function Flag({ icon, label, on, warn }) {
  const c = warn ? 'var(--warn)' : on ? 'var(--ok)' : 'var(--muted-2)';
  return <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 600, color: c }}><Icon name={icon} size={12} color={c} />{label}</span>;
}

/* labelled form row */
function FRow({ label, hint, children }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '150px 1fr', gap: 14, alignItems: 'center', padding: '12px 0', borderTop: '1px solid var(--hair)' }}>
      <div><div className="t-ui" style={{ fontWeight: 600, lineHeight: 1.25 }}>{label}</div>{hint && <div className="t-sm" style={{ color: 'var(--muted-2)', marginTop: 3, lineHeight: 1.3 }}>{hint}</div>}</div>
      <div>{children}</div>
    </div>
  );
}
function NumBox({ value, onChange, suffix, width = 92 }) {
  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, border: '1px solid var(--hair)', borderRadius: 10, padding: '0 12px', height: 42, background: 'var(--surface)', width }}>
      <input type="number" value={value} onChange={e => onChange(Math.max(0, parseInt(e.target.value) || 0))} style={{ border: 'none', outline: 'none', background: 'transparent', fontSize: 15, fontWeight: 600, width: '100%' }} />
      {suffix && <span className="t-sm" style={{ color: 'var(--muted-2)', fontWeight: 600 }}>{suffix}</span>}
    </div>
  );
}
function PctChips({ value, onChange }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
      {/* primary editable field — the source of truth */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, border: '1px solid var(--ink)', borderRadius: 10, padding: '0 6px 0 14px', height: 46, background: 'var(--surface)', width: 172 }}>
        <input type="number" min={0} max={100} value={value} onChange={e => onChange(Math.max(0, Math.min(100, parseInt(e.target.value) || 0)))} style={{ flex: 1, minWidth: 0, border: 'none', outline: 'none', background: 'transparent', fontSize: 22, fontWeight: 800, fontFamily: 'var(--mono, monospace)', color: 'var(--ink)' }} />
        <span style={{ fontSize: 17, fontWeight: 700, color: 'var(--muted)' }}>%</span>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <button onClick={() => onChange(Math.min(100, value + 5))} className="dk-iconbtn" style={{ width: 26, height: 19, borderRadius: 6, fontSize: 11, lineHeight: 1 }}>▲</button>
          <button onClick={() => onChange(Math.max(0, value - 5))} className="dk-iconbtn" style={{ width: 26, height: 19, borderRadius: 6, fontSize: 11, lineHeight: 1 }}>▼</button>
        </div>
      </div>
      {/* quick suggestions */}
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ fontSize: 11.5, color: 'var(--muted-2)', fontWeight: 600 }}>Rapidi:</span>
        {[10, 20, 30, 40, 50].map(p => <button key={p} onClick={() => onChange(p)} className="tabnum" style={{ padding: '5px 11px', borderRadius: 99, fontSize: 12.5, fontWeight: 700, cursor: 'pointer', border: '1px solid ' + (value === p ? 'var(--ink)' : 'var(--hair)'), background: value === p ? 'var(--ink)' : 'var(--surface)', color: value === p ? '#fff' : 'var(--ink-2)' }}>{p}%</button>)}
      </div>
    </div>
  );
}

function SvcEditModal({ draft, setDraft, cats, onSave, onClose, onCats, t, lang }) {
  const SVC_CATS = cats || CATS;
  const set = (patch) => setDraft(d => ({ ...d, ...patch }));
  const setName = (v) => setDraft(d => ({ ...d, name: { ...d.name, [lang]: v } }));
  const setDesc = (v) => setDraft(d => ({ ...d, desc: { ...d.desc, [lang]: v } }));
  const toggleOp = (id) => setDraft(d => ({ ...d, ops: d.ops.includes(id) ? d.ops.filter(x => x !== id) : [...d.ops, id] }));
  const canSave = (draft.name[lang] || '').trim() && draft.ops.length > 0;
  return (
    <DkModal open onClose={onClose} title={draft._new ? t('Nuovo servizio', 'New service') : t('Modifica servizio', 'Edit service')} sub={t('Prezzo, durata, deposito e operatrici', 'Price, duration, deposit and stylists')} width={580}
      foot={<React.Fragment><button className="dk-btn dk-btn--ghost" onClick={onClose}>{t('Annulla', 'Cancel')}</button><button className="dk-btn dk-btn--clay" disabled={!canSave} onClick={() => canSave && onSave(draft)}><Icon name="check" size={17} color="#fff" />{t('Salva', 'Save')}</button></React.Fragment>}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 4 }}>
        <input value={draft.name[lang]} onChange={e => setName(e.target.value)} placeholder={t('Nome servizio', 'Service name')} style={{ border: 'none', borderBottom: '2px solid var(--hair)', outline: 'none', fontSize: 20, fontWeight: 700, fontFamily: 'var(--serif)', padding: '6px 0', background: 'transparent' }} />
        <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap', marginTop: 6, alignItems: 'center' }}>
          {SVC_CATS.map(c => <button key={c.id} onClick={() => set({ cat: c.id })} style={{ padding: '6px 12px', borderRadius: 99, fontSize: 12.5, fontWeight: 600, cursor: 'pointer', border: '1px solid ' + (draft.cat === c.id ? 'var(--ink)' : 'var(--hair)'), background: draft.cat === c.id ? 'var(--ink)' : 'var(--surface)', color: draft.cat === c.id ? '#fff' : 'var(--ink-2)' }}>{catName(c, lang)}</button>)}
          {onCats && <button onClick={onCats} title={t('Nuova categoria', 'New category')} style={{ width: 32, height: 32, borderRadius: 99, border: '1px dashed var(--hair)', background: 'var(--surface)', cursor: 'pointer', display: 'grid', placeItems: 'center', color: 'var(--clay-ink)', flexShrink: 0 }}><Icon name="plus" size={15} color="var(--clay-ink)" /></button>}
        </div>
      </div>
      <FRow label={t('Prezzo', 'Price')}><NumBox value={draft.price} onChange={v => set({ price: v })} suffix="€" /></FRow>
      <FRow label={t('Durata base', 'Base duration')} hint={t('Il tempo reale varia per operatore', 'Real time varies by operator')}><NumBox value={draft.dur} onChange={v => set({ dur: v })} suffix="min" /></FRow>
      {/* operators — required */}
      <div style={{ padding: '12px 0', borderTop: '1px solid var(--hair)' }}>
        <div className="t-meta" style={{ marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>{t('Operatrici abilitate', 'Enabled stylists')} <span style={{ color: 'var(--clay)' }}>*</span>{!draft.ops.length && <span className="t-sm" style={{ color: 'var(--muted-2)', fontWeight: 500, textTransform: 'none', letterSpacing: 0 }}>· {t('seleziona almeno una', 'select at least one')}</span>}</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {OPS.map(o => { const on = draft.ops.includes(o.id); return (
            <button key={o.id} onClick={() => toggleOp(o.id)} style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '6px 13px 6px 6px', borderRadius: 99, cursor: 'pointer', border: '1.5px solid ' + (on ? o.color : 'var(--hair)'), background: on ? 'color-mix(in srgb, ' + o.color + ' 12%, transparent)' : 'var(--surface)' }}>
              <Avatar initials={o.initials} size={24} color={o.color} ring={on} />
              <span style={{ fontSize: 13, fontWeight: 600, color: on ? 'var(--ink)' : 'var(--ink-2)' }}>{o.name}</span>
              {on && <Icon name="check" size={13} color={o.color} stroke={2.6} />}
            </button>); })}
        </div>
      </div>
      {/* deposit */}
      <FRow label={t('Richiedi deposito', 'Require deposit')} hint={draft.depositOn ? t('Trattenuto alla prenotazione', 'Held on booking') : t('Nessun deposito', 'No deposit')}>
        <Toggle on={draft.depositOn} onChange={v => set({ depositOn: v })} />
      </FRow>
      {draft.depositOn && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 14, padding: '14px 16px', background: 'var(--warn-tint)', borderRadius: 12, margin: '4px 0' }}>
          <div style={{ flex: 1 }}>
            <div className="t-meta" style={{ marginBottom: 8 }}>{t('Percentuale sul prezzo', 'Percentage of price')}</div>
            <PctChips value={draft.depositPct} onChange={v => set({ depositPct: v })} />
          </div>
          <div style={{ textAlign: 'right' }}>
            <div className="t-sm" style={{ color: 'var(--muted)' }}>{t('Acconto', 'Deposit')}</div>
            <div className="t-num" style={{ fontSize: 24, color: 'var(--warn)' }}>{fmtEur(depoAmt(draft.price, draft.depositPct), lang)}</div>
          </div>
        </div>
      )}
      <FRow label={t('Prenotabile online', 'Bookable online')} hint={t('Visibile nell’app cliente', 'Shown in the client app')}><Toggle on={draft.online} onChange={v => set({ online: v })} /></FRow>
      <FRow label={t('Servizio attivo', 'Service active')}><Toggle on={draft.active} onChange={v => set({ active: v })} /></FRow>
      <FRow label={t('Descrizione', 'Description')} hint={t('Mostrata al cliente', 'Shown to the client')}>
        <textarea value={draft.desc[lang] || ''} onChange={e => setDesc(e.target.value)} rows={2} placeholder={t('Breve descrizione…', 'Short description…')} style={{ width: '100%', border: '1px solid var(--hair)', borderRadius: 10, outline: 'none', resize: 'none', fontSize: 14, lineHeight: 1.45, padding: '10px 12px', fontFamily: 'var(--sans)', background: 'var(--surface)' }} />
      </FRow>
    </DkModal>
  );
}

function PkgEditModal({ draft, setDraft, onSave, onClose, t, lang }) {
  const set = (patch) => setDraft(d => ({ ...d, ...patch }));
  const setL = (key, v) => setDraft(d => ({ ...d, [key]: { ...d[key], [lang]: v } }));
  const [svcQ, setSvcQ] = useStateDmi('');
  const [svcOpen, setSvcOpen] = useStateDmi(false);
  const toggleSvc = (id) => setDraft(d => ({ ...d, serviceIds: d.serviceIds.includes(id) ? d.serviceIds.filter(x => x !== id) : [...d.serviceIds, id] }));
  const orig = pkgOriginal(draft), off = orig ? Math.round((1 - draft.price / orig) * 100) : 0;
  const inputCss = { border: '1px solid var(--hair)', borderRadius: 10, outline: 'none', fontSize: 14.5, padding: '10px 12px', fontFamily: 'var(--sans)', background: 'var(--surface)', width: '100%' };
  return (
    <DkModal open onClose={onClose} title={draft._new ? t('Nuovo pacchetto', 'New package') : t('Modifica pacchetto', 'Edit package')} sub={t('Sconto per periodo o occasione · deposito alla prenotazione', 'Period or occasion discount · deposit on booking')} width={600}
      foot={<React.Fragment><button className="dk-btn dk-btn--ghost" onClick={onClose}>{t('Annulla', 'Cancel')}</button><button className="dk-btn dk-btn--clay" disabled={!draft.serviceIds.length} onClick={() => onSave(draft)}><Icon name="check" size={17} color="#fff" />{t('Salva pacchetto', 'Save package')}</button></React.Fragment>}>
      <input value={draft.name[lang]} onChange={e => setL('name', e.target.value)} style={{ border: 'none', borderBottom: '2px solid var(--hair)', outline: 'none', fontSize: 20, fontWeight: 700, fontFamily: 'var(--serif)', padding: '6px 0', background: 'transparent', width: '100%', marginBottom: 4 }} />
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, margin: '14px 0' }}>
        <div><div className="t-meta" style={{ marginBottom: 6 }}>{t('Occasione', 'Occasion')}</div><input value={draft.occasion[lang]} onChange={e => setL('occasion', e.target.value)} style={inputCss} /></div>
        <div><div className="t-meta" style={{ marginBottom: 6 }}>{t('Periodo / validità', 'Period / validity')}</div><input value={draft.period[lang]} onChange={e => setL('period', e.target.value)} style={inputCss} /></div>
      </div>
      <div className="t-meta" style={{ marginBottom: 8 }}>{t('Servizi inclusi', 'Included services')}</div>
      {/* selected services (purple chips) */}
      {draft.serviceIds.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7, marginBottom: 10 }}>
          {[...new Set(draft.serviceIds)].map(sid => { const s = svc(sid); const n = draft.serviceIds.filter(x => x === sid).length; return (
            <button key={sid} onClick={() => toggleSvc(sid)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 12px', borderRadius: 99, fontSize: 12.5, fontWeight: 600, cursor: 'pointer', border: '1px solid var(--clay)', background: 'var(--clay)', color: '#fff' }}>
              {svcName(s, lang)}{n > 1 ? ' ×' + n : ''}<Icon name="x" size={12} color="#fff" />
            </button>); })}
        </div>
      )}
      {/* search opens the full picker */}
      <div style={{ position: 'relative', marginBottom: 6 }}>
        <div className="dk-search" style={{ width: '100%' }}>
          <Icon name="search" size={16} color="var(--muted-2)" />
          <input value={svcQ} onChange={e => { setSvcQ(e.target.value); setSvcOpen(true); }} onFocus={() => setSvcOpen(true)} placeholder={draft.serviceIds.length ? t('Aggiungi un altro servizio…', 'Add another service…') : t('Cerca e aggiungi servizi…', 'Search and add services…')} />
          <button onClick={() => { setSvcOpen(o => !o); }} style={{ cursor: 'pointer', display: 'grid', placeItems: 'center' }}><Icon name="chevD" size={15} color="var(--muted-2)" style={{ transform: svcOpen ? 'rotate(180deg)' : 'none', transition: 'transform 140ms' }} /></button>
        </div>
        {svcOpen && (<React.Fragment>
          <div onClick={() => setSvcOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 20 }} />
          <div className="dk-card scroll" style={{ position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0, zIndex: 21, padding: 6, boxShadow: 'var(--sh-pop)', maxHeight: 230, overflowY: 'auto' }}>
            {SERVICES.filter(s => !svcQ || svcName(s, lang).toLowerCase().includes(svcQ.toLowerCase())).map(s => { const on = draft.serviceIds.includes(s.id); const n = draft.serviceIds.filter(x => x === s.id).length; return (
              <button key={s.id} className="dk-row" onClick={() => toggleSvc(s.id)} style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '8px 10px', borderRadius: 8, textAlign: 'left' }}>
                <span style={{ width: 18, height: 18, borderRadius: 6, border: '1.6px solid ' + (on ? 'var(--clay)' : 'var(--faint)'), background: on ? 'var(--clay)' : 'transparent', display: 'grid', placeItems: 'center', flexShrink: 0 }}>{on && <Icon name="check" size={11} color="#fff" stroke={2.6} />}</span>
                <span style={{ flex: 1, fontWeight: 600, fontSize: 13.5, color: on ? 'var(--clay-ink)' : 'var(--ink-2)' }}>{svcName(s, lang)}{on && n > 1 ? ' ×' + n : ''}</span>
                <span className="t-num" style={{ fontSize: 13, color: 'var(--muted)' }}>{fmtEur(s.price, lang)}</span>
              </button>); })}
          </div>
        </React.Fragment>)}
      </div>
      <div className="t-sm" style={{ color: 'var(--muted-2)', marginBottom: 14 }}>{t('Tocca più volte per ripetere un servizio (es. 5× manicure).', 'Tap again to repeat a service (e.g. 5× manicure).')}</div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '14px 16px', background: 'var(--surface-2)', borderRadius: 12, marginBottom: 14 }}>
        <div>
          <div className="t-meta" style={{ marginBottom: 6, whiteSpace: 'nowrap' }}>{t('Prezzo pacchetto', 'Package price')}</div>
          <NumBox value={draft.price} onChange={v => set({ price: v })} suffix="€" width={108} />
        </div>
        <div style={{ flex: 1, textAlign: 'right' }}>
          <div className="t-sm" style={{ color: 'var(--muted)' }}>{t('Valore singoli', 'Individual value')} <span style={{ textDecoration: 'line-through' }}>{fmtEur(orig, lang)}</span></div>
          {off > 0 && <div style={{ fontWeight: 800, fontSize: 18, color: 'var(--clay-ink)' }}>{t('Sconto', 'Discount')} -{off}% · {fmtEur(orig - draft.price, lang)}</div>}
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 14, padding: '14px 16px', background: 'var(--warn-tint)', borderRadius: 12, marginBottom: 8 }}>
        <div style={{ flex: 1 }}>
          <div className="t-meta" style={{ marginBottom: 8 }}>{t('Deposito richiesto', 'Required deposit')}</div>
          <PctChips value={draft.depositPct} onChange={v => set({ depositPct: v })} />
        </div>
        <div style={{ textAlign: 'right' }}>
          <div className="t-sm" style={{ color: 'var(--muted)' }}>{t('Acconto', 'Deposit')}</div>
          <div className="t-num" style={{ fontSize: 24, color: 'var(--warn)' }}>{fmtEur(depoAmt(draft.price, draft.depositPct), lang)}</div>
        </div>
      </div>
      <FRow label={t('Pacchetto attivo', 'Package active')}><Toggle on={draft.active} onChange={v => set({ active: v })} /></FRow>
      <FRow label={t('Descrizione', 'Description')}>
        <textarea value={draft.desc[lang] || ''} onChange={e => setDraft(d => ({ ...d, desc: { ...d.desc, [lang]: e.target.value } }))} rows={2} placeholder={t('Breve descrizione…', 'Short description…')} style={{ width: '100%', border: '1px solid var(--hair)', borderRadius: 10, outline: 'none', resize: 'none', fontSize: 14, lineHeight: 1.45, padding: '10px 12px', fontFamily: 'var(--sans)', background: 'var(--surface)' }} />
      </FRow>
    </DkModal>
  );
}

/* ---------------- Magazzino ---------------- */
const INV_DEFAULTS = { cat: 'consumabili', qty: 0, min: 3, value: 0, cost: 0, retail: 0, vat: 22, discount: 0, reorderQty: 0, unitQty: '', supplier: '', brand: '' };
const UNIT_LABEL = { it: 'unità', en: 'units' };

// stock status: low (red, below min or out) · warn (orange, near min) · ok (green)
function stockStatus(p) {
  if (p.qty <= 0 || p.qty < p.min) return 'low';
  if (p.qty <= p.min + Math.max(1, Math.ceil(p.min * 0.3))) return 'warn';
  return 'ok';
}
const STOCK_DOT = {
  low:  { color: '#D14343', tint: 'rgba(209,67,67,0.14)',  it: 'Sotto soglia', en: 'Below threshold' },
  warn: { color: '#D98A3A', tint: 'rgba(217,138,58,0.16)', it: 'Vicino alla soglia', en: 'Near threshold' },
  ok:   { color: '#3F9D6B', tint: 'rgba(63,157,107,0.14)', it: 'Nella norma', en: 'In stock' },
};

/* grouped inventory filter — Categoria · Tipologia d'uso · Scorta */
function MagFilterMenu({ catOpts, cat, setCat, nat, setNat, stock, setStock, t }) {
  const [open, setOpen] = useStateDmi(false);
  const activeCount = (cat !== 'all' ? 1 : 0) + (nat !== 'all' ? 1 : 0) + (stock !== 'all' ? 1 : 0);
  const Section = ({ label, value, set, opts }) => (
    <div style={{ marginBottom: 2 }}>
      <div className="t-meta" style={{ padding: '8px 10px 5px' }}>{label}</div>
      {opts.map(([k, l]) => { const on = value === k; return (
        <button key={k} className="dk-row" onClick={() => set(k)} style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '8px 10px', borderRadius: 9, textAlign: 'left' }}>
          <span style={{ flex: 1, fontWeight: on ? 700 : 600, fontSize: 13.5, color: on ? 'var(--ink)' : 'var(--ink-2)' }}>{l}</span>
          {on && <Icon name="check" size={15} color="var(--clay-ink)" stroke={2.4} />}
        </button>
      ); })}
    </div>
  );
  return (
    <div style={{ position: 'relative', flexShrink: 0 }}>
      <button className="dk-iconbtn" onClick={() => setOpen(o => !o)} style={{ background: activeCount || open ? 'var(--ink)' : 'var(--surface)', borderColor: activeCount || open ? 'var(--ink)' : 'var(--hair)', position: 'relative' }}>
        <Icon name="filter" size={18} color={activeCount || open ? '#fff' : 'var(--ink)'} />
        {activeCount > 0 && <span style={{ position: 'absolute', top: -5, right: -5, minWidth: 16, height: 16, padding: '0 4px', borderRadius: 99, background: 'var(--clay)', border: '2px solid var(--paper)', fontSize: 10, fontWeight: 800, color: '#fff', display: 'grid', placeItems: 'center' }}>{activeCount}</span>}
      </button>
      {open && (
        <React.Fragment>
          <div onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 60 }} />
          <div className="dk-card" style={{ position: 'absolute', top: 'calc(100% + 8px)', right: 0, width: 252, padding: 8, boxShadow: 'var(--sh-pop)', zIndex: 61, maxHeight: 460, overflowY: 'auto' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '4px 10px 2px' }}>
              <span style={{ fontWeight: 700, fontSize: 13 }}>{t('Filtri', 'Filters')}</span>
              {activeCount > 0 && <button onClick={() => { setCat('all'); setNat('all'); setStock('all'); }} style={{ background: 'transparent', border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 700, color: 'var(--clay-ink)' }}>{t('Azzera', 'Clear')}</button>}
            </div>
            <Section label={t('Categoria', 'Category')} value={cat} set={setCat} opts={catOpts} />
            <div style={{ height: 1, background: 'var(--hair)', margin: '5px 0' }} />
            <Section label={t("Tipologia d'uso", 'Usage type')} value={nat} set={setNat} opts={[['all', t('Tutte', 'All')], ['interno', t('Solo uso interno', 'In-salon only')], ['vendita', t('Solo vendita', 'Retail only')], ['entrambi', t('Misto', 'Mixed')]]} />
            <div style={{ height: 1, background: 'var(--hair)', margin: '5px 0' }} />
            <Section label={t('Scorta', 'Stock')} value={stock} set={setStock} opts={[['all', t('Tutte', 'All')], ['low', t('Solo sottoscorta', 'Low stock only')]]} />
          </div>
        </React.Fragment>
      )}
    </div>
  );
}

function DkMagazzino() {
  const { t, lang, fireToast, invCats, subTab, setSubTab } = useDk();
  const [inv, setInv] = useStateDmi(() => INVENTORY.map(p => ({ ...p })));
  const [editP, setEditP] = useStateDmi(null);
  const [catsOpen, setCatsOpen] = useStateDmi(false);
  const [q, setQ] = useStateDmi('');
  const [filt, setFilt] = useStateDmi('all');
  const seq = useRefDmi(700);
  const sub = subTab || 'prodotti';
  const setSub = setSubTab;

  const [moves, setMoves] = useStateDmi(() => MOVES_SEED.map(m => ({ ...m })));
  const logMove = (e) => { const d = new Date(); const hh = String(d.getHours()).padStart(2, '0'); const mm = String(d.getMinutes()).padStart(2, '0'); setMoves(m => [{ id: 'mv' + Date.now() + Math.round(Math.random() * 1e4), when: { it: 'Oggi · ' + hh + ':' + mm, en: 'Today · ' + hh + ':' + mm }, by: 'Sole Caputo', ...e }, ...m]); };
  const low = inv.filter(p => p.qty < p.min);
  const totalValue = inv.reduce((s, p) => s + p.qty * p.value, 0);
  const adj = (id, d) => { setInv(l => l.map(p => p.id === id ? { ...p, qty: Math.max(0, p.qty + d) } : p)); const p = inv.find(x => x.id === id); if (p) logMove({ type: 'rettifica', productId: id, productName: p.name[lang], delta: d, note: { it: 'Rettifica manuale', en: 'Manual adjustment' } }); };
  const invCat = (id) => invCats.find(c => c.id === id);
  const [restock, setRestock] = useStateDmi(false);
  const [supplierReg, setSupplierReg] = useStateDmi(() => ({ ...SUPPLIER_CONFIG_SEED }));
  const [selProd, setSelProd] = useStateDmi(null);  // product drawer
  const [adjOpen, setAdjOpen] = useStateDmi(null);  // { id, type:'scarico'|'rettifica' }
  const [natFilt, setNatFilt] = useStateDmi('all'); // all | vendita | interno | entrambi
  const [stockFilt, setStockFilt] = useStateDmi('all'); // all | low | warn | ok
  const [supFilt, setSupFilt] = useStateDmi('all');
  const [brandFilt, setBrandFilt] = useStateDmi('all');
  const applyRestock = (lines, _unused, causale) => {
    let added = 0, created = 0;
    const noteBase = 'Carico merce';
    const noteBaseEn = 'Restock';
    const noteIt = causale ? `${noteBase} · ${causale}` : noteBase;
    const noteEn = causale ? `${noteBaseEn} · ${causale}` : noteBaseEn;
    setInv(l => {
      let next = l.map(p => ({ ...p }));
      lines.forEach(ln => {
        const qn = parseInt(ln.qty) || 0;
        if (ln.existingId) {
          if (qn === 0) return;
          next = next.map(p => p.id === ln.existingId ? { ...p, qty: Math.max(0, p.qty + qn) } : p);
          added += qn;
        } else {
          const nm = (ln.name || '').trim();
          if (!nm) return;
          next.push({ id: 'p' + (seq.current++), cat: ln.cat || 'consumabili', name: { it: nm, en: nm }, qty: qn, min: parseInt(ln.min) || 3, unit: { it: ln.unit || 'pezzi', en: ln.unit || 'pcs' }, value: parseFloat(ln.value) || 0, supplier: (ln.supplier || '').trim() });
          created++; added += qn;
        }
      });
      return next;
    });
    setRestock(false);
    lines.forEach(ln => {
      const qn = parseInt(ln.qty) || 0;
      if (ln.existingId) { if (qn === 0) return; const p = inv.find(x => x.id === ln.existingId); logMove({ type: 'carico', productId: ln.existingId, productName: p ? p.name[lang] : '', delta: qn, note: { it: noteIt, en: noteEn } }); }
      else { const nm = (ln.name || '').trim(); if (!nm) return; logMove({ type: 'carico', productId: null, productName: nm, delta: qn, note: { it: noteIt + ' · nuovo', en: noteEn + ' · new' } }); }
    });
    const itMsg = `Carico registrato · +${added} unità` + (created ? ` · ${created} ${created === 1 ? 'nuovo prodotto' : 'nuovi prodotti'}` : '');
    const enMsg = `Stock received · +${added} units` + (created ? ` · ${created} new ${created === 1 ? 'product' : 'products'}` : '');
    fireToast({ msg: t(itMsg, enMsg), icon: 'check' });
  };

  const list = inv.filter(p => {
    const okF = filt === 'all' || filt === p.cat;
    const okN = natFilt === 'all' || p.nature === natFilt;
    const okS = stockFilt === 'all' || stockStatus(p) === stockFilt;
    const okSup = supFilt === 'all' || (p.supplier || '') === supFilt;
    const okBrand = brandFilt === 'all' || (p.brand || '') === brandFilt;
    const okQ = !q || p.name[lang].toLowerCase().includes(q.toLowerCase()) || (p.sku||'').toLowerCase().includes(q.toLowerCase()) || (p.brand||'').toLowerCase().includes(q.toLowerCase()) || (p.supplier||'').toLowerCase().includes(q.toLowerCase());
    return okF && okN && okS && okSup && okBrand && okQ;
  });
  // low stock first within each group
  const stockRank = { low: 0, warn: 1, ok: 2 };
  const byLow = (a, b) => stockRank[stockStatus(a)] - stockRank[stockStatus(b)] || a.name[lang].localeCompare(b.name[lang]);
  // group by category (default screen); each group sorted low-first
  const groups = invCats.map(c => ({ cat: c, items: list.filter(p => p.cat === c.id).sort(byLow) })).filter(g => g.items.length);
  const orphans = list.filter(p => !invCats.some(c => c.id === p.cat)).sort(byLow);
  if (orphans.length) groups.push({ cat: { id: '__other', name: { it: 'Altro', en: 'Other' } }, items: orphans });
  const suppliers = [...new Set(inv.map(p => p.supplier).filter(Boolean))];
  const brands = [...new Set(inv.map(p => p.brand).filter(Boolean))];
  const filterGroups = [
    { label: t('Categoria', 'Category'), value: filt, set: setFilt, opts: [['all', t('Tutte', 'All')], ...invCats.map(c => [c.id, c.name[lang] || c.name.it])] },
    { label: t('Fornitore', 'Supplier'), value: supFilt, set: setSupFilt, opts: [['all', t('Tutti', 'All')], ...suppliers.map(s => [s, s])] },
    { label: t('Brand', 'Brand'), value: brandFilt, set: setBrandFilt, opts: [['all', t('Tutti', 'All')], ...brands.map(b => [b, b])] },
    { label: t("Tipologia d'uso", 'Usage type'), value: natFilt, set: setNatFilt, opts: [['all', t('Tutte', 'All')], ['interno', t('Solo uso interno', 'In-salon only')], ['vendita', t('Solo vendita', 'Retail only')], ['entrambi', t('Misto', 'Mixed')]] },
    { label: t('Stato scorte', 'Stock status'), value: stockFilt, set: setStockFilt, opts: [['all', t('Tutti', 'All')], ['low', t('Sotto soglia', 'Below threshold')], ['warn', t('Vicino alla soglia', 'Near threshold')], ['ok', t('Nella norma', 'In stock')]] },
  ];

  const newP = () => setSelProd({ id: 'p' + (seq.current++), name: { it: '', en: '' }, unit: { it: 'unità', en: 'units' }, nature: 'interno', sku: '', ...INV_DEFAULTS, _new: true });
  const saveP = (d) => { setInv(l => d._new ? [...l, stripNew(d)] : l.map(p => p.id === d.id ? stripNew(d) : p)); fireToast({ msg: t('Prodotto salvato', 'Product saved'), icon: 'check' }); };
  const delP = (id) => { setInv(l => l.filter(p => p.id !== id)); fireToast({ msg: t('Prodotto eliminato', 'Product deleted'), icon: 'x' }); };


  return (
    <div className="dk-page" style={{ maxWidth: 1080 }}>
      {/* sub-tabs: Prodotti / Storico */}
      <div style={{ borderBottom: '1px solid var(--hair)', display: 'flex', gap: 4, marginBottom: 22 }}>
        {[['prodotti', t('Prodotti', 'Products')], ['ordini', t('Ordini', 'Orders')], ['fornitori', t('Fornitori', 'Suppliers')], ['storico', t('Storico', 'History')]].map(([k, l]) => (
          <button key={k} onClick={() => setSub(k)} style={{ padding: '11px 4px', marginRight: 22, fontSize: 15.5, fontWeight: 600, cursor: 'pointer', color: sub === k ? 'var(--ink)' : 'var(--muted)', borderBottom: '2px solid ' + (sub === k ? 'var(--clay)' : 'transparent'), marginBottom: -1, position: 'relative' }}>{l}{k === 'ordini' && low.length > 0 && <span style={{ position: 'absolute', top: 6, right: -2, width: 7, height: 7, borderRadius: 99, background: STOCK_DOT.low.color }} />}</button>
        ))}
      </div>

      {sub === 'prodotti' && <React.Fragment>
      <div style={{ display: 'flex', gap: 14, marginBottom: 14 }}>
        <MiniMetric label={t('Valore magazzino', 'Stock value')} value={fmtEur(totalValue, lang)} />
        <MiniMetric label={t('Sottoscorta', 'Low stock')} value={low.length} onClick={() => { setFilt('all'); setNatFilt('all'); setSupFilt('all'); setBrandFilt('all'); setStockFilt('low'); }} />
        <MiniMetric label={t('Prodotti', 'Products')} value={inv.length} onClick={() => { setFilt('all'); setNatFilt('all'); setStockFilt('all'); setSupFilt('all'); setBrandFilt('all'); }} />
      </div>

      {low.length > 0 && <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '12px 16px', background: 'var(--warn-tint)', borderRadius: 12, marginBottom: 16 }}><Icon name="alert" size={18} color="var(--warn)" /><span style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--ink-2)' }}>{low.length} {t('prodotti sotto la scorta minima · ricordati di riordinare', 'products below minimum · remember to reorder')}</span></div>}

      <SearchToolbar q={q} setQ={setQ} placeholder={t('Cerca prodotto, brand o fornitore…', 'Search product, brand or supplier…')} onAdd={newP} addLabel={t('Nuovo prodotto', 'New product')}
        extra={<React.Fragment>
          <GroupedFilterMenu t={t} groups={filterGroups} />
          <button className="dk-btn dk-btn--ghost" onClick={() => setRestock(true)} style={{ flexShrink: 0 }}><Icon name="box" size={16} />{t('Carico merce', 'Receive stock')}</button>
        </React.Fragment>} />

      <div className="dk-card" style={{ overflow: 'hidden' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '16px 2.1fr 0.85fr 1fr 0.8fr 118px 40px', gap: 12, padding: '13px 20px', borderBottom: '1px solid var(--hair)' }}>
          {['', t('Prodotto', 'Product'), t('Natura', 'Nature'), t('Scorta', 'Stock'), t('Valore', 'Value'), t('Movimenta', 'Move'), ''].map((h, i) => <div key={i} className="t-meta">{h}</div>)}
        </div>
        {groups.map((g, gi) => { const lowCount = g.items.filter(p => stockStatus(p) === 'low').length; return (
          <React.Fragment key={g.cat.id}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: gi ? '20px 20px 7px' : '15px 20px 7px' }}>
              <span style={{ fontWeight: 700, fontSize: 12, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--muted)' }}>{g.cat.name[lang] || g.cat.name.it}</span>
              <span className="t-sm" style={{ color: 'var(--faint)', fontWeight: 600 }}>{g.items.length}</span>
              {lowCount > 0 && <span style={{ fontSize: 10.5, fontWeight: 700, color: STOCK_DOT.low.color, background: STOCK_DOT.low.tint, padding: '2px 8px', borderRadius: 99 }}>{lowCount} {t('sotto soglia', 'low')}</span>}
            </div>
            {g.items.map((p) => { const st = stockStatus(p); const dot = STOCK_DOT[st]; const lowItem = st === 'low'; return (
              <div key={p.id} className="dk-row" onClick={() => setSelProd(p)} style={{ display: 'grid', gridTemplateColumns: '16px 2.1fr 0.85fr 1fr 0.8fr 118px 40px', gap: 12, padding: '12px 20px', alignItems: 'center', borderTop: '1px solid var(--hair)', cursor: 'pointer' }}>
                <span title={dot[lang]} style={{ width: 9, height: 9, borderRadius: 99, background: dot.color }} />
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name[lang]}</div>
                  <div className="t-sm" style={{ color: 'var(--muted-2)', marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{[p.brand, p.sku].filter(Boolean).join(' · ') || (p.supplier || '')}</div>
                </div>
                <div>{p.nature ? <span style={{ fontSize: 11, fontWeight: 700, color: NATURE_META[p.nature]?.color, background: NATURE_META[p.nature]?.tint, padding: '3px 8px', borderRadius: 99, whiteSpace: 'nowrap' }}>{NATURE_META[p.nature]?.[lang]}</span> : <span className="t-sm" style={{ color: 'var(--muted-2)' }}>—</span>}</div>
                <div style={{ whiteSpace: 'nowrap' }}>
                  <div style={{ fontSize: 13.5, fontWeight: lowItem ? 700 : 600, color: lowItem ? dot.color : 'var(--ink)' }}>{p.qty} <span style={{ fontWeight: 400, color: lowItem ? dot.color : 'var(--muted)' }}>{p.unit?.[lang] || 'u'}</span></div>
                  <div className="t-sm" style={{ color: 'var(--muted-2)' }}>min {p.min}</div>
                </div>
                <div className="t-num" style={{ fontSize: 14 }}>{p.qty * p.value === 0 ? '€0' : fmtEur(p.qty * p.value, lang)}</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 7 }} onClick={e => e.stopPropagation()}>
                  <button className="dk-iconbtn" style={{ width: 30, height: 30, borderRadius: 9, fontSize: 19, fontWeight: 600, border: '1px solid var(--hair)' }} onClick={() => setAdjOpen({ id: p.id, type: 'scarico' })} title={t('Scarico', 'Issue')}>−</button>
                  <span className="t-num" style={{ fontSize: 14.5, minWidth: 24, textAlign: 'center' }}>{p.qty}</span>
                  <button className="dk-iconbtn" style={{ width: 30, height: 30, borderRadius: 9, fontSize: 19, fontWeight: 600, border: '1px solid var(--hair)', background: 'var(--clay)', color: '#fff', borderColor: 'transparent' }} onClick={() => setAdjOpen({ id: p.id, type: 'carico' })} title={t('Carico', 'Receive')}>+</button>
                </div>
                <button className="dk-iconbtn" style={{ width: 32, height: 32, borderRadius: 9 }} onClick={(e) => { e.stopPropagation(); setSelProd(p); }}><Icon name="edit" size={15} /></button>
              </div>
            ); })}
          </React.Fragment>
        ); })}
        {!list.length && <div style={{ padding: '36px 22px' }}><EmptyState icon="search" title={t('Nessun prodotto', 'No products')} sub={t('Prova un altro filtro o termine di ricerca.', 'Try another filter or search term.')} /></div>}
      </div>
      </React.Fragment>}


      {sub === 'ordini' && <OrdiniSub inv={inv} cfg={supplierReg} setCfg={setSupplierReg} t={t} lang={lang} fireToast={fireToast} onReceive={(lines) => {
        lines.forEach(l => { if (l.received > 0) { setInv(list => list.map(p => p.id === l.id ? { ...p, qty: p.qty + l.received } : p)); logMove({ type: 'carico', productId: l.id, productName: typeof l.name === 'object' ? l.name[lang] : l.name, delta: l.received, note: { it: 'Consegna ordine', en: 'Order delivery' } }); } });
      }} />}
      {sub === 'fornitori' && <FornitoriSub inv={inv} suppliers={supplierReg} setSuppliers={setSupplierReg} t={t} lang={lang} fireToast={fireToast} />}
      {sub === 'storico' && <StoricoSub moves={moves} t={t} lang={lang} />}

      {selProd && <ProductDrawer prod={selProd} inv={inv} moves={moves} cats={invCats} onCats={() => setCatsOpen(true)} onSave={(d) => { saveP(d); setSelProd(null); }} onDelete={(id) => { delP(id); setSelProd(null); }} onAdj={(id, type) => setAdjOpen({ id, type })} onClose={() => setSelProd(null)} t={t} lang={lang} />}
      {adjOpen && <AdjModal prodId={adjOpen.id} type={adjOpen.type} inv={inv} onConfirm={(id, delta, note) => { setInv(l => l.map(p => p.id === id ? { ...p, qty: Math.max(0, p.qty + delta) } : p)); const p = inv.find(x => x.id === id); if (p) logMove({ type: adjOpen.type, productId: id, productName: p.name[lang], delta, note }); setAdjOpen(null); setSelProd(sp => sp ? { ...sp } : sp); fireToast({ msg: t('Movimento registrato', 'Movement recorded'), icon: 'check' }); }} onClose={() => setAdjOpen(null)} t={t} lang={lang} />}
      {restock && <RestockModal inv={inv} onApply={applyRestock} onClose={() => setRestock(false)} t={t} lang={lang} fireToast={fireToast} />}
      {catsOpen && <CategoriesManager initialType="magazzino" onClose={() => setCatsOpen(false)} t={t} lang={lang} fireToast={fireToast} />}

    </div>
  );
}

function ProdEditModal({ draft, setDraft, cats, onCats, onSave, onDelete, onClose, t, lang }) {
  const set = (patch) => setDraft(d => ({ ...d, ...patch }));
  const setName = (v) => setDraft(d => ({ ...d, name: { ...d.name, [lang]: v } }));
  const setUnit = (it, en) => setDraft(d => ({ ...d, unit: { it, en } }));
  const canSave = (draft.name[lang] || '').trim();
  const lowItem = draft.qty < draft.min;
  const inputCss = { width: '100%', border: '1px solid var(--hair)', borderRadius: 10, outline: 'none', fontSize: 14.5, padding: '10px 12px', fontFamily: 'var(--sans)', background: 'var(--surface)' };
  const curUnit = draft.unit?.[lang] || 'unità';
  return (
    <DkModal open onClose={onClose} title={draft._new ? t('Nuovo prodotto', 'New product') : t('Modifica prodotto', 'Edit product')} sub={t('Categoria, scorta e valore', 'Category, stock and value')} width={560}
      foot={<React.Fragment>
        {!draft._new && <button className="dk-btn dk-btn--ghost" style={{ color: 'var(--danger)', borderColor: 'color-mix(in srgb, var(--danger) 40%, var(--hair))', marginRight: 'auto' }} onClick={() => onDelete(draft.id)}><Icon name="x" size={16} color="var(--danger)" />{t('Elimina', 'Delete')}</button>}
        <button className="dk-btn dk-btn--ghost" onClick={onClose}>{t('Annulla', 'Cancel')}</button>
        <button className="dk-btn dk-btn--clay" disabled={!canSave} onClick={() => canSave && onSave(draft)}><Icon name="check" size={17} color="#fff" />{t('Salva', 'Save')}</button>
      </React.Fragment>}>
      <input value={draft.name[lang] || ''} onChange={e => setName(e.target.value)} placeholder={t('Nome prodotto', 'Product name')} style={{ border: 'none', borderBottom: '2px solid var(--hair)', outline: 'none', fontSize: 20, fontWeight: 700, fontFamily: 'var(--serif)', padding: '6px 0', background: 'transparent', width: '100%', marginBottom: 14 }} />

      {/* SKU */}
      <div style={{ marginBottom: 16 }}>
        <div><div className="t-meta" style={{ marginBottom: 6 }}>SKU / {t('Codice', 'Code')}</div><input value={draft.sku || ''} onChange={e => set({ sku: e.target.value })} placeholder="es. GEL-RD-001" style={inputCss} /></div>

      </div>
      {/* Nature */}
      <div className="t-meta" style={{ marginBottom: 8 }}>{t('Natura', 'Nature')}</div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 18 }}>
        {[['vendita', t('Vendita', 'Retail')], ['interno', t('Uso interno', 'In-salon')], ['entrambi', t('Entrambi', 'Both')]].map(([v, l]) => { const on = draft.nature === v; return (
          <button key={v} onClick={() => set({ nature: v })} style={{ flex: 1, padding: '9px', borderRadius: 10, fontSize: 13, fontWeight: 600, cursor: 'pointer', border: '1px solid ' + (on ? 'var(--clay)' : 'var(--hair)'), background: on ? 'var(--clay-tint)' : 'var(--surface)', color: on ? 'var(--clay-ink)' : 'var(--ink-2)' }}>{l}</button>
        ); })}
      </div>

      {/* Category */}
      <div className="t-meta" style={{ marginBottom: 8 }}>{t('Categoria', 'Category')}</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7, marginBottom: 18, alignItems: 'center' }}>
        {cats.map(c => { const on = draft.cat === c.id; return (
          <button key={c.id} onClick={() => set({ cat: c.id })} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 13px', borderRadius: 99, fontSize: 12.5, fontWeight: 600, cursor: 'pointer', border: '1px solid ' + (on ? 'var(--ink)' : 'var(--hair)'), background: on ? 'var(--ink)' : 'var(--surface)', color: on ? '#fff' : 'var(--ink-2)' }}><span style={{ width: 8, height: 8, borderRadius: 99, background: c.color, display: on ? 'none' : 'inline-block' }} />{c.name[lang]}</button>); })}
        <button onClick={onCats} title={t('Gestisci categorie', 'Manage categories')} style={{ width: 32, height: 32, borderRadius: 99, border: '1px dashed var(--hair)', background: 'var(--surface)', cursor: 'pointer', display: 'grid', placeItems: 'center', color: 'var(--clay-ink)', flexShrink: 0 }}><Icon name="plus" size={15} color="var(--clay-ink)" /></button>
      </div>

      {/* Unit of measure */}
      <div className="t-meta" style={{ marginBottom: 8 }}>{t('Unità di misura', 'Unit of measure')}</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7, marginBottom: 18 }}>
        {UNIT_OPTIONS.map(u => { const on = curUnit === u[lang]; return (
          <button key={u.it} onClick={() => setUnit(u.it, u.en)} style={{ padding: '6px 13px', borderRadius: 99, fontSize: 12.5, fontWeight: 600, cursor: 'pointer', border: '1px solid ' + (on ? 'var(--ink)' : 'var(--hair)'), background: on ? 'var(--ink)' : 'var(--surface)', color: on ? '#fff' : 'var(--ink-2)' }}>{u[lang]}</button>
        ); })}
      </div>

      <FRow label={t('Scorta attuale', 'Current stock')} hint={t('· solo da Scarico / Carico rapido / Rettifica', '· only via Issue / Quick restock / Adjust')}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span className="t-num" style={{ fontSize: 22 }}>{draft.qty}</span>
          <span className="t-sm" style={{ color: 'var(--muted)' }}>{curUnit}</span>
          {draft.qty < draft.min && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, fontWeight: 700, color: 'var(--warn)', background: 'var(--warn-tint)', padding: '4px 10px', borderRadius: 99 }}><Icon name="alert" size={12} color="var(--warn)" />{t('Sottoscorta', 'Low')}</span>}
        </div>
      </FRow>
      <FRow label={t('Scorta minima', 'Minimum stock')} hint={t('Avviso sottoscorta', 'Low-stock alert')}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <NumBox value={draft.min} onChange={v => set({ min: v })} width={92} />
          {lowItem && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, fontWeight: 700, color: 'var(--warn)', background: 'var(--warn-tint)', padding: '4px 10px', borderRadius: 99 }}><Icon name="alert" size={12} color="var(--warn)" />{t('Sottoscorta', 'Low')}</span>}
        </div>
      </FRow>
      <FRow label={t('Valore unitario', 'Unit value')}><NumBox value={draft.value} onChange={v => set({ value: v })} suffix="€" /></FRow>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 16px', background: 'var(--surface-2)', borderRadius: 12, marginTop: 8 }}>
        <span className="t-sm" style={{ color: 'var(--muted)', fontWeight: 600 }}>{t('Valore totale a magazzino', 'Total stock value')}</span>
        <span className="t-num" style={{ fontSize: 22 }}>{draft.qty * draft.value === 0 ? '€0' : fmtEur(draft.qty * draft.value, lang)}</span>
      </div>
    </DkModal>
  );
}


function parseInvCsv(text, inv, lang, fallbackSupplier) {
  const rows = String(text).split(/\r?\n/).map(r => r.trim()).filter(Boolean);
  if (!rows.length) return [];
  const delim = (rows[0].match(/;/g) || []).length > (rows[0].match(/,/g) || []).length ? ';' : ',';
  let start = 0;
  if (/nome|name|prodotto|product|quant|qty|categoria|category/i.test(rows[0])) start = 1;
  const out = [];
  for (let i = start; i < rows.length; i++) {
    const cols = rows[i].split(delim).map(c => c.trim().replace(/^"(.*)"$/, '$1'));
    const name = cols[0]; if (!name) continue;
    const qty = parseInt(cols[1]) || 0;
    const catRaw = (cols[2] || '').toLowerCase();
    const unit = cols[3] || '';
    const value = parseFloat((cols[4] || '').replace(',', '.')) || 0;
    const supplier = (cols[5] || '').trim() || fallbackSupplier || '';
    const match = inv.find(p => (p.name.it || '').toLowerCase() === name.toLowerCase() || (p.name.en || '').toLowerCase() === name.toLowerCase());
    const cat = (INV_CATS.find(c => c.id === catRaw || c.name.it.toLowerCase() === catRaw || c.name.en.toLowerCase() === catRaw) || {}).id || 'consumabili';
    out.push(match
      ? { key: 'k' + i + '_' + Date.now(), existingId: match.id, name: match.name[lang], cat: match.cat, unit: match.unit[lang], value: match.value, qty, supplier: supplier || match.supplier || '' }
      : { key: 'k' + i + '_' + Date.now(), existingId: null, name, cat, unit: unit || 'pezzi', value, qty, supplier });
  }
  return out;
}

/* ---- Carico merce: batch restock (existing products) + CSV import ---- */
function RestockModal({ inv, onApply, onClose, t, lang, fireToast }) {
  const [lines, setLines] = useStateDmi([]);
  const [pickQ, setPickQ] = useStateDmi('');
  const [csvInfo, setCsvInfo] = useStateDmi(false);
  const [csvSupplier, setCsvSupplier] = useStateDmi('');
  const [causaleFile, setCausaleFile] = useStateDmi(null);
  const fileRef = useRefDmi(null);
  const lineSeq = useRefDmi(0);
  const keyOf = () => 'k' + (lineSeq.current++) + '_' + Date.now();

  const available = inv.filter(p => !lines.some(l => l.existingId === p.id) && (!pickQ || p.name[lang].toLowerCase().includes(pickQ.toLowerCase())));
  const addExisting = (p) => { setLines(ls => [...ls, { key: keyOf(), existingId: p.id, name: p.name[lang], cat: p.cat, unit: p.unit[lang], value: p.value, qty: 1 }]); setPickQ(''); };
  const setLine = (key, patch) => setLines(ls => ls.map(l => l.key === key ? { ...l, ...patch } : l));
  const rmLine = (key) => setLines(ls => ls.filter(l => l.key !== key));

  const onCsv = (e) => {
    const f = e.target.files && e.target.files[0]; if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      const parsed = parseInvCsv(reader.result, inv, lang, csvSupplier.trim());
      if (parsed.length) { setLines(ls => [...ls, ...parsed]); setCsvInfo(false); fireToast({ msg: t(parsed.length + ' righe importate dal CSV', parsed.length + ' rows imported from CSV'), icon: 'check' }); }
      else fireToast({ msg: t('Nessuna riga valida nel CSV', 'No valid rows in the CSV'), icon: 'alert' });
    };
    reader.readAsText(f);
    e.target.value = '';
  };

  const invById = (id) => inv.find(p => p.id === id);
  const totalUnits = lines.reduce((s, l) => s + (parseInt(l.qty) || 0), 0);
  const validLines = lines.filter(l => l.existingId ? (parseInt(l.qty) || 0) !== 0 : (l.name || '').trim() && (parseInt(l.qty) || 0) > 0);
  const canApply = validLines.length > 0;

  return (
    <DkModal open onClose={onClose} title={t('Carico merce', 'Receive stock')} sub={t('Seleziona i prodotti e indica le quantità in arrivo — si sommano alle scorte attuali', 'Pick products and enter incoming quantities — they add to current stock')} width={680}
      foot={<React.Fragment>
        <div style={{ marginRight: 'auto', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>

          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 7, border: '1px solid var(--hair)', borderRadius: 9, fontSize: 13, padding: '7px 11px', fontFamily: 'var(--sans)', background: 'var(--surface)', cursor: 'pointer', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: causaleFile ? 'var(--clay-ink)' : 'var(--muted)' }}><Icon name="arrowDn" size={14} color={causaleFile ? 'var(--clay-ink)' : 'var(--muted-2)'} /><span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 150 }}>{causaleFile ? causaleFile.name : t('Allega fattura (opz.)', 'Attach invoice (opt.)')}</span><input type="file" accept=".pdf,.jpg,.jpeg,.png" onChange={e => setCausaleFile(e.target.files[0] || null)} style={{ display: 'none' }} /></label>
          <span style={{ display: 'flex', alignItems: 'baseline', gap: 5 }}>
            <span className="t-sm" style={{ color: 'var(--muted)' }}>{t('Totale in arrivo', 'Total incoming')}</span>
            <span className="t-num" style={{ fontSize: 18 }}>{totalUnits > 0 ? '+' : ''}{totalUnits}</span>
          </span>
        </div>
        <button className="dk-btn dk-btn--ghost" onClick={onClose}>{t('Annulla', 'Cancel')}</button>
        <button className="dk-btn dk-btn--clay" disabled={!canApply} onClick={() => canApply && onApply(lines, null, causaleFile ? causaleFile.name : '')}><Icon name="check" size={17} color="#fff" />{t('Conferma carico', 'Confirm restock')}</button>
      </React.Fragment>}>

      {/* PRIMARY action: search an existing product */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
        <div className="dk-search" style={{ flex: 1, width: 'auto' }}>
          <Icon name="search" size={17} color="var(--muted-2)" />
          <input value={pickQ} autoFocus onChange={e => setPickQ(e.target.value)} placeholder={t('Cerca un prodotto da ricaricare…', 'Search a product to restock…')} />
          {pickQ && <button className="press" onClick={() => setPickQ('')} style={{ cursor: 'pointer', display: 'grid', placeItems: 'center' }}><Icon name="x" size={14} color="var(--muted-2)" /></button>}
        </div>
        <button className="dk-btn dk-btn--ghost" onClick={() => setCsvInfo(v => !v)} style={{ flexShrink: 0, ...(csvInfo ? { background: 'var(--surface-2)' } : {}) }}><Icon name="arrowDn" size={15} />CSV</button>
        <input ref={fileRef} type="file" accept=".csv,text/csv" onChange={onCsv} style={{ display: 'none' }} />
      </div>

      {/* product list — always visible (filtered by search), pick to add */}
      {!csvInfo && (
        <React.Fragment>
          <div className="t-meta" style={{ marginBottom: 8 }}>{pickQ ? t('Risultati', 'Results') : t('Tutti i prodotti', 'All products')}</div>
          <div className="dk-card" style={{ padding: 6, marginBottom: lines.length ? 14 : 0, maxHeight: 240, overflowY: 'auto', boxShadow: 'none', border: '1px solid var(--hair)' }}>
            {available.length === 0 && <div className="t-sm" style={{ color: 'var(--muted-2)', padding: '10px 12px' }}>{pickQ ? t('Nessun prodotto trovato con questo nome.', 'No product found with this name.') : t('Tutti i prodotti sono già in lista.', 'All products are already on the list.')}</div>}
            {available.map(p => { const lowItem = p.qty < p.min; return (
              <button key={p.id} className="dk-row" onClick={() => addExisting(p)} style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '9px 11px', borderRadius: 8, textAlign: 'left' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: 13.5 }}>{p.name[lang]}</div>
                  <div className="t-sm" style={{ color: lowItem ? 'var(--warn)' : 'var(--muted-2)', fontWeight: lowItem ? 700 : 400 }}>{t('Attuale', 'Current')}: {p.qty} {UNIT_LABEL[lang]}{lowItem ? ' · ' + t('sottoscorta', 'low stock') : ''}</div>
                </div>
                <Icon name="plus" size={15} color="var(--clay-ink)" />
              </button>
            ); })}
          </div>
        </React.Fragment>
      )}

      {/* CSV notice — appears only when CSV is clicked */}
      {csvInfo && (
        <div style={{ padding: '16px 18px', background: 'var(--surface-2)', borderRadius: 12, marginBottom: 12, border: '1px solid var(--hair)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 7 }}><Icon name="info" size={15} color="var(--muted)" /><span style={{ fontWeight: 600, fontSize: 13.5 }}>{t('Importazione da CSV', 'CSV import')}</span></div>
          <div className="t-sm" style={{ color: 'var(--muted)', lineHeight: 1.55 }}>
            {t('Cerca un prodotto esistente per sommargli le unità in arrivo. Con il CSV ne importi più insieme: i prodotti già presenti vengono ricaricati, quelli nuovi aggiunti — mai sovrascritti.', 'Search an existing product to add the incoming units. With CSV you import several at once: existing products are restocked, new ones added — never overwritten.')}
            <div style={{ marginTop: 8, fontFamily: 'var(--mono, monospace)', fontSize: 12, color: 'var(--ink-2)', background: 'var(--surface)', border: '1px solid var(--hair)', borderRadius: 8, padding: '8px 11px' }}>
              {t('Nome, Quantità, Categoria, Unità, Valore, Fornitore', 'Name, Quantity, Category, Unit, Value, Supplier')}<br />
              Base coat, 50, nail, flaconi, 11, NailPro
            </div>
          </div>
          {/* supplier applied to the whole CSV (used when a row has no supplier column) */}
          <div style={{ marginTop: 12 }}>
            <div className="t-meta" style={{ marginBottom: 6 }}>{t('Fornitore del carico', 'Shipment supplier')}</div>
            <input value={csvSupplier} onChange={e => setCsvSupplier(e.target.value)} placeholder={t('es. NailPro — assegnato ai prodotti del file', 'e.g. NailPro — assigned to the file’s products')} style={{ border: '1px solid var(--hair)', borderRadius: 9, outline: 'none', fontSize: 14, padding: '9px 12px', fontFamily: 'var(--sans)', background: 'var(--surface)', width: '100%', boxSizing: 'border-box' }} />
            <div className="t-sm" style={{ color: 'var(--muted-2)', marginTop: 5 }}>{t('Si applica a tutte le righe senza colonna “Fornitore”. Le scorte sono comunque monitorate.', 'Applied to every row without a “Supplier” column. Stock is monitored either way.')}</div>
          </div>
          <button className="dk-btn dk-btn--clay" onClick={() => fileRef.current && fileRef.current.click()} style={{ marginTop: 12 }}><Icon name="arrowDn" size={15} color="#fff" />{t('Seleziona file CSV', 'Choose CSV file')}</button>
        </div>
      )}

      {/* selected lines */}
      {lines.length > 0 && (
        <React.Fragment>
        <div className="t-meta" style={{ marginBottom: 8 }}>{t('In arrivo', 'Incoming')}</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {lines.map(l => {
            const cur = l.existingId ? invById(l.existingId) : null;
            const result = (cur ? cur.qty : 0) + (parseInt(l.qty) || 0);
            return (
              <div key={l.key} className="dk-card" style={{ padding: '12px 14px', boxShadow: 'none', border: '1px solid var(--hair)', display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: 14.5, display: 'flex', alignItems: 'center', gap: 8 }}>
                    {l.name}
                    {!l.existingId && <span style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--clay-ink)', background: 'var(--clay-tint)', padding: '2px 8px', borderRadius: 99 }}>{t('Nuovo', 'New')}</span>}
                  </div>
                  <div className="t-sm" style={{ color: 'var(--muted-2)', marginTop: 1 }}>
                    {l.existingId
                      ? <React.Fragment>{t('Attuale', 'Current')}: {cur ? cur.qty : 0} {UNIT_LABEL[lang]} <span style={{ color: 'var(--clay-ink)', fontWeight: 700 }}>→ {result} {UNIT_LABEL[lang]}</span></React.Fragment>
                      : <React.Fragment>{t('Nuovo prodotto dal CSV', 'New product from CSV')}{l.supplier ? ' · ' + l.supplier : ''}</React.Fragment>}
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
                  <span className="t-sm" style={{ color: 'var(--muted-2)', fontWeight: 700 }}>+</span>
                  <NumBox value={parseInt(l.qty) || 0} onChange={v => setLine(l.key, { qty: Math.max(0, v) })} width={104} />
                </div>
                <button className="dk-iconbtn" onClick={() => rmLine(l.key)} style={{ width: 32, height: 32, borderRadius: 8, flexShrink: 0, color: 'var(--muted-2)' }}><Icon name="x" size={15} /></button>
              </div>
            );
          })}
        </div>
        </React.Fragment>
      )}
    </DkModal>
  );
}

/* ---------------- Fornitori & Storico (sotto-sezioni Magazzino) ---------------- */
const MOVES_SEED = [
  { id: 's1', when: { it: '9 nov · 10:20', en: '9 Nov · 10:20' }, type: 'carico', productId: 'p6', productName: { it: 'Cotone in dischetti', en: 'Cotton pads' }, delta: 20, note: { it: 'Carico merce', en: 'Restock' } },
  { id: 's2', when: { it: '8 nov · 16:05', en: '8 Nov · 16:05' }, type: 'scarico', productId: 'p1', productName: { it: 'Smalto gel rosso “Carmine”', en: 'Gel polish red “Carmine”' }, delta: -2, note: { it: 'Vendita · Ricostruzione gel', en: 'Sale · Gel build' } },
  { id: 's3', when: { it: '7 nov · 11:30', en: '7 Nov · 11:30' }, type: 'rettifica', productId: 'p3', productName: { it: 'Tinta 6.0 castano', en: 'Colour 6.0 brown' }, delta: -1, note: { it: 'Rettifica inventario · prodotto scaduto', en: 'Inventory adjustment · expired' } },
  { id: 's4', when: { it: '5 nov · 09:15', en: '5 Nov · 09:15' }, type: 'carico', productId: 'p3', productName: { it: 'Tinta 6.0 castano', en: 'Colour 6.0 brown' }, delta: 12, note: { it: 'Carico merce', en: 'Restock' } },
  { id: 's5', when: { it: '4 nov · 14:40', en: '4 Nov · 14:40' }, type: 'scarico', productId: 'p5', productName: { it: 'Maschera ristrutturante', en: 'Repair mask' }, delta: -1, note: { it: 'Vendita · al banco', en: 'Sale · retail' } },
];
const MOVE_META = {
  carico:        { icon: 'arrowDn', color: 'var(--ok)',     tint: 'var(--ok-tint)',     it: 'Carico',       en: 'Stock in' },
  scarico:       { icon: 'arrowUp', color: 'var(--muted)',  tint: 'var(--surface-2)',   it: 'Scarico',      en: 'Stock out' },
  rettifica:     { icon: 'edit',    color: 'var(--warn)',   tint: 'var(--warn-tint)',   it: 'Rettifica',    en: 'Adjustment' },
  trasferimento: { icon: 'refresh', color: 'var(--info)',   tint: 'var(--surface-2)',   it: 'Trasferimento',en: 'Transfer' },
};
const NATURE_META = {
  vendita:  { it: 'Vendita',     en: 'Retail',    color: 'var(--ok)',   tint: 'var(--ok-tint)' },
  interno:  { it: 'Uso interno', en: 'In-salon',  color: 'var(--info)', tint: 'var(--surface-2)' },
  entrambi: { it: 'Misto',    en: 'Mixed',      color: 'var(--clay-ink)', tint: 'var(--clay-tint)' },
};
const UNIT_OPTIONS = [
  { it: 'pezzi',        en: 'pcs' },
  { it: 'flaconi',      en: 'bottles' },
  { it: 'tubi',         en: 'tubes' },
  { it: 'litri',        en: 'litres' },
  { it: 'ml',           en: 'ml' },
  { it: 'g',            en: 'g' },
  { it: 'vasetti',      en: 'jars' },
  { it: 'confezioni',   en: 'packs' },
  { it: 'unità',        en: 'units' },
];


function StoricoSub({ moves, t, lang }) {
  const [filt, setFilt] = useStateDmi('all');
  const tabs = [['all', t('Tutti', 'All')], ['carico', t('Carico', 'Stock in')], ['scarico', t('Scarico', 'Stock out')], ['rettifica', t('Rettifiche', 'Adjustments')], ['trasferimento', t('Trasferimenti', 'Transfers')]];
  const list = moves.filter(m => filt === 'all' || m.type === filt);
  return (
    <React.Fragment>
      <div style={{ display: 'flex', gap: 7, marginBottom: 18, flexWrap: 'wrap' }}>
        {tabs.map(([k, l]) => { const on = filt === k; return (
          <button key={k} onClick={() => setFilt(k)} style={{ padding: '7px 14px', borderRadius: 99, fontSize: 13, fontWeight: 600, cursor: 'pointer', border: '1px solid ' + (on ? 'var(--ink)' : 'var(--hair)'), background: on ? 'var(--ink)' : 'var(--surface)', color: on ? '#fff' : 'var(--ink-2)' }}>{l}</button>); })}
      </div>
      <div className="dk-card" style={{ overflow: 'hidden' }}>
        {list.map((m, i) => { const meta = MOVE_META[m.type] || MOVE_META.rettifica; const nm = typeof m.productName === 'object' ? m.productName[lang] : m.productName; return (
          <div key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '13px 20px', borderTop: i ? '1px solid var(--hair)' : 'none' }}>
            <div style={{ width: 34, height: 34, borderRadius: 10, background: meta.tint, display: 'grid', placeItems: 'center', flexShrink: 0 }}><Icon name={meta.icon} size={16} color={meta.color} /></div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600, fontSize: 14 }}>{nm}</div>
              <div className="t-sm" style={{ color: 'var(--muted)', marginTop: 1 }}>{m.note ? m.note[lang] : meta[lang]} · {m.when[lang]}</div>
            </div>
            <div className="t-num" style={{ fontSize: 15, fontWeight: 700, color: m.delta > 0 ? 'var(--ok)' : 'var(--ink-2)', flexShrink: 0 }}>{m.delta > 0 ? '+' : ''}{m.delta} {t('unità', 'units')}</div>
          </div>
        ); })}
        {!list.length && <div style={{ padding: '36px 22px' }}><EmptyState icon="clock" title={t('Nessun movimento', 'No movements')} sub={t('Carichi, vendite e rettifiche compariranno qui.', 'Restocks, sales and adjustments will appear here.')} /></div>}
      </div>
    </React.Fragment>
  );
}

/* ───────────── Ordini fornitori (purchase-order drafts grouped by supplier) ───────────── */
const ORDER_METHODS = {
  email:    { it: 'Email',    en: 'Email',    icon: 'mail' },
  whatsapp: { it: 'WhatsApp', en: 'WhatsApp', icon: 'whatsapp' },
  pdf:      { it: 'PDF',      en: 'PDF',      icon: 'arrowDn' },
};
// preferred send method + contact per supplier (configurable)
const SUPPLIER_CONFIG_SEED = {
  'NailPro':       { method: 'whatsapp', email: 'ordini@nailpro.it',     phone: '+39 02 4455 119' },
  'Beauty Dist.':  { method: 'email',    email: 'ordini@beautydist.it',  phone: '+39 06 7788 220' },
  'Derma Supply':  { method: 'email',    email: 'sales@dermasupply.eu',  phone: '+39 011 332 9087' },
};
const supContact = (cfg) => cfg ? (cfg.method === 'whatsapp' ? (cfg.phone || cfg.email) : (cfg.email || cfg.phone)) : '';
function suggestQty(p) {
  if (p.reorderQty && p.reorderQty > 0) return p.reorderQty;
  return Math.max(1, (p.min || 0) * 2 - (p.qty || 0));
}
function orderLineMath(ln) {
  const net = ln.qty * (ln.cost || 0);
  const vat = net * (ln.vat || 0) / 100;
  return { net, vat, total: net + vat };
}
function downloadOrderPdf(s, lines, cfg, lang) {
  const tt = (it, en) => lang === 'en' ? en : it;
  const eur = (n) => '€' + n.toLocaleString(lang === 'en' ? 'en-GB' : 'it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const today = new Date().toLocaleDateString(lang === 'en' ? 'en-GB' : 'it-IT', { day: '2-digit', month: 'long', year: 'numeric' });
  let net = 0, vat = 0;
  const rows = lines.map(l => {
    const m = orderLineMath(l); net += m.net; vat += m.vat;
    return `<tr><td>${l.name[lang]}${l.sku ? ' <span class="sku">· ' + l.sku + '</span>' : ''}</td><td class="r">${l.qty} ${(l.unit && l.unit[lang]) || ''}</td><td class="r">${eur(l.cost)}</td><td class="r">${l.vat}%</td><td class="r">${eur(m.total)}</td></tr>`;
  }).join('');
  const contact = supContact(cfg[s]);
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${tt('Ordine', 'Order')} — ${s}</title><style>
    @page { size: A4; margin: 22mm; }
    body { font-family: Inter, -apple-system, system-ui, sans-serif; color: #2C2C2F; font-size: 13px; }
    h1 { font-size: 22px; font-weight: 600; margin: 0; letter-spacing: .04em; }
    .muted { color: #6F6E74; }
    .head { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #1F1F21; padding-bottom: 14px; margin-bottom: 22px; }
    .to { margin-bottom: 22px; }
    .to .lbl { text-transform: uppercase; letter-spacing: .12em; font-size: 10px; color: #6F6E74; margin-bottom: 4px; }
    .to .name { font-size: 16px; font-weight: 700; }
    table { width: 100%; border-collapse: collapse; margin-top: 8px; }
    th { text-align: left; text-transform: uppercase; letter-spacing: .08em; font-size: 10px; color: #6F6E74; border-bottom: 1px solid #D8D6DC; padding: 8px 6px; }
    td { padding: 9px 6px; border-bottom: 1px solid #ECEAEE; }
    .r { text-align: right; }
    .sku { color: #93919A; font-size: 11px; }
    .tot { margin-top: 18px; margin-left: auto; width: 240px; }
    .tot .row { display: flex; justify-content: space-between; padding: 5px 0; }
    .tot .grand { border-top: 2px solid #1F1F21; margin-top: 4px; padding-top: 8px; font-size: 17px; font-weight: 800; }
  </style></head><body>
    <div class="head"><div><h1>THE PARLOUR</h1><div class="muted">${tt("Buono d'ordine", 'Purchase order')} · ${today}</div></div><div class="muted r">${tt('Rif.', 'Ref.')} PO-${Date.now().toString().slice(-6)}</div></div>
    <div class="to"><div class="lbl">${tt('Fornitore', 'Supplier')}</div><div class="name">${s}</div>${contact ? '<div class="muted">' + contact + '</div>' : ''}</div>
    <table><thead><tr><th>${tt('Prodotto', 'Product')}</th><th class="r">${tt('Quantità', 'Qty')}</th><th class="r">${tt('Prezzo un.', 'Unit price')}</th><th class="r">IVA</th><th class="r">${tt('Totale', 'Total')}</th></tr></thead><tbody>${rows}</tbody></table>
    <div class="tot"><div class="row"><span class="muted">${tt('Imponibile', 'Net')}</span><span>${eur(net)}</span></div><div class="row"><span class="muted">IVA</span><span>${eur(vat)}</span></div><div class="row grand"><span>${tt('Totale', 'Total')}</span><span>${eur(net + vat)}</span></div></div>
    <script>window.onload=function(){setTimeout(function(){window.print();},250);};<\/script>
  </body></html>`;
  const w = window.open('', '_blank');
  if (w) { w.document.write(html); w.document.close(); }
  return !!w;
}

function FornitoriSub({ inv, suppliers, setSuppliers, t, lang, fireToast }) {
  const [edit, setEdit] = useStateDmi(null); // supplier name being edited
  const [draft, setDraft] = useStateDmi(null);
  const [addOpen, setAddOpen] = useStateDmi(false);
  const [nw, setNw] = useStateDmi({ name: '', email: '', phone: '', method: 'email', address: '', vat: '', sdi: '', notes: '' });
  // suppliers in use across products + any in the registry
  const names = [...new Set([...inv.map(p => (p.supplier || '').trim()).filter(Boolean), ...Object.keys(suppliers)])].sort((a, b) => a.localeCompare(b));
  const countOf = (s) => inv.filter(p => (p.supplier || '').trim() === s).length;
  const openEdit = (s) => { setEdit(s); setDraft({ email: (suppliers[s] || {}).email || '', phone: (suppliers[s] || {}).phone || '', method: (suppliers[s] || {}).method || 'email', address: (suppliers[s] || {}).address || '', vat: (suppliers[s] || {}).vat || '', sdi: (suppliers[s] || {}).sdi || '', notes: (suppliers[s] || {}).notes || '' }); };
  const saveEdit = () => { setSuppliers(c => ({ ...c, [edit]: { ...(c[edit] || {}), email: draft.email.trim(), phone: draft.phone.trim(), method: draft.method, address: draft.address.trim(), vat: draft.vat.trim(), sdi: draft.sdi.trim(), notes: draft.notes.trim() } })); fireToast({ msg: t(`Fornitore ${edit} aggiornato · propagato a ${countOf(edit)} prodotti`, `Supplier ${edit} updated · propagated to ${countOf(edit)} products`), icon: 'check' }); setEdit(null); setDraft(null); };
  const addSupplier = () => { const nm = nw.name.trim(); if (!nm) return; setSuppliers(c => ({ ...c, [nm]: { method: nw.method, email: nw.email.trim(), phone: nw.phone.trim(), address: nw.address.trim(), vat: nw.vat.trim(), sdi: nw.sdi.trim(), notes: nw.notes.trim() } })); setAddOpen(false); setNw({ name: '', email: '', phone: '', method: 'email', address: '', vat: '', sdi: '', notes: '' }); fireToast({ msg: t(`Fornitore ${nm} creato`, `Supplier ${nm} created`), icon: 'check' }); };
  const inputCss = { border: '1px solid var(--hair)', borderRadius: 9, outline: 'none', fontSize: 14, padding: '9px 12px', fontFamily: 'var(--sans)', background: 'var(--surface)', width: '100%', boxSizing: 'border-box' };
  return (
    <React.Fragment>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 18 }}>
        <div className="t-sm" style={{ color: 'var(--muted)', flex: 1 }}>{t('Anagrafica fornitori. Modificando qui un contatto (es. l’email), l’aggiornamento si applica automaticamente a tutti i prodotti di quel fornitore.', 'Supplier directory. Editing a contact here (e.g. the email) automatically applies to all products from that supplier.')}</div>
        <button className="dk-btn dk-btn--clay" style={{ flexShrink: 0 }} onClick={() => setAddOpen(true)}><Icon name="plus" size={16} color="#fff" />{t('Nuovo fornitore', 'New supplier')}</button>
      </div>

      {addOpen && (
        <div className="dk-card" style={{ padding: 18, marginBottom: 14, border: '1px solid var(--clay)' }}>
          <div className="t-meta" style={{ marginBottom: 12 }}>{t('Nuovo fornitore', 'New supplier')}</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
            <div style={{ gridColumn: '1 / -1' }}><div className="t-meta" style={{ marginBottom: 5 }}>{t('Nome', 'Name')}</div><input value={nw.name} onChange={e => setNw(f => ({ ...f, name: e.target.value }))} style={inputCss} /></div>
            <div><div className="t-meta" style={{ marginBottom: 5 }}>Email</div><input value={nw.email} onChange={e => setNw(f => ({ ...f, email: e.target.value }))} style={inputCss} /></div>
            <div><div className="t-meta" style={{ marginBottom: 5 }}>{t('Telefono', 'Phone')}</div><input value={nw.phone} onChange={e => setNw(f => ({ ...f, phone: e.target.value }))} style={inputCss} /></div>
            <div style={{ gridColumn: '1 / -1' }}><div className="t-meta" style={{ marginBottom: 5 }}>{t('Indirizzo', 'Address')}</div><input value={nw.address} onChange={e => setNw(f => ({ ...f, address: e.target.value }))} placeholder={t('Via, civico, città, CAP', 'Street, city, ZIP')} style={inputCss} /></div>
            <div><div className="t-meta" style={{ marginBottom: 5 }}>{t('Partita IVA', 'VAT no.')}</div><input value={nw.vat} onChange={e => setNw(f => ({ ...f, vat: e.target.value }))} placeholder="IT01234567890" style={inputCss} /></div>
            <div><div className="t-meta" style={{ marginBottom: 5 }}>{t('Codice SDI / PEC', 'SDI code / PEC')}</div><input value={nw.sdi} onChange={e => setNw(f => ({ ...f, sdi: e.target.value }))} placeholder="es. ABCDEFG" style={inputCss} /></div>
            <div style={{ gridColumn: '1 / -1' }}><div className="t-meta" style={{ marginBottom: 5 }}>{t('Note', 'Notes')}</div><input value={nw.notes} onChange={e => setNw(f => ({ ...f, notes: e.target.value }))} placeholder={t('es. ordine minimo, tempi di consegna…', 'e.g. minimum order, lead times…')} style={inputCss} /></div>
          </div>
          <div className="t-meta" style={{ marginBottom: 6 }}>{t('Metodo d’ordine preferito', 'Preferred order method')}</div>
          <div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
            {Object.entries(ORDER_METHODS).map(([k, m]) => { const on = nw.method === k; return <button key={k} onClick={() => setNw(f => ({ ...f, method: k }))} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 13px', borderRadius: 9, fontSize: 13, fontWeight: 700, cursor: 'pointer', border: '1px solid ' + (on ? 'var(--clay)' : 'var(--hair)'), background: on ? 'var(--clay-tint)' : 'var(--surface)', color: on ? 'var(--clay-ink)' : 'var(--ink-2)' }}><Icon name={m.icon} size={14} color={on ? 'var(--clay-ink)' : 'var(--muted)'} />{m[lang]}</button>; })}
          </div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button className="dk-btn dk-btn--ghost" onClick={() => setAddOpen(false)}>{t('Annulla', 'Cancel')}</button>
            <button className="dk-btn dk-btn--clay" disabled={!nw.name.trim()} onClick={addSupplier}><Icon name="check" size={16} color="#fff" />{t('Crea', 'Create')}</button>
          </div>
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {names.map(s => {
          const cfg = suppliers[s] || {};
          const isEdit = edit === s;
          return (
            <div key={s} className="dk-card" style={{ padding: 18, border: '1px solid ' + (isEdit ? 'var(--clay)' : 'var(--hair)') }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14 }}>
                <div style={{ width: 42, height: 42, borderRadius: 11, background: 'var(--clay-tint)', display: 'grid', placeItems: 'center', flexShrink: 0 }}><Icon name="box" size={20} color="var(--clay-ink)" /></div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 3 }}>
                    <span style={{ fontFamily: 'var(--serif)', fontSize: 18, fontWeight: 500 }}>{s}</span>
                    <span style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--clay-ink)', background: 'var(--clay-tint)', padding: '2px 9px', borderRadius: 99 }}>{countOf(s)} {t('prodotti', 'products')}</span>
                  </div>
                  {!isEdit && <div className="t-sm" style={{ color: 'var(--muted)', display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><Icon name="mail" size={14} color="var(--muted-2)" />{cfg.email || '—'}</span>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><Icon name="whatsapp" size={14} color="var(--muted-2)" />{cfg.phone || '—'}</span>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>{t('Ordine via', 'Order via')} <b style={{ color: 'var(--ink-2)' }}>{(ORDER_METHODS[cfg.method] || ORDER_METHODS.email)[lang]}</b></span>
                    {cfg.address && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><Icon name="mapPin" size={14} color="var(--muted-2)" />{cfg.address}</span>}
                    {cfg.vat && <span>P.IVA {cfg.vat}</span>}
                    {cfg.sdi && <span>SDI {cfg.sdi}</span>}
                  </div>}
                </div>
                {!isEdit && <button className="dk-btn dk-btn--ghost" style={{ flexShrink: 0 }} onClick={() => openEdit(s)}><Icon name="edit" size={15} />{t('Modifica', 'Edit')}</button>}
              </div>
              {isEdit && (
                <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--hair)' }}>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
                    <div><div className="t-meta" style={{ marginBottom: 5 }}>Email</div><input value={draft.email} onChange={e => setDraft(d => ({ ...d, email: e.target.value }))} style={inputCss} /></div>
                    <div><div className="t-meta" style={{ marginBottom: 5 }}>{t('Telefono', 'Phone')}</div><input value={draft.phone} onChange={e => setDraft(d => ({ ...d, phone: e.target.value }))} style={inputCss} /></div>
                    <div style={{ gridColumn: '1 / -1' }}><div className="t-meta" style={{ marginBottom: 5 }}>{t('Indirizzo', 'Address')}</div><input value={draft.address} onChange={e => setDraft(d => ({ ...d, address: e.target.value }))} placeholder={t('Via, civico, città, CAP', 'Street, city, ZIP')} style={inputCss} /></div>
                    <div><div className="t-meta" style={{ marginBottom: 5 }}>{t('Partita IVA', 'VAT no.')}</div><input value={draft.vat} onChange={e => setDraft(d => ({ ...d, vat: e.target.value }))} placeholder="IT01234567890" style={inputCss} /></div>
                    <div><div className="t-meta" style={{ marginBottom: 5 }}>{t('Codice SDI / PEC', 'SDI code / PEC')}</div><input value={draft.sdi} onChange={e => setDraft(d => ({ ...d, sdi: e.target.value }))} placeholder="es. ABCDEFG" style={inputCss} /></div>
                    <div style={{ gridColumn: '1 / -1' }}><div className="t-meta" style={{ marginBottom: 5 }}>{t('Note', 'Notes')}</div><input value={draft.notes} onChange={e => setDraft(d => ({ ...d, notes: e.target.value }))} placeholder={t('es. ordine minimo, tempi di consegna…', 'e.g. minimum order, lead times…')} style={inputCss} /></div>
                  </div>
                  <div className="t-meta" style={{ marginBottom: 6 }}>{t('Metodo d’ordine preferito', 'Preferred order method')}</div>
                  <div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
                    {Object.entries(ORDER_METHODS).map(([k, m]) => { const on = draft.method === k; return <button key={k} onClick={() => setDraft(d => ({ ...d, method: k }))} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 13px', borderRadius: 9, fontSize: 13, fontWeight: 700, cursor: 'pointer', border: '1px solid ' + (on ? 'var(--clay)' : 'var(--hair)'), background: on ? 'var(--clay-tint)' : 'var(--surface)', color: on ? 'var(--clay-ink)' : 'var(--ink-2)' }}><Icon name={m.icon} size={14} color={on ? 'var(--clay-ink)' : 'var(--muted)'} />{m[lang]}</button>; })}
                  </div>
                  <div className="t-sm" style={{ color: 'var(--muted-2)', marginBottom: 12 }}>{t(`La modifica si applicherà a ${countOf(s)} prodotti di questo fornitore.`, `Changes will apply to ${countOf(s)} products from this supplier.`)}</div>
                  <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                    <button className="dk-btn dk-btn--ghost" onClick={() => { setEdit(null); setDraft(null); }}>{t('Annulla', 'Cancel')}</button>
                    <button className="dk-btn dk-btn--clay" onClick={saveEdit}><Icon name="check" size={16} color="#fff" />{t('Salva', 'Save')}</button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
        {!names.length && <div className="dk-card" style={{ overflow: 'hidden' }}><div style={{ padding: '40px 22px' }}><EmptyState icon="box" title={t('Nessun fornitore', 'No suppliers')} sub={t('Aggiungi un fornitore o assegnalo a un prodotto.', 'Add a supplier or assign one to a product.')} /></div></div>}
      </div>
    </React.Fragment>
  );
}

function OrdiniSub({ inv, cfg: cfgProp, setCfg: setCfgProp, t, lang, fireToast, onReceive }) {
  const NO_SUP = t('Senza fornitore', 'No supplier');
  const supplierOf = (p) => (p.supplier || '').trim() || NO_SUP;
  const [cfgLocal, setCfgLocal] = useStateDmi(() => ({ ...SUPPLIER_CONFIG_SEED }));
  const cfg = cfgProp || cfgLocal; const setCfg = setCfgProp || setCfgLocal;
  const [sent, setSent] = useStateDmi({});           // { supplier: 'oggi · 14:30' }
  const [received, setReceived] = useStateDmi({});    // { supplier: { at, discrepancies: [{name, ordered, received}] } }
  const [receiving, setReceiving] = useStateDmi(null); // supplier currently being received
  const [recv, setRecv] = useStateDmi({});           // { lineId: receivedQty }
  const [recvCsv, setRecvCsv] = useStateDmi(null);   // csv textarea string or null
  const [addFor, setAddFor] = useStateDmi(null);     // supplier name whose add-search is open
  const [addQ, setAddQ] = useStateDmi('');
  const [newSupOpen, setNewSupOpen] = useStateDmi(false);
  const [newSup, setNewSup] = useStateDmi({ name: '', contact: '', method: 'email' });
  const mkLine = (p) => ({ id: p.id, name: p.name, sku: p.sku, brand: p.brand, unit: p.unit, stock: p.qty, min: p.min, qty: suggestQty(p), cost: p.cost || p.value || 0, vat: p.vat != null ? p.vat : 22 });
  // auto-draft: low-stock products grouped by supplier
  const [orders, setOrders] = useStateDmi(() => {
    const m = {};
    inv.filter(p => p.qty < p.min).forEach(p => { const s = supplierOf(p); (m[s] = m[s] || []).push(mkLine(p)); });
    return m;
  });
  const [manualSups, setManualSups] = useStateDmi([]); // names of manually-added empty drafts

  const methodOf = (s) => (cfg[s] && cfg[s].method) || 'email';
  const setMethod = (s, method) => setCfg(c => ({ ...c, [s]: { ...(c[s] || {}), method } }));
  const setLine = (s, id, patch) => setOrders(o => ({ ...o, [s]: o[s].map(l => l.id === id ? { ...l, ...patch } : l) }));
  const removeLine = (s, id) => setOrders(o => { const next = (o[s] || []).filter(l => l.id !== id); return { ...o, [s]: next }; });
  const addProduct = (s, p) => { setOrders(o => ({ ...o, [s]: [...(o[s] || []), mkLine(p)] })); setAddFor(null); setAddQ(''); };
  const confirmOrder = (s) => {
    const d = new Date(); const hh = String(d.getHours()).padStart(2, '0'); const mm = String(d.getMinutes()).padStart(2, '0');
    setSent(x => ({ ...x, [s]: t('oggi · ', 'today · ') + hh + ':' + mm }));
    const meta = ORDER_METHODS[methodOf(s)];
    fireToast({ msg: t(`Ordine inviato a ${s} via ${meta.it}`, `Order sent to ${s} via ${meta.en}`), icon: 'check' });
  };
  const onPdf = (s, lines) => { const ok = downloadOrderPdf(s, lines, cfg, lang); fireToast({ msg: ok ? t('PDF ordine generato · pronto da inoltrare', 'Order PDF generated · ready to forward') : t('Consenti i popup per scaricare il PDF', 'Allow popups to download the PDF'), icon: ok ? 'check' : 'alert' }); };
  // delivery receiving
  const startReceive = (s) => { const init = {}; (orders[s] || []).forEach(l => { init[l.id] = l.qty; }); setRecv(init); setReceiving(s); setRecvCsv(null); };
  const cancelReceive = () => { setReceiving(null); setRecv({}); setRecvCsv(null); };
  const setRecvQty = (id, q) => setRecv(r => ({ ...r, [id]: Math.max(0, parseInt(q) || 0) }));
  const applyRecvCsv = (s) => {
    const lines = orders[s] || [];
    const rows = (recvCsv || '').split(/\n+/).map(r => r.trim()).filter(Boolean);
    let matched = 0; const next = { ...recv };
    rows.forEach(row => {
      const parts = row.split(/[,;\t]/).map(x => x.trim());
      if (parts.length < 2) return;
      const key = parts[0].toLowerCase(); const qty = parseInt(parts[parts.length - 1]);
      if (isNaN(qty)) return;
      const hit = lines.find(l => (l.name[lang] || '').toLowerCase() === key || (l.name.it || '').toLowerCase() === key || (l.sku || '').toLowerCase() === key);
      if (hit) { next[hit.id] = Math.max(0, qty); matched++; }
    });
    setRecv(next); setRecvCsv(null);
    fireToast({ msg: matched ? t(`${matched} righe aggiornate dal CSV`, `${matched} rows updated from CSV`) : t('Nessuna corrispondenza trovata', 'No matches found'), icon: matched ? 'check' : 'alert' });
  };
  const confirmReceive = (s) => {
    const lines = orders[s] || [];
    const applied = lines.map(l => ({ id: l.id, name: l.name, received: recv[l.id] != null ? recv[l.id] : 0, ordered: l.qty }));
    if (onReceive) onReceive(applied);
    const discrepancies = applied.filter(l => l.received !== l.ordered).map(l => ({ name: l.name, ordered: l.ordered, received: l.received }));
    const d = new Date(); const hh = String(d.getHours()).padStart(2, '0'); const mm = String(d.getMinutes()).padStart(2, '0');
    setReceived(x => ({ ...x, [s]: { at: t('oggi · ', 'today · ') + hh + ':' + mm, discrepancies } }));
    setReceiving(null); setRecv({}); setRecvCsv(null);
    fireToast({ msg: discrepancies.length ? t(`Consegna registrata · ${discrepancies.length} discrepanze`, `Delivery recorded · ${discrepancies.length} discrepancies`) : t('Consegna registrata · magazzino aggiornato', 'Delivery recorded · stock updated'), icon: 'check' });
  };
  const createSupplier = () => {
    const nm = newSup.name.trim(); if (!nm) return;
    setCfg(c => ({ ...c, [nm]: { method: newSup.method, email: newSup.method === 'whatsapp' ? '' : newSup.contact.trim(), phone: newSup.method === 'whatsapp' ? newSup.contact.trim() : '' } }));
    setOrders(o => ({ ...o, [nm]: o[nm] || [] }));
    setManualSups(l => l.includes(nm) ? l : [...l, nm]);
    setNewSupOpen(false); setNewSup({ name: '', contact: '', method: 'email' });
    setAddFor(nm); setAddQ('');
    fireToast({ msg: t('Fornitore aggiunto · aggiungi i prodotti', 'Supplier added · add products'), icon: 'check' });
  };

  // show suppliers that have lines OR were manually added
  const supplierNames = [...new Set([...Object.keys(orders).filter(s => (orders[s] || []).length), ...manualSups])];
  const addable = (s) => {
    const inDraft = new Set((orders[s] || []).map(l => l.id));
    return inv.filter(p => !inDraft.has(p.id) && (!addQ || p.name[lang].toLowerCase().includes(addQ.toLowerCase()) || (p.sku || '').toLowerCase().includes(addQ.toLowerCase())))
      .sort((a, b) => (supplierOf(a) === s ? 0 : 1) - (supplierOf(b) === s ? 0 : 1));
  };

  const inputCss = { border: '1px solid var(--hair)', borderRadius: 8, outline: 'none', fontSize: 13, padding: '7px 9px', fontFamily: 'var(--sans)', background: 'var(--surface)', width: '100%', boxSizing: 'border-box' };

  return (
    <React.Fragment>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14, marginBottom: 18 }}>
        <div className="t-sm" style={{ color: 'var(--muted)', flex: 1 }}>{t('Bozze d\'ordine generate automaticamente dai prodotti sotto soglia, raggruppate per fornitore. Regola le quantità, aggiungi prodotti e invia con il metodo preferito o scarica il PDF da inoltrare.', 'Purchase-order drafts auto-generated from below-threshold products, grouped by supplier. Adjust quantities, add products and send via the preferred method or download the PDF to forward.')}</div>
      </div>

      {supplierNames.length === 0 && <div className="dk-card" style={{ overflow: 'hidden' }}><div style={{ padding: '40px 22px' }}><EmptyState icon="check" title={t('Nessun riordino necessario', 'No reorders needed')} sub={t('Tutti i prodotti sono sopra la soglia minima.', 'All products are above their minimum threshold.')} /></div></div>}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        {supplierNames.map(s => {
          const lines = orders[s] || [];
          const method = methodOf(s);
          const isSent = sent[s];
          const grandNet = lines.reduce((a, l) => a + orderLineMath(l).net, 0);
          const grandVat = lines.reduce((a, l) => a + orderLineMath(l).vat, 0);
          const grandTot = grandNet + grandVat;
          const contact = supContact(cfg[s]);
          const isReceiving = receiving === s;
          const isReceived = received[s];
          const recvTotal = lines.reduce((a, l) => a + (recv[l.id] != null ? recv[l.id] : 0), 0);
          return (
            <div key={s} className="dk-card" style={{ overflow: 'hidden', opacity: isReceived ? 0.78 : 1 }}>
              {/* supplier header */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '16px 20px', borderBottom: '1px solid var(--hair)', flexWrap: 'wrap' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap' }}>
                    <span style={{ fontFamily: 'var(--serif)', fontSize: 18, fontWeight: 500 }}>{s}</span>
                    <span style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--clay-ink)', background: 'var(--clay-tint)', padding: '2px 9px', borderRadius: 99 }}>{lines.length} {t('articoli', 'items')}</span>
                    {isReceived ? <span style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--ok)', background: 'var(--ok-tint)', padding: '2px 9px', borderRadius: 99, display: 'inline-flex', alignItems: 'center', gap: 4 }}><Icon name="box" size={12} color="var(--ok)" />{t('Consegnato', 'Received')} {isReceived.at}{isReceived.discrepancies.length ? ' · ' + isReceived.discrepancies.length + ' ' + t('discrepanze', 'discrepancies') : ''}</span>
                      : isSent ? <span style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--ok)', background: 'var(--ok-tint)', padding: '2px 9px', borderRadius: 99, display: 'inline-flex', alignItems: 'center', gap: 4 }}><Icon name="check" size={12} color="var(--ok)" stroke={2.4} />{t('Inviato', 'Sent')} {isSent}</span> : null}
                  </div>
                  {contact && <div className="t-sm" style={{ color: 'var(--muted)', marginTop: 3 }}>{ORDER_METHODS[method][lang]} · {contact}</div>}
                </div>
                {/* send-method selector */}
                {!isReceiving && !isReceived && <div style={{ display: 'flex', gap: 4, background: 'var(--surface-2)', borderRadius: 10, padding: 4, flexShrink: 0 }}>
                  {Object.entries(ORDER_METHODS).map(([k, meta]) => { const on = method === k; return (
                    <button key={k} onClick={() => setMethod(s, k)} title={meta[lang]} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '7px 12px', borderRadius: 8, fontSize: 12.5, fontWeight: 700, cursor: 'pointer', border: 'none', background: on ? 'var(--surface)' : 'transparent', color: on ? 'var(--ink)' : 'var(--muted)', boxShadow: on ? 'var(--sh-card)' : 'none' }}><Icon name={meta.icon} size={15} color={on ? 'var(--clay-ink)' : 'var(--muted)'} />{meta[lang]}</button>
                  ); })}
                </div>}
              </div>

              {isReceiving ? (
                /* ───── delivery receiving mode ───── */
                <React.Fragment>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '12px 20px', background: 'var(--clay-tint)' }}>
                    <Icon name="box" size={16} color="var(--clay-ink)" />
                    <span style={{ fontWeight: 700, fontSize: 13.5, color: 'var(--clay-ink)', flex: 1 }}>{t('Registra consegna · inserisci le quantità ricevute', 'Record delivery · enter received quantities')}</span>
                    <button onClick={() => setRecvCsv(recvCsv == null ? '' : null)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 11px', borderRadius: 8, border: '1px solid var(--clay)', background: 'var(--surface)', cursor: 'pointer', fontSize: 12.5, fontWeight: 700, color: 'var(--clay-ink)' }}><Icon name="arrowUp" size={14} color="var(--clay-ink)" />{t('Importa CSV', 'Import CSV')}</button>
                  </div>
                  {recvCsv != null && (
                    <div style={{ padding: '12px 20px', borderBottom: '1px solid var(--hair)', background: 'var(--surface-2)' }}>
                      <div className="t-sm" style={{ color: 'var(--muted)', marginBottom: 8 }}>{t('Una riga per prodotto: nome o SKU, quantità ricevuta — es. "Base coat, 10"', 'One row per product: name or SKU, received qty — e.g. "Base coat, 10"')}</div>
                      <textarea value={recvCsv} onChange={e => setRecvCsv(e.target.value)} rows={4} placeholder={"Base coat, 10\nGEL-RD-001, 12"} style={{ ...inputCss, fontFamily: 'var(--mono, monospace)', resize: 'vertical' }} />
                      <div style={{ display: 'flex', gap: 8, marginTop: 8, justifyContent: 'flex-end' }}>
                        <button className="dk-btn dk-btn--ghost" style={{ height: 34 }} onClick={() => setRecvCsv(null)}>{t('Annulla', 'Cancel')}</button>
                        <button className="dk-btn dk-btn--clay" style={{ height: 34 }} onClick={() => applyRecvCsv(s)}><Icon name="check" size={15} color="#fff" />{t('Applica', 'Apply')}</button>
                      </div>
                    </div>
                  )}
                  <div style={{ display: 'grid', gridTemplateColumns: '2.6fr 1fr 1.1fr 1.1fr', gap: 10, padding: '11px 20px', background: 'var(--surface-2)' }}>
                    {[t('Prodotto', 'Product'), t('Ordinato', 'Ordered'), t('Ricevuto', 'Received'), t('Esito', 'Status')].map((h, i) => <div key={i} className="t-meta" style={{ textAlign: i === 0 ? 'left' : i === 3 ? 'left' : 'right' }}>{h}</div>)}
                  </div>
                  {lines.map((l) => { const rq = recv[l.id] != null ? recv[l.id] : 0; const diff = rq - l.qty; return (
                    <div key={l.id} style={{ display: 'grid', gridTemplateColumns: '2.6fr 1fr 1.1fr 1.1fr', gap: 10, padding: '10px 20px', alignItems: 'center', borderTop: '1px solid var(--hair)' }}>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontWeight: 600, fontSize: 13.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.name[lang]}</div>
                        {(l.brand || l.sku) && <div className="t-sm" style={{ color: 'var(--muted-2)' }}>{[l.brand, l.sku].filter(Boolean).join(' · ')}</div>}
                      </div>
                      <div className="t-num" style={{ textAlign: 'right', fontSize: 13.5, color: 'var(--muted)' }}>{l.qty}</div>
                      <div style={{ display: 'flex', justifyContent: 'flex-end' }}><input type="number" value={rq} min={0} onChange={e => setRecvQty(l.id, e.target.value)} style={{ ...inputCss, width: 66, textAlign: 'right', fontWeight: 700, fontFamily: 'var(--mono, monospace)', borderColor: 'var(--clay)' }} /></div>
                      <div>{diff === 0
                        ? <span style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--ok)', display: 'inline-flex', alignItems: 'center', gap: 4 }}><Icon name="check" size={13} color="var(--ok)" stroke={2.4} />{t('Completo', 'Complete')}</span>
                        : <span style={{ fontSize: 11.5, fontWeight: 700, color: STOCK_DOT.low.color, background: STOCK_DOT.low.tint, padding: '2px 9px', borderRadius: 99, display: 'inline-flex', alignItems: 'center', gap: 4 }}><Icon name="alert" size={12} color={STOCK_DOT.low.color} />{diff > 0 ? '+' : ''}{diff} {diff > 0 ? t('in più', 'over') : t('mancanti', 'short')}</span>}
                      </div>
                    </div>
                  ); })}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 20px', borderTop: '1px solid var(--hair)', background: 'var(--surface-2)' }}>
                    <span className="t-sm" style={{ color: 'var(--muted)', flex: 1 }}>{t('Totale ricevuto', 'Total received')}: <b style={{ color: 'var(--ink)' }}>{recvTotal}</b> {t('unità', 'units')} · {t('alla conferma il magazzino viene aggiornato', 'on confirm the stock is updated')}</span>
                    <button className="dk-btn dk-btn--ghost" onClick={cancelReceive} style={{ flexShrink: 0 }}>{t('Annulla', 'Cancel')}</button>
                    <button className="dk-btn dk-btn--clay" onClick={() => confirmReceive(s)} style={{ flexShrink: 0 }}><Icon name="check" size={16} color="#fff" />{t('Conferma consegna', 'Confirm delivery')}</button>
                  </div>
                </React.Fragment>
              ) : (
                <React.Fragment>
              {/* line table — only "Da ordinare" is editable */}
              <div style={{ display: 'grid', gridTemplateColumns: isReceived ? '2.4fr 0.95fr 0.95fr 0.95fr 1fr' : '2.4fr 0.8fr 0.95fr 0.9fr 0.6fr 0.95fr 34px', gap: 10, padding: '11px 20px', background: 'var(--surface-2)' }}>
                {(isReceived ? [t('Prodotto', 'Product'), t('Ordinato', 'Ordered'), t('Ricevuto', 'Received'), t('Esito', 'Status'), t('Totale', 'Total')] : [t('Prodotto', 'Product'), t('Scorta', 'Stock'), t('Da ordinare', 'To order'), t('Prezzo un.', 'Unit price'), 'IVA', t('Totale', 'Total'), '']).map((h, i) => <div key={i} className="t-meta" style={{ textAlign: isReceived ? (i === 0 || i === 3 ? 'left' : 'right') : (i >= 1 && i <= 5 ? 'right' : 'left') }}>{h}</div>)}
              </div>
              {lines.map((l) => { const mth = orderLineMath(l); const lowItem = l.stock < l.min;
                if (isReceived) { const rec = isReceived; const drow = (rec.discrepancies || []).find(d => (d.name[lang] || d.name) === (l.name[lang] || l.name)); const rq = drow ? drow.received : l.qty; const diff = rq - l.qty; return (
                  <div key={l.id} style={{ display: 'grid', gridTemplateColumns: '2.4fr 0.95fr 0.95fr 0.95fr 1fr', gap: 10, padding: '10px 20px', alignItems: 'center', borderTop: '1px solid var(--hair)' }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 600, fontSize: 13.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.name[lang]}</div>
                      {(l.brand || l.sku) && <div className="t-sm" style={{ color: 'var(--muted-2)' }}>{[l.brand, l.sku].filter(Boolean).join(' · ')}</div>}
                    </div>
                    <div className="t-num" style={{ textAlign: 'right', fontSize: 13, color: 'var(--muted)' }}>{l.qty}</div>
                    <div className="t-num" style={{ textAlign: 'right', fontSize: 13.5, fontWeight: 700 }}>{rq}</div>
                    <div>{diff === 0 ? <span style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--ok)' }}>{t('Completo', 'Complete')}</span> : <span style={{ fontSize: 11.5, fontWeight: 700, color: STOCK_DOT.low.color, background: STOCK_DOT.low.tint, padding: '2px 8px', borderRadius: 99 }}>{diff > 0 ? '+' : ''}{diff}</span>}</div>
                    <div className="t-num" style={{ textAlign: 'right', fontSize: 13 }}>{fmtEur(mth.total, lang)}</div>
                  </div>
                ); }
                return (
                <div key={l.id} style={{ display: 'grid', gridTemplateColumns: '2.4fr 0.8fr 0.95fr 0.9fr 0.6fr 0.95fr 34px', gap: 10, padding: '10px 20px', alignItems: 'center', borderTop: '1px solid var(--hair)' }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: 13.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.name[lang]}</div>
                    {(l.brand || l.sku) && <div className="t-sm" style={{ color: 'var(--muted-2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{[l.brand, l.sku].filter(Boolean).join(' · ')}</div>}
                  </div>
                  <div className="t-num" style={{ textAlign: 'right', fontSize: 13, color: lowItem ? STOCK_DOT.low.color : 'var(--muted)', fontWeight: lowItem ? 700 : 500 }}>{l.stock}/{l.min}</div>
                  <div style={{ display: 'flex', justifyContent: 'flex-end' }}><input type="number" value={l.qty} min={0} disabled={isSent} onChange={e => setLine(s, l.id, { qty: Math.max(0, parseInt(e.target.value) || 0) })} style={{ ...inputCss, width: 62, textAlign: 'right', fontWeight: 700, fontFamily: 'var(--mono, monospace)', borderColor: 'var(--clay)', background: isSent ? 'var(--surface-2)' : 'var(--surface)' }} /></div>
                  <div className="t-num" style={{ textAlign: 'right', fontSize: 13 }}>{fmtEur(l.cost, lang)}</div>
                  <div className="t-num" style={{ textAlign: 'right', fontSize: 13, color: 'var(--muted)' }}>{l.vat}%</div>
                  <div className="t-num" style={{ textAlign: 'right', fontSize: 13.5, fontWeight: 700 }}>{fmtEur(mth.total, lang)}</div>
                  <button className="dk-iconbtn" style={{ width: 30, height: 30, borderRadius: 8 }} onClick={() => removeLine(s, l.id)} title={t('Rimuovi', 'Remove')}><Icon name="x" size={14} color="var(--muted)" /></button>
                </div>
              ); })}
              {lines.length === 0 && <div className="t-sm" style={{ color: 'var(--muted-2)', padding: '16px 20px', borderTop: '1px solid var(--hair)' }}>{t('Nessun prodotto. Aggiungine uno qui sotto.', 'No products yet. Add one below.')}</div>}

              {/* add product row */}
              {!isReceived && <div style={{ borderTop: '1px solid var(--hair)', padding: '10px 20px', position: 'relative' }}>
                {addFor === s ? (
                  <div>
                    <div className="dk-search" style={{ width: '100%', height: 38 }}>
                      <Icon name="search" size={16} color="var(--muted-2)" />
                      <input autoFocus value={addQ} onChange={e => setAddQ(e.target.value)} placeholder={t('Cerca un prodotto da aggiungere…', 'Search a product to add…')} />
                      <button onClick={() => { setAddFor(null); setAddQ(''); }} style={{ cursor: 'pointer', display: 'grid', placeItems: 'center' }}><Icon name="x" size={14} color="var(--muted-2)" /></button>
                    </div>
                    <div style={{ marginTop: 6, border: '1px solid var(--hair)', borderRadius: 10, padding: 6, maxHeight: 240, overflowY: 'auto', background: 'var(--surface)' }}>
                      {addable(s).slice(0, 8).map(p => (
                        <button key={p.id} className="dk-row" onClick={() => addProduct(s, p)} style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '8px 10px', borderRadius: 8, textAlign: 'left' }}>
                          <span style={{ width: 8, height: 8, borderRadius: 99, background: STOCK_DOT[stockStatus(p)].color, flexShrink: 0 }} />
                          <span style={{ flex: 1, minWidth: 0 }}>
                            <span style={{ display: 'block', fontWeight: 600, fontSize: 13.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name[lang]}</span>
                            <span className="t-sm" style={{ color: 'var(--muted-2)' }}>{supplierOf(p)} · {t('scorta', 'stock')} {p.qty}/{p.min}</span>
                          </span>
                          <Icon name="plus" size={15} color="var(--clay-ink)" />
                        </button>
                      ))}
                      {addable(s).length === 0 && <div className="t-sm" style={{ color: 'var(--muted-2)', padding: 12, textAlign: 'center' }}>{t('Nessun prodotto trovato.', 'No product found.')}</div>}
                    </div>
                  </div>
                ) : (
                  <button onClick={() => { setAddFor(s); setAddQ(''); }} style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '7px 12px', borderRadius: 9, border: '1px dashed var(--hair)', background: 'var(--surface)', cursor: 'pointer', fontSize: 13, fontWeight: 600, color: 'var(--clay-ink)' }}><Icon name="plus" size={15} color="var(--clay-ink)" />{t('Aggiungi prodotto', 'Add product')}</button>
                )}
              </div>}

              {/* footer totals + actions */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 18, padding: '14px 20px', borderTop: '1px solid var(--hair)', background: 'var(--surface-2)', flexWrap: 'wrap' }}>
                <div style={{ display: 'flex', gap: 20, flex: 1, flexWrap: 'wrap' }}>
                  <div><span className="t-meta">{t('Imponibile', 'Net')}</span><div className="t-num" style={{ fontSize: 15, marginTop: 2 }}>{fmtEur(grandNet, lang)}</div></div>
                  <div><span className="t-meta">IVA</span><div className="t-num" style={{ fontSize: 15, marginTop: 2 }}>{fmtEur(grandVat, lang)}</div></div>
                  <div><span className="t-meta">{t('Totale ordine', 'Order total')}</span><div className="t-num" style={{ fontSize: 19, marginTop: 2, fontWeight: 800 }}>{fmtEur(grandTot, lang)}</div></div>
                </div>
                <button className="dk-btn dk-btn--ghost" onClick={() => onPdf(s, lines)} disabled={!lines.length} style={{ flexShrink: 0 }}><Icon name="arrowDn" size={16} />{t('Scarica PDF', 'Download PDF')}</button>
                {isReceived ? null : isSent ? (
                  <React.Fragment>
                    <button className="dk-btn dk-btn--ghost" onClick={() => setSent(x => { const c = { ...x }; delete c[s]; return c; })} style={{ flexShrink: 0 }}><Icon name="undo" size={16} />{t('Riapri', 'Reopen')}</button>
                    <button className="dk-btn dk-btn--clay" onClick={() => startReceive(s)} style={{ flexShrink: 0 }}><Icon name="box" size={16} color="#fff" />{t('Registra consegna', 'Receive delivery')}</button>
                  </React.Fragment>
                ) : (
                  <button className="dk-btn dk-btn--clay" onClick={() => confirmOrder(s)} disabled={!lines.length} style={{ flexShrink: 0 }}><Icon name={ORDER_METHODS[method].icon} size={16} color="#fff" />{t('Conferma e invia', 'Confirm & send')} · {ORDER_METHODS[method][lang]}</button>
                )}
              </div>
                </React.Fragment>
              )}
            </div>
          );
        })}
      </div>
    </React.Fragment>
  );
}


const SCARICO_REASONS = [
  { it: 'Uso in trattamento', en: 'Treatment use' },
  { it: 'Vendita al banco', en: 'Retail sale' },
  { it: 'Prodotto scaduto', en: 'Expired' },
  { it: 'Danni / perdita', en: 'Damage / loss' },
];
const RETTIFICA_REASONS = [
  { it: 'Conteggio inventario', en: 'Stock count' },
  { it: 'Errore precedente', en: 'Previous error' },
  { it: 'Restituzione a fornitore', en: 'Return to supplier' },
  { it: 'Altro', en: 'Other' },
];

function AdjModal({ prodId, type, inv, onConfirm, onClose, t, lang }) {
  const p = inv.find(x => x.id === prodId);
  const reasons = type === 'scarico' ? SCARICO_REASONS : type === 'carico' ? [{ it: 'Carico merce', en: 'Restock' }, { it: 'Rettifica inventario', en: 'Inventory adjustment' }] : RETTIFICA_REASONS;
  const isScarico = type === 'scarico';
  const [reason, setReason] = useStateDmi(null);
  const [qty, setQty] = useStateDmi(1);

  const delta = type === 'scarico' ? -Math.abs(qty) : Math.abs(qty);
  const after = p ? Math.max(0, p.qty + delta) : 0;
  const canConfirm = reason && qty > 0;
  return (
    <DkModal open onClose={onClose} title={type === 'scarico' ? t('Scarico prodotto', 'Issue product') : type === 'carico' ? t('Carico rapido', 'Quick restock') : t('Rettifica scorta', 'Adjust stock')} sub={p ? p.name[lang] : ''} width={440}
      foot={<React.Fragment>
        <button className="dk-btn dk-btn--ghost" onClick={onClose}>{t('Annulla', 'Cancel')}</button>
        <button className="dk-btn dk-btn--clay" disabled={!canConfirm} onClick={() => canConfirm && onConfirm(prodId, delta, { it: reason.it, en: reason.en })}><Icon name="check" size={16} color="#fff" />{t('Conferma', 'Confirm')}</button>
      </React.Fragment>}>
      <div className="t-meta" style={{ marginBottom: 8 }}>{t('Causale', 'Reason')}</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7, marginBottom: 18 }}>
        {reasons.map(r => { const on = reason && reason.it === r.it; return (
          <button key={r.it} onClick={() => setReason(r)} style={{ padding: '8px 14px', borderRadius: 99, fontSize: 13, fontWeight: 600, cursor: 'pointer', border: '1px solid ' + (on ? 'var(--clay)' : 'var(--hair)'), background: on ? 'var(--clay-tint)' : 'var(--surface)', color: on ? 'var(--clay-ink)' : 'var(--ink-2)' }}>{r[lang]}</button>
        ); })}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 18 }}>
        <div>
          <div className="t-meta" style={{ marginBottom: 6 }}>{isScarico ? t('Quantità da scaricare', 'Units to issue') : t('Variazione (+ o −)', 'Change (+ or −)')}</div>
          <NumBox value={qty} onChange={setQty} suffix={p?.unit?.[lang] || t('unità', 'units')} width={140} />
        </div>
        <div style={{ padding: '12px 14px', background: 'var(--surface-2)', borderRadius: 10 }}>
          <div className="t-sm" style={{ color: 'var(--muted)', marginBottom: 2 }}>{t('Dopo', 'After')}</div>
          <div className="t-num" style={{ fontSize: 24, color: after < (p?.min||0) ? 'var(--warn)' : 'var(--ink)' }}>{after}</div>
          {after < (p?.min||0) && <div className="t-sm" style={{ color: 'var(--warn)', fontWeight: 700, marginTop: 2 }}>{t('Sotto soglia!', 'Below threshold!')}</div>}
        </div>
      </div>

    </DkModal>
  );
}

/* ─── ProductDrawer: unified detail + edit panel ─── */
function ProductDrawer({ prod, inv, moves, cats, onCats, onSave, onDelete, onAdj, onClose, t, lang }) {
  const isNew = !!prod._new;
  const live = inv.find(x => x.id === prod.id) || prod;
  const [draft, setDraft] = useStateDmi(() => ({ ...prod, name: { ...prod.name }, unit: { ...(prod.unit || { it: 'unità', en: 'units' }) } }));
  const set = (patch) => setDraft(d => ({ ...d, ...patch }));
  const setName = (v) => setDraft(d => ({ ...d, name: { ...d.name, [lang]: v } }));
  const setUnit = (it, en) => setDraft(d => ({ ...d, unit: { it, en } }));
  // stock shown: for existing products it's the live qty (changed only via movements); for new, the draft qty
  const qty = isNew ? draft.qty : live.qty;
  const minV = isNew ? draft.min : live.min;
  const lowItem = qty < minV;
  const stockPct = minV > 0 ? Math.min(100, Math.round((qty / minV) * 100)) : 100;
  const curUnit = draft.unit?.[lang] || 'unità';
  const prodMoves = moves.filter(m => m.productId === prod.id).slice(0, 8);
  const canSave = (draft.name[lang] || '').trim();
  const inputCss = { width: '100%', border: '1px solid var(--hair)', borderRadius: 10, outline: 'none', fontSize: 14.5, padding: '10px 12px', fontFamily: 'var(--sans)', background: 'var(--surface)', boxSizing: 'border-box' };
  const nm = NATURE_META[draft.nature];
  const Sec = ({ title, last, children }) => (
    <div style={{ border: '1px solid var(--hair)', borderRadius: 14, padding: 16, marginBottom: last ? 4 : 14 }}>
      <div className="t-meta" style={{ marginBottom: 12 }}>{title}</div>
      {children}
    </div>
  );
  const Fld = ({ label, hint, last, children }) => (
    <div style={{ marginBottom: last ? 0 : 16 }}>
      <div className="t-meta" style={{ marginBottom: 6 }}>{label}</div>
      {children}
      {hint && <div className="t-sm" style={{ color: 'var(--muted-2)', marginTop: 5 }}>{hint}</div>}
    </div>
  );

  return (
    <DkModal open onClose={onClose} title={isNew ? t('Nuovo prodotto', 'New product') : t('Scheda prodotto', 'Product card')} width={580}
      foot={<React.Fragment>
        {!isNew && <button className="dk-btn dk-btn--ghost" style={{ color: 'var(--danger)', borderColor: 'color-mix(in srgb, var(--danger) 40%, var(--hair))', marginRight: 'auto' }} onClick={() => onDelete(prod.id)}><Icon name="x" size={16} color="var(--danger)" />{t('Elimina', 'Delete')}</button>}
        <button className="dk-btn dk-btn--ghost" onClick={onClose}>{t('Annulla', 'Cancel')}</button>
        <button className="dk-btn dk-btn--clay" disabled={!canSave} onClick={() => canSave && onSave(draft)}><Icon name="check" size={17} color="#fff" />{isNew ? t('Crea prodotto', 'Create product') : t('Salva modifiche', 'Save changes')}</button>
      </React.Fragment>}>
      <input value={draft.name[lang] || ''} onChange={e => setName(e.target.value)} placeholder={t('Nome prodotto', 'Product name')} style={{ border: 'none', borderBottom: '2px solid var(--hair)', outline: 'none', fontSize: 21, fontWeight: 500, fontFamily: 'var(--serif)', padding: '4px 0', background: 'transparent', width: '100%', marginBottom: 18 }} />

        {/* ── Anagrafica ── */}
        <Sec title={t('Anagrafica', 'Identity')}>
          <Fld label={'SKU / ' + t('Codice', 'Code')}>
            <input value={draft.sku || ''} onChange={e => set({ sku: e.target.value })} placeholder="es. GEL-RD-001" style={inputCss} />
          </Fld>
          <Fld label={t('Brand', 'Brand')}>
            <input value={draft.brand || ''} onChange={e => set({ brand: e.target.value })} placeholder={t('es. OPI, L\'Oréal Pro…', 'e.g. OPI, L\'Oréal Pro…')} style={inputCss} />
          </Fld>
          <Fld label={t('Categoria', 'Category')}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7, alignItems: 'center' }}>
              {cats.map(c => { const on = draft.cat === c.id; return (
                <button key={c.id} onClick={() => set({ cat: c.id })} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 13px', borderRadius: 99, fontSize: 12.5, fontWeight: 600, cursor: 'pointer', border: '1px solid ' + (on ? 'var(--ink)' : 'var(--hair)'), background: on ? 'var(--ink)' : 'var(--surface)', color: on ? '#fff' : 'var(--ink-2)' }}><span style={{ width: 8, height: 8, borderRadius: 99, background: c.color, display: on ? 'none' : 'inline-block' }} />{c.name[lang]}</button>); })}
              <button onClick={onCats} title={t('Gestisci categorie', 'Manage categories')} style={{ width: 32, height: 32, borderRadius: 99, border: '1px dashed var(--hair)', background: 'var(--surface)', cursor: 'pointer', display: 'grid', placeItems: 'center', color: 'var(--clay-ink)', flexShrink: 0 }}><Icon name="plus" size={15} color="var(--clay-ink)" /></button>
            </div>
          </Fld>
          <Fld label={t("Tipologia d'uso", 'Usage type')} last>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {[['interno', t('Solo uso interno', 'In-salon only'), t('Consumato nei trattamenti · non al punto cassa · scarico manuale', 'Used in treatments · not at checkout · manual decrement')], ['vendita', t('Solo vendita al dettaglio', 'Retail only'), t('Venduto alle clienti · scarico automatico al punto cassa', 'Sold to clients · auto-decrement at POS')], ['entrambi', t('Misto', 'Mixed'), t('Trattamenti + vendita · canali tracciati separatamente', 'Treatments + retail · channels tracked separately')]].map(([v, l, d]) => { const on = draft.nature === v; return (
                <button key={v} onClick={() => set({ nature: v })} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, textAlign: 'left', padding: '11px 13px', borderRadius: 10, cursor: 'pointer', border: '1px solid ' + (on ? 'var(--clay)' : 'var(--hair)'), background: on ? 'var(--clay-tint)' : 'var(--surface)' }}>
                  <span style={{ width: 18, height: 18, borderRadius: 99, border: '1.8px solid ' + (on ? 'var(--clay)' : 'var(--faint)'), background: on ? 'var(--clay)' : 'transparent', display: 'grid', placeItems: 'center', flexShrink: 0, marginTop: 1 }}>{on && <Icon name="check" size={11} color="#fff" stroke={2.6} />}</span>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: 'block', fontWeight: 700, fontSize: 13.5, color: on ? 'var(--clay-ink)' : 'var(--ink)' }}>{l}</span>
                    <span className="t-sm" style={{ color: 'var(--muted)', marginTop: 2, display: 'block', lineHeight: 1.4 }}>{d}</span>
                  </span>
                </button>
              ); })}
            </div>
          </Fld>
        </Sec>

        {/* ── Confezione ── */}
        <Sec title={t('Confezione', 'Packaging')}>
          <Fld label={t('Unità di misura', 'Unit of measure')}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7 }}>
              {UNIT_OPTIONS.map(u => { const on = curUnit === u[lang]; return (
                <button key={u.it} onClick={() => setUnit(u.it, u.en)} style={{ padding: '6px 13px', borderRadius: 99, fontSize: 12.5, fontWeight: 600, cursor: 'pointer', border: '1px solid ' + (on ? 'var(--ink)' : 'var(--hair)'), background: on ? 'var(--ink)' : 'var(--surface)', color: on ? '#fff' : 'var(--ink-2)' }}>{u[lang]}</button>
              ); })}
            </div>
          </Fld>
          <Fld label={t('Valore quantità', 'Quantity value')} hint={t('Risulta: ', 'Shows as: ') + curUnit + (draft.unitQty ? ' · ' + draft.unitQty : '')} last>
            <input value={draft.unitQty || ''} onChange={e => set({ unitQty: e.target.value })} placeholder={t('es. 14ml, 250g', 'e.g. 14ml, 250g')} style={inputCss} />
          </Fld>
        </Sec>

        {/* ── Fornitore ── */}
        <Sec title={<React.Fragment>{t('Fornitore', 'Supplier')} <span style={{ color: 'var(--clay)' }}>*</span></React.Fragment>}>
          <input value={draft.supplier || ''} onChange={e => set({ supplier: e.target.value })} placeholder={t('es. NailPro, L\'Oréal Pro…', 'e.g. NailPro, L\'Oréal Pro…')} style={inputCss} />
          {!((draft.supplier || '').trim()) && <div className="t-sm" style={{ color: 'var(--muted-2)', marginTop: 6 }}>{t('Obbligatorio per la gestione degli ordini.', 'Required for order management.')}</div>}
        </Sec>

        {/* ── Prezzi e IVA ── */}
        <Sec title={t('Prezzi e IVA', 'Pricing & VAT')}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px 16px' }}>
            <div>
              <div className="t-meta" style={{ marginBottom: 6 }}>{t('Prezzo di acquisto', 'Purchase price')}</div>
              <NumBox value={draft.cost || 0} onChange={v => set({ cost: v, value: v })} suffix="€" width="100%" />
              <div className="t-sm" style={{ color: 'var(--muted-2)', marginTop: 4 }}>{t('IVA esclusa', 'VAT excl.')}</div>
            </div>
            <div>
              <div className="t-meta" style={{ marginBottom: 6 }}>{t('Sconto', 'Discount')}</div>
              <NumBox value={draft.discount || 0} onChange={v => set({ discount: v })} suffix="%" width="100%" />
              <div className="t-sm" style={{ color: 'var(--muted-2)', marginTop: 4 }}>{t('Fornitore o promo', 'Supplier or promo')}</div>
            </div>
            <div>
              <div className="t-meta" style={{ marginBottom: 6 }}>{t('Prezzo di vendita', 'Retail price')}</div>
              <NumBox value={draft.retail || 0} onChange={v => set({ retail: v })} suffix="€" width="100%" />
              <div className="t-sm" style={{ color: 'var(--muted-2)', marginTop: 4 }}>{t('IVA inclusa', 'VAT incl.')}</div>
            </div>
            <div>
              <div className="t-meta" style={{ marginBottom: 6 }}>{t('Aliquota IVA', 'VAT rate')}</div>
              <select value={draft.vat != null ? draft.vat : 22} onChange={e => set({ vat: parseInt(e.target.value) })} style={{ ...inputCss, cursor: 'pointer' }}>
                {[4, 10, 22].map(v => <option key={v} value={v}>{v}%</option>)}
              </select>
            </div>
          </div>
        </Sec>

        {/* ── Scorte ── */}
        <Sec title={t('Scorte', 'Stock')}>
          {isNew ? (
            <Fld label={t('Scorta iniziale', 'Initial stock')} hint={t('Dopo la creazione cambia solo con Scarico / Carico / Rettifica.', 'After creation it changes only via Issue / Restock / Adjust.')}>
              <NumBox value={draft.qty} onChange={v => set({ qty: v })} suffix={curUnit} width={170} />
            </Fld>
          ) : (
            <Fld label={t('Giacenza attuale', 'Current stock')} hint={t('Ogni movimento richiede una causale e finisce nel registro.', 'Every movement needs a reason and is logged.')}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <button className="dk-iconbtn" style={{ width: 36, height: 36, borderRadius: 9, fontSize: 22, fontWeight: 600, border: '1px solid var(--hair)' }} onClick={() => onAdj(prod.id, 'scarico')} title={t('Scarico', 'Issue')}>−</button>
                <span className="t-num" style={{ fontSize: 18, minWidth: 30, textAlign: 'center' }}>{qty}</span>
                <button className="dk-iconbtn" style={{ width: 36, height: 36, borderRadius: 9, fontSize: 22, fontWeight: 600, border: '1px solid var(--hair)', background: 'var(--clay)', color: '#fff', borderColor: 'transparent' }} onClick={() => onAdj(prod.id, 'carico')} title={t('Carico rapido', 'Quick restock')}>+</button>
              </div>
            </Fld>
          )}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px 16px', marginBottom: 14 }}>
            <div>
              <div className="t-meta" style={{ marginBottom: 6 }}>{t('Soglia minima', 'Minimum threshold')}</div>
              <NumBox value={draft.min} onChange={v => set({ min: v })} suffix={curUnit} width="100%" />
              <div className="t-sm" style={{ color: 'var(--muted-2)', marginTop: 4 }}>{t('Avviso sottoscorta', 'Low-stock alert')}</div>
            </div>
            <div>
              <div className="t-meta" style={{ marginBottom: 6 }}>{t('Quantità di riordino', 'Reorder quantity')}</div>
              <NumBox value={draft.reorderQty || 0} onChange={v => set({ reorderQty: v })} suffix={curUnit} width="100%" />
              <div className="t-sm" style={{ color: 'var(--muted-2)', marginTop: 4 }}>{t('Predefinita al ripristino', 'Default on restock')}</div>
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '13px 15px', background: 'var(--surface-2)', borderRadius: 10 }}>
            <span className="t-sm" style={{ color: 'var(--muted)', fontWeight: 600 }}>{t('Valore totale a magazzino', 'Total stock value')}</span>
            <span className="t-num" style={{ fontSize: 20 }}>{qty * (draft.cost || draft.value || 0) === 0 ? '€0' : fmtEur(qty * (draft.cost || draft.value || 0), lang)}</span>
          </div>
        </Sec>

        {/* ── Registro movimenti (existing only) ── */}
        {!isNew && (
          <Sec title={<React.Fragment>{t('Registro movimenti', 'Movement log')} <span className="t-sm" style={{ color: 'var(--muted-2)', fontWeight: 500 }}>· {t('automatico', 'automatic')}</span></React.Fragment>} last>
            {prodMoves.length === 0 ? (
              <div className="t-sm" style={{ color: 'var(--muted-2)' }}>{t('Nessun movimento registrato per questo prodotto.', 'No movements recorded for this product.')}</div>
            ) : (
              <div style={{ border: '1px solid var(--hair)', borderRadius: 10, overflow: 'hidden' }}>
                {prodMoves.map((m, i) => { const meta = MOVE_META[m.type] || MOVE_META.rettifica; const note = typeof m.note === 'object' ? m.note[lang] : m.note; return (
                  <div key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '11px 14px', borderTop: i ? '1px solid var(--hair)' : 'none' }}>
                    <div style={{ width: 30, height: 30, borderRadius: 9, background: meta.tint, display: 'grid', placeItems: 'center', flexShrink: 0 }}><Icon name={meta.icon} size={14} color={meta.color} /></div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="t-sm" style={{ fontWeight: 700 }}>{meta[lang]}{note ? ' · ' + note : ''}</div>
                      <div className="t-sm" style={{ color: 'var(--muted-2)' }}>{m.when[lang]} · {m.by || 'Sole Caputo'}</div>
                    </div>
                    <span style={{ fontWeight: 700, fontSize: 14, color: m.delta > 0 ? 'var(--ok)' : 'var(--ink-2)', flexShrink: 0 }}>{m.delta > 0 ? '+' : ''}{m.delta} {curUnit}</span>
                  </div>
                ); })}
              </div>
            )}
          </Sec>
        )}

        {/* Footer actions handled by DkModal foot */}
    </DkModal>
  );
}

/* ---------------- Staff ---------------- */
const STAFF_CONTACT = {
  sole: { phone: '+39 348 110 2245', email: 'sole@theparlour.it' },
  mara: { phone: '+39 333 221 7788', email: 'mara@theparlour.it' },
  lina: { phone: '+39 327 884 1290', email: 'lina@theparlour.it' },
  giulia: { phone: '+39 340 556 9921', email: 'giulia@theparlour.it' },
  asia: { phone: '+39 351 447 3300', email: 'asia@theparlour.it' },
  noor: { phone: '+39 329 770 5512', email: 'noor@theparlour.it' },
  vera: { phone: '+39 346 882 4471', email: 'vera@theparlour.it' },
  ines: { phone: '+39 338 514 9963', email: 'ines@theparlour.it' },
  dafne: { phone: '+39 350 226 7104', email: 'dafne@theparlour.it' },
};
function staffTodayStatus(d, t, lang) {
  const TODAY = '2026-06-26';
  const ov = (d.availability || {})[TODAY];
  if (ov) {
    const meta = AVAIL_STATUS[ov.status] || AVAIL_STATUS.work;
    return { key: ov.status, label: meta[lang], color: meta.c, bg: meta.bg, hours: ov.status === 'work' ? (ov.hours || '') : '' };
  }
  // recurring weekly pattern — today is Friday (Ven/Fri)
  const week = (d.weeks && d.weeks[0]) ? d.weeks[0].days : [];
  const today = week.find(x => x[0] === 'Ven' || x[1] === 'Fri');
  const hrs = today ? today[2] : '';
  if (!today || !hrs || hrs === '—' || /ripos|off/i.test(hrs)) {
    const m = AVAIL_STATUS.off; return { key: 'off', label: m[lang], color: m.c, bg: m.bg, hours: '' };
  }
  const m = AVAIL_STATUS.work; return { key: 'work', label: m[lang], color: m.c, bg: m.bg, hours: hrs };
}
function DkStaff() {
  const { t, lang, fireToast, svcOps, toggleStaffSvc, commission } = useDk();
  const [clocked, setClocked] = useStateDmi({ sole: true, mara: true, lina: false, giulia: true, asia: false });
  const [openId, setOpenId] = useStateDmi(null);
  const [store, setStore] = useStateDmi(() => {
    const o = {};
    OPS.forEach(p => { o[p.id] = { name: p.name, role: { ...p.role }, phone: STAFF_CONTACT[p.id].phone, email: STAFF_CONTACT[p.id].email, color: p.color, weeks: [{ label: staffWeekLabel(0, 'it'), days: STAFF_SHIFTS[p.id].map(s => [s[0], s[1], s[2], '']) }], availability: { ...(STAFF_AVAIL[p.id] || {}) } }; });
    return o;
  });
  const toggleClock = (id) => { setClocked(c => ({ ...c, [id]: !c[id] })); fireToast({ msg: clocked[id] ? t('Uscita registrata', 'Clocked out') : t('Entrata registrata', 'Clocked in'), icon: 'clock' }); };
  const patch = (id, p) => setStore(s => ({ ...s, [id]: { ...s[id], ...p } }));
  const staffServices = (id) => SERVICES.filter(s => (svcOps[s.id] || []).includes(id)).map(s => s.id);

  if (openId) {
    const p = op(openId);
    return <DkStaffPage id={openId} o={p} data={store[openId]} setData={pp => patch(openId, pp)} services={staffServices(openId)} onToggleSvc={sid => toggleStaffSvc(openId, sid)} commissionPct={commission[openId] || 0} on={clocked[openId]} onToggle={() => toggleClock(openId)} onBack={() => setOpenId(null)} t={t} lang={lang} fireToast={fireToast} />;
  }
  return (
    <div className="dk-page" style={{ maxWidth: 1080 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 16 }}>
        {OPS.map(o => { const d = store[o.id]; const ts = staffTodayStatus(d, t, lang); const svcCount = staffServices(o.id).length; return (
          <div key={o.id} className="dk-card dk-hovercard" onClick={() => setOpenId(o.id)} style={{ padding: 18 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
              <Avatar initials={o.initials} size={48} color={o.color} ring />
              <div style={{ flex: 1, minWidth: 0 }}><div className="t-h3" style={{ fontSize: 16 }}>{d.name}</div><div className="t-sm" style={{ color: 'var(--muted)' }}>{d.role[lang]}</div></div>
            </div>
            {/* today's availability — the at-a-glance info */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '10px 13px', borderRadius: 11, background: ts.bg, marginBottom: 14 }}>
              <span style={{ width: 9, height: 9, borderRadius: 99, background: ts.color, flexShrink: 0, boxShadow: ts.key === 'work' ? '0 0 0 3px color-mix(in srgb, ' + ts.color + ' 25%, transparent)' : 'none' }} />
              <span style={{ fontWeight: 700, fontSize: 13.5, color: ts.color }}>{t('Oggi', 'Today')}: {ts.label}</span>
              {ts.hours && <span className="t-num" style={{ marginLeft: 'auto', fontSize: 13, fontWeight: 700, color: ts.color }}>{ts.hours}</span>}
            </div>
            <div style={{ display: 'flex', gap: 22 }}>
              <div><div className="t-meta" style={{ fontSize: 9.5, whiteSpace: 'nowrap' }}>{t('Incasso mese', 'Month revenue')}</div><div className="t-num" style={{ fontSize: 18, marginTop: 4 }}>{fmtEur(STAFF_PERF[o.id].month, lang)}</div></div>
              <div><div className="t-meta" style={{ fontSize: 9.5, whiteSpace: 'nowrap' }}>{t('Clienti oggi', 'Clients today')}</div><div className="t-num" style={{ fontSize: 18, marginTop: 4, color: ts.key === 'work' ? 'var(--ink)' : 'var(--muted-2)' }}>{ts.key === 'work' ? window.APPTS.filter(a => a.opId === o.id && a.kind !== 'break').length : '—'}</div></div>
            </div>
          </div>
        ); })}
      </div>
    </div>
  );
}

/* per-operator performance + schedule demo data */
const STAFF_PERF = {
  sole:   { month: 4980, target: 78, appts: 92, clients: 71, avg: 54, rebook: 68, trend: [3.9, 4.2, 4.1, 4.6, 4.7, 4.98], svc: ['s1', 's2', 's3', 's13', 's14'], top: ['c1', 'c8', 'c10', 'c3'] },
  mara:   { month: 3720, target: 62, appts: 78, clients: 60, avg: 48, rebook: 61, trend: [3.2, 3.4, 3.3, 3.5, 3.6, 3.72], svc: ['s5', 's6', 's9'], top: ['c2', 'c5'] },
  lina:   { month: 2100, target: 45, appts: 41, clients: 33, avg: 64, rebook: 55, trend: [1.7, 1.9, 1.8, 2.0, 2.05, 2.1], svc: ['s10', 's11', 's12'], top: ['c4', 'c9'] },
  giulia: { month: 4310, target: 90, appts: 104, clients: 80, avg: 41, rebook: 72, trend: [3.4, 3.7, 3.9, 4.0, 4.2, 4.31], svc: ['s1', 's2', 's3', 's4', 's13'], top: ['c10', 'c6', 'c1'] },
  asia:   { month: 3290, target: 70, appts: 52, clients: 44, avg: 78, rebook: 64, trend: [2.6, 2.8, 3.0, 3.1, 3.2, 3.29], svc: ['s7', 's8', 's9', 's14'], top: ['c8', 'c5', 'c2'] },
  noor:   { month: 2870, target: 58, appts: 47, clients: 39, avg: 61, rebook: 59, trend: [2.2, 2.4, 2.5, 2.6, 2.75, 2.87], svc: ['s9', 's10', 's11'], top: ['c7', 'c2', 'c5'] },
  vera:   { month: 3540, target: 66, appts: 63, clients: 51, avg: 56, rebook: 67, trend: [2.9, 3.0, 3.2, 3.3, 3.4, 3.54], svc: ['s12', 's13', 's14'], top: ['c1', 'c8', 'c4'] },
  ines:   { month: 2460, target: 52, appts: 58, clients: 46, avg: 42, rebook: 63, trend: [1.9, 2.0, 2.1, 2.25, 2.35, 2.46], svc: ['s12', 's14'], top: ['c4', 'c6', 'c10'] },
  dafne:  { month: 1680, target: 38, appts: 36, clients: 29, avg: 47, rebook: 48, trend: [1.1, 1.3, 1.4, 1.5, 1.6, 1.68], svc: ['s1', 's2', 's3'], top: ['c3', 'c9', 'c5'] },
};
const STAFF_SHIFTS = {
  sole:   [['Lun', 'Mon', '9–19'], ['Mar', 'Tue', '9–19'], ['Mer', 'Wed', '9–19'], ['Gio', 'Thu', '—'], ['Ven', 'Fri', '9–19'], ['Sab', 'Sat', '9–17']],
  mara:   [['Lun', 'Mon', '—'], ['Mar', 'Tue', '10–19'], ['Mer', 'Wed', '10–19'], ['Gio', 'Thu', '10–19'], ['Ven', 'Fri', '10–19'], ['Sab', 'Sat', '9–17']],
  lina:   [['Lun', 'Mon', '—'], ['Mar', 'Tue', '—'], ['Mer', 'Wed', '11–18'], ['Gio', 'Thu', '11–18'], ['Ven', 'Fri', '11–18'], ['Sab', 'Sat', '10–16']],
  giulia: [['Lun', 'Mon', '9–18'], ['Mar', 'Tue', '9–18'], ['Mer', 'Wed', '9–18'], ['Gio', 'Thu', '9–18'], ['Ven', 'Fri', '—'], ['Sab', 'Sat', '9–17']],
  asia:   [['Lun', 'Mon', '—'], ['Mar', 'Tue', '9–18'], ['Mer', 'Wed', '9–18'], ['Gio', 'Thu', '—'], ['Ven', 'Fri', '9–18'], ['Sab', 'Sat', '9–17']],
  noor:   [['Lun', 'Mon', '10–18'], ['Mar', 'Tue', '10–18'], ['Mer', 'Wed', '—'], ['Gio', 'Thu', '10–18'], ['Ven', 'Fri', '10–18'], ['Sab', 'Sat', '—']],
  vera:   [['Lun', 'Mon', '—'], ['Mar', 'Tue', '11–19'], ['Mer', 'Wed', '11–19'], ['Gio', 'Thu', '11–19'], ['Ven', 'Fri', '11–19'], ['Sab', 'Sat', '10–17']],
  ines:   [['Lun', 'Mon', '9–16'], ['Mar', 'Tue', '9–16'], ['Mer', 'Wed', '9–16'], ['Gio', 'Thu', '—'], ['Ven', 'Fri', '9–16'], ['Sab', 'Sat', '9–14']],
  dafne:  [['Lun', 'Mon', '—'], ['Mar', 'Tue', '—'], ['Mer', 'Wed', '12–19'], ['Gio', 'Thu', '12–19'], ['Ven', 'Fri', '12–19'], ['Sab', 'Sat', '10–17']],
};
// availability exceptions to the weekly pattern — keyed by YYYY-MM-DD
const AVAIL_STATUS = {
  work:     { it: 'Lavorativa',  en: 'Working',  c: '#3F9D6B', bg: 'rgba(63,157,107,0.14)' },
  off:      { it: 'Giorno libero', en: 'Day off', c: '#6F6E74', bg: 'rgba(111,110,116,0.12)' },
  vacation: { it: 'Ferie',       en: 'Vacation', c: '#5FAEC9', bg: 'rgba(95,174,201,0.16)' },
  holiday:  { it: 'Festività',   en: 'Holiday',  c: '#B26A4F', bg: 'rgba(178,106,79,0.16)' },
};
const STAFF_AVAIL = {
  sole:   { '2026-06-26': { status: 'vacation' }, '2026-06-27': { status: 'vacation' }, '2026-06-29': { status: 'work', hours: '10–15' } },
  mara:   { '2026-06-25': { status: 'off' }, '2026-07-02': { status: 'holiday' } },
  lina:   { '2026-06-30': { status: 'work', hours: '11–16' } },
  giulia: { '2026-06-26': { status: 'off' } },
};
// label a recurring-pattern week by its real calendar dates (weeks start Monday from the current week)
function staffWeekLabel(idx, lang) {
  const base = new Date('2026-06-22'); // Monday of the current week
  const start = new Date(base); start.setDate(base.getDate() + idx * 7);
  const end = new Date(start); end.setDate(start.getDate() + 6);
  const mon = (lang === 'en' ? ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'] : ['gen','feb','mar','apr','mag','giu','lug','ago','set','ott','nov','dic']);
  const txt = start.getMonth() === end.getMonth()
    ? `${start.getDate()}–${end.getDate()} ${mon[end.getMonth()]}`
    : `${start.getDate()} ${mon[start.getMonth()]} – ${end.getDate()} ${mon[end.getMonth()]}`;
  return { it: txt, en: txt };
}
const STAFF_PUNCH = {
  sole:   [['Mer 12', 'Wed 12', '08:54', '—', 'in']],
  mara:   [['Mer 12', 'Wed 12', '09:58', '—', 'in'], ['Mar 11', 'Tue 11', '10:02', '19:08', '9h 06m']],
  lina:   [['Mar 11', 'Tue 11', '10:58', '18:03', '7h 05m'], ['Sab 8', 'Sat 8', '10:04', '16:11', '6h 07m']],
  giulia: [['Mer 12', 'Wed 12', '08:48', '—', 'in'], ['Mar 11', 'Tue 11', '08:55', '18:10', '9h 15m']],
  asia:   [['Mar 11', 'Tue 11', '09:05', '18:02', '8h 57m'], ['Sab 8', 'Sat 8', '09:01', '17:05', '8h 04m']],
  noor:   [['Mer 12', 'Wed 12', '10:02', '—', 'in'], ['Mar 11', 'Tue 11', '10:05', '18:01', '7h 56m']],
  vera:   [['Mer 12', 'Wed 12', '11:04', '—', 'in'], ['Mar 11', 'Tue 11', '11:01', '19:06', '8h 05m']],
  ines:   [['Mer 12', 'Wed 12', '08:58', '—', 'in'], ['Mar 11', 'Tue 11', '09:02', '16:04', '7h 02m']],
  dafne:  [['Mer 12', 'Wed 12', '12:03', '—', 'in'], ['Sab 8', 'Sat 8', '10:06', '17:02', '6h 56m']],
};

function AvailabilityCalendar({ data, setData, t, lang }) {
  const today = new Date('2026-06-25');
  const [cursor, setCursor] = useStateDmi(new Date('2026-06-01'));
  const [picker, setPicker] = useStateDmi(null); // YYYY-MM-DD being edited
  const [addOpen, setAddOpen] = useStateDmi(false);
  const [range, setRange] = useStateDmi({ status: 'vacation', from: '2026-06-25', to: '2026-06-25', hours: '9–18' });
  const avail = data.availability || {};
  const applyRange = () => {
    const a = new Date(range.from), b = new Date(range.to);
    if (isNaN(a) || isNaN(b) || b < a) return;
    const next = { ...avail };
    for (let d = new Date(a); d <= b; d.setDate(d.getDate() + 1)) {
      const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      next[k] = range.status === 'work' ? { status: 'work', hours: range.hours } : { status: range.status };
    }
    setData({ availability: next }); setAddOpen(false);
  };
  const months = lang === 'en'
    ? ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
    : ['Gennaio', 'Febbraio', 'Marzo', 'Aprile', 'Maggio', 'Giugno', 'Luglio', 'Agosto', 'Settembre', 'Ottobre', 'Novembre', 'Dicembre'];
  const dows = lang === 'en' ? ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] : ['Lun', 'Mar', 'Mer', 'Gio', 'Ven', 'Sab', 'Dom'];
  const y = cursor.getFullYear(), m = cursor.getMonth();
  const first = new Date(y, m, 1);
  const startDow = (first.getDay() + 6) % 7; // Monday-first
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const key = (d) => `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const setStatus = (k, status, hours) => setData({ availability: { ...avail, [k]: status == null ? undefined : { status, hours } } });
  const clearDate = (k) => { const next = { ...avail }; delete next[k]; setData({ availability: next }); setPicker(null); };
  const cells = [];
  for (let i = 0; i < startDow; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 280px', gap: 20, alignItems: 'start' }}>
      <div className="dk-card" style={{ padding: 20 }}>
        {/* month nav */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
          <button className="dk-iconbtn" onClick={() => setCursor(new Date(y, m - 1, 1))}><Icon name="chevL" size={18} /></button>
          <div style={{ fontFamily: 'var(--serif)', fontSize: 20, fontWeight: 500, flex: 1, textAlign: 'center' }}>{months[m]} {y}</div>
          <button className="dk-iconbtn" onClick={() => setCursor(new Date(y, m + 1, 1))}><Icon name="chevR" size={18} /></button>
        </div>
        {/* dow header */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', gap: 6, marginBottom: 6 }}>
          {dows.map(d => <div key={d} className="t-meta" style={{ textAlign: 'center' }}>{d}</div>)}
        </div>
        {/* day grid */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', gap: 6 }}>
          {cells.map((d, i) => {
            if (d == null) return <div key={'e' + i} />;
            const k = key(d); const ex = avail[k]; const st = ex && AVAIL_STATUS[ex.status];
            const isToday = k === '2026-06-25';
            return (
              <button key={k} onClick={() => setPicker(picker === k ? null : k)} style={{ aspectRatio: '1', borderRadius: 10, cursor: 'pointer', border: '1px solid ' + (picker === k ? 'var(--ink)' : isToday ? 'var(--clay)' : 'var(--hair)'), background: st ? st.bg : 'var(--surface)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 3, padding: 4, position: 'relative' }}>
                <span style={{ fontWeight: isToday ? 800 : 600, fontSize: 13.5, color: st ? st.c : 'var(--ink)' }}>{d}</span>
                {st && <span style={{ fontSize: 8.5, fontWeight: 700, color: st.c, lineHeight: 1, textAlign: 'center' }}>{ex.status === 'work' && ex.hours ? ex.hours : st[lang]}</span>}
              </button>
            );
          })}
        </div>
        {/* per-date picker */}
        {picker && (
          <div style={{ marginTop: 16, padding: 14, borderRadius: 12, border: '1px solid var(--clay)', background: 'var(--surface-2)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
              <Icon name="calendar" size={15} color="var(--clay-ink)" />
              <span style={{ fontWeight: 700, fontSize: 14, flex: 1 }}>{picker.split('-').reverse().join('/')}</span>
              {avail[picker] && <button onClick={() => clearDate(picker)} className="t-sm" style={{ cursor: 'pointer', color: 'var(--clay-ink)', fontWeight: 700, background: 'transparent' }}>{t('Azzera', 'Clear')}</button>}
            </div>
            <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>
              {Object.entries(AVAIL_STATUS).map(([k, meta]) => { const on = avail[picker] && avail[picker].status === k; return (
                <button key={k} onClick={() => setStatus(picker, k, k === 'work' ? (avail[picker] && avail[picker].hours) || '9–18' : undefined)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 12px', borderRadius: 99, fontSize: 12.5, fontWeight: 700, cursor: 'pointer', border: '1px solid ' + (on ? meta.c : 'var(--hair)'), background: on ? meta.bg : 'var(--surface)', color: on ? meta.c : 'var(--ink-2)' }}><span style={{ width: 8, height: 8, borderRadius: 99, background: meta.c }} />{meta[lang]}</button>
              ); })}
            </div>
            {avail[picker] && avail[picker].status === 'work' && (
              <div style={{ marginTop: 12 }}>
                <div className="t-meta" style={{ marginBottom: 6 }}>{t('Orario', 'Hours')}</div>
                <input value={avail[picker].hours || ''} onChange={e => setStatus(picker, 'work', e.target.value)} placeholder={t('es. 9–18', 'e.g. 9–18')} style={{ border: '1px solid var(--hair)', borderRadius: 9, outline: 'none', fontSize: 14, padding: '8px 11px', fontFamily: 'var(--sans)', background: 'var(--surface)', width: 140 }} />
              </div>
            )}
          </div>
        )}
      </div>

      {/* side: legend + summary */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {/* quick add time-off range */}
        {addOpen ? (
          <div className="dk-card" style={{ padding: 16, border: '1px solid var(--clay)' }}>
            <div className="t-meta" style={{ marginBottom: 12 }}>{t('Aggiungi assenza / periodo', 'Add time-off / period')}</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
              {Object.entries(AVAIL_STATUS).map(([k, meta]) => { const on = range.status === k; return (
                <button key={k} onClick={() => setRange(r => ({ ...r, status: k }))} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '6px 10px', borderRadius: 99, fontSize: 12, fontWeight: 700, cursor: 'pointer', border: '1px solid ' + (on ? meta.c : 'var(--hair)'), background: on ? meta.bg : 'var(--surface)', color: on ? meta.c : 'var(--ink-2)' }}><span style={{ width: 7, height: 7, borderRadius: 99, background: meta.c }} />{meta[lang]}</button>
              ); })}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <label><div className="t-sm" style={{ color: 'var(--muted)', fontWeight: 600, marginBottom: 4 }}>{t('Dal', 'From')}</div><input type="date" value={range.from} onChange={e => setRange(r => ({ ...r, from: e.target.value, to: r.to < e.target.value ? e.target.value : r.to }))} style={{ border: '1px solid var(--hair)', borderRadius: 9, outline: 'none', fontSize: 13.5, padding: '8px 10px', fontFamily: 'var(--sans)', background: 'var(--surface)', width: '100%', boxSizing: 'border-box' }} /></label>
              <label><div className="t-sm" style={{ color: 'var(--muted)', fontWeight: 600, marginBottom: 4 }}>{t('Al', 'To')}</div><input type="date" value={range.to} min={range.from} onChange={e => setRange(r => ({ ...r, to: e.target.value }))} style={{ border: '1px solid var(--hair)', borderRadius: 9, outline: 'none', fontSize: 13.5, padding: '8px 10px', fontFamily: 'var(--sans)', background: 'var(--surface)', width: '100%', boxSizing: 'border-box' }} /></label>
              {range.status === 'work' && <label><div className="t-sm" style={{ color: 'var(--muted)', fontWeight: 600, marginBottom: 4 }}>{t('Orario', 'Hours')}</div><input value={range.hours} onChange={e => setRange(r => ({ ...r, hours: e.target.value }))} placeholder="9–18" style={{ border: '1px solid var(--hair)', borderRadius: 9, outline: 'none', fontSize: 13.5, padding: '8px 10px', fontFamily: 'var(--sans)', background: 'var(--surface)', width: '100%', boxSizing: 'border-box' }} /></label>}
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
              <button className="dk-btn dk-btn--ghost" style={{ flex: 1 }} onClick={() => setAddOpen(false)}>{t('Annulla', 'Cancel')}</button>
              <button className="dk-btn dk-btn--clay" style={{ flex: 1 }} onClick={applyRange}><Icon name="check" size={15} color="#fff" />{t('Aggiungi', 'Add')}</button>
            </div>
          </div>
        ) : (
          <button className="dk-btn dk-btn--clay" style={{ width: '100%', height: 46 }} onClick={() => setAddOpen(true)}><Icon name="plus" size={17} color="#fff" />{t('Aggiungi assenza / ferie', 'Add time-off')}</button>
        )}
        <div className="dk-card" style={{ padding: 18 }}>
          <div className="t-meta" style={{ marginBottom: 12 }}>{t('Legenda', 'Legend')}</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {Object.entries(AVAIL_STATUS).map(([k, meta]) => (
              <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ width: 14, height: 14, borderRadius: 4, background: meta.bg, border: '1px solid ' + meta.c, flexShrink: 0 }} />
                <span className="t-sm" style={{ fontWeight: 600 }}>{meta[lang]}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="dk-card" style={{ padding: 18 }}>
          <div className="t-meta" style={{ marginBottom: 10 }}>{t('Eccezioni · ' + months[m], 'Exceptions · ' + months[m])}</div>
          {(() => {
            const ex = Object.entries(avail).filter(([k]) => k.startsWith(`${y}-${String(m + 1).padStart(2, '0')}`)).sort();
            if (!ex.length) return <div className="t-sm" style={{ color: 'var(--muted-2)' }}>{t('Nessuna eccezione questo mese.', 'No exceptions this month.')}</div>;
            return <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>{ex.map(([k, v]) => { const meta = AVAIL_STATUS[v.status]; return (
              <button key={k} onClick={() => setPicker(k)} className="dk-row" style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '7px 9px', borderRadius: 9, textAlign: 'left', width: '100%' }}>
                <span style={{ width: 8, height: 8, borderRadius: 99, background: meta.c, flexShrink: 0 }} />
                <span className="t-sm" style={{ fontWeight: 700, width: 26 }}>{parseInt(k.slice(-2))}</span>
                <span className="t-sm" style={{ flex: 1, color: 'var(--ink-2)' }}>{meta[lang]}{v.status === 'work' && v.hours ? ' · ' + v.hours : ''}</span>
              </button>
            ); })}</div>;
          })()}
        </div>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '12px 14px', background: 'var(--clay-tint)', borderRadius: 12 }}>
          <Icon name="calendar" size={15} color="var(--clay-ink)" />
          <span className="t-sm" style={{ color: 'var(--clay-ink)', lineHeight: 1.45 }}>{t('Le eccezioni confluiscono nell\'agenda: nei giorni di ferie, libero o festività non vengono proposti slot prenotabili.', 'Exceptions flow into the calendar: on vacation, day-off or holiday dates no bookable slots are offered.')}</span>
        </div>
      </div>
    </div>
  );
}

function DkStaffPage({ id, o, data, setData, services, onToggleSvc, commissionPct, on, onToggle, onBack, t, lang, fireToast }) {
  const { setSelClient, setTab, opColors, setOpColor } = useDk();
  const P = STAFF_PERF[id];
  const max = Math.max(...P.trend);
  const inputCss = { border: '1px solid var(--hair)', borderRadius: 10, outline: 'none', fontSize: 14.5, padding: '10px 12px', fontFamily: 'var(--sans)', background: 'var(--surface)', width: '100%' };
  const earned = Math.round(P.month * commissionPct / 100);
  const metrics = [
    { label: t('Incasso mese', 'Month revenue'), value: fmtEur(P.month, lang) },
    { label: t('Prodotti venduti', 'Products sold'), value: window.STAFF_SOLD[id] },
    { label: t('Appuntamenti', 'Appointments'), value: P.appts },
    commissionPct > 0
      ? { label: t('Guadagno commissioni', 'Commission earned'), value: fmtEur(earned, lang), color: o.color }
      : { label: t('Clienti serviti', 'Clients served'), value: P.clients },
  ];
  const openClient = (cid) => { setSelClient(cid); setTab('clienti'); };
  const weeks = data.weeks || [];
  const setDayField = (wi, di, idx, v) => setData({ weeks: weeks.map((w, j) => j === wi ? { ...w, days: w.days.map((d, k) => k === di ? (idx === 2 ? [d[0], d[1], v, d[3] || ''] : [d[0], d[1], d[2], v]) : d) } : w) });
  const addWeek = () => { const base = STAFF_SHIFTS[id] || weeks[0].days.map(d => [d[0], d[1], '—', '']); setData({ weeks: [...weeks, { label: staffWeekLabel(weeks.length, lang), days: base.map(d => [d[0], d[1], '—', '']) }] }); };
  const removeWeek = (wi) => setData({ weeks: weeks.filter((_, j) => j !== wi).map((w, j) => ({ ...w, label: staffWeekLabel(j, lang) })) });
  const [staffTab, setStaffTab] = useStateDmi('anagrafica');
  const [cliQ, setCliQ] = useStateDmi('');
  const [saleQ, setSaleQ] = useStateDmi('');

  return (
    <div className="dk-page" style={{ maxWidth: 1180 }}>
      {/* header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 22 }}>
        <button className="dk-iconbtn" onClick={onBack}><Icon name="chevL" size={20} /></button>
        <Avatar initials={o.initials} size={56} color={o.color} ring />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontFamily: 'var(--serif)', fontSize: 26, fontWeight: 500, lineHeight: 1.1 }}>{data.name}</div>
          <div className="t-sm" style={{ color: 'var(--muted)' }}>{data.role[lang]}</div>
        </div>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, fontWeight: 700, color: on ? 'var(--ok)' : 'var(--muted)', background: on ? 'var(--ok-tint)' : 'var(--paper-2)', padding: '7px 13px', borderRadius: 99 }}><span style={{ width: 7, height: 7, borderRadius: 99, background: on ? 'var(--ok)' : 'var(--muted-2)' }} />{on ? t('In turno', 'On shift') : t('Fuori turno', 'Off shift')}</span>
        <button className="dk-btn dk-btn--clay" onClick={() => { onBack(); fireToast({ msg: t('Modifiche salvate', 'Changes saved'), icon: 'check' }); }}><Icon name="check" size={17} color="#fff" />{t('Salva', 'Save')}</button>
      </div>

      {/* sub-tabs: clear sections */}
      <div style={{ borderBottom: '1px solid var(--hair)', display: 'flex', gap: 4, marginBottom: 22 }}>
        {[['anagrafica', t('Anagrafica', 'Profile')], ['turni', t('Turni e ferie', 'Shifts & time off')], ['performance', t('Performance', 'Performance')], ['clienti', t('Clienti e vendite', 'Clients & sales')]].map(([k, l]) => (
          <button key={k} onClick={() => setStaffTab(k)} style={{ padding: '11px 4px', marginRight: 22, fontSize: 15.5, fontWeight: 600, cursor: 'pointer', color: staffTab === k ? 'var(--ink)' : 'var(--muted)', borderBottom: '2px solid ' + (staffTab === k ? 'var(--clay)' : 'transparent'), marginBottom: -1 }}>{l}</button>
        ))}
      </div>

      {/* ── ANAGRAFICA ── */}
      {staffTab === 'anagrafica' && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 18, alignItems: 'start' }}>
          <div className="dk-card" style={{ padding: 20 }}>
            <div className="t-meta" style={{ marginBottom: 14 }}>{t('Dati anagrafici', 'Personal details')}</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <label style={{ display: 'block' }}><div className="t-sm" style={{ color: 'var(--muted)', fontWeight: 600, marginBottom: 5 }}>{t('Nome', 'Name')}</div><input value={data.name} onChange={e => setData({ name: e.target.value })} style={inputCss} /></label>
              <label style={{ display: 'block' }}><div className="t-sm" style={{ color: 'var(--muted)', fontWeight: 600, marginBottom: 5 }}>{t('Ruolo', 'Role')}</div><input value={data.role[lang]} onChange={e => setData({ role: { ...data.role, [lang]: e.target.value } })} style={inputCss} /></label>
              <label style={{ display: 'block' }}><div className="t-sm" style={{ color: 'var(--muted)', fontWeight: 600, marginBottom: 5 }}>{t('Telefono', 'Phone')}</div><input value={data.phone} onChange={e => setData({ phone: e.target.value })} style={inputCss} /></label>
              <label style={{ display: 'block' }}><div className="t-sm" style={{ color: 'var(--muted)', fontWeight: 600, marginBottom: 5 }}>Email</div><input value={data.email} onChange={e => setData({ email: e.target.value })} style={inputCss} /></label>
            </div>
          </div>
          <div className="dk-card" style={{ padding: 20 }}>
            <div className="t-meta" style={{ marginBottom: 6 }}>{t('Colore operatrice', 'Stylist colour')}</div>
            <div className="t-sm" style={{ color: 'var(--muted)', marginBottom: 12 }}>{t('Identifica questa operatrice nell\u2019agenda e nei report.', 'Identifies this stylist in the calendar and reports.')}</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
              <label title={t('Ruota dei colori', 'Colour wheel')} style={{ position: 'relative', width: 34, height: 34, borderRadius: 9, cursor: 'pointer', overflow: 'hidden', flexShrink: 0, border: '1px solid var(--hair)', background: (opColors && opColors[id]) || o.color }}>
                <input type="color" value={(opColors && opColors[id]) || '#888888'} onChange={e => setOpColor(id, e.target.value)} style={{ position: 'absolute', inset: 0, opacity: 0, cursor: 'pointer' }} />
              </label>
              <HexInput value={(opColors && opColors[id]) || o.color} onChange={c => setOpColor(id, c)} width={70} />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3, maxWidth: 280 }}>
              {(window.GD_PALETTE || []).map((row, ri) => (
                <div key={ri} style={{ display: 'flex', gap: 3 }}>
                  {row.map(c => { const sel = ((opColors && opColors[id]) || '').toLowerCase() === c.toLowerCase(); return (
                    <button key={c} onClick={() => setOpColor(id, c)} title={c} style={{ width: 22, height: 22, borderRadius: 5, background: c, cursor: 'pointer', border: '1px solid ' + (c.toUpperCase() === '#FFFFFF' ? 'var(--hair)' : 'transparent'), outline: sel ? '2px solid var(--ink)' : 'none', outlineOffset: 1, flexShrink: 0 }} />
                  ); })}
                </div>
              ))}
            </div>
          </div>
          <div className="dk-card" style={{ padding: 20 }}>
            <div className="t-meta" style={{ marginBottom: 6 }}>{t('Servizi abilitati', 'Enabled services')}</div>
            <div className="t-sm" style={{ color: 'var(--muted)', marginBottom: 14 }}>{t('I servizi che questa operatrice può erogare. Determinano cosa è prenotabile sulla sua colonna in agenda.', 'The services this stylist can perform. They drive what is bookable on her column in the calendar.')}</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {SERVICES.map(s => { const onS = services.includes(s.id); return (
                <button key={s.id} onClick={() => onToggleSvc(s.id)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 12px', borderRadius: 99, fontSize: 12.5, fontWeight: 600, cursor: 'pointer', border: '1px solid ' + (onS ? 'var(--clay)' : 'var(--hair)'), background: onS ? 'var(--clay)' : 'var(--surface)', color: onS ? '#fff' : 'var(--ink-2)' }}>{svcName(s, lang)}<Icon name={onS ? 'check' : 'plus'} size={12} color={onS ? '#fff' : 'var(--muted-2)'} /></button>); })}
            </div>
          </div>
        </div>
      )}

      {/* ── TURNI E FERIE ── */}
      {staffTab === 'turni' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          {/* AI note */}
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '13px 16px', background: 'var(--clay-tint)', borderRadius: 12 }}>
            <Icon name="sparkle" size={16} color="var(--clay-ink)" />
            <span className="t-sm" style={{ color: 'var(--clay-ink)', lineHeight: 1.5 }}>{t('Turni e disponibilità alimentano la pianificazione automatica degli appuntamenti. Imposta il pattern ricorrente e programma le eccezioni con largo anticipo: l\'agenda proporrà slot solo quando l\'operatrice è effettivamente presente.', 'Shifts and availability feed automatic appointment planning. Set the recurring pattern and plan exceptions well ahead: the calendar offers slots only when the stylist is actually in.')}</span>
          </div>
          {/* recurring weekly pattern(s) — supports a multi-week rotation */}
          <div className="dk-card" style={{ padding: 20 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 4 }}>
              <div className="t-meta">{t('Pattern settimanale ricorrente', 'Recurring weekly pattern')}</div>
              <span className="t-sm" style={{ color: 'var(--muted-2)', fontWeight: 600 }}>{weeks.length > 1 ? t('rotazione di ' + weeks.length + ' settimane', weeks.length + '-week rotation') : t('valido ogni settimana', 'applies every week')}</span>
            </div>
            <div className="t-sm" style={{ color: 'var(--muted)', marginBottom: 16 }}>{t('Orario e pausa per ogni giorno. Aggiungi più settimane per una rotazione; le eccezioni (ferie, festività) si impostano nel calendario sotto.', 'Hours and break for each day. Add more weeks for a rotation; exceptions (vacation, holidays) are set in the calendar below.')}</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              {weeks.map((w, wi) => (
                <div key={wi} style={{ border: '1px solid var(--hair)', borderRadius: 12, padding: 14 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                    <span style={{ fontWeight: 700, fontSize: 13.5, color: 'var(--clay-ink)', flex: 1 }}>{w.label[lang] || w.label.it}</span>
                    {weeks.length > 1 && <button className="dk-iconbtn" style={{ width: 28, height: 28, borderRadius: 8 }} onClick={() => removeWeek(wi)} title={t('Rimuovi settimana', 'Remove week')}><Icon name="x" size={13} color="var(--muted)" /></button>}
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '46px 1fr 1fr', gap: '8px 10px', alignItems: 'center' }}>
                    <span className="t-meta" />
                    <span className="t-meta">{t('Orario', 'Hours')}</span>
                    <span className="t-meta">{t('Pausa', 'Break')}</span>
                    {w.days.map((s, di) => (
                      <React.Fragment key={di}>
                        <span style={{ fontWeight: 700, fontSize: 13, color: 'var(--ink-2)' }}>{t(s[0], s[1])}</span>
                        <input value={s[2]} onChange={e => setDayField(wi, di, 2, e.target.value)} placeholder={t('9–19 o riposo', '9–19 or off')} style={{ ...inputCss, padding: '8px 11px' }} />
                        <input value={s[3] || ''} onChange={e => setDayField(wi, di, 3, e.target.value)} placeholder={t('es. 13–14', 'e.g. 13–14')} style={{ ...inputCss, padding: '8px 11px' }} />
                      </React.Fragment>
                    ))}
                  </div>
                </div>
              ))}
            </div>
            <button onClick={addWeek} style={{ display: 'inline-flex', alignItems: 'center', gap: 7, marginTop: 14, padding: '9px 14px', borderRadius: 9, border: '1px dashed var(--hair)', background: 'var(--surface)', cursor: 'pointer', fontSize: 13, fontWeight: 600, color: 'var(--clay-ink)' }}><Icon name="plus" size={15} color="var(--clay-ink)" />{t('Aggiungi settimana', 'Add week')}</button>
          </div>
          {/* continuous availability calendar (plan ahead) */}
          <div>
            <div className="t-meta" style={{ marginBottom: 12 }}>{t('Calendario disponibilità · eccezioni', 'Availability calendar · exceptions')}</div>
            <AvailabilityCalendar data={data} setData={setData} t={t} lang={lang} />
          </div>
        </div>
      )}

      {/* ── PERFORMANCE ── */}
      {staffTab === 'performance' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          <div>
            <div className="t-meta" style={{ marginBottom: 10, display: 'flex', alignItems: 'center', gap: 6 }}><Icon name="insights" size={14} color="var(--muted)" />{t('Performance del mese', 'This month’s performance')}</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10 }}>
              {metrics.map((m, i) => (
                <div key={i} className="dk-card" style={{ padding: 14, boxShadow: 'none', border: '1px solid var(--hair)' }}>
                  <div className="t-meta" style={{ fontSize: 9.5, marginBottom: 5 }}>{m.label}</div>
                  <div className="t-num" style={{ fontSize: 19, color: m.color || 'var(--ink)' }}>{m.value}</div>
                </div>
              ))}
            </div>
          </div>
          <div className="dk-card" style={{ padding: '18px 20px 14px' }}>
            {(() => {
              const moLabels = ['Giu', 'Lug', 'Ago', 'Set', 'Ott', 'Nov'];
              const last = P.trend[P.trend.length - 1], prev = P.trend[P.trend.length - 2] || last;
              const delta = prev ? Math.round((last - prev) / prev * 100) : 0;
              const avg = Math.round(P.trend.reduce((a, b) => a + b, 0) / P.trend.length);
              const chartH = 150;
              return (
                <React.Fragment>
                  <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', marginBottom: 18 }}>
                    <div>
                      <div className="t-meta" style={{ marginBottom: 4 }}>{t('Andamento incassi · 6 mesi', 'Revenue trend · 6 months')}</div>
                      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                        <span className="t-num" style={{ fontSize: 24, fontWeight: 800 }}>{fmtEur(last, lang)}</span>
                        <span style={{ fontSize: 12.5, fontWeight: 700, color: delta >= 0 ? 'var(--ok)' : 'var(--danger)', display: 'inline-flex', alignItems: 'center', gap: 2 }}><Icon name={delta >= 0 ? 'arrowUp' : 'arrowDn'} size={13} color={delta >= 0 ? 'var(--ok)' : 'var(--danger)'} />{Math.abs(delta)}%</span>
                      </div>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <div className="t-meta" style={{ marginBottom: 4 }}>{t('Media', 'Average')}</div>
                      <span className="t-num" style={{ fontSize: 15, fontWeight: 700, color: 'var(--muted)' }}>{fmtEur(avg, lang)}</span>
                    </div>
                  </div>
                  <div style={{ position: 'relative', height: chartH }}>
                    {/* gridlines */}
                    {[0, 0.5, 1].map(g => <div key={g} style={{ position: 'absolute', left: 0, right: 0, bottom: g * (chartH - 22) + 22, height: 1, background: 'var(--hair)', opacity: g === 0 ? 1 : 0.5 }} />)}
                    {/* average reference */}
                    <div style={{ position: 'absolute', left: 0, right: 0, bottom: (avg / max) * (chartH - 22) + 22, height: 1, borderTop: '1px dashed var(--clay)', opacity: 0.6 }} />
                    <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'flex-end', gap: 14 }}>
                      {P.trend.map((v, i) => { const isLast = i === P.trend.length - 1; return (
                        <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, height: '100%', justifyContent: 'flex-end' }}>
                          <span className="t-sm" style={{ fontSize: 10.5, fontWeight: 700, color: isLast ? o.color : 'var(--muted-2)' }}>{fmtEur(v, lang)}</span>
                          <div style={{ width: '100%', maxWidth: 38, height: (v / max) * (chartH - 22) + 'px', borderRadius: '7px 7px 0 0', background: isLast ? o.color : 'color-mix(in srgb, ' + o.color + ' 30%, var(--paper-2))', transition: 'height var(--dur-base) var(--ease-classic)' }} />
                          <span className="t-sm" style={{ fontSize: 10.5, fontWeight: isLast ? 700 : 500, color: isLast ? 'var(--ink)' : 'var(--muted-2)' }}>{moLabels[i]}</span>
                        </div>
                      ); })}
                    </div>
                  </div>
                </React.Fragment>
              );
            })()}
          </div>
        </div>
      )}

      {/* ── CLIENTI E VENDITE ── */}
      {staffTab === 'clienti' && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 18, alignItems: 'start' }}>
          <div>
            <div className="t-meta" style={{ marginBottom: 10 }}>{t('Clienti seguiti', 'Regular clients')}</div>
            <div className="dk-search" style={{ width: '100%', marginBottom: 10 }}>
              <Icon name="search" size={16} color="var(--muted-2)" />
              <input value={cliQ} onChange={e => setCliQ(e.target.value)} placeholder={t('Cerca cliente…', 'Search client…')} />
              {cliQ && <button onClick={() => setCliQ('')} style={{ cursor: 'pointer', display: 'grid', placeItems: 'center' }}><Icon name="x" size={14} color="var(--muted-2)" /></button>}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {P.top.map(cid => client(cid)).filter(c => c && (!cliQ || c.name.toLowerCase().includes(cliQ.toLowerCase()))).map(c => (
                <button key={c.id} className="dk-card dk-row" onClick={() => openClient(c.id)} style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '10px 12px', boxShadow: 'none', border: '1px solid var(--hair)', textAlign: 'left' }}>
                  <Avatar initials={c.initials} size={34} />
                  <div style={{ flex: 1, minWidth: 0 }}><div style={{ fontWeight: 600, fontSize: 14 }}>{c.name}</div><div className="t-sm" style={{ color: 'var(--muted)' }}>{c.visits} {t('visite', 'visits')} · {fmtEur(c.value, lang)}</div></div>
                  <Icon name="chevR" size={15} color="var(--muted-2)" />
                </button>
              ))}
              {P.top.map(cid => client(cid)).filter(c => c && (!cliQ || c.name.toLowerCase().includes(cliQ.toLowerCase()))).length === 0 && <div className="t-sm" style={{ color: 'var(--muted-2)', padding: '16px 4px' }}>{t('Nessun cliente trovato.', 'No client found.')}</div>}
            </div>
          </div>
          <div>
            <div className="t-meta" style={{ marginBottom: 10 }}>{t('Vendite recenti', 'Recent sales')}</div>
            <div className="dk-search" style={{ width: '100%', marginBottom: 10 }}>
              <Icon name="search" size={16} color="var(--muted-2)" />
              <input value={saleQ} onChange={e => setSaleQ(e.target.value)} placeholder={t('Cerca per servizio o cliente…', 'Search by service or client…')} />
              {saleQ && <button onClick={() => setSaleQ('')} style={{ cursor: 'pointer', display: 'grid', placeItems: 'center' }}><Icon name="x" size={14} color="var(--muted-2)" /></button>}
            </div>
            <div className="dk-card" style={{ overflow: 'hidden' }}>
              {(() => {
                const dates = lang === 'en' ? ['24 Jun', '23 Jun', '21 Jun', '19 Jun', '17 Jun'] : ['24 giu', '23 giu', '21 giu', '19 giu', '17 giu'];
                const rows = P.top.slice(0, 5).map((cid, i) => { const c = client(cid); const sv = SERVICES[(i + id.length) % SERVICES.length]; const amt = [85, 120, 60, 150, 45][i % 5]; return { c, sv, amt, date: dates[i] }; }).filter(r => r.c).filter(r => !saleQ || svcName(r.sv, lang).toLowerCase().includes(saleQ.toLowerCase()) || r.c.name.toLowerCase().includes(saleQ.toLowerCase()));
                if (!rows.length) return <div className="t-sm" style={{ color: 'var(--muted-2)', padding: 20, textAlign: 'center' }}>{saleQ ? t('Nessuna vendita trovata.', 'No sale found.') : t('Nessuna vendita registrata.', 'No sales recorded.')}</div>;
                return rows.map((r, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '12px 14px', borderTop: i ? '1px solid var(--hair)' : 'none' }}>
                    <div style={{ width: 34, height: 34, borderRadius: 9, background: 'var(--clay-tint)', display: 'grid', placeItems: 'center', flexShrink: 0 }}><Icon name="wallet" size={16} color="var(--clay-ink)" /></div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 600, fontSize: 13.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{svcName(r.sv, lang)}</div>
                      <div className="t-sm" style={{ color: 'var(--muted)' }}>{r.c.name} · {r.date}</div>
                    </div>
                    <span className="t-num" style={{ fontWeight: 700, fontSize: 14, flexShrink: 0 }}>{fmtEur(r.amt, lang)}</span>
                  </div>
                ));
              })()}
            </div>
            <div className="t-sm" style={{ color: 'var(--muted-2)', marginTop: 10, textAlign: 'center' }}>{t('Totale prodotti venduti questo mese', 'Total products sold this month')}: <b style={{ color: 'var(--ink-2)' }}>{window.STAFF_SOLD[id]}</b></div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------------- Categorie manager ---------------- */
const swatches = ['#6FB89A', '#5FAEC9', '#9B86E0', '#E0A85A', '#D9B65C', '#E08B9A', '#7FA8E0', '#E0857A', '#7BC4A3', '#C99BD9'];
// Google-Docs-style palette: a grayscale row + a saturated row + tint/shade rows
function gdHexFromHSL(h, s, l) {
  s /= 100; l /= 100;
  const k = n => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = n => { const c = l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1))); return Math.round(255 * c).toString(16).padStart(2, '0'); };
  return ('#' + f(0) + f(8) + f(4)).toUpperCase();
}
const GD_HUES = [0, 22, 45, 90, 140, 175, 205, 230, 265, 300];
const GD_PALETTE = (() => {
  const rows = [];
  // grayscale row (dark → white)
  rows.push(['#000000', '#434343', '#666666', '#999999', '#B7B7B7', '#CCCCCC', '#D9D9D9', '#EFEFEF', '#F3F3F3', '#FFFFFF']);
  // saturated standard row
  rows.push(GD_HUES.map(h => gdHexFromHSL(h, 78, 50)));
  // tints (light → mid)
  [92, 84, 74].forEach(l => rows.push(GD_HUES.map(h => gdHexFromHSL(h, 70, l))));
  // shades (mid → dark)
  [40, 30, 20].forEach(l => rows.push(GD_HUES.map(h => gdHexFromHSL(h, 65, l))));
  return rows;
})();
function CategoriesManager({ onClose, t, lang, fireToast, initialType }) {
  const { clientCats, setClientCats, svcCats, setSvcCats, invCats, setInvCats } = useDk();
  const [type, setType] = useStateDmi(initialType || 'clienti');
  const [dragIdx, setDragIdx] = useStateDmi(null);
  const seq = useRefDmi(500);
  const [edit, setEdit] = useStateDmi(null);

  const types = [['clienti', t('Clienti', 'Clients'), 'clients'], ['servizi', t('Servizi', 'Services'), 'scissors'], ['magazzino', t('Magazzino', 'Inventory'), 'box']];
  const list = type === 'clienti' ? clientCats : type === 'servizi' ? svcCats : invCats;
  const save = (d) => {
    const upd = (arr) => d._new ? [...arr, { id: d.id, name: d.name, color: d.color }] : arr.map(c => c.id === d.id ? { id: d.id, name: d.name, color: d.color } : c);
    if (type === 'clienti') setClientCats(upd); else if (type === 'servizi') setSvcCats(upd); else setInvCats(upd);
    setEdit(null); fireToast({ msg: t('Categoria salvata', 'Category saved'), icon: 'check' });
  };
  const del = (id) => {
    if (type === 'clienti') setClientCats(arr => arr.filter(c => c.id !== id)); else if (type === 'servizi') setSvcCats(arr => arr.filter(c => c.id !== id)); else setInvCats(arr => arr.filter(c => c.id !== id));
    setEdit(null); fireToast({ msg: t('Categoria eliminata', 'Category deleted'), icon: 'x' });
  };
  const blank = () => ({ id: 'cat' + (seq.current++), name: { it: '', en: '' }, color: swatches[Math.floor(Math.random() * swatches.length)], _new: true });
  const setList = (fn) => { if (type === 'clienti') setClientCats(fn); else if (type === 'servizi') setSvcCats(fn); else setInvCats(fn); };
  const reorder = (from, to) => { setList(arr => { const a = [...arr]; const [m] = a.splice(from, 1); a.splice(to, 0, m); return a; }); fireToast({ msg: t('Ordine aggiornato', 'Order updated'), icon: 'check' }); };

  return (
    <DkDrawer open onClose={onClose}>
      <div style={{ padding: '22px 22px 0', borderBottom: '1px solid var(--hair)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
          <div><div style={{ fontFamily: 'var(--serif)', fontSize: 22, fontWeight: 500 }}>{t('Categorie', 'Categories')}</div><div className="t-sm" style={{ color: 'var(--muted)', marginTop: 2 }}>{t('Crea e modifica le categorie', 'Create and edit categories')}</div></div>
          <button className="dk-iconbtn" onClick={onClose}><Icon name="x" size={18} /></button>
        </div>
        <div style={{ display: 'flex', gap: 4 }}>
          {types.map(([k, l, ic]) => (
            <button key={k} onClick={() => setType(k)} style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '11px 4px', marginRight: 18, fontSize: 14.5, fontWeight: 600, cursor: 'pointer', color: type === k ? 'var(--ink)' : 'var(--muted)', borderBottom: '2px solid ' + (type === k ? 'var(--clay)' : 'transparent'), marginBottom: -1 }}>
              <Icon name={ic} size={16} color={type === k ? 'var(--clay-ink)' : 'var(--muted)'} />{l}
            </button>
          ))}
        </div>
      </div>
      <div className="scroll" style={{ flex: 1, overflowY: 'auto', padding: '18px 22px 30px' }}>
        <button className="dk-btn dk-btn--clay" style={{ width: '100%', marginBottom: 16 }} onClick={() => setEdit(blank())}><Icon name="plus" size={16} color="#fff" />{t('Nuova categoria', 'New category')}</button>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {list.map((c, i) => (
            <div key={c.id} className="dk-card dk-row" draggable
              onDragStart={e => { setDragIdx(i); e.dataTransfer.effectAllowed = 'move'; }}
              onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }}
              onDrop={e => { e.preventDefault(); if (dragIdx !== null && dragIdx !== i) reorder(dragIdx, i); setDragIdx(null); }}
              onDragEnd={() => setDragIdx(null)}
              onClick={() => setEdit({ ...c, name: { ...c.name } })}
              style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '13px 14px', boxShadow: 'none', border: '1px solid ' + (dragIdx === i ? 'var(--clay)' : 'var(--hair)'), opacity: dragIdx === i ? 0.5 : 1 }}>
              <span title={t('Trascina per riordinare', 'Drag to reorder')} style={{ cursor: 'grab', color: 'var(--muted-2)', fontSize: 15, lineHeight: 1, letterSpacing: '-3px', flexShrink: 0, userSelect: 'none' }} onClick={e => e.stopPropagation()}>⋮⋮</span>
              <span style={{ width: 14, height: 14, borderRadius: 99, background: c.color, flexShrink: 0 }} />
              <span style={{ flex: 1, fontWeight: 600, fontSize: 14.5 }}>{c.name[lang] || c.name.it}</span>
              <button className="dk-iconbtn" style={{ width: 30, height: 30, borderRadius: 8 }} onClick={(e) => { e.stopPropagation(); setEdit({ ...c, name: { ...c.name } }); }}><Icon name="edit" size={14} /></button>
              <button className="dk-iconbtn" style={{ width: 30, height: 30, borderRadius: 8 }} onClick={(e) => { e.stopPropagation(); del(c.id); }}><Icon name="x" size={14} color="var(--danger)" /></button>
            </div>
          ))}
          {!list.length && <EmptyState icon="tag" title={t('Nessuna categoria', 'No categories')} sub={t('Crea la prima categoria.', 'Create the first category.')} />}
        </div>
      </div>
      {edit && <CatEditModal draft={edit} setDraft={setEdit} onSave={save} onDelete={del} onClose={() => setEdit(null)} t={t} lang={lang} />}
    </DkDrawer>
  );
}

function CatEditModal({ draft, setDraft, onSave, onDelete, onClose, t, lang }) {
  const setName = (v) => setDraft(d => ({ ...d, name: { ...d.name, [lang]: v } }));
  const canSave = (draft.name[lang] || '').trim();
  return (
    <DkModal open onClose={onClose} title={draft._new ? t('Nuova categoria', 'New category') : t('Modifica categoria', 'Edit category')} width={440}
      foot={<React.Fragment>
        {!draft._new && <button className="dk-btn dk-btn--ghost" style={{ color: 'var(--danger)', borderColor: 'color-mix(in srgb, var(--danger) 40%, var(--hair))', marginRight: 'auto' }} onClick={() => onDelete(draft.id)}><Icon name="x" size={16} color="var(--danger)" />{t('Elimina', 'Delete')}</button>}
        <button className="dk-btn dk-btn--ghost" onClick={onClose}>{t('Annulla', 'Cancel')}</button>
        <button className="dk-btn dk-btn--clay" disabled={!canSave} onClick={() => canSave && onSave(draft)}><Icon name="check" size={17} color="#fff" />{t('Salva', 'Save')}</button>
      </React.Fragment>}>
      <div className="t-meta" style={{ marginBottom: 8 }}>{t('Nome categoria', 'Category name')}</div>
      <input value={draft.name[lang] || ''} onChange={e => setName(e.target.value)} placeholder={t('Nome categoria', 'Category name')} autoFocus style={{ width: '100%', border: '1px solid var(--hair)', borderRadius: 10, outline: 'none', fontSize: 15, padding: '11px 13px', fontFamily: 'var(--sans)', background: 'var(--surface)', marginBottom: 18 }} />
      <div className="t-meta" style={{ marginBottom: 10 }}>{t('Colore', 'Colour')}</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
        <label title={t('Ruota dei colori', 'Colour wheel')} style={{ position: 'relative', width: 48, height: 48, borderRadius: 12, cursor: 'pointer', overflow: 'hidden', flexShrink: 0, border: '1px solid var(--hair)', background: draft.color || '#888' }}>
          <input type="color" value={draft.color || '#888888'} onChange={e => setDraft(d => ({ ...d, color: e.target.value }))} style={{ position: 'absolute', inset: 0, opacity: 0, cursor: 'pointer' }} />
        </label>
        <div style={{ flex: 1 }}>
          <div className="t-sm" style={{ color: 'var(--muted)', fontWeight: 600, marginBottom: 4 }}>{t('Codice esadecimale', 'Hex code')}</div>
          <HexInput value={draft.color} onChange={c => setDraft(d => ({ ...d, color: c }))} />
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3, maxWidth: 280 }}>
        {GD_PALETTE.map((row, ri) => (
          <div key={ri} style={{ display: 'flex', gap: 3 }}>
            {row.map(c => { const on = (draft.color || '').toLowerCase() === c.toLowerCase(); return (
              <button key={c} onClick={() => setDraft(d => ({ ...d, color: c }))} title={c} style={{ width: 22, height: 22, borderRadius: 5, background: c, cursor: 'pointer', border: '1px solid ' + (c.toUpperCase() === '#FFFFFF' ? 'var(--hair)' : 'transparent'), outline: on ? '2px solid var(--ink)' : 'none', outlineOffset: 1, flexShrink: 0, display: 'grid', placeItems: 'center' }}>{on && <Icon name="check" size={12} color={ri === 0 && row.indexOf(c) > 6 ? 'var(--ink)' : '#fff'} stroke={2.6} />}</button>
            ); })}
          </div>
        ))}
      </div>
    </DkModal>
  );
}

/* ---------------- Brand & client app manager ---------------- */
const PASTELS = [
  { id: 'rosa', name: { it: 'Rosa cipria', en: 'Blush pink' }, color: '#E8B4BC' },
  { id: 'pesca', name: { it: 'Pesca', en: 'Peach' }, color: '#F0C9A8' },
  { id: 'azzurro', name: { it: 'Azzurro polvere', en: 'Dusty blue' }, color: '#AECBD6' },
  { id: 'salvia', name: { it: 'Verde salvia', en: 'Sage green' }, color: '#B7C9A8' },
  { id: 'lavanda', name: { it: 'Lavanda', en: 'Lavender' }, color: '#C9B8D6' },
  { id: 'sabbia', name: { it: 'Sabbia', en: 'Sand' }, color: '#E2D4BC' },
];
function BrandManager({ onClose, t, lang, fireToast }) {
  const [logo, setLogo] = useStateDmi(null);
  const [color, setColor] = useStateDmi('#E8B4BC');
  const fileRef = useRefDmi(null);
  const sel = { color };
  const onFile = (e) => { const f = e.target.files && e.target.files[0]; if (f) { const r = new FileReader(); r.onload = ev => setLogo(ev.target.result); r.readAsDataURL(f); } };
  const Logo = ({ size, dark }) => logo
    ? <img src={logo} alt="logo" style={{ width: size, height: size, objectFit: 'cover', borderRadius: 10 }} />
    : <div style={{ width: size, height: size, borderRadius: 10, background: sel.color, display: 'grid', placeItems: 'center', color: '#fff', fontWeight: 800, fontFamily: 'var(--serif)', fontSize: size * 0.42 }}>P</div>;
  return (
    <DkDrawer open onClose={onClose}>
      <div style={{ padding: '22px 22px 18px', borderBottom: '1px solid var(--hair)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ minWidth: 0 }}><div style={{ fontFamily: 'var(--serif)', fontSize: 22, fontWeight: 500, lineHeight: 1.15 }}>{t('Brand & app cliente', 'Brand & client app')}</div><div className="t-sm" style={{ color: 'var(--muted)', marginTop: 4 }}>The Parlour · Firenze</div></div>
        <button className="dk-iconbtn" style={{ flexShrink: 0, marginLeft: 12 }} onClick={onClose}><Icon name="x" size={18} /></button>
      </div>
      <div className="scroll" style={{ flex: 1, overflowY: 'auto', padding: '18px 22px 30px' }}>
        {/* logo upload */}
        <div className="t-meta" style={{ marginBottom: 10 }}>{t('Logo', 'Logo')}</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 8 }}>
          <Logo size={64} />
          <div style={{ flex: 1 }}>
            <button className="dk-btn dk-btn--ghost" onClick={() => fileRef.current && fileRef.current.click()}><Icon name="plus" size={16} />{logo ? t('Cambia logo', 'Change logo') : t('Carica logo', 'Upload logo')}</button>
            {logo && <button onClick={() => setLogo(null)} style={{ marginLeft: 10, cursor: 'pointer', fontSize: 13, fontWeight: 700, color: 'var(--danger)' }}>{t('Rimuovi', 'Remove')}</button>}
            <input ref={fileRef} type="file" accept="image/*" onChange={onFile} style={{ display: 'none' }} />
          </div>
        </div>
        <div className="t-sm" style={{ color: 'var(--muted-2)', marginBottom: 22 }}>{t('Sostituirà il logo in basso a sinistra e in alto a destra.', 'Replaces the logo bottom-left and top-right.')}</div>

        {/* primary color — full wheel + hex */}
        <div className="t-meta" style={{ marginBottom: 10 }}>{t('Colore principale', 'Primary colour')}</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
          <label title={t('Ruota dei colori', 'Colour wheel')} style={{ position: 'relative', width: 48, height: 48, borderRadius: 12, cursor: 'pointer', overflow: 'hidden', flexShrink: 0, border: '1px solid var(--hair)', background: color }}>
            <input type="color" value={color} onChange={e => setColor(e.target.value)} style={{ position: 'absolute', inset: 0, opacity: 0, cursor: 'pointer' }} />
          </label>
          <div style={{ flex: 1 }}>
            <div className="t-sm" style={{ color: 'var(--muted)', fontWeight: 600, marginBottom: 4 }}>{t('Codice esadecimale', 'Hex code')}</div>
            <HexInput value={color} onChange={c => setColor(c)} />
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3, maxWidth: 280, marginBottom: 22 }}>
          {(window.GD_PALETTE || []).map((row, ri) => (
            <div key={ri} style={{ display: 'flex', gap: 3 }}>
              {row.map(c => { const on = (color || '').toLowerCase() === c.toLowerCase(); return (
                <button key={c} onClick={() => setColor(c)} title={c} style={{ width: 22, height: 22, borderRadius: 5, background: c, cursor: 'pointer', border: '1px solid ' + (c.toUpperCase() === '#FFFFFF' ? 'var(--hair)' : 'transparent'), outline: on ? '2px solid var(--ink)' : 'none', outlineOffset: 1, flexShrink: 0 }} />
              ); })}
            </div>
          ))}
        </div>

        {/* live preview */}
        <div className="t-meta" style={{ marginBottom: 10 }}>{t('Anteprima', 'Preview')}</div>
        {/* client app mock cover */}
        <div style={{ borderRadius: 14, overflow: 'hidden', border: '1px solid var(--hair)', marginBottom: 16 }}>
          <div style={{ height: 70, background: sel.color, display: 'flex', alignItems: 'flex-end', padding: 12 }}>
            <span style={{ fontFamily: 'var(--serif)', fontSize: 20, fontWeight: 600, color: '#fff' }}>The Parlour</span>
          </div>
          <div style={{ padding: 12, background: 'var(--surface)' }}>
            <div style={{ height: 8, width: '60%', borderRadius: 4, background: 'var(--paper-2)', marginBottom: 8 }} />
            <div style={{ height: 30, borderRadius: 99, background: sel.color, display: 'grid', placeItems: 'center', color: '#fff', fontSize: 12, fontWeight: 700 }}>{t('Prenota', 'Book')}</div>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '11px 14px', background: 'var(--info-tint)', borderRadius: 12, marginBottom: 18 }}>
          <Icon name="info" size={16} color="var(--info)" />
          <span className="t-sm" style={{ color: 'var(--ink-2)', fontWeight: 600 }}>{t('Per ora è un’anteprima: il tema non viene ancora applicato a tutta la dashboard.', 'For now this is a preview: the theme is not yet applied across the whole dashboard.')}</span>
        </div>
        <button className="dk-btn dk-btn--clay" style={{ width: '100%' }} onClick={() => { onClose(); fireToast({ msg: t('Brand salvato (anteprima)', 'Brand saved (preview)'), icon: 'check' }); }}><Icon name="check" size={17} color="#fff" />{t('Salva', 'Save')}</button>
      </div>
    </DkDrawer>
  );
}

/* ---------------- Commission manager ---------------- */
function CommissionManager({ commission, setCommission, onClose, t, lang, fireToast }) {
  const set = (id, v) => setCommission(c => ({ ...c, [id]: Math.max(0, Math.min(100, parseInt(v) || 0)) }));
  return (
    <DkDrawer open onClose={onClose}>
      <div style={{ padding: '22px 22px 18px', borderBottom: '1px solid var(--hair)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div><div style={{ fontFamily: 'var(--serif)', fontSize: 22, fontWeight: 500 }}>{t('Commissioni vendita', 'Sales commission')}</div><div className="t-sm" style={{ color: 'var(--muted)', marginTop: 2 }}>{t('Lascia 0 per non mostrarla', 'Set 0 to hide it')}</div></div>
        <button className="dk-iconbtn" onClick={onClose}><Icon name="x" size={18} /></button>
      </div>
      <div className="scroll" style={{ flex: 1, overflowY: 'auto', padding: '18px 22px 30px' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {OPS.map(o => (
            <div key={o.id} className="dk-card" style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', boxShadow: 'none', border: '1px solid var(--hair)' }}>
              <Avatar initials={o.initials} size={38} color={o.color} ring />
              <div style={{ flex: 1, minWidth: 0 }}><div style={{ fontWeight: 600, fontSize: 14.5 }}>{o.name}</div><div className="t-sm" style={{ color: 'var(--muted)' }}>{o.role[lang]}</div></div>
              <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, border: '1px solid var(--hair)', borderRadius: 10, padding: '0 12px', height: 42, background: 'var(--surface)' }}>
                <input type="number" value={commission[o.id] || 0} onChange={e => set(o.id, e.target.value)} style={{ border: 'none', outline: 'none', background: 'transparent', fontSize: 16, fontWeight: 700, width: 48, textAlign: 'right' }} />
                <span className="t-sm" style={{ color: 'var(--muted-2)', fontWeight: 700 }}>%</span>
              </div>
            </div>
          ))}
        </div>
        <button className="dk-btn dk-btn--clay" style={{ width: '100%', marginTop: 18 }} onClick={() => { onClose(); fireToast({ msg: t('Commissioni salvate', 'Commission saved'), icon: 'check' }); }}><Icon name="check" size={17} color="#fff" />{t('Salva', 'Save')}</button>
      </div>
    </DkDrawer>
  );
}

/* ---------------- Impostazioni ---------------- */
// grouped link-style rows — module scope: stable component identity across DkSettings re-renders
const Group = ({ title, children }) => (
  <div style={{ marginBottom: 24 }}>
    <div className="t-meta" style={{ marginBottom: 10 }}>{title}</div>
    <div className="dk-card" style={{ padding: 6 }}>{children}</div>
  </div>
);
const Row = ({ icon, label, sub, value, onClick, first }) => (
  <div className="dk-row" onClick={onClick} style={{ display: 'flex', alignItems: 'center', gap: 13, padding: '14px 16px', borderTop: first ? 'none' : '1px solid var(--hair)', borderRadius: 10, cursor: onClick ? 'pointer' : 'default' }}>
    <Icon name={icon} size={19} color="var(--muted)" />
    <div style={{ flex: 1, minWidth: 0 }}><div style={{ fontWeight: 600, fontSize: 14.5 }}>{label}</div>{sub && <div className="t-sm" style={{ color: 'var(--muted)' }}>{sub}</div>}</div>
    {value && <span className="t-sm" style={{ color: 'var(--muted-2)', maxWidth: '42%', textAlign: 'right', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{value}</span>}
    {onClick && <Icon name="chevR" size={15} color="var(--faint)" />}
  </div>
);

function DkSettings() {
  const { t, lang, fireToast, setLang, commission, setCommission, depositRule, setDepositRule, deepLink, setDeepLink } = useDk();
  const [cats, setCats] = useStateDmi(false);
  const [comm, setComm] = useStateDmi(false);
  const [brandOpen, setBrandOpen] = useStateDmi(false);
  const [teamOpen, setTeamOpen] = useStateDmi(false);
  const [rolesOpen, setRolesOpen] = useStateDmi(false);
  const [logOpen, setLogOpen] = useStateDmi(false);
  const [page, setPage] = useStateDmi(null);
  useEffectDmi(() => { if (deepLink === 'log-today') { setPage('log'); setDeepLink && setDeepLink(null); } }, [deepLink]);

  if (page === 'bookings') return <DkBookingsOptim onBack={() => setPage(null)} />;
  if (page === 'log') return <DkActivityLogPage onBack={() => setPage(null)} t={t} lang={lang} initialPeriod="today" />;

  return (
    <div className="dk-page" style={{ maxWidth: 760 }}>
      {/* brand teaser → left as-is */}
      <div className="dk-card" style={{ padding: 22, marginBottom: 24, display: 'flex', alignItems: 'center', gap: 16, background: 'linear-gradient(120deg, var(--ink), #34291f)' }}>
        <div style={{ width: 46, height: 46, borderRadius: 13, background: 'rgba(255,255,255,0.12)', display: 'grid', placeItems: 'center' }}><Icon name="palette" size={22} color="var(--clay-tint)" /></div>
        <div style={{ flex: 1 }}><div style={{ fontWeight: 700, fontSize: 16, color: '#fff' }}>{t('Brand & app cliente', 'Brand & client app')}</div><div style={{ fontSize: 13, color: 'rgba(255,255,255,0.6)' }}>{t('Personalizza colore, logo e tipografia della superficie cliente', 'Customize colour, logo and type of the client surface')}</div></div>
        <button className="dk-btn" style={{ background: '#fff', color: 'var(--ink)' }} onClick={() => setBrandOpen(true)}>{t('Personalizza', 'Customize')}</button>
      </div>

      {/* SALONE */}
      <Group title={t('Salone', 'Salon')}>
        <Row first icon="mapPin" label={t('Indirizzo', 'Address')} value="Via de’ Tornabuoni 12, Firenze" onClick={() => fireToast({ msg: t('Modifica indirizzo', 'Edit address'), icon: 'edit' })} />
        <Row icon="clock" label={t('Orari di apertura', 'Opening hours')} value={t('Mar–Sab · 9–19', 'Tue–Sat · 9–19')} onClick={() => fireToast({ msg: t('Modifica orari', 'Edit hours'), icon: 'edit' })} />
        <Row icon="phone" label={t('Telefono', 'Phone')} value="+39 055 21 00 94" onClick={() => fireToast({ msg: t('Modifica telefono', 'Edit phone'), icon: 'edit' })} />
        <Row icon="globe" label={t('Sito prenotazioni', 'Booking site')} value="prenota.theparlour.it" onClick={() => fireToast({ msg: t('Modifica sito', 'Edit site'), icon: 'edit' })} />
      </Group>

      {/* PRENOTAZIONI & OTTIMIZZAZIONE — entry prominente verso pagina dedicata */}
      <button className="dk-card" onClick={() => setPage('bookings')} style={{ width: '100%', textAlign: 'left', padding: 22, marginBottom: 24, display: 'flex', alignItems: 'center', gap: 18, background: 'linear-gradient(120deg, #2D1F5E, #4A3380)', border: 'none', cursor: 'pointer' }}>
        <div style={{ width: 50, height: 50, borderRadius: 14, background: 'rgba(255,255,255,0.15)', display: 'grid', placeItems: 'center', flexShrink: 0 }}><Icon name="sparkle" size={24} color="#fff" /></div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 17, color: '#fff' }}>{t('Prenotazioni & ottimizzazione', 'Bookings & optimization')}</div>
          <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.65)', marginTop: 3, lineHeight: 1.4 }}>{t('Riempimento agenda, recupero buchi, clienti flessibili, sconti last-minute, deposito anti no-show e regole personalizzate.', 'Agenda fill, gap recovery, flexible clients, last-minute discounts, no-show deposit and custom rules.')}</div>
        </div>
        <Icon name="chevR" size={22} color="rgba(255,255,255,0.7)" style={{ flexShrink: 0 }} />
      </button>

      {/* LINGUA — section + selectable options (no toggle) */}
      <Group title={t('Lingua', 'Language')}>
        {[['it', 'Italiano', 'Italiano'], ['en', 'English', 'English']].map(([k, l], i) => (
          <div key={k} className="dk-row" onClick={() => setLang(k)} style={{ display: 'flex', alignItems: 'center', gap: 13, padding: '14px 16px', borderTop: i ? '1px solid var(--hair)' : 'none', borderRadius: 10, cursor: 'pointer' }}>
            <Icon name="globe" size={19} color={lang === k ? 'var(--clay-ink)' : 'var(--muted)'} />
            <span style={{ flex: 1, fontWeight: 600, fontSize: 14.5, color: lang === k ? 'var(--ink)' : 'var(--ink-2)' }}>{l}</span>
            {lang === k && <Icon name="check" size={18} color="var(--clay-ink)" stroke={2.4} />}
          </div>
        ))}
      </Group>

      {/* GESTIONE */}
      <Group title={t('Gestione', 'Management')}>
        <Row first icon="user" label={t('Commissioni vendita', 'Sales commission')} sub={t('% che ogni membro guadagna sulle vendite', '% each member earns on sales')} onClick={() => setComm(true)} />
        <Row icon="tag" label={t('Categorie', 'Categories')} sub={t('Clienti, servizi e magazzino', 'Clients, services and inventory')} onClick={() => setCats(true)} />
      </Group>

      {/* NOTIFICHE */}
      <Group title={t('Notifiche & comunicazioni', 'Notifications')}>
        <Row first icon="bell" label={t('Notifiche push', 'Push notifications')} value={t('Attive', 'On')} onClick={() => fireToast({ msg: t('Gestisci notifiche', 'Manage notifications'), icon: 'bell' })} />
        <Row icon="whatsapp" label={t('Numero WhatsApp Business', 'WhatsApp Business number')} value="+39 055 21 00 94" onClick={() => fireToast({ msg: t('Modifica numero', 'Edit number'), icon: 'edit' })} />
        <Row icon="message" label={t('Mittente SMS', 'SMS sender')} value="TheParlour" onClick={() => fireToast({ msg: t('Modifica mittente', 'Edit sender'), icon: 'edit' })} />
      </Group>

      {/* ACCOUNT */}
      <Group title={t('Account & team', 'Account & team')}>
        <Row first icon="user" label={t('Membri del team', 'Team members')} value="9" onClick={() => setTeamOpen(true)} />
        <Row icon="settings" label={t('Ruoli e permessi', 'Roles & permissions')} value={t('Gestisci', 'Manage')} onClick={() => setRolesOpen(true)} />
        <Row icon="clock" label={t('Registro attività', 'Activity log')} value={t('Solo titolare', 'Owner only')} onClick={() => setPage('log')} />
      </Group>

      <div className="t-sm" style={{ textAlign: 'center', color: 'var(--muted-2)', marginTop: 8 }}>yourang · v1.0 · {t('App salone desktop', 'Salon desktop app')}</div>
      {cats && <CategoriesManager onClose={() => setCats(false)} t={t} lang={lang} fireToast={fireToast} />}
      {comm && <CommissionManager commission={commission} setCommission={setCommission} onClose={() => setComm(false)} t={t} lang={lang} fireToast={fireToast} />}
      {brandOpen && <BrandManager onClose={() => setBrandOpen(false)} t={t} lang={lang} fireToast={fireToast} />}
      {teamOpen && <TeamManager onClose={() => setTeamOpen(false)} onRoles={() => { setTeamOpen(false); setRolesOpen(true); }} t={t} lang={lang} fireToast={fireToast} />}
      {rolesOpen && <RolesManager onClose={() => setRolesOpen(false)} t={t} lang={lang} fireToast={fireToast} />}
    </div>
  );
}

/* ---------------- Regole deposito (Impostazioni → Prenotazioni) ----------------
   Riusa il costruttore "SE [campo] è [valore]" delle Automazioni (window.DkCondRow). */
let DK_DRC = 100;

function dkDepositFields(clientCats, t, lang) {
  return [
    { id: 'label', type: 'enum', label: { it: 'Etichetta cliente', en: 'Client label' }, options: clientCats.map(c => ({ value: c.id, label: c.name[lang] || c.name.it })) },
    { id: 'reliability', type: 'num', defaultOp: 'lt', defaultValue: 60, unit: '', label: { it: 'Affidabilità', en: 'Reliability' } },
    { id: 'firstVisit', type: 'bool', label: { it: 'Prima visita', en: 'First visit' } },
    { id: 'timeSlot', type: 'enum', label: { it: 'Fascia oraria', en: 'Time slot' }, options: [
      { value: 'morning', label: t('Mattina', 'Morning') }, { value: 'evening', label: t('Sera · dopo le 17', 'Evening · after 5pm') }, { value: 'weekend', label: t('Weekend', 'Weekend') }] },
  ];
}

function dkRuleSentence(r, fields, t, lang) {
  if (!r.conds.length) return t('Tutte le clienti', 'All clients');
  const joinTxt = r.join === 'or' ? ` ${t('O', 'OR')} ` : ` ${t('E', 'AND')} `;
  const OPS_TXT = { lt: '<', lte: '≤', gt: '>', gte: '≥', eq: '=' };
  return r.conds.map(c => {
    const f = fields.find(x => x.id === c.field) || fields[0];
    if (f.type === 'enum') { const o = (f.options || []).find(o => o.value === c.value); return f.label[lang] + ' = ' + (o ? o.label : c.value); }
    if (f.type === 'bool') return f.label[lang] + (c.value ? '' : ' = No');
    return f.label[lang] + ' ' + (OPS_TXT[c.op] || c.op) + ' ' + c.value;
  }).join(joinTxt);
}

function DkDepositRules() {
  const { t, lang, clientCats, depositRules, setDepositRules, fireToast } = useDk();
  const [openId, setOpenId] = useStateDmi(null);
  const fields = dkDepositFields(clientCats, t, lang);
  const upd = (id, patch) => setDepositRules(l => l.map(r => r.id === id ? { ...r, ...patch } : r));
  const del = (id) => { setDepositRules(l => l.filter(r => r.id !== id)); if (openId === id) setOpenId(null); fireToast({ msg: t('Regola eliminata', 'Rule deleted'), icon: 'x' }); };
  const add = () => {
    const id = 'dr' + Date.now();
    setDepositRules(l => [...l, { id, on: true, join: 'and', conds: [{ id: 'dc' + (++DK_DRC), field: 'label', op: 'is', value: 'rischio' }], scope: 'all', svcIds: [], overrideOn: false, overridePct: 30 }]);
    setOpenId(id);
  };
  return (
    <div style={{ padding: '14px 16px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 13, marginBottom: 14 }}>
        <Icon name="coupon" size={19} color="var(--muted)" />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600, fontSize: 14.5 }}>{t('Regole deposito', 'Deposit rules')}</div>
          <div className="t-sm" style={{ color: 'var(--muted)' }}>{t('A chi richiedere un acconto e su quali servizi. Si applicano in automatico.', 'Who is asked for a deposit, and on which services. Applied automatically.')}</div>
        </div>
        <button className="dk-btn dk-btn--clay" style={{ flexShrink: 0 }} onClick={add}><Icon name="plus" size={16} color="#fff" />{t('Nuova regola deposito', 'New deposit rule')}</button>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {depositRules.map(r => (
          <DkDepositRuleCard key={r.id} r={r} fields={fields} open={openId === r.id} onToggleOpen={() => setOpenId(openId === r.id ? null : r.id)} upd={p => upd(r.id, p)} del={() => del(r.id)} t={t} lang={lang} />
        ))}
        {!depositRules.length && <div className="t-sm" style={{ color: 'var(--muted-2)', padding: '10px 2px' }}>{t('Nessuna regola. Creane una per proporre acconti in automatico.', 'No rules yet. Create one to suggest deposits automatically.')}</div>}
      </div>
      <div className="t-sm" style={{ color: 'var(--muted-2)', marginTop: 12, display: 'flex', alignItems: 'flex-start', gap: 6 }}>
        <Icon name="info" size={13} color="var(--muted-2)" style={{ marginTop: 1, flexShrink: 0 }} />
        <span>{t('Le regole propongono l’acconto in automatico al momento della prenotazione; resta sempre disattivabile o modificabile sul singolo appuntamento.', 'Rules suggest the deposit automatically at booking time; it can always be removed or changed on the individual appointment.')}</span>
      </div>
    </div>
  );
}

function DkDepositRuleCard({ r, fields, open, onToggleOpen, upd, del, t, lang }) {
  const CondRow = window.DkCondRow;
  const sentence = dkRuleSentence(r, fields, t, lang);
  const scopeTxt = r.scope === 'all' ? t('tutti i servizi', 'all services') : r.svcIds.length + ' ' + t(r.svcIds.length === 1 ? 'servizio' : 'servizi', r.svcIds.length === 1 ? 'service' : 'services');
  const amtTxt = r.overrideOn ? r.overridePct + '%' : t('% del servizio', 'service %');
  const setConds = (fn) => upd({ conds: fn(r.conds) });
  const addCond = () => setConds(cs => [...cs, { id: 'dc' + (++DK_DRC), field: 'label', op: 'is', value: 'rischio' }]);
  const updCond = (id, patch) => setConds(cs => cs.map(c => c.id === id ? { ...c, ...patch } : c));
  const rmCond = (id) => setConds(cs => cs.filter(c => c.id !== id));
  const QUICK = [
    ['rischio', t('A rischio', 'At risk'), { field: 'reliability', op: 'lt', value: 60 }],
    ['studente', t('Studente', 'Student'), { field: 'label', op: 'is', value: 'studente' }],
    ['turista', t('Turista', 'Tourist'), { field: 'label', op: 'is', value: 'turista' }],
    ['straniero', t('Straniero', 'Foreign'), { field: 'label', op: 'is', value: 'straniero' }],
  ];
  const quickOn = (q) => r.conds.length === 1 && r.conds[0].field === q.field && r.conds[0].value === q.value && r.conds[0].op === q.op;
  const toggleSvc = (sid) => upd({ svcIds: r.svcIds.includes(sid) ? r.svcIds.filter(x => x !== sid) : [...r.svcIds, sid] });
  return (
    <div className="dk-card" style={{ boxShadow: 'none', border: '1px solid var(--hair)', borderLeft: '3px solid ' + (r.on ? 'var(--clay)' : 'var(--faint)'), opacity: r.on ? 1 : 0.65 }}>
      {/* riga compatta — la regola come frase */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '12px 14px', cursor: 'pointer' }} onClick={onToggleOpen}>
        <span onClick={e => e.stopPropagation()}><Toggle on={r.on} onChange={v => upd({ on: v })} /></span>
        <div style={{ flex: 1, minWidth: 0, fontSize: 13.5, lineHeight: 1.45 }}>
          <span style={{ fontWeight: 800, fontSize: 11, letterSpacing: '0.08em', color: 'var(--clay-ink)', background: 'var(--clay-tint)', padding: '2px 7px', borderRadius: 6, marginRight: 7 }}>{t('SE', 'IF')}</span>
          <strong>{sentence}</strong>
          <span style={{ color: 'var(--muted)' }}> → {t('acconto su', 'deposit on')} {scopeTxt} · {amtTxt}</span>
        </div>
        <button className="dk-iconbtn" onClick={e => { e.stopPropagation(); del(); }} title={t('Elimina regola', 'Delete rule')} style={{ width: 30, height: 30, borderRadius: 8, display: 'grid', placeItems: 'center', color: 'var(--muted)', flexShrink: 0 }}><Icon name="x" size={14} /></button>
        <Icon name="chevD" size={16} color="var(--muted-2)" style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 160ms', flexShrink: 0 }} />
      </div>

      {open && (
        <div style={{ padding: '2px 14px 16px', borderTop: '1px solid var(--hair)' }}>
          {/* CONDIZIONI — a chi si applica */}
          <div className="t-meta" style={{ margin: '13px 0 8px' }}>{t('Condizioni · a chi si applica', 'Conditions · who it applies to')}</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7, marginBottom: 12 }}>
            {QUICK.map(([k, l, cond]) => {
              const on = quickOn(cond);
              return <button key={k} onClick={() => setConds(() => [{ id: 'dc' + (++DK_DRC), ...cond }])} style={{ padding: '7px 13px', borderRadius: 99, fontSize: 12.5, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap', border: '1px solid ' + (on ? 'var(--ink)' : 'var(--hair)'), background: on ? 'var(--ink)' : 'var(--surface)', color: on ? '#fff' : 'var(--ink-2)' }}>{l}</button>;
            })}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {r.conds.map((c, i) => (
              <React.Fragment key={c.id}>
                {i > 0 && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '8px 0' }}>
                    <div className="dk-seg" style={{ padding: 3 }}>
                      {[['and', t('E', 'AND')], ['or', t('O', 'OR')]].map(([k, l]) => (
                        <button key={k} className={r.join === k ? 'on' : ''} style={{ height: 26, padding: '0 12px', fontSize: 11.5 }} onClick={() => upd({ join: k })}>{l}</button>
                      ))}
                    </div>
                    <div style={{ flex: 1, height: 1, background: 'var(--hair)' }} />
                  </div>
                )}
                <CondRow c={c} onChange={p => updCond(c.id, p)} onRemove={() => rmCond(c.id)} t={t} lang={lang} fields={fields} />
              </React.Fragment>
            ))}
          </div>
          <button className="dk-btn dk-btn--soft" style={{ height: 34, fontSize: 12.5, marginTop: 10 }} onClick={addCond}><Icon name="plus" size={14} />{t('Aggiungi condizione', 'Add condition')}</button>

          {/* ACCONTO — ambito servizi + importo */}
          <div className="t-meta" style={{ margin: '18px 0 8px' }}>{t('Acconto · su quali servizi', 'Deposit · on which services')}</div>
          <DkSeg value={r.scope} onChange={v => upd({ scope: v })} options={[{ value: 'all', label: t('Tutti i servizi', 'All services') }, { value: 'sel', label: t('Servizi selezionati', 'Selected services') }]} />
          {r.scope === 'sel' && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7, marginTop: 10 }}>
              {SERVICES.map(s => {
                const on = r.svcIds.includes(s.id);
                return (
                  <button key={s.id} onClick={() => toggleSvc(s.id)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 12px', borderRadius: 99, fontSize: 12.5, fontWeight: 600, cursor: 'pointer', border: '1px solid ' + (on ? 'var(--clay)' : 'var(--hair)'), background: on ? 'var(--clay)' : 'var(--surface)', color: on ? '#fff' : 'var(--ink-2)' }}>
                    {svcName(s, lang)}<span style={{ fontSize: 10.5, fontWeight: 700, opacity: on ? 0.85 : 0.6 }}>{svcMeta(s.id).depositPct}%</span>{on && <Icon name="check" size={12} color="#fff" />}
                  </button>
                );
              })}
            </div>
          )}
          <div className="t-meta" style={{ margin: '16px 0 8px' }}>{t('Importo', 'Amount')}</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <DkSeg value={r.overrideOn ? 'custom' : 'svc'} onChange={v => upd({ overrideOn: v === 'custom' })} options={[{ value: 'svc', label: t('% del servizio', 'Service %') }, { value: 'custom', label: t('% personalizzata', 'Custom %') }]} />
            {r.overrideOn && (
              <div style={{ display: 'inline-flex', alignItems: 'center', gap: 5, border: '1px solid var(--hair)', borderRadius: 9, padding: '0 10px', height: 36, background: 'var(--surface)' }}>
                <input type="number" value={r.overridePct} onChange={e => upd({ overridePct: Math.min(100, Math.max(0, parseInt(e.target.value) || 0)) })} style={{ width: 44, border: 'none', outline: 'none', background: 'transparent', fontSize: 14.5, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }} />
                <span className="t-sm" style={{ color: 'var(--muted-2)', fontWeight: 700 }}>%</span>
              </div>
            )}
            {!r.overrideOn && <span className="t-sm" style={{ color: 'var(--muted)' }}>{t('Segue la percentuale di deposito impostata su ciascun servizio (sezione Servizi).', 'Follows the deposit percentage set on each service (Services section).')}</span>}
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------------- Prenotazioni & ottimizzazione (pagina dedicata) ----------------
   Riempimento, recupero buchi, clienti flessibili, sconti last-minute, deposito
   anti no-show (basato sull'affidabilità) e regole in linguaggio naturale.
   Helper a livello modulo per non perdere il focus negli input. */
const AoPills = ({ value, onChange, options }) => (
  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7 }}>
    {options.map(([v, l]) => {
      const on = value === v;
      return <button key={v} onClick={() => onChange(v)} style={{ padding: '8px 15px', borderRadius: 99, fontSize: 13, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap', border: '1px solid ' + (on ? 'var(--ink)' : 'var(--hair)'), background: on ? 'var(--ink)' : 'var(--surface)', color: on ? '#fff' : 'var(--ink-2)', transition: 'all 140ms' }}>{l}</button>;
    })}
  </div>
);
const AoStepper = ({ value, onChange, min = 0, max = 999, step = 5, suffix }) => (
  <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4, border: '1px solid var(--hair)', borderRadius: 10, padding: '0 5px 0 10px', height: 40, background: 'var(--surface)' }}>
    <input type="number" value={value} onChange={e => onChange(Math.max(min, Math.min(max, parseInt(e.target.value) || 0)))} style={{ width: 46, border: 'none', outline: 'none', background: 'transparent', fontSize: 15, fontWeight: 700, fontVariantNumeric: 'tabular-nums', textAlign: 'right' }} />
    {suffix && <span className="t-sm" style={{ color: 'var(--muted-2)', fontWeight: 700, marginRight: 2 }}>{suffix}</span>}
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      <button onClick={() => onChange(Math.min(max, value + step))} style={{ border: 'none', background: 'transparent', cursor: 'pointer', padding: '1px 4px', lineHeight: 1, color: 'var(--muted)' }}><Icon name="chevD" size={12} color="var(--muted)" style={{ transform: 'rotate(180deg)' }} /></button>
      <button onClick={() => onChange(Math.max(min, value - step))} style={{ border: 'none', background: 'transparent', cursor: 'pointer', padding: '1px 4px', lineHeight: 1, color: 'var(--muted)' }}><Icon name="chevD" size={12} color="var(--muted)" /></button>
    </div>
  </div>
);
const AoCtrl = ({ icon, title, micro, how, children, t }) => {
  const [isOpen, setIsOpen] = useStateDmi(false);
  return (
    <div style={{ padding: '20px 0', borderTop: '1px solid var(--hair)' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 13 }}>
        <div style={{ width: 34, height: 34, borderRadius: 9, background: 'var(--surface-2)', display: 'grid', placeItems: 'center', flexShrink: 0, marginTop: 1 }}><Icon name={icon} size={18} color="var(--muted)" /></div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600, fontSize: 15 }}>{title}</div>
          <div className="t-sm" style={{ color: 'var(--muted)', marginTop: 3, lineHeight: 1.45 }}>{micro}</div>
        </div>
      </div>
      <div style={{ marginTop: 14, marginLeft: 47 }}>{children}</div>
      <button onClick={() => setIsOpen(o => !o)} style={{ marginLeft: 47, marginTop: 12, display: 'inline-flex', alignItems: 'center', gap: 5, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--clay-ink)', fontSize: 12.5, fontWeight: 600, padding: 0 }}>
        {t('Come funziona', 'How it works')}<Icon name="chevD" size={13} color="var(--clay-ink)" style={{ transform: isOpen ? 'rotate(180deg)' : 'none', transition: 'transform 160ms' }} />
      </button>
      {isOpen && <div className="t-sm" style={{ marginLeft: 47, marginTop: 10, padding: '13px 15px', background: 'var(--surface-2)', borderRadius: 11, color: 'var(--ink-2)', lineHeight: 1.6 }}>{how}</div>}
    </div>
  );
};

function DkBookingsOptim({ onBack }) {
  const { t, lang, fireToast } = useDk();
  const [fill, setFill] = useStateDmi('revenue');
  const [freed, setFreed] = useStateDmi('notify');
  const [flexible, setFlexible] = useStateDmi(true);
  const [flexWindow, setFlexWindow] = useStateDmi(30);
  const [flexCoupon, setFlexCoupon] = useStateDmi(10);
  const [discount, setDiscount] = useStateDmi('20');
  const [budget, setBudget] = useStateDmi(100);
  const [depMode, setDepMode] = useStateDmi('threshold');
  const [relThreshold, setRelThreshold] = useStateDmi(60);
  const [rules, setRules] = useStateDmi([
    { id: 'r1', text: t('Mai spostare la signora Bianchi', 'Never move Mrs Bianchi') },
    { id: 'r2', text: t('Sabato pomeriggio solo trattamenti lunghi', 'Saturday afternoon: long treatments only') },
  ]);
  const [ruleText, setRuleText] = useStateDmi('');
  const ruleSeq = useRefDmi(10);
  const addRule = () => { const v = ruleText.trim(); if (!v) return; setRules(r => [...r, { id: 'r' + (ruleSeq.current++), text: v }]); setRuleText(''); };
  const rmRule = (id) => setRules(r => r.filter(x => x.id !== id));

  // riepilogo dinamico: in base ai funzionamenti scelti, il sistema agisce di conseguenza
  const summary = () => {
    const parts = [];
    parts.push(fill === 'free'
      ? t('mostra alla cliente tutti gli orari liberi', 'shows the client every open time')
      : t('online propone solo gli orari che riducono i buchi', 'online it offers only the times that reduce gaps'));
    parts.push(freed === 'notify'
      ? t('quando si libera un posto ti avvisa e decidi tu', 'when a slot frees up it alerts you and you decide')
      : t('quando si libera un posto ricontatta da solo i clienti e lo riassegna', 'when a slot frees up it re-contacts clients on its own and reassigns it'));
    if (flexible) parts.push(t('compatta la giornata spostando solo chi ha aderito (±' + flexWindow + ' min, coupon ' + flexCoupon + '%)', 'compacts the day moving only those who opted in (±' + flexWindow + ' min, ' + flexCoupon + '% coupon)'));
    if (discount !== 'never') parts.push(t('sui buchi dell’ultim’ora arriva fino al ' + discount + '% di sconto', 'on last-minute gaps it goes up to ' + discount + '% off'));
    if (depMode !== 'never') parts.push(depMode === 'always'
      ? t('chiede sempre un deposito alla prenotazione', 'always asks for a deposit at booking')
      : t('chiede un deposito a chi ha affidabilità sotto ' + relThreshold, 'asks a deposit from clients with reliability below ' + relThreshold));
    return parts;
  };

  return (
    <div className="dk-page" style={{ maxWidth: 820 }}>
      {/* header con back */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
        <button className="dk-iconbtn" onClick={onBack} style={{ width: 38, height: 38, borderRadius: 10, display: 'grid', placeItems: 'center', border: '1px solid var(--hair)', background: 'var(--surface)' }}><Icon name="chevR" size={18} style={{ transform: 'rotate(180deg)' }} /></button>
        <div>
          <div style={{ fontFamily: 'var(--serif)', fontSize: 26, fontWeight: 500 }}>{t('Prenotazioni & ottimizzazione', 'Bookings & optimization')}</div>
          <div className="t-sm" style={{ color: 'var(--muted)', marginTop: 2 }}>{t('Come il sistema riempie l’agenda, recupera i buchi e protegge dagli no-show.', 'How the system fills the agenda, recovers gaps and protects against no-shows.')}</div>
        </div>
      </div>

      <div className="dk-card" style={{ padding: '4px 22px 22px', marginTop: 14 }}>
        <AoCtrl t={t} icon="grid" title={t('Riempimento del calendario', 'Calendar fill')} micro={t('Quanto il sistema ottimizza gli orari proposti in prenotazione online.', 'How much the system optimizes the times offered in online booking.')}
          how={<React.Fragment>
            <b>{t('Libero', 'Free')}</b> — {t("la cliente vede tutti gli orari disponibili nell'ordine in cui vengono trovati. Il sistema non interviene sulla lista: mostra tutto e la scelta è completamente sua.", 'the client sees every available time in the order they appear. The system does not intervene on the list: it shows everything and the choice is entirely hers.')}<br /><br />
            <b>{t('Massimo incasso', 'Max revenue')}</b> — {t("online vengono proposti solo gli orari che riducono i buchi tra un appuntamento e l'altro e proteggono le fasce lunghe per i trattamenti che le richiedono. Gli orari che frammenterebbero la giornata non vengono mostrati. Se uno slot ottimale non viene prenotato entro 48h dall'appuntamento, viene rilasciato automaticamente così non perdi una prenotazione normale.", "only times that reduce gaps between appointments and protect long bands for treatments that need them are offered online. Times that would needlessly fragment the day are not shown. If an optimal slot is not booked within 48h of the appointment, it is automatically released so you don't lose a regular booking.")}<br /><br />
            <span style={{color:'var(--muted)',fontSize:12}}>{t("Questo controlla solo la vista online: dalla dashboard puoi sempre prenotare in qualsiasi orario libero.", 'This only controls the online view: from the dashboard you can always book any free time.')}</span>
          </React.Fragment>}>
          <DkSeg value={fill} onChange={setFill} options={[{ value: 'free', label: t('Libero', 'Free') }, { value: 'revenue', label: t('Massimo incasso', 'Max revenue') }]} />
        </AoCtrl>

        <AoCtrl t={t} icon="refresh" title={t('Se si libera un posto', 'When a slot opens up')} micro={t('Cosa fa il sistema quando un appuntamento viene cancellato o spostato.', 'What the system does when an appointment is cancelled or moved.')}
          how={<React.Fragment>
            {t('Quando si libera uno slot, il sistema percorre sempre la stessa cascata:', 'When a slot opens up, the system always runs the same cascade:')}<br />
            <ol style={{margin:'8px 0 10px 16px',padding:0,lineHeight:1.7}}>
              <li>{t("Clienti in lista d'attesa per quel servizio", 'Clients on the waiting list for that service')}</li>
              <li>{t('Clienti in scadenza di ciclo con un servizio della durata giusta', 'Clients due for their cycle with a service of the right duration')}</li>
              <li>{t('Offerta last-minute (con sconto se attivato sotto)', 'Last-minute offer (with discount if enabled below)')}</li>
            </ol>
            <b>{t('Avvisa', 'Notify')}</b> — {t('il sistema ti mostra i candidati ordinati per compatibilità. Sei tu a scegliere chi contattare e quando: nulla parte senza la tua conferma.', 'the system shows you the candidates sorted by compatibility. You choose who to contact and when: nothing goes without your confirmation.')}<br /><br />
            <b>{t('Esegui', 'Execute')}</b> — {t("il sistema contatta i candidati in autonomia nell'ordine suggerito, invia il messaggio via Yourang e assegna lo slot al primo che risponde sì. Trovi l'appuntamento già confermato in agenda: ricevi solo una notifica di riepilogo.", 'the system contacts the candidates autonomously in the suggested order, sends the message via Yourang and assigns the slot to the first who says yes. You find the appointment already confirmed in the agenda: you only receive a summary notification.')}<br /><br />
            <span style={{color:'var(--muted)',fontSize:12}}>{t('La cascata è identica in entrambi i casi; cambia solo chi preme "invia".', 'The cascade is identical in both cases; what changes is who presses "send".')}</span>
          </React.Fragment>}>
          <DkSeg value={freed} onChange={setFreed} options={[{ value: 'notify', label: t('Avvisa', 'Notify') }, { value: 'execute', label: t('Esegui', 'Execute') }]} />
        </AoCtrl>

        <AoCtrl t={t} icon="user" title={t('Clienti flessibili', 'Flexible clients')} micro={t('Chiedi in prenotazione chi accetta di spostarsi per compattare la giornata.', 'Ask at booking who is willing to move to compact the day.')}
          how={<React.Fragment>
            {t(`In fase di prenotazione online, la cliente vede un'opzione: "Accetto uno spostamento di ±X minuti se aiuta il salone a ottimizzare la giornata". Chi la attiva aderisce alla flessibilità.`, 'At online booking, the client sees an option: "I accept a shift of ±X minutes if it helps the salon optimise the day". Those who enable it opt into flexibility.')}<br /><br />
            {t('La sera prima, il sistema calcola se spostando solo chi ha aderito riesce a compattare la giornata. Se trova una combinazione vantaggiosa, manda un messaggio: "Possiamo spostarti dalle 10:00 alle 10:30, ok?". La cliente risponde con un tap. Se dice no (o non risponde entro 30 min), il suo orario originale viene ripristinato in automatico — nessun intervento da parte tua.', 'The evening before, the system calculates whether moving only those who opted in can compact the day. If it finds a beneficial combination, it sends a message: "We can move you from 10:00 to 10:30, ok?". The client replies with a tap. If she says no (or does not reply within 30 min), her original time is automatically restored — no action needed from you.')}<br /><br />
            {t('Se viene effettivamente spostata, riceve in automatico un coupon con la percentuale di sconto che imposti, valido sul prossimo appuntamento.', 'If she is actually moved, she automatically receives a coupon with the discount percentage you set, valid on the next appointment.')}
          </React.Fragment>}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
            <Toggle on={flexible} onChange={setFlexible} />
            <span className="t-sm" style={{ fontWeight: 600, color: flexible ? 'var(--ok)' : 'var(--muted)' }}>{flexible ? t('Attivo', 'On') : t('Disattivato', 'Off')}</span>
          </div>
          {flexible && (
            <div style={{ marginTop: 13, display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ padding: '12px 15px', background: 'var(--surface-2)', borderRadius: 11, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                <div style={{ flex: 1, minWidth: 150 }}>
                  <div style={{ fontWeight: 600, fontSize: 13.5 }}>{t('Finestra di spostamento', 'Move window')}</div>
                  <div className="t-sm" style={{ color: 'var(--muted-2)', marginTop: 1 }}>{t('Di quanto al massimo può slittare l’orario', 'How far the time can shift at most')}</div>
                </div>
                <div style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}><span className="t-sm" style={{ color: 'var(--muted-2)', fontWeight: 700 }}>±</span><AoStepper value={flexWindow} onChange={setFlexWindow} min={5} max={120} step={5} suffix={t('min', 'min')} /></div>
              </div>
              <div style={{ padding: '12px 15px', background: 'var(--surface-2)', borderRadius: 11, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                <div style={{ flex: 1, minWidth: 150 }}>
                  <div style={{ fontWeight: 600, fontSize: 13.5 }}>{t('Coupon di cortesia se spostata', 'Courtesy coupon if moved')}</div>
                  <div className="t-sm" style={{ color: 'var(--muted-2)', marginTop: 1 }}>{t('Sconto sul prossimo appuntamento', 'Discount on the next appointment')}</div>
                </div>
                <AoStepper value={flexCoupon} onChange={setFlexCoupon} min={0} max={50} step={5} suffix="%" />
              </div>
            </div>
          )}
        </AoCtrl>

        <AoCtrl t={t} icon="coupon" title={t('Sconti last-minute', 'Last-minute discounts')} micro={t('Il tetto massimo dello sconto sui buchi dell’ultim’ora.', 'The maximum discount cap on last-minute gaps.')}
          how={<React.Fragment>
            {t('Il valore che scegli è il tetto di una curva di escalation — lo sconto non parte al massimo subito:', 'The value you choose is the cap of an escalation curve — the discount does not start at the maximum straight away:')}<br />
            <ul style={{margin:'8px 0 10px 16px',padding:0,lineHeight:1.7}}>
              <li>{t('24h prima del buco → sconto minimo (pochi punti %)', '24h before the gap → minimum discount (a few %)')}</li>
              <li>{t('4h prima → sconto intermedio', '4h before → intermediate discount')}</li>
              <li>{t('1h prima → sconto al massimo scelto', '1h before → maximum discount chosen')}</li>
            </ul>
            {t('Così non svaluti gli orari che si riempirebbero comunque. Il budget mensile fissa un tetto: una volta esaurito, gli sconti si spengono da soli fino al mese successivo.', "This way you don't devalue times that would fill anyway. The monthly budget sets a cap: once exhausted, discounts switch off automatically until the next month.")}<br /><br />
            {t('Con "Mai" questo passo della cascata è spento: nessun buco verrà mai scontato.', 'With "Never" this cascade step is off: no gap will ever be discounted.')}
          </React.Fragment>}>
          <AoPills value={discount} onChange={setDiscount} options={[['never', t('Mai', 'Never')], ['10', '10%'], ['20', '20%'], ['30', '30%']]} />
          {discount !== 'never' && (
            <div style={{ marginTop: 13, padding: '13px 15px', background: 'var(--surface-2)', borderRadius: 11, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <div style={{ flex: 1, minWidth: 150 }}>
                <div style={{ fontWeight: 600, fontSize: 13.5 }}>{t('Budget mensile', 'Monthly budget')}</div>
                <div className="t-sm" style={{ color: 'var(--muted-2)', marginTop: 1 }}>{t('Stop automatico a esaurimento', 'Auto-stop when exhausted')}</div>
              </div>
              <div style={{ display: 'inline-flex', alignItems: 'center', gap: 5, border: '1px solid var(--hair)', borderRadius: 10, padding: '0 12px', height: 40, background: 'var(--surface)' }}>
                <span className="t-sm" style={{ color: 'var(--muted-2)', fontWeight: 700 }}>€</span>
                <input type="number" value={budget} onChange={e => setBudget(Math.max(0, parseInt(e.target.value) || 0))} style={{ width: 56, border: 'none', outline: 'none', background: 'transparent', fontSize: 15, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }} />
              </div>
            </div>
          )}
        </AoCtrl>

        <AoCtrl t={t} icon="bulb" title={t('Le tue regole', 'Your rules')} micro={t('Scrivile come parli. Diventano vincoli che vincono sempre sull’ottimizzatore.', 'Write them the way you speak. They become constraints that always beat the optimizer.')}
          how={<React.Fragment>
            {t('Le regole hanno priorità assoluta su tutto il resto. Prima di fare qualsiasi ottimizzazione, il sistema controlla se la mossa che sta per fare viola una delle tue regole. Se sì, la salta — senza eccezioni.', 'Rules have absolute priority over everything else. Before making any optimisation, the system checks whether the move it is about to make violates one of your rules. If yes, it skips it — no exceptions.')}<br /><br />
            {t("Scrivile come parleresti a un'assistente: frasi brevi, dirette, in italiano (o inglese). Esempi validi:", 'Write them as you would speak to an assistant: short, direct sentences. Valid examples:')}<br />
            <ul style={{margin:'8px 0 10px 16px',padding:0,lineHeight:1.7}}>
              <li><i>{t('"Mai spostare la signora Bianchi il venerdì"', '"Never move Mrs Bianchi on Fridays"')}</i></li>
              <li><i>{t('"Sabato pomeriggio solo trattamenti da almeno 60 minuti"', '"Saturday afternoon only treatments of at least 60 minutes"')}</i></li>
              <li><i>{t('"Non proporre sconti last-minute per la colorazione"', '"Do not offer last-minute discounts for colouring"')}</i></li>
            </ul>
            {t('Se scrivi qualcosa di ambiguo (es. "trattamenti corti solo al mattino" senza specificare cosa significa "corti"), il sistema ti fa una domanda prima di salvare la regola.', 'If you write something ambiguous (e.g. "short treatments mornings only" without specifying what "short" means), the system asks you a question before saving the rule.')}
          </React.Fragment>}>
          <div style={{ display: 'flex', gap: 8 }}>
            <input value={ruleText} onChange={e => setRuleText(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') addRule(); }} placeholder={t('es. Non prenotare colore dopo le 18', 'e.g. No colour bookings after 6pm')} style={{ flex: 1, border: '1px solid var(--hair)', borderRadius: 10, outline: 'none', fontSize: 14, padding: '10px 12px', fontFamily: 'var(--sans)', background: 'var(--surface)' }} />
            <button className="dk-btn dk-btn--soft" onClick={addRule} style={{ flexShrink: 0 }}><Icon name="plus" size={15} />{t('Aggiungi', 'Add')}</button>
          </div>
          {rules.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 11 }}>
              {rules.map(r => (
                <span key={r.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '7px 10px 7px 13px', borderRadius: 99, fontSize: 13, fontWeight: 500, background: 'var(--clay-tint)', color: 'var(--clay-ink)', border: '1px solid color-mix(in srgb, var(--clay) 30%, transparent)' }}>
                  {r.text}
                  <button onClick={() => rmRule(r.id)} style={{ width: 18, height: 18, borderRadius: 99, border: 'none', cursor: 'pointer', display: 'grid', placeItems: 'center', background: 'color-mix(in srgb, var(--clay) 18%, transparent)', color: 'var(--clay-ink)', flexShrink: 0 }}><Icon name="x" size={11} color="var(--clay-ink)" /></button>
                </span>
              ))}
            </div>
          )}
          <div className="t-sm" style={{ color: 'var(--muted-2)', marginTop: 10, display: 'flex', alignItems: 'flex-start', gap: 6, lineHeight: 1.45 }}>
            <Icon name="info" size={13} color="var(--muted-2)" style={{ marginTop: 1, flexShrink: 0 }} />
            <span>{t('Se una regola è ambigua, il sistema fa una domanda invece di indovinare.', 'If a rule is ambiguous, the system asks a question instead of guessing.')}</span>
          </div>
        </AoCtrl>
      </div>

      {/* riepilogo — in base ai funzionamenti scelti, il sistema agisce di conseguenza */}
      <div style={{ display: 'flex', gap: 12, padding: '16px 18px', background: 'var(--clay-tint)', borderRadius: 13, marginTop: 16, border: '1px solid color-mix(in srgb, var(--clay) 22%, transparent)' }}>
        <Icon name="sparkle" size={18} color="var(--clay-ink)" style={{ flexShrink: 0, marginTop: 1 }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 13.5, color: 'var(--clay-ink)', marginBottom: 5 }}>{t('In base a come l’hai impostato', 'Based on how you set it')}</div>
          <div className="t-sm" style={{ color: 'var(--ink-2)', lineHeight: 1.6 }}>{t('Con queste scelte, il sistema ', 'With these choices, the system ')}{summary().join('; ')}.</div>
        </div>
      </div>

      {/* REGOLE DEPOSITO — motore di dettaglio (ex sezione Prenotazioni) */}
      <div style={{ marginTop: 28 }}>
        <div className="t-meta" style={{ marginBottom: 10 }}>{t('Regole deposito · condizioni di dettaglio', 'Deposit rules · detailed conditions')}</div>
        <div className="dk-card" style={{ padding: 0 }}>
          <DkDepositRules />
        </div>
      </div>

      <button className="dk-btn dk-btn--clay" style={{ width: '100%', marginTop: 24, marginBottom: 12 }} onClick={() => { fireToast({ msg: t('Impostazioni salvate', 'Settings saved'), icon: 'check' }); onBack(); }}><Icon name="check" size={17} color="#fff" />{t('Salva', 'Save')}</button>
    </div>
  );
}

/* ================= Team, Roles & Activity log (Impostazioni → Account) ================= */
const DK_PERMS = [
  { id: 'agenda',    it: 'Agenda e appuntamenti',     en: 'Agenda & appointments' },
  { id: 'clienti',   it: 'Schede cliente',            en: 'Client records' },
  { id: 'vendite',   it: 'Vendite e checkout',        en: 'Sales & checkout' },
  { id: 'magazzino', it: 'Magazzino e rettifiche',    en: 'Inventory & adjustments' },
  { id: 'prezzi',    it: 'Listino e prezzi',          en: 'Pricing & price list' },
  { id: 'marketing', it: 'Coupon, fedeltà e marketing', en: 'Coupons, loyalty & marketing' },
  { id: 'team',      it: 'Team e permessi',           en: 'Team & permissions' },
  { id: 'registro',  it: 'Registro attività',         en: 'Activity log' },
  { id: 'incassi',   it: 'Riepilogo incassi (vendite totali)', en: 'Revenue summary (total sales)' },
];
const DK_ROLES_SEED = [
  { id: 'owner', name: { it: 'Titolare', en: 'Owner' }, system: true, perms: DK_PERMS.map(p => p.id) },
  { id: 'manager', name: { it: 'Manager', en: 'Manager' }, perms: ['agenda', 'clienti', 'vendite', 'magazzino', 'marketing'] },
  { id: 'front', name: { it: 'Front desk', en: 'Front desk' }, perms: ['agenda', 'clienti', 'vendite'] },
  { id: 'operatrice', name: { it: 'Operatrice', en: 'Stylist' }, perms: ['agenda'] },
];
// staff → assigned role + account status
const DK_TEAM_ROLE = { sole: 'owner', mara: 'manager', lina: 'front', giulia: 'operatrice', asia: 'operatrice', noor: 'operatrice', vera: 'front', ines: 'operatrice', dafne: 'operatrice' };
const DK_SALON_START = '2023-03-01';
const DK_LOG_SEED = [
  { id: 'lg1', type: 'checkout',  who: 'lina',   date: '2026-06-24T11:42', summary: { it: 'Checkout Sofia Ricci · €85 · carta', en: 'Checkout Sofia Ricci · €85 · card' } },
  { id: 'lg2', type: 'modify',    who: 'lina',   date: '2026-06-24T11:20', summary: { it: 'Trattamento modificato · Manicure → Gel · saldo ricalcolato', en: 'Treatment changed · Manicure → Gel · balance recalculated' } },
  { id: 'lg3', type: 'inventory', who: 'mara',   date: '2026-06-24T10:05', summary: { it: 'Rettifica magazzino · Tinta 6.0 −1 · prodotto scaduto', en: 'Inventory adjustment · Colour 6.0 −1 · expired' } },
  { id: 'lg4', type: 'create',    who: 'sole',   date: '2026-06-24T09:18', summary: { it: 'Nuovo appuntamento · Chiara Greco · 09:45', en: 'New appointment · Chiara Greco · 09:45' } },
  { id: 'lg5', type: 'price',     who: 'sole',   date: '2026-06-23T18:30', summary: { it: 'Prezzo modificato · Balayage €95 → €110', en: 'Price changed · Balayage €95 → €110' } },
  { id: 'lg6', type: 'cancel',    who: 'vera',   date: '2026-06-23T16:12', summary: { it: 'Appuntamento cancellato · Aisha Diallo · addebito €0', en: 'Appointment cancelled · Aisha Diallo · €0 charged' } },
  { id: 'lg7', type: 'delete',    who: 'sole',   date: '2026-06-23T12:40', summary: { it: 'Scheda cliente eliminata · profilo duplicato', en: 'Client record deleted · duplicate profile' } },
  { id: 'lg8', type: 'checkout',  who: 'giulia', date: '2026-06-22T17:05', summary: { it: 'Checkout Marta Vinci · €120 · contanti', en: 'Checkout Marta Vinci · €120 · cash' } },
  { id: 'lg9', type: 'inventory', who: 'sole',   date: '2026-06-20T09:30', summary: { it: 'Carico merce · Base coat +50 · NailPro', en: 'Restock · Base coat +50 · NailPro' } },
  { id: 'lg10', type: 'create',   who: 'vera',   date: '2026-06-18T14:22', summary: { it: 'Nuovo cliente · Bianca Lombardi', en: 'New client · Bianca Lombardi' } },
  { id: 'lg11', type: 'price',    who: 'sole',   date: '2026-05-30T19:10', summary: { it: 'Listino aggiornato · +5% servizi colore', en: 'Price list updated · +5% colour services' } },
  { id: 'lg12', type: 'modify',   who: 'mara',   date: '2026-05-14T11:48', summary: { it: 'Orari turno modificati · settimana 20', en: 'Shift hours changed · week 20' } },
  { id: 'lg13', type: 'cancel',   who: 'lina',   date: '2026-04-09T10:30', summary: { it: 'Appuntamento cancellato · no-show · addebito €40', en: 'Appointment cancelled · no-show · €40 charged' } },
  { id: 'lg14', type: 'checkout', who: 'asia',   date: '2026-02-21T16:55', summary: { it: 'Checkout · pacchetto sposa · €450', en: 'Checkout · bridal package · €450' } },
  { id: 'lg15', type: 'delete',   who: 'sole',   date: '2025-11-12T13:15', summary: { it: 'Servizio eliminato dal listino · "Trattamento cheratina"', en: 'Service removed from list · "Keratin treatment"' } },
  { id: 'lg16', type: 'create',   who: 'sole',   date: '2024-09-03T08:40', summary: { it: 'Aggiunta operatrice · Dafne Pozzi', en: 'Staff added · Dafne Pozzi' } },
];
const DK_LOG_META = {
  create:    { icon: 'plus',     color: 'var(--ok)',     it: 'Creazione',     en: 'Created' },
  modify:    { icon: 'edit',     color: 'var(--info)',   it: 'Modifica',      en: 'Modified' },
  cancel:    { icon: 'x',        color: 'var(--warn)',   it: 'Cancellazione', en: 'Cancelled' },
  delete:    { icon: 'x',        color: 'var(--danger)', it: 'Eliminazione',  en: 'Deleted' },
  checkout:  { icon: 'wallet',   color: 'var(--ok)',     it: 'Checkout',      en: 'Checkout' },
  inventory: { icon: 'box',      color: 'var(--info)',   it: 'Magazzino',     en: 'Inventory' },
  price:     { icon: 'wallet',   color: 'var(--clay-ink)', it: 'Prezzo',      en: 'Pricing' },
};

function TeamManager({ onClose, onRoles, t, lang, fireToast }) {
  const [team, setTeam] = useStateDmi(() => OPS.map(o => ({ id: o.id, name: o.name + ' ' + (o.surname || ''), initials: o.initials, color: o.color, email: (STAFF_CONTACT[o.id] || {}).email || '', roleId: DK_TEAM_ROLE[o.id] || 'operatrice', status: 'active' })));
  const roleName = (rid) => { const r = DK_ROLES_SEED.find(x => x.id === rid); return r ? (r.name[lang] || r.name.it) : rid; };
  const setRole = (id, roleId) => { setTeam(l => l.map(m => m.id === id ? { ...m, roleId } : m)); fireToast({ msg: t('Ruolo aggiornato', 'Role updated'), icon: 'check' }); };
  const [inviting, setInviting] = useStateDmi(false);
  const [inv, setInv] = useStateDmi({ name: '', email: '', roleId: 'front' });
  const invSeq = useRefDmi(1);
  const sendInvite = () => {
    const nm = inv.name.trim(); if (!nm || !inv.email.trim()) return;
    const initials = nm.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
    setTeam(l => [...l, { id: 'inv' + (invSeq.current++), name: nm, initials, color: 'var(--pewter-400, #93919A)', email: inv.email.trim(), roleId: inv.roleId, status: 'invited' }]);
    setInviting(false); setInv({ name: '', email: '', roleId: 'front' });
    fireToast({ msg: t('Invito inviato a ' + nm, 'Invite sent to ' + nm), icon: 'check' });
  };
  return (
    <DkDrawer open onClose={onClose}>
      <div style={{ padding: '22px 22px 18px', borderBottom: '1px solid var(--hair)', display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontFamily: 'var(--serif)', fontSize: 21, fontWeight: 500 }}>{t('Membri del team', 'Team members')}</div>
          <div className="t-sm" style={{ color: 'var(--muted)', marginTop: 2 }}>{team.length} {t('membri · ruolo e accesso', 'members · role and access')}</div>
        </div>
        <button className="dk-iconbtn" onClick={onClose}><Icon name="x" size={19} /></button>
      </div>
      <div className="scroll" style={{ flex: 1, overflowY: 'auto', padding: '16px 22px' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
          {team.map(m => (
            <div key={m.id} className="dk-card" style={{ padding: 13, boxShadow: 'none', border: '1px solid var(--hair)', display: 'flex', alignItems: 'center', gap: 12 }}>
              <Avatar initials={m.initials} size={40} color={m.color} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}><span style={{ fontWeight: 700, fontSize: 14 }}>{m.name}</span>{m.status === 'invited' && <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--warn)', background: 'var(--warn-tint)', padding: '1px 7px', borderRadius: 99 }}>{t('invitato', 'invited')}</span>}</div>
                <div className="t-sm" style={{ color: 'var(--muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{m.email}</div>
              </div>
              <select value={m.roleId} onChange={e => setRole(m.id, e.target.value)} disabled={m.roleId === 'owner'} style={{ border: '1px solid var(--hair)', borderRadius: 9, outline: 'none', fontSize: 13, fontWeight: 600, padding: '7px 10px', fontFamily: 'var(--sans)', background: m.roleId === 'owner' ? 'var(--surface-2)' : 'var(--surface)', cursor: m.roleId === 'owner' ? 'default' : 'pointer', flexShrink: 0, color: 'var(--ink)' }}>
                {DK_ROLES_SEED.map(r => <option key={r.id} value={r.id}>{r.name[lang] || r.name.it}</option>)}
              </select>
            </div>
          ))}
        </div>
        {inviting ? (
          <div className="dk-card" style={{ padding: 15, border: '1px solid var(--clay)', boxShadow: 'none', marginTop: 12 }}>
            <div className="t-meta" style={{ marginBottom: 10 }}>{t('Invita un membro', 'Invite a member')}</div>
            <input value={inv.name} onChange={e => setInv(f => ({ ...f, name: e.target.value }))} placeholder={t('Nome e cognome', 'Full name')} style={{ width: '100%', border: '1px solid var(--hair)', borderRadius: 9, outline: 'none', fontSize: 14, padding: '9px 11px', fontFamily: 'var(--sans)', background: 'var(--surface)', boxSizing: 'border-box', marginBottom: 9 }} />
            <input value={inv.email} onChange={e => setInv(f => ({ ...f, email: e.target.value }))} type="email" placeholder="email@theparlour.it" style={{ width: '100%', border: '1px solid var(--hair)', borderRadius: 9, outline: 'none', fontSize: 14, padding: '9px 11px', fontFamily: 'var(--sans)', background: 'var(--surface)', boxSizing: 'border-box', marginBottom: 9 }} />
            <select value={inv.roleId} onChange={e => setInv(f => ({ ...f, roleId: e.target.value }))} style={{ width: '100%', border: '1px solid var(--hair)', borderRadius: 9, outline: 'none', fontSize: 13, fontWeight: 600, padding: '9px 11px', fontFamily: 'var(--sans)', background: 'var(--surface)', cursor: 'pointer', marginBottom: 12, color: 'var(--ink)' }}>
              {DK_ROLES_SEED.filter(r => r.id !== 'owner').map(r => <option key={r.id} value={r.id}>{r.name[lang] || r.name.it}</option>)}
            </select>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="dk-btn dk-btn--ghost" style={{ flex: 1 }} onClick={() => setInviting(false)}>{t('Annulla', 'Cancel')}</button>
              <button className="dk-btn dk-btn--clay" style={{ flex: 1 }} disabled={!inv.name.trim() || !inv.email.trim()} onClick={sendInvite}><Icon name="check" size={16} color="#fff" />{t('Invia invito', 'Send invite')}</button>
            </div>
          </div>
        ) : (
          <button className="dk-btn dk-btn--ghost" style={{ width: '100%', borderStyle: 'dashed', marginTop: 12 }} onClick={() => setInviting(true)}><Icon name="plus" size={16} />{t('Invita un membro', 'Invite a member')}</button>
        )}
        <button className="dk-row" onClick={onRoles} style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '13px 14px', borderRadius: 12, marginTop: 16, background: 'var(--surface-2)', textAlign: 'left' }}>
          <Icon name="settings" size={17} color="var(--muted)" />
          <div style={{ flex: 1 }}><div style={{ fontWeight: 600, fontSize: 13.5 }}>{t('Ruoli e permessi', 'Roles & permissions')}</div><div className="t-sm" style={{ color: 'var(--muted)' }}>{t('Definisci cosa può fare ogni ruolo', 'Define what each role can do')}</div></div>
          <Icon name="chevR" size={16} color="var(--muted-2)" />
        </button>
      </div>
    </DkDrawer>
  );
}

function RolesManager({ onClose, t, lang, fireToast }) {
  const { showRevenue, setShowRevenue } = useDk();
  const [roles, setRoles] = useStateDmi(() => DK_ROLES_SEED.map(r => ({ ...r, perms: [...r.perms] })));
  const [openId, setOpenId] = useStateDmi('manager');
  const roleSeq = useRefDmi(1);
  const addRole = () => { const id = 'role' + (roleSeq.current++); setRoles(l => [...l, { id, name: { it: 'Nuovo ruolo', en: 'New role' }, perms: ['agenda'] }]); setOpenId(id); fireToast({ msg: t('Ruolo creato · imposta i permessi', 'Role created · set permissions'), icon: 'check' }); };
  const rename = (rid, v) => setRoles(l => l.map(r => r.id === rid ? { ...r, name: { it: v, en: v } } : r));
  const toggle = (rid, pid) => setRoles(l => l.map(r => r.id === rid ? { ...r, perms: r.perms.includes(pid) ? r.perms.filter(x => x !== pid) : [...r.perms, pid] } : r));
  return (
    <DkDrawer open onClose={onClose}>
      <div style={{ padding: '22px 22px 18px', borderBottom: '1px solid var(--hair)', display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontFamily: 'var(--serif)', fontSize: 21, fontWeight: 500 }}>{t('Ruoli e permessi', 'Roles & permissions')}</div>
          <div className="t-sm" style={{ color: 'var(--muted)', marginTop: 2 }}>{t('Cosa può vedere e fare ogni ruolo', 'What each role can see and do')}</div>
        </div>
        <button className="dk-iconbtn" onClick={onClose}><Icon name="x" size={19} /></button>
      </div>
      <div className="scroll" style={{ flex: 1, overflowY: 'auto', padding: '16px 22px' }}>
        {/* global visibility toggle for the revenue summary box */}
        <div className="dk-card" style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 16px', boxShadow: 'none', border: '1px solid var(--hair)', marginBottom: 14 }}>
          <div style={{ width: 36, height: 36, borderRadius: 10, background: 'var(--ink)', display: 'grid', placeItems: 'center', flexShrink: 0 }}><Icon name="wallet" size={17} color="#fff" /></div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 700, fontSize: 14 }}>{t('Riepilogo incassi visibile', 'Revenue summary visible')}</div>
            <div className="t-sm" style={{ color: 'var(--muted)' }}>{t('Mostra la box “Vendite totali” in agenda. Disattiva per nasconderla ai ruoli non autorizzati.', 'Shows the “Total sales” box in the agenda. Turn off to hide it from unauthorised roles.')}</div>
          </div>
          <button onClick={() => setShowRevenue(!showRevenue)} style={{ position: 'relative', width: 42, height: 24, borderRadius: 99, cursor: 'pointer', border: 'none', background: showRevenue ? 'var(--clay)' : 'var(--hair)', transition: 'background 140ms', flexShrink: 0 }}><span style={{ position: 'absolute', top: 2, left: showRevenue ? 20 : 2, width: 20, height: 20, borderRadius: 99, background: '#fff', transition: 'left 140ms', boxShadow: '0 1px 2px rgba(0,0,0,0.2)' }} /></button>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {roles.map(r => { const open = openId === r.id; return (
            <div key={r.id} className="dk-card" style={{ boxShadow: 'none', border: '1px solid ' + (open ? 'var(--clay)' : 'var(--hair)'), overflow: 'hidden' }}>
              <button className="dk-row" onClick={() => setOpenId(open ? null : r.id)} style={{ display: 'flex', alignItems: 'center', gap: 11, width: '100%', padding: '13px 15px', textAlign: 'left' }}>
                <div style={{ width: 34, height: 34, borderRadius: 9, background: r.system ? 'var(--clay-tint)' : 'var(--surface-2)', display: 'grid', placeItems: 'center', flexShrink: 0 }}><Icon name={r.system ? 'sparkle' : 'user'} size={16} color={r.system ? 'var(--clay-ink)' : 'var(--muted)'} /></div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 700, fontSize: 14 }}>{r.name[lang] || r.name.it}{r.system && <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--clay-ink)', background: 'var(--clay-tint)', padding: '1px 7px', borderRadius: 99, marginLeft: 7 }}>{t('accesso totale', 'full access')}</span>}</div>
                  <div className="t-sm" style={{ color: 'var(--muted)' }}>{r.perms.length}/{DK_PERMS.length} {t('permessi', 'permissions')}</div>
                </div>
                <Icon name="chevD" size={16} color="var(--muted-2)" style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 160ms', flexShrink: 0 }} />
              </button>
              {open && (
                <div style={{ padding: '4px 15px 15px', borderTop: '1px solid var(--hair)' }}>
                  {DK_PERMS.map(p => { const on = r.perms.includes(p.id); const locked = r.system; return (
                    <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 0', borderBottom: '1px solid var(--hair-2, #EEE)' }}>
                      <span style={{ flex: 1, fontSize: 13.5, fontWeight: 500, color: on ? 'var(--ink)' : 'var(--muted)' }}>{p[lang]}</span>
                      <button onClick={() => !locked && toggle(r.id, p.id)} disabled={locked} style={{ width: 40, height: 23, borderRadius: 99, border: 'none', cursor: locked ? 'default' : 'pointer', background: on ? 'var(--clay)' : 'var(--pewter-300, #B6B4BB)', opacity: locked ? 0.5 : 1, position: 'relative', transition: 'background 160ms', flexShrink: 0 }}>
                        <span style={{ position: 'absolute', top: 2, left: on ? 19 : 2, width: 19, height: 19, borderRadius: 99, background: '#fff', transition: 'left 160ms' }} />
                      </button>
                    </div>
                  ); })}
                  {!r.system && <div style={{ display: 'flex', gap: 8, marginTop: 12, alignItems: 'center' }}>
                    <input value={r.name[lang] || r.name.it} onChange={e => rename(r.id, e.target.value)} placeholder={t('Nome ruolo', 'Role name')} style={{ flex: 1, border: '1px solid var(--hair)', borderRadius: 9, outline: 'none', fontSize: 13, padding: '8px 11px', fontFamily: 'var(--sans)', background: 'var(--surface)' }} />
                    <button className="dk-btn dk-btn--clay" style={{ height: 38, fontSize: 13 }} onClick={() => fireToast({ msg: t('Permessi salvati per ' + (r.name[lang] || r.name.it), 'Permissions saved for ' + (r.name[lang] || r.name.it)), icon: 'check' })}><Icon name="check" size={15} color="#fff" />{t('Salva', 'Save')}</button>
                  </div>}
                </div>
              )}
            </div>
          ); })}
        </div>
        <button className="dk-btn dk-btn--ghost" style={{ width: '100%', borderStyle: 'dashed', marginTop: 12 }} onClick={addRole}><Icon name="plus" size={16} />{t('Crea un nuovo ruolo', 'Create a new role')}</button>
      </div>
    </DkDrawer>
  );
}

function dkLogDateLabel(iso, lang) {
  const d = new Date(iso);
  const today = new Date('2026-06-24T23:59');
  const day0 = new Date(d); day0.setHours(0, 0, 0, 0);
  const t0 = new Date(today); t0.setHours(0, 0, 0, 0);
  const diff = Math.round((t0 - day0) / 86400000);
  const hm = iso.slice(11, 16);
  if (diff === 0) return (lang === 'en' ? 'Today' : 'Oggi') + ' · ' + hm;
  if (diff === 1) return (lang === 'en' ? 'Yesterday' : 'Ieri') + ' · ' + hm;
  const months = lang === 'en' ? ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'] : ['gen','feb','mar','apr','mag','giu','lug','ago','set','ott','nov','dic'];
  return d.getDate() + ' ' + months[d.getMonth()] + ' ' + d.getFullYear() + ' · ' + hm;
}
function DkActivityLogPage({ onBack, t, lang, initialPeriod }) {
  const [q, setQ] = useStateDmi('');
  const [filt, setFilt] = useStateDmi('all');
  const [who, setWho] = useStateDmi('all');
  const [period, setPeriod] = useStateDmi(initialPeriod || 'all'); // today | 7d | 30d | year | all | custom
  const [from, setFrom] = useStateDmi(DK_SALON_START);
  const [to, setTo] = useStateDmi('2026-06-24');
  const TODAY = '2026-06-24';
  const tabs = [['all', t('Tutto', 'All')], ['create', t('Creazioni', 'Created')], ['modify', t('Modifiche', 'Modified')], ['cancel', t('Cancellazioni', 'Cancelled')], ['delete', t('Eliminazioni', 'Deleted')], ['checkout', t('Checkout', 'Checkout')], ['inventory', t('Magazzino', 'Inventory')], ['price', t('Prezzi', 'Pricing')]];
  const periods = [['today', t('Oggi', 'Today')], ['7d', t('7 giorni', '7 days')], ['30d', t('30 giorni', '30 days')], ['year', t('Anno', 'Year')], ['all', t('Tutto', 'All')], ['custom', t('Personalizzato', 'Custom')]];
  const inPeriod = (iso) => {
    const d = new Date(iso); const today = new Date(TODAY + 'T23:59');
    if (period === 'all') return true;
    if (period === 'custom') { return iso.slice(0, 10) >= from && iso.slice(0, 10) <= to; }
    const days = { today: 0, '7d': 7, '30d': 30, year: 365 }[period];
    if (period === 'today') return iso.slice(0, 10) === TODAY;
    const cutoff = new Date(today); cutoff.setDate(cutoff.getDate() - days);
    return d >= cutoff;
  };
  const list = DK_LOG_SEED.filter(e => {
    const okT = filt === 'all' || e.type === filt;
    const okW = who === 'all' || e.who === who;
    const okP = inPeriod(e.date);
    const okQ = !q || e.summary[lang].toLowerCase().includes(q.toLowerCase()) || (op(e.who) && (op(e.who).name + ' ' + (op(e.who).surname || '')).toLowerCase().includes(q.toLowerCase()));
    return okT && okW && okP && okQ;
  });
  const staff = OPS.filter(o => DK_LOG_SEED.some(e => e.who === o.id));
  const inputCss = { border: '1px solid var(--hair)', borderRadius: 9, outline: 'none', fontSize: 13, padding: '8px 11px', fontFamily: 'var(--sans)', background: 'var(--surface)', cursor: 'pointer', color: 'var(--ink)' };
  useEffectDmi(() => { const c = document.querySelector('.dk-content'); if (c) c.scrollTop = 0; }, []);
  return (
    <div className="dk-page" style={{ maxWidth: 900 }}>
      <button className="dk-btn dk-btn--ghost" onClick={onBack} style={{ marginBottom: 16 }}><Icon name="chevL" size={16} />{t('Impostazioni', 'Settings')}</button>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 20 }}>
        <div style={{ width: 46, height: 46, borderRadius: 13, background: 'var(--clay-tint)', display: 'grid', placeItems: 'center', flexShrink: 0 }}><Icon name="clock" size={22} color="var(--clay-ink)" /></div>
        <div style={{ flex: 1 }}>
          <div style={{ fontFamily: 'var(--serif)', fontSize: 26, fontWeight: 500, lineHeight: 1.1 }}>{t('Registro attività', 'Activity log')}</div>
          <div className="t-sm" style={{ color: 'var(--muted)', marginTop: 3 }}>{t('Ogni azione con data, ora e autore. Visibile solo al titolare.', 'Every action with date, time and author. Visible to the owner only.')}</div>
        </div>
      </div>

      {/* search + user filter */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
        <div className="dk-search" style={{ flex: 1, minWidth: 220 }}>
          <Icon name="search" size={17} color="var(--muted-2)" />
          <input value={q} onChange={e => setQ(e.target.value)} placeholder={t('Cerca per descrizione o autore…', 'Search by description or author…')} />
          {q && <button className="press" onClick={() => setQ('')} style={{ cursor: 'pointer', display: 'grid', placeItems: 'center' }}><Icon name="x" size={14} color="var(--muted-2)" /></button>}
        </div>
        <select value={who} onChange={e => setWho(e.target.value)} style={{ ...inputCss, minWidth: 150 }}>
          <option value="all">{t('Tutti gli utenti', 'All users')}</option>
          {staff.map(o => <option key={o.id} value={o.id}>{o.name} {o.surname || ''}</option>)}
        </select>
      </div>

      {/* period filter */}
      <div style={{ display: 'flex', gap: 7, marginBottom: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <span className="t-meta" style={{ marginRight: 2 }}>{t('Periodo', 'Period')}</span>
        {periods.map(([k, l]) => { const on = period === k; return (
          <button key={k} onClick={() => setPeriod(k)} style={{ padding: '6px 12px', borderRadius: 99, fontSize: 12.5, fontWeight: 600, cursor: 'pointer', border: '1px solid ' + (on ? 'var(--clay)' : 'var(--hair)'), background: on ? 'var(--clay-tint)' : 'var(--surface)', color: on ? 'var(--clay-ink)' : 'var(--ink-2)' }}>{l}</button>
        ); })}
      </div>
      {period === 'custom' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
          <input type="date" value={from} min={DK_SALON_START} max={to} onChange={e => setFrom(e.target.value)} style={inputCss} />
          <span className="t-sm" style={{ color: 'var(--muted-2)' }}>→</span>
          <input type="date" value={to} min={from} max={TODAY} onChange={e => setTo(e.target.value)} style={inputCss} />
          <span className="t-sm" style={{ color: 'var(--muted-2)', marginLeft: 4 }}>{t('Inizio attività: mar 2023', 'Since: Mar 2023')}</span>
        </div>
      )}

      {/* type filter */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 16, flexWrap: 'wrap' }}>
        {tabs.map(([k, l]) => { const on = filt === k; return (
          <button key={k} onClick={() => setFilt(k)} style={{ padding: '5px 11px', borderRadius: 99, fontSize: 12, fontWeight: 600, cursor: 'pointer', border: '1px solid ' + (on ? 'var(--ink)' : 'var(--hair)'), background: on ? 'var(--ink)' : 'var(--surface)', color: on ? '#fff' : 'var(--ink-2)' }}>{l}</button>
        ); })}
      </div>

      <div className="t-sm" style={{ color: 'var(--muted-2)', marginBottom: 10 }}>{list.length} {t('voci', 'entries')}</div>
      <div className="dk-card" style={{ overflow: 'hidden' }}>
        {list.map((e, i) => { const m = DK_LOG_META[e.type] || DK_LOG_META.modify; const wo = op(e.who); return (
          <div key={e.id} style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 18px', borderTop: i ? '1px solid var(--hair)' : 'none' }}>
            <div style={{ width: 36, height: 36, borderRadius: 10, background: 'color-mix(in srgb, ' + m.color + ' 14%, transparent)', display: 'grid', placeItems: 'center', flexShrink: 0 }}><Icon name={m.icon} size={16} color={m.color} /></div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600, fontSize: 14 }}>{e.summary[lang]}</div>
              <div className="t-sm" style={{ color: 'var(--muted)', marginTop: 2, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ fontWeight: 700, color: m.color }}>{m[lang]}</span>
                {wo && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><Avatar initials={wo.initials} size={18} color={wo.color} />{wo.name} {wo.surname || ''}</span>}
              </div>
            </div>
            <div className="tabnum t-sm" style={{ color: 'var(--muted-2)', flexShrink: 0, textAlign: 'right' }}>{dkLogDateLabel(e.date, lang)}</div>
          </div>
        ); })}
        {!list.length && <div className="t-sm" style={{ color: 'var(--muted-2)', padding: '36px 16px', textAlign: 'center' }}>{t('Nessuna voce per i filtri selezionati.', 'No entries for the selected filters.')}</div>}
      </div>
    </div>
  );
}

Object.assign(window, { DkServizi, DkMagazzino, DkStaff, DkSettings, CategoriesManager, GD_PALETTE });
