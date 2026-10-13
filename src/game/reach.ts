// The player's reach on a story level (DECISIONS round 30): the land around
// the green, by the green's size. Each connected patch of established green
// reaches past its edge by a quarter of its width (a circle 1.5× as wide as
// the patch), and at least MIN_REACH cells, following the patch's outline;
// reach only ever grows — land once seen stays seen. Only green that touches
// the reach counts: it starts as a disc around the level's start, and wild
// green elsewhere on the map is found (and then reaches too) when the reach
// gets to it — seeds blown into the fog don't open it up. Outside it the draw
// fogs the world (render.wgsl), the camera can't go there, and the player's
// touch and wind don't work there.
//
// Computed on the CPU from slow readbacks (veg, drift ~1 Hz): label the
// patches, then flood each cell's remaining "budget" (its patch's reach
// minus the distance travelled) outward in a bucket queue, keeping the best.

/** green at least this established counts (grass and up; fresh sprouts don't) */
const GREEN_V = 1.0;
/** the least a patch reaches past its edge (cells) */
export const MIN_REACH = 8;
/** reach past the edge per cell of the patch's width */
const REACH_PER_WIDTH = 0.25;
/** the fog's soft edge beyond the reach (cells) */
const FADE = 4;
/** bucket resolution of the flood (cells) */
const STEP = 0.25;

export class Reach {
  /** 0..255 per column: how far inside the revealed land (255 = inside) */
  readonly revealed: Uint8Array;
  /** revealed box (cells, inclusive), for the camera */
  bounds: [number, number, number, number] = [0, 0, 0, 0];
  private budget: Float32Array;
  private label: Int32Array;

  constructor(
    readonly w: number,
    readonly h: number,
    start: [number, number],
    startR = MIN_REACH * 1.5,
  ) {
    this.revealed = new Uint8Array(w * h);
    this.budget = new Float32Array(w * h);
    this.label = new Int32Array(w * h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const d = Math.hypot(x + 0.5 - start[0], y + 0.5 - start[1]);
        if (d < startR) this.revealed[y * w + x] = 255;
      }
    this.bounds = [Math.floor(start[0] - startR), Math.floor(start[1] - startR), Math.ceil(start[0] + startR), Math.ceil(start[1] + startR)];
  }

  /** Is (x, y) inside the reach (not in the fog)? */
  contains(x: number, y: number): boolean {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    if (ix < 0 || iy < 0 || ix >= this.w || iy >= this.h) return false;
    return this.revealed[iy * this.w + ix] >= 128;
  }

  /**
   * Grow the reach from the green on the map now. `buried(i)`: green under
   * blown dust is dormant and doesn't count.
   * @returns true if anything new was revealed
   */
  update(veg: Float32Array, buried: (i: number) => boolean): boolean {
    const { w, h } = this;
    const N = w * h;
    const label = this.label;
    label.fill(-1);
    // patches (4-connected) and their sizes
    const sizes: number[] = [];
    /** does the patch touch the reach (only those count) */
    const touches: boolean[] = [];
    const stack: number[] = [];
    for (let i = 0; i < N; i++) {
      if (label[i] >= 0 || veg[i] < GREEN_V || buried(i)) continue;
      const id = sizes.length;
      let n = 0;
      let seen = false;
      label[i] = id;
      stack.push(i);
      while (stack.length) {
        const j = stack.pop()!;
        n++;
        if (this.revealed[j] >= 128) seen = true;
        const x = j % w;
        const y = (j - x) / w;
        const nb = [x > 0 ? j - 1 : -1, x < w - 1 ? j + 1 : -1, y > 0 ? j - w : -1, y < h - 1 ? j + w : -1];
        for (const k of nb) {
          if (k < 0 || label[k] >= 0 || veg[k] < GREEN_V || buried(k)) continue;
          label[k] = id;
          stack.push(k);
        }
      }
      sizes.push(n);
      touches.push(seen);
    }
    // each patch's reach: a quarter of its width (the width of a disc of its area)
    const reachOf = sizes.map((a) => Math.max(MIN_REACH, REACH_PER_WIDTH * 2 * Math.sqrt(a / Math.PI)));
    // flood the budget outward (8-connected, diagonal steps cost √2)
    const budget = this.budget;
    budget.fill(-Infinity);
    const maxB = Math.max(0, ...reachOf) + FADE;
    const nb = Math.ceil(maxB / STEP) + 2;
    const buckets: number[][] = Array.from({ length: nb }, () => []);
    const bucketOf = (b: number) => Math.max(0, Math.min(nb - 1, Math.floor((b + FADE) / STEP)));
    for (let i = 0; i < N; i++) {
      if (label[i] < 0 || !touches[label[i]]) continue;
      budget[i] = reachOf[label[i]];
      buckets[bucketOf(budget[i])].push(i);
    }
    for (let k = nb - 1; k >= 0; k--) {
      const q = buckets[k];
      while (q.length) {
        const j = q.pop()!;
        const b = budget[j];
        if (bucketOf(b) !== k) continue; // stale entry
        const x = j % w;
        const y = (j - x) / w;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            const xx = x + dx;
            const yy = y + dy;
            if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
            const nbI = yy * w + xx;
            const nbB = b - (dx && dy ? Math.SQRT2 : 1);
            if (nbB <= budget[nbI] || nbB < -FADE) continue;
            budget[nbI] = nbB;
            buckets[bucketOf(nbB)].push(nbI);
          }
      }
    }
    // reveal (never shrinks)
    let grew = false;
    let x0 = w;
    let y0 = h;
    let x1 = -1;
    let y1 = -1;
    for (let i = 0; i < N; i++) {
      const b = budget[i];
      const v = b >= 0 ? 255 : b > -FADE ? Math.round(255 * (1 + b / FADE) * 0.5) : 0;
      if (v > this.revealed[i]) {
        this.revealed[i] = v;
        grew = true;
      }
      if (this.revealed[i] >= 128) {
        const x = i % w;
        const y = (i - x) / w;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
    if (x1 >= 0) this.bounds = [x0, y0, x1, y1];
    return grew;
  }
}
