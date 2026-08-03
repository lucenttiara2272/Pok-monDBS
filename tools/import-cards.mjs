#!/usr/bin/env node
/**
 * Bulk-import the Standard-legal card pool into data/cards.json.
 *
 *   node tools/import-cards.mjs            # import, merge, write
 *   node tools/import-cards.mjs --dry-run  # report only, write nothing
 *   node tools/import-cards.mjs --limit 200
 *
 * Source: pokemontcg.io. It returns structured JSON with the fields this project
 * needs (hp, subtypes, evolvesFrom, attacks with cost and damage), which is far
 * more reliable than scraping a rendered card list.
 *
 * An API key is optional but lifts the rate limit. Get one at dev.pokemontcg.io:
 *   POKEMONTCG_API_KEY=xxxx node tools/import-cards.mjs
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CURATED CARDS ALWAYS WIN.
 * Cards already in data/cards.json keep their hand-written `sim` block. The
 * importer only adds cards that aren't there yet. That matters because the
 * curated entries encode mechanics the API cannot express — Abyss Eye's
 * conditional knockout, Dark Bell's self-Confusion trap, Mega prize counts.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * WHAT YOU GET, AND WHAT YOU DON'T
 * Imported cards are complete enough to *build* with: correct name, set, type,
 * HP, stage, evolution line, retreat, weakness, and attack costs and damage.
 * They are NOT fully simulated — ability text and Trainer effects are free text
 * that no parser can turn into game logic. An imported Supporter is an inert
 * card in the simulation unless someone writes its effect into src/engine.js.
 * The app shows a confidence note for this reason. Don't read a win rate for a
 * deck built mostly from imported Trainers as gospel.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const CARDS_PATH = join(here, '../data/cards.json');

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const LIMIT = (() => {
  const i = args.indexOf('--limit');
  return i >= 0 ? Number(args[i + 1]) : Infinity;
})();

const API = 'https://api.pokemontcg.io/v2/cards';
const PAGE_SIZE = 250;

/** Energy symbol map: the API spells types out, the engine uses single letters. */
const TYPE = {
  Grass: 'G', Fire: 'R', Water: 'W', Lightning: 'L', Psychic: 'P',
  Fighting: 'F', Darkness: 'D', Metal: 'M', Dragon: 'N', Colorless: 'C', Fairy: 'Y',
};

function symbolise(costArray) {
  const cost = {};
  for (const t of costArray || []) {
    const s = TYPE[t] || 'C';
    cost[s] = (cost[s] || 0) + 1;
  }
  return cost;
}

/** "120+" / "50×" / "" -> number */
function damageOf(d) {
  if (!d) return 0;
  const m = String(d).match(/\d+/);
  return m ? Number(m[0]) : 0;
}

function stageOf(subtypes = []) {
  if (subtypes.includes('Stage 2')) return 2;
  if (subtypes.includes('Stage 1')) return 1;
  return 0;
}

function categoryOf(c) {
  if (c.supertype === 'Pokémon') return 'pokemon';
  if (c.supertype === 'Energy') return 'energy';
  const st = c.subtypes || [];
  if (st.includes('Supporter')) return 'supporter';
  if (st.includes('Pokémon Tool')) return 'tool';
  if (st.includes('Stadium')) return 'stadium';
  return 'item';
}

/** How many Prizes does knocking this out give up? */
function prizesOf(c) {
  const st = c.subtypes || [];
  const n = c.name || '';
  // Mega Evolution Pokemon ex give up 3 — the single most important number here
  if (/^Mega .+ ex$/.test(n) || st.includes('MEGA')) return 3;
  if (st.includes('ex') || st.includes('EX') || st.includes('V') || st.includes('GX')) return 2;
  if (st.includes('VMAX') || st.includes('VSTAR')) return 3;
  return 1;
}

