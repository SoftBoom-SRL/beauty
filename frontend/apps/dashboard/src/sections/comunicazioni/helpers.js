// helpers.js — communications: status metadata + date <-> datetime-local conversions.
// Local to this section (no shared statusMeta equivalent exists for the marketing
// `Communication.status` enum, which is draft|scheduled|sent — unrelated to
// appointment/deposit statuses in @youty/shared).
import { salonIsoAt, salonParts } from '@youty/shared';

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

/** ISO datetime -> "1 lug 2026 · 10:00" (SALON time, bilingual months). */
export function comWhenLabel(iso, lang) {
  if (!iso) return '';
  const p = salonParts(iso);
  const mon = lang === 'en' ? MONTHS_EN : MONTHS_IT;
  const pad = (n) => String(n).padStart(2, '0');
  return `${p.d} ${mon[p.m - 1]} ${p.y} · ${pad(p.h)}:${pad(p.min)}`;
}

/* La coppia isoToDtLocal/dtLocalToIso deve parlare LO STESSO fuso, altrimenti
   riaprire una comunicazione programmata ne sposterebbe l'orario. Entrambe usano
   l'ora del salone: è quella che il titolare intende quando scrive "ore 10:00". */

/** API ISO datetime -> value for <input type="datetime-local"> (salon wall-clock). */
export function isoToDtLocal(iso) {
  if (!iso) return '';
  const p = salonParts(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${p.y}-${pad(p.m)}-${pad(p.d)}T${pad(p.h)}:${pad(p.min)}`;
}

/** <input type="datetime-local"> value (salon wall-clock) -> ISO8601 with the
 *  salon's offset, or null. */
export function dtLocalToIso(value) {
  if (!value) return null;
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/.exec(value);
  if (!m) return null;
  return salonIsoAt(m[1], +m[2] * 60 + +m[3]);
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
