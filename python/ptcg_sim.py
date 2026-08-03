"""
Pokemon TCG hybrid battle simulator
Deck under test: Mega Darkrai ex / Mega Absol ex "Abyss Eye" (Regulation H-I-J Standard)
Gauntlet: top 8 tournament archetypes weighted by Limitless meta share (Aug 2026)

Model:
  - USER DECK: full card-level Monte Carlo. Real shuffle, real 7-card hand, real mulligans,
    real prize set, real search/draw/attach/attack sequencing with a greedy policy.
  - OPPONENTS: archetype agents. Setup speed drawn from a calibrated distribution,
    then card-exact attacker stats (HP, prize value, damage, type interactions,
    disruption) applied per turn.

Everything the user's deck does is simulated from the physical 60(61) cards.
Opponent internals are parameterised - see METADECKS for per-deck sourcing notes.
"""

import random
import json
import math
from collections import defaultdict, Counter

# ---------------------------------------------------------------------------
# CARD DATA  (all text verified against limitlesstcg.com)
# ---------------------------------------------------------------------------

DARK = "D"

# Mega Evolution Pokemon ex give up THREE prizes when Knocked Out.
MEGA_PRIZES = 3

USER_DECK = {
    # --- Pokemon (8) ---
    "Mega Darkrai ex":   {"n": 3, "kind": "pokemon", "basic": True, "hp": 280,
                          "prizes": MEGA_PRIZES, "type": DARK, "weak": "G", "retreat": 2},
    "Mega Absol ex":     {"n": 2, "kind": "pokemon", "basic": True, "hp": 280,
                          "prizes": MEGA_PRIZES, "type": DARK, "weak": "G", "retreat": 2},
    "Fezandipiti ex":    {"n": 1, "kind": "pokemon", "basic": True, "hp": 210,
                          "prizes": 2, "type": DARK, "weak": "G", "retreat": 1},
    "Munkidori":         {"n": 2, "kind": "pokemon", "basic": True, "hp": 110,
                          "prizes": 1, "type": DARK, "weak": "G", "retreat": 1},
    # --- Energy (12) ---
    "Darkness Energy":   {"n": 11, "kind": "energy", "basic_energy": True, "provides": DARK},
    "Spiky Energy":      {"n": 1,  "kind": "energy", "basic_energy": False, "provides": "C"},
    # --- Items / Tools (27) ---
    "Ultra Ball":        {"n": 4, "kind": "item"},
    "Dark Bell":         {"n": 4, "kind": "item"},
    "Night Stretcher":   {"n": 3, "kind": "item"},
    "Punk Helmet":       {"n": 2, "kind": "tool"},
    "Amulet of Hope":    {"n": 1, "kind": "tool"},
    "Air Balloon":       {"n": 1, "kind": "tool"},
    "Powerglass":        {"n": 1, "kind": "tool"},
    "Energy Retrieval":  {"n": 3, "kind": "item"},
    "Energy Search":     {"n": 3, "kind": "item"},
    "Switch":            {"n": 2, "kind": "item"},
    "Energy Switch":     {"n": 3, "kind": "item"},
    # --- Supporters (14) ---
    "AZ's Tranquility":     {"n": 2, "kind": "supporter"},
    "Boss's Orders":        {"n": 2, "kind": "supporter"},
    "Janine's Secret Art":  {"n": 2, "kind": "supporter"},
    "Black Belt's Training":{"n": 2, "kind": "supporter"},
    "Lisia's Appeal":       {"n": 2, "kind": "supporter"},
    "Judge":                {"n": 1, "kind": "supporter"},
    "Lillie's Determination":{"n": 1, "kind": "supporter"},
    "Jett":                 {"n": 1, "kind": "supporter"},
    "Team Rocket's Petrel": {"n": 1, "kind": "supporter"},
}

DRAW_SUPPORTERS = {"Lillie's Determination", "Judge", "Jett", "Team Rocket's Petrel"}
ATTACKERS = {"Mega Darkrai ex", "Mega Absol ex"}


def _shuffle(rng, lst):
    """Fisher-Yates using only rng.random() (avoids a getrandbits bug in this sandbox)."""
    for i in range(len(lst) - 1, 0, -1):
        j = int(rng.random() * (i + 1))
        if j > i:
            j = i
        lst[i], lst[j] = lst[j], lst[i]
    return lst


