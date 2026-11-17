// (tilekit step 2, docs/design/TILEKIT.md §13–§18) A district on the real grid: town lots round an anchor merged into
// plots; alleys cut between some plots; each plot's cells decomposed into grid strips (strips.ts) that become a main
// range, wings, a tower, annexes and yards; the walls of every storey offset in by a setback (a jetty steps upper
// storeys out), merged into runs and laid out in bays (facade.ts); one roof a strip (roof.ts) or step 1's height
// field; corner turrets and chamfers at sharp corners; a bridge room on an arch over an alley. CPU, once a change.

import { centroid, cornerOf, P, walls, type GridMesh, type Panel } from './grid';
import { bays, chamfer, interiorAt, loopsOf, offsetLoop, straighten, type Bay, type LoopPt, type V2 } from './facade';
import { planRoof, roofGrid, sideEdges, slopeIntoWall, type RoofGrid, type RoofParams, type SideClass, type StripSides } from './roof';
import { decompose, patch, stripCells, type Strip } from './strips';
import { controlGrid, hull, roofs as fieldRoofs, storeyH, storeyZ, wtri, wv, type ControlGrid } from './block';
import { MAT } from './kit';
import { packSeg } from './sweep';
import { unionRoofs, worstInside, type Lid, type RoofSolidIn } from './roofunion';
import type { RGB, Theme } from './theme';

const NONE = 0xffffffff;

