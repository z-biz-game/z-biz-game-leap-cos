// The rules of 跳蛙渡 (leapfrog / the toads-and-frogs puzzle) and nothing else.
//
// A river is a straight line of `cells` lily pads. `left` frogs start on the near bank and
// only ever step *right*; `right` frogs start on the far bank and only ever step *left*. The
// whole game is one line of cells, so a position is an array of three symbols:
//
//   1  LEAP   a frog from the left bank, forward = +1
//   2   HOP   a frog from the right bank, forward = -1
//   0   gap   the one free pad
//
// A frog either slides into the pad directly ahead of it, or hops over exactly one *opposing*
// frog into the free pad beyond. Never backwards, never over two, never off the end. Those
// four words are `moveKind` below: the single source of legality in this repo, and the reason
// every difficulty number in the game is a measurement rather than an opinion.
//
// No DOM, no window, no canvas. `node --test`, tools/bake.mjs and the browser all import this
// exact file.

export const LEAP = 1;
export const HOP = 2;
export const GAP = 0;

// Rule variants. The game ships STANDARD; the other two exist because a difficulty number is
// only worth printing if the rule behind it can be *falsified* (test/solve.test.mjs relaxes
// the hop and demands the measurement move). Kept as data rather than as forks of the
// function, so there is still exactly one implementation of the rule.
export const RULES = {
  standard: { maxHopped: 1, oppositeOnly: true },
  // A frog may clear one OR two neighbours. Used only as a counter-example.
  loose: { maxHopped: 2, oppositeOnly: true },
  // A frog may clear a neighbour of either colour. Also only a counter-example.
  sameColor: { maxHopped: 1, oppositeOnly: false },
};

export function rulesOf(opts = {}) {
  if (!opts) return RULES.standard;
  if (typeof opts === 'string') {
    const r = RULES[opts];
    if (!r) throw new Error(`unknown rule set '${opts}'`);
    return r;
  }
  if (opts.rules && RULES[opts.rules]) return RULES[opts.rules];
  return {
    maxHopped: Number.isInteger(opts.maxHopped) ? opts.maxHopped : RULES.standard.maxHopped,
    oppositeOnly: opts.oppositeOnly === undefined ? RULES.standard.oppositeOnly : !!opts.oppositeOnly,
  };
}

// ---------------------------------------------------------------- positions

// Which way a symbol walks. The gap goes nowhere.
export function dirOf(cell) {
  if (cell === LEAP) return 1;
  if (cell === HOP) return -1;
  return 0;
}

export function other(cell) {
  if (cell === LEAP) return HOP;
  if (cell === HOP) return LEAP;
  return GAP;
}

export function counts(board) {
  let a = 0;
  let b = 0;
  for (const c of board) {
    if (c === LEAP) a++;
    else if (c === HOP) b++;
  }
  return { left: a, right: b };
}

// The bank-to-bank opening position: a frogs packed on the left, one free pad, b on the right.
export function standardBoard(a, b = a) {
  const board = [];
  for (let i = 0; i < a; i++) board.push(LEAP);
  board.push(GAP);
  for (let i = 0; i < b; i++) board.push(HOP);
  return board;
}

// The far bank: everyone has swapped sides, and the single free pad sits between them again.
export function goalBoard(a, b = a) {
  const board = [];
  for (let i = 0; i < b; i++) board.push(HOP);
  board.push(GAP);
  for (let i = 0; i < a; i++) board.push(LEAP);
  return board;
}

export function boardKey(board) {
  return board.join('');
}

export function keyToBoard(key) {
  return String(key).split('').map(Number);
}

export function isGoal(board) {
  const { left, right } = counts(board);
  const goal = goalBoard(left, right);
  for (let i = 0; i < board.length; i++) if (board[i] !== goal[i]) return false;
  return true;
}

// ---------------------------------------------------------------- serialised specs
//
// A lot on disk is a *placement*, not a string: `{ left: [0,1], right: [3,4], empty: 2,
// cells: 5 }`. Redundant on purpose — `cells` and the two lists must agree, so a hand-edit to
// a shipped row has somewhere to fail. Everything that reads a serialised lot goes through
// `boardOfSpec`, and `validateSpec` is the gate it passes on the way.

export function validateSpec(spec) {
  if (!spec || typeof spec !== 'object') return 'spec is not an object';
  const { left, right } = spec;
  if (!Array.isArray(left) || !Array.isArray(right)) return 'left/right must be lists of pad indices';
  for (const [name, list] of [['left', left], ['right', right]]) {
    for (const c of list) {
      if (!Number.isInteger(c)) return `${name}: pad index ${c} is not an integer`;
    }
  }
  const cells = Number.isInteger(spec.cells) ? spec.cells : left.length + right.length + 1;
  if (cells !== left.length + right.length + 1) {
    return `river is ${cells} pads wide but holds ${left.length}+${right.length} frogs and one gap`;
  }
  if (!Number.isInteger(spec.empty)) return 'missing gap pad';
  const seen = new Map();
  for (const [c, who] of [...left.map((x) => [x, 'left']), ...right.map((x) => [x, 'right'])]) {
    if (c < 0 || c >= cells) return `${who} frog on pad ${c} is off the river (0..${cells - 1})`;
    if (seen.has(c)) return `two frogs share pad ${c} (${seen.get(c)} and ${who})`;
    seen.set(c, who);
  }
  if (spec.empty < 0 || spec.empty >= cells) return `gap on pad ${spec.empty} is off the river`;
  if (seen.has(spec.empty)) return `gap on pad ${spec.empty} collides with the ${seen.get(spec.empty)} frog`;
  return null;
}

