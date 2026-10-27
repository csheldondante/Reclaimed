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

import { MATERIALS, MatState } from '../world/materials';
import { cellPos, nbr } from '../world/lattice';

export type V3 = [number, number, number];
type Q = [number, number, number, number];
type M3 = number[];

/**
 * The knobs (DECISIONS round 95: for the user to play with). URL: rbgrav, rbrest, rbfric, rbbreak, rbdamp, rbmax,
 * rbspin, rbmaxv, rbscatter, rbcdamp, rbsize, rbcrumble (round 96); the rock lab's panel (`level=rocklab&rockbody=1`) sets them live.
 */
export const RB = {
  /** × the falling pieces' gravity (10 cells/s²) */
  gravity: 1,
  /** bounce: share of the speed into the ground given back (hits over 1.5 cells/s) */
  restitution: 0.05,
  /** Coulomb friction at the contacts */
  friction: 0.6,
  /** impact speed (cells/s, into the ground at the point hit) that breaks rock of strength 1 (× √strength) */
  breakSpeed: 9,
  /** angular damping (1/s) */
  angDamp: 0.6,
  /**
   * (round 96, the user: "slightly weightier") the spin and the speed taken out while it touches the ground (1/s):
   * a piece that lands stays down, it doesn't spin or skate off
   */
  contactDamp: 1.5,
  /**
   * (round 96) the square-cube law: the break speed × (cells / 200)^−size — a big piece is weak for its weight
   * (0: every size alike)
   */
  sizeK: 0.15,
  /** (round 96) × the radius that crumbles round a hard hit, and × the pieces it breaks into */
  crumble: 1.4,
  /** bodies at once (the phone); past it the oldest is settled into the columns first */
  maxBodies: 10,
  /** a tipping piece's start: rad/s about the edge it tips over */
  tipSpin: 0.5,
  /** top speed (cells/s) */
  maxV: 14,
  /** pieces of a break thrown apart at this share of the impact speed */
  scatter: 0.2,
  /** (debug) 1: the cubes the bodies are simulated with drawn too (else only their mesh, the cubes casting the shadow) */
  cubes: 0,
};
if (typeof location !== 'undefined') {
  const q = new URLSearchParams(location.search);
  const num = (k: string, f: keyof typeof RB) => {
    const v = q.get(k);
    if (v !== null && v !== '' && Number.isFinite(Number(v))) RB[f] = Number(v);
  };
  num('rbgrav', 'gravity');
  num('rbrest', 'restitution');
  num('rbfric', 'friction');
  num('rbbreak', 'breakSpeed');
  num('rbdamp', 'angDamp');
  num('rbmax', 'maxBodies');
  num('rbspin', 'tipSpin');
  num('rbmaxv', 'maxV');
  num('rbscatter', 'scatter');
  num('rbcubes', 'cubes');
  num('rbcdamp', 'contactDamp');
  num('rbsize', 'sizeK');
  num('rbcrumble', 'crumble');
}
/**
 * Whether rock the judge frees falls as these bodies (else the columns' own falling pieces): `?rockbody=1` / `=0`;
 * (round 96, the user: "And then I think push to atlas") on by default in the atlas and the rock lab.
 */
export function rockbodyFor(levelId?: string): boolean {
  const p = typeof location === 'undefined' ? null : new URLSearchParams(location.search).get('rockbody');
  if (p === '1') return true;
  if (p === '0') return false;
  return levelId === 'atlas' || levelId === 'rocklab';
}

const G = 10; // cells/s² (colbodies.ts, bodies.ts: the falling pieces' feel)
const AIR_DRAG = 0.1; // 1/s
const SUB_DT = 1 / 120;
/** at rest: under these speeds (cells/s, rad/s) for REST_T with something under it */
const REST_V = 0.3;
const REST_W = 0.15;
const REST_T = 0.6;
/** settled regardless after this long (s) */
export const MAX_AGE = 20;
/** pieces of a break smaller than this (cells) crumble to rubble */
const MIN_CHUNK = 8;
/** breaks deep: a piece of a piece of a piece doesn't break again */
const MAX_GEN = 2;
/** s after spawning or breaking before a hit can break it */
const GRACE = 0.3;
/** penetration (cells) let be before it's pushed out */
const SLOP = 0.03;

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
}

