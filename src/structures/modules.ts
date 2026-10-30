// The module library: every drawn piece of a building, made in code in a unit frame (u, v, w) and warped into its tile
// at draw time (contracts/structures.ts StructurePieces). Why modules in a unit frame: the tiles are irregular quads
// (Townscaper's look comes from bending one module set to every quad), the GPU keeps one copy of each module however
// many thousand times it's used, and a style is just a different set (the user, round 117: "various procedural building
// assets for various tile systems").
//
// Frames: walls run along a tile's side — u along it, v into the building (0 the outer face, 1 the wall's inner face,
// about 0.35 m; v < 0 sticks out), w up the storey. Roofs and slabs cover a tile — u, v across it, w up. Corner posts sit
// in the corner of two walls — u along the one side, v along the other. A vertex is (u, v, w, part): the part is the
// palette slot (Part below) the shader colours it by.

export const enum Part {
  Wall = 0,
  Trim = 1,
  Roof = 2,
  Glass = 3,
  Stone = 4,
  Door = 5,
  Shutter = 6,
  Pave = 7,
  Awning = 8,
  Metal = 9,
  RoofUnder = 10,
  Water = 11,
  Plant = 12,
  Lamp = 13,
}
export const PARTS = 14;

export interface Module {
  name: string;
  /** u, v, w, part — 4 floats a vertex */
  verts: number[];
  index: number[];
}

/** A mesh under construction in a unit frame. */
export class Kit {
  verts: number[] = [];
  index: number[] = [];
  private v(u: number, v: number, w: number, part: number): number {
    this.verts.push(u, v, w, part);
    return this.verts.length / 4 - 1;
  }
  tri(a: number[], b: number[], c: number[], part: number): void {
    const i = this.v(a[0], a[1], a[2], part);
    const j = this.v(b[0], b[1], b[2], part);
    const k = this.v(c[0], c[1], c[2], part);
    this.index.push(i, j, k);
  }
  quad(a: number[], b: number[], c: number[], d: number[], part: number): void {
    this.tri(a, b, c, part);
    this.tri(a, c, d, part);
  }
  /** an axis-aligned box in the frame; `skip` leaves faces out (−u +u −v +v −w +w as bits 1 2 4 8 16 32) */
  box(u0: number, u1: number, v0: number, v1: number, w0: number, w1: number, part: number, skip = 0): void {
    const P = (a: number, b: number, c: number) => [a ? u1 : u0, b ? v1 : v0, c ? w1 : w0];
    if (!(skip & 1)) this.quad(P(0, 0, 0), P(0, 0, 1), P(0, 1, 1), P(0, 1, 0), part);
    if (!(skip & 2)) this.quad(P(1, 0, 0), P(1, 1, 0), P(1, 1, 1), P(1, 0, 1), part);
    if (!(skip & 4)) this.quad(P(0, 0, 0), P(1, 0, 0), P(1, 0, 1), P(0, 0, 1), part);
    if (!(skip & 8)) this.quad(P(0, 1, 0), P(0, 1, 1), P(1, 1, 1), P(1, 1, 0), part);
    if (!(skip & 16)) this.quad(P(0, 0, 0), P(0, 1, 0), P(1, 1, 0), P(1, 0, 0), part);
    if (!(skip & 32)) this.quad(P(0, 0, 1), P(1, 0, 1), P(1, 1, 1), P(0, 1, 1), part);
  }
  /** a vertical cylinder (n sides) about (cu, cv), radii ru, rv, from w0 to w1, capped on top */
  cyl(cu: number, cv: number, ru: number, rv: number, w0: number, w1: number, n: number, part: number, cap = true, topScale = 1): void {
    for (let i = 0; i < n; i++) {
      const a0 = (i / n) * Math.PI * 2;
      const a1 = ((i + 1) / n) * Math.PI * 2;
      const p = (a: number, w: number, s: number) => [cu + Math.cos(a) * ru * s, cv + Math.sin(a) * rv * s, w];
      this.quad(p(a0, w0, 1), p(a1, w0, 1), p(a1, w1, topScale), p(a0, w1, topScale), part);
      if (cap) this.tri([cu, cv, w1], p(a0, w1, topScale), p(a1, w1, topScale), part);
    }
  }
  /** a cone from a ring at w0 to an apex at w1 */
  cone(cu: number, cv: number, ru: number, rv: number, w0: number, w1: number, n: number, part: number): void {
    for (let i = 0; i < n; i++) {
      const a0 = (i / n) * Math.PI * 2;
      const a1 = ((i + 1) / n) * Math.PI * 2;
      this.tri([cu + Math.cos(a0) * ru, cv + Math.sin(a0) * rv, w0], [cu + Math.cos(a1) * ru, cv + Math.sin(a1) * rv, w0], [cu, cv, w1], part);
    }
  }
  done(name: string): Module {
    return { name, verts: this.verts, index: this.index };
  }
}

