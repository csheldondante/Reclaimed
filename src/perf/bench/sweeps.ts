// The bench's sweeps: the fastest pan, each system's GPU cost, tiles, agents, render scales, a warp and a meteor.
// API: maxPan, systemGpu, storm, tileSweep, genQuiet, agentsSweep, renderScales, warp, meteor.
import { warpWindow } from '../../api/atlas-world';
import { capture, settle } from './pace';
import { lowDetail, view, writtenShare } from './ab';
import { freshAt, makeRegion } from './regions';
import { ROW_H, Stat, r3, stat, PROBE_SPEEDS, PROBE_S } from './defs';
import { GpuTimer } from './page';
import { sleep, frame } from '../bench';
import type { Bench } from '../bench';

/**
 * (v3) The fastest pan this window sustains: the speed raised step by step (PROBE_SPEEDS, PROBE_S each) until, over
 * a step, the low detail's p90 is over 5% of the screen or the rendered fps under 30 — the last step that held.
 */
export async function maxPan(bn: Bench): Promise<Record<string, unknown>> {
  const sc = bn.R.scene;
  await settle(bn, 1000, 10000);
  bn.parkedCover = writtenShare(bn);
  const [ux, uy] = bn.R.camera.screenDeltaToWorld(0, -1);
  const l = Math.hypot(ux, uy) || 1;
  const steps: { speed: number; fps: number; lowP90: number; ok: boolean }[] = [];
  let held: number | null = null;
  let why = `held to ${PROBE_SPEEDS[PROBE_SPEEDS.length - 1]} cells/s`;
  sc.pan = { speed: PROBE_SPEEDS[0], dir: [ux / l, uy / l], t: 0, turnAt: 0, turnBy: 0, turned: 0, asked: 0 };
  try {
    for (const v of PROBE_SPEEDS) {
      bn.say(`the fastest pan: ${v} cells/s…`);
      sc.pan.speed = v;
      const low: number[] = [];
      const fno0 = bn.prof.frameNo;
      const t0 = performance.now();
      while (performance.now() - t0 < PROBE_S * 1000) {
        await frame();
        low.push(lowDetail(bn));
      }
      const fps = (bn.prof.frameNo - fno0) / ((performance.now() - t0) / 1000);
      const lowP90 = [...low].sort((a, b) => a - b)[Math.floor(low.length * 0.9)] ?? 0;
      const ok = lowP90 <= 0.05 && fps >= 30;
      steps.push({ speed: v, fps: +fps.toFixed(1), lowP90: r3(lowP90), ok });
      if (!ok) {
        why = lowP90 > 0.05 ? `low detail ${(lowP90 * 100).toFixed(0)}% of the screen at ${v}` : `${fps.toFixed(0)} fps at ${v}`;
        break;
      }
      held = v;
    }
  } finally {
    sc.pan = null;
  }
  return { unit: 'cells/s', maxSustainable: held, stoppedBy: why, rule: `the speed raised every ${PROBE_S} s; it holds while low detail (p90) <= 5% of the screen and rendered fps >= 30`, parkedDetailed: r3(bn.parkedCover), window: bn.W, steps };
}

/**
 * (v4) Each sim system's GPU time, its dispatches in one compute pass: Mali's timestamps are sane inside a pass
 * (round 102's phone: one pass sum/wall 0.87) and not across passes (3.0). The system is encoded once more, outside
 * the frame, through an encoder that hands it one shared pass (its own end()s ignored; a copy or a clear between its
 * passes ends the pass and the next dispatch opens another — each timed on its own); its own timestamp asks are off
 * meanwhile (the profiler inactive). A system runs one extra tick for each sample — the bench's own world. Wall:
 * the isolated submit's, less an empty submit's.
 */
