// Nested scales lab, round 22: a record's EDGE SAMPLE (docs/design/NESTED_SCALES.md "As built (round 22)"). The owner:
// "I really want the look of something like dual contouring but without the cost". A surface record near a sharp edge
// (a carve's rim, an add's foot) keeps where that edge runs: a horizontal line given by its unit normal n (as an angle)
// and the signed distance d from the column's centre to it along n (the line is { p : dot(n, p - centre) = d }), in the
// record's own level's column units. n points out of the brush, so d > 0 for a column whose centre lies inside the
// brush's outline and d < 0 outside it. The sheet bake slides a corner's vertex onto the lines its columns keep (a 2D
// dual contouring of the edge line); see boxmesh.ts sheetMesh and nest.wgsl sWalk.
//
// Storage: the spare bits of the record's material word (materials use bits 0-7). Bits 8-29 hold the sample; 0 there is
// "no edge", the default everywhere, so no generator, page or record layout changes:
//   bit 8 on, bits 9-17 the angle of n (512 steps a turn), bits 18-29 d (4096 steps over [-2, 2): 1/1024 a step).
// Bit 30 is RES_EDGE in a residual record (nest.wgsl putResW; the oracle's Res.edge), bit 31 the residual's WHOLE flag.
// The CPU keeps the field in a parallel array (Part.edge, Col.edge) as the word's bits 8-29, so `mat` stays the material.
// Mirrored in WGSL: store.wgsl edgeEnc / edgeDec, the same expressions.

export const EDGE_ON = 1 << 8;
/** bits 8-29 of a record's material word */
export const EDGE_MASK = 0x3fffff00;
/** (residual records) the live column's edge field overrides the enhanced one */
export const RES_EDGE = 0x40000000;
/** the representable distance, columns */
export const EDGE_RANGE = 2;
const A_STEPS = 512;
const Q_STEPS = 4096;
const Q_UNIT = 1024;

export interface EdgeSample {
  /** the unit normal (out of the brush) */
  nx: number;
  ny: number;
  /** signed distance from the column's centre to the line along n, columns (> 0: the centre is inside) */
  d: number;
}

/** the field for normal angle `ang` (radians) and distance d; 0 (none) where |d| is past the range */
export function edgeEncA(ang: number, d: number): number {
  if (!(Math.abs(d) <= EDGE_RANGE)) return 0;
  const a = (Math.floor((ang / (2 * Math.PI)) * A_STEPS + 0.5) % A_STEPS + A_STEPS) % A_STEPS;
  const q = Math.min(Q_STEPS - 1, Math.max(0, Math.floor(d * Q_UNIT + 0.5) + Q_STEPS / 2));
  return EDGE_ON | (a << 9) | (q << 18);
}
export function edgeEnc(nx: number, ny: number, d: number): number {
  return edgeEncA(Math.atan2(ny, nx), d);
}
export function edgeDec(e: number): EdgeSample | null {
  if (!(e & EDGE_ON)) return null;
  const a = ((e >>> 9) & (A_STEPS - 1)) * ((2 * Math.PI) / A_STEPS);
  const q = (e >>> 18) & (Q_STEPS - 1);
  return { nx: Math.cos(a), ny: Math.sin(a), d: (q - Q_STEPS / 2) / Q_UNIT };
}

/** whether two fields describe the same line within `steps` quantisation steps (GPU f32 against the oracle's f64) */
export function edgeClose(a: number, b: number, steps = 2, dSteps = steps): boolean {
  if (!(a & EDGE_ON) || !(b & EDGE_ON)) return (a & EDGE_ON) === (b & EDGE_ON);
  const e = edgeDiff(a, b);
  return e.da <= steps && e.dq <= dSteps;
}
/** two present fields' difference in quantisation steps: angle (512 a turn), distance (1024 a column) */
export function edgeDiff(a: number, b: number): { da: number; dq: number } {
  const da = Math.abs(((a >>> 9) & (A_STEPS - 1)) - ((b >>> 9) & (A_STEPS - 1)));
  const dq = Math.abs(((a >>> 18) & (Q_STEPS - 1)) - ((b >>> 18) & (Q_STEPS - 1)));
  return { da: Math.min(da, A_STEPS - da), dq };
}

