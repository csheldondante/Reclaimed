// Measuring frames: the pace probe, waiting for the scene to settle, capturing a stretch of frames and summarising
// them (frame times, hitches, GPU passes). API: paceProbe, paceSettle, settle, capture, captureRaw, summarise.
import { cpuStats } from '../../gpu/cpustat';
import type { HitchBoot } from '../start';
import { toggles, writtenShare } from './ab';
import { Stat, r3, stat } from './defs';
import { judgeTimestamps } from './timestamps';
import { paceHeadline } from './pan-report';
import { sleep, frame, Sample } from '../bench';
import type { Bench } from '../bench';

/**
 * (v6, round 114, framepace) Parked, every frame from its rAF to the GPU done (src/perf/framepace.ts): with the
 * GPU timestamps read back (per pass) and without (as the game plays), and with `ab` the pacing's frames-in-flight
 * limit at 1 and 3 and the sim off — what the slow frames had that the others hadn't.
 */
export async function paceProbe(bn: Bench, seconds: number, ab: boolean): Promise<Record<string, unknown> | null> {
  const pacer = bn.ctx.pacer;
  if (!pacer) return null;
  const prof = bn.prof as { active: boolean };
  const wasActive = prof.active;
  const out: Record<string, unknown> = {};
  // (v8, round 114: settled first — v7's first phases ran while the zoom change was still filling, the last ones
  // after: the planner without holes, no tiles in flight, nothing arriving, the streamer idle, for a second; the
  // wait and whether it timed out recorded)
  out.settle = await paceSettle(bn, 20000);
  const clock = bn.R.core.clock as { mode: string; stats: Record<string, number>; displayDt(): number } | undefined;
  const sc = bn.R.scene as { simHeld?: Record<string, number> };
  const phase = async (key: string, setup: () => () => void) => {
    bn.say(`frame pacing: ${key}…`);
    const undo = setup();
    try {
      await sleep(400);
      const c0 = clock ? { ...clock.stats } : null;
      const h0 = { ...(sc.simHeld ?? {}) };
      const m = pacer.mark();
      await sleep(seconds * 1000);
      await bn.dev.queue.onSubmittedWorkDone();
      await sleep(150);
      const r = pacer.report(m, key);
      // (v7: the sim's tick clock over the phase — sim/tickclock.ts; v8: the time it dropped as pauses — missed
      // vsyncs, the planner's cuts, the frames the streamer held the sim — and the held frames by why)
      if (clock && c0) r.tickClock = { mode: clock.mode, displayMs: r3(clock.displayDt() * 1000), ...Object.fromEntries(Object.entries(clock.stats).map(([k, v]) => [k, r3(v - c0[k])])) };
      r.simHeld = Object.fromEntries(Object.entries(sc.simHeld ?? {}).map(([k, v]) => [k, v - (h0[k] ?? 0)]).filter(([, v]) => (v as number) > 0));
      out[key] = r;
    } finally {
      undo();
    }
  };
  const kinds: Record<string, () => () => void> = {
    timed: () => {
      prof.active = true;
      return () => (prof.active = wasActive);
    },
    untimed: () => {
      prof.active = false;
      return () => (prof.active = wasActive);
    },
  };
  if (ab) {
    for (const n of [1, 3])
      kinds[`inFlight${n}`] = () => {
        prof.active = false;
        pacer.maxInFlight = n;
        return () => {
          pacer.maxInFlight = 2;
          prof.active = wasActive;
        };
      };
    // (v7: the accumulator as before the tick clock, against the default 'locked')
    if (clock)
      kinds.tickAccum = () => {
        prof.active = false;
        const was = clock.mode;
        clock.mode = 'accum';
        return () => {
          clock.mode = was;
          prof.active = wasActive;
        };
      };
    const sim = toggles(bn).simAll;
    if (sim)
      kinds.simOff = () => {
        prof.active = false;
        sim.off();
        return () => {
          sim.on();
          prof.active = wasActive;
        };
      };
  }
  // (v8: every phase twice, the second round in the reverse order — A B C … C B A — so no phase is always first or
  // last; the keys `untimed` and `untimed@2`)
  const order = Object.keys(kinds);
  out.order = [...order, ...[...order].reverse().map((k) => `${k}@2`)];
  for (const k of order) await phase(k, kinds[k]);
  for (const k of [...order].reverse()) await phase(`${k}@2`, kinds[k]);
  out.headline = paceHeadline(out);
  return out;
}

