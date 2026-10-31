// Rock that breaks free as a rigid body (round 95, `?rockbody=1`, an experiment). The user: "It could be fun to
// spin up a new rock agent to make the disjoint chunk a rigidbody during falling but I know the rigidbody sim needs
// tuning (still probably worth making an experiment for me to play with and give feedback on)"; round 86: "simulate
// as voxels but split the mesh and have the rock column fall and just weight vertices to voxels (although rock I
// don't expect to flex only crumble)", "a big cloud of dust … and maybe sparks".
//
// A piece the rock judge frees (fracture.ts analyseRock), or one that tips, leaves the columns and becomes one of
// these: its cells (the lattice's, a cell each of its runs) about its centre of mass, its mass and inertia from the
// cells × density, a pose (position, quaternion) and a velocity, linear and angular — a piece that tips starts
// turning about the edge of what it stood on. It is pure CPU and knows the world only through `RockGround` (the
// integrity system's CPU copy of the columns): impulses at its corners against the ground, friction, restitution.
// Drawn as its surface cells rigidly moved (the body-voxel draw, render.wgsl vsBody): nothing meshed again while it
// moves. On a hard hit it crumbles where it struck and breaks into smaller bodies (impact speed against the rock's
// strength: rock crumbles, it doesn't flex); at rest (or after MAX_AGE) Integrity writes its cells back into the
// columns where it lies. Body against body is not simulated: they collide with what is ground.

import { MAT, MATERIALS, MatState } from '../world/materials';
import { cellAt, cellPos, nbr, DIRV, ROW_H } from '../world/lattice';
import { TUNE, worldG } from '../tune/params';
import type { BodySpec, BodyRead, SolverBody } from '../api/contracts/solver';
import { restComOf } from '../solver/build';

export type V3 = [number, number, number];
type Q = [number, number, number, number];
type M3 = number[];

/**
 * The knobs (DECISIONS round 95: for the user to play with): the tuning registry's `rigid` group (src/tune/params.ts,
 * round 108 — the tuning panel sets them live; the old URL names rbgrav, rbrest, … still set them).
 */
export const RB = TUNE.rigid;
/**
 * Whether rock the judge frees falls as these bodies (else the columns' own falling pieces): `?rockbody=1` / `=0`;
 * (round 96, the user: "And then I think push to atlas") on by default in the atlas and the rock lab.
 */
export function rockbodyFor(levelId?: string): boolean {
  const p = typeof location === 'undefined' ? null : new URLSearchParams(location.search).get('rockbody');
  if (p === '1') return true;
  if (p === '0') return false;
  return levelId === 'atlas' || levelId === 'rocklab' || levelId === 'playground';
}

/** (solver step 1) the fixed step: every body moves in whole steps of this, drawn between its last two (drawPose) */
export const SUB_DT = 1 / 120;
/** steps a frame at most (a long frame's rest is dropped, not caught up) */
const MAX_SUBS = 6;
/** (round 108) gravity (the world's × RB.gravity), air drag, rest (restV, restW for restT) and the contacts' slop: RB */
/** settled regardless after this long (s) */
export const MAX_AGE = 20;
/** pieces of a break smaller than this (cells) crumble to rubble */
const MIN_CHUNK = 8;
/** (round 112) the cell visits a body's neck search may make (its tries' floods): ~1 ms on the desktop for the biggest */
const NECK_WORK = 15000;
/** breaks deep: a piece of a piece of a piece doesn't break again */
const MAX_GEN = 2;
/** s after spawning or breaking before a hit can break it */
const GRACE = 0.3;

export interface RockCell {
  /** centre, body frame (cells, about the centre of mass) */
  p: V3;
  mat: number;
  /** the lattice cell it was at spawn (column x, y, z): what touches what, for a break */
  lat: [number, number, number];
}

export interface RockBody {
  id: number;
  cells: RockCell[];
  /** the cells drawn (those with a lattice neighbour missing) */
  surf: RockCell[];
  /** collision points (exposed cube corners, a little inside), body frame */
  pts: V3[];
  /** bounding radius about the centre (cells) */
  radius: number;
  mass: number;
  /** inverse inertia, body frame (row-major 3×3) */
  invI: M3;
  pos: V3;
  q: Q;
  /** (solver step 1) its pose a step before (drawn between that and this: RockBodies.drawPose); unset: as it is */
  prevPos?: V3;
  prevQ?: Q;
  v: V3;
  w: V3;
  age: number;
  still: number;
  grace: number;
  gen: number;
  /** the hardest hit this frame (cells/s) and where (world) */
  hit: number;
  hitAt: V3;
  /** s since its last dust */
  dustT: number;
  /** mean strength of what it's made of; its main material */
  strength: number;
  mat: number;
  /** touching the ground this step */
  contact: boolean;
  /** where its frame's origin was when it broke free (the spawn frame: its cells' p = there − origin, turned by q) */
  origin: V3;
  /** (render/rockmesh.ts) its mesh's slot, if it has one */
  slot?: number;
  /**
   * (round 96) s left of its tip: it's leaning over the edge it tips on — not damped on the ground, not at rest — till it
   * has come down (a hard hit) or this runs out; the first try damped a lean out on its stub in a second and wrote it
   * back where it stood
   */
  tipping: number;
  /**
   * (round 110) overlap with the ground it's allowed (cells): what it overlapped when it became a body — freed in place
   * from the ground round it, its cells whole cubes where the cut was fractional — never pushed out (the user: "When you
   * destroy material around a rock it pushes up out of the earth before becoming a rigidbody"). It only shrinks: to its
   * deepest overlap now, each step, as it moves clear
   */
  allow: number;
  /** (round 110) ground cells (world points) it's cut deep into this frame: crumbled where they meet it, not pushed out of */
  erode: V3[];
  /**
   * (round 112) its centre of mass is over what it touches (the convex hull of its contact points, seen from above,
   * within RB.balanceGive): it can stand. Not balanced, gravity turns it about that support — the ground doesn't damp
   * its spin and it doesn't count as at rest (the user: "The tower just settled at a leaning angle")
   */
  balanced: boolean;
  /** (round 112) s it has been off the ground since it was freed (past 0.15 s its grace ends: RockBody.grace) */
  airborne: number;
  /** (round 112) its thin sections (necks), found once from its shape (findNecks) */
  necks: Neck[];
  /** (round 112) the slowest hit that breaks it at a neck (cells/s): the least over its necks, either side beyond */
  neckV: number;
}

/**
 * (round 112) A thin section of a body: where its medial axis is thin (the distance transform small there) with enough
 * mass on both sides that cutting a ball of that thickness splits it in two. An impact's impulse to stop the part beyond
 * it passes through it: stress = (mass beyond) x speed / area, against the rock's strength (RB.neckStrength).
 */
export interface Neck {
  /** its centre (body frame) and half-thickness (cells) */
  at: V3;
  r: number;
  /** its cross-section (cells^2) */
  area: number;
  /** the two sides: indices into the body's cells (the ball's cells given to the side that reaches them first) */
  sides: [number[], number[]];
  /** each side's mass */
  mass: [number, number];
}

/**
 * What the bodies know of the world: a point (world) in the ground — how deep, and the way out — or null; (round 110)
 * `mass`: what it's in is a thing of that mass (a resting rock), not the ground (absent: the ground, heaviest of all).
 */
export interface RockGround {
  probe(x: number, y: number, z: number): { d: number; n: V3; mass?: number } | null;
  /** the highest ground in this world box (x0, y0, x1, y1), for the broad phase */
  topIn(x0: number, y0: number, x1: number, y1: number): number;
}

/** What `columnsGround` reads of the columns (fracture.ts WorldVox) */
export interface ColumnView {
  matAt(x: number, y: number, z: number): number;
  runTop(x: number, y: number, z: number): number;
  colTop(x: number, y: number): number;
}

