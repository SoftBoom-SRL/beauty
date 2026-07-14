// desktop-shell.jsx — DesktopApp: context, sidebar, topbar, modal/drawer/toast, routing
const { useState: useStateDk, useEffect: useEffectDk, useRef: useRefDk } = React;

const DkCtx = React.createContext(null);
const useDk = () => React.useContext(DkCtx);

const DK_TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{ "lang": "it", "density": "comoda" }/*EDITMODE-END*/;

/* ---- modal & drawer hosts ---- */
function DkModal({ open, onClose, title, sub, children, width, foot }) {
  if (!open) return null;
  return (
    <div className="dk-scrim" onClick={onClose}>
      <div className="dk-modal" style={{ width }} onClick={e => e.stopPropagation()}>
        <div className="dk-modalhead">
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="t-title" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{title}</div>
            {sub && <div className="t-sm" style={{ color: 'var(--muted)', marginTop: 4 }}>{sub}</div>}
          </div>
          <button className="dk-iconbtn" style={{ flexShrink: 0, marginLeft: 12 }} onClick={onClose}><Icon name="x" size={18} /></button>
        </div>
        <div className="dk-modalbody">{children}</div>
        {foot && <div style={{ padding: '16px 24px', borderTop: '1px solid var(--hair)', display: 'flex', gap: 12, justifyContent: 'flex-end', background: 'var(--surface-2)' }}>{foot}</div>}
      </div>
    </div>
  );
}
function DkDrawer({ open, onClose, children }) {
  if (!open) return null;
  return (
    <div className="dk-scrim" onClick={onClose}>
      <div className="dk-drawer" onClick={e => e.stopPropagation()}>{children}</div>
    </div>
  );
}

function DkToast({ toast, onUndo, onDone }) {
  useEffectDk(() => { if (!toast) return; const tm = setTimeout(onDone, toast.undo ? 4500 : 2800); return () => clearTimeout(tm); }, [toast]);
  if (!toast) return null;
  return (
    <div className="dk-toast">
      {toast.icon && <Icon name={toast.icon} size={20} color="#fff" />}
      <span style={{ flex: 1, fontSize: 14.5, fontWeight: 500 }}>{toast.msg}</span>
      {toast.undo && <button onClick={onUndo} style={{ color: 'var(--clay-tint)', fontWeight: 700, fontSize: 14, cursor: 'pointer' }}>{toast.undo}</button>}
    </div>
  );
}

/* ---- shared desktop seg control ---- */
function DkSeg({ options, value, onChange, style }) {
  return (
    <div className="dk-seg" style={style}>
      {options.map(o => <button key={o.value} className={value === o.value ? 'on' : ''} onClick={() => onChange(o.value)}>{o.label}</button>)}
    </div>
  );
}

/* ---- reference locations (sedi) — multi-location salon ---- */
const DK_LOCATIONS = [
  { id: 'firenze', name: 'The Parlour', city: 'Firenze', addr: 'Via dei Pucci 12' },
  { id: 'milano', name: 'The Parlour', city: 'Milano · Brera', addr: 'Via Solferino 24' },
  { id: 'roma', name: 'The Parlour', city: 'Roma · Prati', addr: 'Via Cola di Rienzo 88' },
];

/* ---- consolidated multi-location reporting (owner view) ---- */
const DK_LOC_REPORT = {
  firenze: { revenue: 18450, appts: 142, clients: 318, staff: 4, occupancy: 82, lowStock: 3 },
  milano:  { revenue: 24800, appts: 168, clients: 402, staff: 5, occupancy: 88, lowStock: 1 },
  roma:    { revenue: 16200, appts: 121, clients: 264, staff: 3, occupancy: 74, lowStock: 5 },
};
const DK_OWNER_STAFF = [
  { initials: 'MR', name: 'Mara Rizzo', loc: 'Milano · Brera', color: 'var(--op-mara, #B3DDF7)', revenue: 7120, sales: 32, occ: 91 },
  { initials: 'SC', name: 'Sole Caputo', loc: 'Firenze', color: 'var(--op-sole, #C9B8F2)', revenue: 6480, sales: 24, occ: 86 },
  { initials: 'GV', name: 'Giulia Valli', loc: 'Roma · Prati', color: 'var(--op-giulia, #FBE7A1)', revenue: 5240, sales: 28, occ: 79 },
  { initials: 'AK', name: 'Asia Kane', loc: 'Milano · Brera', color: 'var(--op-asia, #C2E8CB)', revenue: 4900, sales: 19, occ: 83 },
  { initials: 'LB', name: 'Lina Bianchi', loc: 'Firenze', color: 'var(--op-lina, #F7C5D9)', revenue: 4310, sales: 21, occ: 77 },
];

