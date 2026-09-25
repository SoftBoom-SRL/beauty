// Le altre azioni della cliente, fino alla chiamata: il Profilo (salvataggio
// ottimistico, lingua, consenso alle promozioni, uscita), l'acquisto di una
// gift card, la lista d'attesa (rimuovere e aggiungersi) e il pagamento della
// caparra. Il giro del test di fumo apre queste schermate ma non tocca niente.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fail, fakeCtx, loadScreen, lost, pending, reply, tap, text, calls } from './fake-app.mjs';
import { button, findAll, mount, settle, textOf } from './load.mjs';

const { default: Profilo } = await loadScreen('src/screens/Profilo.jsx');
const { default: GiftCard } = await loadScreen('src/screens/GiftCard.jsx');
const { default: Waitlist } = await loadScreen('src/screens/Waitlist.jsx');
const { default: WaitlistNew } = await loadScreen('src/screens/WaitlistNew.jsx');
const { DepositDue } = await loadScreen('src/components/DepositDue.jsx');

const stubs = (s, name) => findAll(s.tree, (el) => el.type?.name === name);
const ME = { first_name: 'Giada', last_name: 'Bellini', phone: '+39 333 884 1120', email: '', whatsapp_reminders: true, marketing_consent: true, lang: 'it' };

test('Profilo: dati, lista d\'attesa e punti all\'apertura; se i due extra non arrivano, 0 senza toast', async () => {
  const { toasts } = fakeCtx({ client: { first_name: 'Giada' } });
  const s = mount(Profilo);
  try {
    assert.deepEqual(calls().map((c) => c.slice(0, 2)), [
      ['get', '/api/auth/client/me'], ['get', '/api/agenda/client/waitlist'], ['get', '/api/marketing/client/wallet'],
    ]);
    await reply(pending('get', '/api/auth/client/me')[0], ME);
    await lost(pending('get', '/api/agenda/client/waitlist')[0]);
    await fail(pending('get', '/api/marketing/client/wallet')[0], 500, 'Errore del server');
    s.render();
    assert.match(text(s), /GBGiada BelliniCliente di The Parlour/);
    assert.match(text(s), /Telefono\+39 333 884 1120Email—Punti fedeltà0 pt/);
    assert.match(text(s), /Nessuno slot libero\? Mettiti in lista/);
    assert.deepEqual(toasts, []);
  } finally { s.unmount(); }
  // con le risposte: richieste attive e punti arrotondati
  const again = fakeCtx({});
  const t = mount(Profilo);
  try {
    await reply(pending('get', '/api/auth/client/me')[0], ME);
    await reply(pending('get', '/api/agenda/client/waitlist')[0], [{ status: 'active' }, { status: 'contacted' }, { status: 'active' }]);
    await reply(pending('get', '/api/marketing/client/wallet')[0], { loyalty: [{ points: '12.4' }, { points: 3 }] });
    t.render();
    assert.match(text(t), /Punti fedeltà15 pt/);
    assert.match(text(t), /2 richieste attive · ti avvisiamo su WhatsApp/);
    // i dati della cliente che non arrivano: un toast, e i segnaposto restano
    const bad = fakeCtx({});
    const u = mount(Profilo);
    await fail(pending('get', '/api/auth/client/me')[0], 401, 'Sessione scaduta');
    u.render();
    assert.deepEqual(bad.toasts, [{ msg: 'Sessione scaduta', icon: 'alert' }]);
    assert.equal(stubs(u, 'Toggle').length, 0);
    u.unmount();
    assert.deepEqual(again.toasts, []);
  } finally { t.unmount(); }
});

