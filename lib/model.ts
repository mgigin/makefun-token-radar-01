// Token Radar — the value model.
//
// One sealed snapshot in, one ranked board out. The board ranks protocols that record no token
// and are not a wrapped, staked or bridged product of a token that already trades (the watchlist
// rule, applied at every TVL, not only above the floor). Protocols whose token already trades —
// and the wrapped/staked/bridged products of those tokens — are set aside and shown with the
// market's own figures, never mixed into the ranking.
//
// Implied value is calibrated from the snapshot itself, not from a magic constant: for each
// category, the model's base multiple is the median market-cap-to-TVL ratio of the live-token
// protocols in that category in this same snapshot (categories with fewer than three live
// protocols fall back to the snapshot-wide median). Then:
//
//   implied = tvl_usd x category_multiple x growth_mult x maturity_mult x breadth_mult
//
//   growth_mult   = 1 + clamp(change_7d, -40, 80) / 100 x 0.35
//   maturity_mult = 0.55 + min(age_days, 1460) / 1460 x 0.45   (unknown age: 270 days)
//   breadth_mult  = 1 + 0.03 x min(chains - 1, 8)
//
// The same function scores every row; no protocol name is ever special-cased.

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

export const MODEL_VERSION = 'radar-2 (snapshot-calibrated)';

export const MODEL = {
  growth_weight: 0.35,
  growth_floor: -40,
  growth_cap: 80,
  maturity_floor: 0.55,
  maturity_range: 0.45,
  maturity_days: 1460,
  unknown_age_days: 270,
  breadth_per_chain: 0.03,
  breadth_max_extra_chains: 8,
  multiple_min: 0.02,
  multiple_max: 2.5,
  min_live_for_category: 3,
};

/** Categories the watchlist rule treats as products of a token that already trades. */
const PRODUCT_CATEGORIES = new Set([
  'Bridge',
  'Canonical Bridge',
  'Cross Chain Bridge',
  'Liquid Staking',
  'Liquid Restaking',
  'Restaked BTC',
  'CEX',
]);

/** Name prefixes that mark an exchange's own product. */
const EXCHANGE_PREFIXES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];

/** A version marker at the end of a name: a pool or release of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** A whole word that marks a wrapped or staked product. */
const PRODUCT_WORD = /\b(wrapped|staked|staking)\b/i;

/** Whether the protocol records no token of its own. */
export function recordsNoToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** Whether the protocol is a wrapped, staked or bridged product of a token that already trades. */
export function isProductOfLiveToken(p: SnapshotProtocol): boolean {
  if (p.category !== null && PRODUCT_CATEGORIES.has(p.category)) return true;
  if (PRODUCT_WORD.test(p.name)) return true;
  if (VERSIONED.test(p.name)) return true;
  const lower = p.name.toLowerCase();
  return EXCHANGE_PREFIXES.some((x) => lower.startsWith(x.toLowerCase()));
}

