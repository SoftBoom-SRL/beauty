// lib.js — agenda section helpers (grid math, ISO building, waitlist ranking)
import { ApiError, fmtEur, isoAtMin, minutesOfDay, parseISO, timeLabel, toDateStr } from '@youty/shared';

export const DK_START = 8 * 60;   // grid 08:00
export const DK_END = 20 * 60;    // grid 20:00
export const PXM = 1.35;          // px per minute (zoom 1)

/* ---- Zoom delle viste calendario -------------------------------------------
 * Quanto è alta un'ora sullo schermo. È una preferenza PERSONALE della
 * postazione, non del salone: chi sta al banco su un monitor grande vuole
 * vedere la giornata intera, chi lavora su un portatile vuole leggere i
 * quarti d'ora. Non tocca MAI la fascia di prenotazione (Impostazioni →
 * intervallo slot), che resta una regola del salone: qui si cambia solo la
 * scala del disegno, come fanno i calendari professionali (Fresha ha uno
 * "zoom" personale a cursore, Vagaro la spaziatura delle righe più il pinch,
 * Apple "quante ore vedere per schermata").
 * I passi sono moltiplicatori di PXM; «adatta» calcola un valore libero. */
export const ZOOM_STEPS = [0.5, 0.65, 0.8, 1, 1.25, 1.6, 2];
export const ZOOM_MIN = 0.4;
export const ZOOM_MAX = 2.5;
export const clampZoom = (z) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Number(z) || 1));
/** Passo successivo (dir +1) o precedente (dir −1) a partire da un valore libero. */
export function zoomStep(current, dir) {
  const z = clampZoom(current);
  if (dir > 0) return clampZoom(ZOOM_STEPS.find((s) => s > z + 0.001) ?? ZOOM_MAX);
  return clampZoom([...ZOOM_STEPS].reverse().find((s) => s < z - 0.001) ?? ZOOM_MIN);
}
export const COLW = 158;          // min operator column width

/** Eventi live dopo cui le viste giorno, settimana e mese si ricaricano.
 *  Ognuna ne ascoltava un pezzo diverso, e ciascuna restava ferma su qualcosa:
 *  - `deposit.` e `sale.`: la caparra pagata online e l'incasso in cassa
 *    (anche `appointment.closed` del conto) — in settimana e nel mese il
 *    pallino «caparra da versare» e la visita «in corso» restavano lì;
 *  - `operator.` e `settings.`: turni, assenze e orari del centro cambiati da
 *    un'altra postazione — la colonna di un'assente restava «in turno», il
 *    trascinamento diceva «Disponibile» e lo spostamento partiva forzato sopra
 *    un'assenza, senza che nessuno lo vedesse; nel mese l'occupazione restava
 *    quella vecchia. */
export const AGENDA_LIVE_RE = /^(appointment|pause|waitlist|slot|visit|sale|deposit|operator|settings)\./;

export const MONTHS_IT = ['Gennaio', 'Febbraio', 'Marzo', 'Aprile', 'Maggio', 'Giugno', 'Luglio', 'Agosto', 'Settembre', 'Ottobre', 'Novembre', 'Dicembre'];
export const MONTHS_EN = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const DOW_IT = ['Lun', 'Mar', 'Mer', 'Gio', 'Ven', 'Sab', 'Dom'];
export const DOW_EN = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/* ---- appointment helpers (day/week payload objects) ---- */
export const aStartMin = (a) => minutesOfDay(a.start);
export const aDur = (a) => a.total_duration_min ?? a.duration_min ?? 0;
export const aEndMin = (a) => aStartMin(a) + aDur(a);
export const svcLabel = (a) => (a.items || []).map((i) => i.service_name).join(' + ');
export const firstName = (full) => String(full || '').split(' ')[0];
export const lastName = (full) => String(full || '').trim().split(/\s+/).slice(1).join(' ');

/** Nome da mostrare in agenda: solo nome di battesimo; in caso di omonimia tra le
 *  operatrici (`firsts` = pool di nomi) aggiunge l'iniziale del cognome ("Giulia V.").
 *  Il nome completo resta per l'hover (title). */