test('Profilo: promemoria e consenso subito a video, indietro se il server rifiuta; lingua; uscita', async () => {
  const { toasts, views, langs } = fakeCtx({});
  const s = mount(Profilo);
  try {
    await reply(pending('get', '/api/auth/client/me')[0], ME);
    s.render();
    const [wa] = stubs(s, 'Toggle');
    wa.props.onChange(false);
    s.render();
    assert.equal(stubs(s, 'Toggle')[0].props.on, false);          // ottimistico
    const put = pending('put', '/api/auth/client/me');
    assert.deepEqual(put.map((c) => c.args), [[{ whatsapp_reminders: false }]]);
    await reply(put[0], { ...ME, whatsapp_reminders: false });
    s.render();
    assert.deepEqual(toasts, [{ msg: 'Promemoria WhatsApp disattivati', icon: 'check' }]);
    stubs(s, 'Toggle')[0].props.onChange(true);
    s.render();
    await fail(pending('put', '/api/auth/client/me')[1], 500, 'Non salvato');
    s.render();
    assert.equal(stubs(s, 'Toggle')[0].props.on, false);          // tornato com'era
    assert.deepEqual(toasts[1], { msg: 'Non salvato', icon: 'alert' });
    // consenso alle promozioni: il suo endpoint, e indietro se fallisce
    stubs(s, 'Toggle')[1].props.onChange(false);
    s.render();
    assert.equal(stubs(s, 'Toggle')[1].props.on, false);
    const consent = pending('post', '/api/marketing/client/marketing-consent');
    assert.deepEqual(consent.map((c) => c.args), [[{ accepted: false }]]);
    await reply(consent[0], { ok: true });
    s.render();
    assert.deepEqual(toasts[2], { msg: 'Non riceverai più offerte e promozioni', icon: 'check' });
    stubs(s, 'Toggle')[1].props.onChange(true);
    await lost(pending('post', '/api/marketing/client/marketing-consent')[1]);
    s.render();
    assert.equal(stubs(s, 'Toggle')[1].props.on, false);
    assert.deepEqual(toasts[3], { msg: 'Errore di rete', icon: 'alert' });
    // lingua: si cambia subito e si salva sulla scheda
    await tap(s, 'EN');
    assert.deepEqual(langs, ['en']);
    assert.deepEqual(pending('put', '/api/auth/client/me')[2].args, [{ lang: 'en' }]);
    await reply(pending('put', '/api/auth/client/me')[2], { ...ME, lang: 'en', whatsapp_reminders: false });
    await tap(s, 'IT');                                          // la lingua del contesto è ancora «it»
    assert.deepEqual(langs, ['en']);
    // uscita: prima la home, poi la sessione chiusa, poi il toast
    await tap(s, 'Esci');
    assert.deepEqual(views, [['home', undefined]]);
    assert.equal(calls().filter((c) => c[0] === 'logout').length, 1);
    assert.deepEqual(toasts[4], { msg: 'Sei uscita dal profilo', icon: 'check' });
  } finally { s.unmount(); }
});

test('Profilo: la lingua scelta durante un salvataggio si salva dopo; se il server rifiuta torna quella salvata (voce 34)', async () => {
  const { langs, toasts } = fakeCtx({});
  // qui la lingua del contesto cambia davvero, come in ctx.jsx
  const ctx = globalThis.__ctx;
  ctx.setLang = (l) => { langs.push(l); ctx.lang = l; };
  const s = mount(Profilo);
  const puts = () => pending('put', '/api/auth/client/me');
  try {
    await reply(pending('get', '/api/auth/client/me')[0], ME);          // sulla scheda «it»
    s.render();
    // EN e subito dopo IT, col primo salvataggio ancora in volo
    await tap(s, 'EN');
    await tap(s, 'IT');
    assert.equal(ctx.lang, 'it');
    assert.deepEqual(puts().map((c) => c.args), [[{ lang: 'en' }]]);
    await reply(puts()[0], { ...ME, lang: 'en' });
    s.render();
    // finito il primo, si salva l'ultima scelta: sul server non resta «en»
    assert.deepEqual(puts().map((c) => c.args), [[{ lang: 'en' }], [{ lang: 'it' }]]);
    await reply(puts()[1], { ...ME, lang: 'it' });
    s.render();
    assert.equal(puts().length, 2);
    // anche dietro al salvataggio dei promemoria
    stubs(s, 'Toggle')[0].props.onChange(false);
    s.render();
    await tap(s, 'EN');
    assert.equal(puts().length, 3);
    await reply(puts()[2], { ...ME, whatsapp_reminders: false });
    s.render();
    assert.deepEqual(puts()[3].args, [{ lang: 'en' }]);
    await reply(puts()[3], { ...ME, whatsapp_reminders: false, lang: 'en' });
    s.render();
    // IT, EN e di nuovo IT col salvataggio di IT in volo: l'ultima scelta è
    // già quella salvata, niente da salvare
    await tap(s, 'IT');
    await tap(s, 'EN');
    await tap(s, 'IT');
    await reply(puts()[4], { ...ME, whatsapp_reminders: false, lang: 'it' });
    s.render();
    assert.equal(puts().length, 5);
    assert.equal(ctx.lang, 'it');
    // il salvataggio che non riesce: a schermo torna la lingua salvata
    await tap(s, 'EN');
    assert.equal(ctx.lang, 'en');
    await fail(puts()[5], 500, 'Non salvato');
    s.render();
    assert.equal(ctx.lang, 'it');
    assert.deepEqual(toasts.slice(-1), [{ msg: 'Non salvato', icon: 'alert' }]);
    assert.equal(puts().length, 6);
    assert.deepEqual(langs, ['en', 'it', 'en', 'it', 'en', 'it', 'en', 'it']);
  } finally { s.unmount(); }
});

