// Token Radar v2 — the value model (radar-3).
//
// One sealed snapshot in, one ranked board out. The board ranks every protocol that records no
// token of its own (gecko_id, symbol and mcap all null in the snapshot), except CEX records,
// which are exchanges rather than farmable protocols. Within the board, rows split into two
// kinds the page badges separately:
//
//   pre-token core  — no token recorded, and not a wrapped/staked/bridged product of a live token
//   product         — no token of its own recorded, but a bridge, liquid-staking / restaking /
//                     wrapped product of a token that already trades, or a versioned deployment
//                     of another protocol (its own governance token may still come; the flag
//                     lets a reader filter it out)
//
// Protocols whose token already trades never enter the ranking; they are shown apart with the
// market's own figures, and they are also the calibration set for the model.
//
// Implied value is calibrated from the snapshot itself. For each category the base multiple is
// the median market-cap-to-TVL ratio of that category's live-token protocols in this same
// snapshot, shrunk toward the snapshot-wide median by sample size so a two-protocol category
// cannot swing the board:
//
//   multiple(cat) = (n * median(cat) + K * median(all)) / (n + K),   K = 4, clamped to [0.02, 2.5]
//
//   implied = tvl_usd * multiple * momentum * maturity * breadth
//
//   momentum = 1 + 0.5 * tanh(change_7d / 75)          (unreported growth counts as flat: 1.0)
//   maturity = 0.60 + 0.40 * ln(1 + age_days) / ln(1 + 1460)   (unknown age counts as 270 days)
//   breadth  = 1 + 0.025 * min(chains - 1, 10)
//
// Momentum is damped (tanh saturates, so a one-week spike cannot dominate), maturity saturates
// (the survival signal of running tokenless flattens after the first years), and breadth pays a
// small premium per extra chain. The same function scores every row; no protocol name is ever
// special-cased, and every factor is printed beside the row it produced.

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

export const MODEL_VERSION = 'radar-3 (snapshot-calibrated, shrunk category medians)';

