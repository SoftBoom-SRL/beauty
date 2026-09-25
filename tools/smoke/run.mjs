#!/usr/bin/env node
// run.mjs — giro deterministico nel browser su dashboard e app cliente.
//
//   node run.mjs --out DIR --api URL --dash URL --client URL --now ISO
//                [--date AAAA-MM-GG] [--server-log FILE] [--repo DIR]
//
// Di solito lo lancia smoke.sh. Scrive DIR/report.json e DIR/screenshots/.
// Ogni PASSO fa qualche clic, aspetta che la pagina sia ferma (niente richieste
// per QUIET_MS, escluso il feed live; DOM fermo per DOM_QUIET_MS) e registra:
// esito, URL, errori di console e di pagina, richieste fallite e risposte >= 400,
// le chiamate API del passo (metodo, percorso, query ordinata, corpo JSON a
// chiavi ordinate, valori volatili mascherati), il testo visibile, i valori dei
// campi, i toast comparsi e uno screenshot.
//
// I passi sono raggruppati in CATENE: ogni catena riparte da una pagina
// ricaricata e ogni passo costruisce sullo stato lasciato dal precedente. Se un
// passo fallisce, prima del successivo si ricarica e si rigiocano (senza
// registrarli come passi) quelli già riusciti della catena, così un errore non
// si trascina dietro il resto del giro.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

/* ---------------------------------------------------------------- argomenti */
const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
for (const k of ['out', 'api', 'dash', 'client', 'now']) {
  if (!args[k]) { console.error(`run.mjs: manca --${k}`); process.exit(2); }
}
const OUT = path.resolve(args.out);
const SHOTS = path.join(OUT, 'screenshots');
const API = args.api.replace(/\/$/, '');
const DASH = args.dash.replace(/\/$/, '');
const CLIENT = args.client.replace(/\/$/, '');
const NOW = new Date(args.now);
const SERVER_LOG = args['server-log'] || path.join(OUT, 'server.log');
const ONLY = process.env.SMOKE_STEPS ? new RegExp(process.env.SMOKE_STEPS) : null;
const HEADFUL = process.env.SMOKE_HEADFUL === '1';

const require = createRequire(import.meta.url);
// Playwright: quello indicato, altrimenti quello installato (locale o globale).
// Chromium lo trova da PLAYWRIGHT_BROWSERS_PATH, come per `npx playwright`.
function loadPlaywright() {
  const candidates = [process.env.SMOKE_PLAYWRIGHT, 'playwright', '/opt/node22/lib/node_modules/playwright'].filter(Boolean);
  for (const name of candidates) {
    try { return require(name); } catch { /* il prossimo */ }
  }
  throw new Error('Playwright non trovato: installalo (npm i -g playwright) o imposta SMOKE_PLAYWRIGHT');
}
const { chromium, devices } = loadPlaywright();

/* ------------------------------------------------------------------ tempi */
const QUIET_MS = 800;        // nessuna richiesta (salvo il feed live) per tanto
const DOM_QUIET_MS = 500;    // nessuna mutazione del DOM (salvo i toast) per tanto
const SETTLE_MAX_MS = 15000; // poi il passo si registra come «non fermo»
const ACTION_TIMEOUT = 10000;  // macchina condivisa: margine per i picchi di carico

// Rasterizzazione ripetibile. --disable-partial-raster soprattutto: una zona
// ridipinta (un bottone dopo l'hover, un modale che si chiude) veniva
// rasterizzata di nuovo solo in parte, e angoli arrotondati e ombre sfumate
// uscivano di ±1 rispetto al primo disegno: lo stesso stato dava pixel diversi
// a seconda di cosa era successo prima.
const CHROMIUM_ARGS = [
  '--disable-partial-raster', '--font-render-hinting=none', '--disable-lcd-text', '--force-color-profile=srgb',
];

const SALON_SLUG = 'the-parlour';
const OWNER = { email: 'sole@theparlour.it', password: 'theparlour' };
// Cliente del seed con un appuntamento più tardi oggi (11:00, Taglio + Piega).
const OTP_CLIENT = { name: 'Giada Bellini', phone: '333 884 1120', e164: '+393338841120' };

