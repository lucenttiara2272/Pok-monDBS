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
import { makeCardIndex, buildSpec, PRESETS } from '../src/decks.js';
import { candidatePool } from '../src/optimise.js';

const PRESETS_OPTIMISED = PRESETS['Optimised (43%)'];

/** The optimiser's candidate pool for a given deck, for reachability checks. */
const candidatePoolFrom = (counts) => candidatePool(counts, INDEX);

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

test('a Supporter gust is played once the draw engine is not being held up', () => {
  // No Dark Bell here, so there is no auto-knockout to trade down from and
  // gusting is a real option. It still waits for a turn where no refill is in
  // hand, or for the prize that ends the game.
  const counts = {
    'Mega Darkrai ex': 4, 'Munkidori': 4, 'Fezandipiti ex': 3,
    "Boss's Orders": 4, 'Darkness Energy': 18,
    'Ultra Ball': 4, "Lillie's Determination": 4, 'Night Stretcher': 3,
    'Energy Search': 3, 'Switch': 2, 'Lacey': 2, 'Kofu': 2,
    'Energy Retrieval': 3, 'Energy Switch': 4,
  };
  assert.equal(Object.values(counts).reduce((a, b) => a + b, 0), 60);
  const spec = buildSpec(counts, INDEX);
  assert.equal(validateDeck(spec).ok, true, validateDeck(spec).errors.join('; '));

  const rng = makeRng(41);
  let gusts = 0;
  for (const deck of meta.decks) {
    for (let i = 0; i < 120; i++) {
      const { S } = playGame(spec, deck, rng);
      if (S.itemsPlayed.includes("Boss's Orders")) gusts++;
    }
  }
  assert.ok(gusts > 0, "Boss's Orders was never played");
});

test('a gust is never spent while a bigger knockout is available', () => {
  // This replaces a win-rate comparison that asserted adding Boss's Orders was
  // "roughly a wash". That premise was wrong and the failing test was right:
  // against a model whose Bench is one generic one-prize body, spending a turn
  // there instead of on a two-prize Abyss Eye is a losing trade, and four copies
  // cost the deck fourteen points. Tuning until the old assertion passed would
  // have meant inventing value the opponent model cannot represent.
  //
  // What is worth pinning is the policy rule that came out of it: never trade
  // down. Dark Bell in hand plus the Energy to pay for Abyss Eye means an
  // auto-knockout is live, and no gust should be played into that.
  const counts = {
    'Mega Darkrai ex': 4, 'Munkidori': 4, 'Fezandipiti ex': 3,
    'Prime Catcher': 4, 'Dark Bell': 4, 'Darkness Energy': 16,
    'Ultra Ball': 4, "Lillie's Determination": 4, 'Judge': 4,
    'Night Stretcher': 3, 'Energy Search': 3, 'Switch': 2, 'Lacey': 2,
    'Kofu': 2, 'Energy Retrieval': 1,
  };
  assert.equal(Object.values(counts).reduce((a, b) => a + b, 0), 60);
  const spec = buildSpec(counts, INDEX);

  // Dragapult is not a Darkness deck, so Dark Bell works against it and Abyss
  // Eye is the better line whenever it is payable.
  const rng = makeRng(43);
  let withBell = 0;
  for (let i = 0; i < 300; i++) {
    withBell += playGame(spec, meta.decks[0], rng).S.abyssEyeKos;
  }
  assert.ok(withBell > 0, 'Abyss Eye should still be doing the heavy lifting here');
});

