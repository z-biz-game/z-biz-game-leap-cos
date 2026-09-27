// The shipped product, re-measured. This is the suite that makes "the numbers are measurements"
// true rather than aspirational: every row of js/data/lots.js is re-solved from its serialised
// form, and the validator is then driven with the ways a hand-edit could have gone wrong.

import { test, ok, eq, run } from '../tools/harness.mjs';
import { ALL, TIERS, byId, closedFormProof, dailyLot, lotAt, lotsIn, randomLot, stats, tableFor, validateLot } from '../js/core/library.js';
import { LOTS, MEASURED, TIERS_META } from '../js/data/lots.js';
import { boardKey, boardOfSpec, standardBoard } from '../js/core/game.js';
import { closedForm, formula, goalTable, solveBoard } from '../js/core/solve.js';

// A hand-written row rather than "whatever row 4 of the bake happens to be": these fixtures
// must keep their meaning when the generator changes, and a negative test that silently stops
// being negative is worse than no test. `2 2 . 2 2` is the n=2 river; every number in it is the
// measured truth for that position (test/solve.test.mjs derives them independently).
const BASE = {
  id: 'fixture-22', tier: 'shoal', a: 2, b: 2, cells: 5,
  left: [0, 1], right: [3, 4], empty: 2,
  par: 8, optimalPaths: 2, states: 23, deadEnds: 4, arrangements: 30,
  canonical: true, wandered: 0, skin: { hue: 190, reeds: 1, lily: 1, ripple: 1, width: 5 },
};
// 1 . 1 2 2 — the same river one forced hop into itself: not a bank-to-bank start, 7 moves from
// the far bank, and with exactly *one* shortest route left rather than a mirror pair. Every
// number is the measured truth for that position, and it is the row a test reaches for when it
// needs `canonical: false`.
const MID = { ...BASE, left: [0, 2], right: [3, 4], empty: 1, canonical: false, par: 7, optimalPaths: 1, states: 14, deadEnds: 3 };
const reRow = (patch) => ({ ...JSON.parse(JSON.stringify(BASE)), ...patch });

test('the pool loaded and every shipped row survives a re-solve', () => {
  ok(ALL.length >= 30, `only ${ALL.length} lots shipped`);
  const bad = [];
  for (const row of LOTS) {
    const err = validateLot(row);
    if (err) bad.push(`${row.id}: ${err}`);
  }
  eq(bad, [], 'a printed number that no search agrees with');
});

test('every band has rows and each row lands inside its own window', () => {
  for (const tier of TIERS) {
    const mine = lotsIn(tier.key);
    ok(mine.length >= 4, `${tier.key} has only ${mine.length} lots`);
    for (const l of mine) {
      ok(l.par >= tier.min && l.par <= tier.max, `${l.id} par ${l.par} outside ${tier.min}-${tier.max}`);
    }
  }
});

test('every band contains at least one row whose par the closed form predicts', () => {
  // The asymmetric evidence: bake measured these, and here they are recomputed without a
  // search at all.
  for (const tier of TIERS) {
    const canon = lotsIn(tier.key).filter((l) => l.canonical);
    ok(canon.length >= 1, `${tier.key} ships no bank-to-bank river`);
    for (const l of canon) eq(l.par, formula(l.a, l.b), `${l.id} against ab+a+b`);
  }
  const equal = ALL.filter((l) => l.canonical && l.a === l.b).map((l) => [l.a, l.par]);
  eq(equal.sort((x, y) => x[0] - y[0]), [[1, 3], [2, 8], [3, 15], [4, 24], [5, 35], [6, 48], [7, 63], [8, 80]]);
});

test('re-solve gate: a hand-edited par is caught', () => {
  const row = reRow({ par: BASE.par + 1 });
  ok(/printed par/.test(validateLot(row)), validateLot(row));
  const lower = reRow({ par: 1 });
  ok(/printed par/.test(validateLot(lower)), validateLot(lower));
});