/** What the bodies know of the world: a point (world) in the ground — how deep, and the way out — or null. */
export interface RockGround {
  probe(x: number, y: number, z: number): { d: number; n: V3 } | null;
  /** the highest ground in this world box (x0, y0, x1, y1), for the broad phase */
  topIn(x0: number, y0: number, x1: number, y1: number): number;
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
/** world inverse inertia × v: R · I⁻¹ · Rᵀ v */
const iw = (b: RockBody, R: M3, v: V3): V3 => mv(R, mv(b.invI, mtv(R, v)));

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

export class RockBodies {
  list: RockBody[] = [];
  private nextId = 1;
  /** while the ground's copy isn't of the window as it is (a slide, until it's read again): nothing moves */
  frozen = false;
  stats = { spawned: 0, breaks: 0, settled: 0, capped: 0, maxPts: 0, stepMs: 0, contacts: 0 };

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
    };
    this.shape(b);
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
      for (let c = 0; c < 8; c++) {
        const o: V3 = [(c & 1) - 0.5, ((c >> 1) & 1) - 0.5, (c >> 2) - 0.5];
        const p = add(k.p, mul(o, 0.92));
        const key = p.map((v) => Math.round(v * 2)).join(',');
        if (seen.has(key)) continue;
        seen.add(key);
        b.pts.push(p);
      }
    }
    this.stats.maxPts = Math.max(this.stats.maxPts, b.pts.length);
  }

  /** A step of every body (dt s): the hits hard enough to break or to raise dust, and the bodies come to rest. */
  update(dt: number, only?: RockBody[]): { hits: RockHit[]; rest: RockBody[] } {
    const hits: RockHit[] = [];
    const rest: RockBody[] = [];
    if (this.frozen || !this.list.length || dt <= 0) return { hits, rest };
    const t0 = performance.now();
    const n = Math.min(6, Math.max(1, Math.ceil(dt / SUB_DT)));
    const h = dt / n;
    for (const b of only ?? this.list) {
      b.hit = 0;
      // (the broad phase once a frame: the highest ground it could reach this frame)
      const r0 = b.radius + len(b.v) * dt + 0.5;
      const top = this.ground.topIn(b.pos[0] - r0, b.pos[1] - r0, b.pos[0] + r0, b.pos[1] + r0);
      for (let s = 0; s < n; s++) this.substep(b, h, top);
      b.age += dt;
      b.grace -= dt;
      // (a lean ends when it has come down hard, or in time)
      if (b.tipping > 0) b.tipping = b.hit > 3 && b.age > 0.3 ? 0 : b.tipping - dt;
      b.dustT += dt;
      if (b.hit > 1.5 && (b.dustT > 0.25 || b.hit > this.breakSpeedOf(b))) {
        b.dustT = 0;
        hits.push({ body: b, speed: b.hit, at: b.hitAt });
      }
      if (b.still > REST_T || b.age > MAX_AGE) rest.push(b);
    }
    this.stats.stepMs = performance.now() - t0;
    return { hits, rest };
  }

  private substep(b: RockBody, h: number, top: number): void {
    // gravity, air, top speed; the spin damped
    b.v[2] -= G * RB.gravity * h;
    const drag = Math.exp(-AIR_DRAG * h);
    b.v = mul(b.v, drag);
    const sp = len(b.v);
    if (sp > RB.maxV) b.v = mul(b.v, RB.maxV / sp);
    b.w = mul(b.w, Math.exp(-RB.angDamp * h));
    const R = rotM(b.q);
    // the contacts: its corners in the ground (only those low enough to reach it)
    const r0 = b.radius;
    const contacts: { r: V3; n: V3; d: number }[] = [];
    if (b.pos[2] - r0 <= top + 0.5)
      for (const p of b.pts) {
        const r = mv(R, p);
        const wz = b.pos[2] + r[2];
        if (wz > top + 0.05 && wz > 0) continue;
        const c = this.ground.probe(b.pos[0] + r[0], b.pos[1] + r[1], wz);
        if (c) contacts.push({ r, n: c.n, d: c.d });
      }
    b.contact = contacts.length > 0;
    this.stats.contacts = Math.max(this.stats.contacts, contacts.length);
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
      // pushed out of the ground (the deepest first, each only as far as the others haven't already)
      contacts.sort((a, c) => c.d - a.d);
      let corr: V3 = [0, 0, 0];
      for (let i = 0; i < Math.min(8, contacts.length); i++) {
        const { n, d } = contacts[i];
        const need = d - SLOP - dot(corr, n);
        if (need > 0) corr = add(corr, mul(n, need));
      }
      b.pos = add(b.pos, mul(corr, 0.5));
    }
    // integrate
    b.pos = add(b.pos, mul(b.v, h));
    const [wx, wy, wz] = b.w;
    const [x, y, z, w] = b.q;
    const hh = 0.5 * h;
    const q: Q = [x + hh * (wx * w + wy * z - wz * y), y + hh * (wy * w + wz * x - wx * z), z + hh * (wz * w + wx * y - wy * x), w - hh * (wx * x + wy * y + wz * z)];
    const ql = Math.hypot(q[0], q[1], q[2], q[3]);
    b.q = [q[0] / ql, q[1] / ql, q[2] / ql, q[3] / ql];
    // (round 96) touching: the spin and the slide damped (a landed piece stays down)
    if (b.contact && RB.contactDamp > 0 && b.tipping <= 0) {
      const k = Math.exp(-RB.contactDamp * h);
      b.w = mul(b.w, k);
      b.v = [b.v[0] * k, b.v[1] * k, b.v[2]];
    }
    if (b.contact && b.tipping <= 0 && len(b.v) < REST_V && len(b.w) < REST_W) b.still += h;
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
    if (speed < thr || b.grace > 0 || b.gen >= MAX_GEN) return null;
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
        // it goes on as the body moved at its centre, thrown apart from the point hit
        const rc = sub(nbBody.pos, b.pos);
        const away = sub(nbBody.pos, at);
        const al = len(away) || 1;
        nbBody.v = add(add(b.v, cross(b.w, rc)), mul(away, (RB.scatter * speed) / al));
        nbBody.w = [...b.w] as V3;
        nbBody.age = b.age;
        pieces.push(nbBody);
      }
    }
    return { rubble, pieces, seeds: seedOut, hit: add(hit, b.origin), rad };
  }

  /** spawn frame → world, rows of a 3×4 (rotation | translation): what its mesh is drawn with */
  matrix(b: RockBody): number[] {
    const R = rotM(b.q);
    const t = sub(b.pos, mv(R, b.origin));
    return [R[0], R[1], R[2], t[0], R[3], R[4], R[5], t[1], R[6], R[7], R[8], t[2]];
  }

  /** its cells as lattice cells of the spawn frame (column x, y, cell z): what its mesh is made from */
  latCells(b: RockBody): { x: number; y: number; z: number; mat: number }[] {
    return b.cells.map((k) => ({ x: k.lat[0], y: k.lat[1], z: k.lat[2], mat: k.mat }));
  }

  /** (round 96) the impact speed that breaks it: its strength's, less for a big piece (the square-cube law: RB.sizeK) */
  breakSpeedOf(b: RockBody): number {
    return RB.breakSpeed * Math.sqrt(b.strength) * Math.pow(Math.max(1, b.cells.length) / 200, -RB.sizeK);
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
    for (const b of this.list) b.pos = [b.pos[0] - dx, b.pos[1] - dy, b.pos[2] - dz];
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

  /** Their surface cells for the body-voxel draw (Bodies.pack's form: centre xyz, material, quaternion), from `o` (in 8-word voxels); `which`: those bodies only */
  packInto(f: Float32Array, u: Uint32Array, o: number, max: number, which: (b: RockBody) => boolean = () => true): number {
    let n = o;
    for (const b of this.list) {
      if (!which(b)) continue;
      const R = rotM(b.q);
      for (const k of b.surf) {
        if (n >= max) return n;
        const p = mv(R, k.p);
        const i = n * 8;
        f[i] = b.pos[0] + p[0];
        f[i + 1] = b.pos[1] + p[1];
        f[i + 2] = b.pos[2] + p[2];
        u[i + 3] = k.mat;
        f[i + 4] = b.q[0];
        f[i + 5] = b.q[1];
        f[i + 6] = b.q[2];
        f[i + 7] = b.q[3];
        n++;
      }
    }
    return n;
  }
}
