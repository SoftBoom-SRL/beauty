// lib.js — staff section helpers: availability meta (prototype AVAIL_STATUS styling),
// minutes↔"HH:MM" conversions, weekly-pattern (de)serialization, local GD palette.
import { WEEKDAYS_SHORT_EN, WEEKDAYS_SHORT_IT, todayStr } from '@youty/shared';

/* ---- availability / absence meta — ported from prototype AVAIL_STATUS ----
 * Keys follow the API: absence type ∈ vacation | holiday | other, plus the
 * synthetic work / off states used by the today-status pill. */
export const AVAIL_META = {
  work:     { it: 'Lavorativa',    en: 'Working',  c: '#3F9D6B', bg: 'rgba(63,157,107,0.14)' },
  off:      { it: 'Giorno libero', en: 'Day off',  c: '#6F6E74', bg: 'rgba(111,110,116,0.12)' },
  vacation: { it: 'Ferie',         en: 'Vacation', c: '#5FAEC9', bg: 'rgba(95,174,201,0.16)' },
  holiday:  { it: 'Festività',     en: 'Holiday',  c: '#B26A4F', bg: 'rgba(178,106,79,0.16)' },
  other:    { it: 'Altro',         en: 'Other',    c: '#8A5A6E', bg: 'rgba(138,90,110,0.14)' },
  // fuori dal rapporto di lavoro (prima di «nel team dal», dopo «fino al»)
  out:      { it: 'Non in team',   en: 'Not on the team', c: '#9A98A0', bg: 'repeating-linear-gradient(135deg, var(--paper-2) 0 4px, transparent 4px 8px)' },
};

/* ---- il rapporto di lavoro: nel team dal / fino al ----
 * Fuori da quei giorni l'operatrice non ha turni (il server, shift_windows):
 * il riempimento dei mesi passati contava i turni di chi è arrivata dopo come
 * capacità vuota (il titolare, 16/10). */

/** «before» se `dateStr` viene prima di `from`, «after» se dopo `until`
 *  (estremi compresi, date «YYYY-MM-DD» o vuote), null se è nel team. */
export function outOfTeam(dateStr, from, until) {
  const d = String(dateStr).slice(0, 10);
  if (from && d < from) return 'before';
  if (until && d > until) return 'after';
  return null;
}

/** La parola per un giorno fuori dal rapporto di lavoro. */
export const outLabel = (out, t) => (out === 'after' ? t('Non più in team', 'No longer on the team') : t('Non ancora in team', 'Not on the team yet'));

/** «3 feb 2026»: una data pura, già nel giorno del salone. */
export function dayShort(dateStr, lang) {
  const [y, m, d] = String(dateStr).slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(lang === 'en' ? 'en-GB' : 'it-IT', { day: 'numeric', month: 'short', year: 'numeric' }).replace('.', '');
}
export const ABSENCE_TYPES = ['vacation', 'holiday', 'other'];

/* ---- weekday / month labels (weekday 0 = Monday, as the API) ----
 * Le tabelle sono quelle di @youty/shared: qui le coppie [it, en] dei giorni
 * (si leggono come WEEKDAYS[giorno][0|1]) e i mesi con la maiuscola. */
export const WEEKDAYS = WEEKDAYS_SHORT_IT.map((it, i) => [it, WEEKDAYS_SHORT_EN[i]]);
export { MONTHS_LONG_IT as MONTHS_IT, MONTHS_LONG_EN as MONTHS_EN } from '@youty/shared';

/** "YYYY-MM" → short localized month label ("Giu" / "Jun") */
export function monthShort(ym, lang) {
  const [y, m] = ym.split('-').map(Number);
  const s = new Date(y, m - 1, 1).toLocaleDateString(lang === 'en' ? 'en-GB' : 'it-IT', { month: 'short' });
  return s.charAt(0).toUpperCase() + s.slice(1).replace('.', '');
}

/* ---- minutes ↔ "HH:MM" ---- */

/** minutes from midnight → compact label: 540 → "9", 570 → "9:30" */
export function minCompact(min) {
  const h = Math.floor(min / 60), m = min % 60;
  return m ? `${h}:${String(m).padStart(2, '0')}` : String(h);
}

