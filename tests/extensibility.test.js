/**
 * Extensibility tests.
 *
 * The point of the card database is that adding a card to data/cards.json (or via the
 * in-app "Add card" form) is enough to make it work — no engine edit required.
 * These tests hold the engine to that promise.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { runGauntlet, playGame, makeRng, deckSize, validateDeck } from '../src/engine.js';
import { makeCardIndex, buildSpec } from '../src/decks.js';

const here = dirname(fileURLToPath(import.meta.url));
const cards = JSON.parse(readFileSync(join(here, '../data/cards.json'), 'utf8'));
const meta = JSON.parse(readFileSync(join(here, '../data/meta.json'), 'utf8'));
const INDEX = makeCardIndex(cards);

/** A card defined purely as data, exactly as the Add-card form would emit it. */
const CUSTOM = {
  id: 'test-slugger-ex',
  name: 'Test Slugger ex',
  set: 'TEST 1',
  category: 'pokemon',
  type: 'D',
  max: 4,
  text: 'Big Swing [D][D] 250.',
  sim: {
    basic: true, hp: 300, prizes: 2, retreat: 2, role: 'attacker',
    attacks: [{ name: 'Big Swing', cost: { D: 2 }, damage: 250 }],
  },
};
const INDEX2 = makeCardIndex({ cards: [...cards.cards, CUSTOM] });

const withSlugger = {
  'Test Slugger ex': 4, 'Munkidori': 4, 'Fezandipiti ex': 2,
  'Darkness Energy': 14, 'Ultra Ball': 4, 'Night Stretcher': 3,
  'Energy Search': 4, 'Energy Retrieval': 3, 'Energy Switch': 2, 'Switch': 2,
  "Lillie's Determination": 4, "Boss's Orders": 3, "Black Belt's Training": 2,
  "Janine's Secret Art": 2, "AZ's Tranquility": 2, "Lisia's Appeal": 2, 'Powerglass': 1,
};

test('a card added only as data can attack', () => {
  const spec = buildSpec(withSlugger, INDEX2);
  assert.equal(deckSize(spec), 58);          // shape of the probe, not a legal deck

  const r = runGauntlet(spec, meta.decks, { games: 600, seed: 11 });
  assert.ok(r.weighted > 5,
    `a 300 HP / 250 damage attacker should win sometimes, got ${r.weighted.toFixed(1)}%`);

  // and it must actually be swinging, not just sitting there
  const rng = makeRng(3);
  let attacked = 0;
  for (let i = 0; i < 400; i++) {
    const g = playGame(spec, meta.decks[0], rng);
    if (g.S.firstAttackTurn !== null) attacked++;
  }
  assert.ok(attacked > 200, `expected most games to see an attack, saw ${attacked}/400`);
});

test('energy costs are enforced — [C] takes anything, typed symbols do not', () => {
  const cheap = { ...CUSTOM, name: 'Cheap ex', id: 'cheap-ex',
    sim: { ...CUSTOM.sim, attacks: [{ name: 'Free Hit', cost: { C: 1 }, damage: 250 }] } };
  const dear = { ...CUSTOM, name: 'Dear ex', id: 'dear-ex',
    sim: { ...CUSTOM.sim, attacks: [{ name: 'Slow Hit', cost: { D: 4 }, damage: 250 }] } };
  const idx = makeCardIndex({ cards: [...cards.cards, cheap, dear] });

  const mk = (n) => buildSpec({ ...withSlugger, 'Test Slugger ex': 0, [n]: 4 }, idx);
  const a = runGauntlet(mk('Cheap ex'), meta.decks, { games: 500, seed: 5 }).weighted;
  const b = runGauntlet(mk('Dear ex'), meta.decks, { games: 500, seed: 5 }).weighted;

  assert.ok(a > b,
    `a 1-Energy attack should beat an identical 4-Energy one (${a.toFixed(1)}% vs ${b.toFixed(1)}%)`);
});

test('Mega Kangaskhan ex is in the database with its real stats', () => {
  const k = INDEX['Mega Kangaskhan ex'];
  assert.ok(k, 'Mega Kangaskhan ex missing from cards.json');
  assert.equal(k.sim.hp, 300);
  assert.equal(k.sim.prizes, 3);            // Mega Evolution ex
  assert.equal(k.type, 'C');                // Colorless
  assert.equal(k.sim.attacks[0].cost.C, 3); // [C][C][C]
  assert.ok(k.warning, 'the Dark Bell self-Confusion trap should be flagged on the card');
});

