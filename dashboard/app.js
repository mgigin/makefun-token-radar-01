// Token Radar dashboard. Reads window.RADAR (written beside dashboard/ by main.ts from the same
// board board.json carries) and renders: the ranked pre-token board, filters, a per-protocol
// detail view with the model's own factors and the farm plan, the set-aside already-trading
// protocols, and the calibration the multiples came from. No network: every byte is in data.js.
(function () {
  'use strict';

  var DATA = window.RADAR;
  if (!DATA) return;
  var app = document.getElementById('board');
  var state = { q: '', category: 'all', chain: 'all', minTvl: 0, tab: 'pre-token', sort: 'implied', dir: -1, selected: null };

  /* ---------- formatting ---------- */
  function fmtUsd(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return '$' + Math.round(n);
  }
  function fmtPct(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
  }
  function fmtAge(days) {
    if (days === null || days === undefined) return 'unknown';
    if (days >= 365) return (days / 365).toFixed(1) + 'y';
    return Math.max(0, Math.round(days)) + 'd';
  }
  function fmtMult(n) { return 'x' + Number(n).toFixed(3).replace(/0+$/, '').replace(/\.$/, '.0'); }

  /* The model, recomputed in the page from the row's own factors: if this number ever disagrees
     with the board's, the data is stale. Same arithmetic as lib/model.ts scoreProtocol. */
  function impliedOf(row) {
    var m = row.model;
    return Math.max(1, Math.round(row.tvl_usd * m.multiple * m.growth_multiplier * m.maturity_multiplier * m.breadth_multiplier));
  }

  /* ---------- tiny DOM helper ---------- */
  function el(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === 'class') node.className = attrs[k];
        else if (k === 'text') node.textContent = attrs[k];
        else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), attrs[k]);
        else if (attrs[k] !== null && attrs[k] !== undefined) node.setAttribute(k, attrs[k]);
      });
    }
    for (var i = 2; i < arguments.length; i++) {
      var child = arguments[i];
      if (child === null || child === undefined) continue;
      if (Array.isArray(child)) child.forEach(function (c) { if (c) node.appendChild(c); });
      else if (typeof child === 'string') node.appendChild(document.createTextNode(child));
      else node.appendChild(child);
    }
    return node;
  }

  /* ---------- hash state (shareable views, and how the screenshots were taken) ---------- */
  function readHash() {
    var hash = window.location.hash.replace(/^#/, '');
    if (!hash) return;
    var params = new URLSearchParams(hash);
    if (params.get('q')) state.q = params.get('q');
    if (params.get('category')) state.category = params.get('category');
    if (params.get('chain')) state.chain = params.get('chain');
    if (params.get('tab')) state.tab = params.get('tab');
    if (params.get('p')) state.selected = params.get('p');
  }
  function writeHash() {
    var params = new URLSearchParams();
    if (state.q) params.set('q', state.q);
    if (state.category !== 'all') params.set('category', state.category);
    if (state.chain !== 'all') params.set('chain', state.chain);
    if (state.tab !== 'pre-token') params.set('tab', state.tab);
    if (state.selected) params.set('p', state.selected);
    var next = params.toString();
    if (next) window.history.replaceState(null, '', '#' + next);
    else window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }

  /* ---------- filtering & sorting ---------- */
  function visibleRows() {
    var q = state.q.trim().toLowerCase();
    return DATA.rows.filter(function (r) {
      if (state.category !== 'all' && (r.category || 'Other') !== state.category) return false;
      if (state.chain !== 'all' && (r.chains || []).indexOf(state.chain) < 0) return false;
      if (r.tvl_usd < state.minTvl) return false;
      if (!q) return true;
      var hay = [r.name, r.slug, r.category || '', (r.chains || []).join(' ')].join(' ').toLowerCase();
      return hay.indexOf(q) >= 0;
    });
  }
  function sortedRows(list) {
    var key = state.sort;
    function value(r) {
      if (key === 'name') return r.name.toLowerCase();
      if (key === 'tvl') return r.tvl_usd;
      if (key === 'growth') return r.change_7d === null ? -Infinity : r.change_7d;
      if (key === 'age') return r.age_days === null ? Infinity : r.age_days;
      if (key === 'ratio') return r.tvl_usd > 0 ? r.implied_value_usd / r.tvl_usd : 0;
      return r.implied_value_usd;
    }
    return list.slice().sort(function (a, b) {
      var av = value(a), bv = value(b);
      if (av < bv) return -state.dir;
      if (av > bv) return state.dir;
      return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
    });
  }

  /* ---------- sections ---------- */
  function header() {
    return el('header', { class: 'top' },
      el('div', { class: 'brand' }, el('span', { class: 'mark', 'aria-hidden': 'true' }),
        el('span', { class: 'brand-name' }, 'TOKEN ', el('em', { text: 'RADAR' }))),
      el('div', { class: 'top-meta' },
        el('span', null, 'snapshot ', el('b', { text: DATA.as_of })),
        el('span', null, 'source ', el('b', { text: 'DefiLlama protocol index' })),
        el('span', null, 'model ', el('b', { text: DATA.model_version }))
      )
    );
  }

  function lede() {
    return el('section', { class: 'lede' },
      el('div', null,
        el('h1', null, 'Protocols with ', el('span', { class: 'hl', text: 'no token yet' }), ', ranked by what a launch would be worth'),
        el('p', { text: 'The watchlist is the floor: every protocol with at least $' + Math.round(DATA.floor_usd / 1e6) + 'M of TVL that records no token and is not a wrapped or staked product of one that trades. The radar ranks all ' + DATA.board_size + ' of them — the ' + DATA.watchlist_size + ' on the watchlist and ' + DATA.early_size + ' earlier ones below the floor.' }),
        el('p', { text: 'Implied value is calibrated from this snapshot itself: each category is priced at the median market-cap-to-TVL ratio of its live-token peers, then adjusted for seven-day growth, age with no token, and chain breadth. It is the radar\u2019s own claim, not a price and not a promise.' })
      ),
      el('div', { class: 'facts' },
        el('div', { class: 'fact' }, el('span', { text: 'Watchlist covered' }), el('b', null, DATA.watchlist_size + ' / ' + DATA.watchlist_size)),
        el('div', { class: 'fact' }, el('span', { text: 'Pre-token rows ranked' }), el('b', null, String(DATA.board_size))),
        el('div', { class: 'fact' }, el('span', { text: 'Total implied value' }), el('b', null, fmtUsd(DATA.total_implied_usd))),
        el('div', { class: 'fact' }, el('span', { text: 'Already trading, set aside' }), el('b', null, String(DATA.live_size + DATA.product_size), el('small', { text: ' (' + DATA.live_size + ' live, ' + DATA.product_size + ' products)' })))
      )
    );
  }

  function topBy(fn) {
    var best = null;
    DATA.rows.forEach(function (r) { if (best === null || fn(r) > fn(best)) best = r; });
    return best;
  }
  function movers() {
    var gainer = topBy(function (r) { return r.change_7d === null ? -Infinity : r.change_7d; });
    var ratio = topBy(function (r) { return r.tvl_usd > 0 ? r.implied_value_usd / r.tvl_usd : 0; });
    var youngest = null;
    DATA.rows.forEach(function (r) {
      if (r.age_days !== null && r.tvl_usd >= 25000000 && (youngest === null || r.age_days < youngest.age_days)) youngest = r;
    });
    function card(tag, row, why) {
      if (!row) return null;
      return el('button', { class: 'mover', type: 'button', onclick: function () { openDetail(row.slug); } },
        el('span', { class: 'tag', text: tag }),
        el('span', { class: 'who', text: row.name }),
        el('span', { class: 'why', text: why(row) }));
    }
    return el('div', { class: 'movers' },
      card('Fastest 7-day growth', gainer, function (r) { return fmtPct(r.change_7d) + ' in 7d \u00b7 TVL ' + fmtUsd(r.tvl_usd); }),
      card('Highest implied / TVL', ratio, function (r) { return fmtUsd(r.implied_value_usd) + ' implied on ' + fmtUsd(r.tvl_usd) + ' TVL'; }),
      card('Youngest above $25M TVL', youngest, function (r) { return fmtAge(r.age_days) + ' old \u00b7 TVL ' + fmtUsd(r.tvl_usd) + ' \u00b7 rank ' + r.rank; })
    );
  }

  function controls() {
    var categories = Array.from(new Set(DATA.rows.map(function (r) { return r.category || 'Other'; }))).sort();
    var chains = Array.from(new Set(DATA.rows.flatMap(function (r) { return r.chains || []; }))).sort();
    var search = el('input', { type: 'search', id: 'q', placeholder: 'Search name, slug or chain', value: state.q, 'aria-label': 'Search the board' });
    search.addEventListener('input', function () { state.q = search.value; writeHash(); render(); });
    var catSelect = el('select', { id: 'category', 'aria-label': 'Filter by category' },
      el('option', { value: 'all', text: 'All categories' }),
      categories.map(function (c) { return el('option', { value: c, text: c, selected: c === state.category ? 'selected' : null }); }));
    catSelect.addEventListener('change', function () { state.category = catSelect.value; writeHash(); render(); });
    var chainSelect = el('select', { id: 'chain', 'aria-label': 'Filter by chain' },
      el('option', { value: 'all', text: 'All chains' }),
      chains.map(function (c) { return el('option', { value: c, text: c, selected: c === state.chain ? 'selected' : null }); }));
    chainSelect.addEventListener('change', function () { state.chain = chainSelect.value; writeHash(); render(); });
    var tvlLabel = el('span', { class: 'range-val', text: state.minTvl > 0 ? 'TVL \u2265 ' + fmtUsd(state.minTvl) : 'any TVL' });
    var tvlRange = el('input', { type: 'range', id: 'mintvl', min: '0', max: '8', step: '1', value: String(Math.round(Math.log10(Math.max(state.minTvl, 1)))), 'aria-label': 'Minimum TVL' });
    tvlRange.addEventListener('input', function () {
      var v = Number(tvlRange.value);
      state.minTvl = v === 0 ? 0 : Math.pow(10, v + 4);
      tvlLabel.textContent = state.minTvl > 0 ? 'TVL \u2265 ' + fmtUsd(state.minTvl) : 'any TVL';
      render();
    });
    var pre = el('button', { type: 'button', 'aria-pressed': state.tab === 'pre-token' ? 'true' : 'false', text: 'Pre-token board', onclick: function () { state.tab = 'pre-token'; writeHash(); render(); } });
    var live = el('button', { type: 'button', 'aria-pressed': state.tab === 'live' ? 'true' : 'false', text: 'Already trades', onclick: function () { state.tab = 'live'; writeHash(); render(); } });
    return el('div', { class: 'controls' },
      el('div', { class: 'field' }, el('label', { for: 'q', text: 'Search' }), search),
      el('div', { class: 'field' }, el('label', { for: 'category', text: 'Category' }), catSelect),
      el('div', { class: 'field' }, el('label', { for: 'chain', text: 'Chain' }), chainSelect),
      el('div', { class: 'field' }, el('label', { for: 'mintvl', text: 'Min TVL' }), tvlRange, tvlLabel),
      el('div', { class: 'field' }, el('span', { class: 'sub', text: 'Token status' }), el('div', { class: 'tabs' }, pre, live)),
      el('span', { class: 'count', text: state.tab === 'pre-token' ? visibleRows().length + ' of ' + DATA.board_size + ' rows' : DATA.live.length + ' set-aside protocols' })
    );
  }

  function sortHeader(key, label) {
    return el('th', { scope: 'col' },
      el('button', { type: 'button', onclick: function () { if (state.sort === key) state.dir = -state.dir; else { state.sort = key; state.dir = -1; } render(); } },
        label, state.sort === key ? el('span', { 'aria-hidden': 'true', text: state.dir < 0 ? ' \u25bc' : ' \u25b2' }) : null));
  }

  function boardTable() {
    var list = sortedRows(visibleRows());
    if (list.length === 0) {
      return el('div', { class: 'panel' }, el('div', { class: 'empty' },
        el('h2', { text: 'No protocol matches those filters' }),
        el('p', { text: 'Clear the search, the category or the TVL floor to see the board again.' }),
        el('button', { class: 'button primary', type: 'button', text: 'Clear filters', onclick: function () { state.q = ''; state.category = 'all'; state.chain = 'all'; state.minTvl = 0; writeHash(); render(); } })));
    }
    var max = DATA.rows[0].implied_value_usd || 1;
    var tbody = el('tbody');
    list.forEach(function (r) {
      var growthClass = r.change_7d === null ? '' : r.change_7d >= 0 ? 'pos' : 'neg';
      var tr = el('tr', {
        'data-selected': state.selected === r.slug ? 'true' : 'false',
        tabindex: '0',
        onclick: function () { openDetail(r.slug); },
        onkeydown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(r.slug); } }
      },
        el('td', { class: 'rank-cell' + (r.rank <= 3 ? ' top' : ''), text: String(r.rank) }),
        el('td', null, el('div', { class: 'name' },
          el('b', null, r.name, r.on_watchlist ? el('span', { class: 'wl-badge', text: 'WATCHLIST' }) : null),
          el('span', { class: 'sub', text: (r.category || 'Other') + ' \u00b7 ' + (r.chains && r.chains.length ? r.chains.slice(0, 3).join(', ') + (r.chains.length > 3 ? ' +' + (r.chains.length - 3) : '') : 'chain not recorded') }))),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num ' + growthClass, text: fmtPct(r.change_7d) }),
        el('td', { class: 'num', text: fmtAge(r.age_days) }),
        el('td', null, el('div', { class: 'implied' },
          el('div', { class: 'bar', 'aria-hidden': 'true' }, el('i', { style: 'width:' + Math.max(2, Math.round((r.implied_value_usd / max) * 100)) + '%' })),
          el('span', { class: 'num', text: fmtUsd(r.implied_value_usd) }))),
        el('td', null, el('span', { class: 'status', text: 'no token on record' })));
      tbody.appendChild(tr);
    });
    return el('div', { class: 'panel' }, el('div', { class: 'table-wrap' },
      el('table', null,
        el('caption', { text: 'Pre-token protocols, strongest implied value first. Select a row for its model breakdown and farm plan.' }),
        el('thead', null, el('tr', null,
          sortHeader('implied', 'Rank'), sortHeader('name', 'Protocol'), sortHeader('tvl', 'TVL'),
          sortHeader('growth', '7d'), sortHeader('age', 'Age'), sortHeader('implied', 'Implied value'),
          el('th', { scope: 'col', text: 'Token' }))),
        tbody)));
  }

  function liveTable() {
    var tbody = el('tbody');
    DATA.live.forEach(function (r) {
      var isLive = r.kind === 'live-token';
      tbody.appendChild(el('tr', null,
        el('td', { class: 'rank-cell', text: isLive ? 'live' : 'product' }),
        el('td', null, el('div', { class: 'name' }, el('b', { text: r.name }),
          el('span', { class: 'sub', text: (r.category || 'Other') + ' \u00b7 ' + (r.chains && r.chains.length ? r.chains.slice(0, 3).join(', ') : 'chain not recorded') }))),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num ' + (r.change_7d !== null && r.change_7d >= 0 ? 'pos' : 'neg'), text: fmtPct(r.change_7d) }),
        el('td', { class: 'num', text: fmtUsd(r.mcap_usd) }),
        el('td', null, el('span', { class: 'status ' + (isLive ? 'live' : 'product'), text: isLive ? 'already trades' : 'wrapped / staked product' }))));
    });
    return el('div', { class: 'panel' }, el('div', { class: 'table-wrap' },
      el('table', null,
        el('caption', { text: 'Set aside from the ranking: tokens that already trade (market cap is a fact, not a model) and wrapped or staked products of tokens that do.' }),
        el('thead', null, el('tr', null,
          el('th', { scope: 'col', text: 'Status' }), el('th', { scope: 'col', text: 'Protocol' }),
          el('th', { scope: 'col', text: 'TVL' }), el('th', { scope: 'col', text: '7d' }),
          el('th', { scope: 'col', text: 'Market cap' }), el('th', { scope: 'col', text: 'Token' }))),
        tbody)));
  }

  function modelPanel() {
    var m = DATA.model;
    var cal = DATA.calibration;
    var cells = Object.keys(cal.by_category).sort().map(function (c) {
      var hit = cal.by_category[c];
      return el('div', { class: 'cal-cell' },
        el('span', { text: c }), el('b', { text: fmtMult(hit.multiple) }),
        el('small', { text: ' median of ' + hit.live_count + ' live' }));
    });
    return el('section', { class: 'panel model' },
      el('h2', { text: 'How implied value is computed' }),
      el('p', { text: 'One function scores every row from the snapshot\u2019s own figures; no protocol name is special-cased and no row is hand-picked. The base multiple is not a guess: it is the median market-cap-to-TVL ratio of the live-token protocols in the same category in this snapshot, so the board prices a future token the way the market already prices its peers.' }),
      el('div', { class: 'formula', text: 'implied = tvl_usd \u00d7 category_multiple \u00d7 (1 + clamp(change_7d, ' + m.growth_floor + ', ' + m.growth_cap + ') / 100 \u00d7 ' + m.growth_weight + ') \u00d7 (' + m.maturity_floor + ' + min(age_days, ' + m.maturity_days + ') / ' + m.maturity_days + ' \u00d7 ' + m.maturity_range + ') \u00d7 (1 + ' + m.breadth_per_chain + ' \u00d7 min(chains \u2212 1, ' + m.breadth_max_extra_chains + '))' }),
      el('p', { text: 'Age is the time since DefiLlama first listed the protocol \u2014 the best record of how long it has run with no token (an unrecorded age counts as ' + m.unknown_age_days + ' days). Categories with fewer than ' + m.min_live_for_category + ' live protocols use the snapshot-wide median, ' + fmtMult(cal.overall_multiple) + ' across ' + cal.live_count + ' live protocols. Wrapped, staked and bridged products of tokens that already trade are set aside, not ranked.' }),
      el('div', { class: 'cal-grid' }, cells));
  }

  function footer() {
    return el('footer', { class: 'foot' },
      el('p', { text: 'Source: ' + DATA.source + '. \u201cRecords no token\u201d is DefiLlama\u2019s record, not proof: a protocol may have a token its record does not carry. Implied value is this radar\u2019s own claim about what a token would be worth if the protocol\u2019s record stayed as it is; it does not predict whether or when a token is issued, and farming always risks the capital in the position.' }),
      el('p', { text: 'Built for make.fun\u2019s token launch radar bounty. Farm plans are derived from each protocol\u2019s category, chains, TVL and age; always verify contract addresses from the protocol\u2019s own site before depositing.' }));
  }

  /* ---------- detail dialog ---------- */
  var dialog = el('dialog', { class: 'detail', id: 'detail', 'aria-labelledby': 'detail-title' });
  dialog.addEventListener('close', function () { state.selected = null; writeHash(); render(); });

  function whyLine(row) {
    var bits = [];
    bits.push('ranked #' + row.rank + ' of ' + DATA.board_size);
    if (row.on_watchlist) bits.push('on the house watchlist');
    else bits.push('an early find below the $' + Math.round(DATA.floor_usd / 1e6) + 'M floor');
    bits.push(fmtUsd(row.tvl_usd) + ' of TVL');
    if (row.change_7d !== null) bits.push(fmtPct(row.change_7d) + ' over 7 days');
    if (row.age_days !== null) bits.push(fmtAge(row.age_days) + ' with no token on record');
    if (row.chains && row.chains.length > 1) bits.push('live on ' + row.chains.length + ' chains');
    return 'Why it ranks here: ' + bits.join(', ') + '.';
  }

  function openDetail(slug) {
    var row = DATA.rows.filter(function (r) { return r.slug === slug; })[0];
    if (!row) return;
    state.selected = slug;
    writeHash();
    dialog.textContent = '';
    var check = impliedOf(row);
    dialog.appendChild(el('div', { class: 'detail-head' },
      el('div', null,
        el('span', { class: 'rankline', text: 'RANK ' + row.rank + ' OF ' + DATA.board_size + (row.on_watchlist ? ' \u00b7 WATCHLIST' : ' \u00b7 EARLY RADAR') }),
        el('h2', { id: 'detail-title', text: row.name }),
        el('p', { class: 'sub', text: (row.category || 'Other') + ' \u00b7 ' + (row.chains && row.chains.length ? row.chains.join(', ') : 'chain not recorded') + ' \u00b7 records no token' })),
      el('button', { class: 'close', type: 'button', 'aria-label': 'Close details', text: 'Close', onclick: function () { dialog.close(); } })));
    dialog.appendChild(el('section', { class: 'detail-section' },
      el('h3', { text: 'Implied value \u2014 the model\u2019s own factors' }),
      el('div', { class: 'equation' },
        el('div', null, el('span', { text: 'TVL' }), el('b', { text: fmtUsd(row.tvl_usd) })),
        el('div', null, el('span', { text: 'Category multiple' }), el('b', { text: fmtMult(row.model.multiple) })),
        el('div', null, el('span', { text: 'Growth (7d)' }), el('b', { text: fmtPct(row.change_7d) + ' \u2192 ' + fmtMult(row.model.growth_multiplier) })),
        el('div', null, el('span', { text: 'Age, no token' }), el('b', { text: fmtAge(row.age_days) + ' \u2192 ' + fmtMult(row.model.maturity_multiplier) })),
        el('div', null, el('span', { text: 'Chain breadth' }), el('b', { text: (row.chains ? row.chains.length : 0) + ' chains \u2192 ' + fmtMult(row.model.breadth_multiplier) })),
        el('div', { class: 'hero' }, el('span', { text: 'Implied value' }), el('b', { text: fmtUsd(row.implied_value_usd) }))),
      el('p', { class: 'why', text: whyLine(row) + ' The multiple is the ' + row.model.multiple_source + '. The page recomputes this row from those factors as ' + fmtUsd(check) + (Math.abs(check - row.implied_value_usd) <= Math.max(2, row.implied_value_usd * 0.005) ? ', the same number board.json carries (factors shown rounded).' : ', which differs from the board \u2014 the data would be stale.') + ' An estimate, not a price.' })));
    dialog.appendChild(el('section', { class: 'detail-section' },
      el('h3', { text: 'Farm plan \u2014 ' + row.farm_steps.length + ' steps, with cost and time' }),
      el('ol', { class: 'steps' }, row.farm_steps.map(function (s) {
        var at = s.indexOf(' Cost: ');
        var action = at >= 0 ? s.slice(0, at) : s;
        var tail = at >= 0 ? s.slice(at + 1) : '';
        return el('li', null, el('b', { text: action }), el('span', { class: 'cost', text: tail }));
      }))));
    if (typeof dialog.showModal === 'function') { if (!dialog.open) dialog.showModal(); }
    else dialog.setAttribute('open', '');
  }

  /* ---------- render ---------- */
  function render() {
    app.textContent = '';
    var shell = el('div', { class: 'shell' });
    shell.appendChild(header());
    shell.appendChild(lede());
    if (state.tab === 'pre-token') shell.appendChild(movers());
    shell.appendChild(controls());
    shell.appendChild(state.tab === 'pre-token' ? boardTable() : liveTable());
    if (state.tab === 'pre-token') shell.appendChild(modelPanel());
    shell.appendChild(footer());
    app.appendChild(shell);
    app.setAttribute('aria-busy', 'false');
    if (!dialog.isConnected) app.appendChild(dialog);
    if (state.selected && !dialog.open) openDetail(state.selected);
  }

  readHash();
  render();
  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && dialog.open) dialog.close();
  });
})();
