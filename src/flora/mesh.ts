// Plant meshes from skeletons (round 117). Low-poly and faceted, the look the instanced trees already have
// (render/treemesh.ts, MI3): the fragment shades each face flat from its derivatives, so a few triangles read as a
// cut-gem tree that sits with the per-cell terrain. The user: "I am ok with stylized or low fidelity but I just want
// it to be readable and pretty and look integrated with the world."
//
// A vertex is four floats (x, y, z, w) — the instanced mesh renderer's format (render/meshinst.ts) — with
//   w = part + sway, part an integer ≥ 3 (PART below; parts 0–2 are treemesh.ts's), sway 0..0.99 how much the wind
//   moves it (0 at the foot, more up the plant and out along a branch: the shader multiplies the column's lean by it).
// Why pack sway into w: the renderer's vertex format and buffers stay as they are (one float4 a vertex), and the
// shader needs only these two facts per vertex.
//
// Winding: counter-clockwise seen from outside. Thin parts (blades, petals) are two-sided: each triangle twice.

import type { LeafSite, Segment, Skeleton, V3 } from './lsystem';
import { norm } from './lsystem';
import { rng } from './rng';

export const PART = {
  /** bark (the species' bark colour; birch: white with dark marks) */
  wood: 3,
  /** foliage (the species' leaf colours, turned by the season) */
  leaf: 4,
  /** grass / reed / fern blades (the grass's season colours) */
  blade: 5,
  /** petals (the species' flower colour) */
  flower: 6,
  /** roots above ground (bark, darker; no sway) */
  root: 7,
  /** an accent: seed heads, catkins, cattails (the species' accent colour) */
  accent: 8,
  /** (round 128) an epiphyte's green: ferns and tufts in the forks, a vine's leaves (evergreen: stays in winter) */
  epiphyte: 9,
  /** (round 128) hanging lines: lianas, Spanish-moss strands (grey-green, swing in the wind) */
  strand: 10,
  /** (round 128) icicles: drawn only in winter (floralook.wgsl seasonSnow) */
  ice: 11,
} as const;

