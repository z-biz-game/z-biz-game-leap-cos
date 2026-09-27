// The lot generator: a seed in, a measured river out.
//
// A lot is *not* "n frogs per side" — that would make difficulty a size knob and `par` a
// lookup. A lot is a position: the canonical bank-to-bank start, or a mid-river position
// reached by letting some frogs hop a few legal steps forward and then asking the solver what
// the rest of the crossing costs. The same river width therefore carries a whole range of
// measured difficulties, and the number only exists after the search has run.
//
// Everything is a pure function of the seed (`hashSeed` + `mulberry32`, js/core/rng.js), so a
// `#/lot/<id>` link and the daily river resolve to the same pads on every device with nothing
// to carry. Generation happens at bake time for the shipped campaign and on route change for
// `#/random`; it is a bounded search over one river's own state space, never on a frog tap,
// and the third timing row in tools/bake.mjs is where its cost is measured and printed.

import { rngFrom } from './rng.js';
import { applyMove, boardKey, legalMoves, specOfBoard, standardBoard } from './game.js';
import { solveBoard, arrangements, goalTable } from './solve.js';

// Bands are cut on the measured `par`, and they are contiguous: every position that can be
// solved has exactly one home. For the canonical bank-to-bank starts the windows line up with
// the brief's n-based ranges exactly (n<=2 shoal, 3..4 linked, 5..6 twined, 7..8 master),
// which test/make.test.mjs asserts row by row; the in-between numbers belong to the
// mid-river and asymmetric lots the brief leaves unspecified.
export const TIERS = [
  {
    key: 'shoal', label: '浅滩', min: 3, max: 8,
    sizes: [[1, 1], [2, 2], [1, 2], [2, 1]], wanderMax: 2, asymmetric: false,
    blurb: '3-8 步', note: '两三只蛙一段浅水',
  },
  {
    key: 'linked', label: '莲塘', min: 9, max: 24,
    sizes: [[3, 3], [4, 4], [1, 4], [2, 3]], wanderMax: 10, asymmetric: true,
    blurb: '9-24 步', note: '对岸已在望，路还长',
  },
  {
    key: 'twined', label: '曲流', min: 25, max: 48,
    sizes: [[5, 5], [6, 6], [2, 4], [3, 4]], wanderMax: 14, asymmetric: true,
    blurb: '25-48 步', note: '十只蛙要互相让路',
  },
  {
    key: 'master', label: '深渡', min: 49, max: 120,
    sizes: [[7, 7], [8, 8], [8, 7], [7, 8]], wanderMax: 20, asymmetric: true,
    blurb: '49 步起', note: '两岸齐平只有一条最短路线',
  },
];

// No lot is ever published wider than this: the closed-form story dies past n=8 (see spec 6),
// and so does the readability of the screen.
export const MAX_BANK = 8;
export const MAX_CELLS = MAX_BANK * 2 + 1;
const ATTEMPTS = 60;

export function tierByKey(key) {
  const t = TIERS.find((x) => x.key === key);
  if (!t) throw new Error(`unknown tier '${key}' — have ${TIERS.map((x) => x.key).join(', ')}`);
  return t;
}

export function tierForPar(par) {
  return TIERS.find((t) => par >= t.min && par <= t.max) || null;
}

export function validateShape(a, b) {
  if (!Number.isInteger(a) || !Number.isInteger(b)) return 'frog counts must be integers';
  if (a < 1 || b < 1) return 'both banks need at least one frog';
  if (a > MAX_BANK || b > MAX_BANK) return `a bank of ${Math.max(a, b)} frogs is past the published ${MAX_BANK}`;
  if (a + b + 1 > MAX_CELLS) return `river of ${a + b + 1} pads is past the published ${MAX_CELLS}`;
  return null;
}

// The display-only half of a lot: which water, how wide the river looks, how the reeds sit.
// Deliberately not part of the difficulty claim, and never read by the solver — but it *is*
// part of the seed, so a shared link shows the same river.
function skinFrom(rng, cells) {
  return {
    hue: rng.range(150, 215),      // pond green -> dusk blue, the one colour the water takes
    reeds: rng.int(5),
    lily: rng.int(3),
    ripple: rng.int(4),
    width: cells,                  // pads drawn; the geometry the view lays out from
  };
}

// The "wander": let the river run a few legal moves forward from its banks, so a lot can be a
// mid-river position rather than only a size. Two ways to do it, and the difference between
// them is the reason this file exists:
//
//   naive    — pick any legal move. Frogs cannot step back, and (test/solve.test.mjs proves it
//              for n = 1..6) every legal move out of a solvable position either spends exactly
//              one unit of distance or ends the crossing for good, so a naive walk strands most
//              of its proposals: measured at 17.3% accepted, 43% of proposals rejected as dead
//              water. Those lots then have to be thrown away.
//   solvable — pick only a move the distance table still calls solvable. Every proposal then
//              needs measuring rather than filtering, and the reject counters stay at zero for
//              a *good* reason: the generator cannot produce an unsolvable lot.
//
// Either way `par` is whatever `solveBoard` says afterwards; the walk only decides where to
// look. The printed number is never taken from the closed form.
function wanderFrom(board, steps, rng, opts = {}) {
  let cur = board.slice();
  if (opts.naive) {
    for (let i = 0; i < steps; i++) {
      const moves = legalMoves(cur);
      if (!moves.length) break;
      cur = applyMove(cur, moves[rng.int(moves.length)]);
    }
    return cur;
  }
  const table = goalTable(board);
  for (let i = 0; i < steps; i++) {
    const moves = legalMoves(cur).filter((m) => table.dist.get(boardKey(applyMove(cur, m))) !== undefined);
    if (!moves.length) break;              // solved, or every hop onward is fatal
    cur = applyMove(cur, moves[rng.int(moves.length)]);
  }
  return cur;
}