def _rebuild(rng, params):
    """Turns the opponent needs to re-establish an attacker after losing one."""
    mu = params.get("rebuild", 1.0)
    return max(0, round(rng.gauss(mu, 0.5)))


def _choice(rng, seq):
    i = int(rng.random() * len(seq))
    return seq[min(i, len(seq) - 1)]


def build_decklist(spec):
    out = []
    for name, d in spec.items():
        out.extend([name] * d["n"])
    return out


# ---------------------------------------------------------------------------
# META GAUNTLET
# ---------------------------------------------------------------------------
# share      : Limitless meta share (TEF-CRI, Aug 2026)
# hp/prizes  : main attacker, card-exact where noted
# dmg        : damage to our Active per attacking turn
# spread     : damage counters distributed to our Bench per turn
# setup_mu/sd: turn on which they begin attacking (normal, clipped >=1)
# dark_type  : True  -> immune to Dark Bell (Confusion only hits non-[D]) -> ABYSS EYE FAILS
# grass      : True  -> hits our Grass-weak Megas for x2
# hammers    : expected Energy discards forced on us per turn (Crushing Hammer etc.)
# ability_lock: shuts off Colorless abilities (does not affect our Dark Pokemon)
# confidence : how card-exact the model is
METADECKS = {
    "Dragapult ex": dict(
        share=49.22, rebuild=1.6, whiff=0.2, hp=320, prizes=2, dmg=200, spread=60, setup_mu=2.3, setup_sd=0.7,
        dark_type=False, grass=False, hammers=0.55, stage=2, ability_lock=True,
        confidence="high",
        note="Card-exact: Dragapult ex 320HP, Phantom Dive [R][P] 200 + 6 counters, "
             "no Weakness, Tera (no bench damage). List runs 4 Crushing Hammer, "
             "2 Team Rocket's Watchtower, 4 Lillie's Determination."),
    "N's Zoroark ex": dict(
        share=8.02, rebuild=1.1, whiff=0.14, hp=280, prizes=2, dmg=200, spread=0, setup_mu=2.0, setup_sd=0.6,
        dark_type=True, grass=False, hammers=0.0, stage=1, ability_lock=False,
        confidence="high",
        note="Card-exact: 280HP Darkness Stage 1, Night Joker copies a Benched N's "
             "Pokemon attack. DARKNESS TYPE -> Dark Bell cannot Confuse it -> your "
             "Abyss Eye auto-KO line is dead in this matchup."),
    "Crustle Rock Inn": dict(
        share=6.14, rebuild=0.8, whiff=0.16, hp=140, prizes=1, dmg=140, spread=20, setup_mu=2.0, setup_sd=0.6,
        dark_type=False, grass=False, hammers=0.0, stage=1, ability_lock=False,
        confidence="medium",
        note="Single-prize engine deck. Modelled as a fast, low-HP, 1-prize attacker - "
             "the worst possible prize-trade shape against 3-prize Megas."),
    "Slowking Inspiration": dict(
        share=5.59, rebuild=0.9, whiff=0.18, hp=160, prizes=1, dmg=130, spread=0, setup_mu=2.2, setup_sd=0.7,
        dark_type=False, grass=False, hammers=0.35, stage=1, ability_lock=False,
        confidence="medium",
        note="Single-prize control. Modelled with moderate damage plus light "
             "resource denial."),
    "Hydrapple ex": dict(
        share=4.84, rebuild=1.7, whiff=0.22, hp=280, prizes=2, dmg=180, spread=0, setup_mu=2.6, setup_sd=0.8,
        dark_type=False, grass=True, hammers=0.0, stage=2, ability_lock=False,
        confidence="medium",
        note="GRASS. Both your Megas are Grass-Weak, so its damage is DOUBLED "
             "against them. Structurally your worst matchup."),
    "Alakazam Powerful Hand": dict(
        share=4.75, rebuild=1.4, whiff=0.18, hp=180, prizes=1, dmg=160, spread=0, setup_mu=2.1, setup_sd=0.6,
        dark_type=False, grass=False, hammers=0.0, stage=2, ability_lock=False,
        confidence="medium",
        note="Single-prize Psychic attacker scaling off hand size."),
    "Raging Bolt ex": dict(
        share=3.51, rebuild=0.9, whiff=0.16, hp=240, prizes=2, dmg=220, spread=0, setup_mu=2.4, setup_sd=0.8,
        dark_type=False, grass=False, hammers=0.0, stage=0, ability_lock=False,
        confidence="medium",
        note="Big Dragon Basic. High damage, no Weakness interaction either way."),
    "Ogerpon Box": dict(
        share=3.18, rebuild=0.7, whiff=0.13, hp=210, prizes=2, dmg=160, spread=0, setup_mu=2.0, setup_sd=0.6,
        dark_type=False, grass=True, hammers=0.0, stage=0, ability_lock=False,
        confidence="medium",
        note="Toolbox with Grass attackers - doubled damage into your Megas."),
}


