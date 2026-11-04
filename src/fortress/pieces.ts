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
import { WALL_HALF, WALL_LINTEL } from './solid';

/** (round 128d) look bit 23: a block planned, not built yet — drawn see-through while building (structgame.wgsl) */
export const LOOK_GHOST = 1 << 23;
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
}

/** The pieces of every planned structure, in the box's frame (x, y box-local world units; z world). */
export function fortressPieces(inp: PieceInputs): StructurePieces {
  const defs = inp.defs ?? DEFS;
  const styles = new Set<StructureStyleId>();
  for (const s of inp.plan.structures()) styles.add(defs[s.type].look.style);
  // (round 128d) the painted shapes' landmarks: towers, domes, turrets, courtyards (shapes.ts)
  const shapes = shapesOf(inp.plan, inp.grid, (c) => inp.town.base[c], defs);
  const parts: StructurePieces[] = [];
  for (const style of styles) {
    const cp = cityPlanOf(inp, style, defs, shapes);
    const p = piecesOf(cp.plan);
    ripen(p);
    drapeAny(p);
    if (inp.ghost) ghostOver(p, inp);
    parts.push(p);
    parts.push(cp.extra);
  }
  return concat(parts);
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
function ghostOver(p: StructurePieces, inp: PieceInputs): void {
  const { plan, town, grid, zOff } = inp;
  const d = p.data;
  for (let i = 0; i < p.count; i++) {
    const o = i * PIECE_FLOATS;
    // (affine pieces — props — are set down beside: left as they are)
    if ((d[o + 15] | 0) & 2) continue;
    const cx = (d[o] + d[o + 2] + d[o + 4] + d[o + 6]) / 4;
    const cy = (d[o + 1] + d[o + 3] + d[o + 5] + d[o + 7]) / 4;
    const c = grid.cellAtWorld(cx, cy);
    if (c < 0 || !plan.levels.any(c)) continue;
    const foot = (d[o + 8] + d[o + 9] + d[o + 10] + d[o + 11]) / 4;
    const top = (d[o + 15] | 0) & 1 ? foot + d[o + 12] : d[o + 12];
    const top0 = plan.top(c);
    const L = Math.max(0, Math.min(top0, Math.floor(((foot + top) / 2 - zOff - town.base[c]) / LEVEL_H)));
    if (inp.ghost!(c, L)) d[o + 13] = (d[o + 13] | 0) | LOOK_GHOST;
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
  // the ground under every corner of the cells drawn
  const drawn = [...mine.flatMap((s) => [...s.cells.keys()]), ...courts.flatMap((ct) => ct.cells)];
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
          extra.add(lib.id('merlons'), band(f[0], f[1], 0.22), top, top + 1.1, L2);
          extra.add(lib.id('merlons'), band(f[3], f[2], 0.22), top, top + 1.1, L2);
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
      let doorDone = false;
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
              const door = L === 0 && !doorDone;
              if (door) doorDone = true;
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
    nav: { nodes: [], links: [] },
    stats: {},
  };
  return { plan: cityPlan, extra: extra.done() };
}

