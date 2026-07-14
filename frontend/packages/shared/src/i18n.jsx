// i18n.jsx — bilingual IT/EN helper, same `t(it, en)` pattern as the prototype.
// Also accepts the object form `t({ it, en })` used by API payloads / prototype data.

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

const LangCtx = createContext({ lang: 'it', setLang: () => {} });

const LS_KEY = 'yt.lang';

export function LangProvider({ initial = 'it', children }) {
  const [lang, setLang] = useState(() => {
    try { return localStorage.getItem(LS_KEY) || initial; } catch { return initial; }
  });
  useEffect(() => {
    try { localStorage.setItem(LS_KEY, lang); } catch { /* ignore */ }
  }, [lang]);
  const value = useMemo(() => ({ lang, setLang }), [lang]);
  return <LangCtx.Provider value={value}>{children}</LangCtx.Provider>;
}

/** Build a translate function for a given lang (non-hook contexts). */
export function makeT(lang) {
  return (it, en) => {
    if (it && typeof it === 'object') return it[lang] ?? it.it ?? it.en ?? '';
    return lang === 'en' ? (en ?? it) : it;
  };
}

/** { t, lang, setLang } — t('Ciao', 'Hello') or t({ it: 'Ciao', en: 'Hello' }) */
export function useT() {
  const { lang, setLang } = useContext(LangCtx);
  const t = useCallback(makeT(lang), [lang]);
  return { t, lang, setLang };
}
