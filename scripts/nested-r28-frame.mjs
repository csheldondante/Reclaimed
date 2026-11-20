// Nested scales (round 28): a frame broken into its GPU passes at the owner's phone situations, sheets against the field
// mesh (?gputime=1: a render pass a level and one for the sky, each timed by timestamp queries and its fragments counted
// by an occlusion query; measurement only). Per pose: the textured draw (tex=1, canopy on) per pass; the same with the
// canopy off and flat (tex=0), whose differences are the canopy's and the textured shading's cost; triangles drawn per
// level (a readback) and the overdraw (fragments that passed the depth test / screen pixels).
// node scripts/nested-r28-frame.mjs --chromeargs "ignore-certificate-errors,enable-webgpu-developer-features" --port 5461
//   [--order sheets,field] [--size 446x1000] [--dpr 2] [--frames 90] [--tag r28f]
import { run, sleep } from './lib/runner.mjs';
import fs from 'node:fs';

await run({ name: 'r28-frame', kind: 'timing', size: '446x1000', dpr: 2, echo: false }, async (R) => {
  const port = R.opt('port', '5461');
  const tag = R.opt('tag', 'r28f');
  const frames = Number(R.opt('frames', '90'));
  fs.mkdirSync('local/nested', { recursive: true });
  const all = {};
  for (const variant of R.opt('order', 'sheets,field').split(',')) {
    const page = await R.page();
    page.on('console', (m) => {
      if (m.type() === 'error' && !m.text().includes('404')) console.log(`[page ${m.type()}] ${m.text()}`);
    });
    page.on('pageerror', (e) => console.log(`[page exception] ${e.message}`));
    const vq = variant === 'field' ? '&field=1,2,3' : variant === 'sheets' ? '' : `&${variant}`;
    await page.goto(`https://localhost:${port}/nested.html?smooth=1&gputime=1${vq}${R.opt('extra', '')}`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.nested && nested.app.pipesReady && nested.app.genReady && nested.app.fieldDone && nested.app.frameCount > 30, { timeout: 300000, polling: 200 });
    const hasTs = await page.evaluate(() => nested.app.device.features.has('timestamp-query'));
    if (!hasTs) {
      R.check('timestamp queries on this device', false);
      return;
    }
    // (settled: no op or job in flight and the level count unchanged for 2 s)
    const settle = async () => {
      let last = -1;
      let since = 0;
      for (let i = 0; i < 400; i++) {
        await sleep(150);
        const st = await page.evaluate(() => ({ live: nested.app.nest.live, ok: nested.app.nest.settled && !nested.app.nest.switching && !nested.app.nest.fieldJob }));
        if (st.live !== last || !st.ok) {
          last = st.live;
          since = 0;
        } else if (++since > 13) break;
      }
      await sleep(500);
    };
    // the round 28 scene's spot (nested-r28.mjs): the steepest land step under 200 m
    const spot = await page.evaluate(async (below) => {
      const a = nested.app;
      const s = await a.nest.readAll();
      const w = a.nest.wins[0];
      const top = (X, Y) => {
        const c = s.column(0, X, Y);
        return c.z1[c.z1.length - 1];
      };
      let best = { x: 0, y: 0, step: 0, dir: [1, 0] };
      for (let y = w.gy + 40; y < w.gy + w.n - 40; y++)
        for (let x = w.gx + 40; x < w.gx + w.n - 40; x++) {
          if (top(x, y) > below) continue;
          for (const d of [[1, 0], [0, 1], [-1, 0], [0, -1]]) {
            const st = top(x, y) - top(x + d[0], y + d[1]);
            if (st > best.step) best = { x, y, step: st, dir: d };
          }
        }
      return { ...best, top: top(best.x, best.y) };
    }, 200 / 128);
    const m = 1 / 128;
    const look = (eye, at) => {
      const d = [at[0] - eye[0], at[1] - eye[1], at[2] - eye[2]];
      const n = Math.hypot(...d);
      return { yaw: Math.atan2(-d[1], -d[0]), pitch: Math.asin(-d[2] / n), eye };
    };
    const c = [spot.x + 0.5 + spot.dir[0] * 2.5, spot.y + 0.5 + spot.dir[1] * 2.5];
    const poses = {
      // (2 levels, 600 m up, 45 degrees: the phone's image 1)
      cliff600: look([spot.x + 0.5 - spot.dir[0] * 4 - spot.dir[1] * 2, spot.y + 0.5 - spot.dir[1] * 4 + spot.dir[0] * 2, spot.top + 600 * m], [spot.x + 0.5 + spot.dir[0], spot.y + 0.5 + spot.dir[1], spot.top - 0.5]),
      // (3 levels, about 190 m up: image 2)
      oblique190: look([c[0] - 160 * m, c[1] - 90 * m, spot.top + 190 * m], [c[0], c[1], spot.top - 0.5]),
      // (3 levels, about 100 m up, steep: images 3 and 4)
      down100: look([c[0] - 50 * m, c[1] - 30 * m, spot.top + 100 * m], [c[0], c[1], spot.top - 0.8]),
    };
    const res = {};
    for (const [name, v] of Object.entries(poses)) {
      await page.evaluate((v) => nested.setView(v), v);
      await settle();
      await page.evaluate(() => (nested.app.frozen = true));
      const live = await page.evaluate(() => nested.app.nest.live);
      if (R.flag('probe')) {
        const pr = await page.evaluate(() => ({ st: nested.app.nest.stats, log: nested.app.nest.fieldLog.map((j) => `${j.L}:${j.chunks}c/${j.frames}f`), wins: nested.app.nest.wins.slice(0, nested.app.nest.live), grow: nested.app.nest.growLog.slice(-3) }));
        console.log(`  probe: ${JSON.stringify(pr)}`);
      }
      const meas = async (what, set) => {
        await page.evaluate(set);
        await sleep(300);
        const r = await page.evaluate((n) => nested.gpuTimes(n), frames);
        return r;
      };
      const tex = await meas('tex', async () => {
        await nested.texMode(1);
        await nested.canopy(true);
      });
      const noCanopy = await meas('nocanopy', async () => {
        await nested.canopy(false);
      });
      const flat = await meas('flat', async () => {
        await nested.texMode(0);
      });
      // (the canvas at half its side: the fragments a quarter, the vertices the same)
      const half = await meas('half', async () => {
        await nested.texMode(1);
        await nested.canopy(true);
        nested.app.setDrawScale(0.5);
      });
      await page.evaluate(() => nested.app.setDrawScale(1));
      await sleep(300);
      const tris = await page.evaluate(() => nested.drawnTris());
      const lp = await page.evaluate(() => nested.levelPixels());
      await page.evaluate(() => (nested.app.frozen = false));
      const sum = (r) => Object.values(r.passes).reduce((s, p) => s + p.ms, 0);
      const frags = (r) => Object.values(r.passes).reduce((s, p) => s + (p.frags || 0), 0);
      void frags;
      res[name] = { live, tex, noCanopy, flat, half, tris, lp };
      console.log(`${variant} ${name}: ${live} levels; ${tex.pixels} pixels`);
      for (const [k, p] of Object.entries(tex.passes)) {
        const pc = noCanopy.passes[k];
        const pf = flat.passes[k];
        const ph = half.passes[k];
        const lv = k.split(' ')[0];
        console.log(`  ${k.padEnd(10)} tex ${p.ms.toFixed(3)} ms (${((100 * p.ms) / sum(tex)).toFixed(0)} %), no canopy ${pc ? pc.ms.toFixed(3) : '-'}, flat ${pf ? pf.ms.toFixed(3) : '-'}, tex at half side ${ph ? ph.ms.toFixed(3) : '-'}; pixels drawn alone ${lp.levels[lv] !== undefined ? `${((100 * lp.levels[lv]) / lp.screen).toFixed(1)} %` : '-'}; triangles ${tris[lv] ? `${tris[lv].tris} of ${tris[lv].slots} slots` : '-'}`);
      }
      const solo = Object.values(lp.levels).reduce((s, v) => s + v, 0);
      console.log(`  total GPU: tex ${sum(tex).toFixed(2)} ms, no canopy ${sum(noCanopy).toFixed(2)}, flat ${sum(flat).toFixed(2)}, half side ${sum(half).toFixed(2)}; levels drawn alone cover ${(solo / lp.screen).toFixed(3)} x the screen, the whole draw ${(lp.union / lp.screen).toFixed(3)} (overlap between levels ${((solo - lp.union) / lp.screen).toFixed(3)}); wall ${tex.wall.toFixed(1)} ms/frame (worst ${tex.worst.toFixed(1)})`);
      if (R.flag('shot')) await page.screenshot({ path: `local/nested/${tag}-${name}-${variant}.png` });
    }
    all[variant] = res;
    await page.close();
  }
  fs.writeFileSync(`local/nested/${tag}.json`, JSON.stringify(all, null, 1));
});
