// Round 92 repro (the user's phone screenshots: a meteor crater with a molten rim at the foot of a tall dark rock
// pillar; afterwards a pillar hangs with nothing under it). On the atlas level at the phone tier (q=low, hybrid=1,
// 412×915) the natural pillars/mesas near the camera are found from the window's columns (a column standing far
// over the ring round it), the camera put on one, the sandbox's meteor tool picked and the screen tapped at the
// pillar's foot (the real pointer path: pick, flight, crater, the rim's lava). Then the window's runs are scanned
// (Integrity.scan: fracture.ts floatingRuns) at intervals for 45 s: every run with something solid and no way to
// the ground near the site is a failure. Also a built tower (--built).
//   node scripts/meteorpillar.mjs [--url http://localhost:5271] [--n 3] [--built 1] [--gif out.gif] [--gifcase 0]
//   [--secs 45] [--trace 1: the integrity's seeds, watches and passes logged while it settles]
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
const url = opt('url', 'http://localhost:5271');
const N = Number(opt('n', 3));
const built = opt('built', '1') === '1';
const gif = opt('gif', '');
const gifCase = Number(opt('gifcase', 0));
const secs = Number(opt('secs', 45));
const extra = opt('params', '');
const far = Number(opt('far', 0));
const count = Number(opt('count', 1));
const throttle = Number(opt('throttle', 1));
const auto = opt('auto', '1') === '1';
const slideHow = opt('slide', '');
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--window-size=412,915'],
  defaultViewport: { width: 412, height: 915, deviceScaleFactor: 1 },
  protocolTimeout: 900000,
});
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
let fails = 0;
let pageErrors = 0;
try {
  const p = await browser.newPage();
  p.on('pageerror', (e) => {
    pageErrors++;
    console.log('pageerror', e.message);
  });
  p.on('console', (m) => (m.type() === 'error' && !m.text().includes('404')) || m.text().startsWith('[mp]') ? console.log('console', m.text()) : 0);
  const atArg = opt('at', '');
  await p.goto(`${url}/?skipmenu=1&tutorial=0&q=low&hybrid=1&level=atlas${atArg ? '&at=' + atArg : ''}${extra}`, { waitUntil: 'load' });
  await p.waitForFunction(() => window.reclaimed?.stream && window.reclaimed?.integrity?.(), { timeout: 240000 });
  // (--kind spires: the nearest region of that kind to the spawn, the window opened there)
  const kind = opt('kind', '');
  if (kind) {
    const at = await p.evaluate((kind) => {
      const A = window.reclaimed.atlas;
      const [sx, sy] = A.spawn();
      for (let r = 64; r < 9000; r += 64)
        for (let a = 0; a < 64; a++) {
          const x = sx + Math.cos((a / 64) * 6.283) * r;
          const y = sy + Math.sin((a / 64) * 6.283) * r;
          // (well inside it: the four round it too)
          if ([[0, 0], [60, 0], [-60, 0], [0, 60], [0, -60]].every(([dx, dy]) => A.regionAt(x + dx, (y + dy) * 0.8660254).kind === kind)) return [Math.round(x), Math.round(y)];
        }
      return null;
    }, kind);
    console.log(`region ${kind} at ${at}`);
    if (at) {
      await p.goto(`${url}/?skipmenu=1&tutorial=0&q=low&hybrid=1&level=atlas&at=${at.join(',')}${extra}`, { waitUntil: 'load' });
      await p.waitForFunction(() => window.reclaimed?.stream && window.reclaimed?.integrity?.(), { timeout: 240000 });
    }
  }
  await sleep(30000);
  if (throttle > 1) await (await p.target().createCDPSession()).send('Emulation.setCPUThrottlingRate', { rate: throttle });
  const warm = await p.evaluate(async () => {
    const R = window.reclaimed;
    const I = R.integrity();
    const s = await I.scan();
    return { floating: s.floating.length, runs: s.runs, ms: s.ms, stats: { ...I.stats } };
  });
  console.log(`warm-up: ${warm.runs} runs, ${warm.floating} floating, scan ${warm.ms.toFixed(0)} ms, stats ${JSON.stringify(warm.stats)}`);
  // the pillars: columns standing PROM over the median of the ring 9..12 round them, the camera's 70 cells
  const sites = await p.evaluate(async (N, REACH, PROM, AUTO) => {
    const R = window.reclaimed;
    // (--auto 0: the streamer held still; by default it slides with the camera, as on the phone)
    if (!AUTO) R.stream.auto = false;
    const L = await import('/src/world/lattice.ts');
    const f = await R.readBuffer('layers');
    const slots = new Uint32Array(f.buffer, f.byteOffset, f.byteLength / 4);
    const f32 = new Float32Array(slots.buffer, slots.byteOffset, slots.length);
    const pk = R.core.packed;
    const { w: W, h: H } = R.core.dims;
    const top = (x, y) => {
      if (x < 0 || y < 0 || x >= W || y >= H) return 0;
      const ci = Math.floor(y / 16) * pk.chunksX + Math.floor(x / 16);
      const k = pk.chunkTable[ci * 2 + 1];
      const b = pk.chunkTable[ci * 2] + ((y % 16) * 16 + (x % 16)) * k;
      let t = 0;
      for (let s = 0; s < k; s++) {
        if (slots[(b + s) * 4 + 1] === 0) break;
        t = f32[(b + s) * 4 + 1];
      }
      return t;
    };
    const [tx, ty] = R.camera.target;
    const found = [];
    const [c0x, c0y] = L.cellAt(tx - REACH, ty - REACH);
    const [c1x, c1y] = L.cellAt(tx + REACH, ty + REACH);
    for (let y = Math.max(12, c0y); y <= Math.min(H - 13, c1y); y += 2)
      for (let x = Math.max(12, c0x); x <= Math.min(W - 13, c1x); x += 2) {
        const t = top(x, y);
        const ring = [];
        for (let a = 0; a < 16; a++) {
          const [px, py] = L.cellPos(x, y);
          const [rx, ry] = L.cellAt(px + Math.cos((a / 16) * 6.283) * 11, py + Math.sin((a / 16) * 6.283) * 11);
          ring.push(top(rx, ry));
        }
        ring.sort((a, b) => a - b);
        const g = ring[8];
        if (t - g > PROM) {
          // its width: the columns within 6 standing over g + 12
          let n = 0;
          const [px, py] = L.cellPos(x, y);
          for (let dy = -7; dy <= 7; dy++)
            for (let dx = -7; dx <= 7; dx++) {
              const [qx, qy] = L.cellAt(px + dx, py + dy);
              if (Math.hypot(dx, dy) <= 6 && top(qx, qy) > g + 12) n++;
            }
          found.push({ x, y, px, py, top: t, ground: g, ring0: ring[0], wide: n });
        }
      }
    // the tallest well apart
    found.sort((a, b) => b.top - b.ground - (a.top - a.ground));
    const out = [];
    for (const f of found) if (out.every((o) => Math.hypot(o.px - f.px, o.py - f.py) > 25)) out.push(f);
    console.log('[mp] candidates ' + found.length + ' best ' + (found[0] ? (found[0].top - found[0].ground).toFixed(1) : '-'));
    return out.slice(0, N);
  }, N, Number(opt('reach', 100)), Number(opt('prom', 18)), auto);
  console.log(`pillars: ${JSON.stringify(sites.map((s) => ({ ...s, px: +s.px.toFixed(1), py: +s.py.toFixed(1), top: +s.top.toFixed(1), ground: +s.ground.toFixed(1) })))}`);
  // (--built: a tower the world API builds by the camera, as towertest's)
  if (built) {
    const b = await p.evaluate(async () => {
      const R = window.reclaimed;
      const t = R.api.terrain;
      await t.refresh();
      const [cx, cy] = R.camera.target;
      const x = cx + 14;
      const y = cy + 6;
      const z = t.heightAt(x, y);
      for (let k = 0; k < 12; k++) t.build(x, y, 'stone', { radius: 3.5, layers: 4 });
      return { px: x, py: y, ground: z, built: true };
    });
    await sleep(3000);
    sites.push(b);
  }
  // (the sites in world cells: the window slides under them)
  const stream0 = await p.evaluate(() => [window.reclaimed.stream.origin.slice(), window.reclaimed.stream.oz]);
  for (const s of sites) {
    s.wx = s.px + stream0[0][0];
    s.wy = s.py + stream0[0][1] * 0.8660254;
    s.wg = s.ground + stream0[1];
  }
  /** the site in the window as it is now; the window's origin and oz */
  const fix = async (s) => {
    const [o, oz] = await p.evaluate(() => [window.reclaimed.stream.origin.slice(), window.reclaimed.stream.oz]);
    s.px = s.wx - o[0];
    s.py = s.wy - o[1] * 0.8660254;
    s.ground = s.wg - oz;
    return [o, oz];
  };
  for (let si = 0; si < sites.length; si++) {
    const s = sites[si];
    await fix(s);
    // look at it (--far D: from D cells off, the pillar in the hybrid's heightfield chunks)
    await p.evaluate((s, far) => {
      const R = window.reclaimed;
      R.camera.target = [s.px + far * 0.7, s.py + far * 0.7, s.ground + 12];
      R.camera.zoom = far ? 9 : 6;
    }, s, far);
    await sleep(4000);
    // (a floater by its world cell and height)
    const keyOf = (f) => `${f.wx},${f.wy},${f.wz.toFixed(1)}`;
    const scanHere = async () => {
      await fix(s);
      const nearHere = `(f) => Math.hypot(f.x + 0.5 * (f.y & 1) - ${s.px}, f.y * 0.866 - ${s.py}) < 45`;
      return p.evaluate(async (near) => {
        const R = window.reclaimed;
        const I = R.integrity();
        const sc = await I.scan();
        const f = eval(near);
        const o = R.stream.origin;
        const here = sc.floating.filter(f).map((g) => ({ ...g, wx: g.x + o[0], wy: g.y + o[1], wz: g.z0 + R.stream.oz }));
        // (round 96) held only by basalt: what floats here once the basalt is taken for air (the meteor's lava set into it)
        const Fr = await import('/src/game/fracture.ts');
        const lb = await R.readBuffer('layers');
        const u = new Uint32Array(lb.buffer, lb.byteOffset, lb.byteLength / 4).slice();
        let basalt = 0;
        for (let k = 0; k < u.length; k += 4)
          if (u[k + 1] !== 0 && (u[k + 2] & 255) === 23) {
            u[k + 2] &= ~255;
            basalt++;
          }
        const nb = Fr.floatingRuns(new Fr.WorldVox(R.core.packed, u)).floating.filter(f);
        const old = sc.floating.filter(f);
        const bs = nb.filter((g) => !old.some((h) => h.x === g.x && h.y === g.y && Math.abs(h.z0 - g.z0) < 0.01));
        return { here, byBasalt: bs.length, basalt, bs: bs.slice(0, 2), window: sc.floating.length, falling: I.falling.list.length, seeds: I.rockSeeds.size, watches: I.watches.length, slides: R.stream.stats.slides, tiers: R.stream.stats.tiers, stats: { passes: I.stats.passes, bodies: I.stats.bodies, crumbled: I.stats.crumbled, rereads: I.stats.rereads, why: Object.fromEntries(Object.entries(I.why).map(([k, v]) => [k, Math.round(v)])) } };
      }, nearHere);
    };
    const before = new Set((await scanHere()).here.map(keyOf));
    await p.evaluate(() => {
      const R = window.reclaimed;
      window.__craters = [];
      if (!window.__tapped) {
        window.__tapped = true;
        R.core.sim.eventTaps.push((sent) => {
          for (const e of sent) if (((e.z ?? 0) & 511) >> 5 === 13 && e.radius > 20) window.__craters.push([+e.x.toFixed(1), +e.y.toFixed(1), +e.strength.toFixed(1)]);
        });
      }
    });
    const shots = [];
    const grab = async () => {
      if (gif && si === gifCase) shots.push(await p.screenshot({ type: 'png' }));
    };
    await grab();
    const log = [];
    let newest = [];
    const look = async (label) => {
      const r = await scanHere();
      const fresh = r.here.filter((f) => !before.has(keyOf(f)));
      newest = fresh;
      log.push(`${label}: new floating here ${fresh.length} (natural ones before ${before.size}, here now ${r.here.length}); held by basalt only ${r.byBasalt}${r.byBasalt ? ' e.g. ' + JSON.stringify(r.bs) : ''} (basalt slots ${r.basalt}) window ${r.window} falling ${r.falling} seeds ${r.seeds} watches ${r.watches} slides ${r.slides}/${r.tiers} ${JSON.stringify(r.stats)}${fresh.length ? ' e.g. ' + JSON.stringify(fresh.slice(0, 3)) : ''}`);
      return fresh.length;
    };
    for (let m = 0; m < count; m++) {
      await fix(s);
      // the foot: from the pillar's middle out along a way (each meteor its own) until the ground is under g + 3
      const foot = await p.evaluate(async (s, a0) => {
        const R = window.reclaimed;
        const t = R.api.terrain;
        await t.refresh();
        let best = null;
        for (let a = 0; a < 8 && !best; a++) {
          const ang = a0 + (a / 8) * 6.283;
          const dx = Math.cos(ang);
          const dy = Math.sin(ang);
          for (let r = 1; r < 18; r += 0.5) {
            const x = s.px + dx * r;
            const y = s.py + dy * r;
            const z = t.heightAt(x, y);
            if (z < s.ground + 3) {
              const [sx, sy] = R.camera.project(x, y, z + 0.5);
              const onScreen = sx > 8 && sx < 404 && sy > 60 && sy < 860 && !(sx > 225 && sy < 475);
              best = { x, y, z, sx, sy, r, onScreen };
              break;
            }
          }
        }
        return best;
      }, s, m * 2.1);
      if (!foot) {
        log.push(`meteor ${m}: no foot found`);
        break;
      }
      await p.evaluate(() => (window.__craters = []));
      let how = 'tap';
      if (foot.onScreen) {
        await p.evaluate(() => window.reclaimed.editor().select('meteor'));
        await p.mouse.click(foot.sx, foot.sy);
        await p.evaluate(() => window.reclaimed.editor().select('wind'));
      }
      const tw = Date.now();
      while (Date.now() - tw < 2600) {
        await grab();
        await sleep(200);
      }
      let craters = await p.evaluate(() => window.__craters);
      if (!craters.length) {
        how = foot.onScreen ? 'meteorNow (the tap missed)' : 'meteorNow (the foot off screen)';
        await p.evaluate((f) => window.reclaimed.meteorNow(f.x, f.y, f.z + 0.5), foot);
        await sleep(400);
        craters = await p.evaluate(() => window.__craters);
      }
      log.push(`meteor ${m} by ${how}: crater ${JSON.stringify(craters)} (foot ${foot.x.toFixed(1)}, ${foot.y.toFixed(1)}, ${foot.z.toFixed(1)}, ${foot.r} from the middle)`);
      // (--slide x|z: the window slides away and back while what the meteor freed is falling — as it does on the
      // phone when the camera moves on: a region frozen, the columns cut again in z)
      if (slideHow) {
        await sleep(300);
        const got = await p.evaluate(async (how, px) => {
          const R = window.reclaimed;
          const S = R.stream;
          const falling = R.integrity().falling.list.length;
          if (how === 'x') {
            const d = px < 128 ? 64 : -64;
            await S.slide(d, 0);
            await new Promise((r) => setTimeout(r, 800));
            await S.slide(-d, 0);
          } else {
            const d = S.oz >= 32 ? -32 : 32;
            await S.slideZ(d);
            await new Promise((r) => setTimeout(r, 800));
            await S.slideZ(-d);
          }
          return { falling, slideMs: S.stats.lastMs, settleMs: R.integrity().stats.settleMs, stillFalling: R.integrity().falling.list.length };
        }, slideHow, s.px);
        log.push(`  slid ${slideHow} away and back with ${got.falling} piece(s) falling: the last slide ${got.slideMs} ms, settling took ${got.settleMs?.toFixed?.(1)} ms at most, ${got.stillFalling} still falling after`);
      }
      await sleep(1500);
      await look(`  after meteor ${m}`);
    }
    const t0 = Date.now();
    let lastFloat = -1;
    for (const c of [5, 12, 20, 30, 45, 60, secs].filter((c) => c <= secs)) {
      while ((Date.now() - t0) / 1000 < c) {
        await grab();
        await sleep(gif && si === gifCase ? 200 : 500);
      }
      lastFloat = await look(`${c}s after`);
    }
    if (newest.length) {
      const f = newest[0];
      const cols = await p.evaluate(async (f) => {
        const R = window.reclaimed;
        const L = await import('/src/world/lattice.ts');
        const Lay = await import('/src/world/layout.ts');
        const b = await R.readBuffer('layers');
        const slots = new Uint32Array(b.buffer, b.byteOffset, b.byteLength / 4);
        const col = (x, y) => Lay.readColumn(R.core.packed, slots, x, y).map((iv) => `${iv.z0.toFixed(2)}-${iv.z1.toFixed(2)}:${iv.mat}`).join(' ');
        const out = [`    ${f.x},${f.y}: ${col(f.x, f.y)}`];
        for (let k = 0; k < 6; k++) {
          const [nx, ny] = L.nbr(f.x, f.y, k);
          out.push(`    n${k} ${nx},${ny}: ${col(nx, ny)}`);
        }
        return out.join(String.fromCharCode(10));
      }, f);
      log.push('the first new floater and its neighbours: ' + String.fromCharCode(10) + cols);
    }
    const ok = lastFloat === 0;
    if (!ok) fails++;
    console.log(`${ok ? 'PASS' : 'FAIL'} site ${si}${s.built ? ' (built tower)' : ''} at (${s.px.toFixed(1)}, ${s.py.toFixed(1)}) ground ${s.ground.toFixed(1)} top ${s.top?.toFixed(1) ?? '-'} wide ${s.wide ?? '-'}; ${count} meteor(s)`);
    for (const l of log) console.log('   ', l);
    if (shots.length) {
      const enc = GIFEncoder();
      for (const sh of shots) {
        const png = PNG.sync.read(Buffer.from(sh));
        const pal = quantize(png.data, 256);
        enc.writeFrame(applyPalette(png.data, pal), png.width, png.height, { palette: pal, delay: 120 });
      }
      enc.finish();
      fs.writeFileSync(gif, enc.bytes());
      console.log('saved', gif, shots.length, 'frames');
    }
  }
} finally {
  await browser.close();
}
console.log(fails || pageErrors ? `meteorpillar: ${fails} failed, ${pageErrors} page errors` : 'meteorpillar: all passed');
process.exit(fails || pageErrors ? 1 : 0);
