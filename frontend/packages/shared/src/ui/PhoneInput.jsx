// PhoneInput.jsx — campo telefono con bandiera + prefisso a discesa e numero
// nazionale. Il valore esterno è SEMPRE E.164 ('' se vuoto): il componente
// traduce da/verso quello che l'utente vede.
//
// Il menu dei paesi è un portal (nel `.dk-root` della dashboard o
// nell'`.app-frame` dell'app cliente, per ereditare i token colore) posizionato
// sul campo: così non viene tagliato da modali/drawer con overflow. Si chiude
// al click fuori con un listener su document, come fa Topbar.jsx.
//
// Props: value, onChange(e164), placeholder, autoFocus, disabled, onEnter,
//        variant 'dashboard' | 'client', style, inputStyle, id, ariaLabel, lang
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon.jsx';
import { COUNTRIES, DEFAULT_ISO2, countryOf, splitPhone, joinPhone, formatNational, readPhoneField } from '../phone.js';

// prefisso non in elenco: si mostra un globo e si conserva il numero com'è
const UNKNOWN = { iso2: '', flag: '🌐', dial: '', name_it: 'Prefisso internazionale', name_en: 'International prefix' };

const isTouch = () => typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches;

export function PhoneInput({
  value, onChange, placeholder, autoFocus, disabled, onEnter,
  variant = 'dashboard', style, inputStyle, id, ariaLabel, lang = 'it',
}) {
  const client = variant === 'client';
  const parsed = useMemo(() => splitPhone(value), [value]);

  // Il paese scelto vive nello stato: a numero vuoto joinPhone dà '' e il
  // valore esterno non saprebbe ricordarlo.
  const [iso2, setIso2] = useState(() => (value ? parsed.iso2 : DEFAULT_ISO2));
  useEffect(() => {
    if (!value) return;
    // si riallinea solo se cambia il prefisso: USA/Canada condividono +1 e la
    // scelta dell'utente non va sovrascritta a ogni cifra digitata
    const cur = countryOf(iso2);
    if ((cur ? cur.dial : '') !== parsed.dial) setIso2(parsed.iso2);
  }, [value, parsed.dial, parsed.iso2]); // eslint-disable-line react-hooks/exhaustive-deps
  const country = countryOf(iso2) || UNKNOWN;

  // Buffer delle cifre mentre il campo è a fuoco: lo 0 iniziale (che in E.164
  // cade) non deve sparire sotto le dita di chi lo digita. Tiene anche un «+»
  // o un «00» appena battuti, finché il prefisso non si riconosce: vedi
  // readPhoneField.
  const [raw, setRaw] = useState(null);
  const [focused, setFocused] = useState(false);
  const national = value ? parsed.national : '';
  const pending = raw != null && /^(\+|00)/.test(raw);
  const shown = pending ? raw : formatNational(iso2, raw != null ? raw : national);

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [hi, setHi] = useState(0);
  const [rect, setRect] = useState(null);
  const wrapRef = useRef(null), menuRef = useRef(null), btnRef = useRef(null), numRef = useRef(null), searchRef = useRef(null);

  const emit = (isoCode, digits) => onChange?.(joinPhone(isoCode, digits));

  // Cifre che devono restare a sinistra del cursore dopo il prossimo render.
  // Il testo mostrato è raggruppato ("333 123 4567"): riscrivendolo a ogni
  // battuta il browser riporta il cursore in fondo, e chi correggeva una cifra
  // in mezzo al numero si ritrovava a scrivere alla fine.
  const caretDigits = useRef(null);

  useLayoutEffect(() => {
    const el = numRef.current;
    const want = caretDigits.current;
    if (!el || want == null || document.activeElement !== el) { caretDigits.current = null; return; }
    caretDigits.current = null;
    let pos = 0, seen = 0;
    while (pos < el.value.length && seen < want) {
      if (/\d/.test(el.value[pos])) seen += 1;
      pos += 1;
    }
    try { el.setSelectionRange(pos, pos); } catch { /* input non selezionabile */ }
  });

  const onNumber = (e) => {
    const el = e.target;
    const text = el.value;
    const caret = el.selectionStart ?? text.length;
    // Numero con il prefisso, battuto o incollato («+44…», «0044…», «(+39)…»,
    // «393331234567» con la bandiera italiana): il paese si riconosce e il
    // prefisso passa nella bandiera. Un «+» o un «00» senza ancora un prefisso
    // riconoscibile resta in campo com'è: chi lo sta digitando non deve
    // vederselo sparire sotto le dita (e le cifre dopo finire in coda al +39).
    const r = readPhoneField(iso2, text);
    if (r.pending) {
      caretDigits.current = null; // il testo resta quello battuto: cursore dov'è
      setRaw(r.pending);
      onChange?.('');
      return;
    }
    // Le cifre finite nella bandiera non contano per il cursore.
    const moved = text.replace(/\D/g, '').length - r.national.length;
    const before = text.slice(0, caret).replace(/\D/g, '').length;
    caretDigits.current = Math.min(r.national.length, Math.max(0, before - moved));
    if (r.iso2 !== iso2) setIso2(r.iso2);
    setRaw(r.national);
    emit(r.iso2, r.national);
  };

  const onNumberKey = (e) => {
    if (e.key === 'Enter' && onEnter) { onEnter(e); return; }
    if (e.key !== 'Backspace') return;
    const el = e.target;
    const at = el.selectionStart;
    if (at == null || at !== el.selectionEnd || at === 0) return;
    if (/\d/.test(el.value[at - 1])) return; // cifra: cancellazione normale
    // Il carattere a sinistra è uno spazio di raggruppamento. Cancellandolo il
    // numero non cambia, quindi il campo si ridisegna identico e il tasto
    // sembra non funzionare: si toglie invece la cifra che lo precede.
    e.preventDefault();
    const before = el.value.slice(0, at).replace(/\D/g, '');
    const after = el.value.slice(at).replace(/\D/g, '');
    const digits = before.slice(0, -1) + after;
    caretDigits.current = Math.max(0, before.length - 1);
    setRaw(digits);
    emit(iso2, digits);
  };

  const close = useCallback(() => { setOpen(false); setQuery(''); setHi(0); }, []);

  const pick = (c) => {
    // Un «+»/«00» ancora senza prefisso: il paese scelto dal menu lo sostituisce.
    let digits = pending ? '' : (raw != null ? raw : national);
    // Prefisso non riconosciuto: le cifre in campo contengono ANCORA il
    // prefisso incollato. Anteporre quello scelto dava "+39 44 7911…".
    if (!country.dial && digits.startsWith(c.dial)) digits = digits.slice(c.dial.length);
    setIso2(c.iso2);
    if (raw != null) setRaw(digits);
    close();
    if (digits) emit(c.iso2, digits);
    requestAnimationFrame(() => numRef.current?.focus());
  };

  /* ---- posizionamento del menu (sotto il campo, sopra se non c'è spazio) ---- */
  const place = useCallback(() => {
    const el = wrapRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight;
    const width = Math.min(Math.max(r.width, 280), vw - 16);
    const left = Math.min(Math.max(8, r.left), Math.max(8, vw - width - 8));
    const below = vh - r.bottom - 12;
    const up = below < 240 && r.top > below;
    const maxH = Math.max(160, Math.min(340, (up ? r.top : below) - 12));
    setRect({ left, width, top: up ? undefined : r.bottom + 6, bottom: up ? vh - r.top + 6 : undefined, maxH });
  }, []);
  useLayoutEffect(() => { if (open) place(); }, [open, place]);

  useEffect(() => {
    if (!open) return undefined;
    setHi(Math.max(0, COUNTRIES.findIndex((c) => c.iso2 === iso2)));
    // su touch la tastiera coprirebbe la lista: la ricerca si tocca a mano
    if (!isTouch()) requestAnimationFrame(() => searchRef.current?.focus());
    const onDown = (e) => { if (!wrapRef.current?.contains(e.target) && !menuRef.current?.contains(e.target)) close(); };
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); btnRef.current?.focus(); } };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', place);
    document.addEventListener('scroll', place, true);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', place);
      document.removeEventListener('scroll', place, true);
    };
  }, [open, close, place]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ---- ricerca per nome o prefisso ---- */
  const q = query.trim().toLowerCase();
  const qDigits = q.replace(/^\+|^00/, '');
  const list = useMemo(() => (q
    ? COUNTRIES.filter((c) => c.name_it.toLowerCase().includes(q) || c.name_en.toLowerCase().includes(q)
      || c.iso2.toLowerCase() === q || (qDigits && /^\d+$/.test(qDigits) && c.dial.startsWith(qDigits)))
    : COUNTRIES), [q, qDigits]);
  useEffect(() => { setHi(0); }, [q]);
  useEffect(() => {
    if (open) menuRef.current?.querySelector('[data-hi="1"]')?.scrollIntoView({ block: 'nearest' });
  }, [hi, open]);

  const onSearchKey = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setHi((i) => Math.min(list.length - 1, i + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((i) => Math.max(0, i - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); if (list[hi]) pick(list[hi]); }
  };

  const name = (c) => (lang === 'en' ? c.name_en : c.name_it);
  const ph = placeholder ?? (country.iso2 === 'IT' ? '333 123 4567' : (lang === 'en' ? 'Number' : 'Numero'));

  /* ---- stili per variante ---- */
  const wrapStyle = client
    ? { display: 'flex', alignItems: 'stretch', padding: 0, minHeight: 50, borderColor: focused ? 'var(--brand, var(--clay))' : undefined, opacity: disabled ? 0.6 : 1, ...style }
    : {
      display: 'flex', alignItems: 'stretch', height: 42, width: '100%', boxSizing: 'border-box',
      border: '1px solid ' + (focused ? 'var(--line-strong)' : 'var(--hair)'), borderRadius: 10,
      background: disabled ? 'var(--surface-2)' : 'var(--surface)', fontFamily: 'var(--sans)', fontSize: 14.5, color: 'var(--ink)',
      boxShadow: focused ? '0 0 0 4px var(--hair-2)' : 'none', transition: 'border-color 150ms, box-shadow 150ms',
      opacity: disabled ? 0.6 : 1, ...style,
    };
  const hiBg = client ? 'var(--brand-tint, var(--paper-2))' : 'var(--surface-2, var(--paper-2))';
  const accent = client ? 'var(--brand, var(--clay))' : 'var(--clay)';

  const host = open && wrapRef.current ? (wrapRef.current.closest('.dk-root, .app-frame') || document.body) : null;

  const menu = open && rect && (
    <div ref={menuRef} role="listbox" className={client ? 'card' : 'dk-card'}
      style={{
        position: 'fixed', left: rect.left, width: rect.width, top: rect.top, bottom: rect.bottom, maxHeight: rect.maxH,
        zIndex: 1000, display: 'flex', flexDirection: 'column', padding: 6, boxSizing: 'border-box',
        boxShadow: 'var(--sh-pop)', border: '1px solid var(--hair)', borderRadius: client ? 'var(--r-md)' : 14,
        fontFamily: 'var(--sans)', color: 'var(--ink)',
      }}>
      <input ref={searchRef} value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={onSearchKey}
        placeholder={lang === 'en' ? 'Search country or prefix…' : 'Cerca paese o prefisso…'} aria-label={lang === 'en' ? 'Search country' : 'Cerca paese'}
        autoCapitalize="off" autoCorrect="off" spellCheck={false}
        style={{ width: '100%', boxSizing: 'border-box', border: '1px solid var(--hair)', borderRadius: client ? 12 : 8, padding: client ? '11px 12px' : '8px 10px', fontSize: client ? 16 : 13.5, outline: 'none', fontFamily: 'inherit', background: 'var(--paper-2)', color: 'var(--ink)', marginBottom: 6, flexShrink: 0 }} />
      <div className="scroll" style={{ overflowY: 'auto', flex: 1, minHeight: 0 }}>
        {list.map((c, i) => {
          const on = c.iso2 === iso2;
          return (
            <button key={c.iso2} type="button" role="option" aria-selected={on} data-hi={i === hi ? '1' : undefined}
              onMouseEnter={() => setHi(i)} onClick={() => pick(c)}
              style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: client ? '11px 10px' : '8px 9px', borderRadius: 9, border: 'none', background: i === hi ? hiBg : 'transparent', cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit', color: 'var(--ink)' }}>
              <span aria-hidden="true" style={{ fontSize: 20, lineHeight: 1, width: 26, textAlign: 'center' }}>{c.flag}</span>
              <span style={{ flex: 1, minWidth: 0, fontSize: client ? 15 : 13.5, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name(c)}</span>
              <span className="tabnum" style={{ color: 'var(--muted)', fontSize: client ? 14 : 13 }}>+{c.dial}</span>
              {on && <Icon name="check" size={14} color={accent} stroke={2.6} />}
            </button>
          );
        })}
        {!list.length && <div style={{ padding: '10px 9px', fontSize: 13, color: 'var(--muted-2)' }}>{lang === 'en' ? 'No match' : 'Nessun paese trovato'}</div>}
      </div>
    </div>
  );

  return (
    <div ref={wrapRef} className={client ? 'ca-input' : undefined} style={wrapStyle}>
      <button type="button" ref={btnRef} disabled={disabled} onClick={() => (open ? close() : setOpen(true))}
        aria-haspopup="listbox" aria-expanded={open} aria-label={(lang === 'en' ? 'Country prefix: ' : 'Prefisso: ') + name(country)}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: client ? '0 10px 0 14px' : '0 8px 0 10px', border: 'none', borderRight: '1px solid var(--hair)', background: 'transparent', cursor: disabled ? 'default' : 'pointer', fontFamily: 'inherit', fontSize: 'inherit', color: 'var(--ink)', flexShrink: 0, borderRadius: client ? '14px 0 0 14px' : '10px 0 0 10px' }}>
        <span aria-hidden="true" style={{ fontSize: client ? 20 : 18, lineHeight: 1 }}>{country.flag}</span>
        <span className="tabnum" style={{ fontWeight: 600, color: 'var(--ink-2)', fontSize: client ? 15 : 13.5 }}>+{country.dial}</span>
        <Icon name="chevD" size={14} color="var(--muted-2)" />
      </button>
      <input ref={numRef} id={id} type="tel" inputMode="tel" autoComplete="tel-national" value={shown} disabled={disabled} autoFocus={autoFocus}
        placeholder={ph} aria-label={ariaLabel || (lang === 'en' ? 'Phone number' : 'Numero di telefono')}
        onChange={onNumber}
        onFocus={() => { setFocused(true); setRaw(national); }}
        onBlur={() => { setFocused(false); setRaw(null); }}
        onKeyDown={onNumberKey}
        style={{ flex: 1, minWidth: 0, border: 'none', outline: 'none', background: 'transparent', fontFamily: 'inherit', fontSize: client ? 16 : 'inherit', color: 'var(--ink)', padding: client ? '0 14px' : '0 11px', letterSpacing: '0.01em', ...inputStyle }} />
      {host ? createPortal(menu, host) : null}
    </div>
  );
}
