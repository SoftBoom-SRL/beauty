// rules.js — regole pure dei pannelli dell'agenda (dettaglio, nuova
// prenotazione, riepilogo di cassa). Qui c'è solo logica, senza React: così la
// si prova con `node --test` (vedi apps/dashboard/test/modali-*.test.js) e le
// regole che replicano il server stanno in un posto solo.
import { salonTzOpts } from '@youty/shared';

/** Scadenza della caparra, letta sull'orologio del SALONE («24/09, 18:00»).
 *  Il toLocaleString senza fuso scriveva l'ora del dispositivo: da un portatile
 *  rimasto su un altro fuso la reception leggeva un termine spostato di ore. */
export function depositDueLabel(iso, lang) {
  if (!iso) return '';
  return new Date(iso).toLocaleString(lang === 'en' ? 'en-GB' : 'it-IT',
    salonTzOpts({ day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }));
}

/* ---- la copia dell'appuntamento nel pannello di dettaglio ------------------ */

/** Firma dei servizi di una visita: id, servizio, operatrice, durata, posa. */
export const itemsSig = (list) => JSON.stringify((list || []).map((i) => [
  i.id ?? null, i.service_id, i.operator_id ?? null, Number(i.duration_min) || 0, Number(i.soak_min) || 0,
]));

/** Versione di un appuntamento per dire «è cambiato?». `updated_at` (contratto
 *  C2) quando il server lo manda, più i campi che il pannello mostra: alcune
 *  scritture (il riallineamento della scadenza caparra) non toccano
 *  updated_at, e con un server senza C2 restano solo i campi. */
export function apptVersion(a) {
  if (!a) return '';
  return JSON.stringify([
    a.updated_at ?? null, a.start, a.operator_id, a.status, a.note ?? '', a.forced ?? false,
    a.deposit_status ?? null, String(a.deposit_amount ?? ''), String(a.deposit_credit ?? ''),
    String(a.deposit_refunded_amount ?? ''), a.deposit_payment_link ?? '', a.deposit_due_at ?? null,
    String(a.total_price ?? ''), itemsSig(a.items), (a.items || []).map((i) => String(i.price ?? '')),
    (a.gifts || []).map((g) => g.gift_card_id ?? g.code),
  ]);
}

/** Vero solo se `a` è di sicuro più vecchia di `b` (entrambe con updated_at):
 *  una risposta lenta non deve riportare indietro il pannello. */
export function isOlder(a, b) {
  const ta = Date.parse(a?.updated_at || ''), tb = Date.parse(b?.updated_at || '');
  return Number.isFinite(ta) && Number.isFinite(tb) && ta < tb;
}

/** Uno spostamento dal pannello si calcola su ora, operatrice e stato che si
 *  vedono: se nel frattempo sono cambiati (trascinamento, «Indietro», un'altra
 *  postazione) il comando va rifatto guardando la versione nuova. */
export function movedMeanwhile(seen, fresh) {
  if (!seen || !fresh) return false;
  return Date.parse(seen.start) !== Date.parse(fresh.start)
    || (seen.operator_id ?? null) !== (fresh.operator_id ?? null)
    || seen.status !== fresh.status;
}

/** Evento del feed live che riguarda l'appuntamento `id`. `appointment.undone`
 *  non dice quale gesto ha rimesso a posto: in quel caso si rilegge comunque. */
export function eventConcerns(ev, id) {
  if (!ev || id == null) return false;
  if (ev.type === 'appointment.undone') return true;
  const p = ev.payload || {};
  return [p.appointment_id, p.created_id].some((x) => x != null && Number(x) === Number(id));
}

/** Riga modificabile del pannello a partire da un servizio della visita. */
export const editRow = (it, key) => ({
  key,
  id: it.id,                        // existing item id (undefined for new lines → creates)
  service_id: it.service_id,
  operator_id: it.operator_id ?? null,
  operator_name: it.operator_name || '',
  duration_min: it.duration_min,
  soak_min: it.soak_min || 0,       // solo per l'anteprima degli orari a destra
  price: Number(it.price) || 0,
  name: it.service_name,
});

const DRAFT_FIELDS = ['service_id', 'operator_id', 'duration_min', 'soak_min'];

