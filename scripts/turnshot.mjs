// Round 90 (phonecam): the atlas level at phone size turned by its own buttons — a screenshot at each step
// (the ↻ button tapped, the turn let settle), and a check that the ground under the screen's middle (the pick)
// stays the target's while it turns.
//   node scripts/turnshot.mjs [--url http://localhost:5283] [--steps 3] [--dir 1] [--out C:/Projects/shots88/phonecam/turn]
//     [--extra "&win=320"] [--wait 35000] [--size 412x915] [--gif path --frames 24]
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';
const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const url = opt('url', 'http://localhost:5283');
const steps = Number(opt('steps', 3));
const dir = Number(opt('dir', 1));
const out = opt('out', 'C:/Projects/shots88/phonecam/turn');
const extra = opt('extra', '');
const wait = Number(opt('wait', 35000));
const [vw, vh] = opt('size', '412x915').split('x').map(Number);
const hold = Number(opt('hold', 0));
fs.mkdirSync(path.dirname(out), { recursive: true });
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', `--window-size=${vw},${vh}`],
  defaultViewport: { width: vw, height: vh, deviceScaleFactor: 2, hasTouch: true, isMobile: true },
  protocolTimeout: 600000,
});
let bad = false;
try {
  const p = await browser.newPage();
  p.on('pageerror', (e) => {
    bad = true;
    console.log('pageerror', e.message);
  });
  p.on('console', (m) => m.type() === 'error' && console.log('console.error', m.text()));
  await p.goto(`${url}/?skipmenu=1&level=atlas&tutorial=0&q=low${extra}`, { waitUntil: 'load' });
  await p.waitForFunction(() => window.reclaimed?.stream, { timeout: 240000 });
  await new Promise((r) => setTimeout(r, wait));
  const state = () =>
    p.evaluate(() => {
      const R = window.reclaimed;
      const c = R.camera;
      const g = c.groundAt(c.viewportW / 2, c.viewportH / 2, (x, y) => R.scene.heightAt(x, y));
      return { az: +((c.azimuth * 180) / Math.PI).toFixed(1), target: c.target.map((v) => +v.toFixed(1)), mid: g.map((v) => +v.toFixed(1)), fatal: !!document.querySelector('.fatal') };
    });
  const shoot = async (k) => {
    const s = await state();
    console.log(`step ${k}`, JSON.stringify(s));
    if (s.fatal) bad = true;
    await p.screenshot({ path: `${out}-${k}.png` });
  };
  await shoot(0);
  const btn = await p.$$('.turn-ctl button');
  for (let k = 1; k <= steps; k++) {
    const b = btn[dir > 0 ? 1 : 0];
    const box = await b.boundingBox();
    await p.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
    await new Promise((r) => setTimeout(r, 2500));
    await shoot(k);
  }
  if (hold) {
    // (held: turns on until let go)
    const box = await btn[1].boundingBox();
    await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await p.mouse.down();
    await new Promise((r) => setTimeout(r, hold));
    await p.mouse.up();
    await new Promise((r) => setTimeout(r, 1500));
    await shoot('held');
  }
} finally {
  await browser.close();
}
if (bad) process.exit(1);
