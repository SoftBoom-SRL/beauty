import React from 'react';
import ReactDOM from 'react-dom/client';
import { staffAuth } from '@youty/shared';
import App from './App.jsx';
import './styles/styles.css';
import './styles/desktop.css';
import './styles/app.css';

// Wire the staff session into the api wrapper (401 → refresh once → retry → else logout).
staffAuth.installStaffAuth();

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
