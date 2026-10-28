// Round 101 (bench): the calibration benchmark (src/perf/bench.ts) run headless at the phone's shape — one tap on
// "Start benchmark", then its pages one after another till the report; the report's JSON written to --out.
// The desktop baseline: data/bench/desktop-igpu.json (node scripts/benchrun.mjs --out data/bench/desktop-igpu.json).
//   node scripts/benchrun.mjs [--url http://localhost:5291] [--size 412x915] [--dpr 2.6] [--q low] [--out bench.json]
//     [--extra "&x=1"] [--timeout 1200] [--uncapped]
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';
const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const url = opt('url', 'http://localhost:5291');
const [vw, vh] = opt('size', '412x915').split('x').map(Number);
const dpr = Number(opt('dpr', '2.6'));
const q = opt('q', 'low');
const out = opt('out', 'bench.json');
const extra = opt('extra', '');
const timeout = Number(opt('timeout', 1200)) * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  // (bench2, --uncapped: no vsync — the GPU kept busy, frames bound by it as the phone's are, so the A/B's costs show)
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-precise-memory-info', `--window-size=${vw},${vh}`].concat(argv.includes('--uncapped') ? ['--disable-gpu-vsync', '--disable-frame-rate-limit'] : []),
  defaultViewport: { width: vw, height: vh, deviceScaleFactor: dpr, hasTouch: true, isMobile: true },
  protocolTimeout: 900000,
});
let bad = 0;
try {
  const p = await browser.newPage();
  p.on('pageerror', (e) => {
    bad++;
    console.log('pageerror', e.message);
  });
  p.on('console', (m) => m.type() === 'error' && console.log('console.error', m.text().slice(0, 300)));
  // (bench v3, --smoke: the start, the hero and one window page, the end — and no Download offered before the end)
  await p.goto(`${url}/?bench=1&q=${q}${argv.includes('--smoke') ? '&benchsmoke=1' : ''}${extra}`, { waitUntil: 'load' });
  if (argv.includes('--smoke')) {
    // (a previous run stored, as on the user's phone: it must not be offered while the new one runs)
    await p.evaluate(() => localStorage.setItem('reclaimed.bench.last', JSON.stringify({ kind: 'reclaimed-bench', version: 1, startedAt: '2026-10-28T09:00:22Z', finishedAt: '2026-10-28T09:05:00Z' })));
    await p.reload({ waitUntil: 'load' });
  }
  await p.waitForFunction(() => [...document.querySelectorAll('button')].some((b) => b.textContent === 'Start benchmark'), { timeout: 120000 });
  await p.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.textContent === 'Start benchmark').click());
  const t0 = Date.now();
  let lastSay = '';
  let report = null;
  while (Date.now() - t0 < timeout) {
    await sleep(2000);
    try {
      const r = await p.evaluate(() => ({ done: !!window.reclaimedBench, say: document.querySelector('#bench-say')?.textContent ?? document.querySelector('#bench-loading')?.textContent ?? '', fatal: document.querySelector('.fatal')?.textContent ?? '', dl: [...document.querySelectorAll('button')].map((b) => b.textContent).filter((t) => /Download/.test(t)) }));
      if (!r.done && r.dl.length) {
        bad++;
        console.log(`MID-RUN DOWNLOAD OFFERED: ${r.dl.join(', ')} (${r.say})`);
      }
      if (r.fatal) throw new Error(`fatal overlay: ${r.fatal}`);
      if (r.say !== lastSay) {
        console.log(`${((Date.now() - t0) / 1000).toFixed(0)}s ${r.say}`);
        lastSay = r.say;
      }
      if (r.done) {
        report = await p.evaluate(() => window.reclaimedBench);
        break;
      }
    } catch (e) {
      if (String(e.message).startsWith('fatal')) throw e;
      // (between pages: the context is gone for a moment)
    }
  }
  if (!report) throw new Error('the benchmark never finished');
  const endButtons = await p.evaluate(() => [...document.querySelectorAll('button')].map((b) => b.textContent));
  console.log(`end screen buttons: ${endButtons.join(' | ')}`);
  if (!endButtons.includes('Download report') || endButtons.includes('Download previous run')) {
    bad++;
    console.log('END SCREEN: no Download report for this run');
  }
  report.runner = { headless: true, size: `${vw}x${vh}`, dpr, uncapped: argv.includes('--uncapped') };
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(report, null, 1));
  console.log(`wrote ${out} (${(fs.statSync(out).size / 1024).toFixed(0)} KB) in ${((Date.now() - t0) / 1000).toFixed(0)} s; errors: ${JSON.stringify(report.errors)}`);
  if (opt('shot', '')) await p.screenshot({ path: opt('shot', '') });
} finally {
  await browser.close();
}
if (bad) process.exit(1);
