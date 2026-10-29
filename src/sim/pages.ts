// Round 105 (`ringwin`): the window on a ring — a world cell keeps its place while the window slides over it, so a
// slide moves nothing: the strip leaving is frozen and the strip coming in written where it lies.
// Round 107 (`pages`, docs/PAGES.md P2.1-P2.2): the places are pages. A page is a window chunk's 16 x 16 columns;
// the page table (`table`, Globals.pages) gives each window chunk its page's slot, and every per-column buffer is
// page-major: column (x, y) at slot * 256 + (y % 16) * 16 + x % 16. A texture is a page atlas, a slot's 16 x 16
// texels at (slot % nx, slot / nx) * 16 (nx: the window's chunks across, so the atlas is the window's size). The
// slots are the ring's places (py * nx + px, the wrap of chunk + offset) through `perm`, a place's slot: identity,
// or with ?pageperm=<seed> shuffled (the identity test: no result may depend on a slot number). Window coordinates
// stay what every caller uses; the shaders index through common.wgsl colIdx / texCol*, the CPU through Pages.
//
//   const p = core.ring                 // (the window's Pages; `ring` for the offset it still slides by)
//   p.i(x, y)                           // window column (x, y)'s index in a per-column buffer (and the CPU's mirrors)
//   p.t(x, y)                           // its texel's index in a texel-a-column texture's image (W wide)
//   p.toWindow(data, per, planes)       // a buffer's readback in window order (y * W + x)
//   p.toStore(data, per, planes)        // window order to a buffer's (for an upload of a whole per-column array)
//   p.texToWindow / p.texToStore        // the same for a texture's image (texels `per` floats; half: a texel a 2 x 2)

/** the per-column buffers (WorldGpu): bytes a column and planes — what a readback of one is put in window order by */
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
/** columns a page */
export const PAGE_COLS = COLS_PAGE * COLS_PAGE;
/** window chunks the page table holds at most (Globals.pages: 512 vec4 of two u16 a u32) */
export const MAX_PAGES = 4096;

/** (P2.2) ?pageperm=<seed>: the places' slots shuffled (the identity test); absent: identity */
export const PAGE_PERM: number | null = (() => {
  const v = typeof location === 'undefined' ? null : new URLSearchParams(location.search).get('pageperm');
  if (v === null) return null;
  const n = Number(v);
  if (!Number.isInteger(n)) throw new Error(`?pageperm=${v}: a whole number (the shuffle's seed)`);
  return n;
})();

type Arr = ArrayLike<number> & { constructor: unknown; subarray(a: number, b: number): Arr; set(a: ArrayLike<number>, o: number): void; length: number };

/**
 * Where a window column's data lies: its chunk, that chunk's page's slot (`table`: the ring's place through `perm`),
 * the column's offset in the page. The ring's offset is whole pages.
 */
export class Pages {
  private ox = 0;
  private oy = 0;
  /** the offset (cells; whole pages): setting it makes the table again */
  get x(): number {
    return this.ox;
  }
  set x(v: number) {
    this.ox = v;
    this.build();
  }
  get y(): number {
    return this.oy;
  }
  set y(v: number) {
    this.oy = v;
    this.build();
  }
  /** chunks across and down */
  readonly nx: number;
  readonly ny: number;
  /** a ring place (py * nx + px) -> its slot: identity, or shuffled (?pageperm=) */
  readonly perm: Uint16Array;
  /** window chunk (cy * nx + cx) -> its page's slot (common.wgsl colSlot) */
  readonly table: Uint16Array;
  /** window chunk -> its slot's place in the atlas, px | py << 8 (the slot py * nx + px): what the GPU's table holds
   *  (Globals.pages, common.wgsl colPlace) — a buffer's index and a texel both without a division */
  readonly entries: Uint16Array;
  /** slot -> the window chunk in it, cx | cy << 8 (Globals.pageInv, common.wgsl colXY) */
  readonly inv: Uint16Array;
  /** bumped whenever the table changes (Simulation uploads it then) */
  version = 0;
  readonly identity: boolean;