# ---------------------------------------------------------------------------
# GAME STATE
# ---------------------------------------------------------------------------

class UserSide:
    """Card-level state for the Mega Darkrai deck."""

    def __init__(self, rng):
        self.rng = rng
        self.deck = build_decklist(USER_DECK)
        self.decksize = len(self.deck)
        _shuffle(rng, self.deck)
        self.hand = []
        self.discard = []
        self.prizes = []
        self.bench = []          # list of dicts
        self.active = None
        self.mulligans = 0
        self.prizes_taken = 0
        self.supporter_used = False
        self.energy_attached = False
        # diagnostics
        self.turns_stuck_no_attack = 0
        self.first_attack_turn = None
        self.abyss_eye_kos = 0
        self.dusk_raid_kos = 0
        self.absol_kos = 0
        self.dead_draw_turns = 0

    # -- setup ---------------------------------------------------------------
    def has_basic(self, cards):
        return any(USER_DECK[c]["kind"] == "pokemon" for c in cards)

    def opening(self):
        while True:
            self.deck = build_decklist(USER_DECK)
            _shuffle(self.rng, self.deck)
            self.hand = [self.deck.pop() for _ in range(7)]
            if self.has_basic(self.hand):
                break
            self.mulligans += 1
            if self.mulligans > 12:
                break
        # opponent draws an extra card per mulligan (tracked, applied as tempo)
        self.prizes = [self.deck.pop() for _ in range(6)]
        # place active: prefer a Mega attacker, else anything
        basics = [c for c in self.hand if USER_DECK[c]["kind"] == "pokemon"]
        if not basics:
            return
        pick = next((c for c in basics if c in ATTACKERS), basics[0])
        self.hand.remove(pick)
        self.active = self.new_mon(pick)
        # bench the rest (max 5)
        for c in list(self.hand):
            if USER_DECK[c]["kind"] == "pokemon" and len(self.bench) < 5:
                self.hand.remove(c)
                self.bench.append(self.new_mon(c))

    def new_mon(self, name):
        d = USER_DECK[name]
        return {"name": name, "dmg": 0, "hp": d["hp"], "prizes": d["prizes"],
                "energy": [], "tool": None, "confused": False, "poisoned": False}

    # -- helpers -------------------------------------------------------------
    def draw(self, n):
        got = 0
        for _ in range(n):
            if not self.deck:
                return got  # deck-out handled by caller
            self.hand.append(self.deck.pop())
            got += 1
        return got

    def dark_count(self, mon):
        return sum(1 for e in mon["energy"] if e == DARK)

    def total_energy(self, mon):
        return len(mon["energy"])

    def take_prizes(self, n):
        for _ in range(n):
            if self.prizes:
                self.hand.append(self.prizes.pop())
                self.prizes_taken += 1

    def search_deck(self, pred, limit=1):
        found = []
        for c in list(self.deck):
            if pred(c) and len(found) < limit:
                self.deck.remove(c)
                found.append(c)
        _shuffle(self.rng, self.deck)
        self.hand.extend(found)
        return found

    def bench_has_damage(self):
        return any(m["dmg"] > 0 for m in self.bench)


# ---------------------------------------------------------------------------
# USER TURN POLICY
# ---------------------------------------------------------------------------

