#!/usr/bin/env bash
# One-shot verification: the node suites first, then a real browser against a real server,
# driven over CDP. Everything the script starts exits with the script, including the Chrome it
# launched in a throwaway profile.
#
#   bash tools/verify.sh                              # node suites + @boot @play @routes @save @reloaded @pointer
#   SCENARIOS="pointer" bash tools/verify.sh          # one browser suite while editing the view
#   SKIP_UNIT=1 bash tools/verify.sh                  # browser only (what the CI browser job does)
#
# Ports: 5196 (web) and 9356 (devtools) are this repo's own. They MUST NOT be changed to a
# sibling's: :5180/:9340 belong to gridlock, :5181/:9341 to nine-rings, and 5182-5199 / 9334-9353
# are taken by the other agents in this batch. This machine also runs one headless Chrome per
# repo at a time, so the pre-flight below waits rather than double-binding.
#
# Do NOT add --use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader: software
# rasterisation saturates the cores and, with no CDP client attached, the process will not exit
# on its own. This game is 2D canvas, so plain headless Chrome is enough.
set -u
HERE=$(cd "$(dirname "$0")/.." && pwd)
CDP_PORT=${CDP_PORT:-9356}; if command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:"$CDP_PORT" -sTCP:LISTEN >/dev/null 2>&1; then echo ":$CDP_PORT is already LISTENING — a sibling gate or an orphan Chrome holds it; attaching there reads someone else's browser. Wait for it to finish, or rerun with CDP_PORT=<a free port>." >&2; lsof -nP -iTCP:"$CDP_PORT" -sTCP:LISTEN >&2 || true; exit 6; fi  # 一机一台：撞在同一个默认口上时不报错的是 Chrome，报错的是绿——先让路再开闸
WEB_PORT=${WEB_PORT:-5196}
BASE=${BASE_URL:-http://127.0.0.1:$WEB_PORT/}
SHOTS=${SHOTS:-/tmp/leap}
CHROME=${CHROME_BIN:-}
if [ -z "$CHROME" ]; then
  for c in "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
           "/Applications/Chromium.app/Contents/MacOS/Chromium" \
           google-chrome chromium chromium-browser; do
    if command -v "$c" >/dev/null 2>&1 || [ -x "$c" ]; then CHROME=$c; break; fi
  done
fi
[ -x "$CHROME" ] || { echo "no Chrome found; set CHROME_BIN" >&2; exit 2; }

port_free() { ! nc -z 127.0.0.1 "$1" 2>/dev/null && ! nc -z 127.0.0.1 "$1" -u 2>/dev/null; }
busy() {
  # lsof is the honest check: a listening socket on either port means another agent's Chrome or
  # server is in the way, and driving *that* browser would report its verdict as ours.
  lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
}

for p in "$CDP_PORT" "$WEB_PORT"; do
  for i in $(seq 1 20); do
    busy "$p" || break
    echo "port $p is taken (another agent's Chrome or server?); waiting 3s ($i/20)" >&2
    sleep 3
  done
  if busy "$p"; then
    echo "port $p still busy after 60s; re-run with CDP_PORT=... WEB_PORT=... (see the port note at the top)" >&2
    exit 6
  fi
done
if pgrep -f "remote-debugging-port=$CDP_PORT" >/dev/null 2>&1; then
  echo "a Chrome already owns --remote-debugging-port=$CDP_PORT; refusing to attach to it" >&2
  exit 6
fi

UDD=$(mktemp -d)
"$CHROME" --headless=new --remote-debugging-port=$CDP_PORT --user-data-dir=$UDD \
  --window-size=1000,820 --no-first-run --no-default-browser-check about:blank >"$SHOTS-chrome.log" 2>&1 &
CPID=$!
node "$HERE/server.cjs" $WEB_PORT >"$SHOTS-server.log" 2>&1 &
SPID=$!
cleanup() {
  kill -9 $CPID $SPID 2>/dev/null
  # wait on every background pid, or the script's last lines turn into a shower of Killed: 9
  wait $CPID 2>/dev/null
  wait $SPID 2>/dev/null
  kill $WD 2>/dev/null
  wait $WD 2>/dev/null
  rm -rf $UDD
}
trap cleanup EXIT
# The watchdog redirects its fds: a background subshell inherits the script's stdout, and if this
# runs inside a pipeline it would hold the write end open for the full timeout and stall the
# consumer long after the tests finished.
( sleep ${WD_TIMEOUT:-300}; cleanup ) </dev/null >/dev/null 2>&1 & WD=$!

# A fresh --user-data-dir binds DevTools noticeably later than a warm profile, so wait on the
# endpoints rather than guessing a sleep duration.
for i in $(seq 1 60); do
  curl -fsS -m 1 "http://127.0.0.1:$CDP_PORT/json/version" >/dev/null 2>&1 && break
  sleep 0.5
done
curl -fsS -m 2 "http://127.0.0.1:$CDP_PORT/json/version" >/dev/null 2>&1 || {
  echo "devtools never bound on :$CDP_PORT" >&2; exit 3; }
for i in $(seq 1 40); do
  curl -fsS -m 1 "$BASE" >/dev/null 2>&1 && break
  sleep 0.25
done
curl -fsS -m 2 "$BASE" >/dev/null 2>&1 || {
  echo "static server never answered on $BASE" >&2; exit 4; }

cd "$HERE"
FAILED=0

echo "=== purity gate ==="
# js/core/* must stay free of DOM globals so `node --test` and tools/bake.mjs can import them
# without a shim. Comment prose may mention window (storage.js explains *why* it uses
# globalThis instead), so a line whose own text starts with a comment marker is not evidence;
# code that reads `window.x` or `document.x` is.
core_hits() {
  grep -rn -E '(^|[^A-Za-z0-9_.$/\-])(window|document)\.[A-Za-z]' js/core/ \
    | sed -E 's/^([^:]+:[0-9]+)://' \
    | grep -vE '^[[:space:]]*(//|\*|/\*)' || true
}
# The gate is worthless if it cannot fire, so prove it can — on a fixture, not on the repo.
if ! printf 'const ls = window.localStorage;\n' | grep -qE '(^|[^A-Za-z0-9_.$/-])(window|document)\.[A-Za-z]'; then
  echo "  PURITY GATE IS BROKEN (its own pattern no longer matches a planted violation)"
  FAILED=1
fi
if [ -n "$(core_hits)" ]; then
  echo "  CORE TOUCHES A DOM GLOBAL (js/core/* must be pure; storage.js uses globalThis):"
  core_hits | head -5
  FAILED=1
else
  echo "  js/core/* touches no window/document"
fi

echo "=== node suites ==="
# SKIP_UNIT=1 for the browser job in CI: the suites are its own job there.
if [ -z "${SKIP_UNIT:-}" ]; then
  for f in test/*.test.mjs; do
    echo "--- $f"
    node "$f" || FAILED=1
  done
  # 部署集闸：ci.yml 跑这两步、本地整闸以前一次都不跑（59 仓同形）。「本地全绿、线上 404 自己的
  # manifest / sw.js / 图标」这一类坏法缺的就是这一步。它不碰 Chrome，所以放在 node suites 里。
  echo "=== deploy-set ==="
  node tools/deploy-set.mjs || FAILED=1
  node tools/deploy-set-selftest.mjs || FAILED=1
fi

export CDP_PORT
export BASE_URL=$BASE
node tools/playtest.mjs open "$BASE" | head -3
# js/data/lots.js is 40 measured rows and the shell resolves a route before it reports a state,
# so wait on window.leap rather than on a timer: a fixed sleep leaves the canvas at its
# unstyled 300x150 default and the @boot layout assertion then fails spuriously.
BOOT=""
for i in $(seq 1 60); do
  BOOT=$(node tools/playtest.mjs eval "window.leap?window.leap.state.id:'nope'" nonav 2>/dev/null | tr -d '\n" ')
  case "$BOOT" in *nope*|"") sleep 0.5 ;; *) break ;; esac
done
echo "boot lot: $BOOT"
[ "$BOOT" = "nope" ] && { echo "window.leap never appeared at $BASE" >&2; exit 5; }

# @reloaded has to run after @save (it reads what @save left on disk) and each scenario runs in
# its own driver process, which is what makes the "eval without nonav" reload real.
for s in ${SCENARIOS:-boot play routes save reloaded pointer}; do
  echo "=== @$s ==="
  if [ "$s" = "reloaded" ]; then
    OUT=$(node tools/playtest.mjs eval "@$s" 2>&1)
  else
    OUT=$(node tools/playtest.mjs eval "@$s" nonav 2>&1)
  fi
  printf '%s\n' "$OUT" | python3 -c '
import sys, json
raw = sys.stdin.read()
start = raw.find("{")
if start < 0:
    print("NO RESULT", raw[-300:]); sys.exit(1)
depth = 0
d = None
for i in range(start, len(raw)):
    if raw[i] == "{": depth += 1
    elif raw[i] == "}":
        depth -= 1
        if depth == 0:
            try: d = json.loads(raw[start:i + 1])
            except Exception as e:
                print("BAD JSON", e, raw[start:start+200]); sys.exit(1)
            break
if d is None:
    print("NO CLOSED BRACE", raw[-300:]); sys.exit(1)
rows = d.get("rows", [])
print("rows:", len(rows), "fail:", d.get("fail"))
for r in rows:
    if not r["pass"]: print("  FAIL", r["test"], json.dumps(r["detail"], ensure_ascii=False)[:240])
sys.exit(1 if d.get("fail") else 0)
' || FAILED=1
  # A clean console is part of the contract: a thrown page error, a refused resource or a
  # rendering warning all count, even when every assertion above happened to pass.
  if printf '%s' "$OUT" | grep -qE '\[EXCEPTION\]|\[log:error\]|\[error\]|\[warning\]'; then
    echo "  CONSOLE NOT CLEAN for @$s"
    printf '%s\n' "$OUT" | grep -E '\[EXCEPTION\]|\[log:error\]|\[error\]|\[warning\]' | head -5
    FAILED=1
  fi
  node tools/playtest.mjs shot "$SHOTS-$s.png" >/dev/null 2>&1
done

echo "=== console ==="
node tools/playtest.mjs logs
kill $WD 2>/dev/null
wait $WD 2>/dev/null
[ $FAILED -eq 0 ] && echo "=== ALL GREEN ===" || echo "=== FAILURES ABOVE ==="
exit $FAILED
