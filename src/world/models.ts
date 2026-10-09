// Model atlas (round 13, BACKLOG F5): small voxel models — ruined cars, a
// bus, a tanker truck, a beached tanker ship, ruins, a field-hospital tent,
// a pylon, an oil tank, barrels, a seawall — authored once here and stamped
// into the world as real matter (column intervals), so they can be buried in
// drifts, battered by cyclones and broken like anything else. Map generators
// stamp them into the authoring grid (`stampGrid`); the sandbox places them
// live (LevelScene.placeModel); the editor shows thumbnails (ui/thumbs.ts).

import type { ColumnGrid, Interval } from './layout';
import { MAT } from './materials';
import { hash2 } from './noise';

export interface VoxelModel {
  id: string;
  name: string;
  /** footprint x, y and height z, in cells */
  size: [number, number, number];
  /** material per voxel, index x + w·(y + d·z); 0 = air */
  vox: Uint8Array;
  /** cells it sits below the ground by default (half-buried wrecks) */
  sink: number;
}

class Builder {
  readonly vox: Uint8Array;
  constructor(
    readonly w: number,
    readonly d: number,
    readonly h: number,
  ) {
    this.vox = new Uint8Array(w * d * h);
  }
  set(x: number, y: number, z: number, m: number): void {
    if (x < 0 || y < 0 || z < 0 || x >= this.w || y >= this.d || z >= this.h) return;
    this.vox[x + this.w * (y + this.d * z)] = m;
  }
  get(x: number, y: number, z: number): number {
    if (x < 0 || y < 0 || z < 0 || x >= this.w || y >= this.d || z >= this.h) return 0;
    return this.vox[x + this.w * (y + this.d * z)];
  }
  /** fill the box [x0, x1) × [y0, y1) × [z0, z1) */
  box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, m: number): void {
    for (let z = z0; z < z1; z++) for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) this.set(x, y, z, m);
  }
  /** recolour a share of the solid voxels (rust patches, scorch) */
  weather(m: number, share: number, seed: number, only?: number): void {
    for (let z = 0; z < this.h; z++)
      for (let y = 0; y < this.d; y++)
        for (let x = 0; x < this.w; x++) {
          const v = this.get(x, y, z);
          if (v && (only === undefined || v === only) && hash2(x * 7 + z * 131, y, seed) < share) this.set(x, y, z, m);
        }
  }
  /** knock out voxels from the top down where a noise says so (ruined tops) */
  ruin(depth: number, seed: number): void {
    for (let y = 0; y < this.d; y++)
      for (let x = 0; x < this.w; x++) {
        const cut = Math.floor(hash2(x >> 1, y >> 1, seed) * (depth + 1));
        let removed = 0;
        for (let z = this.h - 1; z >= 0 && removed < cut; z--) {
          if (this.get(x, y, z)) {
            this.set(x, y, z, 0);
            removed++;
          }
        }
      }
  }
  done(id: string, name: string, sink = 0): VoxelModel {
    this.dropIslands();
    return { id, name, size: [this.w, this.d, this.h], vox: this.vox, sink };
  }

  /** Remove voxels not connected (face to face) to the bottom layer: ruined
   *  tops leave loose fragments that would only fall the moment it's placed. */
  private dropIslands(): void {
    const { w, d, h } = this;
    const keep = new Uint8Array(this.vox.length);
    const stack: number[] = [];
    for (let y = 0; y < d; y++)
      for (let x = 0; x < w; x++) {
        const i = x + w * y;
        if (this.vox[i]) {
          keep[i] = 1;
          stack.push(i);
        }
      }
    while (stack.length) {
      const i = stack.pop()!;
      const x = i % w;
      const y = Math.floor(i / w) % d;
      const z = Math.floor(i / (w * d));
      for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
        const nx = x + dx;
        const ny = y + dy;
        const nz = z + dz;
        if (nx < 0 || ny < 0 || nz < 0 || nx >= w || ny >= d || nz >= h) continue;
        const j = nx + w * (ny + d * nz);
        if (this.vox[j] && !keep[j]) {
          keep[j] = 1;
          stack.push(j);
        }
      }
    }
    for (let i = 0; i < this.vox.length; i++) if (!keep[i]) this.vox[i] = 0;
  }
}

