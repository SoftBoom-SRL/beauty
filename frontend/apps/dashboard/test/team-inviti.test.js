// Inviti al team (19/10): «è confusionario e non arrivano neanche le mail».
// Prima l'invito era un codice da copiare, nessuna mail partiva e nel
// gestionale non c'era un posto dove usarlo. Ora: la pagina /invito/<codice>
// (InvitePage) per entrare, il link da mandare quando la mail non parte,
// rimando e annullo, e il collegamento fra accesso e scheda Staff (nel
// pannello del team e nella scheda dell'operatrice).
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { inviteText, linkableOperators, mailtoLink, openInvites, whatsappLink } from '../src/sections/impostazioni/invites.js';
import { find, findAll, installDom, loadComponent, mount, spy, textOf, tick } from './grid-harness.mjs';

const { default: InvitePage, tokenFromPath } = await loadComponent('apps/dashboard/src/InvitePage.jsx');
const { default: TeamDrawer } = await loadComponent('apps/dashboard/src/sections/impostazioni/TeamDrawer.jsx', {
  stubs: ['DkDrawer.jsx', 'DrawerHead.jsx', 'DkConfirm.jsx'], expand: ['ShareLink', 'CopyField'],
});
const { default: AccessCard } = await loadComponent('apps/dashboard/src/sections/staff/AccessCard.jsx', { expand: ['ShareLink', 'CopyField'] });

const t = (it) => it;
const mounted = [];
afterEach(() => { while (mounted.length) mounted.pop().unmount(); globalThis.__session = null; });

test('il link e il messaggio da mandare a mano', () => {
  const text = inviteText('The Parlour', 'https://x.it/invito/abc', t);
  assert.equal(text, 'Ciao! Ti invito nel team di The Parlour: apri questo link per entrare nel gestionale https://x.it/invito/abc');
  assert.equal(whatsappLink('a b&c'), 'https://wa.me/?text=a%20b%26c');
  assert.match(mailtoLink('mara@x.it', 'The Parlour', 'ciao', t), /^mailto:mara%40x\.it\?subject=Entra%20nel%20team%20di%20The%20Parlour&body=ciao$/);
  const past = '2026-01-01T00:00:00Z', future = '2099-01-01T00:00:00Z';
  const list = openInvites([
    { id: 1, status: 'pending', expires_at: future }, { id: 2, status: 'pending', expires_at: past },
    { id: 3, status: 'accepted', expires_at: future }, { id: 4, status: 'revoked', expires_at: future }, { id: 5, status: 'expired', expires_at: past },
  ]);
  assert.deepEqual(list.map((i) => [i.id, i.expired]), [[1, false], [2, true], [5, true]]);
  const ops = [{ id: 1, user_id: null }, { id: 2, user_id: 9 }, { id: 3, user_id: 7 }, { id: 4, user_id: null, active: false }];
  assert.deepEqual(linkableOperators(ops, 9).map((o) => o.id), [1, 2], 'le libere e la sua');
  assert.equal(tokenFromPath('/invito/1f2e-3d'), '1f2e-3d');
});

/* ---- la pagina dell'invito ---- */

function page(preview, { session = null, accept } = {}) {
  installDom();
  globalThis.__session = session;
  const calls = [];
  globalThis.__api = {
    get: (url, opts) => { calls.push(['GET', url, opts]); return Promise.resolve(preview); },
    post: (url, body) => { calls.push(['POST', url, body]); return accept ? accept(url, body) : Promise.resolve({ access: 'a', salon: { slug: 'the-parlour' } }); },
    put: spy(), patch: spy(), del: spy(),
  };
  const onDone = spy();
  const m = mount(InvitePage, { path: '/invito/tok-1', onDone });
  mounted.push(m);
  return { m, calls, onDone };
}
const base = { email: 'mara@parlour.it', salon_name: 'The Parlour', role_name: 'Front desk', invited_by: 'Sole Caputo', status: 'pending', expires_at: '2099-01-01T00:00:00Z', has_account: false, has_password: false };
const ev = { preventDefault() {} };

