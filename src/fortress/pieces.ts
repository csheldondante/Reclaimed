// The fortress drawn (fortress slice 1, milestone 1): its plan made into the towns' pieces — the structures module
// library (structures/pieces.ts piecesOf), the same Townscaper-in-spirit rules the settlements are drawn by. In the
// atlas world the towns are pieces on the ground (settle/view.ts), not column matter: matter there is drawn by the
// heightfield, where a room, a crenel or an arch can't read.
//
// The plan becomes one CityPlan a style (each type's look names its style, defs.ts): its Town grid's quads are the
// tiles; a block structure's cells are lots, its buildings (one a structure and floor, or one a cell for a type that
// doesn't join) with a façade on every storey's side no block of the same building covers; walls are wall and gate
// tiles (ramparts, merlons on the sides that meet no wall, a gate's arch across a run) with a tower where a run turns,
// ends or meets another; farms are fields, the quarry a yard; and each type's props set down on it.
import type { StructurePieces, BuildingRec, CityPlan, Facade, MegaFeature, Prop, TileMesh, TileUse, V2, StructureStyleId } from '../api/contracts/structures';
import type { StructureDef, StructureType } from '../api/contracts/fortress';
import { LEVEL_H, type Town } from '../build/town';
import type { TownGrid } from '../build/towngrid';
import { PROP_SIZE } from '../structures/dressmodules';
import { library } from '../structures/modules';
import { DRAPE, DRAPE_ANY, PIECE_FLOATS, piecesOf, REL, WALL_T } from '../structures/pieces';
import { hashf } from '../structures/rng';
import { styleOf } from '../structures/styles';
import { adjacency, quadCorners } from '../structures/tiles/builder';
import { DEFS } from './defs';
import { towered, type FortressPlan } from './plan';
import { shapesOf, type Courtyard, type Shapes } from './shapes';
import { STAIR_HALF, WALL_HALF, WALL_LINTEL } from './solid';
import { alongAxis, axisLength, WAY_ROAD, WAY_SQUARE, waysOf, type Ways } from './ways';

/**
 * (round 128d) look bit 23: a block planned, not built yet. (round 128e, FT-51) While building its pieces aren't drawn:
 * a plot outline on the ground stands for it until work starts, scaffolding once it has (plotsOf). The bit only marks
 * them to drop (structgame.wgsl still draws it see-through, should one reach the GPU).
 */
export const LOOK_GHOST = 1 << 23;
/** (round 128e, FT-51) the outline's stakes and rails over the ground (m), and how far scaffolding stands off a block */
const PLOT_H = 0.9;
const SCAFFOLD_OFF = 0.35;
/** (round 128d) flags bit 6: the structure Inspect picked — drawn highlighted (structmesh.wgsl sets look bit 24 from it,
 *  structgame.wgsl tints it). A flag, not a look bit: the look travels as a float, exact only to 24 bits */
export const PIECE_PICKED = 64;
// (a thin wall's half width — a cell is ~5 m across — and a gate's lintel: solid.ts's, what's solid of it the same)

export interface PieceInputs {
  plan: FortressPlan;
  town: Town;
  grid: TownGrid;
  /** the ground's top at a box-local point (the Town's frame) */
  ground(x: number, y: number): number;
  /** added to every height (the Town's window z → the world z the pieces are drawn in) */
  zOff: number;
  defs?: Record<StructureType, StructureDef>;
  /**
   * (round 128d) While building: whether a block is still to build (drawn see-through, LOOK_GHOST). Absent while
   * planning: the plan is drawn whole (the user: "No planned blocks can look complete before being built" / "I don't
   * mind that as long as we are clearly in planning mode").
   */
  ghost?: (cell: number, level: number) => boolean;
  /**
   * (round 128e, FT-51) While building: whether work on a block still to build has begun (something brought to it):
   * scaffolding round it; not begun, a plot outline on the ground of its cell.
   */
  started?: (cell: number, level: number) => boolean;
  /** (round 128d) the structure Inspect picked (its pieces drawn highlighted) */
  picked?: number | null;
  /** (round 128d) the plan's ways (ways.ts: Fortress.ways): roads and squares paved, doors where they open, stairs */
  ways?: Ways;
}

