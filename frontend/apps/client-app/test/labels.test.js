// Etichette dell'app cliente: preferenza della lista d'attesa (lib/waitlist.js),
// nomi e icone del listino (lib/catalog.js), servizi di un appuntamento
// (lib/appointments.js), scadenze e coupon del portafoglio (lib/wallet.js) e i
// toast d'errore (toastApiError di @youty/shared e lib/errors.js).
process.env.TZ = 'Asia/Tokyo';

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ApiError, setSalonTz, toastApiError } from '@youty/shared';
import { apptServiceNames } from '../src/lib/appointments.js';
import { catIcon, svcLangName } from '../src/lib/catalog.js';
import { toastSlotTaken } from '../src/lib/errors.js';
import { couponLabel, couponOrigin, fmtExpiry } from '../src/lib/wallet.js';
import { prefLabel, WEEKDAY_LETTERS_EN, WEEKDAY_LETTERS_IT } from '../src/lib/waitlist.js';

const tIt = (it) => it;
const tEn = (it, en) => en;

test('lista d\'attesa: la preferenza oraria a parole', () => {
  const cases = [
    [{ preference: 'morning' }, 'Mattina', 'Morning'],
    [{ preference: 'afternoon' }, 'Pomeriggio', 'Afternoon'],
    [{ preference: 'weekend' }, 'Weekend', 'Weekend'],
    [{ preference: 'any' }, 'Qualsiasi orario', 'Any time'],
    [{ preference: 'boh' }, 'Qualsiasi orario', 'Any time'],
    [{}, 'Qualsiasi orario', 'Any time'],
    // giorni dal lunedì (0) come nell'API, poi l'ora senza i secondi
    [{ preference: 'exact', exact_days: [0, 5], exact_time: '10:00:00' }, 'Lun Sab · 10:00', 'Mon Sat · 10:00'],
    [{ preference: 'exact', exact_days: [6], exact_time: null }, 'Dom', 'Sun'],
    [{ preference: 'exact', exact_days: [], exact_time: '09:30' }, '09:30', '09:30'],
    [{ preference: 'exact', exact_days: [7, -1], exact_time: '' }, 'Orario preciso', 'Exact time'],
    [{ preference: 'exact', exact_days: null }, 'Orario preciso', 'Exact time'],
  ];
  for (const [entry, it, en] of cases) {
    assert.equal(prefLabel(entry, tIt, 'it'), it, JSON.stringify(entry));
    assert.equal(prefLabel(entry, tEn, 'en'), en, JSON.stringify(entry));
  }
});

test('lista d\'attesa: le iniziali dei giorni, dal lunedì', () => {
  assert.equal(WEEKDAY_LETTERS_IT.join(''), 'LMMGVSD');
  assert.equal(WEEKDAY_LETTERS_EN.join(''), 'MTWTFSS');
  // e i nomi abbreviati per esteso, uno per ogni giorno dell'API
  const all = { preference: 'exact', exact_days: [0, 1, 2, 3, 4, 5, 6] };
  assert.equal(prefLabel(all, tIt, 'it'), 'Lun Mar Mer Gio Ven Sab Dom');
  assert.equal(prefLabel(all, tEn, 'en'), 'Mon Tue Wed Thu Fri Sat Sun');
});

test('listino: il nome nella lingua della cliente, l\'italiano se manca l\'inglese', () => {
  const svc = { name_it: 'Taglio', name_en: 'Haircut' };
  assert.equal(svcLangName(svc, 'en'), 'Haircut');
  assert.equal(svcLangName(svc, 'it'), 'Taglio');
  assert.equal(svcLangName({ name_it: 'Piega', name_en: '' }, 'en'), 'Piega');
  assert.equal(svcLangName(svc, 'EN'), 'Taglio');
  assert.equal(svcLangName(null, 'en'), '');
  assert.equal(svcLangName(undefined, 'it'), '');
});