test('pagina dell\'invito: account nuovo, nome e password, ed entra', async () => {
  const { m, calls, onDone } = page(base);
  await tick(); m.render();
  assert.deepEqual(calls[0], ['GET', '/api/auth/invitations/preview', { params: { token: 'tok-1' } }]);
  const text = textOf(m.tree);
  assert.ok(text.includes('Entra nel team di The Parlour'));
  assert.ok(text.includes('Sole Caputo ti invita come «Front desk».'));
  const input = (id) => find(m.tree, (el) => el.type === 'input' && el.props.id === id);
  input('inv-first').props.onChange({ target: { value: ' Mara ' } });
  input('inv-last').props.onChange({ target: { value: 'Rizzo' } });
  input('inv-pass').props.onChange({ target: { value: 'Cartellina-2026' } });
  m.render();
  await find(m.tree, (el) => el.type === 'form').props.onSubmit(ev);
  assert.deepEqual(calls[1], ['POST', '/api/auth/invitations/accept', { token: 'tok-1', password: 'Cartellina-2026', first_name: 'Mara', last_name: 'Rizzo' }]);
  assert.equal(onDone.calls.length, 1);
});

test('pagina dell\'invito: chi ha già un account mette solo la sua password', async () => {
  const { m } = page({ ...base, has_account: true, has_password: true });
  await tick(); m.render();
  assert.equal(find(m.tree, (el) => el.type === 'input' && el.props.id === 'inv-first'), null);
  assert.ok(textOf(m.tree).includes('Hai già un account con questa email'));
  assert.ok(textOf(m.tree).includes('Entra nel team'));
});

test('pagina dell\'invito: chi entra con Yourang, e chi ha già la sessione aperta', async () => {
  const yourang = page({ ...base, has_account: true, has_password: false });
  await tick(); yourang.m.render();
  assert.ok(find(yourang.m.tree, (el) => el.props?.['data-yourang'] !== undefined));
  assert.equal(find(yourang.m.tree, (el) => el.type === 'form'), null);
  const open = page({ ...base, has_account: true, has_password: false }, { session: { user: { email: 'MARA@parlour.it' } } });
  await tick(); open.m.render();
  await find(open.m.tree, (el) => el.props?.['data-with-session'] !== undefined).props.onClick();
  assert.deepEqual(open.calls.at(-1), ['POST', '/api/auth/invitations/accept-session', { token: 'tok-1' }]);
  assert.equal(open.onDone.calls.length, 1);
});

test('pagina dell\'invito: scaduto o annullato lo dice, e non c\'è il modulo', async () => {
  for (const [status, words] of [['expired', 'scaduto'], ['revoked', 'annullato'], ['accepted', 'già stato usato']]) {
    const { m } = page({ ...base, status });
    await tick(); m.render();
    assert.ok(textOf(find(m.tree, (el) => el.props?.['data-dead'] !== undefined)).includes(words), status);
    assert.equal(find(m.tree, (el) => el.type === 'form'), null);
  }
});

/* ---- il pannello del team ---- */

const ROLES = [{ id: 3, name: 'Front desk', scopes: ['agenda', 'clients'] }, { id: 4, name: 'Manager', scopes: ['agenda', 'sales'] }];
const OPS = [
  { id: 11, first_name: 'Mara', last_name: 'Rizzo', user_id: null },
  { id: 12, first_name: 'Lina', last_name: 'Bianchi', user_id: 21 },
];
function drawer({ invitations = [], created } = {}) {
  installDom();
  const calls = [];
  const members = [
    { id: 1, user: { id: 20, name: 'Sole Caputo', email: 'sole@x.it' }, role: null, is_owner: true, operator: null },
    { id: 2, user: { id: 21, name: 'Lina B', email: 'lina@x.it' }, role: ROLES[0], is_owner: false, operator: { id: 12, name: 'Lina Bianchi' } },
  ];
  globalThis.__api = {
    get: (url) => Promise.resolve(url.endsWith('/members') ? members : url.endsWith('/roles') ? ROLES : invitations),
    post: (url, body) => { calls.push(['POST', url, body]); return Promise.resolve(created || {}); },
    put: (url, body) => { calls.push(['PUT', url, body]); return Promise.resolve({}); },
    del: (url) => { calls.push(['DEL', url]); return Promise.resolve({ ok: true }); },
    patch: spy(),
  };
  globalThis.__dash = {
    t, lang: 'it', hasScope: () => true, session: { is_owner: true, user: { id: 20 }, salon: { name: 'The Parlour' }, scopes: [] },
    fireToast: spy(), operators: OPS, reload: { operators: spy(() => Promise.resolve()) },
  };
  const m = mount(TeamDrawer, { onClose: spy(), onRoles: spy() });
  mounted.push(m);
  return { m, calls };
}