function OwnerProfilePage({ locations, t, lang }) {
  const rows = locations.map(l => ({ ...l, r: DK_LOC_REPORT[l.id] || { revenue: 0, appts: 0, clients: 0, staff: 0, occupancy: 0, lowStock: 0 } }));
  const tot = rows.reduce((a, x) => ({ revenue: a.revenue + x.r.revenue, appts: a.appts + x.r.appts, clients: a.clients + x.r.clients, staff: a.staff + x.r.staff, lowStock: a.lowStock + x.r.lowStock }), { revenue: 0, appts: 0, clients: 0, staff: 0, lowStock: 0 });
  const avgOcc = Math.round(rows.reduce((a, x) => a + x.r.occupancy, 0) / Math.max(1, rows.length));
  const maxRev = Math.max(...rows.map(x => x.r.revenue));
  const maxStaffRev = Math.max(...DK_OWNER_STAFF.map(s => s.revenue));
  const eur = (n) => fmtEur(n, lang);
  return (
    <div className="dk-page" style={{ maxWidth: 1180 }}>
      {/* owner header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 24 }}>
        <Avatar initials="SC" size={60} color="var(--op-sole)" ring />
        <div>
          <div style={{ fontFamily: 'var(--serif)', fontSize: 26, fontWeight: 500, lineHeight: 1.1 }}>Sole Caputo</div>
          <div className="t-sm" style={{ color: 'var(--muted)', marginTop: 3 }}>{t('Titolare · ' + rows.length + ' sedi · vista consolidata', 'Owner · ' + rows.length + ' locations · consolidated view')}</div>
        </div>
      </div>

      {/* consolidated KPIs */}
      <div className="t-meta" style={{ marginBottom: 10 }}>{t('Totale su tutte le sedi · questo mese', 'All locations · this month')}</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 12, marginBottom: 24 }}>
        {[[t('Fatturato totale', 'Total revenue'), eur(tot.revenue), 'wallet'], [t('Appuntamenti', 'Appointments'), String(tot.appts), 'calendar'], [t('Occupazione media', 'Avg occupancy'), avgOcc + '%', 'target'], [t('Clienti attivi', 'Active clients'), String(tot.clients), 'clients']].map(([l, v, ic], i) => (
          <div key={i} className="dk-card" style={{ padding: '14px 16px', boxShadow: 'none', border: '1px solid var(--hair)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 6 }}><Icon name={ic} size={15} color="var(--clay-ink)" /><span className="t-meta">{l}</span></div>
            <div className="t-num" style={{ fontSize: 22, fontWeight: 800 }}>{v}</div>
          </div>
        ))}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 22, alignItems: 'start' }}>
        {/* per-location breakdown */}
        <div>
          <div className="t-meta" style={{ marginBottom: 10 }}>{t('Per sede', 'By location')}</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {rows.map(x => (
              <div key={x.id} className="dk-card" style={{ padding: 14, boxShadow: 'none', border: '1px solid var(--hair)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
                  <Icon name="mapPin" size={16} color="var(--clay-ink)" />
                  <span style={{ fontWeight: 700, fontSize: 14, flex: 1 }}>{x.city}</span>
                  <span className="t-num" style={{ fontWeight: 800, fontSize: 15 }}>{eur(x.r.revenue)}</span>
                </div>
                <div style={{ height: 6, borderRadius: 99, background: 'var(--surface-2)', overflow: 'hidden', marginBottom: 10 }}>
                  <div style={{ height: '100%', width: Math.round(x.r.revenue / maxRev * 100) + '%', background: 'var(--clay)', borderRadius: 99 }} />
                </div>
                <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                  <span className="t-sm" style={{ color: 'var(--muted)' }}>{x.r.appts} {t('appunt.', 'appts')}</span>
                  <span className="t-sm" style={{ color: 'var(--muted)' }}>{x.r.staff} {t('staff', 'staff')}</span>
                  <span className="t-sm" style={{ color: 'var(--muted)' }}>{t('occ.', 'occ.')} {x.r.occupancy}%</span>
                  <span className="t-sm" style={{ color: x.r.lowStock > 0 ? 'var(--warn)' : 'var(--muted)', fontWeight: x.r.lowStock > 0 ? 700 : 400 }}>{x.r.lowStock} {t('sottoscorta', 'low stock')}</span>
                </div>
              </div>
            ))}
          </div>

        </div>

        {/* staff performance across locations */}
        <div>
          <div className="t-meta" style={{ marginBottom: 10 }}>{t('Performance staff · tutte le sedi', 'Staff performance · all locations')}</div>
          <div className="dk-card" style={{ padding: 6, boxShadow: 'none', border: '1px solid var(--hair)' }}>
            {DK_OWNER_STAFF.map((s, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 12px', borderTop: i ? '1px solid var(--hair)' : 'none' }}>
                <Avatar initials={s.initials} size={36} color={s.color} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 700, fontSize: 13.5 }}>{s.name}</div>
                  <div className="t-sm" style={{ color: 'var(--muted)' }}>{s.loc} · {s.sales} {t('vendite', 'sales')} · {t('occ.', 'occ.')} {s.occ}%</div>
                  <div style={{ height: 5, borderRadius: 99, background: 'var(--surface-2)', overflow: 'hidden', marginTop: 6 }}>
                    <div style={{ height: '100%', width: Math.round(s.revenue / maxStaffRev * 100) + '%', background: s.color, borderRadius: 99 }} />
                  </div>
                </div>
                <span className="t-num" style={{ fontWeight: 800, fontSize: 14, flexShrink: 0 }}>{eur(s.revenue)}</span>
              </div>
            ))}
          </div>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginTop: 12, padding: '11px 14px', background: 'var(--surface-2)', borderRadius: 12 }}>
            <Icon name="sparkle" size={15} color="var(--clay-ink)" />
            <span className="t-sm" style={{ color: 'var(--muted)', lineHeight: 1.45 }}>{t('Vista consolidata: tutti i dati di fatturato, staff e magazzino delle tue sedi in un unico posto, senza cambiare istanza.', 'Consolidated view: revenue, staff and inventory across all your locations in one place, no instance switching.')}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---- bottom-left salon card + location switcher popover ---- */
