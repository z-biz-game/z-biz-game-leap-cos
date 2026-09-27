// The generator: pure, seed-bounded, and honest about what it rejects.

import { test, ok, eq, run } from '../tools/harness.mjs';
import {
  MAX_BANK, MAX_CELLS, TIERS, blankStats, boardKeyFromLot, canonicalLot, makeLot,
  makeSet, sortLots, tierByKey, tierForPar, validateShape,
} from '../js/core/make.js';
import { boardKey, boardOfSpec, standardBoard } from '../js/core/game.js';
import { closedForm, formula, solveBoard } from '../js/core/solve.js';

test('the bands are contiguous and cover every solvable river', () => {
  eq(TIERS.map((t) => t.key), ['shoal', 'linked', 'twined', 'master']);
  eq(TIERS.map((t) => [t.min, t.max]), [[3, 8], [9, 24], [25, 48], [49, 120]]);
  for (let par = 3; par <= 120; par++) ok(tierForPar(par), `par ${par} has no band`);
  eq(tierForPar(2), null, 'a river with no frogs in it is not a lot');
  eq(tierForPar(121), null, 'and one past the published ceiling is not either');
});

test('the brief n-ranges land in the brief bands', () => {
  // shoal n<=2, linked 3..4, twined 5..6, master 7..8 — checked through the *measured* par,
  // which is the only thing the generator is allowed to look at.
  const want = { 1: 'shoal', 2: 'shoal', 3: 'linked', 4: 'linked', 5: 'twined', 6: 'twined', 7: 'master', 8: 'master' };
  for (const [n, band] of Object.entries(want)) {
    const lot = canonicalLot(Number(n), Number(n));
    eq(lot.tier, band, `n=${n}`);
    eq(lot.par, closedForm(Number(n)), `n=${n} par`);
    eq(lot.optimalPaths, 2, `n=${n} routes`);
    eq(lot.canonical, true);
  }
});

test('the uneven rivers are measured, not extrapolated', () => {
  const one = canonicalLot(1, 2);
  eq(one.par, formula(1, 2));
  eq(one.par, 5, 'hand-dead: 2 hops over 1, 3 slides');
  const six8 = canonicalLot(6, 8);
  eq(six8.par, 6 * 8 + 6 + 8);
  eq(six8.par, solveBoard(standardBoard(6, 8)).par, 'and the search agrees');
  eq(six8.optimalPaths, 2, 'unequal banks still force the mirror pair, once each side has two frogs');
  // ...and the exception is measurable too: with a single frog on one bank the forced chain
  // breaks and more shortest routes appear.
  // The exception is measurable, and it is prettier than the rule: with one frog on a bank,
  // the number of shortest routes goes 2, 3, 5, 8, 13, 21 — each a sum of the two before it,
  // because that lone frog can cross either before or after any block of the others. The
  // expectations below are written out by hand, and the search is what has to match them.
  const ones = [];
  for (let b = 1; b <= 8; b++) ones.push(canonicalLot(1, b).optimalPaths);
  eq(ones, [2, 3, 5, 8, 13, 21, 34, 55], '1-vs-b shortest-route counts follow the Fibonacci walk');
  eq(ones.slice(2).every((v, i) => v === ones[i + 1] + ones[i]), true, 'and the recurrence holds on the measured values');
  for (let a = 2; a <= 6; a++) {
    for (let b = 2; b <= 6; b++) eq(canonicalLot(a, b).optimalPaths, 2, `${a}/${b}`);
  }
});

test('makeLot is a pure function of its seed', () => {
  for (const tier of TIERS) {
    const a = makeLot('same-seed', tier.key);
    const b = makeLot('same-seed', tier.key);
    eq(a, b, tier.key);
    ok(a.par >= tier.min && a.par <= tier.max, `${tier.key} lot measured ${a.par}`);
    eq(a.tier, tier.key, 'and it stayed in the band it was asked for');
  }
  const c = makeLot('other-seed', 'twined');
  ok(boardKeyFromLot(c) !== boardKeyFromLot(makeLot('same-seed', 'twined')), 'a different token, a different river');
});

