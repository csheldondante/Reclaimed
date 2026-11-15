// The fine collision pass's contract (docs/design/PHYSICS_ENGINE.md "Fine collision, body ↔ body"; DESIGN.md §10).
// Types, byte layouts and pure packers only: the buffers the pass reads (bodies, candidate pairs), the model store's
// rows, and the contact rows it writes. The WGSL side is src/shaders/engine/sdf-model.wgsl and sdf-fine.wgsl: keep
// both in step (each struct there names its mirror here).
//
// Units: world lengths are cells. A model's own grid is in voxels, `voxel` cells each (1, 1/2 or 1/4).
// Frames: a model is stored padded by SDF_PAD empty voxels a side. Padded voxel (i, j, k) has its centre at
// (i + 0.5, j + 0.5, k + 0.5). A body-local point is (padded voxel point - com) * voxel; world = pos + rotate(quat, local).
// Angular velocity is in the world frame; inverse inertia is the diagonal in the body's frame.

/** empty voxels round every model in the store: the field then covers half a voxel past the tight bounds, and an
 *  occupied voxel at the model's edge finds its nearest empty one inside the grid */
export const SDF_PAD = 1;
/** a padded side at most (8 bits a side in a row's dims and in a sample) */
export const SDF_MAX_SIDE = 255;

/**
 * How the field is kept:
 * - `f32`: a float a voxel (4 B). The normal is the trilinear field's own gradient.
 * - `snorm8`: 8 bits a voxel in sixteenths of a voxel, ±7.9 voxels (1 B). The normal as f32's.
 * - `grad8`: a word a voxel (4 B): the snorm8 distance in the low byte, then the unit gradient's x, y, z as snorm8
 *   (central differences of the distances at the bake). Distance and gradient are both interpolated, so the normal
 *   is continuous from cell to cell.
 */
export type SdfFormat = 'f32' | 'snorm8' | 'grad8';
/** the snorm8 field's steps a voxel */
export const SDF_SNORM_SCALE = 16;

// ---- inputs (the note's stage 1 and 2 rows; owned by the engine's integration and coarse stages) ----

/** bodyPose, 32 B: pos xyz (cells), inverse mass; quat xyzw */
export const BODY_POSE_BYTES = 32;
/** bodyVel, 32 B: linear xyz, rest timer; angular xyz (world), bound radius (cells, about pos) */
export const BODY_VEL_BYTES = 32;
/** bodyInfo, 32 B: inverse inertia xyz (body frame diagonal), material u32; flags u32, priority u32, model row u32, grid id u32 */
export const BODY_INFO_BYTES = 32;
/** pairs, 8 B: body rows a, b (u32 each). The count is word 0 of a separate buffer. */
export const PAIR_BYTES = 8;

export interface BodyRow {
  pos: [number, number, number];
  quat: [number, number, number, number];
  invMass: number;
  lin?: [number, number, number];
  ang?: [number, number, number];
  /** bound radius about pos, cells */
  radius: number;
  invInertia?: [number, number, number];
  material?: number;
  model: number;
}

/** the three body buffers' bytes for `rows` (tests, benches; the engine's integration stage writes its own) */
export function packBodies(rows: BodyRow[]): { pose: Float32Array; vel: Float32Array; info: ArrayBuffer } {
  const pose = new Float32Array(rows.length * 8);
  const vel = new Float32Array(rows.length * 8);
  const info = new ArrayBuffer(rows.length * BODY_INFO_BYTES);
  const f = new Float32Array(info);
  const u = new Uint32Array(info);
  rows.forEach((r, i) => {
    pose.set([...r.pos, r.invMass, ...r.quat], i * 8);
    vel.set([...(r.lin ?? [0, 0, 0]), 0, ...(r.ang ?? [0, 0, 0]), r.radius], i * 8);
    f.set(r.invInertia ?? [0, 0, 0], i * 8);
    u[i * 8 + 3] = r.material ?? 0;
    u[i * 8 + 6] = r.model;
  });
  return { pose, vel, info };
}

