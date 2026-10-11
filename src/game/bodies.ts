// Falling pieces (round 14, BACKLOG F7; round 17 K1; round 21; round 24 Q5):
// pieces of structures that broke free, as voxel bodies in their own frame.
// Since round 24 they move as real rigid bodies (Rapier, physics.ts): they
// tip, topple, slide and tumble, and hit each other and the world (the
// user: "seeing something topple in a way that feels responsive and
// plausible… fantastic juice"). Nothing bounces (restitution 0) — a hard hit
// breaks them instead (integrity.ts turns an impact into shattering, rubble
// and dust, and breaks the world where they hit). At rest they sleep as
// they lie (skewed), projected into the terrain grid (integrity.ts) so the
// ground systems treat them as ground; they wake when hit or undermined.
//
// The world they collide with: around every moving piece, each column's
// intervals (a CPU read-back of the layers, loose ground included) become
// static boxes, rebuilt when the column changes.

import type { Voxel, WorldVox } from './fracture';
import { MAT, MATERIALS, MatState } from '../world/materials';
import { readColumn } from '../world/layout';
import { physics } from './physics';
import type { RigidBody, Collider, World } from '@dimforge/rapier3d-compat';

type V3 = [number, number, number];
type Q = [number, number, number, number]; // x, y, z, w

// Feel (round 20: "fall more slowly… feel bigger; better to sink into each
// other slightly than spring back"): low gravity with air drag and a top
// speed, no bounce.
const G = 10; // cells/s²
const AIR_DRAG = 0.35; // 1/s
const SPIN_DRAG = 0.6; // 1/s
const MAX_V = 7; // cells/s
const FRICTION = 0.8;
/** fixed solver step (s) and the most steps a frame may take */
const STEP = 1 / 60;
const MAX_STEPS = 4;
/** below these speeds (cells/s, rad/s) for SLEEP_T a body settles */
const SLEEP_V = 0.2;
const SLEEP_W = 0.15;
const SLEEP_T = 0.8;
/** bodies settle regardless after this long (s) */
const MAX_AGE = 24;
/**
 * Wind on a piece (round 24: strong cyclones lift light pieces): drag =
 * WIND_DRAG · exposure · (wind − velocity), exposure ~ voxels^(2/3) (its
 * surface), against its mass (voxels × density) — so a few voxels of wood
 * or canvas fly, a slab slides, a tower stays put.
 */
const WIND_DRAG = 1.4;
/** density (mass per voxel) by material; the rest 1.5 */
const DENSITY: Partial<Record<number, number>> = {
  [MAT.Steel]: 3,
  [MAT.Rust]: 2.5,
  [MAT.Stone]: 2.5,
  [MAT.Concrete]: 2.2,
  [MAT.Asphalt]: 2,
  [MAT.Brick]: 1.9,
  [MAT.Wood]: 0.6,
  [MAT.Canvas]: 0.3,
  [MAT.Trash]: 0.8,
  [MAT.Bone]: 1,
};

/** spin (rad/s) a piece that tips over its foot starts with */
const TIP_START = 0.3;
/** a body is awake at least this long (s) before it may settle */
const MIN_AWAKE = 1.5;
/** Bodies settle a little way into loose ground (they lie in it, not on it). */
const SINK = 0.35;
/** loose ground's boxes: half-width (cells) and friction */
const LOOSE_HALF = 0.42;
const LOOSE_FRICTION = 0.5;

export interface Body {
  /** voxels relative to the body's origin (offsets of voxel centres) */
  local: { p: V3; mat: number }[];
  /** distance from the origin to the farthest voxel corner */
  radius: number;
  /** what the wind catches (voxels^(2/3)) */
  exposure: number;
  pos: V3;
  q: Q;
  /** velocity (cells/s) and spin (rad/s), mirrored from the solver */
  v: V3;
  w: V3;
  slow: number;
  age: number;
  /** strongest impact this frame (cells/s: the jump in velocity a contact caused), its direction, and where (world) */
  impact: number;
  impactDir: V3;
  hitAt: V3;
  /** s before an impact can break it (again) */
  grace: number;
  /** at rest: no physics, projected into the terrain grid */
  asleep: boolean;
  /** when it fell asleep (s, Bodies clock): the oldest go first over budget */
  sleptAt: number;
  /** the tops of the columns under it when it fell asleep (column → top): dug out from under, it wakes */
  under: Map<number, number>;
  /** identity (the projection names which body covers a column) */
  id: number;
  rb: RigidBody;
}

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

