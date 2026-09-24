// Drawer «Nuova prenotazione»: il «Regalo» con la regola del server e l'orario
// scelto che non torna da solo a quello cliccato in agenda.
// Caccia ai bug del 22/09/2026: 13-09 (= 17-09, 07-07), 13-11, 13-18.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fmtDur, isoAtMin, minutesOfDay, parseISO, setSalonTz, timeLabel, toDateStr, todayStr } from '@youty/shared';
import { explainSlot } from '../src/sections/agenda/lib.js';
import { nextSelection, relativeDateLabel, requestStatus, usableGiftCards } from '../src/sections/agenda/modals/rules.js';

setSalonTz('Europe/Rome');
const NOW = Date.parse('2026-09-23T10:00:00Z');
const MARIA = 7;
const card = (extra = {}) => ({
  id: 1, code: 'GIFT-AAAA-1111', gift_service_id: 3, payment_status: 'paid', status: 'active',
  balance: '45.00', expires_at: '2026-12-31T23:00:00Z',
  buyer_client_id: MARIA, recipient_client_id: null, recipient_name: '',
  ...extra,
});

test('«Regalo» solo con le carte che la cassa accetterà (regola di gift_index)', () => {
  const ok = [
    card({ id: 1 }),                                                    // comprata da Maria per sé
    card({ id: 2, buyer_client_id: 9, recipient_client_id: MARIA }),    // regalata a Maria
    card({ id: 3, expires_at: null }),                                   // senza scadenza
  ];
  const ko = [
    card({ id: 10, recipient_name: 'Giulia' }),                          // comprata da Maria per «Giulia»
    card({ id: 11, recipient_client_id: 12 }),                           // per un'altra cliente
    card({ id: 12, expires_at: '2026-09-20T10:00:00Z' }),                // scaduta
    card({ id: 13, balance: '0.00' }),                                   // già usata
    card({ id: 14, payment_status: 'pending' }),                         // non pagata
    card({ id: 15, status: 'redeemed' }),
    card({ id: 16, gift_service_id: null }),                             // carta a valore
  ];
  const got = usableGiftCards([...ok, ...ko], MARIA, NOW).map((g) => g.id);
  assert.deepEqual(got, [1, 2, 3]);
  assert.deepEqual(usableGiftCards(ok, null, NOW), []);
});

const DAY = '2026-09-24';
const at = (hh, mm = 0) => isoAtMin(DAY, hh * 60 + mm);
const free = (...isos) => isos.map((start) => ({ start, assignment: [] }));

test('l’orario cliccato in agenda: libero si prende, occupato si prende forzato', () => {
  assert.deepEqual(nextSelection({ prev: null, src: null, slots: free(at(10)), reqStartMin: 600, date: DAY }),
    { start: at(10), src: 'req', force: false, dropped: null });
  assert.deepEqual(nextSelection({ prev: null, src: null, slots: free(at(11)), reqStartMin: 600, date: DAY }),
    { start: at(10), src: 'req', force: true, dropped: null });
});

test('un’alternativa scelta resta anche cambiando i servizi, finché è libera', () => {
  const r = nextSelection({ prev: at(10, 30), src: 'slot', slots: free(at(10, 30), at(11)), reqStartMin: 600, date: DAY });
  assert.deepEqual(r, { start: at(10, 30), src: 'slot', force: false, dropped: null });
});

test('un orario libero preso nel frattempo si toglie, senza tornare a quello cliccato forzato', () => {
  const r = nextSelection({ prev: at(10, 30), src: 'slot', slots: free(at(11)), reqStartMin: 600, date: DAY });
  assert.deepEqual(r, { start: null, src: 'dropped', force: false, dropped: at(10, 30) });
  // e al ricarico dopo resta vuoto finché chi prenota non sceglie
  assert.deepEqual(nextSelection({ prev: null, src: 'dropped', slots: free(at(11)), reqStartMin: 600, date: DAY, refreshed: true }),
    { start: null, src: 'dropped', force: false, dropped: null });
});

test('l’orario cliccato era libero e un’altra postazione lo prende: non si forza sopra', () => {
  const r = nextSelection({ prev: at(10), src: 'req', prevForced: false, slots: free(at(11)), reqStartMin: 600, date: DAY, refreshed: true });
  assert.deepEqual(r, { start: null, src: 'dropped', force: false, dropped: at(10) });
});

