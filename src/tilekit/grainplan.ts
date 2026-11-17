// (tilekit step 3, TILEKIT.md §21) The lab's road plan round Muru's centre, in lattice steps from the lattice point
// nearest the anchor (O): a through road with a mini plaza on it, a second road that leaves the plaza and bends, an
// alley off the through road (an arch over its mouth). Hand-placed: later a town plan's streets and lots are the
// input (§23). Also the lattice window the lab and the tests build (the GPU grid lab's 3 × 3 chunks round the anchor).

import { latOf, nearestLat, type RoadPlan, type V2 } from './grain';

/** the GPU grid lab's chunks round the anchor (8 lattice cells a chunk), ±`ring` chunks */
export function windowAt(anchor: V2, ring = 1) {
  const [la, lb] = latOf(anchor);
  const chx = Math.floor(la / 8);
  const chy = Math.floor(lb / 8);
  return { a0: (chx - ring) * 8, a1: (chx + ring + 1) * 8, b0: (chy - ring) * 8, b1: (chy + ring + 1) * 8 };
}

const add = (o: V2, d: V2): V2 => [o[0] + d[0], o[1] + d[1]];

/** the lab's anchor: the mean centre of the built lots in citygen's lot records (lab.ts, the step-2 fixture) */
export function lotsAnchor(words: Uint32Array, stride = 24): V2 {
  const f = new Float32Array(words.buffer, words.byteOffset, words.length);
  let x = 0;
  let y = 0;
  let n = 0;
  for (let i = 0; i < words.length / stride; i++) {
    if (words[i * stride + 17] !== 1) continue;
    x += f[i * stride + 8];
    y += f[i * stride + 9];
    n++;
  }
  return [x / n, y / n];
}

/** step 3's grid: the grain on, the window relaxed long enough for the grain's rhombi to square up (§21.4) */
export const STEP3_GRID = { radius: 30, relax: 1000, fair: 0.5 };
/** step 3's massing: plots laid along the streets (a main range fronting each), deeper strips, small leftovers left
 *  open as yards, wings behind at 0.45 odds, no tower (a 1-cell tower read as a chimney stack), one arch, few random
 *  alleys (the traced one is the alley) */
export const STEP3_PLAN = { radius: 30, plotCells: 30, alleyOdds: 0.12, maxA: 11, maxB: 3, towers: 0, arches: 1, annexOdds: 0, plots: 'frontage' as 'frontage' | 'lots', depth: 3, minA: 6, wingOdds: 0.45 };
/** step 3's build: at most two turrets, roofs unioned, contact shadows, a little colour variety a house */
export const STEP3_BUILD = { turrets: 2, roofJoin: 'union' as const, contact: true, tintJitter: 0.07 };

/** the plan: `variant` 0 the default; the lattice directions are (1,0) 0°, (0,1) 60°, (−1,1) 120°, (−1,0) 180°,
 *  (0,−1) 240°, (1,−1) 300° */
export function labPlan(anchor: V2, variant = 0): RoadPlan {
  const O = nearestLat(anchor);
  const P = (d: V2[]) => d.map((x) => add(O, x));
  if (variant === 1) return { roads: [], plazas: [] };
  // A hexagonal mini plaza on O; three roads leave it from alternate corners (v0 east, v2 north-west, v4 south-west),
  // so each block between two roads is bounded by two lattice families only and takes the third as its grain (1, 0,
  // 2): the roads are the seams. The east road bends 60° (to the south-east) four steps out; a bend that keeps its
  // angle needs a seam from it into the block on its inside (§21.3), here along 240° to the district's edge. An alley
  // runs off the east road into the north-east block along that block's other axis, an arch over its mouth.
  if (variant === 2) {
    // (the same roads without the seam: the south block is bounded by all three families, its grain leaves a row of
    // triangles over along one road — what happens without the rule)
    const p = labPlan(anchor, 0);
    return { ...p, roads: p.roads.filter((r) => r.kind !== 'seam') };
  }
  return {
    plazas: [{ name: 'plaza', poly: P([[1, 0], [0, 1], [-1, 1], [-1, 0], [0, -1], [1, -1]]) }],
    roads: [
      { name: 'east road', kind: 'road', pts: P([[1, 0], [4, 0], [7, -3]]) },
      { name: 'north-west road', kind: 'road', pts: P([[-1, 1], [-6, 6]]) },
      { name: 'south-west road', kind: 'road', pts: P([[0, -1], [0, -7]]) },
      { name: 'alley', kind: 'alley', side: 1, pts: P([[3, 0], [-1, 4]]) },
      { name: 'seam', kind: 'seam', pts: P([[4, 0], [4, -7]]) },
    ],
  };
}
