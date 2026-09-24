// Le viste dell'app cliente (src/routes.js): un elenco solo al posto di tre
// (gli schermi del registro, le viste personali del gate di App, le viste con
// la barra di NavBar). Le prove confrontano l'elenco con le tre liste di
// prima, scritte qui così com'erano: una vista personale che perdesse il flag
// si aprirebbe senza sessione.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { loadModule } from './load.mjs';

const R = await loadModule('src/routes.js');   // gli schermi .jsx diventano componenti muti

const SCREENS_BEFORE = {
  home: 'Home', prenota: 'index', prenotazioni: 'Prenotazioni', wallet: 'Wallet', giftcard: 'GiftCard',
  profilo: 'Profilo', waitlist: 'Waitlist', 'waitlist-new': 'WaitlistNew', pacchetti: 'Pacchetti',
  sposta: 'Sposta', annulla: 'Annulla',
};
const PERSONAL_VIEWS_BEFORE = ['prenotazioni', 'wallet', 'profilo', 'waitlist', 'waitlist-new', 'sposta', 'annulla', 'giftcard'];
const NAV_VIEWS_BEFORE = ['home', 'prenotazioni', 'wallet', 'profilo', 'waitlist', 'pacchetti', 'giftcard'];
const navOnBefore = (key, view) => view === key || (key === 'profilo' && ['waitlist'].includes(view)) || (key === 'wallet' && ['giftcard'].includes(view));

const VIEWS = Object.keys(SCREENS_BEFORE);
const sorted = (list) => [...list].sort();

test('le stesse viste, ciascuna col suo schermo; una vista sconosciuta apre la Home', () => {
  assert.deepEqual(sorted(Object.keys(R.ROUTES)), sorted(VIEWS));
  for (const view of VIEWS) {
    assert.equal(R.screenFor(view).name, SCREENS_BEFORE[view], view);
    assert.equal(R.screenFor(view), R.ROUTES[view].Screen);
  }
  assert.equal(R.screenFor('boh'), R.ROUTES.home.Screen);
  assert.equal(R.screenFor(undefined), R.ROUTES.home.Screen);
});

test('l\'insieme delle viste personali non cambia', () => {
  assert.deepEqual(sorted(VIEWS.filter(R.isPersonal)), sorted(PERSONAL_VIEWS_BEFORE));
  for (const view of [...VIEWS, 'boh', '']) assert.equal(R.isPersonal(view), PERSONAL_VIEWS_BEFORE.includes(view), view);
});

test('le viste con la barra e la voce accesa non cambiano', () => {
  assert.deepEqual(sorted(VIEWS.filter(R.hasNav)), sorted(NAV_VIEWS_BEFORE));
  for (const view of [...VIEWS, 'boh']) assert.equal(R.hasNav(view), NAV_VIEWS_BEFORE.includes(view), view);
  for (const key of ['home', 'prenotazioni', 'prenota', 'wallet', 'profilo']) {
    for (const view of [...VIEWS, 'boh']) assert.equal(R.navOn(key, view), navOnBefore(key, view), `${key} su ${view}`);
  }
});
