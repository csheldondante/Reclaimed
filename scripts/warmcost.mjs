// Round 112 (testspeed): what a warmup tick costs the GPU, system by system. On the atlas level once it's up (the sim
// held: scene.speed 0), with nothing asleep as in the warmup (Globals' sleep masks cleared for the probe, put back
// after): `--ticks` steps of every system the warmup runs, timed to the GPU's finish; then the same with each system
// left out — its share is the difference. A timing check (the GPU alone).
//   node scripts/warmcost.mjs [--ticks 120] [--at x,y]
import { run } from './lib/runner.mjs';

await run({ name: 'warmcost', kind: 'timing' }, async (R) => {
  const params = { level: 'atlas' };
  if (R.opt('at', '')) params.at = R.opt('at');
  const p = await R.level(params);
  const n = Number(R.opt('ticks', 120));
  const res = await p.evaluate(async (n) => {
    const Rc = window.reclaimed;
    const core = Rc.core;
    Rc.scene.speed = 0;
    const g = core.globals;
    const dev = core.host.gpu.device;
    await dev.queue.onSubmittedWorkDone();
    const names = core.sim.systems.map((s) => s.name).filter((x) => x !== 'ecology' && x !== 'water');
    const time = async (skip) => {
      const sl = g.sleep;
      const dr = g.drowse;
      g.sleep = undefined;
      g.drowse = undefined;
      const t0 = performance.now();
      for (let i = 0; i < n; i++) core.sim.step(g, (s) => s.name !== 'ecology' && s.name !== 'water' && s.name !== skip);
      const t1 = performance.now();
      await dev.queue.onSubmittedWorkDone();
      g.sleep = sl;
      g.drowse = dr;
      return { cpu: (t1 - t0) / n, all: (performance.now() - t0) / n };
    };
    await time('');
    const base = await time('');
    const out = { base: +base.all.toFixed(2), baseCpu: +base.cpu.toFixed(2), share: {} };
    for (const s of names) {
      const t = await time(s);
      out.share[s] = +(base.all - t.all).toFixed(2);
    }
    out.share = Object.fromEntries(Object.entries(out.share).sort((a, b) => b[1] - a[1]));
    out.window = [core.dims.w, core.dims.h, core.dims.zMax];
    return out;
  }, n);
  console.log(`WARMCOST ${JSON.stringify(res)}`);
});
