// Rigid bodies (round 14, BACKLOG F7; round 17 K1): pieces of structures that
// broke free tumble as rigid voxel bodies (Noita-style) in their own frame,
// collide with the voxel world (a CPU read-back of the layers), the loose
// ground on it, and bodies already at rest — and when they come to rest they
// stay as they are, skewed, asleep (no physics; only drawn). Integrity
// projects the sleeping ones into the terrain grid (the per-column body
// top/bottom the ground systems read) and keeps them within a budget.

import type { Voxel, WorldVox } from './fracture';

type V3 = [number, number, number];
type Q = [number, number, number, number]; // x, y, z, w

// Feel (round 20: "fall more slowly, much more inertia to feel bigger; better
// to sink into each other slightly than spring back"): low gravity with air
// drag, a rotational inertia scaled up so big pieces turn slowly, no bounce,
// and soft contacts — each iteration resolves only part of the approach
// speed, and overlap is pushed out gently past a small slop.
const G = 10; // cells/s²
const AIR_DRAG = 0.35; // 1/s on linear speed
const INERTIA_SCALE = 3;
const RESTITUTION = 0;
const FRICTION = 0.6;
const SOFTNESS = 0.4; // share of the approach speed each iteration takes away
const SLOP = 0.15; // cells of overlap allowed before pushing out
const PUSH = 0.08; // share of the overlap past the slop pushed out per iteration
const SUBSTEPS = 2;
const ITERATIONS = 4;
/** below these speeds (cells/s, rad/s) for SLEEP_T a body settles */
const SLEEP_V = 0.15;
const SLEEP_W = 0.06;
const SLEEP_T = 1.5;
/** bodies settle regardless after this long (s) */
const MAX_AGE = 24;

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
  /** at rest: no physics, projected into the terrain grid */
  asleep: boolean;
  /** when it fell asleep (s, Bodies clock): the oldest go first over budget */
  sleptAt: number;
  /** identity (the projection names which body covers a column) */
  id: number;
}

/** Impact speed (cells/s) of a falling body that wakes a sleeping one it hits. */
const WAKE_IMPACT = 3;

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

export class Bodies {
  list: Body[] = [];
  /** called when a body comes to rest (it stays a body, asleep) */
  onSleep?: (body: Body) => void;
  /** the loose ground's depth per column (drift .x; CPU read-back) */
  loose?: Float32Array;
  /** sleeping bodies projected per column: 4 floats (top, bottom, body id, −); top < 0 = none */
  proj?: Float32Array;
  /** called when a sleeping body wakes (it leaves the projection) */
  onWake?: (body: Body) => void;
  private clock = 0;
  private nextId = 1;
  /** called when a body hits hard (impact speed, world point) */
  onImpact?: (speed: number, at: V3) => void;

  constructor(public world: WorldVox) {}

  /** A body from world voxels (they must already be removed from the world). */
  spawn(cells: Voxel[], kick: V3 = [0, 0, 0]): Body | null {
    const vox = cells.map((v) => ({ p: [v.x + 0.5, v.y + 0.5, v.z + 0.5] as V3, mat: v.mat }));
    return this.build(vox, [0, 0, 0], [0, 0, 0, 1], kick);
  }

  /**
   * A body from voxels given in some frame (q, with its origin at `origin` in
   * the world): voxel centres p on that frame's unit lattice. Used for world
   * cells (identity frame) and for the pieces of a broken body (its frame).
   */
  build(vox: { p: V3; mat: number }[], origin: V3, q: Q, kick: V3 = [0, 0, 0]): Body | null {
    if (!vox.length) return null;
    let c: V3 = [0, 0, 0];
    for (const v of vox) c = add(c, v.p);
    c = scale(c, 1 / vox.length);
    const local = vox.map((v) => ({ p: sub(v.p, c), mat: v.mat }));
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
    // collision points: corners of voxels on the surface (deduplicated), found
    // on the integer lattice the voxels sit on
    const o = vox[0].p;
    const key = (p: V3) => sub(p, o).map(Math.round).join(',');
    const occ = new Set(vox.map((v) => key(v.p)));
    const seen = new Set<string>();
    let points: V3[] = [];
    for (const v of vox) {
      const exposed = [
        [1, 0, 0],
        [-1, 0, 0],
        [0, 1, 0],
        [0, -1, 0],
        [0, 0, 1],
        [0, 0, -1],
      ].some(([dx, dy, dz]) => !occ.has(key(add(v.p, [dx, dy, dz]))));
      if (!exposed) continue;
      for (let k = 0; k < 8; k++) {
        const p: V3 = add(v.p, [(k & 1) - 0.5, ((k >> 1) & 1) - 0.5, (k >> 2) - 0.5]);
        const kk = sub(p, o).map((x) => Math.round(x * 2)).join(',');
        if (seen.has(kk)) continue;
        seen.add(kk);
        points.push(sub(p, c));
      }
    }
    if (points.length > 600) points = points.filter((_, i) => i % Math.ceil(points.length / 600) === 0);
    const pos = add(origin, rotate(q, c));
    const b: Body = { local, points, pos, q: [...q] as Q, v: kick, w: [0, 0, 0], invMass: 1 / vox.length, invI: invert3(I.map((x) => x * INERTIA_SCALE)), slow: 0, age: 0, impact: 0, asleep: false, sleptAt: 0, id: this.nextId++ };
    this.list.push(b);
    return b;
  }

