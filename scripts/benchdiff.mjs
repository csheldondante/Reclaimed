// Round 101 (bench): two benchmark reports side by side (src/perf/bench.ts JSON, version 1) — each measure's value
// in both and their ratio (B / A: how many times slower B is where it's a time, faster where it's a rate).
// A measure with p50/p95 is compared on both; plain numbers as they are. Counts and settings are left out.
//   node scripts/benchdiff.mjs data/bench/desktop-igpu.json phone.json [--all] [--grep regionStages] [--min 1.5]
import fs from 'node:fs';
const argv = process.argv.slice(2);
const files = argv.filter((a, i) => !a.startsWith('--') && !['--grep', '--min'].includes(argv[i - 1]));
if (files.length < 2) {
  console.log('usage: node scripts/benchdiff.mjs A.json B.json [--grep text] [--min ratio] [--all]');
  process.exit(2);
}
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const grep = opt('grep', '');
const min = Number(opt('min', 0));
const all = argv.includes('--all');
const [A, B] = files.slice(0, 2).map((f) => JSON.parse(fs.readFileSync(f, 'utf8')));
for (const [f, r] of [[files[0], A], [files[1], B]]) if (r.kind !== 'reclaimed-bench') throw new Error(`${f}: not a benchmark report`);
if (A.version !== B.version) console.log(`(versions differ: ${A.version} vs ${B.version})`);
// the leaves worth comparing: times, rates, sizes — not counts of samples or the device's settings
const SKIP = /(^|\.)(n|min|mean|tilesPerFrame|regions|bytes|unit|note|rule|how|what|frames\.n|window|region|zoom|target|rings|coveragePct|viewportCss|footprintCells|canvas|device|errors|url|id|at|startedAt|finishedAt|simTicks|stream|hitch|cpuSteps|baseUnits|tier|to)$/;
const flat = (o, pre = '', out = new Map()) => {
  if (o === null || typeof o !== 'object') return out;
  if (typeof o.p50 === 'number' && typeof o.unit === 'string') {
    out.set(`${pre}.p50`, [o.p50, o.unit]);
    out.set(`${pre}.p95`, [o.p95, o.unit]);
    out.set(`${pre}.max`, [o.max, o.unit]);
    return out;
  }
  for (const [k, v] of Object.entries(o)) {
    const p = pre ? `${pre}.${k}` : k;
    if (!all && SKIP.test(k)) continue;
    if (typeof v === 'number') out.set(p, [v, '']);
    else if (v && typeof v === 'object' && !Array.isArray(v)) flat(v, p, out);
  }
  return out;
};
const fa = flat(A);
const fb = flat(B);
const name = (r) => `${r.device?.adapter?.vendor ?? '?'} ${r.device?.adapter?.architecture ?? ''}`.trim();
console.log(`A: ${files[0]}  (${name(A)}, ${A.startedAt})`);
console.log(`B: ${files[1]}  (${name(B)}, ${B.startedAt})`);
console.log(`${'measure'.padEnd(70)} ${'A'.padStart(10)} ${'B'.padStart(10)} ${'B/A'.padStart(7)}  unit`);
let shown = 0;
for (const [k, [a, unit]] of fa) {
  if (!fb.has(k)) continue;
  if (grep && !k.includes(grep)) continue;
  const b = fb.get(k)[0];
  const ratio = a !== 0 ? b / a : null;
  if (min && (ratio === null || Math.max(ratio, 1 / ratio) < min)) continue;
  const fmt = (v) => (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 1 ? v.toFixed(2) : v.toFixed(3));
  console.log(`${k.padEnd(70)} ${fmt(a).padStart(10)} ${fmt(b).padStart(10)} ${(ratio === null ? '–' : ratio.toFixed(2)).padStart(7)}  ${unit}`);
  shown++;
}
console.log(`${shown} measures in both`);
