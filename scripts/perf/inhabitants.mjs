// Round 117 (inhabitants): what creatures cost the GPU on the phone tier — the atlas with every system in play (as
// the deployed page runs it), ?life=empty, then 100, 1 000 and 5 000 creatures spawned in herds round the camera
// (deer with wolves among them, one in ten a crow), all in view. Per count: the inhabitants' own passes (bins,
// behave, animate, mesh: GPU ms a frame from the timestamp queries) and the whole frame's GPU ms, against none.
//   node scripts/perf/inhabitants.mjs [--counts 100,1000,5000] [--seconds 5] [--zoom 6] [--size 412x915 --dpr 2.6]
// Timing kind (the GPU alone). JSON to data/perf/inhabitants-<adapter>.json. < 2 min alone.
import fs from 'node:fs';
import path from 'node:path';
import { run, ROOT } from '../lib/runner.mjs';

await run({ name: 'perf-inhabitants', kind: 'timing' }, async (R) => {
  const counts = R.opt('counts', '100,1000,5000').split(',').map(Number);
  const seconds = Number(R.opt('seconds', 5));
  const zoom = Number(R.opt('zoom', 6));
  const p = await R.level({ level: 'atlas', life: 'empty', perf: '1', q: R.opt('q', 'low') });
  await R.simSeconds(p, 3);
  const measure = async () =>
    p.evaluate(async (seconds) => {
      const prof = window.reclaimed.core.host.profiler;
      prof.resetTotals();
      await new Promise((r) => setTimeout(r, seconds * 1000));
      const f = Math.max(1, prof.framesResolved);
      const life = {};
      let lifeMs = 0;
      for (const [k, v] of prof.totalMs) if (k.startsWith('life')) (life[k] = +(v / f).toFixed(3)), (lifeMs += v / f);
      return { frames: prof.framesResolved, gpuFrameMs: +(prof.gpuTotalMs / f).toFixed(3), lifeMs: +lifeMs.toFixed(3), passes: life };
    }, seconds);
  const setup = await p.evaluate((zoom) => {
    const r = window.reclaimed;
    r.camera.zoom = zoom;
    return { adapter: r.core.host.gpu.adapterInfo, target: [...r.camera.target], view: [r.camera.viewportW / zoom, r.camera.viewportH / zoom] };
  }, zoom);
  const base = await measure();
  R.log(`none: ${JSON.stringify(base)}`);
  const rows = [];
  for (const n of counts) {
    const spawned = await p.evaluate((n) => {
      const r = window.reclaimed;
      const life = r.inhabitants;
      for (const g of life.groups()) life.remove(g.id);
      const deer = life.define({ id: 'deer', plan: 'quadruped', proportions: { size: 1.15 }, palette: { body: '#a0703f' }, behaviour: { kind: 'herd' } });
      const wolf = life.define({ id: 'wolf', plan: 'quadruped', proportions: { size: 0.85 }, palette: { body: '#6b6f78' }, secondary: { fur: 0.7 }, behaviour: { kind: 'stalker', prey: ['deer'] } });
      const crow = life.define({ id: 'crow', plan: 'bird', proportions: { size: 0.4 }, palette: { body: '#1d1f26' }, behaviour: { kind: 'flock' } });
      // herds of 20 on a grid over the view (its half-sizes in world units), a wolf with each, a flock every tenth
      const [tx, ty] = r.camera.target;
      const W = r.camera.viewportW / r.camera.zoom;
      const H = r.camera.viewportH / r.camera.zoom;
      const herds = Math.ceil(n / 20);
      const side = Math.ceil(Math.sqrt(herds));
      let made = 0;
      for (let k = 0; k < herds && made < n; k++) {
        const x = tx + ((k % side) / Math.max(1, side - 1) - 0.5) * W * 0.8;
        const y = ty + (Math.floor(k / side) / Math.max(1, side - 1) - 0.5) * H * 0.5;
        const m = Math.min(20, n - made);
        const sp = k % 10 === 9 ? crow : deer;
        const g = life.spawnGroup(sp, [x, y], Math.max(1, m - 1));
        if (sp === deer) life.drive(g, { kind: 'roam', around: [x, y], radius: 12 });
        made += Math.max(1, m - 1);
        if (made < n) {
          life.spawnGroup(wolf, [x + 10, y + 6], 1);
          made++;
        }
      }
      return life.count;
    }, n);
    await R.simSeconds(p, 2);
    const m = await measure();
    const row = { creatures: spawned, ...m, overNoneMs: +(m.gpuFrameMs - base.gpuFrameMs).toFixed(3) };
    rows.push(row);
    R.log(`${n}: ${JSON.stringify(row)}`);
  }
  const out = { when: new Date().toISOString(), size: `${R.W}x${R.H}`, dpr: R.dpr, zoom, ...setup, none: base, rows };
  const name = setup.adapter.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase().slice(0, 40) || 'unknown';
  const file = path.join(ROOT, 'data', 'perf', `inhabitants-${name}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  R.log(`wrote ${file}`);
  for (const r of rows) R.check(`${r.creatures} creatures measured`, r.frames > 10, r.frames);
});
