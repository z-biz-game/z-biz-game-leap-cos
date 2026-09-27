// The shell: hash routes in, canvas out, records in between. Nothing here knows the rules of
// the river — js/core/game.js is the only implementation of them — and nothing here draws —
// that is js/view.js. What this file owns is routes, the save file, the counters the win card
// prints, and the test hook tools/playtest.mjs drives with a real mouse.
//
// One rule about cost, because the contract is explicit: a frog tap does pure table lookups
// only. The distance table for the lot is built once, when the lot loads; every hop afterwards
// is a Map read. There is no live search behind a click, and no `limit=2` early stop either,
// because the whole reachable set of a published river is at most 10 662 positions (n=9, not
// shipped; the shipped ceiling is n=8 at 5 093) and it is walked at load, where the wait is one
// frame's worth.

import {
  boardKey, counts, createGame, GAP, grade, hint, LEAP, overPar, play, remaining, reset,
  tableRoute, undo,
} from './core/game.js';
import { anchorTable, solveBoard } from './core/solve.js';
import { store, storageMode } from './core/storage.js';
import {
  ALL, TIERS, byId, closedFormProof, dailyLot, lotAt, lotsIn, randomLot, stats as poolStats,
  tableFor, tierByKey, validateLot,
} from './core/library.js';
import { todayKey, hashSeed } from './core/rng.js';
import { createView } from './view.js';

const $ = (id) => document.getElementById(id);
const el = {
  modes: $('modes'), totals: $('totals'), crumbs: $('crumbs'), readout: $('readout'),
  shelf: $('shelf'), hintline: $('hintline'), curtain: $('curtain'), stars: $('stars'),
  verdict: $('verdict'), tally: $('tally'), proof: $('proof'), undo: $('undo'), hint: $('hint'),
  demo: $('demo'), restart: $('restart'), share: $('share'), next: $('next'), again: $('again'),
  toast: $('toast'), canvas: $('river'), wipe: $('wipe'), saveMode: $('save-mode'),
};

const LOTS = ALL.length;
const app = {
  mode: 'campaign',
  index: 1,
  route: null,
  lot: null,
  game: null,
  hints: 0,
  strands: 0,
  label: '',
  day: null,
};

// The anchors, computed once per page rather than quoted from a laptop. @boot reads this object
// and asserts the same nine numbers the node suite does, on the device doing the reading.
let proofProbe = null;
function probeProof() {
  if (proofProbe) return proofProbe;
  const t0 = performance.now();
  const rows = anchorTable(9);
  proofProbe = {
    ms: Number((performance.now() - t0).toFixed(2)),
    rows: rows.map((r) => ({ n: r.n, par: r.bfs, dfs: r.dfs, closed: r.formula, paths: r.optimalPaths, openings: r.openings, states: r.reachable })),
  };
  return proofProbe;
}

function clampIndex(n) {
  return Math.min(LOTS, Math.max(1, Number(n) || 1));
}

