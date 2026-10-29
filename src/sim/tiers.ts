// The sims' tiers (round 108, simtiers; BACKLOG SM1; the contract: api/contracts/simtiers.ts). One owner of which
// slow processes change the map: it writes their tiers into the Globals (common.wgsl tierLive / tierRect /
// tierRectP: TIER_* bits, read by tierRate) and runs the bakes, a few ticks a frame inside the fixed-step scheduler
// (scenes/world-core.ts advance calls pump). The kernels only ask tierRate(process, column); they don't know why.
//
// Defaults: every process live (the older scenes, the title diorama — its wind blows the dust off the level models —
// and the sandbox keep what they had); the atlas level, the legacy game's play, sets the round 108 defaults
// (playDefaults: all baked). ?tiers=live | baked | rain,wind,veg (those live, the rest baked) overrides a scene's.

import type { BakeOpts, BakeReport, LiveHandle, SimTiers, Tier, TierRect, TieredProcess } from '../api/contracts/simtiers';
import { TIERED_PROCESSES } from '../api/contracts/simtiers';
import { ROW_H } from '../world/lattice';
import type { GlobalsState } from './globals';

/** common.wgsl TIER_* */
export const TIER_BIT: Record<TieredProcess, number> = { rainErosion: 1, windErosion: 2, vegetation: 4 };
/** regions the Globals carry (common.wgsl tierRect) */
export const MAX_TIER_REGIONS = 4;
/** a bake's rate by default: simulated seconds a tick over the tick's own (the kernels' per-pass caps hold it) */
export const BAKE_GAIN = 8;
const SHORT: Record<string, TieredProcess> = { rain: 'rainErosion', wind: 'windErosion', veg: 'vegetation' };

/** ?tiers= — null: the scene's own */
function fromUrl(): Set<TieredProcess> | null {
  const v = typeof location === 'undefined' ? null : new URLSearchParams(location.search).get('tiers');
  if (v === null) return null;
  if (v === 'live') return new Set(TIERED_PROCESSES);
  if (v === 'baked') return new Set();
  const out = new Set<TieredProcess>();
  for (const k of v.split(',')) {
    const p = SHORT[k] ?? (TIERED_PROCESSES.includes(k as TieredProcess) ? (k as TieredProcess) : null);
    if (!p) throw new Error(`?tiers=${v}: live, baked, or a list of rain, wind, veg (those live)`);
    out.add(p);
  }
  return out;
}

/** a region kept in world cells (columns, rows), so it stays with the land when the window slides */
interface Region {
  wx0: number;
  wy0: number;
  wx1: number;
  wy1: number;
  bits: number;
  rate: number;
}

interface Bake {
  region: Region;
  ticks: number;
  left: number;
  perFrame: number;
  gain: number;
  seconds: number;
  t0: number;
  done: (r: BakeReport) => void;
}

export interface TierHost {
  /** the window's origin (world cells: columns, rows) — Globals.origin */
  origin(): [number, number];
  /** the window's size (cells) */
  dims: { w: number; h: number };
  /** the fixed step (s) */
  tickDt: number;
  /** keep the chunks a circle (window: x cells, y world units) touches awake for `secs` (sim/sleep.ts), when there's sleep */
  wake(x: number, y: number, r: number, secs: number): void;
}

export class Tiers implements SimTiers {
  /** the processes live everywhere (TIER_* bits) */
  private liveBits = 0;
  private readonly url = fromUrl();
  private readonly regions = new Set<Region>();
  private bakes: Bake[] = [];

  constructor(private host: TierHost) {
    this.setAll(new Set(TIERED_PROCESSES));
  }

  /** the round 108 defaults in play (DECISIONS round 108): rain and wind erosion and vegetation growth baked */
  playDefaults(): void {
    this.setAll(new Set());
  }

  private setAll(live: Set<TieredProcess>): void {
    const s = this.url ?? live;
    this.liveBits = 0;
    for (const p of s) this.liveBits |= TIER_BIT[p];
  }

  tier(p: TieredProcess): Tier {
    return this.liveBits & TIER_BIT[p] ? 'live' : 'baked';
  }

  setTier(p: TieredProcess, t: Tier): void {
    if (t === 'live') this.liveBits |= TIER_BIT[p];
    else this.liveBits &= ~TIER_BIT[p];
  }

  private bitsOf(ps: readonly TieredProcess[]): number {
    let b = 0;
    for (const p of ps) {
      if (!(p in TIER_BIT)) throw new Error(`tiers: no process ${p}`);
      b |= TIER_BIT[p];
    }
    return b;
  }

