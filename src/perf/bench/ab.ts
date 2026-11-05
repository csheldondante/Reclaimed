// A/B toggles (a system off, the frame's difference) and what the view shows: its state, the systems that can be
// toggled, what's written or missing. API: view, toggles, abPhase, ab, boundNote, writtenShare, missingWhere, lowDetail.
import { ROW_H, r3, stat } from './defs';
import { sleep, frame } from '../bench';
import type { Bench } from '../bench';

/** what the camera shows: zoom, the ground's footprint, how much of it is the window, the rings, the far land */
export function view(bn: Bench): Record<string, unknown> {
  const c = bn.R.camera;
  const W = bn.W;
  const H = bn.R.stream.H;
  const vw = c.viewportW;
  const vh = c.viewportH;
  const rings: number[] = bn.R.far?.lod ? bn.R.far.lod.spacings.map((s: number) => s * (bn.R.far.lod.n - 1)) : [];
  const counts: Record<string, number> = { window: 0, far: 0 };
  for (const r of rings) counts[`ring${r}`] = 0;
  const G = 24;
  let xs0 = Infinity;
  let xs1 = -Infinity;
  let ys0 = Infinity;
  let ys1 = -Infinity;
  for (let j = 0; j < G; j++)
    for (let i = 0; i < G; i++) {
      const [dx, dy] = c.fly ? [0, 0] : c.screenDeltaToWorld(((i + 0.5) / G - 0.5) * vw, ((j + 0.5) / G - 0.5) * vh);
      const x = c.target[0] + dx;
      const y = c.target[1] + dy;
      xs0 = Math.min(xs0, x);
      xs1 = Math.max(xs1, x);
      ys0 = Math.min(ys0, y);
      ys1 = Math.max(ys1, y);
      if (x >= 0 && x <= W && y >= 0 && y <= H * ROW_H) counts.window++;
      else {
        const d = Math.max(Math.abs(dx), Math.abs(dy)) * 2;
        const r = rings.find((e) => d <= e);
        if (r !== undefined) counts[`ring${r}`]++;
        else counts.far++;
      }
    }
  const pct: Record<string, number> = {};
  for (const [k, v] of Object.entries(counts)) pct[k] = +((100 * v) / (G * G)).toFixed(1);
  // (v4, the user: "so that the whole screen is nearly always loaded in detail") the smallest window (a side, whole
  // regions) holding 95% of the screen's ground with the camera at its middle, at this zoom and turn
  let need: number | null = null;
  if (!c.fly)
    for (let w = 256; w <= 4096 && need === null; w += 64) {
      let inside = 0;
      for (let j = 0; j < G; j++)
        for (let i = 0; i < G; i++) {
          const [dx, dy] = c.screenDeltaToWorld(((i + 0.5) / G - 0.5) * vw, ((j + 0.5) / G - 0.5) * vh);
          if (Math.abs(dx) <= w / 2 && Math.abs(dy) <= (w / 2) * ROW_H) inside++;
        }
      if (inside >= 0.95 * G * G) need = w;
    }
  return {
    zoom: +c.zoom.toFixed(3),
    fly: !!c.fly,
    azimuth: c.azimuth !== undefined ? +c.azimuth.toFixed(3) : null,
    viewportCss: [vw, vh],
    footprintCells: { w: Math.round(xs1 - xs0), h: Math.round(ys1 - ys0), unit: 'cells (ground at the target height)' },
    window: { w: W, h: H, unit: 'cells' },
    coveragePct: pct,
    windowFor95: need,
    rings,
    target: c.target.map((v: number) => Math.round(v)),
  };
}

// ---- the A/B: systems switched off one at a time (v2: a GPU's timestamps may not be trustworthy — Mali's weren't) ----

