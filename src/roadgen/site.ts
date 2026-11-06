// The road generator on a town's site (round 128p, DA-A13 step 0): what a run is given from a site (its land, its
// water, its roads out as constraints) and the site the run makes — the base lattice as the town's grid, the traced
// roads as its layout's roads (drawn by kind: DECISIONS round 128p), and, to judge the look (the human pass), a
// stand-in for step 1's tiles: a house on three in four open cells facing a road (one or two storeys), the cells
// behind left open. Pure (no GPU).
import { TownSite } from '../build/site';
import { typeIndex } from '../build/plan';
import { QuadGrid } from '../build/quadgrid';
import { ROW_H } from '../world/lattice';
import type { LinearFeature } from '../api/contracts/structures';
import { latticeSize, ROADGEN_STYLE, ROAD_GRADE, type Polyline, type RoadGenInput, type RoadGenParams, type V2 } from './roadgen';
import { blocksOf, hash3, isRoad, latticeMesh, latticePoint } from './lattice';
import type { RoadGenResult } from './gpu';

/** a road's drawn width by kind (DECISIONS round 128p: a lane ~2 m, a road 2.6 m, a main road the whole cell) */
export const DRAWN_WIDTH = { main: 4, road: 2.6, lane: 2 } as const;

/**
 * A run's input from a site: its domain the box (box-local metres), the town's middle and edge, the grid turned to the
 * land's mean contour (the contour tensor summed over the town: the grid runs along the hill), the ground per field node
 * (the site's ground: the land before the town), the water (`wet`, box-local), its roads out as constraints.
 */
export function inputOfSite(site: TownSite, o: { centre: V2; radius: number; wet: (x: number, y: number) => boolean; seed?: number; style?: Partial<typeof ROADGEN_STYLE> }): RoadGenInput {
  const W = site.box.w - 1;
  const H = (site.box.h - 1) * ROW_H;
  const style = { ...ROADGEN_STYLE, ...o.style };
  const base: RoadGenParams = { ...style, W, H, centre: o.centre, radius: o.radius, theta: 0, seed: o.seed ?? site.seed };
  const { nx, ny } = latticeSize(base);
  const ground = new Float32Array(nx * ny);
  const wet = new Uint8Array(nx * ny);
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      ground[j * nx + i] = site.groundAt(i * base.S, j * base.S);
      wet[j * nx + i] = o.wet(i * base.S, j * base.S) ? 1 : 0;
    }
  // the grid along the land: the mean contour direction over the town (a flat town: the box's axes)
  let a = 0;
  let b = 0;
  for (let j = 1; j < ny - 1; j++)
    for (let i = 1; i < nx - 1; i++) {
      if (Math.hypot(i * base.S - o.centre[0], j * base.S - o.centre[1]) > o.radius) continue;
      const gx = (ground[j * nx + i + 1] - ground[j * nx + i - 1]) / (2 * base.S);
      const gy = (ground[(j + 1) * nx + i] - ground[(j - 1) * nx + i]) / (2 * base.S);
      a -= gx * gx - gy * gy;
      b -= 2 * gx * gy;
    }
  const theta = a === 0 && b === 0 ? 0 : 0.5 * Math.atan2(b, a);
  const constraints: Polyline[] = site.plan.layout.linear.filter((f) => f.kind === 'road').map((f) => f.points.map((q) => [q[0], q[1]] as V2));
  return { params: { ...base, theta }, ground, wet, constraints };
}

/** per point of a road: the step into it climbs more than a road may (stairs in town, step 1) */
export function steepOf(p: RoadGenParams, ground: (x: number, y: number) => number, pts: V2[]): boolean[] {
  return pts.map((q, k) => {
    if (!k) return false;
    const L = Math.hypot(q[0] - pts[k - 1][0], q[1] - pts[k - 1][1]);
    return L > 0 && Math.abs(ground(q[0], q[1]) - ground(pts[k - 1][0], pts[k - 1][1])) / L > ROAD_GRADE;
  });
}

export interface RoadSiteStats {
  roads: { major: number; minor: number; fixed: number };
  /** metres of road, and of it the steep (stairs to be) */
  length: number;
  steep: number;
  cells: { road: number; open: number; off: number; water: number };
  blocks: number;
  houses: number;
  /** ms: the CPU's part after the readback (the mesh, the grid's columns, the plan); of it the grid's columns */
  cpuMs: number;
  columnsMs: number;
}