const hash = (x: number): number => {
  let h = Math.imul((x | 0) ^ 0x9e3779b9, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
};

export type Role = 'main' | 'wing' | 'tower' | 'annex' | 'yard' | 'bridge';

export interface DistrictPlan {
  /** plot a cell (-1 none) */
  plot: Int32Array;
  /** an alley cell (cut from a plot) */
  alley: Uint8Array;
  /** storeys: a cell occupied at s when lo ≤ s < tops */
  tops: Uint8Array;
  lo: Uint8Array;
  strips: Strip[];
  /** each strip's plot and role */
  stripPlot: number[];
  role: Role[];
  /** strip a cell (-1 none) */
  stripOf: Int32Array;
  plots: number;
  /** arches: the alley cell and the edge towards one of its two houses */
  arches: { c: number; k: number }[];
}

export interface DistrictOpts {
  anchor: V2;
  /** lots whose cells' centres lie within this of the anchor */
  radius: number;
  seed: number;
  /** a plot keeps merging neighbouring lots until it has this many cells */
  plotCells: number;
  /** odds an adjacent pair of plots gets an alley between */
  alleyOdds: number;
  /** (step 3) the strips' longest and widest (cells); step 2: 7 × 2 */
  maxA?: number;
  maxB?: number;
  /** (step 3) towers in the whole district at most (step 2: one a plot, no cap) */
  towers?: number;
  /** (step 3) arches at most (step 2: 2); with a traced alley they stand where it meets a road */
  arches?: number;
  /** (step 3) odds a small leftover strip (≤ 2 cells) is a one-storey annex rather than a yard (step 2: 0.25) */
  annexOdds?: number;
  /** (step 3) odds a strip of ≥ 3 cells behind the main range is a wing rather than a yard (step 2: 1) */
  wingOdds?: number;
  /** (step 3) 'lots' (step 2: the town's lots merged into plots) or 'frontage' (plots laid along the streets: a main
   *  range `depth` cells deep and `minA`–`maxA` long fronting a street, the ground behind it its yard and wings) */
  plots?: 'lots' | 'frontage';
  depth?: number;
  minA?: number;
}

/** (step 3) plots along the streets: repeatedly the longest a × b strip (b = depth, else less; a up to a length drawn
 *  between minA and maxA for its seed) whose bottom row fronts a street all along (`front`), over the cells `ok` not
 *  yet taken; then every other cell joins the plot of the nearest main range (through cells, breadth first) */
export function frontagePlots(m: GridMesh, ok: Uint8Array, front: (c: number, k: number) => boolean, seed: number, depth: number, minA: number, maxA: number) {
  const plotOf = new Int32Array(m.nc).fill(-1);
  const mains: Strip[] = [];
  for (;;) {
    let best: Strip | null = null;
    let bestScore = 0;
    for (let c = 0; c < m.nc; c++) {
      if (!ok[c] || plotOf[c] >= 0) continue;
      for (let k = 0; k < 4; k++) {
        if (!front(c, k)) continue;
        const L = minA + Math.floor(hash(c * 7 + k * 3 + seed * 11) * (maxA - minA + 1));
        for (let b = depth; b >= 2; b--) {
          let got: Strip | null = null;
          for (let a = L; a >= 3; a--) {
            const s = patch(m, { c, k }, a, b, (x) => ok[x] === 1 && plotOf[x] < 0);
            if (s && s.at[0].every((f) => front(f.c, f.k))) {
              got = s;
              break;
            }
          }
          if (got) {
            const score = got.a * got.b + 0.5 * got.b;
            if (score > bestScore) {
              bestScore = score;
              best = got;
            }
            break;
          }
        }
      }
    }
    if (!best) break;
    const id = mains.length;
    mains.push(best);
    for (const c of stripCells(best)) plotOf[c] = id;
  }
  // the rest: breadth first from the main ranges
  let frontier: number[] = [];
  for (let c = 0; c < m.nc; c++) if (plotOf[c] >= 0) frontier.push(c);
  while (frontier.length) {
    const next: number[] = [];
    for (const c of frontier) {
      for (let k = 0; k < 4; k++) {
        const x = m.across[c * 4 + k];
        if (x < 0 || !ok[x] || plotOf[x] >= 0) continue;
        plotOf[x] = plotOf[c];
        next.push(x);
      }
    }
    frontier = next;
  }
  return { mains, plotOf };
}

/** a cell of open ground the road plan made (grain.ts): 1 road, 2 plaza, 3 alley */
const openOf = (m: GridMesh, c: number) => (m.open ? m.open[c] : 0);
/** a street for doors and the ground: no lot, a corner in no lot, or a traced road or plaza */
export const isStreet = (m: GridMesh, c: number) => m.lot![c] === NONE || m.cls![c] === 3 || openOf(m, c) === 1 || openOf(m, c) === 2;

/** lots → plots → alleys → strips → storeys */
export function planDistrict(m: GridMesh, t: Theme, o: DistrictOpts): DistrictPlan {
  if (!m.lot || !m.cls) throw new Error('tilekit: the grid has no lots (weldCells keeps them)');
  const lotOf = m.lot;
  const near = new Uint8Array(m.nc);
  const lotCells = new Map<number, number[]>();
  for (let c = 0; c < m.nc; c++) {
    const [x, y] = centroid(m, c);
    if (Math.hypot(x - o.anchor[0], y - o.anchor[1]) > o.radius) continue;
    if (lotOf[c] === NONE || (m.cls[c] !== 1 && m.cls[c] !== 2) || openOf(m, c)) continue;
    near[c] = 1;
    const l = lotOf[c];
    if (!lotCells.has(l)) lotCells.set(l, []);
    lotCells.get(l)!.push(c);
  }
  // lot adjacency through cell edges
  const adj = new Map<number, Set<number>>();
  for (let c = 0; c < m.nc; c++) {
    if (!near[c]) continue;
    for (let k = 0; k < 4; k++) {
      const x = m.across[c * 4 + k];
      if (x < 0 || !near[x] || lotOf[x] === lotOf[c]) continue;
      if (!adj.has(lotOf[c])) adj.set(lotOf[c], new Set());
      adj.get(lotOf[c])!.add(lotOf[x]);
    }
  }
  // plots: lots in a hashed order, each unclaimed one starts a plot and takes neighbours until big enough
  const order = [...lotCells.keys()].sort((a, b) => hash(a * 7 + o.seed) - hash(b * 7 + o.seed));
  const plotOfLot = new Map<number, number>();
  let plots = 0;
  for (const l of order) {
    if (plotOfLot.has(l)) continue;
    const id = plots++;
    plotOfLot.set(l, id);
    let size = lotCells.get(l)!.length;
    const members = [l];
    while (size < o.plotCells) {
      let pick = -1;
      for (const x of members) for (const y of adj.get(x) ?? []) if (!plotOfLot.has(y) && (pick < 0 || y < pick)) pick = y;
      if (pick < 0) break;
      plotOfLot.set(pick, id);
      members.push(pick);
      size += lotCells.get(pick)!.length;
    }
  }
  const plot = new Int32Array(m.nc).fill(-1);
  for (const [l, cs] of lotCells) for (const c of cs) plot[c] = plotOfLot.get(l)!;
  // alleys: for some adjacent pairs, the cells of one plot along the other become an alley
  const alley = new Uint8Array(m.nc);
  // (step 3) the traced alleys of the road plan
  for (let c = 0; c < m.nc; c++) {
    if (openOf(m, c) !== 3) continue;
    const [x, y] = centroid(m, c);
    if (Math.hypot(x - o.anchor[0], y - o.anchor[1]) <= o.radius + 6) alley[c] = 1;
  }
  const pairs = new Set<string>();
  for (let c = 0; c < m.nc; c++) {
    if (plot[c] < 0) continue;
    for (let k = 0; k < 4; k++) {
      const x = m.across[c * 4 + k];
      if (x >= 0 && plot[x] >= 0 && plot[x] !== plot[c]) pairs.add(Math.min(plot[c], plot[x]) + ',' + Math.max(plot[c], plot[x]));
    }
  }
  const size = new Map<number, number>();
  for (let c = 0; c < m.nc; c++) if (plot[c] >= 0) size.set(plot[c], (size.get(plot[c]) ?? 0) + 1);
  for (const pr of [...pairs].sort()) {
    const [a, b] = pr.split(',').map(Number);
    if (hash(a * 131 + b * 17 + o.seed * 3) >= o.alleyOdds) continue;
    // cut from the bigger plot
    const [cut, other] = (size.get(a) ?? 0) >= (size.get(b) ?? 0) ? [a, b] : [b, a];
    const take: number[] = [];
    for (let c = 0; c < m.nc; c++) {
      if (plot[c] !== cut) continue;
      for (let k = 0; k < 4; k++) {
        const x = m.across[c * 4 + k];
        if (x >= 0 && plot[x] === other) {
          take.push(c);
          break;
        }
      }
    }
    if ((size.get(cut) ?? 0) - take.length < 6) continue;
    for (const c of take) {
      plot[c] = -1;
      alley[c] = 1;
    }
    size.set(cut, (size.get(cut) ?? 0) - take.length);
  }
  // (step 3, ?plots=frontage) plots laid along the streets instead of merged lots: each a main range fronting a road,
  // plaza, alley or town street (an a × depth strip whose whole front faces it), then the ground behind it
  let mains: Strip[] | null = null;
  if (o.plots === 'frontage') {
    const ok = new Uint8Array(m.nc);
    for (let c = 0; c < m.nc; c++) ok[c] = plot[c] >= 0 ? 1 : 0;
    const front = (c: number, k: number) => {
      const x = m.across[c * 4 + k];
      return x < 0 || (!ok[x] && (isStreet(m, x) || alley[x] === 1 || openOf(m, x) > 0));
    };
    const fp = frontagePlots(m, ok, front, o.seed, o.depth ?? 3, o.minA ?? 5, o.maxA ?? 10);
    plot.fill(-1);
    for (let c = 0; c < m.nc; c++) if (ok[c]) plot[c] = fp.plotOf[c];
    plots = fp.mains.length;
    mains = fp.mains;
  }
  // strips and roles a plot
  const tops = new Uint8Array(m.nc);
  const lo = new Uint8Array(m.nc);
  const stripOf = new Int32Array(m.nc).fill(-1);
  const strips: Strip[] = [];
  const stripPlot: number[] = [];
  const role: Role[] = [];
  let towers = 0;
  for (let p = 0; p < plots; p++) {
    const cs: number[] = [];
    for (let c = 0; c < m.nc; c++) if (plot[c] === p) cs.push(c);
    if (!cs.length) continue;
    // (bendCost: a strip whose sides bend 40° at an irregular vertex costs ~5 cells — long 1-wide strips that snake
    // round irregular vertices made worm roofs in the first look, DEVLOG)
    let ss: Strip[];
    if (mains) {
      const main = mains[p];
      const inMain = new Set(stripCells(main));
      ss = [main, ...decompose(m, cs.filter((c) => !inMain.has(c)), { maxA: o.maxA ?? 7, maxB: o.maxB ?? 2, bendCost: 0.08 })];
    } else ss = decompose(m, cs, { maxA: o.maxA ?? 7, maxB: o.maxB ?? 2, bendCost: 0.08 });
    const H = t.storeys.lo + Math.floor(hash(p * 97 + o.seed) * (t.storeys.hi - t.storeys.lo + 1));
    let tower = false;
    ss.forEach((s, i) => {
      const n = s.a * s.b;
      const h = hash(p * 1009 + i * 31 + o.seed * 7);
      let r: Role;
      let st: number;
      if (i === 0) {
        r = 'main';
        // (a plot whose biggest strip is one or two cells is a cottage, not a tower)
        st = n <= 2 ? Math.min(H, 2) : H;
      } else if (n <= 2 && !tower && cs.length >= 20 && h < 0.3 && towers < (o.towers ?? Infinity)) {
        r = 'tower';
        st = H + 1 + (h < 0.25 ? 1 : 0);
        tower = true;
        towers++;
      } else if (n >= 3 && h < (o.wingOdds ?? 1)) {
        r = 'wing';
        st = h < 0.2 ? H : Math.max(1, H - 1 - (h > 0.75 ? 1 : 0));
      } else if (h >= (o.annexOdds ?? 0.25)) {
        // (small leftovers mostly stay open: yards and gardens between the masses, so a house reads as range + wing)
        r = 'yard';
        st = 0;
      } else {
        r = 'annex';
        st = 1;
      }
      const id = strips.length;
      strips.push(s);
      stripPlot.push(p);
      role.push(r);
      for (const c of stripCells(s)) {
        tops[c] = st;
        stripOf[c] = id;
      }
    });
  }
  // arches: an alley cell between two houses at least two storeys tall (on two opposite edges) gets a bridge room on
  // its first floor; up to two, by hash
  const arches: { c: number; k: number }[] = [];
  const cand: { c: number; k: number; h: number }[] = [];
  for (let c = 0; c < m.nc; c++) {
    if (!alley[c]) continue;
    for (let k = 0; k < 2; k++) {
      const a = m.across[c * 4 + k];
      const b = m.across[c * 4 + k + 2];
      if (a < 0 || b < 0 || tops[a] < 2 || tops[b] < 2 || lo[a] || lo[b]) continue;
      // (step 3: a traced alley's arch stands as near its mouth as two houses allow — ordered by the distance to the
      // nearest road or plaza cell; the cell right at the mouth often has a yard on one side)
      let h = hash(c * 13 + k + o.seed);
      if (m.open && openOf(m, c) === 3) {
        const [x0, y0] = centroid(m, c);
        let d = Infinity;
        for (let x = 0; x < m.nc; x++) {
          if (openOf(m, x) !== 1 && openOf(m, x) !== 2) continue;
          const [x1, y1] = centroid(m, x);
          d = Math.min(d, Math.hypot(x1 - x0, y1 - y0));
        }
        h = d;
      }
      cand.push({ c, k, h });
    }
  }
  cand.sort((x, y) => x.h - y.h);
  for (const a of cand) {
    if (arches.length >= (o.arches ?? 2)) break;
    // not next to another arch
    if (arches.some((b) => [0, 1, 2, 3].some((k) => m.across[b.c * 4 + k] === a.c))) continue;
    arches.push({ c: a.c, k: a.k });
    tops[a.c] = 2;
    lo[a.c] = 1;
    const id = strips.length;
    strips.push({ a: 1, b: 1, at: [[{ c: a.c, k: (a.k + 1) % 4 }]] });
    stripPlot.push(plot[m.across[a.c * 4 + a.k]]);
    role.push('bridge');
    stripOf[a.c] = id;
  }
  return { plot, alley, tops, lo, strips, stripPlot, role, stripOf, plots, arches };
}

export interface DistrictBuild {
  inst: Map<string, number[]>;
  world: number[];
  /** (step 3) contact-shadow strips (world vertices, multiplied onto the ground) */
  decal: number[];
  /** (step 3) where the roof union cut a roof (for the lab's shots) */
  cuts: [number, number, number][];
  ctl: ControlGrid;
  centre: [number, number];
  height: number;
  stats: Record<string, number | string>;
  /** the worst "slope into a wall" over every strip roof (≤ 0 holds) */
  roofRule: number;
  plan: DistrictPlan;
  /** the corner turrets' centres */
  turrets: [number, number][];
  /** the facades' bays (for tests and the plan view) */
  bays: { bay: Bay; panel: Panel }[];
}

export interface BuildOpts {
  roof: 'strip' | 'field';
  /** 0 walls follow the grid's line, 1 straight from corner to corner */
  straighten: number;
  sag: number;
  wonk: number;
  groundR: number;
  /** override the theme's setback (metres) */
  setback?: number;
  /** (step 3) corner turrets in the whole district at most (step 2: one a plot's main range, no cap) */
  turrets?: number;
  /** (step 3) roofs where strips meet: 'union' (each roof clipped to what is not inside another's solid) or
   *  'overlap' (step 2: drawn whole, overlapping) */
  roofJoin?: 'union' | 'overlap';
  /** (step 3) a contact shadow strip on the ground along every ground-floor wall */
  contact?: boolean;
  /** (step 3) a house's colour nudged by up to this fraction in value (and 0.6 of it in warmth) */
  tintJitter?: number;
  /** (tests) measure the union: stats.unionInside */
  checkUnion?: boolean;
}

/** a joint is a corner feature's (no quoins, no chamfer) when within this of a turret's centre */
const NEAR_TURRET = 0.6;

export function buildDistrict(m: GridMesh, t: Theme, plan: DistrictPlan, o: BuildOpts): DistrictBuild {
  const { tops, lo, plot } = plan;
  const w = walls(m, tops, lo);
  const panels = w.panels;
  const key = (s: number, c: number, k: number) => `${s}:${c}:${k}`;
  const has = new Map<string, number>();
  panels.forEach((p, i) => has.set(key(p.s, p.cell, p.k), i));
  const setback = o.setback ?? t.facade.setback;
  /** a panel's wall line, metres in from its cell edge: the setback, less a jetty a storey of facade below (up to 2) */
  const offsetOf = (i: number): number => {
    const p = panels[i];
    let steps = 0;
    for (let s = p.s; s >= 1 && has.has(key(s - 1, p.cell, p.k)); s--) steps++;
    return setback - t.facade.jetty * Math.min(steps, 2);
  };
  const plotAt = (c: number) => plot[c] >= 0 ? plot[c] : plan.stripOf[c] >= 0 ? plan.stripPlot[plan.stripOf[c]] : -1;
  // (step 3: a house's colour from the theme's palette, nudged a little in value and warmth by `tintJitter`, so
  // neighbours with the same palette entry still read as two houses)
  const tintOf = (p: number): RGB => {
    const c = t.wall.palette[Math.floor(hash(p * 7 + 3) * t.wall.palette.length)];
    const j = o.tintJitter ?? 0;
    if (!j) return c;
    const v = 1 + (hash(p * 31 + 11) - 0.5) * 2 * j;
    const w = (hash(p * 53 + 17) - 0.5) * 2 * j * 0.6;
    return [Math.min(1, c[0] * v * (1 + w)), Math.min(1, c[1] * v), Math.min(1, c[2] * v * (1 - w))];
  };
  const roofCol = (p: number): RGB => t.roof.palette[Math.floor(hash(p * 13 + 5) * t.roof.palette.length)];
  const inst = new Map<string, number[]>();
  const put = (name: string) => {
    let a = inst.get(name);
    if (!a) inst.set(name, (a = []));
    return a;
  };
  const world: number[] = [];
  const st: Record<string, number | string> = { cells: 0, plots: 0, strips: 0, walls: panels.length, runs: 0, bays: 0, windows: 0, doors: 0, blanks: 0, corners: 0, jogs: 0, chamfers: 0, turrets: 0, arches: plan.arches.length };

  // ---- turrets: the sharpest convex ground corner of each house, if sharp enough ----
  const loops = loopsOf(panels);
  const loopPts = new Map<number, LoopPt[]>();
  for (let li = 0; li < loops.length; li++) loopPts.set(li, offsetLoop(m, panels, loops[li], offsetOf, (i) => plotAt(panels[i].cell) * 4 + (panels[i].top ? 1 : 0)));
  const turrets: { p: V2; out: V2; plot: number; top: number; ang: number }[] = [];
  {
    const best = new Map<number, { p: V2; out: V2; ang: number; top: number }>();
    loops.forEach((loop, li) => {
      if (panels[loop[0]].s !== 0) return;
      const pts = loopPts.get(li)!;
      const n = pts.length;
      for (let i = 0; i < n; i++) {
        const q = pts[i];
        if (!q.brk) continue;
        const a = pts[(i + n - 1) % n].p;
        const b = pts[(i + 1) % n].p;
        const ang = interiorAt(a, q.p, b);
        const c = panels[q.seg].cell;
        // (on the main range only: one landmark a house, not one on every annex)
        if (ang >= t.corner.turretBelow || tops[c] < 2 || plan.stripOf[c] < 0 || plan.role[plan.stripOf[c]] !== 'main') continue;
        const pl = plotAt(c);
        const cur = best.get(pl);
        if (cur && cur.ang <= ang) continue;
        const ua = [a[0] - q.p[0], a[1] - q.p[1]];
        const ub = [b[0] - q.p[0], b[1] - q.p[1]];
        const la = Math.hypot(ua[0], ua[1]);
        const lb = Math.hypot(ub[0], ub[1]);
        const ox = -(ua[0] / la + ub[0] / lb);
        const oy = -(ua[1] / la + ub[1] / lb);
        const ol = Math.hypot(ox, oy) || 1;
        best.set(pl, { p: q.p, out: [ox / ol, oy / ol], ang, top: tops[c] });
      }
    });
    for (const [pl, b] of best) turrets.push({ ...b, plot: pl });
    // (step 3, Q8 best guess: a turret is an event, not a pattern — the sharpest few in the whole district)
    turrets.sort((a, b) => a.ang - b.ang);
    if (o.turrets !== undefined) turrets.length = Math.min(turrets.length, o.turrets);
  }
  const nearTurret = (p: V2) => turrets.some((tu) => Math.hypot(p[0] - tu.p[0], p[1] - tu.p[1]) < NEAR_TURRET + t.facade.jetty * 2);

  // ---- facades: loops → runs → bays → module instances ----
  const allBays: { bay: Bay; panel: Panel }[] = [];
  loops.forEach((_, li) => {
    let pts = loopPts.get(li)!;
    st.jogs = (st.jogs as number) + pts.filter((q, i) => q.brk && pts[(i + 1) % pts.length].brk && Math.hypot(q.p[0] - pts[(i + 1) % pts.length].p[0], q.p[1] - pts[(i + 1) % pts.length].p[1]) < t.facade.jetty * 2.5 + 1e-3 && t.facade.jetty > 0).length;
    const before = pts.length;
    if (t.corner.chamferBelow > 0) pts = chamfer(pts, t.corner.chamferBelow, t.corner.chamfer, (p) => !nearTurret(p));
    st.chamfers = (st.chamfers as number) + (pts.length - before);
    pts = straighten(pts, o.straighten);
    const bs = bays(pts, t.facade.bayW);
    st.runs = (st.runs as number) + new Set(bs.map((b) => b.run)).size;
    for (const b of bs) allBays.push({ bay: b, panel: panels[b.seg] });
  });
  // (step 3) contact shadows: a strip 0.75 m out from every ground bay's wall line, mitred like the bay so the strips
  // close round corners; occlusion 0 at the wall, 1 at its outer edge (drawn multiplied onto the ground)
  const decal: number[] = [];
  if (o.contact) {
    const W = 0.75;
    const z = 0.012;
    const dv = (p: V2, ao: number) => decal.push(p[0], p[1], z, 4, 0, 0, 1, ao, 1, 1, 1, MAT.ground);
    for (const { bay, panel } of allBays) {
      if (panel.s !== 0) continue;
      const a2: V2 = [bay.a[0] + bay.ma[0] * W, bay.a[1] + bay.ma[1] * W];
      const b2: V2 = [bay.b[0] + bay.mb[0] * W, bay.b[1] + bay.mb[1] * W];
      dv(bay.a, 0);
      dv(bay.b, 0);
      dv(b2, 1);
      dv(bay.a, 0);
      dv(b2, 1);
      dv(a2, 1);
    }
  }
  // a door a plot: its ground bay facing the street most (a street cell: no lot, or one touching a street; an alley)
  const door = new Map<number, { i: number; score: number }>();
  const minDoor = t.door.w + 2 * t.door.frame + 0.4;
  allBays.forEach(({ bay, panel }, i) => {
    if (panel.s !== 0 || bay.len < minDoor) return;
    const pl = plotAt(panel.cell);
    const x = panel.across;
    const street = x < 0 || isStreet(m, x) ? 2 : plan.alley[x] ? 1.5 : 0;
    const main = plan.stripOf[panel.cell] >= 0 && plan.role[plan.stripOf[panel.cell]] === 'main' ? 1 : 0;
    const score = street + main + (bay.i === Math.floor(bay.n / 2) ? 0.5 : 0) + hash(i) * 0.1;
    const cur = door.get(pl);
    if (!cur || score > cur.score) door.set(pl, { i, score });
  });
  const doors = new Set([...door.values()].map((d) => d.i));
  // (quoins only on real corners — under 125°: a chamfer's two 135° joints and the grid's obtuse bends stay plain; they
  // were the largest share of the district's vertices, DEVLOG. Timber posts frame every bay.)
  const cornerAt = (kind: number, g: boolean, ang: number) => (t.quoins ? kind === 0 && ang < 125 : t.timber !== null && (!g || t.timber.groundToo));
  allBays.forEach(({ bay, panel }, i) => {
    const g = panel.s === 0;
    const tag = g ? 'ground' : 'upper';
    const z0 = storeyZ(t, panel.s);
    const pl = plotAt(panel.cell);
    const tint = tintOf(pl);
    const mx = (bay.a[0] + bay.b[0]) * 0.5;
    const my = (bay.a[1] + bay.b[1]) * 0.5;
    const seed = hash(Math.round(mx * 20) * 7919 + Math.round(my * 20) * 104729 + panel.s * 31);
    const runSeed = hash(pl * 131 + Math.round(bay.runLen * 10) + panel.s * 7);
    const endBlank = bay.n >= 3 && (bay.i === 0 || bay.i === bay.n - 1) && runSeed < t.facade.endBlank;
    let kind: string;
    if (doors.has(i)) {
      kind = 'wall-door';
      st.doors = (st.doors as number) + 1;
    } else if (bay.len >= t.minWindowPanel && !endBlank && seed >= t.blankOdds) {
      kind = `wall-window-${tag}`;
      st.windows = (st.windows as number) + 1;
    } else {
      kind = `wall-blank-${tag}`;
      st.blanks = (st.blanks as number) + 1;
    }
    packSeg(put(kind), bay.a, bay.b, bay.ma, bay.mb, z0, false, tint, seed);
    if (g) packSeg(put('plinth'), bay.a, bay.b, bay.ma, bay.mb, 0, false, tint, seed);
    const top = z0 + storeyH(t, panel.s);
    if (panel.top) packSeg(put('cornice'), bay.a, bay.b, bay.ma, bay.mb, top, false, tint, seed);
    else if (t.band) packSeg(put('band'), bay.a, bay.b, bay.ma, bay.mb, top, false, tint, seed);
    if (cornerAt(bay.kb, g, bay.angB) && !nearTurret(bay.b)) {
      packSeg(put(`corner-${tag}`), bay.a, bay.b, bay.ma, bay.mb, z0, false, tint, seed);
      st.corners = (st.corners as number) + 1;
    }
    if (cornerAt(bay.ka, g, bay.angA) && !nearTurret(bay.a)) {
      packSeg(put(`corner-${tag}-alt`), bay.a, bay.b, bay.ma, bay.mb, z0, true, tint, seed);
      st.corners = (st.corners as number) + 1;
    }
  });
  st.bays = allBays.length;

  // ---- roofs ----
  const cuts: [number, number, number][] = [];
  const R: RoofParams = { pitch: t.roof.pitch, towerPitch: t.roof.towerPitch, overhang: t.roof.overhang, thickness: t.roof.thickness, hip: t.roof.hip, clearance: 0.35 };
  let roofRule = -Infinity;
  const kinds: Record<string, number> = {};
  if (o.roof === 'field') {
    const pid = new Int32Array(m.nc);
    for (let c = 0; c < m.nc; c++) pid[c] = plotAt(c);
    fieldRoofs(m, tops, panels, t, pid, world);
  } else {
    // pass 1: each strip's sides, plan and sampled grid
    const grids: { si: number; sides: StripSides; g: RoofGrid; eave: number }[] = [];
    plan.strips.forEach((s, si) => {
      const c0 = s.at[0][0].c;
      const T = tops[c0];
      if (!T) return;
      const eave = storeyZ(t, T);
      const edges = sideEdges(s);
      const sides: StripSides = { cls: [], off: [], headroom: [], extend: [0, 0, 0, 0] };
      for (const side of edges) {
        const cls: SideClass[] = [];
        const off: number[] = [];
        let head = Infinity;
        for (const [c, k] of side) {
          const x = m.across[c * 4 + k];
          const occ = x >= 0 && tops[x] >= T && lo[x] <= T - 1;
          if (occ && tops[x] > T) {
            cls.push('abut');
            // the taller wall's line at our eave storey (its panel there), on our side of the shared edge
            const kx = cornerOf(m, x, m.cells[c * 4 + ((k + 1) % 4)]);
            const pi = has.get(key(T, x, kx));
            off.push(pi !== undefined ? -offsetOf(pi) : -setback);
            head = Math.min(head, storeyZ(t, tops[x]) - eave);
          } else if (occ) {
            cls.push('join');
            off.push(0);
          } else {
            cls.push('eave');
            const pi = has.get(key(T - 1, c, k));
            off.push(pi !== undefined ? offsetOf(pi) : setback);
          }
        }
        sides.cls.push(cls);
        sides.off.push(off);
        sides.headroom.push(head);
      }
      const pl = planRoof(m, s, sides, R, plan.role[si] === 'tower');
      const g = roofGrid(m, s, sides, pl, R);
      grids.push({ si, sides, g, eave });
      kinds[pl.kind] = (kinds[pl.kind] ?? 0) + 1;
      const rule = slopeIntoWall(g, sides);
      if (rule > 1e-6) st.roofRuleBroken = `${st.roofRuleBroken ?? ''} ${pl.kind}${pl.alongA ? 'A' : 'B'} ${s.a}x${s.b} ${sides.cls.map((c) => c.map((x) => x[0]).join('')).join('|')} ${rule.toFixed(2)};`;
      roofRule = Math.max(roofRule, rule);
    });
    // pass 2: a gable end joined to a crossing roof runs on into it (rise / its pitch, a cell at most)
    const ridgeDir = (g: RoofGrid): V2 => {
      const a = g.p[(g.J >> 1) * (g.I + 1)];
      const b = g.p[(g.J >> 1) * (g.I + 1) + g.I];
      const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      return [(b[0] - a[0]) / l, (b[1] - a[1]) / l];
    };
    const byStrip = new Map(grids.map((x) => [x.si, x]));
    for (const x of grids) {
      const { g, sides } = x;
      if (g.plan.kind !== 'gable' && g.plan.kind !== 'hip') continue;
      const ends = [g.side[(g.J >> 1) * (g.I + 1)], g.side[(g.J >> 1) * (g.I + 1) + g.I]];
      const rise = Math.max(...g.h);
      for (const sd of ends) {
        if (!sides.cls[sd].includes('join') || sides.cls[sd].includes('abut')) continue;
        // the neighbour across this end's first joined edge
        const e = sideEdges(plan.strips[x.si])[sd][sides.cls[sd].indexOf('join')];
        const nb = plan.stripOf[m.across[e[0] * 4 + e[1]]];
        const ny = byStrip.get(nb);
        if (!ny) continue;
        const d1 = ridgeDir(g);
        const d2 = ridgeDir(ny.g);
        if (Math.abs(d1[0] * d2[0] + d1[1] * d2[1]) > 0.8) continue;
        sides.extend[sd] = Math.min(2.7, rise / Math.max(ny.g.plan.pitch, 0.2));
      }
    }
    const union = o.roofJoin === 'union';
    const solids: RoofSolidIn[] = [];
    for (const x of grids) {
      const pl = plan.stripPlot[x.si];
      if (!union) {
        meshRoof(x.g, x.sides, x.eave, R, roofCol(pl), t.roof.fascia, tintOf(pl), world);
        continue;
      }
      const own: number[] = [];
      const lids: Lid[] = [];
      meshRoof(x.g, x.sides, x.eave, R, roofCol(pl), t.roof.fascia, tintOf(pl), own, true, world, lids);
      solids.push({ verts: own, lids });
    }
    if (union) {
      const t0 = performance.now();
      const u = unionRoofs(solids, world);
      st.unionMs = +(performance.now() - t0).toFixed(1);
      st.unionTris = `${u.trisIn} → ${u.trisOut}, ${u.clipped} roofs cut`;
      cuts.push(...u.cuts);
      // (tests: the deepest any kept roof surface lies inside another roof's solid, metres; ≤ ~0 when the union holds)
      if (o.checkUnion) st.unionInside = +worstInside(solids, world, u.ranges).toFixed(5);
    }
  }
  st.roofs = Object.entries(kinds).map(([k, v]) => `${k} ${v}`).join(', ');

  // ---- corner turrets, arches, the ground ----
  for (const tu of turrets) turret(t, tu, world, tintOf(tu.plot), roofCol(tu.plot));
  st.turrets = turrets.length;
  for (const a of plan.arches) arch(m, t, a, setback, world, tintOf(plan.stripPlot[plan.stripOf[a.c]]));
  let cx = 0;
  let cy = 0;
  let n = 0;
  let maxTop = 0;
  for (let c = 0; c < m.nc; c++) {
    if (!tops[c]) continue;
    const [x, y] = centroid(m, c);
    cx += x;
    cy += y;
    n++;
    maxTop = Math.max(maxTop, tops[c]);
  }
  cx /= n;
  cy /= n;
  ground(m, t, plan, [cx, cy], o.groundR, world);
  st.cells = n;
  st.plots = new Set([...plot].filter((p) => p >= 0)).size;
  st.strips = plan.strips.length;
  // the sag's supports: each plot's ground outline's hull corners
  const supports: [number, number][] = [];
  const byPlot = new Map<number, [number, number][]>();
  for (const { bay, panel } of allBays) {
    if (panel.s !== 0) continue;
    const pl = plotAt(panel.cell);
    if (!byPlot.has(pl)) byPlot.set(pl, []);
    byPlot.get(pl)!.push(bay.a);
  }
  for (const pts of byPlot.values()) supports.push(...hull(pts));
  const height = storeyZ(t, maxTop) + t.roof.cap + 2;
  const ctl = controlGrid(m, tops, [cx, cy], height, t, { street: [1, 0], sag: o.sag, wonk: o.wonk, groundR: o.groundR }, supports);
  return { cuts, inst, world, decal, ctl, centre: [cx, cy], height, stats: st, roofRule, plan, bays: allBays, turrets: turrets.map((tu) => [tu.p[0], tu.p[1]]) };
}

type V3 = [number, number, number];

/** a strip roof's mesh: the sampled surface plus an overhang ring (eave sides: the overhang; a joined gable end: its
 *  extension; else none), fascia and soffit under the ring, and the wall filled up to the roof on free sides (gable
 *  ends, a lean-to's ends) */
export function meshRoof(g: RoofGrid, sides: StripSides, eave: number, R: RoofParams, col: RGB, fascia: RGB, wallCol: RGB, out: number[], union = false, fillOut: number[] = out, lids?: Lid[]) {
  const { I, J } = g;
  const idx = (i: number, j: number) => j * (I + 1) + i;
  const sideJ0 = g.side[idx(Math.min(1, I), 0)];
  const sideJJ = g.side[idx(Math.min(1, I), J)];
  const sideI0 = g.side[idx(0, Math.min(1, J))];
  const sideII = g.side[idx(I, Math.min(1, J))];
  // (step 2: one ring a side — the overhang only where the whole side is eave; step 3 with the union: a ring a sample —
  // the overhang wherever an eave is, a joined edge's extension elsewhere, none against a taller wall — the union
  // removes what runs into a neighbour)
  const ringSide = (sd: number) => (sides.cls[sd].every((c) => c === 'eave') ? R.overhang : sides.extend[sd]);
  const ringAt = (sd: number, bi: number, bj: number) => {
    if (!union) return ringSide(sd);
    const e = g.edge[idx(bi, bj)];
    return e === 'eave' ? R.overhang : e === 'join' ? sides.extend[sd] : 0;
  };
  const ci = (i: number) => Math.max(0, Math.min(I, i));
  const cj = (j: number) => Math.max(0, Math.min(J, j));
  const P2 = (i: number, j: number) => g.p[idx(ci(i), cj(j))];
  const H2 = (i: number, j: number) => g.h[idx(ci(i), cj(j))];
  // the outward direction at a boundary sample, across its side
  const outDir = (i: number, j: number, di: number, dj: number): V2 => {
    // tangent along the side
    const ta = di === 0 ? P2(i - 1, j) : P2(i, j - 1);
    const tb = di === 0 ? P2(i + 1, j) : P2(i, j + 1);
    let nx = tb[1] - ta[1];
    let ny = -(tb[0] - ta[0]);
    const l = Math.hypot(nx, ny) || 1;
    nx /= l;
    ny /= l;
    const inner = P2(i - di, j - dj);
    const p = P2(i, j);
    if (nx * (inner[0] - p[0]) + ny * (inner[1] - p[1]) > 0) {
      nx = -nx;
      ny = -ny;
    }
    return [nx, ny];
  };
  const extrap = (i: number, j: number, di: number, dj: number, o: number) => {
    const p = P2(i, j);
    const q = P2(i - di, j - dj);
    const d = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1;
    return H2(i, j) + ((H2(i, j) - H2(i - di, j - dj)) / d) * o;
  };
  // the extended grid, i in −1..I+1, j in −1..J+1
  const W = I + 3;
  const pos: V2[] = [];
  const hgt: number[] = [];
  for (let j = -1; j <= J + 1; j++) {
    for (let i = -1; i <= I + 1; i++) {
      const bi = ci(i);
      const bj = cj(j);
      const p = P2(bi, bj);
      let x = p[0];
      let y = p[1];
      const hs: number[] = [];
      if (j < 0 || j > J) {
        const dj = j < 0 ? -1 : 1;
        const o = ringAt(j < 0 ? sideJ0 : sideJJ, bi, bj);
        const n = outDir(bi, bj, 0, dj);
        x += n[0] * o;
        y += n[1] * o;
        hs.push(extrap(bi, bj, 0, dj, o));
      }
      if (i < 0 || i > I) {
        const di = i < 0 ? -1 : 1;
        const o = ringAt(i < 0 ? sideI0 : sideII, bi, bj);
        const n = outDir(bi, bj, di, 0);
        x += n[0] * o;
        y += n[1] * o;
        hs.push(extrap(bi, bj, di, 0, o));
      }
      pos.push([x, y]);
      hgt.push(hs.length ? Math.min(...hs) : H2(bi, bj));
    }
  }
  const E = (i: number, j: number) => (j + 1) * W + (i + 1);
  const z0 = eave + R.thickness;
  const v3 = (e: number, dz = 0): V3 => [pos[e][0], pos[e][1], z0 + hgt[e] + dz];
  const area = (a: V3, b: V3, c: V3) => Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));
  const tri = (a: V3, b: V3, c: V3, colr: RGB, mat: number, up: boolean) => {
    if (area(a, b, c) < 1e-5) return;
    wtri(out, a, b, c, colr, mat, up);
  };
  const isRing = (i: number, j: number) => i < 0 || j < 0 || i >= I || j >= J;
  for (let j = -1; j <= J; j++) {
    for (let i = -1; i <= I; i++) {
      const a = E(i, j);
      const b = E(i + 1, j);
      const c = E(i + 1, j + 1);
      const d = E(i, j + 1);
      // (a min-of-planes roof is concave: the diagonal whose ends average higher is the closer fit — ridges and hips)
      const diagAC = hgt[a] + hgt[c] >= hgt[b] + hgt[d];
      const q = diagAC ? [[a, b, c], [a, c, d]] : [[b, c, d], [b, d, a]];
      for (const [x, y, z] of q) {
        tri(v3(x), v3(y), v3(z), col, MAT.roof, true);
        // (the union's solid: the house under the roof over its own cells, a slab under the ring)
        if (lids && area(v3(x), v3(y), v3(z)) >= 1e-5) lids.push({ t: [v3(x), v3(y), v3(z)], depth: isRing(i, j) ? R.thickness : Infinity });
      }
      if (isRing(i, j) && (i < 0 || j < 0 || i + 1 > I || j + 1 > J)) {
        // the soffit: the ring's underside
        for (const [x, y, z] of q) {
          const A = v3(x, -R.thickness);
          const B = v3(y, -R.thickness);
          const C = v3(z, -R.thickness);
          if (area(A, B, C) < 1e-5) continue;
          for (const p of [A, C, B]) wv(out, p, [0, 0, -1], [fascia[0] * 0.8, fascia[1] * 0.8, fascia[2] * 0.8], MAT.trim);
        }
      }
    }
  }
  // fascia round the ring's outer edge
  const outer: number[] = [];
  for (let i = -1; i <= I + 1; i++) outer.push(E(i, -1));
  for (let j = 0; j <= J + 1; j++) outer.push(E(I + 1, j));
  for (let i = I; i >= -1; i--) outer.push(E(i, J + 1));
  for (let j = J; j >= 0; j--) outer.push(E(-1, j));
  for (let k = 0; k < outer.length; k++) {
    const a = outer[k];
    const b = outer[(k + 1) % outer.length];
    const A = v3(a);
    const B = v3(b);
    if (Math.hypot(B[0] - A[0], B[1] - A[1]) < 1e-4) continue;
    const A2 = v3(a, -R.thickness);
    const B2 = v3(b, -R.thickness);
    const nx = B[1] - A[1];
    const ny = -(B[0] - A[0]);
    const l = Math.hypot(nx, ny);
    const n: V3 = [nx / l, ny / l, 0];
    for (const p of [A, B, B2, A, B2, A2]) wv(out, p, n, fascia, MAT.trim);
  }
  // the wall up to the roof on free sides (gable ends, a lean-to's ends): from the eave to the roof's underside
  // (step 3 with the union: on joined sides too, set in 2 cm — inside the neighbour's roof it is hidden; where the
  // neighbour's roof is lower it is the step wall between the two, which step 2 left open)
  const fill = (pts: [number, number][], sd: number) => {
    if (!union && !sides.cls[sd].every((c) => c === 'eave')) return;
    for (let k = 0; k + 1 < pts.length; k++) {
      const [ia, ja] = pts[k];
      const [ib, jb] = pts[k + 1];
      const ea = g.edge[idx(ia, ja)];
      const eb = g.edge[idx(ib, jb)];
      if (union && (ea === 'abut' || eb === 'abut')) continue;
      const ha = H2(ia, ja);
      const hb = H2(ib, jb);
      if (ha < 0.02 && hb < 0.02) continue;
      const di = ia === ib ? (ia === 0 ? -1 : 1) : 0;
      const dj = ja === jb ? (ja === 0 ? -1 : 1) : 0;
      const n = outDir(ia, ja, di, dj);
      const inset = union && (ea === 'join' || eb === 'join') ? 0.02 : 0;
      const pa = P2(ia, ja);
      const pb = P2(ib, jb);
      const A: V3 = [pa[0] - n[0] * inset, pa[1] - n[1] * inset, eave];
      const B: V3 = [pb[0] - n[0] * inset, pb[1] - n[1] * inset, eave];
      const C: V3 = [B[0], B[1], eave + hb];
      const D: V3 = [A[0], A[1], eave + ha];
      for (const p of [A, B, C, A, C, D]) wv(fillOut, p, [n[0], n[1], 0], wallCol, MAT.wall);
    }
  };
  const row = (j: number) => Array.from({ length: I + 1 }, (_, i) => [i, j] as [number, number]);
  const col2 = (i: number) => Array.from({ length: J + 1 }, (_, j) => [i, j] as [number, number]);
  fill(row(0), sideJ0);
  fill(row(J), sideJJ);
  fill(col2(0), sideI0);
  fill(col2(I), sideII);
}

