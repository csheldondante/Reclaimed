// ---- play/draw/shapes.ts ----------------------------------------------------------------------------------------
// The heroes' looks as voxel models (ported from GameplayGM runtimes/hoverbike/src/model.ts, round 117): boxes in
// eighth cells, only the voxels with an open face kept, drawn by draw/voxels.ts through the renderer's game-model
// entry. Why voxels here: they're what the renderer draws lit and shadowed beside the world today and they're cheap to
// rewrite each frame; a hero is a Part list, so a mesh can stand in for it later without the heroes changing.
// Pure: no GPU.

import { MAT } from '../../world/materials';

export type V3 = [number, number, number];
export type Q = [number, number, number, number];
export type Voxels = { at: V3; mat: number }[];
/** A model placed: its voxels with their origin (bottom centre) at `at`, turned by `q`; `flash` 0..1 the hurt glow. */
export interface Part {
  voxels: Voxels;
  at: V3;
  q: Q;
  flash?: number;
  /** its voxels' edge (cells; default VOXEL): a trail's are bigger */
  size?: number;
}

/** Voxel edge (cells): eighth cells, the renderer's size code 2 (n/16 of a cell). */
export const VOXEL = 0.125;

/** How tall a model stands over its feet (cells). */
export function heightOf(v: Voxels): number {
  let top = 0;
  for (const { at } of v) top = Math.max(top, at[2]);
  return top + VOXEL;
}

/** A model built box by box in (forward, right, up) voxel indices (half-open ranges). */
class Shape {
  private grid = new Map<string, number>();
  box(f0: number, f1: number, r0: number, r1: number, u0: number, u1: number, mat: number): this {
    for (let f = f0; f < f1; f++) for (let r = r0; r < r1; r++) for (let u = u0; u < u1; u++) this.grid.set(`${f},${r},${u}`, mat);
    return this;
  }
  both(f0: number, f1: number, r0: number, r1: number, u0: number, u1: number, mat: number): this {
    return this.box(f0, f1, r0, r1, u0, u1, mat).box(f0, f1, -r1, -r0, u0, u1, mat);
  }
  voxels(): Voxels {
    const out: Voxels = [];
    const open = (f: number, r: number, u: number) => !this.grid.has(`${f},${r},${u}`);
    for (const [k, mat] of this.grid) {
      const [f, r, u] = k.split(',').map(Number);
      if (open(f + 1, r, u) || open(f - 1, r, u) || open(f, r + 1, u) || open(f, r - 1, u) || open(f, r, u + 1) || open(f, r, u - 1))
        out.push({ at: [(f + 0.5) * VOXEL, (r + 0.5) * VOXEL, (u + 0.5) * VOXEL], mat });
    }
    return out;
  }
}

/** A motorcycle on hover pods where the wheels would be, glowing underneath; a rider leaning into the bars. ~2.3 cells long. */
export function buildBike(): Voxels {
  const s = new Shape();
  s.box(4, 9, -2, 2, 1, 3, MAT.Asphalt).box(-9, -3, -2, 2, 1, 4, MAT.Asphalt);
  s.box(5, 8, -1, 1, 0, 1, MAT.Lava).box(-8, -4, -1, 1, 0, 1, MAT.Lava);
  s.box(-4, 5, -1, 1, 2, 4, MAT.Steel).box(-2, 2, -2, 2, 2, 5, MAT.Steel).box(5, 7, -1, 1, 3, 6, MAT.Steel);
  s.box(1, 5, -1, 1, 5, 7, MAT.Rust).box(-4, 1, -1, 1, 5, 6, MAT.Canvas).box(-8, -4, -1, 1, 4, 6, MAT.Rust);
  s.box(4, 5, -3, 3, 7, 8, MAT.Steel).box(5, 6, -1, 1, 7, 9, MAT.Concrete);
  s.both(-2, 1, 1, 2, 4, 7, MAT.Asphalt).box(-3, 0, -1, 1, 6, 9, MAT.Canvas).box(-1, 2, -1, 1, 9, 11, MAT.Canvas);
  s.both(1, 4, 1, 2, 9, 10, MAT.Canvas).box(0, 3, -1, 1, 11, 14, MAT.Bone);
  return s.voxels();
}

/** A robed lich, ~2.6 cells tall: a hood over a skull, bone hands, a staff with a glowing orb. Floats. */
export function buildLich(): Voxels {
  const s = new Shape();
  for (let u = 0; u < 10; u++) {
    const w = Math.max(2, 4 - Math.floor(u / 3));
    s.box(-w, w, -w, w, u, u + 1, MAT.Asphalt);
  }
  s.box(-2, 2, -4, 4, 10, 12, MAT.Asphalt);
  s.box(-2, 2, -2, 2, 12, 16, MAT.Asphalt).box(2, 3, -1, 1, 12, 15, MAT.Bone);
  s.both(0, 3, 3, 4, 8, 11, MAT.Asphalt).both(3, 4, 3, 4, 8, 10, MAT.Bone);
  s.box(4, 5, 4, 5, 0, 19, MAT.Wood).box(3, 6, 3, 6, 19, 22, MAT.Lava);
  return s.voxels();
}

/** The rider's blade, swung out to the side: a grip and a long edge along +x. */
export function buildBlade(): Voxels {
  return new Shape().box(0, 3, 0, 1, 0, 1, MAT.Rust).box(3, 4, -1, 2, 0, 1, MAT.Steel).box(4, 17, 0, 1, 0, 2, MAT.Steel).voxels();
}
export const BLADE_LENGTH = 17 * VOXEL;

/** The rider's lance: a shaft along +x from the origin, a pale point. */
export function buildLance(): Voxels {
  return new Shape().box(0, 18, 0, 1, 0, 1, MAT.Wood).box(18, 22, 0, 1, 0, 1, MAT.Steel).box(2, 4, -1, 2, -1, 2, MAT.Steel).voxels();
}
export const LANCE_LENGTH = 22 * VOXEL;

/** rotation about a unit axis */
export function qAxis(axis: V3, a: number): Q {
  const s = Math.sin(a / 2);
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(a / 2)];
}

export function qMul(a: Q, b: Q): Q {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}

export function qRotate(q: Q, v: V3): V3 {
  const [x, y, z, w] = q;
  const t: V3 = [2 * (y * v[2] - z * v[1]), 2 * (z * v[0] - x * v[2]), 2 * (x * v[1] - y * v[0])];
  return [v[0] + w * t[0] + (y * t[2] - z * t[1]), v[1] + w * t[1] + (z * t[0] - x * t[2]), v[2] + w * t[2] + (x * t[1] - y * t[0])];
}

/** A body's attitude: yaw to its heading, nose up with `pitch`, leaning into turns with `bank` (+ to the left). */
export function attitude(heading: number, pitch: number, bank: number): Q {
  // (the model's forward is +x, right is -y, z up: a nose-up pitch turns about -y, a lean about -x)
  return qMul(qMul(qAxis([0, 0, 1], heading), qAxis([0, -1, 0], pitch)), qAxis([1, 0, 0], -bank));
}

/** Where a point of the model (forward, right, up) is in the world. */
export function modelToWorld(at: V3, q: Q, p: V3): V3 {
  const c = qRotate(q, [p[0], -p[1], p[2]]);
  return [at[0] + c[0], at[1] + c[1], at[2] + c[2]];
}
