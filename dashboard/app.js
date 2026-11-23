// Token Radar — page logic. Renders window.RADAR (written by main.ts into ../data.js) with no
// network: the board, the filters, the per-protocol detail drawer with the full model
// breakdown and farm plan, the category calibration table, and the set-aside live-token list.
// Query parameters preset the view (?q=, ?cat=, ?chain=, ?kind=, ?detail=<slug>, ?sort=).

'use strict';

const R = window.RADAR;
const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Compact dollars: $1.24B, $340M, $12.4K, $900. */
function money(n) {
  if (n === null || n === undefined) return '—';
  const abs = Math.abs(n);
  if (abs >= 1e12) return '$' + trimNum(n / 1e12) + 'T';
  if (abs >= 1e9) return '$' + trimNum(n / 1e9) + 'B';
  if (abs >= 1e6) return '$' + trimNum(n / 1e6) + 'M';
  if (abs >= 1e3) return '$' + trimNum(n / 1e3) + 'K';
  return '$' + Math.round(n).toLocaleString('en-US');
}
function trimNum(x) {
  const s = x.toFixed(2);
  return s.endsWith('00') ? s.slice(0, -3) : s.endsWith('0') ? s.slice(0, -1) : s;
}
/** Full dollars with separators, for the detail drawer. */
function moneyFull(n) {
  return '$' + Math.round(n).toLocaleString('en-US');
}
function pct(v) {
  if (v === null || v === undefined) return '<span class="flat">—</span>';
  const cls = v > 0.05 ? 'up' : v < -0.05 ? 'down' : 'flat';
  const sign = v > 0 ? '+' : '';
  return `<span class="${cls}">${sign}${v.toFixed(1)}%</span>`;
}
function ageLabel(days) {
  if (days === null || days === undefined) return '—';
  if (days < 60) return days + 'd';
  if (days < 730) return Math.round(days / 30.44) + 'mo';
  return (days / 365.25).toFixed(1) + 'y';
}
function mult(x) {
  return '×' + x.toFixed(x >= 10 ? 1 : 3).replace(/0+$/, '').replace(/\.$/, '');
}

/* ---------------- header + stats ---------------- */

$('topbar-meta').innerHTML =
  `<span class="chip">Snapshot <strong>${esc(R.as_of)}</strong></span>` +
  `<span class="chip">Model <strong>${esc(R.model_version.split(' ')[0])}</strong></span>` +
  `<span class="chip">Watchlist floor <strong>${money(R.floor_usd)}</strong></span>`;

const stats = [
  ['Protocols tracked', R.universe_size.toLocaleString('en-US'), 'in the sealed snapshot'],
  ['On the board', R.board_size.toLocaleString('en-US'), `${R.core_size} pre-token core · ${R.product_size} products`],
  ['Watchlist covered', `${R.watchlist_size}/${R.watchlist_size}`, 'every watchlist slug ranked'],
  ['Below the floor', R.early_size.toLocaleString('en-US'), 'early finds under ' + money(R.floor_usd)],
  ['Total implied value', money(R.total_implied_usd), 'sum of the board'],
  ['Median multiple', mult(R.median_multiple), 'market cap per $1 of TVL, live set'],
];
$('stats').innerHTML = stats
  .map(([k, v, s]) => `<div class="stat"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${s}</div></div>`)
  .join('');

/* ---------------- filters ---------------- */

const params = new URLSearchParams(location.search);
const state = {
  q: params.get('q') || '',
  cat: params.get('cat') || '',
  chain: params.get('chain') || '',
  kind: params.get('kind') || '',
  sort: params.get('sort') || 'rank',
  dir: 1,
};

const cats = [...new Set(R.rows.map((r) => r.category ?? 'Other'))].sort();
$('cat').innerHTML =
  '<option value="">All categories</option>' + cats.map((c) => `<option${c === state.cat ? ' selected' : ''}>${esc(c)}</option>`).join('');
const chainSet = new Set();
for (const r of R.rows) for (const c of r.chains) chainSet.add(c);
const chains = [...chainSet].sort();
$('chain').innerHTML =
  '<option value="">All chains</option>' + chains.map((c) => `<option${c === state.chain ? ' selected' : ''}>${esc(c)}</option>`).join('');
$('q').value = state.q;
for (const b of $('kind-seg').querySelectorAll('button')) b.classList.toggle('on', b.dataset.kind === state.kind);

const maxImplied = Math.max(...R.rows.map((r) => r.implied_value_usd));

function visibleRows() {
  const q = state.q.trim().toLowerCase();
  let rows = R.rows.filter((r) => {
    if (state.kind === 'watchlist' && !r.on_watchlist) return false;
    if ((state.kind === 'pre-token' || state.kind === 'product') && r.kind !== state.kind) return false;
    if (state.cat && (r.category ?? 'Other') !== state.cat) return false;
    if (state.chain && !r.chains.includes(state.chain)) return false;
    if (q && !r.name.toLowerCase().includes(q) && !r.slug.toLowerCase().includes(q)) return false;
    return true;
  });
  const key = state.sort;
  const val = (r) =>
    key === 'effective' ? r.model.effective_multiple : key === 'name' ? r.name.toLowerCase() : r[key] ?? (key === 'change_7d' || key === 'age_days' ? -Infinity : 0);
  rows = [...rows].sort((a, b) => {
    const va = val(a);
    const vb = val(b);
    const cmp = typeof va === 'string' ? (va < vb ? -1 : va > vb ? 1 : 0) : va - vb;
    return cmp * state.dir || a.rank - b.rank;
  });
  return rows;
}