test('l’orario cliccato sopra un altro impegno resta forzato anche ai ricarichi', () => {
  const r = nextSelection({ prev: at(10), src: 'req', prevForced: true, slots: free(at(11)), reqStartMin: 600, date: DAY, refreshed: true });
  assert.deepEqual(r, { start: at(10), src: 'req', force: true, dropped: null });
});

test('cambiando i servizi l’orario cliccato si tiene (forzato se non ci sta più)', () => {
  const r = nextSelection({ prev: at(10), src: 'req', prevForced: false, slots: free(at(11)), reqStartMin: 600, date: DAY, refreshed: false });
  assert.deepEqual(r, { start: at(10), src: 'req', force: true, dropped: null });
});

test('l’orario scritto a mano resta, forzato solo se non è fra i liberi', () => {
  assert.deepEqual(nextSelection({ prev: at(10, 10), src: 'manual', slots: free(at(10)), reqStartMin: 600, date: DAY }),
    { start: at(10, 10), src: 'manual', force: true, dropped: null });
  assert.deepEqual(nextSelection({ prev: at(10, 10), src: 'manual', slots: free(at(10, 10)), reqStartMin: 600, date: DAY }),
    { start: at(10, 10), src: 'manual', force: false, dropped: null });
});

test('senza orario cliccato né scelto non si inventa niente', () => {
  assert.deepEqual(nextSelection({ prev: null, src: null, slots: free(at(10)), reqStartMin: null, date: DAY }),
    { start: null, src: null, force: false, dropped: null });
});

/* ---- l'orario chiesto dall'agenda e il giorno scritto (erano nel drawer) ---- */
const tIt = (it) => it;
// Il corpo del useMemo del drawer, copiato com'era (le funzioni del drawer come argomenti).
function wasStatus({ req, reqOp, items, slots, dayRows, totalDur, isToday, nowMin, lang, step, client, t, svcName, svcOf, isEligible }) {
  if (!req || req.startMin == null || !items.length) return null;
  if (slots === null) return { loading: true };
  const exact = (slots || []).find((s) => minutesOfDay(s.start) === req.startMin);
  if (exact) return { ok: true, slot: exact };
  let label, detail = '';
  const notEligible = reqOp ? items.filter((it) => !isEligible(it.service_id, reqOp.id)) : [];
  if (reqOp && notEligible.length) {
    label = t(`${reqOp.first_name} non esegue ${svcName(svcOf(notEligible[0].service_id), lang)}`, `${reqOp.first_name} doesn't perform ${svcName(svcOf(notEligible[0].service_id), lang)}`);
    detail = t('Abilita il servizio in Staff oppure scegli un’altra operatrice', 'Enable the service in Staff or pick another stylist');
  } else if (reqOp && dayRows) {
    const row = dayRows.find((r) => r.operator.id === reqOp.id);
    const v = row ? explainSlot(row, req.startMin, totalDur || step, { nowMin: isToday ? nowMin : null, sameClientId: client?.id ?? null, t, rows: dayRows }) : null;
    if (v && !v.ok) { label = `${reqOp.first_name}: ${v.label}`; detail = v.detail; }
    else label = t(`${reqOp.first_name} non è libera per tutta la durata (${fmtDur(totalDur, lang)})`, `${reqOp.first_name} isn't free for the whole duration (${fmtDur(totalDur, lang)})`);
  } else if (!reqOp) {
    label = t(`Nessuna operatrice libera alle ${timeLabel(req.startMin)}`, `No stylist free at ${timeLabel(req.startMin)}`);
  } else {
    label = t(`${reqOp.first_name} non è disponibile alle ${timeLabel(req.startMin)}`, `${reqOp.first_name} isn't available at ${timeLabel(req.startMin)}`);
  }
  const alternatives = [...(slots || [])]
    .sort((a, b) => Math.abs(minutesOfDay(a.start) - req.startMin) - Math.abs(minutesOfDay(b.start) - req.startMin))
    .slice(0, 4)
    .sort((a, b) => minutesOfDay(a.start) - minutesOfDay(b.start));
  return { ok: false, label, detail, alternatives };
}

