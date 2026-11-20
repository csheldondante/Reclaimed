// Nested scales (round 32 step B1): the cliff rule painted on the real terrain (?cliff=4, the module variant: render.ts
// cliffRuleCode) against the plain textured sheet, at round 31's poses (side16, side2) and one from above the root's
// steepest rim. The switch is render.cliffRuleOn (picks the variant's sheet pipeline per frame), so each pair is one page,
// the app frozen, the same windows. Also: the 16 m level's heights read back ONCE (test only) into
// local/nested/rB1-heights.json for test/gpu/nested-cliffrule-wgsl.test.ts, the window's kinds counted with the TS rule,
// the frame time off / on at side2 (alternating, 3 s each, 3 rounds; ?gputime=1 pass times) and the pipelines' creation
// times.
// node scripts/nested-rB1-stills.mjs --chromeargs ignore-certificate-errors --port 5461
import { run, sleep } from './lib/runner.mjs';
import fs from 'node:fs';

await run({ name: 'rB1-stills', kind: 'behaviour', size: '960x640', dpr: 1, echo: false }, async (R) => {
  const port = R.opt('port', '5461');
  const tag = R.opt('tag', 'rB1');
  fs.mkdirSync('local/nested', { recursive: true });
  const page = await R.page();
  page.on('console', (m) => {
    if (m.type() === 'error') console.log(`[page ${m.type()}] ${m.text()}`);
  });
  page.on('pageerror', (e) => console.log(`[page exception] ${e.message}`));
  await page.goto(`https://localhost:${port}/nested.html?cliff=4&smooth=1&gputime=1${R.opt('extra', '')}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.nested && nested.app.pipesReady && nested.app.genReady && nested.app.frameCount > 30, { timeout: 180000, polling: 200 });
  await page.waitForFunction(() => nested.app.render.texDrawn, { timeout: 120000, polling: 200 });
  const pipes = await page.evaluate(() => ({ tex: nested.app.render.texCompileMs, rule: nested.app.render.cliffRuleCompileMs, S: nested.app.nest.S, k: nested.app.nest.k, mpu: nested.app.render.mpu }));
  console.log(`pipelines: textured ${pipes.tex.toFixed(0)} ms (all three with the variant in parallel), variant sheet ${pipes.rule.toFixed(0)} ms; segments S ${pipes.S} (fragment-stage storage buffers: table + S = ${1 + pipes.S}); k ${pipes.k}, root ${pipes.mpu} m`);
  // (minLive: wait until that many levels are open too: side16 needs the 16 m level, which B1's first run shot without)
  const settle = async (minLive = 0) => {
    for (let i = 0; i < 400; i++) {
      await sleep(150);
      const ok = await page.evaluate((m) => nested.app.nest.settled && !nested.app.nest.switching && !nested.app.nest.fieldJob && nested.app.nest.live >= m, minLive);
      if (ok && i > 10) break;
    }
    await sleep(600);
  };
  const look = (eye, at) => {
    const d = [at[0] - eye[0], at[1] - eye[1], at[2] - eye[2]];
    const n = Math.hypot(...d);
    return { yaw: Math.atan2(-d[1], -d[0]), pitch: Math.asin(-d[2] / n), eye };
  };
  const info = () => page.evaluate(() => ({ live: nested.app.nest.live, eyeLevel: nested.app.nest.camOut[30] }));
  const pair = async (name) => {
    await page.evaluate(() => (nested.app.frozen = true));
    const out = [];
    for (const on of [false, true]) {
      await page.evaluate((on) => (nested.app.render.cliffRuleOn = on), on);
      await sleep(500);
      const file = `local/nested/${tag}-${name}-cliff${on ? 4 : 0}.png`;
      await page.screenshot({ path: file });
      out.push(file);
    }
    const st = await info();
    await page.evaluate(() => (nested.app.frozen = false));
    console.log(`${name}: levels ${st.live}, eye level ${st.eyeLevel}; ${out.join(' ')}`);
  };
  // the root window's steepest step (as nested-r31-stills.mjs)
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
  // (the 16 m level's heights, once, test only; and its kinds by the TS rule, in the page through Vite)
  const dump = async (name) => {
    const r = await page.evaluate(async () => {
      const a = nested.app;
      const L = 1;
      const w = a.nest.wins[L];
      if (!w) return null;
      const s = await a.nest.readAll();
      const z = [];
      let missing = 0;
      for (let y = 0; y < w.n; y++)
        for (let x = 0; x < w.n; x++) {
          const c = s.column(L, w.gx + x, w.gy + y);
          if (!c.z1.length) missing++;
          z.push(c.z1.length ? c.z1[c.z1.length - 1] : 0);
        }
      const m = await import('/src/nested/exp/cliffrule.ts');
      const p = m.defaultParams();
      const h = new Int32Array(w.n * w.n);
      for (let i = 0; i < h.length; i++) {
        const v = Math.fround(z[i]) * m.COARSE_U;
        const f = Math.floor(v);
        h[i] = f + (v - f >= 0.5 ? 1 : 0);
      }
      const f = { nx: w.n, ny: w.n, h };
      const kinds = [0, 0, 0, 0];
      let steepRange = 0;
      for (let cy = 0; cy < w.n; cy++)
        for (let cx = 0; cx < w.n; cx++) {
          const k = m.kindOf(f, cx, cy, p);
          kinds[k.kind]++;
          if (k.kind === m.KIND_SPLIT) steepRange += (k.hi - k.lo) / 64;
        }
      return { gx: w.gx, gy: w.gy, n: w.n, z, missing, kinds, meanSplitRangeM: kinds[3] ? steepRange / kinds[3] : 0 };
    });
    if (!r) return console.log(`${name}: no 16 m window`);
    fs.writeFileSync(`local/nested/${tag}-heights${name === 'side2' ? '' : `-${name}`}.json`, JSON.stringify({ gx: r.gx, gy: r.gy, n: r.n, z: r.z }));
    console.log(`${name}: 16 m window ${r.gx},${r.gy} n ${r.n}, columns with no solid record ${r.missing}; kinds sheet ${r.kinds[0]}, top ${r.kinds[1]}, bottom ${r.kinds[2]}, split ${r.kinds[3]} (split cells' mean hi - lo ${r.meanSplitRangeM.toFixed(1)} m)`);
  };
  const D16 = 8;
  const D2 = 1.5;
  await page.evaluate((v) => nested.setView(v), side(D16, D16 * 0.2));
  await settle(2);
  await pair('side16');
  await dump('side16');
  await page.evaluate((v) => nested.setView(v), side(D2, D2 * 0.2));
  await settle();
  await pair('side2');
  await dump('side2');
  // from above the rim: over the high side, looking down at the step
  await page.evaluate((v) => nested.setView(v), look([C[0] - spot.dir[0] * 0.25, C[1] - spot.dir[1] * 0.25, spot.hi + 0.9], [C[0] + spot.dir[0] * 0.15, C[1] + spot.dir[1] * 0.15, zMid]));
  await settle();
  await pair('above');
  await dump('above');
  if (R.opt('bench', '1') !== '1') return;
  // frame time, the variant off / on, at side2
  await page.evaluate((v) => nested.setView(v), side(D2, D2 * 0.2));
  await settle();
  await page.evaluate(() => (nested.app.frozen = true));
  const res = { off: { f: [], g: [] }, on: { f: [], g: [] } };
  for (let rep = 0; rep < 3; rep++)
    for (const on of [false, true]) {
      const r = await page.evaluate(async (on) => {
        const a = nested.app;
        a.render.cliffRuleOn = on;
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
      res[on ? 'on' : 'off'].f.push(+r.f.toFixed(2));
      res[on ? 'on' : 'off'].g.push(+r.g.toFixed(3));
      if (rep === 2) console.log(`side2 passes (${on ? 'cliff=4' : 'cliff=0'}): ${JSON.stringify(r.per)}`);
    }
  await page.evaluate(() => (nested.app.frozen = false));
  console.log(`side2 frame time cliff=0: frame ms ${res.off.f.join(' / ')}, GPU passes ms ${res.off.g.join(' / ')}`);
  console.log(`side2 frame time cliff=4: frame ms ${res.on.f.join(' / ')}, GPU passes ms ${res.on.g.join(' / ')}`);
});
