// lib.jsx — shared helpers/components for the client-app screens (ported from
// prototype screen-cliente.jsx). Lives inside screens/ per folder ownership.
import React from 'react';
import { ApiError, Icon, api, fmtEur, parseISO, timeLabel, minutesOfDay, toDateStr, todayStr, addDays, salonTzOpts } from '@youty/shared';
import { headFont } from '../theme.js';

/* ============================== UI bits ============================== */

/** Screen sub-header with back chevron (prototype ClientSubHead). */
export function ClientSubHead({ brand, title, onBack }) {
  return (
    <div style={{ padding: '0 16px' }}>
      <div style={{ paddingTop: 'var(--safe-top)' }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingBottom: 10 }}>
        <button className="press" onClick={onBack} style={{ width: 42, height: 42, marginLeft: -8, borderRadius: 99, display: 'grid', placeItems: 'center', flexShrink: 0 }}>
          <Icon name="chevL" size={24} />
        </button>
        <div style={{ flex: 1, minWidth: 0, fontFamily: headFont(brand), fontSize: 21, fontWeight: brand.type === 'serif' ? 500 : 700, lineHeight: 1.15 }}>{title}</div>
      </div>
    </div>
  );
}

/** Inline icon+text meta row (prototype Meta). */
export function Meta({ icon, text }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13.5, fontWeight: 600, color: 'var(--muted)' }}>
      <Icon name={icon} size={15} color="var(--brand)" />{text}
    </span>
  );
}

/** Review detail line (prototype DetailRow). */
export function DetailRow({ icon, label, value }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
      <Icon name={icon} size={17} color="var(--brand)" />
      <span className="t-sm" style={{ color: 'var(--muted)', width: 90, flexShrink: 0 }}>{label}</span>
      <span style={{ fontWeight: 700, fontSize: 14.5, flex: 1, textAlign: 'right' }}>{value}</span>
    </div>
  );
}

/** Caparra da versare: importo, scadenza e pulsante di pagamento.
 *  Il link arriva già con l'appuntamento (`deposit_payment_link`); se manca lo
 *  si chiede al volo. 503 = il salone non ha i pagamenti online: si paga in sede. */
export function DepositDue({ appt, t, lang, fireToast, compact = false }) {
  const [busy, setBusy] = React.useState(false);
  if (!appt || appt.deposit_status !== 'required') return null;
  const amount = Number(appt.deposit_amount || 0);
  const due = appt.deposit_due_at ? new Date(appt.deposit_due_at) : null;
  const locale = lang === 'en' ? 'en-GB' : 'it-IT';
  // La sola ora basta se la scadenza è oggi. Se cade domani — e con una tenuta
  // di qualche ora succede spesso — «entro le 09:30» si legge come stamattina.
  const sameDay = due && due.toDateString() === new Date().toDateString();
  const dueLabel = due
    ? (sameDay
      ? due.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
      : due.toLocaleString(locale, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }))
    : null;

  const pay = async () => {
    if (busy) return;
    // Link già disponibile: si apre subito, dentro il gesto dell'utente.
    if (appt.deposit_payment_link) { window.open(appt.deposit_payment_link, '_blank', 'noopener'); return; }
    setBusy(true);
    try {
      const res = await api.post(`/api/sales/client/appointments/${appt.id}/deposit-link`, {});
      // Dopo l'attesa il gesto è scaduto e Safari su iPhone blocca la finestra
      // nuova: il pulsante sembrava non fare niente. Si naviga nella stessa
      // scheda, e Stripe riporta qui a pagamento concluso.
      if (res?.url) window.location.assign(res.url);
      else fireToast?.({ msg: t('Link di pagamento non disponibile: contatta il salone.', 'Payment link unavailable: please contact the salon.'), icon: 'alert' });
    } catch (err) {
      if (err instanceof ApiError && err.status === 503) {
        fireToast?.({ msg: t('Il salone non accetta pagamenti online: potrai pagare in sede.', 'The salon does not take online payments: you can pay on site.'), icon: 'info' });
      } else errToast(err, fireToast, t);
    } finally { setBusy(false); }
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 11, padding: compact ? '10px 12px' : '13px 15px', borderRadius: 'var(--r-md)', background: 'var(--warn-tint, #FDF2E3)', marginTop: 12 }}>
      <Icon name="coupon" size={18} color="var(--warn, #B4761F)" />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 700, fontSize: 13.5, color: 'var(--ink)' }}>
          {t(`Caparra di ${fmtEur(amount, lang)} da pagare`, `${fmtEur(amount, lang)} deposit to pay`)}
        </div>
        {dueLabel && (
          <div className="t-sm" style={{ color: 'var(--ink-2)', marginTop: 2, lineHeight: 1.4 }}>
            {t(`Entro le ${dueLabel}, poi l'orario torna disponibile.`, `By ${dueLabel}, then the slot is released.`)}
          </div>
        )}
      </div>
      <button className="press" onClick={pay} disabled={busy}
        style={{ flexShrink: 0, padding: '9px 14px', borderRadius: 'var(--r-pill)', background: 'var(--brand)', color: 'var(--brand-on)', fontWeight: 700, fontSize: 13, opacity: busy ? 0.6 : 1 }}>
        {busy ? t('Attendi…', 'Wait…') : t('Paga ora', 'Pay now')}
      </button>
    </div>
  );
}

