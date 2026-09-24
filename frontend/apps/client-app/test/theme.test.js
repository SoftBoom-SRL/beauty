// Il white-label dell'app cliente (theme.js): dal colore del salone i toni
// derivati, il colore leggibile sopra il brand e la soglia di preavviso.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { brandVars, darken, headFont, makeBrand, mix, onColor, tintOf } from '../src/theme.js';

test('colori derivati dal brand', () => {
  assert.equal(mix('#7C4A57', '#000000', 0.28), '#59353f');
  assert.equal(darken('#7C4A57'), '#59353f');
  assert.equal(tintOf('#7C4A57'), '#ede6e7');
  assert.equal(mix('#000000', '#ffffff', 0.5), '#808080');
});

test('sul brand: bianco sui colori scuri, inchiostro su quelli chiari', () => {
  assert.equal(onColor('#7C4A57'), '#FFFFFF');
  assert.equal(onColor('#000000'), '#FFFFFF');
  assert.equal(onColor('#F5E6C8'), '#211C18');
  assert.equal(onColor('#FFFFFF'), '#211C18');
});

test('makeBrand: i campi del branding, con i valori predefiniti', () => {
  const b = makeBrand({ color: '#7C4A57', name: 'The Parlour', slug: 'the-parlour', logoUrl: null });
  assert.deepEqual(b, {
    color: '#7C4A57', ink: '#59353f', tint: '#ede6e7', on: '#FFFFFF',
    name: 'The Parlour', slug: 'the-parlour', logo: null,
    address: '', phone: '', openingHours: '', privacyUrl: '',
    cancelMinHours: 24, type: 'serif',
  });
  assert.equal(makeBrand({ color: '#7C4A57', logoUrl: 'https://x/logo.png' }).logo, 'https://x/logo.png');
  assert.equal(makeBrand({ color: '#7C4A57', logoUrl: '' }).logo, null);
});

test('makeBrand: la soglia di preavviso del salone, 24 ore se manca o non ha senso', () => {
  const hours = (h) => makeBrand({ color: '#7C4A57', cancelMinHours: h }).cancelMinHours;
  assert.equal(hours(48), 48);
  assert.equal(hours('36'), 36);
  assert.equal(hours(1.5), 1.5);
  for (const h of [0, -5, undefined, null, 'abc']) assert.equal(hours(h), 24, String(h));
});

test('variabili CSS del brand e font dei titoli', () => {
  const b = makeBrand({ color: '#7C4A57' });
  assert.deepEqual(brandVars(b), {
    '--brand': '#7C4A57', '--brand-ink': '#59353f', '--brand-tint': '#ede6e7', '--brand-on': '#FFFFFF',
  });
  assert.equal(headFont(b), 'var(--serif)');
  assert.equal(headFont({ type: 'grotesk' }), 'var(--sans)');
});
