// Il selettore della cliente di «Nuova prenotazione» e della prenotazione di
// gruppo (sections/agenda/ClientPicker.jsx, lo stesso componente nei due
// drawer), montato con test/grid-harness.mjs.
// 15/10: «Nuovo cliente» sempre a vista, non solo fra i risultati della ricerca.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { find, installDom, loadComponent, mount, spy, textOf } from './grid-harness.mjs';

const { default: ClientPicker } = await loadComponent('apps/dashboard/src/sections/agenda/ClientPicker.jsx');

function picker({ scopes = ['clients'] } = {}) {
  installDom();
  globalThis.__api = { get: () => new Promise(() => {}), post: () => Promise.resolve({}), put: () => Promise.resolve({}), patch: () => Promise.resolve({}), del: () => Promise.resolve({}) };
  globalThis.__dash = { t: (it) => it, lang: 'it', fireToast: spy(), hasScope: (s) => scopes.includes(s), clientCategories: [] };
  const onChange = spy();
  const m = mount(ClientPicker, { value: null, onChange });
  const newBtn = () => find(m.tree, (el) => el.type === 'button' && textOf(el).includes('Nuovo cliente') && el.props.role !== 'option');
  return { m, onChange, newBtn };
}

test('«Nuovo cliente» è sempre a vista accanto alla ricerca, anche senza aver scritto niente', () => {
  const g = picker();
  // nessuna ricerca, nessuna tendina: prima per crearla bisognava cercare e non trovare
  assert.equal(find(g.m.tree, (el) => el.props?.role === 'listbox'), null);
  assert.ok(g.newBtn(), 'il bottone c\'è');
  g.newBtn().props.onClick();
  g.m.render();
  assert.ok(find(g.m.tree, (el) => el.type === 'button' && textOf(el).includes('Crea e seleziona')), 'si apre la scheda veloce');
});

test('quello che si è scritto nella ricerca precompila la scheda nuova', () => {
  const g = picker();
  const input = find(g.m.tree, (el) => el.type === 'input' && el.props.role === 'combobox');
  input.props.onChange({ target: { value: 'Giada Bellini' } });
  g.m.render();
  g.newBtn().props.onClick();
  g.m.render();
  const values = [];
  find(g.m.tree, (el) => { if (el.type === 'input' && typeof el.props.value === 'string') values.push(el.props.value); return false; });
  assert.ok(values.includes('Giada') && values.includes('Bellini'), JSON.stringify(values));
});

test('senza il permesso sulle clienti il bottone non c\'è', () => {
  const g = picker({ scopes: [] });
  assert.equal(g.newBtn(), null);
});
