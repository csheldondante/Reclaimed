// The road generator (round 128p, DA-A13 step 0; DESIGN section 12, round 128p): roads first, as evenly spaced
// streamlines of a direction (tensor) field over the town's land — the user: "the city generation software that uses
// flow fields to find roads actually had the best looking roads … fast and pretty in our layouts and players get
// control to shape and make it pretty" (citygen.net, round 128k). DEVLOG round 128p has the design.
//
// This file: what a run is given and gives back, and the field's pure rules, shared by the CPU reference (cpu.ts, the
// unit tests') and the GPU's (gpu.ts, shaders/roadgen.wgsl — keep the rules in step).
//  - The domain: the town's frame (box-local world units, metres), [0, W] x [0, H], inside the town's edge (a circle).
//  - The field lattice: nodes every S metres; per node the ground's height and whether it's wet (inputs), and the
//    field (a, b) = Σ m (cos 2φ, sin 2φ) over the bases (outputs):
//      contours  φ along the contour, m = slope / ROAD_GRADE (contours rule exactly where the land is steeper than a
//                road may climb: DECISIONS round 128o, 1 in 3);
//      the grid  φ = θ, m = 1;
//      radial    tangential round the centre, m = exp(−d² / 2σr²);
//      a constraint (a drawn road, an atlas road)  takes over near it: the sum so far blended toward its nearest
//                segment's tangent by w = exp(−d² / 2σc²) (on the road, only the road).
//  - Roads: the major family along the field's major direction, the minor across it; each family's lines keep half
//    their spacing apart (Jobard & Lefer's evenly spaced streamlines), seeded in rounds (cpu.ts says how).
import { ROAD_GRADE } from '../build/grade';

export type V2 = [number, number];

export interface RoadGenParams {
  /** the domain (m) */
  W: number;
  H: number;
  /** the field lattice's spacing (m) */
  S: number;
  /** the town's middle and edge (m) */
  centre: V2;
  radius: number;
  /** the grid basis's angle (radians) */
  theta: number;
  /** the radial basis's and a constraint's reach (m) */
  sigmaR: number;
  sigmaC: number;
  /** the families' spacings (m): major roads, minor roads */
  major: number;
  minor: number;
  /** the tracing step (m) */
  step: number;
  /** the base lattice's irregularity (Townscaper's look): a vertex's jitter, of a cell; and its seed */
  jitter: number;
  seed: number;
}

/** a style's defaults (DEVLOG round 128p): spacings by eye on the start town's land — the user's to shape */
export const ROADGEN_STYLE = { S: 2, sigmaR: 40, sigmaC: 14, major: 26, minor: 15, step: 1, jitter: 0.2 } as const;

/** a drawn or laid road the field follows and the roads keep to (it's a major road itself, fixed) */
export type Polyline = V2[];

export interface RoadGenInput {
  params: RoadGenParams;
  /** per lattice node (nx × ny, row-major): the ground's height (m) and whether water lies on it */
  ground: Float32Array;
  wet: Uint8Array;
  constraints: Polyline[];
}

/** a traced road: its points (STEP apart; the last may be a snap onto another road), its family, steep steps */
export interface Road {
  family: 0 | 1;
  pts: V2[];
  /** per point: the step into it climbs more than ROAD_GRADE (stairs in town, later) */
  steep: boolean[];
  /** where it was seeded (an edit traces it again from there) */
  seed: V2;
  /** a constraint (fixed: never traced again) */
  fixed?: boolean;
}

export function latticeSize(p: RoadGenParams): { nx: number; ny: number } {
  return { nx: Math.floor(p.W / p.S) + 1, ny: Math.floor(p.H / p.S) + 1 };
}

/** the families' spacing */
export function spacing(p: RoadGenParams, family: number): number {
  return family === 0 ? p.major : p.minor;
}

/** the bound on a trace's steps each way: twice round the domain (a longer line is a loop) */
export function maxSteps(p: RoadGenParams): number {
  return Math.ceil((2 * (p.W + p.H)) / p.step);
}

/** the bound on rounds a family takes: the frontier moves a spacing a round across the domain's diagonal */
export function maxRounds(p: RoadGenParams, family: number): number {
  return Math.ceil(Math.hypot(p.W, p.H) / spacing(p, family)) + 2;
}

/** inside the domain and the town's edge */
export function inside(p: RoadGenParams, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x <= p.W && y <= p.H && Math.hypot(x - p.centre[0], y - p.centre[1]) <= p.radius;
}

/** the distance from (x, y) to segment ab and the segment's unit tangent */
function segNear(x: number, y: number, a: V2, b: V2): { d: number; tx: number; ty: number } {
  const ex = b[0] - a[0];
  const ey = b[1] - a[1];
  const L2 = ex * ex + ey * ey;
  const t = L2 > 0 ? Math.max(0, Math.min(1, ((x - a[0]) * ex + (y - a[1]) * ey) / L2)) : 0;
  const L = Math.sqrt(L2) || 1;
  return { d: Math.hypot(x - a[0] - ex * t, y - a[1] - ey * t), tx: ex / L, ty: ey / L };
}