/** Dashed empty box used across wallet/waitlist lists. */
export function DashedEmpty({ children, style = {} }) {
  return (
    <div style={{ padding: '18px 16px', borderRadius: 'var(--r-md)', border: '1px dashed var(--hair)', textAlign: 'center', color: 'var(--muted)', fontSize: 13.5, ...style }}>
      {children}
    </div>
  );
}

/** Sticky bottom CTA bar (gradient fade, prototype pattern). */
export function StickyCta({ children }) {
  return (
    <div style={{ position: 'sticky', bottom: 0, padding: '14px 22px calc(var(--safe-bottom) + 14px)', background: 'linear-gradient(transparent, var(--paper-0) 24%)' }}>
      {children}
    </div>
  );
}

/* ============================== catalog helpers ============================== */

/** Bilingual name for public catalog objects ({name_it, name_en}). */
export function svcLangName(obj, lang) {
  if (!obj) return '';
  return (lang === 'en' && obj.name_en) ? obj.name_en : obj.name_it;
}

/** Category icon heuristic (prototype BK_CAT_ICON keyed nail/hair/viso/extra). */
export function catIcon(name = '') {
  const n = String(name).toLowerCase();
  if (/(unghi|nail|mani|pedic)/.test(n)) return 'sparkle';
  if (/(capell|hair|piega|taglio)/.test(n)) return 'scissors';
  if (/(viso|face|skin|pelle)/.test(n)) return 'drop';
  return 'star';
}

/** Fetch the public price list (categories with services). */
export function usePublicServices(slug) {
  const [cats, setCats] = React.useState(null);
  const [error, setError] = React.useState(null);
  React.useEffect(() => {
    let alive = true;
    api.get('/api/catalog/public/services', { params: { salon: slug }, auth: false })
      .then((d) => { if (alive) setCats(d); })
      .catch((e) => { if (alive) setError(e); });
    return () => { alive = false; };
  }, [slug]);
  return { cats, error };
}

/** Fetch the public list of active operators (stylist picker in booking). */
export function usePublicOperators(slug) {
  const [operators, setOperators] = React.useState(null);
  const [error, setError] = React.useState(null);
  React.useEffect(() => {
    let alive = true;
    api.get('/api/staff/public/operators', { params: { salon: slug }, auth: false })
      .then((d) => { if (alive) setOperators(d); })
      .catch((e) => { if (alive) setError(e); });
    return () => { alive = false; };
  }, [slug]);
  return { operators, error };
}

/** Fetch the client's own appointments ({upcoming, past}). */
export function useClientAppointments() {
  const [data, setData] = React.useState(null);
  const [error, setError] = React.useState(null);
  const reload = React.useCallback(() => {
    api.get('/api/agenda/client/appointments')
      .then(setData)
      .catch(setError);
  }, []);
  React.useEffect(() => { reload(); }, [reload]);
  return { data, error, reload };
}

/* ============================== dates / labels ============================== */

const locale = (lang) => (lang === 'en' ? 'en-GB' : 'it-IT');

/** Next n days as Date[] starting today (booking day strip). */
export function nextDays(n = 14) {
  const today = new Date();
  return Array.from({ length: n }, (_, i) => addDays(today, i));
}

/** La data di oggi come 'YYYY-MM-DD', che cambia da sola a mezzanotte.
 *
 * Le schermate di prenotazione calcolavano la striscia dei giorni una volta
 * sola: un'app lasciata aperta la sera proponeva ancora ieri come primo giorno.
 * Si controlla anche al ritorno in primo piano, perché sul telefono i timer si
 * fermano quando l'app è in secondo piano. */
export function useTodayKey() {
  const [key, setKey] = React.useState(() => toDateStr(new Date()));
  React.useEffect(() => {
    const tick = () => setKey((k) => { const now = toDateStr(new Date()); return now === k ? k : now; });
    const id = setInterval(tick, 60000);
    document.addEventListener('visibilitychange', tick);
    window.addEventListener('focus', tick);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', tick);
      window.removeEventListener('focus', tick);
    };
  }, []);
  return key;
}

/** Short strip label parts, e.g. { wd: 'Gio', num: '14' }. */
export function dayStripLabel(date, lang) {
  const wd = date.toLocaleDateString(locale(lang), { weekday: 'short' }).replace('.', '');
  return { wd: wd.charAt(0).toUpperCase() + wd.slice(1), num: String(date.getDate()) };
}