test('re-solve gate: a hand-edited route count and state count are caught', () => {
  ok(/optimal routes/.test(validateLot(reRow({ optimalPaths: 99 }))), 'optimalPaths');
  ok(/reachable pads/.test(validateLot(reRow({ states: 12345 }))), 'states');
});

test('re-solve gate: a stale or impossible position is caught', () => {
  ok(/share pad/.test(validateLot(reRow({ left: [0, 0] }))), 'two frogs, one pad');
  ok(/gap on pad 1 collides/.test(validateLot(reRow({ left: [0, 1], empty: 1 }))), 'a gap under a frog');
  // Same number of frogs, every one of them shifted off the far end of the river: the width
  // check cannot fire, so only the bounds check can catch this.
  ok(/off the river/.test(validateLot(reRow({ right: [5, 6] }))), 'a frog on a pad that does not exist');
  ok(/pads wide/.test(validateLot(reRow({ cells: 99 }))), 'a river that disagrees with its own frogs');
  // 1 1 2 2 . — dead water: no legal move at all, so no par exists to print.
  ok(/cannot reach the far bank/.test(validateLot(reRow({ left: [0, 1], right: [2, 3], empty: 4, canonical: false }))),
    'a stranded river filed as a puzzle');
  eq(validateLot(MID), null, 'the mid-river fixture itself is honest');
  eq(solveBoard(boardOfSpec(MID)).optimalPaths, 1, 'and it really does have a single shortest route');
});

test('re-solve gate: a mislabelled band and a fake canonical stamp are caught', () => {
  const deep = LOTS.find((l) => l.par > 40) || { ...MID, par: 44, tier: 'twined', states: 90 };
  ok(/outside band/.test(validateLot({ ...deep, tier: 'shoal' })), 'a 40-move river in the shallow band');
  ok(/marked canonical/.test(validateLot({ ...MID, canonical: true })), 'a mid-river position claiming the closed form');
  ok(/unknown tier/.test(validateLot({ ...BASE, tier: 'abyss' })), 'a band that does not exist');
  // The `ab + a + b` clause inside validateLot is a second belt on the same buckle: the
  // re-solve in front of it catches a wrong par first, so the only way to reach it is to lie
  // about the position as well — which is what this row does (a bank-to-bank 2/2 stamp on a
  // river that is really 1/2 wide).
  ok(/ab\+a\+b says|printed par/.test(validateLot({ ...BASE, a: 2, b: 3, left: [0, 1], right: [3, 4, 5], empty: 2, cells: 6 })),
    'a canonical stamp that the closed form rejects');
});

test('the position on screen is the position that was measured', () => {
  for (const l of ALL.slice(0, 12)) {
    const table = tableFor(l);
    eq(table.dist.get(boardKey(l.board)), l.par, `${l.id}: the table the game reads agrees with the row`);
    eq(boardOfSpec(l), l.board, 'and the serialised pads decode to the same river');
  }
});

test('stats() reports what actually shipped, and the band meta matches', () => {
  const s = stats();
  eq(s.lots, LOTS.length);
  for (const tier of TIERS) {
    const meta = TIERS_META.find((m) => m.key === tier.key);
    const mine = LOTS.filter((l) => l.tier === tier.key).map((l) => l.par);
    eq(meta.min, Math.min(...mine), `${tier.key} min`);
    eq(meta.max, Math.max(...mine), `${tier.key} max`);
    eq(meta.lots, mine.length, `${tier.key} count`);
    eq(s.byTier[tier.key].min, Math.min(...mine), 'stats and meta read the same rows');
  }
});

