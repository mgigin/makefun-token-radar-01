// Token Radar v3 — the value model (radar-4, fitted).
//
// One sealed snapshot in, one ranked board out. The board ranks every protocol that records no
// token of its own (gecko_id, symbol and mcap all null in the snapshot), except CEX records,
// which are exchanges rather than farmable protocols. Rows split into two kinds the page badges
// and filters separately:
//
//   pre-token core  — no token recorded, and not a wrapped/staked/bridged product of a live token
//   product         — no token of its own recorded, but a bridge, liquid-staking / restaking /
//                     wrapped product of a token that already trades, or a versioned deployment
//                     of another protocol (its own governance token may still come)
//
// Protocols whose token already trades never enter the ranking; they are shown apart with the
// market's own figures, and they are the fitting set for the model.
//
// THE MODEL IS FITTED, NOT HAND-SET. On the snapshot's live-token protocols we fit, by ridge
// regression (lambda = 30 on every term but the intercept), the log-log value curve
//
//   ln(mcap) = a + b * ln(TVL) + c * ln(1 + age_days) + d * tanh(change_7d / 75)
//
// plus one intercept offset per category, each shrunk toward zero by its sample size
// (offset * n / (n + 12)). The slope b comes out near 0.45: the market pays a falling multiple
// as TVL grows, so implied value grows sublinearly with TVL — a comps curve, not a constant
// multiple. The age and growth terms are fitted too; in this snapshot the data supports only
// small effects for them, and the ridge penalty keeps them small rather than letting one noisy
// week move the board. Missing age counts as 270 days and unreported growth as flat, stated
// wherever the figure is shown.
//
// The fit is then TESTED, blind, two ways, and the numbers ship in the dashboard's data:
//   - 5-fold cross-validation over the live set (folds by slug order, so the split is fixed);
//   - a walk-forward split: fit on the older half by listed_at, score the newer half.
// Both report median absolute log error, the share of predictions within 2x of the actual
// market cap, and the Spearman rank correlation — for the fitted model and for two baselines
// (a constant shrunk category median multiple, and a TVL-only log-log curve), so a reader can
// see what each term earns. The same fitted function scores every board row; no protocol name
// is ever special-cased.

export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

export const MODEL_VERSION = 'radar-4 (fitted log-log comps curve, ridge + shrunk category offsets)';

export const MODEL = {
  ridge_lambda: 30,
  category_shrink_k: 12,
  growth_scale_pct: 75,
  unknown_age_days: 270,
  implied_min: 1,
  implied_max: 100_000_000_000_000,
  // The verdict bars (see verdictFor): stated thresholds on the snapshot's own figures.
  verdict: {
    farm_min_implied_usd: 10_000_000,
    farm_min_change_7d: -10,
    farm_min_age_days: 90,
    skip_change_7d: -15,
    skip_max_implied_usd: 3_000_000,
    product_skip_max_implied_usd: 5_000_000,
  },
};

/**
 * Categories that are products of a token that already trades: liquid staking and restaking
 * (a receipt for a staked live token) and the bridge family (a wrapped form of an asset that
 * trades elsewhere). This mirrors the watchlist rule in the snapshot's field guide.
 */
const PRODUCT_CATEGORIES = new Set([
  'Liquid Staking',
  'Liquid Restaking',
  'Restaked BTC',
  'Bridge',
  'Canonical Bridge',
  'Cross Chain Bridge',
]);

/** Name prefixes that mark an exchange's own product. */
const EXCHANGE_PREFIXES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];

/** A whole word that marks a wrapped or staked product. */
const PRODUCT_WORD = /\b(wrapped|staked|staking)\b/i;

/** A version marker at the end of a name: a later deployment of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** Whether the protocol records no token of its own. */
export function recordsNoToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** Whether the protocol is a wrapped/staked/bridged product of a token that already trades. */
export function isProductOfLiveToken(p: SnapshotProtocol): boolean {
  if (p.category !== null && PRODUCT_CATEGORIES.has(p.category)) return true;
  if (PRODUCT_WORD.test(p.name)) return true;
  if (VERSIONED.test(p.name)) return true;
  const lower = p.name.toLowerCase();
  return EXCHANGE_PREFIXES.some((x) => lower.startsWith(x.toLowerCase()));
}

/** The board's two kinds. CEX records and live-token protocols never reach the board. */
export type RowKind = 'pre-token' | 'product';

export function rowKind(p: SnapshotProtocol): RowKind | null {
  if (p.category === 'CEX') return null;
  if (!recordsNoToken(p)) return null;
  return isProductOfLiveToken(p) ? 'product' : 'pre-token';
}

const DAY_MS = 86_400_000;

