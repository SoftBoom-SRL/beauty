import React from 'react';
import ReactDOM from 'react-dom/client';
import { staffAuth, LangProvider } from '@youty/shared';
import App from './App.jsx';
import OAuthPopup from './oauth/OAuthPopup.jsx';
import './styles/styles.css';
import './styles/desktop.css';
import './styles/app.css';

// Wire the staff session into the api wrapper (401 → refresh once → retry → else logout).
staffAuth.installStaffAuth();

const root = ReactDOM.createRoot(document.getElementById('root'));
const popupPath = window.location.pathname;

// OAuth popup pages render outside the dashboard shell (no session gate / boot load).
if (popupPath === '/oauth-popup/start' || popupPath === '/oauth-popup/done') {
  root.render(<LangProvider><OAuthPopup path={popupPath} /></LangProvider>);
} else {
  root.render(<App />);
}
