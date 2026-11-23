// Token Radar — page logic. Renders window.RADAR (written by main.ts into ../data.js) with no
// network: the board (opening on the pre-token core), the filters, the per-protocol detail
// drawer with the full fitted breakdown and farm plan, the blind-validation tables, the fitted
// category calibration, the gate checks panel, and the set-aside live-token list.
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
function num2(x) {
  return x.toFixed(2);
}

/* ---------------- header + stats ---------------- */

$('topbar-meta').innerHTML =
  `<span class="chip">Snapshot <strong>${esc(R.as_of)}</strong></span>` +
  `<span class="chip">Model <strong>${esc(R.model_version.split(' ')[0])}</strong></span>` +
  `<span class="chip">Fitted on <strong>${R.fit.live_count} live protocols</strong></span>`;

const cvBest = R.validation.cv[0];
const stats = [
  ['Protocols scanned', R.universe_size.toLocaleString('en-US'), 'in the sealed snapshot'],
  ['Pre-token TVL', money(R.core_tvl_usd), 'across the pre-token core'],
  ['Pre-token ranked', R.core_size.toLocaleString('en-US'), `+${R.product_size} products behind the toggle`],
  ['Live comps in fit', R.fit.live_count.toLocaleString('en-US'), 'live-token protocols fitted'],
  ['FARM verdicts', R.farm_count.toLocaleString('en-US'), `of ${R.board_size} rows pass the farm bar`],
  ['Blind CV error', num2(cvBest.median_abs_log_error), 'median |log error|, 5-fold'],
];
$('stats').innerHTML = stats
  .map(([k, v, s]) => `<div class="stat"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${s}</div></div>`)
  .join('');

/* ---------------- comps scatter ---------------- */

/**
 * The comps fit as a log-log scatter: every live-token protocol the curve was fitted on
 * (R.fit_points, [TVL, market cap] in dollars) with the fitted curve drawn through them at
 * the one-year reference age the breakdown uses, growth flat, no category offset. Inline SVG
 * built from data.js — no network, no library.
 */
function renderScatter() {
  const pts = R.fit_points;
  if (!pts || pts.length === 0) return;
  const W = 640, H = 280, L = 58, Rm = 14, T = 12, B = 40;
  const xs = pts.map((p) => Math.log10(p[0]));
  const ys = pts.map((p) => Math.log10(p[1]));
  const x0 = Math.floor(Math.min(...xs)), x1 = Math.ceil(Math.max(...xs));
  const y0 = Math.floor(Math.min(...ys)), y1 = Math.ceil(Math.max(...ys));
  const px = (v) => (L + ((v - x0) / (x1 - x0)) * (W - L - Rm)).toFixed(1);
  const py = (v) => (H - B - ((v - y0) / (y1 - y0)) * (H - T - B)).toFixed(1);
  const tick = (e) => (e >= 9 ? '$' + Math.pow(10, e - 9) + 'B' : e >= 6 ? '$' + Math.pow(10, e - 6) + 'M' : '$' + Math.pow(10, e - 3) + 'K');
  let grid = '';
  for (let e = x0; e <= x1; e++) {
    grid += `<line x1="${px(e)}" y1="${T}" x2="${px(e)}" y2="${H - B}" class="sc-grid"/><text x="${px(e)}" y="${H - B + 16}" class="sc-tick" text-anchor="middle">${tick(e)}</text>`;
  }
  for (let e = y0; e <= y1; e++) {
    grid += `<line x1="${L}" y1="${py(e)}" x2="${W - Rm}" y2="${py(e)}" class="sc-grid"/><text x="${L - 6}" y="${(+py(e) + 3).toFixed(1)}" class="sc-tick" text-anchor="end">${tick(e)}</text>`;
  }
  // The fitted curve at the one-year reference age, growth flat: ln(mcap) = a + b·ln(TVL) + c·ln(366).
  const b = R.fit.beta;
  const cRef = b[0] + b[2] * Math.log(366);
  let curve = '';
  const steps = 48;
  for (let i = 0; i <= steps; i++) {
    const lx = x0 + ((x1 - x0) * i) / steps;
    const ly = (cRef + b[1] * lx * Math.LN10) / Math.LN10;
    curve += `${i === 0 ? 'M' : 'L'}${px(lx)},${py(ly)} `;
  }
  const dots = pts.map((p) => `<circle cx="${px(Math.log10(p[0]))}" cy="${py(Math.log10(p[1]))}" r="2.3" class="sc-dot"/>`).join('');
  $('scatter').innerHTML =
    `<svg viewBox="0 0 ${W} ${H}" class="scatter-svg" aria-hidden="true">${grid}` +
    `<path d="${curve}" class="sc-curve" fill="none"/>${dots}` +
    `<text x="${((W + L) / 2).toFixed(0)}" y="${H - 6}" class="sc-axis" text-anchor="middle">TVL (log)</text>` +
    `<text x="14" y="${(H / 2).toFixed(0)}" class="sc-axis" text-anchor="middle" transform="rotate(-90 14 ${(H / 2).toFixed(0)})">Market cap (log)</text></svg>`;
  $('scatter-note').textContent =
    `Each dot is one of the ${pts.length} live-token protocols the curve was fitted on; the line is the fitted comps curve ` +
    `(slope b = ${num2(b[1])}) at a one-year reference age. A board row's implied value is this curve read at its own TVL, ` +
    `then moved by its age, growth and category terms — the spread around the line is why the blind tests above matter.`;
}
renderScatter();