/** a corner turret: an n-gon tower on the corner (an oriel from the first floor on a corbel, in a theme that says so),
 *  a band at each floor, slit windows towards the outside, a cone roof */
function turret(t: Theme, tu: { p: V2; out: V2; top: number }, out: number[], tint: RGB, roofCol: RGB) {
  const n = t.corner.turretSides;
  const r = t.corner.turretR;
  const zb = t.corner.oriel ? storeyZ(t, 1) : 0;
  const zt = storeyZ(t, tu.top) + storeyH(t, 1) * 0.55;
  const col: RGB = t.corner.turretCol ?? tint;
  const [cx, cy] = [tu.p[0] + tu.out[0] * r * 0.25, tu.p[1] + tu.out[1] * r * 0.25];
  const ang = (i: number) => (i / n) * Math.PI * 2 + Math.PI / n;
  const at = (i: number, rr: number, z: number): V3 => [cx + Math.cos(ang(i)) * rr, cy + Math.sin(ang(i)) * rr, z];
  const quadOut = (i: number, rr: number, za: number, zb2: number, c: RGB, mat: number) => {
    const a = at(i, rr, za);
    const b = at(i + 1, rr, za);
    const c2 = at(i + 1, rr, zb2);
    const d = at(i, rr, zb2);
    const mid = (ang(i) + ang(i + 1)) / 2;
    const nn: V3 = [Math.cos(mid), Math.sin(mid), 0];
    for (const p of [a, b, c2, a, c2, d]) wv(out, p, nn, c, mat);
  };
  for (let i = 0; i < n; i++) quadOut(i, r, zb, zt, col, MAT.wall);
  // bands at each floor and a cornice under the roof
  for (let s = 1; s <= tu.top; s++) {
    const z = storeyZ(t, s);
    if (z <= zb + 0.05) continue;
    for (let i = 0; i < n; i++) quadOut(i, r + 0.05, z - 0.08, z + 0.06, t.cornice.col, MAT.trim);
  }
  for (let i = 0; i < n; i++) quadOut(i, r + 0.1, zt - 0.22, zt, t.cornice.col, MAT.trim);
  // slit windows on the facets facing out, a storey each
  for (let s = t.corner.oriel ? 1 : 0; s <= tu.top; s++) {
    const zc = storeyZ(t, s) + (s === 0 ? t.groundH : t.storeyH) * 0.55;
    if (zc > zt - 0.6) continue;
    for (let i = 0; i < n; i++) {
      const mid = (ang(i) + ang(i + 1)) / 2;
      if (Math.cos(mid) * tu.out[0] + Math.sin(mid) * tu.out[1] < 0.55) continue;
      const nn: V3 = [Math.cos(mid), Math.sin(mid), 0];
      const tx = -Math.sin(mid);
      const ty = Math.cos(mid);
      const rc = r * Math.cos(Math.PI / n) + 0.012;
      const c0: V3 = [cx + nn[0] * rc, cy + nn[1] * rc, 0];
      const hw = 0.17;
      const hh = 0.5;
      const p = (u: number, v: number): V3 => [c0[0] + tx * u, c0[1] + ty * u, zc + v];
      for (const q of [p(-hw, -hh), p(hw, -hh), p(hw, hh), p(-hw, -hh), p(hw, hh), p(-hw, hh)]) wv(out, q, nn, t.window.glass, MAT.glass);
    }
  }
  // the corbel under an oriel
  if (t.corner.oriel) {
    const tip: V3 = [cx, cy, zb - 1.1];
    for (let i = 0; i < n; i++) wtri(out, at(i + 1, r, zb), at(i, r, zb), tip, t.wall.ground ?? col, MAT.trim, false);
  }
  // the cone roof
  const ro = r + t.roof.overhang * 0.8;
  const zr = zt - t.roof.overhang * 0.8 * t.roof.towerPitch * 0.5;
  const apex: V3 = [cx, cy, zt + r * t.roof.towerPitch * 1.3];
  for (let i = 0; i < n; i++) {
    wtri(out, at(i, ro, zr), at(i + 1, ro, zr), apex, roofCol, MAT.roof, true);
    const c0: V3 = [cx, cy, zr];
    for (const p of [at(i, ro, zr - 0.04), c0, at(i + 1, ro, zr - 0.04)]) wv(out, p, [0, 0, -1], t.roof.fascia, MAT.trim);
  }
}