// ------------------------------------------------------------------ walls

/** A wall's opening: u0 u1 w0 w1 (in the wall's frame) and what fills it. */
interface Opening {
  u0: number;
  u1: number;
  w0: number;
  w1: number;
  fill: Part;
  /** shutters either side */
  shutters?: boolean;
  /** a sill under it */
  sill?: boolean;
  /** an arch's rise over the top (w) */
  arch?: number;
}

export interface WallLook {
  /** the wall's own material slot (plaster, stone) */
  body: Part;
  /** timber framing: beams at the floor and the top, braces */
  timber: boolean;
  /** a stone base course (the ground floor) */
  base?: boolean;
}

/** A wall slab with openings cut (rectangles; the slab is boxes round them), frames, sills, shutters, framing. */
function wall(name: string, look: WallLook, openings: Opening[], extra?: (k: Kit) => void): Module {
  const k = new Kit();
  const D = 1; // wall depth in v
  // the slab: split u at the openings' edges, then each column split in w round the opening in it
  const cuts = new Set<number>([0, 1]);
  for (const o of openings) {
    cuts.add(o.u0);
    cuts.add(o.u1);
  }
  const us = [...cuts].sort((a, b) => a - b);
  for (let i = 0; i + 1 < us.length; i++) {
    const a = us[i];
    const b = us[i + 1];
    const o = openings.find((p) => p.u0 <= a + 1e-6 && p.u1 >= b - 1e-6);
    if (!o) k.box(a, b, 0, D, 0, 1, look.body, 16 | 32);
    else {
      if (o.w0 > 0) k.box(a, b, 0, D, 0, o.w0, look.body, 16);
      k.box(a, b, 0, D, o.w1 + (o.arch ?? 0), 1, look.body, 32);
      if (o.arch) {
        // the arch's spandrels: the slab between a round top and the lintel
        const n = 4;
        for (let s = 0; s < n; s++) {
          const t0 = s / n;
          const t1 = (s + 1) / n;
          const curve = (t: number) => o.w1 + o.arch! * Math.sqrt(Math.max(0, 1 - (2 * t - 1) ** 2));
          const ua = o.u0 + (o.u1 - o.u0) * t0;
          const ub = o.u0 + (o.u1 - o.u0) * t1;
          if (ub <= a + 1e-6 || ua >= b - 1e-6) continue;
          k.quad([ua, 0, curve(t0)], [ub, 0, curve(t1)], [ub, 0, o.w1 + o.arch], [ua, 0, o.w1 + o.arch], look.body);
          k.quad([ua, 0, curve(t0)], [ua, D, curve(t0)], [ub, D, curve(t1)], [ub, 0, curve(t1)], look.body);
        }
      }
    }
  }
  for (const o of openings) {
    // the reveal's sides
    k.quad([o.u0, 0, o.w0], [o.u0, D, o.w0], [o.u0, D, o.w1], [o.u0, 0, o.w1], look.body);
    k.quad([o.u1, 0, o.w0], [o.u1, 0, o.w1], [o.u1, D, o.w1], [o.u1, D, o.w0], look.body);
    // what fills it, set back
    k.box(o.u0, o.u1, 0.55, 0.7, o.w0, o.w1 + (o.arch ?? 0) * 0.9, o.fill);
    if (o.fill === Part.Glass) {
      // glazing bars
      const um = (o.u0 + o.u1) / 2;
      k.box(um - 0.012, um + 0.012, 0.5, 0.56, o.w0, o.w1, Part.Trim);
      const wm = o.w0 + (o.w1 - o.w0) * 0.55;
      k.box(o.u0, o.u1, 0.5, 0.56, wm - 0.012, wm + 0.012, Part.Trim);
    }
    // the frame, a little proud
    const f = 0.025;
    k.box(o.u0 - f, o.u0, -0.18, 0.3, o.w0, o.w1 + f, Part.Trim);
    k.box(o.u1, o.u1 + f, -0.18, 0.3, o.w0, o.w1 + f, Part.Trim);
    if (!o.arch) k.box(o.u0 - f, o.u1 + f, -0.22, 0.3, o.w1, o.w1 + 0.04, Part.Trim);
    if (o.sill) k.box(o.u0 - f * 2, o.u1 + f * 2, -0.45, 0.2, o.w0 - 0.035, o.w0, Part.Stone);
    if (o.shutters) {
      const sw = (o.u1 - o.u0) * 0.5;
      k.box(o.u0 - f - sw, o.u0 - f - 0.005, -0.32, -0.18, o.w0 + 0.01, o.w1 - 0.01, Part.Shutter);
      k.box(o.u1 + f + 0.005, o.u1 + f + sw, -0.32, -0.18, o.w0 + 0.01, o.w1 - 0.01, Part.Shutter);
    }
  }
  if (look.timber) {
    // the floor beam and the head beam, proud of the plaster
    k.box(0, 1, -0.22, 0.2, 0, 0.055, Part.Trim, 16);
    k.box(0, 1, -0.22, 0.2, 0.95, 1, Part.Trim, 32);
    // braces from the posts toward the first opening (half-timbering)
    const first = openings.length ? Math.min(...openings.map((o) => o.u0)) : 0.5;
    const last = openings.length ? Math.max(...openings.map((o) => o.u1)) : 0.5;
    if (first > 0.16) brace(k, 0.02, Math.min(first - 0.05, 0.22), 0.06, 0.94);
    if (last < 0.84) brace(k, 0.98, Math.max(last + 0.05, 0.78), 0.06, 0.94);
  }
  if (look.base) k.box(0, 1, -0.12, 0.3, 0, 0.16, Part.Stone, 16);
  extra?.(k);
  return k.done(name);
}