/** enhance: a parent's line seen from a child column. off = the child's centre minus the parent's, PARENT units; k the
 *  factor. d_child = (d_parent - dot(n, off)) * k; none past the range. */
export function edgeToChild(e: number, offX: number, offY: number, k: number): number {
  const s = edgeDec(e);
  if (!s) return 0;
  return edgeEncA(((e >>> 9) & (A_STEPS - 1)) * ((2 * Math.PI) / A_STEPS), (s.d - (s.nx * offX + s.ny * offY)) * k);
}

/** restrict: the parent's line from its children's (those with a sample, in the order given): the mean normal
 *  (normalised) and the mean of the children's line points (each child's centre plus d n, parent units) projected on it.
 *  off: each child's centre minus the parent's, parent units. 0 when no child has one or the normals cancel. */
export function edgeFromChildren(es: number[], offs: [number, number][], k: number): number {
  let sx = 0;
  let sy = 0;
  let px = 0;
  let py = 0;
  let n = 0;
  for (let i = 0; i < es.length; i++) {
    const s = edgeDec(es[i]);
    if (!s) continue;
    sx += s.nx;
    sy += s.ny;
    px += offs[i][0] + (s.d / k) * s.nx;
    py += offs[i][1] + (s.d / k) * s.ny;
    n++;
  }
  // (no line where the children's normals spread too far: a feature smaller than the parent's cell, e.g. a small
  // mound's whole outline, whose mean normal nearly cancels; GPU f32 and the oracle's f64 then pick opposite ones)
  const l = Math.hypot(sx, sy);
  if (!n || l < 0.5 * n) return 0;
  const nx = sx / l;
  const ny = sy / l;
  return edgeEncA(Math.atan2(ny, nx), (nx * px + ny * py) / n);
}

/** the slide's regulariser: the pull of a corner's vertex toward the corner itself, per unit weight of a sample */
export const SLIDE_REG = 0.05;
/** the slide's bound, columns. Round 22's brief said 0.45; 0.35 is the largest round bound that can never fold a sheet
 *  triangle: a sheet triangle is half a unit square (legs 1), its smallest altitude 1/sqrt(2) (the right angle's, onto
 *  the diagonal); moving each vertex at most rho moves a vertex's signed distance to the line through the other two by at
 *  most 2 rho, so rho < 0.3536 keeps every orientation. At 0.45 the random carve test folded 8 triangles in its first
 *  run (diagonal edges where two corners' lines conflict). */
export const SLIDE_MAX = 0.35;

/** the slide of one corner (2D dual contouring): samples given as (field, the column centre minus the corner); the
 *  offset minimising sum (dot(n_i, p - (c_i + d_i n_i)))^2 + SLIDE_REG |p|^2, clamped to a disc of SLIDE_MAX. Only where
 *  the edge crosses the corner's cell: some sample's centre inside (d > 0) and some outside (d <= 0); else 0. */
export function slideOf(samples: { e: number; cx: number; cy: number }[]): { x: number; y: number; crossed: boolean } {
  let axx = 0;
  let axy = 0;
  let ayy = 0;
  let bx = 0;
  let by = 0;
  let pos = 0;
  let neg = 0;
  for (const smp of samples) {
    const s = edgeDec(smp.e);
    if (!s) continue;
    if (s.d > 0) pos++;
    else neg++;
    const e = s.d + s.nx * smp.cx + s.ny * smp.cy;
    axx += s.nx * s.nx;
    axy += s.nx * s.ny;
    ayy += s.ny * s.ny;
    bx += s.nx * e;
    by += s.ny * e;
  }
  if (!pos || !neg) return { x: 0, y: 0, crossed: false };
  const a = axx + SLIDE_REG;
  const c = ayy + SLIDE_REG;
  const det = a * c - axy * axy;
  let x = (c * bx - axy * by) / det;
  let y = (a * by - axy * bx) / det;
  const l = Math.hypot(x, y);
  if (l > SLIDE_MAX) {
    x *= SLIDE_MAX / l;
    y *= SLIDE_MAX / l;
  }
  return { x, y, crossed: true };
}