/* ------------------------------------------------------- normalizzazioni */
const ORIGINS = [
  [API, '{API}'], [DASH, '{DASH}'], [CLIENT, '{CLIENT}'],
];
const PORTS = ORIGINS.map(([o, tag]) => [new URL(o).port, tag]);
function normText(s) {
  if (s == null) return s;
  let out = String(s);
  for (const [origin, tag] of ORIGINS) out = out.split(origin).join(tag);
  for (const [port, tag] of PORTS) {
    out = out.replace(new RegExp(`(127\\.0\\.0\\.1|localhost):${port}(?!\\d)`, 'g'), tag.replace('}', ':host}'));
  }
  // nomi dei chunk con l'hash di Vite: cambiano a ogni modifica del codice
  out = out.replace(/(\/assets\/[\w.-]+?)-[A-Za-z0-9_-]{8}(\.(?:js|css))/g, '$1-*$2');
  return out;
}
const SECRET_KEY_RE = /^(password|new_password|old_password|current_password|password1|password2|refresh|access|token|code|otp|ticket|jti|secret)$/i;
const JWT_RE = /^eyJ[\w-]+\.[\w-]+\.[\w-]+$/;
function canon(v, key = '') {
  if (Array.isArray(v)) return v.map((x) => canon(x));
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v).sort()) o[k] = canon(v[k], k);
    return o;
  }
  if (typeof v === 'string') {
    if (SECRET_KEY_RE.test(key) && v) return '***';
    if (JWT_RE.test(v)) return '<jwt>';
    return normText(v);
  }
  return v;
}
function canonQueryValue(k, v) {
  if (SECRET_KEY_RE.test(k)) return '***';
  if (/^[[{]/.test(v)) { try { return JSON.stringify(canon(JSON.parse(v))); } catch { /* non JSON */ } }
  return normText(v);
}
const LIVE_RE = /^\/api\/core\/activity\/(stream|stream-ticket|feed)\/?$/;
function describeApi(req) {
  const u = new URL(req.url());
  const q = [...u.searchParams.entries()]
    .map(([k, v]) => [k, canonQueryValue(k, v)])
    .sort((a, b) => (a[0] + '=' + a[1]).localeCompare(b[0] + '=' + b[1]));
  let s = `${req.method()} ${u.pathname}${q.length ? '?' + q.map(([k, v]) => `${k}=${v}`).join('&') : ''}`;
  const body = req.postData();
  if (body != null && body !== '') {
    const ct = (req.headers()['content-type'] || '').toLowerCase();
    if (ct.includes('multipart/form-data')) s += ' <form-data>';
    else {
      try { s += ' ' + JSON.stringify(canon(JSON.parse(body))); } catch { s += ' ' + normText(body).slice(0, 500); }
    }
  }
  return s;
}
const isLive = (url) => { try { const u = new URL(url); return u.origin === API && LIVE_RE.test(u.pathname); } catch { return false; } };
const firstLine = (s) => normText(String(s || '').split('\n')[0]).replace(/\s+/g, ' ').trim();

/* ---------------------------------------------- script iniettati nella pagina */
// Caso ripetibile (Math.random) e registrazione di toast e mutazioni del DOM.
// I toast spariscono a tempo (setTimeout veri): testo e screenshot non li
// vedono (visibility: hidden durante la cattura) e il loro testo si registra a
// parte, appena compaiono.
const INIT_SCRIPT = () => {
  let seed = 0x5eed1234;
  Math.random = function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  window.__smoke = { mutations: 0, toasts: [] };
  // Il pannello di destra dell'agenda parte chiuso sotto i 1600 px (dal
  // riordino del 25/09): qui lo si apre come prima, così il giro confronta le
  // stesse schermate fra una versione e l'altra e «Lista d'attesa» è quella
  // del pannello. Una versione vecchia ignora la chiave.
  try { if (localStorage.getItem('dk-agenda-rail') === null) localStorage.setItem('dk-agenda-rail', '1'); } catch { /* niente */ }
  const CSS = `
    *, *::before, *::after {
      animation-delay: 0s !important; animation-duration: 0.001s !important; animation-iteration-count: 1 !important;
      transition-delay: 0s !important; transition-duration: 0s !important;
      scroll-behavior: auto !important; caret-color: transparent !important;
    }
    html.smoke-capture .dk-toast, html.smoke-capture [data-smoke-toast] { visibility: hidden !important; }
  `;
  const isToast = (el) => el && el.nodeType === 1 && (
    (el.classList && el.classList.contains('dk-toast'))
    || (el.style && el.style.zIndex === '300' && /slideUp/.test(el.getAttribute('style') || ''))
  );
  const toastOf = (node) => {
    for (let n = node; n && n.nodeType !== 9; n = n.parentNode) {
      if (n.nodeType === 1 && (n.hasAttribute('data-smoke-toast') || isToast(n))) return n;
    }
    return null;
  };
  const noteToast = (el) => {
    el.setAttribute('data-smoke-toast', '');
    const txt = (el.textContent || '').replace(/\s+/g, ' ').trim();
    if (txt && el.__smokeLast !== txt) { el.__smokeLast = txt; window.__smoke.toasts.push(txt); }
  };
  const start = () => {
    const style = document.createElement('style');
    style.setAttribute('data-smoke', '');
    style.textContent = CSS;
    (document.head || document.documentElement).appendChild(style);
    new MutationObserver((list) => {
      let counted = false;
      for (const m of list) {
        if (m.type === 'attributes' && (String(m.attributeName).startsWith('data-smoke') || m.target === document.documentElement)) continue;
        if (m.target && m.target.nodeType === 1 && m.target.hasAttribute && m.target.hasAttribute('data-smoke')) continue;
        const toast = toastOf(m.target);
        if (toast) { noteToast(toast); continue; }
        let onlyToast = m.type === 'childList';
        for (const n of m.addedNodes || []) {
          if (n.nodeType === 1 && isToast(n)) noteToast(n);
          else onlyToast = false;
        }
        if (m.type === 'childList' && !m.addedNodes.length) {
          // rimozione: se tolgo un toast non conta come movimento della pagina
          onlyToast = [...m.removedNodes].every((n) => n.nodeType === 1 && (n.hasAttribute('data-smoke-toast') || isToast(n)));
        }
        if (!onlyToast && !counted) { window.__smoke.mutations++; counted = true; }
      }
    }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  };
  if (document.documentElement) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });
};

// Cattura: testo visibile, campi, URL (i toast sono già nascosti dalla classe).
const CAPTURE_SCRIPT = () => {
  document.documentElement.classList.add('smoke-capture');
  const fields = [];
  document.querySelectorAll('input, textarea, select').forEach((el) => {
    if (el.type === 'hidden') return;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const cs = getComputedStyle(el);
    if (cs.visibility !== 'visible' || cs.display === 'none') return;
    const val = el.type === 'checkbox' || el.type === 'radio' ? (el.checked ? '[x]' : '[ ]')
      : el.tagName === 'SELECT' ? (el.selectedOptions[0] ? el.selectedOptions[0].text : '') : el.value;
    const label = el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.name || el.id
      || (el.labels && el.labels[0] ? el.labels[0].innerText : '');
    fields.push(`${el.tagName.toLowerCase()}${el.type && el.tagName === 'INPUT' ? ':' + el.type : ''} «${String(label).replace(/\s+/g, ' ').trim()}» = ${String(val).replace(/\s+/g, ' ')}`);
  });
  const text = (document.body.innerText || '').split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
  return { text, fields, url: location.href };
};
// Solo per lo screenshot: le porte di questo giro, dove la pagina le mostra (i link
// pubblici in Impostazioni), si disegnano come quelle canoniche della baseline.
// Una maschera sopra l'elemento non bastava: dietro lo scrim sfocato dei drawer il
// testo sbava qualche pixel fuori dal riquadro, e un giro su 8400 differiva da uno
// su 8300. Il testo del report è già stato letto (con i segnaposto {API}…).
const SWAP_SCRIPT = (swaps) => {
  const res = swaps.map(([from, to]) => [new RegExp('((?:127\\.0\\.0\\.1|localhost):)' + from + '(?!\\d)', 'g'), '$1' + to]);
  const fix = (v) => res.reduce((acc, [re, to]) => acc.replace(re, to), v);
  const undo = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const v = n.nodeValue;
    const w = fix(v);
    if (w !== v) { undo.push([n, 'nodeValue', v]); n.nodeValue = w; }
  }
  document.querySelectorAll('input, textarea').forEach((el) => {
    const v = el.value;
    const w = fix(v);
    if (w !== v) { undo.push([el, 'value', v]); el.value = w; }
  });
  window.__smokeUndo = undo;
  return undo.length;
};
const UNCAPTURE_SCRIPT = () => {
  for (const [node, prop, v] of (window.__smokeUndo || []).reverse()) node[prop] = v;
  window.__smokeUndo = [];
  document.documentElement.classList.remove('smoke-capture');
};

