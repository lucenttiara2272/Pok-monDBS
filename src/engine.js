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

export const ATTACKER_IDS = new Set(['Mega Darkrai ex', 'Mega Absol ex']);
export const DRAW_SUPPORTERS = new Set([
  "Lillie's Determination", 'Judge', 'Jett', "Team Rocket's Petrel",
]);

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
  if (pokemon === 0) errors.push('Deck contains no Basic Pokémon.');

  const basics = Object.entries(spec)
    .filter(([, d]) => d.kind === 'pokemon').reduce((a, [, d]) => a + d.n, 0);
  if (size === 60 && basics > 0 && basics < 10) {
    warnings.push(
      `Only ${basics} Pokémon — mulligan rate ${(mulliganRate(spec) * 100).toFixed(1)}%. ` +
      'Competitive lists normally run 12–16.');
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
    .filter((d) => d.kind === 'pokemon').reduce((a, c) => a + c.n, 0);
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
    trainers: by('item') + by('tool') + by('supporter'),
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
    this.absolKos = 0;
  }

  card(name) { return this.spec[name]; }

  newMon(name) {
    const d = this.spec[name];
    return {
      name, dmg: 0, hp: d.hp, prizes: d.prizes, energy: [],
      tool: null, confused: false, poisoned: false,
    };
  }

  opening() {
    for (;;) {
      this.deck = buildDecklist(this.spec);
      shuffle(this.rng, this.deck);
      this.hand = [];
      for (let i = 0; i < 7; i++) this.hand.push(this.deck.pop());
      if (this.hand.some((c) => this.card(c).kind === 'pokemon')) break;
      this.mulligans++;
      if (this.mulligans > 12) break;
    }
    this.prizes = [];
    for (let i = 0; i < 6; i++) this.prizes.push(this.deck.pop());

    const basics = this.hand.filter((c) => this.card(c).kind === 'pokemon');
    if (basics.length === 0) return;
    const pick = basics.find((c) => ATTACKER_IDS.has(c)) || basics[0];
    this.hand.splice(this.hand.indexOf(pick), 1);
    this.active = this.newMon(pick);
    for (const c of [...this.hand]) {
      if (this.card(c).kind === 'pokemon' && this.bench.length < 5) {
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

  darkCount(m) { return m.energy.filter((e) => e === DARK).length; }
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

function playDrawSupporter(S) {
  if (S.supporterUsed) return false;
  for (const s of ["Lillie's Determination", 'Judge', "Team Rocket's Petrel", 'Jett']) {
    if (!S.has(s)) continue;
    S.play(s);
    S.supporterUsed = true;
    if (s === "Lillie's Determination") {
      S.deck.push(...S.hand); S.hand = []; shuffle(S.rng, S.deck);
      S.draw(S.prizes.length === 6 ? 8 : 6);
    } else if (s === 'Judge') {
      S.deck.push(...S.hand); S.hand = []; shuffle(S.rng, S.deck); S.draw(4);
    } else if (s === "Team Rocket's Petrel") {
      const A = S.active;
      let want;
      if (![S.active, ...S.bench].some((m) => m && ATTACKER_IDS.has(m.name))) want = 'Ultra Ball';
      else if (A && S.darkCount(A) >= 3) want = 'Dark Bell';
      else want = 'Energy Search';
      if (S.searchDeck((c) => c === want, 1).length === 0) {
        S.searchDeck((c) => c === 'Ultra Ball', 1);
      }
    }
    // Jett draws 1 per opponent Mega Evolution ex in play — none in this gauntlet.
    return true;
  }
  return false;
}

function ultraBall(S) {
  if (!S.has('Ultra Ball') || S.hand.length < 3) return false;
  S.play('Ultra Ball');
  for (let i = 0; i < 2; i++) {
    if (!S.hand.length) break;
    const junk = S.hand.find((c) =>
      ['Jett', 'Air Balloon', 'Spiky Energy', 'Energy Search'].includes(c))
      || choice(S.rng, S.hand);
    S.hand.splice(S.hand.indexOf(junk), 1);
    S.discard.push(junk);
  }
  let got = S.searchDeck((c) => c === 'Mega Darkrai ex', 1);
  if (!got.length) got = S.searchDeck((c) => c === 'Mega Absol ex', 1);
  if (!got.length) got = S.searchDeck((c) => S.card(c).kind === 'pokemon', 1);
  return got.length > 0;
}

function userTurn(S, opp, turn) {
  S.supporterUsed = false;
  S.energyAttached = false;
  if (!S.active) return { ko: false, dmg: 0, reason: 'no_active' };
  if (S.draw(1) === 0) return { ko: false, dmg: 0, deckout: true };

  const megasInPlay = () =>
    [S.active, ...S.bench].filter((m) => m && ATTACKER_IDS.has(m.name));

  const benchAll = () => {
    for (const c of [...S.hand]) {
      if (S.card(c).kind === 'pokemon' && S.bench.length < 5) {
        S.hand.splice(S.hand.indexOf(c), 1);
        S.bench.push(S.newMon(c));
      }
    }
  };
  benchAll();

  // dig for an attacker if we have none
  if (megasInPlay().length === 0) {
    ultraBall(S);
    if (megasInPlay().length === 0 && !S.supporterUsed) {
      playDrawSupporter(S);
      ultraBall(S);
    }
    if (S.has('Night Stretcher') && S.discard.some((c) => ATTACKER_IDS.has(c))) {
      S.play('Night Stretcher');
      const i = S.discard.findIndex((c) => ATTACKER_IDS.has(c));
      if (i >= 0) S.hand.push(S.discard.splice(i, 1)[0]);
    }
    benchAll();
  }

  // put a Mega in the Active spot
  if (!ATTACKER_IDS.has(S.active.name)) {
    const idx = S.bench.findIndex((m) => ATTACKER_IDS.has(m.name));
    if (idx >= 0) {
      let moved = false;
      if (S.has('Switch')) { S.play('Switch'); moved = true; }
      else if (S.active.tool === 'Air Balloon') moved = true;
      else if (!S.supporterUsed && S.has("AZ's Tranquility")) {
        S.play("AZ's Tranquility"); S.supporterUsed = true; moved = true;
      } else if (S.totalEnergy(S.active) >= (S.card(S.active.name).retreat || 0)) {
        const cost = S.card(S.active.name).retreat || 0;
        for (let i = 0; i < cost; i++) {
          const e = S.active.energy.pop();
          S.discard.push(e === DARK ? 'Darkness Energy' : 'Spiky Energy');
        }
        moved = true;
      }
      if (moved) { S.bench.push(S.active); S.active = S.bench.splice(idx, 1)[0]; }
    }
  }

  // keep bodies on the board — bench-out is a real failure mode
  const bodies = [S.active, ...S.bench].filter(Boolean).length;
  if (bodies <= 2) {
    if (S.has('Night Stretcher') && S.discard.some((c) => S.card(c).kind === 'pokemon')) {
      S.play('Night Stretcher');
      const i = S.discard.findIndex((c) => S.card(c).kind === 'pokemon');
      if (i >= 0) S.hand.push(S.discard.splice(i, 1)[0]);
    }
    if (bodies <= 1) ultraBall(S);
    benchAll();
  }

  const A = S.active;
  const isAttacker = ATTACKER_IDS.has(A.name);
  let dk = S.darkCount(A);

  // Supporter that enables an attack
  if (!S.supporterUsed && isAttacker && dk < 3 && S.has("Janine's Secret Art")
      && S.deck.filter((c) => c === 'Darkness Energy').length >= 1) {
    S.play("Janine's Secret Art");
    S.supporterUsed = true;
    const got = S.searchDeck((c) => c === 'Darkness Energy', 2);
    for (const g of got) S.hand.splice(S.hand.indexOf(g), 1);
    if (got.length) {
      A.energy.push(DARK);
      A.poisoned = true;                      // our own Active gets Poisoned
      if (got.length > 1) {
        const tgt = S.bench.find((m) => ATTACKER_IDS.has(m.name)) || A;
        tgt.energy.push(DARK);
      }
    }
    dk = S.darkCount(A);
  }

  // items to reach the attack threshold
  if (isAttacker && dk < 3) {
    if (S.has('Energy Search')) {
      S.play('Energy Search');
      S.searchDeck((c) => c === 'Darkness Energy', 1);
    }
    if (S.has('Energy Retrieval')
        && S.discard.filter((c) => c === 'Darkness Energy').length >= 1) {
      S.play('Energy Retrieval');
      const avail = Math.min(2, S.discard.filter((c) => c === 'Darkness Energy').length);
      for (let i = 0; i < avail; i++) {
        S.discard.splice(S.discard.indexOf('Darkness Energy'), 1);
        S.hand.push('Darkness Energy');
      }
    }
    while (S.has('Energy Switch') && S.darkCount(A) < 3) {
      const src = S.bench.find((m) => S.darkCount(m) > 0);
      if (!src) break;
      S.play('Energy Switch');
      src.energy.splice(src.energy.indexOf(DARK), 1);
      A.energy.push(DARK);
    }
    dk = S.darkCount(A);
  }

  // attach for turn — fuel the Active, then pre-load the backup
  if (!S.energyAttached) {
    let target = A;
    if (isAttacker && dk >= 3) {
      target = S.bench.find((m) => ATTACKER_IDS.has(m.name) && S.darkCount(m) < 3) || A;
    } else if (!isAttacker) {
      target = S.bench.find((m) => ATTACKER_IDS.has(m.name)) || A;
    }
    if (S.has('Darkness Energy')) {
      S.hand.splice(S.hand.indexOf('Darkness Energy'), 1);
      target.energy.push(DARK); S.energyAttached = true;
    } else if (S.has('Spiky Energy')) {
      S.hand.splice(S.hand.indexOf('Spiky Energy'), 1);
      target.energy.push('C'); S.energyAttached = true;
    }
    dk = S.darkCount(A);
  }

  // tools
  if (A.tool === null) {
    for (const t of ['Punk Helmet', 'Powerglass', 'Amulet of Hope']) {
      if (S.has(t)) { S.hand.splice(S.hand.indexOf(t), 1); A.tool = t; break; }
    }
  }

  // spare Supporter -> dig
  if (!S.supporterUsed && S.hand.length <= 4) {
    playDrawSupporter(S);
    dk = S.darkCount(A);
  }

  const tot = S.totalEnergy(A);
  const result = { ko: false, dmg: 0, reason: null };

  let bbt = 0;
  if (!S.supporterUsed && S.has("Black Belt's Training") && opp.prizes >= 2) {
    S.play("Black Belt's Training"); S.supporterUsed = true; bbt = 40;
  }

  if (A.name === 'Mega Darkrai ex') {
    if (dk >= 3 && S.has('Dark Bell') && !opp.darkType) {
      S.play('Dark Bell');
      result.ko = true; result.reason = 'abyss_eye';
      S.abyssEyeKos++;
    } else if (dk >= 2) {
      result.dmg = 110 + (S.benchHasDamage() ? 110 : 0) + bbt;
      result.reason = 'dusk_raid';
    } else { result.reason = 'no_energy'; S.turnsStuck++; }
  } else if (A.name === 'Mega Absol ex') {
    if (tot >= 3 && dk >= 2) {
      result.dmg = 200 + bbt; result.reason = 'claw_of_darkness';
    } else if (tot >= 2 && dk >= 1 && opp.dmgOnActive === 60) {
      result.ko = true; result.reason = 'terminal_period'; S.absolKos++;
    } else { result.reason = 'no_energy'; S.turnsStuck++; }
  } else { result.reason = 'no_attacker'; S.turnsStuck++; }

  if ((result.dmg > 0 || result.ko) && S.firstAttackTurn === null) {
    S.firstAttackTurn = turn;
  }

  if (A.tool === 'Powerglass' && S.discard.includes('Darkness Energy')) {
    S.discard.splice(S.discard.indexOf('Darkness Energy'), 1);
    A.energy.push(DARK);
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

  const opp = {
    hpLeft: meta.hp, prizes: meta.prizes, darkType: meta.darkType,
    dmgOnActive: 0, prizesTaken: 0, offlineUntil: 0,
  };
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
        opp.hpLeft = meta.hp; opp.dmgOnActive = 0;
        opp.offlineUntil = turn + rebuildDelay(rng, meta);
      } else if (r.dmg > 0) {
        opp.hpLeft -= r.dmg;
        opp.dmgOnActive = meta.hp - opp.hpLeft;
        if (opp.hpLeft <= 0) {
          S.takePrizes(opp.prizes);
          opp.hpLeft = meta.hp; opp.dmgOnActive = 0;
          opp.offlineUntil = turn + rebuildDelay(rng, meta);
          S.duskRaidKos++;
        }
      }
      if (S.prizesTaken >= 6) {
        return { win: true, reason: 'prizes', turns: turn, S, oppPrizes: opp.prizesTaken };
      }
    }

    /* ---- opponent turn ---- */
    if (turn >= setup && turn >= opp.offlineUntil) {
      if (meta.hammers > 0 && S.active && S.active.energy.length && rng() < meta.hammers) {
        S.active.energy.pop();
        S.discard.push('Darkness Energy');
      }

      const whiffed = rng() < (meta.whiff ?? 0.15);
      let dmg = whiffed ? 0 : meta.dmg;
      if (meta.grass && S.active && ATTACKER_IDS.has(S.active.name)) dmg *= 2;

      if (S.active && dmg > 0) {
        let retaliate = 0;
        if (S.active.tool === 'Punk Helmet') retaliate += 40;
        if (S.active.energy.includes('C')) retaliate += 20;
        if (retaliate) {
          opp.hpLeft -= retaliate;
          opp.dmgOnActive = meta.hp - opp.hpLeft;
          if (opp.hpLeft <= 0) {
            S.takePrizes(opp.prizes);
            opp.hpLeft = meta.hp; opp.dmgOnActive = 0;
            opp.offlineUntil = turn + rebuildDelay(rng, meta);
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
              const score = (ATTACKER_IDS.has(m.name) ? 1000 : 0) + (m.hp - m.dmg);
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