/** the arch under a bridge room: from the one house's ground wall to the other's, between the bridge room's two wall
 *  lines; its faces from the arch up to the first floor, its intrados */
function arch(m: GridMesh, t: Theme, a: { c: number; k: number }, setback: number, out: number[], col: RGB) {
  const c = a.c;
  const vtx = (k: number): V2 => P(m, m.cells[c * 4 + (k % 4)]);
  const nrm = (k: number): V2 => {
    const p = vtx(k);
    const q = vtx(k + 1);
    const l = Math.hypot(q[0] - p[0], q[1] - p[1]);
    return [(q[1] - p[1]) / l, -(q[0] - p[0]) / l];
  };
  const kA = a.k;
  const kB = a.k + 2;
  const cross = (v: V2, n1: V2, d1: number, n2: V2, d2: number): V2 => {
    const det = n1[0] * n2[1] - n1[1] * n2[0];
    const c1 = v[0] * n1[0] + v[1] * n1[1] - d1;
    const c2 = v[0] * n2[0] + v[1] * n2[1] - d2;
    return [(c1 * n2[1] - c2 * n1[1]) / det, (n1[0] * c2 - n2[0] * c1) / det];
  };
  const zTop = t.groundH;
  const faces = [kA + 1, kB + 1].map((kf) => {
    // face kf runs from corner kf to kf + 1; its ends meet the houses' walls on the edges either side of it
    const nf = nrm(kf);
    const start = cross(vtx(kf), nrm(kf - 1 + 4), -setback, nf, setback);
    const end = cross(vtx(kf + 1), nf, setback, nrm(kf + 1), -setback);
    return { nf, start, end };
  });
  const span = Math.hypot(faces[0].end[0] - faces[0].start[0], faces[0].end[1] - faces[0].start[1]);
  const rise = Math.min(span / 2, zTop - 0.3 - 1.7);
  const zs = zTop - 0.3 - rise;
  const N = 10;
  const arc = (f: { start: V2; end: V2 }, s: number): V3 => {
    const u = s / N;
    return [f.start[0] + (f.end[0] - f.start[0]) * u, f.start[1] + (f.end[1] - f.start[1]) * u, zs + rise * Math.sin(Math.PI * u)];
  };
  for (const f of faces) {
    const n: V3 = [f.nf[0], f.nf[1], 0];
    for (let s = 0; s < N; s++) {
      const a0 = arc(f, s);
      const a1 = arc(f, s + 1);
      const t0: V3 = [a0[0], a0[1], zTop];
      const t1: V3 = [a1[0], a1[1], zTop];
      for (const p of [a0, a1, t1, a0, t1, t0]) wv(out, p, n, col, MAT.wall);
    }
    // a stone band at the floor
    const b0: V3 = [f.start[0] + f.nf[0] * 0.05, f.start[1] + f.nf[1] * 0.05, zTop - 0.12];
    const b1: V3 = [f.end[0] + f.nf[0] * 0.05, f.end[1] + f.nf[1] * 0.05, zTop - 0.12];
    const b2: V3 = [b1[0], b1[1], zTop + 0.06];
    const b3: V3 = [b0[0], b0[1], zTop + 0.06];
    for (const p of [b0, b1, b2, b0, b2, b3]) wv(out, p, n, t.cornice.col, MAT.trim);
  }
  // the intrados between the two faces' arcs (face 0 runs A → B, face 1 B → A)
  for (let s = 0; s < N; s++) {
    const p0 = arc(faces[0], s);
    const p1 = arc(faces[0], s + 1);
    const q0 = arc(faces[1], N - s);
    const q1 = arc(faces[1], N - s - 1);
    const mid: V3 = [(p0[0] + q0[0]) / 2, (p0[1] + q0[1]) / 2, zs];
    // normal towards the arch's axis (down and in)
    const ux = p1[0] - p0[0];
    const uy = p1[1] - p0[1];
    const uz = p1[2] - p0[2];
    const vx = q0[0] - p0[0];
    const vy = q0[1] - p0[1];
    const vz = q0[2] - p0[2];
    let nn: V3 = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
    const l = Math.hypot(...nn) || 1;
    nn = [nn[0] / l, nn[1] / l, nn[2] / l];
    if (nn[0] * (mid[0] - p0[0]) + nn[1] * (mid[1] - p0[1]) + nn[2] * (mid[2] - p0[2]) < 0) nn = [-nn[0], -nn[1], -nn[2]];
    for (const p of [p0, p1, q1, p0, q1, q0]) wv(out, p, nn, [0.86, 0.82, 0.75], MAT.trim);
  }
}

