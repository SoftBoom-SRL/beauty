// AccessCard.jsx — «Accesso al gestionale» nella scheda dell'operatrice:
// con quale account entra (il membro del team collegato, Operator.user), e
// se non ne ha uno, collegarne uno esistente o invitarla. Prima il
// collegamento esisteva solo nel database: nessuna schermata lo mostrava né
// lo cambiava (il titolare, 19/10). Solo con il permesso «team».
import { useCallback, useEffect, useState } from 'react';
import { Icon, toastApiError } from '@youty/shared';
import { useDash } from '../../ctx.jsx';
import { invitationsApi, membersApi, rolesApi } from '../../api/team.js';
import { staffApi } from '../../api/staff.js';
import { ShareLink, deliveryLine, roleSummary } from '../impostazioni/InviteParts.jsx';
import { openInvites } from '../impostazioni/invites.js';
import { inputCss } from './lib.js';

const SMALL = { height: 34, padding: '0 12px', fontSize: 13, gap: 6 };

/** `operator` = la scheda (id, nomi, user_id); `onLinked(userId)` dopo un collegamento. */
export default function AccessCard({ operator, onLinked = () => {} }) {
  const { t, lang, fireToast, session } = useDash();
  const salonName = session?.salon?.name || '';
  const [data, setData] = useState(null);     // { members, roles, invitations } | 'error'
  const [userId, setUserId] = useState(operator.user_id ?? null);
  const [mode, setMode] = useState(null);     // null | 'link' | 'invite'
  const [pick, setPick] = useState('');
  const [inv, setInv] = useState({ email: '', role_id: null });
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState(null);

  useEffect(() => { setUserId(operator.user_id ?? null); }, [operator.user_id]);
  const load = useCallback(() => Promise.all([membersApi.list(), rolesApi.list(), invitationsApi.list()])
    .then(([members, roles, invitations]) => {
      setData({ members, roles, invitations });
      // di partenza il ruolo «Operatrice», se c'è: è quello pensato per chi lavora in agenda
      setInv((f) => ({ ...f, role_id: f.role_id ?? (roles.find((r) => r.name === 'Operatrice') || roles[0])?.id ?? null }));
    })
    .catch(() => setData('error')), []);
  useEffect(() => { load(); }, [load]);

  const ready = data && data !== 'error';
  const member = ready && userId ? data.members.find((m) => m.user.id === userId) : null;
  const free = ready ? data.members.filter((m) => !m.operator || m.operator.id === operator.id) : [];
  const pending = ready ? openInvites(data.invitations).find((i) => i.operator?.id === operator.id && !i.expired) : null;

  const link = async (uid) => {
    setBusy(true);
    try {
      await staffApi.update(operator.id, { user_id: uid });
      setUserId(uid);
      setMode(null);
      onLinked(uid);
      fireToast({ msg: uid ? t('Accesso collegato', 'Access linked') : t('Accesso scollegato', 'Access unlinked'), icon: 'check' });
      load();
    } catch (err) { toastApiError(err, fireToast, t); } finally { setBusy(false); }
  };
  const invite = async () => {
    if (!inv.email.trim() || !inv.role_id || busy) return;
    setBusy(true);
    try {
      const made = await invitationsApi.create({ email: inv.email.trim(), role_id: inv.role_id, operator_id: operator.id });
      setCreated(made);
      setMode(null);
      load();
    } catch (err) { toastApiError(err, fireToast, t); } finally { setBusy(false); }
  };
  const resend = async (i) => {
    setBusy(true);
    try {
      const upd = await invitationsApi.resend(i.id);
      fireToast(upd.email_sent ? { msg: t(`Mail rimandata a ${i.email}`, `Email sent again to ${i.email}`), icon: 'check' } : { msg: t('Invito rinnovato per 7 giorni: manda tu il link', 'Invitation renewed for 7 days: send the link yourself'), icon: 'info' });
      load();
    } catch (err) { toastApiError(err, fireToast, t); } finally { setBusy(false); }
  };

  const name = `${operator.first_name} ${operator.last_name || ''}`.trim();
  const shown = created || pending;
  return (
    <div className="dk-card" data-access style={{ padding: 20, gridColumn: '1 / -1' }}>
      <div className="t-meta" style={{ marginBottom: 6 }}>{t('Accesso al gestionale', 'App access')}</div>
      <div className="t-sm" style={{ color: 'var(--muted)', marginBottom: 14, lineHeight: 1.5 }}>
        {t(`Con quale account ${name} entra nel gestionale. Collegato, l’accesso è legato alla sua colonna in agenda.`, `Which account ${name} signs in with. Once linked, the access belongs to their calendar column.`)}
      </div>
      {data === null && <div className="skel" style={{ height: 52, borderRadius: 12 }} />}
      {data === 'error' && <div className="t-sm" style={{ color: 'var(--muted)' }}>{t('Non riesco a leggere il team ora: riprova fra poco.', 'Cannot read the team right now: try again shortly.')}</div>}
      {ready && member && (
        <div data-linked style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px', borderRadius: 12, background: 'var(--surface-2)' }}>
          <Icon name="check" size={16} color="var(--ok)" />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 700, fontSize: 14 }}>{member.user.name || member.user.email}</div>
            <div className="t-sm" style={{ color: 'var(--muted)' }}>
              {member.user.email} · {member.is_owner ? t('titolare', 'owner') : (member.role?.name || t('nessun ruolo', 'no role'))}
            </div>
          </div>
          <button data-unlink className="dk-btn dk-btn--ghost" style={SMALL} disabled={busy} onClick={() => link(null)}>{t('Scollega', 'Unlink')}</button>
        </div>
      )}
      {ready && !member && shown && (
        <div data-pending style={{ padding: '10px 12px', borderRadius: 12, border: '1px dashed var(--hair)' }}>
          <div style={{ fontWeight: 700, fontSize: 13.5, marginBottom: 2 }}>{t(`Invito in attesa: ${shown.email}`, `Pending invitation: ${shown.email}`)}</div>
          <div className="t-sm" style={{ color: deliveryLine(shown, t, lang).ok ? 'var(--ok)' : 'var(--muted)', marginBottom: 8 }}>{deliveryLine(shown, t, lang).text}</div>
          {shown.link && <ShareLink inv={shown} salonName={salonName} t={t} fireToast={fireToast} />}
          {shown.token && (
            <button className="dk-btn dk-btn--ghost" style={{ ...SMALL, marginTop: 8 }} disabled={busy} onClick={() => resend(shown)}>
              <Icon name="refresh" size={13} />{shown.can_email ? t('Rimanda la mail', 'Send email again') : t('Rinnova 7 giorni', 'Renew 7 days')}
            </button>
          )}
        </div>
      )}
      {ready && !member && !shown && mode === null && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button data-mode-invite className="dk-btn dk-btn--soft" style={SMALL} onClick={() => setMode('invite')}><Icon name="send" size={14} />{t('Invitala ad accedere', 'Invite to sign in')}</button>
          {free.length > 0 && (
            <button data-mode-link className="dk-btn dk-btn--ghost" style={SMALL} onClick={() => setMode('link')}><Icon name="link" size={14} />{t('Collega un accesso esistente', 'Link an existing access')}</button>
          )}
          <span className="t-sm" style={{ color: 'var(--muted-2)', alignSelf: 'center' }}>{t('Senza accesso lavora lo stesso in agenda: entra chi la gestisce.', 'Without access she still works in the calendar: whoever manages it signs in.')}</span>
        </div>
      )}
      {ready && !member && !shown && mode === 'link' && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <select value={pick} onChange={(e) => setPick(e.target.value)} style={{ ...inputCss, flex: 1, minWidth: 220, cursor: 'pointer' }}>
            <option value="">{t('Scegli un membro del team…', 'Choose a team member…')}</option>
            {free.map((m) => <option key={m.id} value={m.user.id}>{(m.user.name || m.user.email) + ' · ' + m.user.email}</option>)}
          </select>
          <button className="dk-btn dk-btn--clay" style={SMALL} disabled={!pick || busy} onClick={() => link(Number(pick))}>{t('Collega', 'Link')}</button>
          <button className="dk-btn dk-btn--ghost" style={SMALL} onClick={() => setMode(null)}>{t('Annulla', 'Cancel')}</button>
        </div>
      )}
      {ready && !member && !shown && mode === 'invite' && (
        <div data-invite-form style={{ display: 'grid', gridTemplateColumns: '1fr 200px', gap: 10, alignItems: 'start' }}>
          <input type="email" value={inv.email} onChange={(e) => setInv((f) => ({ ...f, email: e.target.value }))} placeholder={t('la sua email', 'their email')} style={inputCss} />
          <select value={inv.role_id ?? ''} onChange={(e) => setInv((f) => ({ ...f, role_id: Number(e.target.value) }))} style={{ ...inputCss, cursor: 'pointer', fontWeight: 600 }}>
            {data.roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
          <div className="t-sm" style={{ gridColumn: '1 / -1', color: 'var(--muted-2)', fontSize: 11.5 }}>
            {t('Potrà: ', 'Can: ')}{roleSummary(data.roles.find((r) => r.id === inv.role_id), lang) || '—'}
          </div>
          <div style={{ gridColumn: '1 / -1', display: 'flex', gap: 8 }}>
            <button className="dk-btn dk-btn--clay" style={SMALL} disabled={!inv.email.trim() || !inv.role_id || busy} onClick={invite}><Icon name="send" size={14} color="#fff" />{t('Invia invito', 'Send invitation')}</button>
            <button className="dk-btn dk-btn--ghost" style={SMALL} onClick={() => setMode(null)}>{t('Annulla', 'Cancel')}</button>
          </div>
        </div>
      )}
    </div>
  );
}