function DkSalonSwitcher({ locations, setLocations, locId, setLocId, t, lang, fireToast }) {
  const [open, setOpen] = useStateDk(false);
  const [adding, setAdding] = useStateDk(false);
  const [editId, setEditId] = useStateDk(null);
  const [form, setForm] = useStateDk({ city: '', addr: '' });
  const ref = useRefDk(null);
  const active = locations.find(l => l.id === locId) || locations[0];

  useEffectDk(() => {
    if (!open) return;
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) { setOpen(false); setAdding(false); setEditId(null); } };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);

  const pick = (id) => { setLocId(id); setOpen(false); const l = locations.find(x => x.id === id); fireToast({ msg: t('Sede attiva: ', 'Active location: ') + l.city, icon: 'mapPin' }); };
  const startEdit = (l) => { setEditId(l.id); setAdding(false); setForm({ city: l.city, addr: l.addr }); };
  const startAdd = () => { setAdding(true); setEditId(null); setForm({ city: '', addr: '' }); };
  const canSave = form.city.trim().length > 0;
  const saveEdit = () => { setLocations(ls => ls.map(l => l.id === editId ? { ...l, city: form.city.trim(), addr: form.addr.trim() } : l)); setEditId(null); fireToast({ msg: t('Sede aggiornata', 'Location updated'), icon: 'check' }); };
  const saveAdd = () => { const id = 'loc' + Date.now(); setLocations(ls => [...ls, { id, name: 'The Parlour', city: form.city.trim(), addr: form.addr.trim() }]); setLocId(id); setAdding(false); setOpen(false); fireToast({ msg: t('Sede aggiunta', 'Location added'), icon: 'check' }); };

  const inputCss = { width: '100%', border: '1px solid var(--hair)', borderRadius: 9, outline: 'none', fontSize: 13.5, padding: '9px 11px', fontFamily: 'var(--sans)', background: 'var(--surface)', boxSizing: 'border-box' };

  return (
    <div ref={ref} style={{ position: 'relative', marginTop: 8 }}>
      {open && (
        <div className="dk-card" style={{ position: 'absolute', bottom: 'calc(100% + 8px)', left: 0, right: 0, padding: 8, zIndex: 80, boxShadow: 'var(--sh-pop)', maxHeight: 380, overflowY: 'auto' }}>
          <div className="t-meta" style={{ padding: '6px 8px 8px' }}>{t('Sede di riferimento', 'Reference location')}</div>
          {locations.map(l => {
            const on = l.id === locId;
            if (editId === l.id) {
              return (
                <div key={l.id} style={{ padding: '8px', display: 'flex', flexDirection: 'column', gap: 7 }}>
                  <input autoFocus value={form.city} onChange={e => setForm(f => ({ ...f, city: e.target.value }))} placeholder={t('Città / sede', 'City / location')} style={inputCss} />
                  <input value={form.addr} onChange={e => setForm(f => ({ ...f, addr: e.target.value }))} placeholder={t('Indirizzo', 'Address')} style={inputCss} />
                  <div style={{ display: 'flex', gap: 7, justifyContent: 'flex-end' }}>
                    <button className="dk-btn dk-btn--soft" style={{ height: 32, fontSize: 12.5 }} onClick={() => setEditId(null)}>{t('Annulla', 'Cancel')}</button>
                    <button className="dk-btn dk-btn--primary" style={{ height: 32, fontSize: 12.5 }} disabled={!canSave} onClick={saveEdit}>{t('Salva', 'Save')}</button>
                  </div>
                </div>
              );
            }
            return (
              <div key={l.id} className="dk-row" style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 10px', borderRadius: 9, cursor: 'pointer' }} onClick={() => pick(l.id)}>
                <div style={{ width: 34, height: 34, borderRadius: 10, background: on ? 'var(--clay)' : 'var(--surface-2)', color: on ? '#fff' : 'var(--muted)', display: 'grid', placeItems: 'center', fontWeight: 800, fontFamily: 'var(--serif)', fontSize: 16, flexShrink: 0 }}>P</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 700, fontSize: 13.5, color: 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{l.city}</div>
                  <div className="t-sm" style={{ color: 'var(--muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{l.addr}</div>
                </div>
                <button className="dk-iconbtn" title={t('Modifica', 'Edit')} onClick={(e) => { e.stopPropagation(); startEdit(l); }} style={{ width: 28, height: 28, borderRadius: 8, display: 'grid', placeItems: 'center', flexShrink: 0, color: 'var(--muted-2)' }}><Icon name="edit" size={14} /></button>
                {on && <Icon name="check" size={16} color="var(--clay-ink)" stroke={2.4} />}
              </div>
            );
          })}
          <div style={{ borderTop: '1px solid var(--hair)', marginTop: 6, paddingTop: 6 }}>
            {adding ? (
              <div style={{ padding: '8px', display: 'flex', flexDirection: 'column', gap: 7 }}>
                <input autoFocus value={form.city} onChange={e => setForm(f => ({ ...f, city: e.target.value }))} placeholder={t('Città / sede', 'City / location')} style={inputCss} />
                <input value={form.addr} onChange={e => setForm(f => ({ ...f, addr: e.target.value }))} placeholder={t('Indirizzo', 'Address')} style={inputCss} />
                <div style={{ display: 'flex', gap: 7, justifyContent: 'flex-end' }}>
                  <button className="dk-btn dk-btn--soft" style={{ height: 32, fontSize: 12.5 }} onClick={() => setAdding(false)}>{t('Annulla', 'Cancel')}</button>
                  <button className="dk-btn dk-btn--primary" style={{ height: 32, fontSize: 12.5 }} disabled={!canSave} onClick={saveAdd}>{t('Aggiungi', 'Add')}</button>
                </div>
              </div>
            ) : (
              <button className="dk-row" onClick={startAdd} style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '9px 10px', borderRadius: 9, cursor: 'pointer', color: 'var(--clay-ink)', fontWeight: 600, fontSize: 13.5 }}>
                <div style={{ width: 34, height: 34, borderRadius: 10, border: '1px dashed var(--line-strong)', display: 'grid', placeItems: 'center', flexShrink: 0 }}><Icon name="plus" size={16} color="var(--clay-ink)" /></div>
                {t('Aggiungi sede', 'Add location')}
              </button>
            )}
          </div>
        </div>
      )}
      <div className="dk-salon" onClick={() => setOpen(o => !o)}>
        <div style={{ width: 38, height: 38, borderRadius: 11, background: 'var(--clay)', display: 'grid', placeItems: 'center', color: '#fff', fontWeight: 800, fontFamily: 'var(--serif)', fontSize: 19, flexShrink: 0 }}>P</div>
        <div className="meta" style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 14, color: 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{active.name}</div>
          <div style={{ fontSize: 12, color: 'var(--muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{active.city}</div>
        </div>
        <Icon name="chevD" size={16} color="var(--muted-2)" className="dk-salon-chev" style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 160ms' }} />
      </div>
    </div>
  );
}

function DesktopApp() {
  const [tw, setTweak] = useTweaks(DK_TWEAK_DEFAULTS);
  const lang = tw.lang;
  const t = (it, en) => (lang === 'en' ? en : it);
  const [locations, setLocations] = useStateDk(() => DK_LOCATIONS.map(l => ({ ...l })));
  const [locId, setLocId] = useStateDk(DK_LOCATIONS[0].id);
  const [tab, setTab] = useStateDk('agenda');
  const [appts, setAppts] = useStateDk(window.APPTS);
  const [toast, setToast] = useStateDk(null);
  const [modal, setModal] = useStateDk(null);     // {type, data}
  const [drawer, setDrawer] = useStateDk(null);
  const [selClient, setSelClient] = useStateDk('c1');
  const [search, setSearch] = useStateDk('');
  const [analystOpen, setAnalystOpen] = useStateDk(false);
  React.useEffect(() => { window.__openAnalyst = () => setAnalystOpen(true); }, []);
  const [notifOpen, setNotifOpen] = useStateDk(false);
  const [sideCollapsed, setSideCollapsed] = useStateDk(() => { try { return localStorage.getItem('dk-side-collapsed') === '1'; } catch (e) { return false; } });
  useEffectDk(() => { try { localStorage.setItem('dk-side-collapsed', sideCollapsed ? '1' : '0'); } catch (e) {} }, [sideCollapsed]);
  const [newMenu, setNewMenu] = useStateDk(false);
  // shared two-way map service -> [operatorIds]
  const [svcOps, setSvcOps] = useStateDk(() => { const m = {}; window.SERVICES.forEach(s => { m[s.id] = [...s.ops]; }); return m; });
  const [commission, setCommission] = useStateDk(() => ({ ...window.STAFF_COMMISSION }));
  const [coupons, setCoupons] = useStateDk(() => window.COUPON_TEMPLATES.map(c => ({ ...c })));
  const [loyalty, setLoyalty] = useStateDk(() => window.LOYALTY_PROGRAMS.map(p => ({ ...p })));
  const [giftcards, setGiftcards] = useStateDk(() => window.GIFT_CARDS.map(g => ({ ...g })));
  const [depositRule, setDepositRule] = useStateDk({ on: true, threshold: 60 });
  // motore regole deposito — Impostazioni → Prenotazioni
  const [depositRules, setDepositRules] = useStateDk(() => ([
    { id: 'dr1', on: true, join: 'and', conds: [{ id: 'dc1', field: 'reliability', op: 'lt', value: 60 }], scope: 'all', svcIds: [], overrideOn: false, overridePct: 50 },
    { id: 'dr2', on: true, join: 'or', conds: [{ id: 'dc2', field: 'label', op: 'is', value: 'studente' }, { id: 'dc3', field: 'label', op: 'is', value: 'turista' }], scope: 'sel', svcIds: ['s2', 's7', 's8'], overrideOn: false, overridePct: 30 },
  ]));
  // catalogo etichette clienti — condiviso tra Impostazioni → Categorie e la scheda cliente
  const [clientCats, setClientCats] = useStateDk(() => ([
    { id: 'local',       name: { it: 'Local',        en: 'Local' },        color: '#6FB89A' },
    { id: 'expat',       name: { it: 'Expat',        en: 'Expat' },        color: '#5FAEC9' },
    { id: 'studyabroad', name: { it: 'Study abroad', en: 'Study abroad' }, color: '#9B86E0' },
    { id: 'tourist',     name: { it: 'Tourist',      en: 'Tourist' },      color: '#E0A85A' },
    { id: 'vip',         name: { it: 'VIP',          en: 'VIP' },          color: '#D9B65C' },
    { id: 'standard',    name: { it: 'Standard',     en: 'Standard' },     color: '#E08B9A' },
  ]));
  // categorie servizi — editabili (catalogo condiviso: pagina Servizi + Impostazioni → Categorie)
  const SVCCAT_COLORS = { nail: '#E68FAC', hair: '#A88FD6', viso: '#8FCBA6', extra: '#E6C766' };
  const SVCCAT_FALLBACK = ['#E68FAC', '#A88FD6', '#8FCBA6', '#E6C766', '#7FB8D9', '#D9A578'];
  const [svcCats, setSvcCats] = useStateDk(() => window.CATS.map((c, i) => ({ id: c.id, name: { ...c.name }, color: SVCCAT_COLORS[c.id] || SVCCAT_FALLBACK[i % SVCCAT_FALLBACK.length] })));
  const INVCAT_COLORS = ['#B08D57', 'var(--ok)', 'var(--info)', '#3F7A52', 'var(--warn)', 'var(--muted-2)'];
  const [invCats, setInvCats] = useStateDk(() => window.INV_CATS.map((c, i) => ({ id: c.id, name: { ...c.name }, color: INVCAT_COLORS[i % INVCAT_COLORS.length] })));
  const [waitList, setWaitList] = useStateDk(() => window.WAITING_LIST.map(w => ({ ...w })));
  const [freedSlot, setFreedSlot] = useStateDk(null); // { appt } shown after cancellation
  const [showRevenue, setShowRevenue] = useStateDk(() => { try { return localStorage.getItem('dk-show-revenue') !== '0'; } catch (e) { return true; } });
  const setShowRevenueP = (v) => { setShowRevenue(v); try { localStorage.setItem('dk-show-revenue', v ? '1' : '0'); } catch (e) {} };
  const OP_PALETTE = ['#C9B8F2', '#B3DDF7', '#F7C5D9', '#FBE7A1', '#C2E8CB', '#FBD7B5', '#BFE9E1', '#C3CDF7', '#D2E5BE'];
  const [opColors, setOpColors] = useStateDk(() => { const m = {}; window.OPS.forEach((o, i) => { m[o.id] = OP_PALETTE[i % OP_PALETTE.length]; }); return m; });
  const setOpColor = (id, c) => setOpColors(m => ({ ...m, [id]: c }));
  const undoRef = useRefDk(null);
  const toggleStaffSvc = (staffId, sid) => setSvcOps(m => { const cur = m[sid] || []; return { ...m, [sid]: cur.includes(staffId) ? cur.filter(x => x !== staffId) : [...cur, staffId] }; });
  const setServiceOps = (sid, ops) => setSvcOps(m => ({ ...m, [sid]: ops }));

  const fireToast = (o) => { undoRef.current = o.undoFn || null; setToast(o); };
  const openModal = (type, data) => setModal({ type, data });
  const closeModal = () => setModal(null);
  const [subTab, setSubTab] = useStateDk(null);
  const goTab = (id, sub) => { setTab(id); setSubTab(sub != null ? sub : null); };
  const [deepLink, setDeepLink] = useStateDk(null);

  const ctx = { t, lang, setLang: v => setTweak('lang', v), density: tw.density, appts, setAppts, fireToast,
    tab, setTab: goTab, subTab, setSubTab, openModal, closeModal, modal, drawer, setDrawer, selClient, setSelClient, search, setSearch,
    svcOps, setServiceOps, toggleStaffSvc, commission, setCommission, coupons, setCoupons, loyalty, setLoyalty, giftcards, setGiftcards, depositRule, setDepositRule, depositRules, setDepositRules, deepLink, setDeepLink, opColors, setOpColor, opPalette: OP_PALETTE, clientCats, setClientCats, svcCats, setSvcCats, invCats, setInvCats, waitList, setWaitList, freedSlot, setFreedSlot, showRevenue, setShowRevenue: setShowRevenueP };

  const SECTION_SUBTABS = {
    magazzino: [['prodotti', t('Prodotti', 'Products')], ['ordini', t('Ordini', 'Orders')], ['fornitori', t('Fornitori', 'Suppliers')], ['storico', t('Storico', 'History')]],
    servizi: [['servizi', t('Servizi', 'Services')], ['pacchetti', t('Pacchetti', 'Packages')]],
    pos: [['products', t('Prodotti', 'Products')], ['history', t('Storico', 'History')]],
    fedelta: [['coupon', t('Coupon', 'Coupons')], ['fedelta', t('Fedeltà', 'Loyalty')], ['giftcard', t('Gift card', 'Gift cards')]],
  };
  const NAV_MAIN = [
    { id: 'agenda', icon: 'calendar', label: t('Agenda', 'Agenda'), badge: window.APPTS.length },
    { id: 'pos', icon: 'wallet', label: t('Punto Vendita', 'Point of Sale') },
    { id: 'clienti', icon: 'clients', label: t('Clienti', 'Clients') },
    { id: 'insight', icon: 'insights', label: t('Analisi dati', 'Insights') },
    { id: 'auto', icon: 'bolt', label: t('Automazioni', 'Automations') },
  ];
  const NAV_MANAGE = [
    { id: 'servizi', icon: 'scissors', label: t('Servizi', 'Services') },
    { id: 'magazzino', icon: 'box', label: t('Magazzino', 'Inventory'), badge: 2 },
    { id: 'fedelta', icon: 'coupon', label: t('Promozioni', 'Promotions') },
    { id: 'comunicazioni', icon: 'message', label: t('Comunicazioni', 'Communications') },
    { id: 'staff', icon: 'user', label: t('Staff', 'Staff') },
    { id: 'impostazioni', icon: 'settings', label: t('Impostazioni', 'Settings') },
  ];
  const ALL = [...NAV_MAIN, ...NAV_MANAGE];
  const cur = ALL.find(n => n.id === tab) || (tab === 'profile' ? { label: t('Profilo titolare', 'Owner profile') } : NAV_MAIN[0]);

  const screens = {
    agenda: window.DkAgenda, pos: window.DkPos, clienti: window.DkClienti, insight: window.DkInsight, auto: window.DkAuto,
    servizi: window.DkServizi, magazzino: window.DkMagazzino, fedelta: window.DkFedelta, comunicazioni: window.DkComunicazioni, giftcard: window.DkGiftCard, staff: window.DkStaff, impostazioni: window.DkSettings,
  };
  const Screen = tab === 'profile'
    ? (() => <OwnerProfilePage locations={locations} t={t} lang={lang} />)
    : (screens[tab] || (() => <div className="dk-page"><EmptyState icon="sparkle" title={cur.label} sub="—" /></div>));

  return (
    <DkCtx.Provider value={ctx}>
      <div className={'dk-root' + (sideCollapsed ? ' dk-side-collapsed' : '')}>
        {/* sidebar */}
        <aside className="dk-side">
          <div className="dk-logo">
            <b>yourang</b><span style={{ width: 7, height: 7, borderRadius: 99, background: 'var(--clay)' }} />
            <button className="dk-side-extlink" onClick={() => fireToast({ msg: t('La dashboard yourang si aprirà qui (link in arrivo)', 'The yourang dashboard will open here (link coming soon)'), icon: 'ext' })} title={t('Vai alla dashboard yourang', 'Go to yourang dashboard')} style={{ marginLeft: 'auto', width: 30, height: 30, borderRadius: 9, display: 'grid', placeItems: 'center', cursor: 'pointer', background: 'var(--paper-2)', color: 'var(--muted)' }}>
              <Icon name="ext" size={16} color="var(--muted)" />
            </button>
            <button className="dk-collapse-btn" onClick={() => setSideCollapsed(c => !c)} title={sideCollapsed ? t('Espandi menu', 'Expand menu') : t('Comprimi menu', 'Collapse menu')} style={{ marginLeft: sideCollapsed ? 0 : 8 }}>
              <Icon name={sideCollapsed ? 'chevR' : 'chevL'} size={16} color="var(--muted)" />
            </button>
          </div>
          <nav className="dk-nav">
            {NAV_MAIN.map(n => <NavItem key={n.id} n={n} active={tab === n.id} onClick={() => goTab(n.id)} subtabs={SECTION_SUBTABS[n.id]} subTab={subTab} onSub={(s) => goTab(n.id, s)} />)}
            <div className="dk-navsection">{t('Gestione', 'Manage')}</div>
            {NAV_MANAGE.map(n => <NavItem key={n.id} n={n} active={tab === n.id} onClick={() => goTab(n.id)} subtabs={SECTION_SUBTABS[n.id]} subTab={subTab} onSub={(s) => goTab(n.id, s)} />)}
          </nav>
          <DkSalonSwitcher locations={locations} setLocations={setLocations} locId={locId} setLocId={setLocId} t={t} lang={lang} fireToast={fireToast} />
        </aside>

        {/* main */}
        <div className="dk-main">
          <header className="dk-top">
            <div style={{ display: 'flex', flexDirection: 'column', flexShrink: 0 }}>
              <div className="t-meta" style={{ color: 'var(--clay-ink)', fontSize: 10.5, whiteSpace: 'nowrap' }}>{t('Mercoledì 12 novembre', 'Wednesday 12 November')}</div>
              <div style={{ fontFamily: 'var(--serif)', fontSize: 24, fontWeight: 500, lineHeight: 1.05, marginTop: 3 }}>{cur.label}</div>
            </div>
            <div style={{ flex: 1 }} />
            <div className="dk-search">
              <Icon name="search" size={18} color="var(--muted-2)" />
              <input value={search} onChange={e => { setSearch(e.target.value); if (tab !== 'clienti') setTab('clienti'); }} placeholder={t('Cerca clienti…', 'Search clients…')} />
              {search && <button onClick={() => setSearch('')} style={{ cursor: 'pointer', display: 'grid', placeItems: 'center' }}><Icon name="x" size={15} color="var(--muted-2)" /></button>}
            </div>
            <div style={{ position: 'relative' }}>
              <button className="dk-iconbtn" onClick={() => setNotifOpen(o => !o)} style={{ position: 'relative', background: notifOpen ? 'var(--surface-2)' : 'var(--surface)', borderColor: notifOpen ? 'var(--line-strong)' : 'var(--hair)' }}>
                <Icon name="bell" size={19} />
                <span style={{ position: 'absolute', top: 8, right: 9, width: 8, height: 8, borderRadius: 99, background: 'var(--clay)', border: '2px solid var(--surface)' }} />
              </button>
              {notifOpen && <NotifPanel onClose={() => setNotifOpen(false)} t={t} setTab={setTab} fireToast={fireToast} />}
            </div>
            <div style={{ position: 'relative' }}>
              <button className="dk-btn dk-btn--clay" onClick={() => setNewMenu(o => !o)}><Icon name="plus" size={18} color="#fff" />{t('Nuova', 'New')}<Icon name="chevD" size={15} color="#fff" style={{ marginLeft: 2, transform: newMenu ? 'rotate(180deg)' : 'none', transition: 'transform 140ms' }} /></button>
              {newMenu && (
                <React.Fragment>
                  <div onClick={() => setNewMenu(false)} style={{ position: 'fixed', inset: 0, zIndex: 70 }} />
                  <div className="dk-card" style={{ position: 'absolute', top: 'calc(100% + 8px)', right: 0, zIndex: 71, width: 280, padding: 6, boxShadow: 'var(--sh-pop)' }}>
                    {[
                      { icon: 'calendar', title: t('Nuovo appuntamento', 'New appointment'), sub: t('Prenotazione telefonica in agenda', 'Phone booking in the agenda'), act: () => openModal('newappt') },
                      { icon: 'user', title: t('Nuovo cliente', 'New client'), sub: t('Inserimento manuale in anagrafica', 'Manual entry in the client book'), act: () => openModal('newclient') },
                    ].map((o, i) => (
                      <button key={i} className="dk-row" onClick={() => { setNewMenu(false); o.act(); }} style={{ display: 'flex', alignItems: 'center', gap: 11, width: '100%', padding: '11px 11px', borderRadius: 10, textAlign: 'left' }}>
                        <div style={{ width: 36, height: 36, borderRadius: 10, background: 'var(--clay-tint)', display: 'grid', placeItems: 'center', flexShrink: 0 }}><Icon name={o.icon} size={18} color="var(--clay-ink)" /></div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontWeight: 700, fontSize: 14 }}>{o.title}</div>
                          <div className="t-sm" style={{ color: 'var(--muted)' }}>{o.sub}</div>
                        </div>
                        <Icon name="chevR" size={15} color="var(--faint)" />
                      </button>
                    ))}
                  </div>
                </React.Fragment>
              )}
            </div>
            <div style={{ width: 1, height: 30, background: 'var(--hair)' }} />
            <button onClick={() => setTab('profile')} title={t('Profilo · vista consolidata sedi', 'Profile · consolidated locations')} style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: 0, borderRadius: 99 }}><Avatar initials="SC" size={40} color="var(--op-sole)" ring /></button>
          </header>

          <div className="dk-content" key={tab}>
            <Screen />
          </div>
        </div>

        {/* hosts */}
        <DkToast toast={toast} onUndo={() => { undoRef.current && undoRef.current(); setToast(null); }} onDone={() => setToast(null)} />
        {window.DkModals && <window.DkModals />}

        {/* global AI analyst — present on every page */}
        {!analystOpen && (
          <button onClick={() => setAnalystOpen(true)} className="dk-ai-fab" title={t('Chiedi a Youty', 'Ask Youty')}>
            <Icon name="sparkle" size={22} color="#fff" />
            <span className="dk-ai-fab__label">{t('Chiedi a Youty', 'Ask Youty')}</span>
          </button>
        )}
        {window.DkAnalyst && <window.DkAnalyst open={analystOpen} onClose={() => setAnalystOpen(false)} />}

        <TweaksPanel>
          <TweakSection label={t('Lingua', 'Language')} />
          <TweakRadio label={t('Lingua contenuti', 'Content language')} value={lang} options={[{ value: 'it', label: 'Italiano' }, { value: 'en', label: 'English' }]} onChange={v => setTweak('lang', v)} />
          <TweakSection label={t('Densità', 'Density')} />
          <TweakRadio label={t('Spaziatura', 'Spacing')} value={tw.density} options={[{ value: 'comoda', label: t('Comoda', 'Comfortable') }, { value: 'compatta', label: t('Compatta', 'Compact') }]} onChange={v => setTweak('density', v)} />
        </TweaksPanel>
      </div>
    </DkCtx.Provider>
  );
}

