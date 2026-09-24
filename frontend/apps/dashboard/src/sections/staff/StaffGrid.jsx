// StaffGrid — operator cards with today's availability, month revenue, today's clients.
// Port of prototype DkStaff grid; data = ctx operators (GET /api/staff/ → OperatorStatusOut).
// Sotto, a richiesta, le operatrici disattivate (GET /api/staff/?include_inactive=true, C8).
import { useCallback, useEffect, useState } from 'react';
import { api, Avatar, Icon } from '@youty/shared';
import { useDash, useLive } from '../../ctx.jsx';
import { HIDDEN, todayStatus, opName, eur } from './lib.js';
import NewOperatorModal from './NewOperatorModal.jsx';

export default function StaffGrid({ onOpen }) {
  const { t, lang, operators, reload, showRevenue, hasScope, opColors } = useDash();
  const [newOpen, setNewOpen] = useState(false);
  const canTeam = hasScope('team');

  // refresh today-status / KPI on entry (boot data may be stale)
  useEffect(() => { reload.operators().catch(() => {}); }, [reload]);

  /* Operatrici non attive. La scheda si apriva solo da questa griglia, che
   * elenca le attive: un'operatrice spenta per errore, o rientrata dopo la
   * maternità, non si ritrovava più per riaccenderla, e crearne una nuova
   * collegata allo stesso utente falliva (09-05, 15-05). */
  const [showInactive, setShowInactive] = useState(false);
  const [inactive, setInactive] = useState(null);
  const loadInactive = useCallback(() => api.get('/api/staff/', { params: { include_inactive: true } })
    .then((list) => setInactive((list || []).filter((o) => o.active === false)))
    .catch(() => setInactive((l) => l || [])), []);
  useEffect(() => { if (showInactive) loadInactive(); }, [showInactive, loadInactive]);
  useLive(/^operator\./, () => { if (showInactive) loadInactive(); });

  return (
    <div className="dk-page" style={{ maxWidth: 1080 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 18 }}>
        <div style={{ flex: 1 }}>
          <div className="t-meta">{t('Team', 'Team')} · {operators.length} {t('operatrici', 'stylists')}</div>
        </div>
        {canTeam && (
          <button className="dk-btn dk-btn--clay" onClick={() => setNewOpen(true)}>
            <Icon name="plus" size={16} color="#fff" />{t('Nuova operatrice', 'New stylist')}
          </button>
        )}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 16 }}>
        {operators.map((o) => {
          const ts = todayStatus(o, t, lang);
          const color = opColors[o.id] || o.color;
          return (
            <div key={o.id} className="dk-card dk-hovercard" onClick={() => onOpen(o.id)} style={{ padding: 18 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
                <Avatar initials={o.initials} size={48} color={color} ring />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="t-h3" style={{ fontSize: 16 }}>{opName(o)}</div>
                  <div className="t-sm" style={{ color: 'var(--muted)' }}>{o.role_title || t('Operatrice', 'Stylist')}</div>
                </div>
              </div>
              {/* today's availability — the at-a-glance info */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '10px 13px', borderRadius: 11, background: ts.bg, marginBottom: 14 }}>
                <span style={{ width: 9, height: 9, borderRadius: 99, background: ts.color, flexShrink: 0, boxShadow: ts.key === 'work' ? '0 0 0 3px color-mix(in srgb, ' + ts.color + ' 25%, transparent)' : 'none' }} />
                <span style={{ fontWeight: 700, fontSize: 13.5, color: ts.color }}>{t('Oggi', 'Today')}: {ts.label}</span>
                {ts.hours && <span className="t-num" style={{ marginLeft: 'auto', fontSize: 13, fontWeight: 700, color: ts.color }}>{ts.hours}</span>}
              </div>
              <div style={{ display: 'flex', gap: 22 }}>
                <div>
                  <div className="t-meta" style={{ fontSize: 9.5, whiteSpace: 'nowrap' }}>{t('Incasso mese', 'Month revenue')}</div>
                  {/* null senza il permesso vendite (C6): «•••», mai «€0» */}
                  <div className="t-num" style={{ fontSize: 18, marginTop: 4 }}>{showRevenue && o.month_revenue != null ? eur(o.month_revenue, lang) : HIDDEN}</div>
                </div>
                <div>
                  <div className="t-meta" style={{ fontSize: 9.5, whiteSpace: 'nowrap' }}>{t('Clienti oggi', 'Clients today')}</div>
                  <div className="t-num" style={{ fontSize: 18, marginTop: 4, color: ts.key === 'work' ? 'var(--ink)' : 'var(--muted-2)' }}>{o.today_clients}</div>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div style={{ marginTop: 26 }}>
        <button className="dk-btn dk-btn--ghost" onClick={() => setShowInactive((v) => !v)} style={{ height: 36, fontSize: 13 }}>
          <Icon name="chevD" size={14} style={{ transform: showInactive ? 'rotate(180deg)' : 'none', transition: 'transform 140ms' }} />
          {showInactive ? t('Nascondi le operatrici non attive', 'Hide inactive stylists') : t('Mostra le operatrici non attive', 'Show inactive stylists')}
        </button>
        {showInactive && (
          inactive === null ? (
            <div className="skel" style={{ height: 70, borderRadius: 14, marginTop: 12 }} />
          ) : !inactive.length ? (
            <div className="t-sm" style={{ color: 'var(--muted-2)', marginTop: 12 }}>{t('Nessuna operatrice disattivata.', 'No inactive stylists.')}</div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 12, marginTop: 12 }}>
              {inactive.map((o) => (
                <div key={o.id} className="dk-card dk-hovercard" onClick={() => onOpen(o.id)} style={{ padding: '14px 16px', display: 'flex', alignItems: 'center', gap: 12, opacity: 0.8 }}>
                  <Avatar initials={o.initials} size={40} color={o.color} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 700, fontSize: 14.5, display: 'flex', alignItems: 'center', gap: 8 }}>
                      {opName(o)}
                      <span style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--danger)', background: 'var(--danger-tint)', padding: '1px 8px', borderRadius: 99 }}>{t('Non attiva', 'Inactive')}</span>
                    </div>
                    <div className="t-sm" style={{ color: 'var(--muted)' }}>{canTeam ? t('Apri la scheda per riattivarla', 'Open the profile to reactivate her') : (o.role_title || t('Operatrice', 'Stylist'))}</div>
                  </div>
                  <Icon name="chevR" size={15} color="var(--faint)" />
                </div>
              ))}
            </div>
          )
        )}
      </div>

      {newOpen && <NewOperatorModal onClose={() => setNewOpen(false)} onCreated={(id) => { setNewOpen(false); onOpen(id); }} />}
    </div>
  );
}
