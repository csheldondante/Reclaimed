// The flow lab's scenes, headless (docs/ARCHITECTURE.md "The flow model"): ?flow=1&level=flowlab. One browser session:
//   tunnel  — the stream out of the hillside (shot + gif)
//   pool    — the plug dug out, the pool pouring off the ledge as an arc (shots + gif)
//   lava    — the vent running down the ramp, off the step, setting (shot)
//   freeze  — the vent stopped; wait until every chunk is near steady and asleep, then a gif of the frozen
//             world still pouring, with the liquid passes' GPU ms awake vs frozen
//   cost    — GPU ms of the liquid passes (and the old water's with --base)
//
//   node scripts/flowlab.mjs [--url http://localhost:5223] [--scenes tunnel,pool,lava,freeze] [--out flowlab]
//        [--extra "&q=low"] [--base]   (--base: the same level without ?flow=1, the old water's cost)
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
const has = (k) => argv.includes(`--${k}`);
const url = opt('url', 'http://localhost:5223');
const out = opt('out', 'flowlab');
const scenes = opt('scenes', 'tunnel,pool,lava,freeze').split(',');
const base = has('base');
const [W, H] = opt('size', '1000x700').split('x').map(Number);

const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', `--window-size=${W},${H}`],
  defaultViewport: { width: W, height: H, deviceScaleFactor: 1 },
  protocolTimeout: 10 * 60 * 1000,
});
let failed = false;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  const p = await browser.newPage();
  p.on('console', (m) => {
    const t = m.text();
    if (m.type() === 'error' || m.type() === 'warning' || t.includes('flow')) console.log(`[console.${m.type()}] ${t.slice(0, 600)}`);
  });
  p.on('pageerror', (e) => {
    failed = true;
    console.log(`[pageerror] ${e.message}`);
  });
  await p.goto(`${url}/?skipmenu=1&level=flowlab&tutorial=0&perf=1${base ? '' : '&flow=1'}${opt('extra', '')}`, { waitUntil: 'load' });
  await p.waitForFunction(() => window.reclaimed?.core, { timeout: 240000 });
  const fatal = await p.$eval('.fatal', (e) => e.textContent).catch(() => null);
  if (fatal) {
    failed = true;
    console.log(`[fatal] ${fatal}`);
  }
  const look = (x, y, z, zoom, az) =>
    p.evaluate(
      (x, y, z, zoom, az) => {
        const c = window.reclaimed.camera;
        c.target = [x, y, z];
        c.zoom = zoom;
        if (az !== undefined) c.azimuth = az;
      },
      x,
      y,
      z,
      zoom,
      az,
    );
  const shot = async (name) => {
    await p.screenshot({ path: `${out}-${name}.png` });
    console.log(`saved ${out}-${name}.png`);
  };
  const gif = async (name, frames = 24, every = 80) => {
    const enc = GIFEncoder();
    for (let i = 0; i < frames; i++) {
      const png = PNG.sync.read(Buffer.from(await p.screenshot({ type: 'png' })));
      const pal = quantize(png.data, 256);
      enc.writeFrame(applyPalette(png.data, pal), png.width, png.height, { palette: pal, delay: every });
      await sleep(every);
    }
    enc.finish();
    fs.writeFileSync(`${out}-${name}.gif`, enc.bytes());
    console.log(`saved ${out}-${name}.gif`);
  };
  const state = () =>
    p.evaluate(async () => {
      const r = window.reclaimed;
      const f = r.flow;
      if (!f) return { base: true };
      const w = await f.water.probe(150, 125);
      const l = await f.lava.probe(34, 205);
      const un = [];
      for (let k = 0; k < f.steady.net.length; k++) if (f.sleep.isAwake(k, performance.now() / 1000)) un.push([k, +f.steady.net[k].toExponential(1), +f.steady.thr[k].toExponential(1)]);
      return { chunks: un.slice(0, 24), awake: f.sleep.awake, steady: f.steady.last, water: { enclosed: w.enclosed, vol: +w.enclosedVol.toFixed(2), drawn: w.drawn, tunnelMouth: w.col }, lava: { drawn: l.drawn, vent: l.col && l.col[0] }, ran: f.water.ran };
    });
  // GPU ms a frame of each pass named like `pre`, over `frames` frames
  const cost = (frames = 120) =>
    p.evaluate(async (frames) => {
      const prof = window.reclaimed.core.host.profiler;
      const raf = () => new Promise((res) => requestAnimationFrame(res));
      prof.resetTotals();
      for (let f = 0; f < frames; f++) await raf();
      const n = Math.max(prof.framesResolved, 1);
      const o = {};
      for (const [k, v] of prof.totalMs) if (k.startsWith('liquid') || k.startsWith('water') || k.startsWith('sediment') || k.startsWith('particles') || k === 'draw') o[k] = +(v / n).toFixed(3);
      o.gpuFrame = +(prof.gpuTotalMs / n).toFixed(2);
      o.frames = n;
      return o;
    }, frames);

  console.log('[state] ' + JSON.stringify(await state()));
  if (scenes.includes('cost')) console.log('[cost] ' + JSON.stringify(await cost()));
  if (scenes.includes('tunnel')) {
    await look(152, 108, 12, 9);
    await sleep(1500);
    await shot('tunnel');
    await gif('tunnel', 16);
  }
  if (scenes.includes('pool')) {
    await look(66, 48, 18, 8);
    await sleep(800);
    await shot('pool-before');
    await p.evaluate(() => window.reclaimed.flow.breach(1.5));
    await sleep(2500);
    await shot('pool-2s');
    await gif('pool', 20);
    await sleep(4000);
    await shot('pool-8s');
    // (from the side: the arc's parabola across the view)
    await look(74, 48, 16, 9, Math.PI / 2);
    await sleep(600);
    await shot('pool-side');
    await look(66, 48, 18, 8, Math.PI / 4);
    console.log('[state] ' + JSON.stringify(await state()));
  }
  if (scenes.includes('lava')) {
    await look(50, 178, 22, 7);
    await sleep(1000);
    await shot('lava');
    await gif('lava', 12, 120);
  }
  if (scenes.includes('freeze')) {
    await p.evaluate(() => (window.reclaimed.flow.lava.springs.length = 0));
    const awakeCost = await cost();
    console.log('[cost awake] ' + JSON.stringify(awakeCost));
    let s;
    for (let k = 0; k < 90; k++) {
      await sleep(2000);
      s = await state();
      if (k % 5 === 0) console.log(`[wait ${k * 2}s] awake ${s.awake} ` + JSON.stringify(s.steady));
      if (s.awake === 0) break;
    }
    console.log('[state frozen] ' + JSON.stringify(s));
    console.log('[cost frozen] ' + JSON.stringify(await cost()));
    await look(66, 48, 18, 8);
    await sleep(500);
    await shot('frozen-pool');
    await gif('frozen-pool', 24);
    await look(152, 108, 12, 9);
    await sleep(500);
    await gif('frozen-tunnel', 16);
  }
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
