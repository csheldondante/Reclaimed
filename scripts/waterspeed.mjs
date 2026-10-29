// Round 112 (waterscale): how fast the game's water runs, in cells (metres) a second of real time at 1x — headless,
// every system in play, the phone proxy (412 x 915, dpr 2.6, q=low, 1x). The user: "The water seems to fast for the
// scale. Is the 9.8m/s relative to real clock time or game clock time?"
//
// A column's speed is its net flow over its depth: the pipes' flux is volume a 60 Hz step in column depths (a cell's
// area 1), each pipe's face 1/√3 wide over a cell √3/2 in area — 2/3 — so netFlow (flow.wgsl: (2/NDIR) Σ net_k e_k)
// = (2/3) · dt · d · u, u = 1.5 · |netFlow| / (d · dt). A held river (asleep) is drawn by its table (riverFlow: cells a
// 60 Hz step). The drawn scroll is what render.wgsl flowStreaks moves its streaks by (DRAWN below, both models).
//   held    the playground's river asleep: its table's speeds, the pipes' seeded steady flux
//   woken   the river woken by a surge: the pipes' own speeds on the ramp, at the fall, the run out
//   breach  the breach: speeds in the notch and over the ledge, the basin's first water (s)
//   sheet   a spring on the bare ramp beside the river (10 % slope) and on the soil mound (steep): the sheet's speed,
//           its front's
//   atlas   the atlas's river table (atlas/rivers.ts: speed min, median, max)
//   ticks   sim ticks a real second (1x)
//   node scripts/waterspeed.mjs [--url http://localhost:5301] [--out C:/Projects/shots88/waterscale] [--tag before]
//     [--gifs] [--skip atlas] [--old-drawn] (the build before round 112: its drawn scroll)
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
const url = opt('url', 'http://localhost:5301');
const out = opt('out', 'C:/Projects/shots88/waterscale');
const tag = opt('tag', 'now');
const gifs = argv.includes('--gifs');
const skip = opt('skip', '').split(',');
const [W, H] = opt('size', '412x915').split('x').map(Number);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(out, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', `--window-size=${W},${H}`],
  defaultViewport: { width: W, height: H, deviceScaleFactor: 2.6 },
  protocolTimeout: 10 * 60 * 1000,
});
let failed = false;
const fail = (m) => {
  failed = true;
  console.log(`FAIL ${m}`);
};
const rows = [];
const row = (name, s) => {
  rows.push({ name, ...s });
  console.log(`[${name}] ${JSON.stringify(s)}`);
};
const gif = async (p, name, frames, every) => {
  if (!gifs) return;
  const enc = GIFEncoder();
  for (let i = 0; i < frames; i++) {
    const t = Date.now();
    const png = PNG.sync.read(Buffer.from(await p.screenshot({ type: 'png' })));
    const w2 = png.width >> 1;
    const h2 = png.height >> 1;
    const half = new Uint8Array(w2 * h2 * 4);
    for (let y = 0; y < h2; y++) for (let x = 0; x < w2; x++) for (let c = 0; c < 4; c++) half[(y * w2 + x) * 4 + c] = png.data[(2 * y * png.width + 2 * x) * 4 + c];
    const pal = quantize(half, 256);
    enc.writeFrame(applyPalette(half, pal), w2, h2, { palette: pal, delay: every });
    await sleep(Math.max(0, every - (Date.now() - t)));
  }
  enc.finish();
  fs.writeFileSync(path.join(out, `${tag}-${name}`), enc.bytes());
  console.log(`saved ${tag}-${name}`);
};