/** Whether the board may rank the protocol: no token on record, and not a product of one that trades. */
export function isRankable(p: SnapshotProtocol): boolean {
  return recordsNoToken(p) && !isProductOfLiveToken(p);
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

/** The calibration: one base multiple per category, read off the live-token protocols. */
export interface Calibration {
  overall_multiple: number;
  by_category: Record<string, { multiple: number; live_count: number }>;
  live_count: number;
}

/** Calibrate the base multiple from the snapshot's own live-token protocols. */
export function calibrate(snapshot: Snapshot): Calibration {
  const live = snapshot.protocols.filter(
    (p) => !recordsNoToken(p) && p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0 && p.category !== 'CEX',
  );
  const allRatios = live.map((p) => p.mcap_usd! / p.tvl_usd);
  const overall = allRatios.length > 0 ? median(allRatios) : 0.25;
  const grouped = new Map<string, number[]>();
  for (const p of live) {
    const key = p.category ?? 'Other';
    const list = grouped.get(key) ?? [];
    list.push(p.mcap_usd! / p.tvl_usd);
    grouped.set(key, list);
  }
  const byCategory: Calibration['by_category'] = {};
  for (const [key, ratios] of [...grouped.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (ratios.length >= MODEL.min_live_for_category) {
      byCategory[key] = { multiple: clampMultiple(median(ratios)), live_count: ratios.length };
    }
  }
  return { overall_multiple: clampMultiple(overall), by_category: byCategory, live_count: live.length };
}

function clampMultiple(m: number): number {
  return Math.min(MODEL.multiple_max, Math.max(MODEL.multiple_min, m));
}

/** The base multiple one protocol gets: its category's median, else the snapshot-wide median. */
export function multipleFor(p: SnapshotProtocol, cal: Calibration): { multiple: number; source: string } {
  const key = p.category ?? 'Other';
  const hit = cal.by_category[key];
  if (hit) return { multiple: hit.multiple, source: `median of ${hit.live_count} live ${key} protocols` };
  return { multiple: cal.overall_multiple, source: `snapshot-wide median of ${cal.live_count} live protocols` };
}

export interface Scored {
  implied: number;
  multiple: number;
  multiple_source: string;
  growth_pct: number;
  growth_mult: number;
  maturity_mult: number;
  breadth_mult: number;
  age_days: number | null;
}

/** The implied value of one protocol, and every factor that produced it. */
export function scoreProtocol(p: SnapshotProtocol, asOf: string, cal: Calibration): Scored {
  const age = ageDays(asOf, p.listed_at);
  const { multiple, source } = multipleFor(p, cal);
  const rawGrowth = p.change_7d !== null && Number.isFinite(p.change_7d) ? p.change_7d : 0;
  const growthPct = Math.min(MODEL.growth_cap, Math.max(MODEL.growth_floor, rawGrowth));
  const growthMult = 1 + (growthPct / 100) * MODEL.growth_weight;
  const ageForModel = age ?? MODEL.unknown_age_days;
  const maturityMult =
    MODEL.maturity_floor + (Math.min(Math.max(ageForModel, 0), MODEL.maturity_days) / MODEL.maturity_days) * MODEL.maturity_range;
  const breadthMult = 1 + MODEL.breadth_per_chain * Math.min(Math.max(p.chains.length - 1, 0), MODEL.breadth_max_extra_chains);
  const implied = Math.max(1, Math.round(p.tvl_usd * multiple * growthMult * maturityMult * breadthMult));
  return {
    implied,
    multiple,
    multiple_source: source,
    growth_pct: growthPct,
    growth_mult: growthMult,
    maturity_mult: maturityMult,
    breadth_mult: breadthMult,
    age_days: age,
  };
}

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

function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** Working capital for one position, scaled to the protocol's own TVL. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 2_000_000_000) return 300;
  if (p.tvl_usd >= 500_000_000) return 200;
  if (p.tvl_usd >= 100_000_000) return 120;
  if (p.tvl_usd >= 25_000_000) return 80;
  return 50;
}

/** Gas for one transaction on the protocol's first chain, in whole dollars. */
function gasFor(chain: string): number {
  const cheap = ['Base', 'Arbitrum', 'Optimism', 'Polygon', 'BSC', 'BNB Chain', 'Avalanche', 'Solana', 'Sui', 'Aptos', 'Linea', 'Scroll', 'zkSync Era', 'Mantle', 'Blast'];
  return cheap.includes(chain) ? 1 : 6;
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
    return `Supply $${capital} of USDC to ${name} on ${chain}, then borrow a small amount against it and repay, so the wallet shows both sides of the market.`;
  }
  if (c.includes('dex') || c.includes('liquidity')) {
    return `Add $${capital} of liquidity to ${name}'s deepest pool on ${chain} and stake the LP position if the app offers a farm for it.`;
  }
  if (c.includes('perpetual') || c.includes('derivative') || c.includes('basis')) {
    return `Deposit $${capital} of USDC as margin on ${name} and open one small, hedged position; close and reopen it weekly to build volume.`;
  }
  if (c.includes('curator') || c.includes('allocator') || c.includes('yield')) {
    return `Deposit $${capital} into one of ${name}'s vaults on ${chain} and keep the vault shares in the same wallet.`;
  }
  if (c.includes('stable')) {
    return `Mint $${capital} of the stable asset through ${name} on ${chain} and hold it, or pair it in the protocol's own liquidity pool.`;
  }
  if (c.includes('rwa')) {
    return `Buy or mint $${capital} of ${name}'s tokenised yield asset on ${chain} and hold it in the wallet.`;
  }
  if (c.includes('prediction')) {
    return `Fund $${capital} on ${name} and place small positions in at least three different markets.`;
  }
  if (c.includes('insurance')) {
    return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy active for the whole window.`;
  }
  if (c.includes('staking pool') || c.includes('farm')) {
    return `Stake $${capital} of the pool asset through ${name} on ${chain} and keep the receipt token.`;
  }
  if (c.includes('chain')) {
    return `Bridge $${capital} of USDC to ${chain} and make one native transaction a week (a swap, a mint or a vote) so the wallet stays active.`;
  }
  if (c.includes('index')) {
    return `Buy $${capital} of ${name}'s index token on ${chain} and hold it; rebalance only when the index itself does.`;
  }
  if (c.includes('card') || c.includes('payment')) {
    return `Open a ${name} account, fund $${capital}, and make one small payment a week so the account shows steady use.`;
  }
  return `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open for the full window.`;
}