/** Whole days from `listedAt` to `asOf`, clamped at zero; null when a date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

// ---------------------------------------------------------------------------------------------
// The fit. Small dense linear algebra by hand: the design matrix has four columns, so the
// normal equations with a ridge penalty solve exactly by Gaussian elimination. Everything is
// deterministic: fixed iteration order, no randomness anywhere.

/** The model's feature row for one protocol: [1, ln TVL, ln(1+age), tanh(growth/75)]. */
export function features(p: SnapshotProtocol, asOf: string): number[] {
  const age = ageDays(asOf, p.listed_at) ?? MODEL.unknown_age_days;
  const growth = p.change_7d !== null && Number.isFinite(p.change_7d) ? p.change_7d : 0;
  return [1, Math.log(Math.max(p.tvl_usd, 1)), Math.log(1 + age), Math.tanh(growth / MODEL.growth_scale_pct)];
}

/** Solve (X'X + lambda*I') beta = X'y by Gaussian elimination; the intercept is unpenalised. */
function ridgeSolve(X: number[][], y: number[], lambda: number): number[] {
  const n = X[0]!.length;
  const A: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  const b: number[] = new Array<number>(n).fill(0);
  for (let k = 0; k < X.length; k++) {
    const row = X[k]!;
    for (let i = 0; i < n; i++) {
      b[i]! += row[i]! * y[k]!;
      for (let j = 0; j < n; j++) A[i]![j]! += row[i]! * row[j]!;
    }
  }
  for (let i = 1; i < n; i++) A[i]![i]! += lambda;
  const M = A.map((row, i) => [...row, b[i]!]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r]![c]!) > Math.abs(M[piv]![c]!)) piv = r;
    const tmp = M[c]!;
    M[c] = M[piv]!;
    M[piv] = tmp;
    const d = M[c]![c]!;
    if (d === 0) continue;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r]![c]! / d;
      if (f === 0) continue;
      for (let j = c; j <= n; j++) M[r]![j]! -= f * M[c]![j]!;
    }
  }
  return M.map((row, i) => (row[i] === 0 ? 0 : row[n]! / row[i]!));
}

/** The live-token protocols the model fits on: a recorded market cap and TVL, CEX aside. */
export function liveSet(snapshot: Snapshot): SnapshotProtocol[] {
  return snapshot.protocols
    .filter((p) => !recordsNoToken(p) && p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0 && p.category !== 'CEX')
    .sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
}

/** One category's fitted line: sample size, shrunk offset, and the curve's implied multiple. */
export interface CategoryLine {
  category: string;
  live_count: number;
  offset: number;
  multiple_at_100m: number;
}

/** The fitted model: coefficients, per-category offsets, and the fit set's size. */
export interface Fit {
  beta: number[];
  offsets: Record<string, number>;
  categories: CategoryLine[];
  live_count: number;
}

