// Round 110 (physfix): the rigid rock's four faults the user saw in the playground, headless with every system in play
// (the page as the phone runs it: q=low, 1x speed). Scenarios, each from a reset rock station:
//   arch  — one foot of the arch broken: the span must fall as bodies (not vanish)
//   dig   — the ground dug from round a rock's foot (the top on a thin leg, its leg cut low): the body must not rise
//   rest  — the station's buttons, then 20 s: the bodies come to rest and stay meshes (resting), not ground or dust
//   build — the build station's bases broken (the columns' pieces)
//   cost  — the frame's cost while the rock falls and after (the perf overlay's numbers)
// Every scenario logs the bodies' counts and states over time (awake, resting, written back, broken), and per body
// how far it rose above where it was freed and its fastest upward speed in contact (the push-up).
//   node scripts/physfix.mjs [--url http://localhost:5291] [--out C:/Projects/shots88/physfix] [--only arch,dig]
//     [--size 412x915] [--dpr 2.6] [--q low] [--tag before]
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
const url = opt('url', 'http://localhost:5291');
const out = opt('out', 'C:/Projects/shots88/physfix');
const [W, H] = opt('size', '412x915').split('x').map(Number);
const dpr = Number(opt('dpr', '2.6'));
const q = opt('q', 'low');
const tag = opt('tag', 'after');
const only = opt('only', 'arch,dig,rest,build,cost').split(',');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(out, { recursive: true });

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
  // (in the page: each frame, every awake body's height against where it was freed, its upward speed in contact)
  await p.evaluate(() => {
    const ig = window.reclaimed.scene.integrity;
    const T = (window.__pf = { bodies: new Map(), timeline: [], t0: performance.now() });
    const loop = () => {
      const r = ig.rigid;
      if (r)
        for (const b of r.list) {
          let e = T.bodies.get(b.id);
          if (!e) T.bodies.set(b.id, (e = { id: b.id, n: b.cells.length, z0: b.pos[2], zmax: b.pos[2], rise: 0, vup: 0, born: performance.now(), asleep: 0 }));
          e.rise = Math.max(e.rise, b.pos[2] - e.z0);
          if (b.contact && performance.now() - e.born < 1500) e.vup = Math.max(e.vup, b.v[2]);
          e.last = b.pos[2];
          if (b.asleep) e.asleep++;
        }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  });
  const state = () =>
    p.evaluate(() => {
      const ig = window.reclaimed.scene.integrity;
      const r = ig.rigid;
      const list = r?.list ?? [];
      return {
        t: +((performance.now() - window.__pf.t0) / 1000).toFixed(1),
        awake: list.filter((b) => !b.asleep).length,
        asleep: list.filter((b) => b.asleep).length,
        resting: ig.restingCount ?? 0,
        falling: ig.falling.list.length,
        cells: list.reduce((s, b) => s + b.cells.length, 0),
        spawned: r?.stats.spawned,
        breaks: r?.stats.breaks,
        settled: r?.stats.settled,
        baked: r?.stats.baked ?? 0,
        woken: r?.stats.woken ?? 0,
        eroded: r?.stats.eroded ?? 0,
        crumbled: ig.stats.crumbled,
        shattered: ig.stats.shattered,
      };
    });
  const resetPf = () => p.evaluate(() => (window.__pf.bodies.clear(), (window.__pf.t0 = performance.now())));
  const bodiesReport = (label) =>
    p.evaluate(() => [...window.__pf.bodies.values()].map((e) => ({ id: e.id, n: e.n, rise: +e.rise.toFixed(2), vup: +e.vup.toFixed(2), fell: +(e.z0 - e.last).toFixed(2) }))).then((l) => {
      console.log(`[${label}] bodies: ${l.map((e) => `#${e.id} ${e.n}c rose ${e.rise} vup ${e.vup} fell ${e.fell}`).join('; ') || 'none'}`);
      return l;
    });
  /** samples the state every `every` ms for `secs` while a GIF is made */
  const watch = async (label, secs, gifName, frames = 32, every = 250) => {
    const tl = [];
    let stop = false;
    const sampler = (async () => {
      while (!stop) {
        tl.push(await state());
        await sleep(500);
      }
    })();
    if (gifName) await gif(gifName, frames, every);
    const left = secs * 1000 - (gifName ? frames * every : 0);
    if (left > 0) await sleep(left);
    stop = true;
    await sampler;
    for (const s of tl) console.log(`[${label}] t ${s.t} awake ${s.awake} asleep ${s.asleep} resting ${s.resting} falling ${s.falling} cells ${s.cells} spawned ${s.spawned} breaks ${s.breaks} settled ${s.settled} baked ${s.baked} woken ${s.woken} eroded ${s.eroded} crumbled ${s.crumbled} shattered ${s.shattered}`);
    return tl;
  };
  const G = 10;
  const kit = (f, ...a) => p.evaluate((f, a) => window.reclaimed.scene.stationKit()[f](...a), f, a);
  const fresh = async (id) => {
    await pick(id);
    await click('↺ reset');
    await sleep(3500);
    await resetPf();
  };

  if (only.includes('arch')) {
    await fresh('rock');
    // (the arch: sandstone feet at world (70, 30) and (82, 30); the left foot broken through low)
    await p.evaluate(() => ((window.reclaimed.camera.target = [76, 30, 16]), (window.reclaimed.camera.zoom = 5)));
    await sleep(800);
    await shot('arch-0.png');
    await kit('smash', 70, 30, G + 2, 2.6);
    const tl = await watch('arch', 14, 'arch.gif', 36, 250);
    await shot('arch-1.png');
    const l = await bodiesReport('arch');
    const most = Math.max(...tl.map((s) => s.awake + s.asleep + s.resting));
    if (!l.length) fail('arch: the span fell as no body');
    const end = tl[tl.length - 1];
    console.log(`[arch] most bodies ${most}; end awake ${end.awake} asleep ${end.asleep} resting ${end.resting}; crumbled ${end.crumbled}`);
  }
  if (only.includes('dig')) {
    await fresh('rock');
    // (the top on a thin leg at world (28, 30), its leg 2.4 across from G-2 to G+20, the top to G+30: the ground dug
    // from round its foot — the Dig tool's holes at its rim, then a smash through the leg low)
    await p.evaluate(() => ((window.reclaimed.camera.target = [28, 30, 16]), (window.reclaimed.camera.zoom = 5)));
    for (let a = 0; a < 6; a++) await kit('dig', 28 + 3.2 * Math.cos(a), 30 + 3.2 * Math.sin(a), 1.6, 2);
    await sleep(1500);
    await kit('smash', 28, 30, G + 1, 2.2);
    await watch('dig', 10, 'dig.gif', 32, 250);
    const l = await bodiesReport('dig');
    for (const e of l) if (e.rise > 0.3 || e.vup > 0.5) fail(`dig: body #${e.id} (${e.n} cells) rose ${e.rise} cells, ${e.vup} cells/s up in contact`);
  }
  if (only.includes('rest')) {
    await fresh('rock');
    await click('nick the legs');
    await sleep(1500);
    await click('cut the towers');
    const tl = await watch('rest', 30, 'rest.gif', 48, 400);
    await shot('rest-end.png');
    const l = await bodiesReport('rest');
    for (const e of l) if (e.rise > 0.3 || e.vup > 0.5) fail(`rest: body #${e.id} (${e.n} cells) rose ${e.rise} cells, ${e.vup} cells/s up in contact`);
    const end = tl[tl.length - 1];
    if (end.awake > 0) console.log(`[rest] still awake at the end: ${end.awake}`);
    if (end.baked > 0) fail(`rest: ${end.baked} bodies baked into the ground with no request`);
  }
  if (only.includes('build')) {
    await fresh('build');
    await click('break bases');
    await watch('build', 12, 'build.gif', 32, 250);
    await shot('build-end.png');
  }
  if (only.includes('cost')) {
    await fresh('rock');
    const begin = () =>
      p.evaluate(() => {
        const R = window.reclaimed;
        R.scene.cpuReset?.();
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
        return { fps: +(d.length / ((t[t.length - 1] - t[0]) / 1000)).toFixed(1), p50: qq(0.5), p95: qq(0.95), worst: +f[f.length - 1].toFixed(0), gpu: +(P.gpuTotalMs / Math.max(P.framesResolved, 1)).toFixed(2), rigidStepMax: +window.__rbMs.toFixed(2), cpu: R.scene.cpuWorst?.() ?? null };
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
    const st = await state();
    console.log(`[cost] idle ${JSON.stringify(idle)}`);
    console.log(`[cost] falling ${JSON.stringify(busy)}`);
    console.log(`[cost] after ${JSON.stringify(after)}`);
    console.log(`[cost] state ${JSON.stringify(st)}`);
  }
} catch (e) {
  fail(e.stack || String(e));
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
