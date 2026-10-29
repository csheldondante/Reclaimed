// (riverfalls, BACKLOG WF1) The held rivers' falls in the atlas, before and after.
//   node scripts/riverfalls.mjs --find [--min 8] [--top 12]      the atlas's falls: river nodes whose level drops by
//                                                                --min or more to the next, by discharge (prints at=)
//   node scripts/riverfalls.mjs --at x,y [--out dir/name] [--modes after,before] [--wait 35000] [--size 1000x700]
//        [--gif 1] [--frames 30] [--every 100] [--extra "&q=low"]
// At a spot: the page as deployed (every system on, 1x), the falls listed (zoomed out: render/riverfalls.ts probe),
// the biggest lip's fall picked, then an iso shot over it, two free-camera shots from beside it and a GIF; "before"
// is the same page with ?falls=0.
import puppeteer from 'puppeteer-core';
import gifenc from 'gifenc';
import { PNG } from 'pngjs';
import fs from 'node:fs';
import path from 'node:path';
const { GIFEncoder, quantize, applyPalette } = gifenc;

const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const url = opt('url', 'http://localhost:5321');
const out = opt('out', 'C:/Projects/shots88/riverfalls/fall');
const wait = Number(opt('wait', 35000));
const extra = opt('extra', '');
const [vw, vh] = opt('size', '1000x700').split('x').map(Number);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(path.dirname(out), { recursive: true });