function car(id: string, name: string, burnt: boolean, seed: number): VoxelModel {
  const b = new Builder(7, 3, 3);
  const body = burnt ? MAT.Rust : MAT.Steel;
  // wheels (dark) at the corners, the body on them, the cabin set back
  for (const x of [1, 5]) for (const y of [0, 2]) b.set(x, y, 0, MAT.Asphalt);
  b.box(0, 0, 1, 7, 3, 2, body);
  b.box(2, 0, 2, 5, 3, 3, body);
  // the windscreen is gone: a gap under the front of the roof
  b.set(2, 1, 2, 0);
  b.weather(MAT.Rust, burnt ? 0.4 : 0.25, seed);
  if (burnt) b.weather(MAT.Ash, 0.15, seed + 1);
  return b.done(id, name, 0);
}

function bus(): VoxelModel {
  const b = new Builder(14, 4, 4);
  for (const x of [2, 11]) for (const y of [0, 3]) b.set(x, y, 0, MAT.Asphalt);
  b.box(0, 0, 1, 14, 4, 2, MAT.Steel); // floor and skirt
  b.box(0, 0, 3, 14, 4, 4, MAT.Steel); // roof
  // walls with a window row: posts every other cell
  for (let x = 0; x < 14; x++)
    for (const y of [0, 3]) b.set(x, y, 2, x % 2 === 0 || x === 13 ? MAT.Steel : 0);
  for (let y = 0; y < 4; y++) {
    b.set(0, y, 2, MAT.Steel);
    b.set(13, y, 2, MAT.Steel);
  }
  b.weather(MAT.Rust, 0.3, 41);
  // part of the roof has rusted through
  b.box(8, 1, 3, 11, 3, 4, 0);
  return b.done('bus', 'Bus');
}

function tankerTruck(): VoxelModel {
  const b = new Builder(12, 3, 4);
  for (const x of [1, 6, 9]) for (const y of [0, 2]) b.set(x, y, 0, MAT.Asphalt);
  b.box(0, 0, 1, 12, 3, 2, MAT.Steel); // chassis
  b.box(0, 0, 2, 3, 3, 4, MAT.Steel); // cab
  b.box(4, 0, 2, 12, 3, 3, MAT.Rust); // tank, round-ish
  b.box(4, 1, 3, 12, 2, 4, MAT.Rust);
  b.weather(MAT.Rust, 0.3, 77, MAT.Steel);
  return b.done('tankertruck', 'Tanker truck');
}

function tankerShip(): VoxelModel {
  const L = 48;
  const B = 12;
  const b = new Builder(L, B, 16);
  for (let x = 0; x < L; x++) {
    // the bow narrows over the last 10 cells; the keel rises toward it
    const bow = Math.max(0, x - (L - 10)) / 10;
    const half = (B / 2) * (1 - bow * bow * 0.85);
    const keel = Math.round(bow * 2);
    for (let y = 0; y < B; y++) {
      const dy = Math.abs(y + 0.5 - B / 2);
      if (dy > half) continue;
      // the hull is rounded under the waterline: shallower at the sides
      const side = dy > half - 1.5 ? 1 : 0;
      b.box(x, y, keel + side, x + 1, y + 1, 4, MAT.Rust);
      b.box(x, y, 4, x + 1, y + 1, 6, MAT.Steel);
    }
  }
  // the bridge at the stern, with a window band, and the funnel
  b.box(2, 2, 6, 10, 10, 13, MAT.Concrete);
  for (let x = 2; x < 10; x++) for (const y of [2, 9]) if (x % 2) b.set(x, y, 11, 0);
  b.box(4, 5, 13, 7, 7, 16, MAT.Rust);
  // pipes along the deck
  for (let x = 12; x < L - 8; x++) {
    b.set(x, 5, 6, MAT.Steel);
    b.set(x, 6, 6, MAT.Steel);
  }
  b.weather(MAT.Rust, 0.25, 9, MAT.Steel);
  return b.done('tanker', 'Tanker ship', 2);
}

