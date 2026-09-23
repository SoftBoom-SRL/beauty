// Import clienti da CSV (caccia ai bug del 22/09/2026: 14-07, 14-08, 14-15,
// 06-13, 14-16, 14-17). Il modulo sotto esame è la logica pura dell'import;
// la regola del telefono è quella vera di @youty/shared, la stessa del server.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isPlausiblePhone } from '../../../packages/shared/src/phone.js';
import {
  buildRows, decodeCsvBytes, fileLineOf, guessMapping, looksLikeHeader, looksMojibake,
  parseCsvLines, parseFlexibleDate, splitFullName,
} from '../src/sections/clienti/importCsv.js';

const opts = { plausiblePhone: isPlausiblePhone, today: '2026-09-23' };

test('il titolo giusto vince sul contenuto: le date non rubano il telefono', () => {
  const header = ['Nome', 'Cognome', 'Data inserimento', 'Cellulare'];
  const rows = [
    ['Sofia', 'Ricci', '12/03/2021', '348 221 0094'],
    ['Giada', 'Neri', '03/11/2019', '333 118 4420'],
  ];
  assert.deepEqual(guessMapping(header, rows), ['first_name', 'last_name', 'since', 'phone']);
});

test('«Ultima visita» prima di «Data di nascita»: il compleanno resta quello vero', () => {
  const header = ['Nome', 'Ultima visita', 'Data di nascita', 'Telefono'];
  const rows = [['Sofia', '02/09/2026', '15/03/1990', '3482210094'], ['Giada', '30/08/2026', '24/12/1988', '3331184420']];
  assert.deepEqual(guessMapping(header, rows), ['full_name', 'ignore', 'birthday', 'phone']);
  // senza una colonna del compleanno, una colonna di date con un titolo
  // sconosciuto non diventa il compleanno
  assert.deepEqual(guessMapping(['Nome', 'Ultima visita', 'Telefono'], rows.map((r) => [r[0], r[1], r[3]])), ['full_name', 'ignore', 'phone']);
});

test('un «Codice» a 8 cifre non è un telefono; un file senza intestazione si riconosce ancora dal contenuto', () => {
  const header = ['Nome', 'Codice', 'Email'];
  const rows = [['Sofia', '10002345', 'sofia@example.com'], ['Giada', '10002346', 'giada@example.com']];
  assert.deepEqual(guessMapping(header, rows), ['full_name', 'ignore', 'email']);
  const bare = [['Sofia', 'Ricci', '348 221 0094', '15/03/1990'], ['Giada', 'Neri', '+39 333 118 4420', '24/12/1988']];
  assert.equal(looksLikeHeader(bare[0]), false);
  assert.deepEqual(guessMapping(null, bare), ['first_name', 'last_name', 'phone', 'birthday']);
});

test('29 febbraio: vale solo negli anni bisestili (o senza anno)', () => {
  assert.equal(parseFlexibleDate('29/02/1991'), null);
  assert.equal(parseFlexibleDate('1991-02-29'), null);
  assert.equal(parseFlexibleDate('29 febbraio 1991'), null);
  assert.equal(parseFlexibleDate('29/02/1992'), '1992-02-29');
  assert.equal(parseFlexibleDate('29/02'), '--02-29');
  assert.equal(parseFlexibleDate('31/04/2020'), null);
});

test('compleanno impossibile: la cliente entra lo stesso, senza compleanno e con l’avviso', () => {
  const [r] = buildRows([['Sofia', '3482210094', '29/02/1991']], ['full_name', 'phone', 'birthday'], opts);
  assert.equal(r._skip, false);
  assert.equal(r.birthday, '');
  assert.deepEqual(r._warn, ['birthday:29/02/1991']);
});

test('telefoni impossibili: avvisati prima dell’import; il formato di Excel non si importa', () => {
  const map = ['full_name', 'phone', 'email'];
  const [two, sci, short, ok] = buildRows([
    ['Sofia Ricci', '348 221 0094 / 06 1234567', ''],
    ['Giada Neri', '3,93482E+11', 'giada@example.com'],
    ['Anna Bruno', '333', ''],
    ['Marta Villa', '+39 333 118 4420', ''],
  ], map, opts);
  // entra col testo com'è (il server lo tiene e lo segnala), ma lo si sa prima
  assert.equal(two.phone, '348 221 0094 / 06 1234567');
  assert.deepEqual(two._warn, ['badphone:348 221 0094 / 06 1234567']);
  // cifre perse: niente telefono (più clienti diverse avrebbero lo stesso numero)
  assert.equal(sci.phone, '');
  assert.ok(sci._warn.includes('phonesci:3,93482E+11'));
  assert.equal(sci._skip, false, 'con l’email la riga si abbina ancora');
  assert.deepEqual(short._warn, ['badphone:333']);
  assert.equal(ok.phone, '+393331184420');
  assert.deepEqual(ok._warn, []);
});

