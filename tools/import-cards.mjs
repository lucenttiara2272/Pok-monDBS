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
const FORMAT_PATH = join(here, '../data/format.json');

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const LIMIT = (() => {
  const i = args.indexOf('--limit');
  return i >= 0 ? Number(args[i + 1]) : Infinity;
})();

const PARTIAL = args.includes('--partial');
const MAX_ATTEMPTS = 5;
const RETRY_BASE_MS = 1200;
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
  // The API calls it "Basic Darkness Energy"; the curated database, the presets
  // and every deck list in this project call it "Darkness Energy". Left alone,
  // the import adds a second entry for the same card under the API's name, and
  // because it is a different name the curated-card guard does not catch it. The
  // optimiser then happily built decks around 24 "Basic Darkness Energy" while a
  // test looking for "Darkness Energy" reported none at all.
  const name = /^Basic .+ Energy$/.test(c.name)
    ? c.name.replace(/^Basic /, '')
    : c.name;

  const out = {
    id: (c.id || name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
    name,
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

    // Carry Abilities through as structure, not just prose.
    //
    // buildText folds them into the display string and nothing read it back, so
    // every imported Pokemon arrived with its Ability invisible to the engine.
    // `effect` is left unset on purpose: the name and text are enough for the
    // deck builder to flag the card as unmodelled, and inventing a handler name
    // here would claim behaviour that does not exist.
    const ability = (c.abilities || [])[0];
    if (ability) {
      out.sim.ability = { name: ability.name, text: ability.text || '' };
    }
  } else if (category === 'energy') {
    const basic = (c.subtypes || []).includes('Basic');
    out.max = basic ? null : 4;
    out.sim = { basicEnergy: basic, provides: out.type || 'C' };
  }

  // ACE SPEC is a deckbuilding restriction the API states in the card's rules
  // text: one per deck across every ACE SPEC card, not one of each.
  //
  // Applied last, on purpose. This used to sit above the category branches, and
  // the Energy branch then reassigned `max` unconditionally — so an ACE SPEC
  // Special Energy like Enriching Energy came in flagged but still capped at 4,
  // which is the worst of both worlds: the deck builder knew it was restricted
  // and let you run four anyway. Anything that overrides `max` has to run before
  // this block, not after it.
  if ((c.rules || []).some((r) => /ACE SPEC/i.test(r))
      || (c.subtypes || []).some((s) => /ACE SPEC/i.test(s))) {
    out.aceSpec = true;
    out.max = 1;
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

/**
 * Query by set, not by the API's own Standard flag.
 *
 * `q=legalities.standard:legal` sounds right and is quietly wrong: it returns
 * whatever the API currently considers Standard, which tracks the real-world
 * rotation. data/format.json deliberately does not — it pins the format this
 * project simulates. So every set the API has since rotated out was filtered
 * away before the local legalSets check ever saw it, and a run would report
 * "104 new cards" while silently importing none of them from those sets. That
 * is how seventeen ACE SPEC cards stayed missing after a successful import.
 *
 * Asking for the sets we actually want inverts it: the API decides nothing, and
 * a set it has never heard of simply returns no rows.
 *
 * One set per query, deliberately. Two earlier shapes both failed silently or
 * loudly: grouping the terms as `(a OR b)` made the parser return an empty body
 * with a 200, and a bare `a OR b OR …` across all eighteen sets was long enough
 * to 500 the server outright. Six sets worked, eighteen did not, which is the
 * kind of limit you only find by hitting it.
 *
 * Asking for one set at a time sidesteps the length ceiling entirely, lets a set
 * the API has never heard of return zero rows harmlessly, and makes the
 * completeness check per-set rather than one number for the whole run.
 */
function setQuery(code) {
  return `set.ptcgoCode:${code}`;
}

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

/**
 * Fetch one page, retrying on the failures that are not really failures.
 *
 * This API answers throttling with a 500 rather than a 429, and it does it
 * intermittently: the same set query that fails here succeeds seconds later from
 * elsewhere. Treating that as fatal meant seven of eighteen sets dropped out of a
 * run for no reason anyone could see from the error message.
 *
 * A 404 or a 400 is a real answer and retrying it just wastes time, so only 5xx
 * and 429 are retried, with a widening gap between attempts.
 */
async function fetchPage(page, q, attempt = 1) {
  const url = `${API}?q=${encodeURIComponent(q)}&page=${page}&pageSize=${PAGE_SIZE}`
    + '&orderBy=name';
  const headers = {};
  if (process.env.POKEMONTCG_API_KEY) headers['X-Api-Key'] = process.env.POKEMONTCG_API_KEY;

  let r;
  try {
    r = await fetch(url, { headers });
  } catch (e) {
    if (attempt >= MAX_ATTEMPTS) throw e;
    await sleep(RETRY_BASE_MS * attempt);
    return fetchPage(page, q, attempt + 1);
  }
  if (r.ok) return r.json();

  const worthRetrying = r.status >= 500 || r.status === 429;
  if (worthRetrying && attempt < MAX_ATTEMPTS) {
    await sleep(RETRY_BASE_MS * attempt);
    return fetchPage(page, q, attempt + 1);
  }
  throw new Error(`${r.status} ${r.statusText} for page ${page}`
    + (worthRetrying ? ` after ${attempt} attempts` : ''));
}

async function main() {
  const existing = JSON.parse(readFileSync(CARDS_PATH, 'utf8'));
  const format = JSON.parse(readFileSync(FORMAT_PATH, 'utf8'));
  const legalSets = new Set(format.legalSets);
  console.log(`Format: ${format.format} — ${legalSets.size} legal sets`);
  const curated = new Set(existing.cards.filter((c) => !c.imported).map((c) => c.name));
  console.log(`Curated cards to preserve: ${curated.size}`);

  const seen = new Map();
  let pagesOk = 0;
  let skipped = 0;
  const incomplete = [];

  for (const code of legalSets) {
    if (seen.size >= LIMIT) break;
    let page = 1;
    let total = Infinity;
    let got = 0;
    let failed = null;

    while ((page - 1) * PAGE_SIZE < total && seen.size < LIMIT) {
      process.stdout.write(`\r${code}: page ${page}… (${seen.size} unique so far)   `);
      let data;
      try {
        data = await fetchPage(page, setQuery(code));
        pagesOk++;
      } catch (e) {
        failed = e.message;
        break;
      }
      total = data.totalCount ?? 0;
      got += (data.data || []).length;
      for (const raw of data.data || []) {
        // Belt and braces: we asked for this set, but the API has been known to
        // widen a query, and rotated cards must never slip into the pool.
        const setCode = ((raw.set && (raw.set.ptcgoCode || raw.set.id)) || '').toUpperCase();
        if (!legalSets.has(setCode)) { skipped++; continue; }

        // Key off the card's final name, not the API's raw one. toCard renames
        // "Basic Darkness Energy" to "Darkness Energy", so keying by raw name
        // meant the curated check compared the wrong string and the merge filed
        // the card under a name it does not have — producing two entries both
        // called "Darkness Energy" under different keys.
        let card;
        try {
          card = toCard(raw);
        } catch { continue; }                  // skip anything malformed
        if (seen.has(card.name)) continue;     // one entry per card name
        if (curated.has(card.name)) continue;  // never clobber a hand-written card
        seen.set(card.name, card);
      }
      if (!data.data || !data.data.length) break;
      page++;
    }

    if (failed) {
      incomplete.push(`${code} (${failed})`);
      console.error(`\n${code}: stopped — ${failed}`);
    } else if (Number.isFinite(total) && got < total && seen.size < LIMIT) {
      incomplete.push(`${code} (${got}/${total})`);
    }
  }

  console.log(`\nImported ${seen.size} new cards `
    + `(${skipped} skipped as not in a ${format.format} set).`);

  // Never rewrite the database off a failed run — an offline or rate-limited
  // attempt should leave the curated file exactly as it was.
  if (!pagesOk || seen.size === 0) {
    console.error('No cards were fetched. Leaving data/cards.json untouched.');
    console.error('Check your network, or set POKEMONTCG_API_KEY if you are rate limited.');
    process.exit(1);
  }

  // A *partial* run is the dangerous one. Rate limiting throws mid-fetch, the
  // loop breaks, and everything downstream behaves normally — so a run that got
  // half the pool writes half a database and prints the same cheerful summary as
  // a complete one. That is exactly how a dry run projecting 420 new cards
  // turned into 216 written with no indication anything had gone wrong.
  const complete = LIMIT !== Infinity || incomplete.length === 0;
  if (!complete) {
    console.error(
      `\nIncomplete — these sets did not fully download: ${incomplete.join(', ')}.`
      + '\nLeaving data/cards.json untouched.');
    console.error(
      'This is almost always rate limiting. Set POKEMONTCG_API_KEY and re-run, '
      + 'or pass --partial to accept an incomplete import on purpose.');
    if (!PARTIAL) process.exit(1);
    console.error('--partial given: writing anyway.');
  }

  // Merge by name, not by concatenation.
  //
  // The old `[...existing.cards, ...seen.values()]` only ever appended. Curated
  // cards were protected by name, but previously *imported* ones were not — so a
  // second run re-added every card the first run had brought in, and the file
  // grew a duplicate entry, and a duplicate id, for each of them. Two runs left
  // 553 cards carrying 500 unique ids.
  //
  // Keying by name makes a re-import refresh a stale imported card in place,
  // which is what you want from a tool you are expected to run repeatedly.
  const byName = new Map();
  for (const c of existing.cards) byName.set(c.name, c);
  for (const [cardName, card] of seen) {
    if (curated.has(cardName)) continue;      // hand-written wins, always
    byName.set(cardName, card);
  }
  const merged = [...byName.values()]
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