test('orario chiesto dall\'agenda: libero, perché non lo è, e le alternative più vicine', () => {
  const D = '2026-10-01';
  const svcs = [{ id: 3, name_it: 'Taglio', name_en: 'Cut' }, { id: 4, name_it: 'Colore' }];
  const svcOf = (id) => svcs.find((x) => x.id === id);
  const svcName = (x, lang) => (lang === 'en' && x?.name_en ? x.name_en : x?.name_it || '');
  const skills = { 1: [3, 4], 2: [3] };
  const isEligible = (sid, opId) => !!opId && (skills[opId] || []).includes(sid);
  const anna = { id: 1, first_name: 'Anna' }, giulia = { id: 2, first_name: 'Giulia' };
  const slot = (min) => ({ start: isoAtMin(D, min) });
  const row = (op, appointments = []) => ({ operator: { id: op.id, name: op.first_name }, windows: [['09:00', '19:00']], appointments, pauses: [] });
  const busy = { id: 70, operator_id: 1, start: isoAtMin(D, 600), total_duration_min: 60, client: { full_name: 'Sara' }, items: [{ id: 701, operator_id: 1, duration_min: 60, service_name: 'Taglio' }] };
  const cases = [
    { req: null, reqOp: null, items: [{ service_id: 3 }], slots: [] },
    { req: { operatorId: 1, startMin: 600 }, reqOp: anna, items: [], slots: [] },
    { req: { operatorId: 1, startMin: 600 }, reqOp: anna, items: [{ service_id: 3 }], slots: null },
    { req: { operatorId: 1, startMin: 600 }, reqOp: anna, items: [{ service_id: 3 }], slots: [slot(600), slot(630)] },
    { req: { operatorId: 2, startMin: 600 }, reqOp: giulia, items: [{ service_id: 4 }], slots: [slot(540), slot(660)] },
    { req: { operatorId: 1, startMin: 600 }, reqOp: anna, items: [{ service_id: 3 }], slots: [slot(480), slot(540), slot(660), slot(720), slot(900), slot(570)], dayRows: [row(anna, [busy])] },
    { req: { operatorId: 1, startMin: 600 }, reqOp: anna, items: [{ service_id: 3 }], slots: [slot(700)], dayRows: [row(giulia)] },
    { req: { operatorId: null, startMin: 615 }, reqOp: null, items: [{ service_id: 3 }], slots: [slot(630)] },
    { req: { operatorId: 1, startMin: 600 }, reqOp: anna, items: [{ service_id: 3 }], slots: [] },
  ];
  for (const lang of ['it', 'en']) {
    const t = (it, en) => (lang === 'en' ? (en ?? it) : it);
    for (const c of cases) {
      for (const isToday of [false, true]) {
        const args = { dayRows: null, totalDur: 30, nowMin: 11 * 60, step: 15, client: { id: 7 }, ...c, isToday, lang, t };
        const was = wasStatus({ ...args, svcName, svcOf, isEligible });
        const got = requestStatus({
          ...args, nowMin: isToday ? args.nowMin : null, clientId: args.client?.id ?? null,
          serviceName: (sid) => svcName(svcOf(sid), lang), isEligible,
        });
        assert.deepEqual(got, was);
      }
    }
  }
  const t = tIt;
  const r = requestStatus({ req: { operatorId: 2, startMin: 600 }, reqOp: giulia, items: [{ service_id: 4 }], slots: [slot(540), slot(660)], dayRows: null, totalDur: 60, step: 15, nowMin: null, clientId: 7, t, lang: 'it', serviceName: (sid) => svcName(svcOf(sid), 'it'), isEligible });
  assert.equal(r.label, 'Giulia non esegue Colore');
  assert.deepEqual(r.alternatives.map((x) => minutesOfDay(x.start)), [540, 660]);
});

test('il giorno del drawer: «Oggi» e «Domani» davanti alla data', () => {
  const today = todayStr();
  const plus = (n) => { const d = parseISO(today); d.setDate(d.getDate() + n); return toDateStr(d); };
  for (const lang of ['it', 'en']) {
    const t = (it, en) => (lang === 'en' ? (en ?? it) : it);
    for (const date of [today, plus(1), plus(2), plus(-1), '2027-02-28']) {
      // l'espressione del drawer, copiata com'era
      const was = (() => {
        const d = new Date(date + 'T00:00');
        const tday = new Date(todayStr() + 'T00:00');
        const diff = Math.round((d - tday) / 86400000);
        const base = d.toLocaleDateString(lang === 'en' ? 'en-GB' : 'it-IT', { weekday: 'short', day: 'numeric', month: 'short' });
        if (diff === 0) return t('Oggi', 'Today') + ' · ' + base;
        if (diff === 1) return t('Domani', 'Tomorrow') + ' · ' + base;
        return base;
      })();
      assert.equal(relativeDateLabel(date, lang, t), was);
    }
  }
  assert.match(relativeDateLabel(today, 'it', tIt), /^Oggi · /);
});