test('Gift card: acquisto da pagare in salone, poi il portafoglio ricaricato', async () => {
  const { toasts } = fakeCtx({});
  const s = mount(GiftCard);
  try {
    await reply(pending('get', '/api/marketing/client/wallet')[0], {
      gift_cards: [{ id: 1, code: 'AAA', balance: '30.00', initial_value: '50.00', payment_status: 'paid', received: false, recipient_name: '', spendable: true, expires_at: null }],
    });
    s.render();
    assert.match(text(s), /Saldo gift card€30,001 carta attiva · spendibili in salone/);
    await tap(s, /Regala una gift card/);
    assert.match(text(s), /Conferma · €50,00/);
    // importo scritto a mano: sotto i 5 euro non si conferma
    stubs(s, 'NumInput')[0].props.onChange('3');
    s.render();
    assert.equal(button(s.tree, /^Conferma/).props.disabled, true);
    stubs(s, 'NumInput')[0].props.onChange('12.5');
    findAll(s.tree, (el) => el.type === 'input' && /destinataria/.test(el.props.placeholder))[0].props.onChange({ target: { value: '  Maria ' } });
    s.render();
    await tap(s, 'Conferma · €12,50');
    const post = pending('post', '/api/marketing/client/gift-cards');
    assert.deepEqual(post.map((c) => c.args), [[{ value: '12.50', recipient_name: 'Maria' }]]);
    await reply(post[0], { initial_value: '12.50', recipient_name: 'Maria', code: 'BBB' });
    s.render();
    assert.deepEqual(toasts, [{ msg: 'Gift card creata!', icon: 'gift' }]);
    assert.match(text(s), /Gift card da €12,50 creata per Maria · BBB\. Si paga in salone alla prossima visita\./);
    // il portafoglio si richiede subito dopo
    assert.equal(pending('get', '/api/marketing/client/wallet').length, 2);
    await tap(s, /Regala una gift card/);
    await tap(s, 'Conferma · €50,00');
    await fail(pending('post', '/api/marketing/client/gift-cards')[1], 400, 'Importo non valido');
    s.render();
    assert.deepEqual(toasts[1], { msg: 'Importo non valido', icon: 'alert' });
  } finally { s.unmount(); }
});

test('Gift card e lista d\'attesa: l\'errore arrivato a schermata chiusa non compare su quella dopo (voce 33)', async () => {
  for (const [Screen, path] of [[GiftCard, '/api/marketing/client/wallet'], [Waitlist, '/api/agenda/client/waitlist']]) {
    const { toasts } = fakeCtx({});
    const s = mount(Screen);
    // la cliente torna indietro prima della risposta, che poi fallisce
    s.unmount();
    await lost(pending('get', path)[0]);
    assert.deepEqual(toasts, [], path);
    // a schermata aperta invece l'errore si dice
    const again = fakeCtx({});
    const t = mount(Screen);
    try {
      await lost(pending('get', path)[0]);
      t.render();
      assert.deepEqual(again.toasts, [{ msg: 'Errore di rete', icon: 'alert' }], path);
      // e lo scheletro del caricamento se ne va
      assert.equal(findAll(t.tree, (el) => el.props.className === 'skel').length, 0, path);
    } finally { t.unmount(); }
  }
});

