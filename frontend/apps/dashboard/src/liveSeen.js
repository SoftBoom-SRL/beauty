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