// #/c/12 · #/lot/twined-04 · #/daily · #/random/twined/4kq2 · #/ -> campaign
function parseHash(hash = location.hash) {
  const p = String(hash).replace(/^#\/?/, '').split('/').filter(Boolean);
  if (p[0] === 'daily') return { mode: 'daily' };
  if (p[0] === 'random') return { mode: 'random', tier: p[1] || TIERS[0].key, key: p[2] || null };
  if (p[0] === 'lot') return { mode: 'lot', id: p[1] };
  if (p[0] === 'c' || p[0] === 'campaign') return { mode: 'campaign', index: clampIndex(p[1]) };
  const n = Number(p[0]);
  if (Number.isFinite(n) && p.length === 1) return { mode: 'campaign', index: clampIndex(n) };
  return { mode: 'campaign', index: 1 };
}

function linkFor(rt) {
  if (rt.mode === 'daily') return '#/daily';
  if (rt.mode === 'random') return `#/random/${rt.tier}/${rt.key}`;
  if (rt.mode === 'lot') return `#/lot/${rt.id}`;
  return `#/c/${rt.index}`;
}

function resolve(rt) {
  if (rt.mode === 'daily') {
    const day = todayKey();
    return { lot: dailyLot(day), label: `每日跳蛙渡 · ${day}`, note: day, day };
  }
  if (rt.mode === 'random') {
    const tier = tierByKey(rt.tier);
    return { lot: randomLot(rt.key, tier.key), label: `随机 · ${tier.label}`, note: tier.blurb };
  }
  if (rt.mode === 'lot') {
    const lot = byId(rt.id) || ALL[0];
    return { lot, label: `河段 ${lot.id}`, note: tierByKey(lot.tier).label };
  }
  const lot = lotAt(rt.index - 1);
  return { lot, label: `第 ${rt.index} 段`, note: `共 ${LOTS} 段 · ${tierByKey(lot.tier).label}` };
}

const view = createView(el.canvas, {
  onMove: (m) => commit(m),
  onIllegal: (pad, board, tried) => {
    const species = board[pad] === LEAP ? '左岸蛙' : '右岸蛙';
    el.hintline.innerHTML = tried === undefined
      ? `<span class="no">${pad + 1} 号莲叶上的${species}现在无路可走</span> —— 前面必须是空格，或恰好一只对岸的蛙加一个空格`
      : `<span class="no">它跳不到 ${tried + 1} 号莲叶</span> —— 只能朝前一步，或越过恰好一只对岸的蛙`;
  },
});

function setGame(lot, label) {
  stopDemo('');
  app.lot = lot;
  app.label = label || app.label;
  const withTable = { ...lot, table: lot.table || tableFor(lot) };
  app.game = createGame(withTable);
  app.hints = 0;
  app.strands = 0;
  view.attach(app.game);
  el.curtain.hidden = true;
  say('');
}

function say(html) { el.hintline.innerHTML = html; }
function starText(n) { return n === null ? '···' : '★'.repeat(n) + '☆'.repeat(3 - n); }

function field(label, value, note, cls = '') {
  return `<div class="${cls}"><dt>${label}</dt><dd>${value}</dd><dt><small>${note}</small></dt></div>`;
}

function renderCrumbs() {
  const tier = tierByKey(app.lot.tier);
  const rec = store.record(app.lot.id);
  const left = remaining(app.game);
  const dead = left === null;
  el.crumbs.innerHTML = `${app.label}<b>${tier.label}<span class="band"> ${tier.blurb}</span></b>`;
  el.readout.innerHTML = [
    field('步数', app.game.moves, '已落的蛙'),
    field('最短', app.lot.par, dead ? '已证下界' : `本河段 ${app.lot.states} 局面穷尽`, 'par'),
    field('距对岸', dead ? '困' : left, dead ? '退回可解' : '还需落步', dead ? 'bad' : ''),
    field('最优路线', app.lot.optimalPaths, app.lot.optimalPaths === 2 ? '互为镜像' : '条'),
    field('最佳', rec && rec.best ? rec.best : '—', rec && rec.perfect ? '等于最短' : '你的纪录', 'best'),
    field('提示 / 困水', `${app.hints} / ${app.strands}`, '本段计数'),
  ].join('');
  el.undo.disabled = !app.game.moves || app.game.done;
  el.hint.disabled = app.game.done;
  el.demo.disabled = app.game.done;
}

function renderTotals() {
  const solvedN = ALL.filter((l) => store.record(l.id) && store.record(l.id).solved).length;
  const perfectN = ALL.filter((l) => store.record(l.id) && store.record(l.id).perfect).length;
  el.totals.innerHTML = `已渡 <b>${solvedN}</b>/${LOTS} · 无痕 <b>${perfectN}</b> · 提示 <b>${store.stats.hints}</b>`;
  el.saveMode.textContent = storageMode() === 'disk' ? 'localStorage 可写' : '本次会话内存';
}

function renderShelf() {
  if (app.mode === 'campaign') {
    const unlocked = store.unlocked;
    let html = '';
    for (const tier of TIERS) {
      html += `<p class="tier">${tier.label} · ${tier.blurb}</p>`;
      for (const lot of lotsIn(tier.key)) {
        const n = ALL.indexOf(lot) + 1;
        const rec = store.record(lot.id);
        const cls = [
          n === app.index ? 'here' : '',
          rec && rec.perfect ? 'perfect' : rec && rec.solved ? 'done' : '',
        ].filter(Boolean).join(' ');
        html += `<button type="button" data-index="${n}" class="${cls}" title="${lot.par} 步 · ${lot.a}+${lot.b} 蛙" ${n > unlocked ? 'disabled' : ''}>${n}</button>`;
      }
    }
    el.shelf.innerHTML = html;
    el.shelf.querySelectorAll('button[data-index]').forEach((b) => {
      b.addEventListener('click', () => go(`#/c/${b.dataset.index}`));
    });
    return;
  }
  if (app.mode === 'random') {
    let html = '<p class="tier">选一段（数字是实测步数带）</p>';
    for (const tier of TIERS) {
      const on = tier.key === app.route.tier ? 'here' : '';
      html += `<button type="button" class="${on}" data-tier="${tier.key}">${tier.label}<br><small>${tier.blurb}</small></button>`;
    }
    html += '<button type="button" class="wide" data-reroll="1">换一条河</button>';
    el.shelf.innerHTML = html;
    el.shelf.querySelectorAll('button[data-tier]').forEach((b) => {
      b.addEventListener('click', () => go(`#/random/${b.dataset.tier}/${token()}`));
    });
    el.shelf.querySelector('[data-reroll]').addEventListener('click', () => go(`#/random/${app.route.tier}/${token()}`));
    return;
  }
  if (app.mode === 'daily') {
    const done = app.day && store.dailyDone(app.day);
    el.shelf.innerHTML = `<p class="tier">今天这条河对所有人相同${done ? ' · 已渡' : ''}</p>`
      + `<button type="button" class="wide" data-back="1">回到第 ${store.unlocked} 段</button>`;
  } else {
    el.shelf.innerHTML = '<p class="tier">分享的河段</p>';
  }
  const back = el.shelf.querySelector('[data-back]');
  if (back) back.addEventListener('click', () => go(`#/c/${store.unlocked}`));
}

function token() {
  // `Math.random()` can in principle return exactly 0, which would stringify to "0" and mint an
  // empty token — and an empty token is a route that re-mints itself forever.
  return Math.random().toString(36).slice(2) || 'roll';
}

function render() {
  el.modes.querySelectorAll('button').forEach((b) => {
    b.setAttribute('aria-current', String(b.dataset.mode === app.mode));
  });
  renderCrumbs();
  renderTotals();
  renderShelf();
}

// The one place a move happens: a finger on the canvas, the demo's own route and a test replay
// all arrive here and all get held to the same rule.
function commit(move) {
  const took = play(app.game, move);
  if (!took) {
    view.redraw();
    return false;
  }
  if (took.stranded) app.strands++;
  if (app.game.done) {
    finish();
    return took;
  }
  view.redraw();
  renderCrumbs();
  const left = remaining(app.game);
  const pads = `${move.from + 1} → ${move.to + 1}`;
  say(took.stranded
    ? `<span class="no">${pads}：${took.kind === 'hop' ? '跳' : '落'}下去了，但对岸再也到不了</span> —— 只能「退回」这一步，本段已计 <b>${app.strands}</b> 次困水`
    : `<span class="yes">${pads}</span> ${took.kind === 'hop' ? '越过一只对岸的蛙' : '向前一步'} · 已用 ${app.game.moves} 步 · 距对岸 <b>${left}</b> 步`);
  return took;
}

function finish() {
  const lot = app.lot;
  const g = app.game;
  const rec = store.solve(lot.id, { moves: g.moves, par: lot.par, hints: app.hints });
  if (app.day) store.markDaily(app.day, lot.id);
  let nextIndex = 0;
  if (app.mode === 'campaign') {
    store.unlock(Math.max(store.unlocked, app.index + 1));
    nextIndex = app.index < LOTS ? app.index + 1 : 0;
  }
  stopDemo('');
  const gr = grade(g, { hints: app.hints, strands: app.strands });
  el.stars.textContent = starText(gr.stars);
  el.verdict.textContent = gr.label;
  el.tally.innerHTML = `你的 <b>${g.moves}</b> 步 · 穷尽本河段 <b>${lot.states}</b> 个局面的最短 <b>${lot.par}</b> 步`
    + ` · 提示 <b>${app.hints}</b> · 困水 <b>${app.strands}</b>`
    + (rec.best === g.moves ? '<br>这是这一段的最好成绩' : '');
  // The win card prints where its own number came from, in the form that applies to this lot:
  // a bank-to-bank river can be contradicted by arithmetic, a mid-river one can only be
  // contradicted by the search.
  const byForm = lot.a === lot.b
    ? `n(n+2) = ${lot.a}×${lot.a + 2}`
    : `ab+a+b = ${lot.a}×${lot.b}+${lot.a}+${lot.b}`;
  const proven = g.moves === lot.par
    ? `这一步数不是估计值：<b>${lot.par}</b> 是穷尽本河段 ${lot.states} 个可达局面量出的最短距离`
      + (lot.canonical ? `，闭式 ${byForm} 也给出同一个数` : `，而这条河的最短路线一共只有 <b>${lot.optimalPaths}</b> 条`)
    : `到对岸了，但 <b>${g.moves}</b> 步不等于已证下界 <b>${lot.par}</b> 步`;
  el.proof.innerHTML = proven;
  el.next.hidden = !nextIndex;
  el.curtain.hidden = false;
  render();
}

function go(hash) {
  if (location.hash === hash) apply();
  else location.hash = hash;
}

function apply() {
  const rt = parseHash();
  app.route = rt;
  app.mode = rt.mode;
  if (rt.mode === 'random' && !rt.key) {
    // A bare #/random/twined would mean a different river on every visit and an unreproducible
    // link, so the token is minted once and written back into the URL.
    location.replace(`${location.pathname}${location.search}#/random/${rt.tier}/${token()}`);
    return;
  }
  const r = resolve(rt);
  if (!r.lot) {
    say('这一段还没有河');
    return;
  }
  app.day = r.day || null;
  app.index = rt.mode === 'campaign' ? rt.index : ALL.indexOf(r.lot) + 1;
  setGame(r.lot, r.label);
  render();
}

let toastTimer = 0;
function toast(msg) {
  el.toast.textContent = msg;
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.toast.hidden = true; }, 1900);
}

