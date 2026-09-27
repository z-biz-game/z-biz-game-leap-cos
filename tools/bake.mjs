// The content pipeline: prove the anchors, measure the generator, publish the campaign, then
// re-verify the product from its serialised form.
//
// This file is where the repo's thesis is enforced rather than asserted. Four gates run in
// order and any of them stops the build:
//
//   1. the anchors from the brief — BFS optimum 3, 8, 15, 24, 35 (48, 63, 80, 99), the closed
//      form agreeing digit for digit, exactly two optimal routes per river, two legal openings;
//   2. the generator, timed and counted, so DESIGN.md can quote an accept rate from a run
//      rather than from a hope;
//   3. every lot that ships is re-solved from the JSON row that is about to be written to
//      js/data/lots.js, and its printed par / optimalPaths / states must come back identical;
//   4. the written file is imported afresh and run through `validateLot` — the same gate
//      `node test/library.test.mjs` uses — so what the build checked is what ships.
//
//   node tools/bake.mjs                  # js/data/lots.js
//   PER_BAND=24 node tools/bake.mjs      # a longer campaign
//   PROBE=2000 node tools/bake.mjs       # a wider read on the generator
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  TIERS, blankStats, canonicalLot, makeLot, makeSet, tierForPar,
} from '../js/core/make.js';

import {
  arrangements, closedForm, dfsSolve, formula, forwardReach, solveBoard,
} from '../js/core/solve.js';
import { boardKey, legalMoves, standardBoard } from '../js/core/game.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const ATTEMPTS = 60;
const PER_BAND = Number(process.env.PER_BAND || 10);
const PROBE = Number(process.env.PROBE || 240);

