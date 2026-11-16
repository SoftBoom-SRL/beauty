// Cassa, «Servizio extra»: i servizi in cartelle per categoria, come quando
// si crea un appuntamento (Discord 1571903891501744218, punto 6).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { serviceFolders } from '../src/sections/pos/sell/folders.js';

const t = (it) => it;
const cats = [{ id: 1, name_it: 'Viso', name_en: 'Face', color: '#f00' }, { id: 2, name_it: 'Mani', name_en: '', color: null }];
const svc = (id, category_id) => ({ id, category_id });

test('una cartella per categoria con servizi, nell\'ordine, e «Altri servizi» in fondo', () => {
  const folders = serviceFolders([svc(1, 2), svc(2, 1), svc(3, null), svc(4, 99), svc(5, 1)], cats, 'it', t);
  assert.deepEqual(folders.map((f) => [f.id, f.name, f.items.map((s) => s.id)]), [
    [1, 'Viso', [2, 5]],
    [2, 'Mani', [1]],
    ['none', 'Altri servizi', [3, 4]],
  ]);
  assert.equal(serviceFolders([svc(1, 1)], cats, 'en', t), null, 'una cartella sola: elenco piatto');
  assert.equal(serviceFolders([svc(1, 1), svc(2, 2)], cats, 'en', t)[1].name, 'Mani', 'senza nome inglese resta l\'italiano');
  assert.equal(serviceFolders([svc(1, 1), svc(2, 2)], cats, 'en', t)[0].name, 'Face');
});

test('senza categorie niente cartelle', () => {
  assert.equal(serviceFolders([svc(1, 1)], [], 'it', t), null);
  assert.equal(serviceFolders([svc(1, 1)], null, 'it', t), null);
});