function shareLink() {
  const url = `${location.origin}${location.pathname}#/lot/${app.lot.id}`;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(url).then(() => toast('链接已复制'), () => toast(url));
  } else {
    toast(url);
  }
}

// The demo is the search made visible: it walks the same distance table the panel prints `par`
// from, and the loop is bounded by the size of that table rather than by enthusiasm.
let demoTimer = 0;
let demoSteps = 0;
function startDemo() {
  if (demoTimer || !app.game || app.game.done) return;
  demoSteps = 0;
  el.demo.textContent = '停止';
  el.demo.setAttribute('aria-pressed', 'true');
  const cap = app.game.table ? app.game.table.size : app.lot.par + 1;
  demoTimer = setInterval(() => {
    if (++demoSteps > cap || !app.game || app.game.done) {
      stopDemo('演示到此为止');
      return;
    }
    const h = hint(app.game);
    if (!h) { stopDemo('这条河已经没有可走的最短一步'); return; }
    commit(h.move);
    if (app.game.done) stopDemo('演示走完了一条最短路线');
  }, 170);
}

function stopDemo(note) {
  if (demoTimer) clearInterval(demoTimer);
  demoTimer = 0;
  el.demo.textContent = '演示';
  el.demo.setAttribute('aria-pressed', 'false');
  if (note) say(note);
}