// `attempts` counts every proposal the loop made, `accepted` the ones that shipped, and the
// three reject counters say *why* the rest did not. The accept rate quoted in DESIGN.md is
// accepted/attempts from one measured run of tools/bake.mjs, never a rounded-down guess.
export function blankStats() {
  return {
    attempts: 0, accepted: 0, firstTry: 0, rejectPar: 0, rejectDead: 0, rejectShape: 0,
    worstMs: 0, totalMs: 0, maxStates: 0,
  };
}

function bill(stats, reason) {
  if (!stats) return;
  if (reason === 'par') stats.rejectPar++;
  else if (reason === 'dead') stats.rejectDead++;
  else if (reason === 'shape') stats.rejectShape++;
}

// The bank-to-bank river: every frog on its own bank, the single free pad between them. This
// is the position the closed form is *about*, so it is measured like any other lot and then
// checked against `ab + a + b` by tools/bake.mjs rather than being handed the number.
export function canonicalLot(a, b, seed = `canonical|${a}|${b}`) {
  const err = validateShape(a, b);
  if (err) throw new Error(err);
  const board = standardBoard(a, b);
  const measured = solveBoard(board);
  const spec = specOfBoard(board);
  const tier = tierForPar(measured.par);
  if (!tier) throw new Error(`a ${a}/${b} river measures ${measured.par} moves, outside every published band`);
  return {
    tier: tier.key,
    a, b,
    cells: board.length,
    left: spec.left,
    right: spec.right,
    empty: spec.empty,
    par: measured.par,
    optimalPaths: measured.optimalPaths,
    states: measured.reachable,
    deadEnds: measured.deadEnds,
    arrangements: arrangements(a, b),
    canonical: true,
    wandered: 0,
    skin: skinFrom(rngFrom(String(seed)), board.length),
  };
}

// Build one lot. Returns null when nothing in `ATTEMPTS` tries landed inside the band, which
// the caller must treat as a build error rather than a surprise: an empty river is worse.
export function makeLot(seed, tierKey, stats = null, opts = {}) {
  const tier = tierByKey(tierKey);
  const rng = rngFrom(String(seed));
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    stats && stats.attempts++;
    const [a, b] = tier.sizes[rng.int(tier.sizes.length)];
    const shapeErr = validateShape(a, b);
    if (shapeErr) { bill(stats, 'shape'); continue; }
    const steps = rng.range(0, tier.wanderMax);
    const t0 = Date.now();
    const board = wanderFrom(standardBoard(a, b), steps, rng, opts);
    const measured = solveBoard(board);
    if (stats) {
      const ms = Date.now() - t0;
      stats.totalMs += ms;
      if (ms > stats.worstMs) stats.worstMs = ms;
      if (measured.reachable > stats.maxStates) stats.maxStates = measured.reachable;
    }
    if (!measured.canReachGoal) { bill(stats, 'dead'); continue; }
    const home = tierForPar(measured.par);
    if (!home || home.key !== tier.key) { bill(stats, 'par'); continue; }
    if (stats) {
      stats.accepted++;
      if (attempt === 0) stats.firstTry++;   // the band was hit on the first proposal
    }
    const spec = specOfBoard(board);
    return {
      tier: tier.key,
      a, b,
      cells: board.length,
      left: spec.left,
      right: spec.right,
      empty: spec.empty,
      par: measured.par,
      optimalPaths: measured.optimalPaths,
      states: measured.reachable,
      deadEnds: measured.deadEnds,
      arrangements: arrangements(a, b),
      canonical: steps === 0 && boardKey(board) === boardKey(standardBoard(a, b)),
      wandered: steps,
      skin: skinFrom(rng, board.length),
    };
  }
  return null;
}

// A whole band, spread over distinct positions: two lots with the same pads and the same par
// are one lot, so duplicates are dropped rather than padded out. opts passes through to
// makeLot (only bake uses `naive`, to measure what the shipped strategy avoids). `skipKeys` lets the caller
// hand over the positions it already published — the bank-to-bank anchors, in practice — so a
// wander of zero steps cannot ship the same river twice under two ids.
export function makeSet(tierKey, count, seedPrefix = 'set', skipKeys = [], opts = {}) {
  const out = [];
  const seen = new Set(skipKeys);
  for (let i = 0; out.length < count && i < count * 24; i++) {
    const lot = makeLot(`${seedPrefix}|${tierKey}|${i}`, tierKey, null, opts);
    if (!lot) break;
    const key = boardKeyFromLot(lot);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(lot);
  }
  return out;
}

export function boardKeyFromLot(lot) {
  const board = new Array(lot.cells).fill(0);
  for (const c of lot.left) board[c] = 1;
  for (const c of lot.right) board[c] = 2;
  return boardKey(board);
}

// The campaign order: cheapest measured par first, ties broken by the serialised position so
// the sequence is stable across machines.
export function sortLots(lots) {
  return lots.slice().sort((x, y) => (x.par - y.par) || boardKeyFromLot(x).localeCompare(boardKeyFromLot(y)));
}
