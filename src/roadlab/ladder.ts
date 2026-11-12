// (road lab, RD1; the user 2026-11-12: "Let's experiment to determine the grade for ramps stairs and towers.") The grade
// ladder, authored on the CPU (authoring isn't on the low-latency path): the lab's land, the road path records and the
// placeholder structures, all from these numbers. Pure: test/unit/roadlab-ladder.test.ts checks it in Node.
//
// The land: a plain at Z0 and, between x EDGE_W and EDGE_E, a terrace H higher behind a sheer rock step (both with a
// half-cell of gentle relief, so the flattening shows). Every road climbs that same step from the plain to the terrace;
// what changes down the rows is its grade: flat, 1:12, 1:8, 1:6, 1:4, 1:3, 1:2, 1:1, then the cliff itself.
// Each grade row has two lanes, each lane a road climbing the west step and one climbing the east step:
//   lane A  west: graded (cut and fill only, centred on the step)     east: a ramp (a wedge from the plain to the top)
//   lane B  west: stairs (steps from the plain to the top)            east: a switchback (three graded legs, gentle
//                                                                           rows) or a stair tower (1:2, 1:1, cliff)
// The flat row is a flat road over the bumpy plain (dirt west, cobble east). Where a variant can't exist (a graded
// cliff, a ramp up a cliff) the lab says so on screen. Only graded roads and switchbacks cut and fill all the way; the
// others move the ground at most MAX_DZ and the structure carries the road where the profile leaves the ground.

import { RoadSurface, type RoadPoint, type RoadRecord } from '../api/contracts/roadpath';
import { MAT } from '../world/materials';

/** the plain's and the terrace's heights; the step between */
export const Z0 = 10;
export const Z1 = 16;
export const H = Z1 - Z0;
/** the terrace's west and east steps (world x) */
export const EDGE_W = 96;
export const EDGE_E = 160;
/** a road's half width; its approaches on the flat each side */
export const HW = 1.5;
export const APPROACH = 8;
/** a graded road's banks (world units past the edge) */
export const SHOULDER = 6;
/** a structure's road: the most it moves the ground (the land's relief is ±0.5) */
export const MAX_DZ = 1;
/** stairs: the rise of a step */
export const RISE = 0.5;
/** the lanes: the first's y and the spacing (world units) */
export const LANE_Y0 = 10;
export const LANE_DY = 11.5;

export interface Grade {
  /** its label: 'flat', '1:12' … 'cliff' */
  name: string;
  /** run per rise (0 flat; Infinity the cliff) */
  k: number;
}
export const GRADES: Grade[] = [
  { name: 'flat', k: 0 },
  { name: '1:12', k: 12 },
  { name: '1:8', k: 8 },
  { name: '1:6', k: 6 },
  { name: '1:4', k: 4 },
  { name: '1:3', k: 3 },
  { name: '1:2', k: 2 },
  { name: '1:1', k: 1 },
  { name: 'cliff', k: Infinity },
];

export type Variant = 'graded' | 'ramp' | 'stairs' | 'switchback' | 'tower' | 'flat';

/** a placeholder structure: an axis-aligned box over [x0, x1) × [y0, y1) from zb up to its top, which runs from zt0 at
 *  x0 to zt1 at x1 (a ramp's wedge; a step's or a tower's top is level) */
export interface Box {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  zb: number;
  zt0: number;
  zt1: number;
  mat: number;
}

export interface Label {
  x: number;
  y: number;
  z: number;
  text: string;
  /** the grade row (the row's own label: -1 for a variant's) */
  row: number;
}

/** one road of the ladder: its record and what it is */
export interface LadderRoad {
  row: number;
  variant: Variant;
  side: 'west' | 'east';
  record: RoadRecord;
}

export interface Ladder {
  roads: LadderRoad[];
  boxes: Box[];
  labels: Label[];
}

/** the land's gentle relief (±0.5) */
export function relief(x: number, y: number): number {
  return 0.3 * Math.sin(x * 0.37 + 1.3) * Math.sin(y * 0.41 + 0.7) + 0.2 * Math.sin(x * 0.13 - y * 0.17 + 2.1);
}

/** the authored ground's top at world (x, y) */
export function landZ(x: number, y: number): number {
  return (x >= EDGE_W && x < EDGE_E ? Z1 : Z0) + relief(x, y);
}

/** lane i's middle (world y) */
export const laneY = (i: number) => LANE_Y0 + i * LANE_DY;

/** a side's step (world x) and which way is out onto the plain */
const edgeOf = (side: 'west' | 'east') => (side === 'west' ? { e: EDGE_W, s: -1 } : { e: EDGE_E, s: 1 });

/** a point u out from a side's step onto the plain (u < 0: onto the terrace) */
function at(side: 'west' | 'east', u: number, y: number, z: number, hw = HW): RoadPoint {
  const { e, s } = edgeOf(side);
  return { x: e + s * u, y, z, hw };
}

