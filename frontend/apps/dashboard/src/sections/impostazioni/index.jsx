// index.jsx — Impostazioni home: grouped link rows opening sub-pages/drawers
// (port of DkSettings). Sub-pages: bookings (BookingsOptimPage), log
// (ActivityLogPage), sedi (LocationsPage). Drawers: brand, team, roles.
// Categories open the global 'catsmgr' modal. Consumes deepLink 'log-today'.
// Commissioni & Notifiche have no API backing → informational rows (fase 2 / Yourang).
import React, { useEffect, useState } from 'react';
import { Icon, api } from '@youty/shared';
import { useDash } from '../../ctx.jsx';
import BookingsOptimPage from './BookingsOptimPage.jsx';
import ActivityLogPage from './ActivityLogPage.jsx';
import LocationsPage from './LocationsPage.jsx';
import PaymentsPage from './PaymentsPage.jsx';
import BrandDrawer from './BrandDrawer.jsx';
import TeamDrawer from './TeamDrawer.jsx';
import RolesDrawer from './RolesDrawer.jsx';

/* grouped link-style rows — module scope: stable identity across re-renders */
const Group = ({ title, children }) => (
  <div style={{ marginBottom: 24 }}>
    <div className="t-meta" style={{ marginBottom: 10 }}>{title}</div>
    <div className="dk-card" style={{ padding: 6 }}>{children}</div>
  </div>
);

