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
  /** (round 128) the fine twigs (TwigLook): the bark darkened toward its mark colour — a birch's twigs are dark */
  twig: 14,
} as const;

export interface FloraMesh {
  verts: Float32Array;
  /** (round 128) per vertex four floats: its surface coordinates — on wood u round the stem and v along it, in cells
   *  (the bark's procedural texture); on a leaf card its card space 0..1; on a canopy lobe u = −1, v its ambient
   *  occlusion — and, on a lobe, its smooth normal (octahedral, z w); elsewhere 0 */
  uv: Float32Array;
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
  uv: number[] = [];
  i: number[] = [];
  /** the sway at height z: set by the caller (plants of different heights) */
  constructor(private swayAt: (p: V3, extra: number) => number) {}
  vert(p: V3, part: number, extra = 0, u = 0, v = 0, nrm?: V3): number {
    const s = Math.min(0.99, Math.max(0, this.swayAt(p, extra)));
    this.v.push(p[0], p[1], p[2], part + s);
    // (a smooth normal, octahedral: the canopy lobes' — meshinst.wgsl shades them round, not faceted)
    let ox = 0;
    let oy = 0;
    if (nrm) {
      const l = Math.abs(nrm[0]) + Math.abs(nrm[1]) + Math.abs(nrm[2]) || 1;
      ox = nrm[0] / l;
      oy = nrm[1] / l;
      if (nrm[2] < 0) [ox, oy] = [(1 - Math.abs(oy)) * (ox >= 0 ? 1 : -1), (1 - Math.abs(ox)) * (oy >= 0 ? 1 : -1)];
    }
    this.uv.push(u, v, ox, oy);
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
    // (round 128: u round, v along — a seam's column of vertices doubled so u runs 0 .. the circumference)
    const L = Math.hypot(g.b[0] - g.a[0], g.b[1] - g.a[1], g.b[2] - g.a[2]);
    const C = Math.PI * 2 * g.r0;
    for (let k = 0; k <= n; k++) {
      const t = (k / n) * Math.PI * 2;
      const o: V3 = add(mul(u, Math.cos(t)), mul(w, Math.sin(t)));
      lo.push(this.vert(add(g.a, mul(o, g.r0)), part, extra, (k / n) * C, 0, o));
      hi.push(this.vert(add(g.b, mul(o, g.r1)), part, extra, (k / n) * C, L, o));
    }
    for (let k = 0; k < n; k++) {
      const j = k + 1;
      this.tri(lo[k], lo[j], hi[j]);
      this.tri(lo[k], hi[j], hi[k]);
    }
    // (round 128, main's review: a thick prism's top was an open pipe — a stump, the viewer's old trunks: closed)
    if (g.r1 > 0.3) {
      const top = this.vert(g.b, part, extra, C / 2, L);
      for (let k = 0; k < n; k++) this.tri(hi[k], hi[k + 1], top);
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
    const C0 = Math.PI * 2 * path.r[0] * k;
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
        // (round 128: the bark's coordinates — u round the stem in cells of its foot's circumference, v along it in
        // cells; the seam's column doubled so u runs 0 .. C)
        for (let q = 0; q <= n; q++) {
          const th = (q / n) * Math.PI * 2;
          const tq = th + tw;
          const o: V3 = add(mul(u, Math.cos(tq)), mul(v, Math.sin(tq)));
          // (round 128, the user: "the trunk should have way more verts or else Phong normal shading so it looks smooth
          // and not polygonal" — the ring's radial direction as the vertex's normal: the stem shades round)
          ring.push(this.vert(add(at, mul(o, radius(s, r, th % (Math.PI * 2)))), part, extra, (q / n) * C0, s, o));
        }
        if (prev) {
          for (let q = 0; q < n; q++) {
            const w = q + 1;
            this.tri(prev[q], prev[w], ring[w]);
            this.tri(prev[q], ring[w], ring[q]);
          }
        }
        prev = ring;
      }
    }
    // (a thick stem's end closed with a low dome: a bole that forks into limbs ends inside them, but its noise and
    // knots open gaps a flat end would show — the elder's fork was a hollow pipe)
    const rEnd = path.r[path.r.length - 1];
    if (prev && prevT && rEnd > 0.25) {
      const tip = this.vert(add(P[P.length - 1], mul(prevT, rEnd * 0.6)), part, extra, C0 / 2, L + rEnd * k * 0.6);
      for (let q = 0; q < n; q++) this.tri(prev[q], prev[q + 1], tip);
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
    let prevL = this.vert(add(at, mul(u, -width / 2)), part, extra, 0, 0);
    let prevR = this.vert(add(at, mul(u, width / 2)), part, extra, 1, 0);
    for (let s = 1; s <= segs; s++) {
      at = add(at, mul(dir, len / segs));
      dir = norm(add(dir, bend));
      const wdt = width * (1 - s / segs) * 0.9 + width * 0.05;
      if (s === segs) {
        const tip = this.vert(at, part, extra, 0.5, 1);
        this.tri2(prevL, prevR, tip);
      } else {
        const L = this.vert(add(at, mul(u, -wdt / 2)), part, extra, 0, s / segs);
        const R = this.vert(add(at, mul(u, wdt / 2)), part, extra, 1, s / segs);
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
    return { verts: new Float32Array(this.v), uv: new Float32Array(this.uv), index: new Uint32Array(this.i), height, radius, tris: this.i.length / 3 };
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

/**
 * (round 128, treegen; main's review: "leaf clusters attached along the last branch orders (many smaller clusters, gaps
 * between them so sky and branches show through, the silhouette broken up), clusters shaped from the generator's branch
 * tips rather than a fixed pyramid primitive, and a crown parameter set") A broadleaf crown: at each twig's end and
 * back along it, sprays of small leaf cards — each a flat diamond turned off the twig, drooping — some left out for
 * gaps. Replaces round 117's one faceted octahedron a leaf site (the 'cluster' style's blob), which stacked into slabs
 * and pyramids that hid the branching. Sizes in world cells.
 */
export interface CrownLook {
  /** a spray's reach (cells) */
  size: number;
  /** sprays a twig: one at its end, the rest back along it */
  perTwig: number;
  /** spacing back along the twig (cells) */
  spacing: number;
  /** the share of sprays kept (the gaps: 1 a full crown) */
  fill: number;
  /** leaf cards a spray */
  leaves: number;
  /** how far the cards hang (0 level with the twig .. 1 hanging) */
  droop: number;
  /** (round 128, the user: "You could even have completely opaque canopy of leaves with random gaps") 'sprays' the
   *  cards; 'solid' an opaque leaf mass — lumpy shells round clumps of the crown's leaf sites, holes punched through */
  style?: 'sprays' | 'solid' | 'lobecards' | 'hybrid' | 'layers';
  /** layers: shells of cards a lobe, how far apart (a share of its reach), how much darker each deeper one, how much a
   *  card bends to follow its lobe (0 flat .. 1 on the curve), and a dark closed core under them (0 / 1) */
  layers?: number;
  layerGap?: number;
  depthDark?: number;
  bend?: number;
  core?: number;
  /** hybrid: leaf cards a square cell of a lobe's surface */
  shell?: number;
  /** layers: how far apart the lobes stand (0 as clumped .. 1) */
  separate?: number;
  /** solid / lobecards: the stems thinner than this (cells) aren't drawn — inside the leaf mass */
  hideBelow?: number;
  /** lobecards: how much a card takes its lobe's normal (0 its own .. 1 the lobe's) */
  lobeBlend?: number;
  /** solid: a clump's reach (cells) — the shells' size */
  clump?: number;
  /** solid: the share of the shells' faces left out (the gaps: sky and limbs through them) */
  gaps?: number;
  /** solid: how lumpy a shell is (0 round .. 1) */
  lumps?: number;
}

/**
 * (round 128, main's review of the bare trees: "A bare tree reads from its fine twigs. Add one or two finer branch
 * orders (thin, many, generator-driven: count, angle, length falloff)") The twigs past the L-system's last order: from
 * each twig end and along the last two branch orders, `count` thin flat strips (two triangles each) leaving at `angle`
 * from the branch, `length` cells long, and on each `orders` − 1 more of `falloff` × its length from its middle. Drawn
 * all year (under the leaves, the crown's branching; bare, its fine silhouette), as wood. Sizes in cells.
 */
export interface TwigLook {
  count: number;
  /** degrees off the branch */
  angle: number;
  length: number;
  /** a child twig's length over its parent's */
  falloff: number;
  /** 1 or 2 orders */
  orders: number;
  /** how far they hang (0 as they grow .. 1 down: a birch's weeping twigs) */
  droop: number;
  /** a twig's width (cells; at least ~0.7 px where the plant is made for `px`) */
  width: number;
  /** spacing along the last orders (cells) */
  spacing: number;
}

/** Wood: segments as tubes, fewer sides on thinner branches; then leaves at the sites. */
/**
 * `minRadius` (skeleton units; round 117, the phone): wood drawn at least this thick, twigs under half of it left out —
 * a branch narrower than a pixel or two breaks into dotted dashes at a low render scale. `minLeaf`: leaf clusters at
 * least this big, fewer of them (merged), so a crown reads as masses, not specks.
 */
export function buildPlant(sk: Skeleton, leaf: LeafLook, seed: number, opts: { sides?: number; roots?: Segment[]; minTwig?: number; minRadius?: number; minLeaf?: number; stem?: StemLook; crown?: CrownLook; twigs?: TwigLook; px?: number; bake?: boolean; scale?: number; keepLimbs?: boolean; extra?: (mb: MeshBuilder, cut: number) => void } = {}): FloraMesh {
  const H = Math.max(sk.height, 0.5);
  const r01 = rng(seed ^ 0x1eaf);
  // sway: nothing at the foot, rising up the plant (squared: a trunk bends near its top), and a little more out on
  // the twigs and leaves (`extra`)
  const mb = new MeshBuilder((p, extra) => Math.pow(Math.max(0, p[2]) / H, 1.6) * 0.8 + extra);
  const sides = opts.stem?.sides ?? opts.sides ?? 6;
  // (twigs thinner than a few hundredths of a cell are left out: under a pixel at play zoom, and most of a tree's
  // triangles — the leaves they carry still show where they are)
  const minR = opts.minRadius ?? 0;
  // (round 128: a solid crown hides its thin branches — inside the leaf mass — so they aren't drawn: the stems under
  // ~0.12 cells, and no fine twigs)
  const solid = opts.crown?.style === 'solid' || opts.crown?.style === 'hybrid' || opts.crown?.style === 'layers';
  const cutR = Math.max(opts.minTwig ?? 0.035, minR * 0.5, solid ? (opts.crown?.hideBelow ?? 0.12) / (opts.scale ?? 1) : 0);
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
  // (round 128: the fine twigs past the last order)
  if (opts.twigs && !solid) addTwigs(mb, sk, leaf.minDepth, opts.twigs, opts.scale ?? 1, r01, opts.px);
  if (opts.crown && leaf.style === 'cluster' && opts.crown.style === 'layers') {
    addLayeredCrown(mb, sk, leaf.minDepth, opts.crown, opts.scale ?? 1, r01, opts.px, opts.bake);
    return mb.done();
  }
  if (opts.crown && leaf.style === 'cluster' && opts.crown.style === 'hybrid') {
    addHybridCrown(mb, sk, leaf.minDepth, opts.crown, opts.scale ?? 1, r01, opts.px, opts.bake);
    return mb.done();
  }
  if (opts.crown && leaf.style === 'cluster' && opts.crown.style === 'solid') {
    addSolidCrown(mb, sk, leaf.minDepth, opts.crown, opts.scale ?? 1, r01, opts.px, opts.bake);
    return mb.done();
  }
  if (opts.crown && leaf.style === 'cluster') {
    addCrown(mb, sk, leaf.minDepth, opts.crown, opts.scale ?? 1, opts.minLeaf ?? 0, r01, opts.px);
    return mb.done();
  }
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

/** (round 128) the fine twigs (TwigLook): none where a twig would be under ~4 render px long (`px` a cell) */
function addTwigs(mb: MeshBuilder, sk: Skeleton, minDepth: number, t: TwigLook, k: number, r01: () => number, px?: number): void {
  if (px && t.length * px < 4) return;
  const width = Math.max(t.width, px ? 0.7 / px : 0) / k;
  const len0 = t.length / k;
  const rnd = (): V3 => norm([r01() * 2 - 1, r01() * 2 - 1, r01() * 2 - 1]);
  const strip = (a: V3, d: V3, len: number, w: number) => {
    const b = add(a, mul(d, len));
    const side = norm(cross(d, Math.abs(d[2]) < 0.9 ? ([0, 0, 1] as V3) : ([1, 0, 0] as V3)));
    const p0 = mb.vert(add(a, mul(side, w / 2)), PART.twig, 0.15, 0, 0);
    const p1 = mb.vert(add(a, mul(side, -w / 2)), PART.twig, 0.15, 1, 0);
    const p2 = mb.vert(add(b, mul(side, w * 0.15)), PART.twig, 0.2, 0, len);
    const p3 = mb.vert(add(b, mul(side, -w * 0.15)), PART.twig, 0.2, 1, len);
    mb.tri(p0, p1, p3);
    mb.tri(p0, p3, p2);
    return b;
  };
  const ang = (t.angle * Math.PI) / 180;
  const off = (d: V3): V3 => {
    // (a direction `angle` off d, round it at random, bent down by the droop)
    const r = rnd();
    const ax = norm(cross(d, r));
    const c = Math.cos(ang);
    const sn = Math.sin(ang);
    const q = norm(add(mul(d, c), mul(cross(ax, d), sn)));
    return norm(add(q, [0, 0, -t.droop * 1.5]));
  };
  const sprout = (at: V3, d: V3) => {
    for (let i = 0; i < t.count; i++) {
      const dir = off(d);
      const len = len0 * (0.7 + 0.6 * r01());
      const end = strip(at, dir, len, width);
      if (t.orders > 1) {
        const mid = add(at, mul(dir, len * (0.4 + 0.3 * r01())));
        strip(mid, off(dir), len * t.falloff, width * 0.8);
        strip(end, off(dir), len * t.falloff * 0.8, width * 0.7);
      }
    }
  };
  for (const l of sk.leaves) if (l.depth >= minDepth) sprout(l.p, l.d);
  // (along the last two orders, every `spacing`)
  const paths = stemPaths(sk.segments, () => false);
  let deepest = 0;
  for (const p of paths) deepest = Math.max(deepest, p.depth);
  const step = t.spacing / k;
  for (const p of paths) {
    if (p.depth < Math.max(minDepth, deepest - 1) || step <= 0) continue;
    let acc = 0;
    let s = step * 0.5;
    for (let i = 1; i < p.p.length; i++) {
      const a = p.p[i - 1];
      const b = p.p[i];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
      const d = norm([b[0] - a[0], b[1] - a[1], b[2] - a[2]]);
      while (s <= acc + len) {
        const f = (s - acc) / Math.max(len, 1e-6);
        sprout([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f], d);
        s += step;
      }
      acc += len;
    }
  }
}

/** (round 128) one spray of `leaves` leaf cards round `at` along `d` (cells in the mesh's units), drooping by `droop` */
export function sprayAt(mb: MeshBuilder, at: V3, d: V3, size: number, leaves: number, droop: number, r01: () => number, shade?: (p: V3, own: V3) => { n: V3; ao: number }): void {
  const rnd = (): V3 => norm([r01() * 2 - 1, r01() * 2 - 1, r01() * 2 - 1]);
    // (a little off the twig: the sprays follow the branch, not a ball round its tip)
    const ctr: V3 = add(at, mul(rnd(), size * 0.3));
    for (let j = 0; j < leaves; j++) {
      // a card: out from the spray's middle, along the twig and away, bent down by the droop
      const out = rnd();
      const ax = norm(add(add(mul(d, 0.6), mul(out, 0.9)), [0, 0, -droop * 1.2]));
      const side = norm(cross(ax, Math.abs(ax[2]) < 0.9 ? ([0, 0, 1] as V3) : ([1, 0, 0] as V3)));
      // (the card tilted about its axis: faces turned up, down and to the sides, so the light breaks over the spray)
      const tilt = (r01() - 0.5) * 1.6;
      const up = cross(side, ax);
      const sd = norm(add(mul(side, Math.cos(tilt)), mul(up, Math.sin(tilt))));
      const L = size * (0.55 + 0.45 * r01());
      const W = L * (0.45 + 0.2 * r01());
      const base = add(ctr, mul(out, size * 0.15));
      // (card space: u across 0 .. 1, v from the stalk 0 to the tip 1 — the leaf's procedural look)
      const pa = base;
      const pb = add(add(base, mul(ax, L * 0.45)), mul(sd, W / 2));
      const pt = add(base, mul(ax, L));
      const pe = add(add(base, mul(ax, L * 0.45)), mul(sd, -W / 2));
      let a: number, b: number, t: number, e: number;
      if (shade) {
        // (round 128, "lobe-normal cards": each card takes its lobe's normal — the clump shades as one soft round lobe,
        // its edge still leaves — and the lobe's occlusion; uv.x = −1 as a lobe's)
        const own = norm(cross(sub(pb, pa), sub(pt, pa)));
        const v = (p: V3, sw: number) => {
          const s = shade(p, own);
          return mb.vert(p, PART.leaf, sw, -1, s.ao, s.n);
        };
        a = v(pa, 0.12);
        b = v(pb, 0.14);
        t = v(pt, 0.16);
        e = v(pe, 0.14);
      } else {
        // (card space: u across 0 .. 1, v from the stalk 0 to the tip 1 — the leaf's procedural look)
        a = mb.vert(pa, PART.leaf, 0.12, 0.5, 0.001);
        b = mb.vert(pb, PART.leaf, 0.14, 1, 0.45);
        t = mb.vert(pt, PART.leaf, 0.16, 0.5, 1);
        e = mb.vert(pe, PART.leaf, 0.14, 0, 0.45);
      }
      mb.tri(a, b, t);
      mb.tri(a, t, e);
    }
}

/**
 * (round 128) A solid crown — the user's art target: "trees that look like dota 2 or heroes of the storm from above":
 * chunky, full, opaque masses of a few big rounded lobes. The crown's leaf sites (where the colonized branches end)
 * gathered into clumps (greedy, `clump` cells apart); each clump a lobe — an icosahedron cut once (80 faces), a little
 * flattened underneath, lumped by `lumps` — with a smooth normal a vertex (shaded round, not faceted) and an ambient
 * occlusion a vertex (darker where another lobe crowds it and low in the crown: the crevices); `gaps` of the faces left
 * out (rare, small: sky and limbs through). uv = (−1, the occlusion, the normal) marks a lobe's vertex for the look.
 */
interface Lobes {
  lobes: { m: V3; r: number }[];
  zlo: number;
  zhi: number;
}

/** (round 128) the crown's lobes: its leaf sites gathered greedily into clumps `R` apart, each a middle and a reach */
function crownLobes(sk: Skeleton, minDepth: number, R: number, r01: () => number, sep = 0): Lobes {
  const sites = sk.leaves.filter((l) => l.depth >= minDepth);
  const cs: { c: V3; pts: V3[] }[] = [];
  const order = sites.map((_, i) => i).sort(() => r01() - 0.5);
  for (const i of order) {
    const p = sites[i].p;
    let best = -1;
    let bd = R * R;
    for (let j = 0; j < cs.length; j++) {
      const q = cs[j].c;
      const d2 = (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2;
      if (d2 < bd) {
        bd = d2;
        best = j;
      }
    }
    if (best < 0) cs.push({ c: [p[0], p[1], p[2]], pts: [p] });
    else cs[best].pts.push(p);
  }
  // the lobes: middle and reach
  const lobes = cs.map((cl) => {
    const m: V3 = [0, 0, 0];
    for (const p of cl.pts) for (let i = 0; i < 3; i++) m[i] += p[i] / cl.pts.length;
    let ext = 0;
    for (const p of cl.pts) ext = Math.max(ext, Math.hypot(p[0] - m[0], p[1] - m[1], p[2] - m[2]));
    return { m, r: ext * 0.8 + R * 0.6 };
  });
  // (round 128, main: "lobes a bit more separated in the envelope" — `sep` pushes the lobes out from the crown's middle
  // and shrinks them a little, so they stand apart as lobes)
  if (sep > 0 && lobes.length > 1) {
    const mid: V3 = [0, 0, 0];
    for (const l of lobes) for (let i = 0; i < 3; i++) mid[i] += l.m[i] / lobes.length;
    for (const l of lobes) {
      for (let i = 0; i < 3; i++) l.m[i] = mid[i] + (l.m[i] - mid[i]) * (1 + sep * 0.35);
      l.r *= 1 - sep * 0.15;
    }
  }
  let zlo = Infinity;
  let zhi = -Infinity;
  for (const l of lobes) {
    zlo = Math.min(zlo, l.m[2] - l.r);
    zhi = Math.max(zhi, l.m[2] + l.r);
  }
  return { lobes, zlo, zhi };
}

/** (round 128) a point's occlusion in the crown: other lobes crowding it (`li` its own), its height, a downward face */
function lobeAo(L: Lobes, li: number, p: V3, nrm: V3): number {
  let occ = 0;
  L.lobes.forEach((o, oi) => {
    if (oi === li) return;
    const d = Math.hypot(p[0] - o.m[0], p[1] - o.m[1], p[2] - o.m[2]) - o.r;
    occ += Math.max(0, 1 - d / (0.7 * o.r)) * 0.5;
  });
  const hz = (p[2] - L.zlo) / Math.max(1e-3, L.zhi - L.zlo);
  return Math.max(0.2, Math.min(1, 1 - occ)) * (0.55 + 0.45 * hz) * (nrm[2] < 0 ? 0.75 + 0.25 * (1 + nrm[2]) : 1);
}

function addSolidCrown(mb: MeshBuilder, sk: Skeleton, minDepth: number, c: CrownLook, k: number, r01: () => number, px?: number, bake = false, core = 1, lobesIn?: Lobes): Lobes {
  const R = (c.clump ?? 3) / k;
  const gaps = core < 1 ? 0 : (c.gaps ?? 0.05);
  const lumps = c.lumps ?? 0.3;
  const L = lobesIn ?? crownLobes(sk, minDepth, R, r01);
  const lobes = L.lobes.map((l) => ({ m: l.m, r: l.r * core }));
  // the unit icosahedron, each face cut in four (80 faces)
  const t = (1 + Math.sqrt(5)) / 2;
  const I: V3[] = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]].map((v) => norm(v as V3));
  const IF = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
  const tris: [V3, V3, V3][] = [];
  const coarse: [V3, V3, V3][] = IF.map(([a, b, d]) => [I[a], I[b], I[d]]);
  for (const [a, b, d] of IF) {
    const A = I[a];
    const B = I[b];
    const D = I[d];
    const ab = norm(add(A, B));
    const bd = norm(add(B, D));
    const da = norm(add(D, A));
    tris.push([A, ab, da], [ab, B, bd], [da, bd, D], [ab, bd, da]);
  }
  // (the sprites' bake: cut once more — 320 faces a lobe, round at any size the atlas holds)
  const fine: [V3, V3, V3][] = [];
  if (bake)
    for (const [A, B, D] of tris) {
      const ab = norm(add(A, B));
      const bd = norm(add(B, D));
      const da = norm(add(D, A));
      fine.push([A, ab, da], [ab, B, bd], [da, bd, D], [ab, bd, da]);
    }
  lobes.forEach((lb, li) => {
    const seed = Math.floor(r01() * 1e9);
    const lobeDirs = [0, 1, 2].map((q) => {
      const a = (((seed >>> (q * 7)) & 127) / 127) * Math.PI * 2;
      return norm([Math.cos(a), Math.sin(a), 0.5 - q * 0.4]);
    });
    const shape = (v: V3) => {
      let f = 1;
      for (const dir of lobeDirs) f += lumps * 0.3 * Math.max(0, v[0] * dir[0] + v[1] * dir[1] + v[2] * dir[2]) ** 3;
      return f;
    };
    const cache = new Map<string, number>();
    const vid = (v: V3) => {
      const key = `${v[0].toFixed(4)},${v[1].toFixed(4)},${v[2].toFixed(4)}`;
      let id = cache.get(key);
      if (id === undefined) {
        const zs = v[2] < 0 ? 0.72 : 0.95;
        const f = shape(v) * lb.r;
        const p: V3 = [lb.m[0] + v[0] * f, lb.m[1] + v[1] * f, lb.m[2] + v[2] * f * zs];
        const nrm = norm([v[0], v[1], v[2] / zs]);
        // the occlusion: other lobes crowding this point, and its height in the crown
        const ao = lobeAo(L, li, p, nrm);
        id = mb.vert(p, PART.leaf, 0.12 + 0.05 * Math.max(0, v[2]), -1, ao, nrm);
        cache.set(key, id);
      }
      return id;
    };
    // (made for `px` render pixels a cell: a lobe under ~24 px across keeps the icosahedron's 20 faces)
    const faces = bake ? fine : px && lb.r * k * 2 * px < 24 ? coarse : tris;
    for (const [a, b, d] of faces) {
      if (r01() < gaps) continue;
      mb.tri(vid(a), vid(b), vid(d));
    }
  });
  return L;
}

/**
 * (round 128, the user: "It seems like dota the render multiple layers as leaves on bent lobes and then shadow the deeper
 * layers to add depth") The layered crown: each lobe `layers` shells of leaf cards at decreasing reach (`layerGap` apart),
 * each card a strip bent along its lobe's curve (`bend`), lit by the lobe's normal; the deeper the shell the darker and
 * cooler (`depthDark`: uv.y, the look's occlusion), so the outer leaves catch the light and the gaps show the shadowed
 * leaves under them, not the sky; a dark closed core under the last shell (`core`) where the shells leave holes.
 */
function addLayeredCrown(mb: MeshBuilder, sk: Skeleton, minDepth: number, c: CrownLook, k: number, r01: () => number, px?: number, bake = false): void {
  const L = crownLobes(sk, minDepth, (c.clump ?? 6) / k, r01, c.separate ?? 0.25);
  const K = Math.max(1, Math.round(c.layers ?? 3));
  const gap = c.layerGap ?? 0.18;
  const dark = c.depthDark ?? 0.6;
  const bend = c.bend ?? 0.7;
  const dens = c.shell ?? 0.06;
  const blend = c.lobeBlend ?? 0.85;
  const size = c.size / k;
  if ((c.core ?? 1) > 0) {
    // the core: a closed lobe inside the last shell
    addSolidCrown(mb, sk, minDepth, { ...c, gaps: 0 }, k, r01, px, bake, Math.max(0.3, 1 - K * gap * 0.95), L);
  }
  const rnd = (): V3 => norm([r01() * 2 - 1, r01() * 2 - 1, r01() * 2 - 1]);
  for (const o of L.lobes) {
    for (let li = 0; li < K; li++) {
      const ri = o.r * (1 - li * gap);
      const depth = K > 1 ? li / (K - 1) : 0;
      const area = 4 * Math.PI * (ri * k) ** 2;
      // (made for `px`: no card under ~3 px; the deeper shells a little thinner)
      const n = px && size * k * px < 3 ? 0 : Math.round(area * dens * (bake ? 1.5 : 1) * (1 - 0.3 * depth));
      for (let i = 0; i < n; i++) {
        let d = rnd();
        if (d[2] < 0 && r01() < 0.55) d = [d[0], d[1], -d[2]];
        const t0 = norm(cross(d, Math.abs(d[2]) < 0.9 ? ([0, 0, 1] as V3) : ([1, 0, 0] as V3)));
        const t1 = cross(d, t0);
        const a = r01() * Math.PI * 2;
        const ax = norm(add(mul(t0, Math.cos(a)), mul(t1, Math.sin(a))));
        const sd = norm(cross(d, ax));
        const Lc = size * (0.6 + 0.5 * r01());
        const W = Lc * (0.45 + 0.2 * r01());
        // three rows along the card: on the lobe's curve by `bend`, straight off its tangent otherwise
        const ang = Lc / Math.max(ri, 1e-3);
        const jit = 0.97 + 0.06 * r01();
        const row = (t: number): V3 => {
          const curve = norm(add(mul(d, Math.cos(t * ang)), mul(ax, Math.sin(t * ang))));
          const flat = norm(add(d, mul(ax, t * ang)));
          const dir = norm(add(mul(curve, bend), mul(flat, 1 - bend)));
          const rr = ri * jit * (dir[2] < 0 ? 0.85 : 1);
          return [o.m[0] + dir[0] * rr, o.m[1] + dir[1] * rr, o.m[2] + dir[2] * rr * (dir[2] < 0 ? 0.8 : 0.95)];
        };
        const hz0 = (o.m[2] + d[2] * ri - L.zlo) / Math.max(1e-3, L.zhi - L.zlo);
        const ao = Math.max(0.15, (1 - dark * depth) * (0.6 + 0.4 * hz0));
        const own = norm(cross(sd, ax));
        const v = (p: V3, w: number, sw: number) => {
          const ln = norm([p[0] - o.m[0], p[1] - o.m[1], (p[2] - o.m[2]) * 1.15]);
          const ow: V3 = own[0] * ln[0] + own[1] * ln[1] + own[2] * ln[2] < 0 ? [-own[0], -own[1], -own[2]] : own;
          const nn = norm([ow[0] + (ln[0] - ow[0]) * blend, ow[1] + (ln[1] - ow[1]) * blend, ow[2] + (ln[2] - ow[2]) * blend]);
          // (round 128, main: "darker crevices where lobes meet ... a slightly brighter rim/top on each lobe") the crevice:
          // how close this point is to another lobe's surface; the rim: the outer shell's top, a little over 1 (the look
          // brightens past 1)
          let crev = 0;
          for (const q of L.lobes) {
            if (q === o) continue;
            const dd = Math.hypot(p[0] - q.m[0], p[1] - q.m[1], p[2] - q.m[2]) - q.r;
            crev += Math.max(0, 1 - dd / (0.35 * q.r));
          }
          const rim = li === 0 ? 1 + 0.25 * Math.max(0, ln[2]) * Math.max(0, 1 - crev) : 1;
          return mb.vert(add(p, mul(sd, w)), PART.leaf, sw, -1, ao * (1 - 0.45 * Math.min(1, crev)) * rim, nn);
        };
        const p0 = row(0);
        const p1 = row(0.5);
        const p2 = row(1);
        const a0 = v(p0, 0, 0.12);
        const b1 = v(p1, W / 2, 0.14);
        const c1 = v(p1, -W / 2, 0.14);
        const t2 = v(p2, 0, 0.16);
        mb.tri(a0, b1, c1);
        mb.tri(c1, b1, t2);
      }
    }
  }
}

/**
 * (round 128, main's review: "the lobe mass as a smaller inner core (no holes, smooth normals, AO, warm/cool ramp) plus a
 * shell of leaf cards at its surface using the lobe normals") The hybrid crown: each lobe's core a closed shell at 0.8 its
 * reach (it stops the see-through holes), and over it leaf cards scattered on the lobe's surface — more on its upper,
 * sunward half — each lit by the lobe's normal (blend `lobeBlend`), its occlusion by height in the crown: the soft round
 * shading of a lobe with a leafy, broken edge.
 */
function addHybridCrown(mb: MeshBuilder, sk: Skeleton, minDepth: number, c: CrownLook, k: number, r01: () => number, px?: number, bake = false): void {
  const L = crownLobes(sk, minDepth, (c.clump ?? 6) / k, r01);
  addSolidCrown(mb, sk, minDepth, c, k, r01, px, bake, 0.8, L);
  const blend = c.lobeBlend ?? 0.85;
  const dens = c.shell ?? 0.35;
  const size = c.size / k;
  const rnd = (): V3 => norm([r01() * 2 - 1, r01() * 2 - 1, r01() * 2 - 1]);
  for (const o of L.lobes) {
    const area = 4 * Math.PI * (o.r * k) ** 2;
    // (made for `px`: no card under ~3 px — the core shows the lobe there)
    const n = px && size * k * px < 3 ? 0 : Math.round(area * dens * (bake ? 1.5 : 1));
    for (let i = 0; i < n; i++) {
      let d = rnd();
      // (more on the upper half: the sunlit, seen side)
      if (d[2] < 0 && r01() < 0.6) d = [d[0], d[1], -d[2]];
      const at: V3 = [o.m[0] + d[0] * o.r * (0.92 + 0.15 * r01()), o.m[1] + d[1] * o.r * (0.92 + 0.15 * r01()), o.m[2] + d[2] * o.r * (d[2] < 0 ? 0.75 : 0.95)];
      // a card lying on the lobe, turned at random about its normal, tipped out a little
      const t0 = norm(cross(d, Math.abs(d[2]) < 0.9 ? ([0, 0, 1] as V3) : ([1, 0, 0] as V3)));
      const t1 = cross(d, t0);
      const a = r01() * Math.PI * 2;
      const ax = norm(add(add(mul(t0, Math.cos(a)), mul(t1, Math.sin(a))), mul(d, 0.35 + 0.3 * r01())));
      const sd = norm(cross(d, ax));
      const Lc = size * (0.55 + 0.45 * r01());
      const W = Lc * (0.5 + 0.2 * r01());
      const nrm = norm(add(mul(d, blend), mul(norm(cross(sd, ax)), 1 - blend)));
      const hz = (at[2] - L.zlo) / Math.max(1e-3, L.zhi - L.zlo);
      const ao = 0.6 + 0.4 * hz;
      const base = at;
      const pb = add(add(base, mul(ax, Lc * 0.45)), mul(sd, W / 2));
      const pt = add(base, mul(ax, Lc));
      const pe = add(add(base, mul(ax, Lc * 0.45)), mul(sd, -W / 2));
      const va = mb.vert(base, PART.leaf, 0.13, -1, ao, nrm);
      const vb = mb.vert(pb, PART.leaf, 0.15, -1, ao, nrm);
      const vt = mb.vert(pt, PART.leaf, 0.17, -1, ao, nrm);
      const ve = mb.vert(pe, PART.leaf, 0.15, -1, ao, nrm);
      mb.tri(va, vb, vt);
      mb.tri(va, vt, ve);
    }
  }
}

/** (round 128) the crown's sprays (CrownLook): `k` world cells a skeleton unit, `minLeaf` (skeleton units) the phone's
 *  least spray — under it the sprays grow and fewer are made, the crown's cover about kept */
function addCrown(mb: MeshBuilder, sk: Skeleton, minDepth: number, c: CrownLook, k: number, minLeaf: number, r01: () => number, px?: number): void {
  let size = c.size / k;
  // (made for `px` render pixels a cell: a spray `size × px` pixels across holds about as many cards of ~4 px as fit —
  // the coarse level's sprays are a few cards, not a full spray's worth of sub-pixel ones)
  let leaves = px ? Math.max(2, Math.min(c.leaves, Math.round(((c.size * px) / 4) ** 2))) : c.leaves;
  let per = c.perTwig;
  let keep = c.fill;
  if (minLeaf > size) {
    const g = minLeaf / size;
    size = minLeaf;
    leaves = Math.max(2, Math.round(leaves / Math.sqrt(g)));
    per = Math.max(1, Math.round(per / g));
    keep = Math.min(1, keep * 1.2);
  }
  const step = c.spacing / k;
  // (round 128, 'lobecards': the cards shaded by the lobes they sit in — the stylised-foliage "normal transfer")
  let shade: ((p: V3, own: V3) => { n: V3; ao: number }) | undefined;
  if (c.style === 'lobecards') {
    const L = crownLobes(sk, minDepth, (c.clump ?? 6) / k, r01);
    const blend = c.lobeBlend ?? 0.85;
    shade = (p, own) => {
      let li = 0;
      let bd = Infinity;
      L.lobes.forEach((o, i) => {
        const d = Math.hypot(p[0] - o.m[0], p[1] - o.m[1], p[2] - o.m[2]) / o.r;
        if (d < bd) {
          bd = d;
          li = i;
        }
      });
      const o = L.lobes[li];
      const ln = norm([p[0] - o.m[0], p[1] - o.m[1], (p[2] - o.m[2]) * 1.2]);
      // (the card's own normal turned to face out the same side as the lobe's: no dark backs)
      const ow: V3 = own[0] * ln[0] + own[1] * ln[1] + own[2] * ln[2] < 0 ? [-own[0], -own[1], -own[2]] : own;
      const n = norm([ow[0] + (ln[0] - ow[0]) * blend, ow[1] + (ln[1] - ow[1]) * blend, ow[2] + (ln[2] - ow[2]) * blend]);
      // (the occlusion by depth into the lobe and height in the crown — main's review: crowding by the other lobes, as
      // the solid shells take it, darkened every card inside a neighbour's reach to near black)
      const hz = (p[2] - L.zlo) / Math.max(1e-3, L.zhi - L.zlo);
      return { n, ao: Math.min(1, 0.35 + 0.65 * Math.min(1, bd)) * (0.6 + 0.4 * hz) };
    };
  }
  const spray = (at: V3, d: V3) => sprayAt(mb, at, d, size, leaves, c.droop, r01, shade);
  // the twigs' ends: `per` sprays each, back along the twig
  for (const l of sk.leaves) {
    if (l.depth < minDepth) continue;
    for (let i = 0; i < per; i++) if (r01() < keep) spray(add(l.p, mul(l.d, -i * step)), l.d);
  }
  // and along the last two branch orders, a spray every `spacing` past their first quarter: the leaves sit on the
  // branching, so the crown's shape is the branches'
  const paths = stemPaths(sk.segments, () => false);
  let deepest = 0;
  for (const p of paths) deepest = Math.max(deepest, p.depth);
  for (const p of paths) {
    if (p.depth < Math.max(minDepth, deepest - 1)) continue;
    let L = 0;
    for (let i = 1; i < p.p.length; i++) L += Math.hypot(p.p[i][0] - p.p[i - 1][0], p.p[i][1] - p.p[i - 1][1], p.p[i][2] - p.p[i - 1][2]);
    let s = L * 0.25;
    let acc = 0;
    for (let i = 1; i < p.p.length && step > 0; i++) {
      const a = p.p[i - 1];
      const b = p.p[i];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
      const d = norm([b[0] - a[0], b[1] - a[1], b[2] - a[2]]);
      while (s <= acc + len) {
        const f = (s - acc) / Math.max(len, 1e-6);
        if (r01() < keep) spray([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f], d);
        s += step;
      }
      acc += len;
    }
  }
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
