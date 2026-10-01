// 音效：三条振荡器（落一步 / 跳一越 / 渡过）加一条拒绝音，全部现写波形，无音频文件。
//
// 两条约束是这个文件存在的全部理由：
//
// 1. **静音必须是真静音**。把 master gain 设成 0 只是"听不见"，振荡器节点还在新建、
//    AudioContext 还在跑，功耗与时序都没变。所以静音做三件事：`suspend()` 停住上下文
//    （时钟不再推进）、`armed` 置否（后续 sfx 调用直接 return，一个节点都不建）、
//    把状态写进存档（刷新后仍然是静音）。
// 2. **AudioContext 只能在用户手势里建**。headless Chrome 在没有手势时创建上下文会打
//    "The AudioContext was not allowed to start" 的 warning，而 tools/verify.sh 把 console
//    不干净判成失败。所以这里由 js/main.js 在 pointerdown / keydown / click 上挂 `arm()`，
//    没 arm 之前所有 sfx 都是空操作 —— 不是降级，是本来就不该在开局前发声。
//
// 本文件不碰 js/core/：tools/verify.sh 的 purity gate 要求 core 里没有浏览器全局。

let ctx = null;
let master = null;
let armed = false;
let muted = false;

function supported() {
  const Ctor = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
  return typeof Ctor === 'function' ? Ctor : null;
}

function context() {
  if (!armed || muted) return null;                 // 静音态不得新建节点：这里连上下文都不取
  const Ctor = supported();
  if (!Ctor) return null;
  if (!ctx) {
    try {
      ctx = new Ctor();
      master = ctx.createGain();
      master.gain.value = 0.32;
      master.connect(ctx.destination);
    } catch (err) {
      ctx = null;                                   // 没有 WebAudio 就不出声，玩法不受影响
      return null;
    }
  }
  if (ctx.state === 'suspended' && ctx.resume) ctx.resume();
  return ctx;
}

// 一条带包络的正弦/三角音：freq 起始频率，to 结束频率（滑音），dur 秒。
function tone(freq, to, dur, type = 'sine', gain = 1, delay = 0) {
  const ac = context();
  if (!ac) return;
  const t0 = ac.currentTime + delay;
  const osc = ac.createOscillator();
  const env = ac.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (to && to !== freq) osc.frequency.exponentialRampToValueAtTime(Math.max(40, to), t0 + dur);
  env.gain.setValueAtTime(0.0001, t0);
  env.gain.exponentialRampToValueAtTime(0.9 * gain, t0 + Math.min(0.02, dur * 0.2));
  env.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(env);
  env.connect(master);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

export const sfx = {
  // 由 js/main.js 挂在真实用户事件上；重复调用无害。
  arm() {
    armed = true;
    if (!muted) context();
    return !muted && !!supported();
  },
  // 真静音：停上下文 + 关掉建节点的入口。恢复时不重建上下文，只 resume。
  setMuted(next) {
    muted = !!next;
    armed = !muted;
    if (muted) {
      if (ctx && ctx.suspend && ctx.state === 'running') ctx.suspend();
    } else if (ctx && ctx.resume && ctx.state === 'suspended') {
      ctx.resume();
    }
    return muted;
  },
  get muted() { return muted; },
  get armed() { return armed; },
  get state() { return ctx ? ctx.state : (armed ? 'armed' : 'idle'); },
  step() { tone(392, 523, 0.11, 'triangle', 0.55); },
  hop() { tone(294, 587, 0.16, 'sine', 0.7); tone(587, 784, 0.1, 'sine', 0.35, 0.05); },
  refuse() { tone(150, 96, 0.14, 'sawtooth', 0.3); },
  win() {
    [523, 659, 784, 1046].forEach((f, i) => tone(f, f, 0.16, 'sine', 0.5, i * 0.075));
  },
  undo() { tone(440, 300, 0.09, 'sine', 0.4); },
};
