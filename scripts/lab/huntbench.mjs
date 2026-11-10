// (U2, docs/design/UNIT_MINDS_U2.md §5: the riskiest part first) The hunt field's cost with its seeds on the GPU, a
// toggle diff: 200 raiders against 200 guards on the user's start town (the `town` recipe), 412 x 915, ?q=low (the
// lab's), at 1x. Run it with the page's flags, each its own page:
//   node scripts/lab.mjs run scripts/lab/huntbench.mjs --flags "&agentprof=1&huntgpu=0"
//   node scripts/lab.mjs run scripts/lab/huntbench.mjs --flags "&agentprof=1&huntgpu=1"
//   node scripts/lab.mjs run scripts/lab/huntbench.mjs --flags "&agentprof=1&huntgpu=1&frontcap=128"   (FC11 (b))
//   node scripts/lab.mjs run scripts/lab/huntbench.mjs --flags "&agentprof=1&huntgpu=1&seedcell=1"     (FC11 (c))
// Reports, over the fight's `seconds` (args; default 20): the agents' GPU a frame by stage (ms mean / p95 / max: relax,
// hunt — the seed kernels —, in, peel, units), each sweep's front (chunks relaxed) and the chunks that asked (past
// FRONT_CAP: carried), the hunters and the dead; (FC11) the asks by field — a change round the chunk or carried only —
// with the ticks each field's CPU seeds changed, restarted, were marked; the hunters' distances to their targets.
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
  // (FC11 (a): every second, how far each hunter is from its target — a raw read of the rows, the bench's own)
  const agents = units.agents;
  const near = [];
  const run = { simSeconds: 0, frames: 0, wallMs: 0 };
  for (let t = 0; t < seconds; t++) {
    const r = await lab.run(1, 1, { renderEvery: 1 });
    run.simSeconds += r.simSeconds;
    run.frames += r.frames;
    run.wallMs += r.wallMs;
    const u = new Float32Array(await agents.readRaw('units'));
    const w = new Uint32Array(u.buffer);
    for (const id of raiders) {
      // (its slot: AgentUnits' record — the lab runs this function in the page, so no helpers outside it)
      const rec = units.recs.get(id);
      const o = rec ? (rec.gpu % 8192) * 24 : -1;
      if (o < 0 || !((w[o + 3] >>> 8) & 1)) continue;
      const code = w[o + 21];
      if (!code || code & 0x80000000) continue;
      const t2 = ((code - 1) % 8192) * 24;
      near.push(Math.hypot(u[t2] - u[o], u[t2 + 1] - u[o + 1]));
    }
  }
  run.xRealtime = +(run.simSeconds / (run.wallMs / 1000)).toFixed(2);
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
  const flags = new URLSearchParams(location.search);
  const cap = Number(flags.get('frontcap') ?? 32);
  const carried = asked.map((a) => Math.max(0, a - cap));
  // (FC11: the asks by field — a change round the chunk, or carried only — and what the CPU did to each field)
  const NAMES = ['farm', 'fell', 'quarry', 'home', 'store', 'pile', 'site', 'hunt', 'foes', 'goal0', 'goal1', 'goal2', 'road'];
  const logged = ticks.filter((t) => t.fieldAsk);
  const perTick = (k, f) => +(logged.reduce((s, t) => s + (t[k]?.[f] ?? 0), 0) / Math.max(1, logged.length)).toFixed(1);
  const bit = (k, f) => ticks.filter((t) => ((t[k] ?? 0) >> f) & 1).length;
  const byField = Object.fromEntries(
    NAMES.map((nm, f) => [nm, { ask: perTick('fieldAsk', f), carry: perTick('fieldCarry', f), seedTicks: bit('seedChanged', f), restarts: bit('restarted', f), markTicks: bit('marksFor', f) }]).filter(([, v]) => v.ask + v.carry + v.seedTicks + v.restarts > 0),
  );
  const hist = (v, edges) => Object.fromEntries(edges.map((e, i) => [`<${e}`, v.filter((x) => x < e && (i === 0 || x >= edges[i - 1])).length]).concat([[`>=${edges[edges.length - 1]}`, v.filter((x) => x >= edges[edges.length - 1]).length]]));
  const out = {
    flags: Object.fromEntries(['huntgpu', 'frontcap', 'seedcell', 'fieldfront'].map((k) => [k, flags.get(k)])),
    ticks: ticks.length,
    byField,
    seeds: { newPerTick: +(logged.reduce((s, t) => s + (t.seedsNew ?? 0), 0) / Math.max(1, logged.length)).toFixed(2), gonePerTick: +(logged.reduce((s, t) => s + (t.seedsGone ?? 0), 0) / Math.max(1, logged.length)).toFixed(2) },
    peelTicks: ticks.filter((t) => t.peel).length,
    markTicks: ticks.filter((t) => t.marks).length,
    targetDist: { n: near.length, hist: hist(near, [3, 6, 10, 15, 25, 40]) },
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
  await lab.shot(`huntbench-${location.search.replace(/[^\w]+/g, '_').slice(-60)}`);
  console.log(JSON.stringify(out));
  return out;
}
