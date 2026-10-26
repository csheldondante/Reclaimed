// Sleep and wake (round 80, BACKLOG P3; the user: "freezing parts of the simulation (like rigidbodies going
// to rest in a physics engine) and then unfreezing selectively based on player interactions … Water and
// magma I figure we can freeze into a flow steady state").
//
// A chunk (16 × 16 columns, the layers' own) is awake until a time; past it, it sleeps. Asleep, the systems
// that change the ground skip it (common.wgsl `asleep`, Globals.sleep): the layers, plants, fire, moisture
// and stains stay as they are, its water and lava keep their depth and their flow (the flux isn't touched,
// so the surface is drawn moving and a frozen river goes on feeding what's awake below it — a basin spills
// forever until it wakes); what lands on it (dust, leaves) fades. Wind and particles run everywhere.
//
// What wakes a chunk: (with ?wakenear=1) the player's whereabouts (`near`), the world's events (powers, edits, lightning:
// Globals.events) with a margin, storms raining, and land that has just come in (a slide's new chunks,
// everything after a slide in z) for a few seconds to settle.

import { CHUNK } from '../world/layout';
import { ROW_H } from '../world/lattice';
import type { WorldEvent } from './globals';

/** chunks the mask holds (common.wgsl: 64 words) */
const MAX_CHUNKS = 2048;
/** how long a woken chunk stays awake (s): an event's, land just come in, the player's ring */
const EVENT_S = 8;
const SETTLE_S = 1.5;
const NEAR_S = 1.5;
const DROWSE_S = 0.25;
/** (round 83) land come in stays drowsy for this many of the sim's ticks (not seconds: a slide holds the sim, and
 *  its derived fields — the surface, the render fields — must be made before it sleeps) */
const DROWSE_TICKS = 8;
/** (perfopt, ?settle=0 — DECISIONS round 83: "Generated land should come in settled"; "We don't need to simulate a
 *  map cell we stream") land come in — a slide's new chunks, the window cut again in z, a warp, the first window —
 *  doesn't wake to settle: it falls asleep at once (drowsy for a moment: its layers carried through) */
/** (perfopt, ?sleepmore=1) the surface and render-field passes skip sleeping chunks too (but drowsy ones): every
 *  chunk is drowsy for DROWSE_S after any slide, its derived textures moved */
export const SLEEP_MORE = typeof location !== 'undefined' && new URLSearchParams(location.search).get('sleepmore') === '1';
export const SETTLE = typeof location === 'undefined' || new URLSearchParams(location.search).get('settle') !== '0';
/**
 * (round 83, the user: "all generators make a steady state so when we arrive nothing is simulated until the
 * player interacts with it or the session otherwise requests it to unfreeze") The player's whereabouts don't
 * wake what's round them (the camera's target, a game's unit: `near`) — only what's done there does (the
 * events: edits, powers, lightning, a fire set, a gust) and the storms raining. ?wakenear=1: as before, the
 * ring round the player awake.
 */
export const WAKE_NEAR = typeof location !== 'undefined' && new URLSearchParams(location.search).get('wakenear') === '1';

export class Sleep {
  /** per chunk, the time (s) it sleeps again */
  private until: Float32Array;
  readonly mask = new Uint32Array(MAX_CHUNKS / 32);
  /** chunks fallen asleep within DROWSE_S: their layers carried through once (common.wgsl drowsy) */
  readonly drowse = new Uint32Array(MAX_CHUNKS / 32);
  /** chunks awake at the last update */
  awake = 0;

  constructor(
    private cx: number,
    private cy: number,
  ) {
    if (cx * cy > MAX_CHUNKS) throw new Error(`sleep: ${cx} × ${cy} chunks, the mask holds ${MAX_CHUNKS}`);
    this.until = new Float32Array(cx * cy);
    this.drowseTick = new Float64Array(cx * cy);
  }
  /** per chunk, the sim's tick it's drowsy until (land come in: its derived fields made, then asleep) */
  private drowseTick: Float64Array;
  /** the sim's tick at the last update */
  private tick = 0;

