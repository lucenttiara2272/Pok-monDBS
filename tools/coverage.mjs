#!/usr/bin/env node
/**
 * Report how much of the Standard card pool is in data/cards.json.
 *
 *   node tools/coverage.mjs
 *
 * The pool is being transcribed set by set from limitlesstcg.com. This shows what
 * has landed and what is still missing, so batches can be picked off in order.
 *
 * Note on counts: Limitless reports *prints*, and the tail of every set is
 * alternate art of earlier numbers. Pitch Black lists 120 prints but only 84
 * distinct card names. Expect roughly two thirds of the print count to be real.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const db = JSON.parse(readFileSync(join(here, '../data/cards.json'), 'utf8'));
const format = JSON.parse(readFileSync(join(here, '../data/format.json'), 'utf8'));

/** Distinct card names per set, once alternate art is discounted. */
const EXPECTED = format.expectedUnique || {};

const have = {};
for (const c of db.cards) {
  const code = (c.set || '').split(' ')[0].toUpperCase();
  have[code] = (have[code] || 0) + 1;
}

const rows = format.legalSets.map((code) => ({
  code,
  name: format.legalSetNames[code] || '',
  have: have[code] || 0,
  want: EXPECTED[code] || null,
}));

const totalHave = db.cards.length;
const totalWant = rows.reduce((a, r) => a + (r.want || 0), 0);

console.log(`\n${format.format} — card pool coverage\n`);
console.log('  SET   NAME                        HAVE   OF     ');
console.log('  ' + '-'.repeat(52));
for (const r of rows) {
  const pct = r.want ? `${Math.min(100, Math.round((r.have / r.want) * 100))}%` : '';
  const bar = r.want
    ? '█'.repeat(Math.min(10, Math.round((r.have / r.want) * 10))).padEnd(10, '·')
    : (r.have ? '?'.repeat(3).padEnd(10) : '·'.repeat(10));
  console.log(`  ${r.code.padEnd(5)} ${r.name.slice(0, 26).padEnd(27)} `
    + `${String(r.have).padStart(4)}   ${String(r.want ?? '?').padStart(4)}  ${bar} ${pct}`);
}
console.log('  ' + '-'.repeat(52));
console.log(`  TOTAL${' '.repeat(28)}${String(totalHave).padStart(4)}   `
  + `${totalWant ? String(totalWant).padStart(4) : '   ?'}`);

const untouched = rows.filter((r) => r.have === 0);
if (untouched.length) {
  console.log(`\n  Not started: ${untouched.map((r) => r.code).join(', ')}`);
}
const partial = rows.filter((r) => r.have > 0 && r.want && r.have < r.want);
if (partial.length) {
  console.log(`  In progress: ${partial.map((r) => `${r.code} (${r.have}/${r.want})`).join(', ')}`);
}
console.log();
