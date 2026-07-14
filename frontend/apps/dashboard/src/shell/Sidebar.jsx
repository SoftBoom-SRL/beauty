// Sidebar.jsx — logo, main/manage nav with inline sub-tabs, location switcher.
import React, { useEffect, useRef, useState } from 'react';
import { Icon } from '@youty/shared';
import { useDash } from '../ctx.jsx';

export default function Sidebar({ collapsed, onToggleCollapse }) {
  const { t, tab, setTab, subTab } = useDash();

  const SECTION_SUBTABS = {
    magazzino: [['prodotti', t('Prodotti', 'Products')], ['ordini', t('Ordini', 'Orders')], ['fornitori', t('Fornitori', 'Suppliers')], ['storico', t('Storico', 'History')]],
    servizi: [['servizi', t('Servizi', 'Services')], ['pacchetti', t('Pacchetti', 'Packages')]],
    pos: [['products', t('Prodotti', 'Products')], ['history', t('Storico', 'History')]],
    fedelta: [['coupon', t('Coupon', 'Coupons')], ['fedelta', t('Fedeltà', 'Loyalty')], ['gift', t('Gift card', 'Gift cards')]],
  };
  const NAV_MAIN = [
    { id: 'agenda', icon: 'calendar', label: t('Agenda', 'Agenda') },
    { id: 'pos', icon: 'wallet', label: t('Punto Vendita', 'Point of Sale') },
    { id: 'clienti', icon: 'clients', label: t('Clienti', 'Clients') },
    { id: 'insight', icon: 'insights', label: t('Analisi dati', 'Insights') },
    { id: 'automazioni', icon: 'bolt', label: t('Automazioni', 'Automations') },
  ];
  const NAV_MANAGE = [
    { id: 'servizi', icon: 'scissors', label: t('Servizi', 'Services') },
    { id: 'magazzino', icon: 'box', label: t('Magazzino', 'Inventory') },
    { id: 'fedelta', icon: 'coupon', label: t('Promozioni', 'Promotions') },
    { id: 'comunicazioni', icon: 'message', label: t('Comunicazioni', 'Communications') },
    { id: 'staff', icon: 'user', label: t('Staff', 'Staff') },
    { id: 'impostazioni', icon: 'settings', label: t('Impostazioni', 'Settings') },
  ];

  return (
    <aside className="dk-side">
      <div className="dk-logo">
        <b>youty</b><span style={{ width: 7, height: 7, borderRadius: 99, background: 'var(--clay)' }} />
        <button className="dk-collapse-btn" onClick={onToggleCollapse}
          title={collapsed ? t('Espandi menu', 'Expand menu') : t('Comprimi menu', 'Collapse menu')}
          style={{ marginLeft: collapsed ? 0 : 'auto' }}>
          <Icon name={collapsed ? 'chevR' : 'chevL'} size={16} color="var(--muted)" />
        </button>
      </div>
      <nav className="dk-nav">
        {NAV_MAIN.map((n) => (
          <NavItem key={n.id} n={n} active={tab === n.id} onClick={() => setTab(n.id)}
            subtabs={SECTION_SUBTABS[n.id]} subTab={subTab} onSub={(s) => setTab(n.id, s)} />
        ))}
        <div className="dk-navsection">{t('Gestione', 'Manage')}</div>
        {NAV_MANAGE.map((n) => (
          <NavItem key={n.id} n={n} active={tab === n.id} onClick={() => setTab(n.id)}
            subtabs={SECTION_SUBTABS[n.id]} subTab={subTab} onSub={(s) => setTab(n.id, s)} />
        ))}
      </nav>
      <LocationSwitcher />
    </aside>
  );
}

