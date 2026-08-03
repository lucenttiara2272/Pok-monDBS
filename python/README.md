# Python reference implementation

The original engine. The JavaScript version in `../src/engine.js` is a direct port of
`ptcg_sim.py`, and `../tests/parity.test.js` checks the two agree within Monte Carlo
noise:

| Build | Python | JavaScript |
|---|---|---|
| Control (calibration) | 52.8% | 53.3% |
| As sent (61 cards) | 28.6% | 28.8% |
| Optimised | 43.4% | 42.9% |

This code is kept as a reference and a second opinion, not as the shipped path. If you
change simulation behaviour, change `src/engine.js` — and if you want the parity test to
keep meaning something, mirror the change here and re-record the numbers above.

```bash
python3 ptcg_sim.py      # gauntlet + consistency for the as-sent list
python3 variants.py      # build ladder and calibration control
```

No dependencies beyond the standard library.

## Note on `_shuffle`

These scripts use a hand-rolled Fisher-Yates driven by `rng.random()` rather than
`random.shuffle`. That's a workaround for a `getrandbits` crash hit in the original
sandbox, not a modelling decision — `random.shuffle` is fine on a normal interpreter.
