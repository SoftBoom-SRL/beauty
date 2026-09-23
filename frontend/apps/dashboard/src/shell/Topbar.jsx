// Topbar.jsx — real date, section title, client search, notifications, pulsante
// «Prenota», avatar.
//
// Il pulsante di creazione è UNO in tutta l'app: in agenda ce n'erano due (questo
// e un «+ Prenota» nella barra della sezione) e facevano la stessa cosa. La parte
// larga prenota subito — un clic, non un menu da aprire — e la freccetta tiene le
// creazioni meno frequenti. In agenda il giorno proposto è quello che si sta
// guardando (ctx.agendaDate), non oggi.
import React, { useEffect, useRef, useState } from 'react';
import { Avatar, EmptyState, Icon, fmtDateIt, salonTzOpts } from '@youty/shared';
import { useDash } from '../ctx.jsx';

const TITLES = {
  agenda: ['Agenda', 'Agenda'],
  pos: ['Punto Vendita', 'Point of Sale'],
  clienti: ['Clienti', 'Clients'],
  insight: ['Analisi dati', 'Insights'],
  automazioni: ['Automazioni', 'Automations'],
  servizi: ['Servizi', 'Services'],
  magazzino: ['Magazzino', 'Inventory'],
  fedelta: ['Promozioni', 'Promotions'],
  comunicazioni: ['Comunicazioni', 'Communications'],
  staff: ['Staff', 'Staff'],
  impostazioni: ['Impostazioni', 'Settings'],
  profile: ['Profilo titolare', 'Owner profile'],
};

/* Chiude un popover al click fuori o con Esc. Non usa un fondo `position: fixed`:
 * dentro `.dk-top` il backdrop-filter lo confinerebbe alla sola barra e i click
 * sul resto della pagina non lo raggiungerebbero (il pannello restava aperto).
 * Esc qui chiude il popover e basta: `preventDefault()` dice alla pila dei
 * livelli (ui/layers.js) di non chiudere anche la finestra sotto. */
function useClickAway(ref, open, onClose) {
  useEffect(() => {
    if (!open) return;
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) onClose(); };
    const onKey = (e) => { if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); onClose(); } };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('pointerdown', onDown, true); document.removeEventListener('keydown', onKey); };
  }, [ref, open, onClose]);
}

