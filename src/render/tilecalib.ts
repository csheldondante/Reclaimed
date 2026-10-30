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
//  - the atlas: made at a starting size (the phone's 24 MB by the screen's css area, round 112's, at most 128 MB — a start,
//    not a limit), grown to what the floor needs (TileCache.grow) — bounded only by the hardware: one texture's side
//    (the device's maxTextureDimension2D, the adapter's maximum asked for at device creation) and the allocations that
//    succeed. A growth that runs out of memory keeps the atlas it had, and its size is the ceiling (`oom`): nothing at
//    or over it is asked for again. The DECISIONS round 115 answer: "Why limit to 512 and 128MB both should use as much
//    as we need that the hardware supports."
// ?tilerate= (tiles a frame at 60 Hz, as before) fixes the rate; ?floorframes= the budget (frames at 60 Hz); ?tilemb= the
// atlas (no growth). TileCache.stats and the tile gate's rows report what it holds (cal*). The floor's search itself is
// pure (`floorSearch`), unit-tested with the estimator (src/render/tilecalib.test.ts).

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
/** (round 112, tilefix) the atlas's starting size: the phone's 24 MB at its css screen (411 x 785, the pan bench's), by
 *  area, at most TILE_MB_START — where it starts, not how far it grows */
const PHONE_CSS = 411 * 785;
const PHONE_MB = 24;
const TILE_MB_START = 128;

/** (round 115) what the floor's search is given: the zoom now, the screen's ground at it (area, world units², and
 *  perimeter), a region's side (world units), the margin round the screen the look-ahead asks for, the atlas's slots and
 *  the share of them a screenful may take, the tiles the rate fills in the budget, and the part of a slot a tile takes at
 *  a scale k (the zoom over a candidate: 1, 0.5 or 0.25) */
export interface FloorInput {
  z0: number;
  area0: number;
  perim0: number;
  side: number;
  margin: number;
  slots: number;
  room: number;
  fillTiles: number;
  frac: (k: number) => number;
}
/** what it found: the floor (the widest zoom that holds), which test held it, the screen's regions there, the slots the
 *  rate's own floor would take (what the atlas grows to) */
export interface FloorOut {
  floor: number;
  bound: 'room' | 'rate' | 'none';
  tiles: number;
  slotsAtRate: number;
}

/**
 * (round 112, `tilefix3`; round 115) The zoom floor's search: from zoom 24 out by 4% steps, the widest zoom whose screen's
 * own regions (its area and its perimeter: a square's (side + 2)², a wide screen's longer edges counted) are at most
 * `fillTiles` (the rate's test) and whose screen with the margin, each region in its part of a slot, fits `room` of the
 * slots (the room's test). On past the room's to the rate's own floor, for the slots it would take.
 */
export function floorSearch(I: FloorInput): FloorOut {
  const regions = (k: number) => (I.area0 * k * k) / (I.side * I.side) + (I.perim0 * k) / I.side + 4;
  let floor = 24;
  let bound: FloorOut['bound'] = 'none';
  let tiles = 0;
  let roomFull = false;
  let slotsAtRate = 0;
  for (let z = 24; z >= 0.5; z /= 1.04) {
    const k = I.z0 / z;
    const n = regions(k);
    const need = regions(k * I.margin) * I.frac(k);
    if (n > I.fillTiles) {
      if (!roomFull) bound = 'rate';
      break;
    }
    slotsAtRate = Math.ceil(need / I.room);
    if (roomFull) continue;
    if (need > I.slots * I.room) {
      roomFull = true;
      bound = 'room';
      continue;
    }
    floor = z;
    tiles = n;
  }
  return { floor, bound, tiles, slotsAtRate };
}

export class TileCalibration {
  /** what it holds (the gate and the bench read it): the rate (tiles/s), the prior, the bottlenecked seconds measured,
   *  where the rate comes from, the floor's fill budget (s), the atlas's ceiling (bytes of its planes a growth ran out of
   *  memory at; 0 none yet) */
  readonly stats = { rate: 0, prior: 0, measuredS: 0, source: 'prior' as 'prior' | 'measured' | 'fixed', fillS: FILL_S, blocks: 0, ceilingBytes: 0 };
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
  landFrame(baked: number, bottleneck: boolean, now = performance.now()): void {
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

  /** (round 115) an atlas of this many bytes (its planes) couldn't be had: the hardware's ceiling — kept the lowest */
  oom(bytes: number): void {
    this.stats.ceilingBytes = this.stats.ceilingBytes ? Math.min(this.stats.ceilingBytes, bytes) : bytes;
  }

  /** (round 115) an atlas of this many bytes may be asked for: under the ceiling a growth found, if any */
  mayAsk(bytes: number): boolean {
    return !this.stats.ceilingBytes || bytes < this.stats.ceilingBytes;
  }

  /** (round 115) ?tilemb= sets the atlas: it doesn't grow */
  static get atlasFixed(): boolean {
    return Q.has('tilemb');
  }

  /** the atlas's starting size (MB) for a screen of this css size (round 112: the phone's by area, up to TILE_MB_START) */
  static atlasMB(cssW: number, cssH: number): number {
    return Number(Q.get('tilemb') ?? Math.min(TILE_MB_START, PHONE_MB * Math.max(1, (cssW * cssH) / PHONE_CSS)));
  }
}