export async function systemGpu(bn: Bench, label: string): Promise<Record<string, unknown>> {
  if (!bn.dev.features.has('timestamp-query')) return { error: 'no timestamp-query' };
  const dev = bn.dev;
  const prof = bn.prof as { active: boolean };
  const timer = new GpuTimer(dev);
  const sims: { name: string; encode: (e: GPUCommandEncoder, t: number) => void }[] = bn.R.core.sim.systems.filter((x: { name: string }) => !/^(edit|layerpull|landbrush|townstamp|placeop|stats)$/.test(x.name));
  const items: [string, (e: GPUCommandEncoder) => void][] = sims.map((x) => [x.name, (e) => x.encode(e, bn.R.core.sim.tick)]);
  if (bn.R.agents) items.push(['agents', (e) => bn.R.agents.encode(e)]);
  const empty: number[] = [];
  for (let k = 0; k < 5; k++) {
    await dev.queue.onSubmittedWorkDone();
    const t0 = performance.now();
    dev.queue.submit([dev.createCommandEncoder().finish()]);
    await dev.queue.onSubmittedWorkDone();
    empty.push(performance.now() - t0);
  }
  const emptyP50 = stat(empty, 'ms')?.p50 ?? 0;
  const out: Record<string, unknown> = {};
  const awake = bn.R.scene.sleep?.awake ?? null;
  for (const [name, enc] of items) {
    const gpu: number[] = [];
    const wall: number[] = [];
    let segs = 0;
    for (let k = 0; k < 4; k++) {
      await frame();
      const real = dev.createCommandEncoder({ label: `bench one-pass ${name}` });
      let pass: GPUComputePassEncoder | null = null;
      let n = 0;
      const open = () => {
        if (!pass) {
          pass = real.beginComputePass({ timestampWrites: timer.timestamps(name) });
          n++;
        }
        return pass;
      };
      const close = () => {
        if (pass) {
          (pass as GPUComputePassEncoder).end();
          pass = null;
        }
      };
      const passProxy = {
        label: '',
        setPipeline: (p: GPUComputePipeline) => open().setPipeline(p),
        setBindGroup: (i: number, g: GPUBindGroup | null, o?: Iterable<number>) => open().setBindGroup(i, g, o as number[]),
        dispatchWorkgroups: (x: number, y?: number, z?: number) => open().dispatchWorkgroups(x, y, z),
        dispatchWorkgroupsIndirect: (b: GPUBuffer, o: number) => open().dispatchWorkgroupsIndirect(b, o),
        end: () => {},
        pushDebugGroup: () => {},
        popDebugGroup: () => {},
        insertDebugMarker: () => {},
      };
      const encProxy = new Proxy(real, {
        get(t, key) {
          if (key === 'beginComputePass') return () => passProxy;
          const v = (t as unknown as Record<string | symbol, unknown>)[key];
          if (typeof v === 'function')
            return (...a: unknown[]) => {
              close();
              return (v as (...x: unknown[]) => unknown).apply(t, a);
            };
          return v;
        },
      }) as GPUCommandEncoder;
      const was = prof.active;
      prof.active = false;
      try {
        enc(encProxy);
      } finally {
        prof.active = was;
      }
      close();
      await dev.queue.onSubmittedWorkDone();
      const t0 = performance.now();
      dev.queue.submit([real.finish()]);
      await dev.queue.onSubmittedWorkDone();
      wall.push(performance.now() - t0 - emptyP50);
      const g = (await timer.read()).get(name) ?? [];
      gpu.push(g.reduce((a, v) => a + v, 0));
      segs = n;
    }
    out[name] = { gpuMs: stat(gpu, 'GPU ms a tick (its dispatches in one pass)')?.p50 ?? null, wallMs: r3(stat(wall, 'ms')?.p50 ?? NaN), passes: segs };
  }
  return { unit: 'ms a tick of that system alone', scene: label, awakeChunks: awake, windowChunks: (bn.W / 16) * (bn.R.stream.H / 16), emptySubmitMs: r3(emptyP50), how: 'its dispatches in one compute pass, timed at that pass\'s begin and end (sane on Mali where per-pass timestamps aren\'t); wall = the isolated submit less an empty one', systems: out };
}

/** (v4) a storm over the camera (its rain wakes water and sediment, its wind the field): spawned, or why not */
export function storm(bn: Bench): string {
  const w = bn.R.weather ?? bn.R.core?.weather;
  if (!w?.spawn) return 'no weather here';
  const c = bn.R.camera.target;
  const st = w.spawn(c[0], c[1]);
  if (!st) return 'the weather refused (a storm already, or its cooldown)';
  st.intensity = Math.max(st.intensity ?? 0, 0.8);
  return `a storm at ${Math.round(c[0])},${Math.round(c[1])}`;
}

