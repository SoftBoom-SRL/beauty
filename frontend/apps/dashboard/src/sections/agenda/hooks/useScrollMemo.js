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
export function useScrollMemo({ scrollRef, headRef, memo, g0, pxm, ghost, dayKey, ready = true }) {
  const ownMemo = useRef(null);
  const mem = memo || ownMemo;
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!ready || !el || mem.current == null) return;
    el.scrollTop = Math.max(0, (mem.current - g0) * pxm);
  }, [ready, g0]); // eslint-disable-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!ready || !el || !ghost) return;
    const top = (minutesOfDay(ghost.start) - g0) * pxm;                 // nella griglia, sotto l'intestazione
    const visible = el.clientHeight - (headRef.current?.offsetHeight || 0);
    if (top < el.scrollTop || top + 24 > el.scrollTop + visible) el.scrollTop = Math.max(0, top - 40);
  }, [ready, ghost?.id, ghost?.start, dayKey]); // eslint-disable-line react-hooks/exhaustive-deps
  return function remember() {
    const el = scrollRef.current;
    if (el) mem.current = g0 + el.scrollTop / pxm;
  };
}