  /** (?flow=1, flow/steady.ts) how long an event keeps its chunks awake (s): the steady state then decides */
  eventSecs = EVENT_S;

  /** wake chunk k (chunk index) for `secs` from `now` (flow/steady.ts: kept awake while unsteady) */
  wakeChunk(k: number, secs: number, now: number): void {
    this.until[k] = Math.max(this.until[k], now + secs);
  }

  /** is chunk k awake at `now`? */
  isAwake(k: number, now: number): boolean {
    return this.until[k] > now;
  }

  /** wake the chunks a circle (world units, window) touches for `secs` from `now` */
  wake(x: number, y: number, r: number, secs: number, now: number): void {
    const x0 = Math.max(0, Math.floor((x - r) / CHUNK));
    const x1 = Math.min(this.cx - 1, Math.floor((x + r) / CHUNK));
    const y0 = Math.max(0, Math.floor((y - r) / ROW_H / CHUNK));
    const y1 = Math.min(this.cy - 1, Math.floor((y + r) / ROW_H / CHUNK));
    for (let j = y0; j <= y1; j++)
      for (let i = x0; i <= x1; i++) {
        const k = j * this.cx + i;
        this.until[k] = Math.max(this.until[k], now + secs);
      }
  }

  /** land come in everywhere (the first window, a slide in z, a warp): woken to settle for `secs` — or, with
   *  ?settle=0, only drowsy (asleep at once, its layers carried through) */
  settleAll(secs: number, now: number): void {
    this.wakeAll(SETTLE ? secs : 0, now);
    this.drowseTick.fill(this.tick + DROWSE_TICKS);
  }

  wakeAll(secs: number, now: number): void {
    for (let k = 0; k < this.until.length; k++) this.until[k] = Math.max(this.until[k], now + secs);
  }

  /** the window slid (dx, dy columns, whole chunks): the chunks go with the land, the new ones wake to settle */
  /** (sleepmore) when the window last slid: every chunk drowsy for DROWSE_S after */
  private slidAt = -1e9;

  shift(dx: number, dy: number, now: number): void {
    this.slidAt = now;
    const dcx = dx / CHUNK;
    const dcy = dy / CHUNK;
    const old = this.until.slice();
    const oldT = this.drowseTick.slice();
    for (let j = 0; j < this.cy; j++)
      for (let i = 0; i < this.cx; i++) {
        const si = i + dcx;
        const sj = j + dcy;
        const fresh = si < 0 || sj < 0 || si >= this.cx || sj >= this.cy;
        this.until[j * this.cx + i] = fresh ? now + (SETTLE ? SETTLE_S : 0) : old[sj * this.cx + si];
        this.drowseTick[j * this.cx + i] = fresh ? this.tick + DROWSE_TICKS : oldT[sj * this.cx + si];
      }
  }

  /** this frame's wakers, then the mask (bits set: asleep) */
  update(now: number, near: [number, number, number] | null, events: WorldEvent[], storms: { x: number; y: number; radius: number; intensity: number }[], tick = this.tick): Uint32Array {
    this.tick = tick;
    if (near && WAKE_NEAR) this.wake(near[0], near[1], near[2], NEAR_S, now);
    for (const e of events) this.wake(e.x, e.y, e.radius + CHUNK, this.eventSecs, now);
    for (const s of storms) if (s.intensity > 0.2) this.wake(s.x, s.y, s.radius, NEAR_S, now);
    this.mask.fill(0);
    this.drowse.fill(0);
    let awake = 0;
    for (let k = 0; k < this.until.length; k++) {
      if (this.until[k] > now) awake++;
      else {
        this.mask[k >> 5] |= 1 << (k & 31);
        if (now - this.until[k] < DROWSE_S || tick < this.drowseTick[k] || (SLEEP_MORE && now - this.slidAt < DROWSE_S)) this.drowse[k >> 5] |= 1 << (k & 31);
      }
    }
    this.awake = awake;
    return this.mask;
  }

  static readonly SETTLE_S = SETTLE_S;
  static readonly EVENT_S = EVENT_S;
}