test('Lista d\'attesa: rimuovere una richiesta non blocca le altre', async () => {
  const { toasts, views } = fakeCtx({});
  const s = mount(Waitlist);
  try {
    await reply(pending('get', '/api/agenda/client/waitlist')[0], [
      { id: 1, service_name: 'Taglio', status: 'active', preference: 'exact', exact_days: [0, 5], exact_time: '10:00:00', operator_name: null, created_at: '2026-09-20T10:00:00+02:00' },
      { id: 2, service_name: 'Colore', status: 'contacted', preference: 'morning', operator_name: 'Sole', created_at: '2026-09-21T10:00:00+02:00' },
    ]);
    s.render();
    assert.match(text(s), /TaglioIn listaQualsiasi operatriceLun Sab · 10:00In lista dal Dom 20 set/);
    assert.match(text(s), /ColoreContattataSoleMattina/);
    const removes = () => findAll(s.tree, (el) => el.type === 'button' && /^(Rimuovi|Rimozione…)$/.test(textOf(el)));
    removes()[0].props.onClick();
    s.render();
    assert.deepEqual(removes().map(textOf), ['Rimozione…', 'Rimuovi']);
    removes()[1].props.onClick();
    s.render();
    assert.deepEqual(calls().filter((c) => c[0] === 'del').map((c) => c[1]), ['/api/agenda/client/waitlist/1', '/api/agenda/client/waitlist/2']);
    await fail(pending('del', '/api/agenda/client/waitlist/2')[0], 404, 'Richiesta non trovata');
    await reply(pending('del', '/api/agenda/client/waitlist/1')[0], { ok: true });
    s.render();
    assert.doesNotMatch(text(s), /Taglio/);
    assert.match(text(s), /Colore/);
    assert.deepEqual(toasts, [{ msg: 'Richiesta non trovata', icon: 'alert' }, { msg: 'Richiesta rimossa', icon: 'check' }]);
    await tap(s, /Aggiungiti alla lista/);
    assert.deepEqual(views, [['waitlist-new', undefined]]);
  } finally { s.unmount(); }
});

test('Aggiungersi alla lista d\'attesa: il servizio arrivato da Prenota, l\'orario preciso', async () => {
  const CATS = [{ id: 1, name_it: 'Capelli', name_en: 'Hair', services: [
    { id: 10, name_it: 'Taglio', price: '30.00', duration_min: 45 }, { id: 11, name_it: 'Colore', price: '50.00', duration_min: 60, soak_min: 40 },
  ] }];
  const { toasts, views } = fakeCtx({ viewParams: { serviceId: 10 } });
  const s = mount(WaitlistNew);
  try {
    assert.deepEqual(calls(), [['get', '/api/catalog/public/services', { params: { salon: 'the-parlour' }, auth: false }]]);
    await reply(pending('get', '/api/catalog/public/services')[0], CATS);
    s.render();
    assert.match(text(s), /Taglio45m · €30,00.*Colore1h 40m · €50,00/);
    await tap(s, 'Orario preciso');
    const letters = () => findAll(s.tree, (el) => el.type === 'button' && /^[A-Z]$/.test(textOf(el)));
    assert.equal(letters().map(textOf).join(''), 'LMMGVSD');
    letters()[0].props.onClick();                               // lunedì, con il sabato già scelto
    s.render();
    findAll(s.tree, (el) => el.type === 'input' && el.props.type === 'time')[0].props.onChange({ target: { value: '09:30' } });
    s.render();
    await tap(s, /Conferma richiesta/);
    const post = pending('post', '/api/agenda/client/waitlist');
    assert.deepEqual(post.map((c) => c.args), [[{ service_id: 10, preference: 'exact', exact_days: [0, 5], exact_time: '09:30' }]]);
    await reply(post[0], { id: 3 });
    assert.deepEqual(toasts, [{ msg: 'Sei in lista! Ti avvisiamo su WhatsApp.', icon: 'check' }]);
    assert.deepEqual(views, [['waitlist', undefined]]);
  } finally { s.unmount(); }
  // senza orario preciso i giorni non partono; senza giorni non si conferma
  fakeCtx({ viewParams: {} });
  const t = mount(WaitlistNew);
  try {
    await reply(pending('get', '/api/catalog/public/services')[0], CATS);
    t.render();
    assert.equal(button(t.tree, /Conferma richiesta/).props.disabled, true);
    await tap(t, /^Colore/);
    await tap(t, 'Mattina');
    await tap(t, /Conferma richiesta/);
    assert.deepEqual(pending('post', '/api/agenda/client/waitlist')[0].args, [{ service_id: 11, preference: 'morning' }]);
    await fail(pending('post', '/api/agenda/client/waitlist')[0], 400, 'Già in lista');
    await tap(t, 'Orario preciso');
    findAll(t.tree, (el) => el.type === 'button' && textOf(el) === 'S')[0].props.onClick();   // tolto il sabato
    t.render();
    assert.equal(button(t.tree, /Conferma richiesta/).props.disabled, true);
  } finally { t.unmount(); }
});

