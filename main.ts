// Token Radar v2 (token-radar-01 entry, Node 22, standard library only).
//
// Reads the sealed snapshot at /input/snapshot.json, scores every protocol that records no
// token with the model in lib/model.ts, writes the ranked board to /output/board.json and the
// dashboard's data to /output/data.js, copies dashboard/ and screenshots/ into /output, and
// finishes with /output/dossier.json from the vendored make.fun library. The board rows in
// board.json carry the gate's fields; data.js carries the same rows plus the structured farm
// plan the page renders, so the screenshots and the code agree by construction.
//
// Local run:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../kit/input/snapshot.json

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardIssue, buildRadar, dataScript, parseSnapshot, type BoardRow, type RadarRow } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const here = fileURLToPath(new URL('.', import.meta.url));

const TEXT_MAX_BYTES = 65_536;
const SCREENSHOT_CAPS = { max: 4, max_bytes: 524_288 };
const IMAGE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

function arg(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < process.argv.length) return process.argv[at + 1]!;
  const withEquals = process.argv.find((a) => a.startsWith(`--${name}=`));
  return withEquals === undefined ? fallback : withEquals.slice(name.length + 3);
}

const inputArg = arg('input', '/input');
const inputFile = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
if (!existsSync(inputFile)) {
  process.stderr.write(`token radar: no snapshot at ${inputFile}: pass --input <snapshot.json|directory> or mount the sealed /input\n`);
  process.exit(2);
}
const out = arg('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

const snapshot = parseSnapshot(readFileSync(inputFile, 'utf8'));
const { board, radar } = buildRadar(snapshot);
const issue = boardIssue(board, snapshot);
if (issue !== null) {
  process.stderr.write(`token radar: the model wrote a board the gate refuses: ${issue}\n`);
  process.exit(1);
}

/** A board.json row: the gate's fields, in a fixed key order so both runs write the same bytes. */
function gateRow(r: RadarRow): BoardRow {
  return {
    rank: r.rank,
    slug: r.slug,
    name: r.name,
    category: r.category,
    chains: r.chains,
    tvl_usd: r.tvl_usd,
    change_7d: r.change_7d,
    listed_at: r.listed_at,
    age_days: r.age_days,
    on_watchlist: r.on_watchlist,
    kind: r.kind,
    implied_value_usd: r.implied_value_usd,
    model: r.model,
    farm_steps: r.farm_steps,
  };
}

mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'board.json'), `${JSON.stringify({ rows: board.map(gateRow) })}\n`);
writeFileSync(join(out, 'data.js'), dataScript(radar));

/** Copy one directory's regular files into `to`, skipping dot-names and subdirectories. */
function copyFiles(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const copied: string[] = [];
  for (const name of readdirSync(from).sort()) {
    if (name.startsWith('.')) continue;
    const path = join(from, name);
    if (!statSync(path).isFile()) continue;
    copyFileSync(path, join(to, name));
    copied.push(name);
  }
  return copied;
}

const dash = copyFiles(join(here, 'dashboard'), join(out, 'dashboard'));
// The dossier shows the dashboard's source whole only while it fits the text cap; refuse to
// hand in a page the judge would read cut in half.
const dashBytes = dash.reduce((sum, name) => sum + statSync(join(here, 'dashboard', name)).size, 0);
if (dashBytes > TEXT_MAX_BYTES) {
  process.stderr.write(`token radar: dashboard source is ${dashBytes} bytes, past the ${TEXT_MAX_BYTES}-byte dossier text cap: trim it\n`);
  process.exit(1);
}
const shots = copyFiles(join(here, 'screenshots'), join(out, 'screenshots'));
if (shots.length < 3 || shots.length > 4) {
  process.stderr.write(`token radar: screenshots/ holds ${shots.length} images: hand in 3 or 4 (board, detail view, filtered view)\n`);
  process.exit(1);
}
for (const name of shots) {
  if (!IMAGE_NAME.test(name)) {
    process.stderr.write(`token radar: screenshots/${name}: a name is letters, digits and . _ -, 1 to 128 characters\n`);
    process.exit(1);
  }
}

// The dossier is written last: the scorer rebuilds it from /output and compares bytes.
writeFileSync(
  join(out, 'dossier.json'),
  buildDossier(out, { text_max_bytes: TEXT_MAX_BYTES, screenshots: SCREENSHOT_CAPS, dashboard: { max_files: 400, max_bytes: 4_194_304 } }),
);

process.stdout.write(
  `token radar: ${snapshot.protocols.length} protocols, ${snapshot.watchlist.length} on the watchlist, ${board.length} rows ranked (${radar.core_size} pre-token core, ${radar.product_size} products, ${radar.early_size} below the floor)\n` +
    `token radar: wrote board.json, data.js, dashboard/ (${dash.length} files), screenshots/ (${shots.length} images) and dossier.json to ${out}\n`,
);