  /**
   * Break bodies at a world point (round 18): their voxels within radius are
   * removed, in each body's own frame; what's left splits into its connected
   * pieces, which wake (and fall if nothing holds them). Pieces of `crumb`
   * voxels or fewer (round 20: 12) are returned as crumbs (the caller turns them into loose
   * ground). Returns the removed and crumbled voxels (world centres).
   */
  breakAt(at: V3, radius: number, crumb = 12): { removed: { p: V3; mat: number }[]; crumbs: { p: V3; mat: number }[] } {
    const removed: { p: V3; mat: number }[] = [];
    const crumbs: { p: V3; mat: number }[] = [];
    const r2 = radius * radius;
    for (const b of [...this.list]) {
      const world = b.local.map((v) => add(b.pos, rotate(b.q, v.p)));
      const keep: number[] = [];
      for (let i = 0; i < world.length; i++) {
        const d = sub(world[i], at);
        if (dot(d, d) <= r2) removed.push({ p: world[i], mat: b.local[i].mat });
        else keep.push(i);
      }
      if (keep.length === b.local.length) continue;
      this.list = this.list.filter((x) => x !== b);
      // connected pieces of what's left (face neighbours on the body's lattice)
      const o = b.local[0].p;
      const lat = (i: number) => sub(b.local[i].p, o).map(Math.round) as V3;
      const at3 = new Map<string, number>();
      for (const i of keep) at3.set(lat(i).join(','), i);
      const seen = new Set<number>();
      for (const start of keep) {
        if (seen.has(start)) continue;
        const piece: number[] = [start];
        seen.add(start);
        for (let h = 0; h < piece.length; h++) {
          const [x, y, z] = lat(piece[h]);
          for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
            const j = at3.get(`${x + dx},${y + dy},${z + dz}`);
            if (j !== undefined && !seen.has(j)) {
              seen.add(j);
              piece.push(j);
            }
          }
        }
        if (piece.length <= crumb) {
          for (const i of piece) crumbs.push({ p: world[i], mat: b.local[i].mat });
          continue;
        }
        // a new body in the parent's frame (it wakes and settles again)
        this.build(piece.map((i) => b.local[i]), b.pos, b.q);
      }
    }
    return { removed, crumbs };
  }

  /** Is there solid world at this point? (cells, off-map = air) */
  private solid(p: V3): number {
    return this.world.matAt(Math.floor(p[0]), Math.floor(p[1]), Math.floor(p[2]));
  }

  /** Bodies settle a little way into loose ground (they lie in it, not on it). */
  private static readonly SINK = 0.35;

  /** Wake a sleeping body (it moves again and leaves the projection). */
  wake(b: Body): void {
    if (!b.asleep) return;
    b.asleep = false;
    b.slow = 0;
    b.age = 0;
    this.onWake?.(b);
  }

  /** Is anything (world, loose ground, another body) holding b up? */
  supported(b: Body): boolean {
    let lo = Infinity;
    const pts = b.points.map((pl) => add(b.pos, rotate(b.q, pl)));
    for (const p of pts) lo = Math.min(lo, p[2]);
    for (const p of pts) {
      if (p[2] > lo + 0.6) continue;
      if (this.contact([p[0], p[1], p[2] - 0.15], b.id)) return true;
    }
    return false;
  }

  /** The way out of whatever a point is in (solid cells, loose ground, a sleeping body other than `ignore`): normal, depth, and the body hit. */
  private contact(p: V3, ignore = 0): { n: V3; depth: number; body?: number } | null {
    const x = Math.floor(p[0]);
    const y = Math.floor(p[1]);
    const z = Math.floor(p[2]);
    if (z < 0) return { n: [0, 0, 1], depth: -p[2] };
    const W = this.world.w;
    if (x >= 0 && y >= 0 && x < W && y < this.world.h && !this.solid(p)) {
      const i = y * W + x;
      // a sleeping body here: out over its top
      const pr = this.proj;
      if (pr && pr[i * 4] >= 0 && pr[i * 4 + 2] !== ignore && p[2] < pr[i * 4] && p[2] >= pr[i * 4 + 1]) return { n: [0, 0, 1], depth: pr[i * 4] - p[2], body: pr[i * 4 + 2] };
      // loose ground over the column's solid top
      const l = this.loose?.[i] ?? 0;
      if (l > 0.05) {
        const top = this.world.colTop(x, y);
        const surf = top + Math.max(0, l - Bodies.SINK);
        if (p[2] >= top && p[2] < surf) return { n: [0, 0, 1], depth: surf - p[2] };
      }
      return null;
    }
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
    this.clock += dt;
    const h = dt / SUBSTEPS;
    for (let s = 0; s < SUBSTEPS; s++) for (const b of this.list) if (!b.asleep) this.step(b, h);
    const done: Body[] = [];
    for (const b of this.list) {
      if (b.asleep) continue;
      b.age += dt;
      const resting = len(b.v) < SLEEP_V && len(b.w) < SLEEP_W;
      b.slow = resting ? b.slow + dt : 0;
      if (b.pos[2] < -20) done.push(b); // fell off the world
      else if (b.slow > SLEEP_T || b.age > MAX_AGE) {
        // at rest: it stays as it lies (round 17: no snapping back to the grid)
        b.asleep = true;
        b.v = [0, 0, 0];
        b.w = [0, 0, 0];
        b.sleptAt = this.clock;
        this.onSleep?.(b);
      }
    }
    if (done.length) this.list = this.list.filter((b) => !done.includes(b));
  }

  /** Is anything still moving? */
  get anyAwake(): boolean {
    return this.list.some((b) => !b.asleep);
  }

  /** The body's voxels in the world: centre and material. */
  worldVoxels(b: Body): { p: V3; mat: number }[] {
    return b.local.map((v) => ({ p: add(b.pos, rotate(b.q, v.p)), mat: v.mat }));
  }

  /** Each voxel's world bounds (its rotated cube's box), for projection. */
  voxelBounds(b: Body, f: (lo: V3, hi: V3) => void): void {
    // a unit cube rotated by q: its box half-size is Σ|R col|·0.5 per axis
    const ex = rotate(b.q, [0.5, 0, 0]);
    const ey = rotate(b.q, [0, 0.5, 0]);
    const ez = rotate(b.q, [0, 0, 0.5]);
    const hx = Math.abs(ex[0]) + Math.abs(ey[0]) + Math.abs(ez[0]);
    const hy = Math.abs(ex[1]) + Math.abs(ey[1]) + Math.abs(ez[1]);
    const hz = Math.abs(ex[2]) + Math.abs(ey[2]) + Math.abs(ez[2]);
    for (const v of b.local) {
      const c = add(b.pos, rotate(b.q, v.p));
      f([c[0] - hx, c[1] - hy, c[2] - hz], [c[0] + hx, c[1] + hy, c[2] + hz]);
    }
  }

  private step(b: Body, h: number): void {
    b.v[2] -= G * h;
    b.impact = 0;
    for (let it = 0; it < ITERATIONS; it++) {
      let pushN: V3 = [0, 0, 0];
      let pushD = 0;
      for (const pl of b.points) {
        const r = rotate(b.q, pl);
        const p = add(b.pos, r);
        const c = this.contact(p, b.id);
        if (!c) continue;
        const vp = add(b.v, cross(b.w, r));
        const vn = dot(vp, c.n);
        // landing hard on a sleeping body wakes it
        if (c.body !== undefined && -vn > WAKE_IMPACT) {
          const other = this.list.find((x) => x.id === c.body);
          if (other) this.wake(other);
        }
        if (c.depth > pushD) {
          pushD = c.depth;
          pushN = c.n;
        }
        if (vn >= 0) continue;
        if (it === 0) b.impact = Math.max(b.impact, -vn);
        const rn = cross(r, c.n);
        const k = b.invMass + dot(cross(applyInvI(b, rn), r), c.n);
        const j = ((-(1 + RESTITUTION) * vn) / k) * SOFTNESS;
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
      if (pushD > SLOP) b.pos = add(b.pos, scale(pushN, (pushD - SLOP) * PUSH));
    }
    b.v = scale(b.v, Math.exp(-AIR_DRAG * h));
    b.w = scale(b.w, 0.985);
    b.pos = add(b.pos, scale(b.v, h));
    const wq: Q = [b.w[0], b.w[1], b.w[2], 0];
    const dq = qmul(wq, b.q);
    b.q = qnorm([b.q[0] + dq[0] * 0.5 * h, b.q[1] + dq[1] * 0.5 * h, b.q[2] + dq[2] * 0.5 * h, b.q[3] + dq[3] * 0.5 * h]);
    if (b.impact > 10) this.onImpact?.(b.impact, b.pos);
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
