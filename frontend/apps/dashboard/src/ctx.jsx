// ctx.jsx — il contesto della dashboard: DashboardProvider, useDash() e
// useLive(). Qui si mettono insieme i pezzi e si decide la forma del valore
// che leggono le sezioni; i pezzi stanno in app/:
//   app/useCatalogs.js        salone, operatrici, servizi, categorie + reload
//   app/liveFeed.js           feed live (SSE + polling) → `live`
//   app/useActiveLocation.js  sede attiva, ricordata sulla postazione
//   app/useOperatorColors.js  colori delle operatrici in agenda
//   app/BootScreens.jsx       schermata d'attesa e d'errore dell'avvio
// Nome e percorso di questo file non cambiano: lo importano tutte le sezioni,
// e il banco di prova dell'agenda (test/grid-harness.mjs) sostituisce ogni
// file che finisce in `ctx.jsx` con un finto `useDash`.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { staffAuth, useT, useToastHost } from '@youty/shared';
import { createBatcher } from './liveSeen.js';
import { useStoredState } from './hooks/useStoredState.js';
import { useCatalogs, useLiveCatalogs } from './app/useCatalogs.js';
import { useLiveFeed } from './app/liveFeed.js';
import { useActiveLocation } from './app/useActiveLocation.js';
import { OP_FALLBACK_PALETTE, useOperatorColors } from './app/useOperatorColors.js';
import { BootError, BootSkeleton } from './app/BootScreens.jsx';

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

const readShowRevenue = (v) => v !== '0';
const writeShowRevenue = (v) => (v ? '1' : '0');

export function DashboardProvider({ children }) {
  const { t, lang, setLang } = useT();

  /* ---- session ---- */
  const [session, setSession] = useState(staffAuth.getSession());
  useEffect(() => staffAuth.subscribe(setSession), []);
  const hasScope = useCallback((scope) => staffAuth.hasScope(scope), [session]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ---- base data (loaded once, reloadable per collection) ---- */
  const {
    salon, settings, locations, operators, services, serviceCategories, clientCategories,
    reload, bootLoad, booting, bootError,
  } = useCatalogs();

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

  /* ---- toast ----
   * `toastProps` si ricostruisce solo quando cambia il toast (useToastHost ne
   * crea uno nuovo a ogni render): altrimenti il valore del contesto qui sotto
   * cambierebbe a ogni render anche senza cambiare niente. */
  const { fireToast, toastProps: { toast, onUndo, onDone } } = useToastHost();
  const toastProps = useMemo(() => ({ toast, onUndo, onDone }), [toast, onUndo, onDone]);

  /* ---- dati sempre aggiornati (altre postazioni / altre schede) ---- */
  const live = useLiveFeed(session);
  useLiveCatalogs(live.subscribe, reload);

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
  const [showRevenue, setShowRevenue] = useStoredState('dk-show-revenue', { read: readShowRevenue, write: writeShowRevenue, fallback: true });

  /* ---- sede attiva e colori delle operatrici ---- */
  const { locationId, setLocationId, location } = useActiveLocation(locations);
  const { opColors, setOpColor } = useOperatorColors({ operators, reload, fireToast, t });

  /* Il valore cambia solo quando cambia qualcosa che contiene: ricostruito a
   * ogni render, faceva ridisegnare ogni componente che legge il contesto a
   * ogni render del provider. Stesse chiavi e stessi valori di prima. */
  const ctx = useMemo(() => ({
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
  }), [
    t, lang, setLang, session, hasScope, salon, settings, locations, locationId, setLocationId, location,
    operators, services, serviceCategories, clientCategories, reload, tab, setTab, subTab,
    openModal, closeModal, modal, drawer, fireToast, toastProps, live, search, selClient, deepLink,
    agendaPick, setAgendaPick, agendaDate, showRevenue, setShowRevenue, opColors, setOpColor,
  ]);

  if (booting) return <BootSkeleton />;
  if (bootError) return <BootError message={bootError} onRetry={bootLoad} t={t} />;

  return <DashCtx.Provider value={ctx}>{children}</DashCtx.Provider>;
}