export function boardOfSpec(spec) {
  const err = validateSpec(spec);
  if (err) throw new Error(`illegal lot: ${err}`);
  const board = new Array(spec.cells).fill(GAP);
  for (const c of spec.left) board[c] = LEAP;
  for (const c of spec.right) board[c] = HOP;
  return board;
}

export function specOfBoard(board) {
  const left = [];
  const right = [];
  let empty = -1;
  board.forEach((c, i) => {
    if (c === LEAP) left.push(i);
    else if (c === HOP) right.push(i);
    else if (c === GAP) empty = i;
  });
  return { left, right, empty, cells: board.length };
}

export function validateBoard(board) {
  if (!Array.isArray(board)) return 'board is not an array';
  let gaps = 0;
  for (const c of board) {
    if (c !== LEAP && c !== HOP && c !== GAP) return `unknown pad contents ${c}`;
    if (c === GAP) gaps++;
  }
  if (gaps !== 1) return `a river needs exactly one free pad, found ${gaps}`;
  return null;
}

// ---------------------------------------------------------------- the rule

// What a move from `from` to `to` is, or null when the rules refuse it. Slide = the pad
// ahead is free; hop = one (or `maxHopped`) opposing frogs in front, free pad beyond.
export function moveKind(board, from, to, opts) {
  const err = validateBoard(board);
  if (err) return null;
  const rule = rulesOf(opts);
  const span = to - from;
  if (!Number.isInteger(span) || span === 0) return null;
  const frog = board[from];
  const dir = dirOf(frog);
  if (!dir) return null;                        // the gap cannot move itself
  if (Math.sign(span) !== dir) return null;     // never backwards
  const dist = Math.abs(span);
  if (dist > rule.maxHopped + 1) return null;   // never over more than the rule allows
  if (to < 0 || to >= board.length) return null;
  if (board[to] !== GAP) return null;           // the landing pad must be free
  if (dist === 1) return 'slide';
  for (let i = from + dir; i !== to; i += dir) {
    const jumped = board[i];
    if (jumped === GAP) return null;            // a hop clears frogs, not air
    if (rule.oppositeOnly && jumped !== other(frog)) return null;
  }
  return 'hop';
}

// Every legal move from here, in pad order. This is also "which frogs glow" on screen, so it
// is the same array the view draws with and the same one the tests count.
export function legalMoves(board, opts) {
  const out = [];
  for (let i = 0; i < board.length; i++) {
    const dir = dirOf(board[i]);
    if (!dir) continue;
    for (let hopped = 0; hopped <= (rulesOf(opts).maxHopped); hopped++) {
      const to = i + dir * (hopped + 1);
      const kind = moveKind(board, i, to, opts);
      if (kind) out.push({ from: i, to, kind, hopped });
    }
  }
  return out;
}

// A move is a swap with the gap. Returns a new board; the input is never touched.
// `opts` has to travel with it: a move that is legal under a relaxed rule set is not legal
// under the standard one, and re-checking it against the wrong set would throw.
export function applyMove(board, move, opts) {
  const kind = moveKind(board, move.from, move.to, opts);
  if (!kind) throw new Error(`illegal move ${move.from}->${move.to}`);
  const next = board.slice();
  next[move.to] = next[move.from];
  next[move.from] = GAP;
  return next;
}

// The inverse relation, defined *through* the forward rule rather than re-derived from it: a
// board u precedes v when some legal move of u lands exactly on v. Brute force over the one
// free pad, which is cheap and cannot drift out of sync with `moveKind`.
export function reverseMoves(board, opts) {
  const out = [];
  const gap = board.indexOf(GAP);
  for (let j = 0; j < board.length; j++) {
    if (j === gap) continue;
    const frog = board[j];
    const dir = dirOf(frog);
    if (!dir || Math.sign(j - gap) !== dir) continue; // it could only have come from behind
    const prev = board.slice();
    prev[gap] = frog;
    prev[j] = GAP;
    if (moveKind(prev, gap, j, opts)) out.push({ from: gap, to: j, board: prev });
  }
  return out;
}

// Frogs only ever walk forward, so this potential strictly increases with every move: the
// position graph is a DAG. That is what lets an exhaustive DFS terminate without a visited set
// (js/core/solve.js), and test/rules.test.mjs pins it down over the whole space.
export function potential(board) {
  let p = 0;
  for (let i = 0; i < board.length; i++) {
    if (board[i] === LEAP) p += i;
    else if (board[i] === HOP) p -= i;
  }
  return p;
}