function ruinHouse(): VoxelModel {
  const b = new Builder(10, 8, 7);
  b.box(0, 0, 0, 10, 8, 1, MAT.Concrete); // slab
  for (let z = 1; z < 7; z++)
    for (let y = 0; y < 8; y++)
      for (let x = 0; x < 10; x++) {
        const wall = x === 0 || x === 9 || y === 0 || y === 7;
        if (!wall) continue;
        // windows and a door
        const win = z >= 2 && z <= 3 && ((x % 3 === 1 && (y === 0 || y === 7)) || (y % 3 === 1 && (x === 0 || x === 9)));
        const door = y === 0 && x >= 4 && x <= 5 && z <= 3;
        if (!win && !door) b.set(x, y, z, MAT.Brick);
      }
  // a floor slab still hangs on over one corner
  b.box(0, 0, 5, 6, 5, 6, MAT.Concrete);
  b.ruin(4, 13);
  b.weather(MAT.Concrete, 0.1, 14, MAT.Brick);
  return b.done('house', 'Ruined house');
}

function ruinWall(): VoxelModel {
  const b = new Builder(12, 1, 6);
  b.box(0, 0, 0, 12, 1, 6, MAT.Concrete);
  for (let x = 1; x < 12; x += 3) b.box(x, 0, 2, x + 1, 1, 4, 0);
  b.ruin(5, 23);
  return b.done('wall', 'Broken wall');
}

function tent(): VoxelModel {
  // a field-hospital tent: a ridged canvas roof over an open floor, closed
  // gables, a red cross on the roof
  const W = 9;
  const D = 7;
  const b = new Builder(W, D, 5);
  for (let x = 0; x < W; x++)
    for (let y = 0; y < D; y++) {
      const roof = 4 - Math.round(Math.abs(y + 0.5 - D / 2) * 1.1);
      // two cells thick so each step of the roof overlaps the next (support)
      b.box(x, y, roof - 1, x + 1, y + 1, roof + 1, MAT.Canvas);
      if (x === 0 || x === W - 1) for (let z = 0; z < roof; z++) b.set(x, y, z, MAT.Canvas);
    }
  // the open door flap
  b.box(0, 3, 0, 1, 4, 2, 0);
  for (let k = -1; k <= 1; k++) {
    b.set(4 + k, 3, 4, MAT.Brick);
    b.set(4, 3 + k, 4, MAT.Brick);
  }
  return b.done('tent', 'Hospital tent');
}

function pylon(): VoxelModel {
  const b = new Builder(7, 7, 18);
  for (let z = 0; z < 15; z++) {
    // four 2×2 legs leaning in a cell every 5: each segment overlaps the one
    // below, so the legs are continuous (structure support needs face contact)
    const i = z < 5 ? 0 : z < 10 ? 1 : 2;
    const o = 5 - i;
    for (const [x, y] of [[i, i], [o, i], [i, o], [o, o]]) b.box(x, y, z, x + 2, y + 2, z + 1, MAT.Steel);
    // cross-braces
    if (z % 5 === 3) {
      b.box(i, i, z, o + 2, i + 1, z + 1, MAT.Steel);
      b.box(i, o + 1, z, o + 2, o + 2, z + 1, MAT.Steel);
      b.box(i, i, z, i + 1, o + 2, z + 1, MAT.Steel);
      b.box(o + 1, i, z, o + 2, o + 2, z + 1, MAT.Steel);
    }
  }
  // the arms that carried the lines, and the peak
  b.box(0, 3, 15, 7, 4, 16, MAT.Steel);
  b.box(3, 0, 13, 4, 7, 14, MAT.Steel);
  b.box(3, 3, 15, 4, 4, 18, MAT.Steel);
  b.weather(MAT.Rust, 0.35, 5);
  return b.done('pylon', 'Pylon');
}