/* ---------------------------------------------------------- registrazione */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const liveSeen = new Set();
const steps = [];
const report = {
  meta: {
    tool: 'youty smoke v1', date: args.date || null, now: NOW.toISOString(), repo: args.repo || null,
    viewport: { dashboard: '1440x900', client: '390x844 mobile' },
    startedAt: new Date().toISOString(),
  },
  liveEndpoints: [],
  steps,
};

function newRec() { return { api: [], console: [], pageErrors: [], failed: [], httpErrors: [] }; }

function attach(app) {
  const { page } = app;
  app.inflight = new Set();
  app.lastNet = Date.now();
  app.rec = newRec();
  page.on('request', (req) => {
    const url = req.url();
    if (url.startsWith('data:') || url.startsWith('blob:')) return;
    if (isLive(url)) { liveSeen.add(`${req.method()} ${new URL(url).pathname}`); return; }
    app.inflight.add(req);
    app.lastNet = Date.now();
    if (url.startsWith(API + '/')) app.rec.api.push(describeApi(req));
  });
  const done = (req) => { if (app.inflight.delete(req)) app.lastNet = Date.now(); };
  page.on('requestfinished', done);
  page.on('requestfailed', (req) => {
    done(req);
    if (isLive(req.url())) return;
    const f = req.failure();
    app.rec.failed.push(`${req.method()} ${normText(req.url())} ${f ? f.errorText : ''}`.trim());
  });
  page.on('response', (res) => {
    if (res.status() < 400 || isLive(res.url())) return;
    app.rec.httpErrors.push(`${res.status()} ${res.request().method()} ${normText(res.url())}`);
  });
  page.on('console', (msg) => {
    const type = msg.type();
    if (type !== 'error' && type !== 'warning') return;
    const loc = msg.location();
    // Il feed live che si riconnette (ricarica della pagina) non è un errore dell'app.
    if (loc && loc.url && isLive(loc.url)) return;
    app.rec.console.push(`${type}: ${normText(msg.text()).slice(0, 600)}${loc && loc.url ? ' @ ' + normText(loc.url.split('?')[0]) : ''}`);
  });
  page.on('pageerror', (err) => { app.rec.pageErrors.push(firstLine(err.message || String(err))); });
}

async function mutationCount(page) {
  try { return await page.evaluate(() => (window.__smoke ? window.__smoke.mutations : -1)); } catch { return null; }
}

/** Aspetta che la pagina sia ferma: rete (salvo feed live) e DOM. */
async function settle(app) {
  const { page } = app;
  const t0 = Date.now();
  app.lastNet = Math.max(app.lastNet, t0);
  let lastMut = await mutationCount(page);
  let lastMutAt = Date.now();
  let quiet = true;
  for (;;) {
    await sleep(60);
    const now = Date.now();
    const m = await mutationCount(page);
    if (m !== lastMut) { lastMut = m; lastMutAt = now; }
    if (app.inflight.size === 0 && now - app.lastNet >= QUIET_MS && now - lastMutAt >= DOM_QUIET_MS && m !== null) break;
    if (now - t0 > SETTLE_MAX_MS) { quiet = false; break; }
  }
  try {
    await page.evaluate(async () => {
      await document.fonts.ready;
      await Promise.all([...document.images].filter((i) => !i.complete).map((i) => new Promise((r) => { i.onload = i.onerror = r; })));
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    });
  } catch { /* pagina in navigazione: la cattura ci riprova */ }
  return quiet;
}

const slug = (name) => name.replace(/[^\w.-]+/g, '_');
// porte canoniche (port-base 8300, quello della baseline) per SWAP_SCRIPT
const CANON_PORT = { '{API}': '8300', '{DASH}': '8301', '{CLIENT}': '8302' };
const SWAPS = ORIGINS.map(([o, tag]) => [new URL(o).port, CANON_PORT[tag]]).filter(([from, to]) => from !== to);

async function capture(app, name) {
  const { page } = app;
  let data = null;
  for (let i = 0; i < 3 && !data; i++) {
    try { data = await page.evaluate(CAPTURE_SCRIPT); } catch { await sleep(500); }
  }
  const file = `screenshots/${slug(name)}.png`;
  let shotError = null;
  try {
    if (SWAPS.length) await page.evaluate(SWAP_SCRIPT, SWAPS);
    await page.screenshot({ path: path.join(OUT, file), fullPage: true, animations: 'disabled', caret: 'hide', timeout: 20000 });
  } catch (e) { shotError = firstLine(e.message); }
  try { await page.evaluate(UNCAPTURE_SCRIPT); } catch { /* ignore */ }
  let toasts = [];
  try { toasts = await page.evaluate(() => (window.__smoke ? window.__smoke.toasts.splice(0) : [])); } catch { /* ignore */ }
  return {
    url: data ? normText(data.url) : null,
    text: data ? normText(data.text) : '',
    fields: data ? data.fields.map(normText) : [],
    toasts: toasts.map(normText),
    screenshot: shotError ? null : file,
    screenshotError: shotError,
  };
}