/** (round 110) how deep the probe measures (cells): past the largest overlap a body may be allowed (slop + cap, allow) */
export const PROBE_DEPTH = 2;
/** (round 110) the most overlap a body is allowed to keep from where it was freed (cells): under PROBE_DEPTH */
const ALLOW_MAX = 1.2;

/**
 * (round 95; round 110 moved here from integrity.ts, shared with scripts/physfix-cpu.ts) The rigid rock's ground from
 * columns (W × H, window storage): a point in solid or loose ground is pushed out up when it's within 0.6 of its run's
 * top, else sideways through the nearest face with air beside it at that height — (round 110) looked for two rings
 * of columns out, so a point is measured up to PROBE_DEPTH deep: round 95 looked at the six only and called anything
 * past them 1 deep, and a body allowed as much overlap as that (a big rock's slop, what it was freed with) fell
 * through the ground — else straight up, at most PROBE_DEPTH. The window's floor holds. `massAt`: a thing of that
 * mass owns the point (External), not the ground.
 */
export function columnsGround(view: () => ColumnView | null, W: number, H: number, massAt?: (x: number, y: number, z: number) => number | undefined): RockGround {
  const isGround = (m: number) => {
    const s = MATERIALS[m]?.state;
    return s === MatState.Solid || s === MatState.Granular;
  };
  const inMap = (x: number, y: number) => x >= 0 && y >= 0 && x < W && y < H;
  return {
    probe: (wx, wy, wz) => {
      if (wz < 0) return { d: -wz, n: [0, 0, 1] };
      const wv = view();
      if (!wv) return null;
      const [cx, cy] = cellAt(wx, wy);
      if (!inMap(cx, cy)) return null;
      const zq = Math.max(0, wz - 0.5);
      const mat = wv.matAt(cx, cy, zq);
      if (!isGround(mat)) return null;
      const mass = mat === MAT.External && massAt ? massAt(cx, cy, zq) : undefined;
      let t = wv.runTop(cx, cy, zq);
      for (let i = 0; i < 8 && isGround(wv.matAt(cx, cy, t - 0.49)); i++) t = wv.runTop(cx, cy, t - 0.49);
      const up = t - wz;
      if (up < 0.6) return { d: up, n: [0, 0, 1], mass };
      const [px, py] = cellPos(cx, cy);
      let best = Infinity;
      let n: V3 = [0, 0, 1];
      for (let k = 0; k < 6; k++) {
        const [nx, ny] = nbr(cx, cy, k);
        if (inMap(nx, ny) && isGround(wv.matAt(nx, ny, zq))) continue;
        const d = 0.5 - ((wx - px) * DIRV[k][0] + (wy - py) * DIRV[k][1]);
        if (d < best) [best, n] = [d, [DIRV[k][0], DIRV[k][1], 0]];
      }
      if (best === Infinity) {
        // (the next ring: air in a column two out — how far to its near side, the way toward it)
        for (let k = 0; k < 6; k++) {
          const [ax, ay] = nbr(cx, cy, k);
          for (const j of [k, (k + 1) % 6]) {
            const [nx, ny] = nbr(ax, ay, j);
            if (inMap(nx, ny) && isGround(wv.matAt(nx, ny, zq))) continue;
            const [qx, qy] = inMap(nx, ny) ? cellPos(nx, ny) : [px + 2 * (ax - cx), py + 2 * (ay - cy) * ROW_H];
            const dl = Math.hypot(qx - wx, qy - wy);
            const d = dl - 0.5;
            if (d < best && dl > 1e-6) [best, n] = [d, [(qx - wx) / dl, (qy - wy) / dl, 0]];
          }
        }
      }
      if (best >= up || best === Infinity) return { d: Math.min(up, PROBE_DEPTH), n: [0, 0, 1], mass };
      return { d: Math.max(0.01, best), n, mass };
    },
    topIn: (x0, y0, x1, y1) => {
      const wv = view();
      if (!wv) return 0;
      let top = 0;
      const ya = Math.max(0, Math.floor(y0 / ROW_H - 1));
      const yb = Math.min(H - 1, Math.ceil(y1 / ROW_H));
      const xa = Math.max(0, Math.floor(x0 - 1));
      const xb = Math.min(W - 1, Math.ceil(x1));
      for (let y = ya; y <= yb; y++) for (let x = xa; x <= xb; x++) top = Math.max(top, wv.colTop(x, y));
      return top;
    },
  };
}

export interface RockHit {
  body: RockBody;
  speed: number;
  at: V3;
}

// ---- small vector, quaternion, matrix helpers ----
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
function rotM(q: Q): M3 {
  const [x, y, z, w] = q;
  return [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w), 2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w), 2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)];
}
const mv = (m: M3, v: V3): V3 => [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];
const mtv = (m: M3, v: V3): V3 => [m[0] * v[0] + m[3] * v[1] + m[6] * v[2], m[1] * v[0] + m[4] * v[1] + m[7] * v[2], m[2] * v[0] + m[5] * v[1] + m[8] * v[2]];
function inv3(m: M3): M3 {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-9) return [0, 0, 0, 0, 0, 0, 0, 0, 0];
  const s = 1 / det;
  return [A * s, -(b * i - c * h) * s, (b * f - c * e) * s, B * s, (a * i - c * g) * s, -(a * f - c * d) * s, C * s, -(a * h - b * g) * s, (a * e - b * d) * s];
}
/** (solver step 1) a blend of two rotations (the shorter way), normalised */
function nlerp(a: Q, b: Q, t: number): Q {
  const s = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3] < 0 ? -1 : 1;
  const q: Q = [a[0] * (1 - t) + s * b[0] * t, a[1] * (1 - t) + s * b[1] * t, a[2] * (1 - t) + s * b[2] * t, a[3] * (1 - t) + s * b[3] * t];
  const l = Math.hypot(q[0], q[1], q[2], q[3]);
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}
/** a body's 3 × 4 matrix (its spawn frame → world) at a pose */
function poseMatrix(b: RockBody, pos: V3, q: Q): number[] {
  const R = rotM(q);
  const t = sub(pos, mv(R, b.origin));
  return [R[0], R[1], R[2], t[0], R[3], R[4], R[5], t[1], R[6], R[7], R[8], t[2]];
}
/** world inverse inertia × v: R · I⁻¹ · Rᵀ v */
const iw = (b: RockBody, R: M3, v: V3): V3 => mv(R, mv(b.invI, mtv(R, v)));

/** (round 110) a hex prism cell's 12 corners about its centre (pointy-topped: lattice.ts DIRV — corners at 30° + 60°k, 1/√3 out) */
const HEX_CORNERS: V3[] = [];
for (const z of [-0.5, 0.5]) for (let k = 0; k < 6; k++) HEX_CORNERS.push([Math.cos(Math.PI / 6 + (k * Math.PI) / 3) / Math.sqrt(3), Math.sin(Math.PI / 6 + (k * Math.PI) / 3) / Math.sqrt(3), z]);

/**
 * (round 110) The overlap a body of this mass (cells of rock) may make before a contact pushes back: RB.slop, and
 * RB.slopK · mass^RB.slopP up to RB.slopCap (the user: "For physics maybe a tunable parameter for how much objects can
 * interpenetrate maybe as a function of mass?"). A pair meets at the lighter one's: overlap reads as intersecting on
 * the smaller thing — a pebble sunk into a boulder by the boulder's allowance would vanish into it, a boulder on a
 * pebble crushes into it no deeper than the pebble's. The ground is the heaviest of all, so against it a body's own.
 */
export function slopFor(mass: number): number {
  if (!(mass > 0)) return RB.slop;
  return RB.slop + Math.min(RB.slopCap, RB.slopK * Math.pow(mass, RB.slopP));
}

/**
 * (round 112) Is (c's x, y) over the convex hull of these points (world x, y), or within `give` of it? Fewer than three
 * apart: within `give` of the segment (or the point) they make.
 */
