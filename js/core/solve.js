// The measuring instruments. Everything in this file is a search over the *exact* reachable
// state space of one river — no sampling, no heuristics, no estimation.
//
// Two independent routes run over the same positions and must agree, which is what makes the
// printed `par` a fact instead of a claim:
//
//   1. `solveBoard`  — forward BFS from the start position, plus a backward BFS from the far
//                      bank, then a layer-by-layer count of the edges that lie on a shortest
//                      route. Breadth-first: distances fall out of the frontier order.
//   2. `countOptimalDFS` — a memoised depth-first search that never builds a frontier at all:
//                      it asks each position "what is the cheapest you can finish from here?"
//                      and sums the counts of the positions that achieve that answer. It only
//                      terminates because frogs walk forward, so the position graph is a DAG
//                      (js/core/game.js `potential`), which is asserted over the whole space.
//
// Both are then checked against the closed form n(n+2) for the bank-to-bank opening position.
// Three roads to the same integer, or the build fails.

import {
  applyMove, boardKey, counts, goalBoard, isGoal, legalMoves, reverseMoves,
  rulesOf, standardBoard,
} from './game.js';

const cache = new Map();

function cacheKey(board, opts) {
  const r = rulesOf(opts);
  return `${boardKey(board)}|${r.maxHopped}|${r.oppositeOnly ? 'opp' : 'any'}`;
}

// ---------------------------------------------------------------- forward sweep

// Every position reachable from `board`, with its minimum number of moves. Frogs never step
// backwards, so this set is strictly smaller than the set of all arrangements of the same
// frogs — `arrangements` reports both, because "how big was the search" is part of the claim.
export function forwardReach(board, opts) {
  const startKey = boardKey(board);
  const dist = new Map([[startKey, 0]]);
  const boards = new Map([[startKey, board.slice()]]);
  const order = [startKey];
  let deadEnds = 0;
  let frontier = 0;
  while (frontier < order.length) {
    const key = order[frontier++];
    const cur = boards.get(key);
    const d = dist.get(key);
    const moves = legalMoves(cur, opts);
    if (!moves.length && !isGoal(cur)) deadEnds++;
    for (const m of moves) {
      const next = applyMove(cur, m, opts);
      const nk = boardKey(next);
      if (!dist.has(nk)) {
        dist.set(nk, d + 1);
        boards.set(nk, next);
        order.push(nk);
      }
    }
  }
  return { dist, boards, order, nodes: order.length, deadEnds, start: startKey };
}

// ---------------------------------------------------------------- the goal table

// Distances *to* the far bank, by walking the move relation backwards from the solved
// position. This is what the screen reads: the hint, the "距最优" field and the dead-water
// warning all come from one build, and it is built once per lot and shared.
//
// Building it backwards is not just symmetric: forward BFS from a mid-river position cannot
// tell you the distance to the goal, and a hint that guessed would be worse than no hint.
export function goalTable(board, opts) {
  const key = cacheKey(board, opts);
  const hit = cache.get(key);
  if (hit) return hit;
  const { left, right } = counts(board);
  const goal = goalBoard(left, right);
  const goalKey = boardKey(goal);
  const dist = new Map([[goalKey, 0]]);
  const boards = new Map([[goalKey, goal]]);
  const order = [goalKey];
  for (let frontier = 0; frontier < order.length; frontier++) {
    const k = order[frontier];
    const cur = boards.get(k);
    const d = dist.get(k);
    for (const rev of predecessorsOf(cur, opts)) {
      const nk = boardKey(rev);
      if (!dist.has(nk)) {
        dist.set(nk, d + 1);
        boards.set(nk, rev);
        order.push(nk);
      }
    }
  }
  const rules = rulesOf(opts);
  const table = {
    dist,
    boards,
    size: order.length,
    rules,
    goalKey,
    goal,
    startKey: boardKey(board),
    cells: board.length,
    left,
    right,
    cached: false,
  };
  cache.set(key, table);
  return table;
}

