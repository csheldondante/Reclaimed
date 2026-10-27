// Round 92: the rock lab's (level=rocklab) pieces cut the player's way and filmed: the break tool (or the meteor)
// picked and the screen tapped at a piece's foot, at the phone tier. Its ground truth after: floating runs (none).
//   node scripts/rocklabgif.mjs [--url http://localhost:5271] [--piece thin|wide|arm|arch|offset|pillar|banded|concrete|waist]
//     [--tool smash|meteor] [--taps 3] [--gif out.gif]
import puppeteer from 'puppeteer-core';
import gifenc from 'gifenc';
import { PNG } from 'pngjs';
import fs from 'node:fs';
const { GIFEncoder, quantize, applyPalette } = gifenc;
const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const url = opt('url', 'http://localhost:5271');
const piece = opt('piece', 'thin');
const tool = opt('tool', 'smash');
const taps = Number(opt('taps', 3));
const gif = opt('gif', '');
// (rocklab.ts: three rows of three, 22 apart round the camera's opening target; where to tap each, from its middle)
const AT = { thin: [0, 0, 2.2, 0, 4], wide: [1, 0, -2.5, 0, 4], arm: [2, 0, -3.5, 0, 29], arch: [0, 1, -6, 0, 3], offset: [1, 1, -1.8, 0, 4], pillar: [2, 1, 6, 0, 1], banded: [0, 2, 0, 0, 3], concrete: [1, 2, 0, 0, 3], waist: [2, 2, 2.5, 0, 20] };
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--window-size=412,915'],
  defaultViewport: { width: 412, height: 915, deviceScaleFactor: 1 },
  protocolTimeout: 600000,
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let bad = 0;
try {
  const p = await browser.newPage();
  p.on('pageerror', (e) => {
    bad++;
    console.log('pageerror', e.message);
  });
  await p.goto(`${url}/?skipmenu=1&tutorial=0&q=low&level=rocklab`, { waitUntil: 'load' });
  await p.waitForFunction(() => window.reclaimed?.integrity?.(), { timeout: 240000 });
  await sleep(12000);
  const [i, j, dx, dy, dz] = AT[piece];
  const at = await p.evaluate((i, j, dx, dy, dz) => {
    const R = window.reclaimed;
    const { w, h } = R.core.dims;
    const cx = w * 0.55 + 10 + (i - 1) * 22;
    const cy = h * (Math.sqrt(3) / 2) * 0.5 - 6 + (j - 1) * 22;
    R.camera.target = [cx, cy, 24];
    R.camera.zoom = 5;
    return { x: cx + dx, y: cy + dy, z: 12 + dz };
  }, i, j, dx, dy, dz);
  await sleep(3000);
  const shots = [];
  const grab = async () => gif && shots.push(await p.screenshot({ type: 'png' }));
  await grab();
  await p.evaluate((t) => window.reclaimed.editor().select(t), tool);
  for (let k = 0; k < taps; k++) {
    // (--how events: the break tool's own event at the point — under an overhang the pick finds the overhang)
    if (opt('how', 'tap') === 'events') await p.evaluate((a) => window.reclaimed.core.globals.events.push({ kind: 5, x: a.x, y: a.y, z: 12 * 32, radius: 2.5, strength: a.z }), at);
    else {
      const xy = await p.evaluate((a) => window.reclaimed.camera.project(a.x, a.y, a.z), at);
      await p.mouse.click(xy[0], xy[1]);
    }
    for (let f = 0; f < 3; f++) {
      await sleep(150);
      await grab();
    }
  }
  await p.evaluate(() => window.reclaimed.editor().select('wind'));
  const t0 = Date.now();
  while (Date.now() - t0 < 9000) {
    await grab();
    await sleep(gif ? 120 : 500);
  }
  const r = await p.evaluate(async () => {
    const I = window.reclaimed.integrity();
    const s = await I.scan();
    return { floating: s.floating.length, stats: { ...I.stats } };
  });
  console.log(`${piece} by ${taps} ${tool}(s): ${r.stats.bodies} piece(s) fell, ${r.stats.crumbled} cells crumbled, slowest pass ${r.stats.lastMs.toFixed(1)} ms; floating now ${r.floating}`);
  if (r.floating) bad++;
  if (shots.length) {
    const enc = GIFEncoder();
    for (const s of shots) {
      const png = PNG.sync.read(Buffer.from(s));
      const pal = quantize(png.data, 256);
      enc.writeFrame(applyPalette(png.data, pal), png.width, png.height, { palette: pal, delay: 100 });
    }
    enc.finish();
    fs.writeFileSync(gif, enc.bytes());
    console.log('saved', gif, shots.length, 'frames');
  }
} finally {
  await browser.close();
}
process.exit(bad ? 1 : 0);