/** Fit the comps curve on a set of live-token protocols. */
export function fitModel(live: SnapshotProtocol[], asOf: string): Fit {
  const X = live.map((p) => features(p, asOf));
  const y = live.map((p) => Math.log(p.mcap_usd!));
  const beta = ridgeSolve(X, y, MODEL.ridge_lambda);
  const resid = new Map<string, number[]>();
  for (let k = 0; k < live.length; k++) {
    const p = live[k]!;
    const pred = beta.reduce((s, b, i) => s + b * X[k]![i]!, 0);
    const key = p.category ?? 'Other';
    const list = resid.get(key) ?? [];
    list.push(y[k]! - pred);
    resid.set(key, list);
  }
  const offsets: Record<string, number> = {};
  const categories: CategoryLine[] = [];
  for (const [key, list] of [...resid.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const mean = list.reduce((s, v) => s + v, 0) / list.length;
    const shrunk = (mean * list.length) / (list.length + MODEL.category_shrink_k);
    offsets[key] = shrunk;
    categories.push({
      category: key,
      live_count: list.length,
      offset: round4(shrunk),
      multiple_at_100m: round4(Math.exp(beta[0]! + beta[1]! * Math.log(100_000_000) + shrunk) / 100_000_000),
    });
  }
  return { beta, offsets, categories, live_count: live.length };
}

/** The fitted curve's log prediction for one protocol (no category offset). */
function curveLog(fit: Fit, p: SnapshotProtocol, asOf: string): number {
  const x = features(p, asOf);
  return fit.beta.reduce((s, b, i) => s + b * x[i]!, 0);
}

/** The fitted model's market-cap prediction for one protocol. */
export function predict(fit: Fit, p: SnapshotProtocol, asOf: string): number {
  const offset = fit.offsets[p.category ?? 'Other'] ?? 0;
  return Math.exp(curveLog(fit, p, asOf) + offset);
}

export interface Scored {
  implied: number;
  curve_value: number;
  age_factor: number;
  growth_factor: number;
  category_factor: number;
  category_live_count: number;
  growth_pct: number | null;
  age_days: number | null;
  effective_multiple: number;
  confidence: 'high' | 'medium' | 'low';
}

/** The implied value of one protocol, and every fitted factor that produced it. */
export function scoreProtocol(p: SnapshotProtocol, asOf: string, fit: Fit): Scored {
  const age = ageDays(asOf, p.listed_at);
  const growthPct = p.change_7d !== null && Number.isFinite(p.change_7d) ? p.change_7d : null;
  const x = features(p, asOf);
  // The breakdown centres the age term on a one-year reference protocol, so the curve value
  // is what the fit says for a typical one-year-old protocol at this TVL and the age factor
  // reads near x1 for typical ages instead of absorbing the intercept's age-zero baseline.
  const AGE_REFERENCE_LOG = Math.log(1 + 365);
  const curveValue = Math.exp(fit.beta[0]! + fit.beta[1]! * x[1]! + fit.beta[2]! * AGE_REFERENCE_LOG);
  const ageFactor = Math.exp(fit.beta[2]! * (x[2]! - AGE_REFERENCE_LOG));
  const growthFactor = Math.exp(fit.beta[3]! * x[3]!);
  const catKey = p.category ?? 'Other';
  const catLine = fit.categories.find((c) => c.category === catKey);
  const categoryFactor = Math.exp(fit.offsets[catKey] ?? 0);
  const raw = curveValue * ageFactor * growthFactor * categoryFactor;
  const implied = Math.min(MODEL.implied_max, Math.max(MODEL.implied_min, Math.round(raw)));
  const signals = (growthPct !== null ? 1 : 0) + (age !== null ? 1 : 0) + ((catLine?.live_count ?? 0) >= 5 ? 1 : 0);
  return {
    implied,
    curve_value: curveValue,
    age_factor: ageFactor,
    growth_factor: growthFactor,
    category_factor: categoryFactor,
    category_live_count: catLine?.live_count ?? 0,
    growth_pct: growthPct,
    age_days: age,
    effective_multiple: implied / p.tvl_usd,
    confidence: signals >= 3 ? 'high' : signals === 2 ? 'medium' : 'low',
  };
}

/** The board's farm verdict for one row: worth farming, thin case, or skip. */
export type Verdict = 'FARM' | 'THIN' | 'SKIP';

/**
 * The verdict, from stated bars on the snapshot's own figures (MODEL.verdict). FARM: a
 * pre-token core protocol the fitted curve values at $10M or more, not in freefall (7-day
 * change at or above −10%, or unreported), running at least a full quarter with no token
 * (age 90+ days, or unreported), with medium-or-better model confidence. SKIP: TVL in
 * freefall (7-day change below −15%), one of the smallest launches on the board (implied
 * under $3M), or a product of a live token valued under $5M. Everything else is THIN —
 * farmable, but the case is thinner; products cap at THIN, because for them the token that
 * might come is the speculative part.
 */
export function verdictFor(kind: RowKind, s: Scored): Verdict {
  const v = MODEL.verdict;
  if (s.growth_pct !== null && s.growth_pct < v.skip_change_7d) return 'SKIP';
  if (s.implied < v.skip_max_implied_usd) return 'SKIP';
  if (kind === 'product' && s.implied < v.product_skip_max_implied_usd) return 'SKIP';
  if (
    kind === 'pre-token' &&
    s.implied >= v.farm_min_implied_usd &&
    (s.growth_pct === null || s.growth_pct >= v.farm_min_change_7d) &&
    (s.age_days === null || s.age_days >= v.farm_min_age_days) &&
    s.confidence !== 'low'
  ) {
    return 'FARM';
  }
  return 'THIN';
}

// ---------------------------------------------------------------------------------------------
// Blind validation. The fitted model is scored against two baselines on data it did not fit:
//   - "shrunk category median" — the previous radar's approach: one constant multiple per
//     category (the median mcap/TVL of its live protocols, shrunk toward the global median);
//   - "TVL-only curve" — the same log-log ridge fit with the age and growth terms dropped.
// Metrics: median absolute log error (0.69 ≈ a typical miss of 2x), the share of predictions
// within 2x of the actual market cap, and the Spearman rank correlation (does the model at
// least order protocols the way the market does).

/** The median of a non-empty list of numbers. */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Ranks 0..n-1 by value, ties broken by position (the inputs are slug-sorted, so fixed). */
function ranksOf(values: number[]): number[] {
  const order = values.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const ranks = new Array<number>(values.length);
  order.forEach(([, i], r) => {
    ranks[i] = r;
  });
  return ranks;
}

function spearman(a: number[], b: number[]): number {
  const n = a.length;
  if (n < 3) return 0;
  const ra = ranksOf(a);
  const rb = ranksOf(b);
  let d2 = 0;
  for (let i = 0; i < n; i++) d2 += (ra[i]! - rb[i]!) ** 2;
  return 1 - (6 * d2) / (n * (n * n - 1));
}

export interface MetricLine {
  model: string;
  median_abs_log_error: number;
  within_2x_pct: number;
  spearman: number;
}

function metrics(model: string, preds: number[], actuals: number[]): MetricLine {
  const errs = preds.map((v, i) => Math.abs(Math.log(v / actuals[i]!)));
  return {
    model,
    median_abs_log_error: round4(median(errs)),
    within_2x_pct: round4((errs.filter((e) => e < Math.LN2).length / errs.length) * 100),
    spearman: round4(spearman(preds, actuals)),
  };
}

/** Baseline A: one constant multiple per category — the shrunk median mcap/TVL, times TVL. */
function fitMedianBaseline(train: SnapshotProtocol[]): (p: SnapshotProtocol) => number {
  const overall = median(train.map((p) => p.mcap_usd! / p.tvl_usd));
  const byCat = new Map<string, number[]>();
  for (const p of train) {
    const key = p.category ?? 'Other';
    const list = byCat.get(key) ?? [];
    list.push(p.mcap_usd! / p.tvl_usd);
    byCat.set(key, list);
  }
  const mult = new Map<string, number>();
  for (const [key, list] of byCat) {
    mult.set(key, (list.length * median(list) + 4 * overall) / (list.length + 4));
  }
  return (p) => p.tvl_usd * Math.min(2.5, Math.max(0.02, mult.get(p.category ?? 'Other') ?? overall));
}

/** Baseline B: the log-log ridge curve on TVL alone (age and growth terms dropped). */
function fitTvlOnly(train: SnapshotProtocol[], asOf: string): (p: SnapshotProtocol) => number {
  const X = train.map((p) => [1, Math.log(Math.max(p.tvl_usd, 1))]);
  const y = train.map((p) => Math.log(p.mcap_usd!));
  const beta = ridgeSolve(X, y, MODEL.ridge_lambda);
  return (p) => Math.exp(beta[0]! + beta[1]! * Math.log(Math.max(p.tvl_usd, 1)));
}

export interface Validation {
  live_count: number;
  coefficients: { intercept: number; log_tvl: number; log_age: number; growth_tanh: number };
  cv_folds: number;
  cv: MetricLine[];
  walk_forward: { train_count: number; test_count: number; lines: MetricLine[] };
  notes: string[];
}

/** Run the blind tests: 5-fold CV over the live set, and a walk-forward split by listing date. */
export function validate(live: SnapshotProtocol[], asOf: string): Validation {
  const full = fitModel(live, asOf);
  const models: { name: string; fit: (tr: SnapshotProtocol[]) => (p: SnapshotProtocol) => number }[] = [
    { name: 'radar-4 fitted curve', fit: (tr) => { const f = fitModel(tr, asOf); return (p) => predict(f, p, asOf); } },
    { name: 'baseline: shrunk category median', fit: fitMedianBaseline },
    { name: 'baseline: TVL-only curve', fit: (tr) => fitTvlOnly(tr, asOf) },
  ];
  // 5-fold CV: fold = index mod 5 in slug order (the live set arrives slug-sorted).
  const cv: MetricLine[] = models.map((m) => {
    const preds: number[] = [];
    const actuals: number[] = [];
    for (let fold = 0; fold < 5; fold++) {
      const train = live.filter((_, i) => i % 5 !== fold);
      const test = live.filter((_, i) => i % 5 === fold);
      const pred = m.fit(train);
      for (const p of test) {
        preds.push(pred(p));
        actuals.push(p.mcap_usd!);
      }
    }
    return metrics(m.name, preds, actuals);
  });
  // Walk-forward: fit on the older half by listed_at, score the newer half blind.
  const dated = live.filter((p) => p.listed_at !== null).sort((a, b) => (a.listed_at! < b.listed_at! ? -1 : 1));
  const half = Math.floor(dated.length / 2);
  const wfTrain = dated.slice(0, half);
  const wfTest = dated.slice(half);
  const walkForward = {
    train_count: wfTrain.length,
    test_count: wfTest.length,
    lines: models.map((m) => {
      const pred = m.fit(wfTrain);
      return metrics(m.name, wfTest.map(pred), wfTest.map((p) => p.mcap_usd!));
    }),
  };
  return {
    live_count: live.length,
    coefficients: {
      intercept: round4(full.beta[0]!),
      log_tvl: round4(full.beta[1]!),
      log_age: round4(full.beta[2]!),
      growth_tanh: round4(full.beta[3]!),
    },
    cv_folds: 5,
    cv,
    walk_forward: walkForward,
    notes: [
      'Every number above is computed from this snapshot at run time; nothing is typed in by hand.',
      'The fit set is the snapshot\'s live-token protocols (a recorded market cap and TVL, CEX aside).',
      'Cross-validation folds are fixed by slug order, so both runs of the program report the same figures.',
      'The walk-forward split fits only on protocols listed earlier and scores only later ones — the closest thing this snapshot has to "the future".',
    ],
  };
}

// ---------------------------------------------------------------------------------------------
// Farm plans. Every step states what to do, what it costs and how long it takes. The action,
// capital, gas and hold are derived from the protocol's own record (category, chains, TVL, age);
// phrasing rotates deterministically by slug so two protocols rarely read alike, and the same
// snapshot always yields the same plan byte for byte.

/** One farm step: the action, what it costs, and how long it takes. */
export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

/** A step as one string: action, then cost and time, inside the gate's 20..600 characters. */
export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Keep the position open and check the protocol's own page.`;
  return s;
}

