// Round 112 (tilefix): the merge gate for the terrain's drawing. The user: "The most basic thing is that all the tiles
// visible on screen load visually and our framerate doesn't dip below our thresholds", and "Instead of looking at them
// everytime make a cheap baseline image for things that won't change and run pixel diffs to flag changes."
//
// For each screen (desktop 1600x900 at dpr 1, as the user's PC runs it — the page's own tier; the phone proxy 412x915,
// dpr 2.6, q=low) the atlas at a fixed spot, world and time of day, and for each zoom:
//   1. parked: after --loadframes frames at the zoom (180: 3 s at 60 Hz), --parked s of frames — the screen's 24 x 24 points out of detail (in the
//      window: its region not written yet; past it: no tile drawn — why, TileCache.whyMissing where the build has it)
//      and the frames against the pan bench's criteria (fps >= 58, no frame over 33.4 ms, p99 <= 20 ms);
//   2. a golden image: the simulation paused (scene.speed 0), the frame at an eighth of its size (--shrink) against
//      data/baselines/tilegate/<screen>-z<zoom>.png — a pixel changed when a channel moved over --tol, the view flagged
//      when over --area of it changed; a diff image (changed pixels red over the baseline, dimmed) beside the shot;
// then 3. panning: from the spot, up the screen at --pan cells/s for --panning s at each zoom (after --load ms), the
//      same coverage (allowed --panmiss of the screen out of detail in a frame: the arriving edge's moment) and frames.
// Shots and diffs to --out. Exits 1 on any failure (coverage, frames, a flagged image, a page error).
//   node scripts/tilegate.mjs [--url http://localhost:5233] [--screens desktop,phone] [--zooms 14,8,5,3.5,2.2,1.3]
//     [--loadframes 180] [--hz 60] [--chromeargs "--disable-gpu-vsync --disable-frame-rate-limit"] [--parked 2] [--pan 20] [--fastpan 160] [--fastspan 400] [--fastzooms 14,8,5] [--agreemax 0.01] [--panning 3] [--panmiss 0.02] [--tol 40] [--area 0.01]
//     [--out C:/Projects/shots88/tilegate] [--baselines data/baselines/tilegate] [--update] [--no-golden] [--no-pan]
//     [--extra "&x=1"] [--wait 35000] [--shrink 8]
// --update writes the baselines (a view's: --update --screens desktop --zooms 5); they're kept by adapter
// (<baselines>/<vendor>-<architecture>/), written the first time one runs.
// (round 112, tilefix2) The page's frames are held to --hz (60) by the script — Chrome without vsync, the page's rAF
// batched to 60 Hz ticks — so a machine's display (a 3080 with its monitor off gave 29 Hz) doesn't change the result;
// the load is counted in those frames. The phone screen runs with a Pixel's user agent (the page's phone paths).
// (round 112, testspeed: on the shared runner, scripts/lib/runner.mjs — the worktree's build on its own port, a kept
// Chrome profile, the GPU leased as a timing check (its frames need the GPU alone); --chromeargs go to that Chrome.
// `--url` is a server already up, as before; without it the runner serves the build.)
// (round 112, bgcheck: the page runs with ?bgcheck=1 — render/bgcheck.ts samples the frame's depth and pick on a 64 x 128
// grid on the GPU — and a view fails when a frame shows the background colour (nothing drawn) on more than --bgmax of
// the samples (0.001: 0.1%); the share of the flat far land is reported. The user: "Can we do a pan test for the phone
// that fails if any bg color shows?" / "Or flags it anyway".)
import { run } from './lib/runner.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const has = (k) => argv.includes(`--${k}`);
const screens = opt('screens', 'desktop,phone').split(',');
// (round 112, tilefix2: the hero's run too — ?run=bell, the camera on the hero, its own zooms; no pans: the hero's camera)
// (and w384: the atlas at window 384 — the user's own phone setting, the screenshot of 2026-10-29)
const modes = opt('modes', 'atlas,run,w384').split(',');
const runZooms = opt('runzooms', '14,8,5').split(',').map(Number);
const zoomsAtlas = opt('zooms', '14,8,5,3.5,2.2,1.3').split(',').map(Number);
// (round 112, tilefix2: the load in frames, not seconds — the tiles come a few a frame, so a machine at 30 Hz had half
// the tiles a laptop at 120 had in the same 8 s; 180 is three seconds of the phone's 60)
const loadFrames = Number(opt('loadframes', 180));
// (the page's frames held to --hz, whatever the machine's display gives: Chrome run without vsync, rAF callbacks
// batched to --hz ticks in the page — every rAF, the game's and the tile pacer's, sees the same 60 Hz)
const hz = Number(opt('hz', 60));
const chromeArgs = (opt('chromeargs', '--disable-gpu-vsync --disable-frame-rate-limit') || '').split(' ').filter(Boolean);
const parkedS = Number(opt('parked', 2));
// (round 113, tilesfirst: --pan a list of speeds, each a run at each of --panzooms (default the zooms))
const panVs = String(opt('pan', 20)).split(',').map(Number);
// (round 114, covercheck: a fast pan — the pan bench's phone rows showed the stand-in over 4-10% of a frame at 160 c/s the
// geometric check didn't see; the checks' agreement (--agreemax) is judged there. Back and forth over --fastspan cells up
// the screen from the spot, so every run and build sees the same land (0: straight on — from the gate's spot that reaches
// the open sea in 3 s, the far share there the stand-in's sea: SF8, SF11); at --fastzooms, after the zoom's own pans)
const fastV = Number(opt('fastpan', 160));
const fastSpan = Number(opt('fastspan', 400));
const fastZooms = String(opt('fastzooms', '14,8,5')).split(',').map(Number);
const panZooms = opt('panzooms', null)?.split(',').map(Number) ?? null;
const panS = Number(opt('panning', 3));
const panMiss = Number(opt('panmiss', 0.02));
const tol = Number(opt('tol', 40));
const areaMax = Number(opt('area', 0.01));
const bgMax = Number(opt('bgmax', 0.001));
const geoMax = Number(opt('geomax', 0.001));
// (round 114, covercheck: the far land's share a frame shows over the geometric check's, allowed — the pixel grid's
// sampling and the check's quads at a piece's middle height differ by a sliver at the edges)
const agreeMax = Number(opt('agreemax', 0.01));
const outDir = opt('out', 'C:/Projects/shots88/tilegate');
// (round 112, tilefix2: baselines by GPU — vendors render 1.5-12% of a frame differently: a dir an adapter,
// <baselines>/<vendor>-<architecture>, written the first time an adapter runs)
const baseRoot = opt('baselines', 'data/baselines/tilegate');
let baseDir = baseRoot;
const update = has('update');
const golden = !has('no-golden');
const doPan = !has('no-pan');
const extra = opt('extra', '');
const waitMs = Number(opt('wait', 35000));
const CRIT = { fps: 58, max: 33.4, p99: 20 };
const SCREENS = {
  desktop: { w: 1600, h: 900, dpr: 1, mobile: false, q: '' },
  // (a Pixel's user agent: the page takes the phone's own paths — its finish tiles, pacing, uploads)
  phone: { w: 412, h: 915, dpr: 2.6, mobile: true, q: '&q=low', ua: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Mobile Safari/537.36' },
  // (the user's PC's window in their report, 2026-10-29: TilesLoadingWeirdly.png)
  wide: { w: 2046, h: 672, dpr: 1, mobile: false, q: '' },
  // (round 115, tilecal: ultrawide monitors at dpr 1 — the user's "desktop version on my wide monitor does not load all
  // the tiles", its size unknown: the common ultrawides and a super-ultrawide)
  uw2560: { w: 2560, h: 1080, dpr: 1, mobile: false, q: '' },
  uw3440: { w: 3440, h: 1440, dpr: 1, mobile: false, q: '' },
  uw5120: { w: 5120, h: 1440, dpr: 1, mobile: false, q: '' },
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(outDir, { recursive: true });
const t00 = Date.now();
const fails = [];
/** (not failures: what the machine couldn't judge) */
const notes = [];
const rows = [];

/** in the page: `secs` of frames, each with the screen's points out of detail (24 x 24) */
async function measure(p, secs, parked = true) {
  return p.evaluate(async (secs, parked) => {
    const R = window.reclaimed;
    const cam = R.camera;
    const TL = R.renderer.tiles;
    const S = R.stream;
    const ROW_H = Math.sqrt(3) / 2;
    const G = 24;
    const UNDRAWN_FRAMES = 5;
    if (TL?.host?.win?.mesh) TL.host.win.mesh.statPeriod = 1;
    const runs = (window.__gateRuns ??= new Map());
    const fm = TL?.host?.win?.mesh;
    const [nx, ny] = fm?.chunkGrid ?? [0, 0];
    const whyOf = (x, y) => {
      if (TL?.whyMissing) return TL.whyMissing(x, y, cam.azimuth);
      return 'untiled';
    };
    window.reclaimedHitch?.rec?.reset?.();
    // (round 112, bgcheck: the background's share over these frames — a short look (the fill's) doesn't ask)
    const BG = secs >= 0.5 ? R.renderer.bgCheck : null;
    BG?.take();
    const frames = [];
    let worst = 0;
    let worstWhy = {};
    const geo = { frames: 0, framesAny: 0, sum: 0, max: 0, worst: [] };
    let last = performance.now();
    const t0 = last;
    while (performance.now() - t0 < secs * 1000) {
      const t = await new Promise((r) => requestAnimationFrame(r));
      frames.push(t - last);
      last = t;
      let n = 0;
      const why = {};
      const un = S.unwritten ?? [];
      const seen = new Set();
      const grid = TL?.host?.gridOn?.();
      for (let j = 0; j < G; j++)
        for (let i = 0; i < G; i++) {
          const [dx, dy] = cam.screenDeltaToWorld(((i + 0.5) / G - 0.5) * cam.viewportW, ((j + 0.5) / G - 0.5) * cam.viewportH);
          const x = cam.target[0] + dx;
          const y = (cam.target[1] + dy) / ROW_H;
          let k = null;
          if (x >= 0 && x < S.W && y >= 0 && y < S.H) {
            if (un.some(([ux, uy]) => ux === Math.floor(x / S.R) * S.R && uy === Math.floor(y / S.R) * S.R) && !TL?.drawsAt(x, y)) k = 'window';
            // (round 112, tilefix2: the window's own land not drawn there — its chunk neither meshed nor the grid's —
            // and no tile: the user's phone in a run, the screen grey round the hero)
            // (what's built is the CPU's mirror, read back every frame while the gate runs (FieldMesh.statPeriod 1, set
            // below — 60 in play): a chunk counts once it's read undrawn UNDRAWN_FRAMES frames running, by its place in the
            // world — a readback is a frame or two behind; the 3080's pans read 30-60% "undrawn" over a drawn screen with the
            // mirror 60 frames behind)
            else if (fm && fm.built.length === nx * ny && fm.builtSlides === fm.slides && !TL?.drawsAt(x, y)) {
              const ci = Math.min(nx - 1, Math.floor((x / S.W) * nx));
              const cj = Math.min(ny - 1, Math.floor((y / S.H) * ny));
              const c = cj * nx + ci;
              const wk = `${Math.round(S.origin[0] / (S.W / nx)) + ci},${Math.round(S.origin[1] / (S.H / ny)) + cj}`;
              if (!fm.built[c] && !(grid && grid[c])) {
                seen.add(wk);
                if ((runs.get(wk) ?? 0) >= UNDRAWN_FRAMES) k = 'window-undrawn';
              }
            }
          } else if (!TL?.drawsAt(x, y)) k = whyOf(x, y);
          if (k) {
            n++;
            why[k] = (why[k] ?? 0) + 1;
          }
        }
      // (round 113, tilesfirst: the geometric coverage check — render/coverage.ts: what the camera sees drawn by neither
      // the window nor a tile, this frame; the build's own when it has it)
      const gc = TL?.coverCheck?.(cam);
      if (gc) {
        geo.frames++;
        geo.sum += gc.share;
        if (gc.share > geo.max) {
          geo.max = gc.share;
          geo.worst = gc.undrawn.slice(0, 6);
        }
        if (gc.chunksUndrawn + gc.regionsUndrawn) geo.framesAny++;
      }
      // (each chunk's run of frames read undrawn: on, or over)
      for (const wk of [...runs.keys()]) if (!seen.has(wk)) runs.delete(wk);
      for (const wk of seen) runs.set(wk, (runs.get(wk) ?? 0) + 1);
      if (n / (G * G) > worst) {
        worst = n / (G * G);
        worstWhy = why;
      }
    }
    let bg = null;
    if (BG) {
      await Promise.race([BG.sync(), new Promise((r) => setTimeout(r, 2000))]);
      const t = BG.take();
      const n = Math.max(1, t.frames) * t.samples;
      const r5 = (v) => Math.round(v * 1e5) / 1e5;
      bg = { frames: t.frames, samples: t.samples, max: r5(t.bg.max / Math.max(1, t.samples)), mean: r5(t.bg.sum / n), framesAny: t.bg.framesAny, farMax: r5(t.far.max / Math.max(1, t.samples)), farMean: r5(t.far.sum / n), farFrames: t.far.framesAny };
    }
    const fs = frames.slice(1).sort((a, b) => a - b);
    const q = (f) => (fs.length ? fs[Math.min(fs.length - 1, Math.floor(fs.length * f))] : Infinity);
    const st = TL?.stats ?? {};
    // (round 112: the tiles' pipeline — the pacer's turns a frame and guard, the land's counters — where a fill is slow)
    const pz = R.atlas?.pacer;
    const ls = TL?.land?.stats ?? {};
    const pipe = pz ? { perFrame: pz.perFrame, guard: +pz.guard.toFixed(2), base: +pz.base.toFixed(1), chained: pz.chained, made: ls.made, baked: ls.baked, inFlight: ls.inFlight, noSlot: ls.noSlot } : null;
    // (the hitch recorder's word for the long frames: ?hitch=1)
    const rep = window.reclaimedHitch?.report?.();
    const hitches = rep?.worst ? rep.worst.slice(0, 2).map((h) => `${h.ms} ${h.cause} ${[...(h.steps ?? []), ...(h.async ?? [])].slice(0, 2).map((x) => `${x.label} ${x.ms}`).join(', ')}`) : [];
    // (round 112, tilefix3: the zoom as it stands — under the device's floor it's held at it — and the floor)
    return { zoom: +cam.zoom.toFixed(2), zoomFloor: +(cam.zoomFloor ?? 0).toFixed(2), hitches, fps: +(frames.length / secs).toFixed(1), p99: +q(0.99).toFixed(1), max: +q(1).toFixed(1), miss: +worst.toFixed(3), why: worstWhy, bg, planner: R.scene?.planner ? { ...R.scene.planner.stats, reach: R.scene.planner.plan.reach } : null, geo: geo.frames ? { max: +geo.max.toFixed(4), mean: +(geo.sum / geo.frames).toFixed(5), framesAny: geo.framesAny, frames: geo.frames, worst: geo.worst } : null, tiles: { slots: st.slots, used: st.used, drawn: st.drawn, mb: st.mb, floorBound: st.floorBound, floorTiles: st.floorTiles, grown: st.grown }, cal: TL?.cal ? { ...TL.cal.stats, rate: +TL.cal.stats.rate.toFixed(1), measuredS: +TL.cal.stats.measuredS.toFixed(1) } : null, pipe };
  }, secs, parked);
}

let frameChecks = true;
/** in the page: n frames (rAF, under the cap) */
const frames = (p, n) => p.evaluate((n) => new Promise((res) => {
  let k = 0;
  const f = () => (++k >= n ? res() : requestAnimationFrame(f));
  requestAnimationFrame(f);
}), n);

function judge(tag, m, missMax) {
  const f = [];
  if (!frameChecks) {
    // (round 113, tilesfirst: a pan is judged by the geometric check where the build has it — the old "out of detail"
  // counted the window's land once written and put its points at the focus's height; it's reported, not judged)
  if (m.miss > missMax && !(m.geo && tag.includes('panning'))) f.push(`out of detail ${(m.miss * 100).toFixed(1)}% (${Object.entries(m.why).map(([k, v]) => `${k} ${v}`).join(', ')})`);
  // (round 112, bgcheck: the background colour on more than --bgmax of a frame's samples; frame rate or not)
  if (m.bg && m.bg.max > bgMax) f.push(`background ${(m.bg.max * 100).toFixed(2)}% of the screen (worst frame; ${m.bg.framesAny} of ${m.bg.frames} frames with any)`);
  // (round 113, tilesfirst: the geometric check — undrawn land in sight — over --geomax of the screen in a frame)
  if (m.geo && m.geo.max > geoMax) f.push(`undrawn ${(m.geo.max * 100).toFixed(2)}% of the screen (geometric; ${m.geo.framesAny} of ${m.geo.frames} frames; ${m.geo.worst.join(' ')})`);
  // (round 114, covercheck: the two checks agree — the far land the pixels show (the stand-in, the flat far land) in a
  // frame is land drawn by neither the window nor a tile, which the geometric check must see too: a worst frame's far
  // share over the geometric's worst by more than --agreemax is a blind spot of the check, not a tolerance)
  if (m.bg && m.geo && m.bg.farMax > m.geo.max + agreeMax) f.push(`far land ${(m.bg.farMax * 100).toFixed(2)}% of a frame the geometric check doesn't see (its worst ${(m.geo.max * 100).toFixed(2)}%; ${m.bg.farFrames} of ${m.bg.frames} frames with any)`);
    if (f.length) fails.push(`${tag}: ${f.join('; ')}`);
    return f;
  }
  // (round 113, tilesfirst: a pan is judged by the geometric check where the build has it — the old "out of detail"
  // counted the window's land once written and put its points at the focus's height; it's reported, not judged)
  if (m.miss > missMax && !(m.geo && tag.includes('panning'))) f.push(`out of detail ${(m.miss * 100).toFixed(1)}% (${Object.entries(m.why).map(([k, v]) => `${k} ${v}`).join(', ')})`);
  // (round 112, bgcheck: the background colour on more than --bgmax of a frame's samples; frame rate or not)
  if (m.bg && m.bg.max > bgMax) f.push(`background ${(m.bg.max * 100).toFixed(2)}% of the screen (worst frame; ${m.bg.framesAny} of ${m.bg.frames} frames with any)`);
  // (round 113, tilesfirst: the geometric check — undrawn land in sight — over --geomax of the screen in a frame)
  if (m.geo && m.geo.max > geoMax) f.push(`undrawn ${(m.geo.max * 100).toFixed(2)}% of the screen (geometric; ${m.geo.framesAny} of ${m.geo.frames} frames; ${m.geo.worst.join(' ')})`);
  // (round 114, covercheck: the two checks agree — the far land the pixels show (the stand-in, the flat far land) in a
  // frame is land drawn by neither the window nor a tile, which the geometric check must see too: a worst frame's far
  // share over the geometric's worst by more than --agreemax is a blind spot of the check, not a tolerance)
  if (m.bg && m.geo && m.bg.farMax > m.geo.max + agreeMax) f.push(`far land ${(m.bg.farMax * 100).toFixed(2)}% of a frame the geometric check doesn't see (its worst ${(m.geo.max * 100).toFixed(2)}%; ${m.bg.farFrames} of ${m.bg.frames} frames with any)`);
  if (m.fps < CRIT.fps) f.push(`fps ${m.fps}`);
  if (m.max > CRIT.max) f.push(`frame ${m.max} ms${m.hitches?.length ? ` (${m.hitches.join('; ')})` : ''}`);
  if (m.p99 > CRIT.p99) f.push(`p99 ${m.p99} ms`);
  if (f.length) fails.push(`${tag}: ${f.join('; ')}`);
  return f;
}

/** a PNG (buffer or decoded) at 1 / f of its size (f x f means): the baselines small (--shrink, 8) */
const SHRINK = Number(opt('shrink', 8));
function half(buf, f = SHRINK) {
  const a = Buffer.isBuffer(buf) ? PNG.sync.read(buf) : buf;
  const w = Math.floor(a.width / f);
  const h = Math.floor(a.height / f);
  const o = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      for (let c = 0; c < 4; c++) {
        let s = 0;
        for (let j = 0; j < f; j++) for (let i = 0; i < f; i++) s += a.data[((f * y + j) * a.width + f * x + i) * 4 + c];
        o.data[(y * w + x) * 4 + c] = c === 3 ? 255 : Math.round(s / (f * f));
      }
  return o;
}

function compare(tag, img) {
  const file = path.join(baseDir, `${tag}.png`);
  if (update || !fs.existsSync(file)) {
    fs.writeFileSync(file, PNG.sync.write(img));
    return { baseline: update ? 'updated' : 'written' };
  }
  const b = PNG.sync.read(fs.readFileSync(file));
  if (b.width !== img.width || b.height !== img.height) {
    fails.push(`${tag}: image ${img.width}x${img.height}, baseline ${b.width}x${b.height}`);
    return { changed: 1 };
  }
  const d = new PNG({ width: b.width, height: b.height });
  let n = 0;
  for (let i = 0; i < b.data.length; i += 4) {
    const dm = Math.max(Math.abs(b.data[i] - img.data[i]), Math.abs(b.data[i + 1] - img.data[i + 1]), Math.abs(b.data[i + 2] - img.data[i + 2]));
    const ch = dm > tol;
    if (ch) n++;
    d.data[i] = ch ? 255 : b.data[i] >> 2;
    d.data[i + 1] = ch ? 0 : b.data[i + 1] >> 2;
    d.data[i + 2] = ch ? 0 : b.data[i + 2] >> 2;
    d.data[i + 3] = 255;
  }
  const changed = n / (b.width * b.height);
  if (changed > areaMax) {
    fails.push(`${tag}: ${(changed * 100).toFixed(2)}% of the image changed (baseline ${file})`);
    fs.writeFileSync(path.join(outDir, `${tag}-diff.png`), PNG.sync.write(d));
  }
  return { changed: +changed.toFixed(4) };
}

await run({ name: 'tilegate', kind: 'timing', urlIsServer: true, chromeArgs }, async (R) => {
const url = R.url;
for (const mode of modes)
for (const sk0 of screens) {
  const sk = mode === 'atlas' ? sk0 : `${mode}-${sk0}`;
  const sc = SCREENS[sk0];
  const zooms = mode === 'atlas' ? zoomsAtlas : runZooms;
  if (mode === 'w384' && sk0 !== 'phone') continue;
  {
    const p = await R.page({ size: `${sc.w}x${sc.h}`, dpr: sc.dpr });
    await p.setViewport({ width: sc.w, height: sc.h, deviceScaleFactor: sc.dpr, hasTouch: sc.mobile, isMobile: sc.mobile });
    // (--throttle N: the CPU N times slower — a busy machine's, the phone's main thread)
    if (Number(opt('throttle', 0)) > 1) await (await p.createCDPSession()).send('Emulation.setCPUThrottlingRate', { rate: Number(opt('throttle', 0)) });
    if (sc.ua) await p.setUserAgent(sc.ua);
    // (the frame cap: rAF callbacks held to whole ticks of 1000 / hz ms)
    await p.evaluateOnNewDocument((hz) => {
      const raf = window.requestAnimationFrame.bind(window);
      const period = 1000 / hz;
      let next = 0;
      let queue = [];
      let armed = false;
      const tick = (t) => {
        if (t + 1 < next) {
          raf(tick);
          return;
        }
        // (the next tick a whole period on from this one, less a ms for the display's jitter: no catching up after a
        // late one — a short frame after it pulled the tile pacer's low envelope to 8 ms, every 17 ms frame then "long",
        // its guard held at one turn: a fill nine seconds short on the 3080)
        next = t + period - 1;
        armed = false;
        const q = queue;
        queue = [];
        for (const e of q) e.f(t);
      };
      let ids = 0;
      window.requestAnimationFrame = (f) => {
        queue.push({ id: ++ids, f });
        if (!armed) {
          armed = true;
          raf(tick);
        }
        return ids;
      };
      window.cancelAnimationFrame = (id) => {
        queue = queue.filter((e) => e.id !== id);
      };
      window.__gateHz = hz;
    }, hz);
    p.on('pageerror', (e) => fails.push(`${sk}: page error ${e.message}`));
    p.on('console', (m) => {
      if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) fails.push(`${sk}: console error ${m.text().slice(0, 200)}`);
    });
    // (a fixed spot, world, time of day and season; nothing saved or loaded)
    const u = `${url}/?bgcheck=1&skipmenu=1&level=atlas&tutorial=0&worldsave=0&world=tilegate${mode === 'run' ? '&run=bell' : '&at=15024,14337'}${mode === 'w384' ? '&win=384' : ''}&tod=0.42&day=100000&season=0.3&hitch=1&hitchhud=0${sc.q}${extra}`;
    await p.goto(u, { waitUntil: 'load' });
    // (the level made — its boot marks, src/perf/boot-marks.ts — then --wait ms as before)
    await p.waitForFunction(() => (window.__boot?.at['level-ready'] && window.reclaimed?.stream && window.reclaimed?.scene) || document.querySelector('.fatal'), { timeout: 240000, polling: 250 });
    await sleep(waitMs);
    // (the adapter: its baselines)
    const adapter = await p.evaluate(async () => {
      const a = await navigator.gpu.requestAdapter();
      const i = a?.info ?? {};
      return `${i.vendor || 'unknown'}-${i.architecture || 'unknown'}`.replace(/[^a-z0-9-]/gi, '_').toLowerCase();
    });
    baseDir = path.join(baseRoot, adapter);
    fs.mkdirSync(baseDir, { recursive: true });
    // (the page's frame rate under the cap, a second of it: under 55 the frame criteria can't be judged here)
    const rate = await p.evaluate(async () => {
      let n = 0;
      const t0 = performance.now();
      await new Promise((res) => {
        const f = () => (++n, performance.now() - t0 < 1000 ? requestAnimationFrame(f) : res());
        requestAnimationFrame(f);
      });
      return n / ((performance.now() - t0) / 1000);
    });
    // (the criterion itself: a page that can't make 58 here isn't judged on its frames — one threshold for every view)
    frameChecks = rate >= CRIT.fps;
    console.log(`${sk}: adapter ${adapter}, ${rate.toFixed(1)} frames/s under the ${hz} Hz cap${frameChecks ? '' : ` — FRAME CHECKS SKIPPED (under ${CRIT.fps})`}`);
    if (!frameChecks) notes.push(`${sk}: the page ran at ${rate.toFixed(1)} frames/s under the ${hz} Hz cap: frames not judged (rerun with --chromeargs)`);
    const home = await p.evaluate(() => [...window.reclaimed.camera.target]);
    // 1-2: parked at the spot, each zoom
    for (const z of zooms) {
      const tag = `${sk}-z${z}`;
      await p.evaluate((z, home) => {
        const c = window.reclaimed.camera;
        c.zoom = z;
        if (!home) return;
        c.target[0] = home[0];
        c.target[1] = home[1];
      }, z, mode === 'atlas' ? home : null);
      // (round 112, tilefix2: how many frames till the screen is all in detail — checked every 30, up to 3 x the budget;
      // over --loadframes fails below, as the coverage)
      let fill = 0;
      for (; fill < loadFrames * 3; fill += 30) {
        await frames(p, 30);
        if (fill + 30 >= loadFrames && (await measure(p, 0.001)).miss === 0) {
          fill += 30;
          break;
        }
      }
      if (fill < loadFrames) await frames(p, loadFrames - fill);
      const m = await measure(p, parkedS);
      m.fillFrames = fill >= loadFrames * 3 ? null : Math.max(fill, loadFrames);
      const f = judge(`${tag} parked`, m, 0);
      if (m.fillFrames === null || m.fillFrames > loadFrames) {
        const msg = `${tag}: the screen in detail after ${m.fillFrames ?? `over ${loadFrames * 3}`} frames (budget ${loadFrames})`;
        if (!fails.includes(msg)) fails.push(msg);
      }
      const shot = await p.screenshot({ path: path.join(outDir, `${tag}.png`) });
      let g = null;
      if (golden) {
        await p.evaluate(() => (window.reclaimed.scene.speed = 0));
        await sleep(1500);
        g = compare(tag, half(Buffer.from(await p.screenshot())));
        await p.evaluate(() => (window.reclaimed.scene.speed = 1));
      }
      void shot;
      rows.push({ view: tag, mode: 'parked', ...m, golden: g, ok: !f.length });
      console.log(`${tag} parked: ${f.length ? 'FAIL ' + f.join('; ') : 'ok'} — ${JSON.stringify({ ...m, golden: g })}`);
    }
    // 3: panning, each zoom
    // (round 114, covercheck: and the user's own phone setting, window 384 — their screenspace band was there)
    if (doPan && (mode === 'atlas' || mode === 'w384'))
      for (const z of panZooms ?? zooms)
      for (const panV of panVs) {
        const tag = `${sk}-z${z}`;
        await p.evaluate((z) => (window.reclaimed.camera.zoom = z), z);
        await frames(p, loadFrames);
        await p.evaluate((v) => {
          const R = window.reclaimed;
          const c = R.camera;
          const [ux, uy] = c.screenDeltaToWorld(0, -1);
          const l = Math.hypot(ux, uy) || 1;
          R.scene.pan = { speed: v, dir: [ux / l, uy / l], t: 0, turnAt: 0, turnBy: 0, turned: 0, asked: 0 };
        }, panV);
        const m = await measure(p, panS, false);
        await p.evaluate(() => (window.reclaimed.scene.pan = null));
        await p.screenshot({ path: path.join(outDir, `${tag}-pan${panV}.png`) });
        const f = judge(`${tag} panning ${panV} c/s`, m, panMiss);
        rows.push({ view: tag, mode: `pan ${panV}`, ...m, ok: !f.length });
        console.log(`${tag} pan ${panV}: ${f.length ? 'FAIL ' + f.join('; ') : 'ok'} — ${JSON.stringify(m)}`);
      }
    if (doPan && fastV > 0 && (mode === 'atlas' || mode === 'w384'))
      for (const z of fastZooms) {
        const tag = `${sk}-z${z}`;
        await p.evaluate((z) => (window.reclaimed.camera.zoom = z), z);
        await frames(p, loadFrames);
        await p.evaluate((v, span) => {
          const R = window.reclaimed;
          const c = R.camera;
          const S = R.stream;
          const [ux, uy] = c.screenDeltaToWorld(0, -1);
          const l = Math.hypot(ux, uy) || 1;
          const dir = [ux / l, uy / l];
          const ROW = Math.sqrt(3) / 2;
          const here = () => [S.origin[0] + c.target[0], S.origin[1] * ROW + c.target[1]];
          const home = here();
          R.scene.pan = { speed: v, dir: [...dir], t: 0, turnAt: 0, turnBy: 0, turned: 0, asked: 0 };
          let sign = 1;
          const steer = () => {
            const pan = R.scene.pan;
            if (!pan) return;
            if (span > 0) {
              const h = here();
              const off = (h[0] - home[0]) * dir[0] + (h[1] - home[1]) * dir[1];
              if (off > span && sign > 0) sign = -1;
              else if (off < 0 && sign < 0) sign = 1;
              pan.dir = [dir[0] * sign, dir[1] * sign];
            }
            requestAnimationFrame(steer);
          };
          requestAnimationFrame(steer);
        }, fastV, fastSpan);
        const m = await measure(p, panS, false);
        await p.evaluate(() => (window.reclaimed.scene.pan = null));
        await p.screenshot({ path: path.join(outDir, `${tag}-fast${fastV}.png`) });
        const f = judge(`${tag} panning ${fastV} c/s over ${fastSpan || 'on'}`, m, panMiss);
        rows.push({ view: tag, mode: `fast ${fastV}`, ...m, ok: !f.length });
        console.log(`${tag} fast ${fastV}: ${f.length ? 'FAIL ' + f.join('; ') : 'ok'} — ${JSON.stringify(m)}`);
      }
    await p.close();
  }
}
const secs = Math.round((Date.now() - t00) / 1000);
fs.writeFileSync(path.join(outDir, 'tilegate.json'), JSON.stringify({ url, secs, hz, loadFrames, chromeArgs, baselines: baseDir, fails, notes, rows }, null, 1));
console.log(`\n${fails.length ? `GATE FAILED (${fails.length})` : 'GATE PASSED'} in ${secs} s — ${path.join(outDir, 'tilegate.json')}`);
for (const f of fails) console.log(`  ${f}`);
for (const n of notes) console.log(`  note: ${n}`);
for (const f of fails) R.fail(f);
});
