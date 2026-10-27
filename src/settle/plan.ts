// A settlement realised (round 88, arrival scale): from its record, its people's profile and the ground in
// its box, the districts' grids, the buildings on their lots (Building + Instance records), the town wall,
// the plaza's well and stalls, the fields, an adapted ruin where it was founded over one, and a raiders'
// camp near some — and what each of those puts in the columns. Deterministic from the seed and the ground:
// the same settlement comes out the same whichever of its regions streams in first.
//
// Everything here is in the box's local coordinates (x cells, y world units; the box's first row even, so
// local rows have the world's parity). settlements.ts turns them into world and window coordinates.
import type { Building, Job, Settlement, SettlementGrid } from '../api/contracts/settlement';
import type { Instance, ThingEvent } from '../api/contracts/recipe';
import type { FactionId } from '../api/contracts/world';
import { derive } from '../api/contracts/compose';
import { Town, LEVEL_H, type Block } from '../build/town';
import { MAT } from '../world/materials';
import { ROW_H, cellAt, cellPos } from '../world/lattice';
import { LotGrid, rand, stylePolys, type Lot, type Pt } from './grids';
import { catalogue, type CivEntry } from './catalogue';
import { GrowthField } from './field';

export type Iv = { z0: number; z1: number; mat: number };

/** What a column of the box gets: everything above `lo` (world z) replaced by `ivs`; `bare`: no plants. */
export interface ColumnPlan {
  lo: number;
  ivs: Iv[];
  bare: boolean;
  /** the ground let down this much first (a well's shaft, a quarry's benches) */
  cut?: number;
  /** a gap cut through the column (world z): an adit into a hill, rock left over it */
  hole?: [number, number];
}

/** A place agents go to: a job's site, a home's door, a store's. */
export interface Spot {
  at: Pt;
  kind: Job['kind'] | 'home' | 'store' | 'post' | 'camp' | 'pile' | 'site';
  ref?: string;
  /** (a pile) what's heaped there */
  what?: string;
}

/** A house still to build (life.ts builds it block by block from the piles): its lot, its storeys. */
export interface SiteSpec {
  id: string;
  /** the lot's polygon (local) */
  poly: Pt[];
  storeys: number;
  door: Pt;
  /** the materials it's built in */
  wall: number;
  roof: number;
  /** (in play) blocks up, what's been brought toward the next, finished */
  done?: number;
  progress?: number;
  finished?: boolean;
  /** each cell's floor over the ground at the door, fixed when building began */
  floors?: number[];
}

/** The quarry: a terraced pit, or an adit into a hillside. */
export interface QuarrySpec {
  kind: 'pit' | 'adit';
  at: Pt;
  /** (adit) the way in, and the tunnel's floor (world z) */
  dir?: Pt;
  floor?: number;
}

export interface PlanInput {
  rec: Settlement;
  civ: CivEntry;
  camp: CivEntry | null;
  /** the camp's faction and record id (when it has one) */
  campFaction?: FactionId;
  campId?: string;
  seed: number;
  /** the site's setting (the atlas's) */
  setting: string;
  /** an older people's ruin it was founded over */
  ruin: boolean;
  /** the box: its world origin (cells, an even row) and size */
  box: { x0: number; y0: number; w: number; h: number };
  /** per box column: the ground's top (world z), the water on it, the top's material */
  ground: Float32Array;
  water: Float32Array;
  top: Uint8Array;
  /** per box column: the plants' succession (trees past 3.6: the woods' reach) */
  veg: Float32Array;
  sea: number;
}

export interface SettlementPlan {
  rec: Settlement;
  /** its camp's record, if it has one */
  camp: Settlement | null;
  things: Map<string, Instance>;
  /** box column → what it gets */
  columns: Map<number, ColumnPlan>;
  spots: Spot[];
  /** the districts' grids (for the debug view and the city game): by SettlementGrid id */
  grids: Map<string, LotGrid>;
  /** per lot what it was given (debug) */
  lotUse: Map<string, string>;
  /** the plaza's middle (local) */
  centre: Pt;
  campAt: Pt | null;
  sites: SiteSpec[];
  quarry: QuarrySpec | null;
  /** the settlement as a growth field over its box (field.ts): FIELD_CELL world units a cell, local */
  field: GrowthField;
  /** lots it may grow onto: their polygons, the field there when planned (life.ts makes them sites) */
  free: { poly: Pt[]; centre: Pt; door: Pt; v: number }[];
  ms: number;
}

/** world units a growth-field cell */
export const FIELD_CELL = 3;
/** the field's intensity at which a lot is built */
export const BUILT_V = 0.35;

/**
 * A settlement's suitability over its box, its growth field grown out from its middle for as long as it has
 * stood (by its size): flat, dry ground; better near water and near what it works (rock, the woods).
 */
