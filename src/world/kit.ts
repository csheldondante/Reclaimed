// The level kit (docs/LEVELS.md): a level is a short script against this
// builder instead of hundreds of lines of mapgen. Three phases, in order:
//   1. shape the land: `land()` sets the height field, `sculpt()` /
//      `river()` / `pond()` carve and raise it;
//   2. `ground()` turns it into columns (stone, soil, a loose top);
//   3. features stamp onto the columns and the fields (dust, litter, trash,
//      poison, oil, walls, tanks, models, green, seed caches), and `gate()`
//      names the obstacles the level is built around.
// `build()` returns the MapData plus the gates (for the map preview and the
// gate validator, scripts/mapview.mjs and scripts/gates.mjs).
//
// Shapes are signed-distance functions: negative inside, in cells.

import { ColumnGrid, type WorldDims } from './layout';
import { MAT } from './materials';
import { buildRuin, buildTank, type MapData } from './mapgen';
import { modelById, stampGrid } from './models';
import { fbm, hash2, rng, smoothstep } from './noise';

export type P = [number, number];
/** < 0 inside, > 0 outside (cells) */
export type Sdf = (x: number, y: number) => number;

export const disc = (c: P, r: number): Sdf => (x, y) => Math.hypot(x - c[0], y - c[1]) - r;
export const ring = (c: P, r0: number, r1: number): Sdf => (x, y) => {
  const d = Math.hypot(x - c[0], y - c[1]);
  return Math.max(r0 - d, d - r1);
};
export const rect = (x0: number, y0: number, x1: number, y1: number): Sdf => (x, y) => {
  const dx = Math.max(x0 - x, x - x1);
  const dy = Math.max(y0 - y, y - y1);
  return dx > 0 && dy > 0 ? Math.hypot(dx, dy) : Math.max(dx, dy);
};
/** a band `halfW` wide either side of a polyline */
export const band = (pts: P[], halfW: number): Sdf => (x, y) => distToPath(pts, x, y).d - halfW;
export const union = (...s: Sdf[]): Sdf => (x, y) => Math.min(...s.map((f) => f(x, y)));
export const subtract = (a: Sdf, b: Sdf): Sdf => (x, y) => Math.max(a(x, y), -b(x, y));
export const intersect = (a: Sdf, b: Sdf): Sdf => (x, y) => Math.max(a(x, y), b(x, y));
/** a ragged edge: the boundary pushed in and out by noise (`amp` cells, features `scale` cells) */
export const wobble = (s: Sdf, amp = 2, scale = 6, seed = 1): Sdf => (x, y) => s(x, y) + fbm(x / scale, y / scale, 2, seed) * amp;

/** nearest point on a polyline: distance, and how far along it (cells) */
export function distToPath(pts: P[], x: number, y: number): { d: number; t: number } {
  let best = Infinity;
  let bt = 0;
  let run = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, ay] = pts[i];
    const [bx, by] = pts[i + 1];
    const dx = bx - ax;
    const dy = by - ay;
    const L = Math.hypot(dx, dy) || 1;
    const u = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (L * L)));
    const d = Math.hypot(x - ax - dx * u, y - ay - dy * u);
    if (d < best) {
      best = d;
      bt = run + u * L;
    }
    run += L;
  }
  return { d: best, t: bt };
}

/** What a gate is made of — what the validator measures as "still closed". */
export type GateKind = 'dust' | 'litter' | 'trash' | 'poison' | 'oil' | 'wall' | 'dry';
/** The abilities and features a level can lean on (validator scenarios). */
export type Ability = 'wind' | 'gale' | 'cyclone' | 'rain' | 'lightning' | 'flood' | 'chip';