try {
  if (!skip.includes('atlas')) {
    const v = await browser.newPage();
    await v.goto(`${url}/?atlas=view`, { waitUntil: 'load' });
    await v.waitForFunction(() => window.reclaimed?.atlas?.riverStats?.nodes > 0, { timeout: 180000 });
    const st = await v.evaluate(() => window.reclaimed.atlas.riverStats);
    row('atlas table', { 'speed cells/s (min, median, max)': st.speed.map((s) => +(s * 60).toFixed(2)), discharge: st.discharge, pipeSlope: st.pipeSlope });
    await v.close();
  }
  const p = await browser.newPage();
  p.on('console', (m) => {
    if (m.type() === 'error') console.log(`[console.error] ${m.text().slice(0, 600)}`);
  });
  p.on('pageerror', (e) => fail(`pageerror ${e.message}`));
  await p.goto(`${url}/?skipmenu=1&level=playground&tutorial=0&q=low`, { waitUntil: 'load' });
  await p.waitForFunction(() => window.reclaimed?.scene?.stationsBar, { timeout: 240000 });
  await sleep(35000);
  const fatal = await p.$eval('.fatal', (e) => e.textContent).catch(() => null);
  if (fatal) throw new Error(`fatal overlay: ${fatal}`);
  await p.evaluate(() => window.reclaimed.scene.tunePanel?.toggle(false));
  // the speed sampler, in the page
  await p.evaluate(() => {
    const ROW_H = Math.sqrt(3) / 2;
    const DIRV = [[1, 0], [-1, 0], [0.5, ROW_H], [-0.5, -ROW_H], [-0.5, ROW_H], [0.5, -ROW_H]];
    const DE = [[1, 0], [-1, 0], [0, 1], [-1, -1], [-1, 1], [0, -1]];
    const DO = [[1, 0], [-1, 0], [1, 1], [0, -1], [0, 1], [1, -1]];
    const q = (a, x) => (a.length ? +a[Math.min(a.length - 1, Math.floor(x * a.length))].toFixed(2) : 0);
    /** speeds over a rect of columns [x0, y0, x1, y1] (storage), wetter than dMin */
    window.__speeds = async (rect, dMin = 0.02, held = false) => {
      const R = window.reclaimed;
      const { w, h } = R.core.dims;
      const [water, flux] = await Promise.all([R.readBuffer('water'), R.readBuffer('flux')]);
      const rf = R.map.riverFlow;
      const tune = R.core.globals.tune ?? {};
      const drawnOf = window.__drawn;
      const us = [];
      const ds = [];
      const tab = [];
      const dr = [];
      let wet = 0;
      for (let y = rect[1]; y < rect[3]; y++)
        for (let x = rect[0]; x < rect[2]; x++) {
          const i = y * w + x;
          const d = water[i];
          if (!(d > dMin)) continue;
          wet++;
          let vx = 0;
          let vy = 0;
          for (let k = 0; k < 6; k++) {
            const o = (y & 1) === 0 ? DE[k] : DO[k];
            const nx = x + o[0];
            const ny = y + o[1];
            let net = flux[i * 6 + k];
            if (nx >= 0 && ny >= 0 && nx < w && ny < h) net -= flux[(ny * w + nx) * 6 + (k ^ 1)];
            vx += net * DIRV[k][0];
            vy += net * DIRV[k][1];
          }
          const nf = Math.hypot(vx, vy) / 3;
          const u = (1.5 * nf * 60) / d;
          us.push(u);
          ds.push(d);
          const tv = rf ? Math.hypot(rf[i * 4], rf[i * 4 + 1]) : 0;
          if (rf && rf[i * 4 + 2] > 0) tab.push(tv * 60);
          // (what's drawn: a held river by its table, else the pipes' net flow — renderfields.wgsl)
          const fv = held && rf && rf[i * 4 + 2] > 0 ? window.__heldFv(tv, d) : nf;
          dr.push(drawnOf(fv, d, tune));
        }
      for (const a of [us, ds, tab, dr]) a.sort((a, b) => a - b);
      return { wet, u50: q(us, 0.5), u90: q(us, 0.9), umax: q(us, 1), d50: q(ds, 0.5), table50: q(tab, 0.5), tableMax: q(tab, 1), drawn50: q(dr, 0.5), drawn90: q(dr, 0.9), drawnMax: q(dr, 1) };
    };
    /** the farthest wet column from (cx, cy) in the rect (cells) */
    window.__front = async (rect, cx, cy, dMin = 0.02) => {
      const R = window.reclaimed;
      const { w } = R.core.dims;
      const water = await R.readBuffer('water');
      let far = 0;
      for (let y = rect[1]; y < rect[3]; y++)
        for (let x = rect[0]; x < rect[2]; x++) if (water[y * w + x] > dMin) far = Math.max(far, Math.hypot(x + 0.5 * (y & 1) - cx - 0.5 * (cy & 1), (y - cy) * ROW_H));
      return far;
    };
    window.__tick = () => window.reclaimed.core.globals.tick;
    /** the ground's tops over a rect (common.wgsl sfZ: z × 256 in the low 17 bits) */
    window.__ground = async (rect) => {
      const R = window.reclaimed;
      const { w } = R.core.dims;
      const s = new Uint32Array((await R.readBuffer('surface')).buffer);
      const o = [];
      for (let y = rect[1]; y < rect[3]; y++) for (let x = rect[0]; x < rect[2]; x++) o.push((s[y * w + x] & 0x1ffff) / 256);
      return o;
    };
    window.__moved = (a, b) => +a.reduce((t, v, i) => t + Math.abs(v - b[i]), 0).toFixed(2);
    /** (round 112) what the water did to the ground: cells³ cut down and laid up (a change over 0.01) */
    window.__erosion = (a, b) => {
      let cut = 0;
      let laid = 0;
      let cols = 0;
      a.forEach((v, i) => {
        const dz = b[i] - v;
        if (Math.abs(dz) > 0.01) cols++;
        if (dz < 0) cut -= dz;
        else laid += dz;
      });
      return { cut: +cut.toFixed(2), laid: +laid.toFixed(2), cols };
    };
  });
  // the drawn scroll (cells/s), mirrored from render.wgsl flowStreaks and renderfields.wgsl (the held river's fv)
  await p.evaluate(() => {
    // (before round 112: pace = min(|fv| / max(d, 0.06) · 6, 5) cells a cycle of 2 s; a held river's fv = vel · d)
    window.__heldFv = (tv, d) => tv * d;
    window.__drawn = (fv, d) => Math.min((fv / Math.max(d, 0.06)) * 6, 5) / 2;
  });
  if (!argv.includes('--old-drawn')) {
    // (round 112: the mapping as it is now — kept beside this script, mirrored from render.wgsl)
    const src = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname.slice(1)), 'waterspeed-drawn.js'), 'utf8');
    await p.evaluate(src);
  }
  const pick = (id) => p.evaluate((i) => window.reclaimed.scene.stationsBar.pick(window.reclaimed.scene.level.stations.findIndex((s) => s.id === i)), id);
  const click = (label) =>
    p.evaluate((label) => {
      const b = [...document.querySelectorAll('.stations button')].find((x) => x.textContent === label);
      if (!b) throw new Error(`no button ${label}`);
      b.click();
    }, label);
  const hideUi = (h) => p.evaluate((h) => document.getElementById('ui') && (document.getElementById('ui').style.visibility = h ? 'hidden' : 'visible'), h);
  // ticks a real second
  {
    const t0 = await p.evaluate(() => [window.__tick(), performance.now()]);
    await sleep(5000);
    const t1 = await p.evaluate(() => [window.__tick(), performance.now()]);
    row('ticks', { 'ticks/s': +((t1[0] - t0[0]) / ((t1[1] - t0[1]) / 1000)).toFixed(1) });
  }
  // the river: asleep (held)
  const RAMP = [120, 118, 190, 156];
  const FALL = [192, 118, 202, 156];
  const RUN = [204, 118, 254, 156];
  await pick('river');
  await sleep(15000);
  const awake = await p.evaluate(() => window.reclaimed.scene.sleep?.awake ?? -1);
  row('held ramp (asleep)', { awake, ...(await p.evaluate((r) => window.__speeds(r, 0.05, true), RAMP)) });
  row('held fall (asleep)', await p.evaluate((r) => window.__speeds(r, 0.05, true), FALL));
  row('held run out (asleep)', await p.evaluate((r) => window.__speeds(r, 0.05, true), RUN));
  await hideUi(true);
  await p.evaluate(() => {
    const R = window.reclaimed;
    R.camera.target = [160, 136 * 0.8660254, 18];
    R.camera.zoom = 6;
  });
  await sleep(2000);
  await gif(p, 'river-held.gif', 16, 250);
  await hideUi(false);
  // woken by a surge
  await click('surge');
  await sleep(6000);
  row('woken ramp (surge)', await p.evaluate((r) => window.__speeds(r, 0.05), RAMP));
  row('woken fall (surge)', await p.evaluate((r) => window.__speeds(r, 0.05), FALL));
  row('woken run out (surge)', await p.evaluate((r) => window.__speeds(r, 0.05), RUN));
  await hideUi(true);
  await gif(p, 'river-surge.gif', 20, 300);
  await hideUi(false);
  // a sheet on the bare ramp beside the river, and on the soil mound
  const sheet = async (name, cols, rect, rate, look) => {
    await p.evaluate(
      ({ cols, rate, look }) => {
        const R = window.reclaimed;
        R.scene.stationKit().source(cols, rate);
        R.camera.target = look;
        R.camera.zoom = 6;
      },
      { cols, rate, look },
    );
    const [cx, cy] = cols[0];
    const g0 = await p.evaluate((r) => window.__ground(r), rect);
    const fr = [];
    const t0 = Date.now();
    for (let k = 0; k < 6; k++) {
      await sleep(2000);
      fr.push([+((Date.now() - t0) / 1000).toFixed(1), +(await p.evaluate(({ rect, cx, cy }) => window.__front(rect, cx, cy, 0.005), { rect, cx, cy })).toFixed(1)]);
    }
    const s = await p.evaluate((r) => window.__speeds(r, 0.005), rect);
    const dFront = fr[fr.length - 1][1] - fr[0][1];
    const moved = await p.evaluate(async ({ rect, g0 }) => window.__moved(g0, await window.__ground(rect)), { rect, g0 });
    row(name, { ...s, front: fr, 'front cells/s': +(dFront / (fr[fr.length - 1][0] - fr[0][0])).toFixed(2), 'ground moved (cells³)': moved });
    await p.evaluate((cols) => window.reclaimed.scene.stationKit().source(cols, 0), cols);
  };
  await sheet('sheet ramp 10%', [[128, 100], [128, 101], [129, 100]], [118, 96, 196, 118], 6, [140, 104 * 0.8660254, 18]);
  await hideUi(true);
  await gif(p, 'sheet-ramp.gif', 16, 300);
  await hideUi(false);
  await sheet('sheet mound (steep)', [[212, 64], [212, 65], [213, 64]], [196, 50, 230, 80], 6, [212, 64 * 0.8660254, 16]);
  // the breach
  await pick('breach');
  await click('↺ reset');
  await sleep(4000);
  // (round 112: the ground under the ledge only — the basin and the run below the lip, x 57 on: none of the dug
  // cells, the plug and the notch, x 52..55)
  const BG = [57, 116, 92, 172];
  const bg0 = await p.evaluate((r) => window.__ground(r), BG);
  await click('breach');
  const tb = Date.now();
  await hideUi(true);
  let basinAt = null;
  const NOTCH = [40, 138, 57, 150];
  const LEDGE = [55, 130, 70, 160];
  const BASIN = [56, 116, 92, 172];
  const samples = [];
  for (let k = 0; k < 10; k++) {
    await sleep(1000);
    const b = await p.evaluate(() => window.reclaimed.probe('water', 74, 144, 10));
    if (basinAt === null && b > 0.05) basinAt = +((Date.now() - tb) / 1000).toFixed(1);
    if (k === 3) samples.push(['notch', await p.evaluate((r) => window.__speeds(r, 0.05), NOTCH)], ['ledge', await p.evaluate((r) => window.__speeds(r, 0.02), LEDGE)]);
  }
  for (const [n, s] of samples) row(`breach ${n} (4 s)`, s);
  await sleep(10000);
  row('breach basin', { 'erosion below the ledge in 20 s (cells³)': await p.evaluate(async ({ r, g0 }) => window.__erosion(g0, await window.__ground(r)), { r: BG, g0: bg0 }), 'basin wet at s': basinAt, front: +(await p.evaluate((r) => window.__front(r, 57, 144, 0.02), BASIN)).toFixed(1), ...(await p.evaluate((r) => window.__speeds(r, 0.02), BASIN)) });
  await p.evaluate(() => {
    const R = window.reclaimed;
    R.camera.target = [56, 144 * 0.8660254, 22];
    R.camera.zoom = 5;
  });
  await sleep(1000);
  await click('↺ reset').catch(() => {});
  await sleep(3000);
  await click('breach').catch(() => {});
  await sleep(500);
  await gif(p, 'breach.gif', 30, 400);
  await hideUi(false);
  // the pool after a reset: its chunks go back to sleep (the water's sloshing settles)
  await click('↺ reset').catch(() => {});
  const aw = [];
  for (let k = 0; k < 12; k++) {
    await sleep(5000);
    aw.push(await p.evaluate(() => window.reclaimed.scene.sleep?.awake ?? -1));
  }
  row('pool after reset: awake chunks every 5 s', { awake: aw });
  await p.close();
  // the atlas: the sea's edge and its rivers fall asleep
  if (!skip.includes('atlas')) {
    const a = await browser.newPage();
    a.on('pageerror', (e) => fail(`pageerror ${e.message}`));
    await a.goto(`${url}/?skipmenu=1&level=atlas&tutorial=0&q=low`, { waitUntil: 'load' });
    await a.waitForFunction(() => window.reclaimed?.stream, { timeout: 240000 });
    const aw2 = [];
    for (let k = 0; k < 9; k++) {
      await sleep(10000);
      aw2.push(await a.evaluate(() => window.reclaimed.scene.sleep?.awake ?? -1));
    }
    row('atlas: awake chunks every 10 s', { awake: aw2 });
    await a.close();
  }
} catch (e) {
  fail(e.stack ?? String(e));
} finally {
  await browser.close();
}
fs.writeFileSync(path.join(out, `${tag}-speeds.json`), JSON.stringify(rows, null, 1));
console.log(failed ? 'WATERSPEED: FAILED' : 'WATERSPEED: OK');
process.exit(failed ? 1 : 0);
