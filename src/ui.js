/**
 * Deck builder UI.
 * Typeahead search adds cards; the main area shows only what is in the deck.
 */

import {
  runGauntlet, validateDeck, deckStats,
} from './engine.js?v=dev';
import {
  makeCardIndex, buildSpec, PRESETS, applyControlOverride,
} from './decks.js?v=dev';

const $ = (id) => document.getElementById(id);

// Stamped by the deploy workflow with the commit SHA so a new release can never be
// served from a stale browser cache. Stays 'dev' when running locally.
const APP_VERSION = 'dev';
const CATS = ['pokemon', 'item', 'tool', 'supporter', 'energy'];
const CAT_LABEL = {
  pokemon: 'Pokémon', item: 'Item', tool: 'Tool',
  supporter: 'Supporter', energy: 'Energy',
};

let CARDS = [];
let INDEX = {};
let META = [];
let deck = {};                 // { cardName: count }

/* ------------------------------------------------------- custom cards --- */
// Cards the user adds live here and are merged over data/cards.json at boot.
// Browser-local: Export JSON moves them into the repo permanently.
const STORE_KEY = 'ptcg-deck-lab.customCards';

function loadCustom() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY) || '[]'); }
  catch { return []; }
}
function saveCustom(list) {
  localStorage.setItem(STORE_KEY, JSON.stringify(list));
}
function slug(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/** Build a card record from the dialog's form fields. */
function cardFromForm(fd) {
  const cat = fd.get('category');
  const name = fd.get('name').trim();
  const card = {
    id: slug(name),
    name,
    set: fd.get('set').trim(),
    category: cat,
    max: Number(fd.get('max')) || 4,
    text: fd.get('text').trim(),
    custom: true,
  };
  const type = fd.get('type');
  if (type) card.type = type;

  if (cat === 'pokemon') {
    const stage = Number(fd.get('stage')) || 0;
    card.sim = {
      stage,
      hp: Number(fd.get('hp')),
      prizes: Number(fd.get('prizes')),
      retreat: Number(fd.get('retreat')),
    };
    if (stage === 0) card.sim.basic = true;
    const from = (fd.get('evolvesFrom') || '').trim();
    if (stage > 0) {
      if (!from) throw new Error('A Stage 1 or 2 Pokémon must say what it evolves from.');
      card.sim.evolvesFrom = from;
    }
    const weak = fd.get('weak');
    if (weak) card.sim.weak = weak;

    const atkName = (fd.get('atkName') || '').trim();
    if (atkName) {
      const typed = Number(fd.get('costTyped')) || 0;
      const any = Number(fd.get('costAny')) || 0;
      const cost = {};
      if (typed > 0) {
        if (!type) throw new Error('An attack with a typed Energy cost needs a Type.');
        cost[type] = typed;
      }
      if (any > 0) cost.C = any;
      if (!typed && !any) throw new Error('An attack needs at least one Energy in its cost.');
      card.sim.role = 'attacker';
      card.sim.attacks = [{
        name: atkName,
        cost,
        damage: Number(fd.get('atkDmg')) || 0,
      }];
    }
  } else if (cat === 'energy') {
    card.sim = { basicEnergy: !card.max || card.max > 4, provides: type || 'C' };
  }
  return card;
}

/* ---------------------------------------------------------------- boot --- */
async function boot() {
  const [cardsJson, metaJson] = await Promise.all([
    fetch(`data/cards.json?v=${APP_VERSION}`).then((r) => r.json()),
    fetch(`data/meta.json?v=${APP_VERSION}`).then((r) => r.json()),
  ]);
  const custom = loadCustom();
  const merged = [...cardsJson.cards.filter(
    (c) => !custom.some((x) => x.name === c.name)), ...custom];
  CARDS = merged;
  INDEX = makeCardIndex({ cards: merged });
  META = metaJson.decks;

  const sel = $('preset');
  sel.innerHTML = Object.keys(PRESETS).map((p) => `<option>${p}</option>`).join('');
  sel.value = 'Optimised (43%)';
  sel.onchange = () => { deck = { ...PRESETS[sel.value] }; renderAll(); };
  deck = { ...PRESETS[sel.value] };

  const box = $('search');
  box.oninput = () => {
    sugList = findMatches(box.value);
    sugIdx = sugList.length ? 0 : -1;
    renderSuggest();
  };
  box.onkeydown = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault(); sugIdx = Math.min(sugList.length - 1, sugIdx + 1); renderSuggest();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault(); sugIdx = Math.max(0, sugIdx - 1); renderSuggest();
    } else if (e.key === 'Enter') {
      e.preventDefault(); if (sugIdx >= 0) addCard(sugList[sugIdx]);
    } else if (e.key === 'Escape') closeSuggest();
  };
  box.onblur = () => setTimeout(closeSuggest, 120);
  box.onfocus = () => {
    if (box.value) { sugList = findMatches(box.value); sugIdx = 0; renderSuggest(); }
  };

  $('run').onclick = run;
  $('clear').onclick = () => { deck = {}; renderAll(); };
  $('copy').onclick = copyList;

  const modal = $('cardModal');
  $('add-card').onclick = () => {
    $('cardForm').reset();
    $('form-err').classList.add('hidden');
    if ($('search').value.trim()) {
      $('cardForm').elements.namedItem('name').value = $('search').value.trim();
    }
    modal.showModal();
  };
  $('cardForm').addEventListener('change', () => {
    const cat = $('cardForm').elements.namedItem('category').value;
    $('mon-fields').style.display = cat === 'pokemon' ? '' : 'none';
  });
  $('save-card').onclick = (e) => {
    const form = $('cardForm');
    if (!form.reportValidity()) { e.preventDefault(); return; }
    let card;
    try {
      card = cardFromForm(new FormData(form));
    } catch (err) {
      e.preventDefault();
      const errBox = $('form-err');
      errBox.textContent = err.message;
      errBox.classList.remove('hidden');
      return;
    }
    const list = loadCustom().filter((c) => c.name !== card.name);
    list.push(card);
    saveCustom(list);
    CARDS = [...CARDS.filter((c) => c.name !== card.name), card];
    INDEX = makeCardIndex({ cards: CARDS });
    $('search').value = '';
    closeSuggest();
    addCard(card);
  };

  const b = $('build');
  if (b) {
    b.textContent = `Build ${APP_VERSION} · ${CARDS.length} cards loaded`
      + (loadCustom().length ? ` (${loadCustom().length} custom)` : '');
  }

  renderAll();
}