test('team: un invito senza mail configurata dà il link da mandare, con la scheda Staff scelta', async () => {
  const made = { id: 9, email: 'mara@x.it', role: ROLES[0], operator: { id: 11, name: 'Mara Rizzo' }, token: 'tok', link: 'https://b.it/invito/tok', status: 'pending', expires_at: '2099-01-01T00:00:00Z', sent_at: null, send_error: '', can_email: false, email_sent: false };
  const { m, calls } = drawer({ created: made });
  await tick(); await tick(); m.render();
  find(m.tree, (el) => el.props?.['data-invite'] !== undefined).props.onClick();
  m.render();
  const form = () => find(m.tree, (el) => el.props?.['data-invite-form'] !== undefined);
  find(form(), (el) => el.type === 'input').props.onChange({ target: { value: 'mara@x.it' } });
  const selects = findAll(form(), (el) => el.type === 'select');
  // le schede libere: Mara sì, Lina (già collegata) no
  assert.deepEqual(findAll(selects[1], (el) => el.type === 'option').map((o) => o.props.value), ['', 11]);
  selects[1].props.onChange({ target: { value: '11' } });
  m.render();
  assert.equal(textOf(find(form(), (el) => el.props?.['data-role-summary'] !== undefined)), 'Agenda e appuntamenti · Schede cliente');
  await find(form(), (el) => el.type === 'button' && textOf(el).includes('Invia invito')).props.onClick();
  m.render();
  assert.deepEqual(calls[0], ['POST', '/api/auth/invitations', { email: 'mara@x.it', role_id: 3, operator_id: 11 }]);
  const box = find(m.tree, (el) => el.props?.['data-created'] !== undefined);
  assert.ok(textOf(box).includes('Invito pronto per mara@x.it'));
  assert.ok(textOf(box).includes('non ha ancora la posta configurata'));
  const wa = find(box, (el) => el.type === 'a' && textOf(el).includes('WhatsApp'));
  assert.match(wa.props.href, /^https:\/\/wa\.me\/\?text=.*https%3A%2F%2Fb\.it%2Finvito%2Ftok$/);
});

test('team: gli inviti in attesa dicono com\'è andata la mail, si rimandano e si annullano', async () => {
  const invitations = [
    { id: 5, email: 'a@x.it', role: ROLES[0], operator: null, token: 't5', link: 'https://b.it/invito/t5', status: 'pending', expires_at: '2099-01-01T00:00:00Z', sent_at: '2026-10-19T09:00:00Z', send_error: '', can_email: true },
    { id: 6, email: 'b@x.it', role: ROLES[1], operator: null, token: null, link: null, status: 'pending', expires_at: '2099-01-01T00:00:00Z', sent_at: null, send_error: '', can_email: true },
    { id: 7, email: 'c@x.it', role: ROLES[0], operator: null, token: null, link: null, status: 'accepted', expires_at: '2099-01-01T00:00:00Z', sent_at: null, send_error: '', can_email: true },
  ];
  const { m, calls } = drawer({ invitations, created: { ...invitations[0], email_sent: true } });
  await tick(); await tick(); m.render();
  const card = (id) => find(m.tree, (el) => el.props?.['data-invitation'] === id);
  assert.equal(card(7), null, 'gli accettati non si mostrano');
  assert.equal(find(card(5), (el) => el.props?.['data-delivery'] !== undefined).props['data-delivery'], 'sent');
  assert.ok(find(card(5), (el) => el.props?.['data-share'] !== undefined), 'il link per chi può concedere il ruolo');
  assert.equal(find(card(6), (el) => el.props?.['data-resend'] !== undefined), null, 'senza il link niente azioni');
  await find(card(5), (el) => el.props?.['data-resend'] !== undefined).props.onClick();
  assert.deepEqual(calls.at(-1), ['POST', '/api/auth/invitations/5/resend', undefined]);
  m.render();
  find(card(5), (el) => el.props?.['data-revoke'] !== undefined).props.onClick();
  m.render();
  const confirm = findAll(m.tree, (el) => el.type?.name === 'DkConfirm').find((c) => c.props.open);
  await confirm.props.onConfirm();
  assert.deepEqual(calls.at(-1), ['DEL', '/api/auth/invitations/5']);
});

