// index.jsx — Impostazioni home: grouped link rows opening sub-pages/drawers
// (port of DkSettings). Sub-pages: bookings (BookingsOptimPage), log
// (ActivityLogPage), sedi (LocationsPage). Drawers: brand, team, roles.
// Categories open the global 'catsmgr' modal. Consumes deepLink 'log-today'.
// Commissioni & Notifiche have no API backing → informational rows (fase 2 / Yourang).
import { useEffect, useState } from 'react';
import { Icon, fmtDateIt, fmtTime } from '@youty/shared';
import { useDash } from '../../ctx.jsx';
import BookingsOptimPage from './BookingsOptimPage.jsx';
import ActivityLogPage from './ActivityLogPage.jsx';
import LocationsPage from './LocationsPage.jsx';
import BrandDrawer from './BrandDrawer.jsx';
import HoursDrawer, { dayLabel, todayRanges } from './HoursDrawer.jsx';
import TeamDrawer from './TeamDrawer.jsx';
import RolesDrawer from './RolesDrawer.jsx';
import PasswordDrawer from './PasswordDrawer.jsx';
import PaymentsDrawer from './PaymentsDrawer.jsx';
import ReasonsDrawer from './ReasonsDrawer.jsx';
import VoiceDrawer from './VoiceDrawer.jsx';
import AutomationKeyDrawer from './AutomationKeyDrawer.jsx';
import { CopyField } from './lib.jsx';
import { outboxApi } from '../../api/core.js';
import { automationKeyApi, voiceApi, yourangApi } from '../../api/integrations.js';
import { YOURANG_MSG, openYourangPopup, usePopupMessage } from '../../oauth/popup.js';

/* Host dell'app cliente: la dashboard non può dedurlo (è un altro dominio),
 * arriva come build variable. Se manca, la sezione dei link non compare invece
 * di mostrare URL rotti. */
