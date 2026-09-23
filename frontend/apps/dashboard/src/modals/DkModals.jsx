// DkModals.jsx — global modal dispatcher. Rendered once by the Shell.
// Open with ctx.openModal(name, props); the matching component gets
// `...props` plus `onClose`. La key = id dell'apertura: ogni openModal monta
// un'istanza nuova (stato pulito anche riaprendo lo stesso modale).
// Il confine d'errore ha la stessa key: un modale il cui chunk non si carica più
// dopo un deploy mostra un avviso (e ricarica la pagina una volta) invece di
// lasciare la dashboard bianca, e l'apertura successiva riparte pulita.
import React, { Suspense } from 'react';
import { useDash } from '../ctx.jsx';
import ChunkErrorBoundary from '../shell/ChunkErrorBoundary.jsx';
import { MODALS } from './registry.js';

export default function DkModals() {
  const { modal, closeModal, t } = useDash();
  if (!modal) return null;
  const Cmp = MODALS[modal.name];
  if (!Cmp) return null;
  return (
    <ChunkErrorBoundary key={modal.id} t={t} variant="modal" onClose={closeModal}>
      <Suspense fallback={null}>
        <Cmp key={modal.id} {...(modal.props || {})} onClose={closeModal} />
      </Suspense>
    </ChunkErrorBoundary>
  );
}
