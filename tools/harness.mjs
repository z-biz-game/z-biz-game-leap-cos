// Tiny zero-dep test harness: every tools/../test/*.mjs suite prints the same shape so
// verify.sh can aggregate them.

const rows = [];
// `rows` are the named cases, `asserts` the individual checks inside them. Both are printed so
// a report can say how many numbers were actually compared rather than how many sentences were
// written, and so tools/verify.sh can aggregate the two columns across suites.
let asserts = 0;

export function test(name, fn) {
  try {
    fn();
    rows.push({ test: name, pass: true });
  } catch (err) {
    rows.push({ test: name, pass: false, detail: String((err && err.message) || err) });
  }
}

export function ok(cond, msg = 'expected truthy') {
  asserts++;
  if (!cond) throw new Error(msg);
}

export function eq(a, b, msg = 'not equal') {
  asserts++;
  const sa = JSON.stringify(a);
  const sb = JSON.stringify(b);
  if (sa !== sb) throw new Error(`${msg}\n    got      ${sa}\n    expected ${sb}`);
}

export function fail(msg) {
  asserts++;
  throw new Error(msg);
}

export function run() {
  const bad = rows.filter((r) => !r.pass);
  for (const r of rows) console.log(`${r.pass ? '  ok  ' : '  FAIL'} ${r.test}${r.pass ? '' : '\n         ' + r.detail}`);
  console.log(`rows: ${rows.length} fail: ${bad.length} asserts: ${asserts}`);
  process.exit(bad.length ? 1 : 0);
}