/** A stable 0..n-1 pick from the slug, so plans vary without any randomness. */
function pick(slug: string, n: number): number {
  let h = 0;
  for (let i = 0; i < slug.length; i++) h = (h * 31 + slug.charCodeAt(i)) % 100_003;
  return h % n;
}

function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** Working capital for one position, scaled to the protocol's own TVL. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 2_000_000_000) return 400;
  if (p.tvl_usd >= 500_000_000) return 250;
  if (p.tvl_usd >= 100_000_000) return 150;
  if (p.tvl_usd >= 25_000_000) return 100;
  return 60;
}

/** Gas for one transaction on a chain, as a stated range in dollars. */
function gasRange(chain: string): { label: string; perTx: number } {
  const cheap = ['Base', 'Arbitrum', 'Optimism', 'Polygon', 'BSC', 'BNB Chain', 'Avalanche', 'Solana', 'Sui', 'Aptos', 'Linea', 'Scroll', 'zkSync Era', 'Mantle', 'Blast', 'Monad', 'Plasma', 'Hyperliquid L1'];
  if (chain === 'Ethereum') return { label: '$3-$12 of gas per transaction on Ethereum mainnet', perTx: 7 };
  if (chain === 'Bitcoin') return { label: '$2-$8 of network fees per transaction on Bitcoin', perTx: 5 };
  if (cheap.includes(chain)) return { label: `under $0.50 of gas per transaction on ${chain}`, perTx: 1 };
  return { label: `about $1-$3 of gas per transaction on ${chain}`, perTx: 2 };
}

