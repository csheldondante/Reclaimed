// Rigid bodies (round 14, BACKLOG F7): pieces of structures that broke free
// tumble as rigid voxel bodies (Noita-style), collide with the voxel world (a
// CPU read-back of the layers), and when they come to rest are turned back
// into voxels by inverse sampling — every world cell in the body's bounds
// looks up the body voxel it falls in, so a tilted slab lands as a jaggy
// tilted slab with no holes. Just before that, a nudge toward the nearest
// face-down orientation keeps most landings clean.

import type { Voxel, WorldVox } from './fracture';

type V3 = [number, number, number];
type Q = [number, number, number, number]; // x, y, z, w

const G = 22; // cells/s² (a little floatier than 1 g at a metre a cell)
const RESTITUTION = 0.15;
const FRICTION = 0.6;
const SUBSTEPS = 2;
const ITERATIONS = 4;
/** below these speeds (cells/s, rad/s) for SLEEP_T a body settles */
const SLEEP_V = 0.5;
const SLEEP_W = 0.5;
const SLEEP_T = 0.5;
/** bodies settle regardless after this long (s) */
const MAX_AGE = 14;

export interface Body {
  /** voxels relative to the centre of mass (offsets of voxel centres) */
  local: { p: V3; mat: number }[];
  /** collision points (exposed voxel corners), relative to the centre of mass */
  points: V3[];
  pos: V3;
  q: Q;
  v: V3;
  w: V3;
  invMass: number;
  /** inverse inertia tensor in body space (row-major 3×3) */
  invI: number[];
  slow: number;
  age: number;
  /** strongest impact this step (cells/s), for crumbling and sound */
  impact: number;
}

// ---- small vector helpers -----------------------------------------------------
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);

export function rotate(q: Q, v: V3): V3 {
  const u: V3 = [q[0], q[1], q[2]];
  const t = scale(cross(u, v), 2);
  return add(add(v, scale(t, q[3])), cross(u, t));
}
function conj(q: Q): Q {
  return [-q[0], -q[1], -q[2], q[3]];
}
function qmul(a: Q, b: Q): Q {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}
function qnorm(q: Q): Q {
  const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}
function mat3mul(m: number[], v: V3): V3 {
  return [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];
}
function invert3(m: number[]): number[] {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C || 1e-9;
  return [A / det, -(b * i - c * h) / det, (b * f - c * e) / det, B / det, (a * i - c * g) / det, -(a * f - c * d) / det, C / det, -(a * h - b * g) / det, (a * e - b * d) / det];
}
/** world-space inverse inertia applied to a vector: R · I⁻¹ · Rᵀ · v */
function applyInvI(b: Body, v: V3): V3 {
  return rotate(b.q, mat3mul(b.invI, rotate(conj(b.q), v)));
}

/** The 24 axis-aligned orientations (for settling face-down). */
const AXIS_QS: Q[] = (() => {
  const out: Q[] = [];
  const h = Math.SQRT1_2;
  const base: Q[] = [
    [0, 0, 0, 1],
    [h, 0, 0, h],
    [1, 0, 0, 0],
    [-h, 0, 0, h],
    [0, h, 0, h],
    [0, -h, 0, h],
  ];
  const spins: Q[] = [
    [0, 0, 0, 1],
    [0, 0, h, h],
    [0, 0, 1, 0],
    [0, 0, -h, h],
  ];
  for (const s of spins) for (const b of base) out.push(qnorm(qmul(s, b)));
  return out;
})();

export class Bodies {
  list: Body[] = [];
  /** called with the voxels (world cells) of a body that has come to rest */
  onSettle?: (cells: Voxel[], body: Body) => void;
  /** called when a body hits hard (impact speed, world point) */
  onImpact?: (speed: number, at: V3) => void;

  constructor(public world: WorldVox) {}