test('every generated lot is a legal, solvable, honestly-labelled position', () => {
  for (const tier of TIERS) {
    for (let i = 0; i < 12; i++) {
      const lot = makeLot(`audit-${i}`, tier.key);
      ok(lot, 'generator returned nothing for a published band');
      eq(lot.cells, lot.a + lot.b + 1, 'width against frogs');
      eq(lot.left.length + lot.right.length + 1, lot.cells, 'the lists against the width');
      const pads = [...lot.left, ...lot.right];
      eq(new Set(pads).size, pads.length, 'no two frogs share a pad');
      ok(!pads.includes(lot.empty), 'and no frog is standing on the free pad');
      eq(pads.length + 1, lot.cells, 'one free pad, nothing else missing');
      const measured = solveBoard(boardOfSpec(lot));
      eq(measured.par, lot.par, 'par reproduced');
      eq(measured.optimalPaths, lot.optimalPaths, 'route count reproduced');
      eq(measured.reachable, lot.states, 'state count reproduced');
      eq(lot.canonical, boardKeyFromLot(lot) === boardKey(standardBoard(lot.a, lot.b)), 'the canonical stamp is the position, not a wish');
      ok(lot.a <= MAX_BANK && lot.b <= MAX_BANK, 'published ceiling respected');
    }
  }
});

test('the generator bills what it rejects, and the bills add up', () => {
  const stats = blankStats();
  const per = 40;
  for (let i = 0; i < per; i++) makeLot(`probe-${i}`, 'linked', stats);
  eq(stats.accepted, per, JSON.stringify(stats));
  eq(stats.rejectPar + stats.rejectDead + stats.rejectShape, stats.attempts - stats.accepted, 'every proposal accounted for');
  ok(stats.attempts >= per, `${stats.attempts} proposals for ${per} lots`);
  ok(stats.maxStates > 0 && stats.worstMs >= 0, 'and it timed itself');
  const shoal = blankStats();
  for (let i = 0; i < 20; i++) ok(makeLot(`shoal-${i}`, 'shoal', shoal).par <= 8, 'the shoal band is reachable');
});

test('validateShape keeps the published game inside the provable size', () => {
  eq(validateShape(1, 1), null);
  eq(validateShape(8, 8), null);
  ok(/past the published/.test(validateShape(9, 9)), 'nine per side is not published');
  ok(/past the published/.test(validateShape(8, 9)), 'nor is a mixed river that wide');
  ok(/at least one frog/.test(validateShape(0, 3)), 'an empty bank');
  ok(/integers/.test(validateShape(1.5, 2)), 'half a frog');
  eq(MAX_CELLS, 17);
  eq(2 * MAX_BANK + 1, MAX_CELLS, 'the widest published river');
});

test('a set is distinct positions, and skipKeys are really skipped', () => {
  const set = makeSet('twined', 6, 'distinct');
  eq(set.length, 6);
  const keys = set.map(boardKeyFromLot);
  eq(new Set(keys).size, 6, 'two ids, one river');
  const skipped = makeSet('twined', 5, 'distinct', [keys[0], keys[1]]);
  ok(!skipped.map(boardKeyFromLot).includes(keys[0]), 'the position handed in as published is not published again');
});

test('campaign order is by measured par, ties broken by position', () => {
  const lots = [
    { par: 8, left: [0], right: [2], empty: 1, cells: 3 },
    { par: 3, left: [0], right: [2], empty: 1, cells: 3 },
    { par: 3, left: [0, 1], right: [3], cells: 4, empty: 2 },
  ];
  eq(sortLots(lots).map((l) => l.par), [3, 3, 8]);
  eq(sortLots(lots)[2].par, 8, 'and the input array is untouched');
  eq(lots[0].par, 8);
});

test('the water is display-only but still deterministic', () => {
  const a = makeLot('skin-seed', 'master');
  const b = makeLot('skin-seed', 'master');
  eq(a.skin, b.skin);
  ok(a.skin.hue >= 150 && a.skin.hue <= 215, `hue ${a.skin.hue}`);
  eq(a.skin.width, a.cells, 'the renderer is told how many pads to lay out');
  eq(a.par, b.par, 'and the skin changed nothing about the difficulty');
});

test('tierByKey refuses a band that does not exist', () => {
  let threw = false;
  try { makeLot('x', 'abyss'); } catch (err) { threw = /unknown tier/.test(err.message); }
  ok(threw, 'a typo in a route must be loud, not a silent empty board');
  eq(tierByKey('master').key, 'master');
});

run();