export interface GateSpec {
  id: string;
  name: string;
  kind: GateKind;
  /** the columns the gate covers (y·w + x) */
  cells: number[];
  /** where its label goes, and where the validator aims */
  at: P;
  /** what it's meant to teach (documentation; the validator reports what actually opens it) */
  teaches: Ability[];
  /** for walls: the ground height beside it (cleared when its top is down to this + 1) */
  base?: number;
  /** a lesson, not a gate: the weather may clear it (the validator doesn't flag it leaking) */
  soft?: boolean;
}

export interface KitMap extends MapData {
  gates: GateSpec[];
}

export class Kit {
  readonly w: number;
  readonly h: number;
  readonly N: number;
  readonly r: () => number;
  /** phase 1: the land's height (cells, fractional) */
  readonly height: Float32Array;
  /** phase 1: soil depth over the stone (cells); 0 = bare rock */
  readonly soil: Float32Array;
  grid!: ColumnGrid;
  readonly water: Float32Array;
  readonly contam: Float32Array;
  readonly moisture: Float32Array;
  readonly vegetation: Float32Array;
  readonly waterSource: Float32Array;
  readonly oil: Float32Array;
  readonly oilStored: Float32Array;
  readonly drift: Float32Array;
  readonly driftMat: Float32Array;
  readonly poi: Record<string, P> = {};
  readonly gates: GateSpec[] = [];
  private ponds: { c: P; r: number; level: number; fixed: boolean; freeboard: number }[] = [];
  private rivers: { pts: P[]; bed: Float32Array; width: number }[] = [];
  private caches = 0;

  constructor(
    readonly dims: WorldDims,
    readonly seed = 1,
  ) {
    const { w, h } = dims;
    this.w = w;
    this.h = h;
    this.N = w * h;
    this.r = rng(seed);
    const N = this.N;
    this.height = new Float32Array(N).fill(12);
    this.soil = new Float32Array(N).fill(3);
    this.water = new Float32Array(N);
    this.contam = new Float32Array(N * 2);
    this.moisture = new Float32Array(N).fill(0.2);
    this.vegetation = new Float32Array(N);
    this.waterSource = new Float32Array(N);
    this.oil = new Float32Array(N);
    this.oilStored = new Float32Array(N * 2);
    this.drift = new Float32Array(N);
    this.driftMat = new Float32Array(N);
  }

  /** every column inside a shape (with how far inside: 0 at the edge, growing inward) */
  each(s: Sdf, f: (x: number, y: number, i: number, depth: number) => void, pad = 0): void {
    for (let y = 1; y < this.h - 1; y++)
      for (let x = 1; x < this.w - 1; x++) {
        const d = s(x + 0.5, y + 0.5);
        if (d < pad) f(x, y, y * this.w + x, -d);
      }
  }

  // ---- phase 1: land ----

  /** The land's height everywhere (`f` in cells), and its soil depth. */
  land(f: (x: number, y: number) => number, soil: (x: number, y: number) => number = () => 3): this {
    for (let y = 0; y < this.h; y++)
      for (let x = 0; x < this.w; x++) {
        const i = y * this.w + x;
        this.height[i] = f(x, y);
        this.soil[i] = soil(x, y);
      }
    return this;
  }

  /** Raise (+) or lower (−) the land inside a shape, easing in over `soft` cells. */
  sculpt(s: Sdf, dz: number, soft = 4): this {
    this.each(s, (_x, _y, i, d) => (this.height[i] += dz * smoothstep(0, soft, d)), 0);
    return this;
  }

  /** Flatten the land inside a shape to `z`, easing in over `soft` cells. */
  level(s: Sdf, z: number, soft = 4): this {
    this.each(s, (_x, _y, i, d) => (this.height[i] += (z - this.height[i]) * smoothstep(0, soft, d)), 0);
    return this;
  }

  /** Bare rock inside a shape (no soil): poor ground — it takes moss, slowly. */
  rock(s: Sdf): this {
    this.each(s, (_x, _y, i) => (this.soil[i] = 0));
    return this;
  }