/** a box between u0 and u1 out from a side's step (its tops given at u0 and u1) */
function boxU(side: 'west' | 'east', u0: number, u1: number, y0: number, y1: number, zb: number, zt0: number, zt1: number, mat: number): Box {
  const { e, s } = edgeOf(side);
  const xa = e + s * u0;
  const xb = e + s * u1;
  return xa <= xb ? { x0: xa, x1: xb, y0, y1, zb, zt0, zt1, mat } : { x0: xb, x1: xa, y0, y1, zb, zt0: zt1, zt1: zt0, mat };
}

/** the ladder: every road, structure and label */
export function buildLadder(): Ladder {
  const roads: LadderRoad[] = [];
  const boxes: Box[] = [];
  const labels: Label[] = [];
  const add = (row: number, variant: Variant, side: 'west' | 'east', points: RoadPoint[], graded: boolean, surface: RoadSurface) => {
    const i = roads.length;
    const revealStart = 1 + 0.25 * i;
    roads.push({ row, variant, side, record: { points, surface, graded, revealStart, revealEnd: revealStart + 3, shoulder: graded ? SHOULDER : 1, maxDz: graded ? 0 : MAX_DZ } });
  };
  // (lane B's labels further out onto the plain than lane A's: side by side they'd overlap on a phone)
  const tag = (side: 'west' | 'east', y: number, text: string) => {
    const { e, s } = edgeOf(side);
    const laneB = Math.round((y - LANE_Y0) / LANE_DY) % 2 === 1;
    labels.push({ x: e + s * (laneB ? 12 : 3), y, z: (laneB ? Z0 : Z1) + 1.5, text, row: -1 });
  };
  GRADES.forEach((g, row) => {
    const yA = laneY(2 * row);
    const yB = laneY(2 * row + 1);
    // (alternate rows staggered along x: side by side at the whole ladder's zoom they would overlap)
    labels.push({ x: (EDGE_W + EDGE_E) / 2 + (row % 2 ? 14 : -14), y: (yA + yB) / 2, z: Z1 + 1, text: g.k === 0 ? 'flat' : g.k === Infinity ? 'cliff' : `${g.name} (${Math.round(100 / g.k)}%)`, row });
    if (g.k === 0) {
      add(row, 'flat', 'west', [at('west', 12, yA, Z0), at('west', 52, yA, Z0)], true, RoadSurface.Dirt);
      add(row, 'flat', 'east', [at('east', 12, yA, Z0), at('east', 52, yA, Z0)], true, RoadSurface.Cobble);
      tag('west', yA, 'flat: graded, dirt');
      tag('east', yA, 'flat: graded, cobble');
      tag('west', yB, 'flat: no stairs needed');
      tag('east', yB, 'flat: no tower needed');
      return;
    }
    const cliff = g.k === Infinity;
    // lane A west: graded, centred on the step (half cut into the terrace, half filled on the plain)
    if (cliff) tag('west', yA, 'cliff: can\'t be graded');
    else {
      const R = H * g.k;
      add(row, 'graded', 'west', [at('west', -R / 2 - APPROACH, yA, Z1), at('west', -R / 2, yA, Z1), at('west', R / 2, yA, Z0), at('west', R / 2 + APPROACH, yA, Z0)], true, RoadSurface.Dirt);
      tag('west', yA, `${g.name} graded`);
    }
    // lane A east: a ramp, a wedge from the step's top out onto the plain
    if (cliff) tag('east', yA, 'cliff: no ramp');
    else {
      const R = H * g.k;
      add(row, 'ramp', 'east', [at('east', -APPROACH, yA, Z1), at('east', 0, yA, Z1), at('east', R, yA, Z0), at('east', R + APPROACH, yA, Z0)], false, RoadSurface.Cobble);
      boxes.push(boxU('east', 0, R, yA - HW, yA + HW, Z0 - 0.6, Z1, Z0, MAT.Wood));
      tag('east', yA, `${g.name} ramp`);
    }
    // lane B west: stairs
    if (cliff) tag('west', yB, 'cliff: no stairs');
    else {
      const R = H * g.k;
      const tread = RISE * g.k;
      add(row, 'stairs', 'west', [at('west', -APPROACH, yB, Z1), at('west', 0, yB, Z1), at('west', R, yB, Z0), at('west', R + APPROACH, yB, Z0)], false, RoadSurface.Cobble);
      const n = Math.round(H / RISE);
      for (let j = 0; j < n; j++) {
        const top = Z0 + (j + 1) * RISE;
        boxes.push(boxU('west', R - (j + 1) * tread, R - j * tread, yB - HW, yB + HW, Z0 - 0.6, top, top, MAT.Brick));
      }
      tag('west', yB, `${g.name} stairs`);
    }
    // lane B east: a switchback for the gentle grades, a stair tower for 1:2 and steeper
    if (g.k >= 3 && !cliff) {
      const L = (H * g.k) / 3;
      const dy = 4;
      const hw = 1.25;
      const zA = Z0 + H / 3;
      const zB = Z0 + (2 * H) / 3;
      add(row, 'switchback', 'east', [
        at('east', 1 + L + APPROACH, yB - dy, Z0, hw), at('east', 1 + L, yB - dy, Z0, hw), at('east', 1, yB - dy, zA, hw),
        at('east', 1, yB, zA, hw), at('east', 1 + L, yB, zB, hw),
        at('east', 1 + L, yB + dy, zB, hw), at('east', 0, yB + dy, Z1, hw), at('east', -APPROACH, yB + dy, Z1, hw),
      ], true, RoadSurface.Dirt);
      tag('east', yB, `${g.name} switchback`);
    } else {
      const k = cliff ? 1 : g.k;
      tower(row, yB, k, cliff ? 'cliff: stair tower (1:1)' : `${g.name} stair tower`);
    }
  });

  /** a stair tower against the east step: a block D deep and W wide, its stair round the outer face and the +y face */
  function tower(row: number, y: number, k: number, text: string): void {
    const D = 5;
    const W = 5;
    const o = 0.75;
    boxes.push(boxU('east', 0, D, y - W / 2, y + W / 2, Z0 - 0.6, Z1, Z1, MAT.Plaster));
    // the stair's path (u, y): along the outer face from its -y corner, then the +y face back to the step
    const q1 = [D + o, y - W / 2 - o];
    const q2 = [D + o, y + W / 2 + o];
    const q3 = [0, y + W / 2 + o];
    const len1 = q2[1] - q1[1];
    const len = len1 + q2[0] - q3[0];
    const S = H * k;
    if (S > len) throw new Error(`stair tower: a ${S}-long stair round a ${len}-long path`);
    const d0 = len - S;
    const pathAt = (d: number): [number, number, 'out' | 'side'] => (d <= len1 ? [q1[0], q1[1] + d, 'out'] : [q2[0] - (d - len1), q2[1], 'side']);
    const zAt = (d: number) => Z0 + Math.max(0, d - d0) / k;
    const [u0, y0] = pathAt(d0);
    add(row, 'tower', 'east', [
      at('east', u0 + APPROACH, y0, Z0), at('east', u0, y0, Z0),
      ...(d0 < len1 ? [at('east', q2[0], q2[1], zAt(len1))] : []),
      at('east', q3[0], q3[1], Z1), at('east', -APPROACH, q3[1], Z1),
    ], false, RoadSurface.Cobble);
    const tread = RISE * k;
    const n = Math.round(H / RISE);
    for (let j = 0; j < n; j++) {
      const [u, yy, face] = pathAt(d0 + (j + 0.5) * tread);
      const top = Z0 + (j + 1) * RISE;
      const a = tread / 2 + 0.05;
      if (face === 'out') boxes.push(boxU('east', u - 0.75, u + 0.75, yy - a, yy + a, Z0 - 0.6, top, top, MAT.Brick));
      else boxes.push(boxU('east', u - a, u + a, yy - 0.75, yy + 0.75, Z0 - 0.6, top, top, MAT.Brick));
    }
    tag('east', y, text);
  }

  return { roads, boxes, labels };
}