export function overSupport(c: V3, pts: [number, number][], give: number): boolean {
  if (!pts.length) return false;
  const q = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const x = (o: [number, number], a: [number, number], b: [number, number]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo: [number, number][] = [];
  for (const p of q) {
    while (lo.length >= 2 && x(lo[lo.length - 2], lo[lo.length - 1], p) <= 1e-9) lo.pop();
    lo.push(p);
  }
  const up: [number, number][] = [];
  for (let i = q.length - 1; i >= 0; i--) {
    const p = q[i];
    while (up.length >= 2 && x(up[up.length - 2], up[up.length - 1], p) <= 1e-9) up.pop();
    up.push(p);
  }
  const hull = lo.slice(0, -1).concat(up.slice(0, -1));
  const segDist = (a: [number, number], b: [number, number]) => {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const l2 = dx * dx + dy * dy;
    const t = l2 > 1e-12 ? Math.max(0, Math.min(1, ((c[0] - a[0]) * dx + (c[1] - a[1]) * dy) / l2)) : 0;
    return Math.hypot(c[0] - a[0] - t * dx, c[1] - a[1] - t * dy);
  };
  if (hull.length < 3) return segDist(q[0], q[q.length - 1]) <= give;
  let inside = true;
  let near = Infinity;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i];
    const b = hull[(i + 1) % hull.length];
    if (x(a, b, [c[0], c[1]]) < 0) inside = false;
    near = Math.min(near, segDist(a, b));
  }
  return inside || near <= give;
}

/**
 * (round 112) A resting body's cells drawn as voxels (the body-voxel draw's 8 words each: centre, material, rotation):
 * its surface cells (lattice cells of its spawn frame) that `drawn` says, at its transform `m` (RockBodies.matrix's rows)
 * -- what of it the rock mesh doesn't draw (what's built: world/materials.ts fieldMeshed), or all of it with no mesh.
 */
export function restingVoxels(cells: { x: number; y: number; z: number; mat: number }[], m: number[], drawn: (mat: number) => boolean): Float32Array {
  const has = new Set(cells.map((c) => latKey(c.x, c.y, c.z)));
  const q = quatOf([m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]]);
  const out: number[] = [];
  const u = new Uint32Array(1);
  const f = new Float32Array(u.buffer);
  for (const c of cells) {
    if (!drawn(c.mat)) continue;
    let open = !has.has(latKey(c.x, c.y, c.z + 1)) || !has.has(latKey(c.x, c.y, c.z - 1));
    for (let d = 0; d < 6 && !open; d++) {
      const [nx, ny] = nbr(c.x, c.y, d);
      if (!has.has(latKey(nx, ny, c.z))) open = true;
    }
    if (!open) continue;
    const [px, py] = cellPos(c.x, c.y);
    const pz = c.z + 0.5;
    u[0] = c.mat;
    out.push(m[0] * px + m[1] * py + m[2] * pz + m[3], m[4] * px + m[5] * py + m[6] * pz + m[7], m[8] * px + m[9] * py + m[10] * pz + m[11], f[0], q[0], q[1], q[2], q[3]);
  }
  return new Float32Array(out);
}

/** (round 110) a rotation matrix (row-major) as a unit quaternion (x, y, z, w) */
function quatOf(m: M3): Q {
  const [a, b, c, d, e, f, g, h, i] = m;
  const t = a + e + i;
  let q: Q;
  if (t > 0) {
    const s = Math.sqrt(t + 1) * 2;
    q = [(h - f) / s, (c - g) / s, (d - b) / s, s / 4];
  } else if (a > e && a > i) {
    const s = Math.sqrt(1 + a - e - i) * 2;
    q = [s / 4, (b + d) / s, (c + g) / s, (h - f) / s];
  } else if (e > i) {
    const s = Math.sqrt(1 + e - a - i) * 2;
    q = [(b + d) / s, s / 4, (f + h) / s, (c - g) / s];
  } else {
    const s = Math.sqrt(1 + i - a - e) * 2;
    q = [(c + g) / s, (f + h) / s, s / 4, (d - b) / s];
  }
  const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}

const densityOf = (m: number) => MATERIALS[m]?.density ?? (MATERIALS[m]?.state === MatState.Vegetation ? 0.4 : 1);
const latKey = (x: number, y: number, z: number) => (z * 8192 + y) * 8192 + x;

/** a little deterministic noise (a break's seeds) */
function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

/**
 * (solver step 2, BACKLOG AR4) What moves the bodies when the GPU node solver does (src/solver: the contract's add,
 * remove and read): RockBodies keeps what the judge needs of each body — its cells, mass, necks, its breaks, the hand-
 * over at rest — and the solver moves it. Without one (the Node tests, the CPU harness, a body fast-forwarded to rest)
 * the CPU step below moves it.
 */
export interface RockEngine {
  add(spec: BodySpec): SolverBody | null;
  remove(b: SolverBody): void;
  read(b: SolverBody): BodyRead | undefined;
}

interface Engined {
  sb: SolverBody;
  /** the solver's centre of mass less the body's (spawn frame): the two weigh materials their own way */
  d: V3;
  /** the last readback taken, and when (ms) */
  tick: number;
  at: number;
}

export class RockBodies {
  list: RockBody[] = [];
  /** (solver step 2) the GPU solver moves the bodies (null: the CPU step) */
  engine: RockEngine | null = null;
  private engined = new Map<RockBody, Engined>();
  private nextId = 1;
  /** while the ground's copy isn't of the window as it is (a slide, until it's read again): nothing moves */
  frozen = false;
  /** (round 110) why bodies were baked into the ground (room, leaving, asked, no mesh, …): counts */
  bakedWhy: Record<string, number> = {};
  stats = { spawned: 0, breaks: 0, settled: 0, capped: 0, maxPts: 0, stepMs: 0, contacts: 0, woken: 0, baked: 0, eroded: 0, allowMax: 0, necks: 0, neckBreaks: 0, neckMs: 0 };

  constructor(private ground: RockGround) {}

  /**
   * A body from lattice cells (column x, y, z: the cell [z, z + 1) of that column), already out of the columns.
   * `tip`: it tips over the edge through `pivot` (world) along `axis` (horizontal): it starts turning about it.
   */
  spawn(cells: { x: number; y: number; z: number; mat: number }[], tip?: { pivot: V3; axis: V3 }): RockBody | null {
    if (!cells.length) return null;
    const world = cells.map((c) => {
      const [wx, wy] = cellPos(c.x, c.y);
      return { p: [wx, wy, c.z + 0.5] as V3, mat: c.mat, lat: [c.x, c.y, c.z] as [number, number, number] };
    });
    const b = this.build(world, [0, 0, 0, 1], [0, 0, 0], 0, [0, 0, 0]);
    if (!b) return null;
    this.stats.spawned++;
    this.allowOverlap(b);
    if (tip) {
      // (round 96: its centre starting at no more than 2 cells/s — a tall piece's lean over a low pivot began at 10,
      // and it shattered on its own stub; nor broken by that first contact)
      const arm = Math.max(1, len(sub(b.pos, tip.pivot)));
      b.w = mul(tip.axis, Math.min(RB.tipSpin, 2 / arm));
      b.v = cross(b.w, sub(b.pos, tip.pivot));
      b.tipping = 4;
      b.grace = 1;
    }
    return b;
  }