/* ---------------- filters ---------------- */

const params = new URLSearchParams(location.search);
const state = {
  q: params.get('q') || '',
  cat: params.get('cat') || '',
  chain: params.get('chain') || '',
  // The board opens on the pre-token core: products of live tokens never take the default top ranks.
  kind: params.has('kind') ? params.get('kind') : 'pre-token',
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
  if (state.kind !== 'pre-token') p.set('kind', state.kind);
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
    $('rows').innerHTML = '<tr class="empty-row"><td colspan="10">No protocol matches these filters.</td></tr>';
    return;
  }
  $('rows').innerHTML = rows
    .map((r) => {
      const star = r.on_watchlist ? '<span class="star" title="On the watchlist">★</span>' : '';
      const prod = r.kind === 'product' ? '<span class="badge product">product</span>' : '';
      const conf = r.model.confidence === 'high' ? '<span class="badge conf-high">high conf.</span>' : r.model.confidence === 'low' ? '<span class="badge conf-low">low conf.</span>' : '';
      const pill = `<span class="pill pill-${r.verdict.toLowerCase()}">${r.verdict}</span>`;
      const w = Math.max(1.5, (r.implied_value_usd / maxImplied) * 100);
      return (
        `<tr tabindex="0" data-slug="${esc(r.slug)}" class="${r.rank <= 3 ? 'top3' : ''}">` +
        `<td class="num rank">${r.rank}</td>` +
        `<td><span class="pname">${star}${esc(r.name)}</span>${prod}${conf}<div class="pslug">${esc(r.slug)}</div></td>` +
        `<td>${pill}</td>` +
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
    `<span class="pill pill-${r.verdict.toLowerCase()}">${r.verdict}</span>` +
    `<span class="badge">rank #${r.rank} of ${R.board_size}</span>` +
    `<span class="badge">category percentile ${m.category_percentile}</span>` +
    `<span class="badge">model confidence ${m.confidence}</span>`;
  const breakdown =
    `<table class="breakdown">` +
    `<tr><td>Comps-curve value at this TVL<span class="src">fitted curve for a one-year-old protocol, before age / growth / category terms</span></td><td class="num">${moneyFull(m.curve_value_usd)}</td></tr>` +
    `<tr><td>Age factor — ${r.age_days === null ? 'age unreported (270d assumed)' : ageLabel(r.age_days) + ' running with no token'}<span class="src">fitted coefficient on ln(1+age), centred on one year</span></td><td class="num">${mult(m.age_factor)}</td></tr>` +
    `<tr><td>Growth factor — 7d change ${m.growth_pct === null ? 'unreported (flat)' : (m.growth_pct > 0 ? '+' : '') + m.growth_pct.toFixed(1) + '%'}<span class="src">fitted coefficient on tanh(change/75), ridge-shrunk</span></td><td class="num">${mult(m.growth_factor)}</td></tr>` +
    `<tr><td>Category factor — ${esc(r.category ?? 'Other')}<span class="src">shrunk fitted offset from ${m.category_live_count} live protocol${m.category_live_count === 1 ? '' : 's'}</span></td><td class="num">${mult(m.category_factor)}</td></tr>` +
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
    `<h3>Fitted breakdown</h3>${breakdown}` +
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

/* ---------------- methodology, validation, checks, live, footer ---------------- */

const cf = R.validation.coefficients;
$('formula-fit').innerHTML =
  `Fitted on this snapshot: <strong>a = ${num2(cf.intercept)}</strong>, <strong>b = ${num2(cf.log_tvl)}</strong>, ` +
  `<strong>c = ${num2(cf.log_age)}</strong>, <strong>d = ${num2(cf.growth_tanh)}</strong> — computed at run time from ${R.validation.live_count} live-token protocols, never typed in.`;

function valRow(test, m, best) {
  // Short display labels; the full model names stay in the data.
  const label = m.model.replace('radar-4 fitted curve', 'radar-4 fitted').replace('baseline: shrunk category median', 'shrunk median').replace('baseline: TVL-only curve', 'TVL-only');
  return (
    `<tr class="${best ? 'best' : ''}"><td>${esc(test)}</td><td>${esc(label)}</td>` +
    `<td class="num">${num2(m.median_abs_log_error)}</td><td class="num">${m.within_2x_pct.toFixed(0)}%</td><td class="num">${num2(m.spearman)}</td></tr>`
  );
}
const cvLines = R.validation.cv;
const wfLines = R.validation.walk_forward.lines;
const bestCv = Math.min(...cvLines.map((m) => m.median_abs_log_error));
const bestWf = Math.min(...wfLines.map((m) => m.median_abs_log_error));
$('val-rows').innerHTML =
  cvLines.map((m) => valRow(`${R.validation.cv_folds}-fold CV`, m, m.median_abs_log_error === bestCv)).join('') +
  wfLines.map((m) => valRow('Walk-forward', m, m.median_abs_log_error === bestWf)).join('');
$('val-note').textContent =
  `Walk-forward fits on the ${R.validation.walk_forward.train_count} earliest-listed live protocols and scores the ${R.validation.walk_forward.test_count} later ones blind. ` +
  `“Records no token” is the snapshot's record, not proof a token does not exist.`;

$('cal-rows').innerHTML = R.fit.categories
  .map(
    (c) =>
      `<tr><td>${esc(c.category)}</td><td class="num">${c.live_count}</td><td class="num">${c.offset >= 0 ? '+' : ''}${num2(c.offset)}</td><td class="num">${mult(c.multiple_at_100m)}</td></tr>`,
  )
  .join('');
$('method-note').textContent =
  `Offsets are mean log residuals shrunk by n/(n+12); the multiple column is the fitted curve's implied value per $1 of TVL at $100M TVL, before the age and growth terms. ` +
  `Categories with no live sample get offset 0. ${R.cex_size} CEX records are set aside entirely.`;

const verdictCounts = { FARM: 0, THIN: 0, SKIP: 0 };
for (const r of R.rows) verdictCounts[r.verdict]++;
$('verdict-note').textContent =
  `On this snapshot the bars land on ${verdictCounts.FARM} FARM, ${verdictCounts.THIN} THIN and ${verdictCounts.SKIP} SKIP of ${R.board_size} rows — ` +
  `counted from the same verdicts the pills show, computed at run time. The verdict is a triage label over the model's own figures, ` +
  `not a second model: rank still comes from implied value alone.`;

$('check-rows').innerHTML = R.checks
  .map((c) => `<tr><td>${esc(c.check)}</td><td>${esc(c.answer)}</td><td class="num"><span class="${c.pass ? 'pass' : 'fail'}">${c.pass ? 'pass' : 'fail'}</span></td></tr>`)
  .join('');

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