// ---------------------------------------------------------------- the game object

export function createGame(lot, opts = {}) {
  if (!lot) throw new Error('createGame needs a lot');
  const board = Array.isArray(lot.board) ? lot.board.slice() : boardOfSpec(lot);
  return {
    id: lot.id,
    tier: lot.tier,
    par: lot.par,
    rules: rulesOf(opts),
    table: lot.table || null,        // dist-to-goal, built by js/core/solve.js
    board,
    start: board.slice(),
    moves: 0,
    history: [],
    done: isGoal(board),
  };
}

export function boardOf(game) {
  return game.board;
}

export function legal(game) {
  return legalMoves(game.board, game.rules);
}

// The one place a move happens. Returns the move when it counted — with `stranded: true` when
// that hop was the last legal-looking one before the river became unsolvable — and false when
// the rules refused it. Refusal changes nothing at all: not the pads, not the count, not the
// distance, which is what the browser suite asserts with a real mouse.
//
// `stranded` is a measurement, not a mood: it asks the same distance table that printed `par`
// whether the far bank is still reachable. And it is the *only* way to do worse than par here:
// test/solve.test.mjs walks all n<=6 reachable positions and shows that every legal move
// either spends exactly one unit of distance or strands you, with nothing in between.
export function play(game, move) {
  if (game.done) return false;
  const kind = moveKind(game.board, move.from, move.to, game.rules);
  if (!kind) return false;
  const from = game.board;
  game.board = applyMove(from, { from: move.from, to: move.to }, game.rules);
  game.history.push({ from: move.from, to: move.to, kind, board: from });
  game.moves++;
  if (isGoal(game.board)) game.done = true;
  const wasSolvable = distance(game.table, from) !== null;
  return { from: move.from, to: move.to, kind, stranded: wasSolvable && distance(game.table, game.board) === null };
}

export function undo(game) {
  const last = game.history.pop();
  if (!last) return false;
  game.board = last.board;
  game.moves--;
  game.done = false;
  return last;
}

export function reset(game) {
  game.board = game.start.slice();
  game.moves = 0;
  game.history = [];
  game.done = isGoal(game.board);
}

// Steps left on a shortest route, or null when the player has hopped into a dead water:
// frogs cannot step backwards, so some positions have no route to the far bank at all.
export function remaining(game) {
  return distance(game.table, game.board);
}

export function distance(table, board) {
  if (!table) return null;
  const d = table.dist.get(boardKey(board));
  return d === undefined ? null : d;
}

export function canReachGoal(game) {
  return remaining(game) !== null;
}

export function overPar(game) {
  const left = remaining(game);
  if (left === null) return null;
  return Math.max(0, game.moves + left - game.par);
}

// The move a shortest route would take now, or null.
export function nextMove(game) {
  const left = remaining(game);
  if (left === null || left === 0) return null;
  for (const m of legal(game)) {
    const d = game.table.dist.get(boardKey(applyMove(game.board, m, game.rules)));
    if (d === left - 1) return m;
  }
  return null;
}

export function hint(game) {
  const m = nextMove(game);
  if (!m) return null;
  return { move: m, left: remaining(game) };
}

// The certified shortest route out of the *start* position, as moves. Used by the demo, the
// browser suite and `#/lot/<id>` share links; it is read out of the same table the panel
// prints `par` from, so it cannot be cheaper than the number on screen.
export function routeOf(game) {
  return tableRoute(game.table, game.start);
}

export function tableRoute(table, board) {
  const out = [];
  if (!table) return out;
  let cur = board.slice();
  const cap = table.size + 1;
  for (let i = 0; i < cap; i++) {
    const d = table.dist.get(boardKey(cur));
    if (d === undefined || d === 0) return out;
    let took = null;
    for (const m of legalMoves(cur, table.rules)) {
      const nd = table.dist.get(boardKey(applyMove(cur, m, table.rules)));
      if (nd === d - 1) { took = m; break; }
    }
    if (!took) return out;
    out.push(took);
    cur = applyMove(cur, took, table.rules);
  }
  return out;
}

// Three grades, and none of them is a step count.
//
// The spec asked for "steps > par => say so on the win card". Measured, that branch is
// unreachable: of all 1089 reachable positions of the n=6 river, every legal move either spends
// exactly one unit of the table distance or leaves the far bank permanently out of reach, so a
// frog that *does* arrive has necessarily spent exactly `par` hops (test/solve.test.mjs proves
// it for n = 1..6). Arriving late is not a thing in this game; arriving at all is the parity.
//
// So the stars are cut from the two counters that do move: how many times a hint was asked
// for, and how many times the player hopped into dead water and had to be wound back.
export function grade(game, { hints = 0, strands = 0 } = {}) {
  if (!game.done) return { key: 'rowing', label: '正在渡河', stars: null };
  if (!hints && !strands) return { key: 'perfect', label: '踏波无痕', stars: 3 };
  if (hints + strands <= 2) return { key: 'clean', label: '稳渡', stars: 2 };
  return { key: 'wandering', label: '曲径通幽', stars: 1 };
}
