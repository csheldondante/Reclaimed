// Round 112 (tilefix): the merge gate for the terrain's drawing. The user: "The most basic thing is that all the tiles
// visible on screen load visually and our framerate doesn't dip below our thresholds", and "Instead of looking at them
// everytime make a cheap baseline image for things that won't change and run pixel diffs to flag changes."
//
// For each screen (desktop 1600x900 at dpr 1, as the user's PC runs it — the page's own tier; the phone proxy 412x915,
// dpr 2.6, q=low) the atlas at a fixed spot, world and time of day, and for each zoom:
//   1. parked: after --load ms at the zoom, --parked s of frames — the screen's 24 x 24 points out of detail (in the
//      window: its region not written yet; past it: no tile drawn — why, TileCache.whyMissing where the build has it)
//      and the frames against the pan bench's criteria (fps >= 58, no frame over 33.4 ms, p99 <= 20 ms);
//   2. a golden image: the simulation paused (scene.speed 0), the frame at an eighth of its size (--shrink) against
//      data/baselines/tilegate/<screen>-z<zoom>.png — a pixel changed when a channel moved over --tol, the view flagged
//      when over --area of it changed; a diff image (changed pixels red over the baseline, dimmed) beside the shot;
// then 3. panning: from the spot, up the screen at --pan cells/s for --panning s at each zoom (after --load ms), the
//      same coverage (allowed --panmiss of the screen out of detail in a frame: the arriving edge's moment) and frames.
// Shots and diffs to --out. Exits 1 on any failure (coverage, frames, a flagged image, a page error).
//   node scripts/tilegate.mjs [--url http://localhost:5233] [--screens desktop,phone] [--zooms 14,8,5,3.5,2.2,1.3]
//     [--load 8000] [--parked 2] [--pan 20] [--panning 3] [--panmiss 0.02] [--tol 40] [--area 0.01]
//     [--out C:/Projects/shots88/tilegate] [--baselines data/baselines/tilegate] [--update] [--no-golden] [--no-pan]
//     [--extra "&x=1"] [--wait 35000] [--shrink 8]
// --update writes the baselines (a view's: --update --screens desktop --zooms 5).
// (round 112, testspeed: on the shared runner, scripts/lib/runner.mjs — the worktree's build on its own port, a kept
// Chrome profile, the GPU leased as a timing check (its frames need the GPU alone). `--url` is a server already up, as
// before; without it the runner serves the build. The level is waited for by its boot marks, then --wait ms as before.)
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
const zooms = opt('zooms', '14,8,5,3.5,2.2,1.3').split(',').map(Number);
const loadMs = Number(opt('load', 8000));
const parkedS = Number(opt('parked', 2));
const panV = Number(opt('pan', 20));
const panS = Number(opt('panning', 3));
const panMiss = Number(opt('panmiss', 0.02));
const tol = Number(opt('tol', 40));
const areaMax = Number(opt('area', 0.01));
const outDir = opt('out', 'C:/Projects/shots88/tilegate');
const baseDir = opt('baselines', 'data/baselines/tilegate');
const update = has('update');
const golden = !has('no-golden');
const doPan = !has('no-pan');
const extra = opt('extra', '');
const waitMs = Number(opt('wait', 35000));
const CRIT = { fps: 58, max: 33.4, p99: 20 };
const SCREENS = {
  desktop: { w: 1600, h: 900, dpr: 1, mobile: false, q: '' },
  phone: { w: 412, h: 915, dpr: 2.6, mobile: true, q: '&q=low' },
  // (the user's PC's window in their report, 2026-10-29: TilesLoadingWeirdly.png)
  wide: { w: 2046, h: 672, dpr: 1, mobile: false, q: '' },
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(outDir, { recursive: true });
fs.mkdirSync(baseDir, { recursive: true });
const t00 = Date.now();
const fails = [];
const rows = [];

/** in the page: `secs` of frames, each with the screen's points out of detail (24 x 24) */
async function measure(p, secs) {
  return p.evaluate(async (secs) => {
    const R = window.reclaimed;
    const cam = R.camera;
    const TL = R.renderer.tiles;
    const S = R.stream;
    const ROW_H = Math.sqrt(3) / 2;
    const G = 24;
    const whyOf = (x, y) => {
      if (TL?.whyMissing) return TL.whyMissing(x, y, cam.azimuth);
      return 'untiled';
    };
    window.reclaimedHitch?.rec?.reset?.();
    const frames = [];
    let worst = 0;
    let worstWhy = {};
    let last = performance.now();
    const t0 = last;
    while (performance.now() - t0 < secs * 1000) {
      const t = await new Promise((r) => requestAnimationFrame(r));
      frames.push(t - last);
      last = t;
      let n = 0;
      const why = {};
      const un = S.unwritten ?? [];
      for (let j = 0; j < G; j++)
        for (let i = 0; i < G; i++) {
          const [dx, dy] = cam.screenDeltaToWorld(((i + 0.5) / G - 0.5) * cam.viewportW, ((j + 0.5) / G - 0.5) * cam.viewportH);
          const x = cam.target[0] + dx;
          const y = (cam.target[1] + dy) / ROW_H;
          let k = null;
          if (x >= 0 && x < S.W && y >= 0 && y < S.H) {
            if (un.some(([ux, uy]) => ux === Math.floor(x / S.R) * S.R && uy === Math.floor(y / S.R) * S.R) && !TL?.drawsAt(x, y)) k = 'window';
          } else if (!TL?.drawsAt(x, y)) k = whyOf(x, y);
          if (k) {
            n++;
            why[k] = (why[k] ?? 0) + 1;
          }
        }
      if (n / (G * G) > worst) {
        worst = n / (G * G);
        worstWhy = why;
      }
    }
    const fs = frames.slice(1).sort((a, b) => a - b);
    const q = (f) => (fs.length ? fs[Math.min(fs.length - 1, Math.floor(fs.length * f))] : Infinity);
    const st = TL?.stats ?? {};
    // (the hitch recorder's word for the long frames: ?hitch=1)
    const rep = window.reclaimedHitch?.report?.();
    const hitches = rep?.worst ? rep.worst.slice(0, 2).map((h) => `${h.ms} ${h.cause} ${[...(h.steps ?? []), ...(h.async ?? [])].slice(0, 2).map((x) => `${x.label} ${x.ms}`).join(', ')}`) : [];
    return { hitches, fps: +(frames.length / secs).toFixed(1), p99: +q(0.99).toFixed(1), max: +q(1).toFixed(1), miss: +worst.toFixed(3), why: worstWhy, tiles: { slots: st.slots, used: st.used, drawn: st.drawn, mb: st.mb } };
  }, secs);
}

function judge(tag, m, missMax) {
  const f = [];
  if (m.miss > missMax) f.push(`out of detail ${(m.miss * 100).toFixed(1)}% (${Object.entries(m.why).map(([k, v]) => `${k} ${v}`).join(', ')})`);
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

await run({ name: 'tilegate', kind: 'timing', urlIsServer: true }, async (R) => {
const url = R.url;
for (const sk of screens) {
  const sc = SCREENS[sk];
  {
    const p = await R.page({ size: `${sc.w}x${sc.h}`, dpr: sc.dpr });
    await p.setViewport({ width: sc.w, height: sc.h, deviceScaleFactor: sc.dpr, hasTouch: sc.mobile, isMobile: sc.mobile });
    p.on('pageerror', (e) => fails.push(`${sk}: page error ${e.message}`));
    p.on('console', (m) => {
      if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) fails.push(`${sk}: console error ${m.text().slice(0, 200)}`);
    });
    // (a fixed spot, world, time of day and season; nothing saved or loaded)
    const params = { level: 'atlas', worldsave: 0, world: 'tilegate', at: '15024,14337', tod: 0.42, day: 100000, season: 0.3, hitch: 1, hitchhud: 0, q: sc.q ? 'low' : '' };
    if (!sc.q) delete params.q;
    for (const kv of extra.split('&').filter(Boolean)) {
      const [k, v] = kv.split('=');
      params[k] = v ?? '';
    }
    // (the page's own tier on the desktop: no q= — R.level's default q=low dropped for it)
    await R.level(params, { page: p, noDefaultQ: !sc.q });
    await sleep(waitMs);
    const home = await p.evaluate(() => [...window.reclaimed.camera.target]);
    // 1-2: parked at the spot, each zoom
    for (const z of zooms) {
      const tag = `${sk}-z${z}`;
      await p.evaluate((z, home) => {
        const c = window.reclaimed.camera;
        c.zoom = z;
        c.target[0] = home[0];
        c.target[1] = home[1];
      }, z, home);
      await sleep(loadMs);
      const m = await measure(p, parkedS);
      const f = judge(`${tag} parked`, m, 0);
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
    if (doPan)
      for (const z of zooms) {
        const tag = `${sk}-z${z}`;
        await p.evaluate((z) => (window.reclaimed.camera.zoom = z), z);
        await sleep(loadMs);
        await p.evaluate((v) => {
          const R = window.reclaimed;
          const c = R.camera;
          const [ux, uy] = c.screenDeltaToWorld(0, -1);
          const l = Math.hypot(ux, uy) || 1;
          R.scene.pan = { speed: v, dir: [ux / l, uy / l], t: 0, turnAt: 0, turnBy: 0, turned: 0, asked: 0 };
        }, panV);
        const m = await measure(p, panS);
        await p.evaluate(() => (window.reclaimed.scene.pan = null));
        await p.screenshot({ path: path.join(outDir, `${tag}-pan.png`) });
        const f = judge(`${tag} panning ${panV} c/s`, m, panMiss);
        rows.push({ view: tag, mode: `pan ${panV}`, ...m, ok: !f.length });
        console.log(`${tag} pan ${panV}: ${f.length ? 'FAIL ' + f.join('; ') : 'ok'} — ${JSON.stringify(m)}`);
      }
    await p.close();
  }
}
const secs = Math.round((Date.now() - t00) / 1000);
fs.writeFileSync(path.join(outDir, 'tilegate.json'), JSON.stringify({ url, secs, fails, rows }, null, 1));
console.log(`\n${fails.length ? `GATE FAILED (${fails.length})` : 'GATE PASSED'} in ${secs} s — ${path.join(outDir, 'tilegate.json')}`);
for (const f of fails) console.log(`  ${f}`);
for (const f of fails) R.fail(f);
});