  constructor(
    readonly W: number,
    readonly H: number,
    seed: number | null = PAGE_PERM,
  ) {
    this.nx = Math.ceil(W / COLS_PAGE);
    this.ny = Math.ceil(H / COLS_PAGE);
    const n = this.nx * this.ny;
    if (n > MAX_PAGES) throw new Error(`Pages: ${this.nx} x ${this.ny} chunks, the page table holds ${MAX_PAGES}`);
    if (this.nx > 256 || this.ny > 256) throw new Error(`Pages: ${this.nx} x ${this.ny} chunks, an entry holds 256 a side`);
    this.perm = new Uint16Array(n);
    for (let k = 0; k < n; k++) this.perm[k] = k;
    if (seed !== null) {
      // (a seeded Fisher-Yates: the same shuffle for the same seed)
      let h = (seed ^ 0x9e3779b9) >>> 0;
      const rnd = () => {
        h = (Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) >>> 0;
        h = (h ^ (h >>> 12)) >>> 0;
        return h / 4294967296;
      };
      for (let k = n - 1; k > 0; k--) {
        const j = Math.floor(rnd() * (k + 1));
        const t = this.perm[k];
        this.perm[k] = this.perm[j];
        this.perm[j] = t;
      }
    }
    this.identity = this.perm.every((v, k) => v === k);
    this.table = new Uint16Array(n);
    this.entries = new Uint16Array(n);
    this.inv = new Uint16Array(n);
    this.build();
  }

  /** the table made again from the ring's offset: chunk c's place is c + offset, wrapped; its slot that place's */
  private build(): void {
    const { nx, ny } = this;
    const kx = this.ox / COLS_PAGE;
    const ky = this.oy / COLS_PAGE;
    for (let cy = 0; cy < ny; cy++) {
      const py = cy + ky >= ny ? cy + ky - ny : cy + ky;
      for (let cx = 0; cx < nx; cx++) {
        const px = cx + kx >= nx ? cx + kx - nx : cx + kx;
        const s = this.perm[py * nx + px];
        this.table[cy * nx + cx] = s;
        const sy = (s / nx) | 0;
        this.entries[cy * nx + cx] = (s - sy * nx) | (sy << 8);
        this.inv[s] = cx | (cy << 8);
      }
    }
    this.version++;
  }

  /** the offset set (cells, whole pages; any integers, wrapped) */
  set(x: number, y: number): void {
    if (x % COLS_PAGE || y % COLS_PAGE) throw new Error(`the ring's offset (${x}, ${y}) must be whole pages of ${COLS_PAGE} columns`);
    const nx = ((x % this.W) + this.W) % this.W;
    const ny = ((y % this.H) + this.H) % this.H;
    if (nx === this.ox && ny === this.oy) return;
    this.ox = nx;
    this.oy = ny;
    this.build();
  }

  /** the window moved by (dx, dy) columns over the world: where every world cell's data lies stays */
  slide(dx: number, dy: number): void {
    this.set(this.ox + dx, this.oy + dy);
  }

  /** window chunk (cx, cy)'s slot */
  slot(cx: number, cy: number): number {
    return this.table[cy * this.nx + cx];
  }

  /** a slot's first texel in a texel-a-column texture (its place in the atlas, nx pages across) */
  texPage(s: number): [number, number] {
    const sy = (s / this.nx) | 0;
    return [(s - sy * this.nx) * COLS_PAGE, sy * COLS_PAGE];
  }

  /** window column (x, y)'s index in a per-column buffer (x < W, y < H), nothing allocated */
  i(x: number, y: number): number {
    return this.table[(y >> 4) * this.nx + (x >> 4)] * PAGE_COLS + ((y & 15) << 4) + (x & 15);
  }

  /** the same (the older name) */
  idx(x: number, y: number): number {
    return this.i(x, y);
  }

  /** window index i (y * W + x) to its index in a per-column buffer */
  of(i: number): number {
    const W = this.W;
    const y = (i / W) | 0;
    return this.i(i - y * W, y);
  }

  /** a per-column buffer's index back to its window column (common.wgsl colXY) */
  xy(i: number): [number, number] {
    const e = this.inv[i >> 8];
    const l = i & 255;
    return [(e & 0xff) * COLS_PAGE + (l & 15), (e >> 8) * COLS_PAGE + (l >> 4)];
  }

  /** window column (x, y)'s texel (column, row) in a texel-a-column texture */
  texAt(x: number, y: number): [number, number] {
    const [tx, ty] = this.texPage(this.table[(y >> 4) * this.nx + (x >> 4)]);
    return [tx + (x & 15), ty + (y & 15)];
  }

  /** window column (x, y)'s texel's index in a texel-a-column texture's image (W wide): a CPU array a texture mirrors */
  t(x: number, y: number): number {
    const [tx, ty] = this.texAt(x, y);
    return ty * this.W + tx;
  }

