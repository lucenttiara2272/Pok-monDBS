/**
 * Decklist text -> { cardName: count }.
 *
 * The inverse of ui.js's copyList, and deliberately tolerant of the formats
 * people actually paste: PTCG Live exports, Limitless lists, and lists typed by
 * hand. Blank lines, section headers and stray whitespace are ignored.
 *
 *   Pokémon: 9
 *   1 Fezandipiti ex ASC 142
 *   3 Munkidori TWM 95
 *
 * ─── WHY IT REPORTS INSTEAD OF GUESSING ─────────────────────────────────────
 * A card the database does not have is an error, never a silent omission. An
 * importer that quietly drops two lines hands you a 54-card deck that looks like
 * the list you pasted, and the simulator will then happily report a win rate for
 * it. Everything unrecognised comes back in `errors` for the caller to show.
 */

/** `1 Mega Absol ex MEG 86` -> count, name, set. Set is optional. */
const LINE = /^(\d+)\s*[x×]?\s+(.+?)(?:\s+([A-Z][A-Z0-9-]{1,5})\s+(\d+[a-zA-Z]?))?$/;

/** `Pokémon: 9`, `Trainer: 31`, `Total Cards: 60` — counts we recompute anyway. */
const HEADER = /^[A-Za-zÀ-ÿ' ]+:\s*\d+\s*$/;

/**
 * PTCG Live writes basic Energy as "Basic Darkness Energy"; this project, its
 * presets and its card database all say "Darkness Energy". The importer applies
 * the same normalisation, so a list exported from the game client matches.
 */
function normaliseName(name) {
  return /^Basic .+ Energy$/.test(name) ? name.replace(/^Basic /, '') : name;
}

/**
 * Resolve one line to a card in the database.
 *
 * Set code and number are preferred over the name when both are present,
 * because they are an exact identity and names are not: Munkidori and Munkidori
 * ex are different cards, and so are reprints of the same name across sets.
 */
function resolve(name, set, index, bySet) {
  if (set && bySet.has(set)) return bySet.get(set);
  if (index[name]) return name;

  const wanted = name.toLowerCase();
  const ci = Object.keys(index).find((n) => n.toLowerCase() === wanted);
  if (ci) return ci;

  // Apostrophes are the usual culprit: "Lillie's" typed with a right single
  // quote does not equal "Lillie's" with an ASCII one.
  const loose = (s) => s.toLowerCase().replace(/[’'`]/g, "'").replace(/\s+/g, ' ');
  return Object.keys(index).find((n) => loose(n) === loose(name)) || null;
}

/**
 * @param {string} text     pasted decklist
 * @param {object} index    from makeCardIndex()
 * @returns {{counts: Record<string, number>, errors: string[], warnings: string[], size: number}}
 */
export function parseDecklist(text, index) {
  const counts = {};
  const errors = [];
  const warnings = [];

  const bySet = new Map();
  for (const [name, card] of Object.entries(index)) {
    if (card.set) bySet.set(card.set, name);
  }

  const lines = String(text || '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim();
    if (!raw || HEADER.test(raw) || raw.startsWith('#')) continue;

    const m = LINE.exec(raw);
    if (!m) {
      errors.push(`Line ${i + 1}: could not read "${raw}"`);
      continue;
    }
    const n = Number(m[1]);
    const name = normaliseName(m[2].trim());
    const set = m[3] ? `${m[3]} ${m[4]}` : null;

    const found = resolve(name, set, index, bySet);
    if (!found) {
      errors.push(`Line ${i + 1}: no card named "${name}"${set ? ` (${set})` : ''}`);
      continue;
    }
    // Matched by name but the printing differs. Harmless for the simulation,
    // which keys on name, but worth saying rather than silently substituting.
    if (set && index[found].set !== set) {
      warnings.push(`${found}: list says ${set}, database has ${index[found].set}`);
    }
    counts[found] = (counts[found] || 0) + n;
  }

  for (const [name, n] of Object.entries(counts)) {
    const max = index[name].max;
    if (max != null && n > max) {
      warnings.push(`${n}× ${name} exceeds its limit of ${max}`);
    }
  }

  const size = Object.values(counts).reduce((a, b) => a + b, 0);
  if (size && size !== 60) {
    warnings.push(`List totals ${size} cards, not 60`);
  }
  return { counts, errors, warnings, size };
}
