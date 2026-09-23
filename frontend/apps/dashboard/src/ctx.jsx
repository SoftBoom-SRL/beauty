// ctx.jsx — DashboardProvider: session, base catalogs from the API, navigation,
// modal/drawer/toast plumbing, live feed. Section agents CONSUME this via useDash().
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { api, API_URL, setSalonTz, staffAuth, useT, useToastHost } from '@youty/shared';
import { createBatcher, createSeen } from './liveSeen.js';

const DashCtx = createContext(null);
export const useDash = () => useContext(DashCtx);

/** Ricarica in silenzio quando arrivano eventi con questi prefissi (RegExp o
 *  stringa). `fn(events)` è chiamata al più una volta ogni 250 ms. Usalo nelle
 *  sezioni che mostrano dati condivisi: chi guarda lo schermo deve vedere lo
 *  stato reale, non quello di quando ha aperto la pagina. */
export function useLive(match, fn) {
  const { live } = useContext(DashCtx) || {};
  const subscribe = live?.subscribe;
  const fnRef = useRef(fn);
  fnRef.current = fn;
  // L'effetto dipende da `live.subscribe`, che è stabile, e non dall'oggetto
  // `live` (che cambia a ogni consegna): così si rimontava a ogni evento e il
  // timer ripartiva da zero, il debounce non univa mai due eventi vicini — tre
  // appuntamenti salvati altrove facevano tre ricaricamenti.
  // Il debounce accumula tutte le consegne della finestra (createBatcher): con
  // solo l'ultima, l'evento di una cliente seguito entro 250 ms da quello di
  // un'altra si perdeva, e la scheda della prima non si ricaricava.
  useEffect(() => {
    if (!subscribe) return undefined;
    const re = match instanceof RegExp ? match : new RegExp('^(' + [].concat(match).join('|').replace(/\./g, '\\.') + ')');
    const batcher = createBatcher(250, (hit) => { try { fnRef.current?.(hit); } catch { /* ignore */ } });
    const off = subscribe(({ events }) => batcher.push(events.filter((e) => re.test(e.type))));
    // Anche il timer va fermato allo smontaggio: cambiando sezione entro 250 ms
    // dall'ultimo evento la callback partiva su un componente già smontato.
    return () => { off(); batcher.cancel(); };
  }, [subscribe, String(match)]); // eslint-disable-line react-hooks/exhaustive-deps
}

const OP_FALLBACK_PALETTE = ['#C9B8F2', '#B3DDF7', '#F7C5D9', '#FBE7A1', '#C2E8CB', '#FBD7B5', '#BFE9E1', '#C3CDF7', '#D2E5BE'];

/* ---- dati sempre aggiornati ----------------------------------------------------
 * Polling leggero di GET /api/core/activity/feed (ogni LIVE_POLL_MS mentre la
 * scheda è visibile, subito al ritorno in primo piano). Funziona con gunicorn
 * sync in Docker senza connessioni persistenti. NON è un sistema di notifiche:
 * quando un'altra postazione cambia qualcosa, le viste che mostrano quel dato
 * si ricaricano in silenzio, così sullo schermo c'è sempre lo stato reale.
 * Le sezioni si agganciano con `useLive(prefissi, fn)`; i cataloghi base del
 * contesto (operatrici, servizi, categorie, impostazioni) si aggiornano qui. */
const LIVE_POLL_MS = 3000;          // polling di riserva quando lo stream non è connesso
const LIVE_POLL_STREAM_MS = 30000;  // con lo stream attivo: solo un controllo di coerenza
const LIVE_KEEP = 40;