def _play_draw_supporter(S, A):
    """Use the best available draw Supporter. This is the deck's engine."""
    if S.supporter_used:
        return False
    order = ["Lillie's Determination", "Judge", "Team Rocket's Petrel", "Jett"]
    for s in order:
        if s not in S.hand:
            continue
        S.hand.remove(s); S.discard.append(s); S.supporter_used = True
        if s == "Lillie's Determination":
            S.deck.extend(S.hand); S.hand = []; _shuffle(S.rng, S.deck)
            S.draw(8 if len(S.prizes) == 6 else 6)
        elif s == "Judge":
            S.deck.extend(S.hand); S.hand = []; _shuffle(S.rng, S.deck); S.draw(4)
        elif s == "Team Rocket's Petrel":
            if not any(m["name"] in ATTACKERS for m in [A] + S.bench if m):
                want = "Ultra Ball"
            elif A and S.dark_count(A) >= 3:
                want = "Dark Bell"
            else:
                want = "Energy Search"
            if not S.search_deck(lambda c, w=want: c == w, 1):
                S.search_deck(lambda c: c == "Ultra Ball", 1)
        else:  # Jett - draws 1 per opponent Mega Evolution ex in play (none in gauntlet)
            S.dead_draw_turns += 1
        return True
    return False


def _ultra_ball(S):
    """Discard 2, fetch a Mega Darkrai (or any attacker)."""
    if "Ultra Ball" not in S.hand or len(S.hand) < 3:
        return False
    S.hand.remove("Ultra Ball"); S.discard.append("Ultra Ball")
    for _ in range(2):
        if not S.hand:
            break
        # discard the least useful card
        junk = None
        for c in S.hand:
            if c in ("Jett", "Air Balloon", "Spiky Energy", "Energy Search"):
                junk = c; break
        junk = junk or _choice(S.rng, S.hand)
        S.hand.remove(junk); S.discard.append(junk)
    got = S.search_deck(lambda c: c == "Mega Darkrai ex", 1)
    if not got:
        got = S.search_deck(lambda c: c == "Mega Absol ex", 1)
    if not got:
        got = S.search_deck(lambda c: USER_DECK[c]["kind"] == "pokemon", 1)
    return bool(got)


