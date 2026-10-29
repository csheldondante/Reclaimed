// The hybrid renderer's choice (?hybrid=1, the atlas level): which of the window's mesh chunks are voxels — the
// field mesh built and drawn, the sim's — and which are left to the heightfield. The ceiling experiment (round 83)
// showed the heightfield alone at a third of the game's GPU; most of the land is a heightfield anyway. A chunk
// needs voxels when:
//   - its land isn't a heightfield of the ground (Streamer.relief: a gap between runs — a cave or its mouth, a
//     mesa's overhang, a bridge, a tunnel — or, before round 100 (?formvox=1), a form standing on the ground or
//     cut into it), decided as the land comes in (and as an event in sight changes it);
//   - (round 100) a column in it is steep: a neighbour's top more than `?steep=` (12) cells off its own (a cliff,
//     a mesa's face, a gorge's wall — the grid would stretch a triangle down it);
//   - (before round 100; ?vradius=40) it is near the focus (the camera's target: a radius). Round 100, the user:
//     "Why do we do remeshing everytime if it's expensive? Can we limit it to cliffs or something?" — by default
//     a chunk is voxels for what it holds, not for where the camera is;
//   - it has been edited (an edit or a chip — what can cut the ground into shapes a heightfield can't hold —
//     touched it: kept while it's in the window).
// Everything else is a heightfield chunk, of one of two kinds (round 86):
//   - the grid's (most of them): its land is all within the window's z, so the renderer draws it as a lattice
//     through the window's own columns' tops with the mesh's look (meshdraw.wgsl vsGrid) — its water, plants,
//     wetness and stains are the window's, and the sim may wake there (a storm raining on it within
//     `stormReach` of the focus, an event on it), so a storm looks the same on it as on the voxels;
//   - the rings' (far.wgsl): land past the window's floor or ceiling (the band's), or just come in (its columns'
//     derived fields not made yet): drawn from the atlas's ground, nothing of the window's there.
// The window's layers stay the truth for every column (physics, queries, the sim where it's awake).

import { ROW_H } from '../world/lattice';
import { EventKind } from '../sim/globals';

export interface HybridStats {
  /** chunks in the grid, chunks voxels now: for their land, edited, near the focus (a chunk may be several);
   *  heightfield chunks the grid draws, the rings draw; heightfield chunks whose sim may wake */
  chunks: number;
  voxel: number;
  land: number;
  /** (round 100) of the land's: chunks voxels for a steep column only */
  steep: number;
  edited: number;
  near: number;
  grid: number;
  ring: number;
  simmed: number;
}

/**
 * Sim ticks after land comes into a chunk before the grid draws it: its surface, drift and strata are the surface
 * pass's (every tick, every column), its look's fields renderfields' (every other tick). Round 100: ticks, not a
 * time — before, a fixed 0.4 s (24 ticks at 60 Hz) with the rings drawing the land just come in meanwhile
 * (streamspeed round 98: most of what was left in low detail at speed). ?readyticks= to try others.
 */
const READY_TICKS = Number((typeof location === 'undefined' ? null : new URLSearchParams(location.search).get('readyticks')) ?? 3);
/** (round 100, ?steep=) cells a column's top may lie off a neighbour's before its chunk needs voxels */
const STEEP = Number((typeof location === 'undefined' ? null : new URLSearchParams(location.search).get('steep')) ?? 12);
/**
 * (round 100, ?formvox=1 as before) Whether a form standing on the ground or cut into it (Streamer.relief: the top off
 * the ground's own by over 0.75 — a road's cut, a town's plinth, a mesa, a spire) makes its chunk voxels by itself.
 * Off: a form is a heightfield like any ground unless it's steep or open underneath (an overhang, an arch, a room) —
 * speedsweep's pans had 45–65% of the window's chunks voxels with it; without it a town's view 25 → 9, a coast's
 * 23 → 2, a mesa's 74 → 38 (DEVLOG round 100), the shots alike.
 */
const FORM_VOX = typeof location !== 'undefined' && new URLSearchParams(location.search).get('formvox') === '1';