/** "HH:MM" (from API windows) → compact label: "09:00" → "9", "09:30" → "9:30" */
export function hmCompact(hm) {
  const [h, m] = hm.split(':').map(Number);
  return m ? `${h}:${String(m).padStart(2, '0')}` : String(h);
}

/** windows [["09:00","13:00"],["14:00","19:00"]] → "9–13 · 14–19" */
export function fmtWindows(windows) {
  return (windows || []).map(([a, b]) => `${hmCompact(a)}–${hmCompact(b)}`).join(' · ');
}

/** "9" | "9:30" | "09.30" → minutes from midnight, or null if not a time */
export function hmToMin(s) {
  const m = /^(\d{1,2})(?:[:.](\d{1,2}))?$/.exec(String(s).trim());
  if (!m) return null;
  const h = +m[1], mm = m[2] ? +m[2] : 0;
  if (h > 24 || mm > 59) return null;
  return h * 60 + mm;
}

/** Range text → [startMin, endMin].
 *  Returns null for "empty / day off" ("", "—", "riposo", "off"),
 *  undefined for text that looks wrong (so the caller can flag it). */
export function parseRange(str) {
  const txt = String(str || '').trim();
  if (!txt || txt === '—' || txt === '-' || /^(ripos|off|rest|libero)/i.test(txt)) return null;
  const parts = txt.split(/\s*[–—-]\s*/).filter(Boolean);
  if (parts.length !== 2) return undefined;
  const a = hmToMin(parts[0]), b = hmToMin(parts[1]);
  if (a == null || b == null || b <= a) return undefined;
  return [a, b];
}

/** [startMin, endMin] → "9–19" / "9:30–18" */
export function fmtRange(a, b) { return `${minCompact(a)}–${minCompact(b)}`; }

/* ---- weekly pattern ↔ editor rows ----
 * Editor model: weeks = [{ days: [{ hours: "9–19"|"", brk: "13–14"|"" } × 7] }]
 * API model:    shifts = [{ week_index, weekday, start_min, end_min, break_start_min?, break_end_min? }]
 */

const emptyDay = () => ({ hours: '', brk: '' });
export const emptyWeek = () => ({ days: Array.from({ length: 7 }, emptyDay) });

/** WeeklyShiftOut[] + cycle_weeks → editor weeks. Multiple rows on the same
 *  (week, day) — split shifts — are merged into span + first gap as break. */
export function weeksFromShifts(shifts, cycleWeeks) {
  const n = Math.max(1, cycleWeeks || 1);
  const weeks = Array.from({ length: n }, emptyWeek);
  const byDay = {};
  (shifts || []).forEach((s) => {
    const wi = Math.min(s.week_index || 0, n - 1);
    (byDay[`${wi}:${s.weekday}`] = byDay[`${wi}:${s.weekday}`] || []).push(s);
  });
  Object.entries(byDay).forEach(([key, rows]) => {
    const [wi, di] = key.split(':').map(Number);
    rows.sort((a, b) => a.start_min - b.start_min);
    const day = weeks[wi].days[di];
    if (rows.length === 1) {
      const r = rows[0];
      day.hours = fmtRange(r.start_min, r.end_min);
      day.brk = r.break_start_min != null && r.break_end_min != null ? fmtRange(r.break_start_min, r.break_end_min) : '';
    } else {
      // split shift → one span with the first gap as break
      const first = rows[0], last = rows[rows.length - 1];
      day.hours = fmtRange(first.start_min, last.end_min);
      day.brk = rows[1].start_min > first.end_min ? fmtRange(first.end_min, rows[1].start_min) : '';
    }
  });
  return weeks;
}

/** Editor weeks → WeeklyShiftIn[]. Throws Error with a localized message
 *  (day label + reason) on unparsable input. */
