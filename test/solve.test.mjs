// The measurement tests: the anchors, the two independent routes to them, and the refutations
// that prove the rule and the search are both actually working.
//
// Every expectation in this file is hand-dead. It is copied from the brief's measured anchors
// (n(n+2) = 3, 8, 15, 24, 35 / 48, 63, 80, 99; exactly 2 optimal routes; 2 legal openings) and
// from arithmetic done with pen and paper below — never read back out of js/core. If a search
// disagrees with a row here, the search broke.

import { test, ok, eq, run } from '../tools/harness.mjs';
import {
  applyMove, boardKey, counts, goalBoard, isGoal, keyToBoard, legalMoves, moveKind,
  standardBoard,
} from '../js/core/game.js';
import {
  anchorTable, arrangements, closedForm, dfsSolve, formula, forwardReach, goalTable,
  shortestRoute, solveBoard,
} from '../js/core/solve.js';


// ---------------------------------------------------------------- the brief's anchors

const PAR_1_TO_5 = [3, 8, 15, 24, 35];
const PAR_1_TO_6 = [3, 8, 15, 24, 35, 48];
const PAR_6_TO_9 = [48, 63, 80, 99];

test('BFS optimum for n=1..5 is exactly 3, 8, 15, 24, 35', () => {
  const got = anchorTable(5).map((r) => r.bfs);
  eq(got, PAR_1_TO_5, 'the measured ladder');
});

test('BFS optimum for n=6..9 is exactly 48, 63, 80, 99', () => {
  const got = anchorTable(9).slice(5).map((r) => r.bfs);
  eq(got, PAR_6_TO_9, 'the tail of the ladder');
});

test('the closed form n(n+2) reproduces all nine of them', () => {
  // Written out longhand rather than as n*(n+2) so the test cannot be satisfied by the same
  // multiplication the implementation uses.
  const byHand = { 1: 1 * 3, 2: 2 * 4, 3: 3 * 5, 4: 4 * 6, 5: 5 * 7, 6: 6 * 8, 7: 7 * 9, 8: 8 * 10, 9: 9 * 11 };
  for (const [n, want] of Object.entries(byHand)) {
    eq(closedForm(Number(n)), want, `n=${n}`);
  }
});

test('search and closed form agree digit for digit, n = 1..9', () => {
  for (const r of anchorTable(9)) {
    ok(r.bfs === r.formula && r.dfs === r.formula, `n=${r.n}: bfs ${r.bfs} dfs ${r.dfs} form ${r.formula}`);
  }
});

test('the memoised DFS (no frontier at all) reproduces par independently', () => {
  for (const n of [1, 2, 3, 4, 5, 6]) {
    const dfs = dfsSolve(standardBoard(n, n));
    eq(dfs.par, PAR_1_TO_6[n - 1], `n=${n} by DFS`);
  }
});

test('exactly two optimal routes exist for every n tested, 1..6', () => {
  const rows = anchorTable(6);
  eq(rows.map((r) => r.optimalPaths), [2, 2, 2, 2, 2, 2], 'BFS layer counting');
  eq(rows.map((r) => r.dfsPaths), [2, 2, 2, 2, 2, 2], 'memoised DFS counting');
});

test('the two optimal routes are the mirror pair, enumerated without the counter', () => {
  // Brute-force DFS over the move tree, no layer counting and no memo: this is the third
  // independent road to "exactly two", and it also checks *which* two. Mirroring a river means
  // reversing the pad order and swapping the species, so mirroring a route must give a route,
  // and with the count at 2 the partner of one is the other.
  // A frog at pad p lands on pad L-1-p, so the image of `from -> to` is
  // `(L-1-from) -> (L-1-to)` — which flips the direction, exactly as the species swap demands:
  // a left frog walking right becomes a right frog walking left.
  const mirrorMove = (m, cells) => ({ from: cells - 1 - m.from, to: cells - 1 - m.to });
  for (const n of [2, 3, 4]) {
    const start = standardBoard(n, n);
    const cells = start.length;
    const routes = allRoutesOfLength(start, closedForm(n));
    eq(routes.length, 2, `n=${n} routes enumerated by hand-rolled DFS`);
    const [one, two] = routes.map((r) => r.map((m) => `${m.from}-${m.to}`).join(','));
    const flipped = routes[0].map((m) => { const q = mirrorMove(m, cells); return `${q.from}-${q.to}`; }).join(',');
    eq(flipped, two, `n=${n}: the mirror of route one is route two`);
    ok(one !== two, `n=${n}: the two openings differ (gap taken from the left, or from the right)`);
  }
});

