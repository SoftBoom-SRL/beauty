// InviteParts.jsx — i pezzi degli inviti al team che usano sia il pannello
// «Membri del team» (TeamDrawer) sia la card «Accesso al gestionale» della
// scheda Staff: il link da mandare, com'è andata la mail, che cosa permette
// un ruolo. Senza hook.
import { Icon, salonTzOpts } from '@youty/shared';
import { CopyField } from './lib.jsx';
import { SCOPES } from './RolesDrawer.jsx';
import { inviteText, mailtoLink, whatsappLink } from './invites.js';

const SMALL = { height: 32, padding: '0 11px', fontSize: 12.5, gap: 6 };

/** Che cosa permette un ruolo, in parole («Agenda e appuntamenti · Schede cliente»). */
export function roleSummary(role, lang) {
  const names = (role?.scopes || []).map((id) => SCOPES.find((s) => s.id === id)).filter(Boolean).map((s) => (lang === 'en' ? s.en : s.it));
  return names.join(' · ');
}

/** Il link da mandare: copia, WhatsApp, la propria mail. */
export function ShareLink({ inv, salonName, t, fireToast }) {
  const text = inviteText(salonName, inv.link, t);
  return (
    <div data-share>
      <CopyField value={inv.link} t={t} fireToast={fireToast} />
      <div style={{ display: 'flex', gap: 6, marginTop: 7, flexWrap: 'wrap' }}>
        <a className="dk-btn dk-btn--soft" style={SMALL} href={whatsappLink(text)} target="_blank" rel="noreferrer"><Icon name="whatsapp" size={13} />WhatsApp</a>
        <a className="dk-btn dk-btn--soft" style={SMALL} href={mailtoLink(inv.email, salonName, text, t)}><Icon name="mail" size={13} />{t('Dalla tua mail', 'From your email')}</a>
      </div>
    </div>
  );
}

/** Com'è andata la mail di un invito, in una riga: { ok, text }. */
export function deliveryLine(inv, t, lang) {
  const day = (iso) => new Date(iso).toLocaleDateString(lang === 'en' ? 'en-GB' : 'it-IT', salonTzOpts({ day: 'numeric', month: 'short' }));
  if (inv.sent_at) return { ok: true, text: t(`Mail inviata il ${day(inv.sent_at)}`, `Email sent on ${day(inv.sent_at)}`) };
  if (inv.send_error) return { ok: false, text: t('La mail non è partita: manda tu il link', 'The email did not go out: send the link yourself') };
  if (!inv.can_email) return { ok: false, text: t('Nessuna mail automatica: manda tu il link', 'No automatic email: send the link yourself') };
  return { ok: false, text: t('Mail non ancora inviata', 'Email not sent yet') };
}
