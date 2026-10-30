// Round 113 (tilesfirst): where the background shows while panning, and why — the pixel check (render/bgcheck.ts,
// ?bgcheck=1) is the ground truth; for each frame it samples, every background sample's place on the ground is
// classified by what the CPU knew of it that frame:
//   out        past the window: no tile drawn there (tile-missing) or a tile drawn and still the background (tile-drawn)
//   unwritten  in the window, its region slid in but its land not written yet (Streamer.unwritten)
//   unbuilt    in the window, written, its mesh chunk neither built (FieldMesh.built, read back every frame here) nor
//              the hybrid grid's — and no tile drawn: with a tile there ('+tile'), or the region's tile made but not
//              drawn ('+held': kept, not drawn as the region's inside the window), or no tile at all ('+none')
//   built      in the window, its chunk built or the grid's (the mirror says so) and still the background
//   stale      the mirror's from before the last slide (FieldMesh.builtSlides != slides): not judged
// The phone proxy by default: 412x915 at dpr 2.6, q=low, a Pixel's user agent, window 256, the pan bench's flags.
//   node scripts/holediag.mjs [--zoom 14] [--speeds 40,80] [--mode pool|line] [--secs 3] [--win 256] [--extra "&x=1"]
//     [--screen phone|desktop] [--json out.json]
import { run } from './lib/runner.mjs';
import fs from 'node:fs';

const UA = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Mobile Safari/537.36';
const BENCH = 'tufts=0&shadowcache=4&prepevery=2&bandh=2&shadowsize=512&hybrid=1&settle=0&inplace=1&sleepmore=1&hitch=1&hitchhud=0';

