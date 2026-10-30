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

export type LeafStyle = 'cluster' | 'drop' | 'needles' | 'leaflet' | 'none';

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
export function buildPlant(sk: Skeleton, leaf: LeafLook, seed: number, opts: { sides?: number; roots?: Segment[]; minTwig?: number } = {}): FloraMesh {
  const H = Math.max(sk.height, 0.5);
  const r01 = rng(seed ^ 0x1eaf);
  // sway: nothing at the foot, rising up the plant (squared: a trunk bends near its top), and a little more out on
  // the twigs and leaves (`extra`)
  const mb = new MeshBuilder((p, extra) => Math.pow(Math.max(0, p[2]) / H, 1.6) * 0.8 + extra);
  const sides = opts.sides ?? 6;
  for (const g of sk.segments) {
    // (twigs thinner than a few hundredths of a cell are left out: under a pixel at play zoom, and most of a tree's
    // triangles — the leaves they carry still show where they are)
    if (g.r0 < (opts.minTwig ?? 0.035)) continue;
    const n = g.r0 > 0.25 ? sides : g.r0 > 0.08 ? Math.max(3, sides - 2) : 3;
    mb.tube(g, n, PART.wood, Math.min(0.15, g.depth * 0.05));
  }
  for (const g of opts.roots ?? []) mb.tube(g, g.r0 > 0.12 ? 4 : 3, PART.root);
  for (const l of sk.leaves) {
    if (l.depth < leaf.minDepth) continue;
    addLeaves(mb, l, leaf, r01);
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