const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', `--window-size=${vw},${vh}`],
  defaultViewport: { width: vw, height: vh, deviceScaleFactor: 1 },
  protocolTimeout: 15 * 60 * 1000,
});
let bad = false;
const open = async (q) => {
  const p = await browser.newPage();
  p.on('pageerror', (e) => {
    bad = true;
    console.log('pageerror:', e.message);
  });
  p.on('console', (m) => m.type() === 'error' && console.log('console.error', m.text().slice(0, 300)));
  await p.goto(`${url}/?skipmenu=1&level=atlas&tutorial=0&tod=0.35&world=rf-${Date.now().toString(36)}&${q}${extra}`, { waitUntil: 'load' });
  await p.waitForFunction(() => window.reclaimed?.stream, { timeout: 240000 });
  return p;
};
try {
  if (argv.includes('--find')) {
    const p = await open('');
    const res = await p.evaluate(
      (min, top) => {
        const A = window.reclaimed.atlas;
        const u = A.riverNodes;
        const f = new Float32Array(u.buffer, u.byteOffset, u.length);
        const n = u.length / 8;
        const falls = [];
        for (let k = 0; k < n; k++) {
          const o = k * 8;
          const next = u[o + 4];
          if (u[o + 5] & 1 || next === k || next >= n) continue;
          const fall = f[o + 2] - f[next * 8 + 2];
          if (fall < min) continue;
          // (the discharge's proxy: the node's speed x its width x its depth, at the reference wetness)
          const q = f[o + 7] * f[o + 3] * f[o + 6];
          falls.push({ at: [Math.round(f[o]), Math.round(f[o + 1] / 0.8660254)], fall: +fall.toFixed(1), q: +q.toFixed(2), w: +f[o + 3].toFixed(1), v: +f[o + 7].toFixed(2) });
        }
        falls.sort((a, b) => b.q * Math.min(b.fall, 30) - a.q * Math.min(a.fall, 30));
        return { nodes: n, falls: falls.length, top: falls.slice(0, top) };
      },
      Number(opt('min', 8)),
      Number(opt('top', 12)),
    );
    console.log(JSON.stringify(res, null, 1));
  } else {
    const at = opt('at', '');
    if (!at) throw new Error('--at x,y (or --find)');
    let spot = null;
    for (const mode of opt('modes', 'after,before').split(',')) {
      const p = await open(`at=${at}${mode === 'before' ? '&falls=0' : ''}`);
      await sleep(wait);
      await p.evaluate(() => {
        const R = window.reclaimed;
        R.stream.auto = false;
        document.getElementById('ui').style.visibility = 'hidden';
      });
      if (!spot) {
        // the falls on screen with the whole window in view: the lip with the most water falling furthest, and the lips
        // round it (one fall's columns)
        spot = await p.evaluate(async () => {
          const R = window.reclaimed;
          const z0 = R.camera.zoom;
          R.camera.zoom = 1.2;
          await new Promise((r) => setTimeout(r, 800));
          const all = await R.falls.probe();
          R.camera.zoom = z0;
          if (!all.length) return null;
          const score = (f) => f.rate * Math.min(f.tEnd, 2.5);
          all.sort((a, b) => score(b) - score(a));
          const b = all[0];
          const near = all.filter((f) => Math.hypot(f.e[0] - b.e[0], f.e[1] - b.e[1]) < 8);
          const m = (k, i) => near.reduce((s, f) => s + f[k][i], 0) / near.length;
          const e = [m('e', 0), m('e', 1), m('e', 2)];
          const u = [m('u', 0), m('u', 1)];
          const tEnd = near.reduce((s, f) => s + f.tEnd, 0) / near.length;
          const foot = [e[0] + u[0] * tEnd, e[1] + u[1] * tEnd, e[2] - 0.5 * 9.8 * tEnd * tEnd];
          const r3 = (v) => +v.toFixed(2);
          return { listed: all.length, lips: near.length, e: e.map(r3), u: u.map(r3), tEnd: r3(tEnd), foot: foot.map(r3), rate: r3(near.reduce((s, f) => s + f.rate, 0)), stats: { tEnd: all.map((f) => f.tEnd).sort((a, c) => a - c).map(r3), speed: all.map((f) => Math.hypot(...f.u)).sort((a, c) => a - c).map(r3) } };
        });
        console.log('spot', JSON.stringify(spot));
        if (!spot) throw new Error(`no falls listed at ${at}`);
      }
      const tag = `${out}-${mode}`;
      // the iso view over the fall's middle
      await p.evaluate((s) => {
        const R = window.reclaimed;
        R.camera.target = [(s.e[0] + s.foot[0]) / 2, (s.e[1] + s.foot[1]) / 2, s.foot[2]];
        R.camera.zoom = Number(new URLSearchParams(location.search).get('fz') ?? 6);
      }, spot);
      await sleep(2500);
      await p.screenshot({ path: `${tag}-iso.png` });
      // wide: the window and the tiles past it (what a tile shows at a lip)
      await p.evaluate(() => (window.reclaimed.camera.zoom = 1.6));
      await sleep(4000);
      await p.screenshot({ path: `${tag}-wide.png` });
      // the free camera beside it, level with its middle, looking at it (both sides)
      const fly = async (side, back) =>
        p.evaluate(
          async (s, side, back) => {
            const R = window.reclaimed;
            if (!R.camera.fly) R.toggleFly();
            const cx = (s.e[0] + s.foot[0]) / 2;
            const cy = (s.e[1] + s.foot[1]) / 2;
            const mid = (s.e[2] + s.foot[2]) / 2;
            const ul = Math.hypot(s.u[0], s.u[1]) || 1;
            const ax = s.u[0] / ul;
            const ay = s.u[1] / ul;
            const d = Math.max(18, (s.e[2] - s.foot[2]) * 1.4);
            // across the fall, a little in front of it
            const px = -ay * side;
            const py = ax * side;
            R.camera.fly.pos = [cx + (px * 0.8 + ax * back) * d, cy + (py * 0.8 + ay * back) * d, mid + d * 0.25];
            R.camera.fly.yaw = Math.atan2(cy - R.camera.fly.pos[1], cx - R.camera.fly.pos[0]);
            R.camera.fly.pitch = Math.atan2(mid - R.camera.fly.pos[2], Math.hypot(cx - R.camera.fly.pos[0], cy - R.camera.fly.pos[1]));
            await new Promise((r) => setTimeout(r, 2000));
          },
          spot,
          side,
          back,
        );
      await fly(1, 0.6);
      await p.screenshot({ path: `${tag}-fly1.png` });
      await fly(-1, 0.6);
      await p.screenshot({ path: `${tag}-fly2.png` });
      if (opt('gif', '1') === '1') {
        await fly(1, 0.6);
        const enc = GIFEncoder();
        const frames = Number(opt('frames', 30));
        const every = Number(opt('every', 100));
        for (let i = 0; i < frames; i++) {
          const t0 = Date.now();
          const png = PNG.sync.read(Buffer.from(await p.screenshot({ type: 'png', clip: { x: vw * 0.15, y: vh * 0.1, width: vw * 0.7, height: vh * 0.8 } })));
          const pal = quantize(png.data, 256);
          enc.writeFrame(applyPalette(png.data, pal), png.width, png.height, { palette: pal, delay: every });
          await sleep(Math.max(0, every - (Date.now() - t0)));
        }
        enc.finish();
        fs.writeFileSync(`${tag}.gif`, enc.bytes());
      }
      console.log(`${mode}: ${tag}-iso.png, -fly1.png, -fly2.png${opt('gif', '1') === '1' ? ', .gif' : ''}`);
      await p.close();
    }
  }
} finally {
  await browser.close();
}
if (bad) process.exit(1);
