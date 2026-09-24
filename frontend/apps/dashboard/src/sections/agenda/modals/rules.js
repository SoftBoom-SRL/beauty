// rules.js — regole pure dei pannelli dell'agenda (dettaglio, nuova
// prenotazione, riepilogo di cassa). Qui c'è solo logica, senza React: così la
// si prova con `node --test` (vedi apps/dashboard/test/modali-*.test.js) e le
// regole che replicano il server stanno in un posto solo.
import { fmtDur, isoAtMin, minutesOfDay, salonTzOpts, timeLabel, todayStr } from '@youty/shared';
import { explainSlot } from '../lib/slots.js';

/** Scadenza della caparra, letta sull'orologio del SALONE («24/09, 18:00»).
 *  Il toLocaleString senza fuso scriveva l'ora del dispositivo: da un portatile
 *  rimasto su un altro fuso la reception leggeva un termine spostato di ore. */
export function depositDueLabel(iso, lang) {
  if (!iso) return '';
  return new Date(iso).toLocaleString(lang === 'en' ? 'en-GB' : 'it-IT',
    salonTzOpts({ day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }));
}

/* ---- la copia dell'appuntamento nel pannello di dettaglio ------------------ */

/** Stati in cui la visita è finita (conto chiuso, no-show, annullata): niente
 *  più modifiche né comandi dal pannello. */
export const TERMINAL = ['closed', 'no_show', 'cancelled'];

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
  if (ev.type === 'appointment.undone') {
    // l'annullamento dice quali visite ha toccato (anche quelle tolte); un
    // server che non lo dice fa rileggere sempre
    const ids = ev.payload?.appointment_ids;
    return !Array.isArray(ids) || ids.some((x) => Number(x) === Number(id));
  }
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

/** Chi può prendersi la visita («Passa a»): l'operatrice principale e le
 *  colleghe abilitate a TUTTI i servizi che oggi sono suoi (sono quelli che
 *  cambiano mano, come nel trascinamento in agenda). Il server rifiuterebbe
 *  le altre. */
export function handoverOps(appt, operators) {
  const mainItems = (appt.items || []).filter((it) => (it.operator_id ?? appt.operator_id) === appt.operator_id);
  return operators.filter((op) => op.id === appt.operator_id
    || (mainItems.length > 0 && mainItems.every((it) => (op.service_ids || []).includes(it.service_id))));
}

/** Le colleghe che hanno una parte della visita: con «Passa a» la loro parte
 *  resta a loro (nomi senza doppioni, nell'ordine dei servizi). */
export function otherOpNames(appt, operators) {
  return [...new Set((appt.items || [])
    .filter((it) => it.operator_id && it.operator_id !== appt.operator_id)
    .map((it) => operators.find((x) => x.id === it.operator_id)?.first_name || it.operator_name)
    .filter(Boolean))];
}

/** Orario di ogni riga del pannello: i servizi sono in fila dall'inizio della
 *  visita (`startMin`), posa compresa, così si vede subito che cosa slitta
 *  quando si cambia una durata o si aggiunge un trattamento. `to` è la fine
 *  del LAVORO (quando l'operatrice ha finito); `gap` è quello che viene dopo —
 *  la posa di un colore o il buco che il salone vuole lasciare — e il
 *  servizio successivo comincia di là (`next`). Tenerli separati è ciò che
 *  permette di scrivere un'ora di fine senza trascinarsi dietro il
 *  trattamento dopo. */
export function itemSpans(rows, startMin) {
  let cursor = startMin;
  return rows.map((it) => {
    const from = cursor;
    const to = from + Math.max(0, parseInt(it.duration_min, 10) || 0);
    const gap = Math.max(0, parseInt(it.soak_min, 10) || 0);
    cursor = to + gap;
    return { from, to, gap, next: cursor };
  });
}

/** Attesa fra un servizio e l'altro oltre la posa del listino
 *  (`catalogSoak(row)`): è un avviso, non un divieto — il colore ne ha 30,
 *  quello che c'è in più è un buco voluto e come tale si segnala. Dopo
 *  l'ultimo servizio non c'è nulla da aspettare. */
export function gapNotes(rows, spans, catalogSoak) {
  return rows.map((it, i) => {
    if (i >= rows.length - 1) return null;
    const extra = (spans[i].gap || 0) - catalogSoak(it);
    return extra > 0 ? { index: i, minutes: extra, gap: spans[i].gap } : null;
  }).filter(Boolean);
}

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