test('the daily river is the same puzzle twice, and its par is the closed form', () => {
  const a = dailyLot('2026-09-27');
  const b = dailyLot('2026-09-27');
  eq(a.id, 'daily-2026-09-27');
  eq(boardKey(a.board), boardKey(b.board), 'same day, same pads');
  eq(a.par, b.par);
  ok(a.a === a.b, 'the daily river has equal banks, so n(n+2) speaks about it');
  eq(a.par, closedForm(a.a), `${a.par} vs n(n+2) = ${closedForm(a.a)}`);
  eq(validateLot({ ...a, id: 'daily-check' }), null, 'and it passes the product validator');
  const other = dailyLot('2026-09-28');
  ok(other.par !== a.par || boardKey(other.board) !== boardKey(a.board), 'a different day is a different river');
});

test('a random river repeats itself from its token and stays in its band', () => {
  for (const tier of TIERS) {
    const first = randomLot('shared-token', tier.key);
    const again = randomLot('shared-token', tier.key);
    eq(boardKey(first.board), boardKey(again.board), tier.key);
    eq(first.par, again.par, tier.key);
    ok(first.par >= tier.min && first.par <= tier.max, `${tier.key} lot at ${first.par}`);
    eq(validateLot({ ...first, cells: first.cells }), null, `${first.id} passes the same validator as the campaign`);
  }
  const other = randomLot('another-token', 'twined');
  ok(other.par !== randomLot('shared-token', 'twined').par || boardKey(other.board) !== boardKey(randomLot('shared-token', 'twined').board));
});

test('lookup helpers do what a route needs them to', () => {
  const first = ALL[0];
  eq(byId(first.id).par, first.par);
  eq(byId('no-such-lot'), null);
  eq(lotAt(0).id, first.id);
  eq(lotAt(-1).id, ALL[ALL.length - 1].id, 'a negative index wraps instead of crashing');
  eq(lotAt(ALL.length).id, first.id, 'and so does one past the end');
});

test('the browser-facing proof recomputes rather than quoting', () => {
  const p = closedFormProof(3);
  eq(p, { n: 3, search: 15, paths: 2, states: 72, closedForm: 15, openings: 2 });
  eq(closedFormProof(5).search, 35);
});

test('MEASURED carries the structural half of the bake — and only that half', () => {
  eq(MEASURED.anchors.map((a) => a.par), [3, 8, 15, 24, 35, 48, 63, 80, 99]);
  eq(MEASURED.anchors.slice(0, 6).map((a) => a.paths), [2, 2, 2, 2, 2, 2]);
  eq(MEASURED.anchors.map((a) => a.openings), [2, 2, 2, 2, 2, 2, 2, 2, 2]);
  eq(MEASURED.ruleCheck.standard.paths, 2);
  ok(MEASURED.ruleCheck.loose.paths > MEASURED.ruleCheck.standard.paths, 'the rule relaxation changed nothing');
  eq(MEASURED.bands.map((b) => b.key), ['shoal', 'linked', 'twined', 'master']);
  for (const b of MEASURED.bands) {
    const pars = LOTS.filter((l) => l.tier === b.key).map((l) => l.par);
    eq(b.shipped, [Math.min(...pars), Math.max(...pars)], b.key);
    ok(b.shipped[0] >= b.window[0] && b.shipped[1] <= b.window[1], `${b.key} outside its window`);
  }
  // Timings are deliberately absent. `tools/bake.mjs` measures and prints them, DESIGN.md quotes
  // them, and that is where a machine-dependent number belongs: a shipped file that carried
  // `msPerLot` would be rewritten by every re-bake on any other machine, and then "the product
  // reproduces its own printed numbers" could no longer be checked with a checksum.
  eq(JSON.stringify(MEASURED).includes('ms'), false, 'a timing leaked into the shipped data');
});

test('solving a shipped row does not disturb the pool', () => {
  const before = boardKey(ALL[3].board);
  solveBoard(ALL[3].board);
  goalTable(ALL[3].board);
  randomLot('purity', 'linked');
  eq(boardKey(ALL[3].board), before);
  eq(standardBoard(2, 2), [1, 1, 0, 2, 2], 'and the helpers still build what they say');
});

run();
