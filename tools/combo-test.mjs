#!/usr/bin/env node
/**
 * Is the Punk Helmet + Spiky Energy line worth building around?
 *
 * Terminal Period knocks out an opponent sitting on exactly 6 damage counters.
 * Punk Helmet retaliates 40 and Spiky Energy 20, so the pair puts an attacker on
 * exactly 60 the moment it swings into us. The question is whether that is worth
 * eight slots, and the answer depends entirely on the shell:
 *
 *   - Spiky Energy provides [C]. Mega Darkrai's attacks are [D][D] and [D][D][D],
 *     so in a Darkrai deck it is a dead Energy. Mega Absol's are [D][C] and
 *     [D][D][C], so in an Absol deck it is live.
 *   - "Exactly 60" is fragile. Any damage we deal ourselves — Dusk Raid 110,
 *     Claw of Darkness 200 — moves them off 60, and only a knockout resetting
 *     them to zero brings the window back.
 *
 * So a Darkrai-primary list fights its own combo, while an Absol-primary one
 * should be able to loop it: knock out, they promote and attack, retaliate puts
 * them on exactly 60, Terminal Period removes them regardless of HP.
 *
 * Run: node tools/combo-test.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { runGauntlet, playGame, makeRng, validateDeck } from '../src/engine.js';
import { makeCardIndex, buildSpec } from '../src/decks.js';

const here = dirname(fileURLToPath(import.meta.url));
const cards = JSON.parse(readFileSync(join(here, '../data/cards.json'), 'utf8'));
const meta = JSON.parse(readFileSync(join(here, '../data/meta.json'), 'utf8'));
const INDEX = makeCardIndex(cards);

const GAMES = 6000;
const SEED = 20260804;

const DECKS = {
  'Absol-primary, WITH combo': {
    'Mega Absol ex': 4, 'Munkidori': 4, 'Fezandipiti ex': 3,
    'Punk Helmet': 4,
    'Spiky Energy': 4, 'Darkness Energy': 14,
    'Ultra Ball': 4, 'Master Ball': 2, 'Night Stretcher': 3,
    'Energy Search': 3, 'Energy Retrieval': 2, 'Energy Switch': 2, 'Switch': 2,
    "Lillie's Determination": 4, 'Lacey': 2, 'Kofu': 2, "Boss's Orders": 1,
  },

  // Same shell, combo pieces spent on consistency instead. This is the control:
  // if the combo is worth anything, it has to beat its own slots.
  'Absol-primary, NO combo': {
    'Mega Absol ex': 4, 'Munkidori': 4, 'Fezandipiti ex': 3,
    'Darkness Energy': 18,
    'Ultra Ball': 4, 'Master Ball': 3, 'Night Stretcher': 3,
    'Energy Search': 4, 'Energy Retrieval': 2, 'Energy Switch': 2, 'Switch': 3,
    "Lillie's Determination": 4, 'Lacey': 2, 'Kofu': 2, "Boss's Orders": 2,
  },

  // What the optimiser actually built for you (37.4%).
  'Your optimised list': {
    'Fezandipiti ex': 1, 'Mega Absol ex': 2, 'Mega Darkrai ex': 3, 'Munkidori': 3,
    'Dark Bell': 3, 'Energy Retrieval': 2, 'Energy Search': 3, 'Energy Switch': 2,
    'Master Ball': 2, 'Night Stretcher': 3, 'Switch': 2, 'Ultra Ball': 4,
    'Air Balloon': 1,
    "Billy & O'Nare": 1, "Boss's Orders": 2, 'Kofu': 2, 'Lacey': 2,
    "Lillie's Determination": 4,
    'Darkness Energy': 18,
  },

  // Your hand-built version — combo bolted onto a Darkrai shell (34.2%).
  'Your manual combo list': {
    'Fezandipiti ex': 1, 'Mega Absol ex': 2, 'Mega Darkrai ex': 3, 'Munkidori': 3,
    'Dark Bell': 3, 'Energy Retrieval': 2, 'Energy Search': 3, 'Energy Switch': 2,
    'Night Stretcher': 3, 'Switch': 2, 'Ultra Ball': 4,
    'Air Balloon': 1, 'Punk Helmet': 2,
    "Boss's Orders": 2, 'Kofu': 1, 'Lacey': 2, "Lillie's Determination": 4,
    'Darkness Energy': 18, 'Spiky Energy': 2,
  },
};

const pad = (s, n) => String(s).padEnd(n);
const num = (v, n, d = 1) => String(v.toFixed(d)).padStart(n);

console.log(`\n${GAMES} games per matchup, seed ${SEED}, meta as of ${meta.asOf}\n`);
console.log(pad('DECK', 28), num2('WIN%', 7), num2('TERMINAL', 10),
  num2('PER GAME', 10), '  WORST MATCHUP');
console.log('-'.repeat(86));

function num2(s, n) { return String(s).padStart(n); }

const results = [];
for (const [name, counts] of Object.entries(DECKS)) {
  const size = Object.values(counts).reduce((a, b) => a + b, 0);
  const spec = buildSpec(counts, INDEX);
  const v = validateDeck(spec);
  if (size !== 60 || !v.ok) {
    console.log(`${pad(name, 28)}  SKIPPED — ${size} cards; ${v.errors.join('; ')}`);
    continue;
  }

  const r = runGauntlet(spec, meta.decks, { games: GAMES, seed: SEED });

  // Count Terminal Period knockouts directly. The win rate says whether the deck
  // is good; this says whether the combo is actually the reason.
  const rng = makeRng(SEED);
  let kos = 0;
  const sample = 1200;
  for (const deck of meta.decks) {
    for (let i = 0; i < Math.round(sample * (deck.share / 100)); i++) {
      kos += playGame(spec, deck, rng).S.exactDamageKos;
    }
  }

  const worst = Object.entries(r.matchups)
    .sort((a, b) => a[1].winrate - b[1].winrate)[0];

  results.push({ name, win: r.weighted, kos, worst });
  console.log(
    pad(name, 28),
    num(r.weighted, 6) + '%',
    num2(kos, 10),
    num(kos / sample, 10, 3),
    `  ${worst[0]} ${worst[1].winrate.toFixed(1)}%`,
  );

  for (const w of v.warnings) console.log(`${' '.repeat(4)}! ${w}`);
}

const best = [...results].sort((a, b) => b.win - a.win)[0];
const combo = results.find((x) => x.name.includes('WITH combo'));
const control = results.find((x) => x.name.includes('NO combo'));

console.log('\n' + '-'.repeat(86));
if (combo && control) {
  const delta = combo.win - control.win;
  console.log(
    `Combo vs its own slots in the same shell: ${delta >= 0 ? '+' : ''}`
    + `${delta.toFixed(1)} points (${combo.win.toFixed(1)}% vs ${control.win.toFixed(1)}%).`,
  );
  console.log(
    combo.kos === 0
      ? 'Terminal Period never fired — the line is not assembling at all.'
      : `Terminal Period fired ${(combo.kos / 1200).toFixed(2)} times per game.`,
  );
}
console.log(`Best of the four: ${best.name} at ${best.win.toFixed(1)}%.\n`);
