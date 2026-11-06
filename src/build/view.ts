// A town drawn (round 128m, onetown; was the fortress's, fortress slice 1, milestone 1): its one plan (plan.ts) made
// into the towns' pieces — the structures module library (structures/pieces.ts piecesOf), the same Townscaper-in-spirit
// rules for every town, generated or the player's. In the atlas world the towns are pieces on the ground
// (settle/view.ts), not column matter: matter there is drawn by the heightfield, where a room, a crenel or an arch
// can't read.
//
// The plan becomes one CityPlan (townCity: what piecesOf, the far land's raster, the settlements' doors and Inspect
// read): the grid's quads are the tiles, each cell's layout use (a street, the plaza, a yard, the quay) what a cell no
// structure holds is drawn as; a block structure's cells are lots, its buildings (one a structure and floor, or one a
// cell for a type that doesn't join) with a façade on every storey's side no block covers (chosen by WFC, the front door
// toward the street or where the ways put it); walls are thin walls by rules (ramparts, merlons on the sides that meet
// no wall, a gate's arch across a run) with a tower where a run turns, ends or meets another; farms, orchards and
// pastures their crops, trees and grass, fenced or hedged round; landmarks drawn whole (a tower, a domed temple, a
// fountain, a lighthouse, a headframe, a windmill); the layout's roads out, piers, props and moored ships; the dressing
// (lamps, torches, banners) and its lights. What piecesOf has no rule for (thin walls, the keep, stairs, ramps,
// chimneys on a type's top block, scaffolding) is `extra`.
import type { StructurePieces, BuildingRec, CityPlan, Facade, FacadeKind, LinearFeature, MegaFeature, Prop, Span, TileMesh, TileUse, V2, StructureStyleId } from '../api/contracts/structures';
import type { StructureDef, StructureType } from '../api/contracts/fortress';
import { LEVEL_H } from './town';
import type { TownSite } from './site';

/** What the view reads of a town (TownSite's): its plan, what stands, its grid, its seed, its growth order, what the world placed. */
export type ViewSite = Pick<TownSite, 'plan' | 'town' | 'grid' | 'seed' | 'order' | 'placed'>;
import { PROP_SIZE } from '../structures/dressmodules';
import { library } from '../structures/modules';
import { DRAPE, DRAPE_ANY, PIECE_FLOATS, piecesOf, REL, WALL_T } from '../structures/pieces';
import { hashf } from '../structures/rng';
import { STYLE_IDS, styleOf } from '../structures/styles';
import { adjacency, quadCorners } from '../structures/tiles/builder';
import { solve, type WfcProblem } from '../structures/wfc';
import { dressing } from '../structures/purpose';
import { DEFS } from './types';
import { towered } from './plan';
import { shapesOf, type Shapes } from './shapes';
import { rampShape, STAIR_HALF, WALL_HALF, WALL_LINTEL } from './solid';
import { alongAxis, axisLength, groundSteps, WAY_SQUARE, waysOf, type Ways } from './ways';
import { pathsViewOf, type EdgeNet, type PathsView } from './edgenet';
import { curvePieces, insetTiles, pathPaving } from './edgeview';
import { LANE_DRAWN, LANE_WIDTH, type Lanes } from './lanes';

/**
 * (round 128d) look bit 23: a block planned, not built yet. (round 128e, FT-51) While building its pieces aren't drawn:
 * a plot outline on the ground stands for it until work starts, scaffolding once it has (plotsOf). The bit only marks
 * them to drop (structgame.wgsl still draws it see-through, should one reach the GPU).
 */
export const LOOK_GHOST = 1 << 23;
/** (onetown) a structure's look bit: its plot hedged round, not fenced (structures/place.ts sets it) */
const LOOK_HEDGE = 1 << 19;
/** (round 128e, FT-51) the outline's stakes and rails over the ground (m), and how far scaffolding stands off a block */
const PLOT_H = 0.9;
const SCAFFOLD_OFF = 0.35;
/** (round 128d) flags bit 6: the structure Inspect picked — drawn highlighted (structmesh.wgsl sets look bit 24 from it,
 *  structgame.wgsl tints it). A flag, not a look bit: the look travels as a float, exact only to 24 bits */
export const PIECE_PICKED = 64;
/** (round 128h, V128-13) flags bit 7: a warning outline — drawn red (structmesh.wgsl sets look bit 25 from it, structgame.wgsl
 *  tints it): the cells a placement cut off from the stores */
export const PIECE_WARN = 128;
/** (round 128h) the warning outline's rails over the ground (m) */
const WARN_H = 1.4;
/** (onetown) a landmark's half width (m), as the generator stood them (structures/purpose.ts) */
const MEGA_HALF = { lighthouse: 2.2, headframe: 2.4, windmill: 2.3, fountain: 2.2 } as const;

export interface ViewInputs {
  /** the ground's top at a box-local point (the plan's z) */
  ground(x: number, y: number): number;
  /** added to every height (the plan's z → the z the pieces are drawn in; default 0) */
  zOff?: number;
  defs?: Record<StructureType, StructureDef>;
  /**
   * Whether a block is still to build: its pieces aren't drawn (a plot outline or scaffolding stands for it). Absent:
   * the plan is drawn whole (planning: the user, "No planned blocks can look complete before being built" / "I don't
   * mind that as long as we are clearly in planning mode").
   */
  ghost?: (cell: number, level: number) => boolean;
  /** (round 128e, FT-51) whether work on a block still to build has begun (something brought to it): scaffolding */
  started?: (cell: number, level: number) => boolean;
  /** (round 128d) the structure Inspect picked (its pieces drawn highlighted) */
  picked?: number | null;
  /** (round 128d) the plan's ways (ways.ts): squares paved, doors where they open, stairs onto the walls */
  ways?: Ways;
  /** (round 128f) the lanes and the main roads a lane wide (lanes.ts) */
  lanes?: Lanes;
  /** (round 128h, V128-13) cells a placement cut off from the stores: outlined in red */
  warn?: readonly number[];
  /** (round 128l, m4: the attack wave) the gates are shut: a gate's passage drawn closed */
  shut?: boolean;
  /** (round 128p, DA-A13 step 1) the paths on the grid's edges (build/edgenet.ts): the buildings inset from them, the
   *  drawn ones paved, the main roads' curves drawn (build/edgeview.ts); `wet` where a curve is a bridge */
  edges?: EdgeNet;
  wet?: (x: number, y: number) => boolean;
}

/** a stair's step along its axis (metres) */
const STEP_LEN = 0.6;

/** The town's pieces (x, y box-local world units; z the plan's + zOff). */
export function townPieces(site: ViewSite, inp: ViewInputs): StructurePieces {
  const { city, extra } = townView(site, inp);
  let p = piecesOf(city);
  let ex = extra;
  ripen(p);
  if (inp.ghost) {
    ghostOver(p, site, inp, city);
    // (round 128e, FT-51: the user, "The temporary holder would be better as a loose plot outline or scaffolding") what
    // isn't built yet isn't drawn: its plot or its scaffolding is (below)
    p = unbuiltOut(p, site, inp);
    ex = unbuiltOut(ex, site, inp);
  }
  if (inp.picked != null) {
    pickOver(p, site, inp);
    pickOver(ex, site, inp);
  }
  const parts = [p, ex];
  if (inp.ghost) parts.push(plotsOf(site, inp));
  // (round 128p: a town with its roads laid draws its paths, not the lanes)
  if (inp.lanes && !inp.edges && !site.plan.layout.roads) parts.push(lanePieces(site, inp, inp.lanes));
  parts.push(rampPieces(site, inp));
  if (inp.warn?.length) parts.push(warnPieces(site, inp, inp.warn));
  return concat(parts);
}

/** The town as a CityPlan (box-local; heights the plan's + zOff): what's drawn, the doors, the far raster's tops. */
export function townCity(site: ViewSite, inp: ViewInputs): CityPlan {
  return townView(site, inp).city;
}

/**
 * (round 128h, V128-13) The ramps (TownPlan.ramp) as the wall stairs' steps: stone treads across the cell from the
 * drop's top at its high side down to its far side, at the heights solid.ts claims (rampShape) — earthworks, never ghosts.
 */