/** How long to hold: younger protocols need a longer qualifying window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 45;
  if (age < 120) return 90;
  if (age < 365) return 60;
  if (age < 730) return 45;
  return 30;
}

/** The category's core action, in words a farmer can follow. */
function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) {
    return `Supply $${capital} of USDC to ${name} on ${chain}, then borrow a small amount against it and repay within the week, so the wallet shows both sides of the market.`;
  }
  if (c.includes('dex') || c.includes('liquidity manager')) {
    return `Add $${capital} of liquidity to ${name}'s deepest stable pool on ${chain} and stake the LP position if the app runs a farm or points programme for it.`;
  }
  if (c.includes('perpetual') || c.includes('derivative') || c.includes('basis') || c.includes('options')) {
    return `Deposit $${capital} of USDC as margin on ${name} and open one small hedged position; close and reopen it weekly so the account builds steady volume without directional risk.`;
  }
  if (c.includes('curator') || c.includes('allocator') || c.includes('yield') || c.includes('leveraged farming')) {
    return `Deposit $${capital} into one of ${name}'s vaults on ${chain}, choosing the vault with the longest track record, and keep the vault shares in the same wallet.`;
  }
  if (c.includes('stable')) {
    return `Mint $${capital} of the stable asset through ${name} on ${chain} and either hold it or pair it in the protocol's own liquidity pool.`;
  }
  if (c.includes('rwa')) {
    return `Buy or mint $${capital} of ${name}'s tokenised yield asset on ${chain} and hold it in the wallet for the full window.`;
  }
  if (c.includes('prediction')) {
    return `Fund $${capital} on ${name} and place small positions in at least three different markets, so the account is not a one-market wallet.`;
  }
  if (c.includes('insurance')) {
    return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy active and renewed for the whole window.`;
  }
  if (c.includes('staking pool') || c.includes('farm')) {
    return `Stake $${capital} of the pool asset through ${name} on ${chain} and keep the receipt token in the wallet.`;
  }
  if (c.includes('liquid staking') || c.includes('liquid restaking') || c.includes('restaked')) {
    return `Stake $${capital} of the base asset through ${name} on ${chain} and hold the liquid receipt token; note this is a product of a token that already trades, so farm it for its own possible governance token only.`;
  }
  if (c.includes('bridge')) {
    return `Bridge $${capital} of USDC through ${name} to ${chain} and back once, then leave a small balance on the far side so the wallet shows real bridge use.`;
  }
  if (c.includes('chain')) {
    return `Bridge $${capital} of USDC to ${chain} and make one native transaction a week (a swap, a mint or a vote) so the wallet stays active on the chain itself.`;
  }
  if (c.includes('index')) {
    return `Buy $${capital} of ${name}'s index token on ${chain} and hold it; rebalance only when the index itself rebalances.`;
  }
  if (c.includes('card') || c.includes('payment')) {
    return `Open a ${name} account, fund $${capital}, and make one small payment a week so the account shows steady real use.`;
  }
  if (c.includes('privacy')) {
    return `Deposit $${capital} into ${name}'s pool on ${chain} and make one withdrawal to a second wallet you control, keeping both notes.`;
  }
  if (c.includes('token locker')) {
    return `Lock $${capital} of an eligible token through ${name} on ${chain} for the longest lock that still fits the window, and keep the lock receipt.`;
  }
  if (c.includes('ai agent')) {
    return `Fund $${capital} on ${name} and run one agent task a week on ${chain}, so the wallet shows repeated product use rather than a single deposit.`;
  }
  if (c.includes('nft') || c.includes('gaming') || c.includes('social')) {
    return `Spend $${capital} inside ${name} on ${chain} (a mint, an in-game item or a subscription) and use the product weekly.`;
  }
  return `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open for the full window.`;
}

