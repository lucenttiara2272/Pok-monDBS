/**
 * Decklist import tests.
 *
 * The importer's job is to be the exact inverse of copyList, and to refuse to
 * guess. A parser that silently drops the lines it cannot read produces a
 * 54-card deck that looks like the list you pasted, and the simulator will
 * report a win rate for it without complaint — so unresolved lines have to come
 * back as errors rather than as a smaller deck.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { parseDecklist } from '../src/decklist.js';
import { makeCardIndex, buildSpec } from '../src/decks.js';
import { validateDeck, deckSize } from '../src/engine.js';

const here = dirname(fileURLToPath(import.meta.url));
const cards = JSON.parse(readFileSync(join(here, '../data/cards.json'), 'utf8'));
const INDEX = makeCardIndex(cards);

const LIST = `Pokémon: 9
1 Fezandipiti ex ASC 142
2 Mega Absol ex MEG 86
3 Mega Darkrai ex PBL 48
3 Munkidori TWM 95
Item: 20
4 Dark Bell PBL 75
2 Energy Retrieval CRI 108
2 Energy Search POR 72
3 Energy Switch MEG 115
3 Night Stretcher ASC 196
2 Switch MEG 130
3 Ultra Ball MEG 131
1 Unfair Stamp TWM 165
Tool: 4
1 Air Balloon MEG 166
1 Powerglass SFA 63
2 Punk Helmet PFL 92
Supporter: 15
1 AZ's Tranquility CRI 76
2 Black Belt's Training JTG 143
2 Boss's Orders MEG 114
2 Janine's Secret Art SFA 59
3 Judge POR 76
2 Lacey SCR 139
1 Lillie's Determination MEG 119
2 Lisia's Appeal SSP 179
Energy: 12
11 Darkness Energy MEE 7
1 Spiky Energy JTG 159`;

test('a real pasted decklist imports to a legal 60', () => {
  const r = parseDecklist(LIST, INDEX);
  assert.deepEqual(r.errors, [], 'every line should resolve');
  assert.equal(r.size, 60);

  const spec = buildSpec(r.counts, INDEX);
  assert.equal(deckSize(spec), 60);
  assert.equal(validateDeck(spec).ok, true, validateDeck(spec).errors.join('; '));

  assert.equal(r.counts['Mega Darkrai ex'], 3);
  assert.equal(r.counts['Dark Bell'], 4);
  assert.equal(r.counts['Darkness Energy'], 11);
});

test('section headers and blank lines are ignored, not parsed as cards', () => {
  const r = parseDecklist(LIST, INDEX);
  assert.ok(!Object.keys(r.counts).some((n) => /^Pok|^Item|^Tool|^Supporter/.test(n)));
});

test('an unknown card is an error, never a quietly smaller deck', () => {
  const r = parseDecklist('4 Definitely Not A Card XYZ 999\n2 Ultra Ball MEG 131', INDEX);
  assert.equal(r.counts['Ultra Ball'], 2);
  assert.equal(Object.keys(r.counts).length, 1);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /Definitely Not A Card/);
});

test("PTCG Live's \"Basic Darkness Energy\" resolves to the database name", () => {
  // The game client exports basic Energy with the Basic prefix; this project
  // does not use it. Without the same normalisation the importer applies on
  // card import, every list exported from the client would fail on its Energy.
  const r = parseDecklist('11 Basic Darkness Energy MEE 7', INDEX);
  assert.deepEqual(r.errors, []);
  assert.equal(r.counts['Darkness Energy'], 11);
});

test('set code and number win over the name when they disagree', () => {
  // Munkidori and Munkidori ex are different cards; so are reprints sharing a
  // name. The printed identity is exact and the name is not.
  const munkidori = INDEX['Munkidori'];
  const r = parseDecklist(`3 Wrong Name Entirely ${munkidori.set}`, INDEX);
  assert.deepEqual(r.errors, []);
  assert.equal(r.counts['Munkidori'], 3);
});

test('curly apostrophes still match', () => {
  const r = parseDecklist('4 Lillie’s Determination MEG 119', INDEX);
  assert.deepEqual(r.errors, []);
  assert.equal(r.counts["Lillie's Determination"], 4);
});

test('repeated lines for one card are summed', () => {
  const r = parseDecklist('2 Ultra Ball MEG 131\n2 Ultra Ball MEG 131', INDEX);
  assert.equal(r.counts['Ultra Ball'], 4);
});

test('over-limit counts and short lists warn without blocking', () => {
  const r = parseDecklist('6 Ultra Ball MEG 131', INDEX);
  assert.deepEqual(r.errors, [], 'this is a warning, not a parse failure');
  assert.ok(r.warnings.some((w) => /exceeds its limit/.test(w)));
  assert.ok(r.warnings.some((w) => /not 60/.test(w)));
});

test('a list with no set codes still imports', () => {
  const r = parseDecklist('4 Ultra Ball\n3 Dark Bell', INDEX);
  assert.deepEqual(r.errors, []);
  assert.equal(r.counts['Ultra Ball'], 4);
  assert.equal(r.counts['Dark Bell'], 3);
});

test('import round-trips whatever copyList produced', () => {
  // The two have to stay inverses. copyList emits `${n} ${name} ${set}` under
  // `${label}: ${total}` headers, which is exactly the shape parsed above.
  const deck = { 'Mega Darkrai ex': 3, 'Dark Bell': 4, 'Darkness Energy': 20 };
  const lines = [];
  for (const [n, c] of Object.entries(deck)) lines.push(`${c} ${n} ${INDEX[n].set}`);
  const r = parseDecklist(lines.join('\n'), INDEX);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.counts, deck);
});