def user_turn(S, opp, turn, log):
    """Greedy but competent play policy."""
    S.supporter_used = False
    S.energy_attached = False

    if S.active is None:
        return {"ko": False, "dmg": 0, "reason": "no_active"}

    # ---- 1. draw for turn
    if S.draw(1) == 0:
        return {"ko": False, "dmg": 0, "deckout": True}

    def megas_in_play():
        return [m for m in ([S.active] + S.bench) if m and m["name"] in ATTACKERS]

    # ---- 2. bench everything we can
    for c in list(S.hand):
        if USER_DECK[c]["kind"] == "pokemon" and len(S.bench) < 5:
            S.hand.remove(c); S.bench.append(S.new_mon(c))

    # ---- 3. if we have no Mega at all, dig hard for one
    if not megas_in_play():
        _ultra_ball(S)
        if not megas_in_play() and not S.supporter_used:
            _play_draw_supporter(S, S.active)
            _ultra_ball(S)
        if "Night Stretcher" in S.hand and any(c in ATTACKERS for c in S.discard):
            S.hand.remove("Night Stretcher"); S.discard.append("Night Stretcher")
            for c in list(S.discard):
                if c in ATTACKERS:
                    S.discard.remove(c); S.hand.append(c); break
        for c in list(S.hand):
            if USER_DECK[c]["kind"] == "pokemon" and len(S.bench) < 5:
                S.hand.remove(c); S.bench.append(S.new_mon(c))

    # ---- 4. get a Mega into the Active spot
    if S.active["name"] not in ATTACKERS:
        idx = next((i for i, m in enumerate(S.bench) if m["name"] in ATTACKERS), None)
        if idx is not None:
            moved = False
            if "Switch" in S.hand:
                S.hand.remove("Switch"); S.discard.append("Switch"); moved = True
            elif S.active["tool"] == "Air Balloon":
                moved = True
            elif not S.supporter_used and "AZ's Tranquility" in S.hand:
                S.hand.remove("AZ's Tranquility"); S.discard.append("AZ's Tranquility")
                S.supporter_used = True; moved = True
            elif S.total_energy(S.active) >= USER_DECK[S.active["name"]]["retreat"]:
                for _ in range(USER_DECK[S.active["name"]]["retreat"]):
                    e = S.active["energy"].pop()
                    S.discard.append("Darkness Energy" if e == DARK else "Spiky Energy")
                moved = True
            if moved:
                S.bench.append(S.active); S.active = S.bench.pop(idx)

    # ---- 4b. keep bodies on the board (bench-out is a real failure mode here)
    bodies = len([m for m in [S.active] + S.bench if m])
    if bodies <= 2:
        if "Night Stretcher" in S.hand and any(
                USER_DECK[c]["kind"] == "pokemon" for c in S.discard):
            S.hand.remove("Night Stretcher"); S.discard.append("Night Stretcher")
            for c in list(S.discard):
                if USER_DECK[c]["kind"] == "pokemon":
                    S.discard.remove(c); S.hand.append(c); break
        if bodies <= 1:
            _ultra_ball(S)
        for c in list(S.hand):
            if USER_DECK[c]["kind"] == "pokemon" and len(S.bench) < 5:
                S.hand.remove(c); S.bench.append(S.new_mon(c))

    A = S.active
    is_attacker = A["name"] in ATTACKERS
    dk = S.dark_count(A)

    # ---- 5. Supporter: enable an attack if possible, else dig
    if not S.supporter_used:
        # Janine's Secret Art fetches 2 Dark straight out of the deck
        if is_attacker and dk < 3 and "Janine's Secret Art" in S.hand and \
                S.deck.count("Darkness Energy") >= 1:
            S.hand.remove("Janine's Secret Art"); S.discard.append("Janine's Secret Art")
            S.supporter_used = True
            got = S.search_deck(lambda c: c == "Darkness Energy", 2)
            for g in got:
                S.hand.remove(g)
            if got:
                A["energy"].append(DARK)
                A["poisoned"] = True          # our own Active is Poisoned - real drawback
                if len(got) > 1:
                    tgt = next((m for m in S.bench if m["name"] in ATTACKERS), None)
                    (tgt or A)["energy"].append(DARK)
            dk = S.dark_count(A)

    # ---- 6. items to reach the attack threshold
    if is_attacker and dk < 3:
        if "Energy Search" in S.hand:
            S.hand.remove("Energy Search"); S.discard.append("Energy Search")
            S.search_deck(lambda c: c == "Darkness Energy", 1)
        if "Energy Retrieval" in S.hand and S.discard.count("Darkness Energy") >= 1:
            S.hand.remove("Energy Retrieval"); S.discard.append("Energy Retrieval")
            for _ in range(min(2, S.discard.count("Darkness Energy"))):
                S.discard.remove("Darkness Energy"); S.hand.append("Darkness Energy")
        while "Energy Switch" in S.hand and S.dark_count(A) < 3:
            src = next((m for m in S.bench if S.dark_count(m) > 0), None)
            if not src:
                break
            S.hand.remove("Energy Switch"); S.discard.append("Energy Switch")
            src["energy"].remove(DARK); A["energy"].append(DARK)
        dk = S.dark_count(A)

    # ---- 7. attach for turn
    if not S.energy_attached:
        target = A
        if is_attacker and dk >= 3:
            backup = next((m for m in S.bench
                           if m["name"] in ATTACKERS and S.dark_count(m) < 3), None)
            target = backup or A
        elif not is_attacker:
            backup = next((m for m in S.bench if m["name"] in ATTACKERS), None)
            target = backup or A
        if "Darkness Energy" in S.hand:
            S.hand.remove("Darkness Energy"); target["energy"].append(DARK)
            S.energy_attached = True
        elif "Spiky Energy" in S.hand:
            S.hand.remove("Spiky Energy"); target["energy"].append("C")
            S.energy_attached = True
        dk = S.dark_count(A)

    # ---- 8. tools
    if A["tool"] is None:
        for t in ("Punk Helmet", "Powerglass", "Amulet of Hope"):
            if t in S.hand:
                S.hand.remove(t); A["tool"] = t; break

    # ---- 9. leftover Supporter -> dig for next turn
    if not S.supporter_used and len(S.hand) <= 4:
        _play_draw_supporter(S, A)
        dk = S.dark_count(A)

    # ---- 10. attack
    tot = S.total_energy(A)
    result = {"ko": False, "dmg": 0, "reason": None}

    bbt = 0
    if not S.supporter_used and "Black Belt's Training" in S.hand and opp["prizes"] >= 2:
        S.hand.remove("Black Belt's Training"); S.discard.append("Black Belt's Training")
        S.supporter_used = True
        bbt = 40

    if A["name"] == "Mega Darkrai ex":
        if dk >= 3 and "Dark Bell" in S.hand and not opp["dark_type"]:
            S.hand.remove("Dark Bell"); S.discard.append("Dark Bell")
            result["ko"] = True; result["reason"] = "abyss_eye"
            S.abyss_eye_kos += 1
        elif dk >= 2:
            result["dmg"] = 110 + (110 if S.bench_has_damage() else 0) + bbt
            result["reason"] = "dusk_raid"
        else:
            result["reason"] = "no_energy"; S.turns_stuck_no_attack += 1
    elif A["name"] == "Mega Absol ex":
        if tot >= 3 and dk >= 2:
            result["dmg"] = 200 + bbt; result["reason"] = "claw_of_darkness"
        elif tot >= 2 and dk >= 1 and opp["dmg_on_active"] == 60:
            result["ko"] = True; result["reason"] = "terminal_period"
            S.absol_kos += 1
        else:
            result["reason"] = "no_energy"; S.turns_stuck_no_attack += 1
    else:
        result["reason"] = "no_attacker"; S.turns_stuck_no_attack += 1

    if (result["dmg"] > 0 or result["ko"]) and S.first_attack_turn is None:
        S.first_attack_turn = turn

    # Powerglass: end of turn, reattach a basic Energy from the discard
    if A["tool"] == "Powerglass" and S.discard.count("Darkness Energy") > 0:
        S.discard.remove("Darkness Energy"); A["energy"].append(DARK)

    if A["poisoned"]:
        A["dmg"] += 10

    return result


