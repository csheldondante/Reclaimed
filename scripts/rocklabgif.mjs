// Round 92: the rock lab's (level=rocklab) pieces cut the player's way and filmed: the break tool (or the meteor)
// picked and the screen tapped at a piece's foot, at the phone tier. Its ground truth after: floating runs (none).
//   node scripts/rocklabgif.mjs [--url http://localhost:5271] [--piece thin|wide|arm|arch|offset|pillar|banded|concrete|waist|bridge|tower]
//     [--tool smash|meteor] [--taps 3] [--gif out.gif] [--extra "&rockbody=1"] [--secs 9] [--dx 0 --dy 0 (the tap moved, cells)]
//     [--zoom 5] (round 95: the rigid rock's bodies, breaks and step time logged each second)
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
const extra = opt('extra', '');
const secs = Number(opt('secs', 9));
// (rocklab.ts: three rows of three, 22 apart round the camera's opening target; where to tap each, from its middle)
const AT = { thin: [0, 0, 2.2, 0, 4], wide: [1, 0, -2.5, 0, 4], arm: [2, 0, -3.5, 0, 29], arch: [0, 1, -6, 0, 3], offset: [1, 1, -1.8, 0, 4], pillar: [2, 1, 6, 0, 1], bridge: [0, 3, -9, 0, 7], tower: [1, 3, 3, 3, 1], banded: [0, 2, 0, 0, 3], concrete: [1, 2, 0, 0, 3], waist: [2, 2, 2.5, 0, 20] };
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
  await p.goto(`${url}/?skipmenu=1&tutorial=0&q=low&level=rocklab${extra}`, { waitUntil: 'load' });
  await p.waitForFunction(() => window.reclaimed?.integrity?.(), { timeout: 240000 });
  await sleep(12000);
  const [i, j, dx0, dy0, dz1] = AT[piece];
  // (--dz: the tap's height over the plain instead; --az degrees: the camera turned round the piece)
  const dz = Number(opt('dz', dz1));
  const az = opt('az', '');
  const dx = dx0 + Number(opt('dx', 0));
  const dy = dy0 + Number(opt('dy', 0));
  const zoom = Number(opt('zoom', 5));
  const at = await p.evaluate((i, j, dx, dy, dz, zoom, az) => {
    const R = window.reclaimed;
    const { w, h } = R.core.dims;
    const cx = w * 0.55 + 10 + (i - 1) * 22;
    const cy = h * (Math.sqrt(3) / 2) * 0.5 - 6 + (j - 1) * 22;
    R.camera.target = [cx, cy, 24];
    R.camera.zoom = zoom;
    if (az !== '') R.camera.azimuth = (Number(az) * Math.PI) / 180;
    return { x: cx + dx, y: cy + dy, z: 12 + dz };
  }, i, j, dx, dy, dz, zoom, az);
  await sleep(3000);
  // (--hideui 1: the panels hidden, so the pieces behind them show and a tap reaches them)
  if (opt('hideui', '0') === '1')
    await p.evaluate(() => {
      const cv = document.querySelector('canvas');
      for (const el of document.querySelectorAll('body *')) if (el !== cv && !el.contains(cv)) el.style.visibility = 'hidden';
    });
  const shots = [];
  const grab = async () => gif && shots.push(await p.screenshot({ type: 'png' }));
  await grab();
  await p.evaluate((t) => window.reclaimed.editor().select(t), tool);
  for (let k = 0; k < taps; k++) {
    // (--how events: the break tool's own event at the point — under an overhang the pick finds the overhang)
    if (opt('how', 'tap') === 'events') await p.evaluate((a) => window.reclaimed.core.globals.events.push({ kind: 5, x: a.x, y: a.y, z: 12 * 32, radius: a.r, strength: a.z }), { ...at, r: Number(opt('radius', 2.5)) });
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
  let lastLog = 0;
  while (Date.now() - t0 < secs * 1000) {
    await grab();
    if (Date.now() - lastLog > 1000) {
      lastLog = Date.now();
      const s = await p.evaluate(() => {
        const g = window.reclaimed.integrity().rigid;
        return g ? { n: g.list.length, drawn: g.drawn, ...g.stats, v: g.list.map((b) => [b.cells.length, b.pos.map((x) => +x.toFixed(1)), +Math.hypot(...b.v).toFixed(2), +Math.hypot(...b.w).toFixed(2)]).slice(0, 4) } : null;
      });
      if (s) console.log(`  t ${((Date.now() - t0) / 1000).toFixed(1)}s rigid ${JSON.stringify(s)}`);
    }
    await sleep(gif ? 120 : 300);
  }
  const r = await p.evaluate(async () => {
    const I = window.reclaimed.integrity();
    const s = await I.scan();
    return { floating: s.floating.length, some: s.floating.slice(0, 6), stats: { ...I.stats } };
  });
  console.log(`${piece} by ${taps} ${tool}(s): ${r.stats.bodies} piece(s) fell, ${r.stats.crumbled} cells crumbled, slowest pass ${r.stats.lastMs.toFixed(1)} ms; floating now ${r.floating}`);
  if (r.floating) {
    bad++;
    console.log('floating e.g.', JSON.stringify(r.some));
  }
  if (shots.length) {
    const enc = GIFEncoder();
    for (const s of shots) {
      const png = PNG.sync.read(Buffer.from(s));
      const pal = quantize(png.data, 256);
      enc.writeFrame(applyPalette(png.data, pal), png.width, png.height, { palette: pal, delay: 100 });
    }
    enc.finish();
    fs.writeFileSync(gif, enc.bytes());
    // (--pngs N: every Nth frame also as a PNG beside the GIF)
    const every = Number(opt('pngs', 0));
    if (every) shots.forEach((s, k) => k % every === 0 && fs.writeFileSync(gif.replace(/\.gif$/, `-${String(k).padStart(3, '0')}.png`), s));
    console.log('saved', gif, shots.length, 'frames');
  }
} finally {
  await browser.close();
}
process.exit(bad ? 1 : 0);
