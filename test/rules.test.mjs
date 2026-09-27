// The model: what a position is, what the rules refuse, and what the game object is allowed to
// remember. The validator branches each get their own negative fixture, because a checker that
// has never rejected anything is decoration.

import { test, ok, eq, run } from '../tools/harness.mjs';
import {
  GAP, HOP, LEAP, applyMove, boardKey, boardOf, boardOfSpec, canReachGoal, counts, createGame,
  dirOf, grade, goalBoard, hint, isGoal, keyToBoard, legal, legalMoves, moveKind, other,
  overPar, play, potential, remaining, reset, reverseMoves, routeOf, specOfBoard, standardBoard,
  undo, validateBoard, validateSpec,
} from '../js/core/game.js';
import { goalTable, solveBoard } from '../js/core/solve.js';

const lotOf = (row) => ({ ...row, board: boardOfSpec(row), table: goalTable(boardOfSpec(row)) });
const row22 = { id: 'fixture-22', tier: 'shoal', a: 2, b: 2, cells: 5, left: [0, 1], right: [3, 4], empty: 2, par: 8 };
const board22 = [1, 1, 0, 2, 2];

// ---------------------------------------------------------------- the serialised form

test('a well-formed spec decodes to the pads it describes', () => {
  eq(validateSpec(row22), null, 'no complaint');
  eq(boardOfSpec(row22), board22);
  eq(specOfBoard(board22), { left: [0, 1], right: [3, 4], empty: 2, cells: 5 });
  eq(specOfBoard(boardOfSpec(row22)), { left: row22.left, right: row22.right, empty: row22.empty, cells: row22.cells });
});

test('validator: two frogs on one pad is refused', () => {
  const bad = { ...row22, left: [0, 1], right: [1, 3] };
  ok(/share pad 1/.test(validateSpec(bad)), validateSpec(bad));
});

test('validator: a frog off the end of the river is refused', () => {
  const bad = { ...row22, right: [3, 5] };
  ok(/off the river/.test(validateSpec(bad)), validateSpec(bad));
  const negative = { ...row22, left: [-1, 1] };
  ok(/off the river/.test(validateSpec(negative)), validateSpec(negative));
});

test('validator: a river whose width disagrees with its frogs is refused', () => {
  const bad = { ...row22, cells: 6 };
  ok(/6 pads wide/.test(validateSpec(bad)), validateSpec(bad));
});

test('validator: a gap that is missing, or sat on by a frog, is refused', () => {
  ok(/collides with the left frog/.test(validateSpec({ ...row22, empty: 1 })), 'gap under a frog');
  ok(/off the river/.test(validateSpec({ ...row22, empty: 9 })), 'gap off the end');
  ok(/missing gap/.test(validateSpec({ ...row22, empty: undefined })), 'no gap at all');
});

test('validator: junk in the lists is refused rather than coerced', () => {
  ok(validateSpec(null), 'null is not a lot');
  ok(/not an integer/.test(validateSpec({ ...row22, left: [0, 1.5] })), 'half a pad');
  ok(/lists of pad indices/.test(validateSpec({ ...row22, right: '34' })), 'a string is not a list');
});

test('boardOfSpec throws instead of quietly building an impossible river', () => {
  let threw = false;
  try { boardOfSpec({ ...row22, left: [0, 0] }); } catch (err) { threw = /illegal lot/.test(err.message); }
  ok(threw, 'a hand-edited row is a build error, not a shrug');
});

test('validateBoard: a pad line needs exactly one free pad and nothing else', () => {
  eq(validateBoard(board22), null);
  ok(/exactly one free pad/.test(validateBoard([1, 1, 2, 2, 2])), 'no gap');
  ok(/exactly one free pad/.test(validateBoard([0, 0, 1, 2, 1])), 'two gaps');
  ok(/unknown pad contents/.test(validateBoard([1, 3, 0, 2, 1])), 'a third species');
  ok(/not an array/.test(validateBoard('11022')), 'a string is not a board');
});

// ---------------------------------------------------------------- the rule

test('the rule in eight sentences', () => {
  eq(moveKind([0, 1], 1, 0), null, 'a left frog may not step onto pad 0');
  eq(moveKind([1, 0], 0, 1), 'slide', 'a left frog steps right into the free pad');
  eq(moveKind([0, 2], 1, 0), 'slide', 'a right frog steps left into the free pad');
  eq(moveKind([1, 2, 0], 0, 2), 'hop', 'over one opposing frog, into the pad beyond');
  eq(moveKind([1, 1, 0], 0, 2), null, 'over your own species is not a leap');
  eq(moveKind([1, 0, 2], 0, 2), null, 'over air is not a leap either');
  eq(moveKind([1, 2, 2], 0, 2), null, 'the landing pad must be the free one');
  eq(moveKind([0, 1, 2], 0, 1), null, 'the gap does not move itself');
  eq(moveKind([1, 0], 0, 2), null, 'off the end of the river');
  eq(moveKind([1, 1, 0, 2], 0, 2), null, 'a left frog cannot clear another left frog');
});