export interface FloraMesh {
  verts: Float32Array;
  index: Uint32Array;
  /** bounds (cells): height and horizontal radius */
  height: number;
  radius: number;
  tris: number;
}

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** Two unit vectors across the direction d (a frame for rings). */
function across(d: V3): [V3, V3] {
  const up: V3 = Math.abs(d[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const u = norm(cross(d, up));
  const v = norm(cross(d, u));
  return [u, v];
}

export class MeshBuilder {
  v: number[] = [];
  i: number[] = [];
  /** the sway at height z: set by the caller (plants of different heights) */
  constructor(private swayAt: (p: V3, extra: number) => number) {}
  vert(p: V3, part: number, extra = 0): number {
    const s = Math.min(0.99, Math.max(0, this.swayAt(p, extra)));
    this.v.push(p[0], p[1], p[2], part + s);
    return this.v.length / 4 - 1;
  }
  tri(a: number, b: number, c: number): void {
    this.i.push(a, b, c);
  }
  tri2(a: number, b: number, c: number): void {
    this.i.push(a, b, c, a, c, b);
  }
  /** a tapered n-gon tube along a segment (sides only; a cap at the far end when it is thick) */
  tube(g: Segment, n: number, part: number, extra = 0): void {
    const d = norm(sub(g.b, g.a));
    const [u, w] = across(d);
    const lo: number[] = [];
    const hi: number[] = [];
    for (let k = 0; k < n; k++) {
      const t = (k / n) * Math.PI * 2;
      const o: V3 = add(mul(u, Math.cos(t)), mul(w, Math.sin(t)));
      lo.push(this.vert(add(g.a, mul(o, g.r0)), part, extra));
      hi.push(this.vert(add(g.b, mul(o, g.r1)), part, extra));
    }
    for (let k = 0; k < n; k++) {
      const j = (k + 1) % n;
      this.tri(lo[k], lo[j], hi[j]);
      this.tri(lo[k], hi[j], hi[k]);
    }
  }
  /**
   * (round 128) A whole stem as one n-gon tube: rings shared along it (no seams at the steps), each ring across the
   * mean of the two steps' directions, carried along by parallel transport (no flips), turned by the stem's twist;
   * subdivided to `look.ring` cells so the noise and the knots show; the radius perturbed by smooth noise along and
   * around it and bulged at knots. `k`: world cells a skeleton unit. `minR`: the radius drawn at least (the phone).
   */
  stem(path: StemPath, n: number, look: StemLook, k: number, seed: number, part: number, extra: number, minR = 0): void {
    const P = path.p;
    if (P.length < 2) return;
    const r01 = rng(seed);
    // arc length at each point (world cells)
    const S = [0];
    for (let i = 1; i < P.length; i++) S.push(S[i - 1] + Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1], P[i][2] - P[i - 1][2]) * k);
    const L = S[S.length - 1];
    // knots: where, which way round, how wide and big
    const kn: { s: number; a: number; w: number; m: number }[] = [];
    const nk = Math.floor((L * look.knots) / 10 + r01());
    for (let q = 0; q < nk; q++) kn.push({ s: L * (0.08 + 0.84 * r01()), a: r01() * Math.PI * 2, w: Math.max(0.25, path.r[0] * k * (1.2 + r01())), m: look.knotSize * (0.5 + r01()) });
    const nseed = Math.floor(r01() * 2 ** 31);
    const radius = (s: number, r: number, th: number) => {
      let f = 1;
      if (look.noise) f += look.noise * (vnoise2(s * look.noiseFreq, (th / (Math.PI * 2)) * 4, 4, nseed) + 0.5 * vnoise2(s * look.noiseFreq * 2.3, (th / (Math.PI * 2)) * 8, 8, nseed ^ 0x55));
      for (const q of kn) {
        const ds = (s - q.s) / q.w;
        if (Math.abs(ds) > 3) continue;
        const c = Math.max(0, Math.cos(th - q.a));
        f += q.m * Math.exp(-ds * ds) * c * c;
      }
      return Math.max(r * Math.max(0.3, f), minR);
    };
    let u: V3 | null = null;
    let prev: number[] | null = null;
    let prevT: V3 | null = null;
    for (let i = 0; i < P.length; i++) {
      const dIn = i > 0 ? norm(sub(P[i], P[i - 1])) : null;
      const dOut = i < P.length - 1 ? norm(sub(P[i + 1], P[i])) : null;
      // (sub-rings from the previous point to this one: the step cut to `look.ring` cells)
      const steps = i === 0 ? 1 : Math.max(1, Math.min(6, Math.round((S[i] - S[i - 1]) / Math.max(0.2, look.ring))));
      for (let j = 1; j <= steps; j++) {
        const f = j / steps;
        const at: V3 = i === 0 ? P[0] : add(P[i - 1], mul(sub(P[i], P[i - 1]), f));
        const r = i === 0 ? path.r[0] : path.r[i - 1] + (path.r[i] - path.r[i - 1]) * f;
        const s = i === 0 ? 0 : S[i - 1] + (S[i] - S[i - 1]) * f;
        const tw = i === 0 ? path.tw[0] : path.tw[i - 1] + (path.tw[i] - path.tw[i - 1]) * f;
        // the ring's direction: along the step inside it, the mean of the two at a joint
        const t: V3 = j < steps || i === 0 ? (dOut && i === 0 ? dOut : dIn!) : dOut ? norm(add(dIn!, dOut)) : dIn!;
        if (!u) u = across(t)[0];
        else if (prevT) {
          // parallel transport: the previous across-vector, its component along t taken out
          const pu = sub(u, mul(t, u[0] * t[0] + u[1] * t[1] + u[2] * t[2]));
          u = Math.hypot(pu[0], pu[1], pu[2]) > 1e-4 ? norm(pu) : across(t)[0];
        }
        prevT = t;
        const v = norm(cross(t, u));
        const ring: number[] = [];
        for (let q = 0; q < n; q++) {
          const th = (q / n) * Math.PI * 2;
          const tq = th + tw;
          const o: V3 = add(mul(u, Math.cos(tq)), mul(v, Math.sin(tq)));
          ring.push(this.vert(add(at, mul(o, radius(s, r, th))), part, extra));
        }
        if (prev) {
          for (let q = 0; q < n; q++) {
            const w = (q + 1) % n;
            this.tri(prev[q], prev[w], ring[w]);
            this.tri(prev[q], ring[w], ring[q]);
          }
        }
        prev = ring;
      }
    }
  }
  /** a faceted blob (an octahedron, jittered): leaf clusters, moss cushions */
  blob(c: V3, r: V3, part: number, r01: () => number, extra = 0): void {
    const j = () => 0.8 + 0.4 * r01();
    const P: V3[] = [
      [c[0] + r[0] * j(), c[1], c[2]], [c[0] - r[0] * j(), c[1], c[2]],
      [c[0], c[1] + r[1] * j(), c[2]], [c[0], c[1] - r[1] * j(), c[2]],
      [c[0], c[1], c[2] + r[2] * j()], [c[0], c[1], c[2] - r[2] * j()],
    ];
    const id = P.map((p) => this.vert(p, part, extra));
    const F = [[0, 2, 4], [2, 1, 4], [1, 3, 4], [3, 0, 4], [2, 0, 5], [1, 2, 5], [3, 1, 5], [0, 3, 5]];
    for (const [a, b, d] of F) this.tri(id[a], id[b], id[d]);
  }
  /** a cone (n sides, its base closed) from base centre b along d to length len, base radius r */
  cone(b: V3, d: V3, len: number, r: number, n: number, part: number, extra = 0): void {
    const [u, w] = across(d);
    const ring: number[] = [];
    for (let k = 0; k < n; k++) {
      const t = (k / n) * Math.PI * 2;
      ring.push(this.vert(add(b, add(mul(u, Math.cos(t) * r), mul(w, Math.sin(t) * r))), part, extra));
    }
    const tip = this.vert(add(b, mul(d, len)), part, extra);
    const bot = this.vert(b, part, extra);
    for (let k = 0; k < n; k++) {
      const j = (k + 1) % n;
      this.tri(ring[k], ring[j], tip);
      this.tri(ring[j], ring[k], bot);
    }
  }
  /** a blade: a thin two-sided strip of `segs` quads curving from the root p along d, bending by `bend` per segment */
  blade(p: V3, d: V3, len: number, width: number, segs: number, bend: V3, part: number, extra = 0): void {
    const [u] = across(d);
    let at = p;
    let dir = norm(d);
    let prevL = this.vert(add(at, mul(u, -width / 2)), part, extra);
    let prevR = this.vert(add(at, mul(u, width / 2)), part, extra);
    for (let s = 1; s <= segs; s++) {
      at = add(at, mul(dir, len / segs));
      dir = norm(add(dir, bend));
      const wdt = width * (1 - s / segs) * 0.9 + width * 0.05;
      if (s === segs) {
        const tip = this.vert(at, part, extra);
        this.tri2(prevL, prevR, tip);
      } else {
        const L = this.vert(add(at, mul(u, -wdt / 2)), part, extra);
        const R = this.vert(add(at, mul(u, wdt / 2)), part, extra);
        this.tri2(prevL, prevR, R);
        this.tri2(prevL, R, L);
        prevL = L;
        prevR = R;
      }
    }
  }
  done(): FloraMesh {
    let height = 0;
    let radius = 0;
    for (let k = 0; k < this.v.length; k += 4) {
      height = Math.max(height, this.v[k + 2]);
      radius = Math.max(radius, Math.hypot(this.v[k], this.v[k + 1]));
    }
    return { verts: new Float32Array(this.v), index: new Uint32Array(this.i), height, radius, tris: this.i.length / 3 };
  }
}

