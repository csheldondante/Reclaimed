// Round 105 (`ringwin`): the ring-offset identity test. The window's per-column data lies on a ring (sim/ring.ts,
// common.wgsl colIdx / texCol*): window column (x, y) at ((x + ring.x) mod W, (y + ring.y) mod H). Where it lies
// must change nothing the world does. Two page loads of the same world, one at ring offset 0 and one at --bias
// (`?ringbias=`), the sim held (`?skip=sim`: only the load's own warm-up ticks run), the streamer's own slides off;
// then in each, the same ticks stepped by hand with the same globals, a slide or two by hand between them (the strip
// leaving frozen, the one coming in written where it lies), and every per-column buffer and texture read back in
// window order and hashed. Every field must hash the same at both offsets: a kernel indexing a column without the
// ring's helpers shows here as the field it wrote.
//   node scripts/ringtest.mjs [--url http://localhost:5305] [--level atlas|valley] [--bias 128,64] [--ticks 40]
//     [--slides "64,0;0,64"] [--wait 30000] [--extra "&x=1"]
import puppeteer from 'puppeteer-core';
const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const url = opt('url', 'http://localhost:5305');
const level = opt('level', 'atlas');
const bias = opt('bias', '128,64');
const ticks = Number(opt('ticks', 40));
const slides = opt('slides', level === 'atlas' ? '64,0;0,64' : '')
  .split(';')
  .filter(Boolean)
  .map((s) => s.split(',').map(Number));
const wait = Number(opt('wait', 30000));
const extra = opt('extra', '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = false;

async function run(b) {
  const browser = await puppeteer.launch({
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: 'new',
    args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--window-size=412,915'],
    defaultViewport: { width: 412, height: 915, deviceScaleFactor: 1 },
    protocolTimeout: 900000,
  });
  try {
    const p = await browser.newPage();
    p.on('pageerror', (e) => {
      failed = true;
      console.log('pageerror', e.message);
    });
    p.on('console', (m) => {
      if (m.type() === 'error' && !m.text().includes('404')) {
        failed = true;
        console.log('console.error:', m.text().slice(0, 600));
      }
    });
    const lv = level === 'atlas' ? '&level=atlas&at=15024,14337&world=ringtest&worldsave=0' : '';
    await p.goto(`${url}/?skipmenu=1&tutorial=0&q=low&skip=sim&ringbias=${b}${lv}${extra}`, { waitUntil: 'load' });
    await p.waitForFunction(() => window.reclaimed?.core, { timeout: 240000 });
    await sleep(wait);
    return await p.evaluate(
      async (ticks, slides) => {
        const R = window.reclaimed;
        const core = R.core;
        const S = R.stream;
        if (S) S.auto = false;
        const dev = core.host.gpu.device;
        await dev.queue.onSubmittedWorkDone();
        const g0 = JSON.parse(JSON.stringify(core.globals));
        // (at the ring's seam at offset 128,64 — window column W - 128, row H - 64 — a rain storm over it, and events
        // on it at tick 3: lightning, a fire set, a tap to grow, a dig, a ripple; the same at both offsets)
        const sx = core.dims.w - 128;
        const sy = (core.dims.h - 64) * (Math.sqrt(3) / 2);
        const step = (n, t0) => {
          for (let i = 0; i < n; i++) {
            const g = JSON.parse(JSON.stringify(g0));
            g.time = 100 + (t0 + i) * 0.05;
            g.events = [];
            g.storms = [{ x: sx, y: sy, radius: 40, intensity: 1, vx: 0, vy: 0, downpour: 2, flash: 0, shape: [0, 0, 0, 1] }];
            if (t0 + i === 3)
              g.events = [
                { kind: 1, x: sx - 3, y: sy + 2, radius: 5, strength: 20 },
                { kind: 7, x: sx + 6, y: sy - 4, radius: 6, strength: 1 },
                { kind: 4, x: sx - 8, y: sy - 6, radius: 6, strength: 1 },
                { kind: 6, x: sx, y: sy, radius: 12, strength: 4 },
              ];
            if (t0 + i === 8) g.events = [{ kind: 5, x: sx + 1, y: sy + 1, radius: 4, strength: 2, z: 0 }];
            core.sim.step(g);
          }
        };
        const names = ['surface', 'water', 'waterNext', 'waterPrev', 'waterSource', 'oil', 'oilStored', 'lava', 'contam', 'moisture', 'veg', 'fire', 'renderFields', 'bend', 'wilt', 'petals', 'contamDelta', 'deposit', 'places', 'flux', 'oilFlux', 'lavaFlux', 'physCols', 'layers'];
        const texs = ['drift', 'air', 'strata', 'levels', 'shake', 'lavaSpring', 'riverFlow', 'bodyProj', 'foreign', 'proj', 'sparkTex', 'editState', 'windField'];
        const hash = (u) => {
          let h = 2166136261;
          for (let i = 0; i < u.length; i++) h = Math.imul(h ^ u[i], 16777619);
          return (h >>> 0).toString(16);
        };
        const W = core.dims.w;
        const H = core.dims.h;
        const readAll = async () => {
          const out = {};
          for (const n of names) {
            if (!core.world[n]) continue;
            let f = await core.readBuffer(n);
            // (the flux buffers and physCols aren't in the ring's table: rotated here by their stride)
            const per = { flux: 6, oilFlux: 6, lavaFlux: 6, physCols: 16 }[n];
            if (per && !core.ring.zero) f = core.ring.fromRing(f.slice(0, W * H * per), per);
            // (the layers: by the chunk table, the same at any ring)
            out[n] = hash(new Uint32Array(f.buffer, f.byteOffset, n === 'layers' ? f.length : Math.min(f.length, W * H * (per ?? (f.length / (W * H))))));
          }
          for (const t of texs) {
            if (!core.world[t]) continue;
            const r = await core.readTexture(core.world[t]);
            out[`tex:${t}`] = hash(new Uint32Array(r.data.buffer));
          }
          return out;
        };
        const res = [];
        res.push({ at: 'at the start (no tick)', ring: [core.ring.x, core.ring.y], h: await readAll() });
        step(ticks, 0);
        await dev.queue.onSubmittedWorkDone();
        res.push({ at: `after ${ticks} ticks`, ring: [core.ring.x, core.ring.y], h: await readAll() });
        let t = ticks;
        for (const [dx, dy] of slides) {
          if (!S) break;
          await S.slide(dx, dy);
          await dev.queue.onSubmittedWorkDone();
          step(ticks, t);
          t += ticks;
          await dev.queue.onSubmittedWorkDone();
          res.push({ at: `slide ${dx},${dy} then ${ticks} ticks`, ring: [core.ring.x, core.ring.y], h: await readAll() });
        }
        return { dims: core.dims, res };
      },
      ticks,
      slides,
    );
  } finally {
    await browser.close();
  }
}

const a = await run('0,0');
const b = await run(bias);
console.log(`window ${a.dims.w}x${a.dims.h}, level ${level}, bias ${bias}`);
for (let k = 0; k < a.res.length; k++) {
  const ra = a.res[k];
  const rb = b.res[k];
  const bad = Object.keys(ra.h).filter((n) => ra.h[n] !== rb.h[n]);
  const ok = bad.length === 0;
  if (!ok) failed = true;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${ra.at}: ring ${ra.ring} vs ${rb.ring}; ${Object.keys(ra.h).length} fields${ok ? ' identical' : `, differ: ${bad.join(' ')}`}`);
}
if (failed) process.exit(1);
