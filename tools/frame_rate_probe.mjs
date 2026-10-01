// 帧率无关对拍（自写：官方 cos_frame_probe.js 只能把 js 当 script 求值，本仓是 ES module，
// 在它眼里是"无法比对"，而"无法比对"不是结论）。这里真用 ESM 加载 js/view.js，喂假 DOM +
// 受控沙箱时钟，在 30/60/120Hz 三档下比对仿真计数器本身。
//
// 判据（BRIEF_COS §3 + §6：没有反向对照的绿不算结论）：
//  A 定步长完整性：干净时钟下先在 t=1000 打一发 prime 帧（frame 的首帧 elapsed 记 0），
//    再于墙钟 2000ms 这个三档都精确落格的时刻取值 —— simSteps 必须都等于 240、renderClock
//    必须都等于 2.0、累加余额必须为 0。这一步只有"累加器吃真实 elapsed"做得到。
//  B 轨迹是步数的函数：抖动时钟（LCG，均值不变）下记录 (simSteps -> 粒子位置和) 轨迹，
//    取三档共同的步数键比对，必须逐位相同且非零。
//  C 真暂停：2000ms 处暂停，再喂 1000ms 墙钟，simSteps 与粒子场一动不动；恢复 500ms 后
//    恰好补走 60 步，状态没被抹掉。
//  D 补帧上限：单帧 3000ms 只补 MAX_CATCHUP=8 步并把余额丢掉（丢时间，不追帧）。
//  E 减弱动效：动画照样推进、仿真照样走表，但一个溅水粒子都不生成。
//  N1 反向对照（判 A）：`simAccumulator += elapsed` -> `+= 1 / 60`。
//  N2 反向对照（判 B）：`stepSim(SIM_STEP)` -> `stepSim(elapsed)`，即拿帧 dt 直接积分。

import { cpSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';

const REPO = fileURLToPath(new URL('..', import.meta.url));   // 仓根：本文件在 tools/ 下
const RATES = [30, 60, 120];
const STEP = 1 / 120;
const tick = () => new Promise((r) => setTimeout(r, 0));

let clockMs = 1000;
const pending = new Map();
let rafId = 1;

function fakeCtx() {
  const t = {};
  return new Proxy(t, {
    get(g, k) {
      if (k in g) return g[k];
      if (k === 'createLinearGradient' || k === 'createRadialGradient') return () => ({ addColorStop() {} });
      if (k === 'createPattern') return () => ({ setTransform() {} });
      if (k === 'getImageData') return () => ({ data: new Uint8ClampedArray(12) });
      if (k === 'measureText') return () => ({ width: 10 });
      return () => {};
    },
    set(g, k, v) { g[k] = v; return true; },
  });
}

function fakeCanvas() {
  const ctx = fakeCtx();
  const box = { left: 0, top: 0, right: 520, bottom: 300, width: 520, height: 300, x: 0, y: 0 };
  return {
    width: 0, height: 0, style: {},
    getContext: () => ctx,
    getBoundingClientRect: () => box,
    addEventListener() {}, removeEventListener() {},
  };
}

function installDom() {
  globalThis.window = {
    devicePixelRatio: 2,
    addEventListener() {}, removeEventListener() {},
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }),
  };
  globalThis.Image = class {
    set src(v) { this._src = v; this.width = 64; this.height = 64; Promise.resolve().then(() => this.onload && this.onload()); }
    get src() { return this._src; }
  };
  globalThis.performance = { now: () => clockMs };
  globalThis.requestAnimationFrame = (cb) => { const id = rafId++; pending.set(id, cb); return id; };
  globalThis.cancelAnimationFrame = (id) => { pending.delete(id); };
}

