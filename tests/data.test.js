/**
 * Data integrity tests.
 *
 * These catch the failure mode that breaks the UI silently: a card name in a preset
 * that doesn't exist in cards.json, or a card missing the fields the engine reads.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { makeCardIndex, buildSpec, PRESETS } from '../src/decks.js';
import { deckSize, deckStats, DRAW_SUPPORTERS } from '../src/engine.js';

const here = dirname(fileURLToPath(import.meta.url));
const cards = JSON.parse(readFileSync(join(here, '../data/cards.json'), 'utf8'));
const meta = JSON.parse(readFileSync(join(here, '../data/meta.json'), 'utf8'));
const INDEX = makeCardIndex(cards);

test('every card has the fields the UI needs', () => {
  for (const c of cards.cards) {
    assert.ok(c.id, `missing id: ${JSON.stringify(c).slice(0, 60)}`);
    assert.ok(c.name, `missing name on ${c.id}`);
    assert.ok(c.set, `missing set on ${c.name}`);
    assert.ok(
      ['pokemon', 'item', 'tool', 'supporter', 'stadium', 'energy'].includes(c.category),
      `bad category on ${c.name}: ${c.category}`,
    );
    assert.ok(c.text, `missing text on ${c.name}`);
    assert.ok(c.max === null || c.max > 0, `bad max on ${c.name}`);
  }
});

test('every category in the database is one the UI can render', () => {
  // The deck editor iterates a fixed CATS list. A category outside it means cards
  // sit in the deck invisibly and still count toward 60 — which is how the
  // imported Stadium cards first slipped through.
  const ui = readFileSync(join(here, '../src/ui.js'), 'utf8');
  const m = ui.match(/const CATS = \[(.*?)\];/s);
  assert.ok(m, 'could not find CATS in src/ui.js');
  const rendered = new Set(m[1].match(/'([a-z]+)'/g).map((s) => s.replace(/'/g, '')));

  for (const c of cards.cards) {
    assert.ok(rendered.has(c.category),
      `${c.name} is a "${c.category}" but the deck editor only renders `
      + `${[...rendered].join(', ')}`);
  }
});

test('no card cites a set outside the format', () => {
  // Applies to hand-written cards too, not just imported ones. Curated entries
  // originally carried SVI printings for staples like Switch and Energy Search —
  // the cards are legal via reprints, but quoting a rotated set is misleading to
  // anyone checking a decklist against it.
  const format = JSON.parse(readFileSync(join(here, '../data/format.json'), 'utf8'));
  const legal = new Set(format.legalSets);
  const bad = cards.cards
    .filter((c) => !legal.has((c.set || '').split(' ')[0].toUpperCase()));
  assert.equal(bad.length, 0,
    `not legal in ${format.format}: ${bad.slice(0, 6).map((c) => `${c.name} (${c.set})`).join(', ')}`);
});

test('Stadium cards count as Trainers in the deck stats', () => {
  const stadium = cards.cards.find((c) => c.category === 'stadium');
  if (!stadium) return;                       // none imported yet, nothing to check
  const spec = buildSpec({ [stadium.name]: 2, 'Munkidori': 4 }, INDEX);
  const s = deckStats(spec);
  assert.equal(s.trainers, 2, 'a Stadium is a Trainer card');
  assert.equal(s.pokemon, 4);
  assert.equal(s.size, 6);
});

test('card ids and names are unique', () => {
  const ids = cards.cards.map((c) => c.id);
  const names = cards.cards.map((c) => c.name);
  assert.equal(new Set(ids).size, ids.length, 'duplicate id');
  assert.equal(new Set(names).size, names.length, 'duplicate name');
});

test('every Pokémon carries the stats the engine reads', () => {
  for (const c of cards.cards.filter((x) => x.category === 'pokemon')) {
    assert.ok(c.sim, `${c.name} has no sim block`);
    for (const f of ['hp', 'prizes', 'retreat']) {
      assert.equal(typeof c.sim[f], 'number', `${c.name} missing sim.${f}`);
    }
    assert.ok(c.sim.prizes >= 1 && c.sim.prizes <= 3, `${c.name} odd prize value`);
  }
});

test('Mega Evolution Pokémon ex are recorded as 3-prize', () => {
  for (const c of cards.cards.filter((x) => /^Mega .* ex$/.test(x.name))) {
    assert.equal(c.sim.prizes, 3,
      `${c.name} must give up 3 Prizes — this is the whole point of the archetype`);
  }
});

test('every preset only references cards that exist', () => {
  for (const [label, counts] of Object.entries(PRESETS)) {
    for (const name of Object.keys(counts)) {
      assert.ok(INDEX[name], `preset "${label}" references unknown card "${name}"`);
    }
    assert.doesNotThrow(() => buildSpec(counts, INDEX), `preset "${label}" failed to build`);
  }
});

test('presets are the sizes they claim to be', () => {
  assert.equal(deckSize(buildSpec(PRESETS['As sent (61 cards)'], INDEX)), 61);
  assert.equal(deckSize(buildSpec(PRESETS['Optimised (43%)'], INDEX)), 60);
  assert.equal(deckSize(buildSpec(PRESETS['Control (calibration)'], INDEX)), 60);
});

test('draw-Supporter list matches actual Supporter cards', () => {
  for (const name of DRAW_SUPPORTERS) {
    assert.ok(INDEX[name], `DRAW_SUPPORTERS names a card that doesn't exist: ${name}`);
    assert.equal(INDEX[name].category, 'supporter', `${name} is not a Supporter`);
  }
});

test('meta shares are sane and sum to less than 100%', () => {
  const tot = meta.decks.reduce((a, d) => a + d.share, 0);
  assert.ok(tot > 50 && tot < 100, `meta covers ${tot.toFixed(1)}%`);
  for (const d of meta.decks) {
    for (const f of ['hp', 'prizes', 'dmg', 'setupMu', 'rebuild', 'whiff']) {
      assert.equal(typeof d[f], 'number', `${d.name} missing ${f}`);
    }
    assert.ok(['high', 'medium'].includes(d.confidence), `${d.name} bad confidence`);
    assert.ok(d.note && d.note.length > 20, `${d.name} needs a sourcing note`);
  }
});

test('Dragapult is still modelled as the dominant deck', () => {
  const top = [...meta.decks].sort((a, b) => b.share - a.share)[0];
  assert.equal(top.id, 'dragapult');
  assert.equal(top.hp, 320);
  assert.equal(top.confidence, 'high');
});

test("N's Zoroark is flagged as a Darkness deck (Dark Bell cannot Confuse it)", () => {
  const z = meta.decks.find((d) => d.id === 'zoroark');
  assert.equal(z.darkType, true);
});
