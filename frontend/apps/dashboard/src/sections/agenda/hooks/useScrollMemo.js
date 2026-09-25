// useScrollMemo — la griglia resta all'ora che si stava guardando e porta in
// vista l'ombra dell'appuntamento aperto.
// Sfogliando i giorni (o le settimane) la griglia passa dallo scheletro e
// tornava in cima: l'ombra dell'appuntamento aperto nel pannello — il motivo
// per cui si sfoglia — finiva fuori schermo. Il minuto in cima alla griglia
// si ricorda (`remember`, a ogni scroll) e si ritrova sul giorno dopo, anche
// quando la fascia oraria cambia; se poi l'ombra resta fuori vista, la si
// porta in vista.
import { useLayoutEffect, useRef } from 'react';
import { minutesOfDay } from '@youty/shared';

/** `memo` = ref del minuto in cima, se deve sopravvivere al rimontaggio (la
 *  vista giorno la tiene nella sezione); senza, ne usa una sua. `ghost` =
 *  l'appuntamento aperto su un altro giorno, `dayKey` = il giorno a video
 *  (quando cambia si riguarda l'ombra), `ready` = la griglia è disegnata (la
 *  settimana passa dallo scheletro senza ref). Ritorna `remember()`, da
 *  chiamare quando la griglia scorre. */
export function useScrollMemo({ scrollRef, headRef, memo, g0, pxm, ghost, dayKey, ready = true, initialMin = null }) {
  const ownMemo = useRef(null);
  const mem = memo || ownMemo;
  /* Senza un minuto da ricordare (la prima apertura) si parte da
   * `initialMin`: oggi, un'ora prima di adesso. Aprendo l'agenda alle 16 si
   * vedeva la mattina già passata e bisognava scorrere per trovare adesso.
   * Da lì il minuto si ricorda come uno scorrimento a mano: sfogliando i
   * giorni si resta alla stessa ora, che è lo scopo del memo. */
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const target = mem.current ?? initialMin;
    if (!ready || !el || target == null) return;
    el.scrollTop = Math.max(0, (target - g0) * pxm);
  }, [ready, g0]); // eslint-disable-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!ready || !el || !ghost) return;
    /* In coordinate del contenuto: dove comincia davvero il corpo della
     * griglia (in giorno c'è uno stacco di 8 px sotto l'intestazione), come
     * fanno lo zoom e «Adatta». Contando l'altezza dell'intestazione il
     * controllo era sfasato di quegli 8 px. */
    const headH = headRef.current?.offsetHeight || 0;
    const body = (el.querySelector('.dk-tl-cols') || el.querySelector('[data-daycol]'))?.parentElement;
    const top0 = body ? body.offsetTop : headH;
    const top = top0 + (minutesOfDay(ghost.start) - g0) * pxm;
    if (top < el.scrollTop + headH || top + 24 > el.scrollTop + el.clientHeight) el.scrollTop = Math.max(0, top - headH - 40);
  }, [ready, ghost?.id, ghost?.start, dayKey]); // eslint-disable-line react-hooks/exhaustive-deps
  return function remember() {
    const el = scrollRef.current;
    if (el) mem.current = g0 + el.scrollTop / pxm;
  };
}
