// Round 113 (`tilesfirst`, the streaming design's step 4 — https://claude.ai/artifact/UnqDENhSKGH1abe7pxWiNh; the user:
// "It's really dumb not to grow with speed", "Prioritize rendering over simulation too"). The planner: one place,
// once a frame, that decides how far ahead each layer works and who gets the frame's budget.
//
//  - The footprint is the geometric coverage check's (render/coverage.ts): what the camera sees, drawn or not.
//  - The look-ahead grows with speed: each layer's reach is the camera's speed times that layer's measured latency
//    (wanted to ready) plus a margin of a region — land (the streamer's: asked to made), the window (slid to drawn:
//    every chunk of a region that came in drawn by the window itself), tiles (TileCache.tileLatency: wanted to drawn).
//    The consumers take the reach in cells along the camera's motion: the streamer's strips ahead and its slide's lead,
//    the field mesh's rebuilds ahead, the tiles' look-ahead.
//  - Holes first, rendering before simulation: while the footprint has undrawn land (now or in the last HOLD frames)
//    the tile pacer gives its lane the frame's whole room, and the sim's ticks a frame are cut to SIM_CUT — the sim
//    catches up in time later (its accumulator is capped: it slows, it doesn't spiral). The grid's readiness doesn't
//    wait on the sim's ticks (WorldCore.prepareArrived), so cutting them never delays the drawing.
// It only reads its inputs and writes its outputs through the small interfaces below: no layer depends on another's
// insides, nor on the planner's.

import type { Coverage } from '../render/coverage';

/** what the planner reads, each frame */
export interface PlanSource {
  /** the camera's motion over the ground (cells a second: world x, rows) */
  vel(): [number, number];
  /** this frame's geometric coverage, or null (not placed, flying) */
  cover(): Coverage | null;
  /** the regions slid into the window and not written yet (world region keys "rx,ry"); whether the window draws all
   *  of region k now (every chunk, for sure) */
  arriving(): string[];
  windowDraws(key: string): boolean;
  /** the layers' own measured latencies (s), or null when not measured yet */
  landLatency(): number | null;
  tileLatency(): number | null;
}

/** what it decides, for the consumers to read */
export interface Plan {
  /** cells along the motion each layer works ahead (0 at rest) */
  reach: { land: number; window: number; tile: number };
  /** the unit motion (world x, rows), and the speed (cells a second) */
  dir: [number, number];
  speed: number;
  /** the footprint has undrawn land now or lately: rendering first */
  holes: boolean;
  /** the sim's ticks this frame at most (null: the tier's) */
  simCap: number | null;
}

/** (cells) a region and a half: the margin every reach gets past speed × latency */
const MARGIN = 96;
/** frames the planner keeps "holes" after the footprint was last undrawn */
const HOLD = 30;
/** the sim's ticks a frame while there are holes */
const SIM_CUT = 1;
/** under this (cells a second) the camera's at rest: no reach */
const MOVING = 6;
/** the latencies' defaults till measured (s) */
const LAND_S = 1;
const WINDOW_S = 0.3;
const TILE_S = 0.5;
const OFF = typeof location !== 'undefined' && new URLSearchParams(location.search).get('planner') === '0';

export class StreamPlanner {
  readonly plan: Plan = { reach: { land: 0, window: 0, tile: 0 }, dir: [0, 0], speed: 0, holes: false, simCap: null };
  /** for the bench and the gate: frames planned, with holes, with the sim cut; the window's latency samples (s) */
  readonly stats = { frames: 0, holeFrames: 0, simCut: 0, undrawnMax: 0, windowLatency: 0, landLatency: 0, tileLatency: 0 };
  private since = new Map<string, number>();
  private windowMs: number[] = [];
  private holeAt = -1e9;

  constructor(private src: PlanSource) {}

  /** the window's latency: slid in to every chunk drawn by the window, the 90th percentile of the last 24 regions (s) */
  private windowLatency(): number | null {
    if (this.windowMs.length < 3) return null;
    const a = [...this.windowMs].sort((x, y) => x - y);
    return a[Math.floor(a.length * 0.9)] / 1000;
  }

  update(): Plan {
    const P = this.plan;
    const S = this.stats;
    S.frames++;
    const now = performance.now();
    // (the window's latency, measured: each region from the frame it's seen arriving to the frame it's all drawn)
    const arr = new Set(this.src.arriving());
    for (const k of arr) if (!this.since.has(k)) this.since.set(k, now);
    for (const [k, t] of this.since) {
      if (arr.has(k)) continue;
      if (this.src.windowDraws(k)) {
        this.windowMs.push(now - t);
        if (this.windowMs.length > 24) this.windowMs.shift();
        this.since.delete(k);
      } else if (now - t > 5000) this.since.delete(k);
    }
    const [vx, vy] = this.src.vel();
    const sp = Math.hypot(vx, vy);
    P.speed = sp;
    P.dir = sp > 1e-6 ? [vx / sp, vy / sp] : [0, 0];
    const land = this.src.landLatency() ?? LAND_S;
    const win = this.windowLatency() ?? WINDOW_S;
    const tile = this.src.tileLatency() ?? TILE_S;
    S.landLatency = +land.toFixed(3);
    S.windowLatency = +win.toFixed(3);
    S.tileLatency = +tile.toFixed(3);
    const moving = sp > MOVING && !OFF;
    // (land must be made before the window needs it: its reach is its own latency and the window's after it)
    P.reach.land = moving ? sp * (land + win) + MARGIN : 0;
    P.reach.window = moving ? sp * win + MARGIN : 0;
    P.reach.tile = moving ? sp * tile + MARGIN : 0;
    const c = this.src.cover();
    const undrawn = c ? c.share : 0;
    S.undrawnMax = Math.max(S.undrawnMax, undrawn);
    if (undrawn > 0.001) this.holeAt = S.frames;
    P.holes = !OFF && S.frames - this.holeAt <= HOLD;
    P.simCap = P.holes ? SIM_CUT : null;
    if (P.holes) {
      S.holeFrames++;
      S.simCut++;
    }
    return P;
  }
}