/**
 * The farm plan: seven steps derived from the protocol's own record — category, chains, TVL and
 * age decide the action, the capital, the gas and the hold. Costs are stated per step and summed
 * in the last one. No name is special-cased.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): FarmStep[] {
  const chain = chainOf(p);
  const capital = capitalFor(p);
  const gas = gasFor(chain);
  const hold = holdDaysFor(age);
  const weeks = Math.max(4, Math.round(hold / 7));
  const weeklyCost = gas + 1;
  const totalGas = gas * 3 + weeklyCost * weeks;
  return [
    {
      text: `Start from a fresh wallet funded only with what you plan to farm, and write the seed phrase down offline.`,
      cost: `about $${gas} of gas on ${chain} for the first transaction`,
      time: '5 minutes',
    },
    {
      text: actionFor(p, capital, chain),
      cost: `$${capital} of working capital and about $${gas * 2} of gas to set up`,
      time: '15 minutes',
    },
    {
      text: `Repeat one qualifying action every week for ${weeks} weeks (a deposit, a swap, a borrow or a vote), so the wallet is active in every weekly snapshot.`,
      cost: `about $${weeklyCost} of gas a week, roughly $${weeklyCost * weeks} over the window`,
      time: '10 minutes a week',
    },
    {
      text: `Hold the position for at least ${hold} days; airdrop snapshots usually reward wallets that stayed, not wallets that visited once.`,
      cost: `the $${capital} stays locked in the position; nothing more out of pocket`,
      time: `${hold} days`,
    },
    {
      text: `Watch the protocol's own announcements for a points programme or a token generation event, and re-check this board's implied value against any official tokenomics.`,
      cost: 'nothing; never pay anyone to be included in a snapshot',
      time: '5 minutes a week',
    },
    {
      text: `When a claim opens, claim only from the link on the protocol's own site, keep at least 10% of any airdrop for 30 days in case of a second snapshot, and sell the rest in tranches.`,
      cost: `about $${gas} of gas to claim`,
      time: '20 minutes',
    },
    {
      text: `Log the wallet, the dates, the capital and every transaction. Total expected spend for this plan: $${capital} of capital (recoverable on exit) plus about $${totalGas} of gas over ${hold} days.`,
      cost: 'nothing but the log',
      time: '5 minutes',
    },
  ];
}

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
  implied_value_usd: number;
  model: {
    multiple: number;
    multiple_source: string;
    growth_pct: number;
    growth_multiplier: number;
    maturity_multiplier: number;
    breadth_multiplier: number;
  };
  farm_steps: string[];
}

/** A protocol set aside because its token already trades, or it is a product of one that does. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
  kind: 'live-token' | 'wrapped-or-staked-product';
}

/** Everything the dashboard renders. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model_version: string;
  model: typeof MODEL;
  calibration: Calibration;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  product_size: number;
  total_implied_usd: number;
  rows: BoardRow[];
  live: LiveRow[];
}

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/** The ranked board: every watchlist slug, plus every other rankable pre-token protocol. */
export function buildBoard(snapshot: Snapshot, cal: Calibration): BoardRow[] {
  const watchlist = new Set(snapshot.watchlist);
  const chosen = new Map<string, SnapshotProtocol>();
  for (const p of snapshot.protocols) {
    if (watchlist.has(p.slug) || isRankable(p)) chosen.set(p.slug, p);
  }
  const scored = [...chosen.values()].map((p) => ({ p, s: scoreProtocol(p, snapshot.as_of, cal) }));
  scored.sort((a, b) => b.s.implied - a.s.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  return scored.map(({ p, s }, i) => ({
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
    implied_value_usd: s.implied,
    model: {
      multiple: round4(s.multiple),
      multiple_source: s.multiple_source,
      growth_pct: s.growth_pct,
      growth_multiplier: round4(s.growth_mult),
      maturity_multiplier: round4(s.maturity_mult),
      breadth_multiplier: round4(s.breadth_mult),
    },
    farm_steps: farmSteps(p, s.age_days).map(stepText),
  }));
}

/** The set-aside protocols: tokens that already trade, and products of tokens that do. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  const all = snapshot.protocols
    .filter((p) => !isRankable(p) && p.category !== 'CEX')
    .map((p): LiveRow => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
      kind: recordsNoToken(p) ? 'wrapped-or-staked-product' : 'live-token',
    }));
  const live = all
    .filter((r) => r.kind === 'live-token')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : 1))
    .slice(0, 40);
  const products = all
    .filter((r) => r.kind === 'wrapped-or-staked-product')
    .sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : 1))
    .slice(0, 20);
  return [...live, ...products];
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
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
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
export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData } {
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
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: board.filter((r) => !r.on_watchlist).length,
    live_size: live.filter((r) => r.kind === 'live-token').length,
    product_size: live.filter((r) => r.kind === 'wrapped-or-staked-product').length,
    total_implied_usd: board.reduce((sum, r) => sum + r.implied_value_usd, 0),
    rows: board,
    live,
  };
  return { board, radar };
}

/** The dashboard's dataset as one script: no fetch, no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
