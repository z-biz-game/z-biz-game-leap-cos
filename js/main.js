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
import { createPause } from './core/pause.js';
import { anchorTable, solveBoard } from './core/solve.js';
import { store, storageMode } from './core/storage.js';
import {
  ALL, TIERS, byId, closedFormProof, dailyLot, lotAt, lotsIn, randomLot, stats as poolStats,
  tableFor, tierByKey, validateLot,
} from './core/library.js';
import { todayKey, hashSeed } from './core/rng.js';
import { createView } from './view.js';
// 听觉与触觉这两路反馈：视觉与数值之外，桌面上还该有"听得见"的一路。
// 音频模块自己管手势解锁与真静音（suspend），这里只管把音接到真实事件上。
import { audio } from './audio.js';
import { haptics } from './haptics.js';

const $ = (id) => document.getElementById(id);

// The pause owns the flag, the clock and the door. js/core/pause.js is pure, so the node
// suite drives the same object the page runs — the behaviour is proved in one place and
// shipped from the same place.
const pause = createPause();

const el = {
  modes: $('modes'), totals: $('totals'), crumbs: $('crumbs'), readout: $('readout'),
  shelf: $('shelf'), hintline: $('hintline'), curtain: $('curtain'), stars: $('stars'),
  verdict: $('verdict'), tally: $('tally'), proof: $('proof'), undo: $('undo'), hint: $('hint'),
  demo: $('demo'), restart: $('restart'), share: $('share'), next: $('next'), again: $('again'),
  toast: $('toast'), canvas: $('river'), wipe: $('wipe'), saveMode: $('save-mode'),
  pauseBtn: $('btn-pause'), veil: $('pause-veil'), resumeBtn: $('btn-resume'),
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

// The panel's clock ticks with the frame loop, so a river on hold does not even get a frame
// to move its reading.
view.onFrame = () => syncClock();

function setGame(lot, label) {
  stopDemo('');
  if (pause.paused) setPaused(false);   // a new river is never born on hold
  pause.start();                        // the clock of this river starts at zero
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

// ---- the clock on the panel ----
//
// The reading is the time this river has been on the table. The paused stretches are not on
// it — js/core/pause.js banks them out — so a pause neither eats a second nor invents one.
let lastClockText = '';
function clockText() {
  const ms = Math.max(0, Math.round(pause.elapsedMs()));
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function syncClock() {
  const t = clockText();
  if (t === lastClockText) return;
  lastClockText = t;
  const node = document.getElementById('clock');
  if (node) node.textContent = t;
  const veilClock = document.getElementById('pause-clock');
  if (veilClock) veilClock.textContent = t;
}

// ---- the pause ----
//
// A pause that stops nothing is a label. This one stops the three things that really move:
// the clock on the panel, the demo's own auto-play timer, and the frame loop that flies the
// hop arc. And it holds the door on every way the pads can change — a finger, a drag, the
// demo, a replay — through the one guard in commit().
let demoWasRunning = false;

function syncPauseUI() {
  const on = pause.paused;
  if (el.pauseBtn) {
    el.pauseBtn.textContent = on ? '继续' : '暂停';
    el.pauseBtn.setAttribute('aria-pressed', String(on));
    el.pauseBtn.title = on ? '继续 (P)' : '暂停 (P)';
  }
  if (el.veil) el.veil.hidden = !on;
  const veilClock = document.getElementById('pause-clock');
  if (veilClock) veilClock.textContent = clockText();
}

function setPaused(next) {
  const on = !!next;
  if (on === pause.paused) { syncPauseUI(); return on; }
  if (on) {
    pause.pause();                              // the clock stops here
    view.pause();                               // the frame loop stops here: no arc advances
    if (demoTimer) { demoWasRunning = true; stopDemo(''); }   // the auto-play timer stops here
    say('已暂停 —— 棋盘、计时和演示都停住了；按 <b>P</b> 或点「继续」接着走');
  } else {
    pause.resume();                             // the clock picks up from the pause, not from zero
    view.resume();                              // the arc continues from the frame it was frozen on
    if (demoWasRunning) { demoWasRunning = false; startDemo(); }
    say('继续 —— 计时从暂停处接着走');
  }
  syncPauseUI();
  syncClock();
  if (app.game) renderCrumbs();
  return !on;
}

function renderCrumbs() {
  const tier = tierByKey(app.lot.tier);
  const rec = store.record(app.lot.id);
  const left = remaining(app.game);
  const dead = left === null;
  const clock = clockText();
  el.crumbs.innerHTML = `${app.label}<b>${tier.label}<span class="band"> ${tier.blurb}</span></b>`;
  el.readout.innerHTML = [
    field('步数', app.game.moves, '已落的蛙'),
    field('最短', app.lot.par, dead ? '已证下界' : `本河段 ${app.lot.states} 局面穷尽`, 'par'),
    field('距对岸', dead ? '困' : left, dead ? '退回可解' : '还需落步', dead ? 'bad' : ''),
    field('最优路线', app.lot.optimalPaths, app.lot.optimalPaths === 2 ? '互为镜像' : '条'),
    field('最佳', rec && rec.best ? rec.best : '—', rec && rec.perfect ? '等于最短' : '你的纪录', 'best'),
    field('提示 / 困水', `${app.hints} / ${app.strands}`, '本段计数'),
    field('用时', `<span id="clock">${clock}</span>`, '暂停不计'),
  ].join('');
  lastClockText = clock;
  el.undo.disabled = !app.game.moves || app.game.done || pause.paused;
  el.hint.disabled = app.game.done || pause.paused;
  el.demo.disabled = app.game.done || pause.paused;
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
//
// 声音接在这条路径上，因为这条路径上发生的是**真实事件**：
//   · 引擎拒了这一手 → wrong（规则不成立，壳层只是把理由念出来）
//   · 引擎认了这一手 → correct（一次有效操作成功）
//   · 这一手把青蛙推进了死水（对岸再也到不了）→ lose
//   · 渡到对岸 → win（在 finish 里）
function commitRaw(move) {
  const took = play(app.game, move);
  if (!took) {
    audio.play('wrong');
    haptics.wrong();
    view.redraw();
    return false;
  }
  if (took.stranded) app.strands++;
  if (app.game.done) {
    finish();                      // 收官那一响是 win，在 finish 里
    haptics.correct();
    return took;
  }
  if (took.stranded) {
    // 这一手把青蛙推进了死水：对岸再也到不了（core/game.js 的 distance 返回 null）。
    // 这是本仓唯一的"失败"信号 —— 河本身不会输，但这一局已经过不去了。
    audio.play('lose');
  } else {
    audio.play('correct');         // 一次有效操作成功
    haptics.correct();
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

// The door. A finger on the canvas, the demo's own route and a test replay all arrive at
// commitRaw; while the river is on hold the guard turns them away, so a paused board cannot
// be moved by any of them — and a refused call changes nothing at all.
//
// 闸挡住这一口时是 blocked（不是"错"）。这一声得在门外发：pause.guard 在暂停时
// **根本不调用**被包的那个函数，被包的那一侧没有机会开口。
const commitGuarded = pause.guard(commitRaw);
const commit = (...args) => {
  if (!pause.allow()) {
    audio.play('blocked');
    return false;
  }
  return commitGuarded(...args);
};

function finish() {
  const lot = app.lot;
  const g = app.game;
  audio.play('win');                  // 渡到对岸
  pause.finish();                       // the reading stops where the river ended
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
    if (!pause.allow()) return;               // on hold: the auto-play does not step
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
    audio.play('move');        // 退回一步：盘面退了一步
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
    audio.play('wrong');
    return;
  }
  app.hints++;
  stopDemo('');
  audio.play('move');          // 提示：只点一步，不代走
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
  if (pause.paused) setPaused(false);   // a restart is the way out of a pause
  pause.start();                        // and the clock starts over with the river
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
// The pause is reachable two ways: the button in the top bar and the P key. Both go through
// the same setPaused(), so the button and the shortcut cannot drift apart.
if (el.pauseBtn) el.pauseBtn.addEventListener('click', () => setPaused(!pause.paused));
if (el.resumeBtn) el.resumeBtn.addEventListener('click', () => setPaused(false));
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
  else if (k === 'p' || k === 'escape') setPaused(!pause.paused);
  // While the river is on hold the keys that would change the pads are refused; only the
  // pause itself (and 重开, which is the way out of it) still answers.
  else if (k === 'u' && !pause.paused) el.undo.click();
  else if (k === 'h' && !pause.paused) el.hint.click();
  else if (k === 'r') el.restart.click();
  else if (k === 'd' && !pause.paused) el.demo.click();
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
      paused: pause.paused,
      elapsedMs: Math.round(pause.elapsedMs()),
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
  // The pause, from a test's side: the same setPaused() the button and the P key use.
  pauseToggle() { setPaused(!pause.paused); return pause.paused; },
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

// ---- 全屏开关 ----
//
// 绑到 index.html 的 HUD 里真实存在的 #btn-fullscreen。
// 只在 js 里留一串 requestFullscreen 能骗过字符串扫描，但按钮不在 DOM 里就是死代码：
// 玩家按不到，功能等于没做。所以 id 必须与 HTML 里的按钮对得上，缺失时要在控制台喊出来。
//
// 三套 API 一律**特性探测**，不做 UA 判断：iPhone 版 Safari 压根没有元素全屏（只有 <video> 能全屏），
// 老 Edge 只认 ms 前缀，Firefox 认 moz 前缀。UA 字符串是猜的，方法在不在是量的，猜错就静默失效。
function fsRoot() {
  return document.documentElement;
}

function fsElement() {
  return document.fullscreenElement || document.webkitFullscreenElement || null;
}

function fsRequest(root) {
  // 老 Edge 的 msRequestFullscreen 挂在元素上，和标准名同一个位置，所以并排取即可。
  return root.requestFullscreen || root.webkitRequestFullscreen || root.msRequestFullscreen || null;
}

// iOS Safari 会把非 video 元素的请求直接 reject 成 NotAllowedError。
// 这个 promise 没人接就升级成 unhandledrejection，冒到 window.onerror——离屏预载时足以把整页判死。
// 因此凡是可能返回 promise 的调用，返回值一律就地吞掉，绝不让拒绝逃出这一层。
function fsQuiet(p) {
  if (p && typeof p.catch === 'function') p.catch(() => {});
  return p;
}

// 返回 true=请求进入，false=请求退出，null=不支持（调用方据此禁用按钮）。
function toggleFullscreen(root) {
  const req = fsRequest(root);
  if (!req) return null;
  if (fsElement()) {
    // 退出侧同样要兜底：老 Edge 是 msExitFullscreen；万一三者皆无就当无事发生，不抛。
    const exit = document.exitFullscreen || document.webkitExitFullscreen || document.msExitFullscreen;
    if (exit) fsQuiet(exit.call(document));
    return false;
  }
  // 部分实现（如被 Permissions-Policy 挡住的 iframe）会同步抛，所以 catch 和 .catch 两头都要接。
  try {
    fsQuiet(req.call(root));
  } catch (err) {
    // 拒绝即降级：静默保持当前形态，不冒泡、不打断这一局的其余逻辑。
  }
  return true;
}

function bindFullscreen(btn) {
  const root = fsRoot();

  // 状态回写：Esc 和 iOS 下滑手势退出时不会经过按钮，
  // 只有 fullscreenchange 事件能把按钮的文案/字形拉回正确状态，否则它会一直假装自己在全屏里。
  const sync = () => {
    const on = !!fsElement();
    btn.setAttribute('aria-pressed', String(on));
    btn.textContent = on ? "退出全屏" : "全屏";
    btn.title = on ? "退出全屏 (F)" : "全屏 (F)";
    document.body.classList.toggle('is-fullscreen', on);
    return on;
  };

  if (!fsRequest(root)) {
    // 不支持就要说明为什么：只把按钮变灰，玩家会以为这活根本没做完。
    btn.disabled = true;
    btn.setAttribute('aria-disabled', 'true');
    btn.title = '这个浏览器不提供元素全屏（iOS Safari 请用「添加到主屏幕」）';
    return;
  }

  btn.addEventListener('click', () => {
    toggleFullscreen(root);
    sync();
  });

  document.addEventListener('fullscreenchange', sync);
  document.addEventListener('webkitfullscreenchange', sync);

  window.addEventListener('keydown', (ev) => {
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    // 正在输入框里打字时不劫持按键，否则会打不出 f。
    if (ev.target && /^(input|textarea|select)$/i.test(ev.target.tagName)) return;
    if (ev.key === "f" || ev.key === "F") {
      ev.preventDefault();
      toggleFullscreen(root);
      sync();
    }
  });

  sync();
}

function bootFullscreen() {
  const btn = document.getElementById("btn-fullscreen");
  if (!btn) {
    // 按钮被谁删掉了？在控制台喊出来，别让这个坑静默地烂在下一棒手里。
    console.warn('[fullscreen] index.html 里找不到 #' + "btn-fullscreen" + '，全屏开关没有入口');
    return;
  }
  bindFullscreen(btn);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootFullscreen);
} else {
  bootFullscreen();
}

// ---- 减弱动效（prefers-reduced-motion）----
//
// 跟住系统设置，而且**运行中改设置要立刻生效**：只读一次 matchMedia 不够，玩家在系统里
// 把开关拨回来，页面还停在上一次读到的答案上。addEventListener 是标准接口，老 Safari 只有
// addListener —— 特性探测，不做 UA 判断。
const motionQuery = typeof matchMedia === 'function'
  ? matchMedia('(prefers-reduced-motion: reduce)') : null;
function applyReduceMotion(on) { view.setReduceMotion(on); }
if (motionQuery) {
  applyReduceMotion(motionQuery.matches);
  if (typeof motionQuery.addEventListener === 'function') {
    motionQuery.addEventListener('change', (e) => applyReduceMotion(e.matches));
  } else if (typeof motionQuery.addListener === 'function') {
    motionQuery.addListener((e) => applyReduceMotion(e.matches));
  }
}
window.leap.setReduceMotion = applyReduceMotion;
window.leap.isReducedMotion = () => view.isReducedMotion();

// ---- 音效开关（#btn-sound）----
//
// 静音走 `audio.setMuted(true)`，那是 `ctx.suspend()`：整个 AudioContext 挂起。
// **不许**改成像"把 master.gain 拧到 0"那样 —— 只拧 gain 是假静音：节点照建、时钟照跑，
// 取消静音之后还有一截尾巴在响。真正的静音必须是挂起整个上下文。
//
// 按钮找不到就不装（和全屏那一条同一条纪律）：留一串没人按的代码等于没做这个功能。
(function bindSound() {
  const btn = document.getElementById('btn-sound');
  if (!btn) return;
  function paint() {
    const on = !audio.muted;
    btn.setAttribute('aria-pressed', String(on));
    btn.textContent = on ? '音效：开' : '音效：关';
    btn.title = on ? '点击关闭音效' : '点击开启音效';
  }
  btn.addEventListener('click', () => {
    audio.setMuted(!audio.muted);
    paint();
  });
  paint();
})();
