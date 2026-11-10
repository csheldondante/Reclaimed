// (U2, docs/design/UNIT_MINDS_U2.md §5: the riskiest part first) The hunt field's cost with its seeds on the GPU, a
// toggle diff: 200 raiders against 200 guards on the user's start town (the `town` recipe), 412 x 915, ?q=low (the
// lab's), at 1x. Run it with the page's flags, each its own page:
//   node scripts/lab.mjs run scripts/lab/huntbench.mjs --flags "&agentprof=1&huntgpu=0"
//   node scripts/lab.mjs run scripts/lab/huntbench.mjs --flags "&agentprof=1&huntgpu=1"
//   node scripts/lab.mjs run scripts/lab/huntbench.mjs --flags "&agentprof=1&huntgpu=1&huntsrc=1"
// Reports, over the fight's `seconds` (args; default 20): the agents' GPU a frame by stage (ms mean / p95 / max: relax,
// hunt — the seed kernels —, in, peel, units), each sweep's front (chunks relaxed) and the chunks that asked (past
// FRONT_CAP 32: carried), the hunters and the dead.
export const recipe = 'town';

export default async function (lab, args) {
  const n = args.n ?? 200;
  const seconds = args.seconds ?? 20;
  lab.sims(args.sims ?? 'fortress');
  const units = lab.units;
  const [hx, hy] = lab.heap;
  const R = window.reclaimed;
  const prof = R?.core?.host?.profiler;
  if (!prof?.enabled) throw new Error('huntbench: no GPU timestamps on this page (the profiler is off)');
  // (the GPU's timings are read back only while asked for: main.ts reads them with the perf overlay open)
  const wasActive = prof.active;
  prof.active = true;
  // the two sides: guards round the heap, raiders east of them (rows a cell apart), the fight between
  const side = (k, x0, y0) => [x0 + (k % 20) * 1.1, y0 + Math.floor(k / 20) * 1.1];
  const guards = [];
  const raiders = [];
  for (let k = 0; k < n; k++) guards.push(units.spawn('guard', side(k, hx - 22, hy - 6), 'f-town', { role: 'guard', sight: 14, health: 3 }));
  for (let k = 0; k < n; k++) raiders.push(units.spawn('raider', side(k, hx + 18, hy - 6), 'f-raid', { role: 'raider', hostile: true, sight: 60, health: 3 }));
  let dead = 0;
  units.died.push(() => dead++);
  lab.look(hx, hy, args.zoom ?? 5);
  // (settled on their feet first)
  await lab.run(2, 1, { renderEvery: 1 });
  const g = new Map();
  let on = true;
  const prev = prof.onFrame;
  prof.onFrame = (f, ms, t) => {
    prev?.(f, ms, t);
    if (!on) return;
    const a = {};
    for (const [k, v] of prof.lastPasses) if (k.startsWith('agents')) a[k] = v;
    g.set(f, { span: ms, a });
  };
  window.__agentLog = [];
  const run = await lab.run(seconds, 1, { renderEvery: 1 });
  on = false;
  await new Promise((r) => setTimeout(r, 400));
  prof.onFrame = prev;
  prof.active = wasActive;
  const ticks = window.__agentLog;
  window.__agentLog = undefined;
  const pct = (a, q) => (a.length ? a[Math.min(a.length - 1, Math.floor(a.length * q))] : 0);
  const stat = (v) => {
    v = v.slice().sort((a, b) => a - b);
    return { mean: +(v.reduce((s, x) => s + x, 0) / Math.max(1, v.length)).toFixed(3), p95: +pct(v, 0.95).toFixed(2), max: +(v[v.length - 1] ?? 0).toFixed(2), n: v.length };
  };
  const frames = [...g.values()];
  const stages = ['agents-in', 'agents-hunt', 'agents-peel', 'agents-relax', 'agents-units', 'agents-step', 'agents-notice'];
  const by = Object.fromEntries(stages.map((k) => [k, stat(frames.map((f) => f.a[k] ?? 0))]));
  const total = stat(frames.map((f) => Object.values(f.a).reduce((s, x) => s + x, 0)));
  const fronts = ticks.flatMap((t) => t.front);
  const asked = ticks.flatMap((t) => t.asked ?? []);
  const carried = asked.map((a) => Math.max(0, a - 32));
  const flags = new URLSearchParams(location.search);
  const out = {
    flags: { huntgpu: flags.get('huntgpu'), huntsrc: flags.get('huntsrc') },
    run,
    frames: frames.length,
    agentsGpu: total,
    by,
    front: stat(fronts),
    asked: stat(asked),
    carried: { ...stat(carried), sweepsCarrying: carried.filter((c) => c > 0).length, sweeps: carried.length },
    hunting: units.stats.hunting,
    dead,
    left: { guards: guards.filter((id) => units.get(id)?.alive).length, raiders: raiders.filter((id) => units.get(id)?.alive).length },
  };
  await lab.shot(`huntbench-${flags.get('huntgpu') ?? '0'}${flags.get('huntsrc') === '1' ? 'src' : ''}`);
  console.log(JSON.stringify(out));
  return out;
}