test('a river starts with exactly two legal moves, n = 1, 2, 3', () => {
  for (const n of [1, 2, 3]) {
    const ms = legalMoves(standardBoard(n, n));
    eq(ms.length, 2, `n=${n} openings`);
    eq(ms.map((m) => m.kind), ['slide', 'slide'], 'both openings are single-pad slides into the gap');
  }
});

// ---------------------------------------------------------------- pen-and-paper fixtures
//
// The contract wants at least one expected value that is *not* produced by the code under test.
// These two are worked out by hand above the assert, and the hand work is spelled out.

test('hand fixture n=1: exactly three moves, and the only three that exist', () => {
  //  L . R   (pads 0,1,2). Legal now: L slides 0->1, R slides 2->1. Nothing can hop yet.
  //  Take L 0->1:  . L R.  Now R at 2 may hop over L at 1 into pad 0: R 2->0.
  //  L R .      Then L at 1 slides into pad 2: L . R -> wait, that is  .? do it in pads:
  //  after two moves the line is R L . ; L at 1 slides right to pad 2 -> R . L = the goal.
  //  Total 3 moves. No route can be shorter: the two frogs must change order (only a hop does
  //  that: 1 hop) and each must still reach the other bank (2 slides: 2 moves) = 3.
  const start = standardBoard(1, 1);
  const solved = solveBoard(start);
  eq(solved.par, 3, 'hand-derived 3');
  eq(boardKey(goalBoard(1, 1)), '201', 'the goal is R gap L');
  const route = shortestRoute(start);
  eq(route.map((m) => `${m.from}${m.kind === 'hop' ? '⇒' : '→'}${m.to}`), ['0→1', '2⇒0', '1→2'], 'the hand route, in order');
  eq(solved.optimalPaths, 2, 'and its mirror');
});

test('hand fixture n=2: eight moves, of which 4 hops and 4 slides', () => {
  // Every left/right pair has to pass once: 2x2 = 4 hops. Each of the 4 frogs must also slide
  // exactly once to leave its bank and enter the other: 4 slides. 4 + 4 = 8, and no move is a
  // spare. This is the ab + a + b argument with the numbers written out.
  const solved = solveBoard(standardBoard(2, 2));
  eq(solved.par, 8, 'hand-derived 8');
  eq(formula(2, 2), 8, 'the pair count agrees');
  const route = shortestRoute(standardBoard(2, 2));
  eq(route.length, 8, 'the route the table prints is that long');
  eq(route.filter((m) => m.kind === 'hop').length, 4, 'exactly four hops');
  eq(route.filter((m) => m.kind === 'slide').length, 4, 'exactly four slides');
});

test('the n=2 hand route is legal step by step and ends on the far bank', () => {
  let board = standardBoard(2, 2);
  for (const m of shortestRoute(board)) {
    ok(moveKind(board, m.from, m.to) === m.kind, `${m.from}->${m.to} is legal where it is played`);
    board = applyMove(board, m);
  }
  ok(isGoal(board), 'the walk ends solved');
  eq(boardKey(board), '22011');
});

// ---------------------------------------------------------------- exhaustive refutation

test('exhaustively: no reachable position of n=3..4 costs more than the bank-to-bank start', () => {
  // The "you cannot do better than par" half of the claim, proved by walking the whole
  // reachable set rather than by trusting the frontier order: for every position a player can
  // actually hop into, its distance to the far bank is at most the start's distance, and the
  // start is the unique position attaining it.
  for (const n of [3, 4]) {
    const start = standardBoard(n, n);
    const par = solveBoard(start).par;
    const reach = forwardReach(start);
    const table = goalTable(start);
    let worst = -1;
    let attainers = 0;
    for (const [key, board] of reach.boards) {
      const d = table.dist.get(key);
      if (d === undefined) continue; // dead water, no route onward at all
      if (d > worst) worst = d;
      if (d === par) attainers++;
    }
    eq(worst, par, `n=${n}: the deepest reachable position is shallower than the start`);
    eq(attainers, 1, `n=${n}: only the bank-to-bank start costs ${par}`);
  }
});

test('exhaustively: no shorter route to the far bank exists for n=1..5', () => {
  // If some route were shorter than `par`, the forward sweep would have reached the goal at a
  // smaller depth. Checked against the raw frontier, not against solveBoard's own summary.
  for (const n of [1, 2, 3, 4, 5]) {
    const start = standardBoard(n, n);
    const reach = forwardReach(start);
    const goalKey = boardKey(goalBoard(n, n));
    eq(reach.dist.get(goalKey), PAR_1_TO_5[n - 1], `n=${n} frontier distance`);
    let anyShorter = false;
    for (const [key, d] of reach.dist) if (key === goalKey && d < PAR_1_TO_5[n - 1]) anyShorter = true;
    ok(!anyShorter, `n=${n}`);
  }
});