export function shiftsFromWeeks(weeks, t) {
  const rows = [];
  weeks.forEach((w, wi) => {
    w.days.forEach((d, di) => {
      const label = t(WEEKDAYS[di][0], WEEKDAYS[di][1]) + (weeks.length > 1 ? ` · ${t('sett.', 'wk')} ${wi + 1}` : '');
      const range = parseRange(d.hours);
      if (range === undefined) throw new Error(t(`Orario non valido (${label})`, `Invalid hours (${label})`));
      if (range === null) {
        if (String(d.brk || '').trim() && parseRange(d.brk) !== null) {
          throw new Error(t(`Pausa senza orario (${label})`, `Break without hours (${label})`));
        }
        return; // day off
      }
      const [start, end] = range;
      const brk = parseRange(d.brk);
      if (brk === undefined) throw new Error(t(`Pausa non valida (${label})`, `Invalid break (${label})`));
      if (brk && !(start <= brk[0] && brk[1] <= end)) {
        throw new Error(t(`La pausa deve stare dentro l'orario (${label})`, `Break must be inside the hours (${label})`));
      }
      rows.push({
        week_index: wi,
        weekday: di,
        start_min: start,
        end_min: end,
        break_start_min: brk ? brk[0] : null,
        break_end_min: brk ? brk[1] : null,
      });
    });
  });
  return rows;
}

/* ---- quale settimana del ciclo è quella in corso ----
 * La formula è quella del server (`_week_index` in apps/staff/services.py):
 * si contano le settimane TRASCORSE, `((ordinale − 1) / 7) % settimane`, non
 * il numero di settimana ISO. ISO riparte da 1 a ogni capodanno e negli anni
 * da 53 settimane (2026 lo è) la 53ª e la 1ª successiva cadono sullo stesso
 * indice: con la vecchia formula dal 4 gennaio 2027 il ciclo a due settimane
 * restava invertito per sempre rispetto al server, e chi modificava «questa
 * settimana» finiva per toccare l'altra.
 * L'ordinale 1 (0001-01-01) è un lunedì, quindi l'indice cambia esattamente al
 * cambio di settimana; 1970-01-01 ha ordinale 719163. */
const EPOCH_ORDINAL = 719163;
export function cycleWeekIndex(dateStr, cycleWeeks) {
  const [y, m, d] = String(dateStr).slice(0, 10).split('-').map(Number);
  const ordinal = Math.round(Date.UTC(y, m - 1, d) / 86400000) + EPOCH_ORDINAL;
  return Math.floor((ordinal - 1) / 7) % Math.max(1, cycleWeeks || 1);
}
/** Il giorno è quello del SALONE: a cavallo della mezzanotte una postazione su
 *  un altro fuso evidenziava la settimana sbagliata. */
export function currentWeekIndex(cycleWeeks) {
  return cycleWeekIndex(todayStr(), cycleWeeks);
}

/* ---- il pattern su un giorno vero ----
 * Il calendario della scheda mostrava solo le assenze: come sarebbe venuto il
 * ciclo (il giorno libero che scorre di settimana in settimana) non si vedeva
 * da nessuna parte, prima di salvarlo e andare in agenda (il titolare, 16/10). */

/** Che cosa dice il pattern `weeks` (anche non salvato) per il giorno
 *  `dateStr`: { kind, week, label, brk } con kind ∈ work | off | closed | bad | out.
 *  `week` = la settimana del ciclo (0 = la prima, come cycleWeekIndex);
 *  `closed`: il centro quel giorno è chiuso (`openingWeek` = gli orari del
 *  centro, {} se non impostati), e allora il turno non conta; `bad`: l'orario
 *  scritto non si legge (`label` = il testo); `out`: fuori dal rapporto di
 *  lavoro (`period` = { from, until } della scheda, anche non salvate; `out`
 *  = «before» | «after»). */
export function patternDay(weeks, dateStr, openingWeek = null, period = null) {
  const n = Math.max(1, (weeks || []).length);
  const week = cycleWeekIndex(dateStr, n);
  const out = period ? outOfTeam(dateStr, period.from, period.until) : null;
  if (out) return { kind: 'out', week, out };
  const [y, m, d] = String(dateStr).split('-').map(Number);
  const dow = (new Date(y, m - 1, d).getDay() + 6) % 7;   // 0 = lunedì
  if (openingWeek && Object.keys(openingWeek).length && !(openingWeek[String(dow)] || []).length) return { kind: 'closed', week };
  const day = weeks?.[week]?.days?.[dow];
  const range = parseRange(day?.hours);
  if (range === undefined) return { kind: 'bad', week, label: day.hours };
  if (range === null) return { kind: 'off', week };
  const brk = parseRange(day.brk);
  return { kind: 'work', week, label: fmtRange(range[0], range[1]), brk: brk ? fmtRange(brk[0], brk[1]) : '' };
}