function chainChips(list) {
  const shown = list.slice(0, 3).map((c) => `<span>${esc(c)}</span>`).join('');
  const more = list.length > 3 ? `<span>+${list.length - 3}</span>` : '';
  return `<div class="chain-chips">${shown}${more}</div>`;
}

/** Keep the address bar in step with the view, so any filtered board is a shareable link. */
function syncUrl() {
  const p = new URLSearchParams();
  if (state.q) p.set('q', state.q);
  if (state.cat) p.set('cat', state.cat);
  if (state.chain) p.set('chain', state.chain);
  if (state.kind) p.set('kind', state.kind);
  if (state.sort !== 'rank') p.set('sort', state.sort);
  const qs = p.toString();
  history.replaceState(null, '', qs ? '?' + qs : location.pathname);
}

function renderBoard() {
  syncUrl();
  const rows = visibleRows();
  $('count').textContent = `${rows.length} of ${R.board_size} rows`;
  for (const b of document.querySelectorAll('.sort')) {
    const base = b.dataset.sort;
    const label = b.textContent.replace(/[▲▼]/g, '').trim();
    b.innerHTML = esc(label) + (base === state.sort ? `<span class="dir">${state.dir === 1 ? '▲' : '▼'}</span>` : '');
  }
  if (rows.length === 0) {
    $('rows').innerHTML = '<tr class="empty-row"><td colspan="9">No protocol matches these filters.</td></tr>';
    return;
  }
  $('rows').innerHTML = rows
    .map((r) => {
      const star = r.on_watchlist ? '<span class="star" title="On the watchlist">★</span>' : '';
      const prod = r.kind === 'product' ? '<span class="badge product">product</span>' : '';
      const conf = r.model.confidence === 'high' ? '<span class="badge conf-high">high conf.</span>' : r.model.confidence === 'low' ? '<span class="badge conf-low">low conf.</span>' : '';
      const w = Math.max(1.5, (r.implied_value_usd / maxImplied) * 100);
      return (
        `<tr tabindex="0" data-slug="${esc(r.slug)}" class="${r.rank <= 3 ? 'top3' : ''}">` +
        `<td class="num rank">${r.rank}</td>` +
        `<td><span class="pname">${star}${esc(r.name)}</span>${prod}${conf}<div class="pslug">${esc(r.slug)}</div></td>` +
        `<td>${esc(r.category ?? 'Other')}</td>` +
        `<td>${chainChips(r.chains)}</td>` +
        `<td class="num">${money(r.tvl_usd)}</td>` +
        `<td class="num">${pct(r.change_7d)}</td>` +
        `<td class="num">${ageLabel(r.age_days)}</td>` +
        `<td class="num implied-cell"><span class="implied-val">${money(r.implied_value_usd)}</span><div class="implied-bar"><i style="width:${w.toFixed(1)}%"></i></div></td>` +
        `<td class="num">${mult(r.model.effective_multiple)}</td></tr>`
      );
    })
    .join('');
}

$('q').addEventListener('input', (e) => { state.q = e.target.value; renderBoard(); });
$('cat').addEventListener('change', (e) => { state.cat = e.target.value; renderBoard(); });
$('chain').addEventListener('change', (e) => { state.chain = e.target.value; renderBoard(); });
$('kind-seg').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  state.kind = b.dataset.kind;
  for (const x of $('kind-seg').querySelectorAll('button')) x.classList.toggle('on', x === b);
  renderBoard();
});
for (const b of document.querySelectorAll('.sort')) {
  b.addEventListener('click', () => {
    if (state.sort === b.dataset.sort) state.dir *= -1;
    else { state.sort = b.dataset.sort; state.dir = b.dataset.sort === 'rank' || b.dataset.sort === 'name' ? 1 : -1; }
    renderBoard();
  });
}

/* ---------------- detail drawer ---------------- */

const bySlug = new Map(R.rows.map((r) => [r.slug, r]));