test('Caparra: il link si chiede a ogni tocco; 503 = si paga in sede, 400 = da ricaricare', async () => {
  const assigned = [];
  globalThis.window.location = { assign: (u) => assigned.push(u) };
  const due = new Date(Date.now() + 2 * 3600 * 1000).toISOString();
  const appt = { id: 9, deposit_status: 'required', deposit_amount: '10.00', deposit_due_at: due };
  const { toasts } = fakeCtx({});
  const stale = [];
  const props = { appt, t: (it) => it, lang: 'it', fireToast: (o) => toasts.push(o), onStale: () => stale.push(1) };
  const s = mount(DepositDue, props);
  try {
    assert.match(text(s), /^Caparra di €10,00 da pagareEntro le .*, poi l'orario torna disponibile\.Paga ora$/);
    await tap(s, 'Paga ora');
    assert.match(text(s), /Attendi…/);
    const link = pending('post', '/api/sales/client/appointments/9/deposit-link');
    assert.deepEqual(link.map((c) => c.args), [[{}]]);
    await reply(link[0], { url: 'https://checkout.example/abc' });
    s.render();
    assert.deepEqual(assigned, ['https://checkout.example/abc']);
    await tap(s, 'Paga ora');
    await reply(pending('post', '/api/sales/client/appointments/9/deposit-link')[1], { url: '' });
    s.render();
    await tap(s, 'Paga ora');
    await fail(pending('post', '/api/sales/client/appointments/9/deposit-link')[2], 503, 'Pagamenti non attivi');
    s.render();
    await tap(s, 'Paga ora');
    await fail(pending('post', '/api/sales/client/appointments/9/deposit-link')[3], 400, 'La visita non è più da pagare');
    assert.deepEqual(toasts, [
      { msg: 'Link di pagamento non disponibile: contatta il salone.', icon: 'alert' },
      { msg: 'Il salone non accetta pagamenti online: potrai pagare in sede.', icon: 'info' },
      { msg: 'La visita non è più da pagare', icon: 'alert' },
    ]);
    assert.deepEqual(stale, [1]);
  } finally { s.unmount(); }
  // scaduta: niente pulsante; non da pagare: niente del tutto
  const past = mount(DepositDue, { ...props, appt: { ...appt, deposit_due_at: new Date(Date.now() - 60000).toISOString() } });
  assert.match(text(past), /Il tempo per pagarla è scaduto e l’orario non è più tenuto: contatta il salone\./);
  assert.equal(findAll(past.tree, (el) => el.type === 'button').length, 0);
  past.unmount();
  const paid = mount(DepositDue, { ...props, appt: { ...appt, deposit_status: 'paid' } });
  assert.equal(paid.tree, null);
  paid.unmount();
  await settle();
});
