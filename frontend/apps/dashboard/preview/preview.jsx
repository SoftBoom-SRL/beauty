// Anteprima dell'agenda con dati finti: serve a provare la griglia senza
// backend e senza credenziali. Solo sviluppo — non entra nel bundle dell'app.
import React from 'react';
import ReactDOM from 'react-dom/client';
import { staffAuth, LangProvider } from '@youty/shared';
import { DashboardProvider } from '../src/ctx.jsx';
import AgendaSection from '../src/sections/agenda/index.jsx';
import Topbar from '../src/shell/Topbar.jsx';
import { useDash } from '../src/ctx.jsx';
import DkModals from '../src/modals/DkModals.jsx';
import DkToast from '../src/ui/DkToast.jsx';
import { OPERATORS, SERVICES, SERVICE_CATEGORIES, DAY_ROWS, WEEK, SALON, TODAY, APPOINTMENT, moveAppointment, editAppointment, rememberUndo, UNDO_STACK, undoLast } from './fixtures.js';
import '../src/styles/styles.css';
import '../src/styles/desktop.css';
import '../src/styles/app.css';

/* risposte finte per ogni rotta usata dall'agenda */
// `__status` nel corpo = risposta d'errore simulata (400 idoneità, 409 slot occupato)
const json = (data) => {
  const status = (data && data.__status) || 200;
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
};
const routes = [
  [/\/api\/core\/salon/, () => SALON],
  [/\/api\/staff\/$/, () => OPERATORS],
  [/\/api\/catalog\/services/, () => SERVICES],
  [/\/api\/catalog\/categories/, () => SERVICE_CATEGORIES],
  [/\/api\/clients\/categories/, () => []],
  [/\/api\/clients\//, (u, init) => ((init?.method || 'GET') === 'POST'
    ? { id: 95, full_name: 'Nuova Cliente', phone: '+39 333 000 0000', categories: [] }
    : { items: [{ id: 90, full_name: 'Marta Rossi', phone: '+39 333 111 2233' }] })],
  // spostamento (trascinamento, o orario/operatrice cambiati dal pannello)
  [/\/api\/agenda\/appointments\/\d+\/move$/, (u, init) => {
    const id = Number(u.pathname.split('/')[4]);
    rememberUndo(id, 'Spostamento dell’appuntamento');
    return moveAppointment(id, JSON.parse(init.body || '{}'));
  }],
  // «torna indietro»: la pila e l'annullamento (GET elenca, POST annulla)
  [/\/api\/agenda\/undo$/, (u, init) => ((init?.method || 'GET') === 'POST'
    ? undoLast(JSON.parse(init.body || '{}').entry_id)
    : UNDO_STACK())],
  // GET il dettaglio, PUT le modifiche a servizi e nota
  [/\/api\/agenda\/appointments\/\d+$/, (u, init) => {
    const id = Number(u.pathname.split('/').pop());
    if ((init?.method || 'GET') === 'PUT') { rememberUndo(id, 'Modifica dell’appuntamento'); return editAppointment(id, JSON.parse(init.body || '{}')); }
    return APPOINTMENT(id);
  }],
  [/\/api\/agenda\/day/, (u) => DAY_ROWS(u.searchParams.get('date') || TODAY)],
  [/\/api\/agenda\/week/, (u) => WEEK(u.searchParams.get('start'))],
  [/\/api\/agenda\/month/, () => []],
  [/\/api\/agenda\/waitlist/, () => []],
  [/\/api\/agenda\/released/, () => []],
  [/\/api\/agenda\/availability/, () => []],
  [/\/api\/sales\/today-summary/, () => ({ revenue: '0.00', tickets: 0 })],
  [/\/api\/core\/activity\/feed/, () => ({ events: [], cursor: null })],
];
window.__chiamate = [];
const realFetch = window.fetch.bind(window);
window.fetch = (input, init) => {
  const raw = typeof input === 'string' ? input : input.url;
  const u = new URL(raw, window.location.origin);
  const metodo = init?.method || 'GET';
  if (metodo !== 'GET') window.__chiamate.push({ metodo, path: u.pathname, body: init?.body ? JSON.parse(init.body) : null });
  const hit = routes.find(([re]) => re.test(u.pathname));
  if (hit) return Promise.resolve(json(hit[1](u, init)));
  if (u.pathname.startsWith('/api/')) { console.warn('[anteprima] rotta non simulata', metodo, u.pathname); return Promise.resolve(json({ id: 999, start: new Date().toISOString(), items: [], client: { full_name: 'Finta' } })); }
  return realFetch(input, init);
};

/* ponte per i test: apre i modali dall'esterno, come farebbe la topbar.
 * Monta anche il toast, che nell'app vive nella shell: senza, gli avvisi con
 * «Annulla» non comparivano e non si poteva provare l'annullamento. */
function Ponte() {
  const { openModal, toastProps } = useDash();
  window.__apri = openModal;
  return <DkToast {...toastProps} />;
}

staffAuth.installStaffAuth();
ReactDOM.createRoot(document.getElementById('root')).render(
  <LangProvider>
    <DashboardProvider>
      {/* stessa impalcatura della shell vera (.dk-root/.dk-main): il pannello
          laterale restringe l'area di lavoro proprio attraverso queste classi */}
      <div className="dk-root">
        <div className="dk-main">
          <Topbar />
          <div className="dk-content" style={{ display: 'flex', flexDirection: 'column' }}>
            <AgendaSection />
          </div>
        </div>
      </div>
      <Ponte />
      <DkModals />
    </DashboardProvider>
  </LangProvider>,
);