function openDetail(slug) {
  const r = bySlug.get(slug);
  if (!r) return;
  const m = r.model;
  const badges =
    (r.on_watchlist ? '<span class="badge" style="color:var(--gold);border-color:rgba(234,179,8,.4)">★ watchlist</span>' : '') +
    `<span class="badge">${r.kind === 'product' ? 'product of a live token' : 'pre-token core'}</span>` +
    `<span class="badge">rank #${r.rank} of ${R.board_size}</span>` +
    `<span class="badge">category percentile ${m.category_percentile}</span>` +
    `<span class="badge">model confidence ${m.confidence}</span>`;
  const breakdown =
    `<table class="breakdown">` +
    `<tr><td>TVL (snapshot)</td><td class="num">${moneyFull(r.tvl_usd)}</td></tr>` +
    `<tr><td>Category multiple<span class="src">${esc(m.multiple_source)}</span></td><td class="num">${mult(m.multiple)}</td></tr>` +
    `<tr><td>Momentum — 7d change ${m.growth_pct === null ? 'unreported (flat)' : (m.growth_pct > 0 ? '+' : '') + m.growth_pct.toFixed(1) + '%'}</td><td class="num">${mult(m.momentum_multiplier)}</td></tr>` +
    `<tr><td>Maturity — ${r.age_days === null ? 'age unreported (270d assumed)' : ageLabel(r.age_days) + ' running with no token'}</td><td class="num">${mult(m.maturity_multiplier)}</td></tr>` +
    `<tr><td>Breadth — ${r.chains.length} chain${r.chains.length === 1 ? '' : 's'}</td><td class="num">${mult(m.breadth_multiplier)}</td></tr>` +
    `<tr class="total"><td>Implied value</td><td class="num">${moneyFull(r.implied_value_usd)}</td></tr></table>`;
  const plan = r.farm_plan
    .map((s) => `<li><p class="p-text">${esc(s.text)}</p><div class="p-meta"><span><b>Cost</b> ${esc(s.cost)}</span><span><b>Time</b> ${esc(s.time)}</span></div></li>`)
    .join('');
  const facts = [
    ['Category', esc(r.category ?? 'Other')],
    ['Chains', esc(r.chains.join(', ') || '—')],
    ['Listed', esc(r.listed_at ?? 'unreported')],
    ['Age at snapshot', r.age_days === null ? '—' : r.age_days.toLocaleString('en-US') + ' days'],
    ['7-day TVL change', r.change_7d === null ? 'unreported' : (r.change_7d > 0 ? '+' : '') + r.change_7d.toFixed(2) + '%'],
    ['Effective multiple', mult(m.effective_multiple) + ' of TVL'],
  ]
    .map(([k, v]) => `<div><div class="k">${k}</div><div class="v">${v}</div></div>`)
    .join('');
  $('drawer-body').innerHTML =
    `<h2>${esc(r.name)}</h2><p class="d-slug">${esc(r.slug)}</p>` +
    `<div class="d-badges">${badges}</div>` +
    `<div class="d-implied"><div class="k">Implied launch value</div><div class="v">${money(r.implied_value_usd)}</div>` +
    `<div class="s">${moneyFull(r.implied_value_usd)} · ${mult(m.effective_multiple)} of TVL · records no token in the snapshot</div></div>` +
    `<h3>Model breakdown</h3>${breakdown}` +
    `<h3>Farm plan — ${r.farm_plan.length} steps</h3><ol class="plan">${plan}</ol>` +
    `<h3>Snapshot facts</h3><div class="d-facts">${facts}</div>`;
  $('overlay').hidden = false;
  $('drawer').hidden = false;
  $('drawer').scrollTop = 0;
}
function closeDetail() {
  $('overlay').hidden = true;
  $('drawer').hidden = true;
}
$('rows').addEventListener('click', (e) => {
  const tr = e.target.closest('tr[data-slug]');
  if (tr) openDetail(tr.dataset.slug);
});
$('rows').addEventListener('keydown', (e) => {
  const tr = e.target.closest('tr[data-slug]');
  if (tr && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openDetail(tr.dataset.slug); }
});
$('overlay').addEventListener('click', closeDetail);
$('drawer-close').addEventListener('click', closeDetail);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDetail(); });

/* ---------------- calibration + live + footer ---------------- */

$('cal-rows').innerHTML = R.calibration.categories
  .map(
    (c) =>
      `<tr><td>${esc(c.category)}</td><td class="num">${c.live_count}</td><td class="num">${mult(c.median_multiple)}</td><td class="num">${mult(c.shrunk_multiple)}</td></tr>`,
  )
  .join('');
$('method-note').textContent =
  `Calibrated on ${R.calibration.live_count} live-token protocols in this snapshot (CEX excluded). ` +
  `Snapshot-wide median ${mult(R.calibration.overall_multiple)} of TVL. Categories with no live sample use the snapshot-wide median. ` +
  `${R.cex_size} CEX records are set aside entirely. “Records no token” is the snapshot's record, not proof a token does not exist.`;

$('live-rows').innerHTML = R.live
  .map(
    (r) =>
      `<tr><td><span class="pname">${esc(r.name)}</span><div class="pslug">${esc(r.slug)}</div></td>` +
      `<td>${esc(r.category ?? 'Other')}</td><td class="num">${money(r.mcap_usd)}</td><td class="num">${money(r.tvl_usd)}</td><td class="num">${pct(r.change_7d)}</td></tr>`,
  )
  .join('');

$('foot').textContent =
  `Source: ${R.source} · Snapshot as of ${R.as_of} · Model ${R.model_version}. ` +
  `Implied values are this radar's own claim, computed from the snapshot's figures — not a prediction that a token will be issued.`;

renderBoard();
const detailSlug = params.get('detail');
if (detailSlug) openDetail(detailSlug);
