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
import type { StructurePieces, BuildingRec, CityPlan, Facade, Prop, TileMesh, TileUse, V2, StructureStyleId } from '../api/contracts/structures';
import type { StructureDef, StructureType } from '../api/contracts/fortress';
import { LEVEL_H, MAX_LEVELS, type Town } from '../build/town';
import type { TownGrid } from '../build/towngrid';
import { PROP_SIZE } from '../structures/dressmodules';
import { library } from '../structures/modules';
import { PIECE_FLOATS, piecesOf } from '../structures/pieces';
import { hashf } from '../structures/rng';
import { styleOf } from '../structures/styles';
import { adjacency, quadCorners } from '../structures/tiles/builder';
import { DEFS } from './defs';
import { towered, type FortressPlan } from './plan';

export interface PieceInputs {
  plan: FortressPlan;
  town: Town;
  grid: TownGrid;
  /** the ground's top at a box-local point (the Town's frame) */
  ground(x: number, y: number): number;
  /** added to every height (the Town's window z → the world z the pieces are drawn in) */
  zOff: number;
  defs?: Record<StructureType, StructureDef>;
}

/** The pieces of every planned structure, in the box's frame (x, y box-local world units; z world). */
export function fortressPieces(inp: PieceInputs): StructurePieces {
  const defs = inp.defs ?? DEFS;
  const styles = new Set<StructureStyleId>();
  for (const s of inp.plan.structures()) styles.add(defs[s.type].look.style);
  const parts: StructurePieces[] = [];
  for (const style of styles) {
    const cp = cityPlanOf(inp, style, defs);
    parts.push(piecesOf(cp.plan));
    parts.push(cp.extra);
  }
  return concat(parts);
}

/** The towers on wall tiles that don't simply carry a run on, and the chimneys: pieces the CityPlan has no rule for. */
class Extra {
  module: number[] = [];
  data: number[] = [];
  add(mod: number, f: [V2, V2, V2, V2], foot: number, top: number, look: number): void {
    this.module.push(mod);
    this.data.push(f[0][0], f[0][1], f[1][0], f[1][1], f[2][0], f[2][1], f[3][0], f[3][1], foot, foot, foot, foot, top, look, 0, 0);
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

/** a square frame round (x, y), side 2h (counter-clockwise) */
function square(x: number, y: number, h: number): [V2, V2, V2, V2] {
  return [[x - h, y - h], [x + h, y - h], [x + h, y + h], [x - h, y + h]];
}

/** The fortress's cells of one style as a CityPlan (what piecesOf reads), and the pieces it has no rule for. */
export function cityPlanOf(inp: PieceInputs, style: StructureStyleId, defs: Record<StructureType, StructureDef> = DEFS): { plan: CityPlan; extra: StructurePieces } {
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
  const topOf = (c: number) => 31 - Math.clz32(plan.mask[c]);
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
  // the ground under every corner of the cells drawn
  for (const s of mine)
    for (const c of s.cells.keys())
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
    } else if (def.form === 'wall') {
      for (const c of s.cells.keys()) {
        tiles.use[c] = plan.gate[c] ? 'gate' : 'wall';
        quadTop[c] = town.floorZ(c, topOf(c)) + LEVEL_H + zOff;
      }
      // a tower where a run turns, ends or meets another (and on a lone post)
      for (const c of s.cells.keys()) {
        const tile = plan.wallTile(c, topOf(c));
        if (!tile || !towered(tile)) continue;
        // (a corner that only bends the run — the irregular grid's quads turn a little at every cell — has none: a
        // tower where it turns by more than 50 degrees)
        if (tile === 'corner' && turn(c) < (50 * Math.PI) / 180) continue;
        const [x, y] = centre(c);
        let lo = Infinity;
        for (let k = 0; k < 4; k++) lo = Math.min(lo, ground[grid.quads[c * 4 + k]]);
        extra.add(lib.id('tower'), square(x, y, 2.2), lo - 0.6, quadTop[c] + 2.4, look);
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
        buildings.push({ id, kind: def.look.kind ?? 'house', quads: cells, base, storeys, storeyH: LEVEL_H, look });
        // the walls: each storey's sides no block of this building covers at that storey
        for (const c of cells)
          for (let L = 0; L < MAX_LEVELS; L++) {
            if (!plan.has(c, L)) continue;
            for (let side = 0; side < 4; side++) {
              const n = adj[c * 4 + side];
              if (n >= 0 && quadBuilding[n] === id && plan.has(n, L)) continue;
              const z0 = town.floorZ(c, L) + zOff;
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
        if (def.look.chimney) {
          let tc = cells[0];
          for (const c of cells) if (quadTop[c] > quadTop[tc]) tc = c;
          const [x, y] = centre(tc);
          extra.add(lib.id('chimney'), square(x, y, 0.7), quadTop[tc], quadTop[tc] + roofRise[id] + 2.4, look);
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
    megas: [],
    linear: [],
    berths: [],
    props,
    lights: [],
    nav: { nodes: [], links: [] },
    stats: {},
  };
  return { plan: cityPlan, extra: extra.done() };
}