# ---------------------------------------------------------------------------
# ONE GAME
# ---------------------------------------------------------------------------

def play_game(archetype, params, rng, user_first=None):
    S = UserSide(rng)
    S.opening()
    if S.active is None:
        return {"win": False, "reason": "no_basic_disaster", "turns": 0, "S": S}

    if user_first is None:
        user_first = rng.random() < 0.5

    opp = {
        "hp_left": params["hp"], "hp_max": params["hp"], "prizes": params["prizes"],
        "dark_type": params["dark_type"], "dmg_on_active": 0,
        "prizes_taken": 0, "offline_until": 0,
    }
    opp_setup = max(1, round(rng.gauss(params["setup_mu"], params["setup_sd"])))

    # mulligans hand the opponent extra cards -> faster setup
    opp_setup = max(1, opp_setup - (1 if S.mulligans >= 2 else 0))

    loss_reason = None
    max_turns = 30

    for turn in range(1, max_turns + 1):
        # ---------------- USER TURN ----------------
        if user_first or turn > 1:
            r = user_turn(S, opp, turn, None)
            if r.get("deckout"):
                loss_reason = "deck_out"; break
            if r["ko"]:
                S.take_prizes(opp["prizes"])
                opp["hp_left"] = params["hp"]; opp["dmg_on_active"] = 0
                opp["offline_until"] = turn + _rebuild(rng, params)
            elif r["dmg"] > 0:
                opp["hp_left"] -= r["dmg"]
                opp["dmg_on_active"] = params["hp"] - opp["hp_left"]
                if opp["hp_left"] <= 0:
                    S.take_prizes(opp["prizes"])
                    opp["hp_left"] = params["hp"]; opp["dmg_on_active"] = 0
                    opp["offline_until"] = turn + _rebuild(rng, params)
                    S.dusk_raid_kos += 1
            if S.prizes_taken >= 6:
                return {"win": True, "reason": "prizes", "turns": turn, "S": S,
                        "opp_prizes": opp["prizes_taken"]}

        # ---------------- OPPONENT TURN ----------------
        if turn >= opp_setup and turn >= opp["offline_until"]:
            # Crushing Hammer style energy denial
            if params["hammers"] > 0 and S.active and S.active["energy"]:
                if rng.random() < params["hammers"]:
                    S.active["energy"].pop()
                    S.discard.append("Darkness Energy")

            # opponents are not machines: brick / whiff turns
            whiffed = rng.random() < params.get("whiff", 0.15)

            dmg = 0 if whiffed else params["dmg"]
            if params["grass"] and S.active and S.active["name"] in ATTACKERS:
                dmg *= 2                      # Grass Weakness on both Megas

            if S.active and dmg > 0:
                # Punk Helmet (40) and Spiky Energy (20) punish the attacker
                retaliate = 0
                if S.active["tool"] == "Punk Helmet":
                    retaliate += 40
                if "C" in S.active["energy"]:
                    retaliate += 20
                if retaliate:
                    opp["hp_left"] -= retaliate
                    opp["dmg_on_active"] = params["hp"] - opp["hp_left"]
                    if opp["hp_left"] <= 0:
                        S.take_prizes(opp["prizes"])
                        opp["hp_left"] = params["hp"]; opp["dmg_on_active"] = 0
                        opp["offline_until"] = turn + _rebuild(rng, params)

            if S.active:
                S.active["dmg"] += dmg
                if S.active["dmg"] >= S.active["hp"]:
                    opp["prizes_taken"] += S.active["prizes"]
                    if S.active["tool"] == "Amulet of Hope":
                        S.search_deck(lambda c: c in ("Darkness Energy", "Dark Bell",
                                                      "Ultra Ball"), 3)
                    S.discard.append(S.active["name"])
                    if S.bench:
                        # promote the healthiest attacker
                        idx = 0
                        best = -1
                        for i, m in enumerate(S.bench):
                            score = (m["name"] in ATTACKERS) * 1000 + (m["hp"] - m["dmg"])
                            if score > best:
                                best = score; idx = i
                        S.active = S.bench.pop(idx)
                    else:
                        S.active = None
                        loss_reason = "bench_out"; break

            # spread damage onto our bench (Dragapult's Phantom Dive)
            if params["spread"] > 0 and S.bench:
                left = params["spread"]
                for m in S.bench:
                    if left <= 0:
                        break
                    take = min(left, 30)
                    m["dmg"] += take
                    left -= take
                for m in list(S.bench):
                    if m["dmg"] >= m["hp"]:
                        opp["prizes_taken"] += m["prizes"]
                        S.bench.remove(m)
                        S.discard.append(m["name"])

            if S.prizes_taken >= 6:
                return {"win": True, "reason": "prizes", "turns": turn, "S": S,
                        "opp_prizes": opp["prizes_taken"]}

            if opp["prizes_taken"] >= 6:
                loss_reason = loss_reason or "prize_race"
                break

    if loss_reason is None:
        loss_reason = "time_out"

    return {"win": False, "reason": loss_reason, "turns": turn, "S": S,
            "opp_prizes": opp["prizes_taken"]}


