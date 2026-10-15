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

// 15/10: il telefono non è più obbligatorio (bambine, regali, schede da un
// altro gestionale) e un numero già di un'altra cliente propone di usarlo
// come contatto, come la scheda anagrafica.
function creating(post) {
  const g = picker();
  globalThis.__api.post = post;
  g.newBtn().props.onClick();
  g.m.render();
  const first = find(g.m.tree, (el) => el.type === 'input' && el.props.placeholder === 'Nome *');
  first.props.onChange({ target: { value: 'Giulia' } });
  g.m.render();
  const createBtn = () => find(g.m.tree, (el) => el.type === 'button' && textOf(el).includes('Crea e seleziona'));
  return { g, createBtn };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

test('una scheda nuova si crea anche solo col nome, senza telefono', async () => {
  const bodies = [];
  const { g, createBtn } = creating((url, body) => { bodies.push(body); return Promise.resolve({ id: 9, full_name: 'Giulia', phone: '' }); });
  createBtn().props.onClick();
  await flush(); g.m.render();
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].phone, '');
  assert.equal(bodies[0].contact_client_id, null);
  assert.equal(g.onChange.calls.length, 1);
});

test('numero già di un\'altra cliente: «Usa il numero di …» crea la scheda collegata, senza telefono', async () => {
  const bodies = [];
  // la stessa classe che il componente riconosce (vedi grid-harness.mjs)
  const taken = new globalThis.__ApiError(400, 'Telefono già registrato', { detail: 'Telefono già registrato', phone_holder_id: 4, phone_holder_name: 'Laura Rossi', contact_allowed: true });
  const { g, createBtn } = creating((url, body) => {
    bodies.push(body);
    return bodies.length === 1 ? Promise.reject(taken) : Promise.resolve({ id: 10, full_name: 'Giulia', phone: '' });
  });
  createBtn().props.onClick();
  await flush(); g.m.render();
  const use = find(g.m.tree, (el) => el.type === 'button' && textOf(el).includes('Usa il numero di Laura'));
  assert.ok(use, 'compare la proposta');
  use.props.onClick();
  await flush(); g.m.render();
  assert.equal(bodies.length, 2);
  assert.equal(bodies[1].phone, '');
  assert.equal(bodies[1].contact_client_id, 4);
  assert.equal(g.onChange.calls.length, 1);
});
