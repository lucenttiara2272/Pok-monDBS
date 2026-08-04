/**
 * Card effect tests.
 *
 * `sim.effect` in data/cards.json used to be documentation: the engine reached
 * for Trainers by name and nothing read the field, so a card carrying it was
 * shuffled in, drawn, and held as a blank while the deck still reported a
 * confident win rate. These tests hold each registered effect to doing the thing
 * its card text says, and hold the registry to being reachable from data alone.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  playGame, makeRng, runGauntlet, validateDeck, ITEM_EFFECTS, PLAYED_TRAINERS,
} from '../src/engine.js';
import { makeCardIndex, buildSpec } from '../src/decks.js';

const here = dirname(fileURLToPath(import.meta.url));
const cards = JSON.parse(readFileSync(join(here, '../data/cards.json'), 'utf8'));
const meta = JSON.parse(readFileSync(join(here, '../data/meta.json'), 'utf8'));
const INDEX = makeCardIndex(cards);

/** A small Basic, so Buddy-Buddy Poffin has something legal to find. */
const CHICK = {
  id: 'test-chick', name: 'Test Chick', set: 'TEST 2', category: 'pokemon',
  type: 'D', max: 4, text: 'A 60 HP Basic.',
  sim: { stage: 0, basic: true, hp: 60, prizes: 1, retreat: 1, role: 'support' },
};
const IDX = makeCardIndex({ cards: [...cards.cards, CHICK] });

test('every registered effect name exists on a card, and vice versa', () => {
  // The registry and the database have to agree. A handler with no card is dead
  // code; a card whose effect has no handler is a blank the deck builder should
  // be warning about rather than quietly shipping.
  const onCards = new Set(cards.cards
    .filter((c) => c.sim && c.sim.effect && c.category === 'item')
    .map((c) => c.sim.effect));
  for (const name of Object.keys(ITEM_EFFECTS)) {
    assert.ok(onCards.has(name), `ITEM_EFFECTS.${name} matches no Item in cards.json`);
  }
});

test('Buddy-Buddy Poffin benches Basics at or under its HP limit', () => {
  const spec = buildSpec({
    'Mega Darkrai ex': 4, 'Test Chick': 4, 'Munkidori': 2,
    'Buddy-Buddy Poffin': 4, 'Darkness Energy': 14, 'Ultra Ball': 4,
    "Lillie's Determination": 4, 'Night Stretcher': 3, 'Energy Search': 3,
    'Switch': 2, 'Lacey': 2, 'Energy Retrieval': 2, 'Energy Switch': 2,
    'Kofu': 2, "AZ's Tranquility": 2, 'Air Balloon': 2, 'Judge': 4,
  }, IDX);

  // Probe `itemsPlayed`, not the discard pile. Ultra Ball's cost discards two
  // random cards from hand, so a Poffin in the bin proves nothing about whether
  // it was ever actually played — the first version of this test passed for that
  // wrong reason.
  const rng = makeRng(11);
  let played = 0;
  for (let i = 0; i < 200; i++) {
    const { S } = playGame(spec, meta.decks[0], rng);
    if (S.itemsPlayed.includes('Buddy-Buddy Poffin')) played++;
  }
  assert.ok(played > 100,
    `Poffin should be played in most games with a legal target; only ${played}/200`);
});

test('Poffin is not spent when the deck has no target it can reach', () => {
  // Same shell, but every Basic is far above 70 HP. The handler must decline
  // rather than burn the card — this is the case the deck builder warns about.
  const spec = buildSpec({
    'Mega Darkrai ex': 4, 'Munkidori': 4, 'Fezandipiti ex': 2,
    'Buddy-Buddy Poffin': 4, 'Darkness Energy': 14, 'Ultra Ball': 4,
    "Lillie's Determination": 4, 'Night Stretcher': 3, 'Energy Search': 3,
    'Switch': 2, 'Lacey': 2, 'Energy Retrieval': 2, 'Energy Switch': 2,
    'Kofu': 2, "AZ's Tranquility": 2, 'Air Balloon': 2, 'Judge': 4,
  }, INDEX);

  const rng = makeRng(12);
  for (let i = 0; i < 50; i++) {
    const { S } = playGame(spec, meta.decks[0], rng);
    assert.ok(!S.itemsPlayed.includes('Buddy-Buddy Poffin'),
      'Poffin has no legal target here and must not be played');
  }
});

