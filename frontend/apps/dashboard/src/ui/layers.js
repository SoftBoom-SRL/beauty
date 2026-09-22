import { useEffect, useRef } from 'react';

/*
 * Esc chiude la finestra IN PRIMO PIANO, e solo quella.
 *
 * Prima ogni modale, drawer e pannello registrava il suo ascoltatore su
 * `window`, e gli ascoltatori scattano in ordine di registrazione: vinceva
 * quello aperto per PRIMO, cioè quello sotto. Esc sulla conferma del pagamento
 * chiudeva l'intero check-out, Esc sul carico rapido chiudeva la scheda
 * prodotto sotto (con le sue modifiche), Esc per annullare un trascinamento
 * chiudeva il dettaglio aperto.
 *
 * Qui c'è una pila sola: chi si apre si mette in cima, e un solo ascoltatore
 * decide. La decisione arriva DOPO che tutti gli altri hanno visto il tasto
 * (setTimeout 0): chi usa Esc per sé — una tendina aperta, un trascinamento in
 * corso, un campo in modifica — chiama `e.preventDefault()` e nessuna finestra
 * si chiude. È l'unico contratto da rispettare.
 */

const stack = [];
let listening = false;

function onKeyDown(e) {
  if (e.key !== 'Escape' || e.defaultPrevented) return;
  setTimeout(() => {
    if (e.defaultPrevented) return;
    const top = stack[stack.length - 1];
    top?.current?.(e);
  }, 0);
}

/**
 * Registra un livello che si chiude con Esc finché `active` è vero.
 * `onEsc` può cambiare a ogni render (si legge sempre l'ultimo) e può decidere
 * di non chiudere: per esempio mentre un salvataggio è in corso.
 */
export function useEscLayer(active, onEsc) {
  const ref = useRef(onEsc);
  ref.current = onEsc;
  useEffect(() => {
    if (!active) return undefined;
    stack.push(ref);
    if (!listening) {
      window.addEventListener('keydown', onKeyDown);
      listening = true;
    }
    return () => {
      const i = stack.lastIndexOf(ref);
      if (i >= 0) stack.splice(i, 1);
    };
  }, [active]);
}

/** Vero se c'è almeno un livello aperto (utile a chi gestisce scorciatoie globali). */
export const hasOpenLayer = () => stack.length > 0;