/** A static box of the world: one interval of one column. */
interface Ground {
  x: number;
  y: number;
  mat: number;
}

export class Bodies {
  list: Body[] = [];
  /** called when a body comes to rest (it stays a body, asleep) */
  onSleep?: (body: Body) => void;
  /** sleeping bodies projected per column: 4 floats (top, bottom, body id, −); top < 0 = none */
  proj?: Float32Array;
  /** called when a sleeping body wakes (it leaves the projection) */
  onWake?: (body: Body) => void;
  /** called once a frame for each body that hit something at IMPACT_V or more and is out of its grace (body, impact speed, world point) */
  onImpact?: (body: Body, speed: number, at: V3) => void;
  /** the wind on pieces at a point (cells/s), null where there's none to speak of (the cyclones) */
  wind?: (p: V3) => V3 | null;
  /** a body hit the world this hard at `at`; `mat` is what it hit */
  onHitWorld?: (at: V3, speed: number, mat: number) => void;
  /** ms the last update took (solver + world boxes), for the perf overlay / tests */
  lastMs = 0;
  private clock = 0;
  private nextId = 1;
  private acc = 0;
  private readonly sim: World;
  /** collider handle → the body it belongs to, or the world box it is */
  private owner = new Map<number, Body | Ground>();
  /** world boxes per column: signature of its intervals, colliders, when last needed */
  private ground = new Map<number, { sig: string; cs: Collider[]; used: number }>();
  /** the read-back the world boxes were last checked against (a new one: check them all again) */
  private checked?: Uint32Array;

  constructor(public world: WorldVox) {
    const R = physics();
    this.sim = new R.World({ x: 0, y: 0, z: -G });
    this.sim.timestep = STEP;
  }

  /**
   * A body from world voxels (they must already be removed from the world).
   * Standing on a foot its centre of mass overhangs, it gets a small start
   * toward the overhang: a tall piece barely off balance would otherwise
   * take seconds to begin to lean (round 24: it should feel responsive).
   */
  spawn(cells: Voxel[]): Body | null {
    const vox = cells.map((v) => ({ p: [v.x + 0.5, v.y + 0.5, v.z + 0.5] as V3, mat: v.mat }));
    const b = this.build(vox, [0, 0, 0], [0, 0, 0, 1]);
    if (!b) return b;
    const foot = cells.filter((c) => this.world.matAt(c.x, c.y, c.z - 1) !== 0);
    if (foot.length) {
      const fx = foot.reduce((s, c) => s + c.x + 0.5, 0) / foot.length;
      const fy = foot.reduce((s, c) => s + c.y + 0.5, 0) / foot.length;
      const d: V3 = [b.pos[0] - fx, b.pos[1] - fy, 0];
      const off = len(d);
      if (off > 0.2) {
        const axis = scale(cross([0, 0, 1], d), TIP_START / off);
        b.rb.setAngvel({ x: axis[0], y: axis[1], z: axis[2] }, true);
        b.w = axis;
      }
    }
    return b;
  }