/** Gift card «a trattamento» che coprono un servizio di QUESTA cliente, con la
 *  stessa regola di gift_index sul server (agenda/presenters.py) — quella che poi usa
 *  la cassa: pagata, attiva, non scaduta, saldo > 0, legata a un servizio; e
 *  destinataria la cliente, oppure comprata da lei senza destinataria (né
 *  scheda collegata né nome scritto a mano). Il drawer contava anche le carte
 *  scadute, a saldo zero o regalate a «Giulia» senza scheda: il servizio
 *  compariva barrato «Regalo» e in cassa il regalo non c'era (13-09, 17-09,
 *  07-07). Con status=active il server esclude già le scadute (C21): il
 *  controllo resta qui per un server che non lo fa ancora. */
export function usableGiftCards(cards, clientId, now = Date.now()) {
  if (clientId == null) return [];
  return (cards || []).filter((g) => g
    && g.gift_service_id != null
    && g.payment_status === 'paid'
    && g.status === 'active'
    && Number(g.balance) > 0
    && (!g.expires_at || Date.parse(g.expires_at) >= now)
    && (g.recipient_client_id === clientId
      || (g.recipient_client_id == null && !g.recipient_name && g.buyer_client_id === clientId)));
}

/* ---- orario scelto nel drawer «Nuova prenotazione» -------------------------- */

/** L'orario scelto dopo un elenco nuovo di orari liberi (servizi cambiati,
 *  operatrici, evento live, ricarico dopo un 409). `src` dice da dove viene:
 *  - 'req'     l'orario cliccato in agenda: si tiene anche se non è libero
 *              (lo si è indicato apposta), e allora va forzato — ma se era
 *              libero e un ricarico (`refreshed`: stessa richiesta, agenda
 *              cambiata altrove) lo trova occupato, non si scrive sopra l'altra
 *              cliente senza che nessuno l'abbia deciso (13-11);
 *  - 'slot'    uno degli orari liberi: se non lo è più si toglie;
 *  - 'manual'  scritto a mano: resta, forzato solo se non è fra i liberi;
 *  - 'dropped' una scelta tolta così: si aspetta che chi prenota ne faccia
 *              un'altra, senza ricadere sull'orario cliccato forzato.
 *  Prima ogni ricarico riportava all'orario cliccato in agenda, forzato, anche
 *  chi aveva scelto un'alternativa o scritto un orario (13-18).
 *  Ritorna { start, src, force, dropped } — `dropped` = l'orario appena tolto. */
export function nextSelection({ prev, src, prevForced = false, slots, reqStartMin, date, refreshed = false }) {
  const list = slots || [];
  const free = (iso) => list.some((x) => x.start === iso);
  const drop = (iso) => ({ start: null, src: 'dropped', force: false, dropped: iso });
  if (src === 'dropped') return { start: null, src: 'dropped', force: false, dropped: null };
  if (prev && src === 'manual') return { start: prev, src, force: !free(prev), dropped: null };
  if (prev && src === 'slot') return free(prev) ? { start: prev, src, force: false, dropped: null } : drop(prev);
  if (reqStartMin != null && date) {
    const exact = list.find((x) => minutesOfDay(x.start) === reqStartMin);
    if (exact) return { start: exact.start, src: 'req', force: false, dropped: null };
    if (refreshed && prev && src === 'req' && !prevForced) return drop(prev);
    return { start: isoAtMin(date, reqStartMin), src: 'req', force: true, dropped: null };
  }
  return { start: null, src: null, force: false, dropped: null };
}

/** Esito dell'orario chiesto dall'agenda (`req` = { operatorId, startMin }):
 *  null senza richiesta o senza servizi, { loading } mentre arrivano gli
 *  orari, { ok, slot } se è fra i liberi; altrimenti { ok: false, label,
 *  detail, alternatives } — PERCHÉ non è libero (l'operatrice non fa un
 *  servizio, il suo turno o un'altra cliente, nessuna libera) e i quattro
 *  orari liberi più vicini, in ordine. `serviceName(serviceId)` = il nome da
 *  scrivere; `isEligible(serviceId, opId)` = chi sa fare cosa; `nowMin` =
 *  l'ora attuale se il giorno è oggi (null altrimenti). */