function NavItem({ n, active, onClick, subtabs, subTab, onSub }) {
  return (
    <React.Fragment>
    <button className={'dk-navitem' + (active ? ' dk-navitem--active' : '')} onClick={onClick}>
      <Icon name={n.icon} size={20} color="currentColor" stroke={active ? 2 : 1.7} />
      <span className="lbl" style={{ whiteSpace: 'nowrap' }}>{n.short || n.label}</span>
      {n.badge ? <span className="badge">{n.badge}</span> : null}
    </button>
    {active && subtabs && subtabs.length > 0 && (
      <div className="dk-subtabs" style={{ display: 'flex', flexDirection: 'column', gap: 1, margin: '1px 0 5px 0' }}>
        {subtabs.map(([k, l], i) => { const on = (subTab || subtabs[0][0]) === k; return (
          <button key={k} onClick={() => onSub(k)} style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '7px 12px 7px 40px', borderRadius: 9, border: 'none', cursor: 'pointer', textAlign: 'left', background: on ? 'var(--clay-tint)' : 'transparent', color: on ? 'var(--clay-ink)' : 'var(--muted)', fontSize: 13, fontWeight: on ? 700 : 500, fontFamily: 'var(--sans)' }}>
            <span style={{ width: 5, height: 5, borderRadius: 99, background: on ? 'var(--clay-ink)' : 'var(--faint)', flexShrink: 0 }} />{l}
          </button>
        ); })}
      </div>
    )}
    </React.Fragment>
  );
}

