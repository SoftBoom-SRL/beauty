import ReactDOM from 'react-dom/client';
import { staffAuth, LangProvider } from '@youty/shared';
import App from './App.jsx';
import OAuthPopup from './oauth/OAuthPopup.jsx';
import StripeConnectPopup from './oauth/StripeConnectPopup.jsx';
import { reloadOnce } from './shell/chunkReload.js';
import '@youty/shared/styles/base.css';
import './styles/desktop.css';
import './styles/app.css';

// Wire the staff session into the api wrapper (401 → refresh once → retry → else logout).
staffAuth.installStaffAuth();

// Dopo un deploy i chunk con il vecchio hash non esistono più: Vite segnala il
// caricamento fallito con `vite:preloadError`. Si ricarica la pagina (una volta:
// vedi chunkReload.js) per prendere l'index.html nuovo, invece di lasciare che
// la sezione o la modale appena aperta finisca in una pagina bianca. L'errore
// prosegue comunque fino a ChunkErrorBoundary, che nel frattempo dice cosa
// succede (o, se la ricarica non è partita, offre il pulsante per farla).
window.addEventListener('vite:preloadError', () => { reloadOnce(); });

const root = ReactDOM.createRoot(document.getElementById('root'));
const popupPath = window.location.pathname;

// OAuth popup pages render outside the dashboard shell (no session gate / boot load).
if (popupPath === '/oauth-popup/start' || popupPath === '/oauth-popup/done') {
  root.render(<LangProvider><OAuthPopup path={popupPath} /></LangProvider>);
} else if (popupPath === '/stripe-connect/start' || popupPath === '/stripe-connect/done') {
  root.render(<LangProvider><StripeConnectPopup path={popupPath} /></LangProvider>);
} else {
  root.render(<App />);
}
