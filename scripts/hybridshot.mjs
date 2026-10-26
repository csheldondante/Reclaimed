// The hybrid renderer (?hybrid=1): load the atlas level, wait for the window, then for each step run its js and
// save a screenshot; prints the hybrid's chunk counts. Steps are given as --step "name|js|waitMs" (repeatable).
//   node scripts/hybridshot.mjs [--url http://localhost:5235] [--q low] [--at x,y] [--size 412x915] [--extra "&x=1"]
//     [--out dir] --step "cliff|reclaimed.camera.zoom=3|3000" …
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const steps = argv.flatMap((a, i) => (a === '--step' ? [argv[i + 1]] : []));
const url = opt('url', 'http://localhost:5235');
const q = opt('q', 'low');
const at = opt('at', '12304,5457');
const out = opt('out', '.');
const extra = opt('extra', '&hybrid=1');
const perf = opt('perf', '0');
const [vw, vh] = opt('size', '412x915').split('x').map(Number);
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', `--window-size=${vw},${vh}`],
  defaultViewport: { width: vw, height: vh, deviceScaleFactor: 1 },
  protocolTimeout: 600000,
});
let failed = false;
try {
  const p = await browser.newPage();
  p.on('pageerror', (e) => {
    failed = true;
    console.log('pageerror', e.message);
  });
  p.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warn') console.log(`[${m.type()}] ${m.text().slice(0, 300)}`);
  });
  await p.goto(`${url}/?skipmenu=1&level=atlas&tutorial=0&q=${q}&perf=${perf}&at=${at}${extra}`, { waitUntil: 'load' });
  await p.waitForFunction(() => window.reclaimed?.stream, { timeout: 240000 });
  await new Promise((r) => setTimeout(r, 6000));
  for (const s of steps) {
    const [name, js, wait] = s.split('|');
    // (js: inline, or @file)
    if (js) await p.evaluate(js.startsWith('@') ? fs.readFileSync(js.slice(1), 'utf8') : js);
    await new Promise((r) => setTimeout(r, Number(wait ?? 3000)));
    const fatal = await p.$eval('.fatal', (e) => e.textContent).catch(() => null);
    if (fatal) {
      console.log('FATAL', fatal.slice(0, 800));
      failed = true;
      break;
    }
    const info = await p.evaluate(() => {
      const R = window.reclaimed;
      return { hybrid: R.scene.hybrid?.stats ?? null, drawn: R.core.renderer.fieldMesh.drawn, target: R.camera.target.map((v) => +v.toFixed(1)), zoom: +R.camera.zoom.toFixed(2) };
    });
    console.log(name, JSON.stringify(info));
    await p.screenshot({ path: `${out}/${name}.png` });
  }
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
