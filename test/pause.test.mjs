// The pause has to be a behaviour, not a label: while the river is on hold the clock must
// stop, the pads must not move, and the reading must pick up exactly where it stopped when
// the river is released — again and again, because a pause that only works once is worse than
// no pause at all.
//
// The clock here is cranked by hand, so every number in the assertions is a number the test
// put there: no sleeping, no flake, and a broken second is visible as a wrong digit.

import { test, ok, eq, run } from '../tools/harness.mjs';
import { createPause } from '../js/core/pause.js';
import { boardOfSpec, createGame, play } from '../js/core/game.js';
import { goalTable } from '../js/core/solve.js';

const row22 = { id: 'fixture-22', tier: 'shoal', a: 2, b: 2, cells: 5, left: [0, 1], right: [3, 4], empty: 2, par: 8 };
const lotOf = (row) => ({ ...row, board: boardOfSpec(row), table: goalTable(boardOfSpec(row)) });

// A clock the test drives by hand.
function fakeClock(start = 1000) {
  return {
    t: start,
    now() { return this.t; },
    advance(ms) { this.t += ms; return this.t; },
  };
}

test('the reading on the panel stops while the river is on hold', () => {
  const c = fakeClock();
  const p = createPause({ now: () => c.now() });
  p.start();                 // the river lands on the table at t = 1000
  c.advance(2000);           // two seconds of thinking
  eq(p.elapsedMs(), 2000, 'the clock is running');
  p.pause();
  c.advance(6000);           // six seconds of being interrupted
  eq(p.elapsedMs(), 2000, 'the clock did not move while the river was on hold');
  p.resume();
  c.advance(2000);
  eq(p.elapsedMs(), 4000, 'and it picks up from the pause, not from zero');
});

test('a move offered during the pause does not land on the pads', () => {
  const c = fakeClock();
  const p = createPause({ now: () => c.now() });
  const game = createGame(lotOf(row22));
  // The same door the shell uses: a finger, a drag, the demo and a replay all arrive here.
  const commit = p.guard((m) => play(game, m));
  const move = { from: 1, to: 2 };
  p.pause();
  eq(commit(move), false, 'the move was refused');
  eq(game.moves, 0, 'and it was not billed');
  eq(game.board, [1, 1, 0, 2, 2], 'the pads did not move');
  p.resume();
  ok(commit(move), 'after the pause the same finger works again');
  eq(game.moves, 1, 'and the step is billed once, not twice');
  eq(game.board, [1, 0, 1, 2, 2], 'the frog landed exactly where it should');
});

test('the auto-play does not step while the river is on hold', () => {
  const c = fakeClock();
  const p = createPause({ now: () => c.now() });
  let steps = 0;
  const autoStep = p.guard(() => { steps += 1; });
  p.pause();
  autoStep();
  eq(steps, 0, 'the self-running stepper is held at the door');
  p.resume();
  autoStep();
  eq(steps, 1, 'and it walks again once the river is released');
});

test('three pauses in a row do not count a second twice', () => {
  const c = fakeClock();
  const p = createPause({ now: () => c.now() });
  p.start();
  c.advance(1000);
  eq(p.elapsedMs(), 1000, 'one running second');
  p.pause();  c.advance(4000);  eq(p.elapsedMs(), 1000, 'paused time is not on the clock');
  p.resume(); c.advance(1000);  eq(p.elapsedMs(), 2000, 'the clock picked up');
  p.pause();  c.advance(4000);  eq(p.elapsedMs(), 2000, 'still not');
  p.resume(); c.advance(1000);  eq(p.elapsedMs(), 3000, 'and picked up again');
  p.pause();  c.advance(4000);  eq(p.elapsedMs(), 3000, 'and again');
  p.resume(); c.advance(1000);  eq(p.elapsedMs(), 4000, 'four running seconds, counted once each');
  eq(p.paused, false, 'the river is on play again');
});

test('a river that is paused three times still lands exactly one step per finger', () => {
  const c = fakeClock();
  const p = createPause({ now: () => c.now() });
  const game = createGame(lotOf(row22));
  const commit = p.guard((m) => play(game, m));
  const route = [{ from: 1, to: 2 }, { from: 3, to: 1 }];
  for (const m of route) {
    p.pause();
    c.advance(2000);
    eq(commit(m), false, 'the pads are held while the river is on hold');
    eq(game.moves, route.indexOf(m), 'no step was billed during the pause');
    p.resume();
    ok(commit(m), 'the step lands after the pause');
  }
  eq(game.moves, 2, 'two steps, two of them, no double count');
  eq(game.board, [1, 2, 1, 0, 2], 'and the pads are exactly where the rules put them');
});

test('the reading of a finished river is final', () => {
  const c = fakeClock();
  const p = createPause({ now: () => c.now() });
  p.start();
  c.advance(1500);
  p.finish();
  c.advance(9000);
  eq(p.elapsedMs(), 1500, 'the reading stops where the river ended');
});

test('pausing twice or releasing twice changes nothing', () => {
  const c = fakeClock();
  const p = createPause({ now: () => c.now() });
  p.start();
  eq(p.pause(), true, 'the first pause takes');
  eq(p.pause(), false, 'a second pause is a no-op');
  eq(p.allow(), false, 'the door is shut');
  c.advance(1000);
  eq(p.elapsedMs(), 0, 'and the clock is still');
  eq(p.resume(), true, 'the first release lets go');
  eq(p.resume(), false, 'a second release is a no-op');
  eq(p.allow(), true, 'the door is open');
  c.advance(1000);
  eq(p.elapsedMs(), 1000, 'and the clock runs again');
});

run();
