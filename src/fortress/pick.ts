// Which block face a tap lands on (round 128d, the user: "Fix the clicking on the side to build next to it. This should
// be trivial with a pick and then knowing which side and jumping to an adjacent cell at the same height"). The fortress
// is drawn as pieces, so the pick is the plan's own: a ray through the tap marched through the cells' block stacks
// (each block its cell's quad from its floor up LEVEL_H). The face it enters by says where a new block goes: a top face
// stacks on it, a side face puts one in the neighbouring cell it came from, at the same level. Pure: no GPU, no DOM.
import type { Block } from '../build/town';
import { LEVEL_H, MAX_LEVELS } from '../build/town';

export interface PickCells {
  /** the cell under (x, y) in the plan's frame (-1 none) */
  cellAtWorld(x: number, y: number): number;
}

export interface FaceHit {
  cell: number;
  level: number;
  /** top: entered from above; side: from the neighbouring cell `from`; bottom: from below */
  face: 'top' | 'side' | 'bottom';
  /** the cell the ray was over just before (side: the neighbour across the face; -1 off the grid) */
  from: number;
}

/**
 * March the ray (o + t·d, the plan's frame) through the blocks; the first block it enters. `occ(c)`: c's blocks (a bit
 * a level: planned or built), `floor(c)`: c's ground floor (level 0's).
 */
export function pickFace(cells: PickCells, occ: (c: number) => number, floor: (c: number) => number, o: readonly number[], d: readonly number[], tMax: number, step = 0.08): FaceHit | null {
  let prev = -1;
  let prevZ = Infinity;
  for (let t = 0; t <= tMax; t += step) {
    const x = o[0] + d[0] * t;
    const y = o[1] + d[1] * t;
    const z = o[2] + d[2] * t;
    const c = cells.cellAtWorld(x, y);
    if (c >= 0 && occ(c)) {
      const L = Math.floor((z - floor(c)) / LEVEL_H);
      if (L >= 0 && L < MAX_LEVELS && (occ(c) >> L) & 1) {
        if (prev === c) return { cell: c, level: L, face: prevZ > z ? 'top' : 'bottom', from: prev };
        return { cell: c, level: L, face: 'side', from: prev };
      }
    }
    prev = c;
    prevZ = z;
  }
  return null;
}

/**
 * Where a new block goes for a face hit: on top (the level above), or beside it across a side face (the neighbouring
 * cell, the same level). Null: nowhere (from below, or off the grid).
 */
export function placeFor(hit: FaceHit): Block | null {
  if (hit.face === 'top') return { cell: hit.cell, level: hit.level + 1 };
  if (hit.face === 'side' && hit.from >= 0) return { cell: hit.from, level: hit.level };
  return null;
}