/** (v8) the view quiet before the pacing phases: no holes, no tiles in flight, nothing arriving, the streamer idle, 1 s running */
export async function paceSettle(bn: Bench, maxMs: number): Promise<Record<string, unknown>> {
  const t0 = performance.now();
  const R = bn.R;
  const fno0 = bn.prof.frameNo;
  const state = () => ({ busy: !!R.stream.busy, holes: R.scene.planner?.plan?.holes ?? null, tilesInFlight: R.core.renderer?.tiles?.land?.stats?.inFlight ?? null, unwritten: R.stream.unwritten?.length ?? null });
  let since = -1;
  for (;;) {
    const t = await frame();
    const q = state();
    if (!q.busy && !q.holes && !q.tilesInFlight && !q.unwritten) {
      if (since < 0) since = t;
      if (t - since >= 1000) return { ms: Math.round(performance.now() - t0), timedOut: false };
    } else since = -1;
    // (v9: what was still in flight — each region's key and age — and whether frames were still being rendered)
    if (performance.now() - t0 > maxMs) return { ms: Math.round(performance.now() - t0), timedOut: true, ...q, tiles: R.core.renderer?.tiles?.land?.inFlightJobs?.() ?? null, framesRendered: bn.prof.frameNo - fno0 };
  }
}

/** the streamer and the mesh quiet: nothing sliding, no frames over twice the median for a second */
export async function settle(bn: Bench, minMs = 4000, maxMs = 30000): Promise<number> {
  const t0 = performance.now();
  await sleep(minMs);
  let last = performance.now();
  const recent: number[] = [];
  for (;;) {
    const t = await frame();
    recent.push(t - last);
    last = t;
    if (recent.length > 60) recent.shift();
    const sorted = [...recent].sort((a, b) => a - b);
    const med = sorted[sorted.length >> 1];
    if (recent.length >= 60 && !bn.R.stream.busy && Math.max(...recent) < Math.max(2 * med, 40)) break;
    if (performance.now() - t0 > maxMs) break;
  }
  return Math.round(performance.now() - t0);
}

/** Record `seconds` of frames with every system running: frame times, GPU per pass, the hitch recorder's causes. */
export async function capture(bn: Bench, seconds: number, during?: (t: number) => void): Promise<Record<string, unknown>> {
  const r = await captureRaw(bn, seconds, during);
  if (!bn.keepMesh) delete r.meshFrames;
  return r;
}