function NotifPanel({ onClose, t, setTab, fireToast }) {
  const items = [
    { icon: 'check', color: 'var(--ok)', tint: 'var(--ok-tint)', title: t('Sofia Ricci ha confermato', 'Sofia Ricci confirmed'), sub: t('Oggi alle 09:30 · via WhatsApp', 'Today at 09:30 · via WhatsApp'), when: t('5 min fa', '5 min ago'), go: 'agenda' },
    { icon: 'check', color: 'var(--ok)', tint: 'var(--ok-tint)', title: t('Giada Bellini ha confermato', 'Giada Bellini confirmed'), sub: t('Oggi alle 11:00', 'Today at 11:00'), when: t('22 min fa', '22 min ago'), go: 'agenda' },
    { icon: 'alert', color: 'var(--warn)', tint: 'var(--warn-tint)', title: t('Scorta minima: Tinta 6.0', 'Low stock: Colour 6.0'), sub: t('2 tubi rimasti · sotto la soglia', '2 tubes left · below threshold'), when: t('1 ora fa', '1h ago'), go: 'magazzino' },
  ];
  return (
    <React.Fragment>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 60 }} />
      <div className="dk-card" style={{ position: 'absolute', top: 'calc(100% + 8px)', right: 0, width: 340, padding: 8, boxShadow: 'var(--sh-pop)', zIndex: 61 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 10px 10px' }}>
          <span className="t-meta">{t('Notifiche', 'Notifications')}</span>
          <button onClick={() => { onClose(); fireToast({ msg: t('Segnate come lette', 'Marked as read'), icon: 'check' }); }} style={{ cursor: 'pointer', fontSize: 12, fontWeight: 700, color: 'var(--clay-ink)' }}>{t('Segna lette', 'Mark read')}</button>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {items.map((n, i) => (
            <button key={i} className="dk-row" onClick={() => { onClose(); setTab(n.go); }} style={{ display: 'flex', gap: 11, alignItems: 'flex-start', padding: '11px 10px', borderRadius: 10, textAlign: 'left', width: '100%' }}>
              <div style={{ width: 32, height: 32, borderRadius: 9, background: n.tint, display: 'grid', placeItems: 'center', flexShrink: 0 }}><Icon name={n.icon} size={16} color={n.color} /></div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: 13.5, lineHeight: 1.3 }}>{n.title}</div>
                <div className="t-sm" style={{ color: 'var(--muted)', marginTop: 2 }}>{n.sub}</div>
              </div>
              <span className="t-sm" style={{ color: 'var(--muted-2)', whiteSpace: 'nowrap', fontSize: 11.5 }}>{n.when}</span>
            </button>
          ))}
        </div>
      </div>
    </React.Fragment>
  );
}

