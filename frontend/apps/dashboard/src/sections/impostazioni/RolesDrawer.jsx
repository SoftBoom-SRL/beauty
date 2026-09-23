// RolesDrawer.jsx — port of RolesManager on /api/auth/roles (scope 'team').
// Scope checkboxes come from the known API scope list; system roles read-only.
// Keeps the prototype's local "revenue summary visible" UI toggle (ctx showRevenue).
import React, { useCallback, useEffect, useState } from 'react';
import { api, Icon } from '@youty/shared';
import DkDrawer from '../../ui/DkDrawer.jsx';
import DkConfirm from '../../ui/DkConfirm.jsx';
import { useDash } from '../../ctx.jsx';
import { inputCss, toastErr, LockNote } from './lib.jsx';

// known scopes (common/permissions.py) with bilingual labels
export const SCOPES = [
  { id: 'agenda', it: 'Agenda e appuntamenti', en: 'Agenda & appointments' },
  { id: 'clients', it: 'Schede cliente', en: 'Client records' },
  { id: 'sales', it: 'Vendite e checkout', en: 'Sales & checkout' },
  { id: 'inventory', it: 'Magazzino e rettifiche', en: 'Inventory & adjustments' },
  { id: 'pricing', it: 'Listino e prezzi', en: 'Pricing & price list' },
  { id: 'marketing', it: 'Coupon, fedeltà e marketing', en: 'Coupons, loyalty & marketing' },
  { id: 'team', it: 'Team e permessi', en: 'Team & permissions' },
  { id: 'activity_log', it: 'Registro attività', en: 'Activity log' },
  { id: 'insights', it: 'Analisi dati', en: 'Insights' },
];

