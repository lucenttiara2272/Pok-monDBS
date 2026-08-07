/**
 * Pokémon Ability tests.
 *
 * Abilities were not modelled at all — not crudely, not partially. The importer
 * folded them into the card's display text and nothing read it back, so a
 * support Pokémon whose entire job is its Ability sat on the Bench as a body and
 * a lower mulligan rate. Worse, validateDeck's inert-card check only looked at
 * attacks, so those cards were never flagged: the win rate silently excluded
 * them while the builder reported nothing amiss.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  playGame, makeRng, validateDeck, ABILITY_EFFECTS,
} from '../src/engine.js';
import { makeCardIndex, buildSpec } from '../src/decks.js';

const here = dirname(fileURLToPath(import.meta.url));
const cards = JSON.parse(readFileSync(join(here, '../data/cards.json'), 'utf8'));
const meta = JSON.parse(readFileSync(join(here, '../data/meta.json'), 'utf8'));
const INDEX = makeCardIndex(cards);

const SHELL = {
  'Mega Darkrai ex': 4, 'Munkidori': 4, 'Fezandipiti ex': 4,
  'Dark Bell': 4, 'Darkness Energy': 16,
  'Ultra Ball': 4, "Lillie's Determination": 4, 'Judge': 4,
  'Night Stretcher': 3, 'Energy Search': 3, 'Switch': 2, 'Lacey': 2,
  'Kofu': 2, 'Energy Retrieval': 2, 'Energy Switch': 2,
};

/** Absol-primary shell, for the attacks that only Mega Absol has. */
const ABSOL_SHELL = {
  'Mega Absol ex': 4, 'Munkidori': 4, 'Fezandipiti ex': 4,
  'Darkness Energy': 22,
  'Ultra Ball': 4, "Lillie's Determination": 4, 'Judge': 4,
  'Night Stretcher': 3, 'Energy Search': 3, 'Switch': 2, 'Lacey': 2,
  'Kofu': 2, 'Energy Retrieval': 2,
};

// Both shells are asserted here rather than at each use. Several warnings in
// validateDeck are gated on `size === 60`, so a fixture that is quietly 56 cards
// does not fail loudly — it makes the test pass without checking anything.
test('the shells used by these tests are legal 60s', () => {
  for (const [name, deck] of [['SHELL', SHELL], ['ABSOL_SHELL', ABSOL_SHELL]]) {
    const size = Object.values(deck).reduce((a, b) => a + b, 0);
    assert.equal(size, 60, `${name} is ${size} cards, ${60 - size} short`);
    assert.equal(validateDeck(buildSpec(deck, INDEX)).ok, true);
  }
});

test('every registered Ability effect is claimed by a card', () => {
  const onCards = new Set(cards.cards
    .filter((c) => c.sim && c.sim.ability && c.sim.ability.effect)
    .map((c) => c.sim.ability.effect));
  for (const name of Object.keys(ABILITY_EFFECTS)) {
    assert.ok(onCards.has(name),
      `ABILITY_EFFECTS.${name} matches no card — dead code claims coverage`);
  }
});