export const MODEL = {
  shrink_k: 4,
  multiple_min: 0.02,
  multiple_max: 2.5,
  momentum_amplitude: 0.5,
  momentum_scale_pct: 75,
  maturity_floor: 0.6,
  maturity_range: 0.4,
  maturity_days: 1460,
  unknown_age_days: 270,
  breadth_per_chain: 0.025,
  breadth_max_extra_chains: 10,
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

/** The median of a non-empty list of numbers. */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function clampMultiple(m: number): number {
  return Math.min(MODEL.multiple_max, Math.max(MODEL.multiple_min, m));
}

/** One category's calibration line: what the market pays per dollar of TVL there. */
export interface CategoryLine {
  category: string;
  live_count: number;
  median_multiple: number;
  shrunk_multiple: number;
}

/** The calibration: shrunk category multiples read off the live-token protocols. */
export interface Calibration {
  overall_multiple: number;
  live_count: number;
  categories: CategoryLine[];
  by_category: Record<string, CategoryLine>;
}

/** Calibrate the base multiples from the snapshot's own live-token protocols. */
export function calibrate(snapshot: Snapshot): Calibration {
  const live = snapshot.protocols.filter(
    (p) => !recordsNoToken(p) && p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0 && p.category !== 'CEX',
  );
  const allRatios = live.map((p) => p.mcap_usd! / p.tvl_usd);
  const overall = allRatios.length > 0 ? clampMultiple(median(allRatios)) : 0.25;
  const grouped = new Map<string, number[]>();
  for (const p of live) {
    const key = p.category ?? 'Other';
    const list = grouped.get(key) ?? [];
    list.push(p.mcap_usd! / p.tvl_usd);
    grouped.set(key, list);
  }
  const categories: CategoryLine[] = [];
  const byCategory: Record<string, CategoryLine> = {};
  for (const [key, ratios] of [...grouped.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const med = median(ratios);
    const shrunk = clampMultiple((ratios.length * med + MODEL.shrink_k * overall) / (ratios.length + MODEL.shrink_k));
    const line: CategoryLine = {
      category: key,
      live_count: ratios.length,
      median_multiple: round4(med),
      shrunk_multiple: round4(shrunk),
    };
    categories.push(line);
    byCategory[key] = line;
  }
  return { overall_multiple: round4(overall), live_count: live.length, categories, by_category: byCategory };
}

/** The base multiple one protocol gets, and where it came from. */
export function multipleFor(p: SnapshotProtocol, cal: Calibration): { multiple: number; source: string; live_count: number } {
  const key = p.category ?? 'Other';
  const hit = cal.by_category[key];
  if (hit) {
    return {
      multiple: hit.shrunk_multiple,
      source:
        hit.live_count === 1
          ? `${key}: the 1 live protocol's ratio, shrunk toward the snapshot median`
          : `${key} median of ${hit.live_count} live protocols, shrunk toward the snapshot median`,
      live_count: hit.live_count,
    };
  }
  return {
    multiple: cal.overall_multiple,
    source: `snapshot-wide median of ${cal.live_count} live protocols (no live ${key} sample)`,
    live_count: 0,
  };
}

export interface Scored {
  implied: number;
  multiple: number;
  multiple_source: string;
  multiple_live_count: number;
  growth_pct: number | null;
  momentum_mult: number;
  maturity_mult: number;
  breadth_mult: number;
  effective_multiple: number;
  age_days: number | null;
  confidence: 'high' | 'medium' | 'low';
}

/** The implied value of one protocol, and every factor that produced it. */
export function scoreProtocol(p: SnapshotProtocol, asOf: string, cal: Calibration): Scored {
  const age = ageDays(asOf, p.listed_at);
  const { multiple, source, live_count } = multipleFor(p, cal);
  const growthPct = p.change_7d !== null && Number.isFinite(p.change_7d) ? p.change_7d : null;
  const momentumMult = growthPct === null ? 1 : 1 + MODEL.momentum_amplitude * Math.tanh(growthPct / MODEL.momentum_scale_pct);
  const ageForModel = age ?? MODEL.unknown_age_days;
  const maturityMult =
    MODEL.maturity_floor +
    (MODEL.maturity_range * Math.log(1 + Math.min(Math.max(ageForModel, 0), MODEL.maturity_days))) / Math.log(1 + MODEL.maturity_days);
  const breadthMult = 1 + MODEL.breadth_per_chain * Math.min(Math.max(p.chains.length - 1, 0), MODEL.breadth_max_extra_chains);
  const implied = Math.max(1, Math.round(p.tvl_usd * multiple * momentumMult * maturityMult * breadthMult));
  const signals = (growthPct !== null ? 1 : 0) + (age !== null ? 1 : 0) + (live_count >= 5 ? 1 : 0);
  return {
    implied,
    multiple,
    multiple_source: source,
    multiple_live_count: live_count,
    growth_pct: growthPct,
    momentum_mult: momentumMult,
    maturity_mult: maturityMult,
    breadth_mult: breadthMult,
    effective_multiple: implied / p.tvl_usd,
    age_days: age,
    confidence: signals >= 3 ? 'high' : signals === 2 ? 'medium' : 'low',
  };
}

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

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
 * The farm plan for one protocol. Watchlist and top-ranked rows get the full seven steps; the
 * long tail gets five; product rows get a shorter plan with the caution built into the action.
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
    multiple: number;
    multiple_source: string;
    multiple_live_count: number;
    growth_pct: number | null;
    momentum_multiplier: number;
    maturity_multiplier: number;
    breadth_multiplier: number;
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

/** Everything the dashboard renders. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model_version: string;
  model: typeof MODEL;
  calibration: Calibration;
  universe_size: number;
  watchlist_size: number;
  board_size: number;
  core_size: number;
  product_size: number;
  early_size: number;
  live_size: number;
  cex_size: number;
  total_implied_usd: number;
  median_multiple: number;
  rows: RadarRow[];
  live: LiveRow[];
}

/** The ranked board: every protocol that records no token, CEX records aside, by implied value. */
export function buildBoard(snapshot: Snapshot, cal: Calibration): RadarRow[] {
  const watchlist = new Set(snapshot.watchlist);
  const chosen: { p: SnapshotProtocol; kind: RowKind; s: Scored }[] = [];
  for (const p of snapshot.protocols) {
    const kind = rowKind(p);
    if (kind === null) continue;
    chosen.push({ p, kind, s: scoreProtocol(p, snapshot.as_of, cal) });
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
        multiple: round4(s.multiple),
        multiple_source: s.multiple_source,
        multiple_live_count: s.multiple_live_count,
        growth_pct: s.growth_pct,
        momentum_multiplier: round4(s.momentum_mult),
        maturity_multiplier: round4(s.maturity_mult),
        breadth_multiplier: round4(s.breadth_mult),
        effective_multiple: round4(s.effective_multiple),
        confidence: s.confidence,
        category_percentile: percentile(p, s.implied),
      },
      farm_plan: plan,
      farm_steps: plan.map(stepText),
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

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot): { board: RadarRow[]; radar: RadarData } {
  const cal = calibrate(snapshot);
  const board = buildBoard(snapshot, cal);
  const live = liveRows(snapshot);
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model_version: MODEL_VERSION,
    model: MODEL,
    calibration: cal,
    universe_size: snapshot.protocols.length,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    core_size: board.filter((r) => r.kind === 'pre-token').length,
    product_size: board.filter((r) => r.kind === 'product').length,
    early_size: board.filter((r) => !r.on_watchlist).length,
    live_size: live.length,
    cex_size: snapshot.protocols.filter((p) => p.category === 'CEX').length,
    total_implied_usd: board.reduce((sum, r) => sum + r.implied_value_usd, 0),
    median_multiple: cal.overall_multiple,
    rows: board,
    live,
  };
  return { board, radar };
}

/** The dashboard's dataset as one script: no fetch, no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