export class HybridChunks {
  private land: Uint8Array;
  /** (round 100) per chunk: voxels for a steep column only (land is set too) */
  private steepOnly: Uint8Array;
  private edited: Uint8Array;
  /** an event touched it (any kind): its sim may wake wherever it is */
  private touched: Uint8Array;
  private want: Uint8Array;
  /** (round 86) the grid draws it (see the top) */
  readonly grid: Uint8Array;
  /** per chunk: the lowest and highest of its columns' tops (window z), and whether one is out of the window's z */
  readonly lo: Float32Array;
  readonly hi: Float32Array;
  private outZ: Uint8Array;
  /** per chunk: the sim tick from which the grid may draw it — land come in waits READY_TICKS; Infinity: not come in */
  private readyAt: Float64Array;
  private nextReady = Infinity;
  private changed = true;
  stats: HybridStats = { chunks: 0, voxel: 0, land: 0, steep: 0, edited: 0, near: 0, grid: 0, ring: 0, simmed: 0 };
  /** over the frames since reset: voxel chunks wanted and mesh chunks drawn, summed (the profile's means) */
  totals = { frames: 0, voxel: 0, drawn: 0, grid: 0 };

  constructor(
    /** mesh chunks across, down, and a chunk's width (world units; CHUNK rows down) */
    private nx: number,
    private ny: number,
    private side: number,
    /** the window's columns across and down, and the streamer's relief per column (Streamer.relief, gapTop, colTop) */
    private W: number,
    private H: number,
    /** (round 106, frameprobe) the streamer's per-column relief, on the ring: column (x, y) at colIdx(x, y) */
    private col: { relief: Uint8Array; gapTop: Float32Array; colTop: Float32Array; colIdx(x: number, y: number): number },
    /** world units round the focus within which every chunk is voxels (round 100: 0, none — ?vradius=40 as before) */
    readonly radius = 0,
    /** the window's oz (world z of its floor) now, and its height */
    private z: () => { oz: number; zMax: number } = () => ({ oz: 0, zMax: 1e9 }),
    /** (round 86) world units round the focus within which a heightfield chunk's sim may wake (a storm on it) */
    readonly stormReach = 110,
    /** (round 100) the sim's tick now (READY_TICKS counts them) */
    private tick: () => number = () => 0,
  ) {
    const n = nx * ny;
    this.land = new Uint8Array(n);
    this.steepOnly = new Uint8Array(n);
    this.edited = new Uint8Array(n);
    this.touched = new Uint8Array(n);
    this.want = new Uint8Array(n);
    this.grid = new Uint8Array(n);
    this.lo = new Float32Array(n);
    this.hi = new Float32Array(n);
    this.outZ = new Uint8Array(n);
    this.readyAt = new Float64Array(n).fill(Infinity);
    this.stats.chunks = n;
    this.landBox(0, 0, W, H, -Infinity);
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
   * touch made again from all its columns (a column's relief reaches 2 cells round it: the mesh's fields do), and
   * its tops' span; the grid draws it from sim tick `now` + READY_TICKS (−Infinity: at once — the first window, made
   * before).
   */
  landBox(x0: number, y0: number, x1: number, y1: number, now = this.tick()): void {
    const touched = new Set<number>();
    this.chunksOf(x0 - 3, (y0 - 3) * ROW_H, x1 + 3, (y1 + 3) * ROW_H, (c) => touched.add(c));
    for (const c of touched) this.land[c] = 0;
    const cw = this.side;
    const ch = this.side * ROW_H;
    const { oz, zMax } = this.z();
    for (const c of touched) {
      const cx = c % this.nx;
      const cy = Math.floor(c / this.nx);
      // (the columns within 2 cells of the chunk)
      const ys = Math.max(0, Math.floor((cy * ch - 2) / ROW_H));
      const ye = Math.min(this.H - 1, Math.ceil(((cy + 1) * ch + 2) / ROW_H));
      const xs = Math.max(0, Math.floor(cx * cw - 3));
      const xe = Math.min(this.W - 1, Math.ceil((cx + 1) * cw + 2));
      // (1: for what stands on it or a gap open to the air; 2: for a steep column only — still looking for a 1)
      let hit = 0;
      for (let y = ys; y <= ye && hit !== 1; y++)
        for (let x = xs; x <= xe; x++) {
          const need = this.columnNeeds(x, y);
          if (!need || (need === 2 && hit)) continue;
          const wx = x + 0.5 + 0.5 * (y & 1);
          const wy = (y + 0.5) * ROW_H;
          if (wx >= cx * cw - 2 && wx <= (cx + 1) * cw + 2 && wy >= cy * ch - 2 && wy <= (cy + 1) * ch + 2) {
            hit = need;
            if (hit === 1) break;
          }
        }
      this.land[c] = hit ? 1 : 0;
      this.steepOnly[c] = hit === 2 ? 1 : 0;
      // (its own columns' tops, and its lattice's cell past each edge: meshdraw.wgsl vsGrid)
      let lo = Infinity;
      let hi = -Infinity;
      for (let y = Math.max(0, cy * this.side - 1); y <= Math.min(this.H - 1, (cy + 1) * this.side); y++)
        for (let x = Math.max(0, cx * this.side - 1); x <= Math.min(this.W - 1, (cx + 1) * this.side); x++) {
          const t = this.col.colTop[this.col.colIdx(x, y)] - oz;
          lo = Math.min(lo, t);
          hi = Math.max(hi, t);
        }
      this.lo[c] = lo;
      this.hi[c] = hi;
      this.outZ[c] = lo < 0.5 || hi > zMax - 1 ? 1 : 0;
      this.readyAt[c] = now + READY_TICKS;
      this.nextReady = Math.min(this.nextReady, this.readyAt[c]);
    }
    this.changed = true;
  }