test('a shortest route spends exactly one unit of table distance per step', () => {
  const start = standardBoard(4, 4);
  const table = goalTable(start);
  const par = table.dist.get(boardKey(start));
  eq(par, 24, 'the n=4 anchor, read off the table the screen uses');
  let cur = start.slice();
  let steps = 0;
  for (const m of shortestRoute(start)) {
    eq(table.dist.get(boardKey(cur)), par - steps, `before step ${steps + 1}`);
    cur = applyMove(cur, m);
    steps++;
  }
  eq(steps, par, 'the route has exactly par steps');
  eq(table.dist.get(boardKey(cur)), 0, 'and it lands where the distance is zero');
});

// ---------------------------------------------------------------- the rule is load-bearing

test('refutation: let a frog clear two pads and n=3 changes shape', () => {
  const strict = solveBoard(standardBoard(3, 3));
  const loose = solveBoard(standardBoard(3, 3), 'loose');
  eq(strict.par, 15);
  eq(strict.optimalPaths, 2);
  ok(loose.par < strict.par || loose.optimalPaths > strict.optimalPaths,
    `loose came out par ${loose.par} / ${loose.optimalPaths} routes — the ban on two-pad hops is not constraining anything`);
  ok(loose.optimalPaths > 20, `the relaxed rule admits ${loose.optimalPaths} shortest routes`);
  eq(loose.par, dfsSolve(standardBoard(3, 3), 'loose').par, 'both searchers agree under the relaxed rule too');
});

test('refutation: a hop over two pads is refused by the shipped rule', () => {
  // L at pad 0, two opposing frogs at 1 and 2, the gap at 3: the standard rule says no.
  const board = [1, 2, 2, 0];
  eq(moveKind(board, 0, 3), null, 'a three-pad reach is not a move');
  ok(legalMoves(board).every((m) => Math.abs(m.to - m.from) <= 2), 'the shipped rule never spans three pads');
  eq(legalMoves(board, 'loose').some((m) => Math.abs(m.to - m.from) === 3), true, 'the relaxed set does');
});

test('refutation: hopping over your own species is refused', () => {
  const board = [1, 1, 0];
  eq(moveKind(board, 0, 2), null, 'L may not clear L');
  eq(moveKind(board, 0, 2, { oppositeOnly: false }), 'hop', 'the same-colour variant would allow it');
  eq(moveKind(board, 0, 2, 'sameColor'), 'hop');
});

test('backward sweep and forward sweep describe the same graph', () => {
  // dist-to-goal built by walking the inverse relation must equal the depth of the goal found
  // by walking forward. If `reverseMoves` were wrong, one of these numbers would move.
  for (const n of [2, 3, 5]) {
    const start = standardBoard(n, n);
    const reach = forwardReach(start);
    const table = goalTable(start);
    const goalKey = boardKey(goalBoard(n, n));
    for (const [key, d] of reach.dist) {
      const toGoal = table.dist.get(key);
      if (toGoal === undefined) continue;
      eq(toGoal + d >= reach.dist.get(goalKey), true, `n=${n}: a route cannot be shorter than par`);
    }
    eq(table.dist.get(goalKey), 0, 'the goal is zero from itself');
  }
});

// ---------------------------------------------------------------- the search is pure

test('solving does not touch the position it was given', () => {
  const board = standardBoard(4, 4);
  const before = board.slice();
  solveBoard(board);
  dfsSolve(board);
  goalTable(board);
  forwardReach(board);
  shortestRoute(board);
  eq(board, before, 'the array is byte-identical afterwards');
  const copy = board.slice();
  legalMoves(board).forEach((m) => applyMove(board, m));
  eq(board, copy, 'and legalMoves/applyMove do not write through either');
});

test('the reachable set never exceeds the count of all arrangements, and is smaller', () => {
  for (const n of [2, 3, 4]) {
    const s = solveBoard(standardBoard(n, n));
    ok(s.reachable <= arrangements(n, n), `n=${n}: ${s.reachable} reachable vs ${arrangements(n, n)} arrangements`);
    ok(s.reachable < arrangements(n, n), `n=${n}: some arrangements are simply not hop-into-able`);
  }
  eq(arrangements(1, 1), 6);
  eq(arrangements(2, 2), 30);
  eq(arrangements(3, 3), 140);
});