el.modes.addEventListener('click', (ev) => {
  const b = ev.target.closest('button[data-mode]');
  if (!b) return;
  if (b.dataset.mode === 'campaign') go(`#/c/${clampIndex(store.unlocked)}`);
  else if (b.dataset.mode === 'daily') go('#/daily');
  else go(`#/random/${TIERS[0].key}/${token()}`);
});

el.undo.addEventListener('click', () => {
  stopDemo('');
  if (undo(app.game)) {
    view.redraw();
    renderCrumbs();
    const left = remaining(app.game);
    say(app.game.moves === 0 ? '回到起点' : left === null ? '还困在水里' : `退回一步 · 距对岸 <b>${left}</b> 步`);
  }
});

el.hint.addEventListener('click', () => {
  const h = hint(app.game);
  if (!h) {
    say(remaining(app.game) === null
      ? '<span class="no">这一步已经把自己困死了 —— 提示帮不上忙，只能退回</span>'
      : '<span class="yes">对岸已在脚下</span>');
    return;
  }
  app.hints++;
  stopDemo('');
  view.showHint(h.move.from);
  say(`提示：<b>${h.move.from + 1} 号莲叶</b> ${h.move.kind === 'hop' ? '跳过同伴' : '向前一步'}到 <b>${h.move.to + 1}</b> —— 之后还需 <b>${h.left - 1}</b> 步`);
  renderCrumbs();
});

