// Round 113 (tilesfirst): the chain from a region being wanted to its land being drawn, timed link by link while
// panning — the coordinator: "time each link in the chain from a region being wanted to being drawn, and name the
// slowest". Per region that comes into the window during the pan (its world key):
//   asked    the streamer asked for its land (Streamer.startJob: a prefetch, or the slide's own)
//   made     its land ready in the pool (Streamer.ready)
//   slid     the window slid over it (it's in Streamer.unwritten)
//   written  its land written into the window (out of unwritten)
//   gridOn   the first of its chunks the hybrid grid draws (Renderer.gridOn), allOn every one of them drawn by the
//            window (the grid's, or the voxel mesh's built — FieldMesh.built, read back every frame here)
//   tile     a tile of it drawn (TileCache.drawsRegion), first frame
//   seen     its box first on the screen (its columns' tops when known, else the window's z range)
// and the exposure: frames it was on the screen with any of its chunks undrawn by the window and no tile drawn of it.
// Times are ms from `slid`; medians and worst over the regions. The phone proxy (as holediag.mjs).
//   node scripts/chaintime.mjs [--zoom 14] [--speeds 40,80] [--mode pool|line] [--secs 4] [--throttle 4] [--json f]
import { run } from './lib/runner.mjs';
import fs from 'node:fs';

const UA = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Mobile Safari/537.36';
const BENCH = 'tufts=0&shadowcache=4&prepevery=2&bandh=2&shadowsize=512&hybrid=1&settle=0&inplace=1&sleepmore=1&hitch=1&hitchhud=0';

