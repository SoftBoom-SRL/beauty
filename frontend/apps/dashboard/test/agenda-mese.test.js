// La griglia del mese (month/MonthGrid.jsx, montata con test/grid-harness.mjs).
// Riordino dell'agenda del 24/09/2026: nei giorni con i turni ma senza
// appuntamenti la barra dell'occupazione diventava un blocco grigio alto
// quanto mezza cella.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { find, installDom, loadComponent } from './grid-harness.mjs';

const { default: MonthGrid } = await loadComponent('apps/dashboard/src/sections/agenda/month/MonthGrid.jsx', { expand: ['DayCell'] });

const kidsOf = (el) => [el?.props?.children].flat(Infinity).filter((c) => c && typeof c === 'object');

test('la barra dell\'occupazione di una cella sta in una riga: non cresce in altezza', () => {
  installDom();
  const iso = '2026-09-28';
  // un lunedì con i turni (540 minuti) e nessun appuntamento
  const day = { date: iso, count: 0, by_status: {}, capacity_min: 540, booked_min: 0, revenue: 0, appointments: [],
    operators: [{ operator_id: 1, capacity_min: 540, booked_min: 0 }] };
  const tree = MonthGrid({
    weeks: [[iso]], month: 8, byDate: { [iso]: day }, today: '2026-09-24', t: (it) => it, lang: 'it', showRevenue: false,
    opById: { 1: { id: 1, first_name: 'Anna', last_name: 'Neri' } }, opOrder: { 1: 0 }, opFirsts: ['Anna'], opColors: { 1: '#6366F1' },
    onOpenDay() {}, onCellEnter() {}, onCellLeave() {},
  });
  // il contenitore diretto della barra del giorno (alta 5 px; quelle delle operatrici sono da 4)
  const parent = find(tree, (el) => kidsOf(el).some((c) => c.type?.name === 'Bar' && c.props.height === 5));
  assert.ok(parent, 'la barra c\'è');
  // `Bar` ha flex: 1 per allargarsi in una riga; figlia diretta della cella
  // (una colonna flex) si prendeva tutta l'altezza libera
  assert.notEqual(parent.type, 'button', 'non è figlia diretta della cella a colonna');
  assert.equal(parent.props.style?.display, 'flex');
  assert.notEqual(parent.props.style?.flexDirection, 'column');
});
