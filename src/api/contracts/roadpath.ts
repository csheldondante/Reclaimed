// (road lab, RD1; the user 2026-11-12: "the road path independent of both [the terrain edit and the meshes] a guaranteed
// fixed path defined in curves and width") Road path records: the authority for where a road runs, how wide it is, the
// height it's graded to and when it's revealed. Everything else is derived from them: the cut and fill on the columns
// and the road's surface interval (shaders/roadgrade.wgsl), the placeholder ramps, stairs and towers (roadlab/ladder.ts),
// and later archgen's grow-in decal (a draw pass reading this buffer).
//
// One read-only storage buffer, `array<vec4<u32>>` (f32 fields as their bits). Its WGSL mirror is
// src/shaders/roadpath.wgsl (struct RoadRec, RoadPt; roadHead, roadRec, roadPt) — keep the two the same.
//
//   vec4 0                 header: x the roads, y the points, z the first record's vec4 (ROAD_REC_BASE = 1),
//                          w the first point's vec4 (1 + 2 × roads)
//   vec4 z + 3r            record r, word a: x its first point (index into the points), y its point count (≥ 2; 0 an
//                          empty slot — a GPU-made set's unused record), z its surface kind (RoadSurface: 0 dirt, 1
//                          cobble — what it ends as), w flags (ROAD_GRADED, ROAD_PAVED, ROAD_DRY)
//   vec4 z + 3r + 1        record r, word b (f32): x reveal start, y reveal end (seconds on the owner's clock: the lab's
//                          since it opened; a town's would be its own), z the shoulder (how far past the half width the
//                          ground is sloped back to the land, world units), w maxDz (a road without ROAD_GRADED moves
//                          the ground at most this much: where the profile leaves the ground a structure carries it)
//   vec4 z + 3r + 2        record r, word c (f32): its box — x0, y0, x1, y1 of its points ± (half width + shoulder), the
//                          points' frame (loop-streets: a column tests only the records whose box holds it)
//   vec4 w + i             point i (f32): x, y world units (the frame's — the lab's: the window's, common.wgsl cellPos;
//                          a town's: its grid's, placed in the window by the lay), z the profile (the road's surface
//                          height: the lab's window z, a town's world z), w the half width there
//
// A road is a polyline through its points; the profile and the half width are linear along each segment. Points are
// never smoothed (DESIGN §12: "don't ever smooth them yet").
//
// The road's surface interval in a column (what roadgrade.wgsl writes, common.wgsl ivPack's slot): x z0, y z1 (f32), z
// the material (MAT.DirtRoad / MAT.Cobble) | (record + 1) << 8 | f16(reveal start) << 16, w f32 bits of reveal end.
// The record link (aux) survives every pass that re-packs a slot with ivPack; the reveal bits ride only as far as the
// slot is copied whole (the structure pass keeps a non-structural solid's word; the sediment pass re-packs the loose
// run over it, not it). The record is the authority: read the times from it.

/** the surface a road ends as (record word a.z) */
export const RoadSurface = { Dirt: 0, Cobble: 1, /** (loop-streets) a town's light flagstones (MAT.Paving), laid paved */ Paving: 2 } as const;
export type RoadSurface = (typeof RoadSurface)[keyof typeof RoadSurface];

/** record flag: cut and fill all the way to the profile (else at most maxDz, the rest left to a structure) */
export const ROAD_GRADED = 1;
/** (loop-streets) record flag: laid as its surface at once (the lab lays dirt and paves at the reveal's end) */
export const ROAD_PAVED = 2;
/** (loop-streets) record flag: a wet column (water over its ground) is left as it is — a ford's bed stays under its
 *  river, no fill dams it */
export const ROAD_DRY = 4;
/** vec4s: the header, a record, a point */
export const ROAD_HEADER_VEC4 = 1;
export const ROAD_REC_VEC4 = 3;
export const ROAD_PT_VEC4 = 1;
/** the first record's vec4 */
export const ROAD_REC_BASE = ROAD_HEADER_VEC4;
/** at most this many roads in a buffer: the record link is the interval's aux byte (record + 1, 0 none) */
export const ROAD_MAX = 255;

/** a point of a road's path */
export interface RoadPoint {
  /** world units (the window's frame) */
  x: number;
  y: number;
  /** the profile: the surface's height here (window z) */
  z: number;
  /** half the road's width here */
  hw: number;
}