  /** a texel a 2 x 2 columns (tw x th of them, a page COLS_PAGE / 2 texels a side): window texel (tx, ty)'s index */
  idxHalf(tx: number, ty: number, tw: number): number {
    const h = COLS_PAGE / 2;
    const s = this.table[((ty / h) | 0) * this.nx + ((tx / h) | 0)];
    const sy = (s / this.nx) | 0;
    return (sy * h + (ty % h)) * tw + (s - sy * this.nx) * h + (tx % h);
  }

  /** the slots of the window's whole-page rectangle at (x0, y0), w x h columns: page row by page row */
  slots(x0: number, y0: number, w: number, h: number): Uint16Array {
    const pw = w / COLS_PAGE;
    const ph = h / COLS_PAGE;
    if (x0 % COLS_PAGE || y0 % COLS_PAGE || pw % 1 || ph % 1) throw new Error(`Pages.slots: (${x0}, ${y0}) ${w} x ${h} isn't whole pages`);
    const out = new Uint16Array(pw * ph);
    for (let j = 0; j < ph; j++) for (let i = 0; i < pw; i++) out[j * pw + i] = this.slot(x0 / COLS_PAGE + i, y0 / COLS_PAGE + j);
    return out;
  }

  /**
   * The whole-page rectangle's slots as runs to copy: one when they're a regular block (each page row consecutive slots,
   * the rows a fixed number of slots apart — any rectangle of the identity's), else one per page row run.
   * A run: its first page in the rectangle's page-major order (k), its first slot, pages in it, rows of that, and the
   * slots between its rows.
   */
  runs(sl: Uint16Array, pw: number): { k: number; slot: number; n: number; rows: number; rowSlots: number }[] {
    const ph = sl.length / pw;
    let regular = true;
    for (let j = 0; j < ph && regular; j++) for (let i = 1; i < pw; i++) if (sl[j * pw + i] !== sl[j * pw] + i) regular = false;
    const d = ph > 1 ? sl[pw] - sl[0] : 0;
    if (regular && ph > 1) for (let j = 1; j < ph; j++) if (sl[j * pw] - sl[(j - 1) * pw] !== d || d < pw) regular = false;
    if (regular) return [{ k: 0, slot: sl[0], n: pw, rows: ph, rowSlots: d }];
    const out: { k: number; slot: number; n: number; rows: number; rowSlots: number }[] = [];
    for (let k = 0; k < sl.length; ) {
      let n = 1;
      while (k + n < sl.length && (k + n) % pw !== 0 && sl[k + n] === sl[k] + n) n++;
      out.push({ k, slot: sl[k], n, rows: 1, rowSlots: 0 });
      k += n;
    }
    return out;
  }

  /**
   * The same rectangle in a texture atlas: one rectangle when its pages are a rectangle there (the identity's), else
   * a page each. Each: its texel place (pages: x, y) in the atlas and its window corner (columns) and size (pages).
   */
  texRects(x0: number, y0: number, w: number, h: number): { wx: number; wy: number; px: number; py: number; pw: number; ph: number }[] {
    const sl = this.slots(x0, y0, w, h);
    const pw = w / COLS_PAGE;
    const ph = h / COLS_PAGE;
    const [ax, ay] = this.texPage(sl[0]);
    let rect = ax / COLS_PAGE + pw <= this.nx;
    for (let j = 0; j < ph && rect; j++) for (let i = 0; i < pw; i++) if (sl[j * pw + i] !== sl[0] + j * this.nx + i) rect = false;
    if (rect) return [{ wx: x0, wy: y0, px: ax / COLS_PAGE, py: ay / COLS_PAGE, pw, ph }];
    const out = [];
    for (let j = 0; j < ph; j++)
      for (let i = 0; i < pw; i++) {
        const [tx, ty] = this.texPage(sl[j * pw + i]);
        out.push({ wx: x0 + i * COLS_PAGE, wy: y0 + j * COLS_PAGE, px: tx / COLS_PAGE, py: ty / COLS_PAGE, pw: 1, ph: 1 });
      }
    return out;
  }