export function growField(inp: PlanInput, centre: Pt, R: number): GrowthField {
  const W = inp.box.w;
  const H = inp.box.h;
  const fw = Math.ceil(W / FIELD_CELL);
  const fh = Math.ceil((H * ROW_H) / FIELD_CELL);
  const f = new GrowthField(fw, fh, 1);
  const colAt = (x: number, y: number) => {
    const [rx, ry] = cellAt(x, y);
    return rx < 0 || ry < 0 || rx >= W || ry >= H ? -1 : ry * W + rx;
  };
  // distances (cells of the field) to water, rock and woods: a sweep each way
  const N = fw * fh;
  const dist = (is: (col: number) => boolean) => {
    const d = new Float32Array(N).fill(1e6);
    for (let j = 0; j < fh; j++)
      for (let i = 0; i < fw; i++) {
        const col = colAt((i + 0.5) * FIELD_CELL, (j + 0.5) * FIELD_CELL);
        if (col >= 0 && is(col)) d[j * fw + i] = 0;
      }
    for (let pass = 0; pass < 2; pass++)
      for (let j0 = 0; j0 < fh; j0++)
        for (let i0 = 0; i0 < fw; i0++) {
          const j = pass ? fh - 1 - j0 : j0;
          const i = pass ? fw - 1 - i0 : i0;
          const c = j * fw + i;
          const st = pass ? 1 : -1;
          if (i - st >= 0 && i - st < fw) d[c] = Math.min(d[c], d[c - st] + 1);
          if (j - st >= 0 && j - st < fh) d[c] = Math.min(d[c], d[c - st * fw] + 1);
        }
    return d;
  };
  const dWater = dist((col) => inp.water[col] > 0.2);
  const dRock = dist((col) => inp.top[col] === MAT.Stone || inp.top[col] === MAT.Basalt || inp.top[col] === MAT.Sandstone);
  const dWood = dist((col) => inp.veg[col] > 3.6);
  const s = f.suit[0];
  for (let j = 0; j < fh; j++)
    for (let i = 0; i < fw; i++) {
      const x = (i + 0.5) * FIELD_CELL;
      const y = (j + 0.5) * FIELD_CELL;
      const col = colAt(x, y);
      if (col < 0) continue;
      const g = inp.ground[col];
      if (inp.water[col] > 0.05 || g < inp.sea + 0.6) continue;
      let slope = 0;
      for (const [dx, dy] of [[2, 0], [-2, 0], [0, 2], [0, -2]]) {
        const c2 = colAt(x + dx, y + dy);
        if (c2 >= 0) slope = Math.max(slope, Math.abs(inp.ground[c2] - g));
      }
      const flat = Math.max(0, 1 - slope / 3.5);
      const c = j * fw + i;
      const near = (d: number, l: number) => Math.exp(-(d * FIELD_CELL) / l);
      s[c] = Math.min(1, flat * (0.5 + 0.25 * near(dWater[c], 30) + 0.15 * near(dRock[c], 40) + 0.15 * near(dWood[c], 30)));
    }
  // grown from its middle for as long as it has stood: about its built radius
  f.seed(centre[0] / FIELD_CELL, centre[1] / FIELD_CELL, 0, 0.9, 2);
  f.step({ rate: 0.22, spread: 0.08, colonise: 0.3 }, Math.round((R / FIELD_CELL) * 7));
  return f;
}

/** how big a settlement is built, by its size: the built radius, its people */
const BUILT: Record<Settlement['size'], { R: number; people: number }> = {
  camp: { R: 8, people: 8 },
  hamlet: { R: 14, people: 10 },
  village: { R: 20, people: 16 },
  town: { R: 30, people: 36 },
  city: { R: 42, people: 70 },
};
/** the fields' band past the built radius */
export const FIELDS_BAND = 18;
/** how far a camp sits from the built edge */
export const CAMP_OFF = 24;
export const BOX_PAD = FIELDS_BAND + CAMP_OFF + 9;

export function builtRadius(size: Settlement['size']): number {
  return BUILT[size].R;
}

const USE_TAGS = new Set(['housing', 'store', 'smithy', 'meeting-hall', 'temple', 'defence', 'farm', 'trade']);

