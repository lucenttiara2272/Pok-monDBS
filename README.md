# PTCG Deck Lab

Build a Pokémon TCG deck and simulate it against the current tournament meta.

Standard format, Regulation H/I/J. Meta snapshot: **August 2026**.

Everything runs in the browser — no backend, no install. The deck builder and the
simulation engine are both plain ES modules, so GitHub Pages hosts the whole thing.

---

## What it does

- **Deck builder** — type a card name, pick from the predictive dropdown, and adjust
  counts with a stepper. The main view shows only what's in your deck. Legality updates
  live: 60 cards exactly, 4-copy limit, basic Energy exempt, and every evolution checked
  against its Basic.
- **Optimiser** — pin the cards you're building around, and it fills the rest of the
  deck to maximise meta-weighted win rate. Pinned cards are never touched.
- **Simulator** — plays thousands of games against the top 8 archetypes, weighted by
  real meta share, and reports win rate, matchup breakdown, and how the games ended.
- **Consistency maths** — exact hypergeometric mulligan rate, Pokémon count, draw
  Supporter count, all recalculated as you build.

## Running it

It needs to be served over HTTP (ES modules + `fetch` won't work from `file://`):

```bash
npm run serve             # then open http://localhost:8000
npm run serve -- 3000     # a different port
```

The server is a small dependency-free Node script (`tools/serve.mjs`). It used to
be `python3 -m http.server`, which fails on Windows without Python — and the
`python3` alias there opens the Microsoft Store rather than erroring cleanly.
Node is already required by this project, so there is no second runtime to install.

Tests:

```bash
npm test
```

## Deploying to GitHub Pages

Push to `main` and the `deploy` workflow builds and publishes the site.

**First deploy only:** Pages has to exist before a workflow can publish to it. The
workflow passes `enablement: true` to `actions/configure-pages`, which turns it on
automatically — but that only works if Actions has write permission on the repo:

> Settings → Actions → General → Workflow permissions → **Read and write permissions**

If the deploy job fails with:

```
Get Pages site failed. Please verify that the repository has Pages enabled
and configured to build using GitHub Actions. Error: Not Found
```

…then set it by hand instead:

> Settings → Pages → Build and deployment → Source → **GitHub Actions**

Then re-run the failed job from the Actions tab. Note that Pages on a **private** repo
requires a paid plan; make the repo public if you're on Free.

## The optimiser

Pin cards with the ○ button on each deck row, then press **Optimise deck**. It searches
single-card swaps, keeps the best improvement each round, and shows exactly what it
changed before you apply anything.

Three things it does deliberately:

**Common random numbers.** Every candidate deck is scored on the *same* set of random
games. A 250-game evaluation carries several points of noise, and without a shared seed
the search cheerfully "improves" a deck by reshuffling luck. Sharing the seed means a
measured difference reflects the decklist rather than the dice.

**Fresh-sample verification.** Because the search tunes against one sample, the before
and after it reports are re-scored on a different, larger sample. A change that only
looked good during the search shows no gain here, and the optimiser says so rather than
claiming a win.

**The prior proposes, the simulation decides.** It tries a structurally repaired version
of your deck — Pokémon count and draw Supporters raised to the usual minimums — as a
second starting point, because hill climbing one card at a time cannot cross that valley.
But it only adopts that shape if it actually scores better. On a focused list, padding
with filler Pokémon often costs more than the mulligan rate gains, and it will tell you
that happened.

It is hill climbing, not exhaustive search. It finds a local improvement on what you gave
it, not the best possible deck.

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
tools/import-cards.mjs  bulk card importer
src/decks.js          preset decklists + spec builder
src/ui.js             DOM wiring
src/styles.css
data/cards.json       card database — mechanics live in the `sim` block
data/meta.json        opponent archetypes, meta shares, sourcing notes
tests/                parity, calibration, and data-integrity tests
python/               original Python reference implementation
```

## Building out the card pool

`npm run coverage` shows how much of the Standard pool is in the database and which
sets are still missing.

The pool is transcribed from [limitlesstcg.com](https://limitlesstcg.com) set by set,
50 cards per page, in batches under `data/batches/`. Each batch is one line per card in
a compact pipe-delimited format; card text is synthesised from the structured fields so
only genuinely load-bearing prose has to be typed:

```
P|Name|SET N|TYPE|HP|stage|evolvesFrom|retreat|weak|attacks|note
I|Name|SET N|Item text          O| Tool    S| Supporter    D| Stadium
E|Name|SET N|SYM|basic|text
```

Apply one with:

```bash
node tools/add-batch.mjs data/batches/pbl-1.txt --dry-run
node tools/add-batch.mjs data/batches/pbl-1.txt
npm test
```

Prize counts are derived from the name — `Mega X ex` is 3 Prizes, `X ex` is 2, anything
else 1 — so the most consequential number can't be typo'd. Existing cards are never
overwritten, so re-running a batch is safe, and a card from a set outside the format is
rejected rather than silently added.

Note that Limitless counts *prints*: the tail of every set is alternate art sharing a
name with an earlier number. Pitch Black lists 120 prints but only 84 distinct cards.

## Importing from an API (partial)

`data/cards.json` ships with a hand-curated core. To pull in the whole Standard-legal
pool:

```bash
node tools/import-cards.mjs --dry-run     # see what would come in
node tools/import-cards.mjs               # import and merge
npm test
```

Source is [pokemontcg.io](https://pokemontcg.io). Set `POKEMONTCG_API_KEY` if you hit
rate limits.

**This source is incomplete for this format.** Its `legalities.standard` flag lags the
real rotation: it reports rotated Sword & Shield cards as legal while having none of the
2026 Mega Evolution sets. The importer therefore filters on `data/format.json` rather
than trusting the flag, which is why a run yields far fewer cards than the API claims.
Batch transcription above is the reliable path; treat the importer as a head start.

**Curated cards always win.** Anything already in `data/cards.json` keeps its
hand-written `sim` block; the importer only adds names that aren't there. Those curated
blocks encode mechanics no API exposes — Abyss Eye's conditional knockout, Dark Bell's
self-Confusion trap, Mega prize counts.

**What you get, and what you don't.** Imported cards are complete enough to *build*
with: name, set, type, HP, stage, evolution line, retreat, weakness, attack costs and
damage. They are not fully *simulated* — ability and Trainer effect text is prose that
no parser turns into game logic. An imported Supporter is inert in the simulation until
someone writes its effect into `src/engine.js`. Treat a win rate for a deck built mostly
from imported Trainers with suspicion.

A failed or offline run exits without touching `data/cards.json`.

## Adding a card by hand

The search box only searches the cards in `data/cards.json` — it is **not** a lookup of
every card ever printed. If something doesn't appear, it isn't in the database yet.

**In the app:** hit **+ Add card**, fill in the form, and it shows up immediately. Custom
cards are saved in your browser's local storage, so they survive a reload but live only on
that machine. Press **Export JSON** to copy them in the right shape and paste them into
`data/cards.json` to make them permanent and shared.

**Attacks are data-driven.** A Pokémon with a `sim.attacks` array can fight without any
engine change — the engine reads the Energy cost, damage, and knockout effects straight
from the JSON. Supported attack fields:

| Field | Meaning |
|---|---|
| `cost` | e.g. `{ "D": 2, "C": 1 }` — `C` accepts any Energy |
| `damage` | base damage |
| `bonusIfOwnBenchDamaged` | extra damage if your own Bench has damage counters |
| `flipUntilTailsBonus` | extra damage per heads, flipping until tails |
| `koIfSpecialCondition` | auto-KO if the Defending Pokémon has a Special Condition |
| `koIfExactDamage` | auto-KO at exactly this much damage already on it |

**By hand:** append to `data/cards.json`:

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

- Ability text and Trainer effects on **imported** cards are not simulated; only
  hand-modelled cards have real mechanics.
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