/** the plan view: each cell flat, coloured by its strip (a hue a strip, darker the lower its role), alleys white,
 *  streets dark, unbuilt lot cells grey; each strip's cells inset more so its outline reads */
export function planMesh(m: GridMesh, plan: DistrictPlan, c: V2, R: number): number[] {
  const out: number[] = [];
  const up: V3 = [0, 0, 1];
  for (let i = 0; i < m.nc; i++) {
    const [x, y] = centroid(m, i);
    if (Math.hypot(x - c[0], y - c[1]) > R) continue;
    const s = plan.stripOf[i];
    const q = [0, 1, 2, 3].map((k) => {
      const [px, py] = P(m, m.cells[i * 4 + k]);
      return [px + (x - px) * 0.06, py + (y - py) * 0.06, 0.02] as V3;
    });
    let col: RGB;
    if (s >= 0) {
      const h = hash(s * 977 + 1);
      const r = plan.role[s];
      const k = r === 'main' ? 1 : r === 'tower' ? 0.55 : r === 'wing' ? 0.85 : r === 'yard' ? 0.35 : 0.7;
      col = [(0.35 + 0.65 * hash(s * 3 + 11)) * k, (0.35 + 0.65 * h) * k, (0.35 + 0.65 * hash(s * 5 + 7)) * k];
    } else if (plan.alley[i]) col = [0.95, 0.95, 0.95];
    else if (openOf(m, i) === 2) col = [0.85, 0.6, 0.45];
    else if (openOf(m, i) === 1) col = [0.12, 0.12, 0.14];
    else if (m.lot![i] === NONE || m.cls![i] === 3) col = [0.25, 0.25, 0.28];
    else col = [0.6, 0.6, 0.6];
    for (const p of [q[0], q[1], q[2], q[0], q[2], q[3]]) wv(out, p, up, col, MAT.ground);
  }
  return out;
}

