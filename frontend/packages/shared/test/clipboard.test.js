// copyText (src/clipboard.js): la copia negli appunti che dice se è riuscita
// davvero. Il browser arriva come `env`: qui navigator e document finti.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { copyText } from '../src/clipboard.js';

const ok = { navigator: { clipboard: { writeText: async () => {} } } };
const denied = { navigator: { clipboard: { writeText: async () => { throw new Error('NotAllowedError'); } } } };
/** Un document dove execCommand('copy') risponde `answer`; `appended` le textarea usate. */
function docWith(answer) {
  const appended = [];
  const removed = [];
  return {
    appended, removed,
    body: { appendChild: (n) => appended.push(n), removeChild: (n) => removed.push(n) },
    createElement: () => ({ style: {}, setAttribute() {}, select() {} }),
    execCommand: (cmd) => (cmd === 'copy' ? answer : false),
  };
}

test('con gli appunti del browser: true, e il testo è quello passato', async () => {
  const written = [];
  assert.equal(await copyText('https://pay/x', { navigator: { clipboard: { writeText: async (t) => { written.push(t); } } } }), true);
  assert.deepEqual(written, ['https://pay/x']);
  assert.equal(await copyText('https://pay/x', ok), true);
});

test('copia rifiutata e nessun ripiego: false, senza eccezioni', async () => {
  assert.equal(await copyText('https://pay/x', denied), false);
  assert.equal(await copyText('https://pay/x', { navigator: {} }), false);
  assert.equal(await copyText('https://pay/x', {}), false);
});

test('fuori da HTTPS (niente clipboard) o copia rifiutata: il ripiego con execCommand', async () => {
  const doc = docWith(true);
  assert.equal(await copyText('https://pay/x', { navigator: {}, document: doc }), true);
  assert.equal(doc.appended[0].value, 'https://pay/x');
  assert.deepEqual(doc.removed, doc.appended);   // la textarea non resta nella pagina
  assert.equal(await copyText('https://pay/y', { ...denied, document: docWith(true) }), true);
  // anche il ripiego può non riuscire
  assert.equal(await copyText('https://pay/x', { navigator: {}, document: docWith(false) }), false);
  const broken = { ...docWith(true), execCommand: () => { throw new Error('SecurityError'); } };
  assert.equal(await copyText('https://pay/x', { navigator: {}, document: broken }), false);
});

test('niente da copiare: false', async () => {
  assert.equal(await copyText('', ok), false);
  assert.equal(await copyText(undefined, ok), false);
});