/* ---------------------------------------------------------------- catene */
const PLAN = [];
function chain(appName, name, reset, list, opts = {}) {
  PLAN.push({ appName, name, reset, always: !!opts.always, steps: list.map(([n, run]) => ({ name: n, run })) });
}

async function runPlan(apps) {
  for (const ch of PLAN) {
    if (ONLY && !ch.always && !ch.steps.some((s) => ONLY.test(s.name))) continue;
    const app = apps[ch.appName];
    if (!app) continue;   // le due app girano in contesti separati, una dopo l'altra
    const done = [];
    let needReset = true;
    let broken = null;   // la ripartenza stessa è fallita: il resto della catena non ha senso
    for (const st of ch.steps) {
      const t0 = Date.now();
      app.rec = newRec();
      let ok = true;
      let error = null;
      try {
        if (broken) throw new Error('catena interrotta: ' + broken);
        if (needReset) {
          try { await ch.reset(app); } catch (e) { broken = firstLine(e && e.message ? e.message : e); throw e; }
          for (const prev of done) await prev.run(app);
          needReset = false;
        }
        await st.run(app);
      } catch (e) {
        ok = false;
        error = firstLine(e && e.message ? e.message : e);
      }
      try { await app.page.mouse.move(1, 1); } catch { /* ignore */ }
      const quiet = await settle(app);
      const snap = await capture(app, st.name);
      const rec = app.rec;
      steps.push({
        name: st.name, app: ch.appName, chain: ch.name, ok, error, quiet,
        url: snap.url,
        console: rec.console.slice().sort(), pageErrors: rec.pageErrors.slice().sort(),
        failedRequests: rec.failed.slice().sort(), httpErrors: rec.httpErrors.slice().sort(),
        api: rec.api.slice().sort(),
        toasts: snap.toasts, text: snap.text, fields: snap.fields,
        screenshot: snap.screenshot, screenshotError: snap.screenshotError,
        ms: Date.now() - t0,
      });
      const flag = ok ? (quiet ? 'ok ' : 'ok~') : 'ERR';
      console.log(`[run] ${flag} ${String(steps.length).padStart(2)} ${st.name} (${Date.now() - t0} ms)${error ? ' — ' + error : ''}${quiet ? '' : ' [non fermo]'}`);
      if (ok) done.push(st);
      else needReset = true;
      app.rec = newRec();
    }
  }
}

/* ------------------------------------------------------- aiuti di navigazione */
const dlg = (page) => page.getByRole('dialog').last();

/** Chiude le finestre aperte (Esc, una alla volta: vedi ui/layers.js). */
async function closeDialogs(page) {
  for (let i = 0; i < 5; i++) {
    if (!(await page.getByRole('dialog').count())) return;
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
  }
  if (await page.getByRole('dialog').count()) throw new Error('una finestra non si chiude con Esc');
}

async function quietNow(app) { await settle(app); }

/* dashboard */
async function dashReset(app) {
  await app.page.goto(DASH + '/', { waitUntil: 'domcontentloaded' });
  await app.page.locator('.dk-side .dk-navitem').first().waitFor();
  await quietNow(app);
}
async function section(page, label) {
  await page.locator('.dk-side .dk-nav').getByRole('button', { name: label, exact: true }).first().click();
}
async function subTab(page, label) {
  await page.locator('.dk-side .dk-subtabs').getByRole('button', { name: label, exact: true }).click();
}
const content = (page) => page.locator('.dk-content');
async function settingsRow(page, label) {
  await content(page).locator('.dk-row').filter({ hasText: label }).first().click();
}

/* app cliente */
async function clientReset(app) {
  await app.page.goto(CLIENT + '/' + SALON_SLUG, { waitUntil: 'domcontentloaded' });
  await app.page.locator('.app-frame').first().waitFor();
  await quietNow(app);
}
async function navTo(page, label) {
  // barra in basso: bottoni con icona + etichetta
  await page.getByRole('button', { name: label, exact: true }).last().click();
}

function readOtp(sinceBytes) {
  const buf = fs.readFileSync(SERVER_LOG);
  const txt = buf.subarray(Math.min(sinceBytes, buf.length)).toString('utf8');
  // il log riporta il telefono com'è in anagrafica («+39 333 884 1120»): si confrontano le cifre
  const digits = (x) => x.replace(/\D/g, '');
  const all = [...txt.matchAll(/OTP per ([^:\n]+): (\d{6})/g)].filter((m) => digits(m[1]) === digits(OTP_CLIENT.e164));
  return all.length ? all[all.length - 1][2] : null;
}
const logSize = () => { try { return fs.statSync(SERVER_LOG).size; } catch { return 0; } };

/* La vista dell'agenda: i bottoni Giorno/Settimana/Mese, o il menu «Vista»
 * che li sostituisce quando la barra è stretta (pannello di destra aperto). */
async function pickView(page, label, value) {
  const btn = content(page).getByRole('button', { name: label, exact: true });
  if (await btn.isVisible()) await btn.click();
  else await content(page).getByRole('combobox', { name: 'Vista' }).selectOption(value);
}

/* =========================================================== PASSI · dashboard */
chain('dash', 'accesso', async (app) => {
  await app.page.goto(DASH + '/', { waitUntil: 'domcontentloaded' });
  await app.page.locator('#login-email').waitFor();
  await quietNow(app);
}, [
  ['dash.login', async () => {}],
  ['dash.agenda.giorno', async ({ page }) => {
    await page.fill('#login-email', OWNER.email);
    await page.fill('#login-password', OWNER.password);
    await page.locator('form').getByRole('button', { name: 'Entra' }).click();
    await page.locator('.dk-side .dk-navitem').first().waitFor();
  }],
], { always: true });