/* shared category filter dropdown (used by Clienti, Servizi, Pacchetti, Magazzino) */
function FilterMenu({ options, active, onChange, title }) {
  const [open, setOpen] = React.useState(false);
  const allKey = options[0][0];
  const activeNotAll = active !== allKey;
  return (
    <div style={{ position: 'relative', flexShrink: 0 }}>
      <button className="dk-iconbtn" onClick={() => setOpen(o => !o)} style={{ background: activeNotAll || open ? 'var(--ink)' : 'var(--surface)', borderColor: activeNotAll || open ? 'var(--ink)' : 'var(--hair)', position: 'relative' }}>
        <Icon name="filter" size={18} color={activeNotAll || open ? '#fff' : 'var(--ink)'} />
        {activeNotAll && <span style={{ position: 'absolute', top: -4, right: -4, width: 16, height: 16, borderRadius: 99, background: 'var(--clay)', border: '2px solid var(--paper)' }} />}
      </button>
      {open && (
        <React.Fragment>
          <div onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 60 }} />
          <div className="dk-card" style={{ position: 'absolute', top: 'calc(100% + 8px)', right: 0, width: 220, padding: 8, boxShadow: 'var(--sh-pop)', zIndex: 61, maxHeight: 360, overflowY: 'auto' }}>
            <div className="t-meta" style={{ padding: '6px 10px 8px' }}>{title}</div>
            {options.map(([k, l]) => { const on = active === k; return (
              <button key={k} className="dk-row" onClick={() => { onChange(k); setOpen(false); }} style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '9px 10px', borderRadius: 9, textAlign: 'left' }}>
                <span style={{ flex: 1, fontWeight: on ? 700 : 600, fontSize: 13.5, color: on ? 'var(--ink)' : 'var(--ink-2)' }}>{l}</span>
                {on && <Icon name="check" size={15} color="var(--clay-ink)" stroke={2.4} />}
              </button>
            ); })}
          </div>
        </React.Fragment>
      )}
    </div>
  );
}

