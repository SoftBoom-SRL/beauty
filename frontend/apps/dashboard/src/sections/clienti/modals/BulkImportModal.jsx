// BulkImportModal — import clienti da CSV/TSV o testo incollato in tre passi:
// 1) sorgente: file o incolla, con delimitatore, codifica e intestazione rilevati
// 2) mappatura: ogni colonna del file → un campo (suggerita dai titoli o dal
//    contenuto), con anteprima dei valori
// 3) verifica: righe normalizzate (telefono, genere, compleanno con o senza
//    anno, etichette), avvisi per riga, scelta se aggiornare gli esistenti
// → POST /api/clients/import a blocchi → esito con errori per riga.
import React, { useMemo, useRef, useState } from 'react';
import { api, ApiError, Icon, Toggle } from '@youty/shared';
import DkModal from '../../../ui/DkModal.jsx';
import { useDash } from '../../../ctx.jsx';
import { inputCss, formatBirthday } from '../helpers.js';

/* ---------- parsing ---------- */
const DELIMS = [',', ';', '\t', '|'];
export function detectDelimiter(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim()).slice(0, 8);
  let best = ',', bestScore = -1;
  DELIMS.forEach((d) => {
    const counts = lines.map((l) => (l.split(d).length - 1));
    const min = Math.min(...counts), avg = counts.reduce((a, b) => a + b, 0) / (counts.length || 1);
    const score = min > 0 ? avg + min * 2 : 0;
    if (score > bestScore) { bestScore = score; best = d; }
  });
  return best;
}
/** RFC 4180: virgolette, delimitatori dentro le virgolette, CRLF. → string[][] */
export function parseCsv(text, delim) {
  const rows = []; let row = []; let cell = ''; let q = false;
  const s = text.replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === delim) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.map((r) => r.map((c) => c.trim())).filter((r) => r.some((c) => c));
}