/** Copy every custom card as JSON ready to paste into data/cards.json. */
function exportCustom() {
  const list = loadCustom().map(({ custom, ...c }) => c);
  if (!list.length) return;
  const json = list.map((c) => JSON.stringify(c, null, 2)
    .split('\n').map((l) => '    ' + l).join('\n')).join(',\n');
  navigator.clipboard.writeText(json + ',').then(() => {
    const b = $('export'); const t = b.textContent;
    b.textContent = 'Copied — paste into data/cards.json';
    setTimeout(() => { b.textContent = t; }, 2600);
  });
}

/* ------------------------------------------------------------ typeahead --- */
function maxFor(card) {
  return card.sim && card.sim.basicEnergy ? 60 : (card.max || 4);
}

let sugList = [];
let sugIdx = -1;

/** Rank matches: exact name first, then prefix, then word-start, then substring. */
function findMatches(q) {
  const s = q.trim().toLowerCase();
  if (!s) return [];
  const scored = [];
  for (const c of CARDS) {
    const n = c.name.toLowerCase();
    let score = -1;
    if (n === s) score = 0;
    else if (n.startsWith(s)) score = 1;
    else if (n.split(/[^a-z0-9']+/).some((w) => w.startsWith(s))) score = 2;
    else if (n.includes(s)) score = 3;
    else if ((c.text || '').toLowerCase().includes(s)) score = 5;
    if (score >= 0) scored.push([score, c]);
  }
  scored.sort((a, b) => a[0] - b[0] || a[1].name.localeCompare(b[1].name));
  return scored.slice(0, 12).map(([, c]) => c);
}

function cardMeta(c) {
  return [
    `<span>${c.set}</span>`,
    c.type ? `<span class="badge ${c.type}">${c.type}</span>` : '',
    c.sim && c.sim.stage ? `<span>Stage ${c.sim.stage}</span>` : '',
    c.sim && c.sim.evolvesFrom ? `<span>← ${c.sim.evolvesFrom}</span>` : '',
    c.sim && c.sim.prizes === 3 ? '<span class="badge mega">3 prizes</span>' : '',
    c.custom ? '<span class="badge custom">custom</span>' : '',
  ].join('');
}

function renderSuggest() {
  const box = $('suggest');
  if (!sugList.length) {
    const q = $('search').value.trim();
    if (!q) { box.classList.add('hidden'); return; }
    box.innerHTML = `<div class="sug-empty">
      No card called “${q}” among the ${CARDS.length} cards loaded.<br>
      Use <b>+ Add card</b> to add it yourself.</div>`;
    box.classList.remove('hidden');
    return;
  }
  box.innerHTML = sugList.map((c, i) => {
    const have = deck[c.name] || 0;
    const full = have >= maxFor(c);
    return `<div class="sug${i === sugIdx ? ' on' : ''}" data-i="${i}">
      <div>
        <div class="s-nm">${c.name}</div>
        <div class="s-meta">${cardMeta(c)}<span>${CAT_LABEL[c.category]}</span>
          ${have ? `<span class="s-in">${have} in deck</span>` : ''}</div>
      </div>
      <div class="s-add">${full ? 'max' : '+ add'}</div>
    </div>`;
  }).join('');
  box.classList.remove('hidden');
  box.querySelectorAll('.sug').forEach((el) => {
    el.onmousedown = (e) => { e.preventDefault(); addCard(sugList[+el.dataset.i]); };
  });
}

function closeSuggest() {
  $('suggest').classList.add('hidden');
  sugList = []; sugIdx = -1;
}

function addCard(card, n = 1) {
  if (!card) return;
  const cur = deck[card.name] || 0;
  const next = Math.min(maxFor(card), cur + n);
  deck[card.name] = next;
  $('search').value = '';
  closeSuggest();
  renderAll();
}

function setCount(name, n) {
  const card = INDEX[name];
  if (!card) return;
  const v = Math.max(0, Math.min(maxFor(card), n));
  if (v === 0) delete deck[name]; else deck[name] = v;
  renderAll();
}

/* ---------------------------------------------------------- deck editor --- */
function renderGrid() {
  const wrap = $('grid');
  const names = Object.keys(deck).filter((n) => INDEX[n]);

  if (!names.length) {
    wrap.innerHTML = `<div class="deck-empty">
      <b>Your deck is empty</b>
      Start typing a card name above, or load a preset from the top bar.
    </div>`;
    return;
  }

  let html = '';
  for (const cat of CATS) {
    const group = names.filter((n) => INDEX[n].category === cat).sort();
    if (!group.length) continue;
    const tot = group.reduce((a, n) => a + deck[n], 0);
    html += `<div class="grp"><div class="grp-h">
      <span>${CAT_LABEL[cat]}</span><span>${tot}</span></div><div class="rows">`;
    for (const n of group) {
      const c = INDEX[n];
      const q = deck[n];
      const max = maxFor(c);
      html += `
        <div class="row${c.warning ? ' warnrow' : ''}" title="${
  (c.warning ? c.warning + '\n\n' : '') + (c.text || '').replace(/"/g, '&quot;')}">
          <div class="stepper">
            <button data-dec="${n}">−</button>
            <span class="qn">${q}</span>
            <button data-inc="${n}"${q >= max ? ' disabled' : ''}>+</button>
          </div>
          <div>
            <div class="r-nm">${n}</div>
            <div class="r-meta">${cardMeta(c)}</div>
          </div>
          <button class="r-x" data-rm="${n}" title="Remove">✕</button>
        </div>`;
    }
    html += '</div></div>';
  }
  wrap.innerHTML = html;

  wrap.querySelectorAll('[data-inc]').forEach((b) => {
    b.onclick = () => setCount(b.dataset.inc, (deck[b.dataset.inc] || 0) + 1);
  });
  wrap.querySelectorAll('[data-dec]').forEach((b) => {
    b.onclick = () => setCount(b.dataset.dec, (deck[b.dataset.dec] || 0) - 1);
  });
  wrap.querySelectorAll('[data-rm]').forEach((b) => {
    b.onclick = () => setCount(b.dataset.rm, 0);
  });
}

/* ------------------------------------------------------------ deck panel --- */
function currentSpec() {
  return buildSpec(deck, INDEX);
}

function renderDeck() {
  const spec = currentSpec();
  const size = Object.values(deck).reduce((a, c) => a + c, 0);
  const cnt = $('count');
  cnt.innerHTML = `${size}<span>/60</span>`;
  cnt.className = 'count' + (size === 60 ? ' ok' : (size > 60 ? ' over' : ''));

  const s = deckStats(spec);
  $('composition').innerHTML = `
    <div class="comp"><b>${s.pokemon}</b><span>Pokémon</span></div>
    <div class="comp"><b>${s.trainers}</b><span>Trainer</span></div>
    <div class="comp"><b>${s.energy}</b><span>Energy</span></div>
    <div class="comp"><b>${s.mulligan.toFixed(0)}%</b><span>Mulligan</span></div>`;

  const v = validateDeck(spec);
  let msgs = '';
  for (const e of v.errors) msgs += `<div class="msg err">${e}</div>`;
  for (const w of v.warnings) msgs += `<div class="msg warn">${w}</div>`;
  if (v.ok && !v.warnings.length) {
    msgs = '<div class="msg ok">Legal 60 — no structural warnings.</div>';
  }
  $('legality').innerHTML = msgs;

  $('decklist').innerHTML = '';
}

function renderAll() {
  renderGrid();
  renderDeck();
  const exp = $('export');
  const has = loadCustom().length > 0;
  exp.classList.toggle('hidden', !has);
  exp.onclick = exportCustom;
}

function copyList() {
  const lines = [];
  for (const cat of CATS) {
    const rows = Object.keys(deck)
      .filter((n) => INDEX[n] && INDEX[n].category === cat).sort();
    if (!rows.length) continue;
    lines.push(`${CAT_LABEL[cat]}: ${rows.reduce((a, n) => a + deck[n], 0)}`);
    for (const n of rows) lines.push(`${deck[n]} ${n} ${INDEX[n].set}`);
    lines.push('');
  }
  navigator.clipboard.writeText(lines.join('\n').trim()).then(() => {
    const b = $('copy'); const t = b.textContent;
    b.textContent = 'Copied'; setTimeout(() => { b.textContent = t; }, 1200);
  });
}

/* ----------------------------------------------------------------- run --- */
function wrColor(v) {
  if (v >= 50) return '#3fb950';
  if (v >= 40) return '#57a64a';
  if (v >= 30) return '#d29922';
  if (v >= 20) return '#db7c22';
  return '#f85149';
}

async function run() {
  const spec = currentSpec();
  const size = Object.values(deck).reduce((a, c) => a + c, 0);
  if (size === 0) return;

  const btn = $('run');
  btn.disabled = true;
  btn.textContent = 'Running…';
  await new Promise((r) => setTimeout(r, 30));

  const games = Number($('games').value);
  const res = runGauntlet(spec, META, { games, seed: 20260803 });

  const ctrl = applyControlOverride(buildSpec(PRESETS['Control (calibration)'], INDEX));
  const ctrlRes = runGauntlet(ctrl, META, { games: Math.min(games, 3000), seed: 20260803 });

  const s = deckStats(spec);
  const mus = Object.values(res.matchups).sort((a, b) => b.share - a.share);
  const worst = mus.reduce((a, b) => (a.winrate < b.winrate ? a : b));

  $('res-kpis').innerHTML = `
    <div class="kpi"><div class="n" style="color:${wrColor(res.weighted)}">
      ${res.weighted.toFixed(1)}%</div>
      <div class="l">Meta-weighted win rate</div>
      <div class="d">Across ${res.metaCovered.toFixed(1)}% of the field</div></div>
    <div class="kpi"><div class="n">${s.mulligan.toFixed(1)}%</div>
      <div class="l">Mulligan rate</div>
      <div class="d">${s.pokemon} Pokémon in deck</div></div>
    <div class="kpi"><div class="n">${s.drawSupporters}</div>
      <div class="l">Draw Supporters</div>
      <div class="d">4 is the practical floor</div></div>
    <div class="kpi"><div class="n" style="color:${wrColor(worst.winrate)}">
      ${worst.winrate.toFixed(1)}%</div>
      <div class="l">Worst matchup</div>
      <div class="d">${worst.name}</div></div>`;

  $('res-matchups').innerHTML = mus.map((m) => `
    <div class="mrow">
      <div>
        <div class="top-line">
          <span><b>${m.name}</b>
            <span class="conf ${m.confidence}">${m.confidence}</span></span>
          <span class="share">${m.share.toFixed(1)}% of meta</span>
        </div>
        <div class="bar"><span style="width:${Math.max(1, m.winrate)}%;
          background:${wrColor(m.winrate)}"></span></div>
      </div>
      <div class="v" style="color:${wrColor(m.winrate)}">${m.winrate.toFixed(1)}%</div>
    </div>`).join('');

  $('res-cal').innerHTML =
    `Calibration: the bundled control shell scores
     <b>${ctrlRes.weighted.toFixed(1)}%</b> under these same settings. That is the
     reference point — it should sit near 50%. Confidence tags mark how card-exact
     each opponent model is.`;

  const LBL = {
    prizes: 'You won', prize_race: 'Lost the prize race',
    bench_out: 'Ran out of Pokémon', time_out: 'Game went long',
    deck_out: 'Decked out', no_basic_disaster: 'No Basic to start',
  };
  const agg = {};
  for (const m of mus) {
    const tot = Object.values(m.reasons).reduce((a, c) => a + c, 0);
    for (const [k, v] of Object.entries(m.reasons)) {
      agg[k] = (agg[k] || 0) + (v / tot) * m.share;
    }
  }
  const tot = Object.values(agg).reduce((a, c) => a + c, 0);
  $('res-reasons').innerHTML = Object.entries(agg)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => {
      const p = (v / tot) * 100;
      const col = k === 'prizes' ? '#3fb950'
        : (k === 'bench_out' ? '#f85149' : '#d29922');
      return `<div style="margin-bottom:10px">
        <div style="display:flex;justify-content:space-between;font-size:12.5px">
          <span>${LBL[k] || k}</span>
          <span style="color:var(--dim)">${p.toFixed(1)}%</span></div>
        <div class="bar" style="margin-top:4px">
          <span style="width:${p}%;background:${col}"></span></div></div>`;
    }).join('');

  $('results').classList.remove('hidden');
  btn.disabled = false;
  btn.textContent = 'Run simulation';
  $('results').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

boot().catch((e) => {
  document.body.insertAdjacentHTML('afterbegin',
    `<div class="msg err" style="margin:20px">Failed to load data: ${e.message}.
     <br>This page uses ES modules and fetch, so it needs to be served over HTTP —
     run <code>npm run serve</code> and open http://localhost:8000 rather than
     double-clicking the file.</div>`);
});
