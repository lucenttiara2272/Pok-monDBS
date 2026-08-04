/**
 * Turns a plain { "Card Name": count } object into the spec shape the engine wants,
 * using data/cards.json as the source of truth for card mechanics.
 */

/** @param {object} cardsJson parsed data/cards.json */
export function makeCardIndex(cardsJson) {
  const byName = {};
  for (const c of cardsJson.cards) byName[c.name] = c;
  return byName;
}

/**
 * @param {Record<string, number>} counts  e.g. { "Ultra Ball": 4 }
 * @param {Record<string, object>} index   from makeCardIndex()
 */
export function buildSpec(counts, index) {
  const spec = {};
  for (const [name, n] of Object.entries(counts)) {
    if (!n) continue;
    const card = index[name];
    if (!card) throw new Error(`Unknown card: ${name}`);
    spec[name] = {
      n,
      kind: card.category,
      // `type` lives at the top level of the card, not inside `sim`, but the engine
      // needs it — Dark Bell only Confuses non-[D] Pokémon, including your own.
      type: card.type,
      ...(card.sim || {}),
    };
  }
  return spec;
}

/**
 * Counts-only presets. Kept separate from mechanics so they stay readable.
 *
 * These are calibration references for the test suite, not a menu of decks to
 * build from — `tests/parity.test.js` pins the engine against the recorded
 * Python results for each one. The deck builder shows `UI_PRESETS` instead, so
 * an artefact like the original 61-card list stays available to the tests
 * without cluttering the dropdown.
 */
export const PRESETS = {
  'As sent (61 cards)': {
    'Mega Darkrai ex': 3, 'Mega Absol ex': 2, 'Fezandipiti ex': 1, 'Munkidori': 2,
    'Darkness Energy': 11, 'Spiky Energy': 1,
    'Ultra Ball': 4, 'Dark Bell': 4, 'Night Stretcher': 3, 'Punk Helmet': 2,
    'Amulet of Hope': 1, 'Air Balloon': 1, 'Powerglass': 1, 'Energy Retrieval': 3,
    'Energy Search': 3, 'Switch': 2, 'Energy Switch': 3,
    "AZ's Tranquility": 2, "Boss's Orders": 2, "Janine's Secret Art": 2,
    "Black Belt's Training": 2, "Lisia's Appeal": 2, 'Judge': 1,
    "Lillie's Determination": 1, 'Jett': 1, "Team Rocket's Petrel": 1,
  },

  'Optimised (43%)': {
    'Mega Darkrai ex': 4, 'Mega Absol ex': 2, 'Fezandipiti ex': 2, 'Munkidori': 4,
    'Darkness Energy': 14,
    'Ultra Ball': 4, 'Dark Bell': 4, 'Night Stretcher': 3, 'Energy Retrieval': 3,
    'Energy Switch': 2, 'Switch': 2, 'Energy Search': 4,
    "Lillie's Determination": 4, "Boss's Orders": 2, "Janine's Secret Art": 2,
    "Black Belt's Training": 2, "Lisia's Appeal": 1, "AZ's Tranquility": 1,
  },

  // Calibration probe. Deliberately ordinary; uses a 2-prize attacker.
  // NOT tournament legal (8 Lillie's) — it exists only to prove the engine is fair.
  'Control (calibration)': {
    'Mega Darkrai ex': 4, 'Munkidori': 5, 'Fezandipiti ex': 4,
    'Darkness Energy': 14,
    'Ultra Ball': 4, 'Dark Bell': 4, 'Night Stretcher': 3, 'Energy Search': 2,
    'Energy Switch': 2, 'Switch': 2, 'Powerglass': 1,
    "Lillie's Determination": 8, "Boss's Orders": 3,
    "Janine's Secret Art": 2, "Black Belt's Training": 2,
  },
};

/** Presets worth offering as a starting point in the deck builder. */
export const UI_PRESETS = ['Optimised (43%)'];

/** The control probe overrides Mega Darkrai to 2 prizes; apply after buildSpec. */
export function applyControlOverride(spec) {
  if (spec['Mega Darkrai ex']) spec['Mega Darkrai ex'].prizes = 2;
  return spec;
}
