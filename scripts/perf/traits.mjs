// LW1 (traits): what the trait system costs on the phone tier, by toggling it (the user, round 120: "the tiled rendering
// on phones makes per system unreliable … You need to toggle systems to measure the diff"). The atlas with every system
// in play, as the deployed page runs it (q=low, the phone proxy's 412×915); `--agents` units spawned round the camera,
// half of them walking dead, under a lasting sanctuary (slow: nobody dies in the run) and a fear field, so every rule has
// work. Then windows of `--seconds` with the stage on and off in turn (`--rounds` each): the whole frame's GPU ms (the
// profiler's), the agents' pass (the stage runs inside it) and the traits system's CPU encode, on minus off.
//   node scripts/perf/traits.mjs [--agents 1000] [--seconds 3] [--rounds 4] [--q low]
// Timing kind. JSON to data/perf/traits-<adapter>.json.
import fs from 'node:fs';
import path from 'node:path';
import { run, ROOT } from '../lib/runner.mjs';

await run({ name: 'perf-traits', kind: 'timing' }, async (R) => {
  const n = Number(R.opt('agents', 1000));
  const seconds = Number(R.opt('seconds', 3));
  const rounds = Number(R.opt('rounds', 4));
  const p = await R.level({ level: 'atlas', perf: '1', q: R.opt('q', 'low') });
  await R.simSeconds(p, 3);
  const setup = await p.evaluate((n) => {
    const r = window.reclaimed;
    const [x, y] = r.camera.target;
    const living = r.agents.spawn(n / 2, x - 6, y, { spread: 12, group: 0 });
    const dead = r.agents.spawn(n / 2, x + 6, y, { spread: 12, group: 0 });
    r.traits.assign(dead, ['undead']);
    r.traits.apply({ op: 'heal', rate: 0.1, at: [x, y], radius: 30 });
    r.traits.apply({ op: 'status', status: 'frightened', lasts: 2, at: [x - 6, y], radius: 8, seconds: 1e6 });
    return { adapter: r.core.host.gpu.adapterInfo, living: living.length, dead: dead.length, modules: r.traits.modules() };
  }, n);
  R.log(`setup ${JSON.stringify(setup)}`);
  await R.simSeconds(p, 2);
  const window_ = (on) =>
    p.evaluate(
      async ({ on, seconds }) => {
        const r = window.reclaimed;
        r.traits.enabled = on;
        await new Promise((res) => setTimeout(res, 500));
        const prof = r.core.host.profiler;
        prof.resetTotals();
        const cpu0 = r.core.sim.encodeTotals.get('traits') ?? 0;
        const t0 = performance.now();
        await new Promise((res) => setTimeout(res, seconds * 1000));
        const f = Math.max(1, prof.framesResolved);
        const cpu = ((r.core.sim.encodeTotals.get('traits') ?? 0) - cpu0) / ((performance.now() - t0) / 1000) / 60;
        return { on, frames: prof.framesResolved, gpuFrameMs: prof.gpuTotalMs / f, agentsMs: (prof.totalMs.get('agents') ?? 0) / f, traitsCpuMsPerTick: cpu };
      },
      { on, seconds },
    );
  const rows = [];
  for (let i = 0; i < rounds; i++) for (const on of [true, false]) rows.push(await window_(on));
  await p.evaluate(() => (window.reclaimed.traits.enabled = true));
  const avg = (on, k) => rows.filter((r) => r.on === on).reduce((a, r) => a + r[k], 0) / rounds;
  const result = {
    gpuFrameMs: { on: +avg(true, 'gpuFrameMs').toFixed(3), off: +avg(false, 'gpuFrameMs').toFixed(3) },
    agentsPassMs: { on: +avg(true, 'agentsMs').toFixed(3), off: +avg(false, 'agentsMs').toFixed(3) },
    traitsCpuMsPerTick: +avg(true, 'traitsCpuMsPerTick').toFixed(4),
  };
  result.gpuFrameMs.diff = +(result.gpuFrameMs.on - result.gpuFrameMs.off).toFixed(3);
  result.agentsPassMs.diff = +(result.agentsPassMs.on - result.agentsPassMs.off).toFixed(3);
  R.log(`result ${JSON.stringify(result)}`);
  const out = { when: new Date().toISOString(), size: `${R.W}x${R.H}`, dpr: R.dpr, agents: n, ...setup, rows, result };
  const name = setup.adapter.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase().slice(0, 40) || 'unknown';
  const file = path.join(ROOT, 'data', 'perf', `traits-${name}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  R.log(`wrote ${file}`);
  R.check('windows measured', rows.every((r) => r.frames > 10), rows.map((r) => r.frames));
});