/* ---------- campi e riconoscimento ---------- */
export const FIELDS = (t) => ([
  { k: 'ignore', label: t('— ignora —', '— ignore —') },
  { k: 'full_name', label: t('Nome e cognome', 'Full name') },
  { k: 'first_name', label: t('Nome', 'First name') },
  { k: 'last_name', label: t('Cognome', 'Last name') },
  { k: 'phone', label: t('Telefono', 'Phone') },
  { k: 'email', label: 'Email' },
  { k: 'gender', label: t('Genere', 'Gender') },
  { k: 'birthday', label: t('Compleanno / data di nascita', 'Birthday / date of birth') },
  { k: 'categories', label: t('Etichette', 'Labels') },
  { k: 'origin', label: t('Come ci ha conosciuto', 'Source') },
  { k: 'lang', label: t('Lingua', 'Language') },
  { k: 'note', label: t('Note', 'Notes') },
]);
const SYN = {
  full_name: ['nome completo', 'nominativo', 'nome e cognome', 'cliente', 'client', 'full name', 'fullname', 'name', 'ragione sociale', 'contatto', 'contact'],
  first_name: ['nome', 'first name', 'firstname', 'first_name', 'given name', 'given'],
  last_name: ['cognome', 'surname', 'last name', 'lastname', 'last_name', 'family name'],
  phone: ['telefono', 'tel', 'tel.', 'cell', 'cellulare', 'mobile', 'phone', 'whatsapp', 'numero', 'number', 'recapito'],
  email: ['email', 'e-mail', 'mail', 'posta'],
  gender: ['genere', 'sesso', 'gender', 'sex'],
  birthday: ['compleanno', 'nascita', 'data di nascita', 'data nascita', 'birthday', 'birth', 'dob', 'born', 'birthdate', 'nato il', 'nata il'],
  categories: ['etichette', 'etichetta', 'tag', 'tags', 'categoria', 'categorie', 'labels', 'label', 'gruppo', 'gruppi', 'segmento'],
  origin: ['origine', 'fonte', 'provenienza', 'source', 'origin', 'come ci ha conosciuto', 'canale'],
  lang: ['lingua', 'language', 'lang', 'idioma'],
  note: ['note', 'notes', 'nota', 'commenti', 'commento', 'osservazioni', 'annotazioni', 'memo'],
};
const norm = (s) => String(s || '').toLowerCase().replace(/[_\-]/g, ' ').replace(/\s+/g, ' ').trim();
export function guessFieldByHeader(header) {
  const h = norm(header);
  if (!h) return 'ignore';
  // "nome" da solo è ambiguo: se c'è anche "cognome" lo decide guessMapping
  for (const [k, list] of Object.entries(SYN)) if (list.some((w) => h === w)) return k;
  for (const [k, list] of Object.entries(SYN)) if (list.some((w) => h.includes(w))) return k;
  return 'ignore';
}
const looksPhone = (v) => /^[+\d][\d\s./()-]{6,}$/.test(String(v || '').trim()) && (String(v).replace(/\D/g, '').length >= 8);
const looksEmail = (v) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(v || '').trim());
const looksDate = (v) => !!parseFlexibleDate(String(v || ''), 'dmy');
export function guessFieldByContent(values) {
  const vals = values.filter((v) => String(v || '').trim()).slice(0, 30);
  if (!vals.length) return 'ignore';
  const share = (fn) => vals.filter(fn).length / vals.length;
  if (share(looksEmail) > 0.6) return 'email';
  if (share(looksPhone) > 0.6) return 'phone';
  if (share(looksDate) > 0.6) return 'birthday';
  if (share((v) => !!parseGender(v)) > 0.8) return 'gender';
  return 'text';
}
export function looksLikeHeader(row) {
  return row.some((c) => guessFieldByHeader(c) !== 'ignore') && !row.some((c) => looksPhone(c) || looksEmail(c));
}
/** mappatura iniziale colonna → campo */
export function guessMapping(header, rows) {
  const n = Math.max(header?.length || 0, ...rows.map((r) => r.length));
  const map = [];
  const used = new Set();
  for (let i = 0; i < n; i++) {
    let k = header ? guessFieldByHeader(header[i]) : 'ignore';
    if (k === 'ignore' || !header) {
      const byContent = guessFieldByContent(rows.map((r) => r[i]));
      if (byContent !== 'text') k = byContent;
      else if (!header) k = 'text';
    }
    map.push(k);
  }
  // colonne di testo senza intestazione: prima = nome (o nome completo), seconda = cognome
  const textIdx = map.map((k, i) => (k === 'text' ? i : -1)).filter((i) => i >= 0);
  if (textIdx.length >= 2) { map[textIdx[0]] = 'first_name'; map[textIdx[1]] = 'last_name'; }
  else if (textIdx.length === 1) map[textIdx[0]] = 'full_name';
  // "nome" con "cognome" presente resta nome; "nome" senza cognome → nome completo
  if (map.includes('first_name') && !map.includes('last_name') && header) {
    const i = map.indexOf('first_name');
    if (norm(header[i]) === 'nome' || norm(header[i]) === 'name') map[i] = 'full_name';
  }
  return map.map((k) => {
    if (k === 'text') return 'ignore';
    if (used.has(k) && k !== 'ignore' && k !== 'categories' && k !== 'note') return 'ignore';
    used.add(k); return k;
  });
}