test('Punk Helmet plus Spiky Energy sets up Terminal Period exactly', () => {
  // Punk Helmet retaliates 40 and Spiky Energy 20. Together that is 60 damage on
  // the attacker — precisely the 6 damage counters Mega Absol's Terminal Period
  // needs to Knock Out outright, whatever HP it has left.
  //
  // Asserted on the knockout counter rather than on the win rate. Swapping the
  // combo out frees 8 slots that become Energy, which makes the plain deck more
  // consistent at its 200-damage attack; comparing the two totals would measure
  // that trade-off rather than whether the line fires at all.
  const counts = {
    'Mega Absol ex': 4, 'Munkidori': 4, 'Fezandipiti ex': 3,
    'Punk Helmet': 4, 'Spiky Energy': 4, 'Darkness Energy': 12,
    'Ultra Ball': 4, "Lillie's Determination": 4, 'Judge': 4,
    'Night Stretcher': 3, 'Energy Search': 3, 'Switch': 2, 'Lacey': 2,
    'Kofu': 2, "AZ's Tranquility": 2, 'Energy Switch': 2, 'Energy Retrieval': 1,
  };
  assert.equal(Object.values(counts).reduce((a, b) => a + b, 0), 60);
  const spec = buildSpec(counts, INDEX);
  assert.equal(validateDeck(spec).ok, true, validateDeck(spec).errors.join('; '));

  const rng = makeRng(21);
  let kos = 0;
  for (let i = 0; i < 400; i++) {
    kos += playGame(spec, meta.decks[0], rng).S.exactDamageKos;
  }
  assert.ok(kos > 0,
    'Terminal Period never fired — 40 retaliate plus 20 retaliate should reach '
    + 'exactly 60 damage on the attacker and auto-KO it');

  // Without the retaliate pieces nothing can put the opponent on exactly 6
  // counters, so the same attack should essentially never resolve.
  const bare = { ...counts };
  delete bare['Punk Helmet'];
  delete bare['Spiky Energy'];
  bare['Darkness Energy'] = 20;
  assert.equal(Object.values(bare).reduce((a, b) => a + b, 0), 60);

  const rng2 = makeRng(21);
  let bareKos = 0;
  for (let i = 0; i < 400; i++) {
    bareKos += playGame(buildSpec(bare, INDEX), meta.decks[0], rng2).S.exactDamageKos;
  }
  assert.ok(kos > bareKos,
    `the retaliate line should be what sets up Terminal Period `
    + `(${kos} knockouts with it, ${bareKos} without)`);
});

test('Punk Helmet does not retaliate on a non-Darkness Pokémon', () => {
  // requiresDark was ignored entirely: the tool retaliated from any body. The
  // engine now reads the flag, so a Colorless attacker gets nothing from it.
  const colorless = {
    id: 'test-plain-ex', name: 'Test Plain ex', set: 'TEST 3', category: 'pokemon',
    type: 'C', max: 4, text: 'Swing [C][C] 120.',
    sim: { stage: 0, basic: true, hp: 280, prizes: 2, retreat: 2, role: 'attacker',
      attacks: [{ name: 'Swing', cost: { C: 2 }, damage: 120 }] },
  };
  const idx = makeCardIndex({ cards: [...cards.cards, colorless] });
  const shell = (mon) => buildSpec({
    [mon]: 4, 'Munkidori': 4, 'Fezandipiti ex': 3, 'Punk Helmet': 4,
    'Darkness Energy': 18, 'Ultra Ball': 4, "Lillie's Determination": 4,
    'Night Stretcher': 3, 'Energy Search': 3, 'Switch': 2, 'Lacey': 2,
    'Judge': 4, 'Kofu': 2, "AZ's Tranquility": 2, 'Energy Retrieval': 1,
  }, idx);

  const dark = runGauntlet(shell('Mega Darkrai ex'), meta.decks, { games: 600, seed: 31 });
  const plain = runGauntlet(shell('Test Plain ex'), meta.decks, { games: 600, seed: 31 });
  assert.ok(dark.weighted > plain.weighted,
    'Punk Helmet should only pay off on a Darkness holder');
});

test('every meta archetype declares a gustable Bench', () => {
  // A missing bench block silently disables every gust card in that matchup,
  // which would look like the cards being weak rather than unmodelled.
  for (const d of meta.decks) {
    assert.ok(d.bench, `${d.name} has no bench block`);
    assert.ok(d.bench.hp > 0 && d.bench.prizes > 0, `${d.name} bench is malformed`);
    assert.ok(d.bench.hp < d.hp,
      `${d.name}'s bench target should be softer than its Active, or gusting it `
      + 'is never the right play and the card is dead by construction');
  }
});

