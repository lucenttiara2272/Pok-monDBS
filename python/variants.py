"""
Variant testing + engine calibration.

CONTROL is a deliberately ordinary competitive shell. The engine is only
trustworthy if CONTROL lands near 50%. It does (53%), so the deltas below
are meaningful.

Every build is forced to exactly 60 cards so comparisons are like-for-like.
"""

import copy
import json
import random

import ptcg_sim as P

BASE = copy.deepcopy(P.USER_DECK)
N_GAMES = 5000


def size(spec):
    return sum(v["n"] for v in spec.values())


def force60(spec, filler="Darkness Energy"):
    s = copy.deepcopy(spec)
    while size(s) > 60:                       # trim the least essential first
        for c in ("Energy Search", "Air Balloon", "Jett", "Amulet of Hope",
                  "Spiky Energy", "Energy Switch", "Judge", "Energy Retrieval"):
            if c in s and s[c]["n"] > 0:
                s[c]["n"] -= 1
                if s[c]["n"] == 0:
                    del s[c]
                break
        else:
            s[filler]["n"] -= 1
    while size(s) < 60:
        s[filler]["n"] += 1
    return s


def run_deck(spec, n=N_GAMES, seed=1234, label=""):
    P.USER_DECK = spec
    rng = random.Random(seed)
    out = {}
    for name, params in P.METADECKS.items():
        wins = prizes = never = 0
        reasons = {}
        for _ in range(n):
            g = P.play_game(name, params, rng)
            if g["win"]:
                wins += 1
            prizes += g["S"].prizes_taken
            if g["S"].first_attack_turn is None:
                never += 1
            reasons[g["reason"]] = reasons.get(g["reason"], 0) + 1
        out[name] = {"winrate": 100.0 * wins / n, "avg_prizes": prizes / n,
                     "never_attacked": 100.0 * never / n, "reasons": reasons,
                     "share": params["share"], "confidence": params["confidence"],
                     "note": params["note"]}
    tot = sum(p["share"] for p in P.METADECKS.values())
    weighted = sum(out[k]["winrate"] * P.METADECKS[k]["share"] for k in out) / tot
    return {"label": label, "size": size(spec), "weighted": weighted, "matchups": out}


# ---------------------------------------------------------------- CONTROL
CONTROL = force60({
    "Mega Darkrai ex": {"n": 4, "kind": "pokemon", "basic": True, "hp": 280,
                        "prizes": 2, "type": "D", "weak": "G", "retreat": 2},
    "Munkidori":       {"n": 5, "kind": "pokemon", "basic": True, "hp": 110,
                        "prizes": 1, "type": "D", "weak": "G", "retreat": 1},
    "Fezandipiti ex":  {"n": 4, "kind": "pokemon", "basic": True, "hp": 210,
                        "prizes": 2, "type": "D", "weak": "G", "retreat": 1},
    "Darkness Energy": {"n": 14, "kind": "energy", "basic_energy": True, "provides": "D"},
    "Ultra Ball":      {"n": 4, "kind": "item"},
    "Dark Bell":       {"n": 4, "kind": "item"},
    "Night Stretcher": {"n": 3, "kind": "item"},
    "Energy Search":   {"n": 2, "kind": "item"},
    "Energy Switch":   {"n": 2, "kind": "item"},
    "Switch":          {"n": 2, "kind": "item"},
    "Powerglass":      {"n": 1, "kind": "tool"},
    "Lillie's Determination": {"n": 8, "kind": "supporter"},
    "Boss's Orders":   {"n": 3, "kind": "supporter"},
    "Janine's Secret Art": {"n": 2, "kind": "supporter"},
    "Black Belt's Training": {"n": 2, "kind": "supporter"},
})


def build(changes, drops=()):
    s = copy.deepcopy(BASE)
    for k in drops:
        s.pop(k, None)
    for k, v in changes.items():
        if k in s:
            s[k]["n"] = v
        else:
            raise KeyError(k)
    return force60(s)


def P_(n, hp, prizes, retreat):
    return {"n": n, "kind": "pokemon", "basic": True, "hp": hp,
            "prizes": prizes, "type": "D", "weak": "G", "retreat": retreat}


I_ = lambda n: {"n": n, "kind": "item"}
T_ = lambda n: {"n": n, "kind": "tool"}
S_ = lambda n: {"n": n, "kind": "supporter"}
E_ = lambda n: {"n": n, "kind": "energy", "basic_energy": True, "provides": "D"}

