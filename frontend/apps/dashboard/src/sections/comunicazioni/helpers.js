// helpers.js — communications: status metadata + date <-> datetime-local conversions.
// Local to this section (no shared statusMeta equivalent exists for the marketing
// `Communication.status` enum, which is draft|scheduled|sent — unrelated to
// appointment/deposit statuses in @youty/shared).

export const COM_STATUS_KEYS = ['draft', 'scheduled', 'sent'];

/** status ∈ draft|scheduled|sent -> { label, color, tint } */
export function comStatusMeta(status, t) {
  switch (status) {
    case 'scheduled': return { label: t('Programmata', 'Scheduled'), color: 'var(--info)', tint: 'var(--surface-2)' };
    case 'sent': return { label: t('Inviata', 'Sent'), color: 'var(--ok)', tint: 'var(--ok-tint)' };
    case 'draft':
    default: return { label: t('Bozza', 'Draft'), color: 'var(--muted)', tint: 'var(--surface-2)' };
  }
}

const MONTHS_IT = ['gen', 'feb', 'mar', 'apr', 'mag', 'giu', 'lug', 'ago', 'set', 'ott', 'nov', 'dic'];
const MONTHS_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** ISO datetime -> "1 lug 2026 · 10:00" (local time, bilingual months). */
export function comWhenLabel(iso, lang) {
  if (!iso) return '';
  const d = new Date(iso);
  const mon = lang === 'en' ? MONTHS_EN : MONTHS_IT;
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getDate()} ${mon[d.getMonth()]} ${d.getFullYear()} · ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** API ISO datetime -> value for <input type="datetime-local"> (local time, no offset). */
export function isoToDtLocal(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** <input type="datetime-local"> value -> full ISO8601 with offset (UTC), or null. */
export function dtLocalToIso(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

/** Human summary of a communication's audience, given the salon's client categories. */
export function audienceSummary(comm, clientCategories, t) {
  const audience = comm.audience || [];
  if (!audience.length) return t('Nessuna destinataria', 'No recipients');
  if (comm.audience_type === 'clients') return audience.length + ' ' + t('clienti', 'clients');
  const names = audience
    .map((id) => clientCategories.find((c) => c.id === id))
    .filter(Boolean)
    .map((c) => c.name);
  return names.length ? names.join(' · ') : t('Etichette selezionate', 'Selected labels');
}