export function rampPieces(site: ViewSite, inp: ViewInputs): StructurePieces {
  const { plan, grid } = site;
  const zOff = inp.zOff ?? 0;
  const lib = library();
  const extra = new Extra();
  for (const c of plan.ramps()) {
    const side = plan.ramp[c];
    const r = rampShape(grid, c, side, inp.ground);
    const [hi, lo] = r.axis;
    const a0 = grid.corner(c, side);
    const a1 = grid.corner(c, side + 1);
    const half = Math.hypot(a1[0] - a0[0], a1[1] - a0[1]) * 0.42;
    const len = Math.hypot(lo[0] - hi[0], lo[1] - hi[1]) || 1;
    const d: V2 = [(lo[0] - hi[0]) / len, (lo[1] - hi[1]) / len];
    const nrm: V2 = [-d[1] * half, d[0] * half];
    const n = Math.max(1, Math.ceil(len / STEP_LEN));
    const look = Math.floor(hashf(c, 37) * 4096);
    for (let i = 0; i < n; i++) {
      const t0 = (len * i) / n;
      const t1 = (len * (i + 1)) / n;
      const p0: V2 = [hi[0] + d[0] * t0, hi[1] + d[1] * t0];
      const p1: V2 = [hi[0] + d[0] * t1, hi[1] + d[1] * t1];
      const fr: [V2, V2, V2, V2] = [
        [p0[0] - nrm[0], p0[1] - nrm[1]],
        [p1[0] - nrm[0], p1[1] - nrm[1]],
        [p1[0] + nrm[0], p1[1] + nrm[1]],
        [p0[0] + nrm[0], p0[1] + nrm[1]],
      ];
      // (each tread at the slope's height at its near edge, as the solid's columns there)
      const z = r.top + ((r.foot - r.top) * t0) / len + zOff;
      const g = Math.min(inp.ground(p0[0], p0[1]), inp.ground(p1[0], p1[1])) + zOff;
      if (z < g + 0.15) continue;
      extra.add(lib.id('rampart'), fr, g - 0.4, z, look);
    }
  }
  return extra.done();
}

/**
 * (round 128h, V128-13) a red rail round each cell a placement cut off from the stores: round its eaves (what's walled in
 * is seen over the walls), or draped on the ground where nothing is planned on it
 */
export function warnPieces(site: ViewSite, inp: ViewInputs, cells: readonly number[]): StructurePieces {
  const { grid, plan, town } = site;
  const zOff = inp.zOff ?? 0;
  const fence = library().id('fence');
  const extra = new Extra();
  for (const c of cells) {
    const p: V2[] = [0, 1, 2, 3].map((k) => grid.corner(c, k));
    const top = plan.top(c);
    if (top >= 0) {
      const z = town.floorZ(c, top) + LEVEL_H + zOff;
      // (pushed out a little from the middle: round the walls' faces, not in them)
      const [mx, my] = grid.centre(c);
      const q: V2[] = p.map(([x, y]) => {
        const d = Math.hypot(x - mx, y - my) || 1;
        return [x + ((x - mx) / d) * 0.3, y + ((y - my) / d) * 0.3];
      });
      for (let e = 0; e < 4; e++) extra.add(fence, band(q[e], q[(e + 1) % 4], 0.16), z - 0.3, z + WARN_H, 0, PIECE_WARN);
      continue;
    }
    for (let e = 0; e < 4; e++) {
      const a = p[e];
      const b = p[(e + 1) % 4];
      const ga = inp.ground(a[0], a[1]) + zOff - 0.1;
      const gb = inp.ground(b[0], b[1]) + zOff - 0.1;
      extra.add(fence, band(a, b, 0.14), [ga, gb, gb, ga], WARN_H, 0, REL | DRAPE | DRAPE_ANY | PIECE_WARN);
    }
  }
  return extra.done();
}

/**
 * (round 128e, FT-51) The pieces without those of blocks still to build (marked LOOK_GHOST), and without the things set
 * down (props) on cells where nothing stands yet.
 */
function unbuiltOut(p: StructurePieces, site: ViewSite, _inp: ViewInputs): StructurePieces {
  const keep: number[] = [];
  const d = p.data;
  for (let i = 0; i < p.count; i++) {
    const o = i * PIECE_FLOATS;
    if ((d[o + 13] | 0) & LOOK_GHOST) continue;
    if ((d[o + 15] | 0) & 2) {
      const c = site.grid.cellAtWorld((d[o] + d[o + 2] + d[o + 4] + d[o + 6]) / 4, (d[o + 1] + d[o + 3] + d[o + 5] + d[o + 7]) / 4);
      if (c >= 0 && site.plan.levels.any(c) && !site.town.built.any(c)) continue;
    }
    keep.push(i);
  }
  const out: StructurePieces = { module: new Uint16Array(keep.length), data: new Float32Array(keep.length * PIECE_FLOATS), building: new Int32Array(keep.length), count: keep.length };
  keep.forEach((i, k) => {
    out.module[k] = p.module[i];
    out.data.set(d.subarray(i * PIECE_FLOATS, (i + 1) * PIECE_FLOATS), k * PIECE_FLOATS);
    out.building[k] = p.building[i];
  });
  return out;
}

/**
 * (round 128e, FT-51) Blocks still to build, while building: a loose plot outline — low stakes and rails round the cell,
 * on the ground — where nothing of the cell stands or has begun; scaffolding — poles and rails a storey high, a little
 * off each side — round each block work has begun on.
 */
export function plotsOf(site: ViewSite, inp: ViewInputs): StructurePieces {
  const { plan, town, grid } = site;
  const zOff = inp.zOff ?? 0;
  const defs = inp.defs ?? DEFS;
  const lib = library();
  const fence = lib.id('fence');
  const extra = new Extra();
  for (const s of plan.structures()) {
    const look = Math.floor(hashf(s.id, 31) * 4096);
    for (const c of s.cells.keys()) {
      const todo = [...plan.levels.each(c)].filter((L) => inp.ghost!(c, L));
      if (!todo.length) continue;
      const begun = todo.filter((L) => inp.started?.(c, L) ?? false);
      const p: V2[] = [0, 1, 2, 3].map((k) => grid.corner(c, k));
      const [mx, my] = grid.centre(c);
      if (!begun.length && !town.built.any(c)) {
        // (the plot: draped on the ground, its top a height over it)
        for (let e = 0; e < 4; e++) {
          const a = p[e];
          const b = p[(e + 1) % 4];
          const ga = inp.ground(a[0], a[1]) + zOff - 0.1;
          const gb = inp.ground(b[0], b[1]) + zOff - 0.1;
          extra.add(fence, band(a, b, 0.06), [ga, gb, gb, ga], PLOT_H, look, REL | DRAPE | DRAPE_ANY);
        }
        continue;
      }
      // (scaffolding: each side pushed out from the middle, a storey of poles and rails)
      const out: V2[] = p.map(([x, y]) => {
        const d = Math.hypot(x - mx, y - my) || 1;
        return [x + ((x - mx) / d) * SCAFFOLD_OFF, y + ((y - my) / d) * SCAFFOLD_OFF];
      });
      const yard = defs[s.type].form === 'yard';
      for (const L of begun) {
        const z0 = town.floorZ(c, L) + zOff;
        for (let e = 0; e < 4; e++) extra.add(fence, band(out[e], out[(e + 1) % 4], 0.08), z0, z0 + (yard ? PLOT_H * 2 : LEVEL_H), look);
      }
    }
  }
  return extra.done();
}

/** a lane's step (m) where a climbing lane is steep */
const LANE_STEP = 0.7;

/**
 * (round 128f) The lanes and the main roads (lanes.ts) as paving a lane wide, draped on the ground: each piece a band
 * along its segment, a little past its ends so the bends close; a steep climbing lane gets a step's edge across it every
 * LANE_STEP. A road's way over a square isn't drawn (the square is paved whole).
 */
