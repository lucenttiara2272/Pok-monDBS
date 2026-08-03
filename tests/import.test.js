/**
 * Importer transform tests.
 *
 * The network half of tools/import-cards.mjs can't be tested offline, but the
 * mapping from the API's card shape to ours is pure and is where the damaging
 * mistakes live — a wrong prize count or a dropped evolution line would quietly
 * corrupt every simulation run against imported cards.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '../tools/import-cards.mjs'), 'utf8');

/** Pull the pure helpers out of the script without executing main(). */
function loadHelpers() {
  const body = src
    .replace(/^#!.*$/m, '')
    .replace(/^import[\s\S]*?from 'node:path';$/m, '')
    .replace(/const here[\s\S]*?const PAGE_SIZE = 250;/, 'const PAGE_SIZE = 250;')
    .replace(/async function fetchPage[\s\S]*$/m, '');
  // eslint-disable-next-line no-new-func
  return new Function(
    `${body}\nreturn { toCard, prizesOf, symbolise, stageOf, categoryOf, damageOf };`,
  )();
}

const H = loadHelpers();

test('Mega Evolution ex is imported as a 3-prize Pokémon', () => {
  const card = H.toCard({
    id: 'meg-104', name: 'Mega Kangaskhan ex', supertype: 'Pokémon',
    subtypes: ['Basic', 'MEGA', 'ex'], hp: '300', types: ['Colorless'],
    retreatCost: ['Colorless', 'Colorless', 'Colorless'],
    weaknesses: [{ type: 'Fighting' }],
    attacks: [{ name: 'Rapid-Fire Combo', cost: ['Colorless', 'Colorless', 'Colorless'], damage: '200+' }],
    set: { ptcgoCode: 'MEG' }, number: '104',
  });
  assert.equal(card.category, 'pokemon');
  assert.equal(card.sim.prizes, 3, 'Mega ex must give up 3 Prizes');
  assert.equal(card.sim.hp, 300);
  assert.equal(card.sim.retreat, 3);
  assert.equal(card.type, 'C');
  assert.equal(card.sim.weak, 'F');
  assert.deepEqual(card.sim.attacks[0].cost, { C: 3 });
  assert.equal(card.sim.attacks[0].damage, 200, '"200+" should parse to 200');
});

test('a plain ex is 2 prizes and an ordinary Pokémon is 1', () => {
  const mk = (subtypes, name = 'X') => H.toCard({
    name, supertype: 'Pokémon', subtypes, hp: '100', types: ['Darkness'],
    set: { ptcgoCode: 'S' }, number: '1',
  }).sim.prizes;
  assert.equal(mk(['Basic', 'ex'], 'Fezandipiti ex'), 2);
  assert.equal(mk(['Basic']), 1);
  assert.equal(mk(['Stage 1']), 1);
});

test('evolution lines survive the import', () => {
  const card = H.toCard({
    name: 'Dragapult ex', supertype: 'Pokémon', subtypes: ['Stage 2', 'ex'],
    hp: '320', types: ['Dragon'], evolvesFrom: 'Drakloak',
    retreatCost: ['Colorless'],
    attacks: [{ name: 'Phantom Dive', cost: ['Fire', 'Psychic'], damage: '200' }],
    set: { ptcgoCode: 'TWM' }, number: '130',
  });
  assert.equal(card.sim.stage, 2);
  assert.equal(card.sim.evolvesFrom, 'Drakloak');
  assert.equal(card.sim.prizes, 2);
  assert.deepEqual(card.sim.attacks[0].cost, { R: 1, P: 1 },
    'mixed-type Energy costs must map to distinct symbols');
});

test('Basic Pokémon are flagged basic and get no evolvesFrom', () => {
  const card = H.toCard({
    name: 'Munkidori', supertype: 'Pokémon', subtypes: ['Basic'],
    hp: '110', types: ['Darkness'], retreatCost: ['Colorless'],
    set: { ptcgoCode: 'TWM' }, number: '95',
  });
  assert.equal(card.sim.stage, 0);
  assert.equal(card.sim.basic, true);
  assert.equal(card.sim.evolvesFrom, undefined);
  assert.equal(card.sim.role, 'support', 'no attacks means it is not an attacker');
});

test('Trainer subtypes route to the right category', () => {
  const mk = (subtypes) => H.toCard({
    name: 'T', supertype: 'Trainer', subtypes, rules: ['does a thing'],
    set: { ptcgoCode: 'S' }, number: '1',
  }).category;
  assert.equal(mk(['Supporter']), 'supporter');
  assert.equal(mk(['Item']), 'item');
  assert.equal(mk(['Pokémon Tool']), 'tool');
  assert.equal(mk(['Stadium']), 'stadium');
});

test('basic Energy is uncapped, special Energy caps at 4', () => {
  const basic = H.toCard({
    name: 'Basic Darkness Energy', supertype: 'Energy', subtypes: ['Basic'],
    types: ['Darkness'], set: { ptcgoCode: 'MEE' }, number: '7',
  });
  assert.equal(basic.max, null);
  assert.equal(basic.sim.basicEnergy, true);
  assert.equal(basic.sim.provides, 'D');

  const special = H.toCard({
    name: 'Spiky Energy', supertype: 'Energy', subtypes: ['Special'],
    set: { ptcgoCode: 'JTG' }, number: '159',
  });
  assert.equal(special.max, 4);
  assert.equal(special.sim.basicEnergy, false);
});

test('damage strings parse to numbers', () => {
  assert.equal(H.damageOf('120'), 120);
  assert.equal(H.damageOf('200+'), 200);
  assert.equal(H.damageOf('50×'), 50);
  assert.equal(H.damageOf(''), 0);
  assert.equal(H.damageOf(undefined), 0);
});

test('imported cards are marked so curated ones can be told apart', () => {
  const card = H.toCard({
    name: 'Whatever', supertype: 'Trainer', subtypes: ['Item'],
    set: { ptcgoCode: 'S' }, number: '1',
  });
  assert.equal(card.imported, true);
});

test('the importer refuses to write when nothing was fetched', () => {
  assert.match(src, /Leaving data\/cards\.json untouched/,
    'a failed or offline run must not overwrite the curated database');
  assert.match(src, /if \(!pagesOk \|\| seen\.size === 0\)/);
});

test('curated cards are never overwritten by the importer', () => {
  assert.match(src, /if \(curated\.has\(raw\.name\)\) continue;/,
    'hand-written sim blocks encode mechanics the API cannot express');
});