  /** A body from world voxels (they must already be removed from the world). */
  spawn(cells: Voxel[], kick: V3 = [0, 0, 0]): Body | null {
    if (!cells.length) return null;
    let c: V3 = [0, 0, 0];
    for (const v of cells) c = add(c, [v.x + 0.5, v.y + 0.5, v.z + 0.5]);
    c = scale(c, 1 / cells.length);
    const local = cells.map((v) => ({ p: sub([v.x + 0.5, v.y + 0.5, v.z + 0.5], c), mat: v.mat }));
    // inertia of unit cubes of unit mass about the centre of mass
    const I = [0, 0, 0, 0, 0, 0, 0, 0, 0];
    for (const { p } of local) {
      const r2 = dot(p, p);
      I[0] += r2 - p[0] * p[0] + 1 / 6;
      I[4] += r2 - p[1] * p[1] + 1 / 6;
      I[8] += r2 - p[2] * p[2] + 1 / 6;
      I[1] -= p[0] * p[1];
      I[2] -= p[0] * p[2];
      I[5] -= p[1] * p[2];
    }
    I[3] = I[1];
    I[6] = I[2];
    I[7] = I[5];
    // collision points: corners of voxels on the surface (deduplicated)
    const occ = new Set(cells.map((v) => `${v.x},${v.y},${v.z}`));
    const seen = new Set<string>();
    let points: V3[] = [];
    for (const v of cells) {
      const exposed = [
        [1, 0, 0],
        [-1, 0, 0],
        [0, 1, 0],
        [0, -1, 0],
        [0, 0, 1],
        [0, 0, -1],
      ].some(([dx, dy, dz]) => !occ.has(`${v.x + dx},${v.y + dy},${v.z + dz}`));
      if (!exposed) continue;
      for (let k = 0; k < 8; k++) {
        const p: V3 = [v.x + (k & 1), v.y + ((k >> 1) & 1), v.z + (k >> 2)];
        const key = p.join(',');
        if (seen.has(key)) continue;
        seen.add(key);
        points.push(sub(p, c));
      }
    }
    if (points.length > 600) points = points.filter((_, i) => i % Math.ceil(points.length / 600) === 0);
    const b: Body = { local, points, pos: c, q: [0, 0, 0, 1], v: kick, w: [0, 0, 0], invMass: 1 / cells.length, invI: invert3(I), slow: 0, age: 0, impact: 0 };
    this.list.push(b);
    return b;
  }

  /** Is there solid world at this point? (cells, off-map = air) */
  private solid(p: V3): number {
    return this.world.matAt(Math.floor(p[0]), Math.floor(p[1]), Math.floor(p[2]));
  }

  /** The way out of the solid cell a point is in: normal and depth. */
  private contact(p: V3): { n: V3; depth: number } | null {
    const x = Math.floor(p[0]);
    const y = Math.floor(p[1]);
    const z = Math.floor(p[2]);
    if (z < 0) return { n: [0, 0, 1], depth: -p[2] };
    if (!this.solid(p)) return null;
    // up, out of the top of this solid run; or sideways into open air
    let best: { n: V3; depth: number } = { n: [0, 0, 1], depth: this.world.runTop(x, y, z) - p[2] };
    const sides: [V3, number][] = [
      [[1, 0, 0], x + 1 - p[0]],
      [[-1, 0, 0], p[0] - x],
      [[0, 1, 0], y + 1 - p[1]],
      [[0, -1, 0], p[1] - y],
    ];
    for (const [n, d] of sides) {
      if (d < best.depth && !this.world.matAt(x + n[0], y + n[1], z)) best = { n, depth: d };
    }
    return best;
  }

  update(dt: number): void {
    const h = dt / SUBSTEPS;
    for (let s = 0; s < SUBSTEPS; s++) for (const b of this.list) this.step(b, h);
    const done: Body[] = [];
    for (const b of this.list) {
      b.age += dt;
      const resting = len(b.v) < SLEEP_V && len(b.w) < SLEEP_W;
      b.slow = resting ? b.slow + dt : 0;
      if (b.pos[2] < -20) done.push(b); // fell off the world
      else if (b.slow > SLEEP_T || b.age > MAX_AGE) {
        this.settle(b);
        done.push(b);
      }
    }
    if (done.length) this.list = this.list.filter((b) => !done.includes(b));
  }

  private step(b: Body, h: number): void {
    b.v[2] -= G * h;
    b.impact = 0;
    // a slow body is nudged toward lying face-down (clean landings)
    if (len(b.v) < 2 && len(b.w) < 2) {
      const target = nearestAxis(b.q);
      const dq = qmul(target, conj(b.q));
      const sgn = dq[3] < 0 ? -1 : 1;
      b.w = add(b.w, scale([dq[0] * sgn, dq[1] * sgn, dq[2] * sgn], 4 * h));
    }
    for (let it = 0; it < ITERATIONS; it++) {
      let pushN: V3 = [0, 0, 0];
      let pushD = 0;
      for (const pl of b.points) {
        const r = rotate(b.q, pl);
        const p = add(b.pos, r);
        const c = this.contact(p);
        if (!c) continue;
        const vp = add(b.v, cross(b.w, r));
        const vn = dot(vp, c.n);
        if (c.depth > pushD) {
          pushD = c.depth;
          pushN = c.n;
        }
        if (vn >= 0) continue;
        if (it === 0) b.impact = Math.max(b.impact, -vn);
        const rn = cross(r, c.n);
        const k = b.invMass + dot(cross(applyInvI(b, rn), r), c.n);
        const j = (-(1 + RESTITUTION) * vn) / k;
        let imp = scale(c.n, j);
        // friction against the sliding velocity
        const vt = sub(vp, scale(c.n, vn));
        const vtl = len(vt);
        if (vtl > 1e-4) {
          const t = scale(vt, 1 / vtl);
          const rt = cross(r, t);
          const kt = b.invMass + dot(cross(applyInvI(b, rt), r), t);
          const jt = Math.min(vtl / kt, FRICTION * j);
          imp = sub(imp, scale(t, jt));
        }
        b.v = add(b.v, scale(imp, b.invMass));
        b.w = add(b.w, applyInvI(b, cross(r, imp)));
      }
      // push out of the deepest penetration a little each iteration
      if (pushD > 0.01) b.pos = add(b.pos, scale(pushN, pushD * 0.3));
    }
    b.v = scale(b.v, 0.999);
    b.w = scale(b.w, 0.985);
    b.pos = add(b.pos, scale(b.v, h));
    const wq: Q = [b.w[0], b.w[1], b.w[2], 0];
    const dq = qmul(wq, b.q);
    b.q = qnorm([b.q[0] + dq[0] * 0.5 * h, b.q[1] + dq[1] * 0.5 * h, b.q[2] + dq[2] * 0.5 * h, b.q[3] + dq[3] * 0.5 * h]);
    if (b.impact > 10) this.onImpact?.(b.impact, b.pos);
  }

