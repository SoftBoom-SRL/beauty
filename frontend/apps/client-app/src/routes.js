// routes.js — le viste dell'app cliente, in un elenco solo. Per ciascuna:
// - Screen: lo schermo;
// - personal: serve la sessione — senza, il gate di App apre l'accesso e poi
//   riprende la vista con i suoi parametri;
// - nav: con la barra in basso (e la barra in alto di Utility);
// - navParent: la voce della barra che resta accesa per una vista che ci
//   sta «sotto» (la lista d'attesa si apre dal Profilo, le gift card dal
//   Portafoglio).
// L'app non naviga via URL: la vista è stato in memoria (vedi ctx.jsx).
import Home from './screens/Home.jsx';
import Prenota from './screens/prenota/index.jsx';
import Prenotazioni from './screens/Prenotazioni.jsx';
import Wallet from './screens/Wallet.jsx';
import GiftCard from './screens/GiftCard.jsx';
import Profilo from './screens/Profilo.jsx';
import Waitlist from './screens/Waitlist.jsx';
import WaitlistNew from './screens/WaitlistNew.jsx';
import Pacchetti from './screens/Pacchetti.jsx';
import Sposta from './screens/Sposta.jsx';
import Annulla from './screens/Annulla.jsx';

export const ROUTES = {
  home: { Screen: Home, nav: true },
  prenota: { Screen: Prenota },
  prenotazioni: { Screen: Prenotazioni, personal: true, nav: true },
  wallet: { Screen: Wallet, personal: true, nav: true },
  giftcard: { Screen: GiftCard, personal: true, nav: true, navParent: 'wallet' },
  profilo: { Screen: Profilo, personal: true, nav: true },
  waitlist: { Screen: Waitlist, personal: true, nav: true, navParent: 'profilo' },
  'waitlist-new': { Screen: WaitlistNew, personal: true },
  pacchetti: { Screen: Pacchetti, nav: true },
  sposta: { Screen: Sposta, personal: true },
  annulla: { Screen: Annulla, personal: true },
};

/** Lo schermo della vista; una vista sconosciuta apre la Home. */
export const screenFor = (view) => (ROUTES[view] || ROUTES.home).Screen;

/** La vista chiede la sessione. */
export const isPersonal = (view) => !!ROUTES[view]?.personal;

/** La vista mostra le barre (in basso la navigazione, in alto lingua e accesso). */
export const hasNav = (view) => !!ROUTES[view]?.nav;

/** La voce `key` della barra è accesa: è la vista, o la vista le sta sotto. */
export const navOn = (key, view) => view === key || ROUTES[view]?.navParent === key;