test('listino: l\'icona della categoria dal nome', () => {
  const cases = [
    ['Unghie', 'sparkle'], ['Manicure express', 'sparkle'], ['Pedicure', 'sparkle'], ['Nail art', 'sparkle'],
    ['Capelli', 'scissors'], ['Taglio', 'scissors'], ['Piega', 'scissors'], ['Hair', 'scissors'],
    ['Viso', 'drop'], ['Skin care', 'drop'], ['Pulizia della pelle', 'drop'],
    ['Massaggi', 'star'], ['', 'star'], [undefined, 'star'], [null, 'star'],
    // conta l'ordine delle regole: le unghie vincono sui capelli
    ['Hair & nails', 'sparkle'],
  ];
  for (const [name, icon] of cases) assert.equal(catIcon(name), icon, String(name));
});

test('appuntamento: i servizi uniti da «+»', () => {
  assert.equal(apptServiceNames({ services: [{ name: 'Taglio' }, { name: 'Piega' }] }), 'Taglio + Piega');
  assert.equal(apptServiceNames({ services: [] }), '');
  assert.equal(apptServiceNames({}), '');
});

test('portafoglio: la scadenza è un istante, letto sul calendario del salone', () => {
  assert.equal(fmtExpiry(null, 'it', tIt), 'Senza scadenza');
  assert.equal(fmtExpiry('', 'en', tEn), 'No expiry');
  // Le 23:30 UTC del 31 dicembre sono già l'1 gennaio a Roma.
  assert.equal(fmtExpiry('2026-12-31T23:30:00Z', 'it', tIt), 'Scade il 1 gen 2027');
  assert.equal(fmtExpiry('2026-12-31T23:30:00Z', 'en', tEn), 'Expires 1 Jan 2027');
  setSalonTz('America/Los_Angeles');
  try {
    assert.equal(fmtExpiry('2026-12-31T23:30:00Z', 'it', tIt), 'Scade il 31 dic 2026');
    assert.equal(fmtExpiry('2026-12-31T23:30:00Z', 'en', tEn), 'Expires 31 Dec 2026');
  } finally {
    setSalonTz('Europe/Rome');
  }
});

test('portafoglio: coupon in percentuale (senza arrotondare) o a importo, e da dove viene', () => {
  assert.equal(couponLabel({ kind: 'percent', value: '12.50' }, 'it', tIt), 'Sconto del 12,5%');
  assert.equal(couponLabel({ kind: 'percent', value: '12.50' }, 'en', tEn), '12.5% off');
  assert.equal(couponLabel({ kind: 'amount', value: '10.00' }, 'it', tIt), 'Buono da €10,00');
  assert.equal(couponLabel({ kind: 'amount', value: '1234.5' }, 'en', tEn), '€1,234.50 voucher');
  assert.equal(couponOrigin('loyalty', tIt), 'Premio fedeltà');
  assert.equal(couponOrigin('loyalty', tEn), 'Loyalty reward');
  assert.equal(couponOrigin('manual', tIt), 'Sconto');
  assert.equal(couponOrigin(undefined, tEn), 'Discount');
});

test('errore dell\'API (toastApiError, l\'errToast di prima): il messaggio del server, altrimenti «Errore di rete»', () => {
  const calls = [];
  const fireToast = (o) => calls.push(o);
  toastApiError(new ApiError(400, 'Preavviso minimo non rispettato'), fireToast, tIt);
  toastApiError(new TypeError('Failed to fetch'), fireToast, tIt);
  toastApiError(null, fireToast, tEn);
  assert.deepEqual(calls, [
    { msg: 'Preavviso minimo non rispettato', icon: 'alert' },
    { msg: 'Errore di rete', icon: 'alert' },
    { msg: 'Network error', icon: 'alert' },
  ]);
});

test('orario appena preso (409): lo stesso toast in Prenota e Sposta', () => {
  const calls = [];
  toastSlotTaken((o) => calls.push(o), tIt);
  toastSlotTaken((o) => calls.push(o), tEn);
  assert.deepEqual(calls, [
    { msg: 'Questo orario è appena stato preso: scegline un altro.', icon: 'alert' },
    { msg: 'That time was just taken: pick another.', icon: 'alert' },
  ]);
});
