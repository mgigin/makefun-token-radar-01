# Token Radar — pre-token protocols ranked by fitted implied value

Entry for the make.fun bounty **token-radar-01** ("Build the best token launch radar").

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/mgigin/makefun-token-radar-01/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/mgigin/makefun-token-radar-01/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

## What it is

A program plus the dashboard it writes. `main.ts` (Node 22, standard library only) reads the
sealed DefiLlama snapshot, fits a value model on the snapshot's own live-token protocols,
validates it blind, ranks every protocol that records no token of its own by the fitted
implied launch value, gives each one a concrete farm plan, and writes a static dashboard a
reader can sort, filter and open per protocol. The dashboard opens on the **pre-token core**;
products of tokens that already trade (bridges, liquid staking / restaking, wrapped assets,
versioned deployments) are badged and sit behind a filter toggle, never in the default top
ranks. Protocols whose token already trades are set aside with the market's own figures,
never mixed into the ranking.

## The value model (radar-4, fitted)

The model is fitted, not hand-set. On the snapshot's live-token protocols (a recorded market
cap and TVL, CEX aside — 119 in this snapshot) the program fits, by ridge regression
(λ = 30 on every term but the intercept):

```
ln(mcap) = a + b·ln(TVL) + c·ln(1 + age_days) + d·tanh(change_7d / 75) + category offset
```

Category offsets are mean log residuals shrunk by `n / (n + 12)`, so a one-protocol category
cannot swing the board. The fitted slope b ≈ 0.43 is a comps curve: the market pays a falling
multiple as TVL grows, so implied value grows sublinearly with TVL. Age and growth terms are
fitted too; in this snapshot the data supports only small effects for them, and the ridge
penalty keeps them small rather than letting one noisy week move the board. Missing age
counts as 270 days and unreported growth as flat, stated wherever the figure is shown. The
same fitted function scores every row; no protocol name is special-cased, and every factor is
printed beside the row it produced.

## Blind validation

The fit is tested on data it did not fit, and the numbers ship in the dashboard:

- **5-fold cross-validation** over the live set (folds fixed by slug order): median absolute
  log error, share of predictions within 2× of the actual market cap, Spearman ρ.
- **Walk-forward**: fit on the older half by `listed_at`, score the newer half blind.
- Two baselines scored the same way: a constant shrunk category-median multiple (the
  hand-set approach) and a TVL-only log-log curve — so a reader can see what each term earns.

The dashboard also carries a **checks panel** answering the gate's own questions with this
run's measured numbers (watchlist coverage, board size, rank sequence, monotonicity, farm
plan shape, live-token separation, determinism).

The board holds 300 rows: all 40 watchlist protocols plus every other protocol that records
no token (CEX records aside — exchanges, not farmable protocols). Rows split into a
**pre-token core** (197) and **products** (103). Farm plans run 5–7 steps, each with an
explicit cost and time estimate derived from the protocol's category, chains, TVL and age.

## Verdicts

Every row carries a **FARM / THIN / SKIP** verdict from stated bars on the snapshot's own
figures — the same figures the model scores. **FARM**: a pre-token core protocol the fitted
curve values at $10M or more, not in freefall (7-day change at or above −10%, or unreported),
running at least a full quarter with no token (age 90+ days, or unreported), with
medium-or-better model confidence. **SKIP**: TVL in freefall (7-day change below −15%), an
implied value under $3M, or a product valued under $5M. Everything else is **THIN**;
products cap at THIN. The verdict is a triage label over the model's own figures, not a
second model — rank still comes from implied value alone. On this snapshot the bars land on
44 FARM, 214 THIN and 42 SKIP; the dashboard counts them at run time from the same verdicts
the pills show.

The dashboard opens with a KPI strip (protocols scanned, pre-token TVL, pre-token ranked,
live comps in the fit, FARM verdicts, blind CV error — all computed from the snapshot at
run time) and a log-log scatter of the comps fit beside the blind-validation panel.

## Run

```
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../kit/input/snapshot.json
```

Then open `out/dashboard/index.html`. The page reads `../data.js` (written by the same run)
and needs no network. Query parameters preset the view: `?detail=<slug>` opens a protocol's
detail drawer, `?q=`, `?cat=`, `?chain=`, `?kind=` preset the filters (the board opens on
`kind=pre-token`).

## Files

- `main.ts` — the program: snapshot in, board.json + data.js + dashboard + dossier out.
- `lib/model.ts` — the fitted value model, blind validation, farm-plan generator, gate
  self-check and checks panel data.
- `vendor/makefun-board.ts` — the kit's dossier library, byte for byte.
- `dashboard/` — the static page (index.html, app.css, app.js), rendered from `data.js`.
- `screenshots/` — the board, a protocol detail view, and a filtered view.

## Referral

Built for make.fun: https://make.fun/r/c6yw2yzb