/* ---------- normalizzazione valori ---------- */
const MONTHS = { gen: 1, gennaio: 1, jan: 1, january: 1, feb: 2, febbraio: 2, february: 2, mar: 3, marzo: 3, march: 3, apr: 4, aprile: 4, april: 4, mag: 5, maggio: 5, may: 5, giu: 6, giugno: 6, jun: 6, june: 6, lug: 7, luglio: 7, jul: 7, july: 7, ago: 8, agosto: 8, aug: 8, august: 8, set: 9, settembre: 9, sep: 9, sept: 9, september: 9, ott: 10, ottobre: 10, oct: 10, october: 10, nov: 11, novembre: 11, november: 11, dic: 12, dicembre: 12, dec: 12, december: 12 };
const pad = (n) => String(n).padStart(2, '0');
const valid = (d, m) => m >= 1 && m <= 12 && d >= 1 && d <= new Date(2000, m, 0).getDate();
const fixYear = (y) => { if (y.length === 4) return Number(y); const n = Number(y); const cur = new Date().getFullYear() % 100; return n <= cur ? 2000 + n : 1900 + n; };
/** → 'YYYY-MM-DD' | '--MM-DD' | null. order: 'dmy' | 'mdy' per le date numeriche ambigue */
export function parseFlexibleDate(raw, order = 'dmy') {
  const s = String(raw || '').trim().toLowerCase();
  if (!s) return null;
  let m = /^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})(?:[ t].*)?$/.exec(s);
  if (m) { const y = +m[1], mo = +m[2], d = +m[3]; return valid(d, mo) ? `${y}-${pad(mo)}-${pad(d)}` : null; }
  m = /^--?(\d{1,2})-(\d{1,2})$/.exec(s);
  if (m) { const mo = +m[1], d = +m[2]; return valid(d, mo) ? `--${pad(mo)}-${pad(d)}` : null; }
  m = /^(\d{1,2})[-\/.](\d{1,2})(?:[-\/.](\d{2}|\d{4}))?$/.exec(s);
  if (m) {
    let a = +m[1], b = +m[2];
    let d = a, mo = b;
    if (order === 'mdy') { d = b; mo = a; }
    if (!valid(d, mo) && valid(mo, d)) { [d, mo] = [mo, d]; } // unico ordine possibile
    if (!valid(d, mo)) return null;
    return m[3] ? `${fixYear(m[3])}-${pad(mo)}-${pad(d)}` : `--${pad(mo)}-${pad(d)}`;
  }
  m = /^(\d{1,2})\s+([a-zà-ú]+)\.?(?:\s+(\d{4}))?$/.exec(s);
  if (m) { const mo = MONTHS[m[2]] || MONTHS[m[2].slice(0, 3)]; const d = +m[1]; if (!mo || !valid(d, mo)) return null; return m[3] ? `${m[3]}-${pad(mo)}-${pad(d)}` : `--${pad(mo)}-${pad(d)}`; }
  m = /^([a-z]+)\s+(\d{1,2})(?:,?\s+(\d{4}))?$/.exec(s);
  if (m) { const mo = MONTHS[m[1]] || MONTHS[m[1].slice(0, 3)]; const d = +m[2]; if (!mo || !valid(d, mo)) return null; return m[3] ? `${m[3]}-${pad(mo)}-${pad(d)}` : `--${pad(mo)}-${pad(d)}`; }
  return null;
}
export function parseGender(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (!s) return '';
  if (/^(f|femm\w*|donna|woman|female|w|she|signora|sig\.?ra)$/.test(s)) return 'female';
  if (/^(m|masc\w*|uomo|man|male|he|signore|sig\.?)$/.test(s)) return 'male';
  if (/^(altro|other|x|nb|non binario|non-binary)$/.test(s)) return 'other';
  return '';
}
const parseLang = (raw) => { const s = String(raw || '').trim().toLowerCase(); if (/^(it|ita|italiano|italian)$/.test(s)) return 'it'; if (/^(en|eng|english|inglese)$/.test(s)) return 'en'; return ''; };
const cleanPhone = (raw) => String(raw || '').replace(/[^\d+]/g, ' ').replace(/\s+/g, ' ').trim().replace(/\s/g, '');
const phoneKey = (p) => { let d = String(p || '').replace(/\D/g, ''); if (d.startsWith('0039')) d = d.slice(4); else if (d.startsWith('39') && d.length > 10) d = d.slice(2); return d; };

/** applica la mappatura → righe normalizzate con avvisi */
export function buildRows(dataRows, mapping, { dateOrder = 'dmy' } = {}) {
  const out = [];
  const seenPhones = new Map();
  dataRows.forEach((cells, idx) => {
    const r = { first_name: '', last_name: '', phone: '', email: '', gender: '', birthday: '', origin: '', lang: '', note: '', categories: [] };
    const warn = [];
    let full = '';
    mapping.forEach((k, i) => {
      const v = String(cells[i] ?? '').trim();
      if (!v || k === 'ignore') return;
      if (k === 'full_name') full = v;
      else if (k === 'phone') { r.phone = cleanPhone(v); if (!phoneKey(r.phone)) { warn.push('phone'); r.phone = ''; } }
      else if (k === 'gender') { r.gender = parseGender(v); if (!r.gender) warn.push('gender:' + v); }
      else if (k === 'birthday') { const b = parseFlexibleDate(v, dateOrder); if (b) r.birthday = b; else warn.push('birthday:' + v); }
      else if (k === 'categories') r.categories = [...r.categories, ...v.split(/[,;|/]+/).map((x) => x.trim()).filter(Boolean)];
      else if (k === 'lang') r.lang = parseLang(v);
      else if (k === 'note') r.note = r.note ? r.note + '\n' + v : v;
      else if (k === 'email') { if (looksEmail(v)) r.email = v; else warn.push('email:' + v); }
      else r[k] = v;
    });
    if (full && !r.first_name) { const parts = full.split(/\s+/); r.first_name = parts[0]; r.last_name = r.last_name || parts.slice(1).join(' '); }
    else if (full && !r.last_name) { r.last_name = full.replace(r.first_name, '').trim(); }
    if (!r.first_name) warn.push('name');
    if (!r.phone) warn.push('nophone');
    if (r.phone) { const k = phoneKey(r.phone); if (seenPhones.has(k)) warn.push('dup:' + (seenPhones.get(k) + 1)); else seenPhones.set(k, idx); }
    out.push({ ...r, _idx: idx, _warn: warn, _skip: !r.first_name || (!r.phone && !r.email) });
  });
  return out;
}

