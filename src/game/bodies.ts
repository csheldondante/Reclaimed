// Falling pieces (round 14, BACKLOG F7; round 17 K1; round 21): pieces of
// structures that broke free, as voxel bodies in their own frame. They only
// fall — straight down, no tumbling, sliding or bouncing (round 21: "only let
// the building chunks fall… the rigid-body collision response breaks the
// illusion of scale") — onto the voxel world (a CPU read-back of the
// layers), the loose ground on it and bodies already at rest, and break up
// when they land hard (integrity.ts). At rest they sleep as they lie (no
// physics; only drawn). Integrity projects the sleeping ones into the
// terrain grid (the per-column body top/bottom the ground systems read) and
// keeps them within a budget.

import type { Voxel, WorldVox } from './fracture';

type V3 = [number, number, number];
type Q = [number, number, number, number]; // x, y, z, w

// Feel (round 20: "fall more slowly… feel bigger; better to sink into each
// other slightly than spring back"): low gravity with air drag and a top
// speed (round 21: ~1.5× the old topple); landing takes most of the speed
// away each substep, so a piece settles a little into what it lands on, and
// overlap past a small slop is pushed out gently.
const G = 10; // cells/s²
const AIR_DRAG = 0.35; // 1/s
const MAX_V = 4; // cells/s
const LANDING = 0.6; // share of the falling speed a contact takes away per substep
const SLOP = 0.15; // cells of overlap allowed before pushing out
const PUSH = 0.3; // share of the overlap past the slop pushed out per substep
const MAX_PUSH = 1.5; // cells/s of push out of an overlap
const SUBSTEPS = 2;
/** below this falling speed (cells/s) for SLEEP_T a body settles */
const SLEEP_V = 0.15;
const SLEEP_T = 1;
/** bodies settle regardless after this long (s) */
const MAX_AGE = 24;

export interface Body {
  /** voxels relative to the centre of mass (offsets of voxel centres) */
  local: { p: V3; mat: number }[];
  /** collision points (exposed voxel corners), relative to the centre of mass */
  points: V3[];
  pos: V3;
  q: Q;
  /** vertical speed (cells/s; ≤ 0: it only falls) */
  vz: number;
  slow: number;
  age: number;
  /** strongest impact this frame (cells/s) and where (world), for crumbling, dust and sound */
  impact: number;
  hitAt: V3;
  /** s before an impact can break it (again) */
  grace: number;
  /** at rest: no physics, projected into the terrain grid */
  asleep: boolean;
  /** when it fell asleep (s, Bodies clock): the oldest go first over budget */
  sleptAt: number;
  /** identity (the projection names which body covers a column) */
  id: number;
}