/**
 * (round 128, treegen) How a stem is extruded: an n-gon swept along the whole branch (fork to tip) with shared rings,
 * its radius perturbed by noise along and around it, with knots. Replaces the round-117 primitive — a separate
 * capless tapered prism per turtle step, which showed seams and a straight, perfectly round stick between forks.
 * Lengths in world cells (the plant's final scale), amplitudes as a share of the local radius.
 */
export interface StemLook {
  /** the trunk's sides (thinner stems use fewer: −2, then 3) */
  sides: number;
  /** the radius' noise: amplitude (share of the radius, ~0.05-0.3) and frequency along (cycles a cell) */
  noise: number;
  noiseFreq: number;
  /** knots (bulges, burls, branch scars): how many per 10 cells of stem, and their size (share of the radius) */
  knots: number;
  knotSize: number;
  /** ring spacing along a stem (cells; at least one ring a turtle step: the noise needs rings to show) */
  ring: number;
}

/** a stem's points along it: the skeleton's segments of one stem, end to start */
export interface StemPath {
  p: V3[];
  r: number[];
  tw: number[];
  depth: number;
}

/** Group a skeleton's segments into stems (a stem id's segments in order; a lone segment is a stem of its own). */
export function stemPaths(segs: Segment[], cut: (g: Segment) => boolean): StemPath[] {
  const by = new Map<number, StemPath>();
  const out: StemPath[] = [];
  for (const g of segs) {
    let path = g.stem !== undefined ? by.get(g.stem) : undefined;
    const last = path ? path.p[path.p.length - 1] : null;
    const joined = path && last && Math.abs(last[0] - g.a[0]) + Math.abs(last[1] - g.a[1]) + Math.abs(last[2] - g.a[2]) < 1e-6;
    if (path && (path as StemPath & { done?: boolean }).done) continue;
    if (cut(g)) {
      // (thinner than the cut: the stem ends here — its thinner tail too)
      if (path) (path as StemPath & { done?: boolean }).done = true;
      continue;
    }
    if (!path || !joined) {
      path = { p: [g.a], r: [g.r0], tw: [g.twist ?? 0], depth: g.depth };
      out.push(path);
      if (g.stem !== undefined) by.set(g.stem, path);
    }
    path.p.push(g.b);
    path.r.push(g.r1);
    path.tw.push(g.twist ?? 0);
  }
  // (a point's twist is its segment's start; the tip carries the last step's on)
  for (const s of out) if (s.tw.length > 2) s.tw[s.tw.length - 1] = 2 * s.tw[s.tw.length - 2] - s.tw[s.tw.length - 3];
  return out;
}