// The inverse of the forward rule lives in js/core/game.js and is defined *by* that rule: u is
// a predecessor of v exactly when some legal move of u lands on v. A hand-written second copy
// of the hop test here is how a table and a screen would drift apart.
function predecessorsOf(board, opts) {
  return reverseMoves(board, opts).map((p) => p.board);
}

// ---------------------------------------------------------------- route extraction

// A shortest route from `board` to the far bank, read off a goal table. Bounded by the table
// size rather than by hope: each step strictly lowers `dist`, and `dist` is finite.
export function shortestRoute(board, opts, table = goalTable(board, opts)) {
  const out = [];
  let cur = board.slice();
  for (let i = 0; i <= table.size; i++) {
    const d = table.dist.get(boardKey(cur));
    if (d === undefined || d === 0) return out;
    let took = null;
    for (const m of legalMoves(cur, opts)) {
      const nd = table.dist.get(boardKey(applyMove(cur, m, opts)));
      if (nd === d - 1) { took = m; break; }
    }
    if (!took) return out;
    out.push(took);
    cur = applyMove(cur, took, opts);
  }
  return out;
}

// ---------------------------------------------------------------- the measurement

// par / states / optimalPaths for one position, by the breadth-first route.
export function solveBoard(board, opts) {
  const from = forwardReach(board, opts);
  const table = goalTable(board, opts);
  const goalKey = table.goalKey;
  const par = from.dist.get(goalKey);
  const { left, right } = counts(board);
  const result = {
    board: board.slice(),
    key: boardKey(board),
    left,
    right,
    cells: board.length,
    reachable: from.nodes,
    deadEnds: from.deadEnds,
    canReachGoal: par !== undefined,
    solverMs: 0,
  };
  if (par === undefined) {
    result.par = null;
    result.optimalPaths = 0;
    result.states = table.size;
    return result;
  }
  result.par = par;

  // Count the shortest routes: layer the reachable set by distance *from the start*, and add
  // an edge only when it lies on a shortest route (ds[u] + 1 + dg[v] === par). Edges between
  // equal layers are impossible here — every move strictly raises `potential`, so the graph
  // has no cycles at all — but the test would be the same if it did.
  const layers = new Map();
  for (const [k, d] of from.dist) {
    if (d > par) continue;
    if (!layers.has(d)) layers.set(d, []);
    layers.get(d).push(k);
  }
  const ways = new Map([[from.start, 1]]);
  const maxLayer = Math.min(par, Math.max(...layers.keys()));
  for (let d = 0; d < maxLayer; d++) {
    for (const k of layers.get(d) || []) {
      const w = ways.get(k) || 0;
      if (!w) continue;
      const cur = from.boards.get(k);
      for (const m of legalMoves(cur, opts)) {
        const nk = boardKey(applyMove(cur, m, opts));
        const dg = table.dist.get(nk);
        if (dg === undefined) continue;         // that hop lands in dead water
        if (d + 1 + dg !== par) continue;       // not on a shortest route
        ways.set(nk, (ways.get(nk) || 0) + w);
      }
    }
  }
  result.optimalPaths = ways.get(goalKey) || 0;
  result.states = table.size;
  return result;
}

// ---------------------------------------------------------------- the second road

// Memoised DFS, no frontier, no BFS. Returns the cheapest finishing cost from `board` and how
// many distinct move sequences achieve exactly that cost.
//
// Dead water is `Infinity`, never `null`: the first version of this returned null for a
// position with no route onward, `null + 1` is 1 in JavaScript, and the DFS cheerfully
// reported the whole n=2 river as a 2-move puzzle. test/solve.test.mjs pins the number down
// again from the other side, so the same mistake cannot hide twice.
export function countOptimalDFS(board, opts, memo = new Map()) {
  const key = boardKey(board);
  const seen = memo.get(key);
  if (seen) return seen;
  if (isGoal(board)) {
    const done = { len: 0, count: 1 };
    memo.set(key, done);
    return done;
  }
  let len = Infinity;
  let count = 0;
  for (const m of legalMoves(board, opts)) {
    const sub = countOptimalDFS(applyMove(board, m, opts), opts, memo);
    if (!Number.isFinite(sub.len)) continue;   // that branch never reaches the far bank
    const cand = sub.len + 1;
    if (cand < len) { len = cand; count = sub.count; } else if (cand === len) { count += sub.count; }
  }
  const out = { len: Number.isFinite(len) ? len : null, count };
  memo.set(key, out);
  if (memo.size > 4e6) throw new Error('the DFS memo outran the state space — the graph has a cycle');
  return out;
}

