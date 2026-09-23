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