/** what can be switched off for a few seconds: the sim systems (their encode a no-op), agents, the renderer's pieces (Renderer.skip) */
export function toggles(bn: Bench): Record<string, { what: string; off: () => void; on: () => void; matched: string[] }> {
  const sims: { name: string; encode: unknown }[] = bn.R.core.sim.systems;
  const out: Record<string, { what: string; off: () => void; on: () => void; matched: string[] }> = {};
  const simGroup = (key: string, re: RegExp, what: string) => {
    const hit = sims.filter((x) => re.test(x.name));
    if (!hit.length) return;
    const own = hit.map((x) => Object.prototype.hasOwnProperty.call(x, 'encode'));
    const was = hit.map((x) => x.encode);
    out[key] = {
      what,
      matched: hit.map((x) => x.name),
      off: () => hit.forEach((x) => (x.encode = () => {})),
      on: () =>
        hit.forEach((x, i) => {
          if (own[i]) x.encode = was[i];
          else delete (x as { encode?: unknown }).encode;
        }),
    };
  };
  simGroup('simAll', /^(?!edit$|layerpull$|landbrush$|townstamp$|placeop$|stats$)/, 'every sim system but the edits and stamps (events still consumed)');
  simGroup('water', /^water$/, 'the water flow');
  simGroup('lava', /^lava$/, 'the lava flow');
  simGroup('sediment', /^sediment$/, 'sediment and loose ground');
  simGroup('wind', /^windfield$/, 'the wind field');
  simGroup('plants', /^(ecology|wilt|moisture)$/, 'ecology, wilt, moisture');
  simGroup('otherSims', /^(oil|contamination|fire|climate|sway|structure|project|structtick|surface)$/, 'oil, contamination, fire, climate, sway, structure, surface');
  simGroup('renderfields', /^renderfields$/, 'the render fields (shadow/AO fields the draw reads)');
  simGroup('particlesSim', /^particles$/, 'the particles\' update');
  simGroup('physics', /^physics$/, 'the physics voxels');
  const ag = bn.R.agents;
  if (ag) {
    const own = Object.prototype.hasOwnProperty.call(ag, 'encode');
    const was = ag.encode;
    out.agents = { what: 'the agents pass', matched: ['agents'], off: () => (ag.encode = () => {}), on: () => (own ? (ag.encode = was) : delete ag.encode) };
  }
  const skip: Set<string> = bn.R.core.renderer.constructor.skip;
  const sk = (key: string, names: string[], what: string) => {
    const had = names.map((n) => skip.has(n));
    out[key] = { what, matched: names, off: () => names.forEach((n) => skip.add(n)), on: () => names.forEach((n, i) => !had[i] && skip.delete(n)) };
  };
  sk('renderprep', ['prep'], 'renderprep (the column lists for the draw)');
  sk('meshRebuild', ['meshprep'], 'the field mesh looking for changes and rebuilding');
  sk('shadow', ['shadow'], 'the sun\'s shadow map');
  sk('farLand', ['far'], 'the LOD rings and the far land (extra draws)');
  sk('grid', ['grid'], 'the hybrid\'s heightfield grid draw');
  sk('voxelMesh', ['mesh'], 'the field mesh draw (the hybrid\'s voxel chunks)');
  sk('particlesDraw', ['particles', 'rain'], 'particles and rain drawn');
  sk('waterDraw', ['water'], 'water drawn');
  sk('plantsDraw', ['plants', 'trees'], 'plants and trees drawn');
  sk('band', ['band'], 'the band above and below the window');
  sk('shore', ['shore'], 'the shore pass');
  return out;
}

