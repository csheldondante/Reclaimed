// The rock lab (?level=rocklab, round 92; the user: "make a playground like the one used for waterfalls as it is
// convenient for me to test with too"): a flat stone plain with the collapse's test pieces round the camera, each
// standing as made until something cuts it — then it's judged (fracture.ts analyseRock, ROCK). Storage coordinates
// (x column, y row); the camera looks from +x+y, so the pieces' near sides face it. Three rows of three, 22 apart:
//   back:   a big top on a leg a fifth of it (round 96: break a little of the leg — it buckles; round 92's crushing
//           rule held it) · the same top on a wide leg, a third of it (stands) ·
//           a long arm off a wall (cut its root part way: it snaps there)
//   middle: an arch (break one foot) · a top off to one side of its leg (nick the leg's far side: it tips) ·
//           a tall pillar to drop a meteor by
//   front:  a tower banded with soil and concrete · a concrete tower · a tower with a waist to cut part way round
//   (round 96) in front of those, metal (with rockbody on it's woken into the physics voxels and bends): a steel girder
//           bridge on two stone piers (break a pier) · a steel frame tower (a meteor at its feet)
// The sandbox's tools (Break, Meteor, Heat beam, Dig) are on the panel.
// (solver step 2; the user, round 120: "Can we get a collapse test for domes and arches and cliffs with overhang in
// there?") A station off to the back left, 'collapse' (storage x 16..112, rows 16..96), with a button a cut: an arch
// (the keystone; a foot), a dome (a hole in its crown; its base ring), a cliff with three shelves off its top (reach
// 6 / 10 / 14, 1 / 2 / 3 thick: the judge's numbers in test/unit/judge-shapes.test.ts), a thin spire (its foot cut
// past its middle on one side). The same shapes the judge's Node tests cut.

import { ColumnGrid, type Interval, type WorldDims } from '../world/layout';
import { MAT } from '../world/materials';
import type { MapData } from '../world/mapgen';
import { cellAt, cellPos } from '../world/lattice';
import type { Station } from './playground';

const PLAIN = 12;
/** (solver step 2) the collapse station's shapes (storage cells) */
const SHAPES = {
  arch: { legs: [22, 34], y0: 24, y1: 27, h: 12, span: 3 },
  dome: { x: 60, y: 40, r: 9, t: 1.5 },
  cliff: { x0: 80, x1: 88, y0: 20, y1: 50, h: 20, shelves: [[22, 28, 6, 1], [32, 38, 10, 2], [42, 48, 14, 3]] as [number, number, number, number][] },
  spire: { x: 40, y: 70, r: 1.6, h: 20 },
};
const wp = (x: number, y: number): [number, number] => cellPos(x, y);

/** (solver step 2) the rock lab's stations: the collapse shapes, a button a cut */
export const ROCKLAB_STATIONS: Station[] = [
  {
    id: 'collapse',
    name: 'collapse',
    rect: [16, 16, 112, 96],
    look: [60, 40, 14, 4],
    hint: 'the collapse judge: an arch, a dome, a cliff with three overhangs, a thin spire — cut them, watch what lets go',
    actions: [
      { label: 'cut the keystone', run: (k) => k.dig(...wp(29.5, 25.5), 2.2, 4) },
      { label: 'cut a foot', run: (k) => k.smash(...wp(SHAPES.arch.legs[1] + 1.5, 25.5), PLAIN + 1.5, 2.4) },
      { label: 'hole in the dome', run: (k) => k.dig(...wp(SHAPES.dome.x, SHAPES.dome.y), 2.5, 3) },
      {
        label: 'cut the dome\'s ring',
        run: (k) => {
          const d = SHAPES.dome;
          const [cx, cy] = wp(d.x, d.y);
          for (let a = 0; a < 2 * Math.PI; a += Math.PI / 8) k.smash(cx + Math.cos(a) * (d.r - 0.8), cy + Math.sin(a) * (d.r - 0.8), PLAIN + 1, 1.6);
        },
      },
      {
        label: 'nick the shelves',
        run: (k) => {
          const c = SHAPES.cliff;
          for (const [y0, y1, reach] of c.shelves) k.dig(...wp(c.x1 + reach - 0.5, (y0 + y1) / 2), 1.2, 1);
        },
      },
      {
        label: 'undercut the cliff',
        run: (k) => {
          const c = SHAPES.cliff;
          for (const [y0, y1, , thick] of c.shelves) k.smash(...wp(c.x1 - 1, (y0 + y1) / 2), PLAIN + c.h - thick - 1, 2.2);
        },
      },
      { label: 'undercut the spire', run: (k) => k.smash(...wp(SHAPES.spire.x + 1, SHAPES.spire.y + 0.5), PLAIN + 1, 1.6) },
    ],
  },
];
/** the middle of the pieces (world): where the camera opens (the level's default target, w × 0.55, h × ROW_H × 0.5) */
export const ROCKLAB = { spacing: 22 };

