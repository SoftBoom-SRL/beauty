// ctx.jsx — DashboardProvider: session, base catalogs from the API, navigation,
// modal/drawer/toast plumbing. Section agents CONSUME this via useDash() — never edit it.
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api, setSalonTimeZone, staffAuth, useT, useToastHost } from '@youty/shared';

const DashCtx = createContext(null);
export const useDash = () => useContext(DashCtx);

const OP_FALLBACK_PALETTE = ['#C9B8F2', '#B3DDF7', '#F7C5D9', '#FBE7A1', '#C2E8CB', '#FBD7B5', '#BFE9E1', '#C3CDF7', '#D2E5BE'];

export function DashboardProvider({ children }) {
  const { t, lang, setLang } = useT();

  /* ---- session ---- */
  const [session, setSession] = useState(staffAuth.getSession());
  useEffect(() => staffAuth.subscribe(setSession), []);
  const hasScope = useCallback((scope) => staffAuth.hasScope(scope), [session]);

  /* ---- base data (loaded once, reloadable per collection) ---- */
  const [salon, setSalon] = useState(null);                       // SalonOut {id,name,slug,locations,settings,...}
  const [operators, setOperators] = useState([]);                 // [OperatorStatusOut]
  const [services, setServices] = useState([]);                   // [ServiceOut]
  const [serviceCategories, setServiceCategories] = useState([]); // [catalog CategoryOut]
  const [clientCategories, setClientCategories] = useState([]);   // [clients CategoryOut]
  const [booting, setBooting] = useState(true);
  const [bootError, setBootError] = useState(null);

  const reload = useMemo(() => ({
    // Pin the display timezone to the salon's BEFORE any section renders: the
    // agenda grid maths on salon-local minutes, not on the browser's clock.
    salon: () => api.get('/api/core/salon').then((s) => {
      setSalonTimeZone(s?.settings?.timezone);
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

  /* ---- modal / drawer hosts ---- */
  const [modal, setModal] = useState(null);   // { name, props }
  const openModal = useCallback((name, props) => setModal({ name, props }), []);
  const closeModal = useCallback(() => setModal(null), []);
  const [drawer, setDrawer] = useState(null); // React element (rendered inside <DkDrawer>) or null

  /* ---- toast ---- */
  const { fireToast, toastProps } = useToastHost();

  /* ---- gate strumenti Yourang -------------------------------------------
   * Non "piano free vs premium" ma disponibilità dello strumento: tre stati
   * (active | no_credit | not_connected) e due motivi di blocco che portano
   * l'utente in due posti diversi su Yourang. Il popup arriva SEMPRE prima
   * del rinvio esterno.
   *   requireYourang()  → preventivo: false + popup se lo strumento non c'è
   *   yourangGate(err)  → reattivo: intercetta 402/412 da una chiamata fallita
   */
  const [yourang, setYourang] = useState(null);      // StatusOut o null
  const [yourangGateReason, setYourangGateReason] = useState(null); // 'no_credit' | 'not_connected'
  const loadYourang = useCallback(
    () => api.get('/api/integrations/yourang/status').then(setYourang).catch(() => setYourang(null)),
    [],
  );
  const yourangState = yourang?.feature_state || 'not_connected';

  const requireYourang = useCallback(() => {
    if (yourangState === 'active') return true;
    setYourangGateReason(yourangState);
    return false;
  }, [yourangState]);

  const yourangGate = useCallback((err) => {
    const status = err?.status;
    if (status !== 402 && status !== 412) return false;
    setYourangGateReason(status === 402 ? 'no_credit' : 'not_connected');
    // La verità è del server: riallinea lo stato locale (es. credito appena finito).
    loadYourang();
    return true;
  }, [loadYourang]);

  const closeYourangGate = useCallback(() => setYourangGateReason(null), []);

  // Caricato fuori dal boot: se l'endpoint non risponde la dashboard deve
  // comunque partire (lo stato resta 'not_connected', che è il default sicuro).
  useEffect(() => { loadYourang(); }, [loadYourang]);

  /* ---- cross-section UI state ---- */
  const [search, setSearch] = useState('');
  const [selClient, setSelClient] = useState(null);   // client id for the Clienti profile
  const [deepLink, setDeepLink] = useState(null);     // e.g. 'log-today' (agenda cash-up → activity log)
  const [showRevenue, setShowRevenueRaw] = useState(() => {
    try { return localStorage.getItem('dk-show-revenue') !== '0'; } catch { return true; }
  });
  const setShowRevenue = useCallback((v) => {
    setShowRevenueRaw(v);
    try { localStorage.setItem('dk-show-revenue', v ? '1' : '0'); } catch { /* ignore */ }
  }, []);

  /* ---- operator colours: API color, overridable in state ---- */
  const [opColorOverrides, setOpColorOverrides] = useState({});
  const opColors = useMemo(() => {
    const m = {};
    operators.forEach((o, i) => {
      m[o.id] = opColorOverrides[o.id] || o.color || OP_FALLBACK_PALETTE[i % OP_FALLBACK_PALETTE.length];
    });
    return m;
  }, [operators, opColorOverrides]);
  const setOpColor = useCallback((id, c) => setOpColorOverrides((m) => ({ ...m, [id]: c })), []);

  const ctx = {
    t, lang, setLang,
    session, hasScope,
    salon, settings, locations,
    operators, services, serviceCategories, clientCategories,
    reload,
    tab, setTab, subTab, setSubTab,
    openModal, closeModal, modal,
    drawer, setDrawer,
    fireToast, toastProps,
    yourang, yourangState, requireYourang, yourangGate,
    yourangGateReason, closeYourangGate, reloadYourang: loadYourang,
    search, setSearch,
    selClient, setSelClient,
    deepLink, setDeepLink,
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
