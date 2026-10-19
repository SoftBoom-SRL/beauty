// TeamDrawer.jsx — chi entra nel gestionale: membri (ruolo, scheda Staff
// collegata, titolarità) e inviti.
// Members: GET /api/auth/members, POST /members/{id}/role, DELETE /members/{id},
// POST /members/{id}/transfer-ownership (owner only); la scheda Staff si
// collega con PUT /api/staff/{id} { user_id }.
// Inviti (19/10, «è confusionario e non arrivano le mail»): prima un codice da
// copiare, nessuna mail e nessun posto dove usarlo. Ora l'invito è un LINK
// (/invito/<codice>): parte per mail se il server ha la posta configurata,
// altrimenti lo si manda da qui con WhatsApp, la propria mail o copiandolo.
// Si rimanda, si annulla, e può portare la scheda Staff da collegare.
// Requires scope 'team' (owner bypasses).
import React, { useCallback, useEffect, useState } from 'react';
import { Icon, Avatar, salonTzOpts, staffAuth, toastApiError } from '@youty/shared';
import DkDrawer from '../../ui/DkDrawer.jsx';
import DrawerHead from '../../ui/DrawerHead.jsx';
import DkConfirm from '../../ui/DkConfirm.jsx';
import { useDash } from '../../ctx.jsx';
import { inputCss, LockNote } from './lib.jsx';
import { ShareLink, deliveryLine, roleSummary } from './InviteParts.jsx';
import { linkableOperators, openInvites } from './invites.js';
import { invitationsApi, membersApi, rolesApi } from '../../api/team.js';
import { staffApi } from '../../api/staff.js';

const opName = (o) => `${o.first_name} ${o.last_name || ''}`.trim();
const SMALL = { height: 32, padding: '0 11px', fontSize: 12.5, gap: 6 };

const initialsOf = (name, email) => {
  const src = (name || '').trim() || (email || '');
  const parts = src.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return src.slice(0, 2).toUpperCase() || '?';
};

