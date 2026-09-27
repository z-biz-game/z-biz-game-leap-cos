// The save file, driven against three back ends: none (node), a working one (a fake
// localStorage), and a hostile one that throws on every call the way Safari in private mode
// does. A game that dies on its own storage is worse than one that forgets.

import { test, ok, eq, run } from '../tools/harness.mjs';
import { SAVE_KEY, blank, forgetCache, storageMode, store } from '../js/core/storage.js';

function fakeDisk(overrides = {}) {
  const map = new Map();
  const disk = {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    ...overrides,
  };
  return disk;
}

function withDisk(disk, body) {
  const had = 'localStorage' in globalThis;
  const before = had ? globalThis.localStorage : undefined;
  if (disk) globalThis.localStorage = disk;
  else delete globalThis.localStorage;
  forgetCache();
  try {
    body(disk);
  } finally {
    if (had) globalThis.localStorage = before;
    else delete globalThis.localStorage;
    forgetCache();
  }
}

const throwing = {
  get name() { return 'SecurityError'; },
  getItem() { const e = new Error('blocked'); e.name = 'SecurityError'; throw e; },
  setItem() { const e = new Error('blocked'); e.name = 'SecurityError'; throw e; },
  removeItem() { const e = new Error('blocked'); e.name = 'SecurityError'; throw e; },
};

test('node has no usable localStorage, and the game does not care', () => {
  // Node 26 exposes the *property* with an undefined value in it, so "is it in globalThis" is
  // not the question; "can anything be read from it" is. js/core/storage.js asks the second.
  ok(!globalThis.localStorage || typeof globalThis.localStorage.getItem !== 'function',
    'node handed out a working localStorage, which this file is not written for');
  withDisk(null, () => {
    eq('localStorage' in globalThis, false, 'withDisk(null) really did take it away');
    eq(storageMode(), 'memory');
    eq(store.unlocked, 1);
    eq(store.records, {});
    eq(store.record('shoal-01'), null);
    const rec = store.solve('shoal-01', { moves: 3, par: 3, hints: 0 });
    eq(rec, { solved: true, best: 3, plays: 1, perfect: true });
    eq(storageMode(), 'memory', 'a memory session stays a memory session');
  });
});

test('best only ever goes down, plays only ever go up', () => {
  withDisk(fakeDisk(), () => {
    store.solve('linked-03', { moves: 24, par: 15, hints: 0 });
    eq(store.record('linked-03').best, 24);
    eq(store.record('linked-03').perfect, false, '24 is not the measured minimum');
    store.solve('linked-03', { moves: 15, par: 15, hints: 0 });
    eq(store.record('linked-03').best, 15, 'matching par pulls the record down');
    eq(store.record('linked-03').perfect, true);
    store.solve('linked-03', { moves: 31, par: 15, hints: 2 });
    eq(store.record('linked-03').best, 15, 'and a slower crossing cannot put it back up');
    eq(store.record('linked-03').perfect, true, 'the flag is sticky once earned');
    eq(store.record('linked-03').plays, 3);
    eq(store.stats.solves, 3);
    eq(store.stats.hops, 24 + 15 + 31, 'every billed step is counted once');
    eq(store.stats.hints, 2);
  });
});

test('a perfect tally is only earned without help', () => {
  withDisk(fakeDisk(), () => {
    store.solve('twined-02', { moves: 35, par: 35, hints: 1 });
    eq(store.record('twined-02').perfect, true, 'par is par, hinted or not');
    eq(store.stats.perfect, 0, 'but the lifetime tally says you needed the search');
    store.solve('twined-03', { moves: 35, par: 35, hints: 0 });
    eq(store.stats.perfect, 1);
  });
});

test('unlock only ever goes up', () => {
  withDisk(fakeDisk(), () => {
    eq(store.unlock(4), 4);
    eq(store.unlock(2), 4, 'replaying an early river hides nothing');
    eq(store.unlock(9), 9);
    eq(store.unlock(undefined), 9, 'junk does not reset the pointer');
    eq(store.unlock('12'), 12, 'a numeric string from a JSON round-trip still counts');
    eq(store.unlock(-3), 12);
  });
});