test('Dark Bell Confuses your own non-Darkness attacker too', () => {
  // Same shell twice: once with a Darkness attacker, once Colorless. Dark Bell
  // Confuses "both Active non-[D] Pokemon", so the Colorless build should whiff
  // its own attacks about half the time it uses the auto-KO line.
  const shell = {
    'Dark Bell': 4, 'Munkidori': 4, 'Darkness Energy': 16, 'Ultra Ball': 4,
    'Night Stretcher': 3, 'Energy Search': 4, 'Energy Retrieval': 3,
    'Energy Switch': 2, 'Switch': 2, "Lillie's Determination": 4,
    "Boss's Orders": 3, "Janine's Secret Art": 2, "Lisia's Appeal": 2,
  };
  const darkMon = { ...CUSTOM, name: 'Dark Bomber ex', id: 'dark-bomber', type: 'D',
    sim: { ...CUSTOM.sim, attacks: [{ name: 'Doom', cost: { D: 3 }, koIfSpecialCondition: true }] } };
  const colorMon = { ...darkMon, name: 'Plain Bomber ex', id: 'plain-bomber', type: 'C',
    sim: { ...darkMon.sim, attacks: [{ name: 'Doom', cost: { C: 3 }, koIfSpecialCondition: true }] } };
  const idx = makeCardIndex({ cards: [...cards.cards, darkMon, colorMon] });

  const dk = runGauntlet(buildSpec({ ...shell, 'Dark Bomber ex': 4 }, idx),
    meta.decks, { games: 900, seed: 21 }).weighted;
  const cl = runGauntlet(buildSpec({ ...shell, 'Plain Bomber ex': 4 }, idx),
    meta.decks, { games: 900, seed: 21 }).weighted;

  assert.ok(dk > cl,
    `the Darkness attacker should beat the identical Colorless one because Dark Bell ` +
    `cannot Confuse it (${dk.toFixed(1)}% vs ${cl.toFixed(1)}%)`);
});

test('the engine attaches Energy of any type, not just Darkness', () => {
  // Regression: Energy attachment was hardcoded to Darkness, so a Fire/Psychic
  // deck never attached anything and silently scored 0% in every matchup.
  const fire = {
    id: 'blaze-ex', name: 'Blaze ex', set: 'PBL 1', category: 'pokemon', type: 'R',
    max: 4, text: 'Inferno [R][R] 200.',
    sim: { stage: 0, basic: true, hp: 280, prizes: 2, retreat: 1, role: 'attacker',
      attacks: [{ name: 'Inferno', cost: { R: 2 }, damage: 200 }] },
  };
  const idx = makeCardIndex({ cards: [...cards.cards, fire] });
  const spec = buildSpec({
    'Blaze ex': 4, 'Munkidori': 4, 'Fezandipiti ex': 2, 'Fire Energy': 14,
    'Ultra Ball': 4, 'Night Stretcher': 3, 'Energy Search': 4, 'Switch': 2,
    "Lillie's Determination": 4, "Boss's Orders": 3, 'Lacey': 2,
    // 1 Master Ball, no Prime Catcher: both are ACE SPEC and a deck gets one.
    'Buddy-Buddy Poffin': 4, 'Master Ball': 1, 'Poké Pad': 3,
    'Energy Retrieval': 4, 'Judge': 2,
  }, idx);

  const rng = makeRng(4);
  let attacked = 0;
  for (let i = 0; i < 300; i++) {
    if (playGame(spec, meta.decks[0], rng).S.firstAttackTurn !== null) attacked++;
  }
  assert.ok(attacked > 150,
    `a Fire deck must actually attack; only ${attacked}/300 games saw an attack`);

  const r = runGauntlet(spec, meta.decks, { games: 600, seed: 4 });
  assert.ok(r.weighted > 10,
    `a 280 HP / 200 damage Fire attacker should not score ${r.weighted.toFixed(1)}%`);
});

