// Minimal CDP driver for headless playtesting (Node 21+ global WebSocket/fetch, no Playwright).
//
// env: CDP_PORT (devtools port, default 9356), BASE_URL (page to attach to, default
//      http://127.0.0.1:5196/)
// usage:
//   node playtest.mjs open  <url>          # reuse-or-create our page and navigate
//   node playtest.mjs nav   <url>
//   node playtest.mjs eval  '<js expression>'   # pass `nonav` to skip the reload
//   node playtest.mjs eval  '@boot'        # | @play | @routes | @save | @reloaded | @pointer
//   node playtest.mjs tap   <pad>          # one real mouse press+release on lily pad <pad>
//   node playtest.mjs drag  <from> <to>    # press, move, release — a hop made by hand
//   node playtest.mjs shot  <path.png>
//   node playtest.mjs logs
//
// Every scenario reports { rows, fail } in the same shape as tools/harness.mjs, so
// tools/verify.sh aggregates node suites and browser suites on one line.
const PORT = process.env.CDP_PORT || 9356;
// Which page to attach to. Hard-coding the dev-server port silently evaluates against a fresh
// about:blank tab when pointed at any other origin.
const BASE = process.env.BASE_URL || 'http://127.0.0.1:5196/';
const SHELL_TIMEOUT = Number(process.env.SHELL_TIMEOUT || 30000);
const ORIGIN = new URL(BASE).origin;
const isOurs = (u) => typeof u === 'string' && u.startsWith(ORIGIN);
const cmd = process.argv[2];
const arg = process.argv[3];

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.events = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { res, rej } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
      } else if (msg.method) {
        this.events.push(msg);
        if (globalThis.__printEvents) globalThis.__printEvents(msg);
      }
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One real mouse event at a client-space coordinate. Shared by the @pointer suite and the `tap`
// command so the two cannot drift apart in what "a press" means over the wire.
const mouseAt = (cdp, sessionId, type, x, y, buttons) => cdp.send('Input.dispatchMouseEvent', {
  type, x, y, button: 'left', buttons, clickCount: type === 'mousePressed' ? 1 : 0,
}, sessionId);

// Press and release at the point the page says lily pad p currently occupies. The page computes
// that point through the same mapping a real eye uses (js/view.js padPoint -> getBoundingClientRect
// + geometry), so a pass here means the finger reaches the frog.
async function tapPadAt(cdp, sessionId, runJS, p, hold = 28, rest = 90) {
  const pt = await runJS(`JSON.stringify(window.leap.padPoint(${p}))`);
  if (!pt || pt === 'null') return null;
  const q = JSON.parse(pt);
  await mouseAt(cdp, sessionId, 'mousePressed', q.x, q.y, 1);
  await sleep(hold);
  await mouseAt(cdp, sessionId, 'mouseReleased', q.x, q.y, 0);
  await sleep(rest);
  return q;
}

// A press on one pad, a drag onto another, a release there: the other half of the input surface,
// and the half a click-only test would never touch.
async function dragPad(cdp, sessionId, runJS, from, to, extra = []) {
  const a = JSON.parse(await runJS(`JSON.stringify(window.leap.padPoint(${from}))`));
  const b = JSON.parse(await runJS(`JSON.stringify(window.leap.padPoint(${to}))`));
  if (!a || !b) return null;
  await mouseAt(cdp, sessionId, 'mousePressed', a.x, a.y, 1);
  await sleep(24);
  for (let i = 1; i <= 3; i++) {
    const x = a.x + ((b.x - a.x) * i) / 3;
    const y = a.y + ((b.y - a.y) * i) / 3 - 12;
    await mouseAt(cdp, sessionId, 'mouseMoved', x, y, 1);
    await sleep(16);
  }
  for (const [px, py] of extra) await mouseAt(cdp, sessionId, 'mouseMoved', px, py, 1);
  await mouseAt(cdp, sessionId, 'mouseReleased', b.x, b.y, 0);
  await sleep(120);
  return { a, b };
}

