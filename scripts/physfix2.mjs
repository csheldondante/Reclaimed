// Round 112 (physfix2): the user's five reports from the playground, headless with every system in play (the page as
// the phone runs it: q=low 412x915, 1x speed). Each scenario from a reset station, a GIF, and what the GPU's layers hold
// of each material in the station before and after (the census: what vanished, what turned to rubble):
//   concrete — one block knocked out of the concrete tower's foot (build station)
//   bridge   — one of the bridge's pillars smashed (build station: the columns' pieces / structures)
//   arch     — one foot of the rock station's arch smashed (rigid rock)
//   tower    — a wedge out of one side of the tall sandstone pillar's foot: it must topple, not lean
//   neck     — the station's "nick the legs" (the arm, the arch, the tops): what breaks, at necks too
//   sand     — a mountain range raised with the Range tool on the plain: does it settle and stop, or stream forever?
//   cost     — the frame on the phone proxy, idle and while the rock falls
//   node scripts/physfix2.mjs [--url http://localhost:5311] [--out C:/Projects/shots88/physfix2] [--only a,b] [--tag after]
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
const url = opt('url', 'http://localhost:5311');
const out = opt('out', 'C:/Projects/shots88/physfix2');
const [W, H] = opt('size', '412x915').split('x').map(Number);
const dpr = Number(opt('dpr', '2.6'));
const q = opt('q', 'low');
const tag = opt('tag', 'after');
const only = opt('only', 'concrete,bridge,arch,tower,neck,sand,cost').split(',');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(out, { recursive: true });
const MATS = { 1: 'stone', 2: 'soil', 3: 'sand', 4: 'rubble', 5: 'concrete', 11: 'brick', 19: 'drift', 30: 'sandstone', 39: 'external' };

