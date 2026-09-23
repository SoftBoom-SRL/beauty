// Caccia 22/09 — il pulsante del toast non cancella il toast che mostra lui
// stesso (13-25).
//
// «Copia link caparra» nel toast della nuova prenotazione esegue undoFn, che
// copia e mostra «Link copiato»; poi onUndo chiudeva il toast, e nello stesso
// render la conferma spariva: non compariva mai.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { runUndo } from '../src/ui/useToastHost.js';

// Lo stato del toast come lo tiene React: vince l'ultimo valore impostato
// nello stesso gesto.
function host() {
  const h = { toast: null, undoRef: { current: null } };
  h.setToast = (v) => { h.toast = v; };
  h.fireToast = (o) => { h.undoRef.current = o.undoFn || null; h.setToast(o); };
  return h;
}

test('il toast mostrato da undoFn resta a video', () => {
  const h = host();
  h.fireToast({ msg: 'Appuntamento creato', undo: 'Copia link caparra', undoFn: () => h.fireToast({ msg: 'Link copiato' }) });
  runUndo(h.undoRef, h.setToast);
  assert.deepEqual(h.toast, { msg: 'Link copiato' });
});

test('senza un toast nuovo, il toast si chiude', () => {
  const h = host();
  let undone = 0;
  h.fireToast({ msg: 'Eliminato', undo: 'Annulla', undoFn: () => { undone += 1; } });
  runUndo(h.undoRef, h.setToast);
  assert.equal(h.toast, null);
  assert.equal(undone, 1);
});

test('un secondo tocco non ripete l\'azione', () => {
  const h = host();
  let undone = 0;
  h.fireToast({ msg: 'Eliminato', undo: 'Annulla', undoFn: () => { undone += 1; } });
  runUndo(h.undoRef, h.setToast);
  runUndo(h.undoRef, h.setToast);
  assert.equal(undone, 1);
});
