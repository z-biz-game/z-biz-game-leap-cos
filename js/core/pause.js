// The pause: one flag, one clock, one door.
//
// This file is why 「暂停」 is a behaviour and not a label. It owns exactly three things:
//
//   1. the flag — is this river on hold? One truth; the shell keeps no copy of it;
//   2. the clock — the time this river has been on the table, with every paused stretch left
//      out. So a pause never eats a second and never invents one;
//   3. the door — `guard()` wraps the one function that changes the pads, so a finger, a
//      drag, the demo's own auto-play and a test replay are all held at the same place.
//
// No DOM and no window: js/main.js wires it to the button, the veil and the view; the node
// suite drives it with a hand-cranked clock and watches the behaviour from the outside.

const wallClock = () => (globalThis.performance && typeof globalThis.performance.now === 'function'
  ? globalThis.performance.now()
  : Date.now());

export function createPause({ now = wallClock } = {}) {
  let paused = false;
  let banked = 0;      // milliseconds already on the clock
  let since = null;    // when the running stretch began (null: the clock stands still)
  let over = false;    // the river is finished, so the reading is final

  // Move the running stretch onto the clock and stop it there. This is the line that makes a
  // pause freeze the reading instead of merely hiding it.
  function bank() {
    if (since === null) return;
    banked += Math.max(0, now() - since);
    since = null;
  }

  function hold() {
    if (paused) return false;
    paused = true;
    bank();
    return true;
  }

  function release() {
    if (!paused) return false;
    paused = false;
    if (!over && since === null) since = now();
    return true;
  }

  return {
    get paused() { return paused; },
    get finished() { return over; },
    // Milliseconds on the table so far, paused stretches excluded.
    elapsedMs() { return banked + (since === null ? 0 : Math.max(0, now() - since)); },
    // A fresh river: the clock goes back to zero and the river is not on hold.
    start() { paused = false; over = false; banked = 0; since = now(); return true; },
    // The far bank is reached: the reading stops where it is.
    finish() { over = true; bank(); return true; },
    pause: hold,
    resume: release,
    // Returns the new state: true means the river is now on hold.
    toggle() { return paused ? (release(), false) : (hold(), true); },
    // The door: false while the river is on hold.
    allow() { return !paused; },
    // Wrap the one function that changes the pads. A blocked call returns false and changes
    // nothing at all — not the pads, not the count, not the distance.
    guard(fn) {
      return (...args) => (paused ? false : fn(...args));
    },
  };
}