test('an Energy cost is paid with the right type', () => {
  // Same shell, but the Energy in the deck does not match the attack cost.
  const fire = {
    id: 'blaze2-ex', name: 'Blaze2 ex', set: 'PBL 1', category: 'pokemon', type: 'R',
    max: 4, text: 'Inferno [R][R] 200.',
    sim: { stage: 0, basic: true, hp: 280, prizes: 2, retreat: 1, role: 'attacker',
      attacks: [{ name: 'Inferno', cost: { R: 2 }, damage: 200 }] },
  };
  const idx = makeCardIndex({ cards: [...cards.cards, fire] });
  const shell = (energy) => buildSpec({
    'Blaze2 ex': 4, 'Munkidori': 4, 'Fezandipiti ex': 2, [energy]: 14,
    'Ultra Ball': 4, 'Night Stretcher': 3, 'Energy Search': 4, 'Switch': 2,
    "Lillie's Determination": 4, "Boss's Orders": 3, 'Lacey': 2,
    // 1 Master Ball, no Prime Catcher: both are ACE SPEC and a deck gets one.
    'Buddy-Buddy Poffin': 4, 'Master Ball': 1, 'Poké Pad': 3,
    'Energy Retrieval': 4, 'Judge': 2,
  }, idx);

  const right = runGauntlet(shell('Fire Energy'), meta.decks, { games: 600, seed: 6 });
  const wrong = runGauntlet(shell('Water Energy'), meta.decks, { games: 600, seed: 6 });
  assert.ok(right.weighted > wrong.weighted + 5,
    `[R][R] must not be payable with Water Energy `
    + `(Fire ${right.weighted.toFixed(1)}% vs Water ${wrong.weighted.toFixed(1)}%)`);
});

test('search fetches the next evolution piece, not another Basic', () => {
  // The Basic-attacker branch is skipped for a Stage 2 deck, so every search
  // used to fall through to basicsLeadingToAttackers and return Dreepy. A deck
  // could sit on three Dreepy tutoring a fourth while the Drakloak it needed
  // stayed in the deck — the engine could not assemble its own line at all.
  const counts = {
    'Dreepy': 4, 'Drakloak': 4, 'Dragapult ex': 3, 'Munkidori': 2,
    'Rare Candy': 4, 'Ultra Ball': 4, 'Buddy-Buddy Poffin': 4,
    'Night Stretcher': 3, 'Switch': 2, "Lillie's Determination": 4,
    'Lacey': 2, 'Judge': 4, 'Master Ball': 1, 'Poké Pad': 3,
    'Fire Energy': 8, 'Psychic Energy': 8,
  };
  assert.equal(Object.values(counts).reduce((a, b) => a + b, 0), 60);
  const spec = buildSpec(counts, INDEX);

  const rng = makeRng(21);
  let evolved = 0;
  let attacked = 0;
  for (let i = 0; i < 300; i++) {
    const { S } = playGame(spec, meta.decks[0], rng);
    if (S.inPlay().some((m) => m.name === 'Dragapult ex')
        || S.discard.includes('Dragapult ex')) evolved++;
    if (S.firstAttackTurn !== null) attacked++;
  }
  assert.ok(evolved > 90,
    `a Dragapult deck should reach Dragapult in most games; only ${evolved}/300`);
  assert.ok(attacked > 150, `only ${attacked}/300 games saw an attack`);
});

test('evolution decks are flagged as under-played rather than silently wrong', () => {
  const spec = buildSpec({
    'Dreepy': 4, 'Drakloak': 4, 'Dragapult ex': 3, 'Munkidori': 2, 'Fezandipiti ex': 1,
    'Rare Candy': 4, 'Ultra Ball': 4, 'Buddy-Buddy Poffin': 4, 'Night Stretcher': 3,
    'Switch': 2, "Lillie's Determination": 4, "Boss's Orders": 3, 'Lacey': 2,
    'Poké Pad': 3, 'Master Ball': 1, 'Fire Energy': 8, 'Psychic Energy': 8,
  }, INDEX);
  const v = validateDeck(spec);
  assert.equal(v.ok, true, v.errors.join('; '));
  // Matched on the stable parts of the message. Pinning an exact phrase means
  // every rewording breaks the test for no reason, which is how this one broke.
  assert.ok(v.warnings.some((w) => /Stage 2/.test(w) && /lower bound/.test(w)),
    `expected a warning that Stage 2 decks are under-played, got: ${v.warnings.join(' | ')}`);
});