  /**
   * A body from voxels given in some frame (q, with its origin at `origin` in
   * the world): voxel centres p on that frame's unit lattice. Used for world
   * cells (identity frame) and for the pieces of a broken body (its frame).
   * Its collision shape is the voxels merged into boxes.
   */
  build(vox: { p: V3; mat: number }[], origin: V3, q: Q): Body | null {
    if (!vox.length) return null;
    const R = physics();
    let c: V3 = [0, 0, 0];
    for (const v of vox) c = add(c, v.p);
    c = scale(c, 1 / vox.length);
    const local = vox.map((v) => ({ p: sub(v.p, c), mat: v.mat }));
    let radius = 0;
    for (const v of local) radius = Math.max(radius, len(v.p) + 0.87);
    const pos = add(origin, rotate(q, c));
    const density = vox.reduce((s, v) => s + (DENSITY[v.mat] ?? 1.5), 0) / vox.length;
    const rb = this.sim.createRigidBody(
      R.RigidBodyDesc.dynamic()
        .setTranslation(pos[0], pos[1], pos[2])
        .setRotation({ x: q[0], y: q[1], z: q[2], w: q[3] })
        .setLinearDamping(AIR_DRAG)
        .setAngularDamping(SPIN_DRAG)
        .setCcdEnabled(true),
    );
    const b: Body = {
      local,
      radius,
      exposure: Math.pow(vox.length, 2 / 3),
      pos,
      q: [...q] as Q,
      v: [0, 0, 0],
      w: [0, 0, 0],
      slow: 0,
      age: 0,
      impact: 0,
      impactDir: [0, 0, 0],
      hitAt: [0, 0, 0],
      grace: 0,
      asleep: false,
      sleptAt: 0,
      under: new Map(),
      id: this.nextId++,
      rb,
    };
    const o = vox[0].p;
    for (const [lo, hi] of boxes(vox.map((v) => sub(v.p, o).map(Math.round) as V3))) {
      // lattice cells lo..hi (inclusive) → a box in the body frame
      const ctr = sub(add(o, scale(add(lo, hi), 0.5)), c);
      const half = scale(add(sub(hi, lo), [1, 1, 1]), 0.5);
      const col = this.sim.createCollider(
        R.ColliderDesc.cuboid(half[0], half[1], half[2]).setTranslation(ctr[0], ctr[1], ctr[2]).setFriction(FRICTION).setRestitution(0).setDensity(density),
        rb,
      );
      this.owner.set(col.handle, b);
    }
    this.list.push(b);
    return b;
  }

  /** Take a body out (crumbled, broken up, gone off the world); what it held up wakes. */
  remove(b: Body): void {
    if (!this.list.includes(b)) return;
    this.list = this.list.filter((x) => x !== b);
    for (let i = 0; i < b.rb.numColliders(); i++) this.owner.delete(b.rb.collider(i).handle);
    this.sim.removeRigidBody(b.rb);
    for (const o of this.list) if (o.asleep && len(sub(o.pos, b.pos)) < o.radius + b.radius + 0.5) this.wake(o);
  }

  /** Free the solver's world (the scene is going). */
  dispose(): void {
    this.list = [];
    this.owner.clear();
    this.ground.clear();
    this.sim.free();
  }

  /** Forget every body (undo restores the world beneath them). */
  clear(): void {
    for (const b of [...this.list]) this.remove(b);
  }

  /**
   * Break bodies at a world point (round 18): their voxels within radius are
   * removed, in each body's own frame; what's left splits into its connected
   * pieces, which wake (and fall if nothing holds them). Pieces of `crumb`
   * voxels or fewer (round 20: 12) are returned as crumbs (the caller turns them into loose
   * ground). Returns the removed and crumbled voxels (world centres).
   * `reach` scales the radius per material (impacts chip stone more than
   * steel). Pieces carry on as the body moved.
   */
  breakAt(at: V3, radius: number, crumb = 12, reach: (mat: number) => number = () => 1): { removed: { p: V3; mat: number }[]; crumbs: { p: V3; mat: number }[] } {
    const removed: { p: V3; mat: number }[] = [];
    const crumbs: { p: V3; mat: number }[] = [];
    const r2 = radius * radius;
    for (const b of [...this.list]) {
      if (len(sub(b.pos, at)) > b.radius + radius * 2) continue;
      const world = b.local.map((v) => add(b.pos, rotate(b.q, v.p)));
      const keep: number[] = [];
      for (let i = 0; i < world.length; i++) {
        const d = sub(world[i], at);
        if (dot(d, d) <= r2 * reach(b.local[i].mat) ** 2) removed.push({ p: world[i], mat: b.local[i].mat });
        else keep.push(i);
      }
      if (keep.length === b.local.length) continue;
      this.remove(b);
      this.pieces(b, keep, crumb, world, crumbs);
    }
    return { removed, crumbs };
  }

