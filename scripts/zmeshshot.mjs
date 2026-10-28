// Round 100 (zmesh): the look at the default zoom at the phone tier, before and after — spots (cliffs, mesas, towns,
// water's edges) each loaded as the level's ?at=, a shot straight and one turned (a third of a turn), per variant
// (the URL's extra). Prints each shot's hybrid counts (voxel chunks, the grid's, the rings').
//   node scripts/zmeshshot.mjs [--url http://localhost:5285] [--size 412x915] [--wait 40000]
//     [--spots "name:x,y;name:x,y;town:town=1"] (a spot is an ?at= cell, or a query of its own) [--variants "new:;old:&zwin=248&vradius=40&readyticks=24&steep=1000"]
//     [--out C:/Projects/shots88/zmesh]
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const url = opt('url', 'http://localhost:5285');
const [vw, vh] = opt('size', '412x915').split('x').map(Number);
const wait = Number(opt('wait', 40000));
const out = opt('out', 'C:/Projects/shots88/zmesh');
const spots = opt('spots', 'start:11956,15471')
  .split(';')
  .map((s) => s.split(':'))
  .map(([n, at]) => ({ n, at }));
const variants = opt('variants', 'new:;old:&zwin=248&vradius=40&readyticks=24&steep=1000')
  .split(';')
  .map((s) => {
    const k = s.indexOf(':');
    return { n: s.slice(0, k), extra: s.slice(k + 1) };
  });
fs.mkdirSync(out, { recursive: true });
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', `--window-size=${vw},${vh}`],
  defaultViewport: { width: vw, height: vh, deviceScaleFactor: 2, hasTouch: true, isMobile: true },
  protocolTimeout: 900000,
});
let bad = false;
try {
  for (const s of spots)
    for (const v of variants) {
      const p = await browser.newPage();
      p.on('pageerror', (e) => {
        bad = true;
        console.log('pageerror', e.message);
      });
      p.on('console', (m) => m.type() === 'error' && console.log('console.error', m.text()));
      await p.goto(`${url}/?skipmenu=1&level=atlas&tutorial=0&q=low&${s.at.includes('=') ? s.at : `at=${s.at}`}${v.extra}`, { waitUntil: 'load' });
      await p.waitForFunction(() => window.reclaimed?.stream, { timeout: 240000 });
      await new Promise((r) => setTimeout(r, wait));
      const info = async () =>
        p.evaluate(() => {
          const R = window.reclaimed;
          const h = R.scene.hybrid?.stats;
          return { oz: R.stream.oz, zMax: R.core.dims.zMax, hybrid: h, drawn: R.renderer.fieldMesh.drawn, band: !!R.renderer.band, fatal: !!document.querySelector('.fatal') };
        });
      const a = await info();
      await p.screenshot({ path: `${out}/${s.n}-${v.n}.png` });
      await p.evaluate(() => (window.reclaimed.camera.azimuth += (2 * Math.PI) / 3));
      await new Promise((r) => setTimeout(r, 8000));
      const b = await info();
      await p.screenshot({ path: `${out}/${s.n}-${v.n}-turned.png` });
      if (a.fatal || b.fatal) bad = true;
      console.log(JSON.stringify({ spot: s.n, at: s.at, variant: v.n, straight: a, turned: b }));
      await p.close();
    }
} finally {
  await browser.close();
}
if (bad) process.exit(1);
