// helpers.js — communications: status metadata + date <-> datetime-local conversions.
// Local to this section (no shared statusMeta equivalent exists for the marketing
// `Communication.status` enum, which is draft|scheduled|sent — unrelated to
// appointment/deposit statuses in @youty/shared).
import { dateTimeLocalToIso, fmtTime, salonDateParts, toDateTimeLocal } from '@youty/shared';

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
  const p = salonDateParts(iso);
  const mon = lang === 'en' ? MONTHS_EN : MONTHS_IT;
  return `${p.day} ${mon[p.month - 1]} ${p.year} · ${fmtTime(iso)}`;
}

/** API ISO datetime -> valore per <input type="datetime-local">, ora del SALONE.
 *  L'invio programmato di una comunicazione si legge e si scrive sull'orologio
 *  del salone: da una postazione su un altro fuso, «lunedì alle 9» partiva a
 *  un'ora diversa da quella scritta nel campo. */
export const isoToDtLocal = toDateTimeLocal;

/** Valore di <input type="datetime-local"> -> ISO dell'istante (ora del salone). */
export const dtLocalToIso = dateTimeLocalToIso;

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
