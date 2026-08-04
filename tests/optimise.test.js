/**
 * Optimiser tests.
 *
 * The optimiser is the easiest place in this project to produce something that
 * looks impressive and is quietly wrong: a deck that scores well because the
 * search overfitted its sample, or one that quietly dropped the cards the user
 * asked to build around. These hold it to the promises it makes.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { validateDeck, deckSize } from '../src/engine.js';
import { makeCardIndex, buildSpec, PRESETS } from '../src/decks.js';
import { optimiseDeck } from '../src/optimise.js';

const here = dirname(fileURLToPath(import.meta.url));
const cards = JSON.parse(readFileSync(join(here, '../data/cards.json'), 'utf8'));
const meta = JSON.parse(readFileSync(join(here, '../data/meta.json'), 'utf8'));
const INDEX = makeCardIndex(cards);

// Deliberately small. These tests check behaviour — that pins hold, that the deck
// comes back legal, that a non-improvement is reported honestly — none of which
// needs statistical precision. Running the optimiser at full settings here would
// add minutes to the suite and starve the parity tests of CPU.
const FAST = { games: 120, rounds: 2, maxMoves: 16, budget: 32, finalGames: 400 };

test('pinned cards are never changed', async () => {
  const start = { 'Mega Darkrai ex': 4, 'Dark Bell': 4, 'Darkness Energy': 12 };
  const locked = ['Mega Darkrai ex', 'Dark Bell'];
  const r = await optimiseDeck(start, INDEX, meta.decks, { ...FAST, locked });

  for (const name of locked) {
    assert.equal(r.after[name], start[name],
      `${name} was pinned at ${start[name]} but came back as ${r.after[name]}`);
  }
  assert.ok(!r.diff.some((d) => locked.includes(d.name)),
    `the diff must not touch pinned cards: ${JSON.stringify(r.diff)}`);
});

test('the result is always a legal 60', async () => {
  const cases = [
    { 'Mega Darkrai ex': 4 },                                   // far too few
    { 'Mega Darkrai ex': 4, 'Darkness Energy': 40 },            // lopsided
    { 'Mega Kangaskhan ex': 3, 'Munkidori': 4 },
  ];
  for (const start of cases) {
    const r = await optimiseDeck(start, INDEX, meta.decks,
      { ...FAST, rounds: 1, locked: Object.keys(start) });
    const spec = buildSpec(r.after, INDEX);
    assert.equal(deckSize(spec), 60,
      `got ${deckSize(spec)} cards from ${JSON.stringify(start)}`);
    const v = validateDeck(spec);
    assert.equal(v.ok, true, v.errors.join('; '));
  }
});

test('an evolution line is completed automatically', async () => {
  // Pinning only the Stage 2 should pull in Drakloak and Dreepy.
  const r = await optimiseDeck({ 'Dragapult ex': 3 }, INDEX, meta.decks,
    { ...FAST, rounds: 1, locked: ['Dragapult ex'] });
  assert.ok(r.after['Drakloak'] > 0, 'Drakloak missing from the built deck');
  assert.ok(r.after['Dreepy'] > 0, 'Dreepy missing from the built deck');
  assert.equal(validateDeck(buildSpec(r.after, INDEX)).ok, true);
});

test('Energy matching the attacker is included', async () => {
  // Mega Darkrai's attacks cost [D]; the deck must end up with Darkness Energy.
  const r = await optimiseDeck({ 'Mega Darkrai ex': 4 }, INDEX, meta.decks,
    { ...FAST, rounds: 1, locked: ['Mega Darkrai ex'] });
  assert.ok((r.after['Darkness Energy'] || 0) > 0,
    `no Darkness Energy in the result: ${JSON.stringify(r.after)}`);
});

test('a reported improvement is verified on a fresh sample', async () => {
  // The search runs on one fixed seed; the before/after it reports must come
  // from a different, larger sample, so an overfitted result cannot be claimed
  // as a gain.
  const start = {
    'Mega Darkrai ex': 3, 'Mega Absol ex': 2, 'Munkidori': 2, 'Fezandipiti ex': 1,
    'Darkness Energy': 11, 'Dark Bell': 4, 'Ultra Ball': 4, 'Night Stretcher': 3,
    'Energy Search': 3, 'Energy Retrieval': 3, 'Energy Switch': 3, 'Switch': 2,
    "AZ's Tranquility": 2, "Boss's Orders": 2, "Janine's Secret Art": 2,
    "Black Belt's Training": 2, "Lisia's Appeal": 2, 'Judge': 1,
    "Lillie's Determination": 1, 'Jett': 1, "Team Rocket's Petrel": 1,
    'Punk Helmet': 2, 'Air Balloon': 1, 'Powerglass': 1, 'Amulet of Hope': 1,
    'Spiky Energy': 1,
  };
  const r = await optimiseDeck(start, INDEX, meta.decks,
    { games: 150, rounds: 3, maxMoves: 20, budget: 60, finalGames: 800, locked: ['Mega Darkrai ex'] });

  assert.equal(validateDeck(buildSpec(r.after, INDEX)).ok, true);
  // Either it genuinely improved, or it says plainly that it did not.
  assert.ok(r.afterScore > r.beforeScore || r.note,
    'a non-improvement must be reported, not presented as a win');
  if (r.afterScore <= r.beforeScore) {
    assert.match(r.note, /noise|left as it was/i);
  }
});

test('a deck that did not improve is handed back unchanged', async () => {
  // The optimiser used to return the modified deck while telling the user their
  // list had been left alone, so Apply offered changes it had itself measured as
  // worse. If the fresh sample does not confirm a gain, nothing should change.
  const start = { ...PRESETS['Optimised (43%)'] };
  const r = await optimiseDeck(start, INDEX, meta.decks,
    { games: 100, rounds: 2, maxMoves: 12, budget: 16, finalGames: 400 });

  if (r.reverted) {
    assert.deepEqual(r.after, r.before, 'a reverted run must return the original deck');
    assert.equal(r.diff.length, 0, 'a reverted run must show no changes to apply');
    assert.equal(r.afterScore, r.beforeScore);
  } else {
    assert.ok(r.afterScore > r.beforeScore,
      'a run that kept its changes must actually be better');
  }
});

test('the win condition is never optimised away', async () => {
  // Mega Darkrai's Abyss Eye needs a Special Condition, and Dark Bell is the only
  // card that applies one. Cutting the last Dark Bell takes the deck from ~43% to
  // ~23%, but each single-card step measures fine, so the search has to be told.
  const start = { ...PRESETS['Optimised (43%)'] };
  assert.ok(start['Dark Bell'] > 0, 'fixture should contain the enabler');

  const r = await optimiseDeck(start, INDEX, meta.decks,
    { games: 100, rounds: 2, maxMoves: 14, budget: 24, finalGames: 400 });

  assert.ok((r.after['Dark Bell'] || 0) > 0,
    'Dark Bell was removed, which disables Abyss Eye — the deck\'s whole plan');
});

test('a deck missing its enabler can get one back', async () => {
  // The real failure case: a deck that has already lost its Dark Bell. An
  // absolute combo check rejected every candidate here, so the optimiser did
  // nothing at all and the deck stayed stuck without its win condition.
  const stranded = { ...PRESETS['Optimised (43%)'] };
  delete stranded['Dark Bell'];
  stranded['Darkness Energy'] = (stranded['Darkness Energy'] || 0) + 4;
  assert.equal(Object.values(stranded).reduce((a, b) => a + b, 0), 60);

  const r = await optimiseDeck(stranded, INDEX, meta.decks,
    { games: 150, rounds: 3, maxMoves: 16, budget: 40, finalGames: 600 });

  assert.equal(validateDeck(buildSpec(r.after, INDEX)).ok, true);
  assert.ok(r.diff.length > 0,
    'the optimiser must be able to move at all on a deck with no enabler');
  assert.ok((r.after['Dark Bell'] || 0) > 0,
    `Abyss Eye needs a Special Condition; the optimiser should restore an enabler. `
    + `Got: ${JSON.stringify(r.diff)}`);
});

test('the diff explains exactly what changed', async () => {
  const start = { 'Mega Darkrai ex': 4, 'Darkness Energy': 20, 'Ultra Ball': 4 };
  const r = await optimiseDeck(start, INDEX, meta.decks,
    { ...FAST, rounds: 1, locked: ['Mega Darkrai ex'] });

  for (const d of r.diff) {
    assert.notEqual(d.from, d.to);
    assert.equal(r.after[d.name] || 0, d.to);
    assert.equal(r.before[d.name] || 0, d.from);
  }
  const delta = r.diff.reduce((a, d) => a + (d.to - d.from), 0);
  const startSize = Object.values(r.before).reduce((a, b) => a + b, 0);
  assert.equal(startSize + delta, 60, 'the diff must account for every slot');
});
