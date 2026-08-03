#!/usr/bin/env node
/**
 * Add a batch of cards to data/cards.json from a compact text file.
 *
 *   node tools/add-batch.mjs data/batches/pbl-1.txt
 *   node tools/add-batch.mjs data/batches/pbl-1.txt --dry-run
 *
 * Why a compact format: the full card pool has to be transcribed set by set from
 * limitlesstcg.com, and writing verbose JSON per card is enormously wasteful.
 * One line per card, pipe-delimited. Card text is synthesised from the structured
 * fields, so only genuinely load-bearing prose has to be typed out.
 *
 * ── LINE FORMATS ────────────────────────────────────────────────────────────
 *
 * Pokémon
 *   P|Name|SET N|TYPE|HP|stage|evolvesFrom|retreat|weak|attacks|note
 *     attacks  Attack Name:COST:damage;Second Attack:COST:damage
 *              COST is Energy symbols, e.g. GC = [G][C], DDD = [D][D][D]
 *              damage may be blank for an effect-only attack
 *     note     optional; ability text or anything mechanically important
 *   Prize count is derived from the name: "Mega X ex" = 3, "X ex" = 2, else 1.
 *
 * Trainer
 *   I|Name|SET N|Card text          (Item)
 *   O|Name|SET N|Card text          (Tool)
 *   S|Name|SET N|Card text          (Supporter)
 *   D|Name|SET N|Card text          (Stadium)
 *
 * Energy
 *   E|Name|SET N|SYM|basic|Card text        basic = 1 for Basic Energy, 0 for Special
 *
 * Blank lines and lines starting with # are ignored.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * Existing cards are never overwritten — a name already in data/cards.json is
 * skipped and reported, so re-running a batch is safe.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const CARDS_PATH = join(here, '../data/cards.json');
const FORMAT_PATH = join(here, '../data/format.json');

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const file = args.find((a) => !a.startsWith('--'));
if (!file) {
  console.error('usage: node tools/add-batch.mjs <batch file> [--dry-run]');
  process.exit(1);
}

const SYM = new Set(['G', 'R', 'W', 'L', 'P', 'F', 'D', 'M', 'N', 'C', 'Y']);
const CAT = { I: 'item', O: 'tool', S: 'supporter', D: 'stadium' };

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** "Mega Darkrai ex" -> 3, "Fezandipiti ex" -> 2, "Munkidori" -> 1 */
function prizesFor(name) {
  if (/^Mega .+ ex$/i.test(name)) return 3;
  if (/\bex$/i.test(name) || /\bV(MAX|STAR)?$/.test(name)) return 2;
  return 1;
}

function parseCost(str) {
  const cost = {};
  for (const ch of (str || '').toUpperCase()) {
    if (!SYM.has(ch)) throw new Error(`unknown Energy symbol "${ch}"`);
    cost[ch] = (cost[ch] || 0) + 1;
  }
  return cost;
}

function parseAttacks(str) {
  if (!str || !str.trim()) return [];
  return str.split(';').filter(Boolean).map((a) => {
    const [name, cost, dmg] = a.split(':');
    if (!name || cost === undefined) throw new Error(`bad attack "${a}"`);
    const out = { name: name.trim(), cost: parseCost(cost.trim()) };
    const d = Number((dmg || '').trim());
    out.damage = Number.isFinite(d) ? d : 0;
    return out;
  });
}

/** Build readable card text from the structured fields. */
function synthText(card, attacks, note) {
  const bits = [];
  for (const a of attacks) {
    const cost = Object.entries(a.cost)
      .flatMap(([s, n]) => Array(n).fill(`[${s}]`)).join('');
    bits.push(`${a.name} ${cost}${a.damage ? ` ${a.damage}` : ''}`.trim());
  }
  let out = bits.join('. ');
  if (note) {
    const n = note.trim();
    out = out ? `${out}${/[.!?]$/.test(out) ? '' : '.'} ${n}` : n;
  }
  return out || card.name;
}