# ---------------------------------------------------------------------------
# RUN THE GAUNTLET
# ---------------------------------------------------------------------------

def run(n_games=6000, seed=20260803):
    rng = random.Random(seed)
    results = {}

    for name, params in METADECKS.items():
        wins = 0
        reasons = Counter()
        turns = []
        first_attack = []
        mulls = 0
        abyss = 0
        dusk = 0
        stuck = 0
        opp_prizes = []

        for _ in range(n_games):
            g = play_game(name, params, rng)
            S = g["S"]
            if g["win"]:
                wins += 1
            reasons[g["reason"]] += 1
            turns.append(g["turns"])
            if S.first_attack_turn:
                first_attack.append(S.first_attack_turn)
            mulls += S.mulligans
            abyss += S.abyss_eye_kos
            dusk += S.dusk_raid_kos
            stuck += S.turns_stuck_no_attack
            opp_prizes.append(g.get("opp_prizes", 6))

        results[name] = {
            "share": params["share"],
            "winrate": 100.0 * wins / n_games,
            "reasons": dict(reasons),
            "avg_turns": sum(turns) / len(turns),
            "avg_first_attack": (sum(first_attack) / len(first_attack)) if first_attack else None,
            "pct_never_attacked": 100.0 * (n_games - len(first_attack)) / n_games,
            "avg_mulligans": mulls / n_games,
            "abyss_eye_per_game": abyss / n_games,
            "dusk_raid_ko_per_game": dusk / n_games,
            "stuck_turns_per_game": stuck / n_games,
            "avg_opp_prizes": sum(opp_prizes) / len(opp_prizes),
            "confidence": params["confidence"],
            "note": params["note"],
        }

    total_share = sum(p["share"] for p in METADECKS.values())
    weighted = sum(results[k]["winrate"] * METADECKS[k]["share"] for k in results) / total_share

    return {"matchups": results, "weighted_winrate": weighted,
            "meta_covered": total_share, "n_games": n_games}


