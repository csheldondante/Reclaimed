// (round 128o, DA-B22) What costs at 16x (the user on the Pixel 9a: "16x build speed is slow"): the fortress on the
// user's start town (`town`), Build pressed, the game's own frames at a speed with parts of the tick toggled off, each a
// phase: the frame's interval (p50/p95), its CPU (rAF callbacks), its GPU (the profiler's frame), the ticks a frame.
// A toggle diff: what a part costs is the phase with it against the phase without (docs/DEVLOG round 128o).
//   node scripts/lab.mjs run scripts/lab/speedcost.mjs [--args '{"seconds":6,"phases":["1x all","16x all"],"top":20}']
//     [--flags "&agentprof=1"] (the agents' tick a timed pass a stage: agents-in, -peel, -relax, -units, -step, -traits,
//     -ride, -draw)
export const recipe = 'town';

export default async function (lab, args) {
  const seconds = args.seconds ?? 6;
  const R = window.reclaimed;
  const scene = R.scene;
  const core = R.core;
  const prof = core.host.profiler;
  prof.active = true;
  const all = core.sim.systems.map((s) => s.name);
  const raf = window.requestAnimationFrame.bind(window);
  const S = { iv: [], cpu: [], gpu: [], gpuSum: [], untimed: 0, last: 0, acc: 0 };
  window.requestAnimationFrame = (cb) =>
    raf((t) => {
      const t0 = performance.now();
      try {
        cb(t);
      } finally {
        S.acc += performance.now() - t0;
      }
    });
  let on = true;
  const tick = (t) => {
    if (S.last) S.iv.push(t - S.last);
    S.cpu.push(S.acc);
    S.last = t;
    S.acc = 0;
    if (on) raf(tick);
  };
  // (each frame's GPU passes summed by name: what scales with the speed)
  const passes = new Map();
  prof.listen((_n, ms) => {
    S.gpu.push(ms);
    S.untimed = Math.max(S.untimed, prof.untimed);
    let sum = 0;
    for (const [k, v] of prof.lastPasses) {
      passes.set(k, (passes.get(k) ?? 0) + v);
      sum += v;
    }
    S.gpuSum.push(sum);
  });
  raf(tick);
  const q = (a, p) => {
    const s = [...a].sort((x, y) => x - y);
    return s.length ? +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(1) : null;
  };
  const unitsUpdate = scene.units?.update.bind(scene.units);
  const only = args.phases ? new Set(args.phases) : null;
  const phase = async (name, speed, sims, o = {}) => {
    if (only && !only.has(name)) return null;
    lab.sims(sims);
    if (o.noUnits && scene.units) scene.units.update = () => {};
    // (the game's own frames at this speed: lab.run's keep restores the speed it found, so it's set here)
    scene.speed = speed;
    await new Promise((r) => setTimeout(r, 1000));
    S.iv = [];
    S.cpu = [];
    S.gpu = [];
    S.gpuSum = [];
    S.untimed = 0;
    passes.clear();
    S.last = 0;
    const t0 = core.sim.tick;
    await new Promise((r) => setTimeout(r, seconds * 1000));
    const ticks = core.sim.tick - t0;
    if (scene.units && unitsUpdate) scene.units.update = unitsUpdate;
    const out = { phase: name, speed, fps: +(S.iv.length / seconds).toFixed(1), iv50: q(S.iv, 0.5), iv95: q(S.iv, 0.95), cpu50: q(S.cpu, 0.5), cpu95: q(S.cpu, 0.95), gpu50: q(S.gpu, 0.5), gpu95: q(S.gpu, 0.95), passSum50: q(S.gpuSum, 0.5), untimed: S.untimed, top: [...passes].map(([k, v]) => [k, +(v / Math.max(1, S.gpuSum.length)).toFixed(2)]).sort((a, b) => b[1] - a[1]).slice(0, args.top ?? 10), ticksPerFrame: +(ticks / Math.max(1, S.iv.length)).toFixed(2), simX: +(ticks / 60 / seconds).toFixed(2) };
    console.log(`SPEED ${JSON.stringify(out)}`);
    return out;
  };
  const without = (...drop) => all.filter((n) => !drop.includes(n));
  lab.build();
  await lab.run(4, 4, { keep: true });
  const rows = [];
  rows.push(await phase('1x all', 1, 'all'));
  rows.push(await phase('16x all', 16, 'all'));
  rows.push(await phase('16x no sims', 16, []));
  rows.push(await phase('16x fortress preset', 16, 'fortress'));
  rows.push(await phase('16x no agents/traits', 16, without('agents', 'traits')));
  rows.push(await phase('16x no water', 16, without('water')));
  rows.push(await phase('16x no structure judge', 16, without('structure', 'project', 'structtick')));
  rows.push(await phase('16x all, no units update', 16, 'all', { noUnits: true }));
  on = false;
  window.requestAnimationFrame = raf;
  scene.speed = 0;
  lab.sims('all');
  return { systems: all, rows };
}
