// Round 105 (`ringwin`): the window on a ring. Every per-column buffer and texture on the GPU (and, as they move
// over, the CPU's per-column arrays) holds window column (x, y) at ((x + ring.x) mod W, (y + ring.y) mod H): a
// world cell keeps its place while the window slides over it, so a slide moves nothing — the strip leaving is
// frozen and the strip coming in written where it lies. Window coordinates stay what every caller uses; only the
// storage is rotated. The shaders index through common.wgsl colIdx / colIdxI / texCol / texCol2 / texColK
// (Globals.ring); the CPU through Ring.idx, and whole arrays cross with Ring.toRing / fromRing.
//
//   const r = core.ring                 // x, y: the offset (cells, multiples of the streamer's region)
//   r.idx(x, y)                         // window column (x, y)'s index on the ring
//   r.fromRing(gpuData, wordsPerCol)    // a readback in window order (a copy; the same array when the offset is 0)
//   r.toRing(cpuData, wordsPerCol)      // window order to the ring's (for an upload of a whole per-column array)

/** the per-column buffers (WorldGpu): bytes a column and planes — what a readback of one is rotated by */
export const COLUMN_BUFS: Record<string, [stride: number, planes: number]> = {
  surface: [4, 1],
  water: [4, 1],
  waterNext: [4, 1],
  waterPrev: [4, 1],
  waterSource: [4, 1],
  oil: [4, 1],
  oilNext: [4, 1],
  oilStored: [8, 1],
  lava: [16, 1],
  lavaNext: [16, 1],
  contam: [8, 1],
  contamNext: [8, 1],
  moisture: [4, 1],
  moistureNext: [4, 1],
  veg: [4, 1],
  vegNext: [4, 1],
  fire: [4, 1],
  fireNext: [4, 1],
  renderFields: [16, 1],
  bend: [16, 1],
  wilt: [16, 1],
  petals: [4, 1],
  contamDelta: [4, 2],
  deposit: [16, 1],
  places: [4, 1],
};

/** columns a page side (common.wgsl COLS_PAGE, world/layout.ts CHUNK) */
export const COLS_PAGE = 16;

/**
 * Where a window column's data lies, found as common.wgsl finds it: its chunk, the page that chunk is in (`page`: the
 * ring's table — the window's chunks rotated by the offset), its offset in the page. The offset is whole pages.
 */
export class Ring {
  /** the offset (cells; whole pages) */
  x = 0;
  y = 0;

  constructor(
    readonly W: number,
    readonly H: number,
  ) {}

  /** the offset set (cells, whole pages; any integers, wrapped) */
  set(x: number, y: number): void {
    if (x % COLS_PAGE || y % COLS_PAGE) throw new Error(`the ring's offset (${x}, ${y}) must be whole pages of ${COLS_PAGE} columns`);
    this.x = ((x % this.W) + this.W) % this.W;
    this.y = ((y % this.H) + this.H) % this.H;
  }

  /** the window moved by (dx, dy) columns over the world: where every world cell's data lies stays */
  slide(dx: number, dy: number): void {
    this.set(this.x + dx, this.y + dy);
  }

  /** the page (its place, in pages) holding window chunk (cx, cy): the ring's table */
  page(cx: number, cy: number): [number, number] {
    const nx = this.W / COLS_PAGE;
    const ny = this.H / COLS_PAGE;
    const px = cx + this.x / COLS_PAGE;
    const py = cy + this.y / COLS_PAGE;
    return [px >= nx ? px - nx : px, py >= ny ? py - ny : py];
  }

  /** window column (x, y)'s place (column, row) in the per-column data (x < W, y < H) */
  at(x: number, y: number): [number, number] {
    const [px, py] = this.page(Math.floor(x / COLS_PAGE), Math.floor(y / COLS_PAGE));
    return [px * COLS_PAGE + (x % COLS_PAGE), py * COLS_PAGE + (y % COLS_PAGE)];
  }

  /** window column (x, y)'s index in a per-column buffer */
  idx(x: number, y: number): number {
    const [px, py] = this.at(x, y);
    return py * this.W + px;
  }

  /**
   * (round 106, frameprobe) window column (x, y)'s index, as idx but nothing allocated: for the CPU's per-column
   * arrays kept on the ring (map.surface, the streamer's ground and relief, the level's caches), read a column at a time.
   * The offset is whole pages, so the wrap is the plain one (ringunit checks idx against the page form).
   */
  i(x: number, y: number): number {
    let px = x + this.x;
    let py = y + this.y;
    if (px >= this.W) px -= this.W;
    if (py >= this.H) py -= this.H;
    return py * this.W + px;
  }