export function generateRocklab(dims: WorldDims): MapData {
  const { w, h } = dims;
  const N = w * h;
  const cols: Interval[][] = Array.from({ length: N }, () => [{ z0: 0, z1: PLAIN - 2, mat: MAT.Stone }, { z0: PLAIN - 2, z1: PLAIN, mat: MAT.Soil }]);
  /** column (x, y) with [z0, z1) of mat in it (what was there replaced) */
  const put = (x: number, y: number, z0: number, z1: number, mat: number) => {
    if (x < 0 || y < 0 || x >= w || y >= h || z1 <= z0) return;
    const out: Interval[] = [];
    for (const iv of cols[y * w + x]) {
      if (iv.z1 <= z0 || iv.z0 >= z1) out.push(iv);
      else {
        if (iv.z0 < z0) out.push({ ...iv, z1: z0 });
        if (iv.z1 > z1) out.push({ ...iv, z0: z1 });
      }
    }
    out.push({ z0, z1, mat });
    out.sort((a, b) => a.z0 - b.z0);
    cols[y * w + x] = out;
  };
  /** the cells whose centres lie within r of world point (wx, wy) */
  const disc = (wx: number, wy: number, r: number): [number, number][] => {
    const out: [number, number][] = [];
    const [c0x, c0y] = cellAt(wx - r - 1, wy - r - 1);
    const [c1x, c1y] = cellAt(wx + r + 1, wy + r + 1);
    for (let y = Math.max(0, c0y); y <= Math.min(h - 1, c1y); y++)
      for (let x = Math.max(0, c0x); x <= Math.min(w - 1, c1x); x++) {
        const [px, py] = cellPos(x, y);
        if (Math.hypot(px - wx, py - wy) <= r) out.push([x, y]);
      }
    return out;
  };
  // (a little toward the camera and its left of where it opens: the tall pieces stand up the screen, the panel is on its right)
  const [cx, cy] = [w * 0.55 + 10, h * (Math.sqrt(3) / 2) * 0.5 - 6];
  const S = ROCKLAB.spacing;
  const at = (i: number, j: number): [number, number] => [cx + (i - 1) * S, cy + (j - 1) * S];
  const G = PLAIN;
  // back row (j = 0: furthest from the camera)
  {
    const [x, y] = at(0, 0);
    for (const [a, b] of disc(x, y, 2.6)) put(a, b, G - 2, G + 34, MAT.Stone);
    for (const [a, b] of disc(x, y, 6)) put(a, b, G + 22, G + 34, MAT.Stone);
  }
  {
    const [x, y] = at(1, 0);
    for (const [a, b] of disc(x, y, 3.5)) put(a, b, G - 2, G + 34, MAT.Stone);
    for (const [a, b] of disc(x, y, 6)) put(a, b, G + 22, G + 34, MAT.Stone);
  }
  {
    const [x, y] = at(2, 0);
    for (const [a, b] of disc(x - 6, y, 3)) put(a, b, G - 2, G + 36, MAT.Stone);
    for (let wx = x - 6; wx <= x + 9; wx += 0.5) for (const [a, b] of disc(wx, y, 1.5)) put(a, b, G + 28, G + 31, MAT.Stone);
  }
  // middle row
  {
    const [x, y] = at(0, 1);
    for (const dx of [-6, 6]) for (const [a, b] of disc(x + dx, y, 2)) put(a, b, G - 2, G + 20, MAT.Sandstone);
    for (let wx = x - 6; wx <= x + 6; wx += 0.5)
      for (const [a, b] of disc(wx, y, 1.6)) {
        const t = 2 + 4 * Math.pow(Math.abs(cellPos(a, b)[0] - x) / 6, 2);
        put(a, b, G + 20 - t, G + 20, MAT.Sandstone);
      }
  }
  {
    const [x, y] = at(1, 1);
    for (const [a, b] of disc(x, y, 2.5)) put(a, b, G - 2, G + 24, MAT.Stone);
    for (const [a, b] of disc(x + 2.5, y, 5)) put(a, b, G + 20, G + 24, MAT.Stone);
  }
  {
    const [x, y] = at(2, 1);
    for (const [a, b] of disc(x, y, 4)) put(a, b, G - 2, G + 60, MAT.Stone);
  }
  // front row
  {
    const [x, y] = at(0, 2);
    for (const [a, b] of disc(x, y, 3.5)) {
      put(a, b, G - 2, G + 40, MAT.Stone);
      for (let z = G + 8; z < G + 38; z += 8) put(a, b, z, z + 1, MAT.Soil);
      put(a, b, G + 20, G + 22, MAT.Concrete);
    }
  }
  {
    const [x, y] = at(1, 2);
    for (const [a, b] of disc(x, y, 2.5)) put(a, b, G - 2, G + 30, MAT.Concrete);
  }
  {
    const [x, y] = at(2, 2);
    for (const [a, b] of disc(x, y, 4.5)) put(a, b, G - 2, G + 50, MAT.Stone);
  }
  // (round 96) metal: a fourth row
  {
    // a steel girder bridge on two stone piers 18 apart, its deck a girder 3 wide, 2 deep
    const [x, y] = at(0, 3);
    for (const dx of [-9, 9]) for (const [a, b] of disc(x + dx, y, 2)) put(a, b, G - 2, G + 14, MAT.Stone);
    for (let wx = x - 11; wx <= x + 11; wx += 0.5) for (const [a, b] of disc(wx, y, 1.2)) put(a, b, G + 14, G + 16, MAT.Steel);
  }
  {
    // a steel frame tower: four legs, braced every 8 cells, a platform on top
    const [x, y] = at(1, 3);
    const legs: [number, number][] = [[-3, -3], [3, -3], [3, 3], [-3, 3]];
    for (const [lx, ly] of legs) for (const [a, b] of disc(x + lx, y + ly, 0.6)) put(a, b, G, G + 32, MAT.Steel);
    for (let z = G + 8; z <= G + 32; z += 8)
      for (let k = 0; k < 4; k++) {
        const [ax, ay] = legs[k];
        const [bx, by] = legs[(k + 1) % 4];
        for (let t = 0; t <= 1; t += 0.05) for (const [a, b] of disc(x + ax + (bx - ax) * t, y + ay + (by - ay) * t, 0.6)) put(a, b, z, z + 1, MAT.Steel);
      }
    for (const [a, b] of disc(x, y, 4.5)) put(a, b, G + 32, G + 33, MAT.Steel);
  }
  // (solver step 2) the collapse station's shapes
  {
    const A = SHAPES.arch;
    for (let y = A.y0; y < A.y1 + 1; y++) {
      for (let x = A.legs[0]; x < A.legs[1] + 3; x++) put(x, y, G + A.h, G + A.h + A.span, MAT.Stone);
      for (const lx of A.legs) for (let x = lx; x < lx + 3; x++) put(x, y, G, G + A.h, MAT.Stone);
    }
    const D = SHAPES.dome;
    const [dx, dy] = cellPos(D.x, D.y);
    for (const [a, b] of disc(dx, dy, D.r)) {
      const [px, py] = cellPos(a, b);
      const d = Math.hypot(px - dx, py - dy);
      const ri = D.r - D.t;
      const inner = d < ri ? G + Math.sqrt(ri * ri - d * d) : G;
      put(a, b, Math.floor(inner), Math.ceil(G + Math.sqrt(D.r * D.r - d * d)), MAT.Stone);
    }
    const C = SHAPES.cliff;
    for (let y = C.y0; y < C.y1; y++) for (let x = C.x0; x < C.x1; x++) put(x, y, G, G + C.h, MAT.Stone);
    for (const [y0, y1, reach, thick] of C.shelves) for (let y = y0; y < y1; y++) for (let x = C.x1; x < C.x1 + reach; x++) put(x, y, G + C.h - thick, G + C.h, MAT.Stone);
    const S = SHAPES.spire;
    const [sx, sy] = cellPos(S.x, S.y);
    for (const [a, b] of disc(sx, sy, S.r)) put(a, b, G, G + S.h, MAT.Stone);
  }
  const grid = new ColumnGrid(dims);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      // (touching intervals of a material: one)
      let last: Interval | null = null;
      for (const iv of cols[y * w + x]) {
        if (last && last.mat === iv.mat && Math.abs(last.z1 - iv.z0) < 1e-4) {
          last.z1 = iv.z1;
          continue;
        }
        if (last) grid.push(x, y, last.z0, last.z1, last.mat);
        last = { ...iv };
      }
      if (last) grid.push(x, y, last.z0, last.z1, last.mat);
    }
  const surface = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const col = grid.cols[i];
    surface[i] = col[col.length - 1].z1;
  }
  const z = (n: number) => new Float32Array(n);
  const mid: [number, number] = [Math.round(w * 0.55), Math.round(h * 0.5)];
  return {
    grid,
    water: z(N),
    contam: z(N * 2),
    moisture: z(N).fill(0.3),
    vegetation: z(N),
    waterSource: z(N),
    oil: z(N),
    oilStored: z(N * 2),
    drift: z(N),
    driftMat: z(N),
    surface,
    poi: { healthy: mid, dam: mid, pool: mid, tutorial: mid, heap: mid },
  };
}