export function planSettlement(inp: PlanInput): SettlementPlan {
  const t0 = performance.now();
  const { rec, civ, box } = inp;
  const r = rand(inp.seed);
  const W = box.w;
  const H = box.h;
  const things = new Map<string, Instance>();
  const columns = new Map<number, ColumnPlan>();
  const spots: Spot[] = [];
  const lotUse = new Map<string, string>();
  const grids = new Map<string, LotGrid>();
  // the centre, local
  // (world = local + (x0, y0 × ROW_H): the box's first row is even)
  const ox = box.x0;
  const oy = box.y0 * ROW_H;
  const cx = rec.at[0] - ox;
  const cy = rec.at[1] - oy;
  const centre: Pt = [cx, cy];
  const colAt = (x: number, y: number) => {
    const [rx, ry] = cellAt(x, y);
    return rx < 0 || ry < 0 || rx >= W || ry >= H ? -1 : ry * W + rx;
  };
  const groundAt = (x: number, y: number) => {
    const c = colAt(x, y);
    return c < 0 ? inp.sea : inp.ground[c];
  };
  const built = BUILT[rec.size];
  const R = built.R;
  const run = 0;
  const made = (who: FactionId | null, note: string): ThingEvent[] => [{ what: 'made', run, by: who ? { faction: who } : undefined, note }];
  const thing = (t: Omit<Instance, 'history' | 'parts' | 'condition'> & Partial<Pick<Instance, 'history' | 'parts' | 'condition'>>): string => {
    things.set(t.id, { parts: [], condition: 1, history: made(rec.faction, `built at ${rec.name}`), ...t });
    return t.id;
  };
  const part = (owner: string, slot: string, kind: string, n: number) => {
    const id = `${owner}:${slot}${n}`;
    thing({ id, kind, owner: { settlement: rec.id, faction: rec.faction ?? undefined }, place: { in: 'thing', thing: owner, slot } });
    things.get(owner)!.parts.push({ slot, thing: id });
  };

  // ---- the districts: the profile's grids, the first at the core, a second round it in a town or bigger ----
  const styles = civ.profile.builds.grids;
  const two = styles.length > 1 && (rec.size === 'town' || rec.size === 'city');
  const coreR = two ? R * 0.58 : R;
  const sgrids: SettlementGrid[] = [];
  const spacingOf = (s: string) => (s === 'radial' ? 10.5 : s === 'orthogonal' ? 10 : s === 'irregular' ? 9.5 : 12);
  sgrids.push({ id: `${rec.id}:g0`, style: styles[0], seed: (inp.seed * 31 + 1) >>> 0, at: [rec.at[0], rec.at[1]], radius: coreR, spacing: spacingOf(styles[0]), spokes: 4 + Math.floor(r() * 3), contour: 3, angle: r() * Math.PI, purpose: 'core', civ: civ.profile.id });
  if (two) sgrids.push({ id: `${rec.id}:g1`, style: styles[1], seed: (inp.seed * 31 + 2) >>> 0, at: [rec.at[0], rec.at[1]], radius: R, spacing: spacingOf(styles[1]), spokes: 8, contour: 3, angle: r() * Math.PI, purpose: 'homes', civ: civ.profile.id });
  // the fields: a square lattice round the built edge
  sgrids.push({ id: `${rec.id}:fields`, style: 'orthogonal', seed: (inp.seed * 31 + 3) >>> 0, at: [rec.at[0], rec.at[1]], radius: R + FIELDS_BAND, spacing: 9, angle: r() * Math.PI, purpose: 'fields', civ: civ.profile.id });
  const lots: (Lot & { grid: string; gi: number })[] = [];
  const lotGrids: LotGrid[] = [];
  sgrids.forEach((g, gi) => {
    const prevR = gi === 0 ? 0 : sgrids[gi - 1].radius + (g.purpose === 'fields' ? 2.5 : 0);
    const P = stylePolys(g.style, centre, g.radius, g.spacing, { seed: g.seed, spokes: g.spokes, contour: g.contour, angle: g.angle, ground: groundAt });
    const lg = new LotGrid(W, H, P, g.purpose === 'fields' ? 0.92 : 0.6, gi === 0 ? undefined : (x, y) => Math.hypot(x - cx, y - cy) < prevR);
    for (const l of lg.lots) {
      l.r = Math.hypot(l.centre[0] - cx, l.centre[1] - cy);
      lots.push({ ...l, grid: g.id, gi });
    }
    grids.set(g.id, lg);
    lotGrids.push(lg);
  });
  rec.grids = sgrids;

  // ---- what each lot's ground is like ----------------------------------------------------------------------
  const lotGround = (lg: LotGrid, l: Lot) => {
    let lo = Infinity;
    let hi = -Infinity;
    let wet = 0;
    let n = 0;
    for (const c of l.inner)
      for (const col of lg.columns[c]) {
        const g = inp.ground[col];
        lo = Math.min(lo, g);
        hi = Math.max(hi, g);
        if (inp.water[col] > 0.2 || g < inp.sea + 0.6) wet++;
        n++;
      }
    return { lo, hi, wet: n ? wet / n : 1, n };
  };

  // ---- uses: the plaza, the hall, stores and works, houses; a ruin adapted; streets left open ---------------
  const coreLots = lots.filter((l) => l.gi < sgrids.length - 1);
  const fieldLots = lots.filter((l) => l.gi === sgrids.length - 1);
  const ok = coreLots.filter((l) => {
    if (l.street) return false;
    const g = lotGround(lotGrids[l.gi], l);
    return g.n > 4 && g.wet < 0.15 && g.hi - g.lo < 4.5;
  });
  ok.sort((a, b) => a.r - b.r);
  const people = built.people;
  // the settlement as a growth field: civic buildings at its middle, houses where it has grown strong
  const field = growField(inp, centre, R);
  const vAt = (p: Pt) => field.at(p[0] / FIELD_CELL, p[1] / FIELD_CELL).v;
  const houses = ok.length;
  type Use = 'hall' | 'granary' | 'workshop' | 'house' | 'ruin' | 'temple';
  const uses: { lot: (typeof ok)[number]; use: Use }[] = [];
  let k = 0;
  // (the nearest lot to the middle is the plaza in every style but the radial, whose middle is open already)
  const plazaLot = styles[0] === 'radial' ? null : ok.shift() ?? null;
  if (plazaLot) lotUse.set(`${plazaLot.grid}:${plazaLot.id}`, 'plaza');
  const order: Use[] = ['hall', 'granary'];
  if (inp.ruin) order.push('ruin');
  if ((civ.profile.knowledge.smithing ?? 'uses') !== 'uses') order.push('workshop');
  if (civ.profile.builds.architecture.includes('temple')) order.push('temple');
  for (const u of order) if (k < ok.length) uses.push({ lot: ok[k++], use: u });
  // the rest by the field, strongest first: built past BUILT_V; the next two are houses still to build (the
  // builders' work in play); the rest wait for the field to reach them
  const rest = ok.slice(k).map((l) => ({ l, v: vAt(l.centre) })).sort((a, b) => b.v - a.v);
  let h = 0;
  for (; h < rest.length && h < houses && rest[h].v >= BUILT_V; h++) uses.push({ lot: rest[h].l, use: 'house' });
  const siteLots = rest.slice(h, h + 2).filter((x) => x.v > 0.04).map((x) => x.l);
  const freeLots = rest.slice(h + siteLots.length).filter((x) => x.v > 0.001 || x.l.r < R);

  // its door: the middle of the yard quad nearest the plaza
  const doorOf = (lg: LotGrid, lot: Lot): Pt => {
    let best = lot.yard[0];
    let bd = Infinity;
    for (const c of lot.yard) {
      const [qx, qy] = lg.centre(c);
      const d = Math.hypot(qx - cx, qy - cy);
      if (d < bd) {
        bd = d;
        best = c;
      }
    }
    return lg.centre(best);
  };

  // ---- the towns (one a district) and their blocks ---------------------------------------------------------
  const io = { ground: (col: number) => inp.ground[col], stamp: () => {}, zMax: 1e5 };
  const towns = lotGrids.slice(0, -1).map((lg) => new Town(W, H, io, { grid: lg }));
  /** per district cell: the building it belongs to, and its materials */
  const cellLook = lotGrids.map(() => new Map<number, { wall: number; roof: number; broken?: number; patched?: number }>());
  const [s0, s1] = civ.profile.builds.storeys;
  const buildings: Building[] = [];
  const homeOf: string[] = [];
  let bn = 0;
  for (const { lot, use } of uses) {
    const gi = lot.gi;
    const town = towns[gi];
    const t = Math.min(1, lot.r / R);
    // (taller where the field is strong)
    let storeys = Math.round(s0 + (s1 - s0) * Math.min(1, Math.max(0, (vAt(lot.centre) - BUILT_V) / 0.45)) * (1 - 0.4 * t) + (r() - 0.5));
    storeys = Math.max(s0, Math.min(s1, storeys));
    if (use === 'hall') storeys = Math.min(s1 + 1, 4);
    if (use === 'granary') storeys = Math.max(1, s0);
    if (use === 'ruin') storeys = 5 + Math.floor(r() * 3);
    const blocks: Block[] = [];
    lot.inner.forEach((c, j) => {
      // (a corner a storey lower now and then: the roofline steps)
      const n = use === 'ruin' ? storeys - (j % 3 === 0 ? 1 + Math.floor(r() * 2) : 0) : storeys - (storeys > 1 && r() < 0.3 ? 1 : 0);
      for (let L = 0; L < n; L++) blocks.push({ cell: c, level: L });
    });
    town.set(blocks, true);
    const id = `${rec.id}:b${bn++}`;
    const kind = use === 'ruin' ? 'megastructure' : use === 'temple' ? 'hall' : use;
    const lk = civ.look;
    const look =
      use === 'hall' ? { wall: lk.foundation, roof: lk.roof }
      : use === 'granary' ? { wall: lk.trim, roof: lk.roof }
      : use === 'workshop' ? { wall: lk.wall, roof: lk.trim }
      : use === 'ruin' ? { wall: MAT.Concrete, roof: MAT.Concrete, broken: storeys, patched: Math.min(2, storeys) }
      : { wall: lk.wall, roof: lk.roof };
    for (const c of lot.inner) cellLook[gi].set(c, look);
    const [lx, ly] = lot.centre;
    const z = inp.ground[Math.max(0, colAt(lx, ly))];
    const place = { in: 'world' as const, region: rec.region, at: [lx + ox, ly + oy, z] as [number, number, number] };
    const owner = { settlement: rec.id, faction: rec.faction ?? undefined };
    if (use === 'ruin') {
      // an older people's tower: concrete, broken; its lower floors patched and lived in (adapted, not rebuilt)
      thing({ id, kind, name: `the old tower at ${rec.name}`, material: 'concrete', condition: 0.35, aged: 0.8, owner, place, history: [
        { what: 'made', run: -40, note: 'raised by a people long gone' },
        { what: 'broken', run: -12, note: 'its top fell in' },
        { what: 'adapted', run: -3, by: rec.faction ? { faction: rec.faction } : undefined, ref: 'apartments', note: `made into homes by ${civ.profile.name}` },
      ] });
      part(id, 'room', 'room', 0);
      part(id, 'room', 'room', 1);
      part(id, 'fitting', 'hearth', 0);
      rec.founded = { civ: 'the ancients', over: id };
    } else {
      thing({ id, kind, material: use === 'hall' ? civ.lookMat.foundation : use === 'granary' ? civ.lookMat.trim : civ.lookMat.wall, condition: 0.75 + 0.25 * r(), owner, place });
      if (use !== 'granary') part(id, 'room', 'room', 0);
      if (use === 'house') part(id, 'fitting', 'hearth', 0);
      if (use === 'hall') (part(id, 'fitting', 'hearth', 0), part(id, 'fitting', 'altar', 0));
      if (use === 'temple') part(id, 'fitting', 'altar', 0);
      if (use === 'granary') part(id, 'fitting', 'bin', 0);
      if (use === 'workshop') part(id, 'fitting', 'forge', 0);
    }
    const caps = derive(catalogue(things), id);
    const b: Building = { id, thing: id, grid: lot.grid, cells: lot.inner.slice(), storeys, use: caps.tags.filter((x) => USE_TAGS.has(x)), workers: use === 'workshop' ? ['smith'] : use === 'granary' ? ['hauler'] : undefined };
    if (use === 'temple') b.use.push('temple');
    buildings.push(b);
    lotUse.set(`${lot.grid}:${lot.id}`, use);
    const door = doorOf(lotGrids[gi], lot);
    if (b.use.includes('housing')) {
      spots.push({ at: door, kind: 'home', ref: id });
      homeOf.push(id);
    }
    if (b.use.includes('store')) spots.push({ at: door, kind: 'store', ref: id });
    if (use === 'hall') spots.push({ at: door, kind: 'post', ref: id }, { at: door, kind: 'store', ref: id });
    if (use === 'workshop') spots.push({ at: door, kind: 'make', ref: id });
    if (things.get(id)!.condition < 0.85) spots.push({ at: door, kind: 'repair', ref: id });
  }

  // the sites: their doors are where the builders bring what they carry
  const sites: SiteSpec[] = siteLots.map((lot, n) => {
    const door = doorOf(lotGrids[lot.gi], lot);
    const id = `${rec.id}:site${n}`;
    lotUse.set(`${lot.grid}:${lot.id}`, 'site');
    spots.push({ at: door, kind: 'site', ref: id });
    return { id, poly: lot.poly, storeys: Math.max(1, Math.min(2, s1)), door, wall: civ.look.wall, roof: civ.look.roof };
  });

  // ---- the columns: what the towns stand, in each building's materials ------------------------------------
  const setCol = (col: number, p: ColumnPlan) => {
    if (col < 0) return;
    const was = columns.get(col);
    if (!was) return void columns.set(col, p);
    // (a second thing in a column: kept above the first's top)
    const top = was.ivs.length ? was.ivs[was.ivs.length - 1].z1 : was.lo;
    for (const iv of p.ivs) if (iv.z0 >= top - 1e-3) was.ivs.push(iv);
    was.bare ||= p.bare;
  };
  towns.forEach((town, gi) => {
    const lg = lotGrids[gi];
    for (let c = 0; c < lg.count; c++) {
      const lk = cellLook[gi].get(c);
      if (!lk || !town.mask[c]) continue;
      const base = town.base[c];
      for (const col of lg.columns[c]) {
        const g = inp.ground[col];
        const ivs: Iv[] = [];
        if (base > g + 0.01) ivs.push({ z0: g, z1: base, mat: civ.look.foundation });
        const lx = col % W;
        const ly = Math.floor(col / W);
        const h = (((lx * 73856093) ^ (ly * 19349663)) >>> 0) / 4294967296;
        for (const iv of town.design(c, col)) {
          let mat = iv.mat === MAT.Tile ? lk.roof : lk.wall;
          if (lk.broken !== undefined) {
            // the ruin: no roof, its top floors gnawed; its patched floors in the people's own wall
            if (iv.mat === MAT.Tile) continue;
            const level = Math.floor((iv.z0 - base) / LEVEL_H);
            if (level >= lk.broken - 2 && h < 0.45) continue;
            if (level < (lk.patched ?? 0)) mat = civ.look.wall;
            else if (h > 0.8) mat = MAT.Rust;
          }
          ivs.push({ z0: iv.z0, z1: iv.z1, mat });
        }
        setCol(col, { lo: g, ivs, bare: true });
      }
    }
  });

  // ---- the plaza: a well and stalls -------------------------------------------------------------------------
  const plaza: Pt = plazaLot ? plazaLot.centre : centre;
  const disc = (at: Pt, rad: number, f: (col: number, d: number, x: number, y: number) => void) => {
    for (let y = at[1] - rad - 1; y <= at[1] + rad + 1; y += 0.4)
      for (let x = at[0] - rad - 1; x <= at[0] + rad + 1; x += 0.4) {
        const col = colAt(x, y);
        if (col < 0) continue;
        const [qx, qy] = cellPos(col % W, Math.floor(col / W));
        const d = Math.hypot(qx - at[0], qy - at[1]);
        if (d <= rad) f(col, d, qx, qy);
      }
  };
  const seen = new Set<number>();
  const once = (f: (col: number, d: number, x: number, y: number) => void) => (col: number, d: number, x: number, y: number) => {
    if (seen.has(col)) return;
    seen.add(col);
    f(col, d, x, y);
  };
  const well = thing({ id: `${rec.id}:well`, kind: 'well', material: civ.lookMat.foundation, owner: { settlement: rec.id }, place: { in: 'world', region: rec.region, at: [plaza[0] + ox, plaza[1] + oy, groundAt(...plaza)] } });
  disc(plaza, 1.9, once((col, d) => {
    const g = inp.ground[col];
    if (d < 0.7) setCol(col, { lo: g, ivs: [], bare: true, cut: 0.8 });
    else setCol(col, { lo: g, ivs: [{ z0: g, z1: g + 1.1, mat: civ.look.foundation }], bare: true });
  }));
  buildings.push({ id: well, thing: well, grid: sgrids[0].id, cells: [], storeys: 0, use: ['water'] });
  seen.clear();
  const stalls = rec.size === 'village' || rec.size === 'hamlet' ? 2 : 4;
  for (let s = 0; s < stalls; s++) {
    const a = (s / stalls) * Math.PI * 2 + r();
    const at: Pt = [plaza[0] + Math.cos(a) * 5, plaza[1] + Math.sin(a) * 5];
    const id = thing({ id: `${rec.id}:stall${s}`, kind: 'stall', material: 'canvas', owner: { settlement: rec.id }, place: { in: 'world', region: rec.region, at: [at[0] + ox, at[1] + oy, groundAt(...at)] } });
    buildings.push({ id, thing: id, grid: sgrids[0].id, cells: [], storeys: 1, use: ['trade'] });
    disc(at, 1.6, once((col, d) => {
      const g = inp.ground[col];
      const post = d > 1.1;
      setCol(col, { lo: g, ivs: post && (col & 1) === 0 ? [{ z0: g, z1: g + 2.2, mat: MAT.Wood }, { z0: g + 2.2, z1: g + 2.5, mat: MAT.Canvas }] : [{ z0: g + 2.2, z1: g + 2.5, mat: MAT.Canvas }], bare: true });
    }));
    spots.push({ at, kind: 'trade', ref: id });
  }
  spots.push({ at: plaza, kind: 'post', ref: well });

  // ---- the wall: a ring past the built edge, gates where the main ways go out --------------------------------
  const fortified = civ.profile.builds.architecture.includes('fortified') || (civ.profile.prefers.tags.fortified ?? 0) > 0.5 || rec.size === 'city';
  const gates: number[] = [];
  if (fortified && rec.size !== 'hamlet') {
    const Rw = R + 1.5;
    const ng = rec.size === 'village' ? 2 : 4;
    const a0 = r() * Math.PI * 2;
    for (let g = 0; g < ng; g++) gates.push(a0 + (g / ng) * Math.PI * 2);
    const wid = thing({ id: `${rec.id}:wall`, kind: 'wall', material: civ.lookMat.foundation, owner: { settlement: rec.id, faction: rec.faction ?? undefined }, place: { in: 'world', region: rec.region, at: [cx + ox, cy + oy, groundAt(cx, cy)] } });
    buildings.push({ id: wid, thing: wid, grid: sgrids[sgrids.length - 2].id, cells: [], storeys: 1, use: ['defence'] });
    seen.clear();
    disc(centre, Rw + 1, once((col, d, x, y) => {
      if (Math.abs(d - Rw) > 0.75) return;
      const a = Math.atan2(y - cy, x - cx);
      const gap = gates.some((ga) => Math.abs(Math.atan2(Math.sin(a - ga), Math.cos(a - ga))) * Rw < 2.2);
      const g = inp.ground[col];
      if (g < inp.sea + 0.5 || inp.water[col] > 0.3) return;
      const tower = gates.some((ga) => {
        const dd = Math.abs(Math.atan2(Math.sin(a - ga), Math.cos(a - ga))) * Rw;
        return dd >= 2.2 && dd < 4;
      });
      if (gap) return void setCol(col, { lo: g, ivs: [], bare: true });
      const top = g + (tower ? 6 : 3.4) + ((Math.floor(a * Rw) & 1) === 0 ? 0.8 : 0);
      setCol(col, { lo: g, ivs: [{ z0: g, z1: top, mat: civ.look.foundation }], bare: true });
    }));
    for (const ga of gates) spots.push({ at: [cx + Math.cos(ga) * (Rw - 2.5), cy + Math.sin(ga) * (Rw - 2.5)], kind: 'post', ref: wid });
  }

  // ---- fields: the outer lattice's flat dry lots, furrowed ---------------------------------------------------
  const flg = lotGrids[lotGrids.length - 1];
  const furrow = r() * Math.PI;
  const fc = Math.cos(furrow);
  const fs = Math.sin(furrow);
  let nf = 0;
  const farmers = Math.max(2, Math.round(people * 0.35));
  for (const l of fieldLots) {
    if (nf >= Math.max(3, farmers)) break;
    const cells = [...l.inner, ...l.yard];
    let lo = Infinity;
    let hi = -Infinity;
    let wet = 0;
    let n = 0;
    for (const c of cells)
      for (const col of flg.columns[c]) {
        const g = inp.ground[col];
        lo = Math.min(lo, g);
        hi = Math.max(hi, g);
        if (inp.water[col] > 0.1 || g < inp.sea + 0.8 || columns.has(col)) wet++;
        n++;
      }
    if (n < 10 || wet > 0 || hi - lo > 3.5) continue;
    const id = thing({ id: `${rec.id}:field${nf}`, kind: 'field', owner: { settlement: rec.id }, place: { in: 'world', region: rec.region, at: [l.centre[0] + ox, l.centre[1] + oy, lo] } });
    nf++;
    buildings.push({ id, thing: id, grid: l.grid, cells: cells.slice(), storeys: 0, use: ['farm'], workers: ['farmer'] });
    lotUse.set(`${l.grid}:${l.id}`, 'field');
    for (const c of l.inner)
      for (const col of flg.columns[c]) {
        const [x, y] = cellPos(col % W, Math.floor(col / W));
        const stripe = Math.floor((x * fc + y * fs) / 1.3) & 1;
        const g = inp.ground[col];
        // (furrows of soil; the rows between keep their green)
        if (stripe) setCol(col, { lo: g, ivs: [{ z0: g, z1: g + 0.3, mat: MAT.Soil }], bare: true });
      }
    spots.push({ at: l.centre, kind: 'farm', ref: id });
  }

  // ---- the piles: stone and logs heaped beside the hall, where the quarry's and the woods' loads go ----------
  const hallDoor = spots.find((x) => x.kind === 'post' && x.ref?.endsWith(':b0'))?.at ?? plaza;
  const away = Math.atan2(hallDoor[1] - cy, hallDoor[0] - cx);
  const piles: { at: Pt; what: string; mat: number }[] = [
    { at: [hallDoor[0] + Math.cos(away + 1.2) * 4.5, hallDoor[1] + Math.sin(away + 1.2) * 4.5], what: 'stone', mat: MAT.Rubble },
    { at: [hallDoor[0] + Math.cos(away - 1.2) * 4.5, hallDoor[1] + Math.sin(away - 1.2) * 4.5], what: 'log', mat: MAT.Log },
  ];
  for (const pl of piles) {
    seen.clear();
    disc(pl.at, 1.7, once((col, d) => {
      if (columns.has(col) || inp.water[col] > 0.1) return;
      const g = inp.ground[col];
      const h = pl.mat === MAT.Log ? (d < 1.3 ? 0.9 : 0) : 1.1 * (1 - d / 1.7);
      if (h > 0.05) setCol(col, { lo: g, ivs: [{ z0: g, z1: g + h, mat: pl.mat }], bare: true });
    }));
    spots.push({ at: pl.at, kind: 'pile', what: pl.what });
  }

  // ---- the quarry: into a hill where there's one near (an adit), else a terraced pit; spoil heaped by it -----
  // (mining outside the settlement's own region needs rights there: settlements.ts)
  let quarry: QuarrySpec | null = null;
  {
    let best: { at: Pt; s: number; dir: Pt; rise: number } | null = null;
    for (let ring = 0; ring < 3; ring++)
      for (let t = 0; t < 24; t++) {
        const a = (t / 24) * Math.PI * 2 + ring * 0.13;
        const d = R + 9 + ring * 7;
        const at: Pt = [cx + Math.cos(a) * d, cy + Math.sin(a) * d];
        const c0 = colAt(...at);
        if (c0 < 0 || columns.has(c0) || inp.water[c0] > 0.05 || inp.ground[c0] < inp.sea + 1) continue;
        let clash = false;
        disc(at, 8, (col) => {
          if (columns.has(col) || inp.water[col] > 0.1) clash = true;
        });
        if (clash) continue;
        // (the steepest rise within 10 cells: a hill to tunnel into)
        let rise = 0;
        let dir: Pt = [1, 0];
        for (let k = 0; k < 12; k++) {
          const b = (k / 12) * Math.PI * 2;
          const g = groundAt(at[0] + Math.cos(b) * 9, at[1] + Math.sin(b) * 9) - inp.ground[c0];
          if (g > rise) {
            rise = g;
            dir = [Math.cos(b), Math.sin(b)];
          }
        }
        const rock = inp.top[c0] === MAT.Stone || inp.top[c0] === MAT.Basalt || inp.top[c0] === MAT.Sandstone ? 2 : 0;
        const sc = rock + Math.min(rise, 10) * 0.4 + r() * 0.5 - ring * 0.3;
        if (!best || sc > best.s) best = { at, s: sc, dir, rise };
      }
    if (best) {
      const { at, dir } = best;
      const g0 = groundAt(...at);
      const spoil: Pt = [at[0] - dir[0] * 9 + dir[1] * 4, at[1] - dir[1] * 9 - dir[0] * 4];
      if (best.rise > 6) {
        // an adit: an apron cut level at the hill's foot, a tunnel 3 wide and 3 high into it, timbered at its mouth
        quarry = { kind: 'adit', at, dir, floor: g0 };
        seen.clear();
        disc([at[0] + dir[0] * 6, at[1] + dir[1] * 6], 13, once((col, _d, x, y) => {
          const u = (x - at[0]) * dir[0] + (y - at[1]) * dir[1];
          const v = Math.abs(-(x - at[0]) * dir[1] + (y - at[1]) * dir[0]);
          const g = inp.ground[col];
          if (u < -4 || u > 14 || v > 4) return;
          // (the apron: what's over the floor in front of the hill taken off)
          if (u < 1.5 && g > g0) return void setCol(col, { lo: g, ivs: [], bare: true, cut: g - g0 });
          if (v > 1.6 || u < 1.5) return;
          // the tunnel, under rock that stays over it; its mouth's frame: posts at the sides, a lintel
          if (g < g0 + 3.6) return void setCol(col, { lo: g, ivs: [], bare: true, cut: Math.max(0, g - g0) });
          setCol(col, { lo: g, ivs: [], bare: false, hole: [g0, g0 + 2.9] });
        }));
        for (const side of [-1.9, 1.9]) {
          const px = at[0] + dir[0] * 1.8 - dir[1] * side;
          const py = at[1] + dir[1] * 1.8 + dir[0] * side;
          const col = colAt(px, py);
          // (a post where the mouth's side is open air; inside the hill the rock is its side)
          const cp = col >= 0 ? columns.get(col) : undefined;
          if (cp && cp.cut !== undefined) cp.ivs = [{ z0: cp.lo - cp.cut, z1: g0 + 3.2, mat: MAT.Wood }];
        }
        spots.push({ at: [at[0] + dir[0] * 3, at[1] + dir[1] * 3], kind: 'mine', ref: 'adit' });
      } else {
        // a pit: benches a step down every two cells in, a ramp down one side, a crane at the rim
        quarry = { kind: 'pit', at, dir };
        const Rq = 7.5;
        seen.clear();
        disc(at, Rq, once((col, d, x, y) => {
          const g = inp.ground[col];
          let depth = 1.4 * Math.min(3, Math.ceil((Rq - d) / 2.2));
          const a = Math.atan2(y - at[1], x - at[0]);
          const ra = Math.atan2(dir[1], dir[0]);
          const off = Math.abs(Math.atan2(Math.sin(a - ra), Math.cos(a - ra)));
          // (the ramp: a sector that goes down evenly from the rim)
          if (off < 0.4) depth = Math.min(depth, 4.2 * (1 - d / Rq) + 0.2);
          setCol(col, { lo: g, ivs: [], bare: true, cut: depth });
        }));
        const mast: Pt = [at[0] - dir[0] * (Rq + 1.2), at[1] - dir[1] * (Rq + 1.2)];
        const mc = colAt(...mast);
        if (mc >= 0 && !columns.has(mc)) setCol(mc, { lo: inp.ground[mc], ivs: [{ z0: inp.ground[mc], z1: inp.ground[mc] + 7, mat: MAT.Wood }], bare: true });
        for (let k = 1; k <= 5; k++) {
          const bc = colAt(mast[0] + dir[0] * k * 0.9, mast[1] + dir[1] * k * 0.9);
          if (bc < 0 || bc === mc) continue;
          const cp = columns.get(bc);
          const top = cp ? cp.lo - (cp.cut ?? 0) : inp.ground[bc];
          const zb = inp.ground[mc] + 6.3;
          if (cp) cp.ivs.push({ z0: zb, z1: zb + 0.5, mat: MAT.Wood });
          else setCol(bc, { lo: top, ivs: [{ z0: zb, z1: zb + 0.5, mat: MAT.Wood }], bare: true });
        }
        spots.push({ at, kind: 'mine', ref: 'pit' });
      }
      // the spoil heap
      seen.clear();
      disc(spoil, 4, once((col, d) => {
        if (columns.has(col) || inp.water[col] > 0.1) return;
        const g = inp.ground[col];
        setCol(col, { lo: g, ivs: [{ z0: g, z1: g + 2.6 * (1 - d / 4) ** 1.3 + 0.1, mat: MAT.Rubble }], bare: true });
      }));
    }
  }
  const qBest = quarry ? 1 : -1;
  // (felling: the trees in reach when it comes to life — they're the sim's, not the plan's: settlements.ts)

  // ---- the camp: a few tents round a fire, out past the fields, where the ground's flat and dry -------------
  let campAt: Pt | null = null;
  let campRec: Settlement | null = null;
  if (inp.camp && inp.campId) {
    const dist = R + CAMP_OFF;
    let bestA = -1;
    let bestS = Infinity;
    for (let t = 0; t < 16; t++) {
      const a = (t / 16) * Math.PI * 2 + r() * 0.2;
      const at: Pt = [cx + Math.cos(a) * dist, cy + Math.sin(a) * dist];
      let lo = Infinity;
      let hi = -Infinity;
      let wet = false;
      disc(at, 6, (col) => {
        const g = inp.ground[col];
        lo = Math.min(lo, g);
        hi = Math.max(hi, g);
        if (inp.water[col] > 0.1 || g < inp.sea + 0.8 || columns.has(col)) wet = true;
      });
      if (!Number.isFinite(lo) || wet) continue;
      const s = hi - lo + r();
      if (s < bestS) {
        bestS = s;
        bestA = a;
      }
    }
    if (bestA >= 0) {
      campAt = [cx + Math.cos(bestA) * dist, cy + Math.sin(bestA) * dist];
      const look = inp.camp.look;
      const cid = inp.campId;
      const fire = thing({ id: `${cid}:fire`, kind: 'camp', owner: { settlement: cid, faction: inp.campFaction }, place: { in: 'world', region: rec.region, at: [campAt[0] + ox, campAt[1] + oy, groundAt(...campAt)] }, history: [{ what: 'made', run: -1, by: inp.campFaction ? { faction: inp.campFaction } : undefined, note: `pitched within a day's walk of ${rec.name}` }] });
      const cb: Building[] = [{ id: fire, thing: fire, grid: `${cid}:g0`, cells: [], storeys: 0, use: ['camp'] }];
      seen.clear();
      disc(campAt, 1, once((col) => setCol(col, { lo: inp.ground[col], ivs: [{ z0: inp.ground[col], z1: inp.ground[col] + 0.25, mat: MAT.Ash }], bare: true })));
      const tents = 4 + Math.floor(r() * 3);
      for (let t = 0; t < tents; t++) {
        const a = (t / tents) * Math.PI * 2 + r() * 0.5;
        const at: Pt = [campAt[0] + Math.cos(a) * 4.2, campAt[1] + Math.sin(a) * 4.2];
        const rad = 1.4 + r() * 0.6;
        const tid = `${cid}:tent${t}`;
        thing({ id: tid, kind: 'camp', material: 'canvas', condition: 0.6, owner: { settlement: cid, faction: inp.campFaction }, place: { in: 'world', region: rec.region, at: [at[0] + ox, at[1] + oy, groundAt(...at)] } });
        cb.push({ id: tid, thing: tid, grid: `${cid}:g0`, cells: [], storeys: 1, use: ['housing'] });
        disc(at, rad, once((col, d) => {
          const g = inp.ground[col];
          const h = 2.4 * (1 - d / rad) + 0.3;
          setCol(col, { lo: g, ivs: [{ z0: g, z1: g + h, mat: d > rad - 0.45 && (col & 3) === 0 ? look.trim : look.wall }], bare: true });
        }));
      }
      spots.push({ at: campAt, kind: 'camp', ref: cid });
      const n = rec.size === 'village' ? 5 : rec.size === 'town' ? 7 : 9;
      campRec = {
        id: cid,
        name: `the raiders' camp by ${rec.name}`,
        region: rec.region,
        faction: inp.campFaction ?? null,
        at: [campAt[0] + ox, campAt[1] + oy],
        radius: 8,
        size: 'camp',
        condition: 'thriving',
        grids: [{ id: `${cid}:g0`, style: 'orthogonal', seed: inp.seed + 7, at: [campAt[0] + ox, campAt[1] + oy], radius: 7, spacing: 4, purpose: 'camp', civ: inp.camp.profile.id }],
        buildings: cb,
        people: [{ role: 'raider', count: n, hostile: true }],
        stores: { loot: { stock: 0, rate: 0 } },
        needs: [{ kind: 'raid', at: [rec.at[0], rec.at[1]], ref: rec.id, priority: 1 }],
        founded: { civ: inp.camp.profile.id },
      };
    }
  }

  // ---- the record: buildings, people, stores, needs -------------------------------------------------------
  rec.buildings = buildings;
  const role = (name: string, f: number) => ({ role: name, count: Math.max(1, Math.round(people * f)) });
  rec.people = [role('farmer', 0.25), role('woodcutter', 0.2), role('miner', qBest >= 0 ? 0.2 : 0), role('builder', 0.2), role('guard', 0.15)].filter((p) => p.count > 0 && !(p.role === 'miner' && qBest < 0));
  const n = (rl: string) => rec.people.find((p) => p.role === rl)?.count ?? 0;
  rec.stores = {
    grain: { stock: people * 4, rate: n('farmer') * 2.2 - people },
    log: { stock: 20, rate: n('woodcutter') * 1.5 - n('builder') * 0.6 },
    stone: { stock: 10, rate: n('miner') * 1.2 - n('builder') * 0.4 },
    tools: { stock: 4, rate: (civ.profile.knowledge.smithing ?? 'uses') === 'uses' ? 0 : 0.2 },
  };
  rec.needs = spots.filter((s) => s.kind !== 'home' && s.kind !== 'store' && s.kind !== 'post' && s.kind !== 'camp' && s.kind !== 'pile' && s.kind !== 'site').map((s) => ({
    kind: s.kind as Job['kind'],
    at: [s.at[0] + ox, s.at[1] + oy],
    ref: s.ref,
    priority: s.kind === 'farm' ? 2 : s.kind === 'repair' ? 1.5 : 1,
  }));
  void homeOf;
  for (const st of sites) rec.needs.push({ kind: 'build', at: [st.door[0] + ox, st.door[1] + oy], ref: st.id, priority: 2 });
  const free = freeLots.map(({ l, v }) => ({ poly: l.poly, centre: l.centre, door: doorOf(lotGrids[l.gi], l), v }));
  return { rec, camp: campRec, things, columns, spots, grids, lotUse, centre, campAt, sites, quarry, field, free, ms: +(performance.now() - t0).toFixed(1) };
}