test('species, directions and the goal line', () => {
  eq(dirOf(LEAP), 1);
  eq(dirOf(HOP), -1);
  eq(dirOf(GAP), 0);
  eq(other(LEAP), HOP);
  eq(other(HOP), LEAP);
  eq(other(GAP), GAP);
  eq(goalBoard(2, 3), [2, 2, 2, 0, 1, 1]);
  eq(isGoal(goalBoard(2, 3)), true);
  eq(isGoal(standardBoard(2, 3)), false);
  eq(counts(keyToBoard('11022')), { left: 2, right: 2 });
});

test('legalMoves on fixed fixtures, hand-counted', () => {
  eq(legalMoves([1, 1, 0, 2, 2]).map((m) => `${m.from}->${m.to}`), ['1->2', '3->2']);
  eq(legalMoves([0, 1, 2]).map((m) => `${m.from}->${m.to}`), ['2->0'], 'the right frog hops the left one');
  eq(legalMoves([1, 2, 0]).length, 1, 'only the left frog can land, and it lands in the gap');
  eq(legalMoves([0, 1, 2]).map((m) => m.kind), ['hop'], 'a right frog hops the left one over the gap');
  eq(legalMoves([2, 1, 0]).map((m) => m.kind), ['slide'], 'the right frog at the left end has nowhere to go');
  eq(legalMoves([0]).length, 0, 'an empty river has no moves');
});

test('applyMove is a swap with the gap and never writes through', () => {
  const board = [1, 1, 0, 2, 2];
  const next = applyMove(board, { from: 1, to: 2 });
  eq(next, [1, 0, 1, 2, 2]);
  eq(board, [1, 1, 0, 2, 2], 'the input is untouched');
  let threw = false;
  try { applyMove(board, { from: 0, to: 2 }); } catch (err) { threw = /illegal move/.test(err.message); }
  ok(threw, 'an illegal move is an exception at this layer, not a silent no-op');
});

test('the position graph is a DAG: every legal move strictly raises the potential', () => {
  // Frogs only ever walk forward, so a position can never return to an earlier one. This is
  // what lets js/core/solve.js count routes with a memo and no visited set.
  let checked = 0;
  for (const n of [2, 3, 4]) {
    const start = standardBoard(n, n);
    const reach = solveBoard(start);
    const seen = new Map([[boardKey(start), start.slice()]]);
    const queue = [start.slice()];
    for (let i = 0; i < queue.length; i++) {
      const cur = queue[i];
      for (const m of legalMoves(cur)) {
        const next = applyMove(cur, m);
        ok(potential(next) > potential(cur), `${boardKey(cur)} -> ${boardKey(next)} goes backwards`);
        checked++;
        const k = boardKey(next);
        if (!seen.has(k)) { seen.set(k, next); queue.push(next); }
      }
    }
    ok(reach.reachable === seen.size, 'the sweep and this walk saw the same number of positions');
  }
  ok(checked > 100, `${checked} transitions checked, all forward`);
});

test('reverseMoves is the exact inverse of the forward rule', () => {
  // Both directions, over the whole 2/2 and 3/3 spaces. The distance table to the far bank is
  // built from `reverseMoves`, so if this relation were wrong par would be wrong with it —
  // which is exactly why the closed form is a *third* opinion rather than a second one.
  const boards = new Map();
  for (const n of [2, 3]) {
    const start = standardBoard(n, n);
    boards.set(boardKey(start), start.slice());
    for (let i = 0; i < [...boards.values()].length; i++) {
      for (const m of legalMoves([...boards.values()][i])) {
        const next = applyMove([...boards.values()][i], m);
        if (!boards.has(boardKey(next))) boards.set(boardKey(next), next);
      }
    }
  }
  const edges = [];
  for (const board of boards.values()) {
    for (const m of legalMoves(board)) edges.push([board, applyMove(board, m)]);
  }
  ok(edges.length > 100, `${edges.length} transitions in the two spaces`);
  for (const [u, v] of edges) {
    ok(reverseMoves(v).some((p) => boardKey(p.board) === boardKey(u)),
      `${boardKey(u)} -> ${boardKey(v)} must be reversible`);
  }
  for (const board of boards.values()) {
    for (const p of reverseMoves(board)) {
      const forward = legalMoves(p.board).find((m) => m.from === p.from && m.to === p.to);
      ok(forward, `${boardKey(p.board)} claims a move ${p.from}->${p.to} that the rule refuses`);
      eq(boardKey(applyMove(p.board, forward)), boardKey(board), 'and it lands exactly here');
    }
  }
});

// ---------------------------------------------------------------- the game object

test('a game starts where its lot says and knows its own par', () => {
  const game = createGame(lotOf(row22));
  eq(boardOf(game), board22);
  eq(game.moves, 0);
  eq(game.par, 8);
  eq(game.done, false);
  eq(remaining(game), 8, 'the distance to the far bank is the printed par');
  eq(overPar(game), 0);
  eq(grade(game), { key: 'rowing', label: '正在渡河', stars: null }, 'nothing is graded before the bank is reached');
});