/** a diagonal timber from (ua, wa) to (ub, wb), proud of the wall */
function brace(k: Kit, ua: number, ub: number, wa: number, wb: number): void {
  const t = 0.028;
  const v0 = -0.16;
  const v1 = 0.02;
  // a thin slanted box: its four long edges
  const a = [ua, wa];
  const b = [ub, wb];
  const dx = b[0] - a[0];
  const dw = b[1] - a[1];
  const L = Math.hypot(dx * 4, dw * 3); // (the frame's aspect: a wall about 4 m by 3 m)
  const nu = (-dw * 3) / L / 4 * t * 4;
  const nw = ((dx * 4) / L / 3) * t * 3;
  const P = (p: number[], s: number, v: number) => [p[0] + nu * s, v, p[1] + nw * s];
  k.quad(P(a, -1, v0), P(b, -1, v0), P(b, 1, v0), P(a, 1, v0), Part.Trim);
  k.quad(P(a, -1, v0), P(a, -1, v1), P(b, -1, v1), P(b, -1, v0), Part.Trim);
  k.quad(P(a, 1, v0), P(b, 1, v0), P(b, 1, v1), P(a, 1, v1), Part.Trim);
}

// ------------------------------------------------------------------ roofs

/**
 * A roof over a tile as a height field: h(u, v) = the least distance to the roof's edge — its free sides (the tile's
 * sides with no roof of this building beside them) and its free corners (a corner whose diagonal neighbour has none:
 * the inside of an L) — so neighbouring tiles' roofs meet in ridges, hips and valleys without being told about each
 * other (Townscaper's look from a rule, not a table). All its creases lie on the lines u, v ∈ {0, ½, 1} and the
 * diagonals through the centre, so 8 triangles are exact. w = h (the frame's top is the height a unit of h rises).
 * Free sides overhang by `eave` (h goes negative under the eaves).
 * sides: bit s = side s free (side 0 v=0, 1 u=1, 2 v=1, 3 u=0); corners: bit c = corner c free (0 (0,0), 1 (1,0),
 * 2 (1,1), 3 (0,1)).
 */
