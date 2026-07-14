import React from 'react';
import ReactDOM from 'react-dom/client';
import { clientAuth } from '@youty/shared';
import App from './App.jsx';
import './styles/styles.css';
import './styles/app.css';

// Wire the client session into the api wrapper (401 → logout; no client refresh exists).
clientAuth.installClientAuth();

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