chain('dash', 'agenda', dashReset, [
  ['dash.agenda.dettaglio', async ({ page }) => {
    await content(page).getByText('Federica Mancini').first().click();
    await dlg(page).getByText('Check-in').first().waitFor();
  }],
  // «Riprogramma» cerca un orario libero (disponibilità con exclude_appointment_id)
  ['dash.agenda.dettaglio.riprogramma', async ({ page }) => {
    await dlg(page).getByRole('button', { name: 'Riprogramma', exact: true }).click();
  }],
  // «Incassa» apre la cassa dell'appuntamento: ci si ferma prima di incassare
  ['dash.agenda.dettaglio.incassa', async ({ page }) => {
    await closeDialogs(page);
    await content(page).getByText('Federica Mancini').first().click();
    await dlg(page).getByRole('button', { name: 'Incassa', exact: true }).click();
    await dlg(page).getByText(/Totale/).first().waitFor();
  }],
  ['dash.agenda.nuova', async ({ page }) => {
    await closeDialogs(page);
    await page.getByRole('button', { name: 'Prenota', exact: true }).first().click();
    await dlg(page).getByPlaceholder('Cerca per nome o telefono…').waitFor();
  }],
  ['dash.agenda.nuova.cliente-servizio', async ({ page }) => {
    const d = dlg(page);
    await d.getByPlaceholder('Cerca per nome o telefono…').fill('Giada');
    await d.getByRole('option', { name: /Giada Bellini/ }).first().click();
    await d.getByRole('button', { name: 'Taglio', exact: true }).click();
  }],
  ['dash.agenda.lista-attesa', async ({ page }) => {
    await closeDialogs(page);
    await page.getByRole('button', { name: /Nessuna richiesta · apri|Lista d.attesa/ }).first().click();
    await dlg(page).waitFor();
  }],
  // Dal 25/09 la prenotazione di gruppo sta nel menu di «Prenota» (la freccia
  // «Altre creazioni»); prima era il bottone «Gruppo» dell'agenda. Il passo
  // prende quello che c'è, per confrontare anche le versioni di prima.
  ['dash.agenda.gruppo', async ({ page }) => {
    await closeDialogs(page);
    const old = page.getByRole('button', { name: 'Gruppo', exact: true });
    if (await old.count()) await old.click();
    else {
      await page.getByRole('button', { name: 'Altre creazioni' }).click();
      await page.getByRole('button', { name: /Prenotazione di gruppo/ }).click();
    }
    await dlg(page).getByText('Prenotazione di gruppo').waitFor();
  }],
  ['dash.agenda.settimana', async ({ page }) => {
    await closeDialogs(page);
    await pickView(page, 'Settimana', 'week');
  }],
  ['dash.agenda.mese', async ({ page }) => {
    await pickView(page, 'Mese', 'month');
  }],
  ['dash.agenda.giorno-dopo', async ({ page }) => {
    await pickView(page, 'Giorno', 'day');
    await content(page).getByRole('button', { name: /^Ven\s*25$/ }).click();
  }],
  ['dash.notifiche', async ({ page }) => {
    await page.getByRole('button', { name: 'Notifiche' }).click();
    await page.getByText('Attività del team').waitFor();
    // lo stato della connessione live: si aspetta quello a regime
    await page.getByText('Live', { exact: true }).waitFor({ timeout: 10000 });
  }],
  ['dash.nuovo-cliente', async ({ page }) => {
    await page.getByRole('button', { name: 'Notifiche' }).click();
    await page.getByText('Attività del team').waitFor({ state: 'detached' });
    await page.getByRole('button', { name: 'Altre creazioni' }).click();
    await page.getByRole('button', { name: /Nuovo cliente/ }).click();
    await dlg(page).waitFor();
  }],
]);

chain('dash', 'ricerca', dashReset, [
  ['dash.ricerca', async ({ page }) => { await page.getByPlaceholder('Cerca clienti…').first().fill('Ricci'); }],
]);

chain('dash', 'cassa', dashReset, [
  ['dash.pos.prodotti', async ({ page }) => { await section(page, 'Punto Vendita'); }],
  ['dash.pos.carrello', async ({ page }) => {
    await content(page).locator('button.dk-card').filter({ hasText: 'Shampoo ristrutturante 250ml' }).click();
  }],
  ['dash.pos.storico', async ({ page }) => { await subTab(page, 'Storico'); }],
]);

chain('dash', 'clienti', dashReset, [
  ['dash.clienti.lista', async ({ page }) => { await section(page, 'Clienti'); }],
  ['dash.clienti.scheda', async ({ page }) => {
    await content(page).getByRole('button', { name: /Aisha Diallo/ }).first().click();
    await content(page).getByRole('button', { name: 'Consensi', exact: true }).waitFor();
  }],
  ['dash.clienti.scheda.scheda-tecnica', async ({ page }) => { await content(page).getByRole('button', { name: 'Scheda tecnica', exact: true }).click(); }],
  ['dash.clienti.scheda.note', async ({ page }) => { await content(page).getByRole('button', { name: 'Note', exact: true }).click(); }],
  ['dash.clienti.scheda.wallet', async ({ page }) => { await content(page).getByRole('button', { name: 'Wallet', exact: true }).click(); }],
  ['dash.clienti.scheda.consensi', async ({ page }) => { await content(page).getByRole('button', { name: 'Consensi', exact: true }).click(); }],
  ['dash.clienti.nuovo', async ({ page }) => {
    await content(page).getByRole('button', { name: 'Nuovo', exact: true }).click();
    await dlg(page).waitFor();
  }],
  ['dash.clienti.importa', async ({ page }) => {
    await closeDialogs(page);
    await content(page).getByRole('button', { name: 'Importa', exact: true }).click();
    await dlg(page).waitFor();
  }],
]);