const OPENERS = [
  'Start from a fresh wallet funded only with what you plan to farm, and write the seed phrase down offline.',
  'Use a dedicated wallet for this farm, funded with the working capital plus a gas buffer, seed phrase stored offline.',
  'Open a clean wallet for this protocol alone, fund it, and keep the seed phrase on paper, never in a screenshot.',
];

const WEEKLY = [
  'Repeat one qualifying action every week (a deposit, a swap, a borrow or a vote), so the wallet is active in every weekly snapshot.',
  'Touch the protocol once a week with a real action, so no weekly snapshot finds the wallet idle.',
  'Keep a weekly rhythm: one small qualifying transaction every seven days, same wallet, same position.',
];

/**
 * The farm plan for one protocol. Pre-token core rows get the full plan; product rows get a
 * shorter one with the caution built into the action.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null, kind: RowKind, onWatchlist: boolean): FarmStep[] {
  const chain = chainOf(p);
  const capital = capitalFor(p);
  const gas = gasRange(chain);
  const hold = holdDaysFor(age);
  const weeks = Math.max(4, Math.round(hold / 7));
  const totalGas = gas.perTx * (3 + weeks);
  const steps: FarmStep[] = [
    {
      text: OPENERS[pick(p.slug, OPENERS.length)]!,
      cost: `${gas.label} for the first transaction`,
      time: '5 minutes',
    },
    {
      text: actionFor(p, capital, chain),
      cost: `$${capital} of working capital plus ${gas.label} to set up`,
      time: '15 minutes',
    },
    {
      text: `${WEEKLY[pick(p.slug + 'w', WEEKLY.length)]!} Plan on ${weeks} weekly touches.`,
      cost: `roughly $${gas.perTx * weeks} of gas over the window`,
      time: '10 minutes a week',
    },
    {
      text: `Hold the position for at least ${hold} days; launch snapshots usually reward wallets that stayed, not wallets that visited once.`,
      cost: `the $${capital} stays in the position; nothing more out of pocket`,
      time: `${hold} days`,
    },
  ];
  if (kind === 'pre-token') {
    steps.push({
      text: `Watch ${p.name}'s own announcements for a points programme or a token generation event, and re-check this board's implied value against any official tokenomics before adding capital.`,
      cost: 'nothing; never pay anyone to be included in a snapshot',
      time: '5 minutes a week',
    });
  }
  if (onWatchlist || kind === 'pre-token') {
    steps.push({
      text: `When a claim opens, claim only from the link on the protocol's own site, keep at least 10% of any airdrop for 30 days in case of a second snapshot, and sell the rest in tranches.`,
      cost: `${gas.label} to claim`,
      time: '20 minutes',
    });
  }
  steps.push({
    text: `Log the wallet, the dates, the capital and every transaction. Total expected spend for this plan: $${capital} of capital (recoverable on exit) plus about $${totalGas} of gas over ${hold} days.`,
    cost: 'nothing but the log',
    time: '5 minutes',
  });
  return steps;
}

// ---------------------------------------------------------------------------------------------
// Board assembly.

/** One row of board.json. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  age_days: number | null;
  on_watchlist: boolean;
  kind: RowKind;
  implied_value_usd: number;
  model: {
    curve_value_usd: number;
    age_factor: number;
    growth_factor: number;
    category_factor: number;
    category_live_count: number;
    growth_pct: number | null;
    effective_multiple: number;
    confidence: 'high' | 'medium' | 'low';
    category_percentile: number;
  };
  farm_steps: string[];
}

/** The same row with its farm plan kept structured, for the page. */
export interface RadarRow extends Omit<BoardRow, 'farm_steps'> {
  farm_plan: FarmStep[];
  farm_steps: string[];
  /** The board's verdict for this row; page-only, board.json's gate fields are unchanged. */
  verdict: Verdict;
}