export function roofHeight(u: number, v: number, sides: number, corners: number): number {
  let h = 1;
  if (sides & 1) h = Math.min(h, v);
  if (sides & 2) h = Math.min(h, 1 - u);
  if (sides & 4) h = Math.min(h, 1 - v);
  if (sides & 8) h = Math.min(h, u);
  if (corners & 1) h = Math.min(h, Math.max(u, v));
  if (corners & 2) h = Math.min(h, Math.max(1 - u, v));
  if (corners & 4) h = Math.min(h, Math.max(1 - u, 1 - v));
  if (corners & 8) h = Math.min(h, Math.max(u, 1 - v));
  return h;
}

function roof(sides: number, corners: number, verge: number, eaves: number, clip: number, look: RoofLook): Module {
  const k = new Kit();
  const e = look.eave;
  // the 3 × 3 points, pushed out under the free sides' eaves
  const grid = [0, 0.5, 1];
  const P = (i: number, j: number) => {
    let u = grid[i];
    let v = grid[j];
    let w = roofHeight(u, v, sides, corners);
    // (a point on a free side is pushed out by the overhang and drops with the slope: h is 0 on that side)
    // (a free side with a neighbour as tall beside it has no overhang: the eave would cut into its wall; the two roofs
    // meet in a gutter on the line between)
    // (a clipped corner — a tile as tall touches it diagonally — isn't pushed out: its eave would reach into that tile)
    const corner = i !== 1 && j !== 1 ? (i === 0 ? (j === 0 ? 0 : 3) : j === 0 ? 1 : 2) : -1;
    const held = corner >= 0 && (clip >> corner) & 1;
    if (!held) {
      if (j === 0 && eaves & 1) (v = -e), (w = -e);
      if (i === 2 && eaves & 2) (u = 1 + e), (w = -e);
      if (j === 2 && eaves & 4) (v = 1 + e), (w = -e);
      if (i === 0 && eaves & 8) (u = -e), (w = -e);
    }
    // (a gable's verge: the roof runs a little past the gable wall, level with its slope)
    const g = e * 0.7;
    if (j === 0 && verge & 1) v = -g;
    if (i === 2 && verge & 2) u = 1 + g;
    if (j === 2 && verge & 4) v = 1 + g;
    if (i === 0 && verge & 8) u = -g;
    return [u, v, w];
  };
  const pts: number[][][] = [];
  for (let i = 0; i < 3; i++) {
    pts.push([]);
    for (let j = 0; j < 3; j++) pts[i].push(P(i, j));
  }
  const T = look.thick;
  // four sub-squares, each cut on its diagonal through the centre
  const subs: [number, number][] = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ];
  for (const [i, j] of subs) {
    const a = pts[i][j];
    const b = pts[i + 1][j];
    const c = pts[i + 1][j + 1];
    const d = pts[i][j + 1];
    // (the diagonal that passes through the centre (1, 1))
    const viaAC = (i === 0 && j === 0) || (i === 1 && j === 1);
    const top = (p: number[]) => [p[0], p[1], p[2]];
    const bot = (p: number[]) => [p[0], p[1], p[2] - T];
    if (viaAC) {
      k.tri(top(a), top(b), top(c), Part.Roof);
      k.tri(top(a), top(c), top(d), Part.Roof);
      k.tri(bot(a), bot(c), bot(b), Part.RoofUnder);
      k.tri(bot(a), bot(d), bot(c), Part.RoofUnder);
    } else {
      k.tri(top(a), top(b), top(d), Part.Roof);
      k.tri(top(b), top(c), top(d), Part.Roof);
      k.tri(bot(a), bot(d), bot(b), Part.RoofUnder);
      k.tri(bot(b), bot(d), bot(c), Part.RoofUnder);
    }
  }
  // fascia boards on the free sides' and the verges' edges (the roof's thickness, seen from below the eaves)
  const edge = (p: number[], q: number[]) => k.quad([p[0], p[1], p[2] - T], [q[0], q[1], q[2] - T], [q[0], q[1], q[2]], [p[0], p[1], p[2]], Part.Trim);
  if ((sides | verge) & 1) {
    edge(pts[0][0], pts[1][0]);
    edge(pts[1][0], pts[2][0]);
  }
  if ((sides | verge) & 2) {
    edge(pts[2][0], pts[2][1]);
    edge(pts[2][1], pts[2][2]);
  }
  if ((sides | verge) & 4) {
    edge(pts[2][2], pts[1][2]);
    edge(pts[1][2], pts[0][2]);
  }
  if ((sides | verge) & 8) {
    edge(pts[0][2], pts[0][1]);
    edge(pts[0][1], pts[0][0]);
  }
  // ridge caps along the creases that rise to the top (a darker tile row)
  return k.done(`roof:${sides}:${corners}:${verge}:${eaves}:${clip}:${look.name}`);
}