chain('dash', 'analisi', dashReset, [
  ['dash.insight.mese', async ({ page }) => { await section(page, 'Analisi dati'); }],
  ['dash.insight.trimestre', async ({ page }) => { await content(page).getByRole('button', { name: 'Trimestre', exact: true }).click(); }],
  ['dash.insight.anno', async ({ page }) => { await content(page).getByRole('button', { name: 'Anno', exact: true }).click(); }],
  ['dash.insight.chiedi', async ({ page }) => {
    await page.getByRole('button', { name: 'Chiedi a Youty' }).last().click();
    await dlg(page).waitFor();
  }],
]);

chain('dash', 'automazioni', dashReset, [
  ['dash.automazioni', async ({ page }) => { await section(page, 'Automazioni'); }],
  ['dash.automazioni.nuova', async ({ page }) => { await content(page).getByRole('button', { name: 'Nuova', exact: true }).click(); }],
]);

chain('dash', 'servizi', dashReset, [
  ['dash.servizi.lista', async ({ page }) => { await section(page, 'Servizi'); }],
  ['dash.servizi.modifica', async ({ page }) => {
    await content(page).getByRole('button', { name: 'Modifica' }).first().click();
    await dlg(page).waitFor();
  }],
  ['dash.servizi.categorie', async ({ page }) => {
    await closeDialogs(page);
    await content(page).getByRole('button', { name: 'Categorie', exact: true }).click();
    await dlg(page).waitFor();
  }],
  ['dash.servizi.pacchetti', async ({ page }) => {
    await closeDialogs(page);
    await subTab(page, 'Pacchetti');
  }],
  ['dash.servizi.pacchetti.nuovo', async ({ page }) => {
    await content(page).getByRole('button', { name: /Nuovo pacchetto/ }).first().click();
    await dlg(page).waitFor();
  }],
]);

chain('dash', 'magazzino', dashReset, [
  ['dash.magazzino.prodotti', async ({ page }) => { await section(page, 'Magazzino'); }],
  ['dash.magazzino.prodotto', async ({ page }) => {
    await content(page).getByText('Base coat OPI', { exact: true }).first().click();
    await dlg(page).waitFor();
  }],
  ['dash.magazzino.carico', async ({ page }) => {
    await closeDialogs(page);
    await content(page).getByRole('button', { name: 'Carico merce', exact: true }).click();
    await dlg(page).waitFor();
  }],
  ['dash.magazzino.scarico', async ({ page }) => {
    await closeDialogs(page);
    await content(page).getByRole('button', { name: 'Scarico manuale', exact: true }).click();
    await dlg(page).waitFor();
  }],
  ['dash.magazzino.ordini', async ({ page }) => { await closeDialogs(page); await subTab(page, 'Ordini'); }],
  ['dash.magazzino.fornitori', async ({ page }) => { await subTab(page, 'Fornitori'); }],
  ['dash.magazzino.storico', async ({ page }) => { await subTab(page, 'Storico'); }],
]);

chain('dash', 'promozioni', dashReset, [
  ['dash.promozioni.coupon', async ({ page }) => { await section(page, 'Promozioni'); }],
  ['dash.promozioni.coupon.nuovo', async ({ page }) => {
    await content(page).getByRole('button', { name: 'Nuovo coupon', exact: true }).first().click();
    await dlg(page).waitFor();
  }],
  ['dash.promozioni.fedelta', async ({ page }) => { await closeDialogs(page); await subTab(page, 'Fedeltà'); }],
  ['dash.promozioni.fedelta.modifica', async ({ page }) => {
    await content(page).getByText('The Parlour Club').first().click();
    await dlg(page).waitFor();
  }],
  ['dash.promozioni.fedelta.iscritte', async ({ page }) => {
    await closeDialogs(page);
    await content(page).getByRole('button', { name: /clienti iscritte|cliente iscritta/ }).first().click();
    await dlg(page).waitFor();
  }],
  ['dash.promozioni.gift', async ({ page }) => { await closeDialogs(page); await subTab(page, 'Gift card'); }],
  ['dash.promozioni.gift.nuova', async ({ page }) => {
    await content(page).getByRole('button', { name: 'Nuova gift card', exact: true }).first().click();
    await dlg(page).waitFor();
  }],
]);

chain('dash', 'comunicazioni', dashReset, [
  ['dash.comunicazioni', async ({ page }) => { await section(page, 'Comunicazioni'); }],
  ['dash.comunicazioni.nuova', async ({ page }) => {
    await content(page).getByRole('button', { name: 'Nuova comunicazione', exact: true }).first().click();
    await dlg(page).waitFor();
  }],
]);

chain('dash', 'staff', dashReset, [
  ['dash.staff', async ({ page }) => { await section(page, 'Staff'); }],
  ['dash.staff.nuova', async ({ page }) => {
    await content(page).getByRole('button', { name: 'Nuova operatrice', exact: true }).click();
    await dlg(page).waitFor();
  }],
  ['dash.staff.operatrice', async ({ page }) => {
    await closeDialogs(page);
    await content(page).getByText('Sole Caputo', { exact: true }).first().click();
    await content(page).getByRole('button', { name: 'Turni e ferie', exact: true }).waitFor();
  }],
  ['dash.staff.operatrice.turni', async ({ page }) => { await content(page).getByRole('button', { name: 'Turni e ferie', exact: true }).click(); }],
  ['dash.staff.operatrice.performance', async ({ page }) => { await content(page).getByRole('button', { name: 'Performance', exact: true }).click(); }],
  ['dash.staff.operatrice.clienti', async ({ page }) => { await content(page).getByRole('button', { name: 'Clienti serviti', exact: true }).click(); }],
]);

