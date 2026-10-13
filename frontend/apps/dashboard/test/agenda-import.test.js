// Import degli appuntamenti da un altro gestionale: la logica pura
// (sections/agenda/lib/importVisits.js). Le righe di prova hanno la forma
// dell'esportazione di Treatwell: una riga per servizio, durata in ore,minuti,
// la cliente in una colonna sola.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseCsvLines } from '../src/sections/clienti/importCsv.js';
import {
  buildRows, distinctNames, groupVisits, guessDurationUnit, guessMapping, looksLikeHeader,
  matchNames, operatorOptions, parseDuration, parsePrice, parseTime, serviceOptions, visitPayload,
} from '../src/sections/agenda/lib/importVisits.js';

const CSV = `"Data";"Ora";"Cliente";"Telefono";"Email";"Servizio";"Durata (h)";"Operatrice";"Prezzo (€)";"Fonte"
"14/10/2026";"09:00";"Meo Isabella";"+393398873319";"";"Ceretta Ascelle";"0,15";"Stefania Cavazzoni";"";""
"14/10/2026";"09:15";"Meo Isabella";"+393398873319";"";"Pedicure estetico";"0,45";"Stefania Cavazzoni";"36,00";"Treatwell"
"14/10/2026";"09:30";"Meo Isabella";"+393398873319";"";"MANICURE RINFORZATA";"1,30";"Giulia Arzente";"";""
"14/10/2026";"10:30";"Flora Galleani";"";"";"Pedicure estetico";"1,00";"Marianna D'Auria";"";""
"12/10/2026";"10:30";"Vecchia Visita";"+393330000000";"";"Pedicure estetico";"1,00";"Giulia Arzente";"";""
"15/10/2026";"";"Senza Ora";"+393330000001";"";"Pedicure estetico";"1,00";"Giulia Arzente";"";""`;

const table = parseCsvLines(CSV, ';');
const header = table[0].cells;
const data = table.slice(1).map((r) => r.cells);
const lines = table.slice(1).map((r) => r.line);
const mapping = guessMapping(header);
const rows = buildRows(data, mapping, { lines, today: '2026-10-13' });

const SERVICES = [
  { id: 1, name_it: 'Pedicure estetico', active: true },
  { id: 2, name_it: 'Ceretta ascelle', active: true },
  { id: 3, name_it: 'Manicure rinforzata', name_en: 'Reinforced manicure', active: true },
  { id: 4, name_it: 'Pedicure estetico', active: false },   // ritirato: non si propone
];
const OPERATORS = [
  { id: 10, first_name: 'Stefania', last_name: 'Cavazzoni' },
  { id: 11, first_name: 'Giulia', last_name: 'Arzente' },
  { id: 12, first_name: 'Marianna', last_name: 'D’Auria' },   // apostrofo tipografico
];

test('le colonne di Treatwell si riconoscono dai titoli, unità fra parentesi comprese', () => {
  assert.deepEqual(mapping, ['date', 'time', 'full_name', 'phone', 'email', 'service', 'duration', 'operator', 'price', 'ignore']);
  assert.equal(looksLikeHeader(header), true);
  assert.equal(looksLikeHeader(data[0]), false);
  // «nome» non è «cognome», «ora» non è «collaboratore»
  assert.deepEqual(guessMapping(['Cognome', 'Nome', 'Collaboratore', 'Ora']), ['last_name', 'first_name', 'operator', 'time']);
});

test('la durata «0,45» sono quarantacinque minuti, non tre quarti d’ora decimali', () => {
  assert.equal(parseDuration('0,45'), 45);
  assert.equal(parseDuration('1,30'), 90);
  assert.equal(parseDuration('2,00'), 120);
  assert.equal(parseDuration('0,75'), null);            // non è un'ora,minuti
  assert.equal(parseDuration('0,75', 'dec'), 45);
  assert.equal(parseDuration('1,5', 'dec'), 90);
  assert.equal(parseDuration('90', 'min'), 90);
  assert.equal(parseDuration('90'), null);
  assert.equal(parseDuration('1:30', 'min'), 90);       // ore e minuti comunque
  assert.equal(parseDuration('45 min'), 45);
  assert.equal(parseDuration('0,00'), null);
  assert.equal(guessDurationUnit(['0,15', '1,30', '1,00']), 'hm');
  assert.equal(guessDurationUnit(['0,75', '1,5']), 'dec');
  assert.equal(guessDurationUnit(['45', '60', '90']), 'min');
});