export default function RolesDrawer({ onClose }) {
  const { t, lang, hasScope, showRevenue, setShowRevenue, fireToast, session } = useDash();
  const canTeam = hasScope('team');
  /* Nessuno regala permessi che non ha: il server rifiuta con 403 chi prova ad
   * assegnare uno scope che non possiede, e chi ha il solo «team» poteva
   * altrimenti crearsi un ruolo con tutto e assegnarselo. La regola va spiegata
   * qui, con i comandi bloccati, invece di lasciarla arrivare come un errore
   * grezzo dopo che l'operatrice ha già composto il ruolo. Il titolare è esente:
   * i permessi sono suoi per definizione. */
  const isOwner = !!session?.is_owner;
  const myScopes = session?.scopes || [];
  const canGrant = (scopeId) => isOwner || myScopes.includes(scopeId);
  // Un ruolo si tocca solo se non è più potente di chi lo tocca: altrimenti
  // basterebbe riscriverlo per togliere a una collega i permessi che ha.
  const canTouchRole = (role) => isOwner || (role.scopes || []).every((x) => myScopes.includes(x));
  const [roles, setRoles] = useState(null);
  const [openId, setOpenId] = useState(null);
  const [drafts, setDrafts] = useState({}); // roleId → {name, scopes}

  const load = useCallback(async () => {
    try {
      const r = await api.get('/api/auth/roles');
      setRoles(r);
      setDrafts(Object.fromEntries(r.map((x) => [x.id, { name: x.name, scopes: [...x.scopes] }])));
    } catch (err) { toastErr(err, fireToast, t); setRoles([]); }
  }, [fireToast, t]);
  useEffect(() => { if (canTeam) load(); }, [canTeam, load]);

  const addRole = async () => {
    try {
      // Il ruolo nasce con un permesso che chi lo crea ha davvero: partire
      // sempre da «agenda» faceva fallire la creazione con un 403 a chi non ce
      // l'aveva, senza che si capisse perché.
      const seed = canGrant('agenda') ? ['agenda'] : myScopes.slice(0, 1);
      const created = await api.post('/api/auth/roles', { name: t('Nuovo ruolo', 'New role'), scopes: seed });
      setRoles((l) => [...l, created]);
      setDrafts((d) => ({ ...d, [created.id]: { name: created.name, scopes: [...created.scopes] } }));
      setOpenId(created.id);
      fireToast({ msg: t('Ruolo creato · imposta i permessi', 'Role created · set permissions'), icon: 'check' });
    } catch (err) { toastErr(err, fireToast, t); }
  };

  const saveRole = async (role) => {
    const d = drafts[role.id];
    if (!d || !d.name.trim()) return;
    try {
      const upd = await api.put(`/api/auth/roles/${role.id}`, { name: d.name.trim(), scopes: d.scopes });
      setRoles((l) => l.map((r) => (r.id === role.id ? upd : r)));
      setDrafts((ds) => ({ ...ds, [role.id]: { name: upd.name, scopes: [...upd.scopes] } }));
      fireToast({ msg: t('Permessi salvati per ', 'Permissions saved for ') + upd.name, icon: 'check' });
    } catch (err) { toastErr(err, fireToast, t); }
  };

  /* Eliminare un ruolo partiva al primo clic: chi lo aveva restava senza
   * alcun permesso (la membership perde il ruolo) e gli inviti in attesa con
   * quel ruolo sparivano. Un clic su «Elimina ruolo» mentre si rinominava
   * «Front desk» lasciava la reception senza agenda né cassa (15-08). Ora si
   * chiede, dicendo chi e cosa si perde. */
  const [confirmDel, setConfirmDel] = useState(null); // { role, members: [..]|null, invites: n|null }
  const [deleting, setDeleting] = useState(false);
  const askDelete = async (role) => {
    setConfirmDel({ role, members: null, invites: null });
    try {
      const [m, i] = await Promise.all([api.get('/api/auth/members'), api.get('/api/auth/invitations')]);
      const members = (m || []).filter((x) => x.role?.id === role.id);
      const invites = (i || []).filter((x) => x.status === 'pending' && x.role?.id === role.id).length;
      setConfirmDel((c) => (c && c.role.id === role.id ? { ...c, members, invites } : c));
    } catch {
      setConfirmDel((c) => (c && c.role.id === role.id ? { ...c, members: [], invites: 0, unknown: true } : c));
    }
  };
  const delRole = async () => {
    const role = confirmDel?.role;
    if (!role || deleting) return;
    setDeleting(true);
    try {
      await api.del(`/api/auth/roles/${role.id}`);
      setRoles((l) => l.filter((r) => r.id !== role.id));
      if (openId === role.id) setOpenId(null);
      setConfirmDel(null);
      fireToast({ msg: t('Ruolo eliminato', 'Role deleted'), icon: 'x' });
    } catch (err) { toastErr(err, fireToast, t); } // 400 if system
    finally { setDeleting(false); }
  };
  const delDetail = () => {
    const c = confirmDel;
    if (!c) return '';
    if (c.members === null) return t('Controllo chi ha questo ruolo…', 'Checking who holds this role…');
    if (c.unknown) {
      return t('Chi ha questo ruolo resterà senza alcun permesso finché non gliene assegni un altro, e gli inviti in attesa con questo ruolo verranno annullati.',
        'Whoever holds this role will be left with no permissions until you assign another one, and pending invitations with this role will be cancelled.');
    }
    const names = c.members.map((x) => x.user?.name || x.user?.email).filter(Boolean);
    const who = names.length > 3 ? names.slice(0, 3).join(', ') + '…' : names.join(', ');
    const parts = [];
    if (names.length) {
      parts.push(t(`${names.length === 1 ? '1 persona lo ha' : names.length + ' persone lo hanno'} (${who}): ${names.length === 1 ? 'resterà' : 'resteranno'} senza alcun permesso finché non assegni un altro ruolo.`,
        `${names.length === 1 ? '1 person holds it' : names.length + ' people hold it'} (${who}): they will have no permissions until you assign another role.`));
    } else {
      parts.push(t('Nessun membro ha questo ruolo.', 'No member holds this role.'));
    }
    if (c.invites) {
      parts.push(t(`${c.invites === 1 ? 'L’invito in attesa' : `Gli ${c.invites} inviti in attesa`} con questo ruolo ${c.invites === 1 ? 'verrà annullato' : 'verranno annullati'}.`,
        `${c.invites === 1 ? 'The pending invitation' : `The ${c.invites} pending invitations`} with this role will be cancelled.`));
    }
    return parts.join(' ');
  };

  const toggleScope = (roleId, sid) => setDrafts((ds) => {
    const d = ds[roleId];
    const scopes = d.scopes.includes(sid) ? d.scopes.filter((x) => x !== sid) : [...d.scopes, sid];
    return { ...ds, [roleId]: { ...d, scopes } };
  });

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
        {!canTeam ? (
          <LockNote t={t} msg={t('Ti serve il permesso "Team" per gestire i ruoli.', 'You need the "Team" permission to manage roles.')} />
        ) : (
          <React.Fragment>
            {/* local UI pref: revenue summary visibility (agenda box) */}
            <div className="dk-card" style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 16px', boxShadow: 'none', border: '1px solid var(--hair)', marginBottom: 14 }}>
              <div style={{ width: 36, height: 36, borderRadius: 10, background: 'var(--ink)', display: 'grid', placeItems: 'center', flexShrink: 0 }}><Icon name="wallet" size={17} color="#fff" /></div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 700, fontSize: 14 }}>{t('Riepilogo incassi visibile', 'Revenue summary visible')}</div>
                <div className="t-sm" style={{ color: 'var(--muted)' }}>{t('Mostra la box "Vendite totali" in agenda su questo dispositivo.', 'Shows the "Total sales" box in the agenda on this device.')}</div>
              </div>
              <button onClick={() => setShowRevenue(!showRevenue)} style={{ position: 'relative', width: 42, height: 24, borderRadius: 99, cursor: 'pointer', border: 'none', background: showRevenue ? 'var(--clay)' : 'var(--hair)', transition: 'background 140ms', flexShrink: 0 }}>
                <span style={{ position: 'absolute', top: 2, left: showRevenue ? 20 : 2, width: 20, height: 20, borderRadius: 99, background: '#fff', transition: 'left 140ms', boxShadow: '0 1px 2px rgba(0,0,0,0.2)' }} />
              </button>
            </div>

            {!isOwner && (
              <div className="t-sm" style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '11px 13px', borderRadius: 12, background: 'var(--surface-2)', color: 'var(--ink-2)', marginBottom: 12 }}>
                <Icon name="lock" size={14} color="var(--muted)" style={{ flexShrink: 0, marginTop: 1 }} />
                <span>{t('Puoi assegnare solo i permessi che hai tu: gli altri restano bloccati, e i ruoli più ampi del tuo non si possono modificare. Chiedi al titolare.',
                  'You can only grant permissions you hold yourself: the others stay locked, and roles broader than yours cannot be edited. Ask the owner.')}</span>
              </div>
            )}

            {roles === null ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {[0, 1, 2].map((i) => <div key={i} className="skel" style={{ height: 62, borderRadius: 14 }} />)}
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {roles.map((r) => {
                  const open = openId === r.id;
                  const touchable = canTouchRole(r);
                  const d = drafts[r.id] || { name: r.name, scopes: r.scopes };
                  const dirty = d.name !== r.name || d.scopes.length !== r.scopes.length || d.scopes.some((s) => !r.scopes.includes(s));
                  return (
                    <div key={r.id} className="dk-card" style={{ boxShadow: 'none', border: '1px solid ' + (open ? 'var(--clay)' : 'var(--hair)'), overflow: 'hidden' }}>
                      <button className="dk-row" onClick={() => setOpenId(open ? null : r.id)} style={{ display: 'flex', alignItems: 'center', gap: 11, width: '100%', padding: '13px 15px', textAlign: 'left', cursor: 'pointer', border: 'none', background: 'transparent' }}>
                        <div style={{ width: 34, height: 34, borderRadius: 9, background: r.is_system ? 'var(--clay-tint)' : 'var(--surface-2)', display: 'grid', placeItems: 'center', flexShrink: 0 }}><Icon name={r.is_system ? 'sparkle' : 'user'} size={16} color={r.is_system ? 'var(--clay-ink)' : 'var(--muted)'} /></div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontWeight: 700, fontSize: 14 }}>
                            {r.name}
                            {r.is_system && <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--clay-ink)', background: 'var(--clay-tint)', padding: '1px 7px', borderRadius: 99, marginLeft: 7 }}>{t('di sistema', 'system')}</span>}
                          </div>
                          <div className="t-sm" style={{ color: 'var(--muted)' }}>{r.scopes.length}/{SCOPES.length} {t('permessi', 'permissions')}</div>
                        </div>
                        <Icon name="chevD" size={16} color="var(--muted-2)" style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 160ms', flexShrink: 0 }} />
                      </button>
                      {open && (
                        <div style={{ padding: '4px 15px 15px', borderTop: '1px solid var(--hair)' }}>
                          {r.is_system && <div className="t-sm" style={{ color: 'var(--muted)', display: 'flex', alignItems: 'center', gap: 6, padding: '10px 0 4px' }}><Icon name="lock" size={13} color="var(--muted)" />{t('Ruolo di sistema: permessi non modificabili.', 'System role: permissions cannot be changed.')}</div>}
                          {!r.is_system && !touchable && (
                            <div className="t-sm" style={{ color: 'var(--muted)', display: 'flex', alignItems: 'flex-start', gap: 6, padding: '10px 0 4px' }}>
                              <Icon name="lock" size={13} color="var(--muted)" style={{ flexShrink: 0, marginTop: 2 }} />
                              {t('Questo ruolo ha permessi che tu non hai: solo il titolare (o chi li possiede tutti) può modificarlo.',
                                'This role holds permissions you do not have: only the owner (or someone who holds them all) can edit it.')}
                            </div>
                          )}
                          {SCOPES.map((p) => {
                            const on = d.scopes.includes(p.id);
                            const grantable = canGrant(p.id);
                            const locked = r.is_system || !touchable || !grantable;
                            return (
                              <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 0', borderBottom: '1px solid var(--hair)' }}>
                                <span style={{ flex: 1, fontSize: 13.5, fontWeight: 500, color: on ? 'var(--ink)' : 'var(--muted)' }}>{p[lang] || p.it}</span>
                                {!r.is_system && touchable && !grantable && (
                                  <span className="t-sm" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: 'var(--muted-2)', whiteSpace: 'nowrap' }}
                                    title={t('Non hai questo permesso, quindi non puoi assegnarlo', 'You do not hold this permission, so you cannot grant it')}>
                                    <Icon name="lock" size={12} color="var(--muted-2)" />{t('non tuo', 'not yours')}
                                  </span>
                                )}
                                <button onClick={() => !locked && toggleScope(r.id, p.id)} disabled={locked} style={{ width: 40, height: 23, borderRadius: 99, border: 'none', cursor: locked ? 'default' : 'pointer', background: on ? 'var(--clay)' : 'var(--hair)', opacity: locked ? 0.5 : 1, position: 'relative', transition: 'background 160ms', flexShrink: 0 }}>
                                  <span style={{ position: 'absolute', top: 2, left: on ? 19 : 2, width: 19, height: 19, borderRadius: 99, background: '#fff', transition: 'left 160ms' }} />
                                </button>
                              </div>
                            );
                          })}
                          {!r.is_system && touchable && (
                            <React.Fragment>
                              <div style={{ display: 'flex', gap: 8, marginTop: 12, alignItems: 'center' }}>
                                <input value={d.name} onChange={(e) => setDrafts((ds) => ({ ...ds, [r.id]: { ...ds[r.id], name: e.target.value } }))} placeholder={t('Nome ruolo', 'Role name')} style={{ ...inputCss, flex: 1, fontSize: 13, padding: '8px 11px' }} />
                                <button className="dk-btn dk-btn--clay" disabled={!dirty || !d.name.trim()} style={{ height: 38, fontSize: 13, opacity: dirty && d.name.trim() ? 1 : 0.5 }} onClick={() => saveRole(r)}><Icon name="check" size={15} color="#fff" />{t('Salva', 'Save')}</button>
                              </div>
                              <button onClick={() => askDelete(r)} style={{ marginTop: 10, display: 'inline-flex', alignItems: 'center', gap: 6, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--danger)', fontSize: 12.5, fontWeight: 700, padding: 0 }}>
                                <Icon name="x" size={13} color="var(--danger)" />{t('Elimina ruolo', 'Delete role')}
                              </button>
                            </React.Fragment>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
            <button className="dk-btn dk-btn--ghost" style={{ width: '100%', borderStyle: 'dashed', marginTop: 12 }} onClick={addRole}><Icon name="plus" size={16} />{t('Crea un nuovo ruolo', 'Create a new role')}</button>
          </React.Fragment>
        )}
      </div>
      <DkConfirm
        open={!!confirmDel}
        busy={deleting}
        confirmDisabled={confirmDel?.members === null}
        onClose={() => setConfirmDel(null)}
        onConfirm={delRole}
        title={t('Eliminare il ruolo?', 'Delete the role?')}
        message={t(`«${confirmDel?.role?.name || ''}» verrà eliminato.`, `“${confirmDel?.role?.name || ''}” will be deleted.`)}
        detail={delDetail()}
        confirmLabel={t('Elimina ruolo', 'Delete role')}
        cancelLabel={t('Annulla', 'Cancel')}
      />
    </DkDrawer>
  );
}