/** a stair's step along its axis (metres) */
const STEP_LEN = 0.6;

/** The pieces of every planned structure, in the box's frame (x, y box-local world units; z world). */
export function fortressPieces(inp: PieceInputs): StructurePieces {
  const defs = inp.defs ?? DEFS;
  const styles = new Set<StructureStyleId>();
  for (const s of inp.plan.structures()) styles.add(defs[s.type].look.style);
  // (round 128d) the painted shapes' landmarks: towers, domes, turrets, courtyards (shapes.ts)
  const shapes = shapesOf(inp.plan, inp.grid, (c) => inp.town.base[c], defs);
  const ways = inp.ways ?? waysOf(inp.plan, inp.grid, shapes.courtyards.flatMap((ct) => ct.cells), defs);
  // (the roads and squares paved once, in the homely style if the fortress has it: its paving and lamps)
  const roadStyle: StructureStyleId = styles.has('hearth') ? 'hearth' : [...styles].sort()[0];
  const parts: StructurePieces[] = [];
  for (const style of styles) {
    const cp = cityPlanOf(inp, style, defs, shapes, ways, style === roadStyle);
    let p = piecesOf(cp.plan);
    ripen(p);
    drapeAny(p);
    let extra = cp.extra;
    if (inp.ghost) {
      ghostOver(p, inp, cp.plan);
      // (round 128e, FT-51: the user, "The temporary holder would be better as a loose plot outline or scaffolding") what
      // isn't built yet isn't drawn: its plot or its scaffolding is (below)
      p = unbuiltOut(p, inp);
      extra = unbuiltOut(extra, inp);
    }
    if (inp.picked != null) {
      pickOver(p, inp);
      pickOver(extra, inp);
    }
    parts.push(p);
    parts.push(extra);
  }
  if (inp.ghost) parts.push(plotsOf(inp, defs));
  return concat(parts);
}

/**
 * (round 128e, FT-51) The pieces without those of blocks still to build (marked LOOK_GHOST), and without the things set
 * down (props) on cells where nothing stands yet.
 */
