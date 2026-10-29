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
import type { Pages } from './pages';
import { RIVERS } from './world-gpu';

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
/** (perfopt, settle=0) the ticks land come in settles its water for (WaterSystem's settling passes) */
const SETTLE_TICKS = 64;
/** (perfopt, ?settle=0 — DECISIONS round 83: "Generated land should come in settled"; "We don't need to simulate a
 *  map cell we stream") land come in — a slide's new chunks, the window cut again in z, a warp, the first window —
 *  doesn't wake to settle: it falls asleep at once (drowsy for a moment: its layers carried through) */
/** (perfopt, ?sleepmore=1) the surface and render-field passes skip sleeping chunks too (but drowsy ones): every
 *  chunk was drowsy for DROWSE_S after any slide, its derived textures moved — (round 106, frameprobe) not since
 *  ringwin: nothing moves on a slide, only the strip come in is drowsy (its drowseTick, shift) */
export const SLEEP_MORE = typeof location !== 'undefined' && new URLSearchParams(location.search).get('sleepmore') === '1';
// (round 84: with ?rivers=table, off unless asked for — the atlas's land comes in at its steady state)
export const SETTLE = (() => {
  if (typeof location === 'undefined') return true;
  const v = new URLSearchParams(location.search).get('settle');
  return v === null ? RIVERS !== 'table' : v !== '0';
})();
/**
 * (round 83, the user: "all generators make a steady state so when we arrive nothing is simulated until the
 * player interacts with it or the session otherwise requests it to unfreeze") The player's whereabouts don't
 * wake what's round them (the camera's target, a game's unit: `near`) — only what's done there does (the
 * events: edits, powers, lightning, a fire set, a gust) and the storms raining. ?wakenear=1: as before, the
 * ring round the player awake.
 */
export const WAKE_NEAR = typeof location !== 'undefined' && new URLSearchParams(location.search).get('wakenear') === '1';

/**
 * (round 84 — the user: "we can have a tolerance and decide when we are close enough to steady state to freeze and
 * treat it as an animation only … the simulation can then take over until it finishes finding another near steady
 * state then freeze things") ?settletol=x: a woken chunk stays awake past its time while its water still changes
 * by more than x in a step (world-gpu waterChange), up to SETTLE_MAX_S; then it sleeps — its last flux the animation,
 * a river's columns back to the atlas's table. 0: off (a woken chunk sleeps at its time). On by default with
 * ?rivers=table.
 */
export const SETTLE_TOL = (() => {
  const v = typeof location === 'undefined' ? null : new URLSearchParams(location.search).get('settletol');
  return v !== null ? Number(v) : RIVERS === 'table' ? 0.01 : 0;
})();
/** the longest a chunk is kept awake for its water still settling (s) */
const SETTLE_MAX_S = 60;
/** how far past now an unsettled chunk is kept (s): longer than the level reads waterChange */
const SETTLE_HOLD_S = 0.75;

/**
 * (Round 107, pages P2.3b) Every per-chunk state here is keyed by the chunk's slot (its page's: sim/pages.ts), not its
 * place in the window: a slide moves none of it — the chunks coming in take the slots of those that left, and only
 * theirs are made fresh. The callers still speak window chunks and cells (wake, only, shift); the bits (mask, drowse:
 * Globals.sleep / drowse, common.wgsl asleep) are the slots'. `wakeSlot` / `isAwakeSlot` for what's keyed by slot
 * itself (flow/steady.ts, whose counters liquid.wgsl keys by slot).
 */
export class Sleep {
  /** per slot, the time (s) it sleeps again */
  private until: Float32Array;
  readonly mask = new Uint32Array(MAX_CHUNKS / 32);
  /** chunks fallen asleep within DROWSE_S: their layers carried through once (common.wgsl drowsy) */
  readonly drowse = new Uint32Array(MAX_CHUNKS / 32);
  /** chunks awake at the last update */
  awake = 0;

  constructor(
    private cx: number,
    private cy: number,
    /** the window's page table (window chunk -> slot); absent: the identity */
    private pages?: Pages,
  ) {
    if (cx * cy > MAX_CHUNKS) throw new Error(`sleep: ${cx} × ${cy} chunks, the mask holds ${MAX_CHUNKS}`);
    if (pages && pages.nx * pages.ny !== cx * cy) throw new Error(`sleep: ${cx} × ${cy} chunks, the page table ${pages.nx} × ${pages.ny}`);
    this.until = new Float32Array(cx * cy);
    this.wokeAt = new Float32Array(cx * cy);
    this.drowseTick = new Float64Array(cx * cy);
  }
  /** per chunk, the sim's tick it's drowsy until (land come in: its derived fields made, then asleep) */
  private drowseTick: Float64Array;
  /** the sim's tick at the last update */
  private tick = 0;

