// registry.js — nome del modale → componente caricato a richiesta, per
// ctx.openModal(nome, props) (vedi DkModals.jsx). I componenti stanno nella
// cartella della sezione a cui appartengono.
import { lazy } from 'react';

export const MODALS = {
  newappt: lazy(() => import('../sections/agenda/modals/NewApptModal.jsx')),
  apptdetail: lazy(() => import('../sections/agenda/modals/ApptDetailModal.jsx')),
  freedslot: lazy(() => import('../sections/agenda/modals/FreedSlotModal.jsx')),
  waitlist: lazy(() => import('../sections/agenda/modals/WaitlistModal.jsx')),
  opportunity: lazy(() => import('../sections/agenda/modals/OpportunityModal.jsx')),
  sell: lazy(() => import('../sections/pos/modals/SellModal.jsx')),
  newclient: lazy(() => import('../sections/clienti/modals/NewClientModal.jsx')),
  bulkimport: lazy(() => import('../sections/clienti/modals/BulkImportModal.jsx')),
  techsheet: lazy(() => import('../sections/clienti/modals/TechSheetModal.jsx')),
  catsmgr: lazy(() => import('../sections/impostazioni/modals/CategoriesManagerModal.jsx')),
};