  /**
   * A window rectangle [x0, x1) x [y0, y1) in a texture atlas: the pieces it's cut into (each its window corner, its
   * place and size), a page each where pages aren't next to each other there, merged along rows where they are.
   * `half`: in a texel-a-2 x 2 grid (the wind field's: a page 8 x 8 texels; the rectangle in its texels).
   */
  pieces(x0: number, y0: number, x1: number, y1: number, half = false): { x: number; y: number; px: number; py: number; w: number; h: number }[] {
    const P = half ? COLS_PAGE / 2 : COLS_PAGE;
    const out: { x: number; y: number; px: number; py: number; w: number; h: number }[] = [];
    for (let cy = Math.floor(y0 / P); cy * P < y1; cy++) {
      const ya = Math.max(y0, cy * P);
      const yb = Math.min(y1, (cy + 1) * P);
      let run: { x: number; y: number; px: number; py: number; w: number; h: number } | null = null;
      for (let cx = Math.floor(x0 / P); cx * P < x1; cx++) {
        const xa = Math.max(x0, cx * P);
        const xb = Math.min(x1, (cx + 1) * P);
        const [tx, ty] = this.texPage(this.slot(cx, cy));
        const px = (tx / COLS_PAGE) * P + (xa - cx * P);
        const py = (ty / COLS_PAGE) * P + (ya - cy * P);
        if (run && run.px + run.w === px && run.py === py) run.w += xb - xa;
        else {
          if (run) out.push(run);
          run = { x: xa, y: ya, px, py, w: xb - xa, h: yb - ya };
        }
      }
      if (run) out.push(run);
    }
    return out;
  }

  /** a texture atlas is in window order (no offset, the identity's slots): a buffer never is (page-major) */
  get texZero(): boolean {
    return this.ox === 0 && this.oy === 0 && this.identity;
  }

  /** a per-column buffer's array (`per` values a column, `planes` planes of W x H) in window order */
  toWindow<T extends Arr>(a: T, per = 1, planes = 1): T {
    return this.move(a, per, planes, false, false);
  }

  /** window order to a per-column buffer's */
  toStore<T extends Arr>(a: T, per = 1, planes = 1): T {
    return this.move(a, per, planes, true, false);
  }

  /** a texel-a-column texture's image (`per` values a texel; `half`: a texel a 2 x 2, the image W / 2 wide) in window order */
  texToWindow<T extends Arr>(a: T, per = 4, half = false): T {
    return this.move(a, per, 1, false, true, half);
  }

  /** window order to a texture atlas's image */
  texToStore<T extends Arr>(a: T, per = 4, half = false): T {
    return this.move(a, per, 1, true, true, half);
  }

  /** a copy with every page's 16-column rows moved between window order and the store's (buffer or atlas) */
  private move<T extends Arr>(a: T, per: number, planes: number, toStore: boolean, tex: boolean, half = false): T {
    const P = half ? COLS_PAGE / 2 : COLS_PAGE;
    const W = half ? this.W / 2 : this.W;
    const H = half ? this.H / 2 : this.H;
    const out = new (a.constructor as { new (n: number): T })(a.length);
    const plane = W * H * per;
    const row = P * per;
    for (let q = 0; q < planes; q++) {
      const base = q * plane;
      for (let cy = 0; cy * P < H; cy++)
        for (let cx = 0; cx * P < W; cx++) {
          const s = this.table[cy * this.nx + cx];
          const sy = (s / this.nx) | 0;
          for (let r = 0; r < P; r++) {
            // (the page's row r: in window order at (cx * P, cy * P + r); in the store page-major, or in the atlas)
            const w = base + ((cy * P + r) * W + cx * P) * per;
            const st = tex ? base + ((sy * P + r) * W + (s - sy * this.nx) * P) * per : base + (s * P * P + r * P) * per;
            if (toStore) out.set(a.subarray(w, w + row), st);
            else out.set(a.subarray(st, st + row), w);
          }
        }
    }
    // (anything past the planes: as it was)
    if (a.length > planes * plane) out.set(a.subarray(planes * plane, a.length), planes * plane);
    return out;
  }
}

/**
 * A region's per-column bytes between row-major (R rows of R columns, `stride` bytes a column, `planes` planes) and
 * the record's page-major (its pages row-major, each 256 columns row-major) — world/region-record.ts's layout.
 */
export function regionRowsToPages(src: Uint8Array, R: number, stride: number, planes: number, toPages: boolean): Uint8Array {
  const out = new Uint8Array(src.length);
  const rc = R / COLS_PAGE;
  const plane = R * R * stride;
  const run = COLS_PAGE * stride;
  for (let q = 0; q < planes; q++)
    for (let j = 0; j < rc; j++)
      for (let i = 0; i < rc; i++)
        for (let r = 0; r < COLS_PAGE; r++) {
          const rm = q * plane + ((j * COLS_PAGE + r) * R + i * COLS_PAGE) * stride;
          const pm = q * plane + ((j * rc + i) * PAGE_COLS + r * COLS_PAGE) * stride;
          if (toPages) out.set(src.subarray(rm, rm + run), pm);
          else out.set(src.subarray(pm, pm + run), rm);
        }
  if (src.length > planes * plane) out.set(src.subarray(planes * plane), planes * plane);
  return out;
}