await run({ name: 'holediag', kind: 'behaviour', size: '412x915', dpr: 2.6 }, async (R) => {
  const zooms = R.opt('zoom', '14').split(',').map(Number);
  const speeds = R.opt('speeds', '40,80').split(',').map(Number);
  const modes = R.opt('mode', 'pool,line').split(',');
  const secs = Number(R.opt('secs', 3));
  const win = Number(R.opt('win', 256));
  const screen = R.opt('screen', 'phone');
  const extra = R.opt('extra', '');
  const out = [];
  const phone = screen === 'phone';
  const p = await R.page(phone ? { size: '412x915', dpr: 2.6 } : { size: '1600x900', dpr: 1 });
  if (phone) {
    await p.setViewport({ width: 412, height: 915, deviceScaleFactor: 2.6, hasTouch: true, isMobile: true });
    await p.setUserAgent(UA);
  }
  if (Number(R.opt('throttle', 0)) > 1) await (await p.createCDPSession()).send('Emulation.setCPUThrottlingRate', { rate: Number(R.opt('throttle', 0)) });
  const params = Object.fromEntries(new URLSearchParams(`${BENCH}&level=atlas&at=15024,14337&win=${win}&bgcheck=1&worldsave=0&tod=0.42&day=100000&season=0.3${extra}`));
  await R.level(params, { page: p, noDefaultQ: !phone });
  // (the first load's own work done: the window's land, its meshes, the tiles round it)
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
            const BG = RR.renderer.bgCheck;
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
            // (pool: a leg there and back first — what comes in then is in the pool)
            if (mode === 'pool') {
              const t0 = performance.now();
              while (performance.now() - t0 < 6000) {
                await frame();
                steer();
              }
            } else {
              const t0 = performance.now();
              while (performance.now() - t0 < 1000) await frame();
            }
            // (the state as the frame the snapshot is copied from was encoded)
            const orig = BG.encode;
            let pending = null;
            let state = null;
            BG.encode = function (enc, depth, pick, ts) {
              if (this.snapWanted.length && !this.snapCopied.length) {
                const grid = TL.host.gridOn?.();
                const [nx, ny, ch] = fm.chunkGrid;
                state = {
                  m: Array.from(cam.viewProj),
                  tz: cam.target[2],
                  tgt: [cam.target[0], cam.target[1]],
                  W: S.W,
                  H: S.H,
                  R: S.R,
                  origin: [...TL.origin],
                  un: S.unwritten.map((u) => [...u]),
                  built: fm.built.slice(),
                  stale: fm.builtSlides !== fm.slides || fm.built.length !== nx * ny,
                  grid: grid ? grid.slice() : null,
                  hi: RR.renderer.gridOn ? RR.renderer.gridOn.hi.slice() : null,
                  zMax: RR.core.dims.zMax,
                  inView: fm.inView ? fm.inView.slice() : null,
                  gridView: RR.renderer.gridView ? RR.renderer.gridView.slice() : null,
                  wanted: fm.wanted ? fm.wanted.slice() : null,
                  nx,
                  ny,
                  ch,
                  drawn: new Set(TL.drawnSet),
                  tiles: new Set([...TL.tiles.values()].filter((t) => Math.round(t.az * 1e4) === Math.round(cam.azimuth * 1e4)).map((t) => `${t.rx},${t.ry}`)),
                  geo: TL.coverCheck ? TL.coverCheck(cam) : null,
                  geoWhy: (() => {
                    const g = TL.coverCheck ? TL.coverCheck(cam) : null;
                    if (!g || g.share < 0.02) return null;
                    return g.undrawn.slice(0, 8).map((u) => {
                      if (u[0] !== 'r') return u;
                      const [rx, ry] = u.slice(1).split(',').map(Number);
                      const t = [...TL.tiles.values()].find((t) => t.rx === rx && t.ry === ry);
                      return `${u}:${t ? `tile skip=${t.skip} boxed=${t.boxed} az=${Math.round(t.az * 1e4) === Math.round(cam.azimuth * 1e4)} q=${t.q}` : TL.land.stateOf(`${rx},${ry}`) || 'none'}`;
                    });
                  })(),
                  busy: S.busy,
                  slides: S.stats.slides,
                  frame: TL.frameNo,
                };
              }
              return orig.call(this, enc, depth, pick, ts);
            };
            const agree = { n: 0, pxSum: 0, geoSum: 0, pxMax: 0, geoMax: 0, missed: 0, extra: 0, both: 0, pairs: [] };
            const geoEx = [];
            const agg = {};
            const worst = {};
            let frames = 0;
            let bgFrames = 0;
            let bgSum = 0;
            let bgMax = 0;
            let sampleN = 0;
            const examples = [];
            const take = async () => {
              const snap = await BG.snapshot();
              const s = state;
              if (!s) return;
              const { cols, rows, cls } = snap;
              sampleN = cols * rows;
              const m = s.m;
              // (clip x, y of a ground point at the target's height: X, Y solved from the matrix's two rows)
              const a = m[0], b = m[4], c = m[1], d = m[5];
              const det = a * d - b * c;
              const cnt = {};
              const chunkHits = {};
              let nb = 0;
              for (let j = 0; j < rows; j++)
                for (let i = 0; i < cols; i++) {
                  const cl = cls[j * cols + i];
                  if (cl === 0) continue;
                  nb++;
                  const cx = ((i + 0.5) / cols) * 2 - 1;
                  const cy = 1 - ((j + 0.5) / rows) * 2;
                  // (the view's ray through the sample, marched down from the window's top: the first chunk whose
                  // highest column top it's under — the land it would show; past the window, where it leaves it)
                  const at = (z) => {
                    const rx = cx - m[8] * z - m[12];
                    const ry = cy - m[9] * z - m[13];
                    return [(d * rx - b * ry) / det, (a * ry - c * rx) / det / ROW_H];
                  };
                  let x, y;
                  {
                    let hitAt = null;
                    let lastIn = null;
                    for (let z = s.zMax; z >= 0; z -= 1) {
                      const [px, py] = at(z);
                      if (px < 0 || px >= s.W || py < 0 || py >= s.H) continue;
                      lastIn = [px, py];
                      const cc = Math.min(s.ny - 1, Math.floor(py / s.ch)) * s.nx + Math.min(s.nx - 1, Math.floor(px / s.ch));
                      if (s.hi && z <= s.hi[cc]) {
                        hitAt = [px, py];
                        break;
                      }
                    }
                    [x, y] = hitAt ?? (lastIn ? at(s.tz) : at(s.tz));
                  }
                  const reg = `${Math.floor((x + s.origin[0]) / s.R)},${Math.floor((y + s.origin[1]) / s.R)}`;
                  const tileTag = s.drawn.has(reg) ? '+tile' : s.tiles.has(reg) ? '+held' : '+none';
                  let k;
                  if (x < 0 || x >= s.W || y < 0 || y >= s.H) k = s.drawn.has(reg) ? 'out+tile' : s.tiles.has(reg) ? 'out+held' : 'out+none';
                  else if (s.un.some(([ux, uy]) => ux === Math.floor(x / s.R) * s.R && uy === Math.floor(y / s.R) * s.R)) k = `unwritten${tileTag}`;
                  else if (s.stale) k = `stale${tileTag}`;
                  else {
                    const ci = Math.min(s.nx - 1, Math.floor(x / s.ch));
                    const cj = Math.min(s.ny - 1, Math.floor(y / s.ch));
                    const cc = cj * s.nx + ci;
                    const g = s.grid && s.grid[cc];
                    const mb = s.built[cc];
                    const how = g ? (s.gridView && !s.gridView[cc] ? 'grid-culled' : 'grid') : mb ? (s.inView && !s.inView[cc] ? 'mesh-culled' : 'mesh') : '';
                    if (how) chunkHits[cc] = (chunkHits[cc] ?? 0) + 1;
                    k = how ? `built:${how}${s.wanted ? (s.wanted[cc] ? ':w' : ':nw') : ''}${tileTag}` : `unbuilt${s.wanted ? (s.wanted[cc] ? ':w' : ':nw') : ''}${tileTag}`;
                  }
                  if (cl === 2) k = `far:${k}`;
                  if (cl === 3) k = `farland:${k}`;
                  cnt[k] = (cnt[k] ?? 0) + 1;
                }
              frames++;
              // (the geometric check on the same frame: its undrawn share against the pixels' holes)
              if (s.geo) {
                const px = nb / sampleN;
                const g = s.geo.share;
                agree.n++;
                agree.pxSum += px;
                agree.geoSum += g;
                agree.pxMax = Math.max(agree.pxMax, px);
                agree.geoMax = Math.max(agree.geoMax, g);
                if (px > 0.005 && g < 0.001) agree.missed++;
                if (g > 0.005 && px < 0.001) agree.extra++;
                if (px > 0.001 && g > 0.001) agree.both++;
                agree.pairs.push([+px.toFixed(4), +g.toFixed(4)]);
              }
              if (nb) {
                bgFrames++;
                bgSum += nb;
                bgMax = Math.max(bgMax, nb);
                let probe = null;
                const top = Object.entries(chunkHits).sort((a, b) => b[1] - a[1])[0];
                if (top && top[1] > sampleN * 0.02 && examples.length < 6) {
                  const cc = Number(top[0]);
                  const surf = new Uint32Array((await RR.core.readBuffer('surface')).buffer);
                  const ci = cc % s.nx, cj = Math.floor(cc / s.nx);
                  let zlo = 1e9, zhi = -1e9, zero = 0;
                  for (let y = cj * s.ch; y < (cj + 1) * s.ch; y++)
                    for (let x = ci * s.ch; x < (ci + 1) * s.ch; x++) {
                      const w = surf[y * s.W + x];
                      const z = (w & 0x1ffff) / 256;
                      if (w === 0) zero++;
                      zlo = Math.min(zlo, z);
                      zhi = Math.max(zhi, z);
                    }
                  const go = RR.renderer.gridOn;
                  probe = { chunk: [ci, cj], hits: top[1], surfLoHi: [+zlo.toFixed(1), +zhi.toFixed(1)], zero, gridLoHi: go ? [+go.lo[cc].toFixed(1), +go.hi[cc].toFixed(1)] : null, camZ: +s.tz.toFixed(1), framesSince: TL.frameNo - s.frame };
                }
                if (s.geoWhy && geoEx.length < 4) geoEx.push({ px: +(nb / sampleN).toFixed(4), geo: +s.geo.share.toFixed(4), why: s.geoWhy, origin: s.origin.slice(0, 2), tgt: s.tgt });
                if (examples.length < 6 && nb > sampleN * 0.02) examples.push({ probe, frame: s.frame, share: +(nb / sampleN).toFixed(3), cnt, busy: s.busy, slides: s.slides, tgt: s.tgt.map((q) => +q.toFixed(1)), un: s.un, drawn: [...s.drawn].length });
              }
              for (const k in cnt) {
                agg[k] = (agg[k] ?? 0) + cnt[k];
                worst[k] = Math.max(worst[k] ?? 0, cnt[k]);
              }
            };
            BG.take();
            const t0 = performance.now();
            const sl0 = S.stats.slides;
            try {
              while (performance.now() - t0 < secs * 1000) {
                const tk = take();
                // (steering every frame while the snapshot's readback is under way)
                let done = false;
                tk.then(() => (done = true));
                while (!done) {
                  await frame();
                  steer();
                }
              }
            } finally {
              BG.encode = orig;
              sc.pan = null;
            }
            await BG.sync();
            const tot = BG.take();
            const n = Math.max(1, frames) * sampleN;
            const r = (q) => +q.toFixed(4);
            const share = {};
            for (const k in agg) share[k] = { mean: r(agg[k] / n), worst: r(worst[k] / sampleN) };
            return {
              zoom,
              speed: v,
              mode,
              sampledFrames: frames,
              bgFramesSampled: bgFrames,
              bgMeanSampled: r(bgSum / n),
              bgMaxSampled: r(bgMax / sampleN),
              bgcheckAll: { frames: tot.frames, framesAny: tot.bg.framesAny, mean: r(tot.bg.sum / Math.max(1, tot.frames) / tot.samples), max: r(tot.bg.max / tot.samples) },
              slides: S.stats.slides - sl0,
              share,
              agree: { frames: agree.n, pxMean: r(agree.pxSum / Math.max(1, agree.n)), geoMean: r(agree.geoSum / Math.max(1, agree.n)), pxMax: r(agree.pxMax), geoMax: r(agree.geoMax), missed: agree.missed, extra: agree.extra, both: agree.both, corr: (() => {
                const P = agree.pairs;
                if (P.length < 3) return null;
                const mx = P.reduce((a, p) => a + p[0], 0) / P.length;
                const my = P.reduce((a, p) => a + p[1], 0) / P.length;
                let sxy = 0, sxx = 0, syy = 0;
                for (const [x, y] of P) { sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; syy += (y - my) ** 2; }
                return sxx > 0 && syy > 0 ? +(sxy / Math.sqrt(sxx * syy)).toFixed(3) : null;
              })() },
              examples,
              geoEx,
            };
          },
          zoom,
          v,
          mode,
          secs,
        );
        out.push(res);
        console.log(JSON.stringify(res));
        // (back where it was: the next run starts at rest)
        await R.simSeconds(p, 3);
      }
  const jf = R.opt('json', null);
  if (jf) fs.writeFileSync(jf, JSON.stringify(out, null, 1));
});
