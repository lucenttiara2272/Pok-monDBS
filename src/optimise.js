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
  runGauntlet, validateDeck, deckSize, isBasic, DRAW_SUPPORTERS, isPlayedTrainer,
} from './engine.js?v=dev';

/**
 * Trainers worth considering in almost any deck, best first.
 *
 * Every entry must be a card the engine actually plays. This list used to read
 * like a real-format staples list — Buddy-Buddy Poffin, Master Ball, Poké Pad,
 * Prime Catcher, Boss's Orders — none of which the play policy touches, so the
 * optimiser was filling built decks with about a dozen slots the simulator draws
 * as blanks and then reporting a win rate for the result. Anything not modelled
 * is filtered out of the pool anyway (see `candidatePool`); keeping the list
 * itself honest means the two never drift apart silently.
 */
const GENERIC_STAPLES = [
  'Ultra Ball', 'Buddy-Buddy Poffin', 'Master Ball', 'Poké Pad',
  'Night Stretcher', 'Switch', 'Prime Catcher', 'Energy Search',
  'Energy Retrieval', 'Energy Switch', 'Air Balloon', 'Maximum Belt',
  "Hero's Cape",
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
export function candidatePool(counts, index, locked = []) {
  const lockedSet = locked instanceof Set ? locked : new Set(locked);
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
  // Cards that switch on an attack the deck already holds. Without this, a deck
  // that has lost its Dark Bell can never get one back: the enabler is not a
  // generic staple, so it would never be proposed, and the deck stays stuck as a
  // pile of attackers that cannot use their best attack.
  if (needsEnabler(counts, index)) {
    for (const c of Object.values(index)) {
      if (c.sim && c.sim.appliesSpecialCondition) pool.add(c.name);
    }
  }

  // Pieces that build toward an exact-damage knockout. Mega Absol's Terminal
  // Period knocks out an opponent sitting on exactly 6 damage counters, and the
  // only way to put them there on your own terms is retaliate chip — Punk
  // Helmet's 40 plus Spiky Energy's 20 is exactly 60. Neither piece is a generic
  // staple, neither does much alone, and one of them is a Special Energy that
  // the Energy branch above deliberately skips, so nothing else would ever
  // propose them and the line could only exist if you built it by hand.
  //
  // A piece bigger than the target can only overshoot it, so it is not offered.
  // Beyond that the search does not reason about which subset sums to the
  // target: it proposes the parts and lets the simulation measure the result.
  const targets = exactDamageTargets(counts, index);
  if (targets.length) {
    const cap = Math.max(...targets);
    for (const c of Object.values(index)) {
      if (c.sim && c.sim.retaliate && c.sim.retaliate <= cap) pool.add(c.name);
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

  // Never propose a card the simulator cannot use. Two ways that happens: the
  // play policy has no code for it at all, or it is modelled but its condition
  // is one this deck can never meet. Either way the slot does nothing, and the
  // optimiser has no business spending one on it.
  //
  // This governs additions only. Cards already in the deck stay put and remain
  // cuttable — flagging beats overriding someone's own list.
  for (const n of [...pool]) {
    if (!isUsable(n, counts, index)) pool.delete(n);
  }

  lockedSet.forEach((n) => pool.delete(n));   // never propose changing a pinned card

  // Priority order matters: each round only scores a slice of the pool, so the
  // levers that move win rates most have to be at the front. Draw Supporters and
  // Pokemon count are consistently the two biggest, which is exactly what a
  // first pass over a homebrew list needs to hear.
  const wantsEnabler = needsEnabler(counts, index);
  const rank = (n) => {
    const c = index[n];
    // an attack the deck cannot use at all is the biggest available gain
    if (wantsEnabler && c.sim && c.sim.appliesSpecialCondition) return -2;
    // then the pieces of a knockout line the deck is already half-built for
    if (isRetaliatePiece(n, index, targets)) return -1;
    if (DRAW_SUPPORTERS.has(n)) return 0;
    if (c.category === 'pokemon' && isBasic(c.sim)) return 1;
    if (['Ultra Ball', 'Buddy-Buddy Poffin', 'Master Ball', 'Poké Pad',
      "Boss's Orders", 'Night Stretcher'].includes(n)) return 2;
    if (c.category === 'energy') return 3;
    return 4;
  };
  return [...pool].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

const TRAINER_KINDS = new Set(['item', 'tool', 'supporter']);

/** Does this deck hold a Basic small enough for an hpLimit search to find? */
function hasBasicUpTo(counts, index, hp) {
  return Object.keys(counts).some((n) => {
    const c = index[n];
    return counts[n] > 0 && c && c.category === 'pokemon' && c.sim
      && isBasic(c.sim) && typeof c.sim.hp === 'number' && c.sim.hp <= hp;
  });
}

/** Would adding this card to this deck do anything the simulator can see? */
function isUsable(name, counts, index) {
  const c = index[name];
  if (!c) return false;
  const sim = c.sim || {};
  if (TRAINER_KINDS.has(c.category) && !isPlayedTrainer(name, sim)) return false;
  // Buddy-Buddy Poffin in a deck whose smallest Basic is 110 HP is a blank.
  if (typeof sim.hpLimit === 'number' && !hasBasicUpTo(counts, index, sim.hpLimit)) {
    return false;
  }
  return true;
}

const hasIn = (counts, index, pred) => Object.keys(counts)
  .some((n) => counts[n] > 0 && index[n] && pred(index[n]));

/** Exact damage totals this deck's attacks can cash in on, e.g. Absol's 60. */
function exactDamageTargets(counts, index) {
  const out = new Set();
  for (const n of Object.keys(counts)) {
    if (!counts[n]) continue;
    const c = index[n];
    for (const a of ((c && c.sim && c.sim.attacks) || [])) {
      if (typeof a.koIfExactDamage === 'number') out.add(a.koIfExactDamage);
    }
  }
  return [...out];
}

/** A card that chips the attacker toward one of those totals. */
function isRetaliatePiece(name, index, targets) {
  const c = index[name];
  return Boolean(targets.length && c && c.sim && c.sim.retaliate
    && c.sim.retaliate <= Math.max(...targets));
}

/** Does this deck hold an attack that only works with a separate enabler card? */
function needsEnabler(counts, index) {
  return hasIn(counts, index, (c) => (c.sim && c.sim.attacks || [])
    .some((a) => a.koIfSpecialCondition));
}

/** Does it currently hold one? */
function hasEnabler(counts, index) {
  return hasIn(counts, index, (c) => c.sim && c.sim.appliesSpecialCondition);
}

/**
 * Would this move break the deck's combo?
 *
 * Hill climbing scores one card at a time, which is blind to combos. Dark Bell on
 * its own looks like a weak Item, so the search cut the last copy — and with it
 * Mega Darkrai's Abyss Eye, the entire win condition, taking the deck from ~43%
 * to ~24% while every intermediate step measured slightly better.
 *
 * Deliberately *relative*: it blocks a move that removes the last enabler, but it
 * does not reject a deck that never had one. An absolute check looked right and
 * was much worse — for a deck already missing Dark Bell it rejected every single
 * candidate, so the optimiser silently did nothing at all.
 */
function breaksCombo(before, after, index) {
  if (!needsEnabler(after, index)) return false;
  return hasEnabler(before, index) && !hasEnabler(after, index);
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

/** Hand the thread back so the browser can repaint. */
const tick = () => new Promise((r) => { setTimeout(r, 0); });

/**
 * @param {Record<string,number>} startCounts  the deck as it stands
 * @param {Set<string>|string[]} lockedNames   cards the user pinned
 *
 * Async because the search is several hundred simulations and takes about ten
 * seconds. Run straight through it monopolises the main thread: the browser
 * cannot repaint, so a progress bar sits frozen at zero and the page looks hung.
 * Yielding between candidates costs a little throughput and buys an interface
 * that visibly moves.
 *
 * `onProgress` receives { phase, done, total, pct, round, rounds, best, trying }.
 */
export async function optimiseDeck(startCounts, index, meta, opts = {}) {
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
  const original = { ...startCounts };
  const originalSize = Object.values(original).reduce((a, b) => a + b, 0);
  let counts = completeEvolutionLines({ ...startCounts }, index);
  const pool = candidatePool(counts, index, locked);
  counts = makeLegal60(counts, index, pool, locked);

  // The diff must be against what the user actually had, otherwise completing a
  // half-finished deck shows as "no changes" and there is nothing to apply.
  const before = original;
  const wasIncomplete = originalSize !== 60;

  // 1b. Offer a structurally repaired alternative as a second starting point.
  // Hill climbing one card at a time cannot cross a valley — 8 Pokemon to 9
  // measures as nothing, while 8 to 11 fixes the mulligan rate outright — so
  // the fixed version is worth trying. It is only a *candidate*: padding a
  // focused list with filler Pokemon can easily cost more than the mulligan
  // rate gains, so both starts are scored and the better one wins. The prior
  // proposes; the simulation decides.
  const report = (phase, extra = {}) => {
    if (!onProgress) return;
    onProgress({
      phase, done: spent, total: budget,
      pct: Math.min(1, spent / budget), ...extra,
    });
  };

  report('start', { pct: 0 });
  await tick();

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
      if (breaksCombo(counts, cand, index)) continue;   // never cut the win condition
      const s = score(cand, index, meta, games, seed);
      spent++;
      if (best === null || s > best.s) best = { s, move: moves[i], counts: cand };

      report('search', {
        round: round + 1,
        rounds,
        best: Math.max(current, best.s),
        trying: moves[i].add,
      });
      // yield periodically rather than every candidate — often enough for a
      // smooth bar, rarely enough not to dominate the runtime
      if (spent % 4 === 0) await tick();
    }

    // require a real gain, not noise from a single lucky evaluation
    if (!best || best.s <= current + 0.25) break;
    history.push({ round: round + 1, from: current, to: best.s, move: best.move });
    counts = best.counts;
    current = best.s;
  }

  // 3. re-score start and finish on a fresh, larger sample
  report('verify', { pct: 1 });
  await tick();
  const verifySeed = seed + 7919;
  const finalBefore = wasIncomplete
    ? null                                   // an incomplete deck cannot be scored
    : score(before, index, meta, finalGames, verifySeed);
  let finalAfter = score(counts, index, meta, finalGames, verifySeed);

  // If the fresh sample does not confirm the gain, actually hand back the deck
  // the user started with. This previously returned the modified deck while the
  // note claimed the list was left alone, so the Apply button offered changes the
  // optimiser had itself measured as worse. Saying it and doing it must match.
  let reverted = false;
  if (!wasIncomplete && finalAfter <= finalBefore) {
    counts = before;
    finalAfter = finalBefore;
    reverted = true;
  }

  return {
    before, after: counts,
    beforeScore: finalBefore,
    afterScore: finalAfter,
    searchScore: current,
    reverted,
    history,
    structuralNote,
    diff: diffCounts(before, counts),
    locked: [...locked],
    wasIncomplete,
    originalSize,
    note: (finalBefore !== null && finalAfter <= finalBefore)
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

  const wantsEnabler = needsEnabler(out, index);
  const cutOne = () => {
    const cand = Object.keys(out)
      .filter((n) => !locked.has(n) && out[n] > 0
        && !(index[n].category === 'pokemon')
        && !DRAW_SUPPORTERS.has(n)
        // padding the Pokemon line is not worth the deck's win condition
        && !(wantsEnabler && index[n].sim && index[n].sim.appliesSpecialCondition))
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

/**
 * Bring a deck to exactly 60 legal cards without touching pinned entries.
 *
 * This used to add one copy of every candidate in turn, which produced a deck of
 * ~48 singletons that scored 0% — technically 60 cards, useless as a deck. Real
 * lists are built from a small number of cards at sensible counts, so fill from
 * a template of target counts instead, and only then top up with Energy.
 *
 * Every entry has to be a card the engine plays. The previous template was
 * written from a real-format staples list and handed each built deck 3 Buddy-Buddy
 * Poffin, 3 Boss's Orders, 2 Master Ball, 2 Poké Pad, a Prime Catcher and a
 * Maximum Belt — twelve slots the simulator draws as blanks. The deck looked
 * complete and the win rate looked precise while a fifth of the list did nothing.
 */
const FILL_TEMPLATE = [
  ["Lillie's Determination", 4],
  ['Ultra Ball', 4],
  ['Night Stretcher', 3],
  ['Energy Search', 3],
  ['Buddy-Buddy Poffin', 3],
  ["Boss's Orders", 2],
  ['Lacey', 2],
  ['Kofu', 2],
  ['Master Ball', 2],
  ['Switch', 2],
  ['Energy Retrieval', 2],
  ['Energy Switch', 2],
  ["AZ's Tranquility", 1],
  ['Air Balloon', 1],
];

/** How many copies of a combo enabler a real list runs. One is not a plan. */
const ENABLER_TARGET = 4;

/** The best enabler the pool offers, or null. Pool order is already ranked. */
function bestEnabler(index, pool, locked) {
  return pool.find((n) => !locked.has(n) && index[n]
    && index[n].sim && index[n].sim.appliesSpecialCondition) || null;
}

function makeLegal60(counts, index, pool, locked) {
  const out = { ...counts };
  const size = () => Object.values(out).reduce((a, b) => a + b, 0);
  const inPool = new Set(pool);

  const wantsEnabler = needsEnabler(out, index);
  const isEnablerCard = (n) => wantsEnabler && index[n] && index[n].sim
    && index[n].sim.appliesSpecialCondition;

  // trim overflow from the least valuable unpinned cards. The enabler is exempt:
  // trimming it is the one cut that can cost the deck its whole win condition.
  let guard = 0;
  while (size() > 60 && guard++ < 200) {
    const order = Object.keys(out)
      .filter((n) => !locked.has(n) && out[n] > 0 && !isEnablerCard(n))
      .sort((a, b) => (isEnergy(index, a) ? 1 : 0) - (isEnergy(index, b) ? 1 : 0));
    if (!order.length) break;
    const pick = order[order.length - 1];
    out[pick] -= 1;
    if (!out[pick]) delete out[pick];
  }
  if (size() === 60) return out;

  // 0. If the deck holds an attack that only works with a separate enabler, put
  // the enabler in *first*, at a real count. FILL_TEMPLATE is a list of generic
  // staples, so without this a part-built Mega Darkrai list was completed to a
  // legal 60 that could never use Abyss Eye — the reason it was built. Hill
  // climbing could not rescue it either: it only ever proposes one copy at a
  // time, and a single Dark Bell in 60 cards measures as noise, so the move was
  // never accepted. The enabler has to be seeded, not searched for.
  if (wantsEnabler && !hasEnabler(out, index)) {
    const enabler = bestEnabler(index, pool, locked);
    if (enabler) {
      const target = Math.min(ENABLER_TARGET, maxCopies(index, enabler));
      while ((out[enabler] || 0) < target && size() < 60) {
        out[enabler] = (out[enabler] || 0) + 1;
      }
    }
  }

  // 1. bring the Pokemon line up to a workable count, using what is already here
  const monsInDeck = () => Object.entries(out)
    .filter(([n]) => index[n] && index[n].category === 'pokemon')
    .reduce((a, [, c]) => a + c, 0);
  const monCandidates = Object.keys(out)
    .filter((n) => index[n] && index[n].category === 'pokemon' && !locked.has(n));
  guard = 0;
  while (monsInDeck() < 9 && size() < 60 && guard++ < 30) {
    const pick = monCandidates.find((n) => out[n] < maxCopies(index, n));
    if (!pick) break;
    out[pick] += 1;
  }

  // 2. fill the engine from the template, at counts a real list would run
  for (const [name, target] of FILL_TEMPLATE) {
    if (size() >= 60) break;
    if (!index[name] || locked.has(name) || !inPool.has(name)) continue;
    while ((out[name] || 0) < Math.min(target, maxCopies(index, name)) && size() < 60) {
      out[name] = (out[name] || 0) + 1;
    }
  }

  // 3. the rest is Energy the attackers can actually use
  const energyPicks = pool.filter((n) => isEnergy(index, n)
    && index[n].sim && index[n].sim.basicEnergy && !locked.has(n));
  if (energyPicks.length) {
    guard = 0;
    while (size() < 60 && guard++ < 80) {
      out[energyPicks[0]] = (out[energyPicks[0]] || 0) + 1;
    }
  }

  // 4. last resort: anything legal, so the deck is always exactly 60
  guard = 0;
  while (size() < 60 && guard++ < 200) {
    const pick = pool.find((n) => !locked.has(n) && (out[n] || 0) < maxCopies(index, n));
    if (!pick) break;
    out[pick] = (out[pick] || 0) + 1;
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
  const wantsEnabler = needsEnabler(counts, index);
  const targets = exactDamageTargets(counts, index);

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

      // Some improvements only exist in bulk. Raising Pokemon count from 8 to 9
      // does nothing measurable; raising it to 11 fixes the mulligan rate. A
      // pure one-card-at-a-time search cannot cross that gap, so offer a few
      // larger swaps as well.
      //
      // The same valley applies to a combo enabler, and more sharply: one Dark
      // Bell in 60 cards is drawn too rarely to show up over a few hundred games,
      // so the ±1 search rejected it every round and a deck that arrived here
      // without one stayed stuck. Offer it in a playable count instead.
      const card = index[add];
      const isMon = card && card.category === 'pokemon';
      const isEnabler = wantsEnabler && card && card.sim
        && card.sim.appliesSpecialCondition;
      // Retaliate pieces have the same problem as the enabler, twice over: the
      // line needs two different cards to land on the same Active at the same
      // time, so a single copy of either is deep inside the noise floor.
      const isPiece = isRetaliatePiece(add, index, targets);
      const isCombo = isEnabler || isPiece;
      const headroom = maxCopies(index, add) - (counts[add] || 0);
      const big = Math.min(isCombo ? ENABLER_TARGET : 3, headroom, counts[rem]);

      if (isCombo) {
        // Combo pieces are never offered one at a time. A single copy is inside
        // the noise floor, so a lone evaluation can come out ahead by luck — and
        // when it did, the search banked it and stopped, leaving a deck holding
        // exactly one Dark Bell. That is not a plan: it is the same dead combo
        // as zero copies, dressed up as a fix. If we cannot afford a real count
        // against this cut, propose nothing and let another cut carry it.
        if (big >= 2) {
          moves.push({ add, rem, qty: big });
          if (big > 2) moves.push({ add, rem, qty: 2 });
        }
      } else {
        moves.push({ add, rem, qty: 1 });
        // Some improvements only exist in bulk: 8 Pokemon to 9 measures as
        // nothing, 8 to 11 fixes the mulligan rate outright.
        if (isMon && big >= 2) moves.push({ add, rem, qty: big });
      }
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