test('a legal step counts, a refused one changes nothing at all', () => {
  const game = createGame(lotOf(row22));
  const before = { board: boardOf(game).slice(), moves: game.moves, rem: remaining(game) };
  eq(play(game, { from: 0, to: 1 }), false, 'the left frog has a frog in front of it');
  eq(boardOf(game), before.board, 'and the pads did not move');
  eq(game.moves, 0);
  eq(remaining(game), before.rem);
  ok(play(game, { from: 1, to: 2 }), 'the legal one is accepted');
  eq(game.moves, 1);
  eq(boardOf(game), [1, 0, 1, 2, 2]);
  eq(remaining(game), 7, 'one step of the measured route spent');
  eq(overPar(game), 0);
});

test('steps only ever go up while playing, and undo takes both the step and the pads back', () => {
  const game = createGame(lotOf(row22));
  const route = routeOf(game);
  eq(route.length, game.par, 'the certified route has exactly par steps');
  const seen = [];
  for (const m of route) {
    ok(play(game, m), 'the certified route is legal at every step');
    seen.push(game.moves);
  }
  eq(seen, [1, 2, 3, 4, 5, 6, 7, 8], 'monotone, one at a time');
  eq(game.done, true);
  eq(play(game, { from: 0, to: 1 }), false, 'a solved river accepts nothing more');
  eq(game.par, 8, 'and finishing does not move the goalposts');
  const undone = undo(game);
  eq(game.moves, 7);
  eq(game.done, false);
  eq(boardOf(game), undone.board);
  eq(game.par, 8, 'undo cannot edit par');
  for (let i = 0; i < 12; i++) undo(game);
  eq(game.moves, 0, 'undo stops at the start rather than going negative');
  eq(boardOf(game), board22, 'and lands exactly on the start position');
});

test('there is no such thing as a wasted step: a wrong hop strands the river', () => {
  // 1 1 . 2 2 -> 1 . 1 2 2 (the forced opening) -> 0? pad: 1 slides back into the gap, and now
  // no sequence of forward-only moves can clear the two frogs blocking each other. The model
  // says so, because the distance table has no entry for it.
  const game = createGame(lotOf(row22));
  ok(play(game, { from: 1, to: 2 }));
  eq(remaining(game), 7);
  const second = play(game, { from: 0, to: 1 });
  ok(second, 'the hop itself was legal');
  eq(second.stranded, true, 'and it is the last legal move that mattered');
  eq(remaining(game), null);
  eq(overPar(game), null, 'over par has no answer once the bank is out of reach');
  eq(game.moves, 2, 'the two steps are still billed: stranding is not a refusal');
  undo(game);
  eq(remaining(game), 7, 'undo is the way out, and it works');
  eq(overPar(game), 0);
});

test('the stars are cut from the counters that can actually move', () => {
  const game = createGame(lotOf(row22));
  for (const m of routeOf(game)) play(game, m);
  eq(game.done, true);
  eq(game.moves, game.par, 'arriving at all means arriving at par');
  eq(grade(game), { key: 'perfect', label: '踏波无痕', stars: 3 }, 'no help, no stranding');
  eq(grade(game, { hints: 1 }).stars, 2, 'one hint is a steadier crossing');
  eq(grade(game, { hints: 1, strands: 1 }).stars, 2, 'two counted events still earn two stars');
  eq(grade(game, { strands: 3 }).stars, 1, 'three and the river was wandered');
});

test('reset clears the count and the pads but not the measurement', () => {
  const game = createGame(lotOf(row22));
  play(game, { from: 1, to: 2 });
  play(game, { from: 3, to: 1 });
  reset(game);
  eq(game.moves, 0);
  eq(boardOf(game), board22);
  eq(game.history.length, 0);
  eq(game.par, 8);
  eq(remaining(game), 8);
});

test('the hint names a move that is on a shortest route', () => {
  const game = createGame(lotOf(row22));
  const h = hint(game);
  ok(h && h.move, 'there is something to say');
  ok(legal(game).some((m) => m.from === h.move.from && m.to === h.move.to), 'and it is legal right now');
  eq(h.left, 8);
  const again = createGame(lotOf(row22));
  play(again, h.move);
  eq(remaining(again), 7, 'and it cost exactly one of the measured steps');
});

test('dead water is reported as dead water', () => {
  // 1 1 2 2 . is a real position of the 2/2 river: nothing can move, and it is not the goal.
  const dead = [1, 1, 2, 2, 0];
  eq(legalMoves(dead).length, 0);
  eq(isGoal(dead), false);
  const table = goalTable(standardBoard(2, 2));
  eq(table.dist.get(boardKey(dead)), undefined, 'the distance table has no answer for it');
  const game = createGame({ ...row22, board: dead, table });
  eq(remaining(game), null);
  eq(canReachGoal(game), false, 'and the model says so instead of inventing a number');
});

run();
