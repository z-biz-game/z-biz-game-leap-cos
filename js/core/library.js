// The lot pool the game reads from.
//
// Two kinds of row live here and they are deliberately different things:
//
//   * the campaign — the baked rows in js/data/lots.js. Each carries a stable id so
//     `#/lot/<id>` is a link another device can open, and it carries the par, the number of
//     optimal routes and the reachable-state count that `tools/bake.mjs` measured. Those three
//     numbers are *re-derived* here, from the serialised position and nothing else: a row
//     whose printed par disagrees with a fresh solve is a build error (`validateLot`), which is
//     what stops a hand-edit to a product file from shipping a difficulty nobody computed.
//   * daily / random — generated on the spot by js/core/make.js from the seed in the URL. Same
//     code path as the bake, so the same numbers, and still no search on a frog tap.
//
// Pure lookups plus a seed: no save file, no server, no device history involved.

import { LOTS, TIERS_META, MEASURED, HISTOGRAM } from '../data/lots.js';
import { boardKey, boardOfSpec, legalMoves, specOfBoard, standardBoard, validateSpec } from './game.js';
import { closedForm, formula, goalTable, solveBoard } from './solve.js';
import { MAX_BANK, TIERS, canonicalLot, makeLot, tierByKey } from './make.js';
import { hashSeed } from './rng.js';

export { TIERS, tierByKey, MEASURED, HISTOGRAM };

// ---------------------------------------------------------------- the re-solve

// Reason this row is not what it claims to be, or null. Every clause is a way a checked-in
// product could otherwise print a difficulty number that no search agrees with, and
// test/library.test.mjs drives each one with its own negative fixture.
export function validateLot(row) {
  if (!row || typeof row !== 'object') return 'not an object';
  if (typeof row.id !== 'string' || !row.id.length) return 'missing id';
  const tier = TIERS.find((t) => t.key === row.tier);
  if (!tier) return `unknown tier ${row.tier}`;
  if (!Number.isInteger(row.a) || !Number.isInteger(row.b) || row.a < 1 || row.b < 1) {
    return `bank counts ${row.a}/${row.b} impossible`;
  }
  if (row.a !== (row.left || []).length || row.b !== (row.right || []).length) {
    return `claims ${row.a}+${row.b} frogs but serialises ${(row.left || []).length}+${(row.right || []).length}`;
  }
  const specErr = validateSpec(row);
  if (specErr) return specErr;
  const board = boardOfSpec(row);
  if (boardKey(board) !== boardKey(standardBoard(row.a, row.b)) && row.canonical) {
    return `marked canonical but the pads are ${boardKey(board)}`;
  }
  const measured = solveBoard(board);
  if (!measured.canReachGoal) return `${row.id}: this position cannot reach the far bank at all`;
  if (measured.par !== row.par) return `printed par ${row.par}, a fresh solve says ${measured.par}`;
  if (measured.optimalPaths !== row.optimalPaths) {
    return `printed ${row.optimalPaths} optimal routes, counted ${measured.optimalPaths}`;
  }
  if (measured.reachable !== row.states) return `printed ${row.states} reachable pads, found ${measured.reachable}`;
  if (row.par < tier.min || row.par > tier.max) return `par ${row.par} outside band ${tier.key} ${tier.min}-${tier.max}`;
  if (row.canonical) {
    // A bank-to-bank row is the one position the closed form speaks about, so it is the row
    // where the printed par can be contradicted without running a search at all: n(n+2) for
    // equal banks, ab + a + b for unequal ones (test/solve.test.mjs shows the two agree).
    const byForm = formula(row.a, row.b);
    if (row.par !== byForm) return `canonical ${row.a}/${row.b}: ab+a+b says ${byForm}, row prints ${row.par}`;
    if (row.a === row.b && row.par !== closedForm(row.a)) return `canonical n=${row.a}: n(n+2) disagrees with itself`;
  }
  return null;
}

