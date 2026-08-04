/**
 * Pokémon TCG hybrid battle simulator — JavaScript engine.
 *
 * Direct port of the original Python reference implementation (see python/ptcg_sim.py).
 * Any behavioural change here must keep tests/parity.test.js passing: the JS results
 * have to agree with the recorded Python baselines within Monte Carlo noise.
 *
 * Model
 *   YOUR DECK  — full card-level Monte Carlo: real shuffles, mulligans, prize set,
 *                search, attachment and attack sequencing under a greedy policy.
 *   OPPONENTS  — archetype agents: setup speed from a calibrated distribution, then
 *                card-exact attacker stats, whiff rate, and rebuild delay after a KO.
 *
 * Calibration: an ordinary control shell must score ~50% through this engine.
 * If it doesn't, the opponent model is mis-tuned and no other number means anything.
 */

const DARK = 'D';
const MAX_TURNS = 30;

/* ------------------------------------------------------------------ RNG --- */
/** Mulberry32 — small, fast, seedable. Deterministic across JS runtimes. */
export function makeRng(seed) {
  let a = seed >>> 0;
  const rand = () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  rand.gauss = (mu, sd) => {
    // Box-Muller
    let u = 0, v = 0;
    while (u === 0) u = rand();
    while (v === 0) v = rand();
    return mu + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  return rand;
}

function shuffle(rng, list) {
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.min(i, Math.floor(rng() * (i + 1)));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

function choice(rng, seq) {
  return seq[Math.min(seq.length - 1, Math.floor(rng() * seq.length))];
}

/* -------------------------------------------------------------- helpers --- */

/**
 * Legacy export kept for readability elsewhere. The engine no longer relies on it —
 * anything with a `sim.attacks` array is treated as an attacker, so a card added to
 * data/cards.json can fight without touching this file.
 */
export const ATTACKER_IDS = new Set(['Mega Darkrai ex', 'Mega Absol ex']);

/** Basic = stage 0. Cards without a stage are treated as Basic. */
export function isBasic(card) {
  return !card || !card.stage;
}

/** Names in this spec that can actually attack. */
function attackerNames(spec) {
  return new Set(Object.entries(spec)
    .filter(([, d]) => Array.isArray(d.attacks) && d.attacks.length)
    .map(([n]) => n));
}

/**
 * Can `mon` pay `cost`? [C] accepts any Energy; typed symbols need that type.
 * `symOf` maps an attached Energy card name to the symbol it provides, so the
 * engine works for any deck rather than assuming Darkness.
 */
function canPay(mon, cost, symOf) {
  const total = mon.energy.length;
  let need = 0;
  for (const [sym, n] of Object.entries(cost)) {
    need += n;
    if (sym === 'C') continue;
    if (mon.energy.filter((e) => symOf(e) === sym).length < n) return false;
  }
  return total >= need;
}

/**
 * What this Pokemon still needs to use its *best* attack — not its cheapest.
 *
 * Targeting the cheapest attack is wrong and was a real regression: Mega Darkrai
 * would stop at 2 Energy because Dusk Raid was payable, and never reach the 3 it
 * needs for Abyss Eye, which is the whole point of the deck. Knockout effects
 * outrank damage; ties go to the cheaper cost.
 */
function energyShortfall(S, mon) {
  const card = S.card(mon.name);
  if (!card || !Array.isArray(card.attacks) || !card.attacks.length) return null;
  let best = null;
  for (const atk of card.attacks) {
    const cost = atk.cost || {};
    const total = Object.values(cost).reduce((a, b) => a + b, 0);
    const missing = [];
    for (const [sym, n] of Object.entries(cost)) {
      if (sym === 'C') continue;
      const have = mon.energy.filter((e) => S.symOf(e) === sym).length;
      for (let i = have; i < n; i++) missing.push(sym);
    }
    const shortAny = Math.max(0, total - mon.energy.length - missing.length);
    const gap = missing.length + shortAny;
    // A Special-Condition knockout is worth fuelling toward, because we can turn
    // the condition on ourselves (Dark Bell). A knockout that needs the opponent
    // to be sitting on an exact damage total is situational, so it must not drive
    // Energy attachment — otherwise Mega Absol stops at 2 Energy waiting for a
    // coincidence and never powers its 200-damage attack.
    const value = atk.koIfSpecialCondition ? 9999
      : (typeof atk.koIfExactDamage === 'number') ? 0
        : (atk.damage || 0) + (atk.bonusIfOwnBenchDamaged || 0);
    if (best === null || value > best.value
        || (value === best.value && total < best.total)) {
      best = { gap, missing, shortAny, value, total };
    }
  }
  return best;
}

/**
 * Pick the best attack this Pokémon can use right now.
 * Knockout effects win; otherwise highest damage.
 */
/**
 * Best printed damage this Pokemon could deal right now. No RNG, no bonuses.
 *
 * Auto-knockout attacks are excluded on purpose: whether Abyss Eye can fire
 * depends on a Special Condition that a gust card may be about to apply, so
 * counting it here would make the gust decision argue from its own conclusion.
 */
function payableDamage(S, mon) {
  const card = S.card(mon.name);
  if (!card || !Array.isArray(card.attacks)) return 0;
  let best = 0;
  for (const atk of card.attacks) {
    if (!canPay(mon, atk.cost || {}, (e) => S.symOf(e))) continue;
    if (atk.koIfSpecialCondition || typeof atk.koIfExactDamage === 'number') continue;
    best = Math.max(best, atk.damage || 0);
  }
  return best;
}

function chooseAttack(S, mon, opp, bonusDamage, rng) {
  const card = S.card(mon.name);
  if (!card || !Array.isArray(card.attacks)) return null;

  // a card in hand that can inflict a Special Condition on the opponent
  const conditionCard = Object.keys(S.spec).find((n) =>
    S.spec[n].appliesSpecialCondition && S.hand.includes(n));

  let best = null;
  for (const atk of card.attacks) {
    if (!canPay(mon, atk.cost || {}, (e) => S.symOf(e))) continue;

    if (atk.koIfSpecialCondition) {
      // The condition may already be there. Lisia's Appeal Confuses the Pokemon
      // it drags up, and that Confusion is not type-restricted the way Dark
      // Bell's is — so this is the one route by which Abyss Eye can knock out
      // something in a Darkness deck, though only the Benched Basic it pulled
      // up rather than the archetype's actual attacker.
      if (opp.confusedActive) {
        return { ko: true, dmg: 0, reason: 'auto_ko', name: atk.name,
          via: 'specialCondition' };
      }
      // Dark Bell only Confuses non-[D] Pokémon, so a Darkness opponent is immune
      if (!conditionCard) continue;
      if (S.spec[conditionCard].onlyNonDark && opp.darkType) continue;
      const cand = { ko: true, dmg: 0, reason: 'auto_ko', name: atk.name,
        usesCard: conditionCard, via: 'specialCondition' };
      return cand;                                   // a KO beats any damage roll
    }

    if (typeof atk.koIfExactDamage === 'number') {
      if (opp.dmgOnActive !== atk.koIfExactDamage) continue;
      return { ko: true, dmg: 0, reason: 'auto_ko', name: atk.name,
        via: 'exactDamage' };
    }

    // Night Joker and friends: use the best attack from a matching Benched
    // Pokemon instead of a printed damage number.
    if (atk.copiesBenchedAttack) {
      let borrowed = 0;
      for (const m of S.bench) {
        if (!m.name.includes(atk.copiesBenchedAttack)) continue;
        for (const b of (S.card(m.name).attacks || [])) {
          if (b.copiesBenchedAttack) continue;          // no recursion
          borrowed = Math.max(borrowed, b.damage || 0);
        }
      }
      if (borrowed > 0) {
        const d = borrowed + bonusDamage;
        if (!best || d > best.dmg) {
          best = { ko: false, dmg: d, reason: 'attack', name: atk.name };
        }
      }
      continue;
    }

    let dmg = (atk.damage || 0) + bonusDamage;
    if (atk.bonusIfOwnBenchDamaged && S.benchHasDamage()) {
      dmg += atk.bonusIfOwnBenchDamaged;
    }
    if (atk.flipUntilTailsBonus) {
      while (rng() < 0.5) dmg += atk.flipUntilTailsBonus;
    }
    if (!best || dmg > best.dmg) {
      best = { ko: false, dmg, reason: 'attack', name: atk.name };
    }
  }
  return best;
}
/**
 * Supporters whose job is refilling your hand. Counted for deck-shape advice and
 * played by the turn policy.
 *
 * `draw` is how many cards the sim gives you. Cards with conditional or
 * board-dependent draw (Morty's Conviction scales off the opponent's Bench,
 * Emcee's Hype off their Prize count) are approximated with a typical value —
 * good enough to judge whether a deck can function, not a substitute for the
 * real card. `shuffle` means hand goes back into the deck first.
 */
export const DRAW_SUPPORTER_INFO = {
  "Lillie's Determination": { draw: 6, shuffle: true, firstTurnDraw: 8 },
  'Lacey': { draw: 4, shuffle: true },
  'Judge': { draw: 4, shuffle: true },
  "Team Rocket's Archer": { draw: 5, shuffle: true },
  "Iris's Fighting Spirit": { drawTo: 6 },
  "Team Rocket's Ariana": { drawTo: 5 },
  'Naveen': { drawTo: 5 },
  'Kofu': { draw: 4 },
  "Emcee's Hype": { draw: 3 },
  "Morty's Conviction": { draw: 3 },
  'Gwynn': { draw: 3 },
  'Emma': { draw: 2 },
  "Billy & O'Nare": { draw: 2 },
  "Explorer's Guidance": { draw: 2 },
  "Team Rocket's Petrel": { search: true },
  'Jett': { draw: 0 },
};

export const DRAW_SUPPORTERS = new Set(Object.keys(DRAW_SUPPORTER_INFO));

/**
 * Trainers the play policy actually plays.
 *
 * There is no generic effect dispatcher: the turn loop reaches for cards by
 * name, and `sim.effect` in cards.json is documentation rather than behaviour.
 * A Trainer missing from this set is shuffled in, drawn, held, and never used —
 * it occupies a slot and does nothing, so a deck full of them reports a win rate
 * measured on far fewer than 60 working cards.
 *
 * Keeping the list beside the policy lets the builder say that out loud instead
 * of quietly overstating a list. Add a name here only when the turn loop really
 * uses it — an entry here that the policy ignores is worse than no entry at all,
 * because it turns an honest warning into a false reassurance.
 *
 * Deliberately NOT included, because the opponent model still cannot represent
 * what they do: Tool Scrapper and Crushing Hammer, which need the opponent's
 * Tools and Energy attachments, and neither exists. meta.json now gives each
 * archetype a Bench, which is what unblocked the gust cards, but its Active is
 * otherwise a bundle of statistics with no cards attached to it.
 */
export const PLAYED_TRAINERS = new Set([
  // Items with bespoke policy call sites
  'Ultra Ball', 'Night Stretcher', 'Switch', 'Energy Search', 'Energy Retrieval',
  'Energy Switch', 'Rare Candy',
  // Items driven by the ITEM_EFFECTS registry
  'Buddy-Buddy Poffin', 'Master Ball', 'Poké Ball', 'Poké Pad', 'Super Potion',
  // Gust cards, played by maybeGust against the archetype's Bench
  'Prime Catcher', "Boss's Orders", "Lisia's Appeal",
  // Tools
  'Air Balloon', 'Punk Helmet', 'Powerglass', 'Amulet of Hope',
  "Hero's Cape", 'Maximum Belt',
  // Supporters with bespoke handling, beyond the draw list
  "AZ's Tranquility", "Janine's Secret Art", "Black Belt's Training",
  ...DRAW_SUPPORTERS,
]);

const TRAINER_KINDS = new Set(['item', 'tool', 'supporter']);

/**
 * Dark Bell and anything like it is reached for by capability, not by name, so
 * it counts as played without being listed above.
 */
export function isPlayedTrainer(name, d) {
  return PLAYED_TRAINERS.has(name) || Boolean(d && d.appliesSpecialCondition);
}

/**
 * A deck spec is { cardName: { n, kind, ...simFields } }.
 * `kind` is one of pokemon | item | tool | supporter | energy.
 */
export function buildDecklist(spec) {
  const out = [];
  for (const [name, d] of Object.entries(spec)) {
    for (let i = 0; i < d.n; i++) out.push(name);
  }
  return out;
}

export function deckSize(spec) {
  return Object.values(spec).reduce((a, c) => a + c.n, 0);
}

/** Tournament legality: exactly 60 cards, max 4 of any non-basic-Energy card. */
export function validateDeck(spec) {
  const errors = [];
  const warnings = [];
  const size = deckSize(spec);
  if (size !== 60) {
    errors.push(`Deck is ${size} cards — must be exactly 60.`);
  }
  for (const [name, d] of Object.entries(spec)) {
    if (d.n > 4 && !d.basicEnergy) {
      errors.push(`${d.n}× ${name} exceeds the 4-copy limit.`);
    }
  }
  const pokemon = Object.values(spec)
    .filter((d) => d.kind === 'pokemon').reduce((a, c) => a + c.n, 0);
  if (pokemon === 0) errors.push('Deck contains no Pokémon.');

  // every evolution needs something to evolve from
  for (const [name, d] of Object.entries(spec)) {
    if (d.kind === 'pokemon' && d.evolvesFrom && !spec[d.evolvesFrom]) {
      const viaCandy = spec['Rare Candy'] && d.stage === 2;
      (viaCandy ? warnings : errors).push(
        `${name} evolves from ${d.evolvesFrom}, which is not in the deck.`);
    }
  }

  const basics = Object.entries(spec)
    .filter(([, d]) => d.kind === 'pokemon' && isBasic(d))
    .reduce((a, [, d]) => a + d.n, 0);
  if (size === 60 && basics === 0) errors.push('Deck contains no Basic Pokémon.');
  if (size === 60 && basics > 0 && basics < 10) {
    warnings.push(
      `Only ${basics} Pokémon — mulligan rate ${(mulliganRate(spec) * 100).toFixed(1)}%. ` +
      'Competitive lists normally run 12–16.');
  }
  // An attacker whose attacks are all effect-text does nothing in the sim. Say so
  // rather than reporting a confident win rate built on a Pokemon that never swings.
  const inert = Object.entries(spec).filter(([, d]) =>
    d.kind === 'pokemon' && Array.isArray(d.attacks) && d.attacks.length
    && d.attacks.every((a) => !a.damage && !a.koIfSpecialCondition
      && typeof a.koIfExactDamage !== 'number' && !a.copiesBenchedAttack));
  if (inert.length && size === 60) {
    warnings.push(
      `${inert.map(([n]) => n).join(', ')} ${inert.length > 1 ? 'have' : 'has'} no `
      + 'damage the simulator understands — their attacks are effect text that is not '
      + 'modelled, so they will not attack. Treat the win rate as a lower bound.');
  }

  // Trainers the policy never reaches for are drawn as blanks. This is the single
  // most misleading thing the simulator can do, because the deck looks full and
  // the win rate looks precise while a chunk of the list is doing nothing.
  const inertTrainers = Object.entries(spec)
    .filter(([n, d]) => TRAINER_KINDS.has(d.kind) && !isPlayedTrainer(n, d));
  if (inertTrainers.length && size === 60) {
    const slots = inertTrainers.reduce((a, [, d]) => a + d.n, 0);
    warnings.push(
      `${slots} card${slots > 1 ? 's' : ''} the simulator never plays: `
      + `${inertTrainers.map(([n, d]) => `${d.n}× ${n}`).join(', ')}. `
      + 'These are not modelled, so they are drawn as blanks — the deck is '
      + `effectively being simulated as ${60 - slots} working cards. Real games `
      + 'will run better than the number shown.');
  }

  // A card can be modelled and still be dead in a particular list. Buddy-Buddy
  // Poffin only fetches Basics of 70 HP or less; in a deck whose smallest Basic
  // is 110 it never hits anything. Flagged rather than blocked — it is a legal
  // inclusion and the choice belongs to whoever built the deck.
  const basicHps = Object.values(spec)
    .filter((d) => d.kind === 'pokemon' && isBasic(d) && typeof d.hp === 'number')
    .map((d) => d.hp);
  if (basicHps.length) {
    const smallest = Math.min(...basicHps);
    for (const [n, d] of Object.entries(spec)) {
      if (typeof d.hpLimit === 'number' && smallest > d.hpLimit) {
        warnings.push(
          `${n} searches for Basic Pokémon with ${d.hpLimit} HP or less, and the `
          + `smallest Basic in this deck has ${smallest} HP. It can never find a `
          + 'target — those slots are doing nothing.');
      }
    }
  }

  // The play policy was built around Basic attackers. It evolves when it draws the
  // pieces, but it does not search out evolutions or model Abilities that
  // accelerate Energy, so evolution decks are played worse than a human would.
  const evoAttackers = Object.entries(spec).filter(([, d]) =>
    d.kind === 'pokemon' && d.stage >= 1 && Array.isArray(d.attacks) && d.attacks.length);
  if (evoAttackers.length && size === 60) {
    const worst = Math.max(...evoAttackers.map(([, d]) => d.stage));
    warnings.push(
      `Main attackers are Stage ${worst}. The simulator evolves when it draws the `
      + 'pieces but does not tutor for evolutions or model Ability-based Energy '
      + 'acceleration, so it plays these decks worse than you would. Read the win '
      + 'rate as a lower bound, and compare evolution decks against each other '
      + 'rather than against Basic-attacker decks.');
  }

  const draw = Object.entries(spec)
    .filter(([n]) => DRAW_SUPPORTERS.has(n)).reduce((a, [, d]) => a + d.n, 0);
  if (draw < 4) {
    warnings.push(
      `Only ${draw} draw Supporters. Four shuffle-draw cards is the practical floor — ` +
      'below that the deck cannot reliably find its attacker and Energy in the same turn.');
  }
  return { ok: errors.length === 0, errors, warnings };
}

function logC(n, k) {
  let r = 0;
  for (let i = 0; i < k; i++) r += Math.log(n - i) - Math.log(i + 1);
  return r;
}

/** Exact hypergeometric probability that an opening 7 contains no Basic Pokémon. */
export function mulliganRate(spec) {
  const size = deckSize(spec);
  const basics = Object.values(spec)
    .filter((d) => d.kind === 'pokemon' && isBasic(d)).reduce((a, c) => a + c.n, 0);
  if (size - basics < 7) return 0;
  return Math.exp(logC(size - basics, 7) - logC(size, 7));
}

export function deckStats(spec) {
  const by = (k) => Object.values(spec)
    .filter((d) => d.kind === k).reduce((a, c) => a + c.n, 0);
  return {
    size: deckSize(spec),
    pokemon: by('pokemon'),
    energy: by('energy'),
    trainers: by('item') + by('tool') + by('supporter') + by('stadium'),
    drawSupporters: Object.entries(spec)
      .filter(([n]) => DRAW_SUPPORTERS.has(n)).reduce((a, [, d]) => a + d.n, 0),
    mulligan: mulliganRate(spec) * 100,
  };
}

/* ----------------------------------------------------------- your side --- */

class Side {
  constructor(spec, rng) {
    this.spec = spec;
    this.rng = rng;
    this.attackers = attackerNames(spec);
    this.turn = 0;
    this.deck = [];
    this.hand = [];
    this.discard = [];
    this.prizes = [];
    this.bench = [];
    this.active = null;
    this.mulligans = 0;
    this.prizesTaken = 0;
    this.supporterUsed = false;
    this.energyAttached = false;
    this.turnsStuck = 0;
    this.firstAttackTurn = null;
    this.abyssEyeKos = 0;
    this.duskRaidKos = 0;
    // Auto-knockouts split by how they were set up. These used to be pooled into
    // abyssEyeKos, so a Terminal Period knockout — a completely different line,
    // driven by retaliate damage rather than by Dark Bell — was reported as an
    // Abyss Eye. `absolKos` was declared beside them and never once incremented.
    this.exactDamageKos = 0;
    this.gustKos = 0;
    this.itemsPlayed = [];
  }

  card(name) { return this.spec[name]; }

  /** A Basic Pokemon card that can legally be put down from hand. */
  isPlayableBasic(name) {
    const d = this.spec[name];
    return !!d && d.kind === 'pokemon' && isBasic(d);
  }

  /** All Pokemon currently in play. */
  inPlay() { return [this.active, ...this.bench].filter(Boolean); }

  newMon(name) {
    const d = this.spec[name];
    return {
      name, dmg: 0, hp: d.hp, prizes: d.prizes, energy: [],
      tool: null, confused: false, poisoned: false,
      turnPlayed: this.turn,
    };
  }

  opening() {
    for (;;) {
      this.deck = buildDecklist(this.spec);
      shuffle(this.rng, this.deck);
      this.hand = [];
      for (let i = 0; i < 7; i++) this.hand.push(this.deck.pop());
      if (this.hand.some((c) => this.isPlayableBasic(c))) break;
      this.mulligans++;
      if (this.mulligans > 12) break;
    }
    this.prizes = [];
    for (let i = 0; i < 6; i++) this.prizes.push(this.deck.pop());

    const basics = this.hand.filter((c) => this.isPlayableBasic(c));
    if (basics.length === 0) return;
    const pick = basics.find((c) => this.attackers.has(c)) || basics[0];
    this.hand.splice(this.hand.indexOf(pick), 1);
    this.active = this.newMon(pick);
    for (const c of [...this.hand]) {
      if (this.isPlayableBasic(c) && this.bench.length < 5) {
        this.hand.splice(this.hand.indexOf(c), 1);
        this.bench.push(this.newMon(c));
      }
    }
  }

  draw(n) {
    let got = 0;
    for (let i = 0; i < n; i++) {
      if (this.deck.length === 0) return got;
      this.hand.push(this.deck.pop());
      got++;
    }
    return got;
  }

  /** Energy card name -> the symbol it provides. */
  symOf(cardName) {
    const d = this.spec[cardName];
    return (d && d.provides) || 'C';
  }

  /** Energy cards in hand, best first for what `mon` still needs. */
  energyInHand(mon) {
    const names = this.hand.filter((c) => this.spec[c] && this.spec[c].kind === 'energy');
    if (!mon) return names;
    const want = energyShortfall(this, mon);
    if (!want || !want.missing.length) return names;
    return names.sort((a, b) =>
      (want.missing.includes(this.symOf(b)) ? 1 : 0)
      - (want.missing.includes(this.symOf(a)) ? 1 : 0));
  }

  darkCount(m) { return m.energy.filter((e) => this.symOf(e) === DARK).length; }
  totalEnergy(m) { return m.energy.length; }
  benchHasDamage() { return this.bench.some((m) => m.dmg > 0); }

  takePrizes(n) {
    for (let i = 0; i < n; i++) {
      if (this.prizes.length) { this.hand.push(this.prizes.pop()); this.prizesTaken++; }
    }
  }

  searchDeck(pred, limit = 1) {
    const found = [];
    for (const c of [...this.deck]) {
      if (found.length >= limit) break;
      if (pred(c)) { this.deck.splice(this.deck.indexOf(c), 1); found.push(c); }
    }
    shuffle(this.rng, this.deck);
    this.hand.push(...found);
    return found;
  }

  has(name) { return this.hand.includes(name); }
  play(name) {
    const i = this.hand.indexOf(name);
    if (i < 0) return false;
    this.hand.splice(i, 1);
    this.discard.push(name);
    return true;
  }
}

/* --------------------------------------------------------- turn policy --- */

// Best first: biggest refill, then partial draw, then tutors.
const DRAW_ORDER = Object.entries(DRAW_SUPPORTER_INFO)
  .sort((a, b) => {
    const score = (d) => (d.shuffle ? 100 : 0) + (d.draw || 0) + (d.drawTo || 0)
      + (d.search ? 1 : 0);
    return score(b[1]) - score(a[1]);
  })
  .map(([name]) => name);

function playDrawSupporter(S) {
  if (S.supporterUsed) return false;
  for (const s of DRAW_ORDER) {
    if (!S.has(s)) continue;
    const info = DRAW_SUPPORTER_INFO[s];
    S.play(s);
    S.supporterUsed = true;

    if (info.shuffle) {
      S.deck.push(...S.hand); S.hand = []; shuffle(S.rng, S.deck);
      S.draw(info.firstTurnDraw && S.prizes.length === 6 ? info.firstTurnDraw : info.draw);
      return true;
    }
    if (info.drawTo) {
      S.draw(Math.max(0, info.drawTo - S.hand.length));
      return true;
    }
    if (!info.search) {
      if (info.draw) S.draw(info.draw);
      else S.dead_draw_turns = (S.dead_draw_turns || 0) + 1;
      return true;
    }
    if (s === "Team Rocket's Petrel") {
      const A = S.active;
      let want;
      if (![S.active, ...S.bench].some((m) => m && S.attackers.has(m.name))) want = 'Ultra Ball';
      else if (A && S.darkCount(A) >= 3) {
        want = Object.keys(S.spec).find((n) => S.spec[n].appliesSpecialCondition)
          || 'Energy Search';
      }
      else want = 'Energy Search';
      if (S.searchDeck((c) => c === want, 1).length === 0) {
        S.searchDeck((c) => c === 'Ultra Ball', 1);
      }
    }
    return true;
  }
  return false;
}

/**
 * Fetch the most useful Pokemon the deck can offer, subject to `ok`.
 *
 * Shared by every search Item. Preference order is the same one Ultra Ball has
 * always used: the strongest Basic attacker, then a Basic that leads to one,
 * then any playable Basic, then anything at all. Pulled out of `ultraBall` so
 * Master Ball and friends make the same choice instead of each re-deriving it
 * slightly differently.
 */
function fetchBestPokemon(S, ok = () => true) {
  const rank = (n) => {
    const a = S.card(n).attacks || [];
    return Math.max(0, ...a.map((x) => (x.damage || 0) + (x.koIfSpecialCondition ? 999 : 0)));
  };
  const tryFor = (pred) => S.searchDeck((c) => ok(c) && pred(c), 1);

  const wanted = [...S.attackers].sort((a, b) => rank(b) - rank(a));
  for (const w of wanted) {
    if (!isBasic(S.card(w))) continue;
    const got = tryFor((c) => c === w);
    if (got.length) return got;
  }
  for (const b of basicsLeadingToAttackers(S)) {
    const got = tryFor((c) => c === b);
    if (got.length) return got;
  }
  let got = tryFor((c) => S.isPlayableBasic(c));
  if (!got.length) got = tryFor((c) => S.card(c).kind === 'pokemon');
  return got;
}

/**
 * Self-contained card effects, keyed by `sim.effect` in data/cards.json.
 *
 * Signature: (S, d) => boolean, where `d` is the card's own spec entry and the
 * return value says whether the card was spent. A handler reads its numbers from
 * `d` — heal amount, search limit, HP cap, coin-flip chance — so adding a card
 * that reuses an existing effect is a data change in cards.json, not a code
 * change here. That is the entire point of the registry: `sim.effect` used to be
 * decorative, and cards carrying it were drawn as blanks.
 *
 * Note what is deliberately NOT here. Ultra Ball, Night Stretcher, Switch, Rare
 * Candy, Energy Search, Energy Retrieval and Energy Switch keep their bespoke
 * call sites, because for those the interesting question is *when* to play them
 * — mid-retreat, mid-evolution, mid-Energy-maths — and that sequencing is turn
 * policy rather than card text. Moving them behind a uniform signature would
 * have meant threading the surrounding local state through the registry for no
 * behavioural gain and a real regression risk.
 */
export const ITEM_EFFECTS = {
  /** Ultra Ball, Master Ball, Poké Ball, Poké Pad. */
  searchPokemon(S, d) {
    const noRuleBox = (c) => (S.card(c).prizes || 1) === 1;
    const ok = d.noRuleBox ? noRuleBox : () => true;
    if (!S.deck.some((c) => S.card(c).kind === 'pokemon' && ok(c))) return false;
    if (d.discardCost) {
      if (S.hand.length < d.discardCost) return false;
      for (let i = 0; i < d.discardCost; i++) {
        if (!S.hand.length) break;
        const junk = S.hand.find((c) =>
          ['Jett', 'Air Balloon', 'Spiky Energy', 'Energy Search'].includes(c))
          || choice(S.rng, S.hand);
        S.hand.splice(S.hand.indexOf(junk), 1);
        S.discard.push(junk);
      }
    }
    // A tails flip still spends the card — that is the cost of a coin-flip Item
    // and pretending otherwise would make Poké Ball strictly better than it is.
    if (typeof d.chance === 'number' && S.rng() >= d.chance) return true;
    return fetchBestPokemon(S, ok).length > 0;
  },

  /**
   * Buddy-Buddy Poffin. Only reaches Basics at or under `hpLimit`, which is why
   * it is dead in a deck whose smallest Basic is bigger — validateDeck warns
   * about exactly that rather than letting it look like a live card.
   */
  searchSmallBasics(S, d) {
    const ok = (c) => S.isPlayableBasic(c) && (S.card(c).hp || 0) <= d.hpLimit;
    if (S.bench.length >= 5 || !S.deck.some(ok)) return false;
    const room = Math.min(d.count || 1, 5 - S.bench.length);
    const got = S.searchDeck(ok, room);
    for (const g of got) {
      S.hand.splice(S.hand.indexOf(g), 1);
      S.bench.push(S.newMon(g));
    }
    return got.length > 0;
  },

  /** Super Potion. Worth a card only on something actually worth healing. */
  healAndDiscardEnergy(S, d) {
    const target = S.inPlay()
      .filter((m) => m.dmg > 0 && m.energy.length > 0)
      .sort((a, b) => b.dmg - a.dmg)[0];
    if (!target || target.dmg < d.heal / 2) return false;
    target.dmg = Math.max(0, target.dmg - d.heal);
    S.discard.push(target.energy.pop());
    return true;
  },
};

/**
 * Play a gust card, if dragging something up beats hitting what is already there.
 *
 * The heuristic is deliberately narrow: gust only when we cannot Knock Out their
 * Active this turn but can Knock Out the Benched target. Gusting is not free
 * value — you are trading a card and a turn of damage for a one-prize Pokemon
 * instead of a two-prize one — so a policy that gusted whenever it held the card
 * would make decks measurably worse and would misrepresent what these cards do.
 *
 * Handles Boss's Orders and Prime Catcher (`gust`) and Lisia's Appeal
 * (`gustAndConfuse`, which also leaves the dragged-up Pokemon Confused — a real
 * Special Condition, so Abyss Eye can then knock it out outright).
 */
function maybeGust(S, opp, ourDamage) {
  if (opp.gusted || !opp.bench) return false;
  // Already lethal on what is in front of us: nothing to gain.
  if (ourDamage >= opp.hpLeft) return false;
  if (ourDamage < opp.bench.hp) return false;

  for (const name of [...new Set(S.hand)]) {
    const d = S.card(name);
    if (!d || (d.effect !== 'gust' && d.effect !== 'gustAndConfuse')) continue;
    const isSupporter = d.kind === 'supporter';
    if (isSupporter && S.supporterUsed) continue;
    S.play(name);
    if (isSupporter) S.supporterUsed = true;
    S.itemsPlayed.push(name);
    opp.gustTo(opp.bench, d.effect === 'gustAndConfuse');
    return true;
  }
  return false;
}

/** Items whose timing is decided by bespoke policy, not the generic pass. */
const POLICY_MANAGED = new Set([
  'Ultra Ball', 'Night Stretcher', 'Switch', 'Rare Candy',
  'Energy Search', 'Energy Retrieval', 'Energy Switch',
]);

/**
 * Play every registry-backed Item that would do something this turn.
 *
 * Items are unlimited per turn, so this loops until nothing more is useful. The
 * handler decides whether the card accomplishes anything; a card that returns
 * false is left in hand rather than burned, which matters for Poffin in a deck
 * that has temporarily run out of small Basics.
 */
function playRegistryItems(S) {
  let guard = 0;
  let played = true;
  while (played && guard++ < 12) {
    played = false;
    for (const name of [...new Set(S.hand)]) {
      if (POLICY_MANAGED.has(name)) continue;
      const d = S.card(name);
      if (!d || d.kind !== 'item') continue;
      const fn = ITEM_EFFECTS[d.effect];
      if (!fn) continue;
      const i = S.hand.indexOf(name);
      S.hand.splice(i, 1);
      if (fn(S, d)) {
        S.discard.push(name);
        S.itemsPlayed.push(name);
        played = true;
      } else {
        S.hand.push(name);
      }
    }
  }
}

function ultraBall(S) {
  if (!S.has('Ultra Ball') || S.hand.length < 3) return false;
  S.play('Ultra Ball');
  return ITEM_EFFECTS.searchPokemon(S, { ...S.card('Ultra Ball'), discardCost: 2 });
}

/**
 * Play evolutions from hand. A Pokemon cannot evolve on the turn it was played,
 * which is what makes Stage 2 decks slow and is the whole reason Rare Candy exists.
 */
function doEvolutions(S, turn) {
  let evolved = true;
  while (evolved) {
    evolved = false;
    for (const mon of S.inPlay()) {
      if (mon.turnPlayed >= turn) continue;             // came down this turn
      // direct evolution
      const up = S.hand.find((c) => {
        const d = S.card(c);
        return d && d.kind === 'pokemon' && d.evolvesFrom === mon.name;
      });
      if (up) {
        S.hand.splice(S.hand.indexOf(up), 1);
        S.discard.push(mon.name);
        const d = S.card(up);
        mon.name = up;
        mon.hp = d.hp;
        mon.prizes = d.prizes;
        // damage, Energy and Tools stay on the Pokemon through evolution
        evolved = true;
        continue;
      }
      // Rare Candy: Basic straight to Stage 2
      if (S.has('Rare Candy') && isBasic(S.card(mon.name))) {
        const s2 = S.hand.find((c) => {
          const d = S.card(c);
          if (!d || d.kind !== 'pokemon' || d.stage !== 2) return false;
          const mid = S.card(d.evolvesFrom);
          return mid && mid.evolvesFrom === mon.name;
        });
        if (s2) {
          S.play('Rare Candy');
          S.hand.splice(S.hand.indexOf(s2), 1);
          S.discard.push(mon.name);
          const d = S.card(s2);
          mon.name = s2;
          mon.hp = d.hp;
          mon.prizes = d.prizes;
          evolved = true;
        }
      }
    }
  }
}

/** Basics in this deck that lead to an attacker, best line first. */
function basicsLeadingToAttackers(S) {
  const out = new Map();
  for (const atkName of S.attackers) {
    const power = Math.max(0, ...(S.card(atkName).attacks || [])
      .map((a) => (a.damage || 0) + (a.koIfSpecialCondition ? 999 : 0)));
    let cur = S.card(atkName);
    let name = atkName;
    let guard = 0;
    while (cur && cur.evolvesFrom && guard++ < 4) {
      name = cur.evolvesFrom;
      cur = S.card(name);
    }
    if (cur && isBasic(cur)) {
      out.set(name, Math.max(out.get(name) || 0, power));
    }
  }
  return [...out.entries()].sort((a, b) => b[1] - a[1]).map(([n]) => n);
}

function userTurn(S, opp, turn) {
  S.supporterUsed = false;
  S.energyAttached = false;
  S.turn = turn;
  if (!S.active) return { ko: false, dmg: 0, reason: 'no_active' };
  if (S.draw(1) === 0) return { ko: false, dmg: 0, deckout: true };

  const megasInPlay = () =>
    [S.active, ...S.bench].filter((m) => m && S.attackers.has(m.name));

  const benchAll = () => {
    for (const c of [...S.hand]) {
      if (S.isPlayableBasic(c) && S.bench.length < 5) {
        S.hand.splice(S.hand.indexOf(c), 1);
        S.bench.push(S.newMon(c));
      }
    }
  };
  benchAll();
  doEvolutions(S, turn);

  // Registry Items first: they fetch bodies and Pokemon into hand, so running
  // them before the dig means the dig sees what they found instead of spending
  // an Ultra Ball on something Poffin would have benched for free.
  playRegistryItems(S);
  benchAll();

  // dig for an attacker if we have none
  if (megasInPlay().length === 0) {
    ultraBall(S);
    if (megasInPlay().length === 0 && !S.supporterUsed) {
      playDrawSupporter(S);
      ultraBall(S);
    }
    if (S.has('Night Stretcher') && S.discard.some((c) => S.attackers.has(c))) {
      S.play('Night Stretcher');
      const i = S.discard.findIndex((c) => S.attackers.has(c));
      if (i >= 0) S.hand.push(S.discard.splice(i, 1)[0]);
    }
    benchAll();
  }

  // put a Mega in the Active spot
  if (!S.attackers.has(S.active.name)) {
    const idx = S.bench.findIndex((m) => S.attackers.has(m.name));
    if (idx >= 0) {
      let moved = false;
      if (S.has('Switch')) { S.play('Switch'); moved = true; }
      else if (S.active.tool === 'Air Balloon') moved = true;
      else if (!S.supporterUsed && S.has("AZ's Tranquility")) {
        S.play("AZ's Tranquility"); S.supporterUsed = true; moved = true;
      } else if (S.totalEnergy(S.active) >= (S.card(S.active.name).retreat || 0)) {
        const cost = S.card(S.active.name).retreat || 0;
        for (let i = 0; i < cost; i++) {
          S.discard.push(S.active.energy.pop());
        }
        moved = true;
      }
      if (moved) { S.bench.push(S.active); S.active = S.bench.splice(idx, 1)[0]; }
    }
  }

  // keep bodies on the board — bench-out is a real failure mode
  const bodies = [S.active, ...S.bench].filter(Boolean).length;
  if (bodies <= 2) {
    if (S.has('Night Stretcher') && S.discard.some((c) => S.isPlayableBasic(c))) {
      S.play('Night Stretcher');
      const i = S.discard.findIndex((c) => S.isPlayableBasic(c));
      if (i >= 0) S.hand.push(S.discard.splice(i, 1)[0]);
    }
    if (bodies <= 1) ultraBall(S);
    benchAll();
    doEvolutions(S, turn);
  }

  const A = S.active;
  const isAttacker = S.attackers.has(A.name);
  const needsEnergy = (m) => {
    const sf = energyShortfall(S, m);
    return sf ? sf.gap > 0 : false;
  };

  // Supporter that enables an attack
  if (!S.supporterUsed && isAttacker && needsEnergy(A) && S.has("Janine's Secret Art")
      && S.deck.filter((c) => S.spec[c] && S.symOf(c) === DARK
        && S.spec[c].kind === 'energy').length >= 1) {
    S.play("Janine's Secret Art");
    S.supporterUsed = true;
    const got = S.searchDeck((c) => c === 'Darkness Energy', 2);
    for (const g of got) S.hand.splice(S.hand.indexOf(g), 1);
    if (got.length) {
      A.energy.push(got[0]);
      A.poisoned = true;                      // our own Active gets Poisoned
      if (got.length > 1) {
        const tgt = S.bench.find((m) => S.attackers.has(m.name)) || A;
        tgt.energy.push(got[1]);
      }
    }
  }

  // items to reach the attack threshold
  if (isAttacker && needsEnergy(A)) {
    const want = energyShortfall(S, A);
    const wanted = (c) => S.spec[c] && S.spec[c].kind === 'energy' && S.spec[c].basicEnergy
      && (!want.missing.length || want.missing.includes(S.symOf(c)));

    if (S.has('Energy Search')) {
      S.play('Energy Search');
      if (!S.searchDeck(wanted, 1).length) {
        S.searchDeck((c) => S.spec[c] && S.spec[c].kind === 'energy'
          && S.spec[c].basicEnergy, 1);
      }
    }
    if (S.has('Energy Retrieval') && S.discard.some(wanted)) {
      S.play('Energy Retrieval');
      for (let i = 0; i < 2; i++) {
        const j = S.discard.findIndex(wanted);
        if (j < 0) break;
        S.hand.push(S.discard.splice(j, 1)[0]);
      }
    }
    while (S.has('Energy Switch') && needsEnergy(A)) {
      const src = S.bench.find((m) => m.energy.length > 0);
      if (!src) break;
      S.play('Energy Switch');
      A.energy.push(src.energy.pop());
    }
  }

  // attach for turn — fuel the Active, then pre-load the backup
  if (!S.energyAttached) {
    let target = A;
    if (isAttacker && !needsEnergy(A)) {
      target = S.bench.find((m) => S.attackers.has(m.name) && needsEnergy(m)) || A;
    } else if (!isAttacker) {
      target = S.bench.find((m) => S.attackers.has(m.name)) || A;
    }
    const pick = S.energyInHand(target)[0];
    if (pick) {
      S.hand.splice(S.hand.indexOf(pick), 1);
      target.energy.push(pick);
      S.energyAttached = true;
    }
  }

  // Tools. Chosen by what the card does rather than by a hardcoded name list, so
  // a new Tool with an hpBonus or a damage boost is picked up from cards.json
  // without touching this file. A Tool that does nothing for this Pokemon — Punk
  // Helmet on a non-[D] body — is skipped rather than wasted on it.
  if (A.tool === null) {
    const usable = (t) => {
      const d = S.spec[t];
      if (!d || d.kind !== 'tool') return false;
      if (d.requiresDark && S.card(A.name).type !== DARK) return false;
      return Boolean(d.retaliate || d.hpBonus || d.damageBoostVsEx
        || d.effect || t === 'Air Balloon');
    };
    // Established preference first, so decks that already worked keep making the
    // same choice; anything new falls in behind it ranked by what it contributes.
    const PREFERRED = ['Punk Helmet', 'Powerglass', 'Amulet of Hope'];
    const value = (t) => {
      const d = S.spec[t];
      return (d.retaliate || 0) + (d.hpBonus || 0) + (d.damageBoostVsEx || 0);
    };
    const rank = (t) => {
      const i = PREFERRED.indexOf(t);
      return i >= 0 ? i - PREFERRED.length : 0;      // preferred sort ahead of the rest
    };
    const pick = [...new Set(S.hand)].filter(usable)
      .sort((a, b) => rank(a) - rank(b) || value(b) - value(a))[0];
    if (pick) {
      S.hand.splice(S.hand.indexOf(pick), 1);
      A.tool = pick;
      if (S.spec[pick].hpBonus) A.hp += S.spec[pick].hpBonus;
    }
  }

  // spare Supporter -> dig
  if (!S.supporterUsed && S.hand.length <= 4) {
    playDrawSupporter(S);
  }

  const tot = S.totalEnergy(A);
  const result = { ko: false, dmg: 0, reason: null };

  // Gust before picking an attack, so the choice is made against whatever is
  // actually going to be standing there. Probed with a pure damage estimate
  // rather than a trial chooseAttack: that function consumes RNG for
  // flip-until-tails attacks, so calling it twice a turn would shift every
  // downstream roll and quietly desynchronise the whole simulation.
  if (isAttacker) maybeGust(S, opp, payableDamage(S, A));

  // Bonus damage against a Pokemon ex, from a Supporter and/or the attached Tool.
  // `opp.prizes >= 2` is the engine's stand-in for "is an ex" — the meta model
  // has no card identity, only a prize value, and everything worth 2 or more is
  // an ex in this format.
  let bbt = 0;
  if (!S.supporterUsed && S.has("Black Belt's Training") && opp.prizes >= 2) {
    S.play("Black Belt's Training"); S.supporterUsed = true; bbt = 40;
  }
  if (A.tool && opp.prizes >= 2) bbt += (S.spec[A.tool].damageBoostVsEx || 0);

  const picked = chooseAttack(S, A, opp, bbt, S.rng);
  if (!picked) {
    result.reason = isAttacker ? 'no_energy' : 'no_attacker';
    S.turnsStuck++;
  } else {
    if (picked.usesCard) {
      S.play(picked.usesCard);
      // Dark Bell Confuses BOTH Active non-[D] Pokemon. If our own attacker is not
      // a Darkness Pokemon we Confuse ourselves too, and a tails means no attack.
      const ourCard = S.card(A.name);
      if (S.spec[picked.usesCard].onlyNonDark && ourCard.type !== DARK) {
        A.confused = true;
        if (S.rng() < 0.5) {
          result.reason = 'confused_self';
          S.turnsStuck++;
          if (A.poisoned) A.dmg += 10;
          return result;
        }
      }
    }
    result.ko = picked.ko;
    result.dmg = picked.dmg;
    result.reason = picked.reason;
    if (picked.ko) {
      if (picked.via === 'exactDamage') S.exactDamageKos++;
      else S.abyssEyeKos++;
    }
  }

  if ((result.dmg > 0 || result.ko) && S.firstAttackTurn === null) {
    S.firstAttackTurn = turn;
  }

  if (A.tool === 'Powerglass') {
    const j = S.discard.findIndex((c) => S.spec[c] && S.spec[c].kind === 'energy'
      && S.spec[c].basicEnergy);
    if (j >= 0) A.energy.push(S.discard.splice(j, 1)[0]);
  }
  if (A.poisoned) A.dmg += 10;

  return result;
}

/* -------------------------------------------------------------- a game --- */

function rebuildDelay(rng, meta) {
  return Math.max(0, Math.round(rng.gauss(meta.rebuild ?? 1.0, 0.5)));
}

export function playGame(spec, meta, rng) {
  const S = new Side(spec, rng);
  S.opening();
  if (!S.active) return { win: false, reason: 'no_basic_disaster', turns: 0, S };

  // The opponent's Active is no longer always the archetype's attacker: a gust
  // card can drag a Benched Pokemon up, and while it is there the thing we are
  // hitting has different HP and a different prize value. `activeHp` and
  // `prizes` therefore live on `opp` and are reset from `meta` on a knockout,
  // rather than `meta.hp` being read directly at every site.
  const opp = {
    activeHp: meta.hp,
    hpLeft: meta.hp,
    prizes: meta.prizes,
    darkType: meta.darkType,
    dmgOnActive: 0,
    prizesTaken: 0,
    offlineUntil: 0,
    gusted: false,
    // Damage already on the real attacker, held while a Benched Pokemon is
    // dragged up. Gusting does not heal anything — the damage is still on that
    // Pokemon when it comes back — and losing that would make gust cards look
    // like a drawback instead of tempo.
    stashedDmg: 0,
    confusedActive: false,
  };
  /**
   * Their Active was Knocked Out. What that costs them depends entirely on which
   * Pokemon it was.
   *
   * Knocking out a Pokemon we dragged up off their Bench is a cheap prize and
   * nothing more: their attacker comes back with exactly the damage it already
   * had, and they are not set back a beat, because they never lost the piece
   * they had been building. Treating the two cases the same — full heal plus a
   * rebuild delay — meant gusting a 70 HP support card reset their board and
   * took their attacker offline, which made every gust card look enormously
   * stronger than it is and was most of an unexplained 6-point win rate jump.
   */
  const oppReset = (turn) => {
    if (opp.gusted) {
      const dmg = opp.stashedDmg;
      opp.activeHp = meta.hp;
      opp.prizes = meta.prizes;
      opp.dmgOnActive = dmg;
      opp.hpLeft = meta.hp - dmg;
      opp.gusted = false;
      opp.stashedDmg = 0;
      opp.confusedActive = false;
      return;
    }
    opp.activeHp = meta.hp;
    opp.prizes = meta.prizes;
    opp.hpLeft = meta.hp;
    opp.dmgOnActive = 0;
    opp.stashedDmg = 0;
    opp.confusedActive = false;
    opp.offlineUntil = turn + rebuildDelay(rng, meta);
  };
  /** They retreat the gusted Pokemon back; the real attacker returns damaged. */
  const oppUngust = () => {
    if (!opp.gusted) return;
    opp.activeHp = meta.hp;
    opp.prizes = meta.prizes;
    opp.dmgOnActive = opp.stashedDmg;
    opp.hpLeft = meta.hp - opp.stashedDmg;
    opp.gusted = false;
    opp.confusedActive = false;
  };
  opp.gustTo = (bench, confuse) => {
    if (opp.gusted || !bench) return false;
    opp.stashedDmg = opp.dmgOnActive;
    opp.activeHp = bench.hp;
    opp.prizes = bench.prizes;
    opp.hpLeft = bench.hp;
    opp.dmgOnActive = 0;
    opp.gusted = true;
    opp.confusedActive = Boolean(confuse);
    return true;
  };
  opp.bench = meta.bench || null;
  let setup = Math.max(1, Math.round(rng.gauss(meta.setupMu, meta.setupSd)));
  if (S.mulligans >= 2) setup = Math.max(1, setup - 1);

  let lossReason = null;
  let turn = 0;
  const userFirst = rng() < 0.5;

  for (turn = 1; turn <= MAX_TURNS; turn++) {
    /* ---- your turn ---- */
    if (userFirst || turn > 1) {
      const r = userTurn(S, opp, turn);
      if (r.deckout) { lossReason = 'deck_out'; break; }
      if (r.ko) {
        S.takePrizes(opp.prizes);
        if (opp.gusted) S.gustKos++;
        oppReset(turn);
      } else if (r.dmg > 0) {
        opp.hpLeft -= r.dmg;
        opp.dmgOnActive = opp.activeHp - opp.hpLeft;
        if (opp.hpLeft <= 0) {
          S.takePrizes(opp.prizes);
          if (opp.gusted) S.gustKos++;
          oppReset(turn);
          S.duskRaidKos++;
        }
      }
      if (S.prizesTaken >= 6) {
        return { win: true, reason: 'prizes', turns: turn, S, oppPrizes: opp.prizesTaken };
      }
    }

    /* ---- opponent turn ---- */
    // A gusted Pokemon that survived is retreated back, and then they attack as
    // normal. An earlier version skipped their whole turn here, which read as
    // "gusting denies them tempo" but is not what happens: retreating costs
    // Energy, not the turn. That one `continue` was worth several points of win
    // rate on its own and made every gust card look far better than it is.
    if (opp.gusted) oppUngust();

    if (turn >= setup && turn >= opp.offlineUntil) {
      if (meta.hammers > 0 && S.active && S.active.energy.length && rng() < meta.hammers) {
        S.discard.push(S.active.energy.pop());
      }

      const whiffed = rng() < (meta.whiff ?? 0.15);
      let dmg = whiffed ? 0 : meta.dmg;
      if (meta.grass && S.active && S.attackers.has(S.active.name)) dmg *= 2;

      if (S.active && dmg > 0) {
        // Retaliate is read from the cards themselves, tools included. This used
        // to be `tool === 'Punk Helmet' ? 40 : 0`, which ignored the card's own
        // number, ignored every other retaliate tool, and ignored requiresDark —
        // so a Punk Helmet on a non-[D] Pokemon retaliated when it should not.
        // The exact total matters here beyond the damage: Punk Helmet's 40 plus
        // Spiky Energy's 20 is precisely the 6 damage counters Mega Absol's
        // Terminal Period needs to auto-KO, so an off-by-anything breaks a real
        // line rather than just nudging a win rate.
        let retaliate = 0;
        const addRetaliate = (d) => {
          if (!d || !d.retaliate) return;
          if (d.requiresDark && S.card(S.active.name).type !== DARK) return;
          retaliate += d.retaliate;
        };
        if (S.active.tool) addRetaliate(S.spec[S.active.tool]);
        for (const e of S.active.energy) addRetaliate(S.spec[e]);
        if (retaliate) {
          opp.hpLeft -= retaliate;
          opp.dmgOnActive = opp.activeHp - opp.hpLeft;
          if (opp.hpLeft <= 0) {
            S.takePrizes(opp.prizes);
            oppReset(turn);
          }
        }
      }

      if (S.active) {
        S.active.dmg += dmg;
        if (S.active.dmg >= S.active.hp) {
          opp.prizesTaken += S.active.prizes;
          if (S.active.tool === 'Amulet of Hope') {
            S.searchDeck((c) =>
              ['Darkness Energy', 'Dark Bell', 'Ultra Ball'].includes(c), 3);
          }
          S.discard.push(S.active.name);
          if (S.bench.length) {
            let idx = 0, best = -1;
            S.bench.forEach((m, i) => {
              const score = (S.attackers.has(m.name) ? 1000 : 0) + (m.hp - m.dmg);
              if (score > best) { best = score; idx = i; }
            });
            S.active = S.bench.splice(idx, 1)[0];
          } else { S.active = null; lossReason = 'bench_out'; break; }
        }
      }

      if (meta.spread > 0 && S.bench.length) {
        let left = meta.spread;
        for (const m of S.bench) {
          if (left <= 0) break;
          const take = Math.min(left, 30);
          m.dmg += take; left -= take;
        }
        for (const m of [...S.bench]) {
          if (m.dmg >= m.hp) {
            opp.prizesTaken += m.prizes;
            S.bench.splice(S.bench.indexOf(m), 1);
            S.discard.push(m.name);
          }
        }
      }

      if (S.prizesTaken >= 6) {
        return { win: true, reason: 'prizes', turns: turn, S, oppPrizes: opp.prizesTaken };
      }
      if (opp.prizesTaken >= 6) { lossReason = lossReason || 'prize_race'; break; }
    }
  }

  return {
    win: false, reason: lossReason || 'time_out', turns: turn, S,
    oppPrizes: opp.prizesTaken,
  };
}

/* ------------------------------------------------------------- gauntlet --- */

/**
 * Run the deck against every archetype in `metaDecks`.
 * Returns per-matchup win rates plus the meta-share-weighted overall figure.
 */
export function runGauntlet(spec, metaDecks, { games = 3000, seed = 1234, onProgress } = {}) {
  const rng = makeRng(seed);
  const matchups = {};
  let done = 0;
  const total = metaDecks.length * games;

  for (const meta of metaDecks) {
    let wins = 0, prizes = 0, never = 0, firstAtk = 0, firstAtkN = 0;
    const reasons = {};
    for (let i = 0; i < games; i++) {
      const g = playGame(spec, meta, rng);
      if (g.win) wins++;
      prizes += g.S.prizesTaken;
      if (g.S.firstAttackTurn === null) never++;
      else { firstAtk += g.S.firstAttackTurn; firstAtkN++; }
      reasons[g.reason] = (reasons[g.reason] || 0) + 1;
      done++;
      if (onProgress && done % 2000 === 0) onProgress(done / total);
    }
    matchups[meta.name] = {
      name: meta.name,
      share: meta.share,
      confidence: meta.confidence,
      note: meta.note,
      winrate: (100 * wins) / games,
      avgPrizes: prizes / games,
      neverAttacked: (100 * never) / games,
      avgFirstAttack: firstAtkN ? firstAtk / firstAtkN : null,
      reasons,
    };
  }

  const totShare = metaDecks.reduce((a, m) => a + m.share, 0);
  const weighted = metaDecks
    .reduce((a, m) => a + matchups[m.name].winrate * m.share, 0) / totShare;

  return { matchups, weighted, metaCovered: totShare, games };
}
