/**
 * Deck optimiser.
 *
 * You pin the cards you want to build around; this fills the remaining slots to
 * maximise the meta-weighted win rate.
 *
 * ─── HOW IT SEARCHES ────────────────────────────────────────────────────────
 * Hill climbing over ±1 card moves. Each round it proposes a bounded set of
 * candidate changes, scores every one, takes the single best improvement, and
 * repeats until nothing helps or the round budget runs out.
 *
 * It is not exhaustive and makes no claim to find the global optimum — the
 * search space of 60-card decks is astronomically large. It finds a local
 * improvement over where you started, which is the useful thing in practice.
 *
 * ─── WHY THE SEED IS FIXED ──────────────────────────────────────────────────
 * Every candidate is evaluated on the *same* random games (common random
 * numbers). Without this, a 300-game evaluation carries several points of noise
 * and the search happily "improves" a deck by reshuffling luck. Sharing the seed
 * means a measured difference between two decks reflects the decklist, not the
 * dice. The trade-off is that results are tuned to one sample, so the final
 * answer is re-scored on a fresh, larger sample before being reported.
 */

import {
  runGauntlet, validateDeck, deckSize, isBasic, DRAW_SUPPORTERS,
} from './engine.js?v=dev';

/** Trainers worth considering in almost any deck, best first. */
const GENERIC_STAPLES = [
  'Ultra Ball', 'Buddy-Buddy Poffin', 'Master Ball', 'Poké Pad', 'Poké Ball',
  'Night Stretcher', 'Switch', 'Prime Catcher', 'Energy Search',
  'Energy Retrieval', 'Energy Switch', 'Super Potion', 'Tool Scrapper',
  'Hero’s Cape', "Hero's Cape", 'Maximum Belt', 'Rescue Board',
];

const GENERIC_SUPPORTERS = [
  "Lillie's Determination", 'Lacey', "Boss's Orders", 'Judge', 'Kofu',
  "Iris's Fighting Spirit", 'Naveen', "Team Rocket's Ariana", "Emcee's Hype",
];

/** Every symbol the deck's attackers actually need. */
function neededSymbols(spec) {
  const syms = new Set();
  for (const d of Object.values(spec)) {
    for (const a of (d.attacks || [])) {
      for (const [sym, n] of Object.entries(a.cost || {})) {
        if (sym !== 'C' && n > 0) syms.add(sym);
      }
    }
  }
  return syms;
}

/** Walk an evolution line back to its Basic, adding every missing stage. */
function completeEvolutionLines(counts, index) {
  const out = { ...counts };
  let changed = true;
  let guard = 0;
  while (changed && guard++ < 6) {
    changed = false;
    for (const name of Object.keys(out)) {
      const card = index[name];
      const from = card && card.sim && card.sim.evolvesFrom;
      if (from && index[from] && !out[from]) {
        out[from] = Math.max(2, out[name]);
        changed = true;
      }
    }
  }
  return out;
}

/**
 * Cards the optimiser is allowed to add. Deliberately bounded: trying all ~340
 * cards would make every round hundreds of simulations long for no real gain,
 * because most of the database is filler that no deck wants.
 */