  /**
   * (round 110) A sleeping body woken where it lies (a resting rock whose ground went, or that was cut): its cells
   * (lattice cells of its spawn frame) at its transform (spawn frame → world, RockBodies.matrix's rows), still. Its
   * mesh is the one it had (the caller gives it its slot): nothing is meshed again.
   */
  revive(cells: { x: number; y: number; z: number; mat: number }[], m: number[]): RockBody | null {
    if (!cells.length) return null;
    const world = cells.map((c) => {
      const [wx, wy] = cellPos(c.x, c.y);
      return { p: [wx, wy, c.z + 0.5] as V3, mat: c.mat, lat: [c.x, c.y, c.z] as [number, number, number] };
    });
    const q = quatOf([m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]]);
    const b = this.build(world, q, [m[3], m[7], m[11]], 0, [0, 0, 0]);
    if (!b) return null;
    this.stats.woken++;
    this.allowOverlap(b);
    return b;
  }

  /** (round 110) what it overlaps the ground by as it is now: allowed (RockBody.allow) */
  private allowOverlap(b: RockBody): void {
    const R = rotM(b.q);
    let d = 0;
    for (const p of b.pts) {
      const r = mv(R, p);
      const c = this.ground.probe(b.pos[0] + r[0], b.pos[1] + r[1], b.pos[2] + r[2]);
      if (c) d = Math.max(d, c.d);
    }
    b.allow = Math.min(ALLOW_MAX, d);
    this.stats.allowMax = Math.max(this.stats.allowMax, b.allow);
  }

  /** (round 110) the overlap a contact of this body is allowed before it pushes back (slopFor its mass) */
  slopOf(b: RockBody): number {
    return slopFor(b.mass);
  }

  /** a body from cells given in a frame (rotation q, origin o: world = o + R p) */
  private build(cells: { p: V3; mat: number; lat: [number, number, number] }[], q: Q, o: V3, gen: number, origin: V3): RockBody | null {
    if (!cells.length) return null;
    const R = rotM(q);
    let m = 0;
    let c: V3 = [0, 0, 0];
    const mats = new Map<number, number>();
    let str = 0;
    for (const k of cells) {
      const d = densityOf(k.mat);
      m += d;
      c = add(c, mul(k.p, d));
      mats.set(k.mat, (mats.get(k.mat) ?? 0) + 1);
      str += MATERIALS[k.mat]?.strength ?? 1;
    }
    c = mul(c, 1 / m);
    const local: RockCell[] = cells.map((k) => ({ p: sub(k.p, c), mat: k.mat, lat: k.lat }));
    // inertia: each cell a unit cube of its density about the centre
    const I = [0, 0, 0, 0, 0, 0, 0, 0, 0];
    let radius = 0;
    for (const k of local) {
      const d = densityOf(k.mat);
      const [x, y, z] = k.p;
      I[0] += d * (y * y + z * z + 1 / 6);
      I[4] += d * (x * x + z * z + 1 / 6);
      I[8] += d * (x * x + y * y + 1 / 6);
      I[1] -= d * x * y;
      I[2] -= d * x * z;
      I[5] -= d * y * z;
      radius = Math.max(radius, len(k.p) + 0.87);
    }
    I[3] = I[1];
    I[6] = I[2];
    I[7] = I[5];
    let mat = 0;
    let most = -1;
    for (const [k, n] of mats) if (n > most) [mat, most] = [k, n];
    const b: RockBody = {
      id: this.nextId++,
      cells: local,
      surf: [],
      pts: [],
      radius,
      mass: m,
      invI: inv3(I),
      pos: add(o, mv(R, c)),
      q: [...q] as Q,
      v: [0, 0, 0],
      w: [0, 0, 0],
      age: 0,
      still: 0,
      grace: GRACE,
      gen,
      hit: 0,
      hitAt: [0, 0, 0],
      dustT: 0,
      strength: Math.max(0.2, str / cells.length),
      mat,
      contact: false,
      origin: add(origin, c),
      tipping: 0,
      allow: 0,
      erode: [],
      balanced: true,
      airborne: 0,
      necks: [],
      neckV: Infinity,
    };
    this.shape(b);
    if (gen < MAX_GEN) this.findNecks(b);
    this.list.push(b);
    return b;
  }

  /** its surface cells (drawn) and collision points (their cube corners, deduplicated, a little inside) */
  private shape(b: RockBody): void {
    const has = new Set(b.cells.map((k) => latKey(k.lat[0], k.lat[1], k.lat[2])));
    const seen = new Set<string>();
    b.surf = [];
    b.pts = [];
    for (const k of b.cells) {
      const [x, y, z] = k.lat;
      let open = !has.has(latKey(x, y, z + 1)) || !has.has(latKey(x, y, z - 1));
      for (let d = 0; d < 6 && !open; d++) {
        const [nx, ny] = nbr(x, y, d);
        if (!has.has(latKey(nx, ny, z))) open = true;
      }
      if (!open) continue;
      b.surf.push(k);
      // (round 110) the corners of its hex prism, not of a cube: a cube's corners (±0.5, ±0.5) lie in the next columns
      // over (a hex cell is 0.5 to its side faces, 0.577 to its corners) — a body freed from the ground round it began
      // with its corners in that ground and was pushed up out of it (the user's "pushes up out of the earth")
      for (const o of HEX_CORNERS) {
        const p = add(k.p, mul(o, 0.92));
        const key = p.map((v) => Math.round(v * 2)).join(',');
        if (seen.has(key)) continue;
        seen.add(key);
        b.pts.push(p);
      }
    }
    this.stats.maxPts = Math.max(this.stats.maxPts, b.pts.length);
  }

  /**
   * (round 112; the user: "Maybe we can find thin points with a quick JFA based medial axis to find thin areas where mass
   * on either side is large?") Its necks. The distance transform of its cells (lattice steps from the outside: a
   * breadth-first sweep, exact on the lattice -- what a JFA gives on the GPU, where the bodies go with AR4), its medial
   * axis (the cells no neighbour is deeper than, no deeper than RB.neckDepth), and on it the thin places: an axis cell no
   * thicker than the axis cells two steps round it. Each is tried, the thinnest first, one a place: a ball of its
   * thickness taken out, does the rest fall in two, each side at least RB.neckMin cells?
   */
  private findNecks(b: RockBody): void {
    const t0 = performance.now();
    const n = b.cells.length;
    b.necks = [];
    b.neckV = Infinity;
    const least = Math.max(MIN_CHUNK, RB.neckMin);
    if (n < 2 * least) return;
    // (its cells in a box of the lattice, a cell of margin round: the neighbours by index, no hashing)
    let x0 = Infinity;
    let y0 = Infinity;
    let z0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    let z1 = -Infinity;
    for (const k of b.cells) {
      x0 = Math.min(x0, k.lat[0]);
      y0 = Math.min(y0, k.lat[1]);
      z0 = Math.min(z0, k.lat[2]);
      x1 = Math.max(x1, k.lat[0]);
      y1 = Math.max(y1, k.lat[1]);
      z1 = Math.max(z1, k.lat[2]);
    }
    const DX = x1 - x0 + 3;
    const DY = y1 - y0 + 3;
    const box = new Int32Array(DX * DY * (z1 - z0 + 3)).fill(-1);
    const at = (x: number, y: number, z: number) => ((z - z0 + 1) * DY + (y - y0 + 1)) * DX + (x - x0 + 1);
    b.cells.forEach((k, i) => (box[at(k.lat[0], k.lat[1], k.lat[2])] = i));
    const nbrs = new Int32Array(n * 8).fill(-1);
    for (let i = 0; i < n; i++) {
      const [x, y, z] = b.cells[i].lat;
      nbrs[i * 8] = box[at(x, y, z + 1)];
      nbrs[i * 8 + 1] = box[at(x, y, z - 1)];
      for (let d = 0; d < 6; d++) {
        const [nx, ny] = nbr(x, y, d);
        nbrs[i * 8 + 2 + d] = box[at(nx, ny, z)];
      }
    }
    // the distance transform: 1 on the skin, a step deeper each ring in
    const depth = new Int32Array(n);
    let front: number[] = [];
    for (let i = 0; i < n; i++)
      for (let k = 0; k < 8; k++)
        if (nbrs[i * 8 + k] < 0) {
          depth[i] = 1;
          front.push(i);
          break;
        }
    for (let d = 2; front.length; d++) {
      const next: number[] = [];
      for (const i of front)
        for (let k = 0; k < 8; k++) {
          const j = nbrs[i * 8 + k];
          if (j >= 0 && !depth[j]) {
            depth[j] = d;
            next.push(j);
          }
        }
      front = next;
    }
    // the medial axis (thin enough to look at): a cell midway between two sides of the surface along a line through it --
    // shallower on both sides along one of its four axes (up-down, the hex's three), or (an even thickness) shallower on
    // one side and, past a neighbour as deep as it, shallower again. Not a corner: the surface is near it two ways, not
    // across it. Then its thin places.
    const dAt = (j: number) => (j < 0 ? 0 : depth[j]);
    const axis: number[] = [];
    for (let i = 0; i < n; i++) {
      const d = depth[i];
      if (d > RB.neckDepth) continue;
      let ridge = false;
      for (let k = 0; k < 8 && !ridge; k += 2) {
        const a = nbrs[i * 8 + k];
        const c = nbrs[i * 8 + k + 1];
        if (dAt(a) < d && dAt(c) < d) ridge = true;
        else if (dAt(a) < d && c >= 0 && depth[c] === d && dAt(nbrs[c * 8 + k + 1]) < d) ridge = true;
        else if (dAt(c) < d && a >= 0 && depth[a] === d && dAt(nbrs[a * 8 + k]) < d) ridge = true;
      }
      if (ridge) axis.push(i);
    }
    // (each tried, the thinnest first, while the tries' floods cost no more than NECK_WORK cell visits; one neck a place:
    // none within 2 x its thickness + 2 of one found)
    axis.sort((p, q) => depth[p] - depth[q]);
    const dens = b.cells.map((k) => densityOf(k.mat));
    let work = 0;
    const tried: { p: V3; d: number }[] = [];
    const px = new Float32Array(n);
    const py = new Float32Array(n);
    const pz = new Float32Array(n);
    b.cells.forEach((k, j) => ([px[j], py[j], pz[j]] = k.p));
    const stack = new Int32Array(n + 8);
    const ballMark = new Int32Array(n);
    const compMark = new Int32Array(n);
    const comp = new Int32Array(n);
    let tries = 0;
    const countBall = (id: number) => {
      let m = 0;
      for (let j = 0; j < n; j++) if (ballMark[j] === id) m++;
      return m;
    };
    for (const i of axis) {
      if (work > NECK_WORK) break;
      const c = b.cells[i].p;
      const r = depth[i] - 0.5;
      if (b.necks.some((o) => len(sub(o.at, c)) < 2 * Math.max(r, o.r) + 2)) continue;
      // (a ball next to one tried as thick cuts the same: not again)
      if (tried.some((o) => o.d === depth[i] && len(sub(o.p, c)) < 1.6)) continue;
      tried.push({ p: c, d: depth[i] });
      work += n;
      // the ball out (found from its centre through the cells: it's connected), what's left in pieces? (no allocation a
      // try: the marks are this try's number)
      const tryId = ++tries;
      const R2 = (r + 0.75) ** 2;
      let sp = 0;
      stack[sp++] = i;
      ballMark[i] = tryId;
      while (sp) {
        const a = stack[--sp];
        for (let k = 0; k < 8; k++) {
          const q = nbrs[a * 8 + k];
          if (q < 0 || ballMark[q] === tryId) continue;
          const dx = px[q] - c[0];
          const dy = py[q] - c[1];
          const dz = pz[q] - c[2];
          if (dx * dx + dy * dy + dz * dz > R2) continue;
          ballMark[q] = tryId;
          stack[sp++] = q;
        }
      }
      const sizes: number[] = [];
      for (let j = 0; j < n; j++) {
        if (ballMark[j] === tryId || compMark[j] === tryId) continue;
        const id = sizes.length;
        let m = 0;
        stack[sp++] = j;
        compMark[j] = tryId;
        comp[j] = id;
        while (sp) {
          const a = stack[--sp];
          m++;
          for (let k = 0; k < 8; k++) {
            const q = nbrs[a * 8 + k];
            if (q >= 0 && ballMark[q] !== tryId && compMark[q] !== tryId) {
              compMark[q] = tryId;
              comp[q] = id;
              stack[sp++] = q;
            }
          }
        }
        sizes.push(m);
        // (one piece holding everything but the ball: no neck here)
        if (sizes.length === 1 && m + countBall(tryId) >= n) break;
      }
      if (sizes.length < 2) continue;
      // the two biggest sides; the ball (and any crumbs) to whichever side reaches it first
      const order = sizes.map((m, k) => [m, k]).sort((a, q) => q[0] - a[0]);
      if (order[1][0] < least) continue;
      const side = new Int8Array(n).fill(-1);
      let grow: number[] = [];
      for (let j = 0; j < n; j++)
        if (compMark[j] === tryId && (comp[j] === order[0][1] || comp[j] === order[1][1])) {
          side[j] = comp[j] === order[0][1] ? 0 : 1;
          grow.push(j);
        }
      while (grow.length) {
        const next: number[] = [];
        for (const a of grow)
          for (let k = 0; k < 8; k++) {
            const q = nbrs[a * 8 + k];
            if (q >= 0 && side[q] < 0) {
              side[q] = side[a];
              next.push(q);
            }
          }
        grow = next;
      }
      const sides: [number[], number[]] = [[], []];
      const mass: [number, number] = [0, 0];
      for (let j = 0; j < n; j++) {
        const s0 = side[j] < 0 ? 0 : side[j];
        sides[s0].push(j);
        mass[s0] += dens[j];
      }
      const area = Math.max(1, Math.PI * r * r);
      b.necks.push({ at: [...c] as V3, r, area, sides, mass });
      b.neckV = Math.min(b.neckV, (RB.neckStrength * b.strength * area) / Math.max(mass[0], mass[1]));
    }
    this.stats.neckMs = Math.max(this.stats.neckMs, performance.now() - t0);
    this.stats.necks += b.necks.length;
  }

  /**
   * (round 112) A hit beyond a neck: the impulse to stop what lies past the neck from the point hit passes through it --
   * (mass beyond) x speed / area against RB.neckStrength x strength. The worst neck over that breaks: the body in two at
   * it, each side going on as the body moved there (nothing crumbles: it snaps). Null: every neck holds.
   */
  private neckBreak(b: RockBody, speed: number, at: V3): { pieces: RockBody[]; seeds: { s: V3; piece: RockBody | null }[]; hit: V3 } | null {
    if (!b.necks.length || speed < b.neckV) return null;
    const R = rotM(b.q);
    const hit = mtv(R, sub(at, b.pos));
    // (the cell nearest the point hit: the side that took the hit)
    let near = 0;
    let nd = Infinity;
    b.cells.forEach((k, i) => {
      const d = len(sub(k.p, hit));
      if (d < nd) [near, nd] = [i, d];
    });
    // (the side struck stops; what stops the side beyond is its momentum, through the neck)
    let worst: Neck | null = null;
    let ratio = 1;
    for (const nk of b.necks) {
      const struck = nk.sides[0].includes(near) ? 0 : 1;
      const r = (nk.mass[1 - struck] * speed) / nk.area / (RB.neckStrength * b.strength);
      if (r > ratio) [worst, ratio] = [nk, r];
    }
    if (!worst) return null;
    const w0 = worst;
    this.list = this.list.filter((o) => o !== b);
    this.stats.breaks++;
    this.stats.neckBreaks++;
    const pieces: RockBody[] = [];
    const seeds: { s: V3; piece: RockBody | null }[] = [];
    for (const side of w0.sides) {
      const cells = side.map((i) => b.cells[i]);
      const nb = this.build(cells, b.q, b.pos, b.gen + 1, b.origin);
      if (!nb) continue;
      nb.v = add(b.v, cross(b.w, sub(nb.pos, b.pos)));
      nb.w = [...b.w] as V3;
      nb.age = b.age;
      this.allowOverlap(nb);
      pieces.push(nb);
      // (its mesh drawn split between the two till theirs are built: seeds by the neck, at the side's middle, at its far end)
      const byNeck = (k: RockCell) => len(sub(k.p, w0.at));
      let nearNeck = cells[0];
      let far = cells[0];
      let mid: V3 = [0, 0, 0];
      for (const k of cells) {
        if (byNeck(k) < byNeck(nearNeck)) nearNeck = k;
        if (byNeck(k) > byNeck(far)) far = k;
        mid = add(mid, k.p);
      }
      mid = mul(mid, 1 / cells.length);
      for (const p of [nearNeck.p, mid, far.p]) seeds.push({ s: add(p, b.origin), piece: nb });
    }
    return { pieces, seeds, hit: add(hit, b.origin) };
  }

  /**
   * (solver step 1) The sim time owed to the fixed step (s, under SUB_DT after an update) and where the frame lies between
   * a body's last two steps (0..1): drawPose's blend.
   */
  private acc = 0;
  alpha = 1;

  /**
   * A step of every body (dt s of frame time): the hits hard enough to break or to raise dust, and the bodies come to
   * rest. (Solver step 1, the design's choppiness fix: whole steps of SUB_DT, the frame's remainder carried to the next
   * frame and drawn as a blend of the last two steps — it stepped by the frame's own dt before.) With `only`, those
   * bodies take `dt` in whole steps at once (a settle loop), the shared clock untouched.
   */
  update(dt: number, only?: RockBody[]): { hits: RockHit[]; rest: RockBody[]; erode: { body: RockBody; at: V3 }[] } {
    const hits: RockHit[] = [];
    const rest: RockBody[] = [];
    const erode: { body: RockBody; at: V3 }[] = [];
    if (this.frozen || !this.list.length || dt <= 0) return { hits, rest, erode };
    const t0 = performance.now();
    if (this.engine && !only) return this.fromEngine(dt, hits, rest, erode, t0);
    let n: number;
    if (only) n = Math.max(1, Math.round(dt / SUB_DT));
    else {
      this.acc += dt;
      n = Math.min(MAX_SUBS, Math.floor(this.acc / SUB_DT));
      this.acc = Math.min(this.acc - n * SUB_DT, SUB_DT);
      this.alpha = this.acc / SUB_DT;
    }
    const h = SUB_DT;
    dt = n * h;
    if (n === 0) return { hits, rest, erode };
    for (const b of only ?? this.list) {
      b.hit = 0;
      b.erode = [];
      // (the broad phase once a frame: the highest ground it could reach this frame)
      const r0 = b.radius + len(b.v) * dt + 0.5;
      const top = this.ground.topIn(b.pos[0] - r0, b.pos[1] - r0, b.pos[0] + r0, b.pos[1] + r0);
      for (let s = 0; s < n; s++) {
        b.prevPos = b.pos;
        b.prevQ = b.q;
        this.substep(b, h, top);
      }
      b.age += dt;
      b.grace -= dt;
      // (round 112) the grace is for the contact it was freed in (its stub, the ground it was cut from): once it has left
      // the ground it ends, and what it comes down on can break it — a leg cut at its foot dropped 4.5 cells, struck at
      // 9.2 cells/s, over its break speed, and stood whole (the user's "The thin stone protrusion survived a fall")
      if (!b.contact) b.airborne += dt;
      if (b.airborne > 0.15) b.grace = Math.min(b.grace, 0);
      // (a lean ends when it has come down hard, or in time)
      if (b.tipping > 0) b.tipping = b.hit > 3 && b.age > 0.3 ? 0 : b.tipping - dt;
      b.dustT += dt;
      if (b.hit > 1.5 && (b.dustT > 0.25 || b.hit > this.breakSpeedOf(b) || b.hit > b.neckV)) {
        b.dustT = 0;
        hits.push({ body: b, speed: b.hit, at: b.hitAt });
      }
      if (b.still > RB.restT || b.age > MAX_AGE) rest.push(b);
      for (const at of b.erode) erode.push({ body: b, at });
    }
    this.stats.stepMs = performance.now() - t0;
    return { hits, rest, erode };
  }

  /**
   * (solver step 2) The frame with the GPU solver moving the bodies: new ones handed to it, gone ones taken out, and
   * each one's latest readback taken (a tick or two late) — its pose (drawn between the last two read), velocity, what
   * it hit and how hard, the ground it cut too deep into, whether it's at rest — the same summary the CPU step makes,
   * for the judge (breaks, dust, the hand-over at rest).
   */
  private fromEngine(dt: number, hits: RockHit[], rest: RockBody[], erode: { body: RockBody; at: V3 }[], t0: number): { hits: RockHit[]; rest: RockBody[]; erode: { body: RockBody; at: V3 }[] } {
    const eng = this.engine!;
    const live = new Set(this.list);
    for (const [b, e] of this.engined) {
      if (live.has(b)) continue;
      eng.remove(e.sb);
      this.engined.delete(b);
    }
    const now = performance.now();
    for (const b of this.list) {
      const e = this.engage(b, now);
      if (!e) continue;
      b.hit = 0;
      b.erode = [];
      const r = eng.read(e.sb);
      if (r && r.tick !== e.tick) {
        e.tick = r.tick;
        e.at = now;
        b.prevPos = b.pos;
        b.prevQ = b.q;
        const R = rotM(r.q);
        b.pos = sub(r.pos, mv(R, e.d));
        b.q = r.q;
        b.v = r.vel;
        b.w = r.spin;
        b.contact = r.touching > 0;
        if (r.impact) {
          b.hit = r.impact.speed;
          b.hitAt = r.impact.at;
        }
        b.erode = r.erode;
        b.still = r.asleep ? RB.restT + 1 : 0;
        b.allow = Math.min(b.allow, ALLOW_MAX);
      }
      b.age += dt;
      b.grace -= dt;
      if (!b.contact) b.airborne += dt;
      if (b.airborne > 0.15) b.grace = Math.min(b.grace, 0);
      b.dustT += dt;
      if (b.hit > 1.5 && (b.dustT > 0.25 || b.hit > this.breakSpeedOf(b) || b.hit > b.neckV)) {
        b.dustT = 0;
        hits.push({ body: b, speed: b.hit, at: b.hitAt });
      }
      if (b.still > RB.restT || b.age > MAX_AGE) rest.push(b);
      for (const at of b.erode) erode.push({ body: b, at });
    }
    // (drawn between its last two readbacks: they come a tick apart)
    const lastAt = Math.max(0, ...[...this.engined.values()].map((e) => e.at));
    this.alpha = Math.min(1, Math.max(0, (now - lastAt) / (SUB_DT * 2000)));
    this.stats.stepMs = performance.now() - t0;
    return { hits, rest, erode };
  }

  /** (solver step 2) the node solver's body carrying this one (null: not handed over yet, or the CPU step moves it) */
  engineBody(b: RockBody): SolverBody | null {
    return this.engined.get(b)?.sb ?? null;
  }

  /**
   * (solver step 2) Handed to the GPU solver now if it isn't yet (its pose written where it is): the frame a body is
   * made or broken off is drawn from the solver's pose like every frame after (round 120: a piece drawn first by its
   * own CPU pose, a readback behind, then by the solver's, jumped and changed its look). Null: no solver, or no room.
   */
  engage(b: RockBody, now = performance.now()): Engined | null {
    const eng = this.engine;
    if (!eng || !this.list.includes(b)) return null;
    let e = this.engined.get(b);
    if (e) return e;
    const cells = b.cells.map((k) => ({ x: k.lat[0], y: k.lat[1], z: k.lat[2], mat: k.mat }));
    // (the solver's centre of mass, its materials weighed its own way, sits d from the body's: placed by it)
    const d = sub(restComOf(cells), b.origin);
    const sb = eng.add({ cells, pose: { pos: add(b.pos, mv(rotM(b.q), d)), q: b.q }, vel: b.v, spin: b.w, allow: b.allow, kind: 'rigid' });
    if (!sb) return null;
    e = { sb, d, tick: -1, at: now };
    this.engined.set(b, e);
    return e;
  }

  private substep(b: RockBody, h: number, top: number): void {
    // gravity (the world's: solver step 1, AR9), air; no top speed (AR10: it was capped at 14); the spin damped
    b.v[2] -= worldG() * RB.gravity * h;
    const drag = Math.exp(-RB.airDrag * h);
    b.v = mul(b.v, drag);
    b.w = mul(b.w, Math.exp(-RB.angDamp * h));
    const R = rotM(b.q);
    // the contacts: its corners in the ground (only those low enough to reach it)
    const r0 = b.radius;
    const contacts: { r: V3; n: V3; d: number; slop: number; mass?: number }[] = [];
    if (b.pos[2] - r0 <= top + 0.5)
      for (const p of b.pts) {
        const r = mv(R, p);
        const wz = b.pos[2] + r[2];
        if (wz > top + 0.05 && wz > 0) continue;
        const c = this.ground.probe(b.pos[0] + r[0], b.pos[1] + r[1], wz);
        if (c) contacts.push({ r, n: c.n, d: c.d, slop: 0, mass: c.mass });
      }
    b.contact = contacts.length > 0;
    // (round 112) standing or toppling: its centre of mass over the hull of what it touches (every point in the ground,
    // the slop's too — sunk in, the support is still the footprint it sank with)
    b.balanced = !b.contact || overSupport(b.pos, contacts.map((c) => [b.pos[0] + c.r[0], b.pos[1] + c.r[1]] as [number, number]), RB.balanceGive);
    this.stats.contacts = Math.max(this.stats.contacts, contacts.length);
    // (round 110) soft contacts: a point is met only past the slop — by its mass (slopFor: a big rock cuts visibly into
    // the ground first, the user's "We don't want collision to kick in until they are visibly intersecting for large
    // objects"; against a resting rock the lighter one's) or the overlap it was freed with (b.allow), whichever is more
    let deepest = 0;
    for (const c of contacts) deepest = Math.max(deepest, c.d);
    b.allow = Math.min(b.allow, deepest);
    const own = this.slopOf(b);
    for (const c of contacts) c.slop = Math.max(b.allow, c.mass === undefined ? own : Math.min(own, slopFor(c.mass)));
    for (let i = contacts.length - 1; i >= 0; i--) if (contacts[i].d <= contacts[i].slop) contacts.splice(i, 1);
    if (contacts.length) {
      // impulses, two sweeps (the bounce only on the first), friction against each contact's normal impulse
      const invM = 1 / b.mass;
      const jn = new Float64Array(contacts.length);
      for (let it = 0; it < 2; it++) {
        for (let i = 0; i < contacts.length; i++) {
          const { r, n } = contacts[i];
          const vp = add(b.v, cross(b.w, r));
          const vn = dot(vp, n);
          if (it === 0 && -vn > b.hit) {
            b.hit = -vn;
            b.hitAt = add(b.pos, r);
          }
          if (vn < 0) {
            const e = it === 0 && -vn > 1.5 ? RB.restitution : 0;
            const k = invM + dot(n, cross(iw(b, R, cross(r, n)), r));
            const j = (-(1 + e) * vn) / k;
            jn[i] += j;
            this.impulse(b, R, r, mul(n, j));
          }
          // friction
          const vp2 = add(b.v, cross(b.w, r));
          const vt = sub(vp2, mul(n, dot(vp2, n)));
          const vtl = len(vt);
          if (vtl > 1e-5 && jn[i] > 0) {
            const t = mul(vt, 1 / vtl);
            const kt = invM + dot(t, cross(iw(b, R, cross(r, t)), r));
            const jt = Math.min(vtl / kt, RB.friction * jn[i]);
            this.impulse(b, R, r, mul(t, -jt));
          }
        }
      }
      // (round 110) settled out of the ground, not pushed: the deepest first, each only as far as the others haven't
      // already, at no more than RB.pushV (a position change: it gains no speed); a point cut deeper than RB.erodeDepth
      // past the slop isn't pushed out of the ground at all — the ground there crumbles (DECISIONS round 106: "For deep
      // overlap the preferred fix is to erode material where the bodies meet, not push them apart")
      contacts.sort((a, c) => c.d - a.d);
      let corr: V3 = [0, 0, 0];
      for (let i = 0; i < Math.min(8, contacts.length); i++) {
        const { n, d, r, slop, mass } = contacts[i];
        // (a resting rock isn't eroded: it's met at the lighter's overlap and pushed off as the ground is)
        if (mass === undefined && d - slop > RB.erodeDepth && b.erode.length < RB.erodeMax) {
          b.erode.push(add(b.pos, r));
          continue;
        }
        const need = Math.min(d, slop + RB.erodeDepth) - slop - dot(corr, n);
        if (need > 0) corr = add(corr, mul(n, need));
      }
      const cl = len(corr);
      const most = RB.pushV * h;
      if (cl > most) corr = mul(corr, most / cl);
      b.pos = add(b.pos, corr);
    }
    // integrate
    b.pos = add(b.pos, mul(b.v, h));
    const [wx, wy, wz] = b.w;
    const [x, y, z, w] = b.q;
    const hh = 0.5 * h;
    const q: Q = [x + hh * (wx * w + wy * z - wz * y), y + hh * (wy * w + wz * x - wx * z), z + hh * (wz * w + wx * y - wy * x), w - hh * (wx * x + wy * y + wz * z)];
    const ql = Math.hypot(q[0], q[1], q[2], q[3]);
    b.q = [q[0] / ql, q[1] / ql, q[2] / ql, q[3] / ql];
    // (round 96) touching: the spin and the slide damped (a landed piece stays down) — (round 112) only standing: one
    // whose centre of mass is past its support is falling over it, and damping that held a tall pillar's topple to a
    // crawl it then came to rest in, leaning
    if (b.contact && b.balanced && RB.contactDamp > 0 && b.tipping <= 0) {
      const k = Math.exp(-RB.contactDamp * h);
      b.w = mul(b.w, k);
      b.v = [b.v[0] * k, b.v[1] * k, b.v[2]];
    }
    if (b.contact && b.balanced && b.tipping <= 0 && len(b.v) < RB.restV && len(b.w) < RB.restW) b.still += h;
    else b.still = 0;
  }

  private impulse(b: RockBody, R: M3, r: V3, J: V3): void {
    b.v = add(b.v, mul(J, 1 / b.mass));
    b.w = add(b.w, iw(b, R, cross(r, J)));
  }

  /**
   * A hard hit (speed cells/s at world point `at`): it crumbles round the point (rubble: its cells there, world
   * centres) and breaks into a few bodies, each going on as the body moved, thrown a little apart; the smallest crumble
   * too. Below the rock's strength (RB.breakSpeed × √strength) nothing happens (null).
   */
  breakAt(
    b: RockBody,
    speed: number,
    at: V3,
  ): { rubble: { p: V3; mat: number }[]; pieces: RockBody[]; seeds: { s: V3; piece: RockBody | null }[]; hit: V3; rad: number } | null {
    const thr = this.breakSpeedOf(b);
    if (b.grace > 0 || b.gen >= MAX_GEN) return null;
    // (round 112) under what shatters it, a thin section may still snap
    if (speed < thr) {
      const nk = this.neckBreak(b, speed, at);
      return nk ? { rubble: [], pieces: nk.pieces, seeds: nk.seeds, hit: nk.hit, rad: 0 } : null;
    }
    const R = rotM(b.q);
    const hit = mtv(R, sub(at, b.pos));
    const toWorld = (p: V3) => add(b.pos, mv(R, p));
    const rad = Math.min(3 * RB.crumble, (0.8 + 0.35 * (speed - thr)) * RB.crumble);
    const rubble: { p: V3; mat: number }[] = [];
    const rest: RockCell[] = [];
    for (const k of b.cells) {
      if (len(sub(k.p, hit)) < rad) rubble.push({ p: toWorld(k.p), mat: k.mat });
      else rest.push(k);
    }
    // the rest into k parts round random seeds; each part's connected pieces
    const parts = !rest.length ? 0 : rest.length < 3 * MIN_CHUNK ? 1 :Math.min(Math.round(6 * RB.crumble), 2 + Math.floor((((speed / thr) ** 2 - 1) * rest.length * RB.crumble) / 600));
    const rand = rng(b.id * 7919 + Math.floor(speed * 100));
    const seeds: V3[] = [];
    for (let i = 0; i < parts; i++) seeds.push(rest[Math.floor(rand() * rest.length)].p);
    const groups: RockCell[][] = Array.from({ length: parts }, () => []);
    for (const k of rest) {
      let best = 0;
      let bd = Infinity;
      for (let i = 0; i < parts; i++) {
        const d = len(sub(k.p, seeds[i]));
        if (d < bd) [best, bd] = [i, d];
      }
      groups[best].push(k);
    }
    this.list = this.list.filter((o) => o !== b);
    this.stats.breaks++;
    const pieces: RockBody[] = [];
    // (each seed, in the spawn frame, and the biggest piece its part made: the parent's mesh is drawn split by them)
    const seedOut: { s: V3; piece: RockBody | null }[] = seeds.map((s) => ({ s: add(s, b.origin), piece: null }));
    for (let gi = 0; gi < groups.length; gi++) {
      const g = groups[gi];
      const byKey = new Map(g.map((k) => [latKey(k.lat[0], k.lat[1], k.lat[2]), k]));
      const done = new Set<RockCell>();
      for (const k0 of g) {
        if (done.has(k0)) continue;
        const comp = [k0];
        done.add(k0);
        for (let i = 0; i < comp.length; i++) {
          const [x, y, z] = comp[i].lat;
          const nb: [number, number, number][] = [[x, y, z + 1], [x, y, z - 1]];
          for (let d = 0; d < 6; d++) {
            const [nx, ny] = nbr(x, y, d);
            nb.push([nx, ny, z]);
          }
          for (const [nx, ny, nz] of nb) {
            const o = byKey.get(latKey(nx, ny, nz));
            if (o && !done.has(o)) {
              done.add(o);
              comp.push(o);
            }
          }
        }
        if (comp.length < MIN_CHUNK) {
          for (const k of comp) rubble.push({ p: toWorld(k.p), mat: k.mat });
          continue;
        }
        const nbBody = this.build(comp, b.q, b.pos, b.gen + 1, b.origin);
        if (!nbBody) continue;
        if (!seedOut[gi].piece || seedOut[gi].piece!.cells.length < nbBody.cells.length) seedOut[gi].piece = nbBody;
        // it goes on as the body moved at its centre, thrown apart from the point hit — sideways only, and (round 110)
        // never faster up than the body was going: a break thrown up from the ground it hit jumped pieces 3 cells
        // ("separation never adds speed", DECISIONS round 106)
        const rc = sub(nbBody.pos, b.pos);
        const away: V3 = [nbBody.pos[0] - at[0], nbBody.pos[1] - at[1], 0];
        const al = len(away) || 1;
        nbBody.v = add(add(b.v, cross(b.w, rc)), mul(away, (RB.scatter * speed) / al));
        nbBody.v[2] = Math.min(nbBody.v[2], Math.max(0, b.v[2]));
        nbBody.w = [...b.w] as V3;
        nbBody.age = b.age;
        // (round 110: born where the body was, cut into the ground as it was — that overlap allowed, not pushed out)
        this.allowOverlap(nbBody);
        pieces.push(nbBody);
      }
    }
    return { rubble, pieces, seeds: seedOut, hit: add(hit, b.origin), rad };
  }

  /** spawn frame → world, rows of a 3×4 (rotation | translation): what its mesh is drawn with */
  matrix(b: RockBody): number[] {
    return poseMatrix(b, b.pos, b.q);
  }

  /** (solver step 1) where it is drawn this frame: between its last two steps by `alpha` (its pose as is: matrix) */
  drawPose(b: RockBody): { pos: V3; q: Q } {
    const a = this.alpha;
    if (!b.prevPos || !b.prevQ || a >= 1) return { pos: b.pos, q: b.q };
    return { pos: add(mul(b.prevPos, 1 - a), mul(b.pos, a)), q: nlerp(b.prevQ, b.q, a) };
  }

  /** (solver step 1) the matrix it is drawn with this frame (drawPose's) */
  drawMatrix(b: RockBody): number[] {
    const { pos, q } = this.drawPose(b);
    return poseMatrix(b, pos, q);
  }

  /** its cells as lattice cells of the spawn frame (column x, y, cell z): what its mesh is made from */
  latCells(b: RockBody): { x: number; y: number; z: number; mat: number }[] {
    return b.cells.map((k) => ({ x: k.lat[0], y: k.lat[1], z: k.lat[2], mat: k.mat }));
  }

  /** (round 96) the impact speed that breaks it: its strength's, less for a big piece (the square-cube law: RB.sizeK) */
  breakSpeedOf(b: RockBody): number {
    return RB.breakSpeed * Math.sqrt(b.strength) * Math.pow(Math.max(1, b.cells.length) / 200, -RB.sizeK);
  }

  /** (round 112) its surface cells' centres in the world as it lies now, with its rotation (the body-voxel draw's) */
  surfWorld(b: RockBody): { p: V3; mat: number; q: Q }[] {
    const R = rotM(b.q);
    return b.surf.map((k) => ({ p: add(b.pos, mv(R, k.p)), mat: k.mat, q: [...b.q] as Q }));
  }

  /** its cells' centres in the world as it lies now */
  worldCells(b: RockBody): { p: V3; mat: number }[] {
    const R = rotM(b.q);
    return b.cells.map((k) => ({ p: add(b.pos, mv(R, k.p)), mat: k.mat }));
  }

  remove(b: RockBody): void {
    this.list = this.list.filter((o) => o !== b);
  }

  /** the window moved by (dx, dy, dz) world cells: every body with the land */
  shift(dx: number, dy: number, dz: number): void {
    for (const b of this.list) {
      b.pos = [b.pos[0] - dx, b.pos[1] - dy, b.pos[2] - dz];
      if (b.prevPos) b.prevPos = [b.prevPos[0] - dx, b.prevPos[1] - dy, b.prevPos[2] - dz];
    }
  }

  /** the world box a body may cover (x0, y0, x1, y1) */
  box(b: RockBody): [number, number, number, number] {
    return [b.pos[0] - b.radius, b.pos[1] - b.radius, b.pos[0] + b.radius, b.pos[1] + b.radius];
  }

  /** cells drawn */
  get drawn(): number {
    let n = 0;
    for (const b of this.list) n += b.surf.length;
    return n;
  }

  /**
   * Their surface cells for the body-voxel draw (Bodies.pack's form: centre xyz, material, quaternion), from `o` (in
   * 8-word voxels); `which`: those cells only (round 112: by cell — a body's mesh has only what the field mesh draws,
   * its built cells are drawn here)
   */
  packInto(f: Float32Array, u: Uint32Array, o: number, max: number, which: (b: RockBody, k: RockCell) => boolean = () => true): number {
    let n = o;
    for (const b of this.list) {
      const { pos, q } = this.drawPose(b);
      const R = rotM(q);
      for (const k of b.surf) {
        if (!which(b, k)) continue;
        if (n >= max) return n;
        const p = mv(R, k.p);
        const i = n * 8;
        f[i] = pos[0] + p[0];
        f[i + 1] = pos[1] + p[1];
        f[i + 2] = pos[2] + p[2];
        u[i + 3] = k.mat;
        f[i + 4] = q[0];
        f[i + 5] = q[1];
        f[i + 6] = q[2];
        f[i + 7] = q[3];
        n++;
      }
    }
    return n;
  }
}
