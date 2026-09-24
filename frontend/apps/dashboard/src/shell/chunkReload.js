// chunkReload.js — dopo un deploy, un pezzo dell'app che non si carica più.
//
// Sezioni e modali si caricano a richiesta (React.lazy): i file hanno un hash
// nel nome e l'immagine nuova non tiene quelli vecchi. La reception con l'agenda
// aperta da ore apriva «Nuovo appuntamento» o «Incassa» dopo un push di metà
// mattina, il chunk rispondeva 404, React.lazy rigettava e smontava tutto: pagina
// bianca e lavoro in corso perso. Ricaricare la pagina prende l'index.html nuovo
// (servito no-cache) con i nomi giusti.
//
// Una volta sola, però: se il chunk manca davvero anche dopo la ricarica (un
// deploy rotto) ricaricare di continuo renderebbe la dashboard inutilizzabile.
// Entro RELOAD_WINDOW_MS dalla ricarica precedente non si riprova e si mostra un
// avviso con il pulsante per ricaricare a mano.

export const RELOAD_KEY = 'dk-chunk-reload-at';
export const RELOAD_WINDOW_MS = 30000;

/** Vero per gli errori di caricamento di un modulo/chunk (Chrome, Firefox, Safari, Vite). */
export function isChunkLoadError(err) {
  if (!err) return false;
  if (err.name === 'ChunkLoadError') return true;
  const msg = String(err.message || err);
  return /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Unable to preload CSS|Loading (CSS )?chunk .* failed/i.test(msg);
}

let pending = false;

/** Vero se in questa pagina è già partita una ricarica per un chunk mancante. */
export function reloadPending() { return pending; }

function sessionStore() {
  try { return window.sessionStorage; } catch { return null; }
}

/**
 * Ricarica la pagina, al massimo una volta ogni RELOAD_WINDOW_MS.
 * Restituisce true se la ricarica è partita. Senza sessionStorage (navigazione
 * privata con storage bloccato) non si ricarica da soli: non ci sarebbe modo di
 * ricordare il tentativo, e un chunk mancante per davvero farebbe un ciclo.
 */
export function reloadOnce({ storage = sessionStore(), now = Date.now(), reload } = {}) {
  if (!storage) return false;
  let last;
  try { last = Number(storage.getItem(RELOAD_KEY)) || 0; } catch { return false; }
  if (last && now - last >= 0 && now - last < RELOAD_WINDOW_MS) return false;
  try { storage.setItem(RELOAD_KEY, String(now)); } catch { return false; }
  pending = true;
  (reload || (() => window.location.reload()))();
  return true;
}