  /**
   * Shatter a body into about k pieces (round 21: impacts break bodies up):
   * k seeds among its voxels, picked with a pull toward the point hit (so the
   * pieces near it are small and the far ones big); each voxel goes with its
   * nearest seed. Pieces carry on as it moved; pieces of `crumb`
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
    this.remove(b);
    for (const cell of cells) if (cell.length) this.pieces(b, cell, crumb, world, crumbs);
    return crumbs;
  }

  /**
   * The connected pieces (face neighbours on b's lattice) of b's voxels
   * `idx` become new bodies in b's frame, moving as b moved (its velocity at
   * their centre, its spin); pieces of `crumb` voxels or fewer go to
   * `crumbs` instead.
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
      const nb = this.build(piece.map((i) => b.local[i]), b.pos, b.q)!;
      const v = add(b.v, cross(b.w, sub(nb.pos, b.pos)));
      nb.rb.setLinvel({ x: v[0], y: v[1], z: v[2] }, true);
      nb.rb.setAngvel({ x: b.w[0], y: b.w[1], z: b.w[2] }, true);
      nb.v = v;
      nb.w = [...b.w];
      nb.grace = IMPACT_GRACE;
    }
  }

  /** Wake a sleeping body (it moves again and leaves the projection). */
  wake(b: Body): void {
    if (!b.asleep) return;
    b.asleep = false;
    b.slow = 0;
    b.age = 0;
    b.rb.wakeUp();
    this.onWake?.(b);
  }

  /** Is the ground it fell asleep on still there? (a column under it dropped: no) */
  supported(b: Body): boolean {
    for (const [i, top] of b.under) {
      const x = i % this.world.w;
      if (this.world.colTop(x, (i - x) / this.world.w) < top - 0.3) return false;
    }
    return true;
  }

  /**
   * The world as boxes around every moving body: each column's intervals
   * (loose ground on top a little lower — they settle into it). A column is
   * rebuilt when its intervals change; boxes no body has needed for a few
   * seconds are dropped.
   */
  private refreshGround(): void {
    if (!this.world.slots.length) return;
    const R = physics();
    const { w: W, h: H } = this.world;
    // (columns are only read again after a new read-back; edits in between
    // go through changed())
    const recheck = this.checked !== this.world.slots;
    this.checked = this.world.slots;
    for (const b of this.list) {
      if (b.asleep) continue;
      const reach = b.radius + 1 + len(b.v) * 0.25;
      const x0 = Math.max(0, Math.floor(b.pos[0] - reach));
      const x1 = Math.min(W - 1, Math.floor(b.pos[0] + reach));
      const y0 = Math.max(0, Math.floor(b.pos[1] - reach));
      const y1 = Math.min(H - 1, Math.floor(b.pos[1] + reach));
      for (let y = y0; y <= y1; y++)
        for (let x = x0; x <= x1; x++) {
          const k = y * W + x;
          const had0 = this.ground.get(k);
          if (had0 && !recheck) {
            had0.used = this.clock;
            continue;
          }
          const col = readColumn(this.world.packed, this.world.slots, x, y);
          const sig = col.map((iv) => `${iv.z0},${iv.z1},${iv.mat}`).join(';');
          const had = this.ground.get(k);
          if (had && had.sig === sig) {
            had.used = this.clock;
            continue;
          }
          if (had) this.dropGround(had.cs);
          const cs: Collider[] = [];
          col.forEach((iv, n) => {
            let z1 = iv.z1;
            // loose ground: a little narrower than its cell, so it carries what
            // lands on it but doesn't grip a piece's sides (sand banked round a
            // tower's foot held it upright when it should tip)
            const loose = MATERIALS[iv.mat]?.state === MatState.Granular;
            if (loose && n === col.length - 1) z1 = Math.max(iv.z0, z1 - SINK);
            if (z1 - iv.z0 < 1e-3) return;
            const half = loose ? LOOSE_HALF : 0.5;
            const c = this.sim.createCollider(
              R.ColliderDesc.cuboid(half, half, (z1 - iv.z0) / 2)
                .setTranslation(x + 0.5, y + 0.5, (iv.z0 + z1) / 2)
                .setFriction(loose ? LOOSE_FRICTION : FRICTION)
                .setRestitution(0),
            );
            this.owner.set(c.handle, { x, y, mat: iv.mat });
            cs.push(c);
          });
          this.ground.set(k, { sig, cs, used: this.clock });
        }
    }
    for (const [k, g] of this.ground)
      if (this.clock - g.used > 3) {
        this.dropGround(g.cs);
        this.ground.delete(k);
      }
  }