async function main() {
  const info = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
  const ws = new WebSocket(info.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const cdp = new CDP(ws);
  let list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
  if (cmd === 'open') {
    for (const t of list) if (t.type === 'page' && isOurs(t.url)) {
      try { await cdp.send('Target.closeTarget', { targetId: t.id || t.targetId }); } catch { /* gone already */ }
    }
    await sleep(300);
    list = [];
  }
  const existing = cmd === 'open' ? null : list.find((t) => t.type === 'page' && isOurs(t.url));
  let targetId, sessionId;
  if (existing) {
    targetId = existing.id || existing.targetId;
    ({ sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true }));
  } else {
    ({ targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' }));
    ({ sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true }));
  }
  const logs = [];
  globalThis.__printEvents = (m) => {
    if (m.method === 'Runtime.consoleAPICalled') {
      logs.push(`[${m.params.type}] ` + m.params.args.map((a) => a.value !== undefined ? String(a.value) : (a.description || a.type)).join(' '));
    } else if (m.method === 'Runtime.exceptionThrown') {
      const e = m.params.exceptionDetails;
      logs.push(`[EXCEPTION] ${e.exception?.description || e.text}\n  at ${e.url}:${e.lineNumber}`);
    } else if (m.method === 'Log.entryAdded') {
      const e = m.params.entry;
      if (e.level === 'error' || e.source === 'rendering') logs.push(`[log:${e.level}] ${e.text} ${e.url || ''}`);
    }
  };
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Log.enable', {}, sessionId);
  await cdp.send('Page.enable', {}, sessionId);

  const runJS = async (expression) => {
    const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };

  // Wait on the shell, not on a timer. The page is a module graph fetched over the network: a
  // fixed sleep is long enough for a localhost server and too short for GitHub Pages, where it
  // made an innocent deployment look broken (window.leap still undefined, canvas still the
  // unstyled 300x150 default, and a 300x150 canvas is a river with no room for 17 pads).
  const waitShell = async (floorMs, budgetMs = SHELL_TIMEOUT) => {
    await sleep(floorMs);
    const deadline = Date.now() + budgetMs;
    for (;;) {
      let ready = false;
      try {
        ready = await runJS('!!(window.leap && window.leap.state && window.leap.state.id)');
      } catch { ready = false; }
      if (ready) return true;
      if (Date.now() > deadline) return false;
      await sleep(150);
    }
  };

  if (cmd === 'open') {
    await cdp.send('Page.navigate', { url: arg || BASE }, sessionId);
    await waitShell(600);
    console.log('opened ' + (arg || BASE) + '\n' + (logs.join('\n') || '(no console output)'));
  } else if (cmd === 'nav') {
    await cdp.send('Page.navigate', { url: arg }, sessionId);
    await waitShell(400);
    console.log('navigated\n' + (logs.join('\n') || '(no console output)'));
  } else if (cmd === 'tap' || cmd === 'drag') {
    // One frog, moved for real, against the page that is already open (no navigation, so the
    // game keeps running between commands). The same primitive @pointer uses; having it on the
    // command line means the win screenshot a human reviews can be produced by a finger rather
    // than by an injected call.
    const from = Number(arg);
    const to = Number(process.argv[4]);
    if (!Number.isInteger(from) || (cmd === 'drag' && !Number.isInteger(to))) {
      console.log(`${cmd} wants pad indices, got: ${arg} ${process.argv[4] || ''}`);
      process.exit(1);
    }
    const done = cmd === 'tap' ? await tapPadAt(cdp, sessionId, runJS, from) : await dragPad(cdp, sessionId, runJS, from, to);
    if (!done) {
      console.log('EVAL THROW: no lily pad ' + from + ' on screen');
      process.exit(1);
    }
    const now = await runJS('window.leap.state.moves + "/" + window.leap.state.par + " done=" + window.leap.state.done + " stranded=" + window.leap.state.stranded');
    console.log(`${cmd} pad ${from}${cmd === 'drag' ? ' -> ' + to : ''} at ${done.x},${done.y} -> ${now}`);
  } else if (cmd === 'eval') {
    if (process.argv[4] !== 'nonav') {
      await cdp.send('Page.navigate', { url: BASE }, sessionId);
      await waitShell(300);
    }
    if (arg && arg.startsWith('@')) {
      const name = arg.slice(1);
      let value = null;
      if (name === 'pointer') {
        value = await pointerScenario(cdp, sessionId, runJS);
      } else if (SCENARIOS[name]) {
        // Clear the row buffer *before* running. With `nonav` every scenario is evaluated in the
        // same page, so if this suite throws at parse time the fallback below would otherwise
        // hand back the previous suite's rows and verify.sh would print them as if they belonged
        // to this one — a broken suite that looks green.
        await runJS('window.__lastRows = null; 1');
        try {
          value = await runJS(SCENARIOS[name]);
        } catch (err) {
          const dumped = await runJS('JSON.stringify(window.__lastRows||[])').catch(() => '[]');
          value = { rows: JSON.parse(dumped) };
          value.rows.push({ test: `@${name} threw`, pass: false, detail: String(err.message).slice(0, 300) });
        }
      } else {
        console.log('unknown scenario ' + name + ' — have ' + Object.keys(SCENARIOS).join(', ') + ', pointer');
        process.exit(1);
      }
      value.fail = (value.rows || []).filter((r) => !r.pass).map((r) => r.test);
      console.log(JSON.stringify(value, null, 2));
    } else {
      try {
        console.log(JSON.stringify(await runJS(arg), null, 2));
      } catch (err) {
        console.log('EVAL THROW: ' + err.message);
      }
    }
    if (logs.length) console.log('--- console ---\n' + logs.join('\n'));
  } else if (cmd === 'shot') {
    await runJS('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId);
    (await import('node:fs')).writeFileSync(arg, Buffer.from(data, 'base64'));
    console.log('wrote ' + arg + ' (' + Math.round(data.length / 1024) + 'kB b64)');
  } else if (cmd === 'logs') {
    await sleep(800);
    console.log(logs.join('\n') || '(none)');
  }
  ws.close();
  process.exit(0);
}

// The one suite a page-side script cannot run: real input. Everything below goes through
// Chrome's own mouse over CDP, so what gets asserted is the pointer-to-frog wiring in js/view.js
// rather than the rule behind it. Frogs are tapped and dragged, and the shell decides whether
// that counted, which is exactly the chain a player depends on.
async function pointerScenario(cdp, sessionId, runJS) {
  const rows = [];
  const rec = (name, pass, detail) => rows.push({
    test: name, pass: !!pass,
    detail: detail === undefined ? null : JSON.parse(JSON.stringify(detail ?? null)),
  });
  const mouse = (type, x, y, buttons) => mouseAt(cdp, sessionId, type, x, y, buttons);
  const key = (k) => cdp.send('Input.dispatchKeyEvent', {
    type: 'keyDown', text: k, key: k, code: 'Key' + k.toUpperCase(), windowsVirtualKeyCode: k.toUpperCase().charCodeAt(0),
  }, sessionId);
  const tapPad = (p) => tapPadAt(cdp, sessionId, runJS, p, 24, 70);

  const ids = await runJS(`['river','modes','totals','crumbs','readout','shelf','hintline','curtain','stars','verdict','tally','proof','again','next','undo','hint','demo','restart','share','wipe','toast']
    .map((i) => [i, !!document.getElementById(i)])`);
  rec('every control the shell reaches for exists', ids.every(([, on]) => on), Object.fromEntries(ids));

  // shoal-10 is the 2-vs-2 bank-to-bank river: eight moves of certified optimum, five pads, and
  // four positions in its own space from which the far bank is unreachable — enough to test a
  // refusal, a strand, a drag and a win without leaving the shallow end.
  await runJS(`window.leap.load('#/lot/shoal-10'); 'ok'`);
  await sleep(420);
  const start = await runJS(`(() => {
    const g = window.leap;
    return { state: g.state, path: g.path(), board: g.board(), legal: g.legalPads(), px: g.pixels(), lit: g.painted(), cells: g.state.cells };
  })()`);
  const par = start.state.par;
  rec('a lot loads with a certified par and a route to match', start.state.id === 'shoal-10' && par === 8 && start.path.length === par,
    { id: start.state.id, par, path: start.path.length });
  rec('the canvas is painted with something on it', start.lit > 60 && start.px > 0, { lit: start.lit, px: start.px });
  rec('the river is five pads wide, two frogs per bank', start.cells === 5 && start.board.join('') === '11022', { cells: start.cells, board: start.board });
  rec('exactly two frogs may move, and they both aim at the gap', start.legal.length === 2 && JSON.stringify(start.legal) === JSON.stringify([1, 3]), start.legal);

  // A refused tap: a frog the rules will not let move. It must not be billed, must not move the
  // pads, and after its shake decays the picture must be the same picture.
  const dead = await runJS(`window.leap.illegalPad()`);
  if (dead < 0) {
    rec('a refused tap is testable on this position', false, 'every frog on this river can move');
  } else {
    const said = await runJS(`document.getElementById('hintline').textContent`);
    const point = await tapPad(dead);
    const after = await runJS(`(() => { const g = window.leap; return {
      moves: g.state.moves, left: g.state.left, board: g.board(), said: document.getElementById('hintline').textContent, legal: g.legalPads(),
    }; })()`);
    rec('a tap on a frog with nowhere to go is refused', !!point && after.moves === 0 && after.left === par,
      { pad: dead, moves: after.moves, left: after.left });
    rec('the shell says which pad is stuck', /无路可走/.test(after.said), after.said);
    rec('the stuck frog is still stuck and the legal ones still legal', JSON.stringify(after.legal) === JSON.stringify(start.legal), after.legal);
    await sleep(600);
    const back = await runJS(`(() => { const g = window.leap; g.reset(); return { px: g.pixels(), moves: g.state.moves, board: g.board() }; })()`);
    rec('a refused tap leaves nothing behind', back.px === start.px && back.board.join('') === start.board.join(''), { before: start.px, after: back.px });
  }

  // A legal tap: billed, visible, and the pads really moved.
  const first = start.path[0];
  await tapPad(first.from);
  const after1 = await runJS(`(() => { const g = window.leap; return {
    moves: g.state.moves, board: g.board(), left: g.state.left, px: g.pixels(),
    said: document.getElementById('hintline').textContent, point: g.padPoint(${first.from}),
  }; })()`);
  rec('a legal tap on pad ' + (first.from + 1) + ' is billed as one move', after1.moves === 1 && after1.left === par - 1,
    { moves: after1.moves, left: after1.left });
  rec('and it moved exactly that frog onto the free pad', after1.board[first.to] === start.board[first.from] && after1.board[first.from] === 0,
    { move: `${first.from}->${first.to}`, before: start.board.join(''), after: after1.board.join('') });
  rec('the pad the frog left behind reads as empty water to the hit test',
    !!after1.point && after1.point.pad === first.from && after1.point.contents === 0 && after1.point.to === null,
    { want: first, point: after1.point });
  await sleep(420);
  rec('a legal tap changes the picture', (await runJS('window.leap.pixels()')) !== start.px, { before: start.px });

  // 退回 takes the step back and the picture back with it.
  await runJS(`document.getElementById('undo').click(); 'ok'`);
  await sleep(560);
  const undone = await runJS(`(() => { const g = window.leap; return { moves: g.state.moves, board: g.board(), px: g.pixels(), key: g.key() }; })()`);
  rec('undo takes the step back and the river back with it',
    undone.moves === 0 && undone.key === '11022' && undone.px === start.px, undone);

  // A drag, start to finish, is the other half of the input surface.
  await sleep(400);
  const before2 = await runJS('window.leap.state.moves');
  const wasBoard = JSON.parse(await runJS('JSON.stringify(window.leap.board())'));
  const m2 = JSON.parse(await runJS('JSON.stringify(window.leap.path()[0])'));
  const dragged = await dragPad(cdp, sessionId, runJS, m2.from, m2.to);
  const afterDrag = await runJS(`(() => { const g = window.leap; return { moves: g.state.moves, board: g.board() }; })()`);
  rec('a drag from the frog onto its own landing pad counts exactly one move',
    !!dragged && afterDrag.moves === before2 + 1 && afterDrag.board[m2.to] === wasBoard[m2.from] && afterDrag.board[m2.from] === 0,
    { before2, moves: afterDrag.moves, want: m2, was: wasBoard, now: afterDrag.board });
  // Then drag a legal frog onto a pad the rules do not reach: the hit test itself names the
  // refusal, so the pad it landed on must be neither its own target nor its own origin.
  const wrong = await runJS(`(() => {
    const g = window.leap;
    const legal = g.legalPads();
    if (!legal.length) return null;
    const from = legal[0];
    const ok = g.padPoint(from).to;
    const cells = g.state.cells;
    let to = (ok + 1) % cells;
    if (to === from) to = (to + 1) % cells;
    return { from, to, ok };
  })()`);
  const beforeWrong = await runJS('window.leap.state.moves');
  if (wrong) await dragPad(cdp, sessionId, runJS, wrong.from, wrong.to);
  const afterWrong = await runJS(`(() => { const g = window.leap; return { moves: g.state.moves, board: g.board(), said: document.getElementById('hintline').textContent }; })()`);
  rec('a drag onto a pad the rules refuse is not billed', !!wrong && afterWrong.moves === beforeWrong, { wrong, moves: afterWrong.moves });
  rec('and the shell explains the refusal', /跳不到|无路可走/.test(afterWrong.said), afterWrong.said);
  await runJS('window.leap.reset(); 1');
  await sleep(420);

  // A tap on bare water is not a tap on a frog: no move, and no refusal message either.
  const miss = await runJS(`(() => {
    const g = window.leap;
    const box = document.getElementById('river').getBoundingClientRect();
    const probe = g.padPoint(0);
    const grab = probe ? probe.r + probe.pitch * 0.3 : 24;
    const cands = [[box.left + 4, box.top + 4], [box.right - 4, box.top + 4], [box.left + 4, box.bottom - 4], [box.right - 4, box.bottom - 4], [box.left + box.width / 2, box.bottom - 6]];
    for (const [x, y] of cands) {
      // A point outside the viewport would dispatch a mouse event that never reaches the page,
      // which would make "nothing happened" true for the wrong reason.
      if (x < 1 || y < 1 || x > innerWidth - 1 || y > innerHeight - 1) continue;
      let far = true;
      for (let p = 0; p < g.state.cells; p++) { const q = g.padPoint(p); if (q && Math.hypot(x - q.x, y - q.y) <= grab) far = false; }
      if (far) return { x: Math.round(x), y: Math.round(y), grab };
    }
    return null;
  })()`);
  if (!miss) {
    rec('a tap on bare water is ignored', false, 'every corner of the canvas is within reach of a pad');
  } else {
    const saidBefore = await runJS(`document.getElementById('hintline').textContent`);
    await mouse('mousePressed', miss.x, miss.y, 1);
    await sleep(24);
    await mouse('mouseReleased', miss.x, miss.y, 0);
    await sleep(140);
    const afterMiss = await runJS(`(() => { const g = window.leap; return { moves: g.state.moves, said: document.getElementById('hintline').textContent }; })()`);
    rec('a tap on bare water is ignored: no move and no refusal', afterMiss.moves === 0 && afterMiss.said === saidBefore, { miss, after: afterMiss });
  }

  // The whole certified route, tapped for real. Eight presses, because par for this river is 8.
  await runJS(`document.getElementById('restart').click(); 'ok'`);
  await sleep(420);
  const route = await runJS(`window.leap.path()`);
  let played = 0;
  const log = [];
  for (const m of route) {
    const p = await tapPad(m.from);
    if (!p) { rec(`pad ${m.from + 1} is on screen`, false, p); break; }
    const now = await runJS(`(() => { const g = window.leap; return { moves: g.state.moves, left: g.state.left, done: g.state.done, stranded: g.state.stranded }; })()`);
    played++;
    log.push({ move: `${m.from}->${m.to}`, ...now });
    if (now.moves !== played) { rec(`tap ${played} counted as one move`, false, log); break; }
    if (now.stranded) { rec(`tap ${played} stayed in solvable water`, false, log); break; }
    await sleep(300);
  }
  rec('the mouse hops the whole certified route, one move per press', played === par, log);
  await sleep(700);
  const end = await runJS(`(() => {
    const g = window.leap;
    return {
      state: g.state,
      stars: document.getElementById('stars').textContent,
      verdict: document.getElementById('verdict').textContent,
      tally: document.getElementById('tally').textContent,
      proof: document.getElementById('proof').textContent,
      curtain: !document.getElementById('curtain').hidden,
      record: g.store.record(g.state.id),
    };
  })()`);
  rec('the banks are swapped and the river is won', end.state.done && end.state.moves === par && end.state.left === 0, end.state);
  rec('the win card goes up with three stars', end.curtain && end.stars === '★★★' && end.verdict === '踏波无痕', { stars: end.stars, verdict: end.verdict, curtain: end.curtain });
  rec('the card prints the player count against the measured minimum', end.tally.includes('你的 ' + par + ' 步') && end.tally.includes('最短 ' + par + ' 步'), end.tally);
  rec('the card says where its own number came from', /穷尽本河段 23 个可达局面/.test(end.proof) && /n\(n\+2\) = 2×4/.test(end.proof), end.proof);
  rec('the run is on record at par', end.record && end.record.best === par && end.record.perfect === true, end.record);

  // The dead-water branch, by hand: this river really does have positions the player can hop
  // into and never recover from, and the shell has to say so rather than print a distance.
  await runJS(`document.getElementById('again').click(); 'ok'`);
  await sleep(380);
  const strand = await runJS(`(() => {
    const g = window.leap;
    const route = g.path();
    g.play(route.slice(0, 1));
    const legal = g.legalPads();
    const startBoard = g.board();
    // the frog left behind at pad 0 can slide into the gap the leader just vacated, and that is
    // the move that ends this crossing
    return { from: 0, to: 1, legal, board: startBoard.join(''), moves: g.state.moves };
  })()`);
  if (!strand.legal.includes(strand.from)) {
    rec('a stranding hop exists on this river', false, strand);
  } else {
    await tapPad(strand.from);
    await sleep(420);
    const stuck = await runJS(`(() => { const g = window.leap; return {
      state: g.state, said: document.getElementById('hintline').textContent, readout: document.getElementById('readout').textContent,
      hint: (function () { const h = g.hintOnce(); g.reset(); return h; })(),
    }; })()`);
    rec('a hop into dead water is billed and reported', stuck.state.moves === 2 && stuck.state.stranded === true, { moves: stuck.state.moves, stranded: stuck.state.stranded });
    rec('the panel prints 困 instead of a distance', /困/.test(stuck.readout), stuck.readout.slice(0, 220));
    rec('and the hint admits it cannot help', /困死|退回/.test(stuck.hint.line), stuck.hint.line);
    await runJS('window.leap.reset(); 1');
    await sleep(300);
  }

  // Keyboard shortcuts the panel advertises: u/h/r, and the demo that walks the same table.
  await key('h');
  await sleep(260);
  const hinted = await runJS(`(() => ({ hints: window.leap.state.hints, said: document.getElementById('hintline').textContent }))()`);
  rec('the h key asks for a hint and bills it', hinted.hints === 1 && /提示/.test(hinted.said), hinted);
  await key('r');
  await sleep(260);
  rec('the r key restarts and clears the counters', (await runJS('window.leap.state.moves')) === 0 && (await runJS('window.leap.state.hints')) === 0, await runJS('window.leap.state'));
  await key('d');
  await sleep(620);
  const demoing = await runJS(`(() => { const g = window.leap; return { on: g.state.demo, moves: g.state.moves, left: g.state.left, stranded: g.state.stranded }; })()`);
  rec('the d key runs the solver on screen', demoing.on && demoing.moves >= 2 && demoing.left === par - demoing.moves && !demoing.stranded, demoing);
  await key('d');
  await sleep(240);
  rec('and stops it again', (await runJS('window.leap.state.demo')) === false, await runJS('window.leap.state.demo'));
  await key('u');
  await sleep(260);
  rec('the u key undoes a demo step', (await runJS('window.leap.state.moves')) === demoing.moves - 1, await runJS('window.leap.state.moves'));

  return { rows };
}

// In-page suites. Each returns { rows: [{ test, pass, detail }] }.
const SCENARIOS = {
  boot: `(async () => {
    const g = window.leap;
    const rows = [];
    const rec = (name, pass, detail) => rows.push({ test: name, pass: !!pass, detail: detail === undefined ? null : JSON.parse(JSON.stringify(detail ?? null)) });
    window.__lastRows = rows;
    rec('the shell boots straight into a river', g && g.version === 1 && g.state && g.state.mode === 'campaign', g && g.state);
    rec('the first lot is the shallowest one in the pool', g.state.index === 1 && g.state.par === 3, g.state);
    const c = document.getElementById('river');
    rec('the canvas has real pixels', c.width > 0 && c.height > 0 && !!c.getContext('2d'), { w: c.width, h: c.height });
    // A canvas whose CSS was never applied is still the 300x150 box the HTML spec hands out, and
    // a 17-pad river drawn into that strip is unplayable rather than merely ugly. The
    // screenshot catches it by eye; this line is the same check inside the gate, so a stale
    // stylesheet or a collapsed grid cannot pass 90-odd assertions on a page that renders as a
    // footnote.
    const box = c.getBoundingClientRect();
    const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    rec('the canvas is laid out, not the unstyled 300x150 default',
      box.width > 300 && box.height > 300
        && Math.abs(c.width - box.width * dpr) <= dpr + 1 && Math.abs(c.height - box.height * dpr) <= dpr + 1,
      { css: [Math.round(box.width), Math.round(box.height)], backing: [c.width, c.height], dpr });
    rec('the river was actually painted', g.painted() > 60, { litSamples: g.painted() });
    const pool = g.pool;
    rec('the shipped pool loaded', pool && pool.lots >= 30, pool && pool.lots);
    rec('every band reports a measured range', Object.values(pool.byTier).every((t) => t.n > 0 && t.min <= t.max), pool.byTier);
    rec("the browser's own search agrees with the printed par", g.path().length === g.state.par, { path: g.path().length, par: g.state.par });
    const readout = document.getElementById('readout').textContent;
    rec('the panel prints steps, the measured minimum and the record', /步数/.test(readout) && /最短/.test(readout) && /最佳/.test(readout), readout);
    rec('the panel prints the route count, which is a measurement too', /最优路线/.test(readout), readout.slice(0, 200));
    rec('nothing is claimed as unsolved at load', g.state.stranded === false && g.state.done === false && g.state.left === g.state.par, g.state);

    // The repo's claim, measured on this device rather than quoted from a laptop: three
    // independent roads to the same nine numbers, computed in the page.
    const p = g.proof();
    const want = (n) => n * (n + 2);
    rec('the page ran BFS, a memoised DFS and the closed form over n = 1..9',
      p.rows.length === 9 && p.rows.every((r) => r.par === r.dfs && r.par === r.closed && r.par === want(r.n)),
      p.rows.map((r) => r.n + ':' + r.par));
    rec('the published ladder reads 3,8,15,24,35,48,63,80,99', p.rows.map((r) => r.par).join(',') === '3,8,15,24,35,48,63,80,99', p.rows.map((r) => r.par));
    rec('every river has exactly two optimal routes and two openings', p.rows.every((r) => r.paths === 2 && r.openings === 2), p.rows.map((r) => r.n + ':' + r.paths + '/' + r.openings));
    rec('the search that proves it is fast enough to run at boot', p.ms < 1500, { ms: p.ms });
    const s5 = g.solveNow([1, 1, 1, 1, 1, 0, 2, 2, 2, 2, 2]);
    rec('and the page can re-measure a river of its own accord', s5.par === 35 && s5.optimalPaths === 2, s5);
    return { rows };
  })()`,

  play: `(async () => {
    const g = window.leap;
    const rows = [];
    const rec = (name, pass, detail) => rows.push({ test: name, pass: !!pass, detail: detail === undefined ? null : JSON.parse(JSON.stringify(detail ?? null)) });
    window.__lastRows = rows;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const D = (id) => document.getElementById(id);

    g.store.reset();
    // shoal-10, not shoal-01: a three-move river cannot demonstrate a stranding hop, and every
    // number below is arithmetic against a measured par of 8.
    g.load('#/lot/shoal-10'); await sleep(240);
    const par = g.state.par;
    const path = g.path();
    const startKey = g.key();
    rec('the route the page finds is exactly par', path.length === par && par === 8, { path: path.length, par });
    rec('every step of that route is a hop inside this river', path.every((m) => m.from >= 0 && m.from < 5 && m.to >= 0 && m.to < 5 && m.from !== m.to), path);
    // The chain theorem, on screen: play the certified route one step at a time and read the
    // distance field back after each. It must fall by exactly one, never stall and never jump.
    g.reset(); await sleep(120);
    const lefts = [];
    for (const m of path) { g.hopTo(m.from, m.to); lefts.push(g.state.left); }
    rec('每落一步刚好花掉一个单位的最短距离', lefts.join(',') === path.map((_, i) => par - 1 - i).join(','), { lefts, par });
    rec('so a solved river is always at par, never over it', g.state.done && g.state.moves === par && g.state.over === 0, g.state);
    g.reset(); await sleep(120);

    // A stranding hop: legal, billed, and fatal. This river has four such positions, so the
    // claim is checkable rather than hypothetical.
    g.play(path.slice(0, 1));
    const strandedKey = '01122';
    const strand = g.hopTo(0, 1);
    rec('the fatal hop is accepted as a move', !!strand && strand.to === 1 && strand.kind === 'slide' && strand.stranded === true, { strand, key: g.key() });
    rec('it lands the river in dead water', g.key() === strandedKey && g.state.stranded === true, { key: g.key(), stranded: g.state.stranded });
    rec('the distance field has no number to print', g.state.left === null && g.state.over === null, g.state);
    rec('and the strand is counted', g.state.strands === 1 && g.state.moves === 2, g.state);
    const undoBack = g.undoOnce();
    rec('退回 is the way out', undoBack === 1 && g.state.stranded === false && g.state.left === 7, { moves: undoBack, left: g.state.left });

    // Finish it properly through the same commit() a finger uses.
    g.reset(); await sleep(120);
    g.play(g.path());
    rec('a clean crossing arrives at exactly par', g.state.done && g.state.moves === par && g.state.left === 0, g.state);
    rec('three stars, because nothing was asked for', D('stars').textContent === '★★★' && D('verdict').textContent === '踏波无痕', { stars: D('stars').textContent, verdict: D('verdict').textContent });
    rec('a shared river has no next button', !D('curtain').hidden && D('next').hidden === true, { nextHidden: D('next').hidden });
    const clean = g.store.record(g.state.id);
    rec('the run is on record as perfect', clean.best === par && clean.perfect === true && clean.plays >= 2, clean);


    // A hinted crossing is still at par — but the card knows you asked.
    D('restart').click(); await sleep(140);
    const h = g.hintOnce();
    rec('the hint names a move that is on a shortest route', !!h.move && g.state.left === par, h);
    g.play(g.path());
    rec('a hinted win stays at par but loses a star', g.state.done && g.state.moves === par && D('stars').textContent === '★★☆', { moves: g.state.moves, stars: D('stars').textContent, hints: g.state.hints });
    const aided = g.store.record(g.state.id);
    rec('and it is still a solve on record', aided.solved === true && aided.best === par, aided);
    rec('the hint counter is billed', g.store.stats.hints === 1, g.store.stats);

    D('restart').click(); await sleep(140);
    rec('重开 clears the count, the card and the counters', g.state.moves === 0 && g.state.hints === 0 && g.state.strands === 0 && D('curtain').hidden, g.state);

    // The rule is in front of the picture, not behind it: a refused hop changes nothing.
    const legal = g.legalPads();
    const dead = g.illegalPad();
    const before = { moves: g.state.moves, key: g.key() };
    const refused = g.hopTo(dead, (dead + 1) % 5);
    rec('the shell reports an illegal hop as refused', refused === false, { dead, refused });
    rec('and refuses it without billing anything', g.state.moves === before.moves && g.key() === before.key, g.state);
    const m0 = g.path()[0];
    const accepted = g.hopTo(m0.from, m0.to);
    rec('the legal hop on the same position is accepted', !!accepted && accepted.to === m0.to && g.state.moves === before.moves + 1,
      { legal, want: m0, moves: g.state.moves });
    rec('par never moved during any of it', g.state.par === par && g.level().par === par, g.state);

    // The demo is the solver made visible, so it can never be cheaper than par.
    const on = g.demoStart();
    await sleep(900);
    const moved = g.state.moves;
    g.demoStop();
    rec('the demo hops real moves off the same table', on && moved >= 2 && g.state.left === par - moved, { moved, left: g.state.left, par });
    g.reset();
    rec('and stopping it mid-route leaves a plain river, not a finished one',
      g.state.moves === 0 && g.state.left === par && D('curtain').hidden === true, g.state);

    // Last, because it loads a different lot: a campaign river (unlike a shared one) does offer
    // the next segment, and that is what unlocks the shelf.
    g.load('#/c/1'); await sleep(220);
    g.play(g.path()); await sleep(220);
    rec('a campaign river does offer the next one and unlocks it',
      !D('curtain').hidden && !D('next').hidden && g.state.unlocked === 2,
      { nextHidden: D('next').hidden, unlocked: g.state.unlocked, id: g.state.id });
    return { rows };
  })()`,

  routes: `(async () => {
    const g = window.leap;
    const rows = [];
    const rec = (name, pass, detail) => rows.push({ test: name, pass: !!pass, detail: detail === undefined ? null : JSON.parse(JSON.stringify(detail ?? null)) });
    window.__lastRows = rows;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    g.load('#/c/7'); await sleep(180);
    rec('#/c/7 is lot seven', g.state.index === 7 && g.state.mode === 'campaign', g.state);
    g.load('#/c/99999'); await sleep(180);
    rec('a huge index clamps to the last lot', g.state.index === g.pool.lots, { index: g.state.index, lots: g.pool.lots });
    g.load('#/c/0'); await sleep(180);
    rec('index zero clamps up to one', g.state.index === 1, g.state.index);
    g.load('#/'); await sleep(180);
    rec('a bare #/ opens the campaign from the first river', g.state.mode === 'campaign' && g.state.index === 1, g.state);
    g.load('#/c/' + g.pool.lots); await sleep(180);
    rec('the last campaign river is in the deepest band', g.state.tier === 'master', g.state);

    g.load('#/daily'); await sleep(200);
    const daily = g.state.id;
    const dailyPar = g.state.par;
    g.load('#/c/1'); await sleep(180);
    g.load('#/daily'); await sleep(200);
    rec('the daily route is the same river twice', g.state.mode === 'daily' && g.state.id === daily, { first: daily, again: g.state.id });
    rec('the daily label carries the date', /^每日跳蛙渡 · \\d{4}-\\d{2}-\\d{2}$/.test(g.state.label), g.state.label);
    rec('its par is a measured distance the browser can re-derive', g.state.par === dailyPar && g.path().length === dailyPar, { par: dailyPar });
    rec('and for a bank-to-bank daily it is also the closed form', g.closedForm(g.state.a).search === dailyPar && g.state.a === g.state.b, { n: g.state.a, par: dailyPar, proof: g.closedForm(g.state.a) });

    for (const band of g.bands) {
      g.load('#/random/' + band.key + '/fixedseed'); await sleep(220);
      const first = { id: g.state.id, par: g.state.par, tier: g.state.tier };
      g.load('#/c/1'); await sleep(180);
      g.load('#/random/' + band.key + '/fixedseed'); await sleep(220);
      rec('#/random/' + band.key + ' stays in its band and repeats itself',
        first.tier === band.key && g.state.id === first.id && g.state.par >= band.min && g.state.par <= band.max,
        { band: [band.min, band.max], got: first, again: { id: g.state.id, par: g.state.par } });
      rec('  and the route the browser finds matches the printed par', g.path().length === g.state.par, { path: g.path().length, par: g.state.par });
    }
    g.load('#/random/twined/fixedseed'); await sleep(200);
    const twined = g.state.par;
    g.load('#/random/shoal/fixedseed'); await sleep(200);
    rec('the same token in two bands gives two different difficulties', g.state.par < twined, { shoal: g.state.par, twined });
    g.load('#/random'); await sleep(360);
    rec('a bare #/random mints a token into the URL', /^#\\/[a-z/]*random\\/[a-z]+\\/[a-z0-9]+$/.test(location.hash) || /random\\/[a-z]+\\/[a-z0-9]+$/.test(location.hash), location.hash);

    g.load('#/c/5'); await sleep(180);
    const sample = g.state.id;
    g.load('#/c/1'); await sleep(180);
    g.load('#/lot/' + sample); await sleep(180);
    rec('#/lot/<id> opens that river', g.state.id === sample && g.state.mode === 'lot', { want: sample, got: g.state.id });
    g.load('#/lot/shoal-10'); await sleep(180);
    rec('the 2-vs-2 bank-to-bank river is shareable at par 8', g.state.id === 'shoal-10' && g.state.par === 8 && g.state.optimalPaths === 2, g.state);
    g.load('#/lot/not-a-real-river'); await sleep(180);
    rec('an unknown lot id falls back instead of blanking the board', !!g.state.id && g.state.mode === 'lot' && g.state.par >= 1, g.state);
    g.load('#/nonsense'); await sleep(180);
    rec('an unparseable route still deals a river', g.state.mode === 'campaign' && g.state.index === 1, g.state);
    return { rows };
  })()`,

  save: `(async () => {
    const g = window.leap;
    const rows = [];
    const rec = (name, pass, detail) => rows.push({ test: name, pass: !!pass, detail: detail === undefined ? null : JSON.parse(JSON.stringify(detail ?? null)) });
    window.__lastRows = rows;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const D = (id) => document.getElementById(id);
    const KEY = 'leap.save.v1';

    g.store.reset();
    await sleep(60);
    g.load('#/c/1'); await sleep(200);
    g.play(g.path()); await sleep(200);
    const had = Object.keys(g.store.records).length;
    rec('a solve is on record before the wipe is tried', had >= 1 && g.store.record(g.state.id).best === g.state.par, { had, state: g.state });
    D('wipe').click(); await sleep(90);
    rec('the first click only arms it', Object.keys(g.store.records).length === had && !D('toast').hidden && /清空/.test(D('toast').textContent),
      { records: Object.keys(g.store.records).length, toast: D('toast').textContent });
    D('wipe').click(); await sleep(280);
    rec('清空存档 takes two clicks and clears everything',
      Object.keys(g.store.records).length === 0 && g.store.unlocked === 1 && localStorage.getItem(KEY) === null,
      { records: Object.keys(g.store.records), unlocked: g.store.unlocked, key: localStorage.getItem(KEY) });
    rec('and the shell re-renders as a clean device', /已渡 <b>0<\\/b>/.test(D('totals').innerHTML), D('totals').innerHTML);
    rec('the panel says where the save lives', /localStorage 可写|本次会话内存/.test(D('save-mode').textContent), D('save-mode').textContent);

    g.load('#/c/1'); await sleep(200);
    const par = g.state.par;
    g.play(g.path());
    await sleep(200);
    const id = g.state.id;
    const raw = JSON.parse(localStorage.getItem(KEY));
    rec('the solve reaches localStorage, not only memory', !!(raw && raw.records[id] && raw.records[id].best === par), raw && Object.keys(raw.records || {}));
    rec('clearing the first river unlocks the second', g.store.unlocked === 2 && raw.unlocked === 2, { unlocked: g.store.unlocked });
    rec('the record is flagged perfect at the measured minimum', raw.records[id].perfect === true && raw.records[id].plays === 1, raw.records[id]);
    const shelf2 = document.querySelector("#shelf button[data-index='2']");
    rec('the shelf lets river two be clicked', shelf2 && !shelf2.disabled, shelf2 && shelf2.outerHTML);
    const shelf3 = document.querySelector("#shelf button[data-index='3']");
    rec('and keeps river three locked', shelf3 && shelf3.disabled, shelf3 && shelf3.outerHTML);
    g.load('#/c/1'); await sleep(200);
    rec('the panel prints the record it just read back', /最佳<\\/dt><dd>3<\\/dd>/.test(D('readout').innerHTML), D('readout').innerHTML.slice(0, 400));

    g.load('#/daily'); await sleep(240);
    const day = g.state.label.split(' · ')[1];
    g.play(g.path());
    await sleep(240);
    const mark = g.store.dailyDone(day);
    rec('today is logged once crossed', !!mark && mark.id === g.state.id, { day, mark });
    rec('the shelf says today is done', /已渡/.test(D('shelf').textContent), D('shelf').textContent.slice(0, 120));
    const totals = D('totals').innerHTML;
    rec('the header tally counts both crossings', /已渡 <b>\\d<\\/b>/.test(totals) && /提示/.test(totals), totals);
    return { rows };
  })()`,

  // Run after @save in its own process, so `eval` (without nonav) has really reloaded the page:
  // this is the only suite that can tell a warm module cache from a save on disk.
  reloaded: `(async () => {
    const g = window.leap;
    const rows = [];
    const rec = (name, pass, detail) => rows.push({ test: name, pass: !!pass, detail: detail === undefined ? null : JSON.parse(JSON.stringify(detail ?? null)) });
    window.__lastRows = rows;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const D = (id) => document.getElementById(id);

    rec('a fresh page reads its progress off disk', g.store.unlocked === 2, { unlocked: g.store.unlocked, records: Object.keys(g.store.records) });
    const ids = Object.keys(g.store.records);
    const r1 = g.store.record(ids[0]);
    rec('and the first river\\'s record came back', !!r1 && r1.solved === true && r1.perfect === true, r1);
    g.load('#/c/1'); await sleep(220);
    rec('the shelf shows it as already done', /perfect|done/.test((document.querySelector("#shelf button[data-index='1']") || {}).className || ''),
      (document.querySelector("#shelf button[data-index='1']") || {}).className);
    rec('the header counts the recovered solve', /已渡 <b>\\d<\\/b>/.test(D('totals').innerHTML), D('totals').innerHTML);
    g.load('#/daily'); await sleep(240);
    rec('the daily slot is remembered across the reload', g.store.dailyDone(g.state.label.split(' · ')[1]) !== null, g.state);
    g.store.reset();
    rec('and a reset leaves nothing on disk for the next visitor', localStorage.getItem('leap.save.v1') === null, localStorage.getItem('leap.save.v1'));
    return { rows };
  })()`,
};

main().catch((err) => {
  console.error('playtest failed: ' + ((err && err.stack) || err));
  process.exit(1);
});