export function opDisplay(first, last, firsts) {
  const f = String(first || '');
  const clash = (firsts || []).filter((x) => String(x || '').toLowerCase() === f.toLowerCase()).length > 1;
  return clash && last ? `${f} ${String(last)[0].toUpperCase()}.` : f;
}
export const initialsOf = (full) =>
  String(full || '').split(' ').filter(Boolean).map((w) => w[0]).join('').slice(0, 2).toUpperCase();

/** €-format that never says "Gratis" for zero sums */
export const fmtMoney = (n, lang) => (Number(n) ? fmtEur(Number(n), lang) : '€0');

/** Espande un appuntamento in blocchi per-servizio concatenati dallo `start`.
 *  Ogni servizio è un blocco nella colonna della sua operatrice, con orario e
 *  durata propri (la catena riflette chi fa cosa e quando). Ritorna:
 *  [{ item, appt, apptId, startMin, dur, opId, order, index, isFirst, isLast }] */
export function itemBlocks(appt) {
  const base = aStartMin(appt);
  const items = [...(appt.items || [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  let cursor = base;
  return items.map((item, i) => {
    const activeMin = item.duration_min || 0;   // fase attiva (operatrice al lavoro)
    const soakMin = item.soak_min || 0;          // fase di posa (operatrice non impegnata)
    const dur = activeMin + soakMin;             // durata totale per il cliente
    const block = {
      item, appt, apptId: appt.id, startMin: cursor, dur, activeMin, soakMin,
      opId: item.operator_id, order: item.order ?? i, index: i,
      isFirst: i === 0, isLast: i === items.length - 1,
    };
    cursor += dur;
    return block;
  });
}

/** "YYYY-MM-DD" + minuti → ISO8601 dell'istante, nel fuso del SALONE.
 *  Riesportato da @youty/shared: costruirlo con lo scarto del dispositivo
 *  faceva creare appuntamenti spostati di ore da una postazione su un altro
 *  fuso — si sceglievano le 10:00 e ne arrivavano al server altre. */
export { isoAtMin };

/** Monday (Date) of the week containing the given date/ISO string */
export function mondayOf(date) {
  const d = parseISO(date);
  const dow = (d.getDay() + 6) % 7; // 0 = Monday
  d.setDate(d.getDate() - dow);
  d.setHours(0, 0, 0, 0);
  return d;
}

/** shift an ISO date by n months, clamped to day 1 */
export function addMonths(dateStr, n) {
  const d = parseISO(dateStr);
  return toDateStr(new Date(d.getFullYear(), d.getMonth() + n, 1));
}

/** Vero quando uno spostamento non muove niente (stesso orario, stessa
 *  operatrice): si esce prima di chiamare il server.
 *
 *  `from` va passato ESPLICITO da chi rimanda un appuntamento indietro
 *  («Annulla»): quel percorso ha in mano l'oggetto di prima dello spostamento,
 *  e confrontando il ritorno con `appt.start` il movimento sembrava un
 *  non-movimento — l'annullamento non partiva e l'appuntamento restava dove
 *  era stato spostato, senza dire niente.
 *
 *  Conta anche il GIORNO (`toDate` contro `from.date`, "YYYY-MM-DD"): «Sposta
 *  qui» sull'ombra di un altro giorno arriva proprio con la stessa ora e la
 *  stessa colonna, e confrontando solo quelle la cliente di martedì alle 10
 *  che chiedeva «giovedì, stessa ora» restava a martedì — nessuna richiesta,
 *  nessun avviso. Senza date si confrontano solo ora e operatrice. */
export const moveIsNoop = (startMin, opId, from, toDate = null) =>
  startMin === undefined || (
    startMin === from.startMin && opId === from.opId
    && (toDate == null || from.date == null || toDate === from.date)
  );

/** Servizio dell'ombra sotto il punto (colonna `opId`, minuto `minute`), o null.
 *  L'ombra è l'appuntamento aperto nel pannello disegnato su un altro giorno:
 *  un riquadro per servizio, ognuno nella colonna di chi lo fa. */
export function ghostBlockAt(ghost, opId, minute) {
  if (!ghost || minute == null) return null;
  return itemBlocks(ghost).find((b) => b.opId === opId && minute >= b.startMin && minute < b.startMin + Math.max(b.dur, 1)) || null;
}

/** Dove porta «Sposta qui»: { startMin, opId, fromOp }.
 *  - clic sull'ombra (`slot.ghostHit`): stesso orario e stesse operatrici, cambia
 *    solo il giorno. Col clic sull'ombra della piega (11:00, Giulia) la visita
 *    partiva alle 11:00 e i servizi di Anna passavano a Giulia: l'ombra diceva
 *    «qui» e l'appuntamento finiva altrove, con un'altra operatrice;
 *  - clic su uno spazio libero: la visita parte all'ora cliccata e i servizi
 *    dell'operatrice principale passano alla colonna cliccata (quelli affidati
 *    alle colleghe restano loro, spostati dello stesso tanto). */
export function moveHereTarget(appt, slot) {
  if (slot.ghostHit) return { startMin: aStartMin(appt), opId: appt.operator_id, fromOp: appt.operator_id };
  return { startMin: slot.startMin, opId: slot.opId, fromOp: appt.operator_id };
}

/** ApiError → toast, with network fallback */
export function toastErr(err, t, fireToast) {
  if (err instanceof ApiError) fireToast({ msg: err.message, icon: 'alert' });
  else fireToast({ msg: t('Errore di rete', 'Network error'), icon: 'alert' });
}

/** "HH:MM" → minutes of day (shift windows come as [["09:00","13:00"], ...]) */
export function hmToMin(hm) {
  const [h, m] = String(hm).split(':').map(Number);
  return h * 60 + (m || 0);
}

/** pack overlapping blocks into side-by-side lanes (week view) — blocks need startMin/endMin */
export function weekLayout(list) {
  const sorted = list.map((a) => ({ ...a })).sort((x, y) => x.startMin - y.startMin || y.endMin - x.endMin);
  const out = [];
  let cluster = [], clusterEnd = -1;
  const flush = () => {
    const laneEnds = [];
    cluster.forEach((a) => {
      let l = laneEnds.findIndex((e) => e <= a.startMin);
      if (l === -1) { l = laneEnds.length; laneEnds.push(a.endMin); } else laneEnds[l] = a.endMin;
      a._lane = l;
    });
    const lc = Math.max(1, laneEnds.length);
    cluster.forEach((a) => { a._laneCount = lc; out.push(a); });
    cluster = [];
  };
  sorted.forEach((a) => {
    if (cluster.length && a.startMin >= clusterEnd) { flush(); clusterEnd = -1; }
    cluster.push(a);
    clusterEnd = Math.max(clusterEnd, a.endMin);
  });
  flush();
  return out;
}

/** Vero se `value` ("YYYY-MM-DD" di <input type="date">) è una data da cui
 *  saltare. Scrivendo l'anno a tastiera il campo passa per 0002, 0020, 0202:
 *  sono date valide per il browser, e al primo tasto l'agenda saltava al 1902
 *  (gli anni 0–99 di Date sono il Novecento). */
export function plausibleDate(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
  return !!m && Number(m[1]) >= 1900;
}

/* ---- waitlist helpers ---- */

/** label for a WaitlistOut preference */
export function prefLabel(w, t) {
  const days = (w.exact_days || []).map((d) => t(DOW_IT[d], DOW_EN[d])).join(', ');
  switch (w.preference) {
    case 'morning': return t('Mattina', 'Morning');
    case 'afternoon': return t('Pomeriggio', 'Afternoon');
    case 'weekend': return t('Weekend', 'Weekend');
    case 'exact': return [days, w.exact_time ? String(w.exact_time).slice(0, 5) : ''].filter(Boolean).join(' · ') || t('Giorni precisi', 'Exact days');
    default: return t('Qualsiasi orario', 'Any time');
  }
}

/** Operatrici coinvolte in una visita: quelle dei singoli servizi più la
 *  principale. È la stessa regola del backend (free_slot_event), che sulle voci
 *  di lista d'attesa guarda TUTTI gli item: qui si guardava solo l'operatrice
 *  principale, e chi aspettava un servizio con la collega che lo esegue
 *  davvero non veniva contato fra i match. */
export const apptOperatorIds = (appt) =>
  new Set([...(appt.items || []).map((i) => i.operator_id), appt.operator_id].filter((x) => x != null));

/** entries matching a freed appointment: same service + compatible operator, still active */
export function wlMatches(waitlist, appt) {
  const svcIds = (appt.items || []).map((i) => i.service_id);
  const opIds = apptOperatorIds(appt);
  return (waitlist || []).filter((w) =>
    w.status === 'active' &&
    svcIds.includes(w.service_id) &&
    (w.operator_id == null || opIds.has(w.operator_id))
  );
}

/** rank waitlist entries for a freed slot (service match assumed) */
export function wlRank(entries, appt) {
  const hour = Math.floor(aStartMin(appt) / 60);
  // Giorno della settimana sul calendario del SALONE: getDay() sull'ISO
  // dell'API legge il fuso del dispositivo, e da una postazione su un altro
  // fuso (o a cavallo della mezzanotte UTC) il venerdì sera diventava sabato —
  // «weekend» e «giorni precisi» premiavano le voci sbagliate.
  const dow = (parseISO(toDateStr(appt.start)).getDay() + 6) % 7;
  const opIds = apptOperatorIds(appt);
  const score = (w) => {
    let s = 10;
    if (w.operator_id != null && opIds.has(w.operator_id)) s += 5;
    if (w.preference === 'morning' && hour < 13) s += 4;
    else if (w.preference === 'afternoon' && hour >= 13) s += 4;
    else if (w.preference === 'weekend' && dow >= 5) s += 4;
    else if (w.preference === 'exact' && (w.exact_days || []).includes(dow)) s += 4;
    else if (w.preference === 'any') s += 2;
    const days = Math.max(0, (Date.now() - new Date(w.created_at).getTime()) / 86400000);
    s += Math.min(days * 0.3, 5);
    return s;
  };
  return [...entries].sort((a, b) => score(b) - score(a));
}

/** days on the waiting list (from created_at) */
export function wlDaysWaiting(w) {
  return Math.max(0, Math.floor((Date.now() - new Date(w.created_at).getTime()) / 86400000));
}

/** WhatsApp suggestion copy for a freed slot (display only — Yourang sends) */
export function wlWhatsAppMsg(w, appt, lang, salonName) {
  const name = firstName(w.client_name);
  const slot = timeLabel(aStartMin(appt)) + '–' + timeLabel(aEndMin(appt));
  const svc = w.service_name;
  if (lang === 'en') return `Hi ${name}, a slot just opened up for ${svc} at ${slot}. Would you like to book it? 💜 ${salonName || ''}`.trim();
  return `Ciao ${name}, si è liberato un posto per ${svc} alle ${slot}. Ti interessa prenotarlo? 💜 ${salonName || ''}`.trim();
}

/* --- Anteprima passo-passo del flusso no-show / cancellazione -------------
 * Restituiscono l'array di passi per <FlowSteps>. I contenuti rispecchiano
 * l'esito reale del backend (apps/agenda/services.py): no-show/cancell. tardiva
 * → caparra trattenuta; cancell. anticipata → rimborsata; senza caparra nulla.
 * `matchCount` = voci di lista d'attesa compatibili (null finché in caricamento). */

const _slotStep = (appt, t) => ({
  n: 3,
  title: t('Slot liberato', 'Slot freed'),
  detail: timeLabel(aStartMin(appt)) + '–' + timeLabel(aEndMin(appt)),
  tone: 'default',
});

const _waitlistStep = (matchCount, t) => ({
  n: 4,
  title: t("Proposto alla lista d'attesa", 'Offered to the waiting list'),
  detail:
    matchCount == null
      ? '…'
      : matchCount > 0
        ? t(`${matchCount} in attesa`, `${matchCount} waiting`)
        : t('nessuno compatibile', 'none matching'),
  tone: matchCount ? 'default' : 'muted',
});

const _paid = (appt) => appt.deposit_status === 'paid';
const _depEur = (appt, lang) => fmtEur(Number(appt.deposit_amount), lang);

export function noShowSteps(appt, matchCount, t, lang) {
  return [
    { n: 1, title: t('No-show confermato', 'No-show confirmed'), tone: 'danger' },
    _paid(appt)
      ? { n: 2, title: t('Caparra trattenuta', 'Deposit forfeited'), detail: _depEur(appt, lang), tone: 'danger' }
      : { n: 2, title: t('Nessuna caparra', 'No deposit'), detail: '—', tone: 'muted' },
    _slotStep(appt, t),
    _waitlistStep(matchCount, t),
  ];
}

export function cancelSteps(appt, late, matchCount, t, lang) {
  let dep;
  if (!_paid(appt)) {
    dep = { n: 2, title: t('Nessuna caparra', 'No deposit'), detail: '—', tone: 'muted' };
  } else if (late) {
    dep = { n: 2, title: t('Caparra trattenuta', 'Deposit forfeited'), detail: _depEur(appt, lang), tone: 'danger' };
  } else {
    // Il rimborso avviene su Stripe se la caparra è stata pagata online; altrimenti
    // resta «da rimborsare» finché lo staff non lo conferma dal dettaglio.
    dep = { n: 2, title: t('Caparra da rimborsare', 'Deposit to refund'), detail: _depEur(appt, lang), tone: 'default' };
  }
  return [
    { n: 1, title: t('Cancellazione confermata', 'Cancellation confirmed'), tone: 'danger' },
    dep,
    _slotStep(appt, t),
    _waitlistStep(matchCount, t),
  ];
}

/* ---- Spiegazione della disponibilità di uno slot (lato client) --------------
 * Replica le regole di apps/agenda/services.py sui dati già in pagina (righe di
 * GET /api/agenda/day): finestre di turno, appuntamenti (fase attiva + posa) e
 * pause dell'operatrice. Serve a dire PRIMA di provare — e non dopo un 409 —
 * perché in quel punto non si può inserire o spostare un appuntamento.
 *
 * row      : { operator, windows, appointments, pauses }   (una riga del giorno)
 * startMin : inizio richiesto (minuti da mezzanotte), durMin: durata totale
 * opts     : { excludeApptId, nowMin (solo se la data è oggi), t, rows }
 *
 * `rows` = tutte le righe del giorno. Serve perché un appuntamento è elencato
 * nella riga dell'operatrice PRINCIPALE, ma i suoi servizi possono essere
 * eseguiti da altre: senza guardare anche le altre righe, un orario in cui
 * l'operatrice sta lavorando dentro la visita di una collega risultava
 * «Disponibile», e il server rispondeva 409 dopo il clic.
 *
 * Ritorna { ok, code, label, detail } con code ∈
 *   ok | past | off | closed | pause | busy | soak
 * `soak` è ok=true con avviso: sovrapposizione alla posa altrui (ammessa a mano).
 */
export function explainSlot(row, startMin, durMin, opts = {}) {
  // `excludeItemId`: serve allo stacco, dove si muove UN servizio solo. Gli
  // altri della stessa visita restano dov'erano e occupano davvero quel tempo,
  // quindi non si può escludere l'intero appuntamento come in uno spostamento.
  // `sameClientId`: i trattamenti della STESSA cliente non si fanno concorrenza.
  // Nail art sopra la manicure in posa è una seduta sola, non uno scontro di
  // agenda: segnalarla come «occupata» costringeva a forzare un incastro che
  // incastro non è.
  const { excludeApptId = null, excludeItemId = null, excludePauseId = null, nowMin = null, sameClientId = null, t = (it) => it, rows = null } = opts;
  const endMin = startMin + Math.max(durMin || 0, 1);
  const win = (row?.windows || []).map(([a, b]) => [hmToMin(a), hmToMin(b)]).sort((x, y) => x[0] - y[0]);
  const winLabel = win.map(([a, b]) => `${timeLabel(a)}–${timeLabel(b)}`).join(' · ');

  if (nowMin != null && startMin < nowMin) {
    return { ok: false, code: 'past', label: t('Orario passato', 'Time already passed'), detail: '' };
  }
  if (!win.length) {
    return { ok: false, code: 'off', label: t('Non in turno oggi', 'Not on shift today'), detail: '' };
  }
  const inside = win.find(([a, b]) => a <= startMin && endMin <= b);
  if (!inside) {
    const starts = win.find(([a, b]) => a <= startMin && startMin < b);
    if (starts) {
      return {
        ok: false, code: 'closed',
        label: t(`Sfora la fine del turno (${timeLabel(starts[1])})`, `Runs past the end of the shift (${timeLabel(starts[1])})`),
        detail: t('Turno', 'Shift') + ' ' + winLabel,
      };
    }
    return { ok: false, code: 'closed', label: t('Fuori turno', 'Off shift'), detail: t('Turno', 'Shift') + ' ' + winLabel };
  }
  for (const p of row.pauses || []) {
    if (excludePauseId != null && p.id === excludePauseId) continue;
    const ps = aStartMin(p), pe = ps + (p.duration_min || 0);
    if (ps < endMin && pe > startMin) {
      return { ok: false, code: 'pause', label: t(`In pausa fino alle ${timeLabel(pe)}`, `On a break until ${timeLabel(pe)}`), detail: p.note || '' };
    }
  }
  let soakHit = null;
  // Gli appuntamenti di TUTTE le righe, non solo di questa: un servizio di
  // questa operatrice può vivere dentro la visita di una collega.
  const seen = new Set();
  const candidates = [];
  for (const source of (rows && rows.length ? rows : [row])) {
    for (const a of source?.appointments || []) {
      if (seen.has(a.id)) continue;
      seen.add(a.id);
      candidates.push(a);
    }
  }
  for (const a of candidates) {
    if (excludeApptId != null && a.id === excludeApptId) continue;
    if (sameClientId != null && a.client?.id === sameClientId) continue;
    if (a.status === 'cancelled' || a.status === 'no_show') continue;
    for (const b of itemBlocks(a)) {
      if (excludeItemId != null && b.item.id === excludeItemId) continue;
      if (b.opId !== row.operator?.id) continue;
      const activeEnd = b.startMin + b.activeMin;
      if (b.startMin < endMin && activeEnd > startMin) {
        return {
          ok: false, code: 'busy',
          label: t(`Occupata fino alle ${timeLabel(activeEnd)}`, `Busy until ${timeLabel(activeEnd)}`),
          detail: `${a.client?.full_name || ''} · ${b.item.service_name}`.trim(),
        };
      }
      if (b.soakMin && activeEnd < endMin && activeEnd + b.soakMin > startMin) soakHit = { a, until: activeEnd + b.soakMin };
    }
  }
  if (soakHit) {
    return {
      ok: true, code: 'soak',
      label: t(`Posa di ${firstName(soakHit.a.client?.full_name)} fino alle ${timeLabel(soakHit.until)}`, `${firstName(soakHit.a.client?.full_name)}'s soak until ${timeLabel(soakHit.until)}`),
      detail: t('Sovrapposizione consentita', 'Overlap allowed'),
    };
  }
  return { ok: true, code: 'ok', label: t('Disponibile', 'Available'), detail: '' };
}

/** Prossimi orari liberi (max `n`) per l'operatrice a partire da `fromMin`, a passi di `step`. */
export function nextFreeSlots(row, fromMin, durMin, step, n = 4, opts = {}) {
  const out = [];
  for (let m = fromMin; m < DK_END && out.length < n; m += step) {
    if (explainSlot(row, m, durMin, opts).ok) out.push(m);
  }
  return out;
}

/* ---- Righe orarie delle griglie (vista giorno e settimana) -------------------
 * Il titolare vuole leggere l'ora «a colpo d'occhio»: ora piena marcata,
 * mezz'ora tratteggiata più chiara, quarti appena percettibili e SOLO se il
 * passo dell'agenda è 15' (con passo 30/60 sarebbero rumore). Le righe vanno
 * sempre sotto i blocchi (z-index basso) e non intercettano il puntatore, così
 * non interferiscono con drag e click sugli spazi vuoti. */
export const GRID_LINE_STYLE = {
  hour: { height: 1, background: 'color-mix(in srgb, var(--ink) 14%, transparent)' },
  half: { height: 0, borderTop: '1px dashed color-mix(in srgb, var(--ink) 10%, transparent)' },
  quarter: { height: 1, background: 'color-mix(in srgb, var(--ink) 4%, transparent)' },
};

/* ---- Fascia oraria delle griglie (vista giorno e settimana) -----------------
 * Era fissa, 08:00–20:00: la sposa forzata alle 07:00 non compariva né in
 * giorno né in settimana (il blocco finiva sotto l'intestazione), e con i turni
 * fino alle 21 la fascia 20–21 non si poteva cliccare e un trascinamento la
 * schiacciava alle 19:45. Ora la fascia è quella del giorno: orari del centro e
 * turni, allargata a ore piene per gli appuntamenti e le pause che ci sono
 * davvero. Senza orari né turni si parte dalle 08–20 di sempre.
 * `base` e `extra` = [[da, a], …] in minuti dalla mezzanotte. */
export function gridRange(base, extra = []) {
  const all = [...((base && base.length) ? base : [[DK_START, DK_END]]), ...(extra || [])];
  let lo = Infinity, hi = -Infinity;
  for (const [s, e] of all) {
    if (!Number.isFinite(s) || !Number.isFinite(e)) continue;
    if (s < lo) lo = s;
    if (e > hi) hi = e;
  }
  if (!Number.isFinite(lo)) return { start: DK_START, end: DK_END };
  const start = Math.max(0, Math.floor(lo / 60) * 60);
  const end = Math.min(24 * 60, Math.max(start + 60, Math.ceil(hi / 60) * 60));
  return { start, end };
}

/** Fine di un appuntamento: l'ultimo servizio della catena, posa compresa. */
const apptSpan = (a) => {
  const s = aStartMin(a);
  const blocks = itemBlocks(a);
  const e = blocks.length ? Math.max(...blocks.map((b) => b.startMin + b.dur)) : s + aDur(a);
  return [s, Math.max(e, s + 1)];
};

/** Fascia della vista giorno. `rows` = righe di /agenda/day (turni,
 *  appuntamenti, pause), `opening` = fasce del centro di quel giorno
 *  [["09:00","19:00"], …], `ghost` = appuntamento aperto nel pannello, che su
 *  un altro giorno si disegna in trasparenza e deve restare visibile. */
export function dayGridRange(rows, opening, ghost = null) {
  const base = (opening || []).map(([a, b]) => [hmToMin(a), hmToMin(b)]);
  const extra = [];
  for (const r of rows || []) {
    for (const [a, b] of r.windows || []) base.push([hmToMin(a), hmToMin(b)]);
    for (const a of r.appointments || []) if (a.status !== 'cancelled') extra.push(apptSpan(a));
    for (const p of r.pauses || []) extra.push([aStartMin(p), aStartMin(p) + (p.duration_min || 0)]);
  }
  if (ghost) extra.push(apptSpan(ghost));
  return gridRange(base, extra);
}

/** Fascia della vista settimana: una sola scala per i sette giorni, dagli orari
 *  del centro di tutta la settimana (`openingWeek` = settings.opening_hours_week)
 *  e dagli appuntamenti del payload /agenda/week (`duration_min` = totale). */
export function weekGridRange(days, openingWeek, ghost = null) {
  const base = [];
  for (const ranges of Object.values(openingWeek || {})) {
    for (const [a, b] of ranges || []) base.push([hmToMin(a), hmToMin(b)]);
  }
  const extra = [];
  for (const d of days || []) {
    for (const a of d.appointments || []) {
      const s = minutesOfDay(a.start);
      extra.push([s, s + Math.max(a.duration_min || 0, 1)]);
    }
  }
  if (ghost) extra.push(apptSpan(ghost));
  return gridRange(base, extra);
}

/** Fasce del centro per il giorno "YYYY-MM-DD" (settings.opening_hours_week). */
export function openingFor(settings, dateStr) {
  const week = settings?.opening_hours_week;
  if (!week || !Object.keys(week).length || !dateStr) return [];
  return week[String((parseISO(dateStr).getDay() + 6) % 7)] || [];
}

/** Segni orari da disegnare: [{ m, kind }] con kind ∈ hour | half | quarter,
 *  dalla fascia `start`–`end` (minuti; di norma quella di gridRange). */
export function gridMarks(step, start = DK_START, end = DK_END) {
  const out = [];
  for (let m = start; m <= end; m += 15) {
    if (m % 60 === 0) out.push({ m, kind: 'hour' });
    else if (m % 30 === 0) out.push({ m, kind: 'half' });
    else if (step === 15) out.push({ m, kind: 'quarter' });
  }
  return out;
}

/** Sotto-colonne di un giorno in vista settimana.
 *
 *  Le operatrici della sede attiva — chi non ha sede vale per tutte, la stessa
 *  regola della vista giorno — e in coda chi ha comunque appuntamenti quel
 *  giorno: di un'altra sede (col suo nome) o non più in team (`orphanName`).
 *  Prima c'erano le sotto-colonne delle operatrici di TUTTE le sedi: in
 *  settimana si prenotava a nome di chi lavora altrove.
 *  `appointments` = gli appuntamenti del giorno (payload /agenda/week). */
export function weekDayOps(operators, locationId, appointments, orphanName) {
  const all = operators || [];
  const base = all.filter((o) => !locationId || o.location_id == null || o.location_id === locationId);
  const known = new Set(base.map((o) => o.id));
  const extra = [];
  for (const a of appointments || []) {
    const id = a.operator_id;
    if (!id || known.has(id)) continue;
    known.add(id);
    extra.push(all.find((o) => o.id === id) || { id, first_name: orphanName, last_name: '', inactive: true });
  }
  return base.concat(extra);
}

/** Incasso atteso nelle testate di giorno e settimana, con la regola del mese
 *  (agenda_range): il no-show non entra. Le testate lo contavano, e lo stesso
 *  giorno valeva un incasso in vista giorno e un altro nel mese. Si somma in
 *  centesimi: i prezzi arrivano come stringhe decimali ("45.10"). */
export function apptRevenue(list) {
  let cents = 0;
  for (const a of list || []) {
    if (a.status === 'no_show' || a.status === 'cancelled') continue;
    cents += Math.round(Number(a.total_price || 0) * 100);
  }
  return cents / 100;
}

/** Segmenti della striscia colorata di un blocco settimanale: uno per operatrice,
 *  in proporzione alla durata (attiva + posa), fondendo i consecutivi della stessa
 *  operatrice. Senza `items` (payload vecchio) → un solo segmento dell'operatrice. */
export function opSegments(a) {
  const items = (a.items || []).filter((it) => it && it.operator_id != null);
  if (!items.length) return [{ opId: a.operator_id, w: 1 }];
  const segs = [];
  items.forEach((it) => {
    const w = Math.max(1, (it.duration_min || 0) + (it.soak_min || 0));
    const last = segs[segs.length - 1];
    if (last && last.opId === it.operator_id) last.w += w;
    else segs.push({ opId: it.operator_id, w });
  });
  return segs;
}

// Geometria delle corsie e delle spine: sta in lanes.js, senza import, per
// poterla provare da sola (vedi apps/dashboard/test/lanes.test.js).
export { laneLayout, laneCss, visitSpines, serviceBands, COL_GUTTER } from './lanes.js';