function prepare(row) {
  const err = validateSpec(row);
  if (err) throw new Error(`${row.id}: ${err}`);
  return {
    id: row.id,
    tier: row.tier,
    a: row.a,
    b: row.b,
    cells: row.cells,
    left: row.left.slice(),
    right: row.right.slice(),
    empty: row.empty,
    par: row.par,
    optimalPaths: row.optimalPaths,
    states: row.states,
    deadEnds: row.deadEnds,
    canonical: !!row.canonical,
    wandered: row.wandered,
    skin: row.skin,
    board: boardOfSpec(row),
    generated: false,
  };
}

export const ALL = LOTS.map(prepare);

export function lotsIn(key) {
  return ALL.filter((l) => l.tier === key);
}

export function byId(id) {
  return ALL.find((l) => l.id === id) || null;
}

export function lotAt(index) {
  return ALL[((index % ALL.length) + ALL.length) % ALL.length];
}

export const campaign = () => ALL;

// One goal-distance table per river, memoised in js/core/solve.js by position and rule set.
// Built when a lot is *loaded*, never when a frog is tapped: the hint, the "距对岸" field and
// the dead-water warning all read this one object.
export function tableFor(lot) {
  return goalTable(lot.board);
}

function wrap(lot, id, generated) {
  return {
    ...lot,
    id,
    generated: !!generated,
    board: boardOfSpec(lot),
    table: null,
  };
}

// Endless play inside one band. The seed is in the URL, so the link *is* the lot.
export function randomLot(seed, tierKey) {
  const tier = tierByKey(tierKey);
  const token = String(seed);
  const lot = makeLot(`random|${token}|${tier.key}`, tier.key);
  if (!lot) throw new Error(`no lot in band ${tier.key} came out of seed '${token}'`);
  const id = `rand-${tier.key}-${hashSeed(token).toString(36)}`;
  return wrap(lot, id, true);
}

function hashId(token) {
  let h = 2166136261;
  for (let i = 0; i < token.length; i++) {
    h ^= token.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

// One river per calendar day, the same for everybody. The date picks the size of the river and
// the colour of the water — and only the *bank-to-bank* start, because that is the position
// the closed form speaks about: whatever day it is, the par on screen is both a BFS distance
// and n(n+2), and `test/library.test.mjs` checks the daily row against both readings.
export function dailyLot(dateKey) {
  const n = 1 + (hashSeed(`daily-n|${dateKey}`) % MAX_BANK);
  const lot = canonicalLot(n, n, `daily|${dateKey}`);
  return wrap(lot, `daily-${dateKey}`, true);
}

// What the shipped pool actually holds, measured rather than claimed. README and
// deliverable.md copy their band table out of here, so it is asserted in
// test/library.test.mjs rather than eyeballed.
export function stats() {
  const byTier = {};
  for (const l of ALL) {
    const s = byTier[l.tier] || (byTier[l.tier] = {
      n: 0, min: Infinity, max: 0, pars: [], canonical: 0, asymmetric: 0, maxStates: 0, maxPaths: 0,
    });
    s.n++;
    s.pars.push(l.par);
    if (l.par < s.min) s.min = l.par;
    if (l.par > s.max) s.max = l.par;
    if (l.a !== l.b) s.asymmetric++;
    if (l.canonical) s.canonical++;
    if (l.states > s.maxStates) s.maxStates = l.states;
    if (l.optimalPaths > s.maxPaths) s.maxPaths = l.optimalPaths;
  }
  for (const s of Object.values(byTier)) {
    s.pars.sort((a, b) => a - b);
    s.distinctPars = new Set(s.pars).size;
    delete s.pars;
  }
  return {
    lots: ALL.length,
    byTier,
    tiers: TIERS_META,
    bands: TIERS.map((t) => ({ key: t.key, label: t.label, window: [t.min, t.max], lots: (byTier[t.key] || { n: 0 }).n })),
  };
}

// The number the whole repo is staked on, recomputed on the caller's machine rather than
// quoted: BFS over one river's reachable set, the closed form, and the independent DFS agree.
export function closedFormProof(n) {
  const board = standardBoard(n, n);
  const bfs = solveBoard(board);
  return {
    n,
    search: bfs.par,
    paths: bfs.optimalPaths,
    states: bfs.reachable,
    closedForm: closedForm(n),
    openings: legalMoves(board).length,
  };
}

export { specOfBoard, boardOfSpec };