  /**
   * A river along a path (it should start and end at the map edge): a
   * channel always descending, fed at its start (water enters as if it
   * continues off the map) and leaving at its end. With no inflow it's a dry
   * gully (a flood's path).
   */
  river(pts: P[], width = 3, depth = 3, inflow = 0.01): this {
    const bed = new Float32Array(this.N).fill(Infinity);
    // the bed: a running minimum along the path so it only ever descends
    const samples: { x: number; y: number; z: number }[] = [];
    let z = Infinity;
    for (let k = 0; k < pts.length - 1; k++) {
      const [ax, ay] = pts[k];
      const [bx, by] = pts[k + 1];
      const L = Math.ceil(Math.hypot(bx - ax, by - ay));
      for (let s = 0; s < L; s++) {
        const x = ax + ((bx - ax) * s) / L;
        const y = ay + ((by - ay) * s) / L;
        z = Math.min(z - 0.03, this.at(this.height, x, y) - depth);
        samples.push({ x, y, z: Math.max(1.5, z) });
      }
    }
    const R = width + 8;
    for (const p of samples)
      for (let y = Math.max(0, Math.floor(p.y - R)); y <= Math.min(this.h - 1, Math.ceil(p.y + R)); y++)
        for (let x = Math.max(0, Math.floor(p.x - R)); x <= Math.min(this.w - 1, Math.ceil(p.x + R)); x++) {
          const d = Math.hypot(x - p.x, y - p.y);
          const i = y * this.w + x;
          // banks ease down to the bed
          const want = p.z + Math.max(0, d - width) * 0.6;
          if (d < R && want < bed[i]) bed[i] = want;
        }
    for (let i = 0; i < this.N; i++) if (bed[i] < this.height[i]) this.height[i] = bed[i];
    const [sx, sy] = pts[0];
    const [nx, ny] = pts[1];
    const L = Math.hypot(nx - sx, ny - sy) || 1;
    for (let k = 2; k <= 4; k++)
      for (let j = -2; j <= 2; j++) {
        const x = Math.round(sx + ((nx - sx) / L) * k - ((ny - sy) / L) * j);
        const y = Math.round(sy + ((ny - sy) / L) * k + ((nx - sx) / L) * j);
        if (x >= 0 && y >= 0 && x < this.w && y < this.h) this.waterSource[y * this.w + x] = inflow;
      }
    if (inflow > 0) this.rivers.push({ pts, bed, width });
    return this;
  }

  /**
   * A pond: a bowl `depth` deep, filled to just under its lowest rim once the
   * ground is in (`freeboard` below it: room for a storm's rain before it
   * spills) — or, given `level`, to that height at the very end (so walls
   * stamped later can hold it back: a reservoir behind a plug).
   */
  pond(c: P, r: number, depth = 3, level?: number, freeboard = 0.4): this {
    this.each(disc(c, r + 3), (x, y, i) => {
      const d = Math.hypot(x + 0.5 - c[0], y + 0.5 - c[1]) / r;
      this.height[i] -= depth * smoothstep(1.3, 0.2, d);
    });
    this.ponds.push({ c, r, level: level ?? NaN, fixed: level !== undefined, freeboard });
    return this;
  }

  // ---- phase 2: columns ----