/** smooth value noise in (x along, y around with period `py`), −1..1 */
function vnoise2(x: number, y: number, py: number, seed: number): number {
  const h = (i: number, j: number) => {
    let v = Math.imul(i, 374761393) ^ Math.imul(((j % py) + py) % py, 668265263) ^ seed;
    v = Math.imul(v ^ (v >>> 13), 1274126177);
    return (((v ^ (v >>> 16)) >>> 0) / 4294967296) * 2 - 1;
  };
  const i = Math.floor(x);
  const j = Math.floor(y);
  const fx = x - i;
  const fy = y - j;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = h(i, j) + (h(i + 1, j) - h(i, j)) * sx;
  const b = h(i, j + 1) + (h(i + 1, j + 1) - h(i, j + 1)) * sx;
  return a + (b - a) * sy;
}

export type LeafStyle ='cluster' | 'drop' | 'needles' | 'leaflet' | 'none';

export interface LeafLook {
  style: LeafStyle;
  /** size (cells) */
  size: number;
  /** leaves per site (drops hang in little bunches) */
  per: number;
  /** leaf sites below this depth carry no leaves (a bare trunk) */
  minDepth: number;
}

/** Wood: segments as tubes, fewer sides on thinner branches; then leaves at the sites. */
/**
 * `minRadius` (skeleton units; round 117, the phone): wood drawn at least this thick, twigs under half of it left out —
 * a branch narrower than a pixel or two breaks into dotted dashes at a low render scale. `minLeaf`: leaf clusters at
 * least this big, fewer of them (merged), so a crown reads as masses, not specks.
 */
