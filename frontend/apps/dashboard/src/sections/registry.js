// registry.js — tab id → lazily loaded section. OWNED BY THE SHELL.
// Section agents implement their own `sections/<name>/index.jsx`; they never edit this file.
import { lazy } from 'react';

export const SECTIONS = {
  agenda: lazy(() => import('./agenda/index.jsx')),
  pos: lazy(() => import('./pos/index.jsx')),
  clienti: lazy(() => import('./clienti/index.jsx')),
  insight: lazy(() => import('./insight/index.jsx')),
  automazioni: lazy(() => import('./automazioni/index.jsx')),
  servizi: lazy(() => import('./servizi/index.jsx')),
  magazzino: lazy(() => import('./magazzino/index.jsx')),
  fedelta: lazy(() => import('./fedelta/index.jsx')),
  comunicazioni: lazy(() => import('./comunicazioni/index.jsx')),
  staff: lazy(() => import('./staff/index.jsx')),
  impostazioni: lazy(() => import('./impostazioni/index.jsx')),
  profile: lazy(() => import('./profile/index.jsx')),
};