function oilTank(): VoxelModel {
  const R = 5;
  const b = new Builder(R * 2 + 1, R * 2 + 1, 7);
  for (let y = 0; y <= R * 2; y++)
    for (let x = 0; x <= R * 2; x++) {
      const d = Math.hypot(x - R, y - R);
      if (d > R + 0.4) continue;
      if (d > R - 0.8) b.box(x, y, 0, x + 1, y + 1, 6, MAT.Rust);
      b.set(x, y, 6, MAT.Rust);
    }
  b.weather(MAT.Steel, 0.2, 31);
  return b.done('oiltank', 'Oil tank');
}

function barrels(): VoxelModel {
  const b = new Builder(4, 3, 2);
  const at: [number, number, number][] = [[0, 0, 0], [1, 0, 0], [2, 1, 0], [0, 1, 0], [1, 1, 1], [3, 2, 0], [1, 2, 0]];
  for (const [x, y, z] of at) b.set(x, y, z, hash2(x, y, 3) < 0.5 ? MAT.Rust : MAT.Steel);
  return b.done('barrels', 'Barrels');
}

function seawall(): VoxelModel {
  const b = new Builder(16, 4, 6);
  // a stepped face toward the sea (+y), a broken top
  for (let y = 0; y < 4; y++) b.box(0, y, 0, 16, y + 1, 6 - y, MAT.Concrete);
  b.ruin(2, 51);
  b.box(6, 0, 0, 8, 4, 6, 0); // breached
  return b.done('seawall', 'Seawall');
}

/** A ruined apartment block: a concrete frame, a floor every 4 cells, window bays, a broken crown. */
function apartments(): VoxelModel {
  const W = 12;
  const D = 9;
  const H = 30;
  const b = new Builder(W, D, H);
  for (let z = 0; z < H - 2; z++)
    for (let y = 0; y < D; y++)
      for (let x = 0; x < W; x++) {
        const edge = x === 0 || x === W - 1 || y === 0 || y === D - 1;
        const floor = z % 4 === 0;
        if (floor) b.set(x, y, z, MAT.Concrete);
        else if (edge) {
          // window bays between pillars every third cell
          const pillar = (x % 3 === 0 || y % 3 === 0) && (x === 0 || x === W - 1 || y === 0 || y === D - 1);
          const sill = z % 4 === 1;
          if (pillar || sill) b.set(x, y, z, MAT.Concrete);
        }
      }
  b.box(1, 1, H - 2, W - 1, D - 1, H - 1, MAT.Concrete);
  b.ruin(6, 71);
  b.weather(MAT.Brick, 0.08, 72, MAT.Concrete);
  return b.done('apartments', 'Apartment block');
}

/** A narrow office tower in steel and concrete. */
function officeTower(): VoxelModel {
  const S = 8;
  const H = 40;
  const b = new Builder(S, S, H);
  for (let z = 0; z < H; z++)
    for (let y = 0; y < S; y++)
      for (let x = 0; x < S; x++) {
        const edge = x === 0 || x === S - 1 || y === 0 || y === S - 1;
        const corner = (x === 0 || x === S - 1) && (y === 0 || y === S - 1);
        if (z % 5 === 0) b.set(x, y, z, MAT.Concrete);
        else if (corner) b.set(x, y, z, MAT.Concrete);
        else if (edge && (x + y) % 2 === 0) b.set(x, y, z, MAT.Steel);
      }
  // a lift core
  b.box(3, 3, 0, 5, 5, H, MAT.Concrete);
  b.ruin(3, 81);
  return b.done('office', 'Office tower');
}

/** A water tower: a tank on four legs. */
function waterTower(): VoxelModel {
  const b = new Builder(9, 9, 22);
  for (const [x, y] of [[1, 1], [6, 1], [1, 6], [6, 6]]) b.box(x, y, 0, x + 2, y + 2, 14, MAT.Steel);
  for (const z of [4, 9]) {
    b.box(1, 1, z, 8, 3, z + 1, MAT.Steel);
    b.box(1, 6, z, 8, 8, z + 1, MAT.Steel);
  }
  for (let y = 0; y < 9; y++)
    for (let x = 0; x < 9; x++) {
      const d = Math.hypot(x - 4, y - 4);
      if (d > 4.4) continue;
      b.box(x, y, 14, x + 1, y + 1, d > 3.4 ? 20 : 15, MAT.Rust);
      b.set(x, y, 20, MAT.Rust);
    }
  b.box(4, 4, 21, 5, 5, 22, MAT.Rust);
  return b.done('watertower', 'Water tower');
}