export function requestStatus({ req, reqOp, items, slots, dayRows, totalDur, step, nowMin, clientId, t, lang, serviceName, isEligible }) {
  if (!req || req.startMin == null || !items.length) return null;
  if (slots === null) return { loading: true };
  const exact = (slots || []).find((s) => minutesOfDay(s.start) === req.startMin);
  if (exact) return { ok: true, slot: exact };
  let label, detail = '';
  const notEligible = reqOp ? items.filter((it) => !isEligible(it.service_id, reqOp.id)) : [];
  if (reqOp && notEligible.length) {
    label = t(`${reqOp.first_name} non esegue ${serviceName(notEligible[0].service_id)}`, `${reqOp.first_name} doesn't perform ${serviceName(notEligible[0].service_id)}`);
    detail = t('Abilita il servizio in Staff oppure scegli un’altra operatrice', 'Enable the service in Staff or pick another stylist');
  } else if (reqOp && dayRows) {
    const row = dayRows.find((r) => r.operator.id === reqOp.id);
    const v = row ? explainSlot(row, req.startMin, totalDur || step, { nowMin, sameClientId: clientId, t, rows: dayRows }) : null;
    if (v && !v.ok) { label = `${reqOp.first_name}: ${v.label}`; detail = v.detail; }
    else label = t(`${reqOp.first_name} non è libera per tutta la durata (${fmtDur(totalDur, lang)})`, `${reqOp.first_name} isn't free for the whole duration (${fmtDur(totalDur, lang)})`);
  } else if (!reqOp) {
    label = t(`Nessuna operatrice libera alle ${timeLabel(req.startMin)}`, `No stylist free at ${timeLabel(req.startMin)}`);
  } else {
    label = t(`${reqOp.first_name} non è disponibile alle ${timeLabel(req.startMin)}`, `${reqOp.first_name} isn't available at ${timeLabel(req.startMin)}`);
  }
  const alternatives = [...(slots || [])]
    .sort((a, b) => Math.abs(minutesOfDay(a.start) - req.startMin) - Math.abs(minutesOfDay(b.start) - req.startMin))
    .slice(0, 4)
    .sort((a, b) => minutesOfDay(a.start) - minutesOfDay(b.start));
  return { ok: false, label, detail, alternatives };
}

/** Il giorno della prenotazione come lo scrive il drawer: «Oggi · gio 24
 *  set», «Domani · …», altrimenti solo la data breve. */
export function relativeDateLabel(date, lang, t) {
  const d = new Date(date + 'T00:00');
  const today = new Date(todayStr() + 'T00:00');
  const diff = Math.round((d - today) / 86400000);
  const base = d.toLocaleDateString(lang === 'en' ? 'en-GB' : 'it-IT', { weekday: 'short', day: 'numeric', month: 'short' });
  if (diff === 0) return t('Oggi', 'Today') + ' · ' + base;
  if (diff === 1) return t('Domani', 'Tomorrow') + ' · ' + base;
  return base;
}

/* ---- «Riprogramma» ----------------------------------------------------------- */

/** Riassegnazione proposta da uno slot di «Riprogramma» (contratto C1). Per le
 *  righe di un'operatrice che non si prenota più (disattivata, di un'altra
 *  sede) la ricerca propone una collega: lo spostamento la applica solo se la
 *  si manda (operator_id + from_operator_id), e ne porta una coppia sola.
 *  `assignment` è nell'ordine delle righe della visita.
 *  Ritorna { pair: { from, to } | null, extra } — `extra` conta le altre
 *  operatrici da riassegnare che uno spostamento solo non può portare. */
export function slotReassignment(items, assignment) {
  const rows = [...(items || [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const pairs = [];
  rows.forEach((it, i) => {
    const a = assignment?.[i];
    if (!a || a.operator_id == null || it.operator_id == null || a.operator_id === it.operator_id) return;
    if (a.service_id != null && a.service_id !== it.service_id) return;   // righe non allineate: non si indovina
    if (!pairs.some((p) => p.from === it.operator_id && p.to === a.operator_id)) pairs.push({ from: it.operator_id, to: a.operator_id });
  });
  return { pair: pairs[0] || null, extra: Math.max(0, pairs.length - 1) };
}

/* ---- riepilogo di cassa (RightRail) --------------------------------------- */

/** «Incassato oggi» di GET /api/sales/today-summary (contratto C23): si mostra
 *  quando è diverso dal venduto, con le voci che fanno la differenza — gift
 *  card usate e caparre detratte (denaro entrato un altro giorno), caparre
 *  incassate oggi, caparre restituite oggi. Prima compariva solo con gift card
 *  riscattate (05-16). `cash_in` arriva già al netto dei rimborsi: qui non si
 *  sottrae niente. Confronto in centesimi. */
export function cashUpLines(summary) {
  if (!summary) return null;
  const cents = (v) => Math.round(Number(v || 0) * 100);
  const parts = ['deposit_cashed', 'gift_card_redeemed', 'deposit_used', 'deposit_refunded']
    .filter((key) => cents(summary[key]) > 0)
    .map((key) => ({ key, amount: Number(summary[key]) }));
  return { show: cents(summary.cash_in) !== cents(summary.total), cashIn: Number(summary.cash_in || 0), parts };
}