/** How far (cells) collision points sit inside the voxels' corners. */
const POINT_INSET = 0.04;
/** Impact speed (cells/s) of a falling body that wakes a sleeping one it hits. */
const WAKE_IMPACT = 3;
/** Impacts at least this hard (cells/s) are reported (onImpact). */
const IMPACT_V = 1;
/** s between impacts that can break a body (its pieces inherit it) */
const IMPACT_GRACE = 0.35;

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
  /** called once a frame for each body that hit something at IMPACT_V or more and is out of its grace (body, impact speed, world point) */
  onImpact?: (body: Body, speed: number, at: V3) => void;

  constructor(public world: WorldVox) {}

  /** A body from world voxels (they must already be removed from the world). */
  spawn(cells: Voxel[]): Body | null {
    const vox = cells.map((v) => ({ p: [v.x + 0.5, v.y + 0.5, v.z + 0.5] as V3, mat: v.mat }));
    return this.build(vox, [0, 0, 0], [0, 0, 0, 1]);
  }

  /**
   * A body from voxels given in some frame (q, with its origin at `origin` in
   * the world): voxel centres p on that frame's unit lattice. Used for world
   * cells (identity frame) and for the pieces of a broken body (its frame).
   */
  build(vox: { p: V3; mat: number }[], origin: V3, q: Q): Body | null {
    if (!vox.length) return null;
    let c: V3 = [0, 0, 0];
    for (const v of vox) c = add(c, v.p);
    c = scale(c, 1 / vox.length);
    const local = vox.map((v) => ({ p: sub(v.p, c), mat: v.mat }));
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
        const corner: V3 = [(k & 1) - 0.5, ((k >> 1) & 1) - 0.5, (k >> 2) - 0.5];
        const kk = sub(add(v.p, corner), o).map((x) => Math.round(x * 2)).join(',');
        if (seen.has(kk)) continue;
        seen.add(kk);
        // a little inside the voxel: a corner exactly on a face belongs to the
        // neighbouring column too (floor), so a freshly cut piece "touched"
        // the sand banked against it and was pushed up out of it (round 21)
        points.push(sub(add(v.p, scale(corner, 1 - 2 * POINT_INSET)), c));
      }
    }
    if (points.length > 600) points = points.filter((_, i) => i % Math.ceil(points.length / 600) === 0);
    const pos = add(origin, rotate(q, c));
    const b: Body = { local, points, pos, q: [...q] as Q, vz: 0, slow: 0, age: 0, impact: 0, hitAt: [0, 0, 0], grace: 0, asleep: false, sleptAt: 0, id: this.nextId++ };
    this.list.push(b);
    return b;
  }

  /**
   * Break bodies at a world point (round 18): their voxels within radius are
   * removed, in each body's own frame; what's left splits into its connected
   * pieces, which wake (and fall if nothing holds them). Pieces of `crumb`
   * voxels or fewer (round 20: 12) are returned as crumbs (the caller turns them into loose
   * ground). Returns the removed and crumbled voxels (world centres).
   * `reach` scales the radius per material (impacts chip stone more than
   * steel). Pieces carry on falling (round 21).
   */
  breakAt(at: V3, radius: number, crumb = 12, reach: (mat: number) => number = () => 1): { removed: { p: V3; mat: number }[]; crumbs: { p: V3; mat: number }[] } {
    const removed: { p: V3; mat: number }[] = [];
    const crumbs: { p: V3; mat: number }[] = [];
    const r2 = radius * radius;
    for (const b of [...this.list]) {
      const world = b.local.map((v) => add(b.pos, rotate(b.q, v.p)));
      const keep: number[] = [];
      for (let i = 0; i < world.length; i++) {
        const d = sub(world[i], at);
        if (dot(d, d) <= r2 * reach(b.local[i].mat) ** 2) removed.push({ p: world[i], mat: b.local[i].mat });
        else keep.push(i);
      }
      if (keep.length === b.local.length) continue;
      this.list = this.list.filter((x) => x !== b);
      this.pieces(b, keep, crumb, world, crumbs);
    }
    return { removed, crumbs };
  }

  /**
   * Shatter a body into about k pieces (round 21: impacts break bodies up):
   * k seeds among its voxels, picked with a pull toward the point hit (so the
   * pieces near it are small and the far ones big); each voxel goes with its
   * nearest seed. Pieces carry on falling; pieces of `crumb`
   * voxels or fewer are returned (world centres) as crumbs.
   */
  shatter(b: Body, at: V3, k: number, crumb: number): { p: V3; mat: number }[] {
    const crumbs: { p: V3; mat: number }[] = [];
    k = Math.min(k, b.local.length);
    if (k < 2 || !this.list.includes(b)) return crumbs;
    const hit = rotate(conj(b.q), sub(at, b.pos));
    const seeds: V3[] = [];
    for (let s = 0; s < k; s++) {
      let best = b.local[Math.floor(Math.random() * b.local.length)].p;
      for (let t = 0; t < 2; t++) {
        const c = b.local[Math.floor(Math.random() * b.local.length)].p;
        if (len(sub(c, hit)) < len(sub(best, hit))) best = c;
      }
      seeds.push(best);
    }
    const cells: number[][] = seeds.map(() => []);
    b.local.forEach((v, i) => {
      let j = 0;
      for (let s = 1; s < k; s++) if (len(sub(v.p, seeds[s])) < len(sub(v.p, seeds[j]))) j = s;
      cells[j].push(i);
    });
    const world = b.local.map((v) => add(b.pos, rotate(b.q, v.p)));
    this.list = this.list.filter((x) => x !== b);
    for (const cell of cells) if (cell.length) this.pieces(b, cell, crumb, world, crumbs);
    return crumbs;
  }

  /**
   * The connected pieces (face neighbours on b's lattice) of b's voxels
   * `idx` become new bodies in b's frame, falling as b fell;
   * pieces of `crumb` voxels or fewer go to `crumbs` instead.
   */
  private pieces(b: Body, idx: number[], crumb: number, world: V3[], crumbs: { p: V3; mat: number }[]): void {
    const o = b.local[0].p;
    const lat = (i: number) => sub(b.local[i].p, o).map(Math.round) as V3;
    const at3 = new Map<string, number>();
    for (const i of idx) at3.set(lat(i).join(','), i);
    const seen = new Set<number>();
    for (const start of idx) {
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
      // a new body in the parent's frame (it wakes and settles again), still
      // falling as the parent fell
      const nb = this.build(piece.map((i) => b.local[i]), b.pos, b.q)!;
      nb.vz = b.vz;
      nb.grace = IMPACT_GRACE;
    }
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
    // up, out of the top of this solid run (pieces only fall, so they only
    // ever come into things from above)
    return { n: [0, 0, 1], depth: this.world.runTop(x, y, z) - p[2] };
  }

  update(dt: number): void {
    this.clock += dt;
    const h = dt / SUBSTEPS;
    for (const b of this.list) b.impact = 0;
    for (let s = 0; s < SUBSTEPS; s++) for (const b of this.list) if (!b.asleep) this.step(b, h);
    // impacts are reported after the step (the handler may break bodies)
    const hits: Body[] = [];
    for (const b of this.list) {
      b.grace = Math.max(0, b.grace - dt);
      if (!b.asleep && b.impact >= IMPACT_V && b.grace <= 0) hits.push(b);
    }
    for (const b of hits) {
      b.grace = IMPACT_GRACE;
      this.onImpact?.(b, b.impact, b.hitAt);
    }
    const done: Body[] = [];
    for (const b of this.list) {
      if (b.asleep) continue;
      b.age += dt;
      const resting = Math.abs(b.vz) < SLEEP_V;
      b.slow = resting ? b.slow + dt : 0;
      if (b.pos[2] < -20) done.push(b); // fell off the world
      else if (b.slow > SLEEP_T || b.age > MAX_AGE) {
        // at rest: it stays as it lies (round 17: no snapping back to the grid)
        b.asleep = true;
        b.vz = 0;
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
    b.vz = Math.max(-MAX_V, (b.vz - G * h) * Math.exp(-AIR_DRAG * h));
    // what it rests on: the deepest overlap among its points
    let deep = -1;
    for (const pl of b.points) {
      const p = add(b.pos, rotate(b.q, pl));
      const c = this.contact(p, b.id);
      if (!c) continue;
      // landing hard on a sleeping body wakes it
      if (c.body !== undefined && -b.vz > WAKE_IMPACT) {
        const other = this.list.find((x) => x.id === c.body);
        if (other) this.wake(other);
      }
      if (c.depth > deep) {
        deep = c.depth;
        if (-b.vz > b.impact) {
          b.impact = -b.vz;
          b.hitAt = p;
        }
      }
    }
    if (deep >= 0) {
      b.vz *= 1 - LANDING;
      if (deep > SLOP) b.pos[2] += Math.min((deep - SLOP) * PUSH, MAX_PUSH * h);
    }
    b.pos[2] += b.vz * h;
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