/** A brick smokestack. */
function smokestack(): VoxelModel {
  const b = new Builder(7, 7, 36);
  for (let z = 0; z < 36; z++) {
    const r = 3.3 - (z / 36) * 1.1;
    for (let y = 0; y < 7; y++)
      for (let x = 0; x < 7; x++) {
        const d = Math.hypot(x - 3, y - 3);
        if (d <= r && d > r - 1.3) b.set(x, y, z, z > 30 && (x + y + z) % 5 === 0 ? MAT.Concrete : MAT.Brick);
      }
  }
  b.box(0, 0, 0, 7, 7, 2, MAT.Concrete);
  return b.done('smokestack', 'Smokestack');
}

export const MODELS: VoxelModel[] = [
  car('car', 'Ruined car', false, 1),
  car('carburnt', 'Burnt-out car', true, 2),
  bus(),
  tankerTruck(),
  tankerShip(),
  ruinHouse(),
  ruinWall(),
  tent(),
  pylon(),
  oilTank(),
  barrels(),
  seawall(),
  apartments(),
  officeTower(),
  waterTower(),
  smokestack(),
];

export function modelById(id: string): VoxelModel | undefined {
  return MODELS.find((m) => m.id === id);
}

/** Footprint size after rotating by rot quarter turns. */
export function footprint(m: VoxelModel, rot: number): [number, number] {
  return rot % 2 ? [m.size[1], m.size[0]] : [m.size[0], m.size[1]];
}

/**
 * The model's columns after rotating by rot quarter turns: for each footprint
 * cell (fx + fw·fy) its runs of material as intervals relative to the base.
 */
export function modelColumns(m: VoxelModel, rot: number): { fw: number; fd: number; cols: Interval[][] } {
  const [w, d, h] = m.size;
  const [fw, fd] = footprint(m, rot);
  const cols: Interval[][] = [];
  for (let fy = 0; fy < fd; fy++)
    for (let fx = 0; fx < fw; fx++) {
      // footprint cell → model cell
      let x = fx;
      let y = fy;
      if (rot % 4 === 1) [x, y] = [fy, fw - 1 - fx];
      else if (rot % 4 === 2) [x, y] = [w - 1 - fx, d - 1 - fy];
      else if (rot % 4 === 3) [x, y] = [fd - 1 - fy, fx];
      const runs: Interval[] = [];
      for (let z = 0; z < h; z++) {
        const v = m.vox[x + w * (y + d * z)];
        if (!v) continue;
        const last = runs[runs.length - 1];
        if (last && last.z1 === z && last.mat === v) last.z1 = z + 1;
        else runs.push({ z0: z, z1: z + 1, mat: v });
      }
      cols.push(runs);
    }
  return { fw, fd, cols };
}

/**
 * Put a model's runs (already at world height) into a column: the model
 * replaces whatever it overlaps, everything else stays. Returns the new
 * interval list, merged where neighbours share a material.
 */
export function mergeColumn(world: Interval[], model: Interval[]): Interval[] {
  const out: Interval[] = [];
  for (const iv of world) {
    // cut the world interval around every model run
    let pieces: Interval[] = [{ ...iv }];
    for (const r of model) {
      const next: Interval[] = [];
      for (const p of pieces) {
        if (r.z1 <= p.z0 || r.z0 >= p.z1) next.push(p);
        else {
          if (p.z0 < r.z0) next.push({ z0: p.z0, z1: r.z0, mat: p.mat, aux: p.aux });
          if (p.z1 > r.z1) next.push({ z0: r.z1, z1: p.z1, mat: p.mat, aux: p.aux });
        }
      }
      pieces = next;
    }
    out.push(...pieces);
  }
  out.push(...model.map((r) => ({ ...r })));
  out.sort((a, b) => a.z0 - b.z0);
  const merged: Interval[] = [];
  for (const iv of out) {
    const last = merged[merged.length - 1];
    if (last && last.z1 === iv.z0 && last.mat === iv.mat) last.z1 = iv.z1;
    else merged.push(iv);
  }
  return merged;
}