export function buildPlant(sk: Skeleton, leaf: LeafLook, seed: number, opts: { sides?: number; roots?: Segment[]; minTwig?: number; minRadius?: number; minLeaf?: number; stem?: StemLook; scale?: number; keepLimbs?: boolean; extra?: (mb: MeshBuilder, cut: number) => void } = {}): FloraMesh {
  const H = Math.max(sk.height, 0.5);
  const r01 = rng(seed ^ 0x1eaf);
  // sway: nothing at the foot, rising up the plant (squared: a trunk bends near its top), and a little more out on
  // the twigs and leaves (`extra`)
  const mb = new MeshBuilder((p, extra) => Math.pow(Math.max(0, p[2]) / H, 1.6) * 0.8 + extra);
  const sides = opts.stem?.sides ?? opts.sides ?? 6;
  // (twigs thinner than a few hundredths of a cell are left out: under a pixel at play zoom, and most of a tree's
  // triangles — the leaves they carry still show where they are)
  const minR = opts.minRadius ?? 0;
  const cutR = Math.max(opts.minTwig ?? 0.035, minR * 0.5);
  const sidesAt = (r0: number) => (r0 > 0.25 ? sides : r0 > 0.08 ? Math.max(3, sides - 2) : 3);
  if (opts.stem) {
    // (round 128) each branch one extruded, noise-perturbed tube
    const k = opts.scale ?? 1;
    let q = 0;
    // (`keepLimbs`, the deciduous: the limbs off the trunk always kept, thickened to the minimum: in winter, bare, they are the tree's shape — a
    // birch's coarse level was its trunk alone; the twigs beyond still go under the cut)
    for (const path of stemPaths(sk.segments, (g) => (!opts.keepLimbs || g.depth > 1) && g.r0 < cutR)) {
      mb.stem(path, sidesAt(path.r[0]), opts.stem, k, seed ^ Math.imul(++q, 0x9e3779b1), PART.wood, Math.min(0.15, path.depth * 0.05), minR);
    }
  } else {
    // (round 117: a capless prism a turtle step — the viewer's "old" side)
    for (const g of sk.segments) {
      if (g.r0 < cutR) continue;
      mb.tube({ ...g, r0: Math.max(g.r0, minR), r1: Math.max(g.r1, minR * 0.85) }, sidesAt(g.r0), PART.wood, Math.min(0.15, g.depth * 0.05));
    }
  }
  for (const g of opts.roots ?? []) mb.tube(g, g.r0 > 0.12 ? 4 : 3, PART.root);
  // (round 128: what grows on it and winter's icicles — epiphytes.ts, by the caller)
  opts.extra?.(mb, cutR);
  // (coarse leaves: bigger clusters, fewer of them — the crown's volume about kept: a site in `keep` carries one)
  const grow = opts.minLeaf && opts.minLeaf > leaf.size ? opts.minLeaf / leaf.size : 1;
  const look = grow > 1 ? { ...leaf, size: leaf.size * grow, per: Math.max(1, Math.round(leaf.per / grow)) } : leaf;
  const keep = grow > 1 ? Math.min(1, 1.6 / (grow * grow)) : 1;
  for (const l of sk.leaves) {
    if (l.depth < leaf.minDepth) continue;
    if (keep < 1 && r01() > keep) continue;
    addLeaves(mb, l, look, r01);
  }
  return mb.done();
}

function addLeaves(mb: MeshBuilder, l: LeafSite, leaf: LeafLook, r01: () => number): void {
  const s = leaf.size;
  switch (leaf.style) {
    case 'cluster': {
      // a lumpy cluster round the twig's end, flattened a little (crowns read as layered masses)
      for (let k = 0; k < leaf.per; k++) {
        const o: V3 = [(r01() - 0.5) * s, (r01() - 0.5) * s, (r01() - 0.3) * s * 0.6];
        mb.blob(add(l.p, o), [s * (0.7 + 0.3 * r01()), s * (0.7 + 0.3 * r01()), s * 0.55], PART.leaf, r01, 0.12);
      }
      break;
    }
    case 'drop': {
      // birch: small diamond leaves hanging in bunches from the weeping twigs (three-sided bipyramids: 6 triangles)
      for (let k = 0; k < leaf.per; k++) {
        const c: V3 = add(l.p, [(r01() - 0.5) * s * 2.2, (r01() - 0.5) * s * 2.2, -r01() * s * 2.5]);
        const t0 = r01() * Math.PI * 2;
        const ring = [0, 1, 2].map((j) => {
          const t = t0 + (j / 3) * Math.PI * 2;
          return mb.vert([c[0] + Math.cos(t) * s * 0.6, c[1] + Math.sin(t) * s * 0.6, c[2]], PART.leaf, 0.2);
        });
        const top = mb.vert([c[0], c[1], c[2] + s * 0.7], PART.leaf, 0.2);
        const bot = mb.vert([c[0], c[1], c[2] - s * 0.9], PART.leaf, 0.2);
        for (let j = 0; j < 3; j++) {
          const n = (j + 1) % 3;
          mb.tri(ring[j], ring[n], top);
          mb.tri(ring[n], ring[j], bot);
        }
      }
      break;
    }
    case 'needles': {
      // conifer: a drooping tuft (a cone opening downward along the branch)
      const d = norm([l.d[0], l.d[1], l.d[2] - 0.6]);
      mb.cone(add(l.p, mul(d, -s * 0.6)), d, s * 1.2, s * 0.7, 4, PART.leaf, 0.1);
      break;
    }
    case 'leaflet': {
      // a fern's pinna: a short blade off the frond
      mb.blade(l.p, norm([l.d[0], l.d[1], l.d[2] + 0.2]), s, s * 0.35, 1, [0, 0, -0.25], PART.blade, 0.15);
      break;
    }
    case 'none':
      break;
  }
}
