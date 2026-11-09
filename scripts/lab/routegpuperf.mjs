// (DA-A22) The town's route network on the GPU (build/routegpu.ts): its toggle diff on the start town at 412x915 q=low.
// Phase "off": the frames with no solve (idle: nothing dispatched — the design's case between edits). Phase "on": a solve
// started as soon as the last one's answer is read (cut every edge from the live columns, five component solves to
// convergence, the answer read: far more often than edits ever ask). Per phase the rAF interval p50/p95 and the solves'
// count and wall ms; and the GPU's reach against the CPU net's, structure by structure.
//   node scripts/lab.mjs run scripts/lab/routegpuperf.mjs --recipe town [--args '{"seconds":8}']
export const recipe = 'town';

export default async function (lab, args) {
  const seconds = args.seconds ?? 8;
  while (!lab.ready) await new Promise((r) => setTimeout(r, 100));
  const R = window.reclaimed;
  const routes = R.townRoutes();
  if (!routes) throw new Error('routegpuperf: no town routes (the fortress not started)');
  const f = lab.fortress();
  await f.settled();
  // agreement with the CPU net
  const s0 = await routes.solve();
  const cpu = f.roads.net.reach.reachedIds;
  const diff = [];
  let gpuReached = 0;
  for (let i = 0; i < s0.ids.length; i++) {
    const g = !!(s0.words[i] & 1);
    gpuReached += g ? 1 : 0;
    if (g !== cpu.has(s0.ids[i])) diff.push({ id: s0.ids[i], type: f.plan.structure(s0.ids[i]).type, cpu: cpu.has(s0.ids[i]), gpu: g, word: s0.words[i] });
  }
  const iv = [];
  let last = 0;
  let phase = null;
  const tick = (t) => {
    if (last && phase) iv.push([phase, t - last]);
    last = t;
    if (phase !== 'done') requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  const solves = { off: [], on: [] };
  const run = async (name, solving) => {
    phase = name;
    const t1 = performance.now() + seconds * 1000;
    while (performance.now() < t1) {
      if (solving) solves[name].push((await routes.solve()).ms);
      else await new Promise((r) => setTimeout(r, 50));
    }
  };
  await lab.run(1, 1);
  await run('off', false);
  await run('on', true);
  await run('off2', false);
  phase = 'done';
  const stat = (name) => {
    const v = iv.filter((p) => p[0] === name).map((p) => p[1]).sort((a, b) => a - b);
    const q = (x) => +(v[Math.min(v.length - 1, Math.floor(x * v.length))] ?? 0).toFixed(2);
    return { frames: v.length, p50: q(0.5), p95: q(0.95), max: q(0.999) };
  };
  const sm = solves.on.slice().sort((a, b) => a - b);
  return {
    structures: s0.ids.length,
    cpuReached: cpu.size,
    gpuReached,
    diff,
    rounds: s0.rounds,
    frame: { off: stat('off'), on: stat('on'), off2: stat('off2') },
    solves: { n: sm.length, perSecond: +(sm.length / seconds).toFixed(1), p50: +(sm[sm.length >> 1] ?? 0).toFixed(2), max: +(sm[sm.length - 1] ?? 0).toFixed(2) },
  };
}