/** a phase of frames: the frame interval and, each frame, the wall from after its submit to onSubmittedWorkDone */
export async function abPhase(bn: Bench, seconds: number): Promise<{ frameMean: number; frameP50: number; fps: number; drainMean: number; drainP50: number; n: number; awake: number | null }> {
  const frames: number[] = [];
  const drains: number[] = [];
  const awake: number[] = [];
  const sl = bn.R.scene.sleep;
  const dev = bn.dev;
  const t0 = performance.now();
  let last = t0;
  let fno = bn.prof.frameNo;
  for (;;) {
    const t = await frame();
    if (t - t0 >= seconds * 1000) break;
    // (a rendered frame only: a rAF held for the GPU submitted nothing)
    if (bn.prof.frameNo === fno) continue;
    fno = bn.prof.frameNo;
    frames.push(t - last);
    last = t;
    if (sl) awake.push(sl.awake);
    // (this callback runs after main.ts's frame, which submitted: the queue's drain from here is the frame's GPU work, or more when it's behind)
    const ts = performance.now();
    void dev.queue.onSubmittedWorkDone().then(() => drains.push(performance.now() - ts));
  }
  await dev.queue.onSubmittedWorkDone();
  const f = stat(frames, 'ms');
  const d = stat(drains, 'ms');
  // (v4: no frame rendered in the phase — the GPU stalled — is a number, not a crash)
  if (!f) return { frameMean: NaN, frameP50: NaN, fps: 0, drainMean: d?.mean ?? NaN, drainP50: d?.p50 ?? NaN, n: 0, awake: null };
  const aw = stat(awake, 'chunks');
  return { frameMean: f.mean, frameP50: f.p50, fps: +(frames.length / ((last - t0) / 1000)).toFixed(1), drainMean: d?.mean ?? NaN, drainP50: d?.p50 ?? NaN, n: frames.length, awake: aw ? aw.mean : null };
}

/** Each system off for `secs` against the frames just before with it on: the frame-time and the drain it costs. */
export async function ab(bn: Bench, keys: string[], secs = 2, scene = 'parked'): Promise<Record<string, unknown>> {
  const T = toggles(bn);
  const systems: Record<string, unknown> = {};
  const t0 = performance.now();
  for (const k of keys) {
    const t = T[k];
    if (!t) {
      systems[k] = 'not in this level';
      continue;
    }
    bn.say(`A/B: ${k} off…`);
    await sleep(300);
    const on = await abPhase(bn, secs);
    let off: typeof on;
    try {
      t.off();
      await sleep(300);
      off = await abPhase(bn, secs);
    } finally {
      t.on();
    }
    systems[k] = {
      what: t.what,
      matched: t.matched,
      costFrameMs: r3(on.frameMean - off.frameMean),
      costDrainMs: r3(on.drainP50 - off.drainP50),
      fpsOn: on.fps,
      fpsOff: off.fps,
      // (v4: the chunks awake meanwhile — a cost of ~0 with none awake is asleep, not free)
      awakeOn: on.awake,
      awakeOff: off.awake,
      on: { frameMean: on.frameMean, drainP50: r3(on.drainP50), n: on.n },
      off: { frameMean: off.frameMean, drainP50: r3(off.drainP50), n: off.n },
    };
  }
  await sleep(400);
  return {
    unit: 'ms a frame: costFrameMs = mean frame interval with it on - off (what it costs when the frame is GPU- or CPU-bound; ~0 when the frame waits for vsync); costDrainMs = the same of the median wall from a frame\'s submit to onSubmittedWorkDone. Only a bound frame shows a system\'s cost in its interval: at the display\'s rate (a desktop at vsync) the costs read ~0 and only the drain moves',
    method: `${secs} s on then ${secs} s off each, 0.3 s settling; ${scene}; works on any GPU (no timestamps)`,
    scene,
    bound: boundNote(bn),
    seconds: +((performance.now() - t0) / 1000).toFixed(0),
    systems,
  };
}

/** is the frame bound (by the GPU or the CPU) or waiting for the display? from the parked frames: fps under 90% of the fastest frames' rate */
export function boundNote(bn: Bench): string {
  const f = (bn.idleFrames ?? []).slice().sort((a, b) => a - b);
  if (!f.length) return 'unknown';
  const fast = f[Math.floor(f.length * 0.05)];
  const mean = f.reduce((a, v) => a + v, 0) / f.length;
  return mean > fast * 1.1 ? `bound: frames ${mean.toFixed(1)} ms on average against ${fast.toFixed(1)} at their fastest — the costs show in the interval` : `at the display's rate (${(1000 / mean).toFixed(0)} fps): the frame costs read ~0; the drain is the guide`;
}

