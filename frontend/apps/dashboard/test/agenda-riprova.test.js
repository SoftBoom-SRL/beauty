// «409 → si riprova forzando» (lib/retry.js): la regola di spostamenti,
// stacco, ripristino, durata, salvataggio e creazione. Al primo tentativo
// non si forza; al 409 si ripete una volta con force, se chi chiama lo
// permette; ogni altro errore arriva a chi chiama com'è.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ApiError } from '@youty/shared';
import { isConflict, retryForced, withForceRetry } from '../src/sections/agenda/lib/retry.js';

const conflict = () => new ApiError(409, 'Orario non più disponibile', { detail: 'Orario non più disponibile' });
const refused = () => new ApiError(400, 'Operatrice non abilitata al servizio', {});

/** send finto: risponde (o fallisce) come dice `plan`, un elemento per chiamata. */
function sender(plan) {
  const calls = [];
  const send = async (force) => {
    calls.push(force);
    const next = plan[calls.length - 1];
    if (next instanceof Error) throw next;
    return next;
  };
  return { send, calls };
}

test('conflitto: solo il 409 di un ApiError', () => {
  assert.equal(isConflict(conflict()), true);
  assert.equal(isConflict(refused()), false);
  assert.equal(isConflict(new ApiError(412, 'cambiato', {})), false);
  assert.equal(isConflict(Object.assign(new Error('x'), { status: 409 })), false, 'un errore qualsiasi con status 409 non è una risposta del server');
  assert.equal(isConflict(null), false);
});

test('si rifà il gesto forzando dopo un 409, una volta sola e solo se permesso', () => {
  assert.equal(retryForced(conflict(), false), true);
  assert.equal(retryForced(conflict(), undefined), true, 'opts.force assente = non si stava forzando');
  assert.equal(retryForced(conflict(), true), false, 'già forzato: niente secondo giro');
  assert.equal(retryForced(conflict(), false, false), false, 'senza permesso agenda non si forza');
  assert.equal(retryForced(refused(), false), false, 'l\'idoneità (400) non si forza');
});

test('libero al primo tentativo: una richiesta sola, senza forzare', async () => {
  const s = sender([{ id: 1 }]);
  assert.deepEqual(await withForceRetry(s.send), { res: { id: 1 }, forced: false, stopped: false });
  assert.deepEqual(s.calls, [false]);
});

test('409: si ripete forzando e si dice che è stato forzato', async () => {
  const s = sender([conflict(), { id: 2 }]);
  assert.deepEqual(await withForceRetry(s.send), { res: { id: 2 }, forced: true, stopped: false });
  assert.deepEqual(s.calls, [false, true]);
});

test('409 e chi chiama non vuole forzare: ci si ferma, dopo il suo avviso', async () => {
  const s = sender([conflict(), { id: 3 }]);
  const seen = [];
  const out = await withForceRetry(s.send, { retry: (err) => { seen.push(err.status); return false; } });
  assert.deepEqual(out, { res: undefined, forced: false, stopped: true });
  assert.deepEqual(s.calls, [false]);
  assert.deepEqual(seen, [409]);
});

test('gli altri errori arrivano a chi chiama, anche quello del secondo tentativo', async () => {
  const first = sender([refused()]);
  await assert.rejects(withForceRetry(first.send), (err) => err.status === 400);
  assert.deepEqual(first.calls, [false]);
  const second = sender([conflict(), new Error('rete')]);
  await assert.rejects(withForceRetry(second.send), /rete/);
  assert.deepEqual(second.calls, [false, true]);
  // anche un secondo 409 non si ripete
  const twice = sender([conflict(), conflict()]);
  await assert.rejects(withForceRetry(twice.send), (err) => err.status === 409);
  assert.deepEqual(twice.calls, [false, true]);
});