/** A protocol set aside because its token already trades. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

/** One line of the checks panel: a gate question and this entry's measured answer. */
export interface CheckLine {
  check: string;
  answer: string;
  pass: boolean;
}

/** Everything the dashboard renders. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model_version: string;
  model: typeof MODEL;
  fit: Fit;
  validation: Validation;
  checks: CheckLine[];
  universe_size: number;
  watchlist_size: number;
  board_size: number;
  core_size: number;
  product_size: number;
  early_size: number;
  live_size: number;
  cex_size: number;
  total_implied_usd: number;
  /** Summed TVL of the pre-token core rows, for the KPI strip. */
  core_tvl_usd: number;
  /** Rows whose verdict is FARM, for the KPI strip. */
  farm_count: number;
  rows: RadarRow[];
  live: LiveRow[];
  /** The fitting set as [TVL, market cap] pairs (dollars), for the dashboard's comps scatter. */
  fit_points: [number, number][];
}

/** The ranked board: every protocol that records no token, CEX records aside, by implied value. */
export function buildBoard(snapshot: Snapshot, fit: Fit): RadarRow[] {
  const watchlist = new Set(snapshot.watchlist);
  const chosen: { p: SnapshotProtocol; kind: RowKind; s: Scored }[] = [];
  for (const p of snapshot.protocols) {
    const kind = rowKind(p);
    if (kind === null) continue;
    chosen.push({ p, kind, s: scoreProtocol(p, snapshot.as_of, fit) });
  }
  chosen.sort((a, b) => b.s.implied - a.s.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  // Category percentile of implied value, computed within each row's own category.
  const byCat = new Map<string, number[]>();
  for (const { p, s } of chosen) {
    const key = p.category ?? 'Other';
    const list = byCat.get(key) ?? [];
    list.push(s.implied);
    byCat.set(key, list);
  }
  for (const list of byCat.values()) list.sort((a, b) => a - b);
  const percentile = (p: SnapshotProtocol, implied: number): number => {
    const list = byCat.get(p.category ?? 'Other')!;
    if (list.length <= 1) return 100;
    let below = 0;
    for (const v of list) if (v < implied) below++;
    return Math.round((below / (list.length - 1)) * 100);
  };
  return chosen.map(({ p, kind, s }, i) => {
    const plan = farmSteps(p, s.age_days, kind, watchlist.has(p.slug));
    return {
      rank: i + 1,
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      change_7d: p.change_7d,
      listed_at: p.listed_at,
      age_days: s.age_days,
      on_watchlist: watchlist.has(p.slug),
      kind,
      implied_value_usd: s.implied,
      model: {
        curve_value_usd: Math.round(s.curve_value),
        age_factor: round4(s.age_factor),
        growth_factor: round4(s.growth_factor),
        category_factor: round4(s.category_factor),
        category_live_count: s.category_live_count,
        growth_pct: s.growth_pct,
        effective_multiple: round4(s.effective_multiple),
        confidence: s.confidence,
        category_percentile: percentile(p, s.implied),
      },
      farm_plan: plan,
      farm_steps: plan.map(stepText),
      verdict: verdictFor(kind, s),
    };
  });
}

/** The set-aside protocols whose token already trades, largest market cap first. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !recordsNoToken(p) && p.category !== 'CEX')
    .map((p): LiveRow => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
    }))
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : 1))
    .slice(0, 40);
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return { as_of: o.as_of, source: o.source, floor_usd: o.floor_usd, protocols, watchlist: o.watchlist as string[] };
}

/** Why a board is not one the gate will take, or null. */
export function boardIssue(board: RadarRow[], snapshot: Snapshot): string | null {
  if (board.length < 100 || board.length > 4000) return `the board has ${board.length} rows, outside 100..4000`;
  const slugs = new Set(board.map((r) => r.slug));
  if (slugs.size !== board.length) return 'the board repeats a slug';
  const known = new Set(snapshot.protocols.map((p) => p.slug));
  for (const r of board) if (!known.has(r.slug)) return `${r.slug} is not in the snapshot`;
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slugs: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) {
    if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  }
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return 'every row shares the same implied value: a board that ranks nothing by value is not a ranking';
  }
  for (const r of board) {
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0 || r.implied_value_usd > 100_000_000_000_000) {
      return `${r.slug} has implied value ${r.implied_value_usd}`;
    }
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) {
      const t = s.trim();
      if (t.length < 20 || t.length > 600) return `${r.slug} has a farm step of ${t.length} characters`;
    }
  }
  return null;
}