test("Munkidori's Adrena-Brain moves damage onto the opponent", () => {
  // The transcription in the database said "to another of your Pokémon", which
  // is a shuffle-your-own-damage ability that does nothing. The real card moves
  // the counters across, which is the entire reason Munkidori is played.
  const munki = INDEX['Munkidori'];
  assert.equal(munki.sim.ability.effect, 'moveDamageToOpponent');
  assert.equal(munki.sim.ability.requiresSymbol, 'D');
  assert.match(munki.text, /to 1 of your opponent's Pokémon/);

  const spec = buildSpec(SHELL, INDEX);
  const rng = makeRng(91);
  let used = 0;
  for (let i = 0; i < 200; i++) {
    const { S } = playGame(spec, meta.decks[0], rng);
    if (S.inPlay().some((m) => m.abilityTurn > 0)) used++;
  }
  assert.ok(used > 0, 'no Ability was ever activated across 200 games');
});

test("Fezandipiti's Flip the Script waits for them to take a knockout", () => {
  const fez = INDEX['Fezandipiti ex'];
  assert.equal(fez.sim.ability.effect, 'drawIfKoLastTurn');
  assert.equal(fez.sim.ability.name, 'Flip the Script',
    'the database had Munkidori\'s ability name copied onto this card');
});

test('an Ability the engine cannot run is reported, not hidden', () => {
  // The inert-card warning only ever looked at attacks. A Pokémon with no
  // attacks and an unmodelled Ability passed silently, which is precisely the
  // case where the card is doing nothing.
  const custom = {
    id: 'test-idler', name: 'Test Idler', set: 'TEST 9', category: 'pokemon',
    type: 'D', max: 4,
    text: 'Ability: Do Nothing — this is not modelled.',
    sim: {
      stage: 0, basic: true, hp: 70, prizes: 1, retreat: 1, role: 'support',
      ability: { name: 'Do Nothing', text: 'not modelled' },
    },
  };
  const idx = makeCardIndex({ cards: [...cards.cards, custom] });
  const counts = { ...SHELL, 'Test Idler': 2, 'Darkness Energy': 14 };
  assert.equal(Object.values(counts).reduce((a, b) => a + b, 0), 60);

  const v = validateDeck(buildSpec(counts, idx));
  assert.equal(v.ok, true, 'an unmodelled Ability is a warning, not an error');
  assert.ok(v.warnings.some((w) => /Test Idler/.test(w) && /Ability/.test(w)),
    `expected an unmodelled-Ability warning, got: ${JSON.stringify(v.warnings)}`);
});

test("Claw of Darkness's hand disruption costs them tempo", () => {
  // The archetype model has no hand, so the discard lands where the model can
  // express it: on their next attack, and worth double while they are rebuilding
  // — a card taken off a set-up opponent is usually spare, one taken while they
  // are scrambling back from a knockout is often the one they needed.
  const absol = INDEX['Mega Absol ex'];
  const claw = absol.sim.attacks.find((a) => a.name === 'Claw of Darkness');
  assert.equal(claw.discardFromHand, 1);
  assert.equal(claw.damage, 200, 'the damage must still be counted as well');

  const rng = makeRng(93);
  const spec = buildSpec(ABSOL_SHELL, INDEX);
  let disruptions = 0;
  for (let i = 0; i < 300; i++) {
    disruptions += playGame(spec, meta.decks[0], rng).S.handDisruptions;
  }
  assert.ok(disruptions > 0, 'Claw of Darkness never disrupted a hand');
});

test('an attack with damage plus an unmodelled rider is flagged', () => {
  // The blind spot: the inert check only fires when *every* attack is effect
  // text, so an attack with a damage number attached read as fully implemented
  // no matter what else it printed.
  const custom = {
    id: 'test-rider-ex', name: 'Test Rider ex', set: 'TEST 8', category: 'pokemon',
    type: 'D', max: 4, text: 'Swipe [D][D] 150 — and something clever.',
    sim: {
      stage: 0, basic: true, hp: 280, prizes: 2, retreat: 1, role: 'attacker',
      attacks: [{
        name: 'Swipe', cost: { D: 2 }, damage: 150,
        text: 'Your opponent shuffles their deck and something clever happens.',
      }],
    },
  };
  const idx = makeCardIndex({ cards: [...cards.cards, custom] });
  const counts = { ...SHELL, 'Test Rider ex': 2, 'Darkness Energy': 14 };
  assert.equal(Object.values(counts).reduce((a, b) => a + b, 0), 60);

  const v = validateDeck(buildSpec(counts, idx));
  assert.equal(v.ok, true, 'a partially modelled attack is legal, just incomplete');
  assert.ok(v.warnings.some((w) => /Test Rider ex's Swipe/.test(w)),
    `expected a partial-attack warning, got: ${JSON.stringify(v.warnings)}`);
});

test('a rider the engine does model is not flagged', () => {
  // Claw of Darkness carries text and discardFromHand, so it is implemented and
  // must stop being reported. A flag list that goes stale as mechanics are added
  // would nag about finished cards forever.
  const v = validateDeck(buildSpec(ABSOL_SHELL, INDEX));
  assert.ok(!v.warnings.some((w) => /Claw of Darkness/.test(w)),
    'the hand discard is modelled now and should not be reported as missing');
});

test('a modelled Ability is not reported as a blank', () => {
  const v = validateDeck(buildSpec(SHELL, INDEX));
  assert.ok(!v.warnings.some((w) => /Munkidori/.test(w) && /Ability/.test(w)),
    'Munkidori runs its Ability now and should not be flagged');
});