/* ---- turni del team: la copertura di un giorno ----
 * Ognuna si controllava sulla sua scheda: un sabato pomeriggio senza nessuna
 * in turno si scopriva in agenda, quando una cliente non trovava posto. */

const hm = (s) => { const [h, m] = String(s).split(':').map(Number); return h * 60 + (m || 0); };

/** La copertura di un giorno di GET /api/staff/roster: `working` = quante
 *  sono in turno su `total`; `slots` = mezz'ora per mezz'ora quante ce ne
 *  sono, negli orari del centro (senza orari impostati, dal primo inizio
 *  all'ultima fine dei turni del giorno); `gaps` = le fasce [da, a] (minuti)
 *  in cui il centro è aperto e non c'è nessuna. Centro chiuso: niente fasce.
 *  `known` = gli orari del centro sono impostati: senza, non si sa se un'ora
 *  senza nessuna è un buco o la chiusura per pranzo, e `gaps` resta vuoto
 *  (ogni giorno in rosso per la pausa di tutte non diceva niente). */
export function dayCoverage(day) {
  // chi quel giorno non è (ancora, più) nel team non conta nel «su quante»
  const cells = (day?.cells || []).filter((c) => !c.out_of_team);
  const wins = cells.map((c) => (c.windows || []).map(([a, b]) => [hm(a), hm(b)]));
  const working = wins.filter((w) => w.length).length;
  let open = (day?.opening || []).map(([a, b]) => [hm(a), hm(b)]);
  if (day?.opening == null) {
    const all = wins.flat();
    open = all.length ? [[Math.min(...all.map((w) => w[0])), Math.max(...all.map((w) => w[1]))]] : [];
  }
  const slots = [];
  for (const [a, b] of open) {
    for (let m = a; m < b; m += 30) {
      const to = Math.min(b, m + 30);
      slots.push({ from: m, to, count: wins.filter((w) => w.some(([s, e]) => s <= m && to <= e)).length });
    }
  }
  const known = day?.opening != null;
  const gaps = [];
  for (const sl of slots) {
    if (sl.count || !known) continue;
    const last = gaps[gaps.length - 1];
    if (last && last[1] === sl.from) last[1] = sl.to; else gaps.push([sl.from, sl.to]);
  }
  return { working, total: cells.length, slots, gaps, known };
}

/* ---- misc ---- */
export const inputCss = {
  border: '1px solid var(--hair)', borderRadius: 10, outline: 'none', fontSize: 14.5,
  padding: '10px 12px', fontFamily: 'var(--sans)', background: 'var(--surface)', width: '100%',
  boxSizing: 'border-box',
};

export function opName(o) { return `${o.first_name} ${o.last_name}`.trim(); }

/* ---- scheda operatrice: modulo, modifiche, dati nascosti ---- */

/** Segnaposto dei dati di cassa/HR che il server non manda a chi non ha il
 *  permesso (arrivano null, con `cash_hidden: true`: contratto C6). */
export const HIDDEN = '•••';

/** OperatorDetailOut → stato del modulo Anagrafica. */
export function formFromDetail(d) {
  return {
    first_name: d.first_name || '',
    last_name: d.last_name || '',
    color: d.color,
    role_title: d.role_title || '',
    // null e non «0»: senza permesso il costo orario non arriva, e mostrarlo
    // come 0 € sarebbe un dato falso (C6).
    hourly_cost: d.hourly_cost == null ? null : String(Number(d.hourly_cost)),
    active: d.active,
    service_ids: d.service_ids || [],
    location_id: d.location_id ?? null,
    user_id: d.user_id ?? null,
    order: d.order,
    // il rapporto di lavoro: null = nessun limite («YYYY-MM-DD» altrimenti)
    employed_from: d.employed_from || null,
    employed_until: d.employed_until || null,
  };
}

const sortedIds = (ids) => [...(ids || [])].sort((a, b) => a - b);
const cents = (v) => (Number(v) || 0).toFixed(2);

/** Confronto campo per campo del modulo: i servizi sono un insieme, il colore
 *  non bada alle maiuscole, i testi agli spazi ai lati, il costo ai centesimi. */