/** "Gio 14 nov" style medium label. */
export function fmtDayMed(dateish, lang) {
  const d = parseISO(dateish);
  const opts = { weekday: 'short', day: 'numeric', month: 'short' };
  // Un istante si legge sul calendario del salone; una data pura è già un giorno.
  const s = d.toLocaleDateString(
    locale(lang),
    typeof dateish === 'string' && !dateish.includes('T') ? opts : salonTzOpts(opts),
  ).replace(/\./g, '');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Big relative label for the next appointment: "Oggi alle 15:30" / "Domani alle 10:00" / "Gio 14 nov · 10:00". */
export function relLabel(iso, lang, t) {
  const d = parseISO(iso);
  // «Oggi» e «domani» si contano sul calendario del SALONE: dall'estero la
  // cliente leggeva l'ora del proprio telefono, e a cavallo della mezzanotte
  // anche il giorno sbagliato.
  const days = Math.round((parseISO(toDateStr(iso)) - parseISO(todayStr())) / 86400000);
  const hm = timeLabel(minutesOfDay(iso));
  if (days === 0) return t('Oggi alle ', 'Today at ') + hm;
  if (days === 1) return t('Domani alle ', 'Tomorrow at ') + hm;
  if (days > 1 && days < 7) {
    const wd = d.toLocaleDateString(locale(lang), salonTzOpts({ weekday: 'long' }));
    return wd.charAt(0).toUpperCase() + wd.slice(1) + t(' alle ', ' at ') + hm;
  }
  return fmtDayMed(d, lang) + ' · ' + hm;
}

/** "Gio 14 nov 2026" full date + time meta for lists. */
export function fmtApptDate(iso, lang) {
  return fmtDayMed(iso, lang);
}

export function apptTime(iso) { return timeLabel(minutesOfDay(iso)); }

/** Duration of a client-list appointment (sum of services, fallback start→end). */
export function apptDur(appt) {
  const s = (appt.services || []).reduce((sum, x) => sum + (x.duration_min || 0), 0);
  if (s) return s;
  try { return Math.max(0, (parseISO(appt.end) - parseISO(appt.start)) / 60000); } catch { return 0; }
}

export function apptServiceNames(appt) {
  return (appt.services || []).map((s) => s.name).join(' + ');
}

/* ============================== actions ============================== */

/** Google Maps directions link searching the salon by name. */
export function mapsUrl(brand) {
  return 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(brand?.name || '');
}

/** Build an .ics data URL for an appointment (client-side add-to-calendar). */
export function icsDataUrl(appt, brandName) {
  // Orari in UTC (la Z finale): un .ics con l'ora "fluttuante" veniva
  // interpretato dal calendario nel fuso del telefono, e un appuntamento preso
  // dall'estero finiva in agenda all'ora sbagliata.
  const pad = (n) => String(n).padStart(2, '0');
  const fmt = (d) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}00Z`;
  const start = parseISO(appt.start);
  const end = appt.end ? parseISO(appt.end) : new Date(start.getTime() + apptDur(appt) * 60000);
  const summary = (apptServiceNames(appt) || 'Appuntamento') + (brandName ? ' — ' + brandName : '');
  const ics = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//youty//client-app//IT', 'BEGIN:VEVENT',
    `UID:appt-${appt.id}@youty`, `DTSTAMP:${fmt(new Date())}`, `DTSTART:${fmt(start)}`, `DTEND:${fmt(end)}`,
    `SUMMARY:${summary.replace(/[\n,;]/g, ' ')}`, brandName ? `LOCATION:${brandName.replace(/[\n,;]/g, ' ')}` : null,
    'END:VEVENT', 'END:VCALENDAR',
  ].filter(Boolean).join('\r\n');
  return 'data:text/calendar;charset=utf-8,' + encodeURIComponent(ics);
}

export function downloadIcs(appt, brandName) {
  const a = document.createElement('a');
  a.href = icsDataUrl(appt, brandName);
  a.download = 'appuntamento.ics';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** Uniform ApiError → toast. */
export function errToast(err, fireToast, t) {
  if (err instanceof ApiError) fireToast({ msg: err.message, icon: 'alert' });
  else fireToast({ msg: t('Errore di rete', 'Network error'), icon: 'alert' });
}

/** Waitlist preference label. */
export function prefLabel(entry, t, lang) {
  switch (entry.preference) {
    case 'morning': return t('Mattina', 'Morning');
    case 'afternoon': return t('Pomeriggio', 'Afternoon');
    case 'weekend': return t('Weekend', 'Weekend');
    case 'exact': {
      const days = (entry.exact_days || []).map((d) => (WEEKDAYS_SHORT[d] ? WEEKDAYS_SHORT[d][lang === 'en' ? 1 : 0] : '')).filter(Boolean).join(' ');
      const time = entry.exact_time ? String(entry.exact_time).slice(0, 5) : '';
      return [days, time].filter(Boolean).join(' · ') || t('Orario preciso', 'Exact time');
    }
    default: return t('Qualsiasi orario', 'Any time');
  }
}

/** 0=Monday … 6=Sunday (backend convention). [it, en, letterIt, letterEn] */
export const WEEKDAYS_SHORT = [
  ['Lun', 'Mon', 'L', 'M'], ['Mar', 'Tue', 'M', 'T'], ['Mer', 'Wed', 'M', 'W'],
  ['Gio', 'Thu', 'G', 'T'], ['Ven', 'Fri', 'V', 'F'], ['Sab', 'Sat', 'S', 'S'], ['Dom', 'Sun', 'D', 'S'],
];

export { toDateStr };