el.demo.addEventListener('click', () => {
  if (demoTimer) stopDemo('演示已停止');
  else startDemo();
});

function restart() {
  stopDemo('');
  reset(app.game);
  app.hints = 0;
  app.strands = 0;
  el.curtain.hidden = true;
  view.redraw();
  render();
  say('回到起点');
}

el.restart.addEventListener('click', restart);
el.share.addEventListener('click', shareLink);
el.again.addEventListener('click', restart);
el.next.addEventListener('click', () => go(`#/c/${Math.min(LOTS, app.index + 1)}`));

// Wiping the save is the one destructive thing this game can do, so it asks twice rather than
// firing on a stray click.
let wipeArmed = false;
el.wipe.addEventListener('click', () => {
  if (!wipeArmed) {
    wipeArmed = true;
    toast('再点一次会清空本机全部成绩');
    setTimeout(() => { wipeArmed = false; }, 4000);
    return;
  }
  store.reset();
  wipeArmed = false;
  toast('存档已清空');
  apply();
});

window.addEventListener('hashchange', apply);
window.addEventListener('resize', () => view.measure());
// Runner viewports gain a vertical scrollbar after first paint, which narrows the content without
// firing window 'resize'; measuring the canvas itself keeps the backing store honest.
const layoutCanvas = view.canvas || document.querySelector('canvas');
if (layoutCanvas && typeof ResizeObserver === 'function') new ResizeObserver(() => view.measure()).observe(layoutCanvas);
window.addEventListener('keydown', (ev) => {
  if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
  const k = String(ev.key).toLowerCase();
  if (k === 'escape' && !el.curtain.hidden) el.curtain.hidden = true;
  else if (k === 'u') el.undo.click();
  else if (k === 'h') el.hint.click();
  else if (k === 'r') el.restart.click();
  else if (k === 'd') el.demo.click();
});

view.start();
// Deliberately not paused on visibilitychange: the hop animation and the win card are driven
// from the same loop, and a tab that reports itself hidden (headless Chrome does) must still be
// able to finish a river.
apply();
probeProof();