/** The field at every lattice node (a, b interleaved), from the inputs — the GPU's roadField. */
export function fieldOf(inp: RoadGenInput): Float32Array {
  const p = inp.params;
  const { nx, ny } = latticeSize(p);
  const out = new Float32Array(nx * ny * 2);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) fieldAt(inp, i, j, out);
  return out;
}

/** one node's field into `out` (the dirty rectangle of an edit is these, again) */
export function fieldAt(inp: RoadGenInput, i: number, j: number, out: Float32Array): void {
  const p = inp.params;
  const { nx, ny } = latticeSize(p);
  const g = (ii: number, jj: number) => inp.ground[Math.min(ny - 1, Math.max(0, jj)) * nx + Math.min(nx - 1, Math.max(0, ii))];
  const x = i * p.S;
  const y = j * p.S;
  // contours: the gradient over two nodes each way (4 m: a road's scale, not a pebble's)
  const gx = (g(i + 1, j) - g(i - 1, j)) / (2 * p.S);
  const gy = (g(i, j + 1) - g(i, j - 1)) / (2 * p.S);
  const slope = Math.hypot(gx, gy);
  let a = 0;
  let b = 0;
  if (slope > 0) {
    // φ = ψ + π/2: cos 2φ = −cos 2ψ, sin 2φ = −sin 2ψ (ψ the gradient's angle)
    const c = (gx * gx - gy * gy) / (slope * slope);
    const s = (2 * gx * gy) / (slope * slope);
    const m = slope / ROAD_GRADE;
    a -= m * c;
    b -= m * s;
  }
  a += Math.cos(2 * p.theta);
  b += Math.sin(2 * p.theta);
  const rx = x - p.centre[0];
  const ry = y - p.centre[1];
  const r2 = rx * rx + ry * ry;
  if (r2 > 0) {
    // tangential: φ = angle + π/2, as the contours
    const m = Math.exp(-r2 / (2 * p.sigmaR * p.sigmaR));
    a -= (m * (rx * rx - ry * ry)) / r2;
    b -= (m * 2 * rx * ry) / r2;
  }
  // a constraint takes over near it: the field so far blended toward its tangent by w = exp(−d² / 2σc²) (on it, only it)
  for (const line of inp.constraints) {
    let best = { d: Infinity, tx: 1, ty: 0 };
    for (let k = 1; k < line.length; k++) {
      const n = segNear(x, y, line[k - 1], line[k]);
      if (n.d < best.d) best = n;
    }
    if (best.d === Infinity) continue;
    const w = Math.exp(-(best.d * best.d) / (2 * p.sigmaC * p.sigmaC));
    a = (1 - w) * a + w * (best.tx * best.tx - best.ty * best.ty);
    b = (1 - w) * b + w * 2 * best.tx * best.ty;
  }
  const o = (j * nx + i) * 2;
  out[o] = a;
  out[o + 1] = b;
}

/** below this the field has no direction (numerically: the bases cancel) */
export const DEGENERATE = 1e-6;

/** the field at a point (bilinear), its family's unit direction (null: degenerate) */
export function dirAt(p: RoadGenParams, field: Float32Array, family: number, x: number, y: number): V2 | null {
  const { nx, ny } = latticeSize(p);
  const fx = Math.min(nx - 1.000001, Math.max(0, x / p.S));
  const fy = Math.min(ny - 1.000001, Math.max(0, y / p.S));
  const i = Math.floor(fx);
  const j = Math.floor(fy);
  const u = fx - i;
  const v = fy - j;
  const at = (ii: number, jj: number, k: number) => field[(jj * nx + ii) * 2 + k];
  const lerp = (k: number) => (at(i, j, k) * (1 - u) + at(i + 1, j, k) * u) * (1 - v) + (at(i, j + 1, k) * (1 - u) + at(i + 1, j + 1, k) * u) * v;
  const a = lerp(0);
  const b = lerp(1);
  if (a * a + b * b < DEGENERATE) return null;
  const ang = 0.5 * Math.atan2(b, a) + (family === 1 ? Math.PI / 2 : 0);
  return [Math.cos(ang), Math.sin(ang)];
}

/** the ground at a point (bilinear) */
export function groundAt(p: RoadGenParams, ground: Float32Array, x: number, y: number): number {
  const { nx, ny } = latticeSize(p);
  const fx = Math.min(nx - 1.000001, Math.max(0, x / p.S));
  const fy = Math.min(ny - 1.000001, Math.max(0, y / p.S));
  const i = Math.floor(fx);
  const j = Math.floor(fy);
  const u = fx - i;
  const v = fy - j;
  const at = (ii: number, jj: number) => ground[jj * nx + ii];
  return (at(i, j) * (1 - u) + at(i + 1, j) * u) * (1 - v) + (at(i, j + 1) * (1 - u) + at(i + 1, j + 1) * u) * v;
}

/** whether the node nearest a point is wet */
export function wetAt(p: RoadGenParams, wet: Uint8Array, x: number, y: number): boolean {
  const { nx, ny } = latticeSize(p);
  const i = Math.min(nx - 1, Math.max(0, Math.round(x / p.S)));
  const j = Math.min(ny - 1, Math.max(0, Math.round(y / p.S)));
  return wet[j * nx + i] !== 0;
}

export { ROAD_GRADE };