  /** Column (x, y) of the world was edited (CPU mirror): its boxes are rebuilt when next needed. */
  changed(x: number, y: number): void {
    const k = y * this.world.w + x;
    const g = this.ground.get(k);
    if (!g) return;
    this.dropGround(g.cs);
    this.ground.delete(k);
  }

  private dropGround(cs: Collider[]): void {
    for (const c of cs) {
      this.owner.delete(c.handle);
      this.sim.removeCollider(c, false);
    }
  }

  update(dt: number): void {
    const t0 = performance.now();
    this.step(dt);
    this.lastMs = performance.now() - t0;
  }

  private step(dt: number): void {
    this.clock += dt;
    for (const b of this.list) b.impact = 0;
    this.acc = Math.min(this.acc + dt, STEP * MAX_STEPS);
    if (this.list.some((b) => !b.asleep)) this.refreshGround();
    while (this.acc >= STEP) {
      this.acc -= STEP;
      const v0 = new Map<Body, V3>();
      for (const b of this.list) {
        if (b.asleep) continue;
        v0.set(b, b.v);
        b.rb.resetForces(false);
        const wind = this.wind?.(b.pos);
        if (wind) {
          const f = scale(sub(wind, b.v), WIND_DRAG * b.exposure);
          b.rb.addForce({ x: f[0], y: f[1], z: f[2] }, true);
        }
      }
      this.sim.step();
      for (const b of this.list) {
        if (b.asleep) continue;
        const lv = b.rb.linvel();
        const v: V3 = [lv.x, lv.y, lv.z];
        // (a top falling speed: slow and heavy; the wind may carry them faster)
        if (v[2] < -MAX_V) {
          v[2] = -MAX_V;
          b.rb.setLinvel({ x: v[0], y: v[1], z: v[2] }, true);
        }
        // the jump in velocity a contact caused (what gravity, drag and the
        // wind did taken out)
        const before = v0.get(b) ?? v;
        const free: V3 = [before[0], before[1], before[2] - G * STEP];
        const f = b.rb.userForce();
        const m = b.rb.mass();
        const dv = sub(sub(v, scale(free, Math.exp(-AIR_DRAG * STEP))), [(f.x / m) * STEP, (f.y / m) * STEP, (f.z / m) * STEP]);
        const hit = len(dv);
        if (hit > b.impact) {
          b.impact = hit;
          b.impactDir = scale(dv, 1 / Math.max(hit, 1e-6));
        }
        b.v = v;
        const av = b.rb.angvel();
        b.w = [av.x, av.y, av.z];
      }
    }
    for (const b of this.list) {
      const t = b.rb.translation();
      const r = b.rb.rotation();
      b.pos = [t.x, t.y, t.z];
      b.q = [r.x, r.y, r.z, r.w];
    }
    // impacts are reported after the step (the handler may break bodies)
    const hits: Body[] = [];
    for (const b of this.list) {
      b.grace = Math.max(0, b.grace - dt);
      if (!b.asleep && b.impact >= IMPACT_V && b.grace <= 0) hits.push(b);
    }
    for (const b of hits) {
      if (!this.list.includes(b)) continue;
      b.grace = IMPACT_GRACE;
      const what = this.contactPoint(b);
      b.hitAt = what?.at ?? b.pos;
      if (what && !('rb' in what.with)) this.onHitWorld?.(b.hitAt, b.impact, what.with.mat);
      this.onImpact?.(b, b.impact, b.hitAt);
    }
    const done: Body[] = [];
    for (const b of this.list) {
      if (b.asleep) {
        // something hit it: the solver woke it
        if (!b.rb.isSleeping()) this.wake(b);
        continue;
      }
      b.age += dt;
      const resting = len(b.v) < SLEEP_V && len(b.w) < SLEEP_W;
      b.slow = resting ? b.slow + dt : 0;
      if (b.pos[2] < -20) done.push(b); // fell off the world
      else if ((b.slow > SLEEP_T && b.age > MIN_AWAKE) || b.age > MAX_AGE) this.sleep(b);
    }
    for (const b of done) this.remove(b);
  }