chain('dash', 'impostazioni', dashReset, [
  ['dash.impostazioni', async ({ page }) => { await section(page, 'Impostazioni'); }],
  // il toast «Copiato negli appunti» finisce in `toasts`, non nello screenshot
  ['dash.impostazioni.copia-link', async ({ page }) => {
    await content(page).getByRole('button', { name: 'Copia', exact: true }).first().click();
  }],
  ['dash.impostazioni.brand', async ({ page }) => {
    await content(page).getByRole('button', { name: 'Personalizza', exact: true }).click();
    await dlg(page).waitFor();
  }],
  ['dash.impostazioni.orari', async ({ page }) => { await closeDialogs(page); await settingsRow(page, 'Orari di apertura'); await dlg(page).waitFor(); }],
  ['dash.impostazioni.pagamenti', async ({ page }) => { await closeDialogs(page); await settingsRow(page, 'Stripe del salone'); await dlg(page).waitFor(); }],
  ['dash.impostazioni.categorie', async ({ page }) => { await closeDialogs(page); await settingsRow(page, 'Categorie'); await dlg(page).waitFor(); }],
  ['dash.impostazioni.motivazioni', async ({ page }) => { await closeDialogs(page); await settingsRow(page, 'Motivazioni di annullamento'); await dlg(page).waitFor(); }],
  ['dash.impostazioni.team', async ({ page }) => { await closeDialogs(page); await settingsRow(page, 'Membri del team'); await dlg(page).waitFor(); }],
  ['dash.impostazioni.ruoli', async ({ page }) => { await closeDialogs(page); await settingsRow(page, 'Ruoli e permessi'); await dlg(page).waitFor(); }],
  ['dash.impostazioni.password', async ({ page }) => { await closeDialogs(page); await settingsRow(page, 'Cambia password'); await dlg(page).waitFor(); }],
]);
chain('dash', 'impostazioni-prenotazioni', dashReset, [
  ['dash.impostazioni.prenotazioni', async ({ page }) => {
    await section(page, 'Impostazioni');
    await content(page).getByRole('button', { name: /Prenotazioni & ottimizzazione/ }).click();
  }],
]);
chain('dash', 'impostazioni-sedi', dashReset, [
  ['dash.impostazioni.sedi', async ({ page }) => { await section(page, 'Impostazioni'); await settingsRow(page, 'Sedi'); }],
]);
chain('dash', 'impostazioni-registro', dashReset, [
  ['dash.impostazioni.registro', async ({ page }) => { await section(page, 'Impostazioni'); await settingsRow(page, 'Registro attività'); }],
]);
chain('dash', 'profilo', dashReset, [
  ['dash.profilo', async ({ page }) => { await page.getByRole('button', { name: 'SC' }).first().click(); }],
]);
chain('dash', 'lingua', dashReset, [
  ['dash.lingua.en', async ({ page }) => {
    await section(page, 'Impostazioni');
    await content(page).locator('.dk-row').filter({ hasText: /^English$/ }).click();
    await section(page, 'Agenda');
  }],
  ['dash.lingua.it', async ({ page }) => {
    await section(page, 'Settings');
    await content(page).locator('.dk-row').filter({ hasText: /^Italiano$/ }).click();
  }],
]);

/* ========================================================= PASSI · app cliente */
chain('client', 'anonima', clientReset, [
  ['client.home', async () => {}],
  ['client.hook', async (app) => {
    await app.page.goto(CLIENT + '/' + SALON_SLUG + '/hook', { waitUntil: 'domcontentloaded' });
    await app.page.getByRole('button', { name: 'Invia', exact: true }).waitFor();
  }],
  ['client.prenota.scelta', async (app) => {
    await app.page.goto(CLIENT + '/' + SALON_SLUG, { waitUntil: 'domcontentloaded' });
    await app.page.getByRole('button', { name: 'Prenota ora', exact: true }).click();
  }],
  ['client.pacchetti', async ({ page }) => { await page.getByRole('button', { name: /Pacchetti & offerte/ }).click(); }],
  ['client.prenota.servizi', async ({ page }) => {
    await page.getByRole('button', { name: /Prenota un servizio singolo/ }).click();
    await page.getByRole('button', { name: /Prenota nell.app/ }).click();
  }],
  ['client.prenota.servizio-scelto', async ({ page }) => { await page.getByRole('button', { name: /^Piega/ }).first().click(); }],
  ['client.prenota.giorno', async ({ page }) => { await page.getByRole('button', { name: 'Continua', exact: true }).click(); }],
  ['client.prenota.orario', async ({ page }) => {
    await page.locator('.scroll button.press').filter({ hasText: /^\D+\s*\d+$/ }).nth(2).click();
    await page.getByRole('button', { name: /^\d{2}:\d{2}$/ }).first().click();
  }],
  ['client.prenota.riepilogo-anonimo', async ({ page }) => {
    await page.getByRole('button', { name: 'Continua', exact: true }).click();
    await page.getByText('Passo 3 di 3', { exact: false }).waitFor();
  }],
  // Senza sessione «Conferma prenotazione» porta ai dati della cliente (passo 3),
  // non prenota: ci si ferma lì, prima di chiedere il codice.
  ['client.prenota.dati', async ({ page }) => {
    await page.getByRole('button', { name: 'Conferma prenotazione' }).last().click();
    await page.getByPlaceholder('Cognome').waitFor();
  }],
]);

chain('client', 'accesso', clientReset, [
  ['client.login.telefono', async ({ page }) => {
    await page.getByRole('button', { name: 'Accedi', exact: true }).click();
    await page.getByRole('textbox', { name: 'Numero di telefono' }).fill(OTP_CLIENT.phone);
  }],
  ['client.login.codice', async (app) => {
    app.logMark = logSize();
    await app.page.getByRole('button', { name: 'Ricevi il codice', exact: true }).click();
    await app.page.getByPlaceholder('······').waitFor();
  }],
  ['client.login.home', async (app) => {
    let code = null;
    for (let i = 0; i < 50 && !code; i++) { code = readOtp(app.logMark || 0); if (!code) await sleep(100); }
    if (!code) throw new Error('codice OTP non trovato nel log del server');
    await app.page.getByPlaceholder('······').fill(code);
    await app.page.getByRole('button', { name: 'Entra', exact: true }).click();
    await app.page.getByText('Il tuo prossimo appuntamento').waitFor();
  }],
], { always: true });