export default function Topbar() {
  const { t, lang, tab, setTab, search, setSearch, openModal, session, live, agendaDate } = useDash();
  /* In agenda si prenota sul giorno che si ha davanti; altrove il drawer decide
   * da sé (oggi). */
  const openBooking = () => openModal('newappt', { prefill: agendaDate ? { date: agendaDate } : {} });
  const [notifOpen, setNotifOpen] = useState(false);
  const [newMenu, setNewMenu] = useState(false);
  const notifRef = useRef(null);
  const newRef = useRef(null);
  useClickAway(notifRef, notifOpen, () => setNotifOpen(false));
  useClickAway(newRef, newMenu, () => setNewMenu(false));

  const title = t(...(TITLES[tab] || TITLES.agenda));
  const initials = (session?.user?.name || '?')
    .split(/\s+/).map((w) => w.charAt(0)).slice(0, 2).join('').toUpperCase();

  return (
    <header className="dk-top">
      <div style={{ display: 'flex', flexDirection: 'column', flexShrink: 0 }}>
        <div className="t-meta" style={{ color: 'var(--clay-ink)', fontSize: 10.5, whiteSpace: 'nowrap' }}>{fmtDateIt(new Date())}</div>
        <div style={{ fontFamily: 'var(--serif)', fontSize: 24, fontWeight: 500, lineHeight: 1.05, marginTop: 3 }}>{title}</div>
      </div>
      <div style={{ flex: 1 }} />

      {/* shared search — jumps to Clienti */}
      <div className="dk-search">
        <Icon name="search" size={18} color="var(--muted-2)" />
        <input value={search}
          onChange={(e) => { setSearch(e.target.value); if (tab !== 'clienti') setTab('clienti'); }}
          placeholder={t('Cerca clienti…', 'Search clients…')} />
        {search && <button onClick={() => setSearch('')} style={{ cursor: 'pointer', display: 'grid', placeItems: 'center' }}><Icon name="x" size={15} color="var(--muted-2)" /></button>}
      </div>

      {/* notifications */}
      <div ref={notifRef} style={{ position: 'relative' }}>
        <button className="dk-iconbtn" aria-label={t('Notifiche', 'Notifications')} onClick={() => { setNotifOpen((o) => !o); live?.markRead?.(); }} style={{ position: 'relative', background: notifOpen ? 'var(--surface-2)' : 'var(--surface)', borderColor: notifOpen ? 'var(--line-strong)' : 'var(--hair)' }}>
          <Icon name="bell" size={19} />
        </button>
        {notifOpen && <NotifPanel onClose={() => setNotifOpen(false)} t={t} lang={lang} events={live?.events || []} myId={session?.user?.id} streamOk={!!live?.streamOk} />}
      </div>

      {/* creazione: azione diretta + freccetta per il resto */}
      <div ref={newRef} style={{ position: 'relative', display: 'flex', flexShrink: 0 }}>
        <button className="dk-btn dk-btn--clay" onClick={openBooking}
          title={t('Nuova prenotazione (N)', 'New booking (N)')}
          style={{ borderTopRightRadius: 0, borderBottomRightRadius: 0, paddingRight: 14 }}>
          <Icon name="plus" size={18} color="#fff" />{t('Prenota', 'Book')}
        </button>
        <button className="dk-btn dk-btn--clay" onClick={() => setNewMenu((o) => !o)} aria-expanded={newMenu}
          aria-label={t('Altre creazioni', 'More to create')}
          style={{ borderTopLeftRadius: 0, borderBottomLeftRadius: 0, padding: '0 10px', marginLeft: 1, boxShadow: 'inset 1px 0 0 rgba(255,255,255,0.28)' }}>
          <Icon name="chevD" size={15} color="#fff" style={{ transform: newMenu ? 'rotate(180deg)' : 'none', transition: 'transform 140ms' }} />
        </button>
        {newMenu && (
          <React.Fragment>
            <div className="dk-card" style={{ position: 'absolute', top: 'calc(100% + 8px)', right: 0, zIndex: 71, width: 280, padding: 6, boxShadow: 'var(--sh-pop)' }}>
              {[
                // il cliente creato da qui serve quasi sempre a prenotare:
                // salvata la scheda, si prosegue con l'appuntamento (afterSave)
                { icon: 'user', title: t('Nuovo cliente', 'New client'), sub: t('Si crea la scheda e si prosegue con la prenotazione', 'Create the profile, then continue with the booking'), act: () => openModal('newclient', { afterSave: 'book' }) },
              ].map((o, i) => (
                <button key={i} className="dk-row" onClick={() => { setNewMenu(false); o.act(); }} style={{ display: 'flex', alignItems: 'center', gap: 11, width: '100%', padding: '11px 11px', borderRadius: 10, textAlign: 'left' }}>
                  <div style={{ width: 36, height: 36, borderRadius: 10, background: 'var(--clay-tint)', display: 'grid', placeItems: 'center', flexShrink: 0 }}><Icon name={o.icon} size={18} color="var(--clay-ink)" /></div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 700, fontSize: 14 }}>{o.title}</div>
                    <div className="t-sm" style={{ color: 'var(--muted)' }}>{o.sub}</div>
                  </div>
                  <Icon name="chevR" size={15} color="var(--faint)" />
                </button>
              ))}
            </div>
          </React.Fragment>
        )}
      </div>

      <div style={{ width: 1, height: 30, background: 'var(--hair)' }} />
      <button onClick={() => setTab('profile')} title={t('Profilo', 'Profile')} style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: 0, borderRadius: 99 }}>
        <Avatar initials={initials} size={40} color="var(--clay-tint2)" ring />
      </button>
    </header>
  );
}

/* Feed live: le ultime azioni del team (registro attività), aggiornate dal
 * polling in ctx. Le proprie azioni sono attenuate; quelle altrui in evidenza. */