/* ---------- componente ---------- */
/* Fuori dal componente: ridefinito a ogni render sarebbe un tipo nuovo ogni
 * volta e React rimonterebbe la barra a ogni tasto premuto. */
const Steps = ({ step }) => (
  <div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
    {[1, 2, 3].map((n) => <span key={n} style={{ flex: 1, height: 4, borderRadius: 99, background: n <= step ? 'var(--clay)' : 'var(--hair)' }} />)}
  </div>
);

export default function BulkImportModal({ onClose }) {
  const { t, lang, fireToast } = useDash();
  const [step, setStep] = useState(1);
  const [file, setFile] = useState(null);
  const [encoding, setEncoding] = useState('utf-8');
  const [text, setText] = useState('');
  const [delim, setDelim] = useState(null);      // null = auto
  const [hasHeader, setHasHeader] = useState(null); // null = auto
  const [mapping, setMapping] = useState(null);
  const [dateOrder, setDateOrder] = useState('dmy');
  const [updateExisting, setUpdateExisting] = useState(true);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState(null);
  const fileRef = useRef(null);
  const FIELD_LIST = FIELDS(t);

  const effDelim = delim || (text ? detectDelimiter(text) : ',');
  const table = useMemo(() => (text ? parseCsv(text, effDelim) : []), [text, effDelim]);
  const headerAuto = table.length ? looksLikeHeader(table[0]) : false;
  const effHeader = hasHeader == null ? headerAuto : hasHeader;
  const header = effHeader ? table[0] : null;
  const dataRows = effHeader ? table.slice(1) : table;
  const nCols = Math.max(header?.length || 0, ...dataRows.map((r) => r.length), 0);
  const effMapping = mapping && mapping.length === nCols ? mapping : guessMapping(header, dataRows);
  const rows = useMemo(() => buildRows(dataRows, effMapping, { dateOrder }), [dataRows, effMapping, dateOrder]);
  const ready = rows.filter((r) => !r._skip);
  const mappedKeys = new Set(effMapping);
  const mojibake = /[ÃÂ][\x80-\xBF]|�/.test(text);

  const readFile = (f, enc) => {
    const r = new FileReader();
    r.onload = () => { setText(String(r.result)); setMapping(null); setStep(2); };
    r.readAsText(f, enc);
  };
  const onFile = (e) => { const f = e.target.files?.[0]; if (!f) return; setFile(f); readFile(f, encoding); e.target.value = ''; };
  const changeEncoding = (enc) => { setEncoding(enc); if (file) readFile(file, enc); };

  const doImport = async () => {
    setBusy(true); setProgress(0);
    const payload = ready.map(({ _idx, _warn, _skip, ...r }) => r);
    const CHUNK = 250;
    const total = { created: 0, updated: 0, skipped: 0, errors: [] };
    try {
      for (let i = 0; i < payload.length; i += CHUNK) {
        const res = await api.post('/api/clients/import', { rows: payload.slice(i, i + CHUNK), update_existing: updateExisting });
        total.created += res.created; total.updated += res.updated; total.skipped += res.skipped || 0;
        // Il server numera gli errori dentro il blocco inviato: `e.row + i` è
        // l'indice in `payload`, che salta le righe scartate. Chi corregge il
        // file cerca però la riga del FILE, la stessa numerata nell'anteprima
        // del passo 3: si riporta l'indice originale (`_idx`).
        (res.errors || []).forEach((e) => {
          const k = e.row + i;
          const src = ready[k];
          total.errors.push({
            ...e,
            row: src ? src._idx : k,
            name: `${payload[k]?.first_name || ''} ${payload[k]?.last_name || ''}`.trim(),
          });
        });
        setProgress(Math.min(100, Math.round(((i + CHUNK) / payload.length) * 100)));
      }
      total.skipped += rows.length - ready.length;
      setResult(total);
      fireToast({ msg: t(`Importati ${total.created} nuovi · ${total.updated} aggiornati`, `${total.created} added · ${total.updated} updated`), icon: 'check' });
    } catch (err) {
      fireToast({ msg: err instanceof ApiError ? err.message : t('Errore di rete', 'Network error'), icon: 'alert' });
    } finally { setBusy(false); }
  };

  const warnLabel = (w) => {
    const [k, v] = w.split(':');
    return ({
      name: t('nome mancante', 'missing name'), nophone: t('senza telefono: verrà cercato per email', 'no phone: matched by email only'), phone: t('telefono non valido', 'invalid phone'),
      gender: t(`genere non riconosciuto: “${v}”`, `unrecognised gender: “${v}”`), birthday: t(`data non riconosciuta: “${v}”`, `unrecognised date: “${v}”`), email: t(`email non valida: “${v}”`, `invalid email: “${v}”`),
      dup: t(`stesso telefono della riga ${v}`, `same phone as row ${v}`),
    })[k] || w;
  };

  /* ---- esito ---- */
  if (result) {
    return (
      <DkModal open onClose={onClose} title={t('Importazione completata', 'Import complete')} width={520}
        foot={<button className="dk-btn dk-btn--clay" onClick={onClose}><Icon name="check" size={16} color="#fff" />{t('Chiudi', 'Close')}</button>}>
        <div style={{ display: 'flex', gap: 10, padding: '8px 0 14px' }}>
          {[[result.created, t('nuovi clienti', 'new clients'), 'plus', 'var(--ok)', 'var(--ok-tint)'], [result.updated, t('aggiornati', 'updated'), 'refresh', 'var(--warn)', 'var(--warn-tint)'], [result.skipped, t('saltati', 'skipped'), 'x', 'var(--muted)', 'var(--paper-2)']].map(([n, l, icon, c, bg]) => (
            <div key={l} className="dk-card" style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 10, padding: 14, boxShadow: 'none', border: '1px solid var(--hair)' }}>
              <div style={{ width: 36, height: 36, borderRadius: 10, background: bg, display: 'grid', placeItems: 'center' }}><Icon name={icon} size={17} color={c} /></div>
              <div><div className="t-num" style={{ fontSize: 22, lineHeight: 1 }}>{n}</div><div className="t-sm" style={{ color: 'var(--muted)', marginTop: 2 }}>{l}</div></div>
            </div>
          ))}
        </div>
        {result.errors.length > 0 && (
          <div>
            <div className="t-meta" style={{ marginBottom: 6 }}>{t('Righe non importate', 'Rows not imported')} · {result.errors.length}</div>
            <div className="dk-card" style={{ maxHeight: 200, overflowY: 'auto', boxShadow: 'none', border: '1px solid var(--hair)' }}>
              {result.errors.map((e, i) => <div key={i} className="t-sm" style={{ padding: '7px 12px', borderTop: i ? '1px solid var(--hair)' : 'none' }}><b>{t('Riga', 'Row')} {e.row + 1}</b>{e.name ? ` · ${e.name}` : ''} — {e.reason}</div>)}
            </div>
          </div>
        )}
      </DkModal>
    );
  }

  const stepTitle = ['', t('1 · Sorgente', '1 · Source'), t('2 · Colonne', '2 · Columns'), t('3 · Verifica', '3 · Review')][step];

  return (
    <DkModal open onClose={onClose} title={t('Importa clienti', 'Import clients')} sub={stepTitle} width={780}
      foot={<React.Fragment>
        <span className="t-sm" style={{ marginRight: 'auto', color: 'var(--muted)' }}>
          {table.length ? t(`${dataRows.length} righe · ${ready.length} importabili`, `${dataRows.length} rows · ${ready.length} importable`) : ''}
        </span>
        {step > 1 && <button className="dk-btn dk-btn--ghost" onClick={() => setStep(step - 1)} disabled={busy}><Icon name="chevL" size={15} />{t('Indietro', 'Back')}</button>}
        <button className="dk-btn dk-btn--ghost" onClick={onClose} disabled={busy}>{t('Annulla', 'Cancel')}</button>
        {step < 3 ? (
          <button className="dk-btn dk-btn--clay" aria-disabled={!table.length} onClick={() => { if (!table.length) { fireToast({ msg: t('Carica un file o incolla i dati', 'Upload a file or paste data'), icon: 'alert' }); return; } if (step === 2 && !mappedKeys.has('phone') && !mappedKeys.has('email')) { fireToast({ msg: t('Serve almeno la colonna Telefono (o Email)', 'Map at least the Phone (or Email) column'), icon: 'alert' }); return; } setStep(step + 1); }}>
            {t('Avanti', 'Next')}<Icon name="chevR" size={15} color="#fff" />
          </button>
        ) : (
          <button className="dk-btn dk-btn--clay" aria-disabled={!ready.length || busy} onClick={() => ready.length && !busy && doImport()}>
            <Icon name="check" size={16} color="#fff" />{busy ? t(`Importo… ${progress}%`, `Importing… ${progress}%`) : t(`Importa ${ready.length} client${ready.length === 1 ? 'e' : 'i'}`, `Import ${ready.length} client${ready.length === 1 ? '' : 's'}`)}
          </button>
        )}
      </React.Fragment>}>
      <Steps step={step} />

      {/* ── 1. sorgente ── */}
      {step === 1 && (
        <div>
          <div onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files?.[0]; if (f) { setFile(f); readFile(f, encoding); } }}
            onClick={() => fileRef.current?.click()} role="button" tabIndex={0}
            style={{ border: '1.5px dashed var(--line-strong)', borderRadius: 14, padding: '22px 20px', textAlign: 'center', cursor: 'pointer', background: 'var(--surface-2)', marginBottom: 14 }}>
            <input ref={fileRef} type="file" accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values,text/plain" onChange={onFile} style={{ display: 'none' }} />
            <Icon name="arrowDn" size={22} color="var(--clay-ink)" style={{ margin: '0 auto 8px' }} />
            <div style={{ fontWeight: 700, fontSize: 14.5 }}>{t('Trascina qui il file, oppure clicca per sceglierlo', 'Drop the file here, or click to choose it')}</div>
            <div className="t-sm" style={{ color: 'var(--muted)', marginTop: 4 }}>{t('CSV, TSV o testo: da Excel, Numbers, Google Fogli, altri gestionali. Le colonne le scegli al passo dopo.', 'CSV, TSV or text: from Excel, Numbers, Google Sheets, other software. You pick the columns next.')}</div>
            {file && <div className="t-sm" style={{ marginTop: 8, fontWeight: 700, color: 'var(--ink)' }}>{file.name} · {Math.round(file.size / 1024)} KB</div>}
          </div>
          <div className="t-meta" style={{ marginBottom: 6 }}>{t('oppure incolla', 'or paste')}</div>
          <textarea value={text} onChange={(e) => { setText(e.target.value); setMapping(null); setFile(null); }} rows={6} placeholder={'Nome;Cognome;Telefono;Email;Genere;Compleanno\nSofia;Ricci;+39 348 221 0094;sofia@email.it;F;15/03\nGiada;Neri;333 118 4420;;donna;24/12/1990'} style={{ ...inputCss, fontFamily: 'var(--mono, monospace)', fontSize: 12.5, resize: 'vertical' }} />
          {text && (
            <div style={{ display: 'flex', gap: 14, alignItems: 'center', marginTop: 10, flexWrap: 'wrap' }}>
              <label className="t-sm" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>{t('Separatore', 'Delimiter')}
                <select value={delim || 'auto'} onChange={(e) => { setDelim(e.target.value === 'auto' ? null : e.target.value); setMapping(null); }} style={{ ...inputCss, width: 'auto', padding: '5px 8px', fontSize: 12.5 }}>
                  <option value="auto">{t('automatico', 'auto')} ({effDelim === '\t' ? 'TAB' : effDelim})</option><option value=",">,</option><option value=";">;</option><option value={'\t'}>TAB</option><option value="|">|</option>
                </select>
              </label>
              {file && (
                <label className="t-sm" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>{t('Codifica', 'Encoding')}
                  <select value={encoding} onChange={(e) => changeEncoding(e.target.value)} style={{ ...inputCss, width: 'auto', padding: '5px 8px', fontSize: 12.5 }}>
                    <option value="utf-8">UTF-8</option><option value="windows-1252">Windows-1252 (Excel IT)</option><option value="iso-8859-1">ISO-8859-1</option>
                  </select>
                  {mojibake && <span style={{ color: 'var(--warn)', fontWeight: 700 }}>{t('accenti strani? prova Windows-1252', 'odd accents? try Windows-1252')}</span>}
                </label>
              )}
              <span className="t-sm" style={{ color: 'var(--muted)' }}>{table.length} {t('righe rilevate', 'rows detected')}</span>
            </div>
          )}
        </div>
      )}

      {/* ── 2. mappatura colonne ── */}
      {step === 2 && (
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 12, flexWrap: 'wrap' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 600 }}>
              <Toggle on={effHeader} onChange={(v) => { setHasHeader(v); setMapping(null); }} />{t('La prima riga è l’intestazione', 'First row is the header')}
              {hasHeader == null && <span className="t-sm" style={{ color: 'var(--muted-2)' }}>· {t('rilevato', 'detected')}</span>}
            </label>
            <div style={{ flex: 1 }} />
            <button type="button" onClick={() => setMapping(null)} style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--clay-ink)', cursor: 'pointer', background: 'transparent', border: 'none' }}>{t('Rileva di nuovo', 'Auto-detect again')}</button>
          </div>
          <div className="t-sm" style={{ color: 'var(--muted)', marginBottom: 10 }}>{t('Per ogni colonna del file scegli il campo di destinazione. “Nome e cognome” viene diviso alla prima parola; le etichette si separano con virgola, punto e virgola o barra.', 'For each file column pick the destination field. “Full name” is split at the first word; labels may be separated by comma, semicolon or slash.')}</div>
          <div style={{ overflowX: 'auto', border: '1px solid var(--hair)', borderRadius: 12 }}>
            <table style={{ borderCollapse: 'collapse', minWidth: '100%', fontSize: 12.5 }}>
              <thead>
                <tr style={{ background: 'var(--surface-2)' }}>
                  {[...Array(nCols)].map((_, i) => (
                    <th key={i} style={{ padding: '8px 8px', textAlign: 'left', borderBottom: '1px solid var(--hair)', minWidth: 150, verticalAlign: 'top' }}>
                      <div className="t-sm" style={{ color: 'var(--muted-2)', fontSize: 11, marginBottom: 4, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 170 }}>{header ? header[i] || t(`Colonna ${i + 1}`, `Column ${i + 1}`) : t(`Colonna ${i + 1}`, `Column ${i + 1}`)}</div>
                      <select value={effMapping[i]} onChange={(e) => { const m = [...effMapping]; m[i] = e.target.value; setMapping(m); }}
                        style={{ ...inputCss, padding: '6px 8px', fontSize: 12.5, fontWeight: effMapping[i] === 'ignore' ? 500 : 700, color: effMapping[i] === 'ignore' ? 'var(--muted)' : 'var(--ink)', borderColor: effMapping[i] === 'ignore' ? 'var(--hair)' : 'var(--clay)' }}>
                        {FIELD_LIST.map((f) => <option key={f.k} value={f.k}>{f.label}</option>)}
                      </select>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {dataRows.slice(0, 5).map((r, ri) => (
                  <tr key={ri}>{[...Array(nCols)].map((_, i) => <td key={i} style={{ padding: '6px 8px', borderTop: '1px solid var(--hair-2)', color: effMapping[i] === 'ignore' ? 'var(--muted-2)' : 'var(--ink-2)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 200 }}>{r[i] || <span style={{ color: 'var(--faint)' }}>—</span>}</td>)}</tr>
                ))}
              </tbody>
            </table>
          </div>
          {mappedKeys.has('birthday') && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 12, flexWrap: 'wrap' }}>
              <span className="t-sm" style={{ fontWeight: 600 }}>{t('Date numeriche ambigue (es. 03/04):', 'Ambiguous numeric dates (e.g. 03/04):')}</span>
              {[['dmy', t('giorno/mese/anno', 'day/month/year')], ['mdy', t('mese/giorno/anno', 'month/day/year')]].map(([k, l]) => (
                <button key={k} type="button" onClick={() => setDateOrder(k)} className={'dk-pill' + (dateOrder === k ? ' dk-pill--on' : '')} style={{ padding: '4px 10px', fontSize: 12 }}>{l}</button>
              ))}
              <span className="t-sm" style={{ color: 'var(--muted-2)' }}>{t('Accettati anche 15/03 senza anno, 2024-03-15, “15 marzo 1990”.', 'Also accepted: 15/03 without year, 2024-03-15, “15 March 1990”.')}</span>
            </div>
          )}
          {!mappedKeys.has('phone') && <div style={{ marginTop: 10, display: 'flex', gap: 8, alignItems: 'center', color: 'var(--warn)', fontSize: 12.5, fontWeight: 600 }}><Icon name="alert" size={14} color="var(--warn)" />{t('Nessuna colonna Telefono: i nuovi clienti non possono essere creati senza numero (gli esistenti si aggiornano per email).', 'No Phone column: new clients cannot be created without a number (existing ones update by email).')}</div>}
        </div>
      )}

      {/* ── 3. verifica ── */}
      {step === 3 && (
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 600 }}>
              <Toggle on={updateExisting} onChange={setUpdateExisting} />
              <span>{t('Aggiorna i clienti già in rubrica', 'Update clients already on file')} <span className="t-sm" style={{ color: 'var(--muted)', fontWeight: 500 }}>· {t('stesso telefono o email; i campi vuoti nel file non cancellano nulla', 'same phone or email; blank cells never erase data')}</span></span>
            </label>
          </div>
          <div className="dk-card" style={{ overflow: 'hidden', maxHeight: 340, overflowY: 'auto', boxShadow: 'none', border: '1px solid var(--hair)' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '34px 1.4fr 1fr 1.2fr 70px 1fr 1fr', gap: 8, padding: '8px 12px', background: 'var(--surface-2)', borderBottom: '1px solid var(--hair)', position: 'sticky', top: 0 }}>
              {['#', t('Nome', 'Name'), t('Telefono', 'Phone'), 'Email', t('Gen.', 'Gen.'), t('Compleanno', 'Birthday'), t('Etichette / note', 'Labels / notes')].map((h) => <span key={h} className="t-meta" style={{ fontSize: 10 }}>{h}</span>)}
            </div>
            {rows.slice(0, 200).map((r) => (
              <div key={r._idx} style={{ display: 'grid', gridTemplateColumns: '34px 1.4fr 1fr 1.2fr 70px 1fr 1fr', gap: 8, padding: '7px 12px', borderTop: '1px solid var(--hair-2)', alignItems: 'center', fontSize: 12.5, opacity: r._skip ? 0.55 : 1, background: r._skip ? 'var(--danger-tint)' : r._warn.length ? 'color-mix(in srgb, var(--warn-tint) 60%, transparent)' : 'transparent' }}>
                <span className="t-sm tabnum" style={{ color: 'var(--muted-2)' }}>{r._idx + 1}</span>
                <span style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{[r.first_name, r.last_name].filter(Boolean).join(' ') || <span style={{ color: 'var(--danger)' }}>{t('nome mancante', 'missing name')}</span>}</span>
                <span className="tabnum" style={{ color: r.phone ? 'var(--ink-2)' : 'var(--muted-2)' }}>{r.phone || '—'}</span>
                <span style={{ color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.email || '—'}</span>
                <span style={{ color: 'var(--muted)' }}>{r.gender === 'female' ? '♀' : r.gender === 'male' ? '♂' : r.gender === 'other' ? '⚧' : '—'}</span>
                <span style={{ color: 'var(--muted)' }}>{r.birthday ? formatBirthday(r.birthday, lang) : '—'}</span>
                <span style={{ color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={[...r.categories, r.note].filter(Boolean).join(' · ')}>{[...r.categories, r.note ? '📝' : ''].filter(Boolean).join(', ') || '—'}</span>
                {r._warn.length > 0 && <div style={{ gridColumn: '2 / -1', display: 'flex', gap: 6, flexWrap: 'wrap' }}>{r._warn.map((w) => <span key={w} style={{ fontSize: 11, fontWeight: 600, color: r._skip && (w === 'name' || w === 'nophone') ? 'var(--danger)' : 'var(--warn)', display: 'inline-flex', alignItems: 'center', gap: 3 }}><Icon name="alert" size={10} color="currentColor" />{warnLabel(w)}</span>)}</div>}
              </div>
            ))}
            {rows.length > 200 && <div className="t-sm" style={{ padding: '8px 12px', color: 'var(--muted-2)' }}>{t(`… e altre ${rows.length - 200} righe`, `… and ${rows.length - 200} more rows`)}</div>}
          </div>
          <div className="t-sm" style={{ color: 'var(--muted)', marginTop: 8 }}>
            {t(`${ready.length} righe verranno importate`, `${ready.length} rows will be imported`)}{rows.length - ready.length > 0 ? t(` · ${rows.length - ready.length} saltate (senza nome o senza telefono/email)`, ` · ${rows.length - ready.length} skipped (no name or no phone/email)`) : ''}. {t('Le etichette non ancora esistenti vengono create; le note diventano note private sulla scheda.', 'Labels that do not exist yet are created; notes become private notes on the profile.')}
          </div>
        </div>
      )}
    </DkModal>
  );
}