function parseLine(line, lineNo) {
  const f = line.split('|').map((x) => x.trim());
  const kind = f[0].toUpperCase();

  if (kind === 'P') {
    const [, name, set, type, hp, stage, evolvesFrom, retreat, weak, atkStr, note] = f;
    if (!name || !set) throw new Error('Pokémon needs a name and set');
    const attacks = parseAttacks(atkStr);
    const st = Number(stage) || 0;
    const card = {
      id: slug(name), name, set, category: 'pokemon',
      type: type || undefined, max: 4, text: '',
      sim: {
        stage: st,
        hp: Number(hp) || 60,
        prizes: prizesFor(name),
        retreat: Number(retreat) || 0,
      },
    };
    if (st === 0) card.sim.basic = true;
    if (st > 0) {
      if (!evolvesFrom) throw new Error(`${name} is Stage ${st} but has no evolvesFrom`);
      card.sim.evolvesFrom = evolvesFrom;
    }
    if (weak) card.sim.weak = weak.toUpperCase();
    if (attacks.length) { card.sim.role = 'attacker'; card.sim.attacks = attacks; }
    else card.sim.role = 'support';
    card.text = synthText(card, attacks, note);
    return card;
  }

  if (CAT[kind]) {
    const [, name, set, text] = f;
    if (!name || !set) throw new Error('Trainer needs a name and set');
    return {
      id: slug(name), name, set, category: CAT[kind], max: 4,
      text: text || name,
    };
  }

  if (kind === 'E') {
    const [, name, set, sym, basic, text] = f;
    if (!name || !set) throw new Error('Energy needs a name and set');
    const isBasic = basic === '1';
    return {
      id: slug(name), name, set, category: 'energy',
      type: (sym || 'C').toUpperCase(),
      max: isBasic ? null : 4,
      text: text || name,
      sim: { basicEnergy: isBasic, provides: (sym || 'C').toUpperCase() },
    };
  }

  throw new Error(`unknown line type "${f[0]}" (expected P, I, O, S, D or E)`);
}

// ---------------------------------------------------------------------------
const db = JSON.parse(readFileSync(CARDS_PATH, 'utf8'));
const format = JSON.parse(readFileSync(FORMAT_PATH, 'utf8'));
const legalSets = new Set(format.legalSets);
const have = new Set(db.cards.map((c) => c.name));

const lines = readFileSync(join(process.cwd(), file), 'utf8')
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith('#'));

const added = [];
const skipped = [];
const errors = [];

lines.forEach((line, i) => {
  let card;
  try {
    card = parseLine(line, i + 1);
  } catch (e) {
    errors.push(`line ${i + 1}: ${e.message}\n  ${line.slice(0, 80)}`);
    return;
  }
  if (have.has(card.name)) { skipped.push(card.name); return; }
  const code = card.set.split(' ')[0].toUpperCase();
  if (!legalSets.has(code)) {
    errors.push(`line ${i + 1}: ${card.name} is from ${code}, not legal in ${format.format}`);
    return;
  }
  have.add(card.name);
  added.push(card);
});

if (errors.length) {
  console.error(`\n${errors.length} problem(s):`);
  for (const e of errors) console.error('  ' + e);
  console.error('\nNothing written.');
  process.exit(1);
}

console.log(`Parsed ${lines.length} lines: ${added.length} new, ${skipped.length} already present.`);
if (skipped.length) console.log('  already present:', skipped.slice(0, 8).join(', ')
  + (skipped.length > 8 ? ` … +${skipped.length - 8}` : ''));

if (DRY) {
  console.log('\n--dry-run: nothing written. Sample:');
  console.log(JSON.stringify(added.slice(0, 3), null, 2));
  process.exit(0);
}

db.cards = [...db.cards, ...added]
  .sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
writeFileSync(CARDS_PATH, JSON.stringify(db, null, 2) + '\n');

const by = db.cards.reduce((a, c) => { a[c.category] = (a[c.category] || 0) + 1; return a; }, {});
console.log(`\nWrote ${db.cards.length} cards total.`);
console.log('By category:', by);
console.log('Now run: npm test');