/* grouped multi-dimension filter dropdown (Magazzino, Servizi, Clienti, Promozioni) */
function GroupedFilterMenu({ groups, t }) {
  const [open, setOpen] = React.useState(false);
  const activeCount = groups.filter(g => g.value !== 'all').length;
  const clearAll = () => groups.forEach(g => g.set('all'));
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
              <span style={{ fontWeight: 700, fontSize: 13 }}>{t ? t('Filtri', 'Filters') : 'Filtri'}</span>
              {activeCount > 0 && <button onClick={clearAll} style={{ background: 'transparent', border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 700, color: 'var(--clay-ink)' }}>{t ? t('Azzera', 'Clear') : 'Azzera'}</button>}
            </div>
            {groups.map((g, gi) => (
              <React.Fragment key={gi}>
                {gi > 0 && <div style={{ height: 1, background: 'var(--hair)', margin: '5px 0' }} />}
                <div style={{ marginBottom: 2 }}>
                  <div className="t-meta" style={{ padding: '8px 10px 5px' }}>{g.label}</div>
                  {g.opts.map(([k, l]) => { const on = g.value === k; return (
                    <button key={k} className="dk-row" onClick={() => g.set(k)} style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '8px 10px', borderRadius: 9, textAlign: 'left' }}>
                      <span style={{ flex: 1, fontWeight: on ? 700 : 600, fontSize: 13.5, color: on ? 'var(--ink)' : 'var(--ink-2)' }}>{l}</span>
                      {on && <Icon name="check" size={15} color="var(--clay-ink)" stroke={2.4} />}
                    </button>
                  ); })}
                </div>
              </React.Fragment>
            ))}
          </div>
        </React.Fragment>
      )}
    </div>
  );
}

