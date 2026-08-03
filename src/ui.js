/**
 * Deck builder UI.
 * Card grid in the middle, live deck list on the right, simulation below.
 */

import {
  runGauntlet, validateDeck, deckStats, DRAW_SUPPORTERS,
} from './engine.js';
import {
  makeCardIndex, buildSpec, PRESETS, applyControlOverride,
} from './decks.js';

const $ = (id) => document.getElementById(id);
const CATS = ['pokemon', 'item', 'tool', 'supporter', 'energy'];
const CAT_LABEL = {
  pokemon: 'Pokémon', item: 'Item', tool: 'Tool',
  supporter: 'Supporter', energy: 'Energy',
};

let CARDS = [];
let INDEX = {};
let META = [];
let deck = {};                 // { cardName: count }
let filter = 'all';
let query = '';

/* ---------------------------------------------------------------- boot --- */
async function boot() {
  const [cardsJson, metaJson] = await Promise.all([
    fetch('data/cards.json').then((r) => r.json()),
    fetch('data/meta.json').then((r) => r.json()),
  ]);
  CARDS = cardsJson.cards;
  INDEX = makeCardIndex(cardsJson);
  META = metaJson.decks;

  // preset selector
  const sel = $('preset');
  sel.innerHTML = Object.keys(PRESETS)
    .map((p) => `<option>${p}</option>`).join('');
  sel.value = 'Optimised (43%)';
  sel.onchange = () => { deck = { ...PRESETS[sel.value] }; renderAll(); };
  deck = { ...PRESETS[sel.value] };

  // filters
  $('filters').innerHTML =
    ['all', ...CATS].map((c) =>
      `<div class="chip${c === 'all' ? ' on' : ''}" data-f="${c}">
         ${c === 'all' ? 'All' : CAT_LABEL[c]}</div>`).join('');
  $('filters').onclick = (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    filter = chip.dataset.f;
    [...$('filters').children].forEach((c) => c.classList.toggle('on', c === chip));
    renderGrid();
  };

  $('search').oninput = (e) => { query = e.target.value.toLowerCase(); renderGrid(); };
  $('run').onclick = run;
  $('clear').onclick = () => { deck = {}; renderAll(); };
  $('copy').onclick = copyList;

  renderAll();
}

/* ---------------------------------------------------------------- grid --- */
function maxFor(card) {
  return card.sim && card.sim.basicEnergy ? 30 : (card.max || 4);
}

function renderGrid() {
  const wrap = $('grid');
  const visible = CARDS.filter((c) => {
    if (filter !== 'all' && c.category !== filter) return false;
    if (!query) return true;
    return (c.name + ' ' + (c.text || '')).toLowerCase().includes(query);
  });

  let html = '';
  for (const cat of CATS) {
    const group = visible.filter((c) => c.category === cat);
    if (!group.length) continue;
    html += `<div class="cat-head">${CAT_LABEL[cat]}</div><div class="cards">`;
    for (const c of group) {
      const n = deck[c.name] || 0;
      const max = maxFor(c);
      const opts = Array.from({ length: max + 1 }, (_, i) =>
        `<option value="${i}"${i === n ? ' selected' : ''}>${i}</option>`).join('');
      const isMega = /^Mega /.test(c.name);
      html += `
        <div class="card${n ? ' in' : ''}">
          <div class="nm">${c.name}</div>
          <div class="meta">
            <span>${c.set}</span>
            ${c.type ? `<span class="badge ${c.type}">${c.type}</span>` : ''}
            ${isMega ? '<span class="badge mega">3 prizes</span>' : ''}
          </div>
          <div class="tx" title="${(c.text || '').replace(/"/g, '&quot;')}">${c.text || ''}</div>
          <div class="qty">
            <select data-card="${c.name}">${opts}</select>
            ${isMega ? '<span class="warn3">Mega</span>' : ''}
          </div>
        </div>`;
    }
    html += '</div>';
  }
  wrap.innerHTML = html || '<p class="hint">No cards match that search.</p>';

  wrap.querySelectorAll('select[data-card]').forEach((s) => {
    s.onchange = () => {
      const n = Number(s.value);
      if (n > 0) deck[s.dataset.card] = n; else delete deck[s.dataset.card];
      renderAll();
    };
  });
}

/* ---------------------------------------------------------------- deck --- */
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

  let html = '';
  for (const cat of CATS) {
    const rows = Object.keys(deck)
      .filter((n) => INDEX[n] && INDEX[n].category === cat)
      .sort();
    if (!rows.length) continue;
    const tot = rows.reduce((a, n) => a + deck[n], 0);
    html += `<div class="dl-cat">${CAT_LABEL[cat]} (${tot})</div>`;
    for (const n of rows) {
      html += `<div class="dl-row"><span>${n}</span>
        <span><span class="n">${deck[n]}</span>
        <button data-rm="${n}" title="Remove">×</button></span></div>`;
    }
  }
  $('decklist').innerHTML = html || '<p class="hint">Deck is empty.</p>';
  $('decklist').querySelectorAll('button[data-rm]').forEach((b) => {
    b.onclick = () => { delete deck[b.dataset.rm]; renderAll(); };
  });
}

function renderAll() { renderGrid(); renderDeck(); }

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
  await new Promise((r) => setTimeout(r, 30));   // let the button repaint

  const games = Number($('games').value);
  const res = runGauntlet(spec, META, { games, seed: 20260803 });

  // calibration probe, same settings, so the number is always in front of you
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
      <div class="d">6–10 is the usual range</div></div>
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

  // aggregate end-of-game reasons, weighted by meta share
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
