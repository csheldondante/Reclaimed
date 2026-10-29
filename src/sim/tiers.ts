// The sims' tiers (round 108, simtiers; BACKLOG SM1; the contract: api/contracts/simtiers.ts). One owner of which
// slow processes change the map. It rasterises the tiers into a texture of the window's chunks (world-gpu tierTex,
// read by tiers.wgsl tierRate: a texel a chunk, x rain erosion, y wind erosion, z vegetation — 0 baked, 1 live,
// more a bake's gain), written only when it changes, and runs the bakes a few ticks a frame inside the fixed-step
// scheduler (scenes/world-core.ts advance calls pump). The kernels only ask tierRate(process, column).
//
// What makes a chunk's process run, the most of:
//  - the process's tier everywhere (setTier);
//  - a region the game asked live (live) — any chunk it touches;
//  - a running bake's region, at its gain;
//  - (SM2, following round 78's "unfreeze for player interactions") the player's interactions: an event (a power,
//    an edit, lightning) or a stroke of wind makes rain and wind erosion live in the chunks round it, until the area
//    settles — at least INTERACT_MIN_S, then while the chunk stays awake (sim/sleep.ts), at most INTERACT_MAX_S.
//    Vegetation stays baked there: the player's own grow tap is live anyway (wilt.wgsl, particles.wgsl).
//
// Defaults: every process live (the older scenes, the title diorama — its wind blows the dust off the level models —
// and the sandbox keep what they had); the atlas level, the legacy game's play, sets the round 108 defaults
// (playDefaults: all baked). ?tiers=live | baked | rain,wind,veg (those live, the rest baked) overrides a scene's.

import type { BakeOpts, BakeReport, LiveHandle, SimTiers, Tier, TierRect, TieredProcess } from '../api/contracts/simtiers';
import { TIERED_PROCESSES } from '../api/contracts/simtiers';
import { CHUNK } from '../world/layout';
import { ROW_H } from '../world/lattice';

/** tiers.wgsl TIER_*: the texel's channel */
export const TIER_CHANNEL: Record<TieredProcess, number> = { rainErosion: 0, windErosion: 1, vegetation: 2 };
const BIT: Record<TieredProcess, number> = { rainErosion: 1, windErosion: 2, vegetation: 4 };
/** a bake's rate by default: simulated seconds a tick over the tick's own (the kernels' per-pass caps hold it) */
export const BAKE_GAIN = 8;
/** (SM2) the least and most a player's interaction keeps erosion live round it (s) */
export const INTERACT_MIN_S = 4;
export const INTERACT_MAX_S = 60;
/** (SM2) the margin round an interaction's radius (cells) */
const INTERACT_PAD = 4;
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
  started: boolean;
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
  /** is window chunk k (cy * chunks across + cx) awake (sim/sleep.ts)? false where there's no sleep */
  awake(k: number): boolean;
  /** the rates into the GPU (world-gpu tierTex: rgba32float, chunks across × down) */
  write(data: Float32Array): void;
}

export class Tiers implements SimTiers {
  /** the processes live everywhere (BIT) */
  private liveBits = 0;
  private readonly url = fromUrl();
  private readonly regions = new Set<Region>();
  private bakes: Bake[] = [];
  private readonly cx: number;
  private readonly cy: number;
  /** (SM2) per world chunk ("cx,cy"), when the player last did something there (s) */
  private readonly touched = new Map<string, number>();
  private rates: Float32Array;
  private sent: Float32Array | null = null;

  constructor(private host: TierHost) {
    this.cx = Math.ceil(host.dims.w / CHUNK);
    this.cy = Math.ceil(host.dims.h / CHUNK);
    this.rates = new Float32Array(this.cx * this.cy * 4);
    this.setAll(new Set(TIERED_PROCESSES));
  }

  /** the round 108 defaults in play (DECISIONS round 108): rain and wind erosion and vegetation growth baked */
  playDefaults(): void {
    this.setAll(new Set());
  }

  private setAll(live: Set<TieredProcess>): void {
    const s = this.url ?? live;
    this.liveBits = 0;
    for (const p of s) this.liveBits |= BIT[p];
  }

  tier(p: TieredProcess): Tier {
    return this.liveBits & BIT[p] ? 'live' : 'baked';
  }

  setTier(p: TieredProcess, t: Tier): void {
    if (!(p in BIT)) throw new Error(`tiers: no process ${p}`);
    if (t === 'live') this.liveBits |= BIT[p];
    else this.liveBits &= ~BIT[p];
  }

  private bitsOf(ps: readonly TieredProcess[]): number {
    let b = 0;
    for (const p of ps) {
      if (!(p in BIT)) throw new Error(`tiers: no process ${p}`);
      b |= BIT[p];
    }
    return b;
  }

  private toRegion(r: TierRect | 'all', bits: number, rate: number): Region {
    const [ox, oy] = this.host.origin();
    const rect = r === 'all' ? { x0: 0, y0: 0, x1: this.host.dims.w, y1: this.host.dims.h * ROW_H } : r;
    if (!(rect.x1 > rect.x0 && rect.y1 > rect.y0)) throw new Error(`tiers: an empty region ${JSON.stringify(rect)}`);
    return { wx0: rect.x0 + ox, wy0: rect.y0 / ROW_H + oy, wx1: rect.x1 + ox, wy1: rect.y1 / ROW_H + oy, bits, rate };
  }

  live(ps: readonly TieredProcess[], region: TierRect): LiveHandle {
    const g = this.toRegion(region, this.bitsOf(ps), 1);
    this.regions.add(g);
    return { release: () => void this.regions.delete(g) };
  }