  /** At rest: it stays as it lies (round 17: no snapping back to the grid). */
  private sleep(b: Body): void {
    b.asleep = true;
    b.v = [0, 0, 0];
    b.w = [0, 0, 0];
    b.rb.setLinvel({ x: 0, y: 0, z: 0 }, false);
    b.rb.setAngvel({ x: 0, y: 0, z: 0 }, false);
    b.rb.sleep();
    b.sleptAt = this.clock;
    b.under.clear();
    const W = this.world.w;
    this.voxelBounds(b, (lo, hi) => {
      for (let y = Math.max(0, Math.floor(lo[1])); y <= Math.min(this.world.h - 1, Math.floor(hi[1])); y++)
        for (let x = Math.max(0, Math.floor(lo[0])); x <= Math.min(W - 1, Math.floor(hi[0])); x++) if (!b.under.has(y * W + x)) b.under.set(y * W + x, this.world.colTop(x, y));
    });
    this.onSleep?.(b);
  }

  /**
   * Where b touches what it hit, and what that is: the contact on the side
   * the impact pushed from (velocity jumped along impactDir, so the contact
   * lies against it).
   */
  private contactPoint(b: Body): { at: V3; with: Body | Ground } | null {
    let best: { at: V3; with: Body | Ground; d: number } | null = null;
    for (let i = 0; i < b.rb.numColliders(); i++) {
      const c = b.rb.collider(i);
      this.sim.contactPairsWith(c, (other) => {
        const who = this.owner.get(other.handle);
        if (!who || who === b) return;
        this.sim.contactPair(c, other, (m) => {
          for (let k = 0; k < m.numSolverContacts(); k++) {
            const p = m.solverContactPoint(k);
            if (!p) continue;
            const at: V3 = [p.x, p.y, p.z];
            const d = dot(sub(at, b.pos), b.impactDir);
            if (!best || d < best.d) best = { at, with: who, d };
          }
        });
      });
    }
    return best;
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

/**
 * Voxels (integer lattice cells) merged into boxes (greedy: runs along x,
 * then rows along y, then slabs along z). Returns inclusive [lo, hi] cells.
 */
function boxes(cells: V3[]): [V3, V3][] {
  const key = (x: number, y: number, z: number) => `${x},${y},${z}`;
  const free = new Set(cells.map((c) => key(c[0], c[1], c[2])));
  const sorted = [...cells].sort((a, b) => a[2] - b[2] || a[1] - b[1] || a[0] - b[0]);
  const out: [V3, V3][] = [];
  for (const [x, y, z] of sorted) {
    if (!free.has(key(x, y, z))) continue;
    let x1 = x;
    while (free.has(key(x1 + 1, y, z))) x1++;
    const row = (yy: number, zz: number) => {
      for (let xx = x; xx <= x1; xx++) if (!free.has(key(xx, yy, zz))) return false;
      return true;
    };
    let y1 = y;
    while (row(y1 + 1, z)) y1++;
    const slab = (zz: number) => {
      for (let yy = y; yy <= y1; yy++) if (!row(yy, zz)) return false;
      return true;
    };
    let z1 = z;
    while (slab(z1 + 1)) z1++;
    for (let zz = z; zz <= z1; zz++) for (let yy = y; yy <= y1; yy++) for (let xx = x; xx <= x1; xx++) free.delete(key(xx, yy, zz));
    out.push([
      [x, y, z],
      [x1, y1, z1],
    ]);
  }
  return out;
}