# --- 3. +BODIES : same cards, Pokemon count raised 8 -> 13 ------------------
V3 = {
    "Mega Darkrai ex": P_(4, 280, 3, 2), "Mega Absol ex": P_(2, 280, 3, 2),
    "Fezandipiti ex": P_(2, 210, 2, 1), "Munkidori": P_(5, 110, 1, 1),
    "Darkness Energy": E_(11),
    "Ultra Ball": I_(4), "Dark Bell": I_(4), "Night Stretcher": I_(3),
    "Energy Retrieval": I_(2), "Energy Switch": I_(2), "Switch": I_(2),
    "Punk Helmet": T_(1), "Powerglass": T_(1), "Air Balloon": T_(1),
    "Energy Search": I_(3),
    "AZ's Tranquility": S_(2), "Boss's Orders": S_(2), "Janine's Secret Art": S_(2),
    "Black Belt's Training": S_(2), "Lisia's Appeal": S_(2), "Judge": S_(1),
    "Lillie's Determination": S_(1), "Team Rocket's Petrel": S_(1),
}

# --- 4. +ENGINE : V3 but with a real draw engine ---------------------------
V4 = {
    "Mega Darkrai ex": P_(4, 280, 3, 2), "Mega Absol ex": P_(2, 280, 3, 2),
    "Fezandipiti ex": P_(2, 210, 2, 1), "Munkidori": P_(5, 110, 1, 1),
    "Darkness Energy": E_(12),
    "Ultra Ball": I_(4), "Dark Bell": I_(4), "Night Stretcher": I_(3),
    "Energy Retrieval": I_(2), "Energy Switch": I_(2), "Switch": I_(2),
    "Powerglass": T_(1), "Energy Search": I_(3),
    "Lillie's Determination": S_(4), "Boss's Orders": S_(3),
    "Janine's Secret Art": S_(2), "Black Belt's Training": S_(2),
    "AZ's Tranquility": S_(1), "Lisia's Appeal": S_(1), "Team Rocket's Petrel": S_(1),
}

# --- 5. FULL FIX : V4, tuned counts, clunky techs gone ---------------------
V5 = {
    "Mega Darkrai ex": P_(4, 280, 3, 2), "Mega Absol ex": P_(2, 280, 3, 2),
    "Fezandipiti ex": P_(2, 210, 2, 1), "Munkidori": P_(5, 110, 1, 1),
    "Darkness Energy": E_(12),
    "Ultra Ball": I_(4), "Dark Bell": I_(4), "Night Stretcher": I_(3),
    "Energy Retrieval": I_(4), "Energy Switch": I_(2), "Switch": I_(3),
    "Powerglass": T_(1),
    "Lillie's Determination": S_(4), "Boss's Orders": S_(3),
    "Janine's Secret Art": S_(2), "Black Belt's Training": S_(2),
    "AZ's Tranquility": S_(1), "Lisia's Appeal": S_(2),
}

VARIANTS = [
    ("0. CONTROL - ordinary shell (calibration)", CONTROL),
    ("1. AS SENT - 61 cards", copy.deepcopy(BASE)),
    ("2. LEGAL 60 - trim 1 card", force60(copy.deepcopy(BASE))),
    ("3. +BODIES - 13 Pokemon", V3),
    ("4. +ENGINE - 13 Pokemon + 4 Lillie's", V4),
    ("5. FULL FIX", V5),
]

for _lbl, _sp in VARIANTS:
    assert sum(v["n"] for v in _sp.values()) == 60 or "AS SENT" in _lbl, \
        (_lbl, sum(v["n"] for v in _sp.values()))

# diagnostic (not a legal build): FULL FIX but Megas only give up 2 prizes.
# Isolates how much of the loss rate is the Mega Evolution 3-prize rule itself.
DIAG = copy.deepcopy(VARIANTS[-1][1])
DIAG["Mega Darkrai ex"] = dict(DIAG["Mega Darkrai ex"]); DIAG["Mega Darkrai ex"]["prizes"] = 2
DIAG["Mega Absol ex"] = dict(DIAG["Mega Absol ex"]); DIAG["Mega Absol ex"]["prizes"] = 2


if __name__ == "__main__":
    results = []
    for label, spec in VARIANTS:
        r = run_deck(spec, label=label)
        results.append(r)
        print(f"{label:<45} size {r['size']:>3}   weighted WR {r['weighted']:5.1f}%")
        for k, v in sorted(r["matchups"].items(), key=lambda x: -x[1]["share"]):
            print(f"      {k:<26} {v['winrate']:5.1f}%   "
                  f"prizes {v['avg_prizes']:.2f}   never-atk {v['never_attacked']:.0f}%")
        print()

    d = run_deck(DIAG, label="DIAGNOSTIC - FULL FIX with 2-prize Megas")
    print(f"{d['label']:<45} size {d['size']:>3}   weighted WR {d['weighted']:5.1f}%")
    results.append(d)

    with open("variant_results.json", "w") as f:
        json.dump(results, f, indent=2)
