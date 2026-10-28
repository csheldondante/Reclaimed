// Round 98 (the user: "see if we can get streaming to stay ahead of the camera and how fast we can get the camera
// moving without losing fidelity"): the camera driven at increasing speeds, and for each speed what the streamed
// window kept up with. One page load (the phone tier, 412x915, every system on), then for each speed N seconds of:
//   - pan:   a straight line up the screen (level.ts ?pan's mover; it waits at the window's edge clamp like a held pan)
//   - turn:  the same, turning 90 degrees over a second halfway through
//   - drive: the ?drive road (zooming out with speed, as the hoverbike does; not held back by the clamp)
// Reported per speed: the speed the camera got (against asked), the camera's least distance to the window's edge
// (and ahead, along its motion), the view (a 9x19 grid of screen points on the ground) — past the window, and in the
// window but not in detail (a region moved over and not written yet; a chunk the rings draw — land just come in; a
// chunk that should be voxels and isn't built yet) — the land in detail ahead of the camera along its motion, the
// slides' latency and stages, and frame times (p50/p95/p99).
//   node scripts/speedsweep.mjs [--url http://localhost:5277] [--mode pan|turn|drive] [--speeds 20,40,80,120,160]
//     [--seconds 12] [--wait 35000] [--at 11956,15471] [--extra "&win=320"] [--size 412x915] [--gif out.gif --gifspeed 120]
//     [--dir deg] (round 100: pan/turn along world degrees, not up the screen — a route up a mountain, to force slides in z)
// (round 100) also reported: the slides in z (count, ms), the field mesh's GPU ms a second (its rebuilds), the band's,
// and the hybrid's share of the window's mesh chunks that are voxels.
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
const url = opt('url', 'http://localhost:5277');
const mode = opt('mode', 'pan');
const speeds = opt('speeds', '20,40,80,120,160').split(',').map(Number);
const seconds = Number(opt('seconds', 12));
const wait = Number(opt('wait', 35000));
const at = opt('at', '11956,15471');
const extra = opt('extra', '');
const gif = opt('gif', '');
const gifSpeed = Number(opt('gifspeed', speeds[speeds.length - 1]));
const [vw, vh] = opt('size', '412x915').split('x').map(Number);
const out = opt('json', '');
const dirDeg = opt('dir', '');
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', `--window-size=${vw},${vh}`],
  defaultViewport: { width: vw, height: vh, deviceScaleFactor: 2, hasTouch: true, isMobile: true },
  protocolTimeout: 900000,
});
let bad = false;
const results = [];
try {
  const p = await browser.newPage();
  p.on('pageerror', (e) => {
    bad = true;
    console.log('pageerror', e.message);
  });
  p.on('console', (m) => m.type() === 'error' && console.log('console.error', m.text()));
  const drive = mode === 'drive' ? '&drive=1' : '';
  await p.goto(`${url}/?skipmenu=1&level=atlas&tutorial=0&q=low&perf=1&at=${at}${drive}${extra}`, { waitUntil: 'load' });
  await p.waitForFunction(() => window.reclaimed?.stream, { timeout: 240000 });
  await new Promise((r) => setTimeout(r, wait));
  if (argv.includes('--bench')) {
    // (a region's columns made at once, not a tile a frame: its build's GPU time, with the readback, while the game runs)
    const b = await p.evaluate(async () => {
      const a = window.reclaimed.scene.opts.atlas.atlas;
      const dev = window.reclaimed.core.host.gpu.device;
      const out = [];
      for (let k = 0; k < 6; k++) {
        await dev.queue.onSubmittedWorkDone();
        const t = performance.now();
        await a.columns(1024 + k * 64, 2048, 64, 64, false);
        out.push(+(performance.now() - t).toFixed(1));
      }
      return out;
    });
    console.log('BENCH region build (ms, 64x64 at once, with readback):', JSON.stringify(b));
  }
  // the per-frame probe (installed once; each speed resets it)
  await p.evaluate(() => {
    const R = window.reclaimed;
    const S = R.stream;
    const c = R.camera;
    const sc = R.scene;
    const ROW_H = Math.sqrt(3) / 2;
    const dev = R.core.host.gpu.device;
    const fm = R.renderer.fieldMesh;
    const W = S.W;
    const H = S.H;
    const reg = S.R;
    const NX = 9;
    const NY = 19;
    const CH = 32;
    const nxc = Math.ceil((W + 0.5) / CH);
    const nyc = Math.ceil((H * ROW_H) / (CH * ROW_H));
    // (the field mesh's records: word 5 the hash a chunk was built for — FRESH or 0: nothing built; read every 6 frames)
    let built = null;
    let reading = false;
    let frame = 0;
    const readBuilt = () => {
      if (reading || !fm.state) return;
      reading = true;
      const n = 16 + nxc * nyc * 14;
      const st = dev.createBuffer({ size: n * 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
      const enc = dev.createCommandEncoder();
      enc.copyBufferToBuffer(fm.state, 0, st, 0, n * 4);
      dev.queue.submit([enc.finish()]);
      const epoch = S.trace.length + ':' + S.origin.join(',');
      st.mapAsync(GPUMapMode.READ).then(
        () => {
          const u = new Uint32Array(st.getMappedRange().slice(0));
          st.destroy();
          reading = false;
          // (a slide in between: the records moved — read again)
          if (epoch !== S.trace.length + ':' + S.origin.join(',')) return;
          const b = new Uint8Array(nxc * nyc);
          for (let k = 0; k < nxc * nyc; k++) {
            const h = u[16 + k * 14 + 5];
            b[k] = h !== 0x9e3779b9 && h !== 0 ? 1 : 0;
          }
          built = b;
        },
        () => (reading = false),
      );
    };
    // what a window point (x cells, y rows) shows: 0 detail, 1 past the window, 2 unwritten, 3 the rings' (in the
    // window), 4 voxels wanted and not built
    const classify = (x, y) => {
      if (x < 0 || y < 0 || x >= W || y >= H) return 1;
      for (const [lx, ly] of S.unwritten ?? []) if (x >= lx && x < lx + reg && y >= ly && y < ly + reg) return 2;
      const hy = sc.hybrid;
      if (hy) {
        const ci = Math.min(nyc - 1, Math.floor(y / CH)) * nxc + Math.min(nxc - 1, Math.floor(x / CH));
        if (hy.wanted[ci]) return built && !built[ci] ? 4 : 0;
        if (!hy.grid[ci]) return 3;
      }
      return 0;
    };
    const P = (window.__sweep = { reset: null, data: null });
    P.reset = () => {
      P.data = { frames: 0, ms: [], tEdge: Infinity, ahead: [], aheadEdge: [], view: [0, 0, 0, 0, 0], viewMax: [0, 0, 0, 0, 0], held: 0, start: null, last: null, dist: 0, t0: performance.now(), slides0: S.trace.length, gens0: S.gens.length, busy: 0, waited0: S.waited ?? 0, tiles0: R.scene.opts?.atlas?.atlas?.pacer?.tiles ?? 0, tframes0: R.scene.opts?.atlas?.atlas?.pacer?.frames ?? 0 };
    };
    P.reset();
    let lastT = performance.now();
    let lastPos = null;
    const tick = () => {
      const now = performance.now();
      const d = P.data;
      d.ms.push(now - lastT);
      lastT = now;
      d.frames++;
      if (S.busy) d.busy++;
      if (++frame % 6 === 0) readBuilt();
      const [tx, tyw] = c.target;
      const ty = tyw / ROW_H;
      const wx = S.origin[0] + tx;
      const wy = S.origin[1] * ROW_H + tyw;
      if (lastPos) {
        const step = Math.hypot(wx - lastPos[0], wy - lastPos[1]);
        if (step < 64) d.dist += step;
      }
      lastPos = [wx, wy];
      d.tEdge = Math.min(d.tEdge, tx, W - tx, ty, H - ty);
      // the motion's direction (the streamer's smoothed velocity)
      const v = S.vel;
      const vl = Math.hypot(v[0], v[1]);
      if (vl > 2) {
        const ux = v[0] / vl;
        const uy = v[1] / vl;
        // along the motion, on the ground: the land in detail ahead (cells), and the window's edge ahead
        let a = 0;
        for (; a < 400; a += 2) if (classify(tx + ux * a, ty + uy * a) !== 0) break;
        d.ahead.push(a);
        let e = 0;
        for (; e < 400; e += 2) {
          const x = tx + ux * e;
          const y = ty + uy * e;
          if (x < 0 || y < 0 || x >= W || y >= H) break;
        }
        d.aheadEdge.push(e);
      }
      const cnt = [0, 0, 0, 0, 0];
      for (let j = 0; j < NY; j++)
        for (let i = 0; i < NX; i++) {
          const sx = ((i + 0.5) / NX) * c.viewportW;
          const sy = ((j + 0.5) / NY) * c.viewportH;
          const [dx, dy] = c.screenDeltaToWorld(sx - c.viewportW / 2, sy - c.viewportH / 2);
          cnt[classify(tx + dx, (tyw + dy) / ROW_H)]++;
        }
      for (let k = 0; k < 5; k++) {
        d.view[k] += cnt[k] / (NX * NY);
        d.viewMax[k] = Math.max(d.viewMax[k], cnt[k] / (NX * NY));
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  for (const speed of speeds) {
    await p.evaluate(
      (speed, mode, dirDeg) => {
        const R = window.reclaimed;
        const sc = R.scene;
        if (mode === 'drive') sc.drive.speed = speed;
        else {
          // (up the screen; the turn: 90 degrees over a second, halfway through)
          const c = R.camera;
          const [ux, uy] = dirDeg !== '' ? [Math.cos((Number(dirDeg) * Math.PI) / 180), Math.sin((Number(dirDeg) * Math.PI) / 180)] : c.screenDeltaToWorld(0, -1);
          const l = Math.hypot(ux, uy) || 1;
          sc.pan = { speed, dir: [ux / l, uy / l], t: 0, turnAt: mode === 'turn' ? 1e9 : 0, turnBy: mode === 'turn' ? 90 : 0, turned: 0, asked: 0 };
        }
      },
      speed,
      mode,
      dirDeg,
    );
    // (a second to get going: the streamer's velocity and the lead catch up)
    await new Promise((r) => setTimeout(r, 1500));
    await p.evaluate((mode, s) => {
      window.__sweep.reset();
      const sc = window.reclaimed.scene;
      if (sc.pan) {
        sc.pan.asked = 0;
        if (mode === 'turn') sc.pan.turnAt = sc.pan.t + s / 2;
      }
      const prof = window.reclaimed.core.host.profiler;
      prof.resetTotals();
      sc.cpuReset?.();
      window.__sweep.data.tiers0 = window.reclaimed.stream.stats.tiers;
      window.__sweep.data.oz0 = window.reclaimed.stream.oz;
      if (sc.hybrid) sc.hybrid.totals = { frames: 0, voxel: 0, drawn: 0, grid: 0 };
    }, mode, seconds);
    if (gif && speed === gifSpeed) {
      const enc = GIFEncoder();
      const every = 150;
      const n = Math.floor((seconds * 1000) / (every + 120));
      for (let i = 0; i < n; i++) {
        const png = PNG.sync.read(Buffer.from(await p.screenshot({ type: 'png' })));
        const pal = quantize(png.data, 256);
        enc.writeFrame(applyPalette(png.data, pal), png.width, png.height, { palette: pal, delay: every });
        await new Promise((r) => setTimeout(r, every));
      }
      enc.finish();
      fs.writeFileSync(gif, enc.bytes());
      console.log('saved', gif);
    } else await new Promise((r) => setTimeout(r, seconds * 1000));
    const r = await p.evaluate((speed) => {
      const R = window.reclaimed;
      const S = R.stream;
      const d = window.__sweep.data;
      const secs = (performance.now() - d.t0) / 1000;
      const f = d.ms.slice(1).sort((a, b) => a - b);
      const q = (a, x) => (a.length ? +a[Math.min(a.length - 1, Math.floor(x * a.length))].toFixed(1) : null);
      const ah = [...d.ahead].sort((a, b) => a - b);
      const ae = [...d.aheadEdge].sort((a, b) => a - b);
      const tr = S.trace.filter((t) => t.t0 >= d.t0 && t.end);
      const lat = tr.map((t) => t.end - t.t0).sort((a, b) => a - b);
      // a slide's stages: its synchronous part; waiting for its regions' land; writing them
      const syncMs = tr.map((t) => t.sync - t.t0);
      const waitMs = tr.map((t) => t.regions.reduce((s, x, k) => s + (x.ready - (k ? t.regions[k - 1].written : t.sync)), 0));
      const writeMs = tr.map((t) => t.regions.reduce((s, x) => s + (x.written - x.ready), 0));
      const how = {};
      for (const t of tr) for (const x of t.regions) how[x.how] = (how[x.how] ?? 0) + 1;
      // the regions made in the run: asked → land (the atlas's columns, the ways, the settlements) → cut
      const gens = S.gens.filter((g) => g.asked >= d.t0 && g.done);
      const atlas = R.scene.opts?.atlas?.atlas;
      const stages = gens.map((g) => {
        const b = atlas?.builds.get(`${g.x0},${g.y0}`);
        return b ? { tiles: b.tiles.length, first: b.tiles[0] - g.asked, lastTile: b.tiles[b.tiles.length - 1] - g.asked, mapped: b.mapped - g.asked, ways: b.ways - b.mapped, hooks: b.hooks - b.ways, cut: g.done - g.land, total: g.done - g.asked } : { total: g.done - g.asked, cut: g.done - g.land };
      });
      const med = (k) => {
        const a = stages.map((s) => s[k]).filter((x) => x !== undefined && Number.isFinite(x)).sort((a, b) => a - b);
        return a.length ? +a[Math.floor(a.length / 2)].toFixed(1) : null;
      };
      const prof = R.core.host.profiler;
      const per = (k) => +((prof.totalMs.get(k) ?? 0) / Math.max(prof.framesResolved, 1)).toFixed(2);
      const sum = (a) => a.reduce((s, x) => s + x, 0);
      const n = d.frames;
      return {
        speed,
        got: +(d.dist / secs).toFixed(1),
        frames: n,
        p50: q(f, 0.5),
        p95: q(f, 0.95),
        p99: q(f, 0.99),
        worst: f.length ? +f[f.length - 1].toFixed(0) : null,
        targetMinToEdge: +d.tEdge.toFixed(0),
        aheadEdgeMin: ae.length ? ae[0] : null,
        aheadEdgeP50: q(ae, 0.5),
        detailAheadMin: ah.length ? ah[0] : null,
        detailAheadP5: q(ah, 0.05),
        detailAheadP50: q(ah, 0.5),
        viewPast: +((100 * d.view[1]) / n).toFixed(1),
        viewUnwritten: +((100 * d.view[2]) / n).toFixed(2),
        viewRings: +((100 * d.view[3]) / n).toFixed(2),
        viewUnbuilt: +((100 * d.view[4]) / n).toFixed(2),
        viewLowInWindow: +((100 * (d.view[2] + d.view[3] + d.view[4])) / n).toFixed(2),
        viewLowMax: +(100 * Math.max(d.viewMax[2], d.viewMax[3], d.viewMax[4])).toFixed(1),
        busy: +((100 * d.busy) / n).toFixed(1),
        slides: tr.length,
        regionsPerS: +(sum(tr.map((t) => t.regions.length)) / secs).toFixed(2),
        slideMs: { p50: q(lat, 0.5), max: lat.length ? +lat[lat.length - 1].toFixed(0) : null },
        slideStages: { sync: q([...syncMs].sort((a, b) => a - b), 0.5), wait: q([...waitMs].sort((a, b) => a - b), 0.5), write: q([...writeMs].sort((a, b) => a - b), 0.5) },
        regionsHow: how,
        made: gens.length,
        build: { first: med('first'), lastTile: med('lastTile'), mapped: med('mapped'), ways: med('ways'), hooks: med('hooks'), cut: med('cut'), total: med('total') },
        gpu: { frame: +(prof.gpuTotalMs / Math.max(prof.framesResolved, 1)).toFixed(2), colH: per('atlas-colHeight'), formSeed: per('atlas-formSeed'), colFinish: per('atlas-colFinish'), colFinishMax: +(prof.maxMs.get('atlas-colFinish') ?? 0).toFixed(2), draw: per('draw') },
        waited: (S.waited ?? 0) - d.waited0,
        pacer: atlas?.pacer ? { perFrame: +atlas.pacer.perFrame.toFixed(1), base: +atlas.pacer.base.toFixed(1), tilesPerFrame: +((atlas.pacer.tiles - d.tiles0) / Math.max(1, atlas.pacer.frames - d.tframes0)).toFixed(2), tilesPerS: +((atlas.pacer.tiles - d.tiles0) / secs).toFixed(1) } : null,
        cpu: R.scene.cpuWorst?.(),
        // (round 100, regionstore) the GPU pool and the store
        pool: S.pool ? { used: S.pool.used, cap: S.pool.cap, mb: +(S.pool.gpuBytes / 1048576).toFixed(1), evicted: S.stats.evicted, uploads: S.stats.uploads, thawMs: S.times?.thaw.length ? +[...S.times.thaw].sort((a, b) => a - b)[Math.floor(S.times.thaw.length / 2)].toFixed(2) : null } : null,
        store: S.store ? { ...S.store.totals(), saved: S.stats.saved, checked: S.stats.checked } : null,
        // (round 100) the slides in z; the field mesh's GPU ms a second (its rebuilds: every fieldmesh pass but the
        // hash), the band's; the hybrid's voxel chunks' share of the window's mesh chunks
        zSlides: S.stats.tiers - d.tiers0,
        oz: [d.oz0, S.oz],
        slideZ: R.scene.cpuWorst?.().slideZ ?? null,
        band: R.scene.cpuWorst?.().band ?? null,
        meshMsPerS: +([...prof.totalMs].filter(([k]) => k.startsWith('fieldmesh') && !k.endsWith('hash')).reduce((s, [, v]) => s + v, 0) / secs).toFixed(1),
        bandMeshMsPerS: +([...prof.totalMs].filter(([k]) => k.startsWith('band fieldmesh')).reduce((s, [, v]) => s + v, 0) / secs).toFixed(1),
        voxelShare: R.scene.hybrid ? +((100 * R.scene.hybrid.totals.voxel) / Math.max(1, R.scene.hybrid.totals.frames) / R.scene.hybrid.stats.chunks).toFixed(1) : null,
        steep: R.scene.hybrid?.stats.steep ?? null,
        fitted: S.stats.fitted,
        fatal: !!document.querySelector('.fatal'),
      };
    }, speed);
    if (r.fatal) bad = true;
    results.push(r);
    console.log(JSON.stringify(r));
    console.log(`SPEED ${mode} ${speed} → got ${r.got} c/s | edge: target min ${r.targetMinToEdge}, ahead min ${r.aheadEdgeMin} p50 ${r.aheadEdgeP50} | detail ahead min ${r.detailAheadMin} p5 ${r.detailAheadP5} p50 ${r.detailAheadP50} | view past ${r.viewPast}% low-in-window ${r.viewLowInWindow}% (unwritten ${r.viewUnwritten}, rings ${r.viewRings}, unbuilt ${r.viewUnbuilt}; max ${r.viewLowMax}%) | busy ${r.busy}% slides ${r.slides} (${r.regionsPerS} reg/s) ms ${JSON.stringify(r.slideMs)} stages ${JSON.stringify(r.slideStages)} | build ${JSON.stringify(r.build)} | waited ${r.waited} pacer ${JSON.stringify(r.pacer)} | frame p50 ${r.p50} p95 ${r.p95} p99 ${r.p99} worst ${r.worst} | gpu ${JSON.stringify(r.gpu)} | z slides ${r.zSlides} oz ${r.oz} slideZ ${JSON.stringify(r.slideZ)} band ${JSON.stringify(r.band)} | mesh ${r.meshMsPerS} ms/s band mesh ${r.bandMeshMsPerS} ms/s voxels ${r.voxelShare}% steep ${r.steep}`);
  }
  if (out) fs.writeFileSync(out, JSON.stringify({ mode, url, results }, null, 1));
} finally {
  await browser.close();
}
if (bad) process.exit(1);
