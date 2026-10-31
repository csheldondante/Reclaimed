// Round 120: the physics phone bench (src/perf/physbench.ts) run headless, its report printed and saved.
//   node scripts/physbench.mjs --url http://localhost:5211 --pairs nodes:runs,hybrid:runs [--out data/perf/solver/physbench.json]
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const url = opt('url', 'http://localhost:5211');
const pairs = opt('pairs', '');
const out = opt('out', '');
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--window-size=412,915'],
  defaultViewport: { width: 412, height: 915, deviceScaleFactor: 2.6 },
  protocolTimeout: 30 * 60 * 1000,
});
let failed = false;
try {
  const p = await browser.newPage();
  p.on('pageerror', (e) => {
    failed = true;
    console.log(`FAIL pageerror ${e.message}`);
  });
  p.on('console', (m) => {
    if (m.type() === 'error' && !m.text().includes('404')) console.log(`[console.error] ${m.text().slice(0, 300)}`);
  });
  await p.goto(`${url}/?skipmenu=1&level=playground&tutorial=0&q=low&physbench=1${pairs ? `&pairs=${pairs}` : ''}`, { waitUntil: 'load' });
  const start = Date.now();
  let report = null;
  while (!report && Date.now() - start < 40 * 60 * 1000) {
    await new Promise((r) => setTimeout(r, 5000));
    report = await p.evaluate(() => window.physBenchReport ?? null).catch(() => null);
    const fatal = await p.$eval('.fatal', (e) => e.textContent).catch(() => null);
    if (fatal) throw new Error(`fatal overlay: ${fatal}`);
  }
  if (!report) throw new Error('no report in 40 min');
  const r = JSON.parse(report);
  for (const row of r.rows) console.log(`${row.pair.padEnd(16)} ${row.stage.padEnd(34)} p50 ${row.p50} p95 ${row.p95} p99 ${row.p99} GPU ${row.gpu} phys GPU ${row.gpuPhysics} CPU ${row.cpuPhysics} judge ${row.judge} awake ${row.awake} slow ${row.slow}/${row.clusters} runs`);
  if (out) fs.writeFileSync(out, JSON.stringify(r, null, 1));
} catch (e) {
  failed = true;
  console.log(`FAIL ${e.message}`);
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