/** Regions made as the streamer makes them (tiles over frames), the pacer held at k tiles a frame */
export async function tileSweep(bn: Bench): Promise<Record<string, unknown>> {
  const a = bn.R.atlas;
  const S = bn.R.stream;
  const R = S.R;
  const out: Record<string, unknown> = {};
  const was = a.profiler;
  a.profiler = bn.timer;
  const pacer = a.pacer;
  const nReg = 6;
  try {
    for (const k of [1, 2, 4, 8]) {
      await settle(bn, 1000, 8000);
      // (the streamer's own batches first: their tiles share the pacer — measured alone, not with them)
      const quiet = await genQuiet(bn, 15000);
      pacer.fixed = k;
      const frames: number[] = [];
      let last = performance.now();
      let on = true;
      const loop = async () => {
        while (on) {
          const t = await frame();
          frames.push(t - last);
          last = t;
        }
      };
      const lp = loop();
      const tiles0 = pacer.tiles;
      const fr0 = pacer.frames;
      const t0 = performance.now();
      const spots = Array.from({ length: nReg }, () => freshAt(bn, bn.freshK++));
      await Promise.all(spots.map(([x0, y0]) => makeRegion(bn, x0, y0, true)));
      const ms = performance.now() - t0;
      on = false;
      await lp;
      const g = await bn.timer.read();
      out[`k${k}`] = {
        tilesPerFrame: k,
        regions: nReg,
        ms: Math.round(ms),
        regionsPerSecond: +((nReg * 1000) / ms).toFixed(2),
        // (the settlements' hooks plan a town's ground as raw batches through the same pacer: more tiles than the
        // regions' own where a town is near — the tile rate is the comparable one across k)
        tilesPerSecond: +(((pacer.tiles - tiles0) * 1000) / ms).toFixed(1),
        regionsPerSecondFromTiles: +(((pacer.tiles - tiles0) * 1000) / ms / (R / 32) ** 2).toFixed(2),
        tiles: pacer.tiles - tiles0,
        tilesExpected: nReg * (R / 32) ** 2,
        streamerQuietBefore: quiet,
        framesWithTiles: pacer.frames - fr0,
        frames: stat(frames, 'ms frame interval while generating'),
        gpuColFinishPerTile: bn.timer.on ? stat(g.get('atlas-colFinish') ?? [], 'GPU ms a 32x32 tile') : 'n/a',
        gpuColHeight: bn.timer.on ? stat(g.get('atlas-colHeight') ?? [], 'GPU ms a region') : 'n/a',
        gpuFormSeed: bn.timer.on ? stat(g.get('atlas-formSeed') ?? [], 'GPU ms a region') : 'n/a',
      };
    }
  } finally {
    pacer.fixed = 0;
    a.profiler = was;
  }
  return out;
}

/** the atlas's tile pacer with nothing waiting and the streamer making nothing (false: still busy at the limit) */
export async function genQuiet(bn: Bench, ms: number): Promise<boolean> {
  const t0 = performance.now();
  const pacer = bn.R.atlas.pacer as { waiting?: unknown[] };
  for (;;) {
    if (!(pacer.waiting?.length ?? 0) && !(bn.R.stream.jobs?.size ?? 0) && !bn.R.stream.busy) return true;
    if (performance.now() - t0 > ms) return false;
    await sleep(50);
  }
}

export async function agentsSweep(bn: Bench): Promise<Record<string, unknown>> {
  const ag = bn.R.agents;
  const out: Record<string, unknown> = { baseUnits: ag.size };
  const c = bn.R.camera.target;
  const base = await capture(bn, 3);
  const ms = (cap: Record<string, unknown>) => (cap.gpuGroups as Record<string, number>)?.agents ?? null;
  out.base = { agentsGpu: ms(base), unit: 'GPU ms a frame' };
  for (const n of [100, 500, 2000]) {
    let ids: number[] = [];
    try {
      ids = ag.spawn(n, c[0], c[1], { group: 7, spread: Math.sqrt(n) * 0.8 });
      await sleep(800);
      const cap = await capture(bn, 3);
      out[`n${n}`] = { units: ag.size, agentsGpu: ms(cap), agentsPass: (cap.gpuPasses as Record<string, Stat>)?.agents ?? null, frames: cap.frames, unit: 'GPU ms a frame' };
    } catch (e) {
      out[`n${n}`] = { error: (e as Error).message };
    } finally {
      if (ids.length) ag.remove(ids);
    }
    await sleep(300);
  }
  return out;
}

