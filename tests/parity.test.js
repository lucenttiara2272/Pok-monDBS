/**
 * Parity + calibration tests.
 *
 * These are the gate on the JS engine. Two things must hold:
 *   1. CALIBRATION — an ordinary control shell scores ~50%. If it doesn't, the
 *      opponent model is mis-tuned and every other number is meaningless.
 *   2. PARITY — the JS engine reproduces the Python reference results within
 *      Monte Carlo noise.
 *
 * Run: node --test tests/
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { runGauntlet, validateDeck, mulliganRate, deckStats } from '../src/engine.js';
import { makeCardIndex, buildSpec, PRESETS, applyControlOverride } from '../src/decks.js';

const here = dirname(fileURLToPath(import.meta.url));
const cards = JSON.parse(readFileSync(join(here, '../data/cards.json'), 'utf8'));
const meta = JSON.parse(readFileSync(join(here, '../data/meta.json'), 'utf8'));
const INDEX = makeCardIndex(cards);
const METendl = meta.decks;

/** Python reference results (python/ptcg_sim.py, 6000 games/matchup). */
const PY = {
  control: 52.8,
  asSent: 28.6,
  optimised: 43.4,
};
const TOL = 6.0;   // Monte Carlo + RNG-implementation slack, in percentage points

function gauntlet(preset, { control = false, games = 4000, seed = 20260803 } = {}) {
  let spec = buildSpec(PRESETS[preset], INDEX);
  if (control) spec = applyControlOverride(spec);
  return runGauntlet(spec, METendl, { games, seed });
}

test('calibration: control shell lands near 50%', () => {
  const r = gauntlet('Control (calibration)', { control: true });
  assert.ok(
    r.weighted > 42 && r.weighted < 62,
    `control scored ${r.weighted.toFixed(1)}% — engine is mis-calibrated, ` +
    'no other result can be trusted',
  );
});

test('parity: control matches the Python reference', () => {
  const r = gauntlet('Control (calibration)', { control: true });
  assert.ok(
    Math.abs(r.weighted - PY.control) < TOL,
    `control JS ${r.weighted.toFixed(1)}% vs Python ${PY.control}%`,
  );
});

test('parity: as-sent list matches the Python reference', () => {
  const r = gauntlet('As sent (61 cards)');
  assert.ok(
    Math.abs(r.weighted - PY.asSent) < TOL,
    `as-sent JS ${r.weighted.toFixed(1)}% vs Python ${PY.asSent}%`,
  );
});

test('parity: optimised list matches the Python reference', () => {
  const r = gauntlet('Optimised (43%)');
  assert.ok(
    Math.abs(r.weighted - PY.optimised) < TOL,
    `optimised JS ${r.weighted.toFixed(1)}% vs Python ${PY.optimised}%`,
  );
});

test('the optimised build beats the as-sent build', () => {
  const a = gauntlet('As sent (61 cards)').weighted;
  const b = gauntlet('Optimised (43%)').weighted;
  assert.ok(b > a + 8, `expected a clear improvement, got ${a.toFixed(1)}% -> ${b.toFixed(1)}%`);
});

test('Abyss Eye does nothing to N\'s Zoroark ex (Darkness is immune to Dark Bell)', () => {
  const r = gauntlet('Optimised (43%)');
  const zoro = r.matchups["N's Zoroark ex"].winrate;
  const drag = r.matchups['Dragapult ex'].winrate;
  assert.ok(zoro < drag - 15,
    `Zoroark ${zoro.toFixed(1)}% should be far worse than Dragapult ${drag.toFixed(1)}%`);
});

test('deck validation catches the 61-card list', () => {
  const spec = buildSpec(PRESETS['As sent (61 cards)'], INDEX);
  const v = validateDeck(spec);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.includes('61')), v.errors.join('; '));
});

test('deck validation accepts the optimised list', () => {
  const spec = buildSpec(PRESETS['Optimised (43%)'], INDEX);
  const v = validateDeck(spec);
  assert.equal(v.ok, true, v.errors.join('; '));
});

test('validation enforces the 4-copy limit but exempts basic Energy', () => {
  const spec = buildSpec(PRESETS['Optimised (43%)'], INDEX);
  assert.equal(spec['Darkness Energy'].n, 14);
  assert.equal(validateDeck(spec).ok, true);      // 14 basic Energy is legal

  spec['Ultra Ball'].n = 5;
  const v = validateDeck(spec);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.includes('Ultra Ball')));
});

test('mulligan maths matches the closed-form hypergeometric', () => {
  const spec = buildSpec(PRESETS['As sent (61 cards)'], INDEX);
  // 8 Pokémon in 61 cards: C(53,7)/C(61,7)
  assert.ok(Math.abs(mulliganRate(spec) * 100 - 35.33) < 0.1,
    `got ${(mulliganRate(spec) * 100).toFixed(2)}%`);

  const opt = buildSpec(PRESETS['Optimised (43%)'], INDEX);
  const s = deckStats(opt);
  assert.equal(s.size, 60);
  assert.equal(s.pokemon, 12);
  assert.ok(s.mulligan < 25);
});

test('results are deterministic for a fixed seed', () => {
  const a = gauntlet('Optimised (43%)', { games: 800, seed: 42 }).weighted;
  const b = gauntlet('Optimised (43%)', { games: 800, seed: 42 }).weighted;
  assert.equal(a, b);
});