window.leap = {
  version: 1,
  get state() {
    const left = app.game ? remaining(app.game) : null;
    return {
      mode: app.mode,
      label: app.label,
      id: app.lot && app.lot.id,
      tier: app.lot && app.lot.tier,
      index: app.index,
      a: app.lot && app.lot.a,
      b: app.lot && app.lot.b,
      cells: app.game && app.game.board.length,
      moves: app.game && app.game.moves,
      par: app.lot && app.lot.par,
      optimalPaths: app.lot && app.lot.optimalPaths,
      states: app.lot && app.lot.states,
      left,
      stranded: left === null,
      over: app.game ? overPar(app.game) : null,
      hints: app.hints,
      strands: app.strands,
      done: !!(app.game && app.game.done),
      solvable: left !== null,
      unlocked: store.unlocked,
      solved: ALL.filter((l) => store.record(l.id) && store.record(l.id).solved).length,
      curtain: !el.curtain.hidden,
      demo: !!demoTimer,
    };
  },
  get pool() { return poolStats(); },
  get bands() { return TIERS; },
  // The repo's claim, measured on this device: BFS optimum vs. the closed form vs. the memoised
  // DFS, for n = 1..9, plus the two-route and two-opening facts.
  proof() { return probeProof(); },
  closedForm(n) { return closedFormProof(n); },
  load(hash) { go(hash); return app.lot && app.lot.id; },
  // Where pad p is in client pixels and what the rule says about it: what an automated finger
  // presses, as opposed to the maths in js/core.
  padPoint(p) { return view.padPoint(p); },
  // The same thing by frog: the pad holding the `i`-th legal frog, so a test can iterate frogs
  // without knowing the position.
  legalPads() { return view.legalPads(); },
  illegalPad() {
    if (!app.game) return -1;
    const legal = new Set(view.legalPads());
    for (let p = 0; p < app.game.board.length; p++) {
      if (app.game.board[p] !== GAP && !legal.has(p)) return p;
    }
    return -1;
  },
  board() { return app.game ? app.game.board.slice() : null; },
  key() { return app.game ? boardKey(app.game.board) : null; },
  frogCounts() { return app.game ? counts(app.game.board) : null; },
  level() {
    if (!app.lot) return null;
    const l = app.lot;
    return { id: l.id, tier: l.tier, a: l.a, b: l.b, left: l.left, right: l.right, empty: l.empty, par: l.par, optimalPaths: l.optimalPaths, states: l.states };
  },
  // The certified shortest route out of this lot's start position, as moves: the same chain the
  // panel bills `par` against, recomputed here so a test can prove the browser agrees with the
  // number printed on screen.
  path() { return app.game ? tableRoute(app.game.table, app.game.start) : []; },
  route() { return app.game ? tableRoute(app.game.table, app.game.board) : []; },
  // Play a solver route through the same commit() a finger uses.
  play(route) {
    for (const m of route || []) commit(m);
    return app.game.moves;
  },
  clickPad(p) {
    const m = view.moves().find((x) => x.from === p);
    return commit(m || { from: p, to: -1 });
  },
  hopTo(from, to) { return commit({ from, to }); },
  hintOnce() {
    el.hint.click();
    const h = hint(app.game);
    return { hints: app.hints, move: h ? h.move : null, line: el.hintline.textContent };
  },
  undoOnce() { el.undo.click(); return app.game.moves; },
  demoStart() { startDemo(); return !!demoTimer; },
  demoStop() { stopDemo(''); return demoTimer === 0; },
  pixels() { return view.pixelsHash(); },
  painted() { return view.painted(); },
  validate(row) { return validateLot(row); },
  solveNow(board) { return solveBoard(board); },
  reset() { restart(); return app.game.moves; },
  hashSeed,
  store,
};