export async function renderScales(bn: Bench): Promise<Record<string, unknown>> {
  const q = bn.ctx.host.quality;
  const was = q.renderScale;
  const out: Record<string, unknown> = { tier: was };
  try {
    for (const s of [0.35, 0.75, 1]) {
      if (s === was) continue;
      bn.ctx.setRenderScale(s);
      await sleep(1200);
      const cap = await capture(bn, 4);
      out[`x${s}`] = { canvas: [bn.ctx.host.canvas.width, bn.ctx.host.canvas.height], frames: cap.frames, gpuFrame: cap.gpuFrame, gpuGroups: cap.gpuGroups };
    }
  } finally {
    bn.ctx.setRenderScale(was);
  }
  await sleep(800);
  return out;
}

export async function warp(bn: Bench, to: [number, number]): Promise<Record<string, unknown>> {
  const a = bn.R.atlas;
  const S = bn.R.stream;
  const dims = { w: S.W, h: S.H, zMax: bn.R.core.dims.zMax };
  const [wx, wy] = to;
  const from = [S.origin[0] + S.W / 2, S.origin[1] + S.H / 2];
  const W = a.p.cols;
  const Hh = a.p.rows;
  const dx = ((wx - from[0] + W * 1.5) % W) - W / 2;
  const dy = ((wy - from[1] + Hh * 1.5) % Hh) - Hh / 2;
  const idle = bn.idleP50;
  let warped = -1;
  let settled = -1;
  const t0 = performance.now();
  const p = warpWindow(a, S, dims, wx, wy).then(() => (warped = performance.now() - t0));
  let good = 0;
  const cap = await capture(bn, 20, () => {
    if (warped >= 0 && settled < 0) {
      // (settled: the streamer quiet and 30 frames running within 1.5x the parked median)
      const fr = performance.now();
      good = !S.busy && fr - bn.lastF < idle * 1.5 + 2 ? good + 1 : 0;
      if (good >= 30) settled = performance.now() - t0;
    }
    bn.lastF = performance.now();
  });
  await p;
  return { to: [Math.round(wx), Math.round(wy)], distanceCells: Math.round(Math.hypot(dx, dy * ROW_H)), warpMs: Math.round(warped), settledMs: settled >= 0 ? Math.round(settled) : 'not within 20 s', unit: 'ms from the warp asked (warpMs: every region written; settledMs: frames back to normal)', ...cap, view: view(bn) };
}

export async function meteor(bn: Bench): Promise<Record<string, unknown>> {
  const c = bn.R.camera.target;
  const [ux, uy] = bn.R.camera.screenDeltaToWorld(0, -1);
  const l = Math.hypot(ux, uy) || 1;
  // (40 cells up the screen from the target: in sight, not under the camera)
  const x = c[0] + (ux / l) * 40;
  const y = c[1] + (uy / l) * 40;
  const z = bn.R.api?.terrain?.heightAt?.(x, y) ?? c[2];
  let fired = false;
  const cap = await capture(bn, 12, (t) => {
    if (!fired && t > 0.5) {
      fired = true;
      bn.R.meteorNow(x, y, z);
    }
  });
  const cs = cap.cpuSteps as Record<string, { n: number; mean: number; max: number }>;
  const rb = cap.rockBodies as Stat | null;
  return {
    at: [Math.round(x), Math.round(y), Math.round(z)],
    judgePass: cs.judge ?? null,
    rockBodiesStep: cs.rockbodies ?? null,
    rockBodiesPerBody: cs.rockbodies && rb?.mean ? r3(cs.rockbodies.mean / rb.mean) : null,
    unit: 'ms CPU (judgePass: a pass of the integrity judge; rockBodiesPerBody: the rigid step a frame / bodies alive)',
    ...cap,
  };
}