  /** Turn the height field into columns: stone, whole cells of soil, a loose top of soil. */
  ground(): this {
    const grid = new ColumnGrid(this.dims);
    for (let y = 0; y < this.h; y++)
      for (let x = 0; x < this.w; x++) {
        const i = y * this.w + x;
        const hf = Math.max(2, Math.min(this.dims.zMax - 24, this.height[i]));
        const top = Math.floor(hf - 0.5);
        const soil = Math.round(Math.min(this.soil[i], top - 1));
        grid.push(x, y, 0, top - soil, MAT.Stone);
        if (soil > 0) {
          grid.push(x, y, top - soil, top, MAT.Soil);
          this.drift[i] = hf - top;
          this.driftMat[i] = MAT.Soil;
        }
      }
    this.grid = grid;
    // ponds: fill each bowl to just under its lowest rim
    for (const p of this.ponds) {
      if (p.fixed) continue;
      let rim = Infinity;
      for (let a = 0; a < 72; a++) {
        const x = Math.round(p.c[0] + Math.cos((a / 72) * Math.PI * 2) * (p.r * 1.25 + 1));
        const y = Math.round(p.c[1] + Math.sin((a / 72) * Math.PI * 2) * (p.r * 1.25 + 1));
        rim = Math.min(rim, this.surf(x, y));
      }
      p.level = rim - p.freeboard;
      this.fill(p.c, p.level, p.r * 1.6);
    }
    // rivers: a little water along the bed so it flows from the start
    for (const rv of this.rivers)
      for (let i = 0; i < this.N; i++) {
        const g = this.surfI(i);
        if (rv.bed[i] < Infinity && g < rv.bed[i] + 0.2 && this.water[i] === 0) this.water[i] = 0.8;
      }
    return this;
  }

  // ---- phase 3: features ----

  /** The green the level starts from (the story's start: poi.healthy). */
  start(c: P, r = 9): this {
    this.green(disc(c, r));
    this.poi.healthy = c;
    return this;
  }

  /** Where the level is won (poi.goal). */
  goal(c: P): this {
    this.poi.goal = c;
    return this;
  }

  /** Living green inside a shape (denser to the middle), on clean, damp ground. */
  green(s: Sdf, strength = 1): this {
    this.each(s, (x, y, i, d) => {
      this.contam[i * 2] = Math.min(this.contam[i * 2], 0.03);
      this.moisture[i] = Math.max(this.moisture[i], 0.42);
      if (hash2(x, y, 77) > 0.25) this.vegetation[i] = Math.max(this.vegetation[i], (1.3 + 2.4 * smoothstep(0, 6, d) * hash2(x, y, 78)) * strength);
    });
    return this;
  }

  /** Soil poison inside a shape (0.2 kills sprouts; 2 is a toxic dump). */
  poison(s: Sdf, level = 1.4, soft = 4): this {
    this.each(s, (_x, _y, i, d) => {
      this.contam[i * 2] = Math.max(this.contam[i * 2], level * smoothstep(0, soft, d + 0.5));
      this.vegetation[i] = 0;
    });
    return this;
  }

  /** Clean ground inside a shape (undoes poison). */
  clean(s: Sdf): this {
    this.each(s, (_x, _y, i) => (this.contam[i * 2] = Math.min(this.contam[i * 2], 0.03)));
    return this;
  }

  /** Damp (or, with a low value, parched) ground inside a shape. */
  wet(s: Sdf, moisture: number): this {
    this.each(s, (_x, _y, i) => (this.moisture[i] = moisture));
    return this;
  }

  /** Blown dust inside a shape, `depth` cells deep in the middle, easing out over `soft`. */
  dust(s: Sdf, depth = 2, soft = 3): this {
    this.each(s, (x, y, i, d) => {
      if (this.water[i] > 0 || !this.loose(i)) return;
      const n = 0.75 + 0.5 * (fbm(x / 9, y / 7, 2, this.seed + 91) * 0.5 + 0.5);
      this.drift[i] += depth * n * smoothstep(0, soft, d + 0.5);
      this.driftMat[i] = 0;
      this.vegetation[i] = 0;
    });
    return this;
  }

  /** Scattered litter (a cell of scraps) over a share of the ground inside a shape. */
  litter(s: Sdf, density = 0.75): this {
    this.each(s, (x, y, i) => {
      if (this.water[i] > 0 || hash2(x, y, 83) > density) return;
      this.cover(x, y, 1, MAT.Litter);
      this.vegetation[i] = 0;
    });
    return this;
  }