await run({ name: 'chaintime', kind: 'behaviour', size: '412x915', dpr: 2.6 }, async (R) => {
  const zooms = R.opt('zoom', '14').split(',').map(Number);
  const speeds = R.opt('speeds', '40,80').split(',').map(Number);
  const modes = R.opt('mode', 'line').split(',');
  const secs = Number(R.opt('secs', 4));
  const win = Number(R.opt('win', 256));
  const extra = R.opt('extra', '');
  const out = [];
  const p = await R.page({ size: '412x915', dpr: 2.6 });
  await p.setViewport({ width: 412, height: 915, deviceScaleFactor: 2.6, hasTouch: true, isMobile: true });
  await p.setUserAgent(UA);
  if (Number(R.opt('throttle', 0)) > 1) await (await p.createCDPSession()).send('Emulation.setCPUThrottlingRate', { rate: Number(R.opt('throttle', 0)) });
  const params = Object.fromEntries(new URLSearchParams(`${BENCH}&level=atlas&at=15024,14337&win=${win}&bgcheck=1&worldsave=0&tod=0.42&day=100000&season=0.3${extra}`));
  await R.level(params, { page: p });
  await R.simSeconds(p, 8);
  for (const zoom of zooms)
    for (const mode of modes)
      for (const v of speeds) {
        const res = await p.evaluate(
          async (zoom, v, mode, secs) => {
            const RR = window.reclaimed;
            const cam = RR.camera;
            const S = RR.stream;
            const TL = RR.renderer.tiles;
            const fm = TL.host.win.mesh;
            const ren = RR.renderer;
            const ROW_H = Math.sqrt(3) / 2;
            fm.statPeriod = 1;
            const frame = () => new Promise((r) => requestAnimationFrame(r));
            cam.zoom = zoom;
            const [ux, uy] = cam.screenDeltaToWorld(0, -1);
            const l = Math.hypot(ux, uy) || 1;
            const dir = [ux / l, uy / l];
            const sc = RR.scene;
            const home = [S.origin[0] + cam.target[0], S.origin[1] * ROW_H + cam.target[1]];
            const along = () => (S.origin[0] + cam.target[0] - home[0]) * dir[0] + (S.origin[1] * ROW_H + cam.target[1] - home[1]) * dir[1];
            let sign = 1;
            sc.pan = { speed: v, dir: [...dir], t: 0, turnAt: 0, turnBy: 0, turned: 0, asked: 0 };
            const steer = () => {
              if (mode !== 'pool') return;
              const off = along();
              if (off > 192 && sign > 0) sign = -1;
              else if (off < 0 && sign < 0) sign = 1;
              sc.pan.dir = [dir[0] * sign, dir[1] * sign];
            };
            {
              const t0 = performance.now();
              while (performance.now() - t0 < (mode === 'pool' ? 6000 : 1000)) {
                await frame();
                steer();
              }
            }
            const R0 = S.R;
            const regs = new Map();
            const reg = (key) => {
              let r = regs.get(key);
              if (!r) regs.set(key, (r = { key, exposed: 0, exposedMs: 0 }));
              return r;
            };
            const now = () => performance.now();
            const origStart = S.startJob;
            const origReady = S.ready;
            S.startJob = function (key, job) {
              const r = reg(key);
              r.asked ??= now();
              return origStart.call(this, key, job);
            };
            S.ready = function (key, f) {
              const r = reg(key);
              r.made ??= now();
              return origReady.call(this, key, f);
            };
            const keyOf = (lx, ly) => S.key((S.origin[0] + lx) / R0, (S.origin[1] + ly) / R0);
            const tracked = new Set();
            let last = now();
            const t0 = now();
            try {
              while (now() - t0 < secs * 1000) {
                await frame();
                steer();
                const t = now();
                const dt = t - last;
                last = t;
                const un = S.unwritten.map(([x, y]) => keyOf(x, y));
                for (const k of un) {
                  const r = reg(k);
                  r.slid ??= t;
                  tracked.add(k);
                }
                const [nx, ny] = fm.chunkGrid;
                const go = ren.gridOn;
                const gv = ren.gridView;
                const m = cam.viewProj;
                const W = S.W;
                const H = S.H;
                for (let ly = 0; ly < H; ly += R0)
                  for (let lx = 0; lx < W; lx += R0) {
                    const k = keyOf(lx, ly);
                    if (!tracked.has(k)) continue;
                    const r = regs.get(k);
                    const isUn = un.includes(k);
                    if (!isUn && r.slid && !r.written) {
                      r.written = t;
                      r.wTick = RR.core.sim.tick;
                    }
                    if (r.written && !S.busy) r.idle ??= t;
                    // its chunks
                    let on = 0;
                    let any = false;
                    let lo = Infinity;
                    let hi = -Infinity;
                    for (let q = 0; q < 4; q++) {
                      const cx = lx / 32 + (q & 1);
                      const cy = ly / 32 + (q >> 1);
                      const c = cy * nx + cx;
                      const g = go && go.on[c];
                      const mb = fm.built.length === nx * ny && fm.builtSlides === fm.slides && fm.built[c] && (!fm.wanted || fm.wanted[c]);
                      if (!isUn && (g || mb)) on++;
                      if (!isUn && g) any = true;
                      if (go && !isUn && go.hi[c] > 0) {
                        lo = Math.min(lo, go.lo[c]);
                        hi = Math.max(hi, go.hi[c]);
                      }
                    }
                    if (any && r.gridOn === undefined) {
                      r.gridOn = t;
                      r.gTicks = RR.core.sim.tick - (r.wTick ?? 0);
                    }
                    if (on === 4) r.allOn ??= t;
                    if (!(lo <= hi)) {
                      lo = 0;
                      hi = RR.core.dims.zMax;
                    }
                    // on the screen: its box's corners' clip rect against the screen
                    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
                    for (let q = 0; q < 8; q++) {
                      const X = lx + (q & 1 ? R0 : 0);
                      const Y = (ly + (q & 2 ? R0 : 0)) * ROW_H;
                      const Z = q & 4 ? hi : lo;
                      const px = m[0] * X + m[4] * Y + m[8] * Z + m[12];
                      const py = m[1] * X + m[5] * Y + m[9] * Z + m[13];
                      x0 = Math.min(x0, px); x1 = Math.max(x1, px); y0 = Math.min(y0, py); y1 = Math.max(y1, py);
                    }
                    const seen = x1 >= -1 && x0 <= 1 && y1 >= -1 && y0 <= 1;
                    const [rx, ry] = k.split(',').map(Number);
                    const tile = TL.drawsRegion(rx, ry) || TL.drawsAt(lx + 1, ly + 1);
                    if (tile) r.tile ??= t;
                    if (seen) r.seen ??= t;
                    if (seen && on < 4 && !tile) {
                      r.exposed++;
                      r.exposedMs += dt;
                    }
                  }
              }
            } finally {
              S.startJob = origStart;
              S.ready = origReady;
              sc.pan = null;
            }
            const rows = [...regs.values()].filter((r) => r.slid);
            const rel = (r, k) => (r[k] === undefined ? null : Math.round(r[k] - r.slid));
            const list = rows.map((r) => ({ key: r.key, asked: rel(r, 'asked'), made: rel(r, 'made'), written: rel(r, 'written'), idle: rel(r, 'idle'), gTicks: r.gTicks ?? null, gridOn: rel(r, 'gridOn'), allOn: rel(r, 'allOn'), tile: rel(r, 'tile'), seen: rel(r, 'seen'), exposedFrames: r.exposed, exposedMs: Math.round(r.exposedMs) }));
            const med = (k) => {
              const a = list.map((x) => x[k]).filter((x) => x !== null).sort((a, b) => a - b);
              return a.length ? { p50: a[Math.floor(a.length / 2)], max: a[a.length - 1], n: a.length } : null;
            };
            return { zoom, speed: v, mode, regions: list.length, links: { asked: med('asked'), made: med('made'), written: med('written'), idle: med('idle'), gTicks: med('gTicks'), gridOn: med('gridOn'), allOn: med('allOn'), tile: med('tile'), seen: med('seen'), exposedMs: med('exposedMs') }, list };
          },
          zoom,
          v,
          mode,
          secs,
        );
        out.push(res);
        console.log(JSON.stringify({ ...res, list: undefined }));
        for (const r of res.list) console.log('   ', JSON.stringify(r));
        await R.simSeconds(p, 3);
      }
  const jf = R.opt('json', null);
  if (jf) fs.writeFileSync(jf, JSON.stringify(out, null, 1));
});
