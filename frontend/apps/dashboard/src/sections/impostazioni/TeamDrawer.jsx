// TeamDrawer.jsx — port of TeamManager on the real accounts API.
// Members: GET /api/auth/members, POST /members/{id}/role, DELETE /members/{id}.
// Invitations: GET/POST /api/auth/invitations — delivery is Yourang (phase 2),
// so the invite token is displayed with a copy button only.
// Requires scope 'team' (owner bypasses).
import React, { useCallback, useEffect, useState } from 'react';
import { Icon, Avatar, salonTzOpts, toastApiError } from '@youty/shared';
import DkDrawer from '../../ui/DkDrawer.jsx';
import DrawerHead from '../../ui/DrawerHead.jsx';
import DkConfirm from '../../ui/DkConfirm.jsx';
import { useDash } from '../../ctx.jsx';
import { inputCss, LockNote, CopyField } from './lib.jsx';
import { invitationsApi, membersApi, rolesApi } from '../../api/team.js';

const initialsOf = (name, email) => {
  const src = (name || '').trim() || (email || '');
  const parts = src.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return src.slice(0, 2).toUpperCase() || '?';
};

export default function TeamDrawer({ onClose, onRoles }) {
  const { t, lang, hasScope, session, fireToast } = useDash();
  const canTeam = hasScope('team');
  /* Un ruolo si assegna (o si invita) solo se non dà più di quanto si ha: il
   * server lo rifiuta con 403, e chi ha il solo «team» poteva altrimenti
   * promuovere se stessa o una collega a permessi che il titolare le aveva
   * negato. Qui i ruoli fuori portata si vedono spenti e spiegati, invece di
   * far comparire un errore dopo il clic. */
  const isOwner = !!session?.is_owner;
  const myScopes = session?.scopes || [];
  const canAssign = (role) => isOwner || (role?.scopes || []).every((x) => myScopes.includes(x));
  /* Né cambiare ruolo né rimuovere una collega il cui ruolo ATTUALE dà più di
   * quanto si ha: il server lo rifiuta (403), come già la rimozione. Prima il
   * menu restava attivo e «Nessun ruolo» toglieva alla Manager vendite,
   * magazzino e listino con un clic di chi aveva il solo «team» (15-02). */
  const canTouch = (m) => canAssign(m.role);
  const [members, setMembers] = useState(null);
  const [roles, setRoles] = useState([]);
  const [invitations, setInvitations] = useState(null);
  const [inviting, setInviting] = useState(false);
  const [inv, setInv] = useState({ email: '', role_id: null });
  const [sending, setSending] = useState(false);

  const load = useCallback(async () => {
    try {
      const [m, r, i] = await Promise.all([
        membersApi.list(),
        rolesApi.list(),
        invitationsApi.list(),
      ]);
      setMembers(m); setRoles(r); setInvitations(i);
      setInv((f) => ({ ...f, role_id: f.role_id ?? (r[0]?.id ?? null) }));
    } catch (err) { toastApiError(err, fireToast, t); setMembers([]); setInvitations([]); }
  }, [fireToast, t]);
  useEffect(() => { if (canTeam) load(); }, [canTeam, load]);

  const setRole = async (memberId, roleId) => {
    try {
      const upd = await membersApi.setRole(memberId, { role_id: roleId });
      setMembers((l) => l.map((m) => (m.id === memberId ? upd : m)));
      fireToast({ msg: t('Ruolo aggiornato', 'Role updated'), icon: 'check' });
    } catch (err) { toastApiError(err, fireToast, t); }
  };

  // Rimuovere una persona dal team le toglie l'accesso al gestionale: si chiede
  // prima, perché l'azione partiva al primo clic e non si annulla.
  const [confirmRemove, setConfirmRemove] = useState(null);
  const [removing, setRemoving] = useState(false);
  const removeMember = async () => {
    const m = confirmRemove;
    if (!m || removing) return;
    setRemoving(true);
    try {
      await membersApi.remove(m.id);
      setMembers((l) => l.filter((x) => x.id !== m.id));
      fireToast({ msg: t('Membro rimosso', 'Member removed'), icon: 'x' });
      setConfirmRemove(null);
    } catch (err) { toastApiError(err, fireToast, t); } // 400 if owner
    finally { setRemoving(false); }
  };

  const sendInvite = async () => {
    const email = inv.email.trim();
    if (!email || !inv.role_id || sending) return;
    setSending(true);
    try {
      const created = await invitationsApi.create({ email, role_id: inv.role_id });
      setInvitations((l) => [created, ...(l || [])]);
      setInviting(false);
      setInv({ email: '', role_id: roles[0]?.id ?? null });
      fireToast({ msg: t('Invito creato per ', 'Invite created for ') + email, icon: 'check' });
    } catch (err) { toastApiError(err, fireToast, t); }
    finally { setSending(false); }
  };

  const pending = (invitations || []).filter((i) => i.status === 'pending');

  return (
    <DkDrawer open onClose={onClose}>
      <DrawerHead variant="team" onClose={onClose} title={t('Membri del team', 'Team members')}
        sub={members ? members.length + ' ' + t('membri · ruolo e accesso', 'members · role and access') : t('Ruolo e accesso', 'Role and access')} />

      <div className="scroll" style={{ flex: 1, overflowY: 'auto', padding: '16px 22px' }}>
        {!canTeam ? (
          <LockNote t={t} msg={t('Ti serve il permesso "Team" per gestire i membri.', 'You need the "Team" permission to manage members.')} />
        ) : members === null ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
            {[0, 1, 2].map((i) => <div key={i} className="skel" style={{ height: 66, borderRadius: 14 }} />)}
          </div>
        ) : (
          <React.Fragment>
            {!isOwner && roles.some((r) => !canAssign(r)) && (
              <div className="t-sm" style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '11px 13px', borderRadius: 12, background: 'var(--surface-2)', color: 'var(--ink-2)', marginBottom: 12 }}>
                <Icon name="lock" size={14} color="var(--muted)" style={{ flexShrink: 0, marginTop: 1 }} />
                <span>{t('I ruoli che danno permessi che tu non hai risultano «non assegnabili»: nessuno può regalare più di quanto possiede. Per quelli, chiedi al titolare.',
                  'Roles granting permissions you do not hold show as “not assignable”: nobody can give away more than they have. For those, ask the owner.')}</span>
              </div>
            )}
            {/* members */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
              {members.map((m) => (
                <div key={m.id} className="dk-card" style={{ padding: 13, boxShadow: 'none', border: '1px solid var(--hair)', display: 'flex', alignItems: 'center', gap: 12 }}>
                  <Avatar initials={initialsOf(m.user.name, m.user.email)} size={40} color={m.is_owner ? 'var(--clay)' : 'var(--paper-2)'} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                      <span style={{ fontWeight: 700, fontSize: 14 }}>{m.user.name || m.user.email}</span>
                      {m.is_owner && <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--clay-ink)', background: 'var(--clay-tint)', padding: '1px 7px', borderRadius: 99 }}>{t('titolare', 'owner')}</span>}
                    </div>
                    <div className="t-sm" style={{ color: 'var(--muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{m.user.email}</div>
                  </div>
                  {m.is_owner ? (
                    <span className="t-sm" style={{ color: 'var(--muted-2)', fontWeight: 600, flexShrink: 0 }}>{t('Accesso totale', 'Full access')}</span>
                  ) : (
                    <React.Fragment>
                      <select value={m.role?.id ?? ''} disabled={!canTouch(m)} onChange={(e) => setRole(m.id, e.target.value ? Number(e.target.value) : null)}
                        title={canTouch(m) ? undefined : t('Il suo ruolo dà permessi che tu non hai: può cambiarlo solo il titolare (o chi li ha tutti).', 'Their role grants permissions you do not hold: only the owner (or someone holding them all) can change it.')}
                        style={{ border: '1px solid var(--hair)', borderRadius: 9, outline: 'none', fontSize: 13, fontWeight: 600, padding: '7px 10px', fontFamily: 'var(--sans)', background: 'var(--surface)', cursor: canTouch(m) ? 'pointer' : 'default', flexShrink: 0, color: 'var(--ink)', opacity: canTouch(m) ? 1 : 0.6 }}>
                        <option value="">{t('Nessun ruolo', 'No role')}</option>
                        {roles.map((r) => (
                          <option key={r.id} value={r.id} disabled={!canAssign(r) && m.role?.id !== r.id}>
                            {r.name}{canAssign(r) ? '' : ' · ' + t('non assegnabile', 'not assignable')}
                          </option>
                        ))}
                      </select>
                      {m.user.id !== session?.user?.id && (
                        <button className="dk-iconbtn" disabled={!canTouch(m)} title={canTouch(m) ? t('Rimuovi membro', 'Remove member') : t('Solo il titolare può rimuoverla', 'Only the owner can remove them')} onClick={() => canTouch(m) && setConfirmRemove(m)} style={{ width: 30, height: 30, borderRadius: 8, opacity: canTouch(m) ? 1 : 0.4 }}><Icon name="x" size={14} color="var(--danger)" /></button>
                      )}
                    </React.Fragment>
                  )}
                </div>
              ))}
            </div>

            {/* pending invitations */}
            {pending.length > 0 && (
              <React.Fragment>
                <div className="t-meta" style={{ margin: '18px 0 9px' }}>{t('Inviti in attesa', 'Pending invitations')}</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
                  {pending.map((i) => (
                    <div key={i.id} className="dk-card" style={{ padding: 13, boxShadow: 'none', border: '1px dashed var(--hair)' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 9 }}>
                        <div style={{ width: 34, height: 34, borderRadius: 9, background: 'var(--warn-tint)', display: 'grid', placeItems: 'center', flexShrink: 0 }}><Icon name="mail" size={15} color="var(--warn)" /></div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontWeight: 700, fontSize: 13.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{i.email}</div>
                          <div className="t-sm" style={{ color: 'var(--muted)' }}>
                            {/* giorno del salone, non del dispositivo (17-15, 15-22) */}
                            {(i.role?.name || '—')} · {t('scade', 'expires')} {new Date(i.expires_at).toLocaleDateString(lang === 'en' ? 'en-GB' : 'it-IT', salonTzOpts())}
                          </div>
                        </div>
                        <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--warn)', background: 'var(--warn-tint)', padding: '1px 7px', borderRadius: 99, flexShrink: 0 }}>{t('in attesa', 'pending')}</span>
                      </div>
                      {/* Il codice È l'account: arriva solo a chi potrebbe concedere
                          quel ruolo (10-01). Per gli altri il server manda null. */}
                      {i.token ? (
                        <React.Fragment>
                          <CopyField value={i.token} t={t} fireToast={fireToast} />
                          <div className="t-sm" style={{ color: 'var(--muted-2)', marginTop: 6 }}>{t('L’invio automatico arriva con Yourang (fase 2): per ora condividi il codice manualmente.', 'Automatic delivery ships with Yourang (phase 2): for now share the code manually.')}</div>
                        </React.Fragment>
                      ) : (
                        <div className="t-sm" style={{ display: 'flex', alignItems: 'center', gap: 7, color: 'var(--muted)' }}>
                          <Icon name="lock" size={13} color="var(--muted)" />
                          {t('Il codice di questo invito lo vede solo chi può assegnare il suo ruolo, per esempio il titolare.', 'Only someone who can grant its role (e.g. the owner) can see this invitation code.')}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </React.Fragment>
            )}

            {/* invite form */}
            {inviting ? (
              <div className="dk-card" style={{ padding: 15, border: '1px solid var(--clay)', boxShadow: 'none', marginTop: 12 }}>
                <div className="t-meta" style={{ marginBottom: 10 }}>{t('Invita un membro', 'Invite a member')}</div>
                <input value={inv.email} onChange={(e) => setInv((f) => ({ ...f, email: e.target.value }))} type="email" placeholder="email@salone.it" style={{ ...inputCss, width: '100%', boxSizing: 'border-box', marginBottom: 9 }} />
                <select value={inv.role_id ?? ''} onChange={(e) => setInv((f) => ({ ...f, role_id: Number(e.target.value) }))} style={{ ...inputCss, width: '100%', fontWeight: 600, cursor: 'pointer', marginBottom: 12 }}>
                  {roles.map((r) => (
                    <option key={r.id} value={r.id} disabled={!canAssign(r)}>
                      {r.name}{canAssign(r) ? '' : ' · ' + t('non assegnabile', 'not assignable')}
                    </option>
                  ))}
                </select>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="dk-btn dk-btn--ghost" style={{ flex: 1 }} onClick={() => setInviting(false)}>{t('Annulla', 'Cancel')}</button>
                  <button className="dk-btn dk-btn--clay" style={{ flex: 1 }} disabled={!inv.email.trim() || !inv.role_id || sending} onClick={sendInvite}><Icon name="check" size={16} color="#fff" />{t('Crea invito', 'Create invite')}</button>
                </div>
              </div>
            ) : (
              <button className="dk-btn dk-btn--ghost" style={{ width: '100%', borderStyle: 'dashed', marginTop: 12 }} onClick={() => setInviting(true)}><Icon name="plus" size={16} />{t('Invita un membro', 'Invite a member')}</button>
            )}

            {/* link to roles */}
            <button className="dk-row" onClick={onRoles} style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '13px 14px', borderRadius: 12, marginTop: 16, background: 'var(--surface-2)', textAlign: 'left', cursor: 'pointer', border: 'none' }}>
              <Icon name="settings" size={17} color="var(--muted)" />
              <div style={{ flex: 1 }}><div style={{ fontWeight: 600, fontSize: 13.5 }}>{t('Ruoli e permessi', 'Roles & permissions')}</div><div className="t-sm" style={{ color: 'var(--muted)' }}>{t('Definisci cosa può fare ogni ruolo', 'Define what each role can do')}</div></div>
              <Icon name="chevR" size={16} color="var(--muted-2)" />
            </button>
          </React.Fragment>
        )}
      </div>
      <DkConfirm
        open={!!confirmRemove}
        busy={removing}
        onClose={() => setConfirmRemove(null)}
        onConfirm={removeMember}
        title={t('Rimuovere dal team?', 'Remove from the team?')}
        message={t(
          `${confirmRemove?.user?.name || confirmRemove?.user?.email || ''} perderà l'accesso al gestionale.`,
          `${confirmRemove?.user?.name || confirmRemove?.user?.email || ''} will lose access to the app.`,
        )}
        detail={t('Gli appuntamenti e le vendite già registrate restano. Per riammetterla servirà un nuovo invito.',
          'Past appointments and sales stay. Re-admitting them needs a new invitation.')}
        confirmLabel={t('Rimuovi', 'Remove')}
        cancelLabel={t('Annulla', 'Cancel')}
      />
    </DkDrawer>
  );
}