  bake(region: TierRect | 'all', ps: readonly TieredProcess[], seconds: number, opts: BakeOpts = {}): Promise<BakeReport> {
    const gain = opts.gain ?? BAKE_GAIN;
    if (!(gain >= 1)) throw new Error(`tiers.bake: gain ${gain}, 1 or more`);
    if (!(seconds > 0)) throw new Error(`tiers.bake: ${seconds} s`);
    const ticks = Math.max(1, Math.round(seconds / (this.host.tickDt * gain)));
    const g = this.toRegion(region, this.bitsOf(ps), gain);
    return new Promise((done) => this.bakes.push({ region: g, ticks, left: ticks, perFrame: Math.max(1, opts.ticksPerFrame ?? 30), gain, seconds, t0: performance.now(), started: false, done }));
  }

  /** (for probes and tests) the rates last sent at a window column (x cells, y world units): rain, wind, vegetation */
  rateAt(x: number, y: number): [number, number, number] {
    const i = Math.floor(x / CHUNK);
    const j = Math.floor(y / ROW_H / CHUNK);
    if (!this.sent || i < 0 || j < 0 || i >= this.cx || j >= this.cy) return [0, 0, 0];
    const k = (j * this.cx + i) * 4;
    return [this.sent[k], this.sent[k + 1], this.sent[k + 2]];
  }

  /** a bake running or waiting */
  get baking(): boolean {
    return this.bakes.length > 0;
  }

  /**
   * (SM2) the player did something here (window: x cells, y world units; a radius in cells): rain and wind erosion
   * live round it until it settles. WorldCore feeds it every tick's events and the wind's strokes.
   */
  interact(x: number, y: number, r: number, now = performance.now() / 1000): void {
    const [ox, oy] = this.host.origin();
    const rr = r + INTERACT_PAD;
    const x0 = Math.floor((x - rr + ox) / CHUNK);
    const x1 = Math.floor((x + rr + ox) / CHUNK);
    const y0 = Math.floor(((y - rr) / ROW_H + oy) / CHUNK);
    const y1 = Math.floor(((y + rr) / ROW_H + oy) / CHUNK);
    for (let j = y0; j <= y1; j++) for (let i = x0; i <= x1; i++) this.touched.set(`${i},${j}`, now);
  }

  /** the rates for the window where it is now, into the GPU when they changed */
  apply(now = performance.now() / 1000): void {
    const [ox, oy] = this.host.origin();
    const { cx, cy } = this;
    const R = this.rates;
    const base = [this.liveBits & 1 ? 1 : 0, this.liveBits & 2 ? 1 : 0, this.liveBits & 4 ? 1 : 0];
    for (let k = 0; k < cx * cy; k++) {
      R[k * 4] = base[0];
      R[k * 4 + 1] = base[1];
      R[k * 4 + 2] = base[2];
      R[k * 4 + 3] = 0;
    }
    const regions = [...this.regions];
    const b = this.bakes[0];
    if (b?.started) regions.push(b.region);
    for (const g of regions) {
      // (the chunks it touches, in window chunks; off the window: nothing until it's back)
      const i0 = Math.max(0, Math.floor((g.wx0 - ox) / CHUNK));
      const i1 = Math.min(cx - 1, Math.ceil((g.wx1 - ox) / CHUNK) - 1);
      const j0 = Math.max(0, Math.floor((g.wy0 - oy) / CHUNK));
      const j1 = Math.min(cy - 1, Math.ceil((g.wy1 - oy) / CHUNK) - 1);
      for (let j = j0; j <= j1; j++)
        for (let i = i0; i <= i1; i++)
          for (let c = 0; c < 3; c++) if (g.bits & (1 << c)) R[(j * cx + i) * 4 + c] = Math.max(R[(j * cx + i) * 4 + c], g.rate);
    }
    // (SM2) the player's interactions: rain and wind erosion live there until it settles
    const ocx = Math.floor(ox / CHUNK);
    const ocy = Math.floor(oy / CHUNK);
    for (const [key, t] of this.touched) {
      const [wi, wj] = key.split(',').map(Number);
      const i = wi - ocx;
      const j = wj - ocy;
      const inside = i >= 0 && j >= 0 && i < cx && j < cy;
      const age = now - t;
      if (age > INTERACT_MAX_S || (age > INTERACT_MIN_S && !(inside && this.host.awake(j * cx + i)))) {
        this.touched.delete(key);
        continue;
      }
      if (!inside) continue;
      const k = (j * cx + i) * 4;
      R[k] = Math.max(R[k], 1);
      R[k + 1] = Math.max(R[k + 1], 1);
    }
    const s = this.sent;
    let same = s !== null;
    for (let k = 0; same && k < R.length; k++) if (s![k] !== R[k]) same = false;
    if (!same) {
      this.host.write(R);
      this.sent = R.slice();
    }
  }

  /**
   * (the scheduler: WorldCore.advance, after the frame's own ticks) a running bake's ticks for this frame, `step`
   * one tick of the whole sim. Returns the ticks run.
   */
  pump(step: () => void): number {
    const b = this.bakes[0];
    if (!b) return 0;
    // (its chunks kept awake for it: the passes skip sleeping ones — sim/cull.ts; the sleep mask is made before the
    // frame's ticks, so a bake starts the frame after its first wake)
    this.wakeRegion(b.region);
    if (!b.started) {
      b.started = true;
      return 0;
    }
    const n = Math.min(b.perFrame, b.left);
    this.apply();
    for (let i = 0; i < n; i++) step();
    b.left -= n;
    if (b.left <= 0) {
      this.bakes.shift();
      this.apply();
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