export function sameOperatorField(a, b, key) {
  if (key === 'service_ids') return sortedIds(a).join(',') === sortedIds(b).join(',');
  if (key === 'color') return String(a || '').toUpperCase() === String(b || '').toUpperCase();
  if (key === 'first_name' || key === 'last_name' || key === 'role_title') return String(a || '').trim() === String(b || '').trim();
  if (key === 'hourly_cost') return (a == null || b == null) ? (a == null && b == null) : cents(a) === cents(b);
  return (a ?? null) === (b ?? null);
}

/**
 * Solo i campi dell'Anagrafica cambiati rispetto a `detail` (il server), pronti
 * per la PUT parziale (contratto C19). La PUT a corpo pieno costruita dal modulo
 * letto all'apertura riscriveva anche ciò che era cambiato nel frattempo: il
 * colore scelto in agenda e il servizio abilitato dal listino tornavano indietro
 * al primo «Salva» (09-09).
 */
export function changedOperatorFields(form, detail) {
  const base = formFromDetail(detail);
  const out = {};
  Object.keys(base).forEach((k) => {
    if (sameOperatorField(form[k], base[k], k)) return;
    if (k === 'hourly_cost') {
      if (form.hourly_cost != null) out.hourly_cost = cents(form.hourly_cost);
    } else if (k === 'first_name' || k === 'last_name' || k === 'role_title') {
      out[k] = String(form[k] || '').trim();
    } else if (k === 'service_ids') {
      out.service_ids = [...(form.service_ids || [])];
    } else {
      out[k] = form[k] ?? null;
    }
  });
  return out;
}

/** Stesso pattern turni? (confronto sul modello dell'editor, testo compreso) */
export function sameWeeks(a, b) {
  return JSON.stringify(a || []) === JSON.stringify(b || []);
}

/** Serie mensile degli incassi per il grafico Performance.
 *  `hidden`: il server non ha mandato gli importi (C6). La media NON si
 *  arrotonda all'euro: eur() la scrive con i centesimi, e sei mesi per 7.407 €
 *  davano «€1.235,00» invece di €1.234,50 (15-18), con la riga della media
 *  disegnata sul valore arrotondato. */
export function perfStats(perf) {
  const rows = perf || [];
  const hidden = rows.some((p) => p.revenue == null);
  const values = rows.map((p) => (p.revenue == null ? 0 : Number(p.revenue) || 0));
  const max = Math.max(...values, 1);
  const last = values[values.length - 1] || 0;
  const prev = values[values.length - 2] || 0;
  const delta = prev > 0 ? Math.round(((last - prev) / prev) * 100) : 0;
  const avg = values.reduce((a, b) => a + b, 0) / (values.length || 1);
  return { hidden, values, max, last, prev, delta, avg };
}

/** € per ricavi e costi: lo 0 dev'essere «€0», non il «Gratis» di fmtEur
 *  (convenzione dei listini servizi), e un valore che manca conta zero.
 *  I centesimi si scrivono sempre: senza minimumFractionDigits un costo orario
 *  di 12,50 € finiva a video come «€12,5» e uno di 8,415 € come «€8,415».
 *  È la regola di fmtEurOrZero, con il nome che usa lo staff. */
export { fmtEurOrZero as eur } from '@youty/shared';

/** derive the today-status pill from OperatorStatusOut (port of staffTodayStatus) */
export function todayStatus(op, t, lang) {
  if (op.out_of_team) {
    const m = AVAIL_META.out;
    return { key: 'out', label: outLabel(op.out_of_team, t), color: m.c, bg: 'var(--paper-2)', hours: '' };
  }
  if (op.absence_type) {
    const meta = AVAIL_META[op.absence_type] || AVAIL_META.off;
    return { key: op.absence_type, label: meta[lang === 'en' ? 'en' : 'it'], color: meta.c, bg: meta.bg, hours: '' };
  }
  if (op.on_shift && (op.windows || []).length) {
    const m = AVAIL_META.work;
    return { key: 'work', label: m[lang === 'en' ? 'en' : 'it'], color: m.c, bg: m.bg, hours: fmtWindows(op.windows) };
  }
  const m = AVAIL_META.off;
  return { key: 'off', label: m[lang === 'en' ? 'en' : 'it'], color: m.c, bg: m.bg, hours: '' };
}

export { nameIn as svcLabel } from '@youty/shared';