test('ora e prezzo', () => {
  assert.equal(parseTime('09:00'), 540);
  assert.equal(parseTime('9.30'), 570);
  assert.equal(parseTime('25:00'), null);
  assert.equal(parsePrice('36,00'), '36.00');
  assert.equal(parsePrice('€ 1.250,5'), '1250.50');
  assert.equal(parsePrice('36.5'), '36.50');
  assert.equal(parsePrice(''), null);
});

test('le righe: giorno passato e ora mancante restano fuori, col loro motivo', () => {
  assert.deepEqual(rows.map((r) => r._skip), [false, false, false, false, true, true]);
  assert.deepEqual(rows[4]._warn, ['past']);
  assert.deepEqual(rows[5]._warn, ['missing:startMin']);
  const { date, startMin, durationMin, first_name, last_name, phone, price, _line } = rows[1];
  assert.deepEqual({ date, startMin, durationMin, first_name, last_name, phone, price, _line },
    { date: '2026-10-14', startMin: 555, durationMin: 45, first_name: 'Meo', last_name: 'Isabella', phone: '+393398873319', price: '36.00', _line: 3 });
});

test('servizi e operatrici si abbinano solo quando il nome è uno solo', () => {
  const services = distinctNames(rows, 'service');
  assert.deepEqual(services.map((s) => [s.name, s.count]), [['Pedicure estetico', 2], ['Ceretta Ascelle', 1], ['MANICURE RINFORZATA', 1]]);
  assert.deepEqual(matchNames(services, serviceOptions(SERVICES, 'it')), { 'Pedicure estetico': 1, 'Ceretta Ascelle': 2, 'MANICURE RINFORZATA': 3 });
  assert.deepEqual(matchNames(distinctNames(rows, 'operator'), operatorOptions(OPERATORS)),
    { 'Stefania Cavazzoni': 10, 'Giulia Arzente': 11, "Marianna D'Auria": 12 });
  // due voci con lo stesso nome: non si tira a indovinare
  const twins = [{ id: 1, label: 'Taglio', aliases: ['Taglio'] }, { id: 2, label: 'Taglio', aliases: ['Taglio'] }];
  assert.deepEqual(matchNames([{ name: 'taglio' }], twins), { taglio: null });
});

test('i servizi in fila della stessa cliente sono una visita; quello che si sovrappone no', () => {
  const sMap = { 'Pedicure estetico': 1, 'Ceretta Ascelle': 2, 'MANICURE RINFORZATA': 3 };
  const oMap = { 'Stefania Cavazzoni': 10, 'Giulia Arzente': 11, "Marianna D'Auria": 12 };
  const { visits, excluded } = groupVisits(rows, sMap, oMap);
  assert.equal(excluded, 0);
  assert.deepEqual(visits.map((v) => [v._line, v.items.length]), [[2, 2], [4, 1], [5, 1]]);
  // 09:00 ceretta (15') + 09:15 pedicure: una visita; la manicure delle 09:30
  // comincia mentre il pedicure è in corso, con un'altra operatrice
  const first = visitPayload(visits[0]);
  assert.deepEqual(Object.keys(first), ['first_name', 'last_name', 'phone', 'email', 'start', 'note', 'items']);
  assert.deepEqual(first.items, [
    { service_id: 2, operator_id: 10, duration_min: 15, price: null },
    { service_id: 1, operator_id: 10, duration_min: 45, price: '36.00' },
  ]);
  assert.equal(first.start, '2026-10-14T07:00:00.000Z');   // le 09:00 di Roma, ora legale
  // un servizio non abbinato lascia fuori le sue righe, e la catena si spezza lì
  const partial = groupVisits(rows, { ...sMap, 'Ceretta Ascelle': null }, oMap);
  assert.equal(partial.excluded, 1);
  assert.deepEqual(partial.visits.map((v) => [v._line, v.items.length]), [[3, 1], [4, 1], [5, 1]]);
});
