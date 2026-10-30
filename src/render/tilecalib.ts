// The tiles' calibration to the hardware and the screen (round 115, `tilecal`; DECISIONS round 115 — the user: "the
// desktop version on my wide monitor does not load all the tiles (and I assume it is considerably more powerful than the
// phone) ... make the runtime calibrate to the hardware").
//
// One place owns the numbers the tile cache sizes itself by, each from what this device and screen measure rather than a
// tier's constant:
//  - the land's fill rate (tiles a second): measured while the render-only land is the bottleneck — every scratch slot
//    busy with a region wanted and none free to start it, or the frame's bakes at their cap — tiles baked over those
//    frames' time, folded a second of such time at a go into a running estimate that starts from the tier's prior
//    (round 112's 2 tiles a frame off a phone, 0.3 on one, at 60 Hz). Measured, it follows whatever sets it — the GPU, the
//    frame rate (the pacer's turns are a frame's: this iGPU made ~1.1-1.2 tiles a frame at 50 and at 90 fps), the
//    screen — so a device and display get their own; in seconds so the budget is time.
//  - the zoom floor's fill budget (seconds): a screenful's land made from nothing in this long — FILL_S, round 112's
//    300 frames at 60 Hz (a tighter one, the gate's 180, narrowed every device's zoom: measured, not kept).
//  - the atlas's budget (MB): the phone's 24 MB by the screen's css area (round 112), as before.
// ?tilerate= (tiles a frame at 60 Hz, as before) fixes the rate; ?floorframes= the budget (frames at 60 Hz); ?tilemb= the
// atlas. TileCache.stats and the tile gate's rows report what it holds (cal*).

const Q = new URLSearchParams(typeof location !== 'undefined' ? location.search : '');
const PHONE_UA = typeof navigator !== 'undefined' && /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);
/** the rates the overrides and the priors are said in were frames at this rate */
const REF_HZ = 60;
/** (round 112's measured fills, tiles a frame at 60 Hz) the prior a device starts from till it has measured its own */
const PRIOR_PHONE = 0.3;
const PRIOR = 2;
const FIXED_RATE = Q.has('tilerate') ? Number(Q.get('tilerate')) * REF_HZ : null;
/** seconds a screenful's land may take to make from nothing (round 112's FLOOR_FRAMES, 300 at 60 Hz) */
const FILL_S = Number(Q.get('floorframes') ?? 300) / REF_HZ;
/** seconds of bottlenecked time a block of the measurement holds, and a block's weight in the estimate (each block
 *  replaces this share of it: three blocks, two thirds measured) */
const BLOCK_S = 1;
const BLOCK_W = 0.3;
/** a frame longer than this (ms) is a stall or a hidden tab, not the land's pace: left out */
const GAP_MS = 250;
/** (round 112, tilefix) the atlas's budget: the phone's 24 MB at its css screen (411 x 785, the pan bench's), by area */
const PHONE_CSS = 411 * 785;
const PHONE_MB = 24;
const TILE_MB_MAX = 128;
/** (round 115) the most the atlas may grow to (MB of its baked planes; TileCache.grow), as the measured rate's zoom floor
 *  asks: a memory budget — WebGPU tells a page nothing of a device's memory, so it's the budget's, not the adapter's. Off
 *  a phone 512 MB; on one the most round 112 let any screen's atlas be made at, TILE_MB_MAX. */
const ATLAS_MOST_MB = 512;

export class TileCalibration {
  /** what it holds (the gate and the bench read it): the rate (tiles/s), the prior, the bottlenecked seconds measured,
   *  where the rate comes from, the floor's fill budget (s) */
  readonly stats = { rate: 0, prior: 0, measuredS: 0, source: 'prior' as 'prior' | 'measured' | 'fixed', fillS: FILL_S, blocks: 0 };
  /** (round 115) the planner's holes (level.ts): while set, only frames the pacer gives the tiles its turns for holes —
   *  a screenful filling, the zoom floor's own case — measure; a frame the streamer's strips share the turns isn't the
   *  fill's rate. Null: no planner, the pacer's turns as they come. */
  holes: (() => boolean) | null = null;
  private blockT = 0;
  private blockN = 0;
  private last = 0;

  constructor(readonly phone = PHONE_UA) {
    this.stats.prior = (phone ? PRIOR_PHONE : PRIOR) * REF_HZ;
    this.stats.rate = FIXED_RATE ?? this.stats.prior;
    if (FIXED_RATE !== null) this.stats.source = 'fixed';
  }

  /** tiles the land makes a second */
  get rate(): number {
    return this.stats.rate;
  }

  /** the tiles a screenful at the zoom floor may hold: what the land makes from nothing in the fill budget */
  get fillTiles(): number {
    return this.stats.rate * FILL_S;
  }

  /**
   * A frame of the land's (TileLandGpu.step): tiles baked this frame, and whether the land was the bottleneck — regions
   * wanted that couldn't start (no scratch slot free) or the bakes at their cap. Only those frames measure the rate.
   */
  landFrame(baked: number, bottleneck: boolean): void {
    const now = performance.now();
    const dt = this.last ? now - this.last : 0;
    this.last = now;
    if (!bottleneck || dt <= 0 || dt > GAP_MS || FIXED_RATE !== null || (this.holes && !this.holes())) return;
    this.blockT += dt / 1000;
    this.blockN += baked;
    this.stats.measuredS += dt / 1000;
    if (this.blockT < BLOCK_S) return;
    const r = this.blockN / this.blockT;
    this.stats.rate += (r - this.stats.rate) * BLOCK_W;
    this.stats.blocks++;
    this.stats.source = 'measured';
    this.blockT = this.blockN = 0;
  }

  /** (round 115) the most the atlas made at `madeMB` may grow to (MB): ATLAS_MOST_MB off a phone, TILE_MB_MAX on one; the
   *  atlas as made when ?tilemb= sets it */
  static atlasMostMB(madeMB: number): number {
    return Q.has('tilemb') ? madeMB : Math.max(madeMB, PHONE_UA ? TILE_MB_MAX : ATLAS_MOST_MB);
  }

  /** the atlas's budget (MB) for a screen of this css size (round 112: the phone's by area, up to TILE_MB_MAX) */
  static atlasMB(cssW: number, cssH: number): number {
    return Number(Q.get('tilemb') ?? Math.min(TILE_MB_MAX, PHONE_MB * Math.max(1, (cssW * cssH) / PHONE_CSS)));
  }
}