  /** (?flow=1, flow/steady.ts) how long an event keeps its chunks awake (s): the steady state then decides */
  eventSecs = EVENT_S;

  /** window chunk (cy * cx + cx)'s slot */
  private slotOf(c: number): number {
    return this.pages ? this.pages.table[c] : c;
  }

  /** wake the chunk in slot s for `secs` from `now` (flow/steady.ts: kept awake while unsteady) */
  wakeSlot(s: number, secs: number, now: number): void {
    if (this.filter && !this.filter[s]) return;
    this.until[s] = Math.max(this.until[s], now + secs);
  }

  /** is the chunk in slot s awake at `now`? */
  isAwakeSlot(s: number, now: number): boolean {
    return this.until[s] > now;
  }

  /** is window chunk k (cy * cx + cx) awake at `now`? */
  isAwake(k: number, now: number): boolean {
    return this.until[this.slotOf(k)] > now;
  }

  /** (hybrid, scenes/hybrid.ts) per slot, 0: nothing wakes it — its land is the heightfield's, nothing of the sim
   *  there is drawn; null: every chunk may wake */
  private filter: Uint8Array | null = null;

  /** (hybrid) Which chunks may wake (per chunk 1 or 0; null: all). One awake now that may not sleeps when its time's up. */
  only(filter: Uint8Array | null): void {
    if (filter && filter.length !== this.until.length) throw new Error(`sleep.only: ${filter.length} chunks, not ${this.until.length}`);
    // (per window chunk in; kept per slot)
    if (!filter) this.filter = null;
    else {
      const f = new Uint8Array(filter.length);
      for (let c = 0; c < filter.length; c++) f[this.slotOf(c)] = filter[c];
      this.filter = f;
    }
  }

  /** wake the chunks a circle (world units, window) touches for `secs` from `now` */
  wake(x: number, y: number, r: number, secs: number, now: number): void {
    const x0 = Math.max(0, Math.floor((x - r) / CHUNK));
    const x1 = Math.min(this.cx - 1, Math.floor((x + r) / CHUNK));
    const y0 = Math.max(0, Math.floor((y - r) / ROW_H / CHUNK));
    const y1 = Math.min(this.cy - 1, Math.floor((y + r) / ROW_H / CHUNK));
    for (let j = y0; j <= y1; j++)
      for (let i = x0; i <= x1; i++) {
        const k = this.slotOf(j * this.cx + i);
        if (this.filter && !this.filter[k]) continue;
        if (this.until[k] <= now) this.wokeAt[k] = now;
        this.until[k] = Math.max(this.until[k], now + secs);
      }
  }

  /** per slot, when it last woke (s): SETTLE_MAX_S counts from it */
  private wokeAt = new Float32Array(0);

  /**
   * (round 84, ?settletol) The water's most change in a step per slot since the last read (world-gpu waterChange):
   * a woken chunk whose time is nearly up and whose water still changes by more than the tolerance stays awake.
   * Returns the chunks kept.
   */
  holdUnsettled(change: Float32Array, now: number, tol = SETTLE_TOL): number {
    if (!(tol > 0)) return 0;
    let kept = 0;
    for (let k = 0; k < this.until.length; k++) {
      if (this.until[k] <= now || this.until[k] > now + SETTLE_HOLD_S) continue;
      if (change[k] > tol && now - this.wokeAt[k] < SETTLE_MAX_S) {
        this.until[k] = now + SETTLE_HOLD_S;
        kept++;
      }
    }
    this.unsettled = kept;
    return kept;
  }
  /** chunks kept awake at the last holdUnsettled */
  unsettled = 0;

  /** land come in everywhere (the first window, a slide in z, a warp): woken to settle for `secs` — or, with
   *  ?settle=0, only drowsy (asleep at once, its layers carried through) */
  settleAll(secs: number, now: number): void {
    this.wakeAll(SETTLE ? secs : 0, now);
    this.drowseTick.fill(this.tick + DROWSE_TICKS);
    this.settling = [{ rect: [0, 0, this.cx * CHUNK, this.cy * CHUNK], until: -1 }];
    // (perfopt: counted from the sim's tick at the next update — the first window's comes before any, at tick 0,
    // and the level's warmup had run hundreds by then: it was never drowsy)
    this.settleNext = true;
  }
  private settleNext = false;