export interface RoofLook {
  name: string;
  /** overhang (uv) */
  eave: number;
  /** thickness (w) */
  thick: number;
}

/** The gable end: the wall's triangle under a ridge that ends on this side (apex at u ½, w ½ of the roof's rise). */
function gable(look: WallLook, window: boolean): Module {
  const k = new Kit();
  const D = 1;
  // (just under the roof's top: hidden in its thickness, never level with it)
  const apex = 0.475;
  const tri = (v: number) => {
    k.tri([0, v, 0], [1, v, 0], [0.5, v, apex], look.body);
  };
  tri(0);
  k.tri([0, D, 0], [0.5, D, apex], [1, D, 0], look.body);
  k.quad([0, 0, 0], [0.5, 0, apex], [0.5, D, apex], [0, D, 0], look.body);
  k.quad([1, 0, 0], [1, D, 0], [0.5, D, apex], [0.5, 0, apex], look.body);
  if (look.timber) {
    // the king post and the collar beam
    k.box(0.485, 0.515, -0.18, 0.1, 0, apex - 0.03, Part.Trim);
    k.box(0.22, 0.78, -0.18, 0.1, 0.2, 0.235, Part.Trim);
  }
  if (window) {
    k.box(0.43, 0.57, -0.1, 0.4, 0.06, 0.2, Part.Glass);
    k.box(0.41, 0.59, -0.18, 0.3, 0.045, 0.06, Part.Trim);
  }
  return k.done(`gable:${look.timber ? 't' : 's'}:${window ? 'w' : ''}`);
}

// ------------------------------------------------------------------ the rest

function post(part: Part): Module {
  const k = new Kit();
  k.box(-0.16, 0.62, -0.16, 0.62, 0, 1, part);
  return k.done(`post:${part}`);
}

function quoins(): Module {
  // stone corner blocks, alternating long and short
  const k = new Kit();
  const n = 5;
  for (let i = 0; i < n; i++) {
    const w0 = i / n + 0.01;
    const w1 = (i + 1) / n - 0.01;
    const long = i % 2 === 0;
    k.box(-0.14, long ? 1.4 : 0.8, -0.14, long ? 0.8 : 1.4, w0, w1, Part.Stone);
  }
  return k.done('quoins');
}

function slab(part: Part, name: string): Module {
  const k = new Kit();
  k.box(0, 1, 0, 1, 0, 1, part);
  return k.done(name);
}

function chimney(): Module {
  const k = new Kit();
  k.box(0.3, 0.7, 0.3, 0.7, 0, 0.9, Part.Stone);
  k.box(0.25, 0.75, 0.25, 0.75, 0.9, 1, Part.Stone);
  k.box(0.4, 0.6, 0.4, 0.6, 1, 1.06, Part.Metal);
  return k.done('chimney');
}

function merlons(): Module {
  const k = new Kit();
  const n = 4;
  for (let i = 0; i < n; i++) {
    const u0 = (i + 0.18) / n;
    const u1 = (i + 0.82) / n;
    k.box(u0, u1, 0, 1, 0, 1, Part.Stone);
  }
  k.box(0, 1, -0.3, 0, -0.18, 0, Part.Stone);
  return k.done('merlons');
}