/**
 * The base height a model sits at over a footprint: the mean ground height
 * under it, less the sink. It is seated into the ground (seatColumn), not
 * perched on the highest point — perched, a long hull hangs over the dips and
 * the structure rule rightly brings it down.
 */
export function restingBase(topAt: (x: number, y: number) => number, x0: number, y0: number, fw: number, fd: number, sink: number): number {
  let sum = 0;
  for (let y = y0; y < y0 + fd; y++) for (let x = x0; x < x0 + fw; x++) sum += topAt(x, y);
  return Math.max(1, Math.round(sum / (fw * fd)) - sink);
}

/**
 * A column with a model in it: ground that rises above the base is cut by
 * the model where they overlap; a dip below the base is filled up to it with
 * the column's own top material (the wreck settles into the sand). `runs`
 * are at world height; `aux` marks the new runs (support·16 + damage).
 */
export function seatColumn(world: Interval[], runs: Interval[], base: number, aux = 0): Interval[] {
  const top = world.length ? world[world.length - 1] : undefined;
  const fill: Interval[] = top && top.z1 < base ? [{ z0: top.z1, z1: base, mat: top.mat, aux }] : [];
  return mergeColumn([...world, ...fill], runs.map((r) => ({ ...r, aux })));
}

/** Map generators: stamp a model into the authoring grid with its corner at (x0, y0). */
export function stampGrid(grid: ColumnGrid, m: VoxelModel, x0: number, y0: number, rot = 0, sink = m.sink): void {
  const { fw, fd, cols } = modelColumns(m, rot);
  const base = restingBase((x, y) => grid.top(x, y), x0, y0, fw, fd, sink);
  for (let fy = 0; fy < fd; fy++)
    for (let fx = 0; fx < fw; fx++) {
      const x = x0 + fx;
      const y = y0 + fy;
      if (x < 0 || y < 0 || x >= grid.dims.w || y >= grid.dims.h) continue;
      const runs = cols[fx + fw * fy].map((r) => ({ z0: r.z0 + base, z1: r.z1 + base, mat: r.mat }));
      if (!runs.length) continue;
      const c = grid.col(x, y);
      const merged = seatColumn(c, runs, base).map(({ z0, z1, mat }) => ({ z0, z1, mat }));
      c.length = 0;
      c.push(...merged);
    }
}

/**
 * The model at half size (each 2×2×2 block → its most common material, kept
 * if at least 3 of its 8 voxels are solid): small copies, e.g. the title
 * screen's level models.
 */
export function halfScale(m: VoxelModel): VoxelModel {
  const [w, d, h] = m.size;
  const W = Math.ceil(w / 2);
  const D = Math.ceil(d / 2);
  const Hh = Math.ceil(h / 2);
  const vox = new Uint8Array(W * D * Hh);
  for (let z = 0; z < Hh; z++)
    for (let y = 0; y < D; y++)
      for (let x = 0; x < W; x++) {
        const count = new Map<number, number>();
        let solid = 0;
        for (let k = 0; k < 8; k++) {
          const xx = x * 2 + (k & 1);
          const yy = y * 2 + ((k >> 1) & 1);
          const zz = z * 2 + (k >> 2);
          if (xx >= w || yy >= d || zz >= h) continue;
          const v = m.vox[xx + w * (yy + d * zz)];
          if (!v) continue;
          solid++;
          count.set(v, (count.get(v) ?? 0) + 1);
        }
        if (solid < 3) continue;
        let best = 0;
        let bestN = 0;
        for (const [v, n] of count) if (n > bestN) [best, bestN] = [v, n];
        vox[x + W * (y + D * z)] = best;
      }
  return { id: `${m.id}-half`, name: m.name, size: [W, D, Hh], vox, sink: Math.round(m.sink / 2) };
}