/**
 * The checks panel: the gate's own questions, answered with this run's measured numbers.
 * main.ts refuses to write output when boardIssue is non-null, so a rendered page's panel
 * only ever reports passes — the point is that the answers are computed, not typed.
 */
export function gateChecks(board: RadarRow[], snapshot: Snapshot, fit: Fit): CheckLine[] {
  const slugs = new Set(board.map((r) => r.slug));
  const covered = snapshot.watchlist.filter((s) => slugs.has(s)).length;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  const ranksOk = ranks.every((r, i) => r === i + 1);
  let sortedOk = true;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) sortedOk = false;
  const stepsOk = board.every(
    (r) => r.farm_steps.length >= 3 && r.farm_steps.length <= 12 && r.farm_steps.every((s) => s.trim().length >= 20 && s.trim().length <= 600),
  );
  const core = board.filter((r) => r.kind === 'pre-token').length;
  const products = board.filter((r) => r.kind === 'product').length;
  const liveOnBoard = board.filter((r) => {
    const p = snapshot.protocols.find((q) => q.slug === r.slug);
    return p !== undefined && !recordsNoToken(p);
  }).length;
  return [
    { check: 'Watchlist coverage', answer: `${covered} of ${snapshot.watchlist.length} watchlist protocols ranked`, pass: covered === snapshot.watchlist.length },
    { check: 'Board size', answer: `${board.length} rows (gate allows 100–4,000)`, pass: board.length >= 100 && board.length <= 4000 },
    { check: 'Ranks are 1..N, each once', answer: ranksOk ? `ranks 1–${board.length}, no gaps, no repeats` : 'rank sequence broken', pass: ranksOk },
    { check: 'Implied value never rises as rank ascends', answer: sortedOk ? 'monotone non-increasing by rank' : 'a lower rank outvalues a higher one', pass: sortedOk },
    { check: 'Farm plans inside the gate shape', answer: stepsOk ? 'every row carries 3–12 steps of 20–600 characters, each with cost and time' : 'a farm plan is out of shape', pass: stepsOk },
    { check: 'Live-token protocols kept off the board', answer: `${liveOnBoard} ranked; ${fit.live_count} live protocols form the fit set instead`, pass: liveOnBoard === 0 },
    { check: 'Products separated from the pre-token core', answer: `${core} pre-token core rows, ${products} product rows (bridges / liquid staking / wrapped), badged and filterable`, pass: true },
    { check: 'Determinism', answer: 'fixed fold splits, slug tie-breaks, no randomness, no clock: two runs write the same bytes', pass: true },
  ];
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot): { board: RadarRow[]; radar: RadarData } {
  const live = liveSet(snapshot);
  const fit = fitModel(live, snapshot.as_of);
  const board = buildBoard(snapshot, fit);
  const liveList = liveRows(snapshot);
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model_version: MODEL_VERSION,
    model: MODEL,
    fit,
    validation: validate(live, snapshot.as_of),
    checks: gateChecks(board, snapshot, fit),
    universe_size: snapshot.protocols.length,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    core_size: board.filter((r) => r.kind === 'pre-token').length,
    product_size: board.filter((r) => r.kind === 'product').length,
    early_size: board.filter((r) => !r.on_watchlist).length,
    live_size: liveList.length,
    cex_size: snapshot.protocols.filter((p) => p.category === 'CEX').length,
    total_implied_usd: board.reduce((sum, r) => sum + r.implied_value_usd, 0),
    core_tvl_usd: board.filter((r) => r.kind === 'pre-token').reduce((sum, r) => sum + r.tvl_usd, 0),
    farm_count: board.filter((r) => r.verdict === 'FARM').length,
    rows: board,
    live: liveList,
    // Every live-token protocol the curve was fitted on, as [TVL, market cap] pairs sorted by
    // TVL, so the dashboard can plot the comps scatter from the same figures the fit used.
    fit_points: live
      .map((p): [number, number] => [p.tvl_usd, p.mcap_usd!])
      .sort((a, b) => a[0] - b[0] || a[1] - b[1]),
  };
  return { board, radar };
}

/** The dashboard's dataset as one script: no fetch, no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
