// oauth/popup.js — le finestre di servizio (Yourang, Stripe Connect) e i
// messaggi con cui avvisano chi le ha aperte. Aprire il popup, avvisare
// l'opener e ascoltarne la risposta erano scritti a mano in cinque posti
// (accesso, impostazioni, pagamenti e le due pagine dei popup, vedi
// OAuthPopup.jsx e StripeConnectPopup.jsx); qui stanno una volta.
import { useEffect } from 'react';

/** Il `type` dei messaggi: lo manda la pagina del popup, lo filtra l'opener. */
export const YOURANG_MSG = 'yourang-oauth';
export const STRIPE_MSG = 'stripe-connect';

/** Il popup Yourang (`mode` 'login' | 'connect'); null se il browser lo blocca. */
export const openYourangPopup = (mode) => window.open(`/oauth-popup/start?mode=${mode}`, 'yourang-oauth', 'width=520,height=680');
/** Il popup Stripe Connect; null se il browser lo blocca. */
export const openStripePopup = () => window.open('/stripe-connect/start', 'stripe-connect', 'width=620,height=760');

/** Dalla pagina del popup: avvisa la finestra che l'ha aperta (stessa origine). */
export function notifyOpener(msg) {
  if (window.opener) window.opener.postMessage(msg, window.location.origin);
}

/**
 * Nell'opener: `onMessage(data)` per i messaggi di tipo `type` arrivati dalla
 * stessa origine, finché `enabled`. Come l'effetto scritto a mano che
 * sostituisce: l'ascolto si registra di nuovo al cambio di `deps`, e
 * `onMessage` è quella del render in cui si è registrato.
 */
export function usePopupMessage(type, onMessage, deps, enabled = true) {
  useEffect(() => {
    if (!enabled) return undefined;
    const onMsg = (e) => {
      if (e.origin !== window.location.origin || e.data?.type !== type) return;
      onMessage(e.data);
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, [type, enabled, ...deps]); // eslint-disable-line react-hooks/exhaustive-deps -- le dipendenze le sceglie il chiamante
}