test('«Cognome e nome» e «Nominativo»: cognome per primo, particelle comprese', () => {
  assert.deepEqual(guessMapping(['Cognome e nome', 'Telefono'], [['ROSSI MARIA', '3331112222']]), ['full_name_rev', 'phone']);
  assert.deepEqual(guessMapping(['Nominativo', 'Cellulare'], [['ROSSI MARIA', '3331112222']]), ['full_name_rev', 'phone']);
  assert.deepEqual(guessMapping(['Nome e cognome', 'Cellulare'], [['Maria Rossi', '3331112222']]), ['full_name', 'phone']);
  assert.deepEqual(splitFullName('ROSSI MARIA', true), { first: 'MARIA', last: 'ROSSI' });
  assert.deepEqual(splitFullName('DE LUCA ANNA MARIA', true), { first: 'ANNA MARIA', last: 'DE LUCA' });
  assert.deepEqual(splitFullName('DELLA ROVERE ANNA', true), { first: 'ANNA', last: 'DELLA ROVERE' });
  assert.deepEqual(splitFullName('Maria De Luca'), { first: 'Maria', last: 'De Luca' });
  const [r] = buildRows([['ROSSI MARIA', '3331112222']], ['full_name_rev', 'phone'], opts);
  assert.equal(r.first_name, 'MARIA');
  assert.equal(r.last_name, 'ROSSI');
});

test('«Riga N» è la riga del file: intestazione, righe vuote e celle su più righe comprese', () => {
  const text = 'Nome;Telefono;Note\n\nSofia;3482210094;"allergica\nal nichel"\nGiada;3331184420;\n\nAnna;3482210094;\n';
  const recs = parseCsvLines(text, ';');
  assert.deepEqual(recs.map((r) => r.line), [1, 3, 4, 6]);
  const data = recs.slice(1);
  const rows = buildRows(data.map((r) => r.cells), ['full_name', 'phone', 'note'], { ...opts, lines: data.map((r) => r.line) });
  assert.deepEqual(rows.map((r) => r._line), [3, 4, 6]);
  assert.equal(rows[0].note, 'allergica\nal nichel');
  // il doppione rimanda alla riga del file, non all'indice dei dati
  assert.ok(rows[2]._warn.includes('dup:3'));
  // un errore del server alla riga 1 del secondo blocco (inviate solo le righe buone)
  const ready = [{ _line: 3 }, { _line: 4 }, { _line: 9 }, { _line: 12 }];
  assert.equal(fileLineOf(ready, 2, 1), 12);
});

test('«cliente dal»: data con l’anno e non futura, altrimenti avviso', () => {
  const rows = buildRows([
    ['Sofia', '3482210094', '10/05/2019'],
    ['Giada', '3331184420', '15/03'],
    ['Anna', '3331184421', '01/01/2030'],
  ], ['full_name', 'phone', 'since'], opts);
  assert.equal(rows[0].since, '2019-05-10');
  assert.deepEqual(rows[1]._warn, ['since:15/03']);
  assert.deepEqual(rows[2]._warn, ['since:01/01/2030']);
  assert.equal(rows[2]._skip, false);
});

test('codifica automatica: il CSV di Excel italiano (Windows-1252) si legge con gli accenti', () => {
  // «Niccolò;Università» in Windows-1252: ò = 0xF2, à = 0xE0
  const cp1252 = Uint8Array.from([0x4e, 0x69, 0x63, 0x63, 0x6f, 0x6c, 0xf2, 0x3b, 0x55, 0x6e, 0x69, 0x76, 0x65, 0x72, 0x73, 0x69, 0x74, 0xe0]);
  assert.deepEqual(decodeCsvBytes(cp1252), { text: 'Niccolò;Università', encoding: 'windows-1252' });
  const utf8 = new TextEncoder().encode('Niccolò;Università');
  assert.deepEqual(decodeCsvBytes(utf8), { text: 'Niccolò;Università', encoding: 'utf-8' });
  // scelta a mano sbagliata: l'avviso lo dice in ogni passo
  const wrong = decodeCsvBytes(utf8, 'windows-1252');
  assert.equal(looksMojibake(wrong.text), true);
  assert.equal(looksMojibake('Niccolò'), false);
});
