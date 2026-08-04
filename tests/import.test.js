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

/**
 * The importer with comments stripped.
 *
 * Every assertion below that inspects source must use this rather than `src`.
 * Twice now a test that forbade a pattern has failed on the comment explaining
 * why the pattern is forbidden — a source grep cannot tell an explanation from
 * an instruction, and the comments here deliberately quote the wrong versions.
 */
const codeOnly = src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

/** Pull the pure helpers out of the script without executing main(). */
function loadHelpers() {
  const body = src
    .replace(/^#!.*$/m, '')
    .replace(/^import[\s\S]*?from 'node:path';$/m, '')
    .replace(/const here[\s\S]*?const PAGE_SIZE = 250;/, 'const PAGE_SIZE = 250;')
    .replace(/async function fetchPage[\s\S]*$/m, '');
  // eslint-disable-next-line no-new-func
  return new Function(
    `${body}\nreturn { toCard, prizesOf, symbolise, stageOf, categoryOf, damageOf, setQuery };`,
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

test('the importer queries by set, not by the API\'s Standard flag', () => {
  // legalities.standard:legal tracks the real-world rotation; format.json pins
  // the format this project simulates. Trusting the API's flag silently dropped
  // every set it had since rotated out, before the local legalSets check could
  // see them — a run reported new cards while importing none from those sets.
  //
  assert.doesNotMatch(codeOnly, /legalities\.standard:legal/,
    'the API must not be the authority on which sets are legal here');
  assert.match(codeOnly, /set\.ptcgoCode:/,
    'the importer should ask for the sets format.json lists');
});

test('the set query is built in the one form the API accepts', () => {
  // Grouping the terms — (a OR b) — is the obvious way to write this and the
  // API's parser rejects it, returning an empty body rather than an error. The
  // import then completes, reports a plausible count, and silently pulls almost
  // nothing. That cost a whole round trip to notice, because a failed import and
  // a successful one look identical from the summary line.
  // One set per request. Grouping as `(a OR b)` returns an empty body with a
  // 200; a bare `a OR b OR …` across all eighteen sets is long enough to 500 the
  // server. Six sets worked and eighteen did not, so the safe form is one.
  assert.equal(H.setQuery('TEF'), 'set.ptcgoCode:TEF');
  assert.doesNotMatch(H.setQuery('TEF'), /[()]|\bOR\b/,
    'neither grouping nor multi-set OR survives contact with the API');
});

test('a partial fetch refuses to write', () => {
  // The empty-result guard already existed and was not enough. Rate limiting
  // throws mid-fetch, the loop breaks, and every step after it behaves normally
  // — so a run that got half the pool wrote half a database and printed the same
  // summary as a complete one. A dry run projecting 420 new cards silently
  // became 216 written, and only a card count caught it.
  assert.match(codeOnly, /incomplete\.length === 0/,
    'the importer must know whether every set downloaded in full');
  assert.match(codeOnly, /Leaving data\/cards\.json untouched/);
  assert.match(codeOnly, /--partial/,
    'an incomplete import should be possible, but only when asked for');
});

test('basic Energy keeps the name the rest of the project uses', () => {
  // The API says "Basic Darkness Energy"; the presets, the decks and the engine
  // all say "Darkness Energy". Importing the API's name added a second entry for
  // the same card that the curated-card guard could not recognise, and the
  // optimiser started building decks out of it.
  const c = H.toCard({
    name: 'Basic Darkness Energy', supertype: 'Energy', subtypes: ['Basic'],
    types: ['Darkness'], set: { ptcgoCode: 'MEE' }, number: '7',
  });
  assert.equal(c.name, 'Darkness Energy');
  assert.equal(c.sim.basicEnergy, true);

  assert.equal(H.toCard({
    name: 'Basic Fighting Energy', supertype: 'Energy', subtypes: ['Basic'],
    types: ['Fighting'], set: { ptcgoCode: 'MEE' }, number: '6',
  }).name, 'Fighting Energy');

  // Only the "Basic <type> Energy" shape is rewritten. A Trainer that happens to
  // begin with the word keeps its name, or the database quietly loses cards to a
  // rename nobody asked for.
  assert.equal(H.toCard({
    name: 'Basic Research Energy Machine', supertype: 'Trainer',
    subtypes: ['Item'], set: { ptcgoCode: 'TEF' }, number: '99',
  }).name, 'Basic Research Energy Machine');
});

test('an ACE SPEC Special Energy is capped at 1, not 4', () => {
  // The ACE SPEC block used to run before the category branches, and the Energy
  // branch then reassigned max unconditionally. The card came in flagged as
  // restricted and still capped at 4 — the deck builder knew the rule and let
  // you break it anyway.
  const c = H.toCard({
    name: 'Enriching Energy', supertype: 'Energy', subtypes: ['Special'],
    rules: ["ACE SPEC: You can't have more than 1 ACE SPEC card in your deck."],
    set: { ptcgoCode: 'SSP' }, number: '191',
  });
  assert.equal(c.aceSpec, true);
  assert.equal(c.max, 1, 'ACE SPEC must win over the Special Energy cap of 4');

  // And an ordinary Special Energy is still 4.
  assert.equal(H.toCard({
    name: 'Spiky Energy', supertype: 'Energy', subtypes: ['Special'],
    set: { ptcgoCode: 'JTG' }, number: '159',
  }).max, 4);
});

test('the import keys cards by their final name, not the API\'s', () => {
  // toCard renames "Basic Darkness Energy"; keying the dedupe map by raw name
  // compared the wrong string against the curated list and filed the card under
  // a name it does not have, leaving two entries both called "Darkness Energy".
  assert.match(codeOnly, /seen\.has\(card\.name\)/);
  assert.match(codeOnly, /curated\.has\(card\.name\)/);
  assert.doesNotMatch(codeOnly, /curated\.has\(raw\.name\)/,
    'the curated guard must compare the name the card will actually carry');
});

test('re-importing refreshes a card instead of duplicating it', () => {
  // Curated cards were guarded by name, previously imported ones were not, so
  // every re-run appended a second copy of everything the last run added — 553
  // cards carrying 500 unique ids after two passes.
  assert.match(codeOnly, /const byName = new Map\(\)/,
    'the merge must be keyed by name, not a plain concatenation');
  assert.doesNotMatch(codeOnly, /\[\.\.\.existing\.cards, \.\.\.seen\.values\(\)\]/,
    'concatenating existing and new cards duplicates every imported card');
});

test('throttling is retried rather than treated as a dead set', () => {
  // The API answers rate limiting with an intermittent 500, not a 429. Treating
  // it as fatal dropped seven of eighteen sets from a run.
  assert.match(codeOnly, /r\.status >= 500 \|\| r\.status === 429/);
  assert.match(codeOnly, /MAX_ATTEMPTS/);
});

test('curated cards are never overwritten by the importer', () => {
  assert.match(codeOnly, /if \(curated\.has\(card\.name\)\) continue;/,
    'hand-written sim blocks encode mechanics the API cannot express');
});