function NavItem({ n, active, onClick, subtabs, subTab, onSub }) {
  return (
    <React.Fragment>
      <button className={'dk-navitem' + (active ? ' dk-navitem--active' : '')} onClick={onClick}>
        <Icon name={n.icon} size={20} color="currentColor" stroke={active ? 2 : 1.7} />
        <span className="lbl" style={{ whiteSpace: 'nowrap' }}>{n.label}</span>
        {n.badge ? <span className="badge">{n.badge}</span> : null}
      </button>
      {active && subtabs && subtabs.length > 0 && (
        <div className="dk-subtabs" style={{ display: 'flex', flexDirection: 'column', gap: 1, margin: '1px 0 5px 0' }}>
          {subtabs.map(([k, l]) => {
            const on = (subTab || subtabs[0][0]) === k;
            return (
              <button key={k} onClick={() => onSub(k)} style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '7px 12px 7px 40px', borderRadius: 9, border: 'none', cursor: 'pointer', textAlign: 'left', background: on ? 'var(--clay-tint)' : 'transparent', color: on ? 'var(--clay-ink)' : 'var(--muted)', fontSize: 13, fontWeight: on ? 700 : 500, fontFamily: 'var(--sans)' }}>
                <span style={{ width: 5, height: 5, borderRadius: 99, background: on ? 'var(--clay-ink)' : 'var(--faint)', flexShrink: 0 }} />{l}
              </button>
            );
          })}
        </div>
      )}
    </React.Fragment>
  );
}

/* Location (sede) switcher — driven by GET /api/core/salon locations.
 * Display + pick only for now. TODO: add/edit locations via
 * POST/PUT /api/core/locations (owner) — Impostazioni's job later. */
function LocationSwitcher() {
  const { t, salon, locations, fireToast } = useDash();
  const [open, setOpen] = useState(false);
  const defaultLoc = locations.find((l) => l.is_default) || locations[0] || null;
  const [locId, setLocId] = useState(defaultLoc?.id ?? null);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);

  if (!salon) return null;
  const active = locations.find((l) => l.id === locId) || defaultLoc;
  const monogram = (salon.name || '?').charAt(0).toUpperCase();

  const pick = (l) => {
    setLocId(l.id);
    setOpen(false);
    fireToast({ msg: t('Sede attiva: ', 'Active location: ') + l.name, icon: 'mapPin' });
  };

  return (
    <div ref={ref} style={{ position: 'relative', marginTop: 8 }}>
      {open && (
        <div className="dk-card" style={{ position: 'absolute', bottom: 'calc(100% + 8px)', left: 0, right: 0, padding: 8, zIndex: 80, boxShadow: 'var(--sh-pop)', maxHeight: 380, overflowY: 'auto' }}>
          <div className="t-meta" style={{ padding: '6px 8px 8px' }}>{t('Sede di riferimento', 'Reference location')}</div>
          {locations.map((l) => {
            const on = l.id === active?.id;
            return (
              <div key={l.id} className="dk-row" style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 10px', borderRadius: 9, cursor: 'pointer' }} onClick={() => pick(l)}>
                <div style={{ width: 34, height: 34, borderRadius: 10, background: on ? 'var(--clay)' : 'var(--surface-2)', color: on ? '#fff' : 'var(--muted)', display: 'grid', placeItems: 'center', fontWeight: 800, fontFamily: 'var(--serif)', fontSize: 16, flexShrink: 0 }}>{monogram}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 700, fontSize: 13.5, color: 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{l.name}</div>
                  {l.address && <div className="t-sm" style={{ color: 'var(--muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{l.address}</div>}
                </div>
                {on && <Icon name="check" size={16} color="var(--clay-ink)" stroke={2.4} />}
              </div>
            );
          })}
        </div>
      )}
      <div className="dk-salon" onClick={() => setOpen((o) => !o)}>
        <div style={{ width: 38, height: 38, borderRadius: 11, background: 'var(--clay)', display: 'grid', placeItems: 'center', color: '#fff', fontWeight: 800, fontFamily: 'var(--serif)', fontSize: 19, flexShrink: 0 }}>{monogram}</div>
        <div className="meta" style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 14, color: 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{salon.name}</div>
          <div style={{ fontSize: 12, color: 'var(--muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{active ? active.name : '—'}</div>
        </div>
        <Icon name="chevD" size={16} color="var(--muted-2)" className="dk-salon-chev" style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 160ms' }} />
      </div>
    </div>
  );
}