  /**
   * Back to voxels: snap to the nearest face-down orientation, inverse-sample
   * the world cells in the bounds, then drop the set until it rests on
   * something (snapping can leave it a fraction above the ground).
   */
  private settle(b: Body): void {
    const q = nearestAxis(b.q);
    const inv = conj(q);
    // body voxels sit on an integer lattice offset from the centre of mass by o
    const o = b.local[0].p;
    const lookup = new Map<string, number>();
    for (const v of b.local) lookup.set(sub(v.p, o).map(Math.round).join(','), v.mat);
    let lo: V3 = [Infinity, Infinity, Infinity];
    let hi: V3 = [-Infinity, -Infinity, -Infinity];
    for (const v of b.local) {
      const p = add(b.pos, rotate(q, v.p));
      lo = [Math.min(lo[0], p[0]), Math.min(lo[1], p[1]), Math.min(lo[2], p[2])];
      hi = [Math.max(hi[0], p[0]), Math.max(hi[1], p[1]), Math.max(hi[2], p[2])];
    }
    const cells: Voxel[] = [];
    for (let z = Math.floor(lo[2] - 1); z <= Math.ceil(hi[2] + 1); z++)
      for (let y = Math.floor(lo[1] - 1); y <= Math.ceil(hi[1] + 1); y++)
        for (let x = Math.floor(lo[0] - 1); x <= Math.ceil(hi[0] + 1); x++) {
          // the body-space point this world cell's centre maps to
          const l = rotate(inv, sub([x + 0.5, y + 0.5, z + 0.5], b.pos));
          const key = sub(l, o).map(Math.round).join(',');
          const m = lookup.get(key);
          if (m !== undefined) cells.push({ x, y, z, mat: m });
        }
    if (!cells.length) return;
    // drop until some cell has solid world directly under it
    const occ = new Set(cells.map((c) => `${c.x},${c.y},${c.z}`));
    for (let drop = 0; drop < 8; drop++) {
      const resting = cells.some((c) => c.z <= 0 || (!occ.has(`${c.x},${c.y},${c.z - 1}`) && this.world.matAt(c.x, c.y, c.z - 1)));
      if (resting) break;
      for (const c of cells) c.z--;
      occ.clear();
      for (const c of cells) occ.add(`${c.x},${c.y},${c.z}`);
    }
    this.onSettle?.(cells, b);
  }

  /** Voxels for the renderer: centre xyz, material, quaternion (f32 bits). */
  pack(): { data: Uint32Array; count: number } {
    let n = 0;
    for (const b of this.list) n += b.local.length;
    const f = new Float32Array(n * 8);
    const u = new Uint32Array(f.buffer);
    let o = 0;
    for (const b of this.list) {
      for (const v of b.local) {
        const p = add(b.pos, rotate(b.q, v.p));
        f[o] = p[0];
        f[o + 1] = p[1];
        f[o + 2] = p[2];
        u[o + 3] = v.mat;
        f[o + 4] = b.q[0];
        f[o + 5] = b.q[1];
        f[o + 6] = b.q[2];
        f[o + 7] = b.q[3];
        o += 8;
      }
    }
    return { data: u, count: n };
  }
}

/** The axis-aligned orientation nearest q. */
function nearestAxis(q: Q): Q {
  let best = AXIS_QS[0];
  let bd = -1;
  for (const a of AXIS_QS) {
    const d = Math.abs(a[0] * q[0] + a[1] * q[1] + a[2] * q[2] + a[3] * q[3]);
    if (d > bd) {
      bd = d;
      best = a;
    }
  }
  return best;
}
