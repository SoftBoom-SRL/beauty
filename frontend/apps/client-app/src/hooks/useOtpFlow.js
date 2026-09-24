// useOtpFlow.js — il codice via SMS dell'accesso (AuthFlow) e della
// prenotazione senza sessione (Prenota): richiesta del codice, registrazione
// di chi è nuova, verifica. Stesse regole e stessi messaggi nei due posti.
import React from 'react';
import { ApiError, SALON_SLUG, apiErrorText, clientAuth, toastApiError } from '@youty/shared';

/** `phone` è il numero com'è scritto nel campo (si manda senza spazi ai
 *  bordi). Le tre azioni non rilanciano: dicono com'è andata e mettono in
 *  `error` il messaggio da mostrare sotto il campo.
 *  - request(): chiede il codice → true; 429 → «Troppi codici richiesti».
 *  - register(fields): crea la cliente ({ first_name, last_name, phone, … },
 *    il salone lo aggiunge qui), che riceve subito il codice → 'ok';
 *    400 = numero già in anagrafica → 'blocked' (chi chiama dice cosa fare);
 *    altrimenti 'error'.
 *  - verify(code): verifica il codice e apre la sessione → true; 400 →
 *    «Codice non valido o scaduto», 429 → «Troppi tentativi».
 *  Gli altri errori: `otherErrors: 'inline'` (accesso) scrive in `error` il
 *  messaggio del server, o «Errore di rete» se una risposta non è arrivata
 *  (o non dice niente); 'toast' (prenotazione) li mostra nel toast d'errore
 *  dell'app e lascia `error` com'è. */
export function useOtpFlow({ phone, t, fireToast, otherErrors = 'inline' }) {
  const [error, setError] = React.useState(null);
  // Numero per cui la registrazione è andata a buon fine: solo lì sappiamo che
  // un codice è davvero partito. Dopo un semplice «richiedi codice» il server
  // non dice se il numero esiste, quindi il testo resta al condizionale — e
  // cambiando numero si torna al condizionale da solo.
  const [registeredPhone, setRegisteredPhone] = React.useState(null);
  const codeSurelySent = !!registeredPhone && registeredPhone === phone.trim();

  const other = (err) => {
    if (otherErrors === 'toast') toastApiError(err, fireToast, t);
    // Lo stesso testo del toast (apiErrorText): con `err.message` senza rete
    // compariva quello del browser, «Failed to fetch» (su Safari «Load
    // failed»), in inglese anche con l'app in italiano (voce 31). Una risposta
    // senza messaggio resta «Errore di rete», come prima.
    else setError(apiErrorText(err, t) || t('Errore di rete', 'Network error'));
  };

  /* `request-otp` risponde 200 anche sui numeri sconosciuti — e deve farlo: il
   * 404 di prima era un oracolo, bastava ciclare i numeri per farsi la rubrica
   * del salone. Quindi da qui non si capisce se la cliente è nuova: chi
   * chiama va sempre al passo del codice, e chi non ha ancora un profilo se lo
   * crea da lì con `register`. */
  const request = async () => {
    try {
      await clientAuth.requestOtp(SALON_SLUG, phone.trim());
      return true;
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) {
        setError(t('Troppi codici richiesti. Riprova tra qualche minuto.', 'Too many codes requested. Try again in a few minutes.'));
      } else {
        other(err);
      }
      return false;
    }
  };

  const register = async (fields) => {
    try {
      await clientAuth.register({ salon_slug: SALON_SLUG, ...fields });
      setRegisteredPhone(fields.phone); // la registrazione emette il codice: qui lo sappiamo
      return 'ok';
    } catch (err) {
      // 400 = «numero già registrato», e non si può sapere quale dei due casi
      // sia: o la scheda c'è ed è attiva (il codice chiesto poco fa è davvero
      // partito, basta inserirlo) oppure è disattivata e da qui non si entra.
      if (err instanceof ApiError && err.status === 400) return 'blocked';
      other(err);
      return 'error';
    }
  };

  const verify = async (code) => {
    try {
      await clientAuth.verifyOtp(SALON_SLUG, phone.trim(), code);
      return true;
    } catch (err) {
      if (err instanceof ApiError && err.status === 400) {
        setError(t('Codice non valido o scaduto', 'Invalid or expired code'));
      } else if (err instanceof ApiError && err.status === 429) {
        setError(t('Troppi tentativi. Riprova tra qualche minuto.', 'Too many attempts. Try again in a few minutes.'));
      } else {
        other(err);
      }
      return false;
    }
  };

  return { error, setError, codeSurelySent, request, register, verify };
}
