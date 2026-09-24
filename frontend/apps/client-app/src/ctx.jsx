// ctx.jsx — AppProvider for the client web app: branding boot, session, view routing.
// Gli schermi lo leggono con useApp().
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { apiErrorText, clientAuth, mediaUrl, SALON_SLUG, setSalonTz, storedLang, useT, useToastHost } from '@youty/shared';
import { getBranding } from './api/client.js';
import { makeBrand } from './theme.js';

/* Il salone servito da questa pagina è il primo segmento del path
 * (`/the-parlour`). La risoluzione vive in @youty/shared perché serve anche a
 * clientAuth, che namespacizza la sessione per salone. Vedi shared/src/salon.js.
 * Ri-esportato qui: gli schermi lo importano da '../ctx.jsx'. */
export { SALON_SLUG };

const AppCtx = createContext(null);
export const useApp = () => useContext(AppCtx);

const FALLBACK_BRAND_COLOR = '#7C4A57';

export function AppProvider({ children }) {
  const { t, lang, setLang } = useT();
  /* La lingua scelta dalla cliente vince sempre; se non ne ha mai scelta una,
   * vale `default_lang` del salone. Veniva ignorato del tutto e un salone che
   * lavora in inglese apriva comunque in italiano. Si guarda il valore SALVATO
   * ALL'AVVIO perché il provider riscrive la chiave al primo render. */
  const langChosen = useRef(storedLang() !== null);
  const setLangChosen = useCallback((next) => { langChosen.current = true; setLang(next); }, [setLang]);

  /* ---- white-label branding boot ---- */
  const [brand, setBrand] = useState(null);
  const [brandError, setBrandError] = useState(null);
  // Il `t` di adesso, per il testo dell'errore: loadBrand non dipende dalla
  // lingua, altrimenti l'effetto qui sotto rileggerebbe il salone a ogni cambio.
  const tNow = useRef(t);
  tNow.current = t;
  const loadBrand = useCallback(async () => {
    setBrandError(null);
    try {
      const b = await getBranding(SALON_SLUG);
      // Orari sempre quelli del salone: dall'estero la cliente leggeva l'ora
      // del proprio telefono e si presentava all'ora sbagliata.
      setSalonTz(b.timezone);
      if (!langChosen.current && (b.default_lang === 'it' || b.default_lang === 'en')) setLang(b.default_lang);
      setBrand(makeBrand({
        color: b.brand_color || FALLBACK_BRAND_COLOR,
        name: b.name,
        slug: b.slug,
        logoUrl: b.logo_url ? mediaUrl(b.logo_url) : null,
        address: b.address || '',
        phone: b.phone || '',
        openingHours: b.opening_hours || '',
        privacyUrl: b.privacy_policy_url || '',
        // La soglia di preavviso è configurabile: se il branding non la espone
        // ancora si resta sul 24 di `makeBrand`, mai su un testo fisso.
        cancelMinHours: b.cancel_min_hours,
      }));
    } catch (err) {
      // Sotto «Impossibile caricare il salone» (App.jsx) il messaggio del
      // server se una risposta è arrivata, altrimenti «Errore di rete»
      // (apiErrorText). Con `err.message` senza rete compariva il testo del
      // browser, «Failed to fetch» (su Safari «Load failed»), e il ripiego era
      // un «Errore» senza traduzione (voce 31). Mai vuoto: App.jsx mostra
      // l'errore e «Riprova» solo se c'è un testo.
      setBrandError(apiErrorText(err, tNow.current) || tNow.current('Errore di rete', 'Network error'));
    }
  }, [setLang]);
  useEffect(() => { loadBrand(); }, [loadBrand]);

  /* favicon e titolo white-label: logo del salone se c'è, altrimenti un
   * monogramma nel colore del brand (SVG inline, nessun file da servire). */
  useEffect(() => {
    if (!brand) return;
    try {
      document.title = brand.name || document.title;
      const letter = String(brand.name || 'y').trim().charAt(0).toUpperCase() || 'Y';
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" rx="24" fill="${brand.color || '#7C4A57'}"/><text x="50" y="68" text-anchor="middle" font-family="-apple-system,Helvetica,Arial,sans-serif" font-size="56" font-weight="700" fill="#fff">${letter}</text></svg>`;
      const href = brand.logo || 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
      document.querySelectorAll('link[rel="icon"], link[rel="apple-touch-icon"]').forEach((l) => l.remove());
      const link = document.createElement('link');
      link.rel = 'icon';
      link.type = brand.logo ? '' : 'image/svg+xml';
      link.href = href;
      document.head.appendChild(link);
      const touch = document.createElement('link');
      touch.rel = 'apple-touch-icon';
      touch.href = href;
      document.head.appendChild(touch);
      const theme = document.querySelector('meta[name="theme-color"]');
      if (theme && brand.color) theme.setAttribute('content', brand.color);
    } catch { /* ambiente senza DOM completo */ }
  }, [brand]);

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

  /* ---- viste: stato in memoria, non URL (vedi shared/src/salon.js) ---- */
  const [view, setViewRaw] = useState('home');
  const [viewParams, setViewParams] = useState({});
  const setView = useCallback((v, params = {}) => {
    setViewRaw(v);
    setViewParams(params);
  }, []);

  /* ---- uscita (Utility e Profilo) ----
   * Prima la home, poi il logout, poi il toast. Uscendo DA una schermata
   * personale il gate la riconosceva subito come vietata e rilanciava la
   * schermata d'accesso a tutto schermo, insieme al toast «Sei uscita», con la
   * ripresa sulla schermata appena lasciata (16-09). Chiamata dal tocco su
   * «Esci», React applica i due aggiornamenti insieme e il gate non scatta. */
  const logout = useCallback(() => {
    setView('home');
    clientAuth.logout();
    fireToast({ msg: t('Sei uscita dal profilo', 'Logged out'), icon: 'check' });
  }, [setView, fireToast, t]);

  const ctx = {
    t, lang, setLang: setLangChosen,
    brand, reloadBrand: loadBrand, brandError,
    session, client,
    authOpen, openAuth, closeAuth,
    fireToast, toastProps,
    view, setView, viewParams,
    logout,
  };

  return <AppCtx.Provider value={ctx}>{children}</AppCtx.Provider>;
}