  /** A heap (or wall) of compacted trash inside a shape, `height` cells in the middle; the ground under it is fouled. */
  trash(s: Sdf, height = 3, soft = 3): this {
    this.each(s, (x, y, i, d) => {
      if (this.water[i] > 0) return;
      const n = 0.7 + 0.6 * hash2(x, y, 61);
      const hgt = Math.round(height * smoothstep(0, soft, d + 0.5) * n + 0.3);
      if (hgt <= 0) return;
      this.cover(x, y, hgt, MAT.Trash);
      if (hash2(x, y, 62) > 0.96) this.grid.push(x, y, this.grid.top(x, y), this.grid.top(x, y) + 1, MAT.Rust);
      this.contam[i * 2] = Math.max(this.contam[i * 2], 1.2);
      this.vegetation[i] = 0;
    });
    return this;
  }

  /** Oil lying on the ground (or on water) inside a shape. */
  slick(s: Sdf, depth = 0.4): this {
    this.each(s, (_x, _y, i, d) => {
      this.oil[i] = Math.max(this.oil[i], depth * smoothstep(0, 2, d + 0.5));
      this.vegetation[i] = 0;
    });
    return this;
  }

  /** A solid wall along a shape, `height` cells above the ground (concrete, brick, steel…). */
  wall(s: Sdf, height: number, mat: number = MAT.Concrete): this {
    this.each(s, (x, y, i) => {
      this.cover(x, y, height, mat);
      this.water[i] = 0;
    });
    return this;
  }

  /** A solid plug along a shape up to an absolute height `z` (a dam across a notch). */
  plug(s: Sdf, z: number, mat: number = MAT.Concrete): this {
    this.each(s, (x, y, i) => {
      const g = this.grid.top(x, y);
      if (g < z) this.cover(x, y, z - g, mat);
      this.water[i] = 0;
    });
    return this;
  }

  /** A closed oil tank (it breaks when cracked; the oil burns). */
  tank(c: P, rad = 5, height = 7): this {
    buildTank(this.grid, Math.round(c[0]), Math.round(c[1]), rad, height, this.oilStored);
    this.each(disc(c, rad + 2), (_x, _y, i) => {
      this.drift[i] = 0;
      this.vegetation[i] = 0;
    });
    return this;
  }

  /** A ruined concrete building over a box (storeys, storey height, how ruined 0..1). */
  ruin(x0: number, y0: number, x1: number, y1: number, floors = 2, floorH = 4, decay = 0.4, mat: number = MAT.Concrete): this {
    buildRuin(this.grid, x0, y0, x1, y1, floors, floorH, mat, this.r, decay);
    this.each(rect(x0, y0, x1, y1), (_x, _y, i) => {
      this.drift[i] = 0;
      this.vegetation[i] = 0;
    }, 1);
    return this;
  }

  /** A voxel model (models.ts: car, carburnt, bus, tanker, …) with its corner at `at`. */
  model(id: string, at: P, rot = 0): this {
    const m = modelById(id);
    if (!m) throw new Error(`no model "${id}"`);
    stampGrid(this.grid, m, Math.round(at[0]), Math.round(at[1]), rot);
    return this;
  }

  /**
   * Ancient seeds buried here (an easter egg, BACKLOG R4): good soil and a
   * dormant meadow under whatever covers it. poi `cache<n>`.
   */
  cache(c: P, r = 4): this {
    this.each(disc(c, r), (x, y, i, d) => {
      this.contam[i * 2] = Math.min(this.contam[i * 2], 0.03);
      this.moisture[i] = Math.max(this.moisture[i], 0.38);
      if (d > 1) this.vegetation[i] = Math.max(this.vegetation[i], 1.6 + hash2(x, y, 5));
    });
    this.poi[`cache${this.caches++}`] = c;
    return this;
  }