export function dfsSolve(board, opts) {
  const memo = new Map();
  const r = countOptimalDFS(board, opts, memo);
  return { par: r.len, optimalPaths: r.count || 0, memoised: memo.size };
}

// ---------------------------------------------------------------- the closed form

// Swapping banks of `a` and `b` frogs costs `ab + a + b` moves, and the argument is worth
// stating because it is the second road to the printed number rather than the search itself:
//
//   * every left/right pair of frogs has to change order exactly once, and the only move that
//     changes the order of two frogs is a hop over one — so exactly `ab` hops;
//   * every frog has to leave its bank and the bank has exactly one free pad to leave through,
//     so exactly `a + b` slides, and no frog can ever slide twice in a shortest route;
//   * hops and slides are the only two moves there are.
//
// With a = b = n that is n^2 + 2n = n(n+2), the form the brief anchors on. Stated as
// arithmetic so the BFS has something independent to be contradicted by — this function must
// never be used to *produce* a par, only to check one.
export function formula(a, b = a) {
  if (!Number.isInteger(a) || a < 1 || !Number.isInteger(b) || b < 1) {
    throw new Error(`formula wants whole numbers of frogs, got ${a}/${b}`);
  }
  return a * b + a + b;
}

// n(n+2), the equal-bank special case the brief quotes. Same number, different spelling, and
// both are pinned in test/solve.test.mjs.
export function closedForm(n) {
  return formula(n, n);
}

// The bank-to-bank opening position for n frogs per side.
export function canonicalBoard(n) {
  return standardBoard(n, n);
}

// How many pads a river of a+b frogs could hold in principle: (a+b+1)! / (a! b! 1!). The
// reachable set is smaller, and reporting both is the honest way to size a search.
export function arrangements(a, b) {
  let num = 1;
  let den = 1;
  for (let i = 2; i <= a + b + 1; i++) num *= i;
  for (let i = 2; i <= a; i++) den *= i;
  for (let i = 2; i <= b; i++) den *= i;
  return num / den;
}

// ---------------------------------------------------------------- the anchor table
//
// One call, three independent numbers per n, plus the openings. Both tools/bake.mjs and
// test/solve.test.mjs print this, and the expectations live in the test file rather than here.
export function anchorTable(maxN = 6, opts = 'standard') {
  const rows = [];
  for (let n = 1; n <= maxN; n++) {
    const board = canonicalBoard(n);

    const bfs = solveBoard(board, opts);
    const dfs = dfsSolve(board, opts);
    rows.push({
      n,
      cells: board.length,
      bfs: bfs.par,
      dfs: dfs.par,
      formula: closedForm(n),
      optimalPaths: bfs.optimalPaths,
      dfsPaths: dfs.optimalPaths,
      reachable: bfs.reachable,
      states: bfs.states,
      arrangements: arrangements(n, n),
      openings: legalMoves(board, opts).length,
      deadEnds: bfs.deadEnds,
    });
  }
  return rows;
}

export function summary(table) {
  let maxDist = 0;
  let atKey = table.goalKey;
  for (const [k, d] of table.dist) {
    if (d > maxDist) { maxDist = d; atKey = k; }
  }
  return {
    solvableStates: table.size,
    cells: table.cells,
    left: table.left,
    right: table.right,
    deepest: maxDist,
    atKey,
  };
}
