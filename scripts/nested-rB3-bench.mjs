// Nested scales (round 32 step B3): the ?cliff=5 box pass's cost cuts (cliffbox.ts opt: cull, low, order), measured in
// one page against each other at rB2's four poses (side16, side2, above, foot). Per pose and setting: a still (compared
// pixel by pixel with the first setting's), the closure count (holes below the horizon), and the overdraw (cliffbox.ts
// drawCount: box fragments a pixel with no depth test, those past the front test, those that march against the depth so
// far, and their march steps; measurement only). Then the box pass's GPU time and the frame time, the settings
// alternating (3 s each, --rounds rounds; ?gputime=1).
// node scripts/nested-rB3-bench.mjs --chromeargs ignore-certificate-errors --port 5461 [--extra "&cliffT=4"]
//   [--configs 00,10,11] (cull, order bits; the solid-part variant measured in round 32 B3 is on exp/nested-b3-low) [--only side2] [--rounds 3] [--tag rB3]
import { run, sleep } from './lib/runner.mjs';
import fs from 'node:fs';
import { PNG } from 'pngjs';

await run({ name: 'rB3-bench', kind: 'behaviour', size: '960x640', dpr: 1, echo: false }, async (R) => {
  const port = R.opt('port', '5461');
  const tag = R.opt('tag', 'rB3');
  const only = R.opt('only', '').split(',').filter(Boolean);
  const configs = R.opt('configs', '00,10,11').split(',').filter(Boolean);
  const rounds = Number(R.opt('rounds', '3'));
  const doBench = R.opt('bench', '1') === '1';
  fs.mkdirSync('local/nested', { recursive: true });
  const page = await R.page();
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') console.log(`[page ${m.type()}] ${m.text()}`);
  });
  page.on('pageerror', (e) => console.log(`[page exception] ${e.message}`));
  await page.goto(`https://localhost:${port}/nested.html?cliff=5&smooth=1&gputime=1${R.opt('extra', '')}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.nested && nested.app.pipesReady && nested.app.genReady && nested.app.frameCount > 30, { timeout: 180000, polling: 200 });
  await page.waitForFunction(() => nested.app.render.texDrawn && nested.app.render.cliffBox && nested.app.render.cliffBox.ready, { timeout: 120000, polling: 200 });
  const settle = async (minLive = 0) => {
    for (let i = 0; i < 400; i++) {
      await sleep(150);
      const ok = await page.evaluate((m) => nested.app.nest.settled && !nested.app.nest.switching && !nested.app.nest.fieldJob && nested.app.nest.live >= m, minLive);
      if (ok && i > 10) break;
    }
    await sleep(800);
  };
  const look = (eye, at) => {
    const d = [at[0] - eye[0], at[1] - eye[1], at[2] - eye[2]];
    const n = Math.hypot(...d);
    return { yaw: Math.atan2(-d[1], -d[0]), pitch: Math.asin(-d[2] / n), eye };
  };
  const frames = (k = 3) =>
    page.evaluate((k) => {
      nested.app.frozen = false;
      return new Promise((res) => {
        const f = (i) => (i <= 0 ? res() : requestAnimationFrame(() => f(i - 1)));
        f(k);
      });
    }, k);
  /** set the cost cuts and wait for their pipelines (made once a setting) */
  const setOpt = async (c, counting = false) => {
    await page.evaluate(
      async ({ c, counting }) => {
        const cb = nested.app.render.cliffBox;
        cb.opt = { cull: c[0] === '1', order: c[1] === '1' };
        cb.counting = counting;
        for (let i = 0; i < 400 && !cb.optReady; i++) {
          nested.app.frozen = false;
          await new Promise((res) => setTimeout(res, 50));
        }
      },
      { c, counting },
    );
    await frames(4);
  };
  const holes = (pitch) =>
    page.evaluate(async (pitch) => {
      const hl = await nested.holes();
      const tn = Math.tan((50 * Math.PI) / 360);
      let cnt = 0;
      for (let y = 0; y < hl.h; y++) {
        const ny = 1 - ((y + 0.5) / hl.h) * 2;
        const dz = -Math.sin(pitch) + ny * tn * Math.cos(pitch);
        if (dz / Math.hypot(1, ny * tn) < -0.1) cnt += hl.rows[y];
      }
      return cnt;
    }, pitch);
  /** the count target read back (rgba16float): per pixel r all box fragments, g past the front test, b marched against
   *  the depth, a their steps */
  const count = () =>
    page.evaluate(async () => {
      const r = nested.app.render;
      const tex = r.cliffBox.countTex;
      if (!tex) return null;
      const dev = r.device;
      const w = tex.width;
      const h = tex.height;
      const bpr = Math.ceil((w * 8) / 256) * 256;
      const buf = dev.createBuffer({ size: bpr * h, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
      const enc = dev.createCommandEncoder();
      enc.copyTextureToBuffer({ texture: tex }, { buffer: buf, bytesPerRow: bpr }, [w, h]);
      dev.queue.submit([enc.finish()]);
      await buf.mapAsync(GPUMapMode.READ);
      const px = new Uint16Array(buf.getMappedRange());
      const f16 = (b) => {
        const e = (b >> 10) & 31;
        const m = b & 1023;
        return e === 0 ? m / 16777216 : e === 31 ? Infinity : (1 + m / 1024) * 2 ** (e - 15);
      };
      const s = { pix: 0, all: 0, front: 0, frontMax: 0, mpix: 0, march: 0, marchMax: 0, steps: 0, allMax: 0 };
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          const i = (y * bpr) / 2 + x * 4;
          const a = f16(px[i]);
          const g = f16(px[i + 1]);
          const b = f16(px[i + 2]);
          const st = f16(px[i + 3]);
          if (g > 0) {
            s.pix++;
            s.front += g;
            s.frontMax = Math.max(s.frontMax, g);
          }
          s.all += a;
          s.allMax = Math.max(s.allMax, a);
          if (b > 0) {
            s.mpix++;
            s.march += b;
            s.marchMax = Math.max(s.marchMax, b);
            s.steps += st;
          }
        }
      buf.unmap();
      buf.destroy();
      return s;
    });
  const shot = async (file) => {
    await page.evaluate(() => (nested.app.frozen = true));
    await sleep(300);
    const b = await page.screenshot(file ? { path: file } : {});
    return PNG.sync.read(Buffer.from(b));
  };
  /** pixels that differ (and the largest channel difference); with a file, the image dimmed and the differing pixels in
   *  magenta */
  const diff = (a, b, file) => {
    let n = 0;
    let mx = 0;
    const o = file ? new PNG({ width: b.width, height: b.height }) : null;
    for (let i = 0; i < a.data.length; i += 4) {
      // (the HUD's text box, top left, changes every frame: left out)
      const px = (i / 4) % b.width;
      const py = Math.floor(i / 4 / b.width);
      const hud = px < 440 && py < 170;
      const d = hud ? 0 : Math.max(Math.abs(a.data[i] - b.data[i]), Math.abs(a.data[i + 1] - b.data[i + 1]), Math.abs(a.data[i + 2] - b.data[i + 2]));
      if (d > 0) n++;
      mx = Math.max(mx, d);
      if (o) {
        const g = (b.data[i] + b.data[i + 1] + b.data[i + 2]) / 9;
        o.data.set(d > 0 ? [255, 0, 255, 255] : [g, g, g, 255], i);
      }
    }
    if (o && n) fs.writeFileSync(file, PNG.sync.write(o));
    return { n, mx };
  };
  const spot = await page.evaluate(async () => {
    const a = nested.app;
    const s = await a.nest.readAll();
    const w = a.nest.wins[0];
    const top = (X, Y) => {
      const c = s.column(0, X, Y);
      return c.z1[c.z1.length - 1];
    };
    let best = { x: 0, y: 0, step: 0, dir: [1, 0], hi: 0, lo: 0 };
    for (let y = w.gy + 40; y < w.gy + w.n - 40; y++)
      for (let x = w.gx + 40; x < w.gx + w.n - 40; x++)
        for (const d of [[1, 0], [0, 1], [-1, 0], [0, -1]]) {
          const st = top(x, y) - top(x + d[0], y + d[1]);
          if (st > best.step) best = { x, y, step: st, dir: d, hi: top(x, y), lo: top(x + d[0], y + d[1]) };
        }
    return best;
  });
  const C = [spot.x + 0.5 + spot.dir[0] * 0.5, spot.y + 0.5 + spot.dir[1] * 0.5];
  const zMid = (spot.hi + spot.lo) / 2;
  const perp = [-spot.dir[1], spot.dir[0]];
  const side = (D, up, along = 0.35) => look([C[0] + spot.dir[0] * D + perp[0] * D * along, C[1] + spot.dir[1] * D + perp[1] * D * along, zMid + up], [C[0], C[1], zMid]);
  const poses = {
    side16: [side(8, 1.6), 2],
    side2: [side(1.5, 0.3), 3],
    above: [look([C[0] - spot.dir[0] * 0.25, C[1] - spot.dir[1] * 0.25, spot.hi + 0.9], [C[0] + spot.dir[0] * 0.15, C[1] + spot.dir[1] * 0.15, zMid]), 3],
    foot: [look([C[0] + spot.dir[0] * 0.25 + perp[0] * 0.05, C[1] + spot.dir[1] * 0.25 + perp[1] * 0.05, spot.lo + 0.04], [C[0], C[1], spot.hi]), 3],
  };
  for (const [name, [v, minLive]] of Object.entries(poses)) {
    if (only.length && !only.includes(name)) continue;
    await page.evaluate((v) => nested.setView(v), v);
    await settle(minLive);
    const n = await page.evaluate(async () => {
      const cb = nested.app.render.cliffBox;
      const dev = nested.app.render.device;
      const buf = dev.createBuffer({ size: 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
      const enc = dev.createCommandEncoder();
      enc.copyBufferToBuffer(cb.args, 0, buf, 0, 16);
      dev.queue.submit([enc.finish()]);
      await buf.mapAsync(GPUMapMode.READ);
      const k = new Uint32Array(buf.getMappedRange())[1];
      buf.unmap();
      buf.destroy();
      return k;
    });
    console.log(`${name}: boxes ${n}`);
    let ref = null;
    for (const c of configs) {
      await setOpt(c);
      const img = await shot(`local/nested/${tag}-${name}-${c}.png`);
      const h = await holes(v.pitch);
      const dd = ref ? diff(ref, img, `local/nested/${tag}-${name}-${c}-diff.png`) : { n: 0, mx: 0 };
      if (!ref) ref = img;
      await setOpt(c, true);
      await frames(3);
      const s = await count();
      await setOpt(c, false);
      const f = (x) => x.toFixed(2);
      console.log(
        `  ${name} ${c}: holes ${h}; pixels differing from ${configs[0]} ${dd.n} (max ${dd.mx}); ` +
          (s
            ? `box fragments a box pixel: all ${f(s.all / Math.max(1, s.pix))} (max ${s.allMax}), front ${f(s.front / Math.max(1, s.pix))} (max ${s.frontMax}) over ${s.pix} px; marched past the depth ${f(s.march / Math.max(1, s.mpix))} a pixel (max ${s.marchMax}) over ${s.mpix} px, ${f(s.steps / Math.max(1, s.march))} steps a marched fragment`
            : 'no count'),
      );
    }
    if (!doBench) continue;
    await page.evaluate(() => (nested.app.frozen = true));
    const res = Object.fromEntries(configs.map((c) => [c, { box: [], g: [], f: [] }]));
    for (let rep = 0; rep < rounds; rep++)
      for (const c of configs) {
        await setOpt(c);
        const r = await page.evaluate(async () => {
          const a = nested.app;
          a.frozen = true;
          await new Promise((res) => setTimeout(res, 500));
          a.render.gpuSamples.clear();
          const c0 = a.frameCount;
          await new Promise((res) => setTimeout(res, 3000));
          const f = a.frames.slice(-(a.frameCount - c0));
          let g = 0;
          let box = 0;
          for (const [k, s] of a.render.gpuSamples.entries()) {
            const m = s.ms.reduce((x, y) => x + y, 0) / Math.max(1, s.ms.length);
            g += m;
            if (k === 'cliff boxes') box = m;
          }
          return { f: f.reduce((x, y) => x + y, 0) / Math.max(1, f.length), g, box };
        });
        res[c].box.push(r.box);
        res[c].g.push(r.g);
        res[c].f.push(r.f);
      }
    const med = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)].toFixed(2);
    for (const c of configs) console.log(`  ${name} ${c} bench: box pass ms ${res[c].box.map((x) => x.toFixed(2)).join(' ')} (median ${med(res[c].box)}); GPU passes ${med(res[c].g)}; frame ${med(res[c].f)}`);
    await page.evaluate(() => (nested.app.frozen = false));
  }
  await setOpt('11');
});
