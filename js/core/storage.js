// The save file: one key, plain JSON, a versioned shape so an old save is recognised rather
// than mistaken for a new one.
//
// This is the only module under js/core/ that touches a browser global, and it touches it
// through `globalThis` on purpose: `window.localStorage` is not "undefined when unavailable" —
// in Safari private mode, under a blocked third-party origin and on a file:// page, *reading
// the property itself throws* a SecurityError rather than handing back null. So every access,
// including the property read, sits inside a try, and a hostile back end degrades the session
// to memory instead of killing the river. Under `node --test` there is no localStorage at all,
// which is how the same module stays importable by the build tools.
//
// Two monotone rules make the file reviewable instead of a bag of fields:
//   * `best` only ever goes down — a slower re-crossing cannot improve a record;
//   * `unlocked` only ever goes up — finishing an easy river late cannot hide a hard one.
// Both are asserted against a throwing back end in test/storage.test.mjs.
//
// Nothing the game *needs* lives here: the campaign is js/data/lots.js and every lot is a pure
// function of its seed, so a wiped save costs history, never content.

// 存档格式版本号：写档带上、读档校验，将来升 v2 时旧档整档丢弃而不是被误读。
export const SAVE_VERSION = 1;
export const SAVE_KEY = 'leap.save.v1';

// A back end counts as present only if it answers a probe read. `globalThis.localStorage` can
// exist and still refuse everything it is asked to do — Safari private mode hands back an
// object whose every method throws — and reporting that as 'disk' would tell a player their
// records are saved when nothing can be saved.
function backend() {
  let ls = null;
  try {
    ls = globalThis.localStorage;
  } catch (err) {
    return null; // the property itself threw: memory-only for the rest of the session
  }
  if (!ls || typeof ls.getItem !== 'function' || typeof ls.setItem !== 'function') return null;
  try {
    ls.getItem(SAVE_KEY);
  } catch (err) {
    return null;
  }
  return ls;
}

function readRaw(ls) {
  if (!ls) return null;
  try {
    return globalThis.localStorage.getItem(SAVE_KEY);
  } catch (err) {
    return null; // backend() probed it once; a later throw is still possible
  }
}

function writeRaw(ls, value) {
  if (!ls) return false;
  try {
    globalThis.localStorage.setItem(SAVE_KEY, value);
    return true;
  } catch (err) {
    return false; // quota, or a profile that only lets you read
  }
}

function dropRaw(ls) {
  if (!ls) return;
  try {
    ls.removeItem(SAVE_KEY);
  } catch (err) {
    /* nothing was ever persisted */
  }
}

// A hand-edited or half-written save can carry anything in a numeric field, and `undefined + 1`
// is NaN, which serialises to null and then reads back as a record that plays forever without
// ever counting. Coerce instead of trusting.
function count(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

export function blank() {
  return {
  v: SAVE_VERSION,
    records: {},
    daily: {},
    unlocked: 1,
    stats: { solves: 0, perfect: 0, hops: 0, hints: 0 },
  };
}

let cache = null;
let lastMode = null;

function load() {
  if (cache) return cache;
  const ls = backend();
  const raw = readRaw(ls);
  if (raw) {
    try {
      const p = JSON.parse(raw);
      if (p && typeof p === 'object' && !Array.isArray(p)
          && (p.v === undefined || p.v === SAVE_VERSION)) {
        const base = blank();
        const records = {};
        if (p.records && typeof p.records === 'object') {
          for (const [id, rec] of Object.entries(p.records)) {
            const clean = sanitizeRecord(rec);
            if (clean) records[id] = clean;
          }
        }
        cache = {
          records: Object.keys(records).length || !p.records ? records : base.records,
          daily: p.daily && typeof p.daily === 'object' ? p.daily : base.daily,
          unlocked: count(p.unlocked) || base.unlocked,
          stats: {
            solves: count(p.stats && p.stats.solves),
            perfect: count(p.stats && p.stats.perfect),
            hops: count(p.stats && p.stats.hops),
            hints: count(p.stats && p.stats.hints),
          },
        };
        if (lastMode === null) lastMode = 'memory';
        return cache;
      }
    } catch (err) {
      /* a corrupt save is not worth keeping; start clean rather than crash the shell */
    }
  }
  cache = blank();
  if (lastMode === null) lastMode = 'memory';
  return cache;
}

function persist() {
  const wrote = writeRaw(backend(), JSON.stringify(cache));
  lastMode = wrote ? 'disk' : 'memory';
  return wrote;
}

// One record as the game understands it, whatever came out of the JSON.
function sanitizeRecord(r) {
  if (!r || typeof r !== 'object') return null;
  return {
    solved: !!r.solved,
    best: count(r.best),
    plays: count(r.plays),
    perfect: !!r.perfect,
  };
}

// 'disk' once a write has actually landed this session, 'memory' until then. The panel prints
// it so a player on a locked-down browser is never told their records are saved when nothing
// has been saved — reading a file back is not the same promise as writing one.
export function storageMode() {
  if (lastMode === null) load();
  return lastMode;
}

export const store = {
  get records() { return load().records; },
  get stats() { return load().stats; },
  get daily() { return load().daily; },
  get unlocked() { return load().unlocked; },

  record(id) {
    return load().records[id] || null;
  },

  // `par` is the BFS minimum over this river's exact reachable set, so "perfect" is a fact
  // about the position rather than a feeling: you matched the search. `best` can only fall.
  solve(id, { moves, par, hints }) {
    const s = load();
    const prev = sanitizeRecord(s.records[id]);
    const played = count(moves) || 0;
    const cur = {
      solved: true,
      best: !prev || !prev.best || played < prev.best ? played : prev.best,
      plays: count(prev && prev.plays) + 1,
      perfect: played <= par || !!(prev && prev.perfect),
    };
    s.records[id] = cur;
    s.stats.solves += 1;
    s.stats.hops += played;
    s.stats.hints += count(hints);
    if (played <= par && !count(hints)) s.stats.perfect += 1;
    persist();
    return cur;
  },

  unlock(n) {
    const s = load();
    const want = count(n);
    if (want > s.unlocked) s.unlocked = want;
    persist();
    return s.unlocked;
  },

  markDaily(dateKey, id) {
    const s = load();
    s.daily[dateKey] = { id, at: Date.now() };
    persist();
    return s.daily[dateKey];
  },

  dailyDone(dateKey) {
    return load().daily[dateKey] || null;
  },

  // Wipe: the in-memory cache *and* whatever is on disk. A stale cache surviving a wipe would
  // be worse than no wipe at all, because the screen would say "cleared" and the records would
  // come back on the next load.
  reset() {
    cache = blank();
    const ls = backend();
    dropRaw(ls);
    lastMode = ls ? 'disk' : 'memory';
    return cache;
  },
};

// Tests reach for this between cases: the cache is module state and node has no localStorage,
// so a throwing-back-end scenario cannot be reproduced by patching a global and expecting
// earlier reads to be forgotten.
export function forgetCache() {
  cache = null;
  lastMode = null;
}
