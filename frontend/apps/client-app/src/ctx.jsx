// ctx.jsx — AppProvider for the client web app: branding boot, session, view routing.
// Screen agents CONSUME this via useApp() — never edit it.
import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { api, clientAuth, mediaUrl, useT, useToastHost } from '@youty/shared';
import { makeBrand } from './theme.js';

export const SALON_SLUG = import.meta.env.VITE_SALON_SLUG || 'the-parlour';

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
    fireToast, toastProps,
    view, setView, viewParams,
  };

  return <AppCtx.Provider value={ctx}>{children}</AppCtx.Provider>;
}