export async function captureRaw(bn: Bench, seconds: number, during?: (t: number) => void): Promise<Record<string, unknown>> {
  const rec = bn.ctx.hitch?.rec;
  rec?.reset();
  bn.prof.resetTotals();
  cpuStats.clear();
  const st0 = { ...bn.R.stream.stats };
  const sm: Sample = { frames: [], gpu: [], passes: new Map(), awake: [], ticks: 0, grid: [], voxel: [], bodies: [], mesh: [], passSum: [], cover: [] };
  const prevOnFrame = bn.prof.onFrame;
  const perName = (bn.prof as unknown as { perName: Map<string, number> }).perName;
  bn.prof.onFrame = (f, ms, top) => {
    prevOnFrame?.(f, ms, top);
    sm.gpu.push(ms);
    let mesh = 0;
    let all = 0;
    for (const [n, v] of perName) {
      (sm.passes.get(n) ?? sm.passes.set(n, []).get(n)!).push(v);
      if (n.includes('fieldmesh')) mesh += v;
      all += v;
    }
    sm.mesh.push(mesh);
    sm.passSum.push(all);
  };
  const tick0 = bn.R.core.sim.tick;
  const t0 = performance.now();
  let last = t0;
  let fno = bn.prof.frameNo;
  let held = 0;
  const sleepSys = bn.R.scene.sleep;
  try {
    for (;;) {
      const t = await frame();
      // (v2: a rendered frame — the level's frame began one — not a rAF held for the GPU)
      if (bn.prof.frameNo === fno) {
        held++;
        if (t - t0 >= seconds * 1000) break;
        continue;
      }
      fno = bn.prof.frameNo;
      sm.frames.push(t - last);
      last = t;
      if (sleepSys) sm.awake.push(sleepSys.awake);
      sm.cover.push(writtenShare(bn));
      const hy = bn.R.scene.hybrid?.stats;
      if (hy) {
        sm.grid.push(hy.grid);
        sm.voxel.push(hy.voxel);
      }
      const rb = bn.R.scene.integrity?.rigid?.list;
      if (rb) sm.bodies.push(rb.length);
      if (during) during((t - t0) / 1000);
      if (t - t0 >= seconds * 1000) break;
    }
  } finally {
    bn.prof.onFrame = prevOnFrame;
  }
  sm.ticks = bn.R.core.sim.tick - tick0;
  sm.held = held;
  bn.framesHook?.(sm.frames);
  // (the readbacks of the last frames' timestamps)
  await sleep(100);
  return summarise(bn, sm, st0, (performance.now() - t0) / 1000, rec);
}

