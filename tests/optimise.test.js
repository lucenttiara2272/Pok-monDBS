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
import { makeCardIndex, buildSpec } from '../src/decks.js';
import { optimiseDeck } from '../src/optimise.js';

const here = dirname(fileURLToPath(import.meta.url));
const cards = JSON.parse(readFileSync(join(here, '../data/cards.json'), 'utf8'));
const meta = JSON.parse(readFileSync(join(here, '../data/meta.json'), 'utf8'));
const INDEX = makeCardIndex(cards);

const FAST = { games: 120, rounds: 2, maxMoves: 16, budget: 32, finalGames: 400 };

test('pinned cards are never changed', () => {
  const start = { 'Mega Darkrai ex': 4, 'Dark Bell': 4, 'Darkness Energy': 12 };
  const locked = ['Mega Darkrai ex', 'Dark Bell'];
  const r = optimiseDeck(start, INDEX, meta.decks, { ...FAST, locked });

  for (const name of locked) {
    assert.equal(r.after[name], start[name],
      `${name} was pinned at ${start[name]} but came back as ${r.after[name]}`);
  }
  assert.ok(!r.diff.some((d) => locked.includes(d.name)),
    `the diff must not touch pinned cards: ${JSON.stringify(r.diff)}`);
});

test('the result is always a legal 60', () => {
  const cases = [
    { 'Mega Darkrai ex': 4 },                                   // far too few
    { 'Mega Darkrai ex': 4, 'Darkness Energy': 40 },            // lopsided
    { 'Mega Kangaskhan ex': 3, 'Munkidori': 4 },
  ];
  for (const start of cases) {
    const r = optimiseDeck(start, INDEX, meta.decks,
      { ...FAST, rounds: 1, locked: Object.keys(start) });
    const spec = buildSpec(r.after, INDEX);
    assert.equal(deckSize(spec), 60,
      `got ${deckSize(spec)} cards from ${JSON.stringify(start)}`);
    const v = validateDeck(spec);
    assert.equal(v.ok, true, v.errors.join('; '));
  }
});

test('an evolution line is completed automatically', () => {
  // Pinning only the Stage 2 should pull in Drakloak and Dreepy.
  const r = optimiseDeck({ 'Dragapult ex': 3 }, INDEX, meta.decks,
    { ...FAST, rounds: 1, locked: ['Dragapult ex'] });
  assert.ok(r.after['Drakloak'] > 0, 'Drakloak missing from the built deck');
  assert.ok(r.after['Dreepy'] > 0, 'Dreepy missing from the built deck');
  assert.equal(validateDeck(buildSpec(r.after, INDEX)).ok, true);
});

test('Energy matching the attacker is included', () => {
  // Mega Darkrai's attacks cost [D]; the deck must end up with Darkness Energy.
  const r = optimiseDeck({ 'Mega Darkrai ex': 4 }, INDEX, meta.decks,
    { ...FAST, rounds: 1, locked: ['Mega Darkrai ex'] });
  assert.ok((r.after['Darkness Energy'] || 0) > 0,
    `no Darkness Energy in the result: ${JSON.stringify(r.after)}`);
});

test('a reported improvement is verified on a fresh sample', () => {
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
  const r = optimiseDeck(start, INDEX, meta.decks,
    { games: 150, rounds: 3, maxMoves: 20, budget: 60, finalGames: 800, locked: ['Mega Darkrai ex'] });

  assert.equal(validateDeck(buildSpec(r.after, INDEX)).ok, true);
  // Either it genuinely improved, or it says plainly that it did not.
  assert.ok(r.afterScore > r.beforeScore || r.note,
    'a non-improvement must be reported, not presented as a win');
  if (r.afterScore <= r.beforeScore) {
    assert.match(r.note, /noise|left as it was/i);
  }
});

test('the diff explains exactly what changed', () => {
  const start = { 'Mega Darkrai ex': 4, 'Darkness Energy': 20, 'Ultra Ball': 4 };
  const r = optimiseDeck(start, INDEX, meta.decks,
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
