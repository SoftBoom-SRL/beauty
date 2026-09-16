// DkModals.jsx — global modal dispatcher. Rendered once by the Shell.
// Open with ctx.openModal(name, props); the matching component gets
// `...props` plus `onClose`. La key = id dell'apertura: ogni openModal monta
// un'istanza nuova (stato pulito anche riaprendo lo stesso modale).
import React, { Suspense } from 'react';
import { useDash } from '../ctx.jsx';
import { MODALS } from './registry.js';

export default function DkModals() {
  const { modal, closeModal } = useDash();
  if (!modal) return null;
  const Cmp = MODALS[modal.name];
  if (!Cmp) return null;
  return (
    <Suspense fallback={null}>
      <Cmp key={modal.id} {...(modal.props || {})} onClose={closeModal} />
    </Suspense>
  );
}