function HexInput({ value, onChange, width }) {
  const [raw, setRaw] = React.useState((value || '').replace('#', '').toUpperCase());
  React.useEffect(() => { setRaw((value || '').replace('#', '').toUpperCase()); }, [value]);
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, border: '1px solid var(--hair)', borderRadius: 9, padding: '8px 11px', background: 'var(--surface)' }}>
      <span style={{ color: 'var(--muted-2)', fontFamily: 'ui-monospace, monospace', fontWeight: 700 }}>#</span>
      <input value={raw} maxLength={6}
        onChange={e => { const v = e.target.value.replace(/[^0-9a-fA-F]/g, '').toUpperCase(); setRaw(v); if (v.length === 6) onChange('#' + v); }}
        onBlur={() => { if (raw.length === 3) { const x = raw.split('').map(c => c + c).join(''); setRaw(x); onChange('#' + x); } else if (raw.length === 6) { onChange('#' + raw); } else { setRaw((value || '').replace('#', '').toUpperCase()); } }}
        style={{ border: 'none', outline: 'none', background: 'transparent', fontFamily: 'ui-monospace, monospace', fontWeight: 700, fontSize: 14, width: width || 78, letterSpacing: '0.05em' }} />
    </span>
  );
}

Object.assign(window, { DkCtx, useDk, DkModal, DkDrawer, DkSeg, FilterMenu, GroupedFilterMenu, HexInput, DesktopApp });