/** the ground: cells near the district, streets darker, alleys paved, yards green, built cells paving */
function ground(m: GridMesh, t: Theme, plan: DistrictPlan, c: [number, number], R: number, out: number[]) {
  const up: V3 = [0, 0, 1];
  for (let i = 0; i < m.nc; i++) {
    const [x, y] = centroid(m, i);
    if (Math.hypot(x - c[0], y - c[1]) > R) continue;
    const street = isStreet(m, i);
    const yard = plan.plot[i] >= 0 && !plan.tops[i];
    const op = openOf(m, i);
    const P3 = (k: number): RGB => [t.ground.paving[0] * k, t.ground.paving[1] * k, t.ground.paving[2] * k];
    let base: RGB;
    let inset = 0.035;
    let jit = 0.1;
    if (m.open) {
      // (step 3: the road plan reads — traced roads a darker cooler cobble, the plaza a light warm stone, alleys paving,
      // the town's own streets as before; lot ground and yards plain (no joints, little jitter): the grid's pattern
      // only where it is paving)
      if (op === 1) base = [t.ground.paving[0] * 0.74, t.ground.paving[1] * 0.75, t.ground.paving[2] * 0.8];
      else if (op === 2) base = [t.ground.paving[0] * 1.16, t.ground.paving[1] * 1.1, t.ground.paving[2] * 1.0];
      else if (op === 3 || plan.alley[i]) base = P3(0.92);
      else if (street) base = P3(0.88);
      else {
        base = yard ? [0.5, 0.57, 0.38] : t.ground.col;
        inset = 0;
        jit = 0.04;
      }
    } else base = street ? P3(0.88) : yard ? [0.52, 0.58, 0.4] : plan.alley[i] ? t.ground.paving : t.ground.col;
    const q = [0, 1, 2, 3].map((k) => {
      const [px, py] = P(m, m.cells[i * 4 + k]);
      return [px + (x - px) * inset, py + (y - py) * inset, 0] as V3;
    });
    const j = 1 - jit * 0.6 + hash(i * 3 + 1) * jit;
    const col: RGB = [base[0] * j, base[1] * j, base[2] * j];
    for (const p of [q[0], q[1], q[2], q[0], q[2], q[3]]) wv(out, p, up, col, MAT.ground);
  }
  const z = -0.025;
  const b = [
    [c[0] - R - 6, c[1] - R - 6, z],
    [c[0] + R + 6, c[1] - R - 6, z],
    [c[0] + R + 6, c[1] + R + 6, z],
    [c[0] - R - 6, c[1] + R + 6, z],
  ] as V3[];
  for (const p of [b[0], b[1], b[2], b[0], b[2], b[3]]) wv(out, p, up, t.ground.paving, MAT.ground);
}
