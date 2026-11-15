// The fine collision phone bench (src/perf/sdfbench.ts, sdfbench.html) run headless: its report printed and saved.
//   node scripts/sdfbench.mjs --url http://localhost:5320 [--query "formats=grad8&sides=16&pairs=256"] [--out data/perf/sdf/sdfbench-desktop.json]
// Exits non-zero on a page error, a fatal overlay or no report.
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const url = opt('url', 'http://localhost:5320');
const query = opt('query', '');
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
  await p.goto(`${url}/sdfbench.html?auto=1${query ? `&${query}` : ''}`, { waitUntil: 'load' });
  const start = Date.now();
  let report = null;
  while (!report && Date.now() - start < 20 * 60 * 1000) {
    await new Promise((r) => setTimeout(r, 2000));
    report = await p.evaluate(() => window.sdfBenchReport ?? null).catch(() => null);
    const fatal = await p.$eval('.fatal', (e) => e.textContent).catch(() => null);
    if (fatal) throw new Error(`fatal: ${fatal}`);
  }
  if (!report) throw new Error('no report in 20 min');
  const r = JSON.parse(report);
  const card = await p.$eval('#bench-panel', (e) => e.innerText).catch(() => '(no card)');
  console.log(card);
  console.log(`kind ${r.kind} v${r.version}, build ${r.build}, device ${r.device?.adapter?.vendor ?? '?'} ${r.device?.adapter?.architecture ?? ''}, wake lock ${JSON.stringify(r.wakeLock)}, errors ${JSON.stringify(r.errors)}`);
  const buttons = await p.$$eval('#bench-panel button', (b) => b.map((x) => x.textContent));
  console.log(`buttons: ${buttons.join(' | ')}`);
  if (!buttons.includes('Download report')) throw new Error('no Download report button');
  if (r.errors.length) failed = true;
  if (out) fs.writeFileSync(out, JSON.stringify(r, null, 1));
} catch (e) {
  failed = true;
  console.log(`FAIL ${e.message}`);
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
