// Nested scales (round 32 step B2): the cliff rule drawn on real terrain (?cliff=5: SPLIT cells as boxes marched inside,
// src/nested/cliffbox.ts) against the plain textured sheet. Four poses round the root's steepest step: side16 (waits for
// the 16 m level), side2, above (over the high side looking down at the step), foot (close to the foot of the wall,
// looking up: the march's worst case). Per pose: a pair (render.cliffBoxOn off / on, the app frozen), the closure count
// (pixels nothing was drawn on, below the horizon, both states), and with ?cliffDbg=12 the march steps a box pixel (the
// info target's b channel, read back: measurement only). Then the frame time off / on at each pose (alternating, 3 s each,
// 2 rounds; ?gputime=1 pass sums).
// node scripts/nested-rB2-stills.mjs --chromeargs ignore-certificate-errors --port 5461 [--extra "&cliffAmp=..."]
import { run, sleep } from './lib/runner.mjs';
import fs from 'node:fs';

await run({ name: 'rB2-stills', kind: 'behaviour', size: '960x640', dpr: 1, echo: false }, async (R) => {
  const port = R.opt('port', '5461');
  const tag = R.opt('tag', 'rB2');
  const only = R.opt('only', '').split(',').filter(Boolean);
  fs.mkdirSync('local/nested', { recursive: true });
  const page = await R.page();
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') console.log(`[page ${m.type()}] ${m.text()}`);
  });
  page.on('pageerror', (e) => console.log(`[page exception] ${e.message}`));
  await page.goto(`https://localhost:${port}/nested.html?cliff=5&smooth=1&gputime=1${R.opt('extra', '')}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.nested && nested.app.pipesReady && nested.app.genReady && nested.app.frameCount > 30, { timeout: 180000, polling: 200 });
  await page.waitForFunction(() => nested.app.render.texDrawn && nested.app.render.cliffBox && nested.app.render.cliffBox.ready, { timeout: 120000, polling: 200 });
  const pipes = await page.evaluate(() => ({ tex: nested.app.render.texCompileMs, box: nested.app.render.cliffBox.compileMs, S: nested.app.nest.S }));
  console.log(`pipelines: textured ${pipes.tex.toFixed(0)} ms; cliff boxes (build + sheets + boxes, in parallel) ${pipes.box.toFixed(0)} ms; segments S ${pipes.S}`);
  const lim = await page.evaluate(async () => {
    const ad = await navigator.gpu.requestAdapter();
    return { adapter: ad.limits.maxStorageBuffersPerShaderStage, device: nested.app.render.device.limits.maxStorageBuffersPerShaderStage };
  });
  console.log(`storage buffers per stage: adapter ${lim.adapter}, device (requested) ${lim.device}`);
  // (--strata 1: a strata off / on pair at side2 and side16 instead of the box pairs)
  const strata = R.opt('strata', '0') === '1';
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
  const steps = () =>
    page.evaluate(async () => {
      const a = nested.app;
      const r = a.render;
      r.cliffDbg = 12;
      a.frozen = false;
      await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(res))));
      a.frozen = true;
      const dev = r.device;
      const tex = r.info;
      const w = tex.width;
      const h = tex.height;
      const bpr = Math.ceil((w * 4) / 256) * 256;
      const buf = dev.createBuffer({ size: bpr * h, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
      const enc = dev.createCommandEncoder();
      enc.copyTextureToBuffer({ texture: tex }, { buffer: buf, bytesPerRow: bpr }, [w, h]);
      dev.queue.submit([enc.finish()]);
      await buf.mapAsync(GPUMapMode.READ);
      const px = new Uint8Array(buf.getMappedRange());
      let n = 0;
      let sum = 0;
      let max = 0;
      let capped = 0;
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          const i = y * bpr + x * 4;
          if (px[i + 3] < 100 || px[i + 3] > 150) continue;
          const s = px[i + 2];
          n++;
          sum += s;
          max = Math.max(max, s);
          if (s >= 96) capped++;
        }
      buf.unmap();
      buf.destroy();
      r.cliffDbg = 0;
      return { n, mean: n ? sum / n : 0, max, capped };
    });
  const info = () => page.evaluate(() => ({ live: nested.app.nest.live, builds: nested.app.render.cliffBox.builds, boxes: nested.app.render.cliffBox.built ? 1 : 0 }));
  const pair = async (name, pitch) => {
    await page.evaluate(() => (nested.app.frozen = true));
    const out = [];
    const hs = [];
    for (const on of [false, true]) {
      await page.evaluate(
        ({ on, strata }) => {
          if (strata) nested.app.render.cliffStrata = on;
          else nested.app.render.cliffBoxOn = on;
        },
        { on, strata },
      );
      await page.evaluate(() => {
        nested.app.frozen = false;
        return new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(res))));
      });
      await page.evaluate(() => (nested.app.frozen = true));
      await sleep(400);
      const file = strata ? `local/nested/${tag}-${name}-strata${on ? 1 : 0}.png` : `local/nested/${tag}-${name}-cliff${on ? 5 : 0}.png`;
      await page.screenshot({ path: file });
      out.push(file);
      hs.push(await holes(pitch));
    }
    const st = await steps();
    const file = `local/nested/${tag}-${name}-steps.png`;
    await page.evaluate(() => {
      nested.app.render.cliffDbg = 12;
      nested.app.frozen = false;
      return new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(res))));
    });
    await page.evaluate(() => (nested.app.frozen = true));
    await page.screenshot({ path: file });
    // (the hit kinds: draw.wgsl TINTS[kind]: 0 miss blue, 1 side red, 2 top yellow, 3 floor green, 4 edge wall magenta)
    await page.evaluate(() => {
      nested.app.render.cliffDbg = 13;
      return new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(res))));
    });
    await page.screenshot({ path: `local/nested/${tag}-${name}-kinds.png` });
    await page.evaluate(() => (nested.app.render.cliffDbg = 0));
    const i = await info();
    await page.evaluate(() => (nested.app.frozen = false));
    console.log(`${name}: levels ${i.live}, table builds ${i.builds}; holes below the horizon off ${hs[0]} / on ${hs[1]}; box pixels ${st.n}, march steps mean ${st.mean.toFixed(1)} max ${st.max} (at the cap ${st.capped}); ${out.join(' ')} ${file}`);
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
  console.log(`steepest root step: ${JSON.stringify(spot)}`);
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
  // (--tlist 2,4,8,16: per pose a still at each steep threshold T (render.cliffBoxT; the table rebuilt) and the SPLIT cells
  // in the window (the box count from the indirect arguments, read back: measurement only); nothing else)
  const tlist = R.opt('tlist', '').split(',').filter(Boolean).map(Number);
  if (tlist.length) {
    for (const [name, [v, minLive]] of Object.entries(poses)) {
      if (only.length && !only.includes(name)) continue;
      await page.evaluate((v) => nested.setView(v), v);
      await settle(minLive);
      await page.evaluate(() => (nested.app.frozen = true));
      for (const T of tlist) {
        const r = await page.evaluate(async (T) => {
          const a = nested.app;
          const cb = a.render.cliffBox;
          const b0 = cb.builds;
          a.render.cliffBoxT = T;
          for (let i = 0; i < 100 && cb.builds === b0; i++) await new Promise((res) => setTimeout(res, 50));
          await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(res))));
          const dev = a.render.device;
          const buf = dev.createBuffer({ size: 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
          const enc = dev.createCommandEncoder();
          enc.copyBufferToBuffer(cb.args, 0, buf, 0, 16);
          dev.queue.submit([enc.finish()]);
          await buf.mapAsync(GPUMapMode.READ);
          const n = new Uint32Array(buf.getMappedRange())[1];
          buf.unmap();
          buf.destroy();
          return { n, cells: cb.built.n * cb.built.n, rebuilt: cb.builds !== b0 };
        }, T);
        await sleep(300);
        const file = `local/nested/${tag}-${name}-T${T}.png`;
        await page.screenshot({ path: file });
        console.log(`${name} T ${T}: SPLIT cells ${r.n} of ${r.cells} (${((100 * r.n) / r.cells).toFixed(2)} %), rebuilt ${r.rebuilt}; ${file}`);
      }
      await page.evaluate(() => (nested.app.frozen = false));
    }
    return;
  }
  for (const [name, [v, minLive]] of Object.entries(poses)) {
    if (only.length && !only.includes(name)) continue;
    await page.evaluate((v) => nested.setView(v), v);
    await settle(minLive);
    await pair(name, v.pitch);
  }
  if (R.opt('bench', '1') !== '1') return;
  for (const [name, [v, minLive]] of Object.entries(poses)) {
    if (only.length && !only.includes(name)) continue;
    await page.evaluate((v) => nested.setView(v), v);
    await settle(minLive);
    await page.evaluate(() => (nested.app.frozen = true));
    const res = { off: [], on: [] };
    for (let rep = 0; rep < 2; rep++)
      for (const on of [false, true]) {
        const r = await page.evaluate(async (on) => {
          const a = nested.app;
          a.render.cliffBoxOn = on;
          await new Promise((res) => setTimeout(res, 600));
          a.render.gpuSamples.clear();
          const c0 = a.frameCount;
          await new Promise((res) => setTimeout(res, 3000));
          const f = a.frames.slice(-(a.frameCount - c0));
          let g = 0;
          const per = {};
          for (const [k, s] of a.render.gpuSamples.entries()) {
            const m = s.ms.reduce((x, y) => x + y, 0) / Math.max(1, s.ms.length);
            per[k] = +m.toFixed(2);
            g += m;
          }
          return { f: f.reduce((x, y) => x + y, 0) / Math.max(1, f.length), g, per };
        }, on);
        res[on ? 'on' : 'off'].push(`${r.f.toFixed(2)}/${r.g.toFixed(2)}`);
        if (rep === 1) console.log(`  ${name} passes ${on ? 'cliff=5' : 'cliff=0'}: ${JSON.stringify(r.per)}`);
      }
    await page.evaluate(() => (nested.app.frozen = false));
    console.log(`${name} frame ms / GPU passes ms: cliff=0 ${res.off.join('  ')}; cliff=5 ${res.on.join('  ')}`);
  }
});