function useLiveFeed(session) {
  const cursor = useRef(0);
  const booted = useRef(false);   // dopo il primo giro `after` viaggia sempre, anche se 0
  const listeners = useRef(new Set());
  const [events, setEvents] = useState([]);   // più recenti prima
  const [unread, setUnread] = useState(0);
  const [version, setVersion] = useState(0);  // cambia quando arrivano eventi di altri
  const [streamOk, setStreamOk] = useState(false);
  const streamOkRef = useRef(false);
  const seen = useRef(null);
  if (!seen.current) seen.current = createSeen();
  const myId = session?.user?.id;

  /* consegna comune (stream o polling): aggiorna cursore, lista, ascoltatori.
   * Stream e polling possono riconsegnare eventi già arrivati (finestra di
   * sicurezza del server, contratto C20): si scartano per id PRIMA di lista,
   * contatore e ascoltatori, altrimenti la campanella li mostrava due volte, i
   * non letti crescevano da soli e ogni vista si ricaricava due volte. */
  const deliver = useCallback((incoming, newCursor) => {
    cursor.current = Math.max(cursor.current, Number(newCursor) || 0);
    const list = seen.current.fresh(incoming);
    if (!list.length) return;
    setEvents((l) => [...list.slice().reverse(), ...l].slice(0, LIVE_KEEP));
    const foreign = list.filter((e) => e.actor_id !== myId);
    if (foreign.length) { setUnread((n) => n + foreign.length); setVersion((v) => v + 1); }
    listeners.current.forEach((fn) => { try { fn({ events: list, foreign }); } catch { /* listener error */ } });
  }, [myId]);

  /* ---- push dal server: Server-Sent Events ----
   * Una connessione HTTP aperta; il server spinge gli eventi appena scritti
   * (latenza ~1 s, qualunque worker li abbia prodotti). Se cade si riapre con
   * un ticket nuovo; nel frattempo il polling di riserva accelera. */
  useEffect(() => {
    let es = null, alive = true, retry = 3000, timer = null;
    // Un po' di scarto casuale sul ritentativo: quando il server rifiuta gli
    // stream perché ha raggiunto il tetto di connessioni, tutte le postazioni
    // riproverebbero nello stesso istante e lo riempirebbero di nuovo insieme.
    const wait = () => retry + Math.floor(Math.random() * 1500);
    const connect = async () => {
      if (!alive || document.visibilityState !== 'visible') { timer = setTimeout(connect, 2000); return; }
      try {
        const { ticket } = await api.post('/api/core/activity/stream-ticket');
        if (!alive) return;
        const url = `${API_URL}/api/core/activity/stream?ticket=${encodeURIComponent(ticket)}&after=${cursor.current || 0}`;
        es = new EventSource(url);
        es.addEventListener('ready', (ev) => {
          retry = 3000; streamOkRef.current = true; setStreamOk(true); booted.current = true;
          try { const d = JSON.parse(ev.data); cursor.current = Math.max(cursor.current, Number(d.cursor) || 0); } catch { /* ignore */ }
        });
        es.addEventListener('events', (ev) => {
          try { const d = JSON.parse(ev.data); deliver(d.events || [], d.cursor); } catch { /* ignore */ }
        });
        es.addEventListener('bye', () => { es.close(); es = null; if (alive) connect(); }); // riciclo lato server: riapro subito
        es.onerror = () => {
          streamOkRef.current = false; setStreamOk(false);
          es?.close(); es = null;
          if (alive) { timer = setTimeout(connect, wait()); retry = Math.min(retry * 2, 30000); }
        };
      } catch {
        streamOkRef.current = false; setStreamOk(false);
        if (alive) { timer = setTimeout(connect, wait()); retry = Math.min(retry * 2, 30000); }
      }
    };
    connect();
    return () => { alive = false; clearTimeout(timer); es?.close(); streamOkRef.current = false; };
  }, [myId, deliver]);

  const subscribe = useCallback((fn) => { listeners.current.add(fn); return () => listeners.current.delete(fn); }, []);
  const markRead = useCallback(() => setUnread(0), []);

  useEffect(() => {
    let alive = true, timer = null, inflight = false;
    const tick = async () => {
      if (!alive || inflight || document.visibilityState !== 'visible') return;
      inflight = true;
      try {
        const res = await api.get('/api/core/activity/feed', { params: booted.current ? { after: cursor.current } : {} });
        if (!alive) return;
        const bootstrap = !booted.current;
        booted.current = true;
        const list = bootstrap ? [] : (res.events || []);
        deliver(list, res.cursor);
      } catch { /* silenzioso: riprova al prossimo giro */ } finally { inflight = false; }
    };
    const loop = () => { timer = setTimeout(async () => { await tick(); if (alive) loop(); }, streamOkRef.current ? LIVE_POLL_STREAM_MS : LIVE_POLL_MS); };
    tick(); loop();
    const onVisible = () => { if (document.visibilityState === 'visible') tick(); };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => {
      alive = false; clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, [myId, deliver]); // eslint-disable-line react-hooks/exhaustive-deps

  return useMemo(() => ({ events, unread, markRead, subscribe, version, streamOk }), [events, unread, markRead, subscribe, version, streamOk]);
}

export function DashboardProvider({ children }) {
  const { t, lang, setLang } = useT();

  /* ---- session ---- */
  const [session, setSession] = useState(staffAuth.getSession());
  useEffect(() => staffAuth.subscribe(setSession), []);
  const hasScope = useCallback((scope) => staffAuth.hasScope(scope), [session]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ---- base data (loaded once, reloadable per collection) ---- */
  const [salon, setSalon] = useState(null);                       // SalonOut {id,name,slug,locations,settings,...}
  const [operators, setOperators] = useState([]);                 // [OperatorStatusOut]
  const [services, setServices] = useState([]);                   // [ServiceOut]
  const [serviceCategories, setServiceCategories] = useState([]); // [catalog CategoryOut]
  const [clientCategories, setClientCategories] = useState([]);   // [clients CategoryOut]
  const [booting, setBooting] = useState(true);
  const [bootError, setBootError] = useState(null);

  const reload = useMemo(() => ({
    // Il fuso arriva dal server: l'agenda deve mostrare l'orologio della
    // reception anche da una postazione impostata su un altro fuso.
    salon: () => api.get('/api/core/salon').then((s) => {
      setSalonTz(s?.settings?.timezone);
      setSalon(s);
    }),
    operators: () => api.get('/api/staff/').then(setOperators),
    services: () => api.get('/api/catalog/services').then(setServices),
    serviceCategories: () => api.get('/api/catalog/categories').then(setServiceCategories),
    clientCategories: () => api.get('/api/clients/categories').then(setClientCategories),
  }), []);

  const bootLoad = useCallback(async () => {
    setBooting(true);
    setBootError(null);
    try {
      await Promise.all([
        reload.salon(),
        reload.operators(),
        reload.serviceCategories(),
        reload.services(),
        reload.clientCategories(),
      ]);
    } catch (err) {
      setBootError(err?.message || 'Errore di caricamento');
    } finally {
      setBooting(false);
    }
  }, [reload]);

  useEffect(() => { bootLoad(); }, [bootLoad]);

  const settings = salon?.settings || null;
  const locations = salon?.locations || [];

  /* ---- navigation ---- */
  const [tab, setTabRaw] = useState('agenda');
  const [subTab, setSubTab] = useState(null);
  const setTab = useCallback((id, sub) => {
    setTabRaw(id);
    setSubTab(sub != null ? sub : null);
  }, []);

  /* ---- modal / drawer hosts ----
   * Ogni openModal ha un id crescente: il dispatcher lo usa come key, così una
   * riapertura con props diverse rimonta il componente con stato pulito
   * (prima un secondo openModal('newappt', …) riusava il form precedente). */
  const modalSeq = useRef(0);
  const [modal, setModal] = useState(null);   // { id, name, props }
  const openModal = useCallback((name, props) => setModal({ id: ++modalSeq.current, name, props }), []);
  const closeModal = useCallback(() => setModal(null), []);
  const [drawer, setDrawer] = useState(null); // React element (rendered inside <DkDrawer>) or null

  /* ---- toast ---- */
  const { fireToast, toastProps } = useToastHost();

  /* ---- dati sempre aggiornati (altre postazioni / altre schede) ---- */
  const live = useLiveFeed(session);
  // cataloghi base del contesto: si ricaricano da soli quando cambiano altrove.
  // Dipende da `live.subscribe` (stabile) e non da `live`, che cambia identità
  // a ogni consegna: altrimenti ci si riscriveva alla lista a ogni evento.
  useEffect(() => live.subscribe(({ events }) => {
    const has = (re) => events.some((e) => re.test(e.type));
    if (has(/^operator\./)) reload.operators().catch(() => {});
    if (has(/^(service|category|package)\./)) { reload.services().catch(() => {}); reload.serviceCategories().catch(() => {}); }
    if (has(/^client_category\./)) reload.clientCategories().catch(() => {});
    if (has(/^settings\./)) reload.salon().catch(() => {});
  }), [live.subscribe, reload]);

  /* ---- cross-section UI state ---- */
  const [search, setSearch] = useState('');
  const [selClient, setSelClient] = useState(null);   // client id for the Clienti profile
  const [deepLink, setDeepLink] = useState(null);     // e.g. 'log-today' (agenda cash-up → activity log)
  // slot scelto in agenda mentre il drawer "nuova prenotazione" è aperto:
  // { operatorId, start, date, nonce } — il drawer lo applica al volo.
  /* Giorno che l'agenda sta mostrando: il pulsante «Prenota» vive nella barra in
   * alto ed è lo stesso da ogni sezione, ma in agenda deve proporre il giorno che
   * si ha davanti, non oggi. */
  const [agendaDate, setAgendaDate] = useState(null);
  const [agendaPick, setAgendaPickRaw] = useState(null);
  const pickSeq = useRef(0);
  const setAgendaPick = useCallback((p) => setAgendaPickRaw(p ? { ...p, nonce: ++pickSeq.current } : null), []);
  const [showRevenue, setShowRevenueRaw] = useState(() => {
    try { return localStorage.getItem('dk-show-revenue') !== '0'; } catch { return true; }
  });
  const setShowRevenue = useCallback((v) => {
    setShowRevenueRaw(v);
    try { localStorage.setItem('dk-show-revenue', v ? '1' : '0'); } catch { /* ignore */ }
  }, []);

  /* ---- sede attiva: contesto operativo, non solo un'etichetta ----
   * Vive qui (non nella sidebar) così agenda, disponibilità e creazione
   * appuntamenti la passano come `location_id`. Persistita per postazione;
   * se la sede salvata non esiste più si torna a quella predefinita. */
  const [locationIdRaw, setLocationIdRaw] = useState(() => {
    try { const v = localStorage.getItem('dk-location'); return v ? Number(v) : null; } catch { return null; }
  });
  const locationId = useMemo(() => {
    if (!locations.length) return null;
    if (locationIdRaw && locations.some((l) => l.id === locationIdRaw)) return locationIdRaw;
    return (locations.find((l) => l.is_default) || locations[0]).id;
  }, [locations, locationIdRaw]);
  const location = useMemo(() => locations.find((l) => l.id === locationId) || null, [locations, locationId]);
  const setLocationId = useCallback((id) => {
    setLocationIdRaw(id);
    try { localStorage.setItem('dk-location', String(id)); } catch { /* ignore */ }
  }, []);

  /* ---- colori operatrice: dal server, condivisi fra le postazioni ----
   * Il colore scelto in agenda viene salvato (PATCH /api/staff/{id}/color): prima
   * viveva solo nello stato locale e ogni pc vedeva il suo. L'override locale
   * serve solo come feedback immediato finché il server non conferma; le altre
   * postazioni ricevono `operator.updated` dal feed live e ricaricano. */
  const [opColorOverrides, setOpColorOverrides] = useState({});
  const opColors = useMemo(() => {
    const m = {};
    operators.forEach((o, i) => {
      m[o.id] = opColorOverrides[o.id] || o.color || OP_FALLBACK_PALETTE[i % OP_FALLBACK_PALETTE.length];
    });
    return m;
  }, [operators, opColorOverrides]);
  /* Il selettore colore nativo emette un evento a ogni movimento del cursore:
   * salvare a ogni evento voleva dire decine di PATCH, altrettanti ricarichi
   * dell'elenco operatrici e un evento live a tutte le postazioni per un solo
   * colore scelto. L'anteprima resta immediata, la scrittura parte a mano ferma. */
  const colorTimers = useRef({});
  useEffect(() => () => { Object.values(colorTimers.current).forEach(clearTimeout); }, []);
  const setOpColor = useCallback((id, c) => {
    setOpColorOverrides((m) => ({ ...m, [id]: c }));
    clearTimeout(colorTimers.current[id]);
    colorTimers.current[id] = setTimeout(() => {
      delete colorTimers.current[id];
      api.patch(`/api/staff/${id}/color`, { color: c })
        .then(() => reload.operators().catch(() => {}))
        .then(() => setOpColorOverrides((m) => { const next = { ...m }; delete next[id]; return next; }))
        .catch(() => {
          setOpColorOverrides((m) => { const next = { ...m }; delete next[id]; return next; });
          fireToast({ msg: t('Colore non salvato: riprova', 'Colour not saved: try again'), icon: 'alert' });
        });
    }, 400);
  }, [reload, fireToast, t]);

  const ctx = {
    t, lang, setLang,
    session, hasScope,
    salon, settings, locations,
    locationId, setLocationId, location,
    operators, services, serviceCategories, clientCategories,
    reload,
    tab, setTab, subTab, setSubTab,
    openModal, closeModal, modal,
    drawer, setDrawer,
    fireToast, toastProps,
    live,
    search, setSearch,
    selClient, setSelClient,
    deepLink, setDeepLink,
    agendaPick, setAgendaPick,
    agendaDate, setAgendaDate,
    showRevenue, setShowRevenue,
    opColors, setOpColor, opPalette: OP_FALLBACK_PALETTE,
  };

  if (booting) return <BootSkeleton />;
  if (bootError) return <BootError message={bootError} onRetry={bootLoad} t={t} />;

  return <DashCtx.Provider value={ctx}>{children}</DashCtx.Provider>;
}

/* ---- loading gate ---- */
function BootSkeleton() {
  return (
    <div className="dk-root" style={{ display: 'flex' }}>
      <aside className="dk-side" style={{ gap: 10 }}>
        <div className="skel" style={{ height: 30, width: 120, margin: '4px 10px 22px' }} />
        {[...Array(8)].map((_, i) => <div key={i} className="skel" style={{ height: 40, borderRadius: 12 }} />)}
      </aside>
      <div className="dk-main">
        <header className="dk-top">
          <div className="skel" style={{ height: 30, width: 220 }} />
          <div style={{ flex: 1 }} />
          <div className="skel" style={{ height: 42, width: 320, borderRadius: 999 }} />
        </header>
        <div className="dk-page">
          <div className="skel" style={{ height: 26, width: 280, marginBottom: 18 }} />
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 22 }}>
            {[...Array(4)].map((_, i) => <div key={i} className="skel" style={{ height: 92, borderRadius: 16 }} />)}
          </div>
          <div className="skel" style={{ height: 380, borderRadius: 16 }} />
        </div>
      </div>
    </div>
  );
}

function BootError({ message, onRetry, t }) {
  return (
    <div className="dk-root" style={{ display: 'flex' }}>
      <div style={{ margin: 'auto', textAlign: 'center', maxWidth: 380 }}>
        <div className="t-title" style={{ marginBottom: 8 }}>{t('Errore di caricamento', 'Loading error')}</div>
        <div className="t-body" style={{ color: 'var(--muted)', marginBottom: 18 }}>{message}</div>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
          <button className="dk-btn dk-btn--clay" onClick={onRetry}>{t('Riprova', 'Retry')}</button>
          <button className="dk-btn dk-btn--ghost" onClick={() => staffAuth.logout()}>{t('Esci', 'Log out')}</button>
        </div>
      </div>
    </div>
  );
}