export default function TeamDrawer({ onClose, onRoles }) {
  const { t, lang, hasScope, session, fireToast, operators = [], reload } = useDash();
  const salonName = session?.salon?.name || '';
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
  const [inv, setInv] = useState({ email: '', role_id: null, operator_id: null });
  const [sending, setSending] = useState(false);
  const [created, setCreated] = useState(null);   // l'invito appena creato: com'è andata e il link
  const [busyInv, setBusyInv] = useState(null);   // id dell'invito in rimando / annullo

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

  // Chi attiva il salone per conto del cliente ne diventa titolare: qui lo
  // cede. Dopo, la sessione si rinnova per perdere subito i poteri da titolare.
  const [confirmTransfer, setConfirmTransfer] = useState(null);
  const [transferring, setTransferring] = useState(false);
  const transferOwnership = async () => {
    const m = confirmTransfer;
    if (!m || transferring) return;
    setTransferring(true);
    try {
      await membersApi.transferOwnership(m.id);
      // Niente ricarica della lista: se il ruolo nuovo non ha «team» la GET
      // risponderebbe 403 e il suo errore coprirebbe la conferma.
      setMembers((l) => l.map((x) => ({ ...x, is_owner: x.id === m.id })));
      setConfirmTransfer(null);
      fireToast({ msg: t('Titolarità ceduta', 'Ownership transferred'), icon: 'check' });
      await staffAuth.refresh();
    } catch (err) { toastApiError(err, fireToast, t); }
    finally { setTransferring(false); }
  };

  /* La scheda Staff di un membro: si libera quella di prima e si lega la
   * nuova (Operator.user è uno a uno). */
  const [linking, setLinking] = useState(null);
  const linkOperator = async (m, opId) => {
    const current = m.operator?.id ?? null;
    if (current === opId || linking) return;
    setLinking(m.id);
    try {
      if (current) await staffApi.update(current, { user_id: null });
      if (opId) await staffApi.update(opId, { user_id: m.user.id });
      const op = operators.find((o) => o.id === opId);
      setMembers((l) => l.map((x) => (x.id === m.id ? { ...x, operator: op ? { id: op.id, name: opName(op) } : null } : x)));
      reload?.operators?.().catch(() => {});
      fireToast({ msg: op ? t(`Collegato alla scheda di ${opName(op)}`, `Linked to ${opName(op)}'s profile`) : t('Scheda Staff scollegata', 'Staff profile unlinked'), icon: 'check' });
    } catch (err) { toastApiError(err, fireToast, t); } finally { setLinking(null); }
  };

  const sendInvite = async () => {
    const email = inv.email.trim();
    if (!email || !inv.role_id || sending) return;
    setSending(true);
    try {
      const made = await invitationsApi.create({ email, role_id: inv.role_id, operator_id: inv.operator_id || null });
      // l'invito di prima alla stessa email il server l'ha annullato
      setInvitations((l) => [made, ...(l || []).filter((x) => x.email !== made.email)]);
      setInviting(false);
      setCreated(made);
      setInv({ email: '', role_id: roles[0]?.id ?? null, operator_id: null });
    } catch (err) { toastApiError(err, fireToast, t); }
    finally { setSending(false); }
  };

  const resend = async (i) => {
    if (busyInv) return;
    setBusyInv(i.id);
    try {
      const upd = await invitationsApi.resend(i.id);
      setInvitations((l) => l.map((x) => (x.id === i.id ? upd : x)));
      fireToast(upd.email_sent
        ? { msg: t(`Mail rimandata a ${i.email}`, `Email sent again to ${i.email}`), icon: 'check' }
        : { msg: t('Invito rinnovato per 7 giorni: manda tu il link', 'Invitation renewed for 7 days: send the link yourself'), icon: 'info' });
    } catch (err) { toastApiError(err, fireToast, t); } finally { setBusyInv(null); }
  };
  const [confirmRevoke, setConfirmRevoke] = useState(null);
  const revoke = async () => {
    const i = confirmRevoke;
    if (!i || busyInv) return;
    setBusyInv(i.id);
    try {
      await invitationsApi.revoke(i.id);
      setInvitations((l) => l.filter((x) => x.id !== i.id));
      if (created?.id === i.id) setCreated(null);
      setConfirmRevoke(null);
      fireToast({ msg: t('Invito annullato', 'Invitation cancelled'), icon: 'x' });
    } catch (err) { toastApiError(err, fireToast, t); } finally { setBusyInv(null); }
  };

  const pending = openInvites(invitations).filter((i) => i.id !== created?.id);
  const roleOf = (id) => roles.find((r) => r.id === id);

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
            <div data-team-intro className="t-sm" style={{ color: 'var(--muted)', lineHeight: 1.5, marginBottom: 12 }}>
              {t('Chi entra nel gestionale, con la sua email. Il ruolo dice che cosa può fare; la scheda Staff collega l’accesso alla sua colonna in agenda.',
                'Who signs in to the app, with their own email. The role says what they can do; the Staff profile links the access to their calendar column.')}
            </div>
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
                <div key={m.id} data-member={m.id} className="dk-card" style={{ padding: 13, boxShadow: 'none', border: '1px solid var(--hair)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
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
                      {isOwner && (
                        <button className="dk-iconbtn" title={t('Cedi la titolarità', 'Transfer ownership')} onClick={() => setConfirmTransfer(m)} style={{ width: 30, height: 30, borderRadius: 8 }}><Icon name="star" size={14} color="var(--clay)" /></button>
                      )}
                      {m.user.id !== session?.user?.id && (
                        <button className="dk-iconbtn" disabled={!canTouch(m)} title={canTouch(m) ? t('Rimuovi membro', 'Remove member') : t('Solo il titolare può rimuoverla', 'Only the owner can remove them')} onClick={() => canTouch(m) && setConfirmRemove(m)} style={{ width: 30, height: 30, borderRadius: 8, opacity: canTouch(m) ? 1 : 0.4 }}><Icon name="x" size={14} color="var(--danger)" /></button>
                      )}
                    </React.Fragment>
                  )}
                </div>
                {/* la sua scheda Staff: lega l'accesso alla colonna in agenda */}
                <label data-member-operator style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 9, paddingTop: 9, borderTop: '1px solid var(--hair-2)' }}>
                  <Icon name="user" size={14} color="var(--muted)" />
                  <span className="t-sm" style={{ color: 'var(--muted)', fontWeight: 600, flexShrink: 0 }}>{t('Scheda Staff', 'Staff profile')}</span>
                  <select value={m.operator?.id ?? ''} disabled={linking === m.id} onChange={(e) => linkOperator(m, e.target.value ? Number(e.target.value) : null)}
                    style={{ flex: 1, minWidth: 0, border: '1px solid var(--hair)', borderRadius: 8, outline: 'none', fontSize: 12.5, fontWeight: 600, padding: '5px 8px', fontFamily: 'var(--sans)', background: 'var(--surface)', cursor: 'pointer', color: m.operator ? 'var(--ink)' : 'var(--muted)' }}>
                    <option value="">{t('Nessuna: non lavora in agenda', 'None: not in the calendar')}</option>
                    {linkableOperators(operators, m.user.id).map((o) => <option key={o.id} value={o.id}>{opName(o)}</option>)}
                    {m.operator && !operators.some((o) => o.id === m.operator.id) && <option value={m.operator.id}>{m.operator.name}</option>}
                  </select>
                </label>
                </div>
              ))}
            </div>

            {/* l'invito appena creato: se la mail è partita, e il link da mandare */}
            {created && (
              <div data-created className="dk-card" style={{ padding: 15, boxShadow: 'none', border: '1px solid ' + (created.email_sent ? 'var(--ok)' : 'var(--warn)'), marginTop: 14 }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 10 }}>
                  <Icon name={created.email_sent ? 'check' : 'info'} size={17} color={created.email_sent ? 'var(--ok)' : 'var(--warn)'} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 700, fontSize: 14 }}>
                      {created.email_sent ? t(`Mail inviata a ${created.email}`, `Email sent to ${created.email}`) : t(`Invito pronto per ${created.email}`, `Invitation ready for ${created.email}`)}
                    </div>
                    <div className="t-sm" style={{ color: 'var(--muted)', lineHeight: 1.45 }}>
                      {created.email_sent
                        ? t('Le arriva un link per scegliere la password ed entrare. Vale 7 giorni; puoi mandarlo anche da qui.', 'They get a link to choose a password and join. Valid for 7 days; you can also send it from here.')
                        : created.can_email
                          ? t('La mail non è partita: manda tu il link, con WhatsApp o dalla tua mail. Vale 7 giorni.', 'The email did not go out: send the link yourself, by WhatsApp or from your email. Valid for 7 days.')
                          : t('Il gestionale non ha ancora la posta configurata: manda tu il link, con WhatsApp o dalla tua mail. Vale 7 giorni.', 'Outgoing email is not set up yet: send the link yourself, by WhatsApp or from your email. Valid for 7 days.')}
                    </div>
                  </div>
                  <button className="dk-iconbtn" onClick={() => setCreated(null)} aria-label={t('Chiudi', 'Close')} style={{ width: 28, height: 28 }}><Icon name="x" size={13} /></button>
                </div>
                {created.link && <ShareLink inv={created} salonName={salonName} t={t} fireToast={fireToast} />}
              </div>
            )}

            {/* inviti in attesa (e scaduti, che si rimandano) */}
            {pending.length > 0 && (
              <React.Fragment>
                <div className="t-meta" style={{ margin: '18px 0 9px' }}>{t('Inviti in attesa', 'Pending invitations')}</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
                  {pending.map((i) => {
                    const line = deliveryLine(i, t, lang);
                    const mine = !!i.token;   // il link lo vede chi può concedere quel ruolo (10-01)
                    return (
                      <div key={i.id} data-invitation={i.id} className="dk-card" style={{ padding: 13, boxShadow: 'none', border: '1px dashed var(--hair)' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                          <div style={{ width: 34, height: 34, borderRadius: 9, background: i.expired ? 'var(--paper-2)' : 'var(--warn-tint)', display: 'grid', placeItems: 'center', flexShrink: 0 }}><Icon name="mail" size={15} color={i.expired ? 'var(--muted)' : 'var(--warn)'} /></div>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontWeight: 700, fontSize: 13.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{i.email}</div>
                            <div className="t-sm" style={{ color: 'var(--muted)' }}>
                              {/* giorno del salone, non del dispositivo (17-15, 15-22) */}
                              {(i.role?.name || '—')}{i.operator ? ` · ${t('scheda', 'profile')} ${i.operator.name}` : ''} · {i.expired ? t('scaduto', 'expired') : t('scade', 'expires')} {new Date(i.expires_at).toLocaleDateString(lang === 'en' ? 'en-GB' : 'it-IT', salonTzOpts())}
                            </div>
                          </div>
                          <span style={{ fontSize: 10, fontWeight: 700, color: i.expired ? 'var(--muted)' : 'var(--warn)', background: i.expired ? 'var(--paper-2)' : 'var(--warn-tint)', padding: '1px 7px', borderRadius: 99, flexShrink: 0 }}>{i.expired ? t('scaduto', 'expired') : t('in attesa', 'pending')}</span>
                        </div>
                        <div data-delivery={line.ok ? 'sent' : 'manual'} className="t-sm" style={{ display: 'flex', alignItems: 'center', gap: 6, color: line.ok ? 'var(--ok)' : 'var(--muted)', marginBottom: 8 }}>
                          <Icon name={line.ok ? 'check' : 'info'} size={13} color={line.ok ? 'var(--ok)' : 'var(--muted)'} />{line.text}
                        </div>
                        {mine ? (
                          <React.Fragment>
                            {!i.expired && i.link && <ShareLink inv={i} salonName={salonName} t={t} fireToast={fireToast} />}
                            <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                              <button data-resend className="dk-btn dk-btn--ghost" style={SMALL} disabled={busyInv === i.id} onClick={() => resend(i)}>
                                <Icon name="refresh" size={13} />{i.can_email ? t('Rimanda la mail', 'Send email again') : t('Rinnova 7 giorni', 'Renew 7 days')}
                              </button>
                              {!i.expired && (
                                <button data-revoke className="dk-btn dk-btn--ghost" style={{ ...SMALL, color: 'var(--danger)' }} disabled={busyInv === i.id} onClick={() => setConfirmRevoke(i)}>
                                  <Icon name="x" size={13} color="var(--danger)" />{t('Annulla invito', 'Cancel invitation')}
                                </button>
                              )}
                            </div>
                          </React.Fragment>
                        ) : (
                          <div className="t-sm" style={{ display: 'flex', alignItems: 'center', gap: 7, color: 'var(--muted)' }}>
                            <Icon name="lock" size={13} color="var(--muted)" />
                            {t('Il link di questo invito lo vede solo chi può assegnare il suo ruolo, per esempio il titolare.', 'Only someone who can grant its role (e.g. the owner) can see this invitation link.')}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </React.Fragment>
            )}

            {/* invita una persona */}
            {inviting ? (
              <div data-invite-form className="dk-card" style={{ padding: 15, border: '1px solid var(--clay)', boxShadow: 'none', marginTop: 12 }}>
                <div className="t-meta" style={{ marginBottom: 4 }}>{t('Invita una persona', 'Invite someone')}</div>
                <div className="t-sm" style={{ color: 'var(--muted)', marginBottom: 12, lineHeight: 1.45 }}>
                  {t('Le arriva un link per scegliere la password ed entrare con la sua email.', 'They get a link to choose a password and sign in with their email.')}
                </div>
                <div className="t-sm" style={{ color: 'var(--muted)', fontWeight: 600, marginBottom: 5 }}>{t('Email', 'Email')}</div>
                <input value={inv.email} onChange={(e) => setInv((f) => ({ ...f, email: e.target.value }))} type="email" placeholder="email@salone.it" style={{ ...inputCss, width: '100%', boxSizing: 'border-box', marginBottom: 10 }} />
                <div className="t-sm" style={{ color: 'var(--muted)', fontWeight: 600, marginBottom: 5 }}>{t('Ruolo: che cosa potrà fare', 'Role: what they can do')}</div>
                <select value={inv.role_id ?? ''} onChange={(e) => setInv((f) => ({ ...f, role_id: Number(e.target.value) }))} style={{ ...inputCss, width: '100%', fontWeight: 600, cursor: 'pointer', marginBottom: 5 }}>
                  {roles.map((r) => (
                    <option key={r.id} value={r.id} disabled={!canAssign(r)}>
                      {r.name}{canAssign(r) ? '' : ' · ' + t('non assegnabile', 'not assignable')}
                    </option>
                  ))}
                </select>
                <div data-role-summary className="t-sm" style={{ color: 'var(--muted-2)', fontSize: 11.5, lineHeight: 1.4, marginBottom: 10 }}>
                  {roleSummary(roleOf(inv.role_id), lang) || t('Nessun permesso: vede solo la sua agenda.', 'No permissions.')}
                </div>
                <div className="t-sm" style={{ color: 'var(--muted)', fontWeight: 600, marginBottom: 5 }}>{t('È un’operatrice dello Staff?', 'Is this a stylist on the Staff?')}</div>
                <select value={inv.operator_id ?? ''} onChange={(e) => setInv((f) => ({ ...f, operator_id: e.target.value ? Number(e.target.value) : null }))} style={{ ...inputCss, width: '100%', cursor: 'pointer', marginBottom: 5 }}>
                  <option value="">{t('No, non lavora in agenda', 'No, not in the calendar')}</option>
                  {linkableOperators(operators).map((o) => <option key={o.id} value={o.id}>{opName(o)}</option>)}
                </select>
                <div className="t-sm" style={{ color: 'var(--muted-2)', fontSize: 11.5, lineHeight: 1.4, marginBottom: 12 }}>
                  {t('Entrando si ritrova collegata alla sua scheda e alla sua colonna in agenda.', 'On joining they are linked to their profile and calendar column.')}
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="dk-btn dk-btn--ghost" style={{ flex: 1 }} onClick={() => setInviting(false)}>{t('Annulla', 'Cancel')}</button>
                  <button className="dk-btn dk-btn--clay" style={{ flex: 1 }} disabled={!inv.email.trim() || !inv.role_id || sending} onClick={sendInvite}><Icon name="send" size={15} color="#fff" />{sending ? t('Invio…', 'Sending…') : t('Invia invito', 'Send invitation')}</button>
                </div>
              </div>
            ) : (
              <button data-invite className="dk-btn dk-btn--ghost" style={{ width: '100%', borderStyle: 'dashed', marginTop: 12 }} onClick={() => { setCreated(null); setInviting(true); }}><Icon name="plus" size={16} />{t('Invita una persona', 'Invite someone')}</button>
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
      <DkConfirm
        open={!!confirmRevoke}
        busy={!!busyInv}
        onClose={() => setConfirmRevoke(null)}
        onConfirm={revoke}
        title={t('Annullare l’invito?', 'Cancel the invitation?')}
        message={t(`Il link mandato a ${confirmRevoke?.email || ''} non aprirà più niente.`, `The link sent to ${confirmRevoke?.email || ''} will stop working.`)}
        detail={t('Per invitarla di nuovo basta un invito nuovo.', 'To invite them again, just send a new invitation.')}
        confirmLabel={t('Annulla invito', 'Cancel invitation')}
        cancelLabel={t('Indietro', 'Back')}
      />
      <DkConfirm
        open={!!confirmTransfer}
        busy={transferring}
        onClose={() => setConfirmTransfer(null)}
        onConfirm={transferOwnership}
        title={t('Cedere la titolarità?', 'Transfer ownership?')}
        message={t(
          `${confirmTransfer?.user?.name || confirmTransfer?.user?.email || ''} diventerà titolare del salone, con accesso totale.`,
          `${confirmTransfer?.user?.name || confirmTransfer?.user?.email || ''} will become the salon owner, with full access.`,
        )}
        detail={t('Tu resti nel team come Manager. Per tornare titolare dovrà essere il nuovo titolare a cedertela.',
          'You stay on the team as Manager. To become owner again, they will have to transfer it back.')}
        confirmLabel={t('Cedi', 'Transfer')}
        cancelLabel={t('Annulla', 'Cancel')}
      />
    </DkDrawer>
  );
}