test('the daily slot is one row per date and survives a reload', () => {
  withDisk(fakeDisk(), (disk) => {
    eq(store.dailyDone('2026-09-27'), null);
    store.markDaily('2026-09-27', 'daily-2026-09-27');
    ok(store.dailyDone('2026-09-27').at > 0);
    store.solve('daily-2026-09-27', { moves: 48, par: 48, hints: 0 });
    const onDisk = JSON.parse(disk.map.get(SAVE_KEY));
    eq(onDisk.daily['2026-09-27'].id, 'daily-2026-09-27');
    eq(onDisk.records['daily-2026-09-27'].best, 48);
    eq(storageMode(), 'disk', 'and the module knows it really wrote');
    forgetCache();
    eq(store.dailyDone('2026-09-27').id, 'daily-2026-09-27', 'a cold re-read finds it');
    eq(store.record('daily-2026-09-27').perfect, true);
  });
});

test('reset clears the cache and the disk, and is not undone by the next read', () => {
  const disk = fakeDisk();
  withDisk(disk, () => {
    store.solve('master-01', { moves: 63, par: 63, hints: 0 });
    store.unlock(5);
    eq(Object.keys(store.records).length, 1);
    store.reset();
    eq(store.records, {}, 'memory is clean');
    eq(store.unlocked, 1);
    eq(store.stats.solves, 0);
    eq(disk.map.has(SAVE_KEY), false, 'and nothing was left on disk to come back');
    forgetCache();
    eq(Object.keys(store.records).length, 0, 'a cold read agrees');
  });
});

test('a corrupted or hand-edited save degrades instead of crashing', () => {
  withDisk(fakeDisk(), (disk) => {
    disk.map.set(SAVE_KEY, 'not json at all {');
    forgetCache();
    eq(store.records, {}, 'a torn write is treated as no save');
    eq(store.unlocked, 1);
    disk.map.set(SAVE_KEY, '{"records":{"a":{"best":"lots"}},"unlocked":"nine","stats":null}');
    forgetCache();
    eq(store.unlocked, 1, 'a string unlock is not a number of levels');
    eq(store.stats.solves, 0, 'a missing stats object is zero, not NaN');
    const rec = store.solve('a', { moves: 'x', par: 5, hints: undefined });
    eq(rec.best, 0, 'junk move counts become 0 rather than NaN');
    eq(Number.isFinite(store.stats.hops), true, 'and the tally stays a number');
    eq(blank().stats.hops, 0, 'blank() is a fresh file, not a shared object');
  });
});

test('a localStorage that throws on every call still gives a playable session', () => {
  withDisk(throwing, () => {
    eq(storageMode(), 'memory', 'the getter threw, so this session is memory-only');
    eq(store.record('shoal-01'), null);
    const rec = store.solve('shoal-01', { moves: 3, par: 3, hints: 0 });
    eq(rec.best, 3, 'and the record still works in memory');
    eq(store.unlock(3), 3);
    store.reset();
    eq(store.unlocked, 1, 'resetting a memory session is a no-op, not an exception');
  });
});

test('a back end that throws only on write is reported honestly', () => {
  const halfBroken = fakeDisk({
    setItem() { const e = new Error('QuotaExceededError'); e.name = 'QuotaExceededError'; throw e; },
  });
  withDisk(halfBroken, () => {
    eq(storageMode(), 'memory', 'before anything was attempted');
    store.solve('shoal-02', { moves: 8, par: 8, hints: 0 });
    eq(storageMode(), 'memory', 'the write failed and the panel is allowed to say so');
    eq(store.record('shoal-02').best, 8, 'the session still plays on');
  });
});

test('an object with the wrong shape is not treated as storage', () => {
  withDisk({ getItem: null }, () => {
    eq(storageMode(), 'memory');
    store.solve('shoal-03', { moves: 5, par: 5, hints: 0 });
    eq(store.record('shoal-03').plays, 1);
  });
});

test('the key is versioned and named for this game', () => {
  eq(SAVE_KEY, 'leap.save.v1', 'a sibling repo\'s save must not be readable as ours');
  ok(/leap/.test(SAVE_KEY));
});

run();