function lcg(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

function flush() {
  const cbs = [...pending.values()];
  pending.clear();
  return cbs;
}

async function loadMods(dir) {
  return {
    view: await import(pathToFileURL(join(dir, 'js/view.js')).href),
    game: await import(pathToFileURL(join(dir, 'js/core/game.js')).href),
    library: await import(pathToFileURL(join(dir, 'js/core/library.js')).href),
  };
}

// 一次试跑：每档新建 view（仿真状态在闭包里，不复用才干净）。
async function trial(mods, { rate, jitter = 0, deadline = 2000, tapAt = 210, holdMs = 0, resumeMs = 0, giantAt = 0 }) {
  const { createView } = mods.view;
  const { createGame, legalMoves, play } = mods.game;
  const { byId, tableFor } = mods.library;
  clockMs = 1000;
  pending.clear();
  const view = createView(fakeCanvas(), { onMove: () => true, onIllegal: () => {} });
  const game = createGame({ ...byId('shoal-10'), table: tableFor(byId('shoal-10')) });
  view.attach(game);
  view.start();
  await tick();                                  // 让 Image.onload 落地：纹理分支也跑到
  const rng = lcg(0xC0FFEE);
  const per = 1000 / rate;
  const out = { rate, frames: 0, wall: 0, taps: 0, trace: new Map(), samples: {} };
  let tapped = false;
  let giantDone = false;
  let pausedAt = -1;
  let resumedAt = -1;

  const step = (dt) => { clockMs += dt; out.frames++; for (const cb of flush()) cb(clockMs); };
  step(0);                                       // prime：frame 的首帧 elapsed 记 0，不占墙钟预算
  for (;;) {
    let dt = per;
    if (jitter) dt = per * (0.7 + 0.6 * rng());
    if (giantAt && !giantDone && out.frames === giantAt) { dt = 3000; giantDone = true; out.giantFrom = view.stats().simSteps; }
    step(dt);
    const elapsed = clockMs - 1000;
    const s = view.stats();
    if (!tapped && s.simSteps >= tapAt) {
      const moves = legalMoves(game.board, game.rules);
      if (moves.length) { play(game, moves[0]); out.taps++; }
      tapped = true;
    }
    if (s.particles > 0) {
      if (out.birth === undefined) out.birth = s.simSteps;
      out.trace.set(s.simSteps - out.birth, s.particleField);
    }
    if (pausedAt < 0 && elapsed >= deadline - 1e-6) {
      out.samples.deadline = s;
      out.samples.deadlineWall = elapsed;
      if (!holdMs) break;
      view.setPaused(true);
      pausedAt = clockMs;
      out.frozen = { steps: s.simSteps, field: s.particleField, particles: s.particles, accumulator: s.accumulator };
    } else if (pausedAt >= 0 && !out.samples.holdEnd && clockMs - pausedAt >= holdMs - 1e-6) {
      const h = view.stats();
      out.samples.holdEnd = h;
      out.pausedDelta = h.simSteps - out.frozen.steps;
      out.fieldDelta = h.particleField - out.frozen.field;
      out.particlesKept = h.particles;
      if (!resumeMs) break;
      view.setPaused(false);
      resumedAt = clockMs;
    } else if (resumedAt > 0 && clockMs - resumedAt >= resumeMs - 1e-6) {
      out.samples.afterResume = view.stats();
      out.resumedDelta = out.samples.afterResume.simSteps - out.samples.holdEnd.simSteps;
      break;
    }
    if (out.frames > 6000) break;
  }
  out.wall = clockMs - 1000;
  out.samples.end = view.stats();
  if (giantDone) out.giantDelta = out.samples.end.simSteps - out.giantFrom;
  view.stop();
  return out;
}

const rows = [];
const rec = (gate, pass, detail) => { rows.push({ gate, pass: !!pass, detail }); };

// 轨迹比对：两两配对比（30v60、30v120、60v120）。三档同时命中同一个相对步数的键太少
// （粗帧率本来就只采样到稀疏的几个步），两两比才是"同一步数上必须同一个位置"。
const PAIRS = [[0, 1], [0, 2], [1, 2]];
function compareTraces(runs) {
  let points = 0;
  let oldest = 0;
  const divergence = [];
  const per = [];
  for (const [a, b] of PAIRS) {
    const ra = runs[a]; const rb = runs[b];
    let shared = 0;
    for (const [k, va] of ra.trace) {
      if (!rb.trace.has(k) || va === 0 || rb.trace.get(k) === 0) continue;
      shared++; points++;
      if (k > oldest) oldest = k;
      if (va !== rb.trace.get(k) && divergence.length < 6) {
        divergence.push({ ages: [ra.rate, rb.rate], age: k, vals: [va, rb.trace.get(k)] });
      }
    }
    per.push(`${ra.rate}v${rb.rate}=${shared}`);
  }
  return { points, oldest, pairs: per, coverage: runs.map((r) => r.trace.size), divergence };
}

async function gate(mods, tag) {
  const clean = [];
  const jit = [];
  for (const rate of RATES) clean.push(await trial(mods, { rate, deadline: 2000 }));
  for (const rate of RATES) jit.push(await trial(mods, { rate, jitter: 1, deadline: 4000 }));
  const steps = clean.map((c) => c.samples.end.simSteps);
  const clocks = clean.map((c) => Number(c.samples.end.renderClock.toFixed(9)));
  const accums = clean.map((c) => c.samples.end.accumulator);
  const ideal = Math.round(2 / STEP);
  const spread = Math.max(...steps) - Math.min(...steps);
  rec(`A${tag} 墙钟 2000ms 处三档步数/仿真时钟一致`, spread <= 1 && steps.every((n) => Math.abs(n - ideal) <= 1)
    && clocks.every((c) => Math.abs(c - 2) <= STEP) && accums.every((a) => a < STEP),
    { steps, idealSteps: ideal, spread, renderClock: clocks, accumulator: accums, frames: clean.map((c) => c.frames), artLoaded: clean[0].samples.end.artLoaded });
  const tr = compareTraces(jit);
  rec(`B${tag} 抖动帧下轨迹逐位是步数的函数`, tr.divergence.length === 0 && tr.points >= 12 && tr.oldest >= 8, tr);
  return { steps, clocks };
}

async function main() {
  installDom();
  const mods = await loadMods(REPO);

  await gate(mods, '');

  // C 真暂停
  const hold = await trial(mods, { rate: 60, deadline: 2000, holdMs: 1000, resumeMs: 500 });
  rec('C 暂停 1000ms 墙钟：仿真一步不多走', hold.pausedDelta === 0 && hold.fieldDelta === 0 && hold.particlesKept > 0,
    { frozen: hold.frozen, pausedDelta: hold.pausedDelta, fieldDelta: hold.fieldDelta, particlesKept: hold.particlesKept });
  rec('C2 恢复后继续走表且状态没被抹掉', hold.resumedDelta >= 58 && hold.resumedDelta <= 62,
    { resumedDelta: hold.resumedDelta, after: hold.samples.afterResume });

  // D 补帧上限
  const giant = await trial(mods, { rate: 60, deadline: 2000, giantAt: 7 });
  rec('D 单帧 3000ms 只补 8 步并丢时间', giant.giantDelta === 8 && giant.samples.end.accumulator === 0,
    { giantDelta: giant.giantDelta, accumulator: giant.samples.end.accumulator, wall: giant.wall, steps: giant.samples.end.simSteps });

  // E 减弱动效：动画与走表照旧，粒子一个都不生成
  {
    const probe = async (reduced) => {
      clockMs = 1000; pending.clear();
      const { createView } = mods.view;
      const { createGame, legalMoves, play } = mods.game;
      const { byId, tableFor } = mods.library;
      const v = createView(fakeCanvas(), {});
      const g = createGame({ ...byId('shoal-10'), table: tableFor(byId('shoal-10')) });
      v.attach(g);
      v.setReducedMotion(reduced);
      v.start();
      await tick();
      for (let i = 0; i < 24; i++) { clockMs += 1000 / 60; for (const cb of flush()) cb(clockMs); }
      play(g, legalMoves(g.board, g.rules)[0]);
      for (let i = 0; i < 20; i++) { clockMs += 1000 / 60; for (const cb of flush()) cb(clockMs); }   // 落定后立刻取值
      const s = v.stats();
      v.stop();
      return s;
    };
    const off = await probe(true);
    const on = await probe(false);
    rec('E 减弱动效：仿真照走但零粒子', off.reducedMotion === true && off.particles === 0 && off.simSteps > 0
      && on.particles > 0 && on.simSteps === off.simSteps,
      { reduced: off, normal: on });
  }

  // N 反向对照：两条变异各自必须把对应判据打断
  const mutants = [
    { name: 'N1 accum += 1/60（帧数当时钟）', needle: 'simAccumulator += elapsed;', to: 'simAccumulator += 1 / 60;', breaks: 'A' },
    { name: 'N2 stepSim(elapsed)（帧 dt 直接积分）', needle: 'stepSim(SIM_STEP);', to: 'stepSim(elapsed);', breaks: 'B' },
  ];
  for (const m of mutants) {
    const dir = join(tmpdir(), `leap_fps_mutant_${m.breaks}`);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    cpSync(join(REPO, 'js'), join(dir, 'js'), { recursive: true });
    const vp = join(dir, 'js/view.js');
    const src = readFileSync(vp, 'utf8');
    const hits = src.split(m.needle).length - 1;
    if (hits !== 1) { rec(`${m.name} 可注入`, false, { hits, note: '目标行没找到，对照无效' }); continue; }
    writeFileSync(vp, src.replace(m.needle, m.to), 'utf8');
    const mm = await loadMods(dir);
    const clean = [];
    for (const rate of RATES) clean.push(await trial(mm, { rate, deadline: 2000 }));
    const jit = [];
    for (const rate of RATES) jit.push(await trial(mm, { rate, jitter: 1, deadline: 4000 }));
    const steps = clean.map((c) => c.samples.end.simSteps);
    const tr = compareTraces(jit);
    const aRed = Math.max(...steps) - Math.min(...steps) > 1 || !steps.every((n) => Math.abs(n - 240) <= 1);
    const bRed = tr.divergence.length > 0 || tr.points < 12 || tr.oldest < 8;
    rec(`${m.name} 必须翻红`, m.breaks === 'A' ? aRed : bRed,
      { breaks: m.breaks, expect: m.breaks === 'A' ? '三档步数应漂成 120/240/480' : '同一相对步数的粒子位置和应分歧',
        steps, aRed, bRed, traces: { points: tr.points, oldest: tr.oldest, pairs: tr.pairs, coverage: tr.coverage, divergence: tr.divergence } });
  }

  const fails = rows.filter((r) => !r.pass);
  for (const r of rows) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.gate}  ${JSON.stringify(r.detail)}`);
  console.log('---');
  const controls = rows.filter((r) => r.gate.startsWith('N') && r.pass).length;
  console.log(fails.length
    ? `结论：帧率无关 不成立（${fails.length} 项翻红：${fails.map((f) => f.gate).join('；')}）`
    : `结论：帧率无关 成立（${rows.length - controls} 项判据全绿，另 ${controls} 项反向对照按预期翻红）`);
}

main().then(() => {
  // 退出码就是门槛：tools/verify.sh 里 `node tools/frame_rate_probe.mjs || FAILED=1` 依赖它。
  process.exitCode = rows.some((r) => !r.pass) ? 1 : 0;
}).catch((e) => { console.log('HARNESS ERROR', e && e.stack || e); process.exit(1); });