  private toRegion(r: TierRect | 'all', bits: number, rate: number): Region {
    const [ox, oy] = this.host.origin();
    const rect = r === 'all' ? { x0: 0, y0: 0, x1: this.host.dims.w, y1: this.host.dims.h * ROW_H } : r;
    if (!(rect.x1 > rect.x0 && rect.y1 > rect.y0)) throw new Error(`tiers: an empty region ${JSON.stringify(rect)}`);
    return { wx0: rect.x0 + ox, wy0: rect.y0 / ROW_H + oy, wx1: rect.x1 + ox, wy1: rect.y1 / ROW_H + oy, bits, rate };
  }

  private add(g: Region): void {
    // (the bakes' regions are added as they start: the cap counts those running)
    if (this.regions.size >= MAX_TIER_REGIONS) throw new Error(`tiers: at most ${MAX_TIER_REGIONS} regions live or baking at once`);
    this.regions.add(g);
  }

  live(ps: readonly TieredProcess[], region: TierRect): LiveHandle {
    const g = this.toRegion(region, this.bitsOf(ps), 1);
    this.add(g);
    return { release: () => void this.regions.delete(g) };
  }

  bake(region: TierRect | 'all', ps: readonly TieredProcess[], seconds: number, opts: BakeOpts = {}): Promise<BakeReport> {
    const gain = opts.gain ?? BAKE_GAIN;
    if (!(gain >= 1)) throw new Error(`tiers.bake: gain ${gain}, 1 or more`);
    if (!(seconds > 0)) throw new Error(`tiers.bake: ${seconds} s`);
    const ticks = Math.max(1, Math.round(seconds / (this.host.tickDt * gain)));
    return new Promise((done) =>
      this.bakes.push({
        region: this.toRegion(region, this.bitsOf(ps), gain),
        ticks,
        left: ticks,
        perFrame: Math.max(1, opts.ticksPerFrame ?? 30),
        gain,
        seconds,
        t0: performance.now(),
        done,
      }),
    );
  }

  /** a bake running or waiting */
  get baking(): boolean {
    return this.bakes.length > 0;
  }

  /** the tiers into the Globals, for the window where it is now */
  apply(g: GlobalsState): void {
    const [ox, oy] = this.host.origin();
    const { w, h } = this.host.dims;
    const regions: NonNullable<GlobalsState['tiers']>['regions'] = [];
    for (const r of this.regions) {
      const rect: [number, number, number, number] = [Math.max(0, r.wx0 - ox), Math.max(0, r.wy0 - oy), Math.min(w, r.wx1 - ox), Math.min(h, r.wy1 - oy)];
      // (off the window: nothing to do until it's back)
      if (rect[2] > rect[0] && rect[3] > rect[1]) regions.push({ rect, bits: r.bits, rate: r.rate });
    }
    g.tiers = { live: this.liveBits, regions };
  }

  /**
   * (the scheduler: WorldCore.advance, after the frame's own ticks) a running bake's ticks for this frame, `step`
   * one tick of the whole sim. Returns the ticks run.
   */
  pump(g: GlobalsState, step: () => void): number {
    const b = this.bakes[0];
    if (!b) return 0;
    // (its chunks kept awake for it: the passes skip sleeping ones — sim/cull.ts; the sleep mask is made before the
    // frame's ticks, so a bake starts the frame after its first wake)
    this.wakeRegion(b.region);
    if (!this.regions.has(b.region)) {
      this.add(b.region);
      return 0;
    }
    const n = Math.min(b.perFrame, b.left);
    this.apply(g);
    for (let i = 0; i < n; i++) step();
    b.left -= n;
    if (b.left <= 0) {
      this.regions.delete(b.region);
      this.bakes.shift();
      this.apply(g);
      b.done({ seconds: b.seconds, ticks: b.ticks, gain: b.gain, ms: performance.now() - b.t0 });
    }
    return n;
  }

  private wakeRegion(r: Region): void {
    const [ox, oy] = this.host.origin();
    const x0 = r.wx0 - ox;
    const x1 = r.wx1 - ox;
    const y0 = (r.wy0 - oy) * ROW_H;
    const y1 = (r.wy1 - oy) * ROW_H;
    this.host.wake((x0 + x1) / 2, (y0 + y1) / 2, Math.hypot(x1 - x0, y1 - y0) / 2, 5);
  }
}
