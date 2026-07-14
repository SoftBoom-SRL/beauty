// registry.js — view name → screen component. OWNED BY THE APP SHELL.
// Screen agents implement their own screen file; they never edit this registry.
import Home from './Home.jsx';
import Prenota from './Prenota.jsx';
import Prenotazioni from './Prenotazioni.jsx';
import Wallet from './Wallet.jsx';
import GiftCard from './GiftCard.jsx';
import Profilo from './Profilo.jsx';
import Waitlist from './Waitlist.jsx';
import WaitlistNew from './WaitlistNew.jsx';
import Pacchetti from './Pacchetti.jsx';
import Sposta from './Sposta.jsx';
import Annulla from './Annulla.jsx';

export const SCREENS = {
  home: Home,
  prenota: Prenota,
  prenotazioni: Prenotazioni,
  wallet: Wallet,
  giftcard: GiftCard,
  profilo: Profilo,
  waitlist: Waitlist,
  'waitlist-new': WaitlistNew,
  pacchetti: Pacchetti,
  sposta: Sposta,
  annulla: Annulla,
};
