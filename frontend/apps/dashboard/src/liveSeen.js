// liveSeen.js — memoria degli eventi live già consegnati (contratto C20).
//
// Stream SSE e polling di coerenza rileggono anche gli eventi scritti negli
// ultimi secondi sotto il cursore (su Postgres una transazione che prendeva
// l'id N e committava dopo N+1 veniva scavalcata e l'evento non arrivava a
// nessuna postazione): lo stesso evento può quindi arrivare due volte, dallo
// stream a ogni riconnessione e dal polling di riserva per tutta la finestra.
// Senza scartarli la campanella mostrava doppioni (con key React duplicate), il
// contatore dei non letti cresceva a ogni giro e le viste si ricaricavano due
// volte per la stessa modifica.

/** Insieme limitato degli id visti: `fresh(list)` restituisce solo gli eventi
 *  mai consegnati prima (anche i doppioni dentro la stessa lista) e li segna.
 *  Il tetto tiene la memoria piccola: la finestra di riconsegna del server è di
 *  15 secondi, ben sotto qualche migliaio di eventi di un salone. */
export function createSeen(limit = 2000) {
  const ids = new Set();
  const order = [];
  return {
    fresh(list) {
      const out = [];
      for (const e of list || []) {
        const id = e && e.id;
        if (id == null) { out.push(e); continue; }  // senza id non si può riconoscere: passa
        if (ids.has(id)) continue;
        ids.add(id);
        order.push(id);
        out.push(e);
      }
      while (order.length > limit) ids.delete(order.shift());
      return out;
    },
  };
}

/** Debounce che NON perde eventi: `push(list)` accumula, e dopo `delay` ms di
 *  silenzio `deliver` riceve tutto quello arrivato nella finestra (una volta
 *  per id). Prima `useLive` passava solo gli eventi dell'ULTIMA consegna: se
 *  nei 250 ms arrivavano due consegne, l'evento di una cliente seguito da
 *  quello di un'altra si perdeva, e la scheda della prima — che filtra per
 *  `client_id` — non si ricaricava. `timers` si sostituisce nei test. */
export function createBatcher(delay, deliver, timers = { set: setTimeout, clear: clearTimeout }) {
  let pending = [];
  let handle = null;
  return {
    push(list) {
      if (!list || !list.length) return;
      pending.push(...list);
      timers.clear(handle);
      handle = timers.set(() => {
        handle = null;
        const seen = new Set();
        const batch = pending.filter((e) => {
          const id = e && e.id;
          if (id == null) return true;
          if (seen.has(id)) return false;
          seen.add(id);
          return true;
        });
        pending = [];
        deliver(batch);
      }, delay);
    },
    cancel() {
      timers.clear(handle);
      handle = null;
      pending = [];
    },
  };
}