test('team: ogni membro ha la sua scheda Staff, e cambiarla libera quella di prima', async () => {
  const { m, calls } = drawer();
  await tick(); await tick(); m.render();
  const row = (id) => find(find(m.tree, (el) => el.props?.['data-member'] === id), (el) => el.props?.['data-member-operator'] !== undefined);
  const select = find(row(2), (el) => el.type === 'select');
  assert.equal(select.props.value, 12);
  assert.deepEqual(findAll(select, (el) => el.type === 'option').map((o) => o.props.value), ['', 11, 12]);
  await select.props.onChange({ target: { value: '11' } });
  assert.deepEqual(calls.slice(-2), [['PUT', '/api/staff/12', { user_id: null }], ['PUT', '/api/staff/11', { user_id: 21 }]]);
  m.render();
  assert.equal(find(row(2), (el) => el.type === 'select').props.value, 11);
});

/* ---- la scheda dell'operatrice ---- */

function card(operator, { members, invitations = [] } = {}) {
  installDom();
  const calls = [];
  globalThis.__api = {
    get: (url) => Promise.resolve(url.endsWith('/members') ? members : url.endsWith('/roles') ? [...ROLES, { id: 5, name: 'Operatrice', scopes: ['agenda'] }] : invitations),
    post: (url, body) => { calls.push(['POST', url, body]); return Promise.resolve({ id: 30, email: body.email, role: ROLES[0], operator: { id: operator.id }, token: 'z', link: 'https://b.it/invito/z', status: 'pending', expires_at: '2099-01-01T00:00:00Z', can_email: true, sent_at: '2026-10-19T10:00:00Z', email_sent: true }); },
    put: (url, body) => { calls.push(['PUT', url, body]); return Promise.resolve({}); },
    del: spy(), patch: spy(),
  };
  globalThis.__dash = { t, lang: 'it', fireToast: spy(), session: { salon: { name: 'The Parlour' } } };
  const m = mount(AccessCard, { operator });
  mounted.push(m);
  return { m, calls };
}

test('scheda: l\'accesso collegato si vede e si scollega', async () => {
  const members = [{ id: 2, user: { id: 21, name: 'Lina B', email: 'lina@x.it' }, role: ROLES[0], is_owner: false, operator: { id: 12, name: 'Lina Bianchi' } }];
  const { m, calls } = card({ id: 12, first_name: 'Lina', last_name: 'Bianchi', user_id: 21 }, { members });
  await tick(); m.render();
  const linked = find(m.tree, (el) => el.props?.['data-linked'] !== undefined);
  assert.ok(textOf(linked).includes('lina@x.it · Front desk'));
  await find(linked, (el) => el.props?.['data-unlink'] !== undefined).props.onClick();
  assert.deepEqual(calls.at(-1), ['PUT', '/api/staff/12', { user_id: null }]);
});

test('scheda: senza accesso la si invita, già collegata alla sua scheda e col ruolo «Operatrice»', async () => {
  const { m, calls } = card({ id: 11, first_name: 'Mara', last_name: 'Rizzo', user_id: null }, { members: [] });
  await tick(); m.render();
  assert.equal(find(m.tree, (el) => el.props?.['data-mode-link'] !== undefined), null, 'nessun accesso libero da collegare');
  find(m.tree, (el) => el.props?.['data-mode-invite'] !== undefined).props.onClick();
  m.render();
  const form = find(m.tree, (el) => el.props?.['data-invite-form'] !== undefined);
  assert.equal(find(form, (el) => el.type === 'select').props.value, 5);
  find(form, (el) => el.type === 'input').props.onChange({ target: { value: 'mara@x.it' } });
  m.render();
  await find(m.tree, (el) => el.type === 'button' && textOf(el).includes('Invia invito')).props.onClick();
  assert.deepEqual(calls[0], ['POST', '/api/auth/invitations', { email: 'mara@x.it', role_id: 5, operator_id: 11 }]);
  m.render();
  assert.ok(textOf(find(m.tree, (el) => el.props?.['data-pending'] !== undefined)).includes('Invito in attesa: mara@x.it'));
});
