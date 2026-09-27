// The seed. Deterministic, self-consistent, and *not* textbook FNV-1a — which is the one thing
// a reader of `hashSeed` is most likely to assume and most likely to get wrong.

import { test, ok, eq, run } from '../tools/harness.mjs';
import { hashSeed, mulberry32, rngFrom, todayKey } from '../js/core/rng.js';

// The textbook 32-bit FNV-1a, written out here and only here, so the two can be told apart.
function fnv1aTextbook(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

test('hashSeed is stable, in 32 bits, and a function of the string only', () => {
  eq(hashSeed('2026-09-27'), hashSeed('2026-09-27'), 'the same seed twice');
  const seeds = ['a', 'b', '2026-09-27', 'daily|2026-09-27', '跳蛙渡', '', 'shoal-01'];
  for (const s of seeds) {
    const h = hashSeed(s);
    ok(Number.isInteger(h) && h >= 0 && h <= 0xffffffff, `'${s}' escaped 32 bits: ${h}`);
    eq(h, hashSeed(String(s)), `'${s}' round-trips through String`);
  }
});

test('hashSeed is an FNV-1a *derived* two-round mixer, not FNV-1a', () => {
  // Each UTF-16 code unit is mixed twice: low byte, multiply, high byte, multiply. For ASCII
  // that means a second round the textbook form does not have, so the two disagree — and a
  // reader who "fixes" this back to the public algorithm changes every daily river in the game.
  eq(hashSeed('a'), 723832900, 'the house value, recorded in the contract');
  eq(fnv1aTextbook('a'), 3826002220, 'what textbook FNV-1a says instead');
  ok(hashSeed('a') !== fnv1aTextbook('a'), 'and they are not the same number');
  for (const s of ['frog', '2026-01-01', 'zzz']) {
    ok(hashSeed(s) !== fnv1aTextbook(s), `'${s}' would collide with the textbook form`);
  }
  // Non-ASCII proves the *high* byte is mixed too: dropping that round is the mistake this
  // sentence exists to prevent.
  ok(hashSeed('跳蛙渡') !== fnv1aTextbook('跳蛙渡'), 'a CJK seed must not match either form');
});

test('different seeds land in different places', () => {
  const days = [];
  for (let d = 1; d <= 28; d++) days.push(hashSeed(`2026-09-${String(d).padStart(2, '0')}`));
  eq(new Set(days).size, days.length, 'a month of dailies, 28 distinct hashes');
  const near = ['shoal-01', 'shoal-02'];
  ok(hashSeed(near[0]) !== hashSeed(near[1]), 'neighbouring ids do not collide');
});

test('mulberry32 replays exactly and stays in [0,1)', () => {
  const a = mulberry32(hashSeed('leap'));
  const b = mulberry32(hashSeed('leap'));
  const xs = [];
  for (let i = 0; i < 64; i++) {
    const v = a();
    eq(v, b(), `draw ${i}`);
    ok(v >= 0 && v < 1, `draw ${i} out of range: ${v}`);
    xs.push(v);
  }
  ok(new Set(xs).size === 64, 'a 64-draw repeat would be a broken state');
  const mean = xs.reduce((s, v) => s + v, 0) / xs.length;
  ok(mean > 0.3 && mean < 0.7, `mean ${mean.toFixed(3)} is not a plausible uniform draw`);
});

test('the helpers on the generator are the ones the tools use', () => {
  const rng = mulberry32(hashSeed('helpers'));
  eq(rng.int(5) >= 0 && rng.int(5) < 5, true, 'int is a valid index');
  eq(rng.int(0), 0, 'int(0) is 0 rather than NaN');
  for (let i = 0; i < 40; i++) {
    const v = rng.range(3, 8);
    ok(Number.isInteger(v) && v >= 3 && v <= 8, `range gave ${v}`);
  }
  const pick = rng.pick(['a', 'b', 'c']);
  ok(['a', 'b', 'c'].includes(pick), `pick gave ${pick}`);
  const shuffled = mulberry32(7).shuffle([1, 2, 3, 4, 5]);
  eq(shuffled.slice().sort((x, y) => x - y), [1, 2, 3, 4, 5], 'a shuffle is a permutation');
  eq(mulberry32(7).shuffle([1, 2, 3, 4, 5]), shuffled, 'and the same seed shuffles the same way');
});

test('rngFrom accepts a seed in any of its three shapes', () => {
  const fromString = rngFrom('2026-09-27');
  const fromHash = rngFrom(hashSeed('2026-09-27'));
  eq(fromString(), fromHash(), 'a string seeds the same stream as its own hash');
  const passed = rngFrom(fromString);
  eq(passed, fromString, 'an existing generator is handed back, not re-seeded');
  ok(rngFrom(12345)() !== undefined, 'a numeric seed works');
});

test('todayKey is the date the daily route is built from', () => {
  eq(todayKey(new Date(2026, 8, 27)), '2026-09-27', 'September is month 08 in a Date');
  eq(todayKey(new Date(2026, 0, 1)), '2026-01-01', 'and single digits are padded');
  eq(todayKey(new Date(2026, 11, 31)), '2026-12-31');
  eq(/^\d{4}-\d{2}-\d{2}$/.test(todayKey()), true, 'whatever today is, it has the shape');
  eq(hashSeed(todayKey(new Date(2026, 8, 27))), hashSeed('2026-09-27'), 'so the same day seeds the same river');
});

run();