export function summarise(bn: Bench, sm: Sample, st0: Record<string, number>, secs: number, rec: HitchBoot['rec']): Record<string, unknown> {
  const hasGpu = bn.prof.enabled && bn.prof.active;
  const passes: Record<string, Stat | null> = {};
  const perFrame: Record<string, number> = {};
  const nf = Math.max(1, sm.gpu.length);
  for (const [n, a] of [...sm.passes].sort((x, y) => y[1].reduce((s, v) => s + v, 0) - x[1].reduce((s, v) => s + v, 0))) {
    passes[n] = stat(a, 'ms a frame it ran in');
    perFrame[n] = r3(a.reduce((s, v) => s + v, 0) / nf);
  }
  const sum = (re: RegExp) => r3(Object.entries(perFrame).filter(([k]) => re.test(k)).reduce((s, [, v]) => s + v, 0));
  const groups = hasGpu
    ? {
        unit: 'GPU ms a frame (mean over frames read back)',
        note: 'draw is the frame draw pass (the lighting and the forward draw); render = gbuffer + shadow + draw + renderprep (renderprep, renderfields, project) + tcache',
        render: sum(/^(draw|gbuffer|tcache|shadow|renderprep|renderfields|project)/),
        gbuffer: sum(/^gbuffer|^tcache-g/),
        shadow: sum(/^shadow/),
        draw: sum(/^draw$/),
        renderprep: sum(/^(renderprep|renderfields|project)/),
        mesh: sum(/fieldmesh/),
        water: sum(/^water/),
        oil: sum(/^oil/),
        wind: sum(/^(windfield|sway|wind)/),
        sediment: sum(/^(sediment|surface|structure|slope|erosion)/),
        lava: sum(/^lava/),
        plants: sum(/^(ecology|wilt|moisture|veg|plant)/),
        otherSim: sum(/^(fire|contamination|climate|copyback|stats)/),
        particles: sum(/^particles/),
        agents: sum(/^agents/),
        physics: sum(/^physics/),
        streaming: sum(/^atlas-/),
        far: sum(/^(lod|bake|rough)/),
      }
    : 'n/a (no timestamp-query)';
  const ts = judgeTimestamps(sm.passSum, sm.gpu, sm.frames);
  if (hasGpu) bn.tsChecks.push(ts);
  const topPasses: Record<string, Stat | null> = {};
  for (const k of Object.keys(passes).slice(0, 12)) topPasses[k] = passes[k];
  const cpu: Record<string, unknown> = {};
  for (const [k, v] of [...cpuStats].sort((a, b) => b[1].sum - a[1].sum).slice(0, 15)) cpu[k] = { n: v.n, mean: r3(v.sum / Math.max(1, v.n)), max: r3(v.max), totalMs: Math.round(v.sum), unit: 'ms CPU' };
  const st1 = bn.R.stream.stats;
  const stream: Record<string, number> = {};
  for (const k of Object.keys(st1)) if (typeof st1[k] === 'number' && k !== 'lastMs') stream[k] = st1[k] - (st0[k] ?? 0);
  const awake = stat(sm.awake, 'chunks awake (16x16)');
  // (a sim's GPU ms a tick for each chunk awake: the passes are dispatched over the awake list, sim/cull.ts)
  const tpf = sm.ticks / Math.max(1, sm.frames.length);
  const awakeMean = awake?.mean ?? 0;
  const perAwake: Record<string, number | string> = { unit: 'GPU ms a sim tick per awake 16x16 chunk', ticksPerFrame: r3(tpf) };
  if (typeof groups === 'object' && awakeMean > 0 && tpf > 0)
    for (const k of ['water', 'oil', 'wind', 'sediment', 'lava', 'plants', 'otherSim']) perAwake[k] = r3((groups as unknown as Record<string, number>)[k] / tpf / awakeMean);
  let hitch: unknown = null;
  if (rec) {
    const r = rec.report() as Record<string, unknown>;
    const worst = (r.worst as { ms: number; cause: string; cpu: number; gpu: unknown; steps: { label: string; ms: number }[]; async: { label: string; ms: number }[] }[]).slice(0, 5);
    hitch = {
      causes: r.causes,
      worst: worst.map((h) => `${h.ms} ${h.cause} cpu ${h.cpu} ${[...h.steps, ...h.async].slice(0, 2).map((x) => `${x.label} ${x.ms}`).join(', ')}`),
      heldForGpu: r.heldForGpu,
      gc: r.gc,
      threshold: r.thresholdMs,
      hitches: (r.hitches as unknown[]).length,
    };
  }
  return {
    seconds: +secs.toFixed(1),
    frames: stat(sm.frames, 'ms between rendered frames'),
    heldRafs: sm.held ?? 0,
    screenInDetail: stat(sm.cover, 'share of the screen in the window\'s detail (0..1)'),
    p99: r3([...sm.frames].sort((a, b) => a - b)[Math.floor(0.99 * sm.frames.length)] ?? NaN),
    fps: +(sm.frames.length / secs).toFixed(1),
    fpsNote: 'rendered frames a second (a rAF held for the GPU not counted)',
    gpuFrame: hasGpu ? stat(sm.gpu, 'GPU ms a frame (first pass start to last end)') : 'n/a',
    timestamps: hasGpu ? ts : 'n/a',
    gpuGroups: groups,
    gpuPasses: hasGpu ? topPasses : 'n/a',
    simTicks: sm.ticks,
    ticksPerSecond: +(sm.ticks / secs).toFixed(1),
    awake,
    simPerAwakeChunk: perAwake,
    hybrid: sm.grid.length ? { gridChunks: stat(sm.grid, 'heightfield-grid chunks'), voxelChunks: stat(sm.voxel, 'voxel chunks') } : null,
    rockBodies: stat(sm.bodies, 'rigid rock bodies'),
    meshFrame: hasGpu ? stat(sm.mesh, 'GPU ms of the field mesh a frame') : 'n/a',
    meshFrames: sm.mesh,
    cpuSteps: cpu,
    stream,
    hitch,
  };
}