/** Le modifiche non salvate (`rows`, `note`) riportate su una versione nuova
 *  dell'appuntamento (`theirs`), a partire da quella su cui erano state fatte
 *  (`base`): fusione a tre vie, riga per riga (per id) e campo per campo.
 *  - quello che non si è toccato prende il valore nuovo (lo spostamento, il
 *    «Passa a», il servizio aggiunto da una collega);
 *  - quello che si è cambiato resta com'era nella bozza;
 *  - le righe tolte restano tolte, quelle aggiunte restano in fondo;
 *  - una modifica su una riga che nella versione nuova non c'è più (il server
 *    ricrea le righe a ogni salvataggio dei servizi) non si può riportare: si
 *    conta in `lost`, perché chi chiama lo dica.
 *  Ritorna { rows, note, lost }. */
export function rebaseDraft({ base, rows, note, theirs }) {
  const baseRows = new Map((base?.items || []).map((it) => [it.id, editRow(it, '')]));
  const mine = new Map((rows || []).filter((r) => r.id != null).map((r) => [r.id, r]));
  const touched = (m, b) => DRAFT_FIELDS.some((f) => m[f] !== b[f]);
  const out = [];
  const theirIds = new Set();
  for (const it of theirs?.items || []) {
    theirIds.add(it.id);
    const fresh = editRow(it, 's' + it.id);
    const b = baseRows.get(it.id);
    if (!b) { out.push(fresh); continue; }          // arrivata con la versione nuova
    const m = mine.get(it.id);
    if (!m) continue;                                 // tolta nella bozza
    const merged = { ...fresh, key: m.key };
    for (const f of DRAFT_FIELDS) if (m[f] !== b[f]) merged[f] = m[f];
    out.push(merged);
  }
  let lost = 0;
  for (const [id, b] of baseRows) {
    if (theirIds.has(id)) continue;
    const m = mine.get(id);
    if (!m || touched(m, b)) lost += 1;               // tolta o cambiata su una riga sparita
  }
  for (const r of rows || []) if (r.id == null) out.push(r);   // servizi aggiunti nella bozza
  const baseNote = base?.note || '';
  const mineNote = note ?? baseNote;
  return { rows: out, note: mineNote === baseNote ? (theirs?.note || '') : mineNote, lost };
}

/** «No-show» solo per una visita confermata e già cominciata: il server
 *  rifiuta (400) quello di chi è già in salone o di una visita futura. */
export const canMarkNoShow = (appt, now = Date.now()) =>
  !!appt && appt.status === 'confirmed' && Date.parse(appt.start) <= now;

/* ---- limiti del server sui campi ------------------------------------------ */

/** ReasonIn.reason (no-show e annullamento): 255 caratteri, come la colonna. */
export const REASON_MAX = 255;
const REASON_SEP = ' — ';
/** Spazio che resta alla nota dopo la motivazione scelta («Malattia — …»). */
export const reasonNoteMax = (label) => Math.max(0, REASON_MAX - (label ? label.length + REASON_SEP.length : 0));
/** Motivazione + nota come le salva il server, mai oltre il limite (tagliata
 *  per caratteri interi, non a metà di un'emoji). */
export const joinReason = (label, note) =>
  Array.from([label, note].filter(Boolean).join(REASON_SEP)).slice(0, REASON_MAX).join('');

/** ItemEditIn: durata e attesa di un servizio al massimo 12 ore. */
export const MAX_ITEM_MIN = 12 * 60;

/* ---- appunti ---------------------------------------------------------------- */

/** Copia negli appunti e dice se è riuscita davvero. `navigator.clipboard`
 *  manca fuori da HTTPS e può rifiutare (permesso negato): prima si annunciava
 *  «Link copiato» senza saperlo. Ripiego: execCommand('copy') su una textarea. */
export async function copyText(text, env = globalThis) {
  if (!text) return false;
  try {
    if (env.navigator?.clipboard?.writeText) {
      await env.navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* si prova il ripiego */ }
  try {
    const doc = env.document;
    if (!doc?.body || typeof doc.execCommand !== 'function') return false;
    const ta = doc.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    doc.body.appendChild(ta);
    ta.select();
    const ok = doc.execCommand('copy');
    doc.body.removeChild(ta);
    return !!ok;
  } catch {
    return false;
  }
}

/* ---- gift card -------------------------------------------------------------- */

/** Chi non ha marketing né cassa riceve i codici mascherati («••••1234»,
 *  contratto C21): non vanno mostrati come se fossero il codice da usare. */
export const usableCode = (code) => (code && !String(code).includes('•') ? String(code) : '');
