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

test('the shell used by these tests is a legal 60', () => {
  assert.equal(Object.values(SHELL).reduce((a, b) => a + b, 0), 60);
  assert.equal(validateDeck(buildSpec(SHELL, INDEX)).ok, true);
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

test('a modelled Ability is not reported as a blank', () => {
  const v = validateDeck(buildSpec(SHELL, INDEX));
  assert.ok(!v.warnings.some((w) => /Munkidori/.test(w) && /Ability/.test(w)),
    'Munkidori runs its Ability now and should not be flagged');
});