  wakeAll(secs: number, now: number): void {
    for (let k = 0; k < this.until.length; k++) if (!this.filter || this.filter[k]) this.until[k] = Math.max(this.until[k], now + secs);
  }

  /** the window slid (dx, dy columns, whole chunks): the chunks go with the land, the new ones wake to settle */

  /**
   * (perfopt) Land come in and still settling its water: rects of columns (x, y, w, h) and the tick they're done at
   * (−1: from the next update) — the window's coordinates, moved with it on a slide.
   */
  settling: { rect: [number, number, number, number]; until: number }[] = [];

  shift(dx: number, dy: number, now: number): void {
    // (what was settling moves with the land; the strip come in settles from the next update)
    const W = this.cx * CHUNK;
    const H = this.cy * CHUNK;
    this.settling = this.settling
      .map((s) => ({ rect: [s.rect[0] - dx, s.rect[1] - dy, s.rect[2], s.rect[3]] as [number, number, number, number], until: s.until }))
      .filter((s) => s.rect[0] + s.rect[2] > 0 && s.rect[1] + s.rect[3] > 0 && s.rect[0] < W && s.rect[1] < H);
    if (dx) this.settling.push({ rect: dx > 0 ? [W - dx, 0, dx, H] : [0, 0, -dx, H], until: -1 });
    if (dy) this.settling.push({ rect: dy > 0 ? [0, H - dy, W, dy] : [0, 0, W, -dy], until: -1 });
    const dcx = dx / CHUNK;
    const dcy = dy / CHUNK;
    if (this.pages) {
      // (round 107, pages P2.3b: keyed by slot, nothing moves — the window's table has slid (onShift comes after the
      // ring's slide); the chunks come in, in the slots of those that left, start fresh)
      for (let j = 0; j < this.cy; j++)
        for (let i = 0; i < this.cx; i++) {
          const si = i + dcx;
          const sj = j + dcy;
          if (!(si < 0 || sj < 0 || si >= this.cx || sj >= this.cy)) continue;
          const k = this.slotOf(j * this.cx + i);
          // (hybrid: land come in is the heightfield's till the hybrid says — it doesn't wake to settle)
          if (this.filter) this.filter[k] = 0;
          const settle = !this.filter ? (SETTLE ? SETTLE_S : 0) : 0;
          this.until[k] = now + settle;
          this.wokeAt[k] = 0;
          this.drowseTick[k] = this.tick + DROWSE_TICKS;
        }
      return;
    }
    const old = this.until.slice();
    const oldT = this.drowseTick.slice();
    const fOld = this.filter?.slice();
    for (let j = 0; j < this.cy; j++)
      for (let i = 0; i < this.cx; i++) {
        const si = i + dcx;
        const sj = j + dcy;
        const fresh = si < 0 || sj < 0 || si >= this.cx || sj >= this.cy;
        // (hybrid: land come in is the heightfield's till the hybrid says — it doesn't wake to settle)
        if (this.filter && fOld) this.filter[j * this.cx + i] = fresh ? 0 : fOld[sj * this.cx + si];
        const settle = fresh && (!this.filter || this.filter[j * this.cx + i]) ? (SETTLE ? SETTLE_S : 0) : 0;
        this.until[j * this.cx + i] = fresh ? now + settle : old[sj * this.cx + si];
        this.drowseTick[j * this.cx + i] = fresh ? this.tick + DROWSE_TICKS : oldT[sj * this.cx + si];
      }
  }

  /** this frame's wakers, then the mask (bits set: asleep) */
  update(now: number, near: [number, number, number] | null, events: WorldEvent[], storms: { x: number; y: number; radius: number; intensity: number }[], tick = this.tick): Uint32Array {
    this.tick = tick;
    if (this.settleNext) {
      this.settleNext = false;
      this.drowseTick.fill(tick + DROWSE_TICKS);
    }
    // (one at a time — the water's settling pass takes the first: its ticks counted from when it's first)
    while (this.settling.length) {
      const s = this.settling[0];
      if (s.until < 0) s.until = tick + SETTLE_TICKS;
      if (tick < s.until) break;
      this.settling.shift();
    }
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
        if (now - this.until[k] < DROWSE_S || tick < this.drowseTick[k]) this.drowse[k >> 5] |= 1 << (k & 31);
      }
    }
    this.awake = awake;
    return this.mask;
  }

  static readonly SETTLE_S = SETTLE_S;
  static readonly EVENT_S = EVENT_S;
}