/** a road as authored (CPU: the lab, later a town's builders) */
export interface RoadRecord {
  points: RoadPoint[];
  surface: RoadSurface;
  /** cut and fill all the way (ROAD_GRADED), else at most maxDz */
  graded: boolean;
  /** (loop-streets) laid as its surface at once (ROAD_PAVED); wet columns left (ROAD_DRY) */
  paved?: boolean;
  dry?: boolean;
  revealStart: number;
  revealEnd: number;
  /** world units past the half width the ground slopes back to the land */
  shoulder: number;
  maxDz: number;
}

/** the buffer's bytes for these roads (the layout above) */
export function packRoads(roads: RoadRecord[]): ArrayBuffer {
  if (roads.length > ROAD_MAX) throw new Error(`road records: ${roads.length} roads (> ${ROAD_MAX})`);
  const nPts = roads.reduce((a, r) => a + r.points.length, 0);
  const ptBase = ROAD_REC_BASE + ROAD_REC_VEC4 * roads.length;
  const buf = new ArrayBuffer((ptBase + nPts) * 16);
  const u = new Uint32Array(buf);
  const f = new Float32Array(buf);
  u.set([roads.length, nPts, ROAD_REC_BASE, ptBase], 0);
  let first = 0;
  roads.forEach((r, i) => {
    if (r.points.length < 2) throw new Error(`road ${i}: ${r.points.length} points (a road needs 2 or more)`);
    if (!(r.revealEnd >= r.revealStart)) throw new Error(`road ${i}: reveal end ${r.revealEnd} before its start ${r.revealStart}`);
    const o = (ROAD_REC_BASE + ROAD_REC_VEC4 * i) * 4;
    u.set([first, r.points.length, r.surface, (r.graded ? ROAD_GRADED : 0) | (r.paved ? ROAD_PAVED : 0) | (r.dry ? ROAD_DRY : 0)], o);
    f.set([r.revealStart, r.revealEnd, r.shoulder, r.maxDz], o + 4);
    let bx0 = Infinity;
    let by0 = Infinity;
    let bx1 = -Infinity;
    let by1 = -Infinity;
    for (const p of r.points) {
      const m = p.hw + r.shoulder;
      bx0 = Math.min(bx0, p.x - m);
      by0 = Math.min(by0, p.y - m);
      bx1 = Math.max(bx1, p.x + m);
      by1 = Math.max(by1, p.y + m);
    }
    f.set([bx0, by0, bx1, by1], o + 8);
    r.points.forEach((p, k) => f.set([p.x, p.y, p.z, p.hw], (ptBase + first + k) * 4));
    first += r.points.length;
  });
  return buf;
}

/** the roads back from a buffer's bytes (tests, debugging) */
export function unpackRoads(buf: ArrayBuffer): RoadRecord[] {
  const u = new Uint32Array(buf);
  const f = new Float32Array(buf);
  const [n, , recBase, ptBase] = u;
  const out: RoadRecord[] = [];
  for (let i = 0; i < n; i++) {
    const o = (recBase + ROAD_REC_VEC4 * i) * 4;
    const points: RoadPoint[] = [];
    for (let k = 0; k < u[o + 1]; k++) {
      const p = (ptBase + u[o] + k) * 4;
      points.push({ x: f[p], y: f[p + 1], z: f[p + 2], hw: f[p + 3] });
    }
    out.push({ points, surface: u[o + 2] as RoadSurface, graded: (u[o + 3] & ROAD_GRADED) !== 0, paved: (u[o + 3] & ROAD_PAVED) !== 0, dry: (u[o + 3] & ROAD_DRY) !== 0, revealStart: f[o + 4], revealEnd: f[o + 5], shoulder: f[o + 6], maxDz: f[o + 7] });
  }
  return out;
}

/** a road's box in the window's columns [x0, x1) × [y0, y1), its points ± (half width + shoulder), clipped to w × h */
export function roadColumnBox(r: RoadRecord, w: number, h: number): [number, number, number, number] {
  const ROW_H = Math.sqrt(3) / 2;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of r.points) {
    const m = p.hw + r.shoulder + 1;
    x0 = Math.min(x0, p.x - m);
    x1 = Math.max(x1, p.x + m);
    y0 = Math.min(y0, p.y - m);
    y1 = Math.max(y1, p.y + m);
  }
  const cx0 = Math.max(0, Math.floor(x0 - 1));
  const cx1 = Math.min(w, Math.ceil(x1 + 1));
  const cy0 = Math.max(0, Math.floor(y0 / ROW_H - 1));
  const cy1 = Math.min(h, Math.ceil(y1 / ROW_H + 1));
  return [cx0, cy0, Math.max(cx0, cx1), Math.max(cy0, cy1)];
}
