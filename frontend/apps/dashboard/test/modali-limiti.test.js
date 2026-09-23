// Regole del pannello che replicano i limiti del server. Caccia ai bug del
// 22/09/2026: no-show solo da confermato e già cominciato (02-09, lato
// pannello), 17-12 (campi oltre i limiti → 422 in inglese), 13-25 («Link
// copiato» anche quando la copia non riusciva), C21 (codici mascherati).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  canMarkNoShow, copyText, joinReason, MAX_ITEM_MIN, REASON_MAX, reasonNoteMax, usableCode,
} from '../src/sections/agenda/modals/rules.js';

test('no-show solo per una visita confermata e già cominciata', () => {
  const now = Date.parse('2026-09-24T10:30:00Z');
  assert.ok(canMarkNoShow({ status: 'confirmed', start: '2026-09-24T10:00:00Z' }, now));
  assert.ok(!canMarkNoShow({ status: 'confirmed', start: '2026-09-24T11:00:00Z' }, now));   // non ancora
  assert.ok(!canMarkNoShow({ status: 'checked_in', start: '2026-09-24T10:00:00Z' }, now));  // è in salone
  assert.ok(!canMarkNoShow({ status: 'in_progress', start: '2026-09-24T10:00:00Z' }, now));
  assert.ok(!canMarkNoShow(null, now));
});

test('motivazione + nota non superano mai i 255 caratteri del server', () => {
  const label = 'Malattia / imprevisto';
  assert.equal(reasonNoteMax(label), REASON_MAX - label.length - 3);
  assert.equal(reasonNoteMax(''), REASON_MAX);
  const joined = joinReason(label, 'x'.repeat(400));
  assert.equal(joined.length, REASON_MAX);
  assert.ok(joined.startsWith(label + ' — '));
  assert.equal(joinReason(label, ''), label);
  assert.equal(joinReason('', 'solo nota'), 'solo nota');
  // si taglia per caratteri interi: niente mezza emoji in fondo
  const emoji = joinReason('', 'a' + '😀'.repeat(300));
  assert.equal(Array.from(emoji).length, REASON_MAX);
  assert.ok(!/[\uD800-\uDBFF]$/.test(emoji));
});

test('durata e attesa di un servizio al massimo 12 ore, come ItemEditIn', () => {
  assert.equal(MAX_ITEM_MIN, 720);
});

test('«Link copiato» solo se la copia è riuscita', async () => {
  assert.equal(await copyText('https://pay/x', { navigator: { clipboard: { writeText: async () => {} } } }), true);
  // permesso negato e nessun ripiego possibile
  assert.equal(await copyText('https://pay/x', { navigator: { clipboard: { writeText: async () => { throw new Error('denied'); } } } }), false);
  // fuori da HTTPS non c'è clipboard: si ripiega su execCommand
  const appended = [];
  const doc = {
    body: { appendChild: (n) => appended.push(n), removeChild: () => {} },
    createElement: () => ({ style: {}, setAttribute() {}, select() {} }),
    execCommand: (cmd) => cmd === 'copy',
  };
  assert.equal(await copyText('https://pay/x', { navigator: {}, document: doc }), true);
  assert.equal(appended[0].value, 'https://pay/x');
  assert.equal(await copyText('', { navigator: { clipboard: { writeText: async () => {} } } }), false);
});

test('un codice mascherato non si mostra come codice da usare', () => {
  assert.equal(usableCode('GIFT-7Q2K-1234'), 'GIFT-7Q2K-1234');
  assert.equal(usableCode('••••1234'), '');
  assert.equal(usableCode(''), '');
  assert.equal(usableCode(undefined), '');
});
