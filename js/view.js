// Canvas renderer + pointer handling. This file owns pixels and gestures and decides nothing:
// js/core/game.js is the only place a hop is judged legal, and js/core/solve.js is the only
// place a distance comes from. The view *asks* for a move and reads the rule back through the
// same pure function purely for styling — there is one implementation of the rule in this repo,
// and no second copy hiding in here.
//
// Everything drawn is generated: water, banks, reeds, ripples, lily pads and frogs. No image
// files, no fonts, no sprites, no animation library. The one thing the picture has to get right
// is the physics of the toy: a frog that hops leaves its pad, arcs over exactly one opposing
// frog, and lands on the free pad beyond — because that arc *is* the rule, and a player who
// cannot see which frog may clear which other one is reading a number instead of a river.

import { GAP, HOP, LEAP, boardKey, dirOf, distance, isGoal, legalMoves } from './core/game.js';

const PAD = 22;
const HOP_MS = 260;      // one arcing hop, start to settle
const SLIDE_MS = 170;    // one step onto the free pad
function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

export function createView(canvas, { onMove, onIllegal } = {}) {
  // `willReadFrequently` because tools/playtest.mjs reads the bitmap back to prove a legal hop
  // changes the picture and a refused one does not; without it Chrome logs a warning per
  // readback, which would drown the console-clean gate in tools/verify.sh.
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  let game = null;
  let geom = { pitch: 40, r: 16, x0: 30, y: 150, w: 320, h: 300 };
  let frameMoves = new Map();   // pad -> the one move it could make, refreshed once per draw
  let prev = null;                 // the board as last drawn, for the move diff
  let anim = null;                 // { species, from, to, t0, arc }
  let drag = null;                 // { pad, x, y, moved }
  let shake = null;                // { pad, t0 } after a refused hop
  let hint = null;                 // { pad, until }
  let raf = 0;
  let last = 0;
  let warm = 0;                    // the first frames always repaint, so the canvas is never blank

  // ---- 减弱动效（prefers-reduced-motion）----
  // 两处装饰：① 提示环 t = (now % 1100) / 1100 喂给线宽、半径与透明度；② 被拒的一跳
  // shakeOffset() = Math.sin(t * 26) * (1 - t) * r * 0.4 —— 莲叶左右摆。
  // 判据：被拒本来就有 onIllegal 那句人话读数（"它跳不到 N 号莲叶 —— 只能朝前一步…"），
  // 摆动是叠在读数上的装饰，归零位移不损失信息；提示环本体一律留着。
  // 水面那几道涟漪**不是**装饰性动画（相位只由关卡的 skin.ripple 定，不含时间项），不动。
  let reduceMotion = false;
  const ringPhase = () => (reduceMotion ? 0.5 : (performance.now() % 1100) / 1100);

  // ---------------------------------------------------------------- geometry

  function measure() {
    const box = canvas.getBoundingClientRect();
    const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    const W = Math.max(220, Math.round(box.width));
    const H = Math.max(200, Math.round(box.height));
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (!game) return;
    const cells = game.board.length;
    // The river is one line of pads: the width budget binds first, the height budget keeps the
    // banks and the hop arc from colliding with the water's edge.
    const pitch = Math.max(16, Math.floor(Math.min((W - PAD * 2) / (cells + 0.6), (H - PAD * 2) / 2.9)));
    geom = {
      pitch,
      r: Math.max(7, Math.round(pitch * 0.42)),
      x0: Math.round((W - pitch * (cells - 1)) / 2),
      y: Math.round(H * 0.56),
      w: W,
      h: H,
    };
    draw();
  }

  function padX(p) { return geom.x0 + p * geom.pitch; }

  function localPoint(ev) {
    const box = canvas.getBoundingClientRect();
    return { x: ev.clientX - box.left, y: ev.clientY - box.top };
  }

  // Canvas-local -> client pixels, which is the space an automated finger dispatches in.
  function toClient(ux, uy) {
    const box = canvas.getBoundingClientRect();
    return { x: Math.round(box.left + ux), y: Math.round(box.top + uy), r: geom.r, pitch: geom.pitch };
  }

  function grabRadius() { return geom.r + geom.pitch * 0.24; }

  function padAt(ux, uy) {
    if (!game) return -1;
    const cells = game.board.length;
    let best = -1;
    let dist = Infinity;
    for (let p = 0; p < cells; p++) {
      const d = Math.hypot(ux - padX(p), uy - centreOf(p).y);
      if (d <= grabRadius() && d < dist) { dist = d; best = p; }
    }
    return best;
  }

  // A frog has at most one destination: a free pad directly ahead, or the one beyond a single
  // opposing frog. Those two can never both be true of the same gap, so "which move does this
  // frog make" is a function, not a menu — which is what lets a click on a frog be unambiguous.
  function refreshMoves() {
    frameMoves = new Map();
    if (!game) return frameMoves;
    for (const m of legalMoves(game.board, game.rules)) frameMoves.set(m.from, m);
    return frameMoves;
  }

  // Where a frog is drawn right now: the moving one follows its arc, the rest sit on their pads.
  // Deliberately *not* animated while idle. A frog that breathes would make the canvas hash
  // differ from frame to frame, and then "@pointer: an illegal tap leaves nothing behind" could
  // not be asserted at all — the whole "a refusal changes nothing" claim rests on the picture
  // being a pure function of the position plus one transient (an arc, a shake, a hint ring).
  function centreOf(p) {
    return { x: padX(p), y: geom.y };
  }

  function frogCentre(p, now) {
    if (anim && anim.to === p && now - anim.t0 < anim.ms) {
      const t = (now - anim.t0) / anim.ms;
      const e = t * t * (3 - 2 * t);                     // smoothstep, no easing library
      const a = centreOf(anim.from);
      const b = centreOf(anim.to);
      return {
        x: a.x + (b.x - a.x) * e,
        y: a.y + (b.y - a.y) * e - Math.sin(Math.PI * e) * anim.arc,
      };
    }
    if (drag && drag.pad === p && drag.moved) {
      // A dragged frog follows the finger, held just above the water so it reads as lifted.
      const cells = game.board.length;
      const lo = padX(0) - geom.pitch;
      const hi = padX(cells - 1) + geom.pitch;
      return { x: Math.max(lo, Math.min(hi, drag.x)), y: Math.min(drag.y, geom.y - geom.r * 0.4) };
    }
    return centreOf(p);
  }

  function isLegalPad(p) {
    return frameMoves.has(p);
  }

  function shakeOffset(now) {
    if (!shake) return 0;
    const t = (now - shake.t0) / 240;
    if (t >= 1) { shake = null; return 0; }
    return reduceMotion ? 0 : Math.sin(t * 26) * (1 - t) * geom.r * 0.4;
  }

  // ---------------------------------------------------------------- drawing

  function drawWater(skin, stranded) {
    const { w, h } = geom;
    const hue = (skin && skin.hue) || 186;
    const top = stranded ? `hsl(${hue}, 26%, 12%)` : `hsl(${hue}, 40%, ${stranded ? 16 : 22}%)`;
    const bottom = stranded ? `hsl(${hue}, 30%, 7%)` : `hsl(${hue}, 46%, 11%)`;
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, top);
    grad.addColorStop(1, bottom);
    ctx.fillStyle = grad;
    roundRect(ctx, 8, 8, w - 16, h - 16, 14);
    ctx.fill();

    // Ripples: a few sine bands, positioned by the lot's own `ripple` so two rivers of the same
    // width do not wear the same water.
    const bands = 3 + ((skin && skin.ripple) || 0);
    ctx.strokeStyle = stranded ? 'rgba(220, 120, 90, 0.10)' : 'rgba(190, 230, 255, 0.09)';
    ctx.lineWidth = 1.4;
    for (let i = 0; i < bands; i++) {
      const y = geom.y - geom.r * 1.9 + (i * geom.r * 1.1);
      ctx.beginPath();
      for (let x = 12; x < w - 12; x += 6) {
        const yy = y + Math.sin((x / (28 + i * 7)) + i * 1.7 + (geom.pitch / 60)) * (geom.r * 0.09);
        if (x === 12) ctx.moveTo(x, yy); else ctx.lineTo(x, yy);
      }
      ctx.stroke();
    }
    ctx.strokeStyle = stranded ? 'rgba(240, 150, 110, 0.35)' : 'rgba(226, 232, 240, 0.10)';
    ctx.lineWidth = 1;
    roundRect(ctx, 8, 8, w - 16, h - 16, 14);
    ctx.stroke();
  }

  function drawBanks(skin) {
    const { pitch, y, w } = geom;
    const cells = game.board.length;
    const leftEnd = padX(0) - pitch * 0.62;
    const rightStart = padX(cells - 1) + pitch * 0.62;
    const lily = (skin && skin.lily) || 0;
    for (const [x0, x1, dirName] of [[8, leftEnd, 'left'], [rightStart, w - 8, 'right']]) {
      if (x1 - x0 <= 2) continue;
      const g = ctx.createLinearGradient(0, y - pitch, 0, y + pitch);
      g.addColorStop(0, dirName === 'left' ? '#2f4a2a' : '#3a3325');
      g.addColorStop(1, dirName === 'left' ? '#1d2f1c' : '#241f16');
      ctx.fillStyle = g;
      roundRect(ctx, x0, y - pitch * 1.15, x1 - x0, pitch * 2.3, 8);
      ctx.fill();
      // Reeds, count fixed by the lot so the picture is reproducible from the seed alone.
      const reeds = 2 + ((skin && skin.reeds) || 0) % 3;
      ctx.strokeStyle = dirName === 'left' ? 'rgba(150, 200, 130, 0.5)' : 'rgba(200, 180, 120, 0.45)';
      ctx.lineWidth = Math.max(1, pitch * 0.05);
      for (let i = 0; i < reeds; i++) {
        const rx = x0 + ((x1 - x0) * (i + 0.7)) / (reeds + 0.4);
        const hgt = pitch * (0.5 + 0.16 * ((i + lily) % 3));
        ctx.beginPath();
        ctx.moveTo(rx, y - pitch * 0.2);
        ctx.quadraticCurveTo(rx + pitch * 0.12, y - pitch * 0.2 - hgt * 0.6, rx + pitch * 0.05, y - pitch * 0.2 - hgt);
        ctx.stroke();
      }
    }
  }

  function drawPads() {
    const { pitch, r } = geom;
    const cells = game.board.length;
    for (let p = 0; p < cells; p++) {
      const c = centreOf(p);
      const free = game.board[p] === GAP;
      if (free) {
        // The one free pad: a ring of disturbed water, not a leaf. Where a frog could land.
        ctx.strokeStyle = 'rgba(210, 240, 255, 0.34)';
        ctx.lineWidth = Math.max(1, r * 0.14);
        for (let i = 0; i < 2; i++) {
          ctx.beginPath();
          ctx.ellipse(c.x, c.y, r * (0.72 + i * 0.34), r * (0.36 + i * 0.18), 0, 0, Math.PI * 2);
          ctx.stroke();
        }
        continue;
      }
      // A lily pad under each frog, cut with the classic notch.
      ctx.fillStyle = 'rgba(38, 74, 48, 0.92)';
      ctx.beginPath();
      ctx.ellipse(c.x, c.y + r * 0.52, r * 1.24, r * 0.62, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(120, 190, 140, 0.24)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.ellipse(c.x, c.y + r * 0.52, r * 1.24, r * 0.62, 0, 0, Math.PI * 2);
      ctx.stroke();
      if (pitch > 26) {
        ctx.fillStyle = 'rgba(20, 44, 28, 0.9)';
        ctx.beginPath();
        ctx.moveTo(c.x, c.y + r * 0.52);
        ctx.arc(c.x, c.y + r * 0.52, r * 1.24, -0.5, -1.15, true);
        ctx.closePath();
        ctx.fill();
      }
    }
  }

  function drawFrog(p, now) {
    const { r } = geom;
    const c = frogCentre(p, now);
    const frog = game.board[p];
    if (frog !== LEAP && frog !== HOP) return;
    const dir = dirOf(frog);
    const legal = isLegalPad(p);
    const can = legal;
    const x = c.x + (shake && shake.pad === p ? shakeOffset(now) : 0);
    const y = c.y;
    const body = frog === LEAP ? (can ? '#63c76a' : '#3f7a46') : (can ? '#e0a54a' : '#8a6a35');
    const belly = frog === LEAP ? 'rgba(200, 255, 205, 0.34)' : 'rgba(255, 232, 190, 0.30)';

    ctx.save();
    if (anim && anim.to === p) {
      ctx.shadowColor = 'rgba(0,0,0,0.45)';
      ctx.shadowBlur = 10;
      ctx.shadowOffsetY = 4;
    }
    // legs, then body, then eyes: a frog is a squat triangle-ish blob with two bumps on top,
    // facing the direction it is allowed to walk.
    ctx.strokeStyle = can ? body : '#3a4a3c';
    ctx.lineWidth = Math.max(1.5, r * 0.2);
    ctx.lineCap = 'round';
    for (const side of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(x + dir * r * 0.1, y + side * r * 0.15);
      ctx.lineTo(x - dir * r * 0.72, y + side * r * 0.62);
      ctx.lineTo(x - dir * r * 0.3, y + side * r * 0.78);
      ctx.stroke();
    }
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.ellipse(x, y, r * 0.92, r * 0.72, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = belly;
    ctx.beginPath();
    ctx.ellipse(x - dir * r * 0.16, y + r * 0.2, r * 0.5, r * 0.3, 0, 0, Math.PI * 2);
    ctx.fill();
    // the eye bumps sit toward the direction of travel, so "which way this frog faces" is
    // readable at a glance and the illegal-backwards rule is visible rather than memorised.
    for (const side of [-1, 1]) {
      ctx.fillStyle = '#f4f7f2';
      ctx.beginPath();
      ctx.arc(x + dir * r * 0.5, y - side * r * 0.42 - r * 0.1, r * 0.26, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#161a14';
      ctx.beginPath();
      ctx.arc(x + dir * r * 0.6, y - side * r * 0.42 - r * 0.1, r * 0.12, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();


    if (can) {
      // A faint dashed arc onto the pad this frog would land on: the future, drawn not asserted.
    const m = frameMoves.get(p);
      if (m) {
        const to = centreOf(m.to);
        ctx.save();
        ctx.strokeStyle = 'rgba(150, 230, 255, 0.30)';
        ctx.setLineDash([3, 4]);
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.quadraticCurveTo((x + to.x) / 2, y - geom.r * 1.5, to.x, to.y);
        ctx.stroke();
        ctx.restore();
      }
    }
    if (hint && hint.pad === p && now < hint.until) {
      const t = ringPhase();
      ctx.save();
      ctx.lineWidth = 2 + t * 4;
      ctx.strokeStyle = `rgba(140, 225, 255, ${(0.9 - t * 0.6).toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(x, y, r * (1.35 + t * 0.5), 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  }

  function drawStranded(now) {
    if (!game || !game.table) return;
    if (distance(game.table, game.board) !== null || isGoal(game.board)) return;
    const { w, h, pitch } = geom;
    ctx.save();
    ctx.fillStyle = 'rgba(120, 40, 20, 0.16)';
    roundRect(ctx, 8, 8, w - 16, h - 16, 14);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 170, 130, 0.65)';
    ctx.lineWidth = 2;
    const cx = padX(game.board.length >> 1);
    const cy = geom.y - pitch * 1.15;
    ctx.beginPath();
    ctx.moveTo(cx - pitch * 0.2, cy - pitch * 0.2);
    ctx.lineTo(cx + pitch * 0.2, cy + pitch * 0.2);
    ctx.moveTo(cx + pitch * 0.2, cy - pitch * 0.2);
    ctx.lineTo(cx - pitch * 0.2, cy + pitch * 0.2);
    ctx.stroke();
    ctx.fillStyle = 'rgba(255, 205, 180, 0.9)';
    ctx.font = `${Math.max(11, Math.round(pitch * 0.42))}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText('困在水中', cx, cy - pitch * 0.42);
    ctx.restore();
  }

  function draw(now = performance.now()) {
    const { w, h } = geom;
    ctx.clearRect(0, 0, w, h);
    if (!game) return;
    const cells = game.board.length;
    const stranded = game.table ? (distance(game.table, game.board) === null && !isGoal(game.board)) : false;
    refreshMoves();
    drawWater(game.skin, stranded);
    drawBanks(game.skin);
    drawPads();
    for (let p = 0; p < cells; p++) if (game.board[p] !== GAP) drawFrog(p, now);
    drawStranded(now);
  }

  // Diff the board we last drew against the board we are about to draw: that is how a single
  // hop is turned into an arc without the shell having to tell the view what happened, which in
  // turn means the demo, a finger and a test replay all animate the same way.
  // Returns true when something about the picture changed, so an untouched river stops drawing
  // and pixelsHash() stays a fingerprint of the position rather than of the clock.
  function syncAnim(now) {
    if (anim && now - anim.t0 >= anim.ms) {
      anim = null;                                      // one last frame at the settled geometry
      return true;
    }
    if (!game) return false;
    const key = boardKey(game.board);
    if (prev === null) { prev = key; return true; }
    if (prev === key) return false;
    const before = prev;
    prev = key;
    const oldBoard = before.split('').map(Number);
    const moves = [];
    for (let p = 0; p < oldBoard.length; p++) {
      if (oldBoard[p] !== game.board[p]) moves.push(p);
    }
    if (moves.length !== 2) { anim = null; return true; }      // undo / reset / a new lot: snap
    const from = oldBoard[moves[0]] === GAP ? moves[1] : moves[0];
    const to = from === moves[0] ? moves[1] : moves[0];
    const span = Math.abs(to - from);
    anim = { from, to, t0: now, ms: span === 1 ? SLIDE_MS : HOP_MS, arc: span === 1 ? geom.r * 0.35 : geom.r * 1.7 };
    return true;
  }

  function frame(now) {
    raf = requestAnimationFrame(frame);
    last = now;
    const busy = anim !== null || shake !== null || drag !== null || (!!hint && now < hint.until);
    if (hint && now >= hint.until) hint = null;
    syncAnim(now);
    // The river repaints every frame while a hop, a shake or a hint ring is alive, and for four
    // warm-up frames after a load; an untouched river then stops drawing, which is what keeps
    // pixelsHash() a fingerprint of the *position* rather than of the clock.
    if (busy || warm < 4) { warm++; draw(now); }
  }

  // ---------------------------------------------------------------- the pointer

  function ask(move) {
    if (!move) return false;
    return !!(onMove && onMove(move));
  }

  function down(ev) {
    if (!game || game.done) return;
    const p = localPoint(ev);
    const pad = padAt(p.x, p.y);
    if (pad < 0) return;                       // bare water is not a frog, and costs nothing
    ev.preventDefault();
    const move = frameMoves.get(pad) || refreshMoves().get(pad);
    drag = { pad, x: p.x, y: p.y, moved: false, target: move ? move.to : -1 };
    if (hint && hint.pad === pad) hint = null;
  }

  function move_(ev) {
    if (!drag) return;
    const p = localPoint(ev);
    if (Math.hypot(p.x - drag.x, p.y - drag.y) > geom.r * 0.35) drag.moved = true;
    drag.x = p.x;
    drag.y = p.y;
  }

  function up(ev) {
    if (!drag) return;
    const p = localPoint(ev);
    const pad = padAt(p.x, p.y);
    const started = drag.pad;
    const target = drag.target;
    const dragged = drag.moved;
    drag = null;
    if (!dragged) {
      // A plain click on a frog: its own unique legal destination, or a refusal. A frog has at
      // most one free pad it could reach, so no disambiguation menu is needed.
      const m = frameMoves.get(started);
      if (m) ask(m);
      else {
        shake = { pad: started, t0: performance.now() };
        if (onIllegal) onIllegal(started, game.board);
      }
      draw();
      return;
    }
    if (target >= 0 && pad === target) { ask({ from: started, to: target }); draw(); return; }
    if (pad >= 0 && pad !== started) {
      // dragged somewhere the rules do not reach: refused, unbilled, and shown as such
      shake = { pad: started, t0: performance.now() };
      if (onIllegal) onIllegal(started, game.board, pad);
    }
    draw();
  }

  canvas.addEventListener('pointerdown', down);
  canvas.addEventListener('pointermove', move_);
  window.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', () => { drag = null; });

  // The canvas's box is decided by CSS, and a `window` resize does not always follow it: a phone
  // rotating, the panel reflowing or a devtools split all change the box. The hit test maps
  // client pixels through geometry measured from that box, so measuring late means pressing the
  // wrong frog. Watch the box itself. (Guarded: this file is also loaded by `node --check`.)
  if (typeof ResizeObserver === 'function') {
    let first = true;
    const ro = new ResizeObserver(() => {
      if (first) { first = false; return; }    // the initial callback is the layout we measured
      measure();
    });
    ro.observe(canvas);
  }

  return {
    // The gate the runtime pref flip lands on: idempotent, repaints so a pad stops mid-sway
    // on the frame the setting changes rather than at the end of the 240ms decay.
    setReduceMotion(v) {
      const on = !!v;
      if (on === reduceMotion) return reduceMotion;
      reduceMotion = on;
      if (reduceMotion) draw(performance.now());
      return reduceMotion;
    },
    isReducedMotion: () => reduceMotion,
    attach(next) {
      game = next;
      hint = null;
      drag = null;
      shake = null;
      anim = null;
      prev = null;
      measure();
    },
    detach() { game = null; },
    // Where pad p is right now, in client pixels, plus what the rules say about it. This is what
    // an automated finger presses, and it goes through the same mapping a real finger does.
    padPoint(p) {
      if (!game || p < 0 || p >= game.board.length) return null;
      const c = frogCentre(p, performance.now());
      const m = frameMoves.get(p);
      return {
        ...toClient(c.x, c.y),
        pad: p,
        contents: game.board[p],
        legal: !!m,
        to: m ? m.to : null,
        kind: m ? m.kind : null,
        goal: isGoal(game.board),
      };
    },
    cells() { return game ? game.board.length : 0; },
    board() { return game ? game.board.slice() : null; },
    // The pads holding a frog the rules would accept right now, in pad order.
    legalPads() {
      return game ? legalMoves(game.board, game.rules).map((m) => m.from) : [];
    },
    moves() { return game ? legalMoves(game.board, game.rules) : []; },
    stranded() { return !!(game && game.table && distance(game.table, game.board) === null && !isGoal(game.board)); },
    measure,
    redraw() { draw(); },
    showHint(pad) {
      hint = { pad, until: performance.now() + 2600 };
      draw();
    },
    // A cheap fingerprint of what is on screen, so the browser suite can assert that a legal hop
    // changes the picture and a refused one leaves it where it was.
    pixelsHash() {
      const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let sum = 0;
      for (let i = 0; i + 2 < d.length; i += 4 * 617) sum = (sum * 31 + d[i] + d[i + 1] * 3 + d[i + 2] * 7) % 2147483647;
      return sum;
    },
    painted() {
      const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let n = 0;
      for (let i = 3; i < d.length; i += 4 * 97) if (d[i] > 0) n++;
      return n;
    },
    start() {
      if (!raf) {
        last = 0;
        warm = 0;
        raf = requestAnimationFrame(frame);
      }
    },
    stop() {
      cancelAnimationFrame(raf);
      raf = 0;
    },
  };
}