const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', `--window-size=${W},${H}`],
  defaultViewport: { width: W, height: H, deviceScaleFactor: dpr },
  protocolTimeout: 10 * 60 * 1000,
});
let failed = false;
const fail = (m) => {
  failed = true;
  console.log(`FAIL ${m}`);
};
try {
  const p = await browser.newPage();
  p.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') console.log(`[console.${m.type()}] ${m.text().slice(0, 600)}`);
  });
  p.on('pageerror', (e) => fail(`pageerror ${e.message}`));
  const t0 = Date.now();
  await p.goto(`${url}/?skipmenu=1&level=playground&tutorial=0&q=${q}${opt('extra', '')}`, { waitUntil: 'load' });
  await p.waitForFunction(() => window.reclaimed?.scene?.integrity, { timeout: 240000 });
  console.log(`level up in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  await sleep(35000);
  const fatal = await p.$eval('.fatal', (e) => e.textContent).catch(() => null);
  if (fatal) throw new Error(`fatal overlay: ${fatal}`);
  await p.evaluate(() => window.reclaimed.scene.tunePanel?.toggle(false));
  // (the sandbox's tool panel out of the pictures)
  await p.evaluate(() => document.querySelectorAll('.editor').forEach((e) => (e.style.display = 'none')));
  const stations = await p.evaluate(() => window.reclaimed.scene.level.stations.map((s) => s.id));
  const pick = (id) => p.evaluate((i) => window.reclaimed.scene.stationsBar.pick(i), stations.indexOf(id));
  const click = (label) =>
    p.evaluate((label) => {
      const b = [...document.querySelectorAll('.stations button')].find((x) => x.textContent === label);
      if (!b) throw new Error(`no button ${label}`);
      b.click();
    }, label);
  const shot = (name) => p.screenshot({ path: path.join(out, `${tag}-${name}`) });
  const gif = async (name, frames, every) => {
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
  // (in the page) the GPU's layers: cells of each material above the plain (z > 10) in a box of storage columns
  const census = (x0, y0, x1, y1) =>
    p.evaluate(
      async (x0, y0, x1, y1) => {
        const core = window.reclaimed.core;
        const f = await core.readBuffer('layers');
        const u = new Uint32Array(f.buffer);
        const P = core.packed;
        const by = {};
        for (let y = y0; y < y1; y++)
          for (let x = x0; x < x1; x++) {
            const ci = Math.floor(y / 16) * P.chunksX + Math.floor(x / 16);
            const k = P.chunkTable[ci * 2 + 1];
            const o = (P.chunkTable[ci * 2] + ((y % 16) * 16 + (x % 16)) * k) * 4;
            for (let s = 0; s < k; s++) {
              const w = o + s * 4;
              if (u[w + 1] === 0) break;
              const z0 = Math.max(10, f[w]);
              const z1 = f[w + 1];
              if (z1 <= z0) continue;
              const m = u[w + 2] & 0xff;
              by[m] = (by[m] ?? 0) + z1 - z0;
            }
          }
        for (const m in by) by[m] = +by[m].toFixed(1);
        return by;
      },
      x0,
      y0,
      x1,
      y1,
    ).then((by) => Object.fromEntries(Object.entries(by).map(([m, v]) => [MATS[m] ?? `mat${m}`, v])));
  const state = () =>
    p.evaluate(() => {
      const ig = window.reclaimed.scene.integrity;
      const r = ig.rigid;
      const list = r?.list ?? [];
      const big = list.reduce((a, b) => (!a || b.cells.length > a.cells.length ? b : a), null);
      const tilt = (b) => {
        const m = r.matrix(b);
        return +((Math.acos(Math.min(1, m[10])) * 180) / Math.PI).toFixed(1);
      };
      return {
        t: +((performance.now() - window.__t0) / 1000).toFixed(1),
        rigid: list.length,
        resting: ig.restingCount ?? 0,
        falling: ig.falling.list.length,
        big: big ? `${big.cells.length}c tilt ${tilt(big)} z ${big.pos[2].toFixed(1)} bal ${big.balanced}` : '-',
        spawned: r?.stats.spawned,
        breaks: r?.stats.breaks,
        neckBreaks: r?.stats.neckBreaks ?? 0,
        necks: r?.stats.necks ?? 0,
        settled: r?.stats.settled,
        baked: r?.stats.baked ?? 0,
        bakedWhy: JSON.stringify(r?.bakedWhy ?? {}),
        crumbled: ig.stats.crumbled,
        shattered: ig.stats.shattered,
        why: JSON.stringify(ig.why),
      };
    });
  const watch = async (label, secs, gifName, frames = 32, every = 250) => {
    const tl = [];
    let stop = false;
    const sampler = (async () => {
      while (!stop) {
        tl.push(await state());
        await sleep(1000);
      }
    })();
    if (gifName) await gif(gifName, frames, every);
    const left = secs * 1000 - (gifName ? frames * every : 0);
    if (left > 0) await sleep(left);
    stop = true;
    await sampler;
    for (const s of tl) console.log(`[${label}] t ${s.t} rigid ${s.rigid} resting ${s.resting} falling ${s.falling} big ${s.big} spawned ${s.spawned} breaks ${s.breaks} (necks ${s.neckBreaks}/${s.necks}) settled ${s.settled} baked ${s.baked} ${s.bakedWhy} crumbled ${s.crumbled} shattered ${s.shattered}`);
    console.log(`[${label}] why ${tl[tl.length - 1]?.why}`);
    return tl;
  };
  const G = 10;
  const kit = (f, ...a) => p.evaluate((f, a) => window.reclaimed.scene.stationKit()[f](...a), f, a);
  const look = (x, y, z, zoom) => p.evaluate((v) => ((window.reclaimed.camera.target = [v[0], v[1], v[2]]), (window.reclaimed.camera.zoom = v[3])), [x, y, z, zoom]);
  const fresh = async (id) => {
    await pick(id);
    await click('↺ reset');
    await sleep(3500);
    await p.evaluate(() => (window.__t0 = performance.now()));
  };
  const ROW_H = Math.sqrt(3) / 2;
  const wp = (x, y) => [x + 0.5 + 0.5 * (y & 1), (y + 0.5) * ROW_H];
  const BUILD = [112, 16, 176, 80];
  const ROCK = [16, 16, 96, 80];
  const B = { x: 116, y: 30 };

  if (only.includes('concrete')) {
    await fresh('build');
    await look(...wp(B.x + 14, B.y + 4), G + 8, 2.4);
    await sleep(1500);
    const before = await census(...BUILD);
    console.log(`[concrete] before ${JSON.stringify(before)}`);
    // (the station's "break bases": the concrete tower's foot, the chimney's, the diving board's, a bridge pillar's)
    await click('break bases');
    await watch('concrete', 14, 'concrete.gif', 40, 250);
    const after = await census(...BUILD);
    console.log(`[concrete] after ${JSON.stringify(after)}`);
    await shot('concrete-end.png');
    if ((after.concrete ?? 0) < (before.concrete ?? 0) - 40 && !(after.external > 0)) fail(`concrete: ${before.concrete} -> ${after.concrete} cells`);
  }
  if (only.includes('bridge')) {
    await fresh('build');
    await look(...wp(B.x + 42, B.y + 2), G + 6, 5);
    await sleep(1500);
    console.log(`[bridge] before ${JSON.stringify(await census(...BUILD))}`);
    await kit('smash', ...wp(B.x + 35.5, B.y + 2), G + 3, 2.4);
    await watch('bridge', 14, 'bridge.gif', 40, 250);
    console.log(`[bridge] after ${JSON.stringify(await census(...BUILD))}`);
    await shot('bridge-end.png');
  }
  if (only.includes('arch')) {
    await fresh('rock');
    await look(76, 30, 16, 5);
    await sleep(1500);
    console.log(`[arch] before ${JSON.stringify(await census(...ROCK))}`);
    await kit('smash', 70, 30, G + 2, 2.6);
    await watch('arch', 16, 'arch.gif', 44, 250);
    console.log(`[arch] after ${JSON.stringify(await census(...ROCK))}`);
    await shot('arch-end.png');
  }
  if (only.includes('tower')) {
    await fresh('rock');
    await look(70, 56, 22, 4);
    await sleep(1500);
    for (const dy of [-1.5, 0, 1.5]) await kit('smash', 76.2, 56 + dy, G + 1.5, 1.8);
    await kit('smash', 77.4, 56, G + 1.5, 1.8);
    await watch('tower', 20, 'tower.gif', 48, 300);
    await shot('tower-end.png');
  }
  if (only.includes('neck')) {
    await fresh('rock');
    await look(48, 40, 18, 3.6);
    await sleep(1500);
    await click('nick the legs');
    await watch('neck', 16, 'neck.gif', 44, 250);
    await shot('neck-end.png');
  }
  if (only.includes('sand')) {
    // (a range on the plain between the build station and the river: the Range tool's stroke, its brush 6)
    await p.evaluate(() => {
      const s = window.reclaimed.scene;
      s.editor.tool = 'range';
      s.editor.radius = 6;
      s.editTool(124, 76, false);
      for (let x = 124; x <= 168; x += 2) s.raising.to(x, 76 + 3 * Math.sin(x / 7));
      s.raising.end();
      s.raising = undefined;
      s.editor.tool = 'wind';
    });
    await look(146, 76, 16, 3.2);
    await sleep(8000);
    // (the range's columns: storage rows 82..94, x 116..176; their loose ground over time, and whether their chunks sleep)
    const looseAt = () =>
      p.evaluate(async () => {
        const core = window.reclaimed.core;
        const f = await core.readBuffer('layers');
        const u = new Uint32Array(f.buffer);
        const P = core.packed;
        let loose = 0;
        let top = 0;
        const sig = [];
        for (let y = 80; y < 96; y++)
          for (let x = 116; x < 176; x++) {
            const ci = Math.floor(y / 16) * P.chunksX + Math.floor(x / 16);
            const k = P.chunkTable[ci * 2 + 1];
            const o = (P.chunkTable[ci * 2] + ((y % 16) * 16 + (x % 16)) * k) * 4;
            let colTop = 0;
            for (let s = 0; s < k; s++) {
              const w = o + s * 4;
              if (u[w + 1] === 0) break;
              const m = u[w + 2] & 0xff;
              if (m === 2 || m === 3 || m === 4 || m === 19) loose += f[w + 1] - f[w];
              colTop = f[w + 1];
            }
            top = Math.max(top, colTop);
            sig.push(colTop);
          }
        const sl = window.reclaimed.scene.sleep ?? core.sleep;
        const now = performance.now() / 1000;
        let awake = 0;
        let n = 0;
        for (let cy = 5; cy < 6; cy++) for (let cx = 7; cx < 11; cx++) {
          n++;
          if (sl?.isAwake?.(cy * P.chunksX + cx, now)) awake++;
        }
        return { loose: +loose.toFixed(2), top: +top.toFixed(2), sig, awake: `${awake}/${n}` };
      });
    // (the air the sediment writes for the particles: how much is shown sliding there, texel by texel)
    const airAt = () =>
      p.evaluate(async () => {
        const core = window.reclaimed.core;
        const dev = core.host.gpu.device;
        const t = core.world.air;
        const bpr = Math.ceil((t.width * 16) / 256) * 256;
        const buf = dev.createBuffer({ size: bpr * t.height, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
        const enc = dev.createCommandEncoder();
        enc.copyTextureToBuffer({ texture: t }, { buffer: buf, bytesPerRow: bpr }, { width: t.width, height: t.height });
        dev.queue.submit([enc.finish()]);
        await buf.mapAsync(GPUMapMode.READ);
        const f = new Float32Array(buf.getMappedRange().slice(0));
        buf.destroy();
        let lift = 0;
        let slide = 0;
        let cols = 0;
        for (let y = 0; y < t.height; y++)
          for (let x = 0; x < t.width; x++) {
            const i = (y * bpr) / 4 + x * 4;
            lift += f[i];
            if (f[i + 1] > 0) {
              slide += f[i + 1];
              cols++;
            }
          }
        return { lift: +lift.toFixed(4), slide: +slide.toFixed(4), sliding: cols };
      });
    let last = null;
    const enc = [];
    for (let s = 0; s <= 90; s += 10) {
      const l = await looseAt();
      const a = await airAt();
      let moved = 0;
      if (last) for (let i = 0; i < l.sig.length; i++) moved += Math.abs(l.sig[i] - last.sig[i]);
      console.log(`[sand] t ${s}: top ${l.top} loose ${l.loose} moved ${moved.toFixed(2)} chunks awake ${l.awake}; air: lift ${a.lift} sliding ${a.sliding} texels (${a.slide})`);
      last = l;
      if (s === 30) enc.push(gif('sand-30s.gif', 24, 250));
      if (s === 80) enc.push(gif('sand-80s.gif', 24, 250));
      await Promise.all(enc.splice(0));
      if (s < 90) await sleep(10000);
    }
  }
  if (only.includes('cost')) {
    await fresh('rock');
    const begin = () =>
      p.evaluate(() => {
        const R = window.reclaimed;
        R.core.host.profiler.resetTotals();
        window.__all = [];
        window.__rbMs = 0;
        if (!window.__costLoop) {
          window.__costLoop = true;
          const tick = () => {
            window.__all.push(performance.now());
            window.__rbMs = Math.max(window.__rbMs, R.scene.integrity.rigid?.stats.stepMs ?? 0);
            requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        }
      });
    const end = () =>
      p.evaluate(() => {
        const R = window.reclaimed;
        const t = window.__all;
        const d = [];
        for (let i = 1; i < t.length; i++) d.push(t[i] - t[i - 1]);
        const f = [...d].sort((a, b) => a - b);
        const qq = (x) => +f[Math.min(f.length - 1, Math.floor(x * f.length))].toFixed(1);
        const P = R.core.host.profiler;
        return { fps: +(d.length / ((t[t.length - 1] - t[0]) / 1000)).toFixed(1), p50: qq(0.5), p95: qq(0.95), worst: +f[f.length - 1].toFixed(0), gpu: +(P.gpuTotalMs / Math.max(P.framesResolved, 1)).toFixed(2), rigidStepMax: +window.__rbMs.toFixed(2), neckMs: R.scene.integrity.rigid?.stats.neckMs ?? 0 };
      });
    await begin();
    await sleep(8000);
    const idle = await end();
    await click('nick the legs');
    await sleep(600);
    await click('cut the towers');
    await begin();
    await sleep(8000);
    const busy = await end();
    await sleep(15000);
    await begin();
    await sleep(8000);
    const after = await end();
    console.log(`[cost] idle ${JSON.stringify(idle)}`);
    console.log(`[cost] falling ${JSON.stringify(busy)}`);
    console.log(`[cost] after ${JSON.stringify(after)}`);
  }
} catch (e) {
  fail(e.stack || String(e));
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
