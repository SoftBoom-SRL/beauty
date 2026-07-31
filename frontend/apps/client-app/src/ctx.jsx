// ctx.jsx — AppProvider for the client web app: branding boot, session, view routing.
// Screen agents CONSUME this via useApp() — never edit it.
import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { api, clientAuth, mediaUrl, useT, useToastHost } from '@youty/shared';
import { makeBrand } from './theme.js';

/* ---- salone servito da questa pagina ----
 * Un solo deploy serve tutti i saloni: lo slug arriva dal sottodominio.
 * Ordine di precedenza:
 *   1. ?salon=<slug>        override esplicito (test e anteprime)
 *   2. sottodominio         <slug>.<VITE_CLIENT_BASE_HOST>, es. the-parlour.prenota.esempio.it
 *   3. VITE_SALON_SLUG      fallback a build time (sviluppo, deploy mono-salone)
 * Il confronto con VITE_CLIENT_BASE_HOST è obbligatorio: senza, su un host a due
 * livelli come prenota.esempio.it prenderemmo "prenota" come slug. */
function resolveSalonSlug() {
  const override = new URLSearchParams(window.location.search).get('salon');
  if (override) return override;

  const base = import.meta.env.VITE_CLIENT_BASE_HOST;
  const host = window.location.hostname;
  if (base && host.endsWith('.' + base)) {
    const sub = host.slice(0, -(base.length + 1));
    if (sub && sub !== 'www' && !sub.includes('.')) return sub;
  }

  return import.meta.env.VITE_SALON_SLUG || 'the-parlour';
}

export const SALON_SLUG = resolveSalonSlug();

const AppCtx = createContext(null);
export const useApp = () => useContext(AppCtx);

const FALLBACK_BRAND_COLOR = '#7C4A57';

export function AppProvider({ children }) {
  const { t, lang, setLang } = useT();

  /* ---- white-label branding boot ---- */
  const [brand, setBrand] = useState(null);
  const [brandError, setBrandError] = useState(null);
  const loadBrand = useCallback(async () => {
    setBrandError(null);
    try {
      const b = await api.get('/api/core/public/branding', { params: { salon: SALON_SLUG }, auth: false });
      setBrand(makeBrand({
        color: b.brand_color || FALLBACK_BRAND_COLOR,
        name: b.name,
        slug: b.slug,
        logoUrl: b.logo_url ? mediaUrl(b.logo_url) : null,
        address: b.address || '',
        phone: b.phone || '',
        openingHours: b.opening_hours || '',
      }));
    } catch (err) {
      setBrandError(err?.message || 'Errore');
    }
  }, []);
  useEffect(() => { loadBrand(); }, [loadBrand]);

  /* ---- session ---- */
  const [session, setSession] = useState(clientAuth.getSession());
  useEffect(() => clientAuth.subscribe(setSession), []);
  const client = session?.client || null;

  /* ---- login overlay a richiesta (l'app non ha più un gate d'ingresso) ---- */
  const [authOpen, setAuthOpen] = useState(false);
  const authResume = useRef(null);
  const openAuth = useCallback((onDone) => { authResume.current = onDone || null; setAuthOpen(true); }, []);
  const closeAuth = useCallback(() => { authResume.current = null; setAuthOpen(false); }, []);
  // quando la sessione compare mentre l'overlay è aperto → riprendi e chiudi
  useEffect(() => {
    if (session && authOpen) {
      const cb = authResume.current;
      authResume.current = null;
      setAuthOpen(false);
      if (cb) cb();
    }
  }, [session, authOpen]);

  /* ---- toast ---- */
  const { fireToast, toastProps } = useToastHost();

  /* ---- view routing (state-based, like the prototype) ---- */
  const [view, setViewRaw] = useState('home');
  const [viewParams, setViewParams] = useState({});
  const setView = useCallback((v, params = {}) => {
    setViewRaw(v);
    setViewParams(params);
  }, []);

  const ctx = {
    t, lang, setLang,
    brand, reloadBrand: loadBrand, brandError,
    session, client,
    authOpen, openAuth, closeAuth,
    fireToast, toastProps,
    view, setView, viewParams,
  };

  return <AppCtx.Provider value={ctx}>{children}</AppCtx.Provider>;
}
