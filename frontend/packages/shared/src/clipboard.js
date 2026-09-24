// clipboard.js — copia negli appunti, dicendo se è riuscita davvero.
// Logica pura: il browser arriva come `env` (navigator, document), così i test
// la provano senza DOM. È la logica di `copyText` dell'agenda
// (apps/dashboard/src/sections/agenda/modals/rules.js), qui perché serve anche
// fuori dall'agenda: i campi «Copia» delle Impostazioni e delle Automazioni
// non aspettavano l'esito e annunciavano «Copiato» anche quando la copia era
// rifiutata (voce 47).

/** Copia `text` negli appunti → true se è riuscita, altrimenti false (mai
 *  un'eccezione). `navigator.clipboard` manca fuori da HTTPS e può rifiutare
 *  (permesso negato): allora si ripiega su execCommand('copy') da una
 *  textarea nascosta. */
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