/**
 * The site a run makes: the template's id, box and ground; its grid the base lattice (the cells in the box and the
 * town); its roads the run's, drawn by kind; a house on each open cell facing a road (one or two storeys), the cells
 * behind open — a stand-in for step 1's tiles, to judge the look.
 */
export function siteOfRoads(tpl: TownSite, inp: RoadGenInput, res: RoadGenResult): { site: TownSite; stats: RoadSiteStats; houseCells: Set<number>; latticeQuad: Int32Array } {
  const t0 = performance.now();
  const p = inp.params;
  const n = res.latN;
  const { box } = tpl;
  const W = box.w - 1;
  const H = (box.h - 1) * ROW_H;
  const keep = (i: number, j: number) => {
    if (res.claims[j * n + i] >= 3) return false;
    for (const [u, v] of [
      [i, j],
      [i + 1, j],
      [i, j + 1],
      [i + 1, j + 1],
    ]) {
      const q = latticePoint(p, n, u, v);
      if (q[0] < 1 || q[1] < 1 || q[0] > W - 1 || q[1] > H - 1) return false;
    }
    return true;
  };
  const mesh = latticeMesh(p, n, res.offsets, keep);
  const t1 = performance.now();
  // (the columns each cell holds: QuadGrid's point-in-quad pass — the CPU's; the GPU's is latticeCellAt's math)
  const grid = new QuadGrid(box.w, box.h, mesh.verts, mesh.quads);
  const t2 = performance.now();
  const site = new TownSite(tpl.id, tpl.seed, box, grid, tpl.plan.style, tpl.groundCols);
  const ground = (x: number, y: number) => site.groundAt(x, y);
  // the roads, drawn by kind (a point every 4 m: the spline runs through them)
  const linear: LinearFeature[] = [];
  let length = 0;
  let steep = 0;
  for (const r of res.roads) {
    const st = steepOf(p, ground, r.pts);
    r.pts.forEach((q, k) => {
      if (!k) return;
      const L = Math.hypot(q[0] - r.pts[k - 1][0], q[1] - r.pts[k - 1][1]);
      length += L;
      if (st[k]) steep += L;
    });
    const pts = r.pts.filter((_, k) => k % 4 === 0 || k === r.pts.length - 1);
    if (pts.length < 2) continue;
    linear.push({ kind: 'road', points: pts.map((q) => [q[0], q[1], ground(q[0], q[1]) + 0.15]), ground: pts.map((q) => ground(q[0], q[1])), width: r.fixed ? DRAWN_WIDTH.main : r.family === 0 ? DRAWN_WIDTH.road : DRAWN_WIDTH.lane });
  }
  site.plan.layout.linear = linear;
  // the stand-in tiles: a house on each open cell facing a road
  let houses = 0;
  const houseCells = new Set<number>();
  const cells = { road: 0, open: 0, off: 0, water: 0 };
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const k = res.claims[j * n + i];
      if (k === 3) cells.off++;
      else if (k === 4) cells.water++;
      else if (isRoad(k)) cells.road++;
      else cells.open++;
      const c = mesh.cell[j * n + i];
      if (c < 0 || k !== 0) continue;
      const faces = [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ].some(([di, dj]) => {
        const ii = i + di;
        const jj = j + dj;
        return ii >= 0 && jj >= 0 && ii < n && jj < n && isRoad(res.claims[jj * n + ii]);
      });
      // (a yard in four: the plots read as plots)
      if (!faces || hash3(i, j, p.seed + 11) % 4 === 0) continue;
      const levels = 1 + (hash3(i, j, p.seed + 7) % 2);
      const s = site.plan.place('house', Array.from({ length: levels }, (_, L) => [c, L] as [number, number]));
      if (!s) continue;
      for (const L of site.plan.levels.each(c)) site.town.add(c, L, s.id, typeIndex('house'));
      houses++;
      houseCells.add(j * n + i);
    }
  site.plan.takeChanged();
  const blocks = blocksOf(res.claims, n).count;
  const fam = (f: number, fixed: boolean) => res.roads.filter((r) => r.family === f && !!r.fixed === fixed).length;
  return { site, houseCells, latticeQuad: mesh.cell, stats: { roads: { major: fam(0, false), minor: fam(1, false), fixed: res.roads.filter((r) => r.fixed).length }, length, steep, cells, blocks, houses, cpuMs: performance.now() - t0, columnsMs: +(t2 - t1).toFixed(2) } };
}