function tower(): Module {
  // a round tower in its tile: a drum, a string course, narrow windows, a corbelled parapet
  const k = new Kit();
  k.cyl(0.5, 0.5, 0.5, 0.5, 0, 1, 14, Part.Stone, false);
  k.cyl(0.5, 0.5, 0.56, 0.56, 0.93, 1, 14, Part.Stone, true);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + 0.4;
    const cu = 0.5 + Math.cos(a) * 0.49;
    const cv = 0.5 + Math.sin(a) * 0.49;
    for (const w of [0.3, 0.62]) k.box(cu - 0.035, cu + 0.035, cv - 0.035, cv + 0.035, w, w + 0.14, Part.Glass);
  }
  return k.done('tower');
}

function spire(): Module {
  const k = new Kit();
  k.cone(0.5, 0.5, 0.62, 0.62, 0, 1, 14, Part.Roof);
  k.cyl(0.5, 0.5, 0.62, 0.62, -0.04, 0, 14, Part.Trim, false);
  k.box(0.49, 0.51, 0.49, 0.51, 1, 1.08, Part.Metal);
  return k.done('spire');
}

function fountain(): Module {
  const k = new Kit();
  k.cyl(0.5, 0.5, 0.5, 0.5, 0, 0.35, 16, Part.Stone, false);
  k.cyl(0.5, 0.5, 0.44, 0.44, 0, 0.3, 16, Part.Water, true);
  k.cyl(0.5, 0.5, 0.08, 0.08, 0.3, 1, 8, Part.Stone, true);
  k.cyl(0.5, 0.5, 0.22, 0.22, 0.7, 0.76, 12, Part.Stone, true);
  return k.done('fountain');
}

function lamp(): Module {
  const k = new Kit();
  k.box(0.47, 0.53, 0.47, 0.53, 0, 0.85, Part.Metal);
  k.box(0.42, 0.58, 0.42, 0.58, 0.85, 0.97, Part.Lamp);
  k.box(0.4, 0.6, 0.4, 0.6, 0.97, 1, Part.Metal);
  return k.done('lamp');
}

function arch(): Module {
  // a gate's arch through a wall tile (u across the passage)
  return wall('gatearch', { body: Part.Stone, timber: false }, [{ u0: 0.22, u1: 0.78, w0: 0, w1: 0.5, fill: Part.Door, arch: 0.22 }]);
}

// ------------------------------------------------------------------ the library

export interface Library {
  modules: Module[];
  id(name: string): number;
  has(name: string): boolean;
}

/** wall modules a style offers, by role */
export const WALLS = ['blank', 'window', 'window2', 'door', 'shop', 'balcony', 'slit'] as const;
export type WallKind = (typeof WALLS)[number];

const PLASTER: WallLook = { body: Part.Wall, timber: true };
const PLASTER0: WallLook = { body: Part.Wall, timber: true, base: true };
const STONE: WallLook = { body: Part.Stone, timber: false };

function wallSet(prefix: string, look: WallLook): Module[] {
  const win = (u0: number, u1: number): Opening => ({ u0, u1, w0: 0.3, w1: 0.74, fill: Part.Glass, sill: true, shutters: look.timber });
  return [
    wall(`${prefix}:blank`, look, []),
    wall(`${prefix}:window`, look, [win(0.38, 0.62)]),
    wall(`${prefix}:window2`, look, [win(0.2, 0.38), win(0.62, 0.8)]),
    wall(`${prefix}:door`, look, [{ u0: 0.39, u1: 0.61, w0: 0, w1: 0.7, fill: Part.Door, arch: look.timber ? 0 : 0.08 }], (k) => {
      // a step and a small hood over the door
      k.box(0.34, 0.66, -0.35, 0.2, -0.06, 0.03, Part.Stone);
      if (look.timber) k.box(0.33, 0.67, -0.5, 0.1, 0.76, 0.8, Part.Roof);
    }),
    wall(`${prefix}:shop`, look, [{ u0: 0.14, u1: 0.86, w0: 0.08, w1: 0.66, fill: Part.Glass }], (k) => {
      // an awning: a slope out from over the window
      k.quad([0.12, 0, 0.74], [0.88, 0, 0.74], [0.88, -2.6, 0.6], [0.12, -2.6, 0.6], Part.Awning);
      k.quad([0.12, 0, 0.74], [0.12, -2.6, 0.6], [0.88, -2.6, 0.6], [0.88, 0, 0.74], Part.Awning);
      k.box(0.12, 0.88, -2.65, -2.55, 0.56, 0.6, Part.Awning);
    }),
    wall(`${prefix}:balcony`, look, [{ u0: 0.36, u1: 0.64, w0: 0.04, w1: 0.74, fill: Part.Glass }], (k) => {
      // a timber balcony: its floor out of the wall, a rail, posts
      k.box(0.26, 0.74, -2.4, 0, 0.0, 0.04, Part.Trim);
      k.box(0.26, 0.74, -2.4, -2.28, 0.04, 0.33, Part.Trim, 0);
      k.box(0.26, 0.29, -2.4, 0, 0.3, 0.33, Part.Trim);
      k.box(0.71, 0.74, -2.4, 0, 0.3, 0.33, Part.Trim);
      for (let i = 0; i <= 6; i++) {
        const u = 0.27 + (i / 6) * 0.46;
        k.box(u - 0.006, u + 0.006, -2.38, -2.3, 0.04, 0.3, Part.Trim);
      }
      k.box(0.3, 0.32, -0.9, -0.3, -0.12, 0.0, Part.Trim);
      k.box(0.68, 0.7, -0.9, -0.3, -0.12, 0.0, Part.Trim);
    }),
    wall(`${prefix}:slit`, look, [{ u0: 0.47, u1: 0.53, w0: 0.3, w1: 0.72, fill: Part.Glass }]),
  ];
}