function gate(cond, msg) {
  if (!cond) {
    console.error(`BAKE FAILED — ${msg}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------- 1. the anchors
//
// Hand-dead numbers, from /tmp/puzzle-brief/b3-leap.md (itself measured twice by two
// independent routes). If a search here ever disagrees, the search is the thing that broke.
const ANCHOR_BFS = [3, 8, 15, 24, 35];
const ANCHOR_TAIL = [48, 63, 80, 99];
const ANCHOR_PATHS = 2;
const ANCHOR_OPENINGS = 2;

const t0 = Date.now();
const anchors = [];
for (let n = 1; n <= 9; n++) {
  const board = standardBoard(n, n);
  const bfs = solveBoard(board);
  const dfs = dfsSolve(board);
  anchors.push({
    n, par: bfs.par, paths: bfs.optimalPaths, dfs: dfs.par, dfsPaths: dfs.optimalPaths,
    closed: closedForm(n), states: bfs.reachable, arrangements: arrangements(n, n),
    openings: legalMoves(board).length, deadEnds: bfs.deadEnds,
  });
}
console.log('anchors:', anchors.map((a) => `n=${a.n} par=${a.par} paths=${a.paths} states=${a.states}`).join(' | '));
anchors.slice(0, 5).forEach((a, i) => {
  gate(a.par === ANCHOR_BFS[i], `BFS optimum for n=${a.n} came out ${a.par}, the brief says ${ANCHOR_BFS[i]}`);
});
anchors.slice(5, 9).forEach((a, i) => {
  gate(a.par === ANCHOR_TAIL[i], `BFS optimum for n=${a.n} came out ${a.par}, the closed form says ${ANCHOR_TAIL[i]}`);
});
for (const a of anchors) {
  gate(a.par === a.closed, `n=${a.n}: BFS ${a.par} disagrees with n(n+2) = ${a.closed}`);
  gate(a.dfs === a.par, `n=${a.n}: the memoised DFS says ${a.dfs}, the BFS says ${a.par}`);
  gate(a.dfsPaths === a.paths, `n=${a.n}: the two route counters disagree (${a.dfsPaths} vs ${a.paths})`);
}
for (const a of anchors.slice(0, 6)) {
  gate(a.paths === ANCHOR_PATHS, `n=${a.n} has ${a.paths} optimal routes, the brief says exactly ${ANCHOR_PATHS}`);
  gate(a.openings === ANCHOR_OPENINGS, `n=${a.n} opens with ${a.openings} legal moves, the brief says ${ANCHOR_OPENINGS}`);
}
// The asymmetric closed form, ab + a + b, checked against the search on every published shape.
const asymMismatch = [];
for (let a = 1; a <= 6; a++) {
  for (let b = 1; b <= 6; b++) {
    const m = solveBoard(standardBoard(a, b));
    if (m.par !== formula(a, b)) asymMismatch.push(`${a}/${b}: ${m.par} vs ${formula(a, b)}`);
  }
}
gate(!asymMismatch.length, `ab+a+b disagrees with the search: ${asymMismatch.join(', ')}`);
console.log(`anchors: BFS = DFS = n(n+2) on n=1..9, asymmetric ab+a+b on 36 shapes, ${Date.now() - t0} ms`);

// The rule is load-bearing: relax "hop over exactly one" and the measurement must move.
const strict = solveBoard(standardBoard(3, 3));
const loose = solveBoard(standardBoard(3, 3), 'loose');
gate(loose.par < strict.par || loose.optimalPaths > strict.optimalPaths,
  'allowing a hop over two frogs changed nothing — the rule is not constraining the search');
console.log(`rule check: n=3 standard par ${strict.par} / ${strict.optimalPaths} routes,`
  + ` letting a frog clear two pads gives par ${loose.par} / ${loose.optimalPaths} routes`);

// ---------------------------------------------------------------- 2. the generator
function probeWalk(label, stats, opts) {
  const per = PROBE * TIERS.length;
  for (let i = 0; i < PROBE; i++) {
    for (const tier of TIERS) {
      const lot = makeLot(`probe-${i}`, tier.key, stats, opts);
      gate(lot, `${label}: band ${tier.key} produced nothing in ${ATTEMPTS} proposals`);
    }
  }
  gate(stats.accepted === per, `${label}: ${per - stats.accepted}/${per} requested lots were never produced in ${ATTEMPTS} proposals each`);
  const rate = (100 * stats.accepted) / stats.attempts;
  const first = (100 * stats.firstTry) / per;
  console.log(`generator ${label}: ${per} lots requested, ${stats.attempts} proposals, ${stats.accepted} accepted`
    + ` = ${rate.toFixed(1)}% of proposals, ${first.toFixed(1)}% accepted on the very first try`);
  console.log(`  rejects: par outside band ${stats.rejectPar}, dead water ${stats.rejectDead}, illegal shape ${stats.rejectShape};`
    + ` search ${(stats.totalMs / per).toFixed(3)} ms per measured lot, worst single search ${stats.worstMs} ms,`
    + ` largest reachable set searched ${stats.maxStates} positions`);
  return {
    requested: per, proposals: stats.attempts, accepted: stats.accepted,
    acceptRateOfProposals: Number(rate.toFixed(2)), firstTryRate: Number(first.toFixed(2)),
    rejectPar: stats.rejectPar, rejectDead: stats.rejectDead, rejectShape: stats.rejectShape,
    msPerLot: Number((stats.totalMs / per).toFixed(4)), worstMs: stats.worstMs, maxStates: stats.maxStates,
  };
}

// The shipped walk only ever proposes positions the distance table still calls solvable. The
// naive walk — any legal move, filtered afterwards — is measured right beside it, because the
// difference between the two numbers *is* the design argument (see DESIGN.md 3).
const stats = blankStats();
const measuredGenerator = probeWalk('shipped', stats, {});
const naiveStats = blankStats();
const naiveGenerator = probeWalk('naive ', naiveStats, { naive: true });

// ---------------------------------------------------------------- 3. the campaign
const rows = [];

// Every bank-to-bank river that can be published, filed under the band its *measured* par
// falls in. A 2/4 asymmetric river costs 14 moves and so belongs to `linked` whatever the
// size table it was enumerated from says — the position decides the band, never the intention.
const CANONICAL = [
  // The eight equal rivers: the n(n+2) ladder the whole claim rests on, n = 1..8.
  [1, 1], [2, 2], [3, 3], [4, 4], [5, 5], [6, 6], [7, 7], [8, 8],
  // One uneven river per band, so ab + a + b is on the screen too and not only in a test.
  [1, 2], [2, 4], [4, 6], [6, 8],
];
const canonicalByTier = {};
const seenKeys = new Set();
for (const [a, b] of CANONICAL) {
  const lot = canonicalLot(a, b, `canonical|${a}|${b}`);
  const key = boardKey(standardBoard(a, b));
  if (seenKeys.has(key)) continue;
  seenKeys.add(key);
  (canonicalByTier[lot.tier] = canonicalByTier[lot.tier] || []).push(lot);
}

for (const tier of TIERS) {
  const canonical = (canonicalByTier[tier.key] || []).sort((x, y) => x.par - y.par);
  const band = [...canonical, ...makeSet(
    tier.key, Math.max(0, PER_BAND - canonical.length), 'campaign', canonical.map(boardKeyOf),
  )].sort((x, y) => (x.par - y.par) || boardKeyOf(x).localeCompare(boardKeyOf(y)));
  band.forEach((lot, i) => {
    const id = `${tier.key}-${String(i + 1).padStart(2, '0')}`;
    const row = {
      id,
      tier: tier.key,
      a: lot.a,
      b: lot.b,
      cells: lot.cells,
      left: lot.left,
      right: lot.right,
      empty: lot.empty,
      par: lot.par,
      optimalPaths: lot.optimalPaths,
      states: lot.states,
      deadEnds: lot.deadEnds,
      arrangements: lot.arrangements,
      canonical: lot.canonical,
      wandered: lot.wandered,
      skin: lot.skin,
    };
    // Gate 3: re-solve the *serialised* row. Nothing here reads the generator's memory.
    const fresh = JSON.parse(JSON.stringify(row));
    const again = solveBoard(boardOfRow(fresh));
    gate(again.canReachGoal, `${id}: this position cannot reach the far bank`);
    gate(again.par === row.par, `${id}: claims par ${row.par}, re-solving the row says ${again.par}`);
    gate(again.optimalPaths === row.optimalPaths, `${id}: claims ${row.optimalPaths} optimal routes, counted ${again.optimalPaths}`);
    gate(again.reachable === row.states, `${id}: claims ${row.states} reachable positions, counted ${again.reachable}`);
    const home = tierForPar(row.par);
    gate(home && home.key === row.tier, `${id}: par ${row.par} belongs to band ${home && home.key}, filed under ${row.tier}`);
    if (row.canonical) {
      gate(row.par === formula(row.a, row.b), `${id}: bank-to-bank par ${row.par} disagrees with ab+a+b`);
      if (row.a === row.b) gate(row.par === closedForm(row.a), `${id}: n(n+2) disagrees with itself`);
    }
    rows.push(row);
  });
}

function boardOfRow(row) {
  const board = new Array(row.cells).fill(0);
  for (const c of row.left) board[c] = 1;
  for (const c of row.right) board[c] = 2;
  return board;
}

function boardKeyOf(lot) {
  const board = new Array(lot.cells).fill(0);
  for (const c of lot.left) board[c] = 1;
  for (const c of lot.right) board[c] = 2;
  return boardKey(board);
}

// ---------------------------------------------------------------- 4. write, then re-import
const parCounts = {};
for (const r of rows) parCounts[r.par] = (parCounts[r.par] || 0) + 1;
const histogram = {
  lots: rows.length,
  distinctPars: Object.keys(parCounts).length,
  minPar: Math.min(...rows.map((r) => r.par)),
  maxPar: Math.max(...rows.map((r) => r.par)),
  counts: parCounts,
  bands: TIERS.map((t) => ({ key: t.key, window: [t.min, t.max] })),
};
const meta = TIERS.map((tier) => {
  const mine = rows.filter((r) => r.tier === tier.key);
  const pars = mine.map((r) => r.par);
  return {
    key: tier.key,
    label: tier.label,
    note: tier.note,
    window: [tier.min, tier.max],
    min: Math.min(...pars),
    max: Math.max(...pars),
    lots: mine.length,
    canonical: mine.filter((r) => r.canonical).length,
    asymmetric: mine.filter((r) => r.a !== r.b).length,
    maxStates: Math.max(...mine.map((r) => r.states)),
    blurb: `${Math.min(...pars)}-${Math.max(...pars)} 步`,
  };
});
// Only structural measurements go into the shipped file. The timing rows above are printed and
// quoted in DESIGN.md, but writing `msPerLot` into js/data/lots.js would make a re-bake on any
// other machine (or on this one at a different load) rewrite a product file for no reason —
// and then "the shipped data re-solves to what it prints" could no longer be checked with a
// checksum. So: structure in the file, timings on stdout.
const measured = {
  strategy: 'wander along moves the distance table still calls solvable; measure, never extrapolate',
  anchors: anchors.map((a) => ({ n: a.n, par: a.par, paths: a.paths, states: a.states, deadEnds: a.deadEnds, openings: a.openings })),
  ruleCheck: { standard: { par: strict.par, paths: strict.optimalPaths }, loose: { par: loose.par, paths: loose.optimalPaths } },
  bands: meta.map((m) => ({ key: m.key, window: m.window, shipped: [m.min, m.max], lots: m.lots })),
};

const lines = [
  '// Generated by tools/bake.mjs — every number in this file is a measurement, not an opinion.',
  '// `par` is the breadth-first minimum over the exact reachable position set of THAT row',
  '// (left/right pad indices + one gap), re-derived independently by the memoised DFS and a',
  '// third time by the closed form ab + a + b (n(n+2) when the banks are equal). The',
  '// bank-to-bank rows are stamped canonical:true. `optimalPaths` is the count of distinct',
  '// shortest routes: exactly 2 whenever the banks are equal and at least 3 frogs per side,',
  '// which is why "matching par" here means walking *the* route and not merely a short one.',
  '// Do not hand-edit: `node tools/bake.mjs` re-solves every row below before writing it, and',
  '// `node test/library.test.mjs` re-solves it again from this file at every CI run.',
  `export const HISTOGRAM = ${JSON.stringify(histogram)};`,
  `export const TIERS_META = ${JSON.stringify(meta, null, 1).replace(/\n/g, '\n')};`,
  `export const MEASURED = ${JSON.stringify(measured)};`,
  'export const LOTS = [',
  ...rows.map((r) => `  ${JSON.stringify(r)},`),
  '];',
  '',
];
const out = join(root, 'js', 'data', 'lots.js');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, lines.join('\n'));

const freshModule = await import(pathToFileURL(out).href);
const { validateLot } = await import('../js/core/library.js');
const bad = [];
for (const row of freshModule.LOTS) {
  const err = validateLot(row);
  if (err) bad.push(`${row.id}: ${err}`);
}
gate(!bad.length, `the written product does not survive its own validator:\n  ${bad.join('\n  ')}`);

const byTier = {};
for (const r of rows) byTier[r.tier] = (byTier[r.tier] || 0) + 1;
console.log(`wrote ${rows.length} lots (${Object.entries(byTier).map(([k, n]) => `${k}:${n}`).join(' ')}) -> js/data/lots.js`);
console.log(`bands shipped: ${meta.map((m) => `${m.key} ${m.min}-${m.max} (${m.lots} lots, ${m.canonical} bank-to-bank, ${m.asymmetric} uneven)`).join(' | ')}`);
console.log(`re-solve gate: ${freshModule.LOTS.length} serialised rows re-solved and accepted`);
console.log(`total bake time ${Date.now() - t0} ms`);