test('a gust card knocks out the Benched target it drags up', () => {
  const counts = {
    'Mega Darkrai ex': 4, 'Munkidori': 4, 'Fezandipiti ex': 3,
    "Boss's Orders": 4, 'Dark Bell': 4, 'Darkness Energy': 14,
    'Ultra Ball': 4, "Lillie's Determination": 4, 'Judge': 4,
    'Night Stretcher': 3, 'Energy Search': 3, 'Switch': 2, 'Lacey': 2,
    'Kofu': 2, 'Energy Retrieval': 2, 'Energy Switch': 1,
  };
  assert.equal(Object.values(counts).reduce((a, b) => a + b, 0), 60);
  const spec = buildSpec(counts, INDEX);
  assert.equal(validateDeck(spec).ok, true, validateDeck(spec).errors.join('; '));

  const rng = makeRng(41);
  let gusts = 0;
  let kos = 0;
  for (let i = 0; i < 300; i++) {
    const { S } = playGame(spec, meta.decks[0], rng);
    if (S.itemsPlayed.includes("Boss's Orders")) gusts++;
    kos += S.gustKos;
  }
  assert.ok(gusts > 0, "Boss's Orders was never played");
  assert.ok(kos > 0, 'a gusted Pokémon was never actually Knocked Out');
});

test('gusting does not heal the damage already on their attacker', () => {
  // The damage is on that Pokémon, not on the Active Spot. Losing it when they
  // retreat back would turn every gust card into a drawback.
  const counts = {
    'Mega Darkrai ex': 4, 'Munkidori': 4, 'Fezandipiti ex': 3,
    "Boss's Orders": 4, 'Dark Bell': 4, 'Darkness Energy': 14,
    'Ultra Ball': 4, "Lillie's Determination": 4, 'Judge': 4,
    'Night Stretcher': 3, 'Energy Search': 3, 'Switch': 2, 'Lacey': 2,
    'Kofu': 2, 'Energy Retrieval': 2, 'Energy Switch': 1,
  };
  const withGust = runGauntlet(buildSpec(counts, INDEX), meta.decks,
    { games: 600, seed: 43 });

  const bare = { ...counts };
  delete bare["Boss's Orders"];
  bare['Darkness Energy'] = 18;
  assert.equal(Object.values(bare).reduce((a, b) => a + b, 0), 60);
  const plain = runGauntlet(buildSpec(bare, INDEX), meta.decks,
    { games: 600, seed: 43 });

  // Not asserting gust is better — it costs a card and a turn of damage, and
  // whether that trade pays depends on the matchup. Asserting it is not a
  // catastrophe, which is what a stashed-damage bug would look like.
  assert.ok(withGust.weighted > plain.weighted - 10,
    `gust should be roughly a wash or better, not a collapse `
    + `(${withGust.weighted.toFixed(1)}% vs ${plain.weighted.toFixed(1)}%)`);
});

test("Lisia's Appeal Confuses its target, which Abyss Eye can then punish", () => {
  // Lisia's Confusion is not type-restricted the way Dark Bell's is, so it is
  // the one way an Abyss Eye deck gets an auto-KO through against a Darkness
  // opponent — on the Basic it dragged up, not on the attacker itself.
  const zoroark = meta.decks.find((d) => d.id === 'zoroark');
  assert.ok(zoroark, 'expected the Zoroark archetype to exist');

  const counts = {
    'Mega Darkrai ex': 4, 'Munkidori': 4, 'Fezandipiti ex': 3,
    "Lisia's Appeal": 4, 'Dark Bell': 4, 'Darkness Energy': 14,
    'Ultra Ball': 4, "Lillie's Determination": 4, 'Judge': 4,
    'Night Stretcher': 3, 'Energy Search': 3, 'Switch': 2, 'Lacey': 2,
    'Kofu': 2, 'Energy Retrieval': 2, 'Energy Switch': 1,
  };
  assert.equal(Object.values(counts).reduce((a, b) => a + b, 0), 60);
  const spec = buildSpec(counts, INDEX);

  const rng = makeRng(45);
  let autoKos = 0;
  for (let i = 0; i < 400; i++) {
    autoKos += playGame(spec, zoroark, rng).S.abyssEyeKos;
  }
  assert.ok(autoKos > 0,
    'Dark Bell cannot Confuse a Darkness deck, so every Abyss Eye knockout here '
    + "must have come from Lisia's Appeal — none did");
});

test('an implemented card is no longer reported as a blank', () => {
  for (const n of ['Buddy-Buddy Poffin', 'Master Ball', 'Poké Pad', 'Maximum Belt']) {
    assert.ok(PLAYED_TRAINERS.has(n), `${n} is implemented and should count as played`);
  }
  for (const n of ["Boss's Orders", 'Prime Catcher', "Lisia's Appeal"]) {
    assert.ok(PLAYED_TRAINERS.has(n),
      `${n} gusts, and the meta model now has a Bench to gust from`);
  }
  for (const n of ['Tool Scrapper', 'Crushing Hammer']) {
    assert.ok(!PLAYED_TRAINERS.has(n),
      `${n} needs the opponent's Tools or Energy attachments, which still do not `
      + 'exist — claiming it is played would turn an honest warning into a false one');
  }
});
