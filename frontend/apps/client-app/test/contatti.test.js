// Il modulo contatti pubblico del salone (/<slug>/hook, schermo Hook): lo
// schermo vero col React finto e l'API finta di test/fake-app.mjs. Si
// compila, si invia e si guarda che cosa parte e che cosa si legge a video.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fail, fakeCtx, loadScreen, lost, pending, text } from './fake-app.mjs';
import { button, findAll, mount } from './load.mjs';

const { default: Hook } = await loadScreen('src/screens/Hook.jsx');

const HOOK = '/api/clients/public/hook';

/** Nome, telefono e privacy: il minimo perché «Invia» parta. */
function compile(s) {
  findAll(s.tree, (el) => el.type === 'input' && el.props.autoComplete === 'given-name')[0].props.onChange({ target: { value: 'Sofia' } });
  findAll(s.tree, (el) => el.type?.name === 'PhoneInput')[0].props.onChange('333 884 1120');
  s.render();
  // le caselle: la trappola per i bot, la privacy, le promozioni
  findAll(s.tree, (el) => el.type === 'input' && el.props.type === 'checkbox')[1].props.onChange({ target: { checked: true } });
  s.render();
}

test('senza rete: «Errore di rete» nella lingua dell\'app, non il testo del browser (voce 31)', async () => {
  for (const [extra, label, want] of [
    [{}, 'Invia', 'Errore di rete'],
    [{ t: (it, en) => en, lang: 'en' }, 'Send', 'Network error'],
  ]) {
    fakeCtx(extra);
    const s = mount(Hook);
    try {
      compile(s);
      button(s.tree, label).props.onClick();
      s.render();
      assert.equal(pending('post', HOOK).length, 1);
      await lost(pending('post', HOOK)[0]);
      s.render();
      assert.match(text(s), new RegExp(want));
      assert.doesNotMatch(text(s), /Failed to fetch/);
    } finally { s.unmount(); }
  }
});

test('una risposta del server: il suo messaggio', async () => {
  fakeCtx({});
  const s = mount(Hook);
  try {
    compile(s);
    button(s.tree, 'Invia').props.onClick();
    await fail(pending('post', HOOK)[0], 429, 'Troppe richieste: riprova più tardi');
    s.render();
    assert.match(text(s), /Troppe richieste: riprova più tardi/);
    assert.doesNotMatch(text(s), /Errore di rete/);
  } finally { s.unmount(); }
});