const Row = ({ icon, label, sub, value, onClick, first, locked, tag }) => (
  <div className="dk-row" onClick={onClick} style={{ display: 'flex', alignItems: 'center', gap: 13, padding: '14px 16px', borderTop: first ? 'none' : '1px solid var(--hair)', borderRadius: 10, cursor: onClick ? 'pointer' : 'default', opacity: locked ? 0.6 : 1 }}>
    <Icon name={locked ? 'lock' : icon} size={19} color="var(--muted)" />
    <div style={{ flex: 1, minWidth: 0 }}>
      <div style={{ fontWeight: 600, fontSize: 14.5, display: 'flex', alignItems: 'center', gap: 8 }}>
        {label}
        {tag && <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--clay-ink)', background: 'var(--clay-tint)', padding: '1px 8px', borderRadius: 99 }}>{tag}</span>}
      </div>
      {sub && <div className="t-sm" style={{ color: 'var(--muted)' }}>{sub}</div>}
    </div>
    {value && <span className="t-sm" style={{ color: 'var(--muted-2)', maxWidth: '42%', textAlign: 'right', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{value}</span>}
    {onClick && <Icon name="chevR" size={15} color="var(--faint)" />}
  </div>
);

export default function ImpostazioniSection() {
  const { t, lang, setLang, session, hasScope, salon, locations, openModal, fireToast, deepLink, setDeepLink,
    yourang, yourangState, reloadYourang } = useDash();
  const isOwner = !!session?.is_owner;
  const canTeam = hasScope('team');
  const canLog = hasScope('activity_log');

  const [page, setPage] = useState(null);           // 'bookings' | 'log' | 'sedi'
  const [logPeriod, setLogPeriod] = useState('all');
  const [brandOpen, setBrandOpen] = useState(false);
  const [teamOpen, setTeamOpen] = useState(false);
  const [rolesOpen, setRolesOpen] = useState(false);
  // Lo stato Yourang vive nel ctx (serve a tutte le sezioni per il gate): qui lo
  // si legge e si chiede solo un refresh dopo l'handshake OAuth.

  // deep link from agenda cash-up → activity log filtered to today
  useEffect(() => {
    if (deepLink === 'log-today') {
      setLogPeriod('today');
      setPage('log');
      setDeepLink(null);
    }
  }, [deepLink, setDeepLink]);

  // Stato Stripe solo per l'etichetta della riga: il dettaglio sta in PaymentsPage.
  const [stripeReady, setStripeReady] = useState(null);
  useEffect(() => {
    if (!isOwner) return;
    api.get('/api/integrations/stripe/status')
      .then((s) => setStripeReady(!!s.can_charge))
      .catch(() => setStripeReady(false));
  }, [isOwner, page]);

  // Handshake dal popup OAuth → refresh dello stato nel ctx.
  useEffect(() => {
    if (!isOwner) return undefined;
    const onMsg = (e) => {
      if (e.origin !== window.location.origin || e.data?.type !== 'yourang-oauth') return;
      if (e.data.ok) { fireToast({ msg: t('Yourang collegato', 'Yourang connected'), icon: 'check' }); reloadYourang(); }
      else fireToast({ msg: t('Connessione a Yourang non riuscita', 'Yourang connection failed'), icon: 'info' });
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOwner]);

  // "Collega" è la via per chi HA già un accesso Yourang da collegare a youty.
  const connectYourang = () => {
    const popup = window.open('/oauth-popup/start?mode=connect', 'yourang-oauth', 'width=520,height=680');
    if (!popup) fireToast({ msg: t('Popup bloccato: consenti i popup e riprova', 'Popup blocked: allow popups and retry'), icon: 'info' });
  };

  // Chi NON ha ancora accesso alla piattaforma va alla richiesta informazioni:
  // attivazione del piano e setting li curano gli specialisti Yourang.
  const requestYourangInfo = () => {
    const url = yourang?.activation_url;
    if (url) window.open(url, '_blank', 'noopener,noreferrer');
    else fireToast({ msg: t('Destinazione Yourang non configurata', 'Yourang destination not configured'), icon: 'info' });
  };

  if (page === 'bookings') return <BookingsOptimPage onBack={() => setPage(null)} />;
  if (page === 'log') return <ActivityLogPage key={logPeriod} onBack={() => { setPage(null); setLogPeriod('all'); }} initialPeriod={logPeriod} />;
  if (page === 'sedi') return <LocationsPage onBack={() => setPage(null)} />;
  if (page === 'pagamenti') return <PaymentsPage onBack={() => setPage(null)} />;

  const defaultLoc = locations.find((l) => l.is_default) || locations[0];
  const langLabel = { it: 'Italiano', en: 'English' };
  const lockToast = () => fireToast({ msg: t('Funzione riservata: permesso mancante', 'Restricted: missing permission'), icon: 'lock' });

  return (
    <div className="dk-page" style={{ maxWidth: 760 }}>
      {/* brand teaser */}
      <div className="dk-card" style={{ padding: 22, marginBottom: 24, display: 'flex', alignItems: 'center', gap: 16, background: 'linear-gradient(120deg, var(--ink), #34291f)' }}>
        <div style={{ width: 46, height: 46, borderRadius: 13, background: 'rgba(255,255,255,0.12)', display: 'grid', placeItems: 'center' }}><Icon name="palette" size={22} color="var(--clay-tint)" /></div>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 700, fontSize: 16, color: '#fff' }}>{t('Brand & app cliente', 'Brand & client app')}</div>
          <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.6)' }}>{isOwner ? t('Personalizza colore e logo della superficie cliente', 'Customize colour and logo of the client surface') : t('Solo il titolare può modificare il brand', 'Only the owner can edit the brand')}</div>
        </div>
        <button className="dk-btn" style={{ background: '#fff', color: 'var(--ink)' }} onClick={() => setBrandOpen(true)}>
          {isOwner ? t('Personalizza', 'Customize') : t('Vedi', 'View')}
        </button>
      </div>

      {/* bookings & optimization — prominent entry */}
      <button className="dk-card" onClick={() => setPage('bookings')} style={{ width: '100%', textAlign: 'left', padding: 22, marginBottom: 24, display: 'flex', alignItems: 'center', gap: 18, background: 'linear-gradient(120deg, #2D1F5E, #4A3380)', border: 'none', cursor: 'pointer' }}>
        <div style={{ width: 50, height: 50, borderRadius: 14, background: 'rgba(255,255,255,0.15)', display: 'grid', placeItems: 'center', flexShrink: 0 }}><Icon name="sparkle" size={24} color="#fff" /></div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 17, color: '#fff' }}>{t('Prenotazioni & ottimizzazione', 'Bookings & optimization')}</div>
          <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.65)', marginTop: 3, lineHeight: 1.4 }}>{t('Riempimento agenda, recupero buchi, clienti flessibili, sconti last-minute e regole deposito anti no-show.', 'Agenda fill, gap recovery, flexible clients, last-minute discounts and anti no-show deposit rules.')}</div>
        </div>
        <Icon name="chevR" size={22} color="rgba(255,255,255,0.7)" style={{ flexShrink: 0 }} />
      </button>

      {/* SALONE */}
      <Group title={t('Salone', 'Salon')}>
        <Row first icon="mapPin" label={t('Sedi', 'Locations')}
          sub={t('Indirizzi e recapiti delle sedi', 'Location addresses and contacts')}
          value={locations.length + (defaultLoc ? ' · ' + defaultLoc.name : '')}
          onClick={() => setPage('sedi')} />
        <Row icon="globe" label={t('Lingua predefinita del salone', 'Salon default language')}
          sub={t('Usata per le clienti senza preferenza', 'Used for clients with no preference')}
          value={langLabel[salon?.default_lang] || salon?.default_lang || '—'} />
      </Group>

      {/* LINGUA — dashboard UI language */}
      <Group title={t('Lingua interfaccia', 'Interface language')}>
        {[['it', 'Italiano'], ['en', 'English']].map(([k, l], i) => (
          <div key={k} className="dk-row" onClick={() => setLang(k)} style={{ display: 'flex', alignItems: 'center', gap: 13, padding: '14px 16px', borderTop: i ? '1px solid var(--hair)' : 'none', borderRadius: 10, cursor: 'pointer' }}>
            <Icon name="globe" size={19} color={lang === k ? 'var(--clay-ink)' : 'var(--muted)'} />
            <span style={{ flex: 1, fontWeight: 600, fontSize: 14.5, color: lang === k ? 'var(--ink)' : 'var(--ink-2)' }}>{l}</span>
            {lang === k && <Icon name="check" size={18} color="var(--clay-ink)" stroke={2.4} />}
          </div>
        ))}
      </Group>

      {/* GESTIONE */}
      <Group title={t('Gestione', 'Management')}>
        <Row first icon="user" label={t('Commissioni vendita', 'Sales commission')} tag={t('Fase 2', 'Phase 2')}
          sub={t('Le percentuali per membro arriveranno con la fase 2: per ora le vendite sono attribuite all’operatrice senza calcolo commissioni.', 'Per-member percentages ship with phase 2: for now sales are attributed to the operator without commission math.')} />
        <Row icon="tag" label={t('Categorie', 'Categories')} sub={t('Clienti, servizi e magazzino', 'Clients, services and inventory')} onClick={() => openModal('catsmgr', { kind: 'clienti' })} />
      </Group>

      {/* PAGAMENTI — account Stripe del salone + policy caparra/no-show (titolare) */}
      {isOwner && (
        <Group title={t('Pagamenti', 'Payments')}>
          <Row first icon="wallet"
            label={t('Account Stripe e caparre', 'Stripe account & deposits')}
            sub={stripeReady === null
              ? t('Incassi, caparre e mancate presentazioni.', 'Payments, deposits and no-shows.')
              : stripeReady
                ? t('Incassi attivi: caparre e mancate presentazioni sul tuo conto Stripe.', 'Charges enabled: deposits and no-shows land in your Stripe account.')
                : t('Collega il tuo account Stripe per incassare caparre e mancate presentazioni.', 'Connect your Stripe account to collect deposits and no-show charges.')}
            value={stripeReady === null
              ? ''
              : stripeReady ? t('Attivo', 'Active') : t('Da collegare', 'Not connected')}
            onClick={() => setPage('pagamenti')} />
        </Group>
      )}

      {/* YOURANG — connessione OAuth + sync (titolare) */}
      {isOwner && (
        <Group title={t('Integrazione Yourang', 'Yourang integration')}>
          <Row first icon="globe"
            label={t('Collega Yourang', 'Connect Yourang')}
            tag="Yourang"
            sub={yourang?.connected
              ? t('Clienti, servizi e appuntamenti sincronizzati con Yourang.', 'Clients, services and appointments synced with Yourang.')
              : t('Hai già un accesso Yourang? Collegalo per sincronizzare clienti, servizi e prenotazioni.', 'Already have Yourang access? Connect it to sync clients, services and bookings.')}
            value={{
              active: t('Attivo', 'Active'),
              no_credit: t('Credito esaurito', 'Out of credit'),
              not_connected: t('Non connesso', 'Not connected'),
            }[yourangState]}
            onClick={connectYourang} />
          {/* Credito finito: si ricarica sulla piattaforma. */}
          {yourangState === 'no_credit' && (
            <Row icon="wallet"
              label={t('Ricarica il credito', 'Top up credit')}
              tag="Yourang"
              sub={t('Il credito è esaurito: gli invii restano in attesa finché non ricarichi su Yourang.', 'Credit has run out: sends stay queued until you top up on Yourang.')}
              value={t('Apri', 'Open')}
              onClick={() => {
                const url = yourang?.topup_url || yourang?.activation_url;
                if (url) window.open(url, '_blank', 'noopener,noreferrer');
                else fireToast({ msg: t('Destinazione Yourang non configurata', 'Yourang destination not configured'), icon: 'info' });
              }} />
          )}
          {/* Nessun accesso alla piattaforma: attivazione e setting con gli specialisti. */}
          {yourangState === 'not_connected' && (
            <Row icon="sparkle"
              label={t('Non hai ancora Yourang?', 'Don’t have Yourang yet?')}
              tag="Yourang"
              sub={t('Richiedi informazioni: gli specialisti curano l’attivazione del piano e la configurazione della piattaforma.', 'Request information: the specialists handle plan activation and platform setup.')}
              value={t('Richiedi', 'Request')}
              onClick={requestYourangInfo} />
          )}
        </Group>
      )}

      {/* NOTIFICHE */}
      <Group title={t('Notifiche & comunicazioni', 'Notifications & communications')}>
        <Row first icon="whatsapp" label={t('Notifiche WhatsApp e promemoria', 'WhatsApp notifications & reminders')} tag="Yourang"
          sub={t('Invii e promemoria sono gestiti da Yourang: configurali dalla piattaforma Yourang collegata.', 'Delivery and reminders are handled by Yourang: configure them from the connected Yourang platform.')} />
      </Group>

      {/* ACCOUNT & TEAM */}
      <Group title={t('Account & team', 'Account & team')}>
        <Row first icon="user" label={t('Membri del team', 'Team members')}
          sub={canTeam ? t('Ruoli, accessi e inviti', 'Roles, access and invites') : t('Richiede il permesso Team', 'Requires the Team permission')}
          locked={!canTeam}
          onClick={canTeam ? () => setTeamOpen(true) : lockToast} />
        <Row icon="settings" label={t('Ruoli e permessi', 'Roles & permissions')}
          sub={canTeam ? t('Definisci cosa può fare ogni ruolo', 'Define what each role can do') : t('Richiede il permesso Team', 'Requires the Team permission')}
          locked={!canTeam}
          value={canTeam ? t('Gestisci', 'Manage') : undefined}
          onClick={canTeam ? () => setRolesOpen(true) : lockToast} />
        <Row icon="clock" label={t('Registro attività', 'Activity log')}
          sub={canLog ? t('Ogni azione con data, ora e autore', 'Every action with date, time and author') : t('Richiede il permesso Registro attività', 'Requires the Activity log permission')}
          locked={!canLog}
          onClick={canLog ? () => { setLogPeriod('all'); setPage('log'); } : lockToast} />
      </Group>

      <div className="t-sm" style={{ textAlign: 'center', color: 'var(--muted-2)', marginTop: 8 }}>
        youty · v1.0 · {salon?.name || ''}
      </div>

      {brandOpen && <BrandDrawer onClose={() => setBrandOpen(false)} />}
      {teamOpen && <TeamDrawer onClose={() => setTeamOpen(false)} onRoles={() => { setTeamOpen(false); setRolesOpen(true); }} />}
      {rolesOpen && <RolesDrawer onClose={() => setRolesOpen(false)} />}
    </div>
  );
}