  /** (round 106) window index i (y * W + x) to its index on the ring */
  of(i: number): number {
    const W = this.W;
    const y = (i / W) | 0;
    return this.i(i - y * W, y);
  }

  /** (round 106) a region's place (its corner on the ring) for a window corner that's whole regions: its rows are contiguous there */
  corner(lx: number, ly: number): number {
    return this.i(lx, ly);
  }

  /** a texel a 2 x 2 columns (tw x th of them, a page COLS_PAGE / 2 texels a side): window texel (tx, ty)'s index */
  idxHalf(tx: number, ty: number, tw: number): number {
    const h = COLS_PAGE / 2;
    const [px, py] = this.page(Math.floor(tx / h), Math.floor(ty / h));
    return (py * h + (ty % h)) * tw + px * h + (tx % h);
  }

  /**
   * A window rectangle [x0, x1) x [y0, y1) where it lies: the pieces it's cut into by the ring's seam (one to four),
   * each its window corner, its place and size. `half`: in a texel-a-2 x 2 grid (the wind field's), at half the offset.
   */
  pieces(x0: number, y0: number, x1: number, y1: number, half = false): { x: number; y: number; px: number; py: number; w: number; h: number }[] {
    const W = half ? this.W / 2 : this.W;
    const H = half ? this.H / 2 : this.H;
    const rx = half ? this.x / 2 : this.x;
    const ry = half ? this.y / 2 : this.y;
    // (the window column whose place is 0: the seam)
    const sx = rx ? W - rx : W;
    const sy = ry ? H - ry : H;
    const xs = x0 < sx && x1 > sx ? [[x0, sx], [sx, x1]] : [[x0, x1]];
    const ys = y0 < sy && y1 > sy ? [[y0, sy], [sy, y1]] : [[y0, y1]];
    const out: { x: number; y: number; px: number; py: number; w: number; h: number }[] = [];
    for (const [a, b] of xs)
      for (const [c, d] of ys) {
        const px = a + rx >= W ? a + rx - W : a + rx;
        const py = c + ry >= H ? c + ry - H : c + ry;
        out.push({ x: a, y: c, px, py, w: b - a, h: d - c });
      }
    return out;
  }

  get zero(): boolean {
    return this.x === 0 && this.y === 0;
  }

  /** an array in window order (`per` values a column, `planes` W × H planes) from the ring's order */
  fromRing<T extends ArrayLike<number> & { constructor: unknown; subarray(a: number, b: number): T; set(a: ArrayLike<number>, o: number): void; length: number }>(a: T, per = 1, planes = 1): T {
    return this.zero ? a : rotate(a, this.W, this.H, per, planes, -this.x, -this.y);
  }

  /** an array in the ring's order from window order */
  toRing<T extends ArrayLike<number> & { constructor: unknown; subarray(a: number, b: number): T; set(a: ArrayLike<number>, o: number): void; length: number }>(a: T, per = 1, planes = 1): T {
    return this.zero ? a : rotate(a, this.W, this.H, per, planes, this.x, this.y);
  }
}

/** a copy of `a` with what was at (x, y) at ((x + dx) mod W, (y + dy) mod H), per plane */
function rotate<T extends ArrayLike<number> & { constructor: unknown; subarray(a: number, b: number): T; set(a: ArrayLike<number>, o: number): void; length: number }>(a: T, W: number, H: number, per: number, planes: number, dx: number, dy: number): T {
  const out = new (a.constructor as { new (n: number): T })(a.length);
  const sx = ((dx % W) + W) % W;
  const sy = ((dy % H) + H) % H;
  const plane = W * H * per;
  for (let p = 0; p < planes; p++)
    for (let y = 0; y < H; y++) {
      const src = a.subarray(p * plane + y * W * per, p * plane + (y + 1) * W * per);
      const ty = (y + sy) % H;
      const row = p * plane + ty * W * per;
      // (the row's tail wraps to its head)
      const cut = (W - sx) * per;
      out.set(src.subarray(0, cut), row + sx * per);
      if (sx) out.set(src.subarray(cut, W * per), row);
    }
  // (anything past the planes: as it was)
  if (a.length > planes * plane) out.set(a.subarray(planes * plane, a.length), planes * plane);
  return out;
}