/**
 * The structures as a triangle list in Renderer.addMesh's format (render.wgsl vsSkin): a vertex two vec4<u32> — the
 * position's f32 bits and the material word, then the face's normal and 0 — 36 vertices a box.
 */
export function boxMesh(boxes: Box[]): Uint32Array {
  const out = new Uint32Array(boxes.length * 36 * 8);
  const f = new Float32Array(out.buffer);
  let v = 0;
  const tri = (a: number[], b: number[], c: number[], mat: number) => {
    const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const l = Math.hypot(n[0], n[1], n[2]) || 1;
    for (const p of [a, b, c]) {
      f.set([p[0], p[1], p[2]], v * 8);
      out[v * 8 + 3] = mat;
      f.set([n[0] / l, n[1] / l, n[2] / l], v * 8 + 4);
      out[v * 8 + 7] = 0;
      v++;
    }
  };
  // (counter-clockwise seen from outside)
  const quad = (a: number[], b: number[], c: number[], d: number[], mat: number) => {
    tri(a, b, c, mat);
    tri(a, c, d, mat);
  };
  for (const B of boxes) {
    const { x0, x1, y0, y1, zb, zt0, zt1, mat } = B;
    const b00 = [x0, y0, zb], b10 = [x1, y0, zb], b11 = [x1, y1, zb], b01 = [x0, y1, zb];
    const t00 = [x0, y0, zt0], t10 = [x1, y0, zt1], t11 = [x1, y1, zt1], t01 = [x0, y1, zt0];
    quad(t00, t10, t11, t01, mat); // top
    quad(b00, b01, b11, b10, mat); // bottom
    quad(b00, b10, t10, t00, mat); // -y
    quad(b11, b01, t01, t11, mat); // +y
    quad(b01, b00, t00, t01, mat); // -x
    quad(b10, b11, t11, t10, mat); // +x
  }
  return out;
}
