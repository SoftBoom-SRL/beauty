// invites.js — le parti pure degli inviti al team (TeamDrawer e la card
// «Accesso al gestionale» della scheda Staff): il messaggio da mandare a mano,
// i link di WhatsApp e della mail, lo stato di un invito. Quando il server
// non ha la posta configurata la mail non parte, e il titolare manda lui il
// link: prima c'era un codice da copiare e nessun posto dove usarlo.

/** Il testo che accompagna il link, mandato a mano. */
export function inviteText(salonName, link, t) {
  return t(
    `Ciao! Ti invito nel team di ${salonName}: apri questo link per entrare nel gestionale ${link}`,
    `Hi! I'm inviting you to the ${salonName} team: open this link to join ${link}`,
  );
}

/** WhatsApp con il testo pronto (si sceglie il contatto nell'app). */
export const whatsappLink = (text) => `https://wa.me/?text=${encodeURIComponent(text)}`;

/** La mail dal programma di posta di chi invita, già scritta. */
export function mailtoLink(email, salonName, text, t) {
  const subject = t(`Entra nel team di ${salonName}`, `Join the ${salonName} team`);
  return `mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(text)}`;
}

/** Gli inviti da mostrare: in attesa e scaduti (si possono rimandare), i più nuovi prima. */
export function openInvites(invitations, now = Date.now()) {
  return (invitations || [])
    .filter((i) => i.status === 'pending' || i.status === 'expired')
    .map((i) => ({ ...i, expired: i.status === 'expired' || new Date(i.expires_at).getTime() < now }));
}

/** Le schede Staff che un accesso può collegare: le libere e quella sua. */
export const linkableOperators = (operators, userId = null) => (operators || [])
  .filter((o) => o.active !== false && (o.user_id == null || o.user_id === userId));
