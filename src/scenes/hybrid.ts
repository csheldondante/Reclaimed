// The hybrid renderer's choice (?hybrid=1, the atlas level): which of the window's mesh chunks are voxels — the
// field mesh built and drawn, the sim's — and which are left to the heightfield (the LOD rings, far.wgsl, drawn
// from the atlas's own ground). The ceiling experiment (round 83) showed the heightfield alone at a third of the
// game's GPU; most of the land is a heightfield anyway. A chunk needs voxels when:
//   - its land isn't a heightfield of the ground (Streamer.relief: a gap between runs — a cave or its mouth, a
//     mesa's overhang, a bridge, a tunnel — or a form standing on the ground or cut into it), decided as the land
//     comes in (and as an event in sight changes it);
//   - it is near the focus (the camera's target: a radius);
//   - it has been edited (a world event — a power, an edit, lightning — touched it: kept while it's in the window).
// Everything else is the heightfield's. The window's layers stay the truth for every column (physics, queries,
// the sim where it's awake); the heightfield chunks are a render of the generator's ground.

import { ROW_H } from '../world/lattice';

export interface HybridStats {
  /** chunks in the grid, chunks voxels now: for their land, edited, near the focus (a chunk may be several) */
  chunks: number;
  voxel: number;
  land: number;
  edited: number;
  near: number;
}

export class HybridChunks {
  private land: Uint8Array;
  private edited: Uint8Array;
  private want: Uint8Array;
  private changed = true;
  stats: HybridStats = { chunks: 0, voxel: 0, land: 0, edited: 0, near: 0 };
  /** over the frames since reset: voxel chunks wanted and mesh chunks drawn, summed (the profile's means) */
  totals = { frames: 0, voxel: 0, drawn: 0 };

  constructor(
    /** mesh chunks across, down, and a chunk's width (world units; CHUNK rows down) */
    private nx: number,
    private ny: number,
    private side: number,
    /** the window's columns across and down, and the streamer's relief per column (Streamer.relief, gapTop, colTop) */
    private W: number,
    private H: number,
    private col: { relief: Uint8Array; gapTop: Float32Array; colTop: Float32Array },
    /** world units round the focus within which every chunk is voxels */
    readonly radius = 40,
  ) {
    const n = nx * ny;
    this.land = new Uint8Array(n);
    this.edited = new Uint8Array(n);
    this.want = new Uint8Array(n);
    this.stats.chunks = n;
    this.landBox(0, 0, W, H);
  }