  /** Name an obstacle: the columns inside `s` that make up gate `id`. Call after stamping it. */
  gate(id: string, name: string, kind: GateKind, s: Sdf, teaches: Ability[] = [], opts: { soft?: boolean } = {}): this {
    const cells: number[] = [];
    let sx = 0;
    let sy = 0;
    let lo = Infinity;
    this.each(s, (x, y, i) => {
      cells.push(i);
      sx += x + 0.5;
      sy += y + 0.5;
      lo = Math.min(lo, this.height[i]);
    });
    if (!cells.length) throw new Error(`gate "${id}" covers no columns`);
    this.gates.push({ id, name, kind, cells, at: [sx / cells.length, sy / cells.length], teaches, base: kind === 'wall' ? Math.floor(lo - 0.5) : undefined, soft: opts.soft });
    return this;
  }

  build(): KitMap {
    if (!this.grid) throw new Error('kit: ground() was never called');
    if (!this.poi.healthy) throw new Error('kit: no start() — where does the green begin?');
    const N = this.N;
    for (const p of this.ponds) if (p.fixed) this.fill(p.c, p.level, p.r * 2.5);
    // where something solid stands on the ground, no loose top over it
    for (let i = 0; i < N; i++) {
      const col = this.grid.cols[i];
      const m = col[col.length - 1].mat;
      if (m !== MAT.Soil && m !== MAT.Sand && this.driftMat[i] !== 0) {
        this.drift[i] = 0;
        this.driftMat[i] = 0;
      }
    }
    const surface = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const col = this.grid.cols[i];
      surface[i] = col[col.length - 1].z1;
    }
    this.poi.dam ??= this.poi.goal ?? this.poi.healthy;
    return {
      grid: this.grid,
      water: this.water,
      contam: this.contam,
      moisture: this.moisture,
      vegetation: this.vegetation,
      waterSource: this.waterSource,
      oil: this.oil,
      oilStored: this.oilStored,
      drift: this.drift,
      driftMat: this.driftMat,
      surface,
      poi: this.poi,
      gates: this.gates,
    };
  }

  // ---- helpers ----

  /** the visible ground height at a column (solid top + loose layer) */
  surf(x: number, y: number): number {
    const ix = Math.max(0, Math.min(this.w - 1, x));
    const iy = Math.max(0, Math.min(this.h - 1, y));
    return this.surfI(iy * this.w + ix);
  }

  private surfI(i: number): number {
    const c = this.grid.cols[i];
    return c[c.length - 1].z1 + this.drift[i];
  }

  private at(f: Float32Array, x: number, y: number): number {
    const ix = Math.max(0, Math.min(this.w - 1, Math.round(x)));
    const iy = Math.max(0, Math.min(this.h - 1, Math.round(y)));
    return f[iy * this.w + ix];
  }

  /** the loose top can take dust (bare soil or sand, no structure on it) */
  private loose(i: number): boolean {
    const col = this.grid.cols[i];
    const m = col[col.length - 1].mat;
    return m === MAT.Soil || m === MAT.Sand;
  }

  /** stack `n` cells of `mat` on a column; its loose top goes (whole cells only) */
  private cover(x: number, y: number, n: number, mat: number): void {
    const i = y * this.w + x;
    this.drift[i] = 0;
    this.driftMat[i] = 0;
    const g = this.grid.top(x, y);
    this.grid.push(x, y, g, g + n, mat);
  }

  /** flood-fill water from `c` to `level`, within `R` */
  private fill(c: P, level: number, R: number): void {
    const { w, h } = this;
    const seen = new Uint8Array(this.N);
    const stack = [Math.round(c[1]) * w + Math.round(c[0])];
    while (stack.length) {
      const i = stack.pop()!;
      if (seen[i]) continue;
      seen[i] = 1;
      const x = i % w;
      const y = (i - x) / w;
      if (Math.hypot(x - c[0], y - c[1]) > R) continue;
      const g = this.surfI(i);
      if (g >= level) continue;
      this.water[i] = level - g;
      this.vegetation[i] = 0;
      if (x > 0) stack.push(i - 1);
      if (x < w - 1) stack.push(i + 1);
      if (y > 0) stack.push(i - w);
      if (y < h - 1) stack.push(i + w);
    }
  }
}