# ---------------------------------------------------------------------------
# CONSISTENCY (independent of matchup)
# ---------------------------------------------------------------------------

def consistency(n=40000, seed=7):
    rng = random.Random(seed)
    deck = build_decklist(USER_DECK)
    size = len(deck)
    basics = sum(1 for c in deck if USER_DECK[c]["kind"] == "pokemon")

    mull = 0
    t1_attacker = 0
    t1_draw_supporter = 0
    prized_darkrai = 0
    energy_in_open = []

    for _ in range(n):
        d = deck[:]
        _shuffle(rng, d)
        hand = d[:7]
        prizes = d[7:13]
        if not any(USER_DECK[c]["kind"] == "pokemon" for c in hand):
            mull += 1
        if any(c in ATTACKERS for c in hand):
            t1_attacker += 1
        if any(c in DRAW_SUPPORTERS for c in hand):
            t1_draw_supporter += 1
        if "Mega Darkrai ex" in prizes:
            prized_darkrai += 1
        energy_in_open.append(sum(1 for c in hand if USER_DECK[c]["kind"] == "energy"))

    # exact hypergeometric mulligan check
    def C(a, b):
        return math.comb(a, b)
    exact_mull = C(size - basics, 7) / C(size, 7)

    return {
        "deck_size": size,
        "basic_pokemon": basics,
        "mulligan_rate_sim": 100.0 * mull / n,
        "mulligan_rate_exact": 100.0 * exact_mull,
        "opening_attacker_rate": 100.0 * t1_attacker / n,
        "opening_draw_supporter_rate": 100.0 * t1_draw_supporter / n,
        "darkrai_prized_rate": 100.0 * prized_darkrai / n,
        "avg_energy_in_opening": sum(energy_in_open) / n,
        "counts": {
            "pokemon": sum(v["n"] for v in USER_DECK.values() if v["kind"] == "pokemon"),
            "energy": sum(v["n"] for v in USER_DECK.values() if v["kind"] == "energy"),
            "item": sum(v["n"] for v in USER_DECK.values() if v["kind"] in ("item", "tool")),
            "supporter": sum(v["n"] for v in USER_DECK.values() if v["kind"] == "supporter"),
            "draw_supporters": sum(USER_DECK[c]["n"] for c in DRAW_SUPPORTERS),
        },
    }


if __name__ == "__main__":
    cons = consistency()
    gaunt = run()
    out = {"consistency": cons, "gauntlet": gaunt}
    with open("sim_results.json", "w") as f:
        json.dump(out, f, indent=2)

    print("=" * 68)
    print("DECK LEGALITY / CONSISTENCY")
    print("=" * 68)
    print(f"Deck size            : {cons['deck_size']}  "
          f"{'*** ILLEGAL - must be exactly 60 ***' if cons['deck_size'] != 60 else 'OK'}")
    print(f"Basic Pokemon        : {cons['basic_pokemon']}")
    print(f"Mulligan rate        : {cons['mulligan_rate_sim']:.2f}%  "
          f"(exact hypergeometric {cons['mulligan_rate_exact']:.2f}%)")
    print(f"Opening w/ Mega      : {cons['opening_attacker_rate']:.1f}%")
    print(f"Opening w/ draw supp : {cons['opening_draw_supporter_rate']:.1f}%")
    print(f"Darkrai prized       : {cons['darkrai_prized_rate']:.1f}%")
    print(f"Counts               : {cons['counts']}")
    print()
    print("=" * 68)
    print(f"GAUNTLET  ({gaunt['n_games']} games per matchup)")
    print("=" * 68)
    for k, v in sorted(gaunt["matchups"].items(), key=lambda x: -x[1]["share"]):
        print(f"{k:<26} share {v['share']:5.2f}%   WR {v['winrate']:5.1f}%   "
              f"1st atk T{v['avg_first_attack'] or 0:.1f}   "
              f"never atk {v['pct_never_attacked']:.0f}%")
    print()
    print(f"META-WEIGHTED WIN RATE: {gaunt['weighted_winrate']:.1f}% "
          f"(covers {gaunt['meta_covered']:.1f}% of the field)")