const FEED_ICON = {
  appointment: 'calendar', pause: 'clock', waitlist: 'clients', slot: 'calendar', visit: 'check',
  client: 'user', sale: 'wallet', service: 'scissors', package: 'gift', category: 'tag',
  operator: 'user', product: 'box', stock: 'box', order: 'send', supplier: 'box',
  coupon: 'coupon', giftcard: 'gift', loyalty: 'heart', communication: 'message', automation: 'bolt',
};
function relTime(iso, lang) {
  const diff = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (diff < 60) return lang === 'en' ? 'now' : 'adesso';
  if (diff < 3600) return `${Math.floor(diff / 60)} min`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} h`;
  // Il giorno del salone, non del dispositivo: un'azione delle 23:30 di Roma
  // vista da un portatile in UTC compariva col giorno dopo.
  return new Date(iso).toLocaleDateString(lang === 'en' ? 'en-GB' : 'it-IT', salonTzOpts({ day: 'numeric', month: 'short' }));
}
/* `streamOk` arriva come prop: il pannello non ha accesso al contesto `live`
 * della Topbar e leggerlo direttamente faceva crollare il rendering
 * (ReferenceError) alla prima apertura della campanella. */
function NotifPanel({ onClose, t, lang, events, myId, streamOk }) {
  return (
    <React.Fragment>
      <div className="dk-card" style={{ position: 'absolute', top: 'calc(100% + 8px)', right: 0, width: 360, padding: 8, boxShadow: 'var(--sh-pop)', zIndex: 61, maxHeight: 'min(520px, 70vh)', display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 10px 8px' }}>
          <span className="t-meta">{t('Attività del team', 'Team activity')}</span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, fontWeight: 700, color: streamOk ? 'var(--ok)' : 'var(--warn)' }} title={streamOk ? t('Connessione live attiva: le viste si aggiornano appena qualcuno modifica i dati', 'Live connection on: views refresh as soon as someone changes data') : t('Connessione live in riconnessione: aggiornamento ogni pochi secondi', 'Live connection reconnecting: refreshing every few seconds')}>
            <span style={{ width: 7, height: 7, borderRadius: 99, background: streamOk ? 'var(--ok)' : 'var(--warn)', boxShadow: `0 0 0 3px ${streamOk ? 'var(--ok-tint)' : 'var(--warn-tint)'}` }} />{streamOk ? t('Live', 'Live') : t('Riconnessione…', 'Reconnecting…')}
          </span>
        </div>
        {!events.length ? (
          <EmptyState icon="bell" title={t('Tutto tranquillo', 'All quiet')}
            sub={t('Qui compaiono in tempo reale le azioni delle altre postazioni: prenotazioni, spostamenti, incassi.', 'Actions from other workstations show up here live: bookings, moves, payments.')} />
        ) : (
          <div style={{ overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2, padding: '0 2px 4px' }}>
            {events.map((e) => {
              const mine = e.actor_id != null && e.actor_id === myId;
              const icon = FEED_ICON[String(e.type).split('.')[0]] || 'edit';
              const bad = /deleted|cancelled|no_show|removed/.test(e.type);
              return (
                <div key={e.id} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '9px 10px', borderRadius: 10, opacity: mine ? 0.6 : 1 }}>
                  <div style={{ width: 32, height: 32, borderRadius: 9, flexShrink: 0, display: 'grid', placeItems: 'center', background: bad ? 'var(--danger-tint)' : 'var(--clay-tint)' }}>
                    <Icon name={icon} size={15} color={bad ? 'var(--danger)' : 'var(--clay-ink)'} />
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13.5, fontWeight: 600, lineHeight: 1.3 }}>{e.summary}</div>
                    <div className="t-sm" style={{ color: 'var(--muted)', marginTop: 2 }}>
                      {e.actor_name ? (mine ? t('Tu', 'You') : e.actor_name) : t('Sistema', 'System')} · {relTime(e.created_at, lang)}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </React.Fragment>
  );
}