function unbuiltOut(p: StructurePieces, inp: PieceInputs): StructurePieces {
  const keep: number[] = [];
  const d = p.data;
  for (let i = 0; i < p.count; i++) {
    const o = i * PIECE_FLOATS;
    if ((d[o + 13] | 0) & LOOK_GHOST) continue;
    if ((d[o + 15] | 0) & 2) {
      const c = inp.grid.cellAtWorld((d[o] + d[o + 2] + d[o + 4] + d[o + 6]) / 4, (d[o + 1] + d[o + 3] + d[o + 5] + d[o + 7]) / 4);
      if (c >= 0 && inp.plan.levels.any(c) && !inp.town.built.any(c)) continue;
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
export function plotsOf(inp: PieceInputs, defs: Record<StructureType, StructureDef> = DEFS): StructurePieces {
  const { plan, town, grid, zOff } = inp;
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
function ghostOver(p: StructurePieces, inp: PieceInputs, cp?: CityPlan): void {
  const { plan, town, grid, zOff } = inp;
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
function pickOver(p: StructurePieces, inp: PieceInputs): void {
  const d = p.data;
  for (let i = 0; i < p.count; i++) {
    const o = i * PIECE_FLOATS;
    const affine = ((d[o + 15] | 0) & 2) !== 0;
    // (an affine piece — a prop — has its translation in row 2's last column: x, y at 3, 7)
    const cx = affine ? d[o + 3] : (d[o] + d[o + 2] + d[o + 4] + d[o + 6]) / 4;
    const cy = affine ? d[o + 7] : (d[o + 1] + d[o + 3] + d[o + 5] + d[o + 7]) / 4;
    const c = inp.grid.cellAtWorld(cx, cy);
    if (c >= 0 && inp.plan.owner[c] === inp.picked) d[o + 15] = (d[o + 15] | 0) | PIECE_PICKED;
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
 * (round 128d: "Farms did not build for me") The fortress's fields drawn. Two causes: a crop is draped (DRAPE: laid on
 * the ground the host draws now, and hidden under it when any corner's ground is more than 1.5 off the plan's), and the
 * fortress's ground is the level's surface read, without the loose ground the GPU keeps on it (the drift the host's
 * ground adds) — more than 1.5 off round the fortress, so every field was hidden; and a crop's palette variant is a hash
 * of its look, two in five green — on grass a farm read as nothing. So the fortress's crops follow the host's ground
 * however far off it is (DRAPE_ANY), and are ripe: the look's low bits moved on until the variant is a ripe one.
 */
function ripen(p: StructurePieces): void {
  const crop = library().id('crop');
  for (let i = 0; i < p.count; i++) {
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

/**
 * (round 128d) The fortress's paving (its courtyards) follows the host's ground however far off it is, as its crops do
 * (ripen): the fortress's ground is the surface read without the loose ground on it.
 */
function drapeAny(p: StructurePieces): void {
  const pave = library().id('pave');
  for (let i = 0; i < p.count; i++) if (p.module[i] === pave) p.data[i * PIECE_FLOATS + 15] = (p.data[i * PIECE_FLOATS + 15] | 0) | DRAPE_ANY;
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

/** The fortress's cells of one style as a CityPlan (what piecesOf reads), and the pieces it has no rule for. */
export function cityPlanOf(
  inp: PieceInputs,
  style: StructureStyleId,
  defs: Record<StructureType, StructureDef> = DEFS,
  shapes: Shapes = shapesOf(inp.plan, inp.grid, (c) => inp.town.base[c], defs),
  ways: Ways = waysOf(inp.plan, inp.grid, shapes.courtyards.flatMap((ct) => ct.cells), defs),
  roads = true,
): { plan: CityPlan; extra: StructurePieces } {
  const { plan, town, grid, zOff } = inp;
  const nq = grid.count;
  const tiles: TileMesh = {
    verts: Float64Array.from(grid.verts),
    quads: Uint32Array.from(grid.quads),
    use: new Array<TileUse>(nq).fill('outside'),
    block: new Int32Array(nq).fill(-1),
  };
  const adj = adjacency(tiles);
  const ground = new Float64Array(grid.verts.length / 2);
  const groundDone = new Uint8Array(ground.length);
  const quadBuilding = new Int32Array(nq).fill(-1);
  const quadTop = new Float64Array(nq).fill(NaN);
  const buildings: BuildingRec[] = [];
  const facades: Facade[] = [];
  const roofRise: number[] = [];
  const props: Prop[] = [];
  const lib = library();
  const st = styleOf(style);
  const extra = new Extra();
  const ghostAt = (c: number, L: number) => inp.ghost?.(c, L) ?? false;
  const topOf = (c: number) => plan.top(c);
  const centre = (c: number): V2 => grid.centre(c);
  const groundAt = (x: number, y: number) => inp.ground(x, y) + zOff;
  /** how far a corner tile turns its run (radians): π less the angle between its middle's two ways out */
  const turn = (c: number): number => {
    const [cx, cy] = centre(c);
    const p = quadCorners(tiles, c);
    const ways: V2[] = [];
    for (let e = 0; e < 4; e++) {
      const n = adj[c * 4 + e];
      if (n < 0 || plan.typeAt(n) !== 'wall') continue;
      ways.push([(p[e][0] + p[(e + 1) % 4][0]) / 2 - cx, (p[e][1] + p[(e + 1) % 4][1]) / 2 - cy]);
    }
    if (ways.length !== 2) return Math.PI;
    const [a, b] = ways;
    const cos = (a[0] * b[0] + a[1] * b[1]) / (Math.hypot(...a) * Math.hypot(...b) || 1);
    return Math.PI - Math.acos(Math.max(-1, Math.min(1, cos)));
  };
  const mine = plan.structures().filter((s) => defs[s.type].look.style === style);
  const megas: MegaFeature[] = [];
  // (a courtyard is drawn with the style of the structure round it that the plan made first)
  const courtStyle = (ct: Courtyard) => {
    let id = Infinity;
    for (const c of ct.cells)
      for (let e = 0; e < 4; e++) {
        const o = plan.owner[grid.nbr[c * 4 + e]];
        if (o >= 0) id = Math.min(id, o);
      }
    return defs[plan.structure(id)!.type].look.style;
  };
  const courts = shapes.courtyards.filter((ct) => courtStyle(ct) === style);
  /** the courtyards' faces: a block's ground-floor side, an arch instead of its wall */
  const arched = new Set<number>();
  for (const ct of shapes.courtyards) for (const f of ct.faces) arched.add(f.cell * 4 + f.side);
  // (round 128d) the ways (ways.ts): roads and squares, the courtyards' paving apart (drawn with their style above)
  const courtCells = new Set(shapes.courtyards.flatMap((ct) => ct.cells));
  const paved: number[] = [];
  if (roads) for (let c = 0; c < nq; c++) if ((ways.way[c] === WAY_ROAD || ways.way[c] === WAY_SQUARE) && !courtCells.has(c)) paved.push(c);
  const doorOf = new Map(ways.doors.map((d) => [d.structure, d]));
  const myStairs = ways.stairs.filter((st) => mine.some((s) => s.id === st.structure));
  // the ground under every corner of the cells drawn
  const drawn = [...mine.flatMap((s) => [...s.cells.keys()]), ...courts.flatMap((ct) => ct.cells), ...paved, ...myStairs.flatMap((st) => [...st.cells, st.foot])];
  for (const c of drawn)
    for (let k = 0; k < 4; k++) {
      const v = grid.quads[c * 4 + k];
      if (groundDone[v]) continue;
      groundDone[v] = 1;
      ground[v] = groundAt(grid.verts[v * 2], grid.verts[v * 2 + 1]);
    }
  for (const s of mine) {
    const def = defs[s.type];
    const look = Math.floor(hashf(s.id, 31) * 4096);
    for (const c of s.cells.keys()) tiles.block[c] = s.id;
    if (def.form === 'yard') {
      for (const c of s.cells.keys()) tiles.use[c] = s.type === 'farm' ? 'field' : 'yard';
      // (round 128d: a farm read as nothing — a green crop on green grass, unfenced) a fence round the farm's edge
      if (s.type === 'farm')
        for (const c of s.cells.keys()) {
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
            extra.add(lib.id('fence'), band(a, b, 0.08), [ga, gb, gb, ga], 1.15, L2, REL | DRAPE | DRAPE_ANY);
          }
        }
    } else if (def.form === 'wall') {
      // (round 128d, the user: "walls can be thinner than a cell as long as the cells are marked as wall") a wall cell is
      // a thin wall by rules: a band from its middle to each side that meets a wall (or the keep), so runs, corners and
      // tees join; merlons along both faces; a tower where a run ends, turns or meets another, or where one was tapped;
      // a gate's arch in both faces of a straight run where marked. The cell is still the unit of planning and cost.
      for (const c of s.cells.keys()) {
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
        // level's floor, an arch in each face under it (a bridge between what holds it — FortressPlan.held)
        const bot = plan.levels.bottom(c);
        const zb = bot > 0 ? town.floorZ(c, bot) + zOff : lo - 0.6;
        // the middle: a square the bands meet in
        if (!plan.gate[c]) extra.add(lib.id('rampart'), square(x, y, WALL_HALF), zb, top, L2);
        for (const e of joined) {
          const m: V2 = [(p[e][0] + p[(e + 1) % 4][0]) / 2, (p[e][1] + p[(e + 1) % 4][1]) / 2];
          const f = band([x, y], m, WALL_HALF);
          if (plan.gate[c]) {
            // the passage crosses the run: an arch in each face, a lintel over it
            extra.add(lib.id('gatearch'), band(f[0], f[1], 0.45), lo - 0.3, top, L2);
            extra.add(lib.id('gatearch'), band(f[3], f[2], 0.45), lo - 0.3, top, L2);
            extra.add(lib.id('rampart'), f, top - WALL_LINTEL, top, L2);
          } else {
            extra.add(lib.id('rampart'), f, zb, top, L2);
            if (bot > 0) {
              extra.add(lib.id('gatearch'), band(f[0], f[1], 0.45), lo - 0.3, zb + 0.6, L2);
              extra.add(lib.id('gatearch'), band(f[3], f[2], 0.45), lo - 0.3, zb + 0.6, L2);
            }
          }
          // (a stair comes up on this cell's side: no merlons on that face — round 128d)
          const face = (a: V2, b: V2) => {
            const st = myStairs.find((q) => q.wall === c);
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
        if (auto || plan.tower[c]) extra.add(lib.id('tower'), square(x, y, 2.2), lo - 0.6, top + 2.4, L2);
      }
    } else if (def.form === 'keep') {
      // (round 128d) the fortress's keep: solid stone cells (the towns' rampart, crenellated where no keep cell is
      // beside), a tower at each outer corner
      const keepTop = (c: number) => town.floorZ(c, topOf(c)) + LEVEL_H + zOff;
      for (const c of s.cells.keys()) {
        tiles.use[c] = 'wall';
        quadTop[c] = keepTop(c);
      }
      // (round 128d) a keep cell standing above every keep cell beside it: a round turret (shapes.ts) — the keep's
      // stone up to its tallest neighbour, the turret's drum on up to the cell's own top, a spire on it
      for (const c of s.cells.keys()) {
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
      for (const c of s.cells.keys()) {
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
      }
    } else {
      // buildings: one a floor of the structure (its cells' floors line up), or one a cell for a type that doesn't join
      const groups = new Map<string, number[]>();
      for (const c of s.cells.keys()) {
        const key = def.joins ? String(town.base[c]) : `c${c}`;
        const g = groups.get(key) ?? [];
        g.push(c);
        groups.set(key, g);
      }
      // (round 128d) the door where the ways put it (ways.ts: the side facing the fortress's middle, on a free cell)
      const door0 = doorOf.get(s.id);
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
        // (round 128d) a landmark by its shape (shapes.ts): a lone cell stacked high a round tower and spire; four round a
        // corner, all one height, a domed drum — both drawn whole by the towns' rules (structures/pieces.ts megas), no
        // façades of their own
        const tower = cells.length === 1 && shapes.towers.has(cells[0]);
        const dome = cells.length === 4 ? shapes.domes.find((d) => d.cells.includes(cells[0])) : undefined;
        const mega = tower ? 'tower' : dome ? 'dome' : undefined;
        buildings.push({ id, kind: def.look.kind ?? 'house', quads: cells, base, storeys, storeyH: LEVEL_H, look, mega });
        if (dome) {
          const vx = grid.verts[dome.vertex * 2];
          const vy = grid.verts[dome.vertex * 2 + 1];
          // the patch's corners: each cell's corner opposite the shared one, counter-clockwise round it
          const outer = cells
            .map((c) => {
              const k = [0, 1, 2, 3].find((i) => grid.quads[c * 4 + i] === dome.vertex)!;
              const o = grid.quads[c * 4 + ((k + 2) % 4)];
              return [grid.verts[o * 2], grid.verts[o * 2 + 1]] as V2;
            })
            .sort((a, b) => Math.atan2(a[1] - vy, a[0] - vx) - Math.atan2(b[1] - vy, b[0] - vx));
          megas.push({ kind: 'dome', quads: cells, frame: [outer[0], outer[1], outer[2], outer[3]], z0: base, z1: quadTop[cells[0]] });
        }
        // the walls: each storey's sides no block of this building covers at that storey
        if (!mega)
        for (const c of cells)
          for (const L of plan.levels.each(c)) {
            for (let side = 0; side < 4; side++) {
              const n = adj[c * 4 + side];
              if (n >= 0 && quadBuilding[n] === id && plan.has(n, L)) continue;
              const z0 = town.floorZ(c, L) + zOff;
              // (round 128d) a side on a courtyard: an arch in the ground floor, not a wall (shapes.ts)
              if (L === 0 && arched.has(c * 4 + side)) {
                const p = quadCorners(tiles, c);
                extra.add(lib.id('gatearch'), sideBand(p[side], p[(side + 1) % 4], WALL_T), z0, z0 + LEVEL_H, ghostAt(c, 0) ? look | LOOK_GHOST : look);
                continue;
              }
              const door = L === 0 && !!door0 && door0.cell === c && door0.side === side;
              facades.push({ quad: c, side, level: L, z0, z1: z0 + LEVEL_H, kind: door ? 'door' : hashf(c, side, L) < 0.2 ? 'blank' : 'window', building: id });
            }
          }
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
        const kind = def.look.kind ?? 'house';
        roofRise.push((edge / ne) * (kind === 'house' ? st.pitch : kind === 'hut' ? 1.35 : kind === 'barn' ? 1.0 : 1.1) * 0.5);
        // a chimney on the building's tallest cell
        if (def.look.chimney && !mega) {
          let tc = cells[0];
          for (const c of cells) if (quadTop[c] > quadTop[tc]) tc = c;
          const [x, y] = centre(tc);
          extra.add(lib.id('chimney'), square(x, y, 0.7), quadTop[tc], quadTop[tc] + roofRise[id] + 2.4, ghostAt(tc, topOf(tc)) ? look | LOOK_GHOST : look);
        }
      }
    }
    // the type's things set down: on a yard in it, by a building at its first cell's open side
    const kinds = def.look.props ?? [];
    const cells = [...s.cells.keys()];
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
  // (round 128d) the courtyards (shapes.ts): paved; one cell a tree in the middle, more a fountain
  for (const ct of courts) {
    for (const c of ct.cells) tiles.use[c] = 'plaza';
    let x = 0;
    let y = 0;
    for (const c of ct.cells) {
      const [cx, cy] = centre(c);
      x += cx / ct.cells.length;
      y += cy / ct.cells.length;
    }
    const g = groundAt(x, y);
    if (ct.cells.length === 1) extra.add(lib.id('fruittree'), square(x, y, 2.0), g - 0.1, g + 4.4, Math.floor(hashf(ct.cells[0], 33) * 4096));
    else megas.push({ kind: 'fountain', quads: ct.cells.slice(), frame: square(x, y, 1.7), z0: g - 0.1, z1: g + 2.6 });
  }
  // (round 128d) the roads and squares (ways.ts): paved as the towns' streets and plazas (kerbs where they meet a lot); a
  // lamp on each square
  for (const c of paved) {
    tiles.use[c] = ways.way[c] === WAY_SQUARE ? 'plaza' : 'street';
    if (ways.way[c] !== WAY_SQUARE) continue;
    const [x, y] = centre(c);
    const p = quadCorners(tiles, c);
    const lx = x + (p[0][0] - x) * 0.6;
    const ly = y + (p[0][1] - y) * 0.6;
    props.push({ kind: 'lamp', at: [lx, ly, groundAt(lx, ly)], heading: 0, size: 3.2, seed: hashf(c, 61) });
  }
  // (round 128d) the stairs up onto the walls: stone steps along each stair's axis, from the wall's top down to its foot
  // cell's ground (as solid.ts claims them), see-through while the wall still stands to be built
  for (const st of myStairs) {
    const s = plan.structure(st.structure)!;
    const look = Math.floor(hashf(s.id, 31) * 4096);
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
  const cityPlan: CityPlan = {
    spec: { seed: 7, system: 'irregular', style, at: [0, 0], radius: 0 },
    tiles,
    ground,
    spans: [],
    buildings,
    facades,
    quadBuilding,
    quadTop,
    order: buildings.map((b) => b.id),
    roofRise,
    megas,
    linear: [],
    berths: [],
    props,
    lights: [],
    // (the fortress's nav is its ways', baked whole across styles: Fortress.nav — ways.ts waysNav)
    nav: { nodes: [], links: [] },
    stats: {},
  };
  return { plan: cityPlan, extra: extra.done() };
}

