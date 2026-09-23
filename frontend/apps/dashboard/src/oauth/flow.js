// flow.js — lega il ritorno del popup Yourang al flusso avviato in QUESTA finestra.
//
// Il codice monouso che il proxy rimette nell'URL (?yr_link=) non dice chi ha
// avviato il flusso: un link /oauth-popup/done?mode=connect&yr_link=… mandato da
// un altro veniva riscattato con la sessione del titolare e ricollegava il salone
// all'org dell'attaccante (con mode=login si entrava nel salone dell'attaccante).
// All'avvio il backend conia uno state firmato (torna nell'URL) e un nonce, che
// teniamo nel sessionStorage: è per scheda, quindi un link aperto altrove non lo
// ha, e senza nonce l'exchange non parte (e il backend lo rifiuterebbe comunque).
//
// Tutte le funzioni accettano uno storage nullo: sessionStorage può mancare o
// lanciare (cookie bloccati, navigazione privata su alcuni browser).

export const FLOW_KEY = 'yourang-oauth-flow';
export const RESTART_KEY = 'yourang-oauth-restarted';

/** Ricorda il flusso avviato qui. false se lo storage non è utilizzabile. */
export function saveFlow(storage, mode, nonce) {
  if (!storage || !nonce) return false;
  try {
    storage.setItem(FLOW_KEY, JSON.stringify({ mode, nonce }));
    return true;
  } catch {
    return false;
  }
}

/** Legge e CONSUMA il flusso avviato qui; null se manca o è di un altro mode. */
export function takeFlow(storage, mode) {
  if (!storage) return null;
  let flow = null;
  try {
    flow = JSON.parse(storage.getItem(FLOW_KEY) || 'null');
  } catch {
    flow = null;
  }
  try { storage.removeItem(FLOW_KEY); } catch { /* ignore */ }
  if (!flow || flow.mode !== mode || typeof flow.nonce !== 'string' || !flow.nonce) return null;
  return flow;
}

/**
 * Login arrivato senza un flusso di questa scheda (scorciatoia di Yourang che
 * punta dritta al ritorno, o link di qualcun altro): si riparte UNA volta da
 * /oauth-popup/start, che conia state e nonce propri — il codice altrui non
 * viene mai riscattato. true = ripartire; false = già ripartiti, mostrare l'errore.
 */
export function claimRestart(storage) {
  if (!storage) return false;
  try {
    if (storage.getItem(RESTART_KEY)) {
      storage.removeItem(RESTART_KEY);
      return false;
    }
    storage.setItem(RESTART_KEY, '1');
    return true;
  } catch {
    return false;
  }
}

/** Flusso valido: il prossimo ritorno senza flusso potrà ripartire di nuovo. */
export function clearRestart(storage) {
  if (!storage) return;
  try { storage.removeItem(RESTART_KEY); } catch { /* ignore */ }
}
