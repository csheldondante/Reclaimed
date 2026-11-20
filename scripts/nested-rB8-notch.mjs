// Nested scales (round 32 step B8, NS-307): the notch march coarse-first. One page with fine columns from the URL
// (&cliffAmp=0,256,256,256,256,256,256&cliffWLv=5&cliffPx=2), T 2, switched at run time:
//   fine6    no notches, the step B6 march
//   fine     no notches, the coarse-first march (the same nodes as fine6; the cost of its larger state)
//   b6       notches at every level (cliffbox.ts NOTCH_SETS.every), the step B6 march (BoxOpt.notchB6: BEFORE)
//   cf       the same notches, the coarse-first march (AFTER)
// (1) stills at side16, side2, foot for b6 and cf (local/nested/<tag>-<pose>-<cfg>.png), holes; (2) at side2 and foot,
// interleaved rounds: the box pass's GPU ms, the page's frame ms, the march steps mean / max a box pixel and the pixels
// at the 96 cap (?cliffDbg=12 info readback). The hit-kind stills (?cliffDbg=13, <pose>-<cfg>-kind.png) show which
// pixels are notched in each.
// node scripts/nested-rB8-notch.mjs --chromeargs ignore-certificate-errors --port 5461 [--rounds 3] [--tag rB8]
import { run, sleep } from './lib/runner.mjs';
import fs from 'node:fs';

const NONE = { on: false, pct: [0, 0, 0, 0, 0, 0, 0], dep: [0, 1, 1, 1, 1, 1, 1], frac: [0.1, 0.9], slotLog: 2 };
const EVERY = { on: true, pct: [0, 30, 25, 20, 15, 15, 15], dep: [0, 2, 3, 4, 4, 4, 4], frac: [0.1, 0.9], slotLog: 2 };
const CFG = {
  fine6: { opt: { cull: true, order: true, notchB6: true }, notch: NONE },
  fine: { opt: { cull: true, order: true }, notch: NONE },
  b6: { opt: { cull: true, order: true, notchB6: true }, notch: EVERY },
  cf: { opt: { cull: true, order: true }, notch: EVERY },
};

await run({ name: 'rB8-notch', kind: 'behaviour', size: '960x640', dpr: 1, echo: false }, async (R) => {
  const port = R.opt('port', '5461');
  const tag = R.opt('tag', 'rB8');
  const rounds = Number(R.opt('rounds', '3'));
  const only = R.opt('only', '');
  fs.mkdirSync('local/nested', { recursive: true });
  const page = await R.page();
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') console.log(`[page ${m.type()}] ${m.text()}`);
  });
  page.on('pageerror', (e) => console.log(`[page exception] ${e.message}`));
  await page.goto(`https://localhost:${port}/nested.html?cliff=5&smooth=1&gputime=1&cliffT=2&cliffGap=1&cliffNotch=every&cliffAmp=0,256,256,256,256,256,256&cliffWLv=5&cliffPx=2`, { waitUntil: 'load' });
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
  const frames = (n) => page.evaluate(async (n) => {
    for (let i = 0; i < n; i++) await new Promise((res) => requestAnimationFrame(res));
  }, n);
  const apply = (c) =>
    page.evaluate(async (c) => {
      const a = nested.app;
      const cb = a.render.cliffBox;
      a.frozen = false;
      cb.opt = c.opt;
      for (let i = 0; i < 600 && !cb.optReady; i++) {
        cb.pipe();
        await new Promise((res) => setTimeout(res, 50));
      }
      cb.setNotch(c.notch);
      await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(res))));
      return cb.optReady;
    }, c);
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
  /** the info target read back: per box pixel (a = 0.5 under ?cliffDbg=12) its march steps (b x 255) */
  const steps = () =>
    page.evaluate(async () => {
      const a = nested.app;
      a.render.cliffDbg = 12;
      a.frozen = false;
      await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(res))));
      const r = a.render;
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
      await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
      return { n, mean: n ? sum / n : 0, max, capped };
    });
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
    side2: [side(1.5, 0.3), 3],
    foot: [look([C[0] + spot.dir[0] * 0.25 + perp[0] * 0.05, C[1] + spot.dir[1] * 0.25 + perp[1] * 0.05, spot.lo + 0.04], [C[0], C[1], spot.hi]), 3],
    side16: [side(8, 1.6), 2],
  };
  const go = async (name) => {
    const [v, minLive] = poses[name];
    await page.evaluate((v) => nested.setView(v), v);
    await settle(minLive);
    return v;
  };
  // (1) stills b6 / cf, holes, steps, kind stills
  for (const name of only ? [only] : ['side16', 'side2', 'foot']) {
    const v = await go(name);
    for (const k of ['b6', 'cf']) {
      await apply(CFG[k]);
      await sleep(250);
      await page.screenshot({ path: `local/nested/${tag}-${name}-${k}.png` });
      const ho = await holes(v.pitch);
      await page.evaluate(async () => {
        nested.app.render.cliffDbg = 13;
        await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(res))));
      });
      await page.screenshot({ path: `local/nested/${tag}-${name}-${k}-kind.png` });
      const st = await steps();
      console.log(`still ${name} ${k}: holes ${ho}; steps mean ${st.mean.toFixed(1)} max ${st.max}, at the cap ${st.capped} of ${st.n} box px`);
    }
  }
  if (R.opt('stillsOnly', '') === '1') return;
  // (2) cost, interleaved
  for (const name of only ? [only].filter((n) => n !== 'side16') : ['side2', 'foot']) {
    await go(name);
    const res = Object.fromEntries(Object.keys(CFG).map((k) => [k, { box: [], f: [], st: null }]));
    for (let rep = 0; rep < rounds; rep++)
      for (const k of Object.keys(CFG)) {
        await apply(CFG[k]);
        const r = await page.evaluate(async () => {
          const a = nested.app;
          a.frozen = true;
          await new Promise((res) => setTimeout(res, 400));
          a.render.gpuSamples.clear();
          const c0 = a.frameCount;
          await new Promise((res) => setTimeout(res, 2500));
          const f = a.frames.slice(-(a.frameCount - c0));
          let box = 0;
          for (const [k, s] of a.render.gpuSamples.entries()) if (k === 'cliff boxes') box = s.ms.reduce((x, y) => x + y, 0) / Math.max(1, s.ms.length);
          return { f: f.reduce((x, y) => x + y, 0) / Math.max(1, f.length), box };
        });
        res[k].box.push(r.box);
        res[k].f.push(r.f);
        if (rep === 0) res[k].st = await steps();
      }
    const med = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)].toFixed(2);
    for (const k of Object.keys(CFG)) {
      const s = res[k];
      console.log(`cost ${name} ${k}: box pass ms ${s.box.map((x) => x.toFixed(2)).join(' ')} (median ${med(s.box)}); frame ms ${s.f.map((x) => x.toFixed(2)).join(' ')} (median ${med(s.f)}); steps mean ${s.st.mean.toFixed(1)} max ${s.st.max}, at the cap ${s.st.capped} of ${s.st.n} box px`);
    }
  }
  await frames(1);
});