  /**
   * Column (x, y) isn't a heightfield: something stands on it or is cut into it, or a gap in it is open to the air
   * — a neighbour's top under its roof (an overhang's lip, a cave's mouth, a bridge, a tunnel's portal). A cave
   * whose every neighbour stands over its roof is buried: nobody sees it from the sky. Returns 1 then; (round 100) 2
   * where it's only steep — a neighbour's top more than STEEP cells off its own (a cliff); 0 a heightfield's.
   */
  private columnNeeds(x: number, y: number): 0 | 1 | 2 {
    const i = this.col.colIdx(x, y);
    if (FORM_VOX && this.col.relief[i]) return 1;
    const g = this.col.gapTop[i];
    const t = this.col.colTop[i];
    let steep = false;
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if (!(dx || dy) || nx < 0 || ny < 0 || nx >= this.W || ny >= this.H) continue;
        const n = this.col.colTop[this.col.colIdx(nx, ny)];
        if (g !== -Infinity && n < g - 0.25) return 1;
        if (Math.abs(n - t) > STEEP) steep = true;
      }
    return steep ? 2 : 0;
  }

  /** the window slid by (dcx, dcy) chunks: what's kept per chunk goes with the land (the new land: none yet) */
  shift(dcx: number, dcy: number): void {
    const move = <T extends Uint8Array | Float32Array | Float64Array>(a: T, fresh: number) => {
      const old = a.slice();
      for (let cy = 0; cy < this.ny; cy++)
        for (let cx = 0; cx < this.nx; cx++) {
          const sx = cx + dcx;
          const sy = cy + dcy;
          a[cy * this.nx + cx] = sx < 0 || sy < 0 || sx >= this.nx || sy >= this.ny ? fresh : old[sy * this.nx + sx];
        }
    };
    for (const a of [this.land, this.steepOnly, this.edited, this.touched, this.outZ]) move(a, 0);
    move(this.lo, 0);
    move(this.hi, 0);
    move(this.readyAt, Infinity);
    this.changed = true;
  }

  /**
   * The window was moved somewhere else: nothing edited there yet. (Round 112, `tilefix2`: only what's the place's own
   * history — edited, touched. The land's flags and readiness are landBox's, and a warp writes its regions — each
   * calling landBox — before it tells its onWarp: clearing them here after wiped what the writes had just set, every
   * chunk neither the grid's nor voxels, never ready — the window drawing nothing at all after a warp: the user's run
   * on the phone, grey round the hero, and after a save's regions were restored on load.)
   */
  clear(): void {
    this.edited.fill(0);
    this.touched.fill(0);
    this.changed = true;
  }

  /** the window was cut again in z (its oz moved): every chunk's tops against the window's z again */
  zMoved(): void {
    this.landBox(0, 0, this.W, this.H);
  }

  /**
   * A world event at (x, y) with radius r (window units): the chunks it touches may wake (kept while they're in
   * the window); an edit or a chip — what can cut the ground into shapes a heightfield can't hold — makes them
   * voxels from now on (round 86: not lightning, a fire set, a tap or a gust: the grid shows what they do).
   */
  edit(x: number, y: number, r: number, kind: EventKind = EventKind.Edit): void {
    const shapes = kind === EventKind.Edit || kind === EventKind.Chip;
    this.chunksOf(x - r - 2, y - r - 2, x + r + 2, y + r + 2, (c) => {
      if (!this.touched[c] || (shapes && !this.edited[c])) this.changed = true;
      this.touched[c] = 1;
      if (shapes) this.edited[c] = 1;
    });
  }

  private focusAt: [number, number] | null = null;
  /** the want given out at least once (the mesh starts with every chunk wanted) */
  private sent = false;
  /** (round 86) per chunk: its heightfield sim may wake — within stormReach of the focus, or touched */
  private simmed: Uint8Array | null = null;

  /**
   * This frame's choice, the focus (window units; null: none). Returns whether it changed since the last call (then
   * `wanted` — 1: voxels — `grid`, `bits`, `gridBits` and `sleepFilter` are new).
   */
  update(focus: [number, number] | null, now = this.tick()): boolean {
    const f = this.focusAt;
    // (the focus's circle redone when it's moved a quarter of a chunk)
    const moved = (focus === null) !== (f === null) || (focus && f && Math.hypot(focus[0] - f[0], focus[1] - f[1]) > this.side / 4);
    if (now >= this.nextReady) this.changed = true;
    if (!moved && !this.changed && this.sent) return false;
    if (moved) this.focusAt = focus ? [focus[0], focus[1]] : null;
    this.changed = false;
    const cw = this.side;
    const ch = this.side * ROW_H;
    const s: HybridStats = { chunks: this.nx * this.ny, voxel: 0, land: 0, steep: 0, edited: 0, near: 0, grid: 0, ring: 0, simmed: 0 };
    const simmed = new Uint8Array(this.nx * this.ny);
    this.nextReady = Infinity;
    for (let cy = 0; cy < this.ny; cy++)
      for (let cx = 0; cx < this.nx; cx++) {
        const c = cy * this.nx + cx;
        let near = 0;
        let reach = 0;
        const p = this.focusAt;
        if (p) {
          const dx = Math.max(cx * cw - p[0], 0, p[0] - (cx + 1) * cw);
          const dy = Math.max(cy * ch - p[1], 0, p[1] - (cy + 1) * ch);
          near = this.radius > 0 && Math.hypot(dx, dy) <= this.radius ? 1 : 0;
          reach = Math.hypot(dx, dy) <= this.stormReach ? 1 : 0;
        }
        const w = this.land[c] || this.edited[c] || near ? 1 : 0;
        const ready = now >= this.readyAt[c];
        if (!ready && this.readyAt[c] < this.nextReady) this.nextReady = this.readyAt[c];
        const g = !w && ready && !this.outZ[c] ? 1 : 0;
        s.land += this.land[c];
        s.steep += this.steepOnly[c];
        s.edited += this.edited[c];
        s.near += near;
        s.voxel += w;
        s.grid += g;
        s.ring += w || g ? 0 : 1;
        this.want[c] = w;
        this.grid[c] = g;
        simmed[c] = w || (g && (reach || this.touched[c])) ? 1 : 0;
        s.simmed += g ? simmed[c] : 0;
      }
    this.simmed = simmed;
    this.stats = s;
    this.sent = true;
    return true;
  }

  /** per chunk 1: voxels (the field mesh's) */
  get wanted(): Uint8Array {
    return this.want;
  }

  /** (hybrid, Globals.hfield) a bit a chunk, set: the rings' (renderprep and vegprep skip it) — 64 words, the sim's mask's size */
  readonly hfBits = new Uint32Array(64);
  /** (round 86, far.wgsl LodD.grid) a bit a chunk, set: the grid's */
  readonly gBits = new Uint32Array(64);

  /** the rings' chunks as Globals' hfield bits (after update said it changed) */
  bits(): Uint32Array {
    this.hfBits.fill(0);
    for (let c = 0; c < this.want.length && c < 2048; c++) if (!this.want[c] && !this.grid[c]) this.hfBits[c >> 5] |= 1 << (c & 31);
    return this.hfBits;
  }

  /** the grid's chunks as bits (far.wgsl: the rings leave them to it) */
  gridBits(): Uint32Array {
    this.gBits.fill(0);
    for (let c = 0; c < this.grid.length && c < 2048; c++) if (this.grid[c]) this.gBits[c >> 5] |= 1 << (c & 31);
    return this.gBits;
  }

  /**
   * (Sleep.only) Per sim chunk (`side` columns across and rows down, cx × cy of them): 1 where its mesh chunk is
   * voxels, or (round 86) the grid's within the storms' reach of the focus or touched by an event — the sim may
   * wake only there (and does by Sleep's own rules: a storm raining, an event).
   */
  sleepFilter(cx: number, cy: number, side = 16): Uint8Array {
    const f = new Uint8Array(cx * cy);
    const m = this.simmed ?? this.want;
    for (let j = 0; j < cy; j++)
      for (let i = 0; i < cx; i++) {
        const mx = Math.min(this.nx - 1, Math.floor((i * side + side / 2) / this.side));
        const my = Math.min(this.ny - 1, Math.floor((j * side + side / 2) / this.side));
        f[j * cx + i] = m[my * this.nx + mx];
      }
    return f;
  }

  /** each frame for the profile: the chunks wanted, the mesh chunks drawn */
  count(drawn: number): void {
    this.totals.frames++;
    this.totals.voxel += this.stats.voxel;
    this.totals.drawn += drawn;
    this.totals.grid += this.stats.grid;
  }
}
