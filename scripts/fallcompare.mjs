// Falls side by side at 1x (round 86, the user: "The waterfalls move way way too fast at 1x and visually it doesn't
// look as good as the old approach or the sand particles"): the flow lab's pool breached with the flow model
// (?flow=1), the same pool with the old water, and the sand bank's wall dug out (scene D). Each: GIFs at real
// time from the front and the side, and how long the water took from the breach to the plain under the fall.
//   node scripts/fallcompare.mjs [--url http://localhost:5247] [--modes flow,base,sand] [--out dir/prefix]
//        [--extra "&q=low"] [--frames 40] [--every 100]
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
const url = opt('url', 'http://localhost:5247');
const out = opt('out', 'fallcompare');
const modes = opt('modes', 'flow,base,sand').split(',');
const frames = Number(opt('frames', '40'));
const every = Number(opt('every', '100'));
const [W, H] = opt('size', '640x480').split('x').map(Number);
const ROW_H = Math.sqrt(3) / 2;
const cellPos = (x, y) => [x + 0.5 + 0.5 * (y & 1), (y + 0.5) * ROW_H];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', `--window-size=${W},${H}`],
  defaultViewport: { width: W, height: H, deviceScaleFactor: 1 },
  protocolTimeout: 10 * 60 * 1000,
});
let failed = false;
try {
  for (const mode of modes) {
    const p = await browser.newPage();
    p.on('console', (m) => {
      if (m.type() === 'error' || m.type() === 'warning') console.log(`[${mode} console.${m.type()}] ${m.text().slice(0, 600)}`);
    });
    p.on('pageerror', (e) => {
      failed = true;
      console.log(`[${mode} pageerror] ${e.message}`);
    });
    const flow = mode === 'flow';
    await p.goto(`${url}/?skipmenu=1&level=flowlab&tutorial=0&tod=0.4${flow ? '&flow=1' : ''}${opt('extra', '')}`, { waitUntil: 'load' });
    await p.waitForFunction(() => window.reclaimed?.core, { timeout: 240000 });
    const fatal = await p.$eval('.fatal', (e) => e.textContent).catch(() => null);
    if (fatal) {
      failed = true;
      console.log(`[${mode} fatal] ${fatal}`);
      await p.close();
      continue;
    }
    await p.evaluate(() => (document.getElementById('ui').style.visibility = 'hidden'));
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
    const gif = async (name, n = frames, ms = every) => {
      const enc = GIFEncoder();
      const t0 = Date.now();
      for (let i = 0; i < n; i++) {
        const next = t0 + i * ms;
        if (Date.now() < next) await sleep(next - Date.now());
        const png = PNG.sync.read(Buffer.from(await p.screenshot({ type: 'png' })));
        const pal = quantize(png.data, 256);
        enc.writeFrame(applyPalette(png.data, pal), png.width, png.height, { palette: pal, delay: ms });
      }
      enc.finish();
      fs.writeFileSync(`${out}-${name}.gif`, enc.bytes());
      console.log(`saved ${out}-${name}.gif (${n} frames in ${((Date.now() - t0) / 1000).toFixed(1)} s)`);
    };
    // dig out a wall: the level's dig events down its rows (as the flow lab's breach)
    const dig = (x, y0, y1, str) =>
      p.evaluate(
        (pts, str) => {
          for (const [x, y] of pts) for (let k = 0; k < 3; k++) window.reclaimed.globals.events.push({ kind: 5, x, y, z: 2 * 32 + 512, radius: 2.2, strength: str });
        },
        Array.from({ length: Math.ceil((y1 - y0) / 2) }, (_, k) => cellPos(x, y0 + 2 * k + 0.5)),
        str,
      );
    if (mode === 'sand') {
      const [sx, sy] = cellPos(208, 55);
      await look(sx + 4, sy, 20, 8, Math.PI / 4);
      await sleep(1500);
      await dig(209, 49, 61, 4);
      await gif('sand-front');
      await look(sx + 6, sy, 18, 9, Math.PI / 2);
      await gif('sand-side', 20);
      await p.close();
      continue;
    }
    // the pool (scene A): its plug at x 64..66, rows 53..57
    const [px, py] = cellPos(66, 55);
    await look(px + 2, py, 18, 8, Math.PI / 4);
    await sleep(1500);
    const tick0 = await p.evaluate(() => window.reclaimed.globals.tick);
    const t0 = Date.now();
    // (the plug dug out - three cells, its height - the same events with and without the flow model; with it the
    // lab's spring in the pool too, as flow.breach)
    await dig(65, 53, 57, 1);
    if (flow) await p.evaluate(() => window.reclaimed.flow.lab.breach(1.5));
    // (when the water reaches the plain under the fall, x 70..110 in the trench rows, 0.003 deep; polled while filming)
    const landed = p.evaluate(async () => {
      const R = window.reclaimed;
      const W = 256;
      for (let k = 0; k < 800; k++) {
        const w = await R.readBuffer('water');
        const f = new Float32Array(w.buffer);
        for (let y = 50; y < 60; y++) for (let x = 70; x < 110; x++) if (f[y * W + x] > 0.003) return { tick: R.globals.tick, x, y, at: performance.now() };
        await new Promise((r) => setTimeout(r, 25));
      }
      return null;
    });
    await gif(`${mode}-front`);
    const l = await landed;
    if (l) {
      const ms = await p.evaluate((at) => at, l.at);
      console.log(`[${mode}] the water reached the plain at (${l.x}, ${l.y}) ${l.tick - tick0} ticks after the breach (${((l.tick - tick0) / 60).toFixed(2)} s of sim time)`);
    } else console.log(`[${mode}] the water never reached the plain while filming`);
    console.log(`[${mode}] wall time filmed ${(Date.now() - t0) / 1000} s`);
    await look(px + 8, py, 16, 9, Math.PI / 2);
    await sleep(500);
    await gif(`${mode}-side`, 20);
    await p.screenshot({ path: `${out}-${mode}-side.png` });
    await p.close();
  }
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