let LIB: (Library & { byName: Map<string, number> }) | null = null;

const ROOF_LOOKS: Record<string, RoofLook> = { tile: { name: 'tile', eave: 0.09, thick: 0.05 }, slate: { name: 'slate', eave: 0.05, thick: 0.04 } };

/**
 * The one library: the fixed modules made at once, roofs made the first time a mask is asked for (there are hundreds
 * of side × corner × verge masks; a city uses a few dozen). `modules` only grows: the renderer re-uploads when it has.
 */
export function library(): Library {
  if (LIB) return LIB;
  const modules: Module[] = [];
  modules.push(...wallSet('plaster', PLASTER), ...wallSet('plaster0', PLASTER0), ...wallSet('stone', STONE));
  modules.push(gable(PLASTER, true), gable(PLASTER, false), gable(STONE, true), gable(STONE, false));
  modules.push(post(Part.Trim), post(Part.Stone), quoins(), slab(Part.Stone, 'plinth'), slab(Part.Pave, 'pave'), slab(Part.Stone, 'rampart'), slab(Part.Plant, 'garden'));
  modules.push(chimney(), merlons(), tower(), spire(), fountain(), lamp(), arch());
  const byName = new Map<string, number>();
  modules.forEach((m, i) => {
    if (byName.has(m.name)) throw new Error(`structures: two modules named "${m.name}"`);
    byName.set(m.name, i);
  });
  const lib = {
    modules,
    byName,
    id(name: string) {
      let i = byName.get(name);
      if (i === undefined) {
        const m = /^roof:(\d+):(\d+):(\d+):(\d+):(\d+):(\w+)$/.exec(name);
        if (!m || !ROOF_LOOKS[m[6]]) throw new Error(`structures: no module "${name}"`);
        i = modules.length;
        modules.push(roof(+m[1], +m[2], +m[3], +m[4], +m[5], ROOF_LOOKS[m[6]]));
        byName.set(name, i);
      }
      return i;
    },
    has: (name: string) => byName.has(name),
  };
  LIB = lib;
  return lib;
}

/** the roof module's name for a mask (corner terms that can't matter dropped: a corner on a free side) */
export function roofName(sides: number, corners: number, verge: number, eaves: number, clip: number, look: string): string {
  let c = 0;
  for (let k = 0; k < 4; k++) if (corners & (1 << k) && !(sides & (1 << k)) && !(sides & (1 << ((k + 3) % 4)))) c |= 1 << k;
  const ev = eaves & sides;
  // (a clip only matters at a corner both of whose sides overhang... or either: keep the corners touching an eave)
  let cl = 0;
  for (let k = 0; k < 4; k++) if (clip & (1 << k) && (ev & (1 << k) || ev & (1 << ((k + 3) % 4)))) cl |= 1 << k;
  return `roof:${sides}:${c}:${verge & ~sides}:${ev}:${cl}:${look}`;
}
