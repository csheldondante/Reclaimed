// (season life; debug and tests only) The town wall's shape as the CPU knows it: from its words, read back at a save
// point (FieldTowns.saveWall; citygen/townlog.ts; streets.wgsl WALL). Pure: posts on its walk and its gates, in the
// town grid's frame (world units; z world). Orders don't use it: Track B's `man` and `march` read the GPU's wall table
// (routeread.wgsl wallWalkRoute, gateRoute), made on the GPU from the same words.

/** streets.wgsl's WALL layout: NB directions; the corners at WB_V, their ground at WB_Z, each segment's piece at WB_KIND */
export const NB = 72;
const WB_V = 80;
const WB_Z = 296;
const WB_KIND = 368;
const WB_ART = 440;
const WB_S = 512;
/** streets.wgsl WALL_H, WALL_BAND */
export const WALL_H = 4.5;
const WALL_BAND = 0.12;

export interface WallPost {
  /** the segment it stands on */
  seg: number;
  /** on the wall-walk's middle (the grid's world units; z world) */
  at: [number, number, number];
}

const f32 = (w: number) => new Float32Array(new Uint32Array([w]).buffer)[0];
const corner = (w: readonly number[], b: number): [number, number] => [f32(w[WB_V + 2 * (b % NB)]), f32(w[WB_V + 2 * (b % NB) + 1])];

/** a segment's rise at the wall's stage `to` (streets.wgsl wallRise, eased to its end) */
export function segmentRise(w: readonly number[], seg: number, to: number): number {
  const gate0 = w[2];
  const k = ((seg + NB - gate0) % NB) / NB;
  return Math.min(1, Math.max(0, (to - k * (1 - WALL_BAND)) / WALL_BAND));
}

/** the posts: a segment's middle on each wall piece fully risen (not a gate, not over water) */
export function wallPosts(w: readonly number[], to: number): WallPost[] {
  if (w[0] !== 1) return [];
  const out: WallPost[] = [];
  for (let b = 0; b < NB; b++) {
    if (w[WB_KIND + b] !== 0 || segmentRise(w, b, to) < 1) continue;
    const p = corner(w, b);
    const q = corner(w, b + 1);
    const z = (f32(w[WB_Z + b]) + f32(w[WB_Z + ((b + 1) % NB)])) / 2 - 0.4 + WALL_H;
    out.push({ seg: b, at: [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2, z] });
  }
  return out;
}

export interface WallGate {
  seg: number;
  /** the gate segment's middle */
  at: [number, number];
  /** the arterial through it (its index in the town's ART; −1: none — a gate the rule of two added) and where along
   *  it the ring crosses (world units from its centre end) */
  art: number;
  along: number;
}

/** the gates: each gate segment's middle, and the arterial through it */
export function wallGates(w: readonly number[]): WallGate[] {
  if (w[0] !== 1) return [];
  const out: WallGate[] = [];
  for (let b = 0; b < NB; b++) {
    if (w[WB_KIND + b] !== 1) continue;
    const p = corner(w, b);
    const q = corner(w, b + 1);
    out.push({ seg: b, at: [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2], art: (w[WB_ART + b] ?? 0) - 1, along: f32(w[WB_S + b] ?? 0) });
  }
  return out;
}