// ---- the model store ----

/**
 * A model's row, 32 B (WGSL `SdfModel`):
 *   u32 fieldBase    word offset of its field in the store's data buffer
 *   u32 dims         padded sides, x | y << 8 | z << 16
 *   u32 sampleBase   word offset of its surface samples in the data buffer
 *   u32 sampleCount  samples kept (written on the GPU when the bake ends)
 *   vec3f com        centre of mass, padded voxel coordinates
 *   f32 voxel        cells a voxel
 * Field: voxel (x, y, z) is entry x + dx * (y + dy * z). f32 and grad8: one word an entry. snorm8: four entries a
 * word, low byte first, value / SDF_SNORM_SCALE voxels. Distance is in voxels, negative inside.
 * Sample, one u32: x | y << 8 | z << 16 | open faces << 24 (bits +x -x +y -y +z -z). Its point is the voxel's centre
 * moved half a voxel along each axis that has exactly one open face (a face centre, an edge midpoint, a corner). A
 * voxel with no such axis (a one-voxel plate's inside, a lone voxel) is a ball of half a voxel at its centre.
 */
export const SDF_MODEL_BYTES = 32;

// ---- output ----

/**
 * A contact row, 48 B (WGSL `Contact`; the note's stage 3 row):
 *   u32 a, u32 b      body rows, as the pair gave them
 *   f32 energy        ½ · effective mass · closing² (0 when separating); the pair's whole effective mass at this point
 *   u32 mats          material a | material b << 16
 *   vec3f point       world, midway between the two surfaces
 *   f32 depth         cells; positive overlap, negative a gap inside the margin
 *   vec3f normal      world, unit, from b towards a (move a along it to separate)
 *   f32 closing       speed along the normal at the point, positive when approaching
 * Rows are appended with an atomic counter. The counts buffer (16 B, u32 each): contacts asked for, contacts dropped
 * (asked past the buffer's room), chunks asked for, chunks dropped. A reader takes min(asked, room) rows.
 */
export const CONTACT_BYTES = 48;
export const COUNT_CONTACTS = 0;
export const COUNT_CONTACTS_DROPPED = 1;
export const COUNT_CHUNKS = 2;
export const COUNT_CHUNKS_DROPPED = 3;
export const COUNTS_BYTES = 16;

export interface Contact {
  a: number;
  b: number;
  energy: number;
  matA: number;
  matB: number;
  point: [number, number, number];
  depth: number;
  normal: [number, number, number];
  closing: number;
}

export function unpackContacts(bytes: ArrayBuffer, n: number): Contact[] {
  const f = new Float32Array(bytes);
  const u = new Uint32Array(bytes);
  const out: Contact[] = [];
  for (let i = 0; i < n; i++) {
    const o = i * 12;
    out.push({ a: u[o], b: u[o + 1], energy: f[o + 2], matA: u[o + 3] & 0xffff, matB: u[o + 3] >>> 16, point: [f[o + 4], f[o + 5], f[o + 6]], depth: f[o + 7], normal: [f[o + 8], f[o + 9], f[o + 10]], closing: f[o + 11] });
  }
  return out;
}

/** a sample's word (the model row's comment) */
export function packSample(x: number, y: number, z: number, open: number): number {
  return (x | (y << 8) | (z << 16) | (open << 24)) >>> 0;
}

/** a sample's point (padded voxel coordinates) and its ball's radius (voxels): the rule in the model row's comment */
export function samplePoint(word: number): { p: [number, number, number]; r: number } {
  const open = word >>> 24;
  const o = [0, 1, 2].map((k) => (((open >> (2 * k)) & 1) - ((open >> (2 * k + 1)) & 1)) * 0.5);
  const r = o[0] === 0 && o[1] === 0 && o[2] === 0 ? 0.5 : 0;
  return { p: [(word & 255) + 0.5 + o[0], ((word >> 8) & 255) + 0.5 + o[1], ((word >> 16) & 255) + 0.5 + o[2]], r };
}