function toCard(c) {
  const category = categoryOf(c);
  const setCode = (c.set && (c.set.ptcgoCode || c.set.id) || '').toUpperCase();
  const out = {
    id: (c.id || c.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
    name: c.name,
    set: `${setCode} ${c.number}`.trim(),
    category,
    max: /^(Basic .+ Energy)$/.test(c.name) ? null : 4,
    text: buildText(c),
    imported: true,
  };
  const t = (c.types || [])[0];
  if (t && TYPE[t]) out.type = TYPE[t];

  if (category === 'pokemon') {
    const stage = stageOf(c.subtypes);
    out.subtype = (c.subtypes || []).join(' · ');
    out.sim = {
      stage,
      hp: Number(c.hp) || 60,
      prizes: prizesOf(c),
      retreat: (c.retreatCost || []).length,
    };
    if (stage === 0) out.sim.basic = true;
    if (c.evolvesFrom) out.sim.evolvesFrom = c.evolvesFrom;
    const w = (c.weaknesses || [])[0];
    if (w && TYPE[w.type]) out.sim.weak = TYPE[w.type];

    const attacks = (c.attacks || [])
      .filter((a) => (a.cost || []).length)
      .map((a) => ({
        name: a.name,
        cost: symbolise(a.cost),
        damage: damageOf(a.damage),
      }));
    if (attacks.length) {
      out.sim.role = 'attacker';
      out.sim.attacks = attacks;
    } else {
      out.sim.role = 'support';
    }
  } else if (category === 'energy') {
    const basic = (c.subtypes || []).includes('Basic');
    out.max = basic ? null : 4;
    out.sim = { basicEnergy: basic, provides: out.type || 'C' };
  }
  return out;
}

function buildText(c) {
  const bits = [];
  for (const a of c.abilities || []) bits.push(`Ability: ${a.name} — ${a.text}`);
  for (const a of c.attacks || []) {
    const cost = (a.cost || []).map((t) => `[${TYPE[t] || 'C'}]`).join('');
    bits.push(`${a.name} ${cost} ${a.damage || ''}`.trim()
      + (a.text ? ` — ${a.text}` : ''));
  }
  for (const r of c.rules || []) bits.push(r);
  return bits.join(' ').trim() || c.name;
}

async function fetchPage(page) {
  const url = `${API}?q=legalities.standard:legal&page=${page}&pageSize=${PAGE_SIZE}`
    + '&orderBy=name';
  const headers = {};
  if (process.env.POKEMONTCG_API_KEY) headers['X-Api-Key'] = process.env.POKEMONTCG_API_KEY;
  const r = await fetch(url, { headers });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText} for page ${page}`);
  return r.json();
}

async function main() {
  const existing = JSON.parse(readFileSync(CARDS_PATH, 'utf8'));
  const curated = new Set(existing.cards.filter((c) => !c.imported).map((c) => c.name));
  console.log(`Curated cards to preserve: ${curated.size}`);

  const seen = new Map();
  let page = 1;
  let total = Infinity;
  let pagesOk = 0;

  while ((page - 1) * PAGE_SIZE < total && seen.size < LIMIT) {
    process.stdout.write(`\rFetching page ${page}… (${seen.size} unique so far)`);
    let data;
    try {
      data = await fetchPage(page);
      pagesOk++;
    } catch (e) {
      console.error(`\nStopped at page ${page}: ${e.message}`);
      break;
    }
    total = data.totalCount ?? 0;
    for (const raw of data.data || []) {
      if (seen.has(raw.name)) continue;      // one entry per card name
      if (curated.has(raw.name)) continue;   // never clobber a hand-written card
      try {
        seen.set(raw.name, toCard(raw));
      } catch { /* skip anything malformed */ }
    }
    if (!data.data || !data.data.length) break;
    page++;
  }
  console.log(`\nImported ${seen.size} new cards (API reported ${total} legal prints).`);

  // Never rewrite the database off a failed run — an offline or rate-limited
  // attempt should leave the curated file exactly as it was.
  if (!pagesOk || seen.size === 0) {
    console.error('No cards were fetched. Leaving data/cards.json untouched.');
    console.error('Check your network, or set POKEMONTCG_API_KEY if you are rate limited.');
    process.exit(1);
  }

  const merged = [...existing.cards, ...seen.values()]
    .sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));

  const counts = merged.reduce((acc, c) => {
    acc[c.category] = (acc[c.category] || 0) + 1; return acc;
  }, {});
  console.log('Totals by category:', counts);

  if (DRY) {
    console.log('\n--dry-run: nothing written.');
    console.log('Sample:', JSON.stringify([...seen.values()].slice(0, 2), null, 2));
    return;
  }

  existing.cards = merged;
  existing._imported = {
    at: new Date().toISOString(),
    source: 'pokemontcg.io',
    note: 'Imported cards carry "imported": true. Their attack costs and damage are '
      + 'modelled; ability and Trainer effect text is NOT converted into game logic.',
  };
  writeFileSync(CARDS_PATH, JSON.stringify(existing, null, 2) + '\n');
  console.log(`Wrote ${merged.length} cards to data/cards.json`);
  console.log('Now run: npm test');
}

main().catch((e) => { console.error(e); process.exit(1); });