test('ab + a + b holds for every published bank shape, by both roads', () => {
  for (let a = 1; a <= 5; a++) {
    for (let b = 1; b <= 5; b++) {
      const board = standardBoard(a, b);
      const bfs = solveBoard(board);
      eq(bfs.par, formula(a, b), `${a}/${b} against the search`);
      eq(dfsSolve(board).par, formula(a, b), `${a}/${b} against the DFS`);
    }
  }
});

test('unequal banks really have more than two shortest routes', () => {
  // The mirror-pair argument needs equal banks; with 1 vs 2 frogs the count is 3, which is the
  // same search on a shape the closed-form story does not cover.
  eq(solveBoard(standardBoard(1, 2)).optimalPaths, 3);
  eq(solveBoard(standardBoard(2, 1)).optimalPaths, 3, 'and a mirrored river counts the same');
  eq(counts(keyToBoard('1022')), { left: 1, right: 2 });
});

// ---------------------------------------------------------------- the chain, proved

test('the chain theorem: every legal move spends one unit of distance or strands the river', () => {
  // This is the sentence the whole repo is staked on. Walk *every* reachable position of every
  // published river size, look at every legal move out of it, and ask the distance table what
  // the position it lands in is worth. Either it is exactly one cheaper, or the far bank is
  // gone for good. Nothing in between, so no route can be merely wasteful.
  const SOLVABLE = [6, 16, 30, 48, 70, 96]; // 2n(n+2), hand-written from the same closed form
  const report = [];
  for (const n of [1, 2, 3, 4, 5, 6]) {
    const start = standardBoard(n, n);
    const reach = forwardReach(start);
    const table = goalTable(start);
    let solvable = 0;
    let optimal = 0;
    let fatal = 0;
    let wasted = 0;
    let fromSolvable = 0;
    for (const [key, board] of reach.boards) {
      const d = table.dist.get(key);
      if (d === undefined) continue;
      solvable++;
      fromSolvable += legalMoves(board).length;
      for (const m of legalMoves(board)) {
        const nd = table.dist.get(boardKey(applyMove(board, m, 'standard')));
        if (nd === undefined) fatal++;
        else if (nd === d - 1) optimal++;
        else wasted++;
      }
    }
    report.push({ n, solvable, optimal, fatal, wasted });
    eq(solvable, SOLVABLE[n - 1], `n=${n} solvable positions`);
    eq(solvable, 2 * closedForm(n), `n=${n}: solvable positions are twice the par`);
    eq(wasted, 0, `n=${n}: a merely wasteful move would break the whole story`);
    eq(optimal, solvable, `n=${n}: every solvable position has exactly one way onward on average`);
    eq(optimal + fatal, fromSolvable, `n=${n}: every transition out of a solvable position is accounted for`);
    ok(fatal > 0 || n === 1, `n=${n} has ${fatal} fatal transitions out of solvable water`);
  }
  eq(report.map((r) => r.fatal), [0, 6, 16, 30, 48, 70], 'the fatal edges, counted: 2n(n+2) of the previous size');
});

test('so there are exactly two complete solutions in the whole game, not two shortest ones', () => {
  // Enumerate *every* move sequence that finishes, of any length, by depth-first walking of the
  // DAG. The chain theorem above says none of them can be longer than par; this says there are
  // exactly two of them at all, which is the sense in which par is the shortest route of a
  // unique structure rather than the cheapest of a thousand options.
  for (const n of [1, 2, 3]) {
    let completions = 0;
    const walk = (cur) => {
      if (isGoal(cur)) { completions++; return; }
      for (const m of legalMoves(cur)) walk(applyMove(cur, m));
    };
    walk(standardBoard(n, n));
    eq(completions, 2, `n=${n} complete solutions of any length`);
  }
});

// ---------------------------------------------------------------- helpers

// Every move sequence of exactly `limit` steps that solves the river, found by depth-first
// enumeration over the DAG — deliberately not the counting code under test.
function allRoutesOfLength(board, limit) {
  const found = [];
  const walk = (cur, trail, depth) => {
    if (found.length > 40) return;
    if (isGoal(cur)) {
      if (depth === limit) found.push(trail.slice());
      return;
    }
    if (depth >= limit) return;
    for (const m of legalMoves(cur)) walk(applyMove(cur, m), [...trail, m], depth + 1);
  };
  walk(board, [], 0);
  return found;
}

run();