function candidatePool(counts, index, locked) {
  const pool = new Set();
  const add = (n) => { if (index[n]) pool.add(n); };

  Object.keys(counts).forEach(add);
  GENERIC_STAPLES.forEach(add);
  GENERIC_SUPPORTERS.forEach(add);
  [...DRAW_SUPPORTERS].forEach(add);

  const spec = {};
  for (const [n, c] of Object.entries(counts)) {
    if (index[n]) spec[n] = { ...index[n].sim, n: c };
  }
  // Basic Energy for whatever the attackers actually cost
  const want = neededSymbols(spec);
  for (const c of Object.values(index)) {
    if (c.category === 'energy' && c.sim && c.sim.basicEnergy && want.has(c.sim.provides)) {
      pool.add(c.name);
    }
  }
  // Rare Candy only earns a slot if there is a Stage 2 to hit
  if (Object.keys(counts).some((n) => index[n] && index[n].sim
      && index[n].sim.stage === 2)) {
    add('Rare Candy');
  }
  // small Basic bodies that share a type with the deck, to lower the mulligan rate
  const types = new Set(Object.keys(counts)
    .map((n) => index[n] && index[n].type).filter(Boolean));
  for (const c of Object.values(index)) {
    if (c.category !== 'pokemon' || !c.sim || !isBasic(c.sim)) continue;
    if (!types.has(c.type)) continue;
    if ((c.sim.hp || 0) <= 130 && c.sim.prizes === 1) pool.add(c.name);
  }

  locked.forEach((n) => pool.delete(n));   // never propose changing a pinned card

  // Priority order matters: each round only scores a slice of the pool, so the
  // levers that move win rates most have to be at the front. Draw Supporters and
  // Pokemon count are consistently the two biggest, which is exactly what a
  // first pass over a homebrew list needs to hear.
  const rank = (n) => {
    const c = index[n];
    if (DRAW_SUPPORTERS.has(n)) return 0;
    if (c.category === 'pokemon' && isBasic(c.sim)) return 1;
    if (['Ultra Ball', 'Buddy-Buddy Poffin', 'Master Ball', 'Poké Pad',
      "Boss's Orders", 'Night Stretcher'].includes(n)) return 2;
    if (c.category === 'energy') return 3;
    return 4;
  };
  return [...pool].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

function maxCopies(index, name) {
  const c = index[name];
  if (!c) return 4;
  return (c.sim && c.sim.basicEnergy) ? 60 : (c.max || 4);
}

function toSpec(counts, index) {
  const spec = {};
  for (const [name, n] of Object.entries(counts)) {
    if (!n || !index[name]) continue;
    spec[name] = { n, kind: index[name].category, type: index[name].type,
      ...(index[name].sim || {}) };
  }
  return spec;
}

function score(counts, index, meta, games, seed) {
  const spec = toSpec(counts, index);
  if (deckSize(spec) !== 60) return -1;
  return runGauntlet(spec, meta, { games, seed }).weighted;
}

/**
 * @param {Record<string,number>} startCounts  the deck as it stands
 * @param {Set<string>|string[]} lockedNames   cards the user pinned
 */
export function optimiseDeck(startCounts, index, meta, opts = {}) {
  const {
    games = 250,
    seed = 20260803,
    rounds = 6,
    maxMoves = 45,          // candidate changes scored per round
    budget = 300,           // hard cap on simulations, so the UI cannot hang
    finalGames = 3000,
    onProgress,
  } = opts;
  let spent = 0;
  const locked = new Set(lockedNamesOf(opts.locked ?? []));

  // 1. start from something legal: complete evolution lines, then fill/trim
  let counts = completeEvolutionLines({ ...startCounts }, index);
  const pool = candidatePool(counts, index, locked);
  counts = makeLegal60(counts, index, pool, locked);

  const before = { ...counts };

  // 1b. Offer a structurally repaired alternative as a second starting point.
  // Hill climbing one card at a time cannot cross a valley — 8 Pokemon to 9
  // measures as nothing, while 8 to 11 fixes the mulligan rate outright — so
  // the fixed version is worth trying. It is only a *candidate*: padding a
  // focused list with filler Pokemon can easily cost more than the mulligan
  // rate gains, so both starts are scored and the better one wins. The prior
  // proposes; the simulation decides.
  const repaired = applyStructuralFixes(counts, index, pool, locked);
  const startPlain = score(counts, index, meta, games, seed);
  const startFixed = deckSize(toSpec(repaired, index)) === 60
    && validateDeck(toSpec(repaired, index)).ok
    ? score(repaired, index, meta, games, seed) : -1;

  let structuralNote = null;
  if (startFixed > startPlain) {
    counts = repaired;
    structuralNote = 'Raised Pokémon count and draw Supporters to workable '
      + 'minimums before searching — that shape scored better than the original.';
  } else if (startFixed >= 0) {
    structuralNote = 'Tried padding Pokémon count and draw Supporters to the usual '
      + `minimums first, but that scored worse (${startFixed.toFixed(1)}% vs `
      + `${startPlain.toFixed(1)}%), so the original shape was kept.`;
  }

  const beforeScore = Math.max(startPlain, 0);
  let current = Math.max(startPlain, startFixed);
  const history = [];

  // 2. hill climb
  for (let round = 0; round < rounds && spent < budget; round++) {
    const moves = proposeMoves(counts, index, pool, locked, maxMoves);
    let best = null;

    for (let i = 0; i < moves.length; i++) {
      if (spent >= budget) break;
      const cand = applyMove(counts, moves[i]);
      const candSpec = toSpec(cand, index);
      if (deckSize(candSpec) !== 60) continue;
      if (!validateDeck(candSpec).ok) continue;
      const s = score(cand, index, meta, games, seed);
      spent++;
      if (best === null || s > best.s) best = { s, move: moves[i], counts: cand };
      if (onProgress) onProgress(Math.min(1, spent / budget));
    }

    // require a real gain, not noise from a single lucky evaluation
    if (!best || best.s <= current + 0.25) break;
    history.push({ round: round + 1, from: current, to: best.s, move: best.move });
    counts = best.counts;
    current = best.s;
  }

  // 3. re-score start and finish on a fresh, larger sample
  const verifySeed = seed + 7919;
  const finalBefore = score(before, index, meta, finalGames, verifySeed);
  const finalAfter = score(counts, index, meta, finalGames, verifySeed);

  return {
    before, after: counts,
    beforeScore: finalBefore,
    afterScore: finalAfter,
    searchScore: current,
    history,
    structuralNote,
    diff: diffCounts(before, counts),
    locked: [...locked],
    note: finalAfter <= finalBefore
      ? 'No improvement survived re-scoring on a fresh sample — the changes the '
        + 'search liked were within noise. Your list is left as it was.'
      : null,
  };
}

/** Raise Pokemon count and draw Supporters to workable minimums. */
function applyStructuralFixes(counts, index, pool, locked) {
  const out = { ...counts };
  const countOf = (pred) => Object.entries(out)
    .filter(([n]) => index[n] && pred(index[n], n))
    .reduce((a, [, c]) => a + c, 0);

  const cutOne = () => {
    const cand = Object.keys(out)
      .filter((n) => !locked.has(n) && out[n] > 0
        && !(index[n].category === 'pokemon')
        && !DRAW_SUPPORTERS.has(n))
      .sort((a, b) => out[b] - out[a]);
    const pick = cand[0];
    if (!pick) return false;
    out[pick] -= 1;
    if (!out[pick]) delete out[pick];
    return true;
  };

  // draw Supporters up to 4
  const drawTargets = pool.filter((n) => DRAW_SUPPORTERS.has(n)
    && !/^Jett$/.test(n));
  let guard = 0;
  while (countOf((c, n) => DRAW_SUPPORTERS.has(n)) < 4 && guard++ < 12) {
    const pick = drawTargets.find((n) => (out[n] || 0) < maxCopies(index, n));
    if (!pick || !cutOne()) break;
    out[pick] = (out[pick] || 0) + 1;
  }

  // Basic Pokemon up to 11
  const monTargets = pool.filter((n) => index[n].category === 'pokemon'
    && isBasic(index[n].sim));
  guard = 0;
  while (countOf((c) => c.category === 'pokemon' && isBasic(c.sim)) < 11
      && guard++ < 12) {
    const pick = monTargets.find((n) => (out[n] || 0) < maxCopies(index, n));
    if (!pick || !cutOne()) break;
    out[pick] = (out[pick] || 0) + 1;
  }
  return out;
}

function lockedNamesOf(v) {
  return Array.isArray(v) ? v : [...v];
}

/** Bring a deck to exactly 60 legal cards without touching pinned entries. */
function makeLegal60(counts, index, pool, locked) {
  const out = { ...counts };
  const size = () => Object.values(out).reduce((a, b) => a + b, 0);

  // trim overflow from the least valuable unpinned cards
  const trimOrder = () => Object.keys(out)
    .filter((n) => !locked.has(n) && out[n] > 0)
    .sort((a, b) => (isEnergy(index, a) ? 1 : 0) - (isEnergy(index, b) ? 1 : 0));
  let guard = 0;
  while (size() > 60 && guard++ < 200) {
    const order = trimOrder();
    if (!order.length) break;
    const pick = order[order.length - 1];
    out[pick] -= 1;
    if (!out[pick]) delete out[pick];
  }

  // fill shortfall with staples, then Energy
  const fillers = [...pool].filter((n) => !locked.has(n));
  guard = 0;
  while (size() < 60 && guard++ < 200) {
    let added = false;
    for (const n of fillers) {
      const cur = out[n] || 0;
      if (cur >= maxCopies(index, n)) continue;
      out[n] = cur + 1;
      added = true;
      if (size() >= 60) break;
    }
    if (!added) {
      const energy = fillers.find((n) => isEnergy(index, n));
      if (!energy) break;
      out[energy] = (out[energy] || 0) + 1;
    }
  }
  return out;
}

function isEnergy(index, name) {
  return index[name] && index[name].category === 'energy';
}

/** ±1 swaps. Every move keeps the deck at 60 by pairing an add with a remove. */
function proposeMoves(counts, index, pool, locked, maxMoves) {
  const removable = Object.keys(counts)
    .filter((n) => !locked.has(n) && counts[n] > 0);
  const addable = pool.filter((n) => (counts[n] || 0) < maxCopies(index, n));

  // Favour breadth over depth: try many different additions against a handful of
  // plausible cuts, rather than every possible cut for the first few additions.
  const cutFirst = [...removable].sort((a, b) => {
    const score = (n) => (index[n] && index[n].category === 'pokemon' ? 2 : 0)
      + (DRAW_SUPPORTERS.has(n) ? 3 : 0) - Math.min(2, counts[n]);
    return score(a) - score(b);
  });
  // keep one high-count card in the cut list so bulk swaps are actually possible
  const bulkiest = [...removable].sort((a, b) => counts[b] - counts[a])[0];
  if (bulkiest && !cutFirst.slice(0, 4).includes(bulkiest)) {
    cutFirst.splice(3, 0, bulkiest);
  }

  const removes = Math.min(4, cutFirst.length);
  const adds = Math.max(1, Math.floor(maxMoves / Math.max(1, removes)));
  const moves = [];
  for (let a = 0; a < adds; a++) {
    for (let r = 0; r < removes; r++) {
      const add = addable[a];
      const rem = cutFirst[r];
      if (!add || !rem || add === rem) continue;
      moves.push({ add, rem, qty: 1 });

      // Some improvements only exist in bulk. Raising Pokemon count from 8 to 9
      // does nothing measurable; raising it to 11 fixes the mulligan rate. A
      // pure one-card-at-a-time search cannot cross that gap, so offer a few
      // larger swaps as well.
      const isMon = index[add] && index[add].category === 'pokemon';
      if (isMon && counts[rem] >= 3) moves.push({ add, rem, qty: 3 });
      else if (isMon && counts[rem] >= 2) moves.push({ add, rem, qty: 2 });
    }
  }
  return moves.slice(0, maxMoves);
}

function applyMove(counts, move) {
  const q = move.qty || 1;
  const out = { ...counts };
  out[move.add] = (out[move.add] || 0) + q;
  out[move.rem] -= q;
  if (out[move.rem] <= 0) delete out[move.rem];
  return out;
}

function diffCounts(before, after) {
  const names = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  return names
    .map((n) => ({ name: n, from: before[n] || 0, to: after[n] || 0 }))
    .filter((d) => d.from !== d.to);
}