const CLIENT_APP_URL = (import.meta.env.VITE_CLIENT_APP_URL || '').replace(/\/$/, '');

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
  const { t, lang, setLang, session, hasScope, salon, settings, locations, openModal, fireToast, deepLink, setDeepLink } = useDash();
  const isOwner = !!session?.is_owner;
  const canTeam = hasScope('team');
  const canLog = hasScope('activity_log');
  // Il titolare li ha tutti (hasScope): il permesso serve al tecnico che lo aiuta.
  const canYourang = hasScope('integrations');

  const [page, setPage] = useState(null);           // 'bookings' | 'log' | 'sedi'
  const [pwOpen, setPwOpen] = useState(false);
  const [logPeriod, setLogPeriod] = useState('all');
  const [brandOpen, setBrandOpen] = useState(false);
  const [hoursOpen, setHoursOpen] = useState(false);
  const [teamOpen, setTeamOpen] = useState(false);
  const [rolesOpen, setRolesOpen] = useState(false);
  const [payOpen, setPayOpen] = useState(false);
  const [reasonsOpen, setReasonsOpen] = useState(false);
  const [yourang, setYourang] = useState(null);   // { connected, last_sync_at, ... }
  const [voice, setVoice] = useState(null);       // assistente vocale: { active, created_at }
  const [voiceOpen, setVoiceOpen] = useState(false);
  const [autoKey, setAutoKey] = useState(null);   // chiave n8n/Make/Zapier: { active, created_at }
  const [autoKeyOpen, setAutoKeyOpen] = useState(false);
  const [outbox, setOutbox] = useState(null);     // stato consegna messaggi (OTP, conferme, promemoria)

  // deep link from agenda cash-up → activity log filtered to today
  useEffect(() => {
    if (deepLink === 'log-today') {
      setLogPeriod('today');
      setPage('log');
      setDeepLink(null);
    }
    if (deepLink === 'hours') { setHoursOpen(true); setDeepLink(null); }
    if (deepLink === 'payments') { setPayOpen(true); setDeepLink(null); }
    if (deepLink === 'reasons') { setReasonsOpen(true); setDeepLink(null); }
  }, [deepLink, setDeepLink]);

  // Stato del collegamento Yourang e risposta del popup OAuth. L'ascolto si
  // registra subito dopo le letture, con la loro dipendenza (canYourang), come
  // quando stavano nello stesso effetto, e in più `t`: registrato con il `t`
  // del momento, dopo il cambio di lingua (che si fa proprio in questa
  // pagina) il toast diceva «Yourang collegato» con la pagina in inglese
  // (voce 44). `t` cambia solo con la lingua.
  const loadYourang = () => yourangApi.status().then(setYourang).catch(() => setYourang(null));
  const loadVoice = () => voiceApi.status().then(setVoice).catch(() => setVoice(null));
  const loadAutoKey = () => automationKeyApi.status().then(setAutoKey).catch(() => setAutoKey(null));
  useEffect(() => {
    if (!canYourang) return;
    loadYourang();
    loadVoice();
    loadAutoKey();
  }, [canYourang]);
  useEffect(() => {
    if (!isOwner) return;
    outboxApi.status().then(setOutbox).catch(() => setOutbox(null));
  }, [isOwner]);
  usePopupMessage(YOURANG_MSG, (m) => {
    if (m.ok) { fireToast({ msg: t('Yourang collegato', 'Yourang connected'), icon: 'check' }); loadYourang(); }
    else fireToast({ msg: t('Connessione a Yourang non riuscita', 'Yourang connection failed') + (m.error ? ': ' + m.error : ''), icon: 'info' });
  }, [canYourang, t], canYourang);

  /* Collegato da poco: la prima sincronizzazione gira in background sul server.
   * Si ricontrolla ogni tanto finché non risulta fatta (o non compare un
   * errore), così la riga non resta su «in corso» fino a ricaricare la pagina. */
  const firstSyncRunning = !!yourang?.connected && !yourang?.last_sync_at && !yourang?.last_error;
  useEffect(() => {
    if (!canYourang || !firstSyncRunning) return undefined;
    const timer = setInterval(() => {
      yourangApi.status().then(setYourang).catch(() => {});
      loadVoice(); // l'assistente vocale si installa all'inizio dello stesso giro
    }, 15000);
    return () => clearInterval(timer);
  }, [canYourang, firstSyncRunning]);

  const connectYourang = () => {
    const popup = openYourangPopup('connect');
    if (!popup) fireToast({ msg: t('Popup bloccato: consenti i popup e riprova', 'Popup blocked: allow popups and retry'), icon: 'info' });
  };

  if (page === 'bookings') return <BookingsOptimPage onBack={() => setPage(null)} />;
  if (page === 'log') return <ActivityLogPage key={logPeriod} onBack={() => { setPage(null); setLogPeriod('all'); }} initialPeriod={logPeriod} />;
  if (page === 'sedi') return <LocationsPage onBack={() => setPage(null)} />;

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
        <Row first icon="clock" label={t('Orari di apertura', 'Opening hours')}
          sub={settings?.opening_hours_week && Object.keys(settings.opening_hours_week).length
            ? t('Oggi', 'Today') + ': ' + dayLabel(todayRanges(settings.opening_hours_week), t)
            : t('Non ancora impostati: compaiono in agenda e nell’app cliente', 'Not set yet: shown in the agenda and the client app')}
          value={settings?.opening_hours_week && Object.keys(settings.opening_hours_week).length ? t('Modifica', 'Edit') : t('Imposta', 'Set')}
          onClick={() => setHoursOpen(true)} />
        <Row icon="mapPin" label={t('Sedi', 'Locations')}
          sub={t('Indirizzi e recapiti delle sedi', 'Location addresses and contacts')}
          value={locations.length + (defaultLoc ? ' · ' + defaultLoc.name : '')}
          onClick={() => setPage('sedi')} />
        <Row icon="globe" label={t('Lingua predefinita del salone', 'Salon default language')}
          sub={t('Usata per le clienti senza preferenza', 'Used for clients with no preference')}
          value={langLabel[salon?.default_lang] || salon?.default_lang || '—'} />
      </Group>

      {/* LINK PUBBLICI — gli URL che il salone dà alle clienti */}
      {CLIENT_APP_URL && salon?.slug && (
        <Group title={t('Link pubblici', 'Public links')}>
          <div style={{ padding: '14px 16px' }}>
            <div style={{ fontWeight: 600, fontSize: 14.5, marginBottom: 3 }}>{t('App cliente', 'Client app')}</div>
            <div className="t-sm" style={{ color: 'var(--muted-2)', marginBottom: 9, lineHeight: 1.45 }}>
              {t('Mandalo alle clienti per prenotare, spostare o disdire.', 'Send it to clients to book, move or cancel.')}
            </div>
            <CopyField value={`${CLIENT_APP_URL}/${salon.slug}`} t={t} fireToast={fireToast} />
          </div>
          <div style={{ padding: '14px 16px', borderTop: '1px solid var(--hair)' }}>
            <div style={{ fontWeight: 600, fontSize: 14.5, marginBottom: 3 }}>{t('Modulo raccolta contatti', 'Contact form')}</div>
            <div className="t-sm" style={{ color: 'var(--muted-2)', marginBottom: 9, lineHeight: 1.45 }}>
              {t('Nome, telefono ed email. Chi lo compila entra nei tuoi contatti con l’etichetta “Da form”.',
                 'Name, phone and email. Whoever fills it in lands in your contacts tagged “Da form”.')}
            </div>
            <CopyField value={`${CLIENT_APP_URL}/${salon.slug}/hook`} t={t} fireToast={fireToast} />
            {/* L'informativa c'è sempre (link del salone o generata): manca solo chi è il titolare. */}
            {!settings?.privacy_policy_url && !settings?.privacy_holder && (
              <div className="t-sm" style={{ color: 'var(--danger)', marginTop: 9, lineHeight: 1.45 }}>
                {t('Completa i dati del titolare (ragione sociale, P.IVA, email) in Brand & app cliente: l’informativa privacy generata per ora mostra solo nome e indirizzo del salone.',
                   'Add the data controller details (company name, VAT no., email) under Brand & client app: the generated privacy policy currently shows only the salon name and address.')}
              </div>
            )}
          </div>
          <div style={{ padding: '14px 16px', borderTop: '1px solid var(--hair)' }}>
            <div style={{ fontWeight: 600, fontSize: 14.5, marginBottom: 3 }}>{t('Informativa privacy', 'Privacy policy')}</div>
            <div className="t-sm" style={{ color: 'var(--muted-2)', marginBottom: 9, lineHeight: 1.45 }}>
              {t('Già collegata all’app e al modulo. Copiala dove serve (sito, Instagram, WhatsApp).', 'Already linked from the app and the form. Copy it wherever you need it.')}
            </div>
            <CopyField value={settings?.privacy_policy_url || `${CLIENT_APP_URL}/${salon.slug}/privacy`} t={t} fireToast={fireToast} />
          </div>
        </Group>
      )}

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

      {/* PAGAMENTI & CAPARRE */}
      <Group title={t('Pagamenti & caparre', 'Payments & deposits')}>
        <Row first icon="wallet" label={t('Stripe del salone', 'Salon Stripe account')}
          sub={settings?.stripe_connected ? t('Collegato: caparre e addebiti finiscono sul tuo conto Stripe', 'Connected: deposits and charges land on your Stripe account')
            : settings?.stripe_state === 'pending' ? t('Stripe sta verificando l’account del salone', 'Stripe is reviewing the salon account')
            : settings?.stripe_state === 'incomplete' ? t('Mancano dei dati su Stripe: completa il collegamento', 'Some details are missing on Stripe: finish connecting')
            : t('Collega il tuo account per incassare le caparre online', 'Connect your account to collect deposits online')}
          value={settings?.stripe_connected ? t('Connesso', 'Connected')
            : settings?.stripe_state === 'pending' ? t('In verifica', 'In review')
            : settings?.stripe_state === 'incomplete' ? t('Da completare', 'To finish')
            : t('Non connesso', 'Not connected')}
          onClick={() => setPayOpen(true)} />
        <Row icon="clock" label={t('Caparra con scadenza', 'Deposit deadline')}
          sub={t('Libera lo slot se la caparra non viene pagata in tempo; la cliente resta fra i «da richiamare»', 'Frees the slot if the deposit is not paid in time; the client stays in “to call back”')}
          value={settings?.deposit_hold_minutes ? `${settings.deposit_hold_minutes} min` : t('Off', 'Off')}
          onClick={() => setPayOpen(true)} />
      </Group>

      {/* GESTIONE */}
      <Group title={t('Gestione', 'Management')}>
        <Row first icon="user" label={t('Commissioni vendita', 'Sales commission')} tag={t('Fase 2', 'Phase 2')}
          sub={t('Le percentuali per membro arriveranno con la fase 2: per ora le vendite sono attribuite all’operatrice senza calcolo commissioni.', 'Per-member percentages ship with phase 2: for now sales are attributed to the operator without commission math.')} />
        <Row icon="tag" label={t('Categorie', 'Categories')} sub={t('Clienti, servizi e magazzino', 'Clients, services and inventory')} onClick={() => openModal('catsmgr', { kind: 'clienti' })} />
        <Row icon="x" label={t('Motivazioni di annullamento e no-show', 'Cancellation & no-show reasons')}
          sub={t('Le opzioni proposte nel dettaglio appuntamento', 'The options offered in the appointment detail')}
          value={(settings?.cancel_reasons?.length || 0) + (settings?.no_show_reasons?.length || 0) ? t('Personalizzate', 'Custom') : t('Predefinite', 'Default')}
          onClick={() => setReasonsOpen(true)} />
      </Group>

      {/* YOURANG — connessione OAuth + sync (permesso «integrations»; il titolare ce l'ha).
          La riga diceva «sincronizzati» anche con la sincronizzazione ferma o
          parziale: l'errore restava solo a database (11-18, 17-13). Ora mostra
          l'ultimo errore (C9), la prima sincronizzazione ancora in corso e
          quando è avvenuta l'ultima. */}
      {canYourang && (
        <Group title={t('Integrazione Yourang', 'Yourang integration')}>
          <Row first icon="globe"
            label={t('Collega Yourang', 'Connect Yourang')}
            tag="Yourang"
            sub={yourang?.connected
              ? (yourang.last_sync_at
                ? t('Clienti, servizi e appuntamenti sincronizzati con Yourang', 'Clients, services and appointments synced with Yourang') + ' · ' + t('ultima sincronizzazione', 'last sync') + ' ' + fmtDateIt(yourang.last_sync_at, { weekday: false }) + ' ' + fmtTime(yourang.last_sync_at)
                : yourang.last_error
                  ? t('La prima sincronizzazione non è riuscita.', 'The first sync did not succeed.')
                  : t('Prima sincronizzazione in corso: clienti, servizi e appuntamenti arrivano da Yourang nei prossimi minuti.', 'First sync in progress: clients, services and appointments are arriving from Yourang in the next few minutes.'))
              : yourang?.status === 'error'
                ? t('Il collegamento con Yourang si è interrotto: ricollegalo.', 'The Yourang connection broke off: connect it again.')
                : t('Collega la piattaforma Yourang per sincronizzare clienti, servizi e prenotazioni.', 'Connect the Yourang platform to sync clients, services and bookings.')}
            value={yourang?.connected ? t('Connesso', 'Connected') : yourang?.status === 'error' ? t('Errore', 'Error') : t('Non connesso', 'Not connected')}
            onClick={connectYourang} />
          {!!yourang?.last_error && (
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 9, padding: '12px 16px', borderTop: '1px solid var(--hair)' }}>
              <Icon name="alert" size={16} color="var(--danger)" style={{ flexShrink: 0, marginTop: 1 }} />
              <div className="t-sm" style={{ color: 'var(--danger)', lineHeight: 1.5, minWidth: 0, overflowWrap: 'anywhere' }}>
                <b>{t('Ultimo errore di sincronizzazione', 'Last sync error')}:</b> {yourang.last_error}
              </div>
            </div>
          )}
          <Row icon="phone" label={t('Assistente vocale', 'Voice assistant')} tag="Yourang"
            sub={t('L’agente Yourang prenota gli appuntamenti al telefono', 'The Yourang agent books appointments over the phone')}
            value={voice?.active ? t('Attivo', 'Active') : t('Non attivo', 'Off')}
            onClick={() => setVoiceOpen(true)} />
          <Row icon="link" label={t('Automazioni esterne', 'External automations')} tag="n8n"
            sub={t('Chiave per n8n, Make o Zapier: leggono gli appuntamenti e mandano messaggi per trattamento', 'Key for n8n, Make or Zapier: they read appointments and send messages by treatment')}
            value={autoKey?.active ? t('Attiva', 'Active') : t('Non attiva', 'Off')}
            onClick={() => setAutoKeyOpen(true)} />
        </Group>
      )}

      {/* NOTIFICHE — con diagnostica: un OTP che «non arriva» si spiega qui */}
      <Group title={t('Notifiche & comunicazioni', 'Notifications & communications')}>
        <Row first icon="whatsapp" label={t('Notifiche WhatsApp e promemoria', 'WhatsApp notifications & reminders')} tag="Yourang"
          sub={t('Invii e promemoria sono gestiti da Yourang: configurali dalla piattaforma Yourang collegata.', 'Delivery and reminders are handled by Yourang: configure them from the connected Yourang platform.')} />
        {isOwner && outbox && (
          <div style={{ padding: '14px 16px', borderTop: '1px solid var(--hair)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
              <span style={{ width: 8, height: 8, borderRadius: 99, background: outbox.configured ? 'var(--ok)' : 'var(--warn)', flexShrink: 0 }} />
              <div style={{ fontWeight: 600, fontSize: 14.5, flex: 1 }}>{t('Consegna messaggi', 'Message delivery')}</div>
              <span className="t-sm" style={{ color: outbox.configured ? 'var(--ok)' : 'var(--warn)', fontWeight: 700 }}>
                {outbox.configured ? t('Attiva', 'Active') : t('Non configurata', 'Not configured')}
              </span>
            </div>
            <div className="t-sm" style={{ color: 'var(--muted)', lineHeight: 1.5 }}>
              {/* `scheduled` (campagne programmate, trattenuti) ed `expired` (scaduti
                  prima di partire) arrivano a parte: un server che non li manda
                  li lascia fuori dal testo. */}
              {outbox.configured
                ? t(`${outbox.sent_24h} messaggi consegnati nelle ultime 24 ore · ${outbox.pending} in coda${outbox.scheduled ? ` · ${outbox.scheduled} programmati per più tardi` : ''}${outbox.failed ? ` · ${outbox.failed} non riusciti` : ''}${outbox.expired ? ` · ${outbox.expired} scaduti prima dell’invio` : ''}.`,
                    `${outbox.sent_24h} messages delivered in the last 24 hours · ${outbox.pending} queued${outbox.scheduled ? ` · ${outbox.scheduled} scheduled for later` : ''}${outbox.failed ? ` · ${outbox.failed} failed` : ''}${outbox.expired ? ` · ${outbox.expired} expired before sending` : ''}.`)
                : t(`Codici OTP, conferme e promemoria restano in coda (${outbox.pending} in attesa) e non vengono inviati: manca l’indirizzo di consegna verso Yourang (YOURANG_API_URL) sul server. È questo il motivo se una cliente non riceve il codice per accedere all’app. Nel frattempo il codice si legge nel registro dell’outbox dall’amministrazione.`,
                    `OTP codes, confirmations and reminders stay queued (${outbox.pending} waiting) and are not sent: the delivery address to Yourang (YOURANG_API_URL) is missing on the server. That is why a client does not receive the code to sign in to the app. Meanwhile the code can be read in the outbox log from the admin.`)}
            </div>
            {outbox.pending > 0 && outbox.pending_types.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
                {outbox.pending_types.slice(0, 6).map((k) => (
                  <span key={k} style={{ fontSize: 11, fontWeight: 700, color: 'var(--ink-2)', background: 'var(--surface-2)', padding: '2px 8px', borderRadius: 99 }}>{k}</span>
                ))}
              </div>
            )}
          </div>
        )}
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
        <Row icon="settings" label={t('Cambia password', 'Change password')}
          sub={t('La tua password di accesso alla dashboard', 'Your dashboard sign-in password')}
          onClick={() => setPwOpen(true)} />
        <Row icon="clock" label={t('Registro attività', 'Activity log')}
          sub={canLog ? t('Ogni azione con data, ora e autore', 'Every action with date, time and author') : t('Richiede il permesso Registro attività', 'Requires the Activity log permission')}
          locked={!canLog}
          onClick={canLog ? () => { setLogPeriod('all'); setPage('log'); } : lockToast} />
      </Group>

      <div className="t-sm" style={{ textAlign: 'center', color: 'var(--muted-2)', marginTop: 8 }}>
        youty · v1.0 · {salon?.name || ''}
      </div>

      {brandOpen && <BrandDrawer onClose={() => setBrandOpen(false)} />}
      {hoursOpen && <HoursDrawer onClose={() => setHoursOpen(false)} />}
      {teamOpen && <TeamDrawer onClose={() => setTeamOpen(false)} onRoles={() => { setTeamOpen(false); setRolesOpen(true); }} />}
      {rolesOpen && <RolesDrawer onClose={() => setRolesOpen(false)} />}
      {pwOpen && <PasswordDrawer onClose={() => setPwOpen(false)} />}
      {payOpen && <PaymentsDrawer onClose={() => setPayOpen(false)} />}
      {reasonsOpen && <ReasonsDrawer onClose={() => setReasonsOpen(false)} />}
      {voiceOpen && <VoiceDrawer onClose={() => setVoiceOpen(false)} onChange={loadVoice} onReconnect={connectYourang} />}
      {autoKeyOpen && <AutomationKeyDrawer onClose={() => setAutoKeyOpen(false)} onChange={loadAutoKey} />}
    </div>
  );
}
