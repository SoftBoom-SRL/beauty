// lib/retry.js — «409 → si riprova forzando», la regola di tutti i gesti
// dell'agenda. Lo staff può andare oltre le regole (fuori turno, centro
// chiuso, sovrapposizione): al primo tentativo si scrive senza forzare, così
// un orario libero non resta marcato «forzato» per niente; se il server
// risponde 409 si riscrive con force e basta, senza chiedere conferme. Era
// scritta a mano in dieci punti, con la condizione ricopiata ogni volta.
// Logica pura: la caricano anche i test con `node --test` (la chiamata al
// server la passa chi chiama).
import { ApiError } from '@youty/shared';

/** Il server dice che lo slot non è libero (occupato, fuori turno, centro chiuso). */
export const isConflict = (err) => err instanceof ApiError && err.status === 409;

/** Un gesto che non stava già forzando si ripete forzando: solo dopo un 409, e
 *  solo se `allowed` (chi non ha il permesso agenda non forza niente). Per i
 *  gesti che si rifanno da capo col parametro force (spostamenti, stacco,
 *  ripristino, durata). */
export const retryForced = (err, forced, allowed = true) => isConflict(err) && !forced && allowed;

/** Per chi manda le due richieste di seguito: `send(false)`, e al 409
 *  `send(true)`. `retry()` decide se ripetere (di norma sì; il pannello che
 *  prima deve far scegliere un altro orario risponde no, dopo aver avvisato).
 *  Ritorna { res, forced, stopped }: `stopped` = 409 senza ripetere. Ogni altro
 *  errore, e quello del secondo tentativo, arriva a chi chiama. */
export async function withForceRetry(send, { retry = () => true } = {}) {
  try {
    return { res: await send(false), forced: false, stopped: false };
  } catch (err) {
    if (!isConflict(err)) throw err;
    if (!retry(err)) return { res: undefined, forced: false, stopped: true };
    return { res: await send(true), forced: true, stopped: false };
  }
}
