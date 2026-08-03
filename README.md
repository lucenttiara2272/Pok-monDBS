# PTCG Deck Lab

Build a Pokémon TCG deck and simulate it against the current tournament meta.

Standard format, Regulation H/I/J. Meta snapshot: **August 2026**.

Everything runs in the browser — no backend, no install. The deck builder and the
simulation engine are both plain ES modules, so GitHub Pages hosts the whole thing.

---

## What it does

- **Deck builder** — pick cards from a grid, set counts with a dropdown, watch the deck
  list and legality checks update live (60 cards exactly, 4-copy limit, basic Energy
  exempt).
- **Simulator** — plays thousands of games against the top 8 archetypes, weighted by
  real meta share, and reports win rate, matchup breakdown, and how the games ended.
- **Consistency maths** — exact hypergeometric mulligan rate, Pokémon count, draw
  Supporter count, all recalculated as you build.

## Running it

It needs to be served over HTTP (ES modules + `fetch` won't work from `file://`):

```bash
npm run serve          # then open http://localhost:8000
```

Tests:

```bash
npm test
```

## How the simulation works

Two halves, deliberately asymmetric:

**Your deck is simulated at full card level.** Real shuffles, real 7-card opening hands,
real mulligans, a real prize set, and a greedy but competent play policy that searches,
attaches, retreats, pre-loads a backup attacker, and attacks. When the sim says you
bricked, it bricked for a reason you could have watched happen.

**Opponents are archetype agents.** Each has a setup-speed distribution, a whiff rate, a
rebuild delay after losing an attacker, and card-exact attacker stats. They are not
simulated card by card — that would mean maintaining eight more decklists, and the extra
fidelity does not change the conclusions.

### The calibration rule

A simulator that returns plausible-looking numbers is worthless if you can't tell whether
the opponent model is too strong.

So the repo ships a **control deck** — a deliberately ordinary competitive shell — and the
engine is only considered trustworthy when the control scores near 50%. It currently
scores **~53%**.

This is not decoration. The first four versions of this engine returned 0.5%–12% for
*every* deck including the control, which meant the opponent model was broken, not the
decks. `npm test` fails if the control ever drifts far from 50%.

```
Control shell        53.3%     <- calibration reference
Optimised build      42.9%
As-sent build        28.8%
```

### Confidence levels

Each opponent is tagged in `data/meta.json`:

| Tag | Meaning |
|---|---|
| `high` | Attacker modelled card-exact from verified card text |
| `medium` | Archetype approximated from its role, HP band, and tournament results |

Dragapult ex and N's Zoroark ex are `high`. The rest are `medium`. Treat a 3-point
difference between two `medium` matchups as noise.

## Repo layout

```
index.html            deck builder + results UI
src/engine.js         simulation engine (the thing worth reviewing)
src/decks.js          preset decklists + spec builder
src/ui.js             DOM wiring
src/styles.css
data/cards.json       card database — mechanics live in the `sim` block
data/meta.json        opponent archetypes, meta shares, sourcing notes
tests/                parity, calibration, and data-integrity tests
python/               original Python reference implementation
```

## Adding a card

Append to `data/cards.json`:

```json
{
  "id": "my-card",
  "name": "My Card",
  "set": "ABC 123",
  "category": "item",
  "max": 4,
  "text": "What the card actually says.",
  "sim": { "effect": "searchBasicEnergy" }
}
```

It shows up in the picker immediately. The `sim` block is what the engine reads — a card
with no `sim` block is playable in the builder but inert in the simulation, which is fine
for cards whose effect doesn't matter to the model. If you add a card whose effect *does*
matter, wire it into `src/engine.js` in `userTurn()`.

`npm test` will tell you if you've referenced a card that doesn't exist or omitted a field
the UI needs.

## Updating the meta

Edit `data/meta.json` when the format shifts. Shares come from the
[Limitless Standard deck rankings](https://limitlesstcg.com/decks). Keep the `note` field
honest about how each deck was modelled — it's the difference between a tool you can
reason about and a black box.

## Known limitations

- Opponents don't play Trainers against you beyond an abstracted energy-denial rate.
- No mirror matches, no bench-sniping targets beyond a flat spread value.
- Prize-card mapping is random; the sim doesn't model playing around a prized key card.
- Turn-1 rules (no attacking first turn for the player going first) are simplified.

None of these change the structural findings — prize trade, type weakness, and mulligan
rate dominate — but they'd matter if you were tuning a 2-card ratio.

## Credits

Card text and meta data from [Limitless TCG](https://limitlesstcg.com). Pokémon and the
Pokémon TCG are © Nintendo / Creatures Inc. / GAME FREAK inc. This project is
unaffiliated fan tooling and contains no card images or copyrighted artwork.

MIT licensed — see [LICENSE](LICENSE).