// L'app cliente naviga a stato, senza URL, e i sottotitoli hanno un «indietro»
// senza nome accessibile: invece di tornare indietro, ogni ramo riparte dalla
// home ricaricata (la sessione resta nel localStorage).
chain('client', 'prenotazioni', clientReset, [
  ['client.prenotazioni', async ({ page }) => { await navTo(page, 'Prenotazioni'); }],
  ['client.sposta', async ({ page }) => {
    await page.getByRole('button', { name: 'Sposta', exact: true }).first().click();
    await page.getByText('Scegli un nuovo orario', { exact: false }).waitFor();
  }],
  // si sceglie un orario e ci si ferma su «Conferma nuovo orario»
  ['client.sposta.orario', async ({ page }) => {
    await page.locator('.scroll button.press').filter({ hasText: /^\D+\s*\d+$/ }).nth(2).click();
    await page.getByRole('button', { name: /^\d{2}:\d{2}$/ }).first().click();
  }],
]);
chain('client', 'home-azioni', clientReset, [
  // scarica l'.ics e mostra il toast «Evento aggiunto al calendario»
  ['client.home.calendario', async ({ page }) => {
    await page.getByRole('button', { name: /Aggiungi al calendario/ }).first().click();
  }],
]);
chain('client', 'annulla', clientReset, [
  // dalla scheda del prossimo appuntamento in home; ci si ferma su «Sì, annulla»
  ['client.annulla', async ({ page }) => {
    await page.getByRole('button', { name: 'Annulla appuntamento', exact: true }).click();
    await page.getByRole('button', { name: 'Sì, annulla', exact: true }).waitFor();
  }],
]);
chain('client', 'portafoglio', clientReset, [
  ['client.wallet', async ({ page }) => { await navTo(page, 'Portafoglio'); }],
  ['client.giftcard', async ({ page }) => { await page.getByRole('button', { name: /Acquista o regala una gift card/ }).first().click(); }],
  ['client.giftcard.nuova', async ({ page }) => { await page.getByRole('button', { name: /Regala una gift card/ }).first().click(); }],
]);
chain('client', 'profilo', clientReset, [
  ['client.profilo', async ({ page }) => { await navTo(page, 'Profilo'); }],
  ['client.waitlist', async ({ page }) => { await page.getByRole('button', { name: /Lista d.attesa/ }).first().click(); }],
  ['client.waitlist.nuova', async ({ page }) => { await page.getByRole('button', { name: /Aggiungiti alla lista/ }).first().click(); }],
]);

chain('client', 'prenota-loggata', clientReset, [
  ['client.prenota.riepilogo', async ({ page }) => {
    await page.getByRole('button', { name: /Prenota un appuntamento|Prenota ora/ }).first().click();
    await page.getByRole('button', { name: /Prenota nell.app/ }).click();
    await page.getByRole('button', { name: /^Manicure express/ }).first().click();
    await page.getByRole('button', { name: 'Continua', exact: true }).click();
    await page.locator('.scroll button.press').filter({ hasText: /^\D+\s*\d+$/ }).nth(2).click();
    await page.getByRole('button', { name: /^\d{2}:\d{2}$/ }).first().click();
    await page.getByRole('button', { name: 'Continua', exact: true }).click();
    await page.getByRole('button', { name: 'Conferma prenotazione' }).waitFor();
  }],
]);

chain('client', 'lingua', clientReset, [
  ['client.lingua.en', async ({ page }) => { await page.getByRole('button', { name: 'IT', exact: true }).click(); }],
  ['client.lingua.it', async ({ page }) => { await page.getByRole('button', { name: 'EN', exact: true }).click(); }],
]);
// ultimo: l'uscita chiude la sessione della cliente
chain('client', 'uscita', clientReset, [
  ['client.esci', async ({ page }) => { await page.getByRole('button', { name: 'Esci' }).first().click(); }],
]);

/* ----------------------------------------------------------------- avvio */
async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  const t0 = Date.now();
  const extra = (process.env.SMOKE_CHROMIUM_ARGS || '').split(/\s+/).filter(Boolean);
  const browser = await chromium.launch({ headless: !HEADFUL, args: [...CHROMIUM_ARGS, ...extra] });
  const base = { locale: 'it-IT', timezoneId: 'Europe/Rome', colorScheme: 'light', reducedMotion: 'no-preference' };
  const mk = async (opts) => {
    const context = await browser.newContext({ ...base, ...opts });
    await context.clock.setFixedTime(NOW);
    await context.addInitScript(INIT_SCRIPT);
    const page = await context.newPage();
    page.setDefaultTimeout(ACTION_TIMEOUT);
    const app = { context, page };
    attach(app);
    return app;
  };
  const apps = {};
  try {
    // gli appunti servono ai pulsanti «Copia» (senza permesso writeText rifiuta)
    apps.dash = await mk({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, permissions: ['clipboard-read', 'clipboard-write'] });
    await runPlan({ dash: apps.dash });
    await apps.dash.context.close();
    const phone = devices['iPhone 13'];
    apps.client = await mk({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true, userAgent: phone.userAgent });
    await runPlan({ client: apps.client });
    await apps.client.context.close();
  } finally {
    await browser.close().catch(() => {});
  }
  report.liveEndpoints = [...liveSeen].sort();
  report.meta.durationMs = Date.now() - t0;
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  const bad = steps.filter((s) => !s.ok).length;
  console.log(`[run] ${steps.length} passi, ${bad} falliti, ${steps.filter((s) => !s.quiet).length} non fermi · ${Math.round((Date.now() - t0) / 1000)} s`);
}

main().catch((e) => { console.error('[run] harness interrotto:', e && e.stack ? e.stack : e); process.exit(1); });