export function lanePieces(site: ViewSite, inp: ViewInputs, lanes: Lanes): StructurePieces {
  const lib = library();
  const pave = lib.id('pave');
  // (round 128i) the tracks out in the fields trodden earth, not paving: brown on the grass reads at play zoom
  const earth = lib.id('earth');
  const kerb = lib.id('kerb');
  const extra = new Extra();
  const zOff = inp.zOff ?? 0;
  const z = (p: V2) => inp.ground(p[0], p[1]) + zOff;
  // (round 128k) the thoroughfare tiles paved whole: gates, the cells either side, the big buildings' door cells
  for (const c of lanes.tiles) {
    if (inp.ways?.way[c] === WAY_SQUARE) continue;
    const q = [0, 1, 2, 3].map((k) => site.grid.corner(c, k)) as [V2, V2, V2, V2];
    const look = Math.floor(hashf(c, 61) * 4096);
    extra.add(pave, q, q.map((p) => z(p) - 0.25) as [number, number, number, number], 0.38, look, REL | DRAPE | DRAPE_ANY);
  }
  for (const s of lanes.segs) {
    const w = LANE_WIDTH[s.kind];
    if (!LANE_DRAWN[s.kind] || w <= 0) continue;
    const dx = s.b[0] - s.a[0];
    const dy = s.b[1] - s.a[1];
    const l = Math.hypot(dx, dy) || 1;
    const ext = w * 0.35;
    const a: V2 = [s.a[0] - (dx / l) * ext, s.a[1] - (dy / l) * ext];
    const b: V2 = [s.b[0] + (dx / l) * ext, s.b[1] + (dy / l) * ext];
    const fr = band(a, b, w / 2);
    const look = Math.floor(hashf(s.kind === 'track' ? 7 : 3, 61) * 4096);
    // (a road a hair over a lane where they cross: no fighting surfaces)
    const top = s.kind === 'road' ? 0.4 : s.kind === 'track' ? 0.3 : 0.36;
    extra.add(s.kind === 'track' ? earth : pave, fr, fr.map((p) => z(p) - 0.25) as [number, number, number, number], top, look, REL | DRAPE | DRAPE_ANY);
    if (s.steps) {
      const n = Math.floor(l / LANE_STEP);
      for (let i = 1; i < n; i++) {
        const t = i / n;
        const m: V2 = [s.a[0] + dx * t, s.a[1] + dy * t];
        const nx = (-dy / l) * (w / 2);
        const ny = (dx / l) * (w / 2);
        const p: V2 = [m[0] - nx, m[1] - ny];
        const q: V2 = [m[0] + nx, m[1] + ny];
        const f2 = band(p, q, 0.12);
        extra.add(kerb, f2, f2.map((r) => z(r) - 0.2) as [number, number, number, number], 0.5, look, REL | DRAPE | DRAPE_ANY);
      }
    }
  }
  return extra.done();
}

/** The towers on wall tiles that don't simply carry a run on, and the chimneys: pieces the CityPlan has no rule for. */
class Extra {
  module: number[] = [];
  data: number[] = [];
  add(mod: number, f: [V2, V2, V2, V2], foot: number | [number, number, number, number], top: number, look: number, flags = 0): void {
    const z = typeof foot === 'number' ? [foot, foot, foot, foot] : foot;
    this.module.push(mod);
    this.data.push(f[0][0], f[0][1], f[1][0], f[1][1], f[2][0], f[2][1], f[3][0], f[3][1], z[0], z[1], z[2], z[3], top, look, 0, flags);
  }
  done(): StructurePieces {
    return { module: Uint16Array.from(this.module), data: Float32Array.from(this.data), building: new Int32Array(this.module.length).fill(-1), count: this.module.length };
  }
}

function concat(parts: StructurePieces[]): StructurePieces {
  let n = 0;
  for (const p of parts) n += p.count;
  const out: StructurePieces = { module: new Uint16Array(n), data: new Float32Array(n * PIECE_FLOATS), building: new Int32Array(n), count: n };
  let k = 0;
  for (const p of parts) {
    out.module.set(p.module, k);
    out.data.set(p.data, k * PIECE_FLOATS);
    out.building.set(p.building, k);
    k += p.count;
  }
  return out;
}

/**
 * The towns' pieces of blocks still to build marked see-through: a piece's block is the cell under its middle and the
 * level at its middle height (a roof: its cell's top block).
 */
function ghostOver(p: StructurePieces, site: ViewSite, inp: ViewInputs, cp?: CityPlan): void {
  const { plan, town, grid } = site;
  const zOff = inp.zOff ?? 0;
  const d = p.data;
  for (let i = 0; i < p.count; i++) {
    const o = i * PIECE_FLOATS;
    // (affine pieces — props — are set down beside: left as they are)
    if ((d[o + 15] | 0) & 2) continue;
    const cx = (d[o] + d[o + 2] + d[o + 4] + d[o + 6]) / 4;
    const cy = (d[o + 1] + d[o + 3] + d[o + 5] + d[o + 7]) / 4;
    let c = grid.cellAtWorld(cx, cy);
    // (round 128e, FT-51: a façade on a cell's outer side has its middle just outside the plan — FT-22 — and was drawn
    // while its block wasn't built: the piece's building's cell nearest its middle)
    if ((c < 0 || !plan.levels.any(c)) && cp && p.building[i] >= 0) {
      let best = Infinity;
      for (const q of cp.buildings[p.building[i]]?.quads ?? []) {
        const [qx, qy] = grid.centre(q);
        const dd = Math.hypot(qx - cx, qy - cy);
        if (dd < best) {
          best = dd;
          c = q;
        }
      }
    }
    if (c < 0 || !plan.levels.any(c)) continue;
    const foot = (d[o + 8] + d[o + 9] + d[o + 10] + d[o + 11]) / 4;
    const top = (d[o + 15] | 0) & 1 ? foot + d[o + 12] : d[o + 12];
    const top0 = plan.top(c);
    const L = Math.max(0, Math.min(top0, Math.floor(((foot + top) / 2 - zOff - town.base[c]) / LEVEL_H)));
    if (inp.ghost!(c, L)) d[o + 13] = (d[o + 13] | 0) | LOOK_GHOST;
  }
}

/** (round 128d) the picked structure's pieces flagged PIECE_PICKED (by the cell under each piece's middle) */
function pickOver(p: StructurePieces, site: ViewSite, inp: ViewInputs): void {
  const d = p.data;
  for (let i = 0; i < p.count; i++) {
    const o = i * PIECE_FLOATS;
    const affine = ((d[o + 15] | 0) & 2) !== 0;
    // (an affine piece — a prop — has its translation in row 2's last column: x, y at 3, 7)
    const cx = affine ? d[o + 3] : (d[o] + d[o + 2] + d[o + 4] + d[o + 6]) / 4;
    const cy = affine ? d[o + 7] : (d[o + 1] + d[o + 3] + d[o + 5] + d[o + 7]) / 4;
    const c = site.grid.cellAtWorld(cx, cy);
    if (c >= 0 && site.plan.owner[c] === inp.picked) d[o + 15] = (d[o + 15] | 0) | PIECE_PICKED;
  }
}