/** (v3) the share of a 12x12 grid of screen points whose ground is in the window, in a region already written */
export function writtenShare(bn: Bench): number {
  const c = bn.R.camera;
  const S = bn.R.stream;
  const W = S.W;
  const H = S.H;
  const R = S.R;
  const un: [number, number][] = S.unwritten ?? [];
  const G = 12;
  let n = 0;
  for (let j = 0; j < G; j++)
    for (let i = 0; i < G; i++) {
      const [dx, dy] = c.fly ? [0, 0] : c.screenDeltaToWorld(((i + 0.5) / G - 0.5) * c.viewportW, ((j + 0.5) / G - 0.5) * c.viewportH);
      const x = c.target[0] + dx;
      const y = (c.target[1] + dy) / ROW_H;
      // (round 104, ?tiles=1: land a tile draws is in detail too — render/tilecache.ts)
      const tiled = bn.R.core.renderer.tiles?.drawsAt(x, y) ?? false;
      if (x < 0 || x >= W || y < 0 || y >= H) {
        if (tiled) n++;
        continue;
      }
      const lx = Math.floor(x / R) * R;
      const ly = Math.floor(y / R) * R;
      if (un.some(([ux, uy]) => ux === lx && uy === ly) && !tiled) continue;
      n++;
    }
  return n / (G * G);
}

/**
 * (round 106, tilephone: where the pop-in is) The screen's 12 x 12 points not in detail now, as shares of the screen:
 * in the window but its region not written yet (and no tile there), or past it with no tile — those split by the pan's
 * way `dir` (world x y): ahead, to the side, behind.
 */
export function missingWhere(bn: Bench, dir: [number, number], why?: Record<string, number>): { win: number; ahead: number; side: number; behind: number } {
  const c = bn.R.camera;
  const S = bn.R.stream;
  const un: [number, number][] = S.unwritten ?? [];
  const G = 12;
  const dl = Math.hypot(dir[0], dir[1]) || 1;
  const o = { win: 0, ahead: 0, side: 0, behind: 0 };
  for (let j = 0; j < G; j++)
    for (let i = 0; i < G; i++) {
      const [dx, dy] = c.fly ? [0, 0] : c.screenDeltaToWorld(((i + 0.5) / G - 0.5) * c.viewportW, ((j + 0.5) / G - 0.5) * c.viewportH);
      const x = c.target[0] + dx;
      const y = (c.target[1] + dy) / ROW_H;
      if (bn.R.core.renderer.tiles?.drawsAt(x, y)) continue;
      if (x >= 0 && x < S.W && y >= 0 && y < S.H) {
        if (un.some(([ux, uy]) => ux === Math.floor(x / S.R) * S.R && uy === Math.floor(y / S.R) * S.R)) o.win++;
        continue;
      }
      const along = (dx * dir[0] + dy * dir[1]) / (dl * (Math.hypot(dx, dy) || 1));
      // (round 112, tilefast: why it's not drawn — TileCache.whyMissing — counted a point each)
      if (why) {
        const k = bn.R.core.renderer.tiles?.whyMissing(x, y, c.azimuth) ?? 'none';
        why[k] = (why[k] ?? 0) + 1 / (G * G);
      }
      if (along > 0.5) o.ahead++;
      else if (along < -0.5) o.behind++;
      else o.side++;
    }
  const n = G * G;
  return { win: o.win / n, ahead: o.ahead / n, side: o.side / n, behind: o.behind / n };
}

/** (v3) low detail now: the share of the screen detailed when parked that isn't now (outside the window, or not written yet) */
export function lowDetail(bn: Bench): number {
  return Math.max(0, bn.parkedCover - writtenShare(bn));
}