  /** the chunks touched by world rect (x0, y0)–(x1, y1) (window units), clamped to the grid */
  private chunksOf(x0: number, y0: number, x1: number, y1: number, f: (c: number) => void): void {
    const cw = this.side;
    const ch = this.side * ROW_H;
    const i0 = Math.max(0, Math.floor(x0 / cw));
    const i1 = Math.min(this.nx - 1, Math.floor(x1 / cw));
    const j0 = Math.max(0, Math.floor(y0 / ch));
    const j1 = Math.min(this.ny - 1, Math.floor(y1 / ch));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) f(j * this.nx + i);
  }

  /**
   * The relief of columns (x0, y0)–(x1, y1) (window cells, exclusive) is new: the land flag of every chunk they
   * touch made again from all its columns (a column's relief reaches 2 cells round it: the mesh's fields do).
   */
  landBox(x0: number, y0: number, x1: number, y1: number): void {
    const touched = new Set<number>();
    this.chunksOf(x0 - 3, (y0 - 3) * ROW_H, x1 + 3, (y1 + 3) * ROW_H, (c) => touched.add(c));
    for (const c of touched) this.land[c] = 0;
    const cw = this.side;
    const ch = this.side * ROW_H;
    for (const c of touched) {
      const cx = c % this.nx;
      const cy = Math.floor(c / this.nx);
      // (the columns within 2 cells of the chunk)
      const ys = Math.max(0, Math.floor((cy * ch - 2) / ROW_H));
      const ye = Math.min(this.H - 1, Math.ceil(((cy + 1) * ch + 2) / ROW_H));
      const xs = Math.max(0, Math.floor(cx * cw - 3));
      const xe = Math.min(this.W - 1, Math.ceil((cx + 1) * cw + 2));
      let hit = 0;
      for (let y = ys; y <= ye && !hit; y++)
        for (let x = xs; x <= xe; x++) {
          if (!this.columnNeeds(x, y)) continue;
          const wx = x + 0.5 + 0.5 * (y & 1);
          const wy = (y + 0.5) * ROW_H;
          if (wx >= cx * cw - 2 && wx <= (cx + 1) * cw + 2 && wy >= cy * ch - 2 && wy <= (cy + 1) * ch + 2) {
            hit = 1;
            break;
          }
        }
      this.land[c] = hit;
    }
    this.changed = true;
  }

  /**
   * Column (x, y) isn't a heightfield: something stands on it or is cut into it, or a gap in it is open to the air
   * — a neighbour's top under its roof (an overhang's lip, a cave's mouth, a bridge, a tunnel's portal). A cave
   * whose every neighbour stands over its roof is buried: nobody sees it from the sky.
   */
  private columnNeeds(x: number, y: number): boolean {
    const i = y * this.W + x;
    if (this.col.relief[i]) return true;
    const g = this.col.gapTop[i];
    if (g === -Infinity) return false;
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if ((dx || dy) && nx >= 0 && ny >= 0 && nx < this.W && ny < this.H && this.col.colTop[ny * this.W + nx] < g - 0.25) return true;
      }
    return false;
  }

  /** the window slid by (dcx, dcy) chunks: what's kept per chunk goes with the land (the new land: none yet) */
  shift(dcx: number, dcy: number): void {
    for (const a of [this.land, this.edited]) {
      const old = a.slice();
      for (let cy = 0; cy < this.ny; cy++)
        for (let cx = 0; cx < this.nx; cx++) {
          const sx = cx + dcx;
          const sy = cy + dcy;
          a[cy * this.nx + cx] = sx < 0 || sy < 0 || sx >= this.nx || sy >= this.ny ? 0 : old[sy * this.nx + sx];
        }
    }
    this.changed = true;
  }

  /** the window was moved somewhere else: nothing edited there yet (the land comes in through landBox) */
  clear(): void {
    this.edited.fill(0);
    this.land.fill(0);
    this.changed = true;
  }

  /** a world event at (x, y) with radius r (window units): the chunks it touches are voxels from now on */
  edit(x: number, y: number, r: number): void {
    this.chunksOf(x - r - 2, y - r - 2, x + r + 2, y + r + 2, (c) => {
      if (!this.edited[c]) this.changed = true;
      this.edited[c] = 1;
    });
  }

  private focusAt: [number, number] | null = null;
  /** the want given out at least once (the mesh starts with every chunk wanted) */
  private sent = false;

  /**
   * This frame's choice, the focus (window units; null: none). Returns the per-chunk want (1: voxels) when it
   * changed since the last call, else null.
   */
  update(focus: [number, number] | null): Uint8Array | null {
    const f = this.focusAt;
    // (the focus's circle redone when it's moved a quarter of a chunk)
    const moved = (focus === null) !== (f === null) || (focus && f && Math.hypot(focus[0] - f[0], focus[1] - f[1]) > this.side / 4);
    if (!moved && !this.changed) return null;
    if (moved) this.focusAt = focus ? [focus[0], focus[1]] : null;
    this.changed = false;
    const cw = this.side;
    const ch = this.side * ROW_H;
    const s: HybridStats = { chunks: this.nx * this.ny, voxel: 0, land: 0, edited: 0, near: 0 };
    let diff = false;
    for (let cy = 0; cy < this.ny; cy++)
      for (let cx = 0; cx < this.nx; cx++) {
        const c = cy * this.nx + cx;
        let near = 0;
        const p = this.focusAt;
        if (p) {
          const dx = Math.max(cx * cw - p[0], 0, p[0] - (cx + 1) * cw);
          const dy = Math.max(cy * ch - p[1], 0, p[1] - (cy + 1) * ch);
          near = Math.hypot(dx, dy) <= this.radius ? 1 : 0;
        }
        const w = this.land[c] || this.edited[c] || near ? 1 : 0;
        s.land += this.land[c];
        s.edited += this.edited[c];
        s.near += near;
        s.voxel += w;
        if (w !== this.want[c]) diff = true;
        this.want[c] = w;
      }
    this.stats = s;
    if (!diff && this.sent) return null;
    this.sent = true;
    return this.want;
  }

  /** (hybrid, Globals.hfield) a bit a chunk, set: the heightfield's (not wanted) — 64 words, the sim's mask's size */
  readonly hfBits = new Uint32Array(64);

  /** the want as Globals' hfield bits (after update gave a new want) */
  bits(): Uint32Array {
    this.hfBits.fill(0);
    for (let c = 0; c < this.want.length && c < 2048; c++) if (!this.want[c]) this.hfBits[c >> 5] |= 1 << (c & 31);
    return this.hfBits;
  }

  /** each frame for the profile: the chunks wanted, the mesh chunks drawn */
  count(drawn: number): void {
    this.totals.frames++;
    this.totals.voxel += this.stats.voxel;
    this.totals.drawn += drawn;
  }
}