/** the structures' hash (structmesh.wgsl spHash), to pick a palette variant as the GPU will */
function spHash(x: number): number {
  let h = x >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  h = Math.imul(h, 0x7feb352d) >>> 0;
  h = (h ^ (h >>> 15)) >>> 0;
  h = Math.imul(h, 0x846ca68b) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

/** the crop palette's ripe variants (styles.ts Part.Crop: 1 and 3 are the yellow ones) */
const RIPE = new Set([1, 3]);
const CROP_PART = 18;
const CROP_VARIANTS = 5;

/**
 * (round 128d: "Farms did not build for me") The fields drawn. Two causes: a crop is draped (DRAPE: laid on the ground
 * the host draws now, and hidden under it when any corner's ground is more than 1.5 off the plan's), and a town's ground
 * is the land as it was, without the loose ground the GPU keeps on it — more than 1.5 off in places, so fields were
 * hidden; and a crop's palette variant is a hash of its look, two in five green — on grass a farm read as nothing. So
 * the crops follow the host's ground however far off it is (DRAPE_ANY), and are ripe: the look's low bits moved on until
 * the variant is a ripe one. (round 128d) The paving follows the host's ground the same way.
 */
function ripen(p: StructurePieces): void {
  const lib = library();
  const crop = lib.id('crop');
  const pave = lib.id('pave');
  for (let i = 0; i < p.count; i++) {
    if (p.module[i] === pave) {
      p.data[i * PIECE_FLOATS + 15] = (p.data[i * PIECE_FLOATS + 15] | 0) | DRAPE_ANY;
      continue;
    }
    if (p.module[i] !== crop) continue;
    const f = i * PIECE_FLOATS;
    p.data[f + 15] = (p.data[f + 15] | 0) | DRAPE_ANY;
    const o = f + 13;
    const look = p.data[o] | 0;
    let v = look & 0xffff;
    for (let k = 0; k < 64 && !RIPE.has(spHash(((v * 31) >>> 0) + CROP_PART * 7919) % CROP_VARIANTS); k++) v = (v + 1) & 0xffff;
    p.data[o] = (look & ~0xffff) | v;
  }
}

/** a wall's frame on side a→b of a cell (counter-clockwise): along it, then in by t */
function sideBand(a: V2, b: V2, t: number): [V2, V2, V2, V2] {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l = Math.hypot(dx, dy) || 1;
  const nx = (-dy / l) * t;
  const ny = (dx / l) * t;
  return [a, b, [b[0] + nx, b[1] + ny], [a[0] + nx, a[1] + ny]];
}

/** a band from a to b, h either side of the line (counter-clockwise from a's right) */
function band(a: V2, b: V2, h: number): [V2, V2, V2, V2] {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l = Math.hypot(dx, dy) || 1;
  const nx = (-dy / l) * h;
  const ny = (dx / l) * h;
  return [[a[0] - nx, a[1] - ny], [b[0] - nx, b[1] - ny], [b[0] + nx, b[1] + ny], [a[0] + nx, a[1] + ny]];
}

/** a square frame round (x, y), side 2h (counter-clockwise) */
function square(x: number, y: number, h: number): [V2, V2, V2, V2] {
  return [[x - h, y - h], [x + h, y - h], [x + h, y + h], [x - h, y + h]];
}

/** The town as a CityPlan, and the pieces it has no rule for. */
export function townView(site: ViewSite, inp: ViewInputs): { city: CityPlan; extra: StructurePieces } {
  const { plan, town, grid } = site;
  const defs = inp.defs ?? DEFS;
  const zOff = inp.zOff ?? 0;
  const seed = site.seed;
  const nq = grid.count;
  // (round 128d) the painted shapes' landmarks: towers, domes, turrets, courtyards (shapes.ts)
  const shapes: Shapes = shapesOf(plan, grid, (c) => town.base[c], defs);
  const ways = inp.ways ?? waysOf(plan, grid, { courtyards: shapes.courtyards.flatMap((ct) => ct.cells), defs, walk: groundSteps(grid, inp.ground) });
  const tiles: TileMesh = {
    verts: Float64Array.from(grid.verts),
    quads: Uint32Array.from(grid.quads),
    use: plan.use.slice(),
    block: Int32Array.from(plan.block),
  };
  // (round 128p, DA-A13) the paths: the lab's network, else the roads the plan's layout carries (generation's, an edit's)
  const paths: PathsView | undefined = inp.edges ?? (plan.layout.roads ? pathsViewOf(grid, plan.layout.roads) : undefined);
  if (paths) {
    const t = insetTiles(grid, plan, paths);
    tiles.verts = t.verts;
    tiles.quads = t.quads;
  }
  const adj = grid.nbr;
  // the ground under every corner (the plan's z + zOff; the grid's vertices first, then an inset's copies)
  const nv = tiles.verts.length / 2;
  const ground = new Float64Array(nv);
  for (let v = 0; v < nv; v++) ground[v] = inp.ground(tiles.verts[v * 2], tiles.verts[v * 2 + 1]) + zOff;
  const quadBuilding = new Int32Array(nq).fill(-1);
  const quadTop = new Float64Array(nq).fill(NaN);
  const buildings: BuildingRec[] = [];
  const roofRise: number[] = [];
  const props: Prop[] = plan.layout.props.map((p) => ({ ...p, at: [p.at[0], p.at[1], p.at[2] + zOff] }));
  const megas: MegaFeature[] = [];
  const spans: Span[] = [];
  const lib = library();
  const extra = new Extra();
  const ghostAt = (c: number, L: number) => inp.ghost?.(c, L) ?? false;
  const topOf = (c: number) => plan.top(c);
  const centre = (c: number): V2 => grid.centre(c);
  const groundAt = (x: number, y: number) => inp.ground(x, y) + zOff;
  const styleOfType = (t: StructureType): StructureStyleId => (defs[t].look.style === 'town' ? plan.style : defs[t].look.style as StructureStyleId);
  /** a structure's look as the pieces take it: its style's index over its bits (the hedge bit is the view's, not a look) */
  const lookOf = (id: number) => {
    const s = plan.structure(id)!;
    const bits = (s.look ?? Math.floor(hashf(s.id, 31) * 4096)) & ~LOOK_HEDGE;
    return STYLE_IDS.indexOf(styleOfType(s.type)) * 65536 + bits;
  };
  /**
   * how far a corner tile's run turns (radians): π less the angle at its middle between the run two cells on either way
   * (onetown: a run across an irregular grid steps from cell to cell — its tiles turn by a quarter at every step while the
   * run goes on straight; the run's own bend is what a tower marks)
   */
  const wallAt = (n: number) => n >= 0 && (plan.typeAt(n) === 'wall' || plan.typeAt(n) === 'fortress');
  const along = (from: number, via: number, steps: number): V2 => {
    let prev = from;
    let cur = via;
    for (let i = 1; i < steps; i++) {
      const next = [0, 1, 2, 3].map((e) => adj[cur * 4 + e]).filter((n) => n !== prev && wallAt(n));
      if (next.length !== 1) break;
      prev = cur;
      cur = next[0];
    }
    return centre(cur);
  };
  const turn = (c: number): number => {
    const ns = [0, 1, 2, 3].map((e) => adj[c * 4 + e]).filter(wallAt);
    if (ns.length !== 2) return Math.PI;
    const [cx, cy] = centre(c);
    const p1 = along(c, ns[0], 2);
    const p2 = along(c, ns[1], 2);
    const a: V2 = [p1[0] - cx, p1[1] - cy];
    const b: V2 = [p2[0] - cx, p2[1] - cy];
    const cos = (a[0] * b[0] + a[1] * b[1]) / (Math.hypot(...a) * Math.hypot(...b) || 1);
    return Math.PI - Math.acos(Math.max(-1, Math.min(1, cos)));
  };
  /** the courtyards' faces: a block's ground-floor side, an arch instead of its wall */
  const arched = new Set<number>();
  for (const ct of shapes.courtyards) for (const f of ct.faces) arched.add(f.cell * 4 + f.side);
  const courtCells = new Set(shapes.courtyards.flatMap((ct) => ct.cells));
  const doorOf = new Map(ways.doors.map((d) => [d.structure, d]));
  /** (onetown) per building its front door where the ways put one (a façade forced to a door) */
  const front = new Map<number, { quad: number; side: number }>();
  /** a gate's cells (the dressing's torches) */
  const gates: number[] = [];

  for (const s of plan.structures()) {
    const def = defs[s.type];
    const look = lookOf(s.id);
    const cellsOf = [...s.cells.keys()];
    if (def.form === 'yard') {
      const use: TileUse = def.look.use ?? (s.type === 'farm' ? 'field' : 'yard');
      for (const c of cellsOf) tiles.use[c] = use;
      // (round 128d: a farm read as nothing — a green crop on green grass, unfenced) a fence round a farm's, an
      // orchard's, a pasture's edge (a hedge where the generator hedged it)
      if (s.type === 'farm' || s.type === 'orchard' || s.type === 'pasture') {
        const hedge = ((s.look ?? 0) & LOOK_HEDGE) !== 0;
        for (const c of cellsOf) {
          const p = quadCorners(tiles, c);
          const L2 = ghostAt(c, 0) ? look | LOOK_GHOST : look;
          for (let e = 0; e < 4; e++) {
            const n = adj[c * 4 + e];
            if (n >= 0 && plan.owner[n] === s.id) continue;
            const a = p[e];
            const b = p[(e + 1) % 4];
            // (draped on the ground as drawn, as the towns' fences: its top a height over it)
            const ga = ground[grid.quads[c * 4 + e]] - 0.1;
            const gb = ground[grid.quads[c * 4 + ((e + 1) % 4)]] - 0.1;
            extra.add(lib.id(hedge ? 'hedge' : 'fence'), band(a, b, hedge ? 0.35 : 0.08), [ga, gb, gb, ga], hedge ? 1.3 : 1.15, L2, REL | DRAPE | DRAPE_ANY);
          }
        }
      }
      // (onetown) a fountain where its cells meet (the plaza's middle)
      if (def.look.mega === 'fountain') {
        const at = sharedCorner(grid, cellsOf) ?? centroid(grid, cellsOf);
        const g = groundAt(at[0], at[1]);
        megas.push({ kind: 'fountain', quads: cellsOf, frame: square(at[0], at[1], MEGA_HALF.fountain), z0: g - 0.1, z1: g + 2.6 });
      }
    } else if (def.form === 'wall') {
      // (round 128d, the user: "walls can be thinner than a cell as long as the cells are marked as wall") a wall cell is
      // a thin wall by rules: a band from its middle to each side that meets a wall (or the keep), so runs, corners and
      // tees join; merlons along both faces; a tower where a run ends, turns or meets another, or where one was tapped;
      // a gate's arch in both faces of a straight run where marked. The cell is still the unit of planning and cost.
      for (const c of cellsOf) {
        if (plan.gate[c]) gates.push(c);
        const L = topOf(c);
        const top = town.floorZ(c, L) + LEVEL_H + zOff;
        const [x, y] = centre(c);
        const p = quadCorners(tiles, c);
        let lo = Infinity;
        for (let k = 0; k < 4; k++) lo = Math.min(lo, ground[grid.quads[c * 4 + k]]);
        const L2 = ghostAt(c, L) ? look | LOOK_GHOST : look;
        const joined: number[] = [];
        for (let e = 0; e < 4; e++) {
          const n = adj[c * 4 + e];
          const t = n >= 0 ? plan.typeAt(n) : null;
          if (t === 'wall' || t === 'fortress') joined.push(e);
        }
        // (round 128d) a wall cell whose lowest level is up off the ground spans the levels under it: its stone from that
        // level's floor, an arch in each face under it (a bridge between what holds it — TownPlan.held)
        const bot = plan.levels.bottom(c);
        const zb = bot > 0 ? town.floorZ(c, bot) + zOff : lo - 0.6;
        // the middle: a square the bands meet in
        if (!plan.gate[c]) extra.add(lib.id('rampart'), square(x, y, WALL_HALF), zb, top, L2);
        const myStairs = ways.stairs.filter((st) => st.wall === c);
        for (const e of joined) {
          const m: V2 = [(p[e][0] + p[(e + 1) % 4][0]) / 2, (p[e][1] + p[(e + 1) % 4][1]) / 2];
          const f = band([x, y], m, WALL_HALF);
          if (plan.gate[c]) {
            // the passage crosses the run: an arch in each face, a lintel over it
            extra.add(lib.id('gatearch'), band(f[0], f[1], 0.45), lo - 0.3, top, L2);
            extra.add(lib.id('gatearch'), band(f[3], f[2], 0.45), lo - 0.3, top, L2);
            extra.add(lib.id('rampart'), f, top - WALL_LINTEL, top, L2);
            // (m4) shut: the passage closed under the lintel
            if (inp.shut) extra.add(lib.id('rampart'), band([x, y], m, 0.35), lo - 0.3, top - WALL_LINTEL, L2);
          } else {
            extra.add(lib.id('rampart'), f, zb, top, L2);
            if (bot > 0) {
              extra.add(lib.id('gatearch'), band(f[0], f[1], 0.45), lo - 0.3, zb + 0.6, L2);
              extra.add(lib.id('gatearch'), band(f[3], f[2], 0.45), lo - 0.3, zb + 0.6, L2);
            }
          }
          // (a stair comes up on this cell's side: no merlons on that face — round 128d)
          const face = (a: V2, b: V2) => {
            const st = myStairs[0];
            if (!st) return true;
            const d = alongAxis(st.axis, 0).d;
            return ((a[0] + b[0]) / 2 - x) * d[0] + ((a[1] + b[1]) / 2 - y) * d[1] <= 0.05;
          };
          if (face(f[0], f[1])) extra.add(lib.id('merlons'), band(f[0], f[1], 0.22), top, top + 1.1, L2);
          if (face(f[3], f[2])) extra.add(lib.id('merlons'), band(f[3], f[2], 0.22), top, top + 1.1, L2);
        }
        if (!joined.length) {
          const q = square(x, y, WALL_HALF);
          for (let k = 0; k < 4; k++) extra.add(lib.id('merlons'), band(q[k], q[(k + 1) % 4], 0.22), top, top + 1.1, L2);
        }
        // a tower where the run doesn't simply carry on (a corner that only bends — the irregular grid's quads turn a
        // little at every cell — has none: one where it turns by more than 50 degrees), or where the player put one
        const tile = plan.wallTile(c, L);
        const auto = !!tile && towered(tile) && !(tile === 'corner' && turn(c) < (50 * Math.PI) / 180);
        // (with a spire, as the towns' wall towers had)
        if (auto || plan.tower[c]) {
          extra.add(lib.id('tower'), square(x, y, 2.2), lo - 0.6, top + 2.4, L2);
          extra.add(lib.id('spire'), square(x, y, 2.1), top + 2.4, top + 2.4 + 2.1 * 2.4, L2);
        }
        spans.push({ quad: c, z0: zb, z1: top, kind: 'rampart', building: -1 });
      }
    } else if (def.form === 'keep') {
      // (round 128d) the keep: solid stone cells (the towns' rampart, crenellated where no keep cell is beside), a
      // tower at each outer corner
      const keepTop = (c: number) => town.floorZ(c, topOf(c)) + LEVEL_H + zOff;
      for (const c of cellsOf) {
        tiles.use[c] = 'wall';
        quadTop[c] = keepTop(c);
      }
      // (round 128d) a keep cell standing above every keep cell beside it: a round turret (shapes.ts) — the keep's
      // stone up to its tallest neighbour, the turret's drum on up to the cell's own top, a spire on it
      for (const c of cellsOf) {
        if (!shapes.turrets.has(c)) continue;
        let under = -Infinity;
        for (let e = 0; e < 4; e++) {
          const n = adj[c * 4 + e];
          if (n >= 0 && plan.owner[n] === s.id) under = Math.max(under, keepTop(n));
        }
        quadTop[c] = under;
        const [x, y] = centre(c);
        const L2 = ghostAt(c, topOf(c)) ? look | LOOK_GHOST : look;
        const t = keepTop(c);
        extra.add(lib.id('tower'), square(x, y, 2.1), under - 0.5, t, L2);
        extra.add(lib.id('spire'), square(x, y, 1.9), t, t + 4.2, L2);
      }
      // (round 128d) its door (ways.ts): an arch in the keep's face there
      const kd = doorOf.get(s.id);
      if (kd) {
        const p = quadCorners(tiles, kd.cell);
        const z0 = town.floorZ(kd.cell, 0) + zOff;
        extra.add(lib.id('gatearch'), sideBand(p[kd.side], p[(kd.side + 1) % 4], 0.9), z0 - 0.3, z0 + LEVEL_H * 0.8, ghostAt(kd.cell, 0) ? look | LOOK_GHOST : look);
      }
      for (const c of cellsOf) {
        const p = quadCorners(tiles, c);
        const out = (e: number) => {
          const n = adj[c * 4 + ((e + 4) % 4)];
          return n < 0 || plan.owner[n] !== s.id;
        };
        let lo = Infinity;
        for (let k = 0; k < 4; k++) lo = Math.min(lo, ground[grid.quads[c * 4 + k]]);
        // (corner k lies between sides k-1 and k)
        for (let k = 0; k < 4; k++) {
          if (!out(k - 1) || !out(k)) continue;
          extra.add(lib.id('tower'), square(p[k][0], p[k][1], 1.8), lo - 0.6, quadTop[c] + 3.2, ghostAt(c, topOf(c)) ? look | LOOK_GHOST : look);
        }
        spans.push({ quad: c, z0: lo - 0.5, z1: quadTop[c], kind: 'rampart', building: -1 });
      }
    } else if (def.form === 'block') {
      // (onetown) a landmark of its own (a lighthouse, a headframe, a windmill): drawn whole over its cells
      const freeMega = def.look.mega === 'lighthouse' || def.look.mega === 'headframe' || def.look.mega === 'windmill' ? def.look.mega : null;
      if (freeMega) {
        const [x, y] = centroid(grid, cellsOf);
        let z0 = Infinity;
        let z1 = -Infinity;
        for (const c of cellsOf) {
          tiles.use[c] = 'yard';
          z0 = Math.min(z0, town.floorZ(c, 0) + zOff);
          z1 = Math.max(z1, town.floorZ(c, topOf(c)) + LEVEL_H + zOff);
        }
        megas.push({ kind: freeMega, quads: [], frame: square(x, y, MEGA_HALF[freeMega]), z0, z1 });
        continue;
      }
      // buildings: one a floor of the structure (its cells' floors line up), or one a cell for a type that doesn't join
      const groups = new Map<string, number[]>();
      for (const c of cellsOf) {
        const key = def.joins ? String(town.base[c]) : `c${c}`;
        const g = groups.get(key) ?? [];
        g.push(c);
        groups.set(key, g);
      }
      const door0 = doorOf.get(s.id);
      const st = styleOfType(s.type);
      for (const cells of groups.values()) {
        const id = buildings.length;
        const base = town.base[cells[0]] + zOff;
        let storeys = 0;
        for (const c of cells) {
          tiles.use[c] = 'lot';
          quadBuilding[c] = id;
          quadTop[c] = town.floorZ(c, topOf(c)) + LEVEL_H + zOff;
          storeys = Math.max(storeys, topOf(c) + 1);
        }
        // (round 128d) a landmark by its type or its shape (shapes.ts): a lone cell stacked high a round tower and spire;
        // four round a corner, all one height, a domed drum — both drawn whole by the towns' rules (megas), no façades
        const tower = def.look.mega === 'tower' || (cells.length === 1 && shapes.towers.has(cells[0]));
        const dome = def.look.mega === 'dome' || (cells.length === 4 && shapes.domes.some((d) => d.cells.includes(cells[0])));
        const mega = tower ? 'tower' : dome ? 'dome' : undefined;
        const kind = def.look.kind ?? 'house';
        buildings.push({ id, kind, quads: cells, base, storeys, storeyH: LEVEL_H, look: look & 0xffff, mega, structure: s.id, ...(st !== plan.style ? { style: st } : {}), ...(s.district !== undefined ? { district: s.district } : {}), ...(s.wear ? { wear: s.wear } : {}) });
        if (dome) {
          const v = sharedVertex(grid, cells);
          const outer: V2[] =
            v >= 0
              ? cells
                  .map((c) => {
                    const k = [0, 1, 2, 3].find((i) => grid.quads[c * 4 + i] === v)!;
                    const o = grid.quads[c * 4 + ((k + 2) % 4)];
                    return [grid.verts[o * 2], grid.verts[o * 2 + 1]] as V2;
                  })
                  .sort((a, b) => Math.atan2(a[1] - grid.verts[v * 2 + 1], a[0] - grid.verts[v * 2]) - Math.atan2(b[1] - grid.verts[v * 2 + 1], b[0] - grid.verts[v * 2]))
              : quadCorners(tiles, cells[0]);
          let z1 = -Infinity;
          for (const c of cells) z1 = Math.max(z1, quadTop[c]);
          if (outer.length === 4) megas.push({ kind: 'dome', quads: cells, frame: [outer[0], outer[1], outer[2], outer[3]], z0: base, z1 });
        }
        // (the door where the ways put it, on this floor's cells)
        if (door0 && cells.includes(door0.cell)) front.set(id, { quad: door0.cell, side: door0.side });
        // (the roof's rise, as the towns': a tile's mean side × the pitch)
        let edge = 0;
        let ne = 0;
        for (const c of cells) {
          const p = quadCorners(tiles, c);
          for (let k = 0; k < 4; k++) {
            edge += Math.hypot(p[(k + 1) % 4][0] - p[k][0], p[(k + 1) % 4][1] - p[k][1]);
            ne++;
          }
        }
        roofRise.push((edge / ne) * (kind === 'house' ? styleOf(st).pitch : kind === 'hut' ? 1.35 : kind === 'barn' ? 1.0 : 1.1));
        // a chimney on the building's tallest cell (the types that have one: a smithy's forge)
        if (def.look.chimney && !mega) {
          let tc = cells[0];
          for (const c of cells) if (quadTop[c] > quadTop[tc]) tc = c;
          const [x, y] = centre(tc);
          extra.add(lib.id('chimney'), square(x, y, 0.7), quadTop[tc], quadTop[tc] + roofRise[id] + 2.4, ghostAt(tc, topOf(tc)) ? look | LOOK_GHOST : look);
        }
        // (the occupancy as spans: what the far land's raster and the columns' readers see)
        for (const c of cells) {
          let lo = Infinity;
          for (let k = 0; k < 4; k++) lo = Math.min(lo, ground[grid.quads[c * 4 + k]]);
          if (base > lo) spans.push({ quad: c, z0: lo - 0.5, z1: base, kind: 'foundation', building: id });
          spans.push({ quad: c, z0: base, z1: quadTop[c], kind: mega === 'tower' ? 'tower' : 'room', building: id });
        }
      }
    }
    // (form 'bridge': townlab's bridges draw and claim themselves — nothing here)
    // the type's things set down: on a yard in it, by a building at its first cell's open side
    const kinds = def.look.props ?? [];
    // (round 128m, quarry: on the pit's rim — its ring-0 cells off the ramp — not in the pit, where they'd float as it deepens)
    const pit = s.type === 'quarry' ? plan.pitOf(s.id) : null;
    const rim = pit && pit.tiers ? [...pit.ring].filter(([c, d]) => d === 0 && !plan.pit.any(c)).map(([c]) => c) : [];
    const cells = rim.length ? rim : cellsOf;
    kinds.forEach((kind, i) => {
      const c = cells[(i * 7) % cells.length];
      let [x, y] = centre(c);
      if (def.form !== 'yard') {
        // (out past the open side)
        for (let side = 0; side < 4; side++) {
          const n = adj[c * 4 + side];
          if (n >= 0 && plan.owner[n] === s.id) continue;
          const p = quadCorners(tiles, c);
          const mx = (p[side][0] + p[(side + 1) % 4][0]) / 2;
          const my = (p[side][1] + p[(side + 1) % 4][1]) / 2;
          x = mx + (mx - x) * 0.6;
          y = my + (my - y) * 0.6;
          break;
        }
      }
      props.push({ kind, at: [x, y, groundAt(x, y)], heading: hashf(s.id, i, 3) * Math.PI * 2, size: PROP_SIZE[kind], seed: hashf(s.id, i, 5) });
    });
  }
  // (a lot no structure stands on is a yard: room to grow, a garden)
  for (let c = 0; c < nq; c++) if (tiles.use[c] === 'lot' && quadBuilding[c] < 0) tiles.use[c] = 'yard';
  // (round 128d) the courtyards (shapes.ts): paved; one cell a tree in the middle, more a fountain
  for (const ct of shapes.courtyards) {
    for (const c of ct.cells) tiles.use[c] = 'plaza';
    const [x, y] = centroid(grid, ct.cells);
    const g = groundAt(x, y);
    if (ct.cells.length === 1) extra.add(lib.id('fruittree'), square(x, y, 2.0), g - 0.1, g + 4.4, Math.floor(hashf(ct.cells[0], 33) * 4096));
    else megas.push({ kind: 'fountain', quads: ct.cells.slice(), frame: square(x, y, 1.7), z0: g - 0.1, z1: g + 2.6 });
  }
  // (round 128d) the squares (ways.ts): paved as the towns' plazas (onetown: lit by the dressing's lamps, as every
  // plaza and street — about 12 m apart)
  for (let c = 0; c < nq; c++) if (ways.way[c] === WAY_SQUARE && !courtCells.has(c) && plan.owner[c] < 0) tiles.use[c] = 'plaza';
  // (round 128d) the stairs up onto the walls: stone steps along each stair's axis, from the wall's top down to its foot
  // cell's ground (as solid.ts claims them), see-through while the wall still stands to be built
  for (const st of ways.stairs) {
    const s = plan.structure(st.structure)!;
    const look = lookOf(s.id);
    const L2 = ghostAt(st.wall, 0) ? look | LOOK_GHOST : look;
    const top = town.floorZ(st.wall, topOf(st.wall)) + LEVEL_H + zOff;
    // (the ground at the flight's far end: a free cell has no floor — as solid.ts)
    const end = st.axis[st.axis.length - 1];
    const foot = groundAt(end[0], end[1]);
    const len = axisLength(st.axis);
    const rise = (top - foot) / Math.max(1e-3, len - WALL_HALF);
    const n = Math.max(1, Math.ceil((len - WALL_HALF) / STEP_LEN));
    for (let i = 0; i < n; i++) {
      const t0 = WALL_HALF + ((len - WALL_HALF) * i) / n - (i === 0 ? 0.3 : 0);
      const t1 = WALL_HALF + ((len - WALL_HALF) * (i + 1)) / n;
      const a = alongAxis(st.axis, t0);
      const b = alongAxis(st.axis, t1);
      const nx = (d: V2) => [-d[1] * STAIR_HALF, d[0] * STAIR_HALF] as V2;
      const na = nx(a.d);
      const nb = nx(b.d);
      const fr: [V2, V2, V2, V2] = [
        [a.p[0] - na[0], a.p[1] - na[1]],
        [b.p[0] - nb[0], b.p[1] - nb[1]],
        [b.p[0] + nb[0], b.p[1] + nb[1]],
        [a.p[0] + na[0], a.p[1] + na[1]],
      ];
      // (each step's tread at the flight's height at its near edge)
      const z = top - (t0 + 0.3 * (i === 0 ? 1 : 0) - WALL_HALF) * rise;
      const g = Math.min(groundAt(a.p[0], a.p[1]), groundAt(b.p[0], b.p[1]));
      extra.add(lib.id('rampart'), fr, g - 0.4, Math.max(z, g + 0.15), L2);
    }
  }
  // ---- the façades: every storey's side no block covers, WFC by building (doors toward the street, or the ways')
  const facades = facadesOf(tiles, adj, buildings, quadBuilding, {
    levels: (c) => [...plan.levels.each(c)],
    floorZ: (c, L) => town.floorZ(c, L) + zOff,
    seed,
    gz: ground,
    // (round 128d) a side on a courtyard: an arch in the ground floor, not a wall (shapes.ts); (round 128h, V128-13) a
    // passage through the ground floor: an arch in each of its sides the same
    skip: (c, side, L) => L === 0 && (arched.has(c * 4 + side) || !!plan.passage[c]),
    front,
  });
  for (const b of buildings) {
    if (b.mega) continue;
    for (const c of b.quads)
      if (plan.passage[c] || [0, 1, 2, 3].some((side) => arched.has(c * 4 + side)))
        for (let side = 0; side < 4; side++) {
          if (!(plan.passage[c] || arched.has(c * 4 + side))) continue;
          const n = adj[c * 4 + side];
          if (n >= 0 && quadBuilding[n] === b.id) continue;
          const p = quadCorners(tiles, c);
          const z0 = town.floorZ(c, 0) + zOff;
          const look = lookOf(b.structure!);
          extra.add(lib.id('gatearch'), sideBand(p[side], p[(side + 1) % 4], WALL_T), z0, z0 + LEVEL_H, ghostAt(c, 0) ? look | LOOK_GHOST : look);
        }
  }
  // ---- the layout's features (copies: the view is moved, the plan isn't) and the dressing's lamps, torches, banners
  const linear: LinearFeature[] = plan.layout.linear.map((f) => ({ ...f, points: f.points.map((p) => [p[0], p[1], p[2] + zOff]), ground: f.ground.map((g) => g + zOff) }));
  // (round 128p, DA-A13 step 2: the edge paths paved — the streets' paving, draped on the ground)
  if (paths) {
    for (const pv of pathPaving(grid, paths, groundAt)) extra.add(lib.id('pave'), pv.frame, pv.foot - 0.25, 0.37, STYLE_IDS.indexOf(plan.style) * 65536, REL | DRAPE);
    // (the bridges are the plan's layout's: townroads.ts lays them, so they're claimed as decks and drawn with the rest)
    // (over water a curve is its bridge — the layout's deck — not paving: where no `wet` is given, near a bridge's line)
    const bridges = plan.layout.linear.filter((f) => f.of === 'mainroad');
    const onBridge = (x: number, y: number) => bridges.some((f) => f.points.some((q, i) => i > 0 && segDist(x, y, f.points[i - 1], q) < 2.2));
    const cp = curvePieces(paths.curves, groundAt, inp.wet ?? onBridge);
    for (const pv of cp.paves) extra.add(lib.id('pave'), pv.frame, pv.foot - 0.25, 0.37, STYLE_IDS.indexOf(plan.style) * 65536, REL | DRAPE);
  }
  const berths = plan.layout.berths.map((b) => ({ ...b, at: [b.at[0], b.at[1], b.at[2] + zOff] as [number, number, number] }));
  const order: number[] = [];
  const byStructure = new Map<number, number[]>();
  for (const b of buildings) (byStructure.get(b.structure!) ?? byStructure.set(b.structure!, []).get(b.structure!)!).push(b.id);
  for (const s of site.order) for (const b of byStructure.get(s) ?? []) order.push(b);
  const city: CityPlan = {
    spec: { seed, system: 'irregular', style: plan.style, at: [0, 0], radius: 0 },
    tiles,
    ground,
    spans,
    buildings,
    facades,
    quadBuilding,
    quadTop,
    order: order.length ? order : buildings.map((b) => b.id),
    roofRise,
    megas,
    linear,
    works: plan.layout.works,
    berths,
    props,
    lights: [],
    nav: { nodes: [], links: [] },
    stats: {},
  };
  // (gates as the dressing knows them: a gate tile's torches)
  for (const g of gates) tiles.use[g] = 'gate';
  city.lights = dressing({ spec: city.spec, tiles, adj, ground: groundAt, buildings }, facades, megas, props, berths);
  for (const g of gates) tiles.use[g] = 'outside';
  // (a field's crop rows run along its tile's first side: each field tile's corners turned so that side lies along its
  // plot's long way — the rows of a plot run one way, as the strips of the old farmland did)
  for (const s of plan.structures()) {
    if ((defs[s.type].look.use ?? (s.type === 'farm' ? 'field' : '')) !== 'field' || s.cells.size < 2) continue;
    const cs = [...s.cells.keys()];
    const [mx, my] = centroid(grid, cs);
    let xx = 0;
    let xy = 0;
    let yy = 0;
    for (const c of cs) {
      const [x, y] = grid.centre(c);
      xx += (x - mx) ** 2;
      xy += (x - mx) * (y - my);
      yy += (y - my) ** 2;
    }
    const a = 0.5 * Math.atan2(2 * xy, xx - yy);
    const ax = Math.cos(a);
    const ay = Math.sin(a);
    for (const c of cs) {
      let best = 0;
      let bd = -1;
      for (let k = 0; k < 4; k++) {
        const [x0, y0] = grid.corner(c, k);
        const [x1, y1] = grid.corner(c, k + 1);
        const l = Math.hypot(x1 - x0, y1 - y0) || 1;
        const d = Math.abs(((x1 - x0) * ax + (y1 - y0) * ay) / l);
        if (d > bd) (bd = d), (best = k);
      }
      const q = [0, 1, 2, 3].map((k) => grid.quads[c * 4 + ((k + best) % 4)]);
      for (let k = 0; k < 4; k++) tiles.quads[c * 4 + k] = q[k];
    }
  }
  if (site.placed.size) city.placed = [...site.placed].map(([id, s]) => ({ id, building: byStructure.get(s)?.[0] ?? -1 })).filter((p) => p.building >= 0);
  return { city, extra: extra.done() };
}

/** the vertex the cells all share (-1 none) */
function sharedVertex(grid: { quads: ArrayLike<number> }, cells: readonly number[]): number {
  for (let k = 0; k < 4; k++) {
    const v = grid.quads[cells[0] * 4 + k];
    if (cells.every((c) => [0, 1, 2, 3].some((i) => grid.quads[c * 4 + i] === v))) return v;
  }
  return -1;
}

/** where the cells all meet (null: they don't) */
function sharedCorner(grid: { quads: ArrayLike<number>; verts: ArrayLike<number> }, cells: readonly number[]): V2 | null {
  const v = sharedVertex(grid, cells);
  return v >= 0 ? [grid.verts[v * 2], grid.verts[v * 2 + 1]] : null;
}

/** the cells' middle */
function centroid(grid: { centre(c: number): [number, number] }, cells: readonly number[]): V2 {
  let x = 0;
  let y = 0;
  for (const c of cells) {
    const [a, b] = grid.centre(c);
    x += a / cells.length;
    y += b / cells.length;
  }
  return [x, y];
}

// ------------------------------------------------------------------ façades (WFC by building)

const KINDS: FacadeKind[] = ['blank', 'window', 'window2', 'door', 'shop', 'balcony'];
const BLANK = 0;
const WINDOW = 1;
const WINDOW2 = 2;
const DOOR = 3;
const SHOP = 4;
const BALCONY = 5;
const bits = (...t: number[]) => t.reduce((m, k) => m | (1 << k), 0);

/** what may stand above each kind (blank always may: the rules can always be met) */
const ABOVE = new Uint32Array([
  bits(BLANK, WINDOW), // blank
  bits(BLANK, WINDOW, BALCONY), // window
  bits(BLANK, WINDOW2), // window2
  bits(BLANK, WINDOW, WINDOW2, BALCONY), // door
  bits(BLANK, WINDOW, WINDOW2, BALCONY), // shop
  bits(BLANK, WINDOW, BALCONY), // balcony
]);
/** side by side round a corner or along a wall: no two doors, no two balconies */
const BESIDE = new Uint32Array(KINDS.map((_, a) => bits(...KINDS.map((__, b) => b).filter((b) => !((a === DOOR && b === DOOR) || (a === BALCONY && b === BALCONY))))));

export interface FacadeInputs {
  /** a cell's levels (its blocks') */
  levels(c: number): number[];
  /** where level L of a cell starts */
  floorZ(c: number, L: number): number;
  seed: number;
  /** per vertex the ground */
  gz: Float64Array;
  /** a side with no wall (an arch: a courtyard's face, a passage) */
  skip?(c: number, side: number, L: number): boolean;
  /** a building's front door (the ways'): its façade is the door */
  front?: Map<number, { quad: number; side: number }>;
}

/**
 * Which wall each storey of each side of each building shows (structures' round-117 WFC): a side's storey is a wall
 * where no block covers it (its own building's at that height, or a neighbour's); doors toward the street (or where the
 * ways put the front door), shops on it, balconies over them, windows up the house; blank in the earth.
 */
export function facadesOf(tiles: TileMesh, adj: Int32Array, buildings: BuildingRec[], quadBuilding: Int32Array, inp: FacadeInputs): Facade[] {
  const out: Facade[] = [];
  /** whether cell n's blocks cover [z0, z1] */
  const covered = (n: number, z0: number, z1: number) => {
    if (n < 0 || quadBuilding[n] < 0) return false;
    let lo = Infinity;
    let hi = -Infinity;
    for (const L of inp.levels(n)) {
      const a = inp.floorZ(n, L);
      const b = a + LEVEL_H;
      // (a run of levels: contiguous blocks)
      if (a > hi + 0.01) {
        if (lo <= z0 + 0.01 && hi >= z1 - 0.01) return true;
        lo = a;
      }
      hi = b;
    }
    return lo <= z0 + 0.01 && hi >= z1 - 0.01;
  };
  for (const b of buildings) {
    if (b.mega) continue;
    const nodes: Facade[] = [];
    const len: number[] = [];
    const street: boolean[] = [];
    const yard: boolean[] = [];
    /** in the earth: the ground at the wall stands over most of the storey (blank, no door: a house dug into a hill) */
    const buried: boolean[] = [];
    for (const q of b.quads) {
      const p = quadCorners(tiles, q);
      for (let s = 0; s < 4; s++) {
        const n = adj[q * 4 + s];
        const L = Math.hypot(p[(s + 1) % 4][0] - p[s][0], p[(s + 1) % 4][1] - p[s][1]);
        for (const l of inp.levels(q)) {
          const z0 = inp.floorZ(q, l);
          const z1 = z0 + LEVEL_H;
          if (inp.skip?.(q, s, l)) continue;
          // hidden where a neighbour's blocks cover this one (its own building's, or one leaning on it)
          if (covered(n, z0, z1)) continue;
          nodes.push({ quad: q, side: s, level: l, z0, z1, kind: 'blank', building: b.id });
          len.push(L);
          street.push(n >= 0 && (tiles.use[n] === 'street' || tiles.use[n] === 'plaza' || tiles.use[n] === 'quay'));
          yard.push(n >= 0 && tiles.use[n] === 'yard');
          const g = (inp.gz[tiles.quads[q * 4 + s]] + inp.gz[tiles.quads[q * 4 + ((s + 1) % 4)]]) / 2;
          buried.push(g > z0 + LEVEL_H * 0.6);
        }
      }
    }
    if (!nodes.length) continue;
    const T = KINDS.length;
    const domain = new Uint32Array(nodes.length);
    const weight = new Float64Array(nodes.length * T);
    // the front door: where the ways put it, else the longest street-facing ground wall (else the longest ground wall)
    let front = -1;
    const want = inp.front?.get(b.id);
    if (want) front = nodes.findIndex((f) => f.quad === want.quad && f.side === want.side && f.level === Math.min(...inp.levels(want.quad)));
    if (front < 0)
      nodes.forEach((f, i) => {
        if (f.level !== Math.min(...inp.levels(f.quad)) || buried[i]) return;
        // (long enough for a door first, then facing the street, then the longest)
        const sc = (k: number) => (len[k] >= 1.8 ? 1000 : 0) + (street[k] ? 100 : yard[k] ? 50 : 0) + len[k];
        const score = sc(i);
        const was = front < 0 ? -1 : sc(front);
        if (score > was) front = i;
      });
    nodes.forEach((f, i) => {
      const L = len[i];
      let d = f.level === 0 ? bits(BLANK, WINDOW, WINDOW2, DOOR, SHOP) : bits(BLANK, WINDOW, WINDOW2, BALCONY);
      // (a hut's, a farmhouse's, a barn's: no shops, no balconies, one window a wall)
      if (b.kind !== 'house') d &= ~bits(SHOP, BALCONY, WINDOW2);
      if (L < 1.8 || buried[i]) d = bits(BLANK);
      else if (L < 3.2) d &= ~bits(WINDOW2, SHOP);
      if (i === front) d = bits(DOOR);
      domain[i] = d;
      const w = weight.subarray(i * T, i * T + T);
      // (blank walls read as warehouses and backs: rare up the house, a little commoner low down and on narrow walls)
      w[BLANK] = f.level === 0 ? 0.3 : L < 2.6 ? 0.25 : 0.08;
      w[WINDOW] = L < 3.2 ? 2 : 0.8;
      w[WINDOW2] = 2.2;
      w[DOOR] = street[i] ? 0.35 : 0.05;
      w[SHOP] = street[i] ? 0.9 : 0;
      w[BALCONY] = street[i] ? 0.7 : 0.35;
    });
    if (front >= 0) weight[front * T + DOOR] = 1;
    const edges: [number, number, number][] = [];
    const key = (q: number, s: number, l: number) => `${q},${s},${l}`;
    const at = new Map(nodes.map((f, i) => [key(f.quad, f.side, f.level), i]));
    nodes.forEach((f, i) => {
      const up = at.get(key(f.quad, f.side, f.level + 1));
      if (up !== undefined) edges.push([i, up, 0]);
    });
    // beside: walls of one storey sharing a corner vertex
    const byVert = new Map<string, number[]>();
    nodes.forEach((f, i) => {
      for (const k of [f.side, (f.side + 1) % 4]) {
        const v = tiles.quads[f.quad * 4 + k];
        const kk = `${v},${f.level}`;
        (byVert.get(kk) ?? byVert.set(kk, []).get(kk)!).push(i);
      }
    });
    for (const list of byVert.values()) for (let a = 0; a < list.length; a++) for (let c = a + 1; c < list.length; c++) edges.push([list[a], list[c], 1]);
    const prob: WfcProblem = { tiles: T, domain, weight, edges, allow: [ABOVE, BESIDE] };
    const sol = solve(prob, inp.seed * 977 + (b.structure ?? b.id));
    nodes.forEach((f, i) => {
      f.kind = KINDS[sol[i]];
      out.push(f);
    });
  }
  return out;
}

// ------------------------------------------------------------------ a view's subsets (the structures viewer's)

/**
 * One building of a town's view on its own (the viewer's building view): the others taken away, its façades and roofs
 * worked out again as if it stood alone.
 */
export function isolate(plan: CityPlan, id: number): CityPlan {
  return { ...subset(plan, new Map([[id, Infinity]])), megas: [] };
}

/**
 * The town as built so far (round 110: "towns should visibly grow but slowly"): the view's buildings in its build order,
 * the first share of them standing, the next one going up — its lower storeys, no roof yet.
 */
export function grown(plan: CityPlan, progress: number): CityPlan {
  if (progress >= 1) return plan;
  const n = plan.order.length;
  const done = Math.floor(Math.max(0, progress) * n);
  const keep = new Map<number, number>();
  for (let i = 0; i < done; i++) keep.set(plan.order[i], Infinity);
  const site = plan.order[done];
  if (site !== undefined) {
    const b = plan.buildings[site];
    const st = Math.floor((Math.max(0, progress) * n - done) * b.storeys);
    if (st > 0 && !b.mega) keep.set(site, -st);
  }
  return subset(plan, keep);
}

/** A view with only these buildings (id → storeys kept: Infinity all; −k: k, no roof — a site), its façades again. */
function subset(plan: CityPlan, keep: Map<number, number>): CityPlan {
  const nq = plan.tiles.use.length;
  const quadBuilding = new Int32Array(nq).fill(-1);
  const quadTop = new Float64Array(nq).fill(NaN);
  const levels = new Map<number, number>();
  const sites = new Set<number>();
  for (const [id, k] of keep) {
    const b = plan.buildings[id];
    if (k < 0) sites.add(id);
    for (const q of b.quads) {
      const full = Math.round((plan.quadTop[q] - b.base) / b.storeyH);
      const st = k < 0 ? Math.min(full, -k) : full;
      quadBuilding[q] = id;
      levels.set(q, st);
      quadTop[q] = b.base + st * b.storeyH;
    }
  }
  const baseOf = (q: number) => plan.buildings[quadBuilding[q]].base;
  const facades = facadesOf(plan.tiles, adjacency(plan.tiles), plan.buildings, quadBuilding, {
    levels: (q) => (quadBuilding[q] < 0 ? [] : Array.from({ length: levels.get(q) ?? 0 }, (_, l) => l)),
    floorZ: (q, l) => baseOf(q) + l * LEVEL_H,
    seed: plan.spec.seed,
    gz: plan.ground,
  }).filter((f) => keep.has(f.building));
  const tiles = { ...plan.tiles, use: plan.tiles.use.map((u, q): TileUse => (u === 'lot' && quadBuilding[q] < 0 ? 'yard' : u)) };
  const megas = plan.megas.filter((m) => m.kind === 'fountain' || m.quads.length === 0 || m.quads.some((q) => quadBuilding[q] >= 0));
  return { ...plan, tiles, quadBuilding, quadTop, facades, megas, sites, spans: plan.spans.filter((s) => s.building < 0 || keep.has(s.building)) };
}

/** the distance from (x, y) to segment ab (their x, y) */
function segDist(x: number, y: number, a: readonly number[], b: readonly number[]): number {
  const ex = b[0] - a[0];
  const ey = b[1] - a[1];
  const L2 = ex * ex + ey * ey;
  const t = L2 > 0 ? Math.max(0, Math.min(1, ((x - a[0]) * ex + (y - a[1]) * ey) / L2)) : 0;
  return Math.hypot(x - a[0] - ex * t, y - a[1] - ey * t);
}