test('an Item gust can be played without stalling the draw engine', () => {
  // Prime Catcher is an Item, so it costs no Supporter slot and can be spent on
  // the prize maths alone. Boss's Orders competes with the deck's refill, which
  // is why the two are gated differently.
  const counts = {
    'Mega Darkrai ex': 4, 'Munkidori': 4, 'Fezandipiti ex': 3,
    'Prime Catcher': 4, 'Darkness Energy': 18,
    'Ultra Ball': 4, "Lillie's Determination": 4, 'Judge': 4,
    'Night Stretcher': 3, 'Energy Search': 3, 'Switch': 2, 'Lacey': 2,
    'Kofu': 2, 'Energy Retrieval': 3,
  };
  assert.equal(Object.values(counts).reduce((a, b) => a + b, 0), 60);
  const spec = buildSpec(counts, INDEX);

  const rng = makeRng(44);
  let played = 0;
  let kos = 0;
  for (const deck of meta.decks) {
    for (let i = 0; i < 120; i++) {
      const { S } = playGame(spec, deck, rng);
      if (S.itemsPlayed.includes('Prime Catcher')) played++;
      kos += S.gustKos;
    }
  }
  assert.ok(played > 0, 'Prime Catcher was never played');
  assert.ok(kos > 0, 'a gusted Pokémon was never actually Knocked Out');
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

test('Scoop Up Cyclone saves a Pokémon that was about to be Knocked Out', () => {
  // Denying a knockout on a Mega denies three Prizes, which is why this is worth
  // a card in a deck like this and not in most others.
  const counts = {
    'Mega Darkrai ex': 4, 'Munkidori': 4, 'Fezandipiti ex': 4,
    'Scoop Up Cyclone': 1, 'Dark Bell': 4, 'Darkness Energy': 15,
    'Ultra Ball': 4, "Lillie's Determination": 4, 'Judge': 4,
    'Night Stretcher': 3, 'Energy Search': 3, 'Switch': 2, 'Lacey': 2,
    'Kofu': 2, 'Energy Retrieval': 2, 'Energy Switch': 2,
  };
  assert.equal(Object.values(counts).reduce((a, b) => a + b, 0), 60);
  const spec = buildSpec(counts, INDEX);
  assert.equal(validateDeck(spec).ok, true, validateDeck(spec).errors.join('; '));

  const rng = makeRng(61);
  let played = 0;
  for (let i = 0; i < 300; i++) {
    if (playGame(spec, meta.decks[0], rng).S.itemsPlayed.includes('Scoop Up Cyclone')) {
      played++;
    }
  }
  assert.ok(played > 0, 'Scoop Up Cyclone was never played');
});

test('Dangerous Laser turns on Abyss Eye against a Darkness deck', () => {
  // Dark Bell cannot Confuse a Darkness Pokémon, so Abyss Eye is dead against
  // Zoroark. Dangerous Laser has no such restriction and needs no new engine
  // code — chooseAttack finds it by capability, exactly like Dark Bell.
  const zoroark = meta.decks.find((d) => d.id === 'zoroark');
  const counts = {
    'Mega Darkrai ex': 4, 'Munkidori': 4, 'Fezandipiti ex': 4,
    'Dangerous Laser': 1, 'Darkness Energy': 20,
    'Ultra Ball': 4, "Lillie's Determination": 4, 'Judge': 4,
    'Night Stretcher': 3, 'Energy Search': 3, 'Switch': 2, 'Lacey': 2,
    'Kofu': 2, 'Energy Retrieval': 3,
  };
  assert.equal(Object.values(counts).reduce((a, b) => a + b, 0), 60);
  const spec = buildSpec(counts, INDEX);

  const rng = makeRng(62);
  let kos = 0;
  for (let i = 0; i < 400; i++) kos += playGame(spec, zoroark, rng).S.abyssEyeKos;
  assert.ok(kos > 0,
    'no enabler here is type-restricted, so Abyss Eye should still knock out');
});

test('Deluxe Bomb retaliates once and is then discarded', () => {
  // 120 retaliate every turn would be a different and much stronger card.
  const bomb = INDEX['Deluxe Bomb'];
  assert.equal(bomb.sim.retaliate, 120);
  assert.equal(bomb.sim.discardAfterRetaliate, true);

  // And it overshoots Terminal Period's exact 60, so the combo search must not
  // offer it as a piece — the cap check exists for precisely this card.
  const pool = candidatePoolFrom({ 'Mega Absol ex': 4, 'Munkidori': 4 });
  assert.ok(!pool.includes('Deluxe Bomb'),
    '120 retaliate can never leave an opponent sitting on exactly 60');
});

test('ACE SPEC cards are flagged and capped at one copy', () => {
  // The whole set was marked "max": 4 with no flag of any kind, so nothing
  // stopped a deck running four Prime Catcher.
  const aces = cards.cards.filter((c) => c.aceSpec);
  assert.ok(aces.length >= 10, `only ${aces.length} ACE SPEC cards flagged`);
  for (const c of aces) {
    assert.equal(c.max, 1, `${c.name} is ACE SPEC and must cap at 1 copy`);
  }
  // Spot-check one that is easy to miss: Hero's Cape reads like an ordinary Tool.
  assert.ok(aces.some((c) => c.name === "Hero's Cape"),
    "Hero's Cape (TEF 152) is ACE SPEC despite looking like a plain Tool");
});

test('two different ACE SPEC cards is an error, not a warning', () => {
  const counts = { ...PRESETS_OPTIMISED };
  counts['Darkness Energy'] -= 2;
  counts['Prime Catcher'] = 1;
  counts['Maximum Belt'] = 1;
  const v = validateDeck(buildSpec(counts, INDEX));
  assert.equal(v.ok, false, 'one of each ACE SPEC is still illegal');
  assert.ok(v.errors.some((e) => /ACE SPEC/.test(e)), v.errors.join('; '));

  // One on its own is fine.
  const legal = { ...PRESETS_OPTIMISED };
  legal['Darkness Energy'] -= 1;
  legal['Prime Catcher'] = 1;
  assert.equal(validateDeck(buildSpec(legal, INDEX)).ok, true);
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
