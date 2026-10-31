// A settlement realised (round 88, arrival scale; round 119: on the structures contract): from its record, its people's
// profile and the ground in its box — its town and farmland planned by the structures system (contracts/structures.ts:
// tiles, buildings by the density of its growth field, façades, walls, landmarks), each building's record (Building +
// Instance), the plaza's well and stalls, the fields' jobs, an adapted ruin where it was founded over one, the quarry, a
// raiders' camp near some — and what the ground works put in the columns (the buildings are pieces: drawn, and claimed
// as External columns in play by view.ts, not stamped into the land). Deterministic from the seed and the ground:
// the same settlement comes out the same whichever of its regions streams in first.
//
// Everything here is in the box's local coordinates (x cells, y world units; the box's first row even, so
// local rows have the world's parity). settlements.ts turns them into world and window coordinates.
import type { Building, Job, Settlement } from '../api/contracts/settlement';
import type { Instance, ThingEvent } from '../api/contracts/recipe';
import type { FactionId } from '../api/contracts/world';
import { derive } from '../api/contracts/compose';
import { MAT } from '../world/materials';
import { ROW_H, cellAt, cellPos } from '../world/lattice';
import { rand, type Pt } from './grids';
import type { BuildingRec, CityPlan, CitySpec, DensityFn, StructureStyleId, V2 } from '../api/contracts/structures';
import { planCity } from '../structures/plan';
import { columnsOf } from '../structures/columns';
import { fbm } from '../structures/rng';
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
/** A house still to build (life.ts has it built storey by storey from the piles): a building of the town's plan. */
export interface SiteSpec {
  id: string;
  /** its building in the plan (contracts/structures.ts BuildingRec id) */
  building: number;
  storeys: number;
  door: Pt;
  /** (in play) storeys up, what's been brought toward the next, finished */
  done?: number;
  progress?: number;
  finished?: boolean;
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
  /** the atlas region at a local point (a quarry in its own region needs no rights) */
  regionAt?: (x: number, y: number) => number;
  sea: number;
  /** (the level's ?city= override: this settlement's town planned with another tile system or style) */
  override?: Partial<CitySpec>;
}

export interface SettlementPlan {
  rec: Settlement;
  /** its camp's record, if it has one */
  camp: Settlement | null;
  things: Map<string, Instance>;
  /** box column → what the ground works put there (stalls, piles, the quarry, the camp; not the buildings) */
  columns: Map<number, ColumnPlan>;
  spots: Spot[];
  /** the town and its farmland: the structures plan in the box's frame (local x, y) */
  city: CityPlan;
  /** per building of the plan: storeys standing (0: not built yet — a site or room to grow) */
  standing: Int32Array;
  /** the box's width in columns (its frame's) */
  boxW: number;
  /** per building (`b<id>`) or field (`f<n>`) what it was given (debug) */
  lotUse: Map<string, string>;
  /** the plaza's middle (local) */
  centre: Pt;
  campAt: Pt | null;
  sites: SiteSpec[];
  quarry: QuarrySpec | null;
  /** the settlement as a growth field over its box (field.ts): FIELD_CELL world units a cell, local */
  field: GrowthField;
  /** buildings it may grow onto, in its build order: their middles, doors, the field there when planned (grow() makes
   *  them sites) */
  free: { building: number; centre: Pt; door: Pt; v: number }[];
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
/** the farmland's band past the built radius (round 119: crop strips, orchards, pastures, farmsteads) */
export const FARM_BAND = 36;
/** (the old name: the fields' band) */
export const FIELDS_BAND = FARM_BAND;
/** how far a camp sits from the built edge: past the farmland */
export const CAMP_OFF = FARM_BAND + 8;
export const BOX_PAD = CAMP_OFF + 13;
/** how much of a town its size lets be dense (a hamlet's middle is huts, a city's town houses) */
const SIZE_K: Record<Settlement['size'], number> = { camp: 0.3, hamlet: 0.36, village: 0.46, town: 0.8, city: 1 };
/** the share of a town's own buildings (its build order) standing when it's first planned: the rest its frontier */
const FRONTIER_UP = 0.9;
type Use = 'hall' | 'granary' | 'workshop' | 'house' | 'ruin' | 'temple';

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
  // the centre, local
  // (world = local + (x0, y0 × ROW_H): the box's first row is even)
  const ox = box.x0;
  const oy = box.y0 * ROW_H;
  let cx = rec.at[0] - ox;
  let cy = rec.at[1] - oy;
  const centre: Pt = [cx, cy];
  const colAt = (x: number, y: number) => {
    const [rx, ry] = cellAt(x, y);
    return rx < 0 || ry < 0 || rx >= W || ry >= H ? -1 : ry * W + rx;
  };
  const groundAt = (x: number, y: number) => {
    const c = colAt(x, y);
    if (c >= 0) return inp.ground[c];
    // (past the box — a farm's far corner, a centre moved to dry ground — the box's nearest column: never the sea's
    // floor, which warped a field's strip from the ground down to it)
    const [rx, ry] = cellAt(x, y);
    return inp.ground[Math.min(H - 1, Math.max(0, ry)) * W + Math.min(W - 1, Math.max(0, rx))];
  };
  const built = BUILT[rec.size];
  const R = built.R;
  // (a river town's site is on its river: its middle moved to the nearest dry, level ground beside it — the record
  // says where it stands)
  const dryAt = (x: number, y: number) => {
    let lo = Infinity;
    let hi = -Infinity;
    for (let k = 0; k < 9; k++) {
      const a = (k / 9) * Math.PI * 2;
      const d = k === 0 ? 0 : 6;
      const c = colAt(x + Math.cos(a) * d, y + Math.sin(a) * d);
      if (c < 0 || inp.water[c] > 0.05 || inp.ground[c] < inp.sea + 0.8) return Infinity;
      lo = Math.min(lo, inp.ground[c]);
      hi = Math.max(hi, inp.ground[c]);
    }
    return hi - lo;
  };
  if (dryAt(cx, cy) > 3) {
    search: for (let d = 3; d <= R * 1.5; d += 3)
      for (let k = 0; k < 16; k++) {
        const a = (k / 16) * Math.PI * 2;
        const x = cx + Math.cos(a) * d;
        const y = cy + Math.sin(a) * d;
        if (dryAt(x, y) <= 3) {
          cx = x;
          cy = y;
          break search;
        }
      }
    centre[0] = cx;
    centre[1] = cy;
    rec.at = [cx + ox, cy + oy];
  }
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

  // ---- the settlement as a growth field (field.ts): where its people are, and so what's built where -----------------
  const field = growField(inp, centre, R);
  const vAt = (p: Pt) => field.at(p[0] / FIELD_CELL, p[1] / FIELD_CELL).v;
  const people = built.people;

  // ---- the quarry's place first: its pit (or adit's apron) and its spoil kept out of the farmland -----------------
  const quarrySpot = chooseQuarry(inp, centre, R, colAt, groundAt, disc, r);

  // ---- the town and its farmland: the structures planner (contracts/structures.ts, round 119: "have them actually use
  // the new structures") on the box's ground, the density from the growth field — dense: town houses; thinner: huts;
  // thinnest: farmland with its farmsteads
  const styles = civ.profile.builds.grids;
  const [s0, s1] = civ.profile.builds.storeys;
  const fortified = civ.profile.builds.architecture.includes('fortified') || (civ.profile.prefers.tags.fortified ?? 0) > 0.5 || rec.size === 'city';
  const sizeK = SIZE_K[rec.size];
  const farmR = R + FARM_BAND;
  const density: DensityFn = (x, y) => {
    const town = Math.min(1, Math.max(0, (vAt([x, y]) - 0.08) / 0.72)) * sizeK;
    const d = Math.hypot(x - cx, y - cy);
    // (the country round it: a few people out to the farmland's edge, thinning — farmsteads, not nobody)
    const country = 0.17 * Math.max(0, Math.min(1, (farmR - d) / (farmR - R))) * (0.4 + 0.9 * fbm(x * 0.012, y * 0.012, inp.seed + 4));
    return Math.min(1, town + country);
  };
  const water = (x: number, y: number) => {
    const c = colAt(x, y);
    return c < 0 ? 0 : Math.max(inp.water[c], inp.sea - inp.ground[c]);
  };
  const keepOut: { at: V2; r: number }[] = [];
  if (quarrySpot) keepOut.push({ at: quarrySpot.at, r: 10 }, { at: quarrySpot.spoil, r: 6 });
  const spec: CitySpec = {
    seed: inp.seed,
    system: styles[0],
    style: styleFor(civ),
    at: [cx, cy],
    radius: R,
    tile: rec.size === 'hamlet' || rec.size === 'village' ? 3.6 : 4,
    storeys: [s1 + 0.6, s0],
    walls: fortified && rec.size !== 'hamlet',
    roads: 0,
    farmland: farmR,
    keepOut,
    ...inp.override,
  };
  const city = planCity(spec, groundAt, water, density);
  rec.grids = [
    { id: `${rec.id}:g0`, style: spec.system, seed: spec.seed, at: [rec.at[0], rec.at[1]], radius: R, spacing: spec.tile ?? 4, purpose: 'core', civ: civ.profile.id },
    { id: `${rec.id}:fields`, style: 'contour-voronoi', seed: spec.seed + 1, at: [rec.at[0], rec.at[1]], radius: farmR, spacing: 26, purpose: 'fields', civ: civ.profile.id },
  ];

  // ---- what each building is: the hall, the granary, the workshop, the temple, an adapted ruin; houses and huts; the
  // farmsteads' farmhouses and barns (barns are granaries) — the record's Buildings and Instances, their doors as spots
  const townB = city.buildings.filter((b) => b.kind === 'house' || b.kind === 'hut');
  const dist = (b: BuildingRec) => {
    const [x, y] = buildingCentre(city, b);
    return Math.hypot(x - cx, y - cy);
  };
  const byMiddle = townB.filter((b) => !b.mega).sort((a, b) => dist(a) - dist(b));
  const useOf = new Map<number, Use>();
  const take = (u: Use, pick?: BuildingRec) => {
    const b = pick ?? byMiddle.find((x) => !useOf.has(x.id));
    if (b) useOf.set(b.id, u);
  };
  take('hall', byMiddle.find((b) => b.quads.length >= 2));
  take('granary');
  if ((civ.profile.knowledge.smithing ?? 'uses') !== 'uses') take('workshop');
  const dome = city.buildings.find((b) => b.mega === 'dome');
  if (civ.profile.builds.architecture.includes('temple') || dome) take('temple', dome);
  const tower = city.buildings.find((b) => b.mega === 'tower');
  if (inp.ruin && tower) take('ruin', tower);
  for (const b of city.buildings) if (!useOf.has(b.id)) useOf.set(b.id, b.kind === 'barn' ? 'granary' : 'house');

  // the frontier: the town's last buildings in its build order aren't up yet — the next two are sites (the builders'
  // work in play), the rest wait for it to grow (the farmsteads stand: the country is older than the town's edge)
  const standing = new Int32Array(city.buildings.length);
  for (const b of city.buildings) standing[b.id] = b.storeys;
  const frontier = city.order.filter((id) => {
    const b = city.buildings[id];
    return (b.kind === 'house' || b.kind === 'hut') && !b.mega && useOf.get(id) === 'house';
  });
  const nUp = Math.round(frontier.length * FRONTIER_UP);
  const siteIds = frontier.slice(nUp, nUp + 2);
  const freeIds = frontier.slice(nUp + 2);
  for (const id of [...siteIds, ...freeIds]) standing[id] = 0;
  const doorAt = (b: BuildingRec): Pt => doorOf(city, b) ?? buildingCentre(city, b);

  const buildings: Building[] = [];
  const homeOf: string[] = [];
  for (const b of city.buildings) {
    if (!standing[b.id]) continue;
    const use = useOf.get(b.id)!;
    const id = `${rec.id}:b${b.id}`;
    const kind = use === 'ruin' ? 'megastructure' : use === 'temple' ? 'hall' : use;
    const [lx, ly] = buildingCentre(city, b);
    const place = { in: 'world' as const, region: rec.region, at: [lx + ox, ly + oy, b.base] as [number, number, number] };
    const owner = { settlement: rec.id, faction: rec.faction ?? undefined };
    if (use === 'ruin') {
      // an older people's tower, its lower floors lived in (adapted, not rebuilt)
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
    const rb: Building = { id, thing: id, grid: rec.grids[b.kind === 'farmhouse' || b.kind === 'barn' ? 1 : 0].id, cells: b.quads.slice(), storeys: b.storeys, use: caps.tags.filter((x) => USE_TAGS.has(x)), workers: use === 'workshop' ? ['smith'] : use === 'granary' ? ['hauler'] : undefined };
    if (use === 'temple') rb.use.push('temple');
    buildings.push(rb);
    lotUse.set(`b${b.id}`, use);
    const door = doorAt(b);
    if (rb.use.includes('housing')) {
      spots.push({ at: door, kind: 'home', ref: id });
      homeOf.push(id);
    }
    if (rb.use.includes('store')) spots.push({ at: door, kind: 'store', ref: id });
    if (use === 'hall') spots.push({ at: door, kind: 'post', ref: id }, { at: door, kind: 'store', ref: id });
    if (use === 'workshop') spots.push({ at: door, kind: 'make', ref: id });
    if (things.get(id)!.condition < 0.85) spots.push({ at: door, kind: 'repair', ref: id });
  }

  // the sites: their doors are where the builders bring what they carry
  const sites: SiteSpec[] = siteIds.map((bid, n) => {
    const b = city.buildings[bid];
    const door = doorAt(b);
    const id = `${rec.id}:site${n}`;
    lotUse.set(`b${bid}`, 'site');
    spots.push({ at: door, kind: 'site', ref: id });
    return { id, building: bid, storeys: b.storeys, door };
  });

  // ---- the plaza: the fountain (the town's well) and stalls --------------------------------------------------------
  const fountain = city.megas.find((m) => m.kind === 'fountain');
  const plaza: Pt = fountain ? [(fountain.frame[0][0] + fountain.frame[2][0]) / 2, (fountain.frame[0][1] + fountain.frame[2][1]) / 2] : centre;
  const seen = new Set<number>();
  const once = (f: (col: number, d: number, x: number, y: number) => void) => (col: number, d: number, x: number, y: number) => {
    if (seen.has(col)) return;
    seen.add(col);
    f(col, d, x, y);
  };
  const setCol = (col: number, p: ColumnPlan) => {
    if (col < 0) return;
    const was = columns.get(col);
    if (!was) return void columns.set(col, p);
    // (a second thing in a column: kept above the first's top)
    const top = was.ivs.length ? was.ivs[was.ivs.length - 1].z1 : was.lo;
    for (const iv of p.ivs) if (iv.z0 >= top - 1e-3) was.ivs.push(iv);
    was.bare ||= p.bare;
  };
  const well = thing({ id: `${rec.id}:well`, kind: 'well', material: civ.lookMat.foundation, owner: { settlement: rec.id }, place: { in: 'world', region: rec.region, at: [plaza[0] + ox, plaza[1] + oy, groundAt(...plaza)] } });
  buildings.push({ id: well, thing: well, grid: rec.grids[0].id, cells: [], storeys: 0, use: ['water'] });
  const stalls = rec.size === 'village' || rec.size === 'hamlet' ? 2 : 4;
  for (let s = 0; s < stalls; s++) {
    const a = (s / stalls) * Math.PI * 2 + r();
    const at: Pt = [plaza[0] + Math.cos(a) * 5, plaza[1] + Math.sin(a) * 5];
    const id = thing({ id: `${rec.id}:stall${s}`, kind: 'stall', material: 'canvas', owner: { settlement: rec.id }, place: { in: 'world', region: rec.region, at: [at[0] + ox, at[1] + oy, groundAt(...at)] } });
    buildings.push({ id, thing: id, grid: rec.grids[0].id, cells: [], storeys: 1, use: ['trade'] });
    disc(at, 1.6, once((col, d) => {
      const g = inp.ground[col];
      const post = d > 1.1;
      setCol(col, { lo: g, ivs: post && (col & 1) === 0 ? [{ z0: g, z1: g + 2.2, mat: MAT.Wood }, { z0: g + 2.2, z1: g + 2.5, mat: MAT.Canvas }] : [{ z0: g + 2.2, z1: g + 2.5, mat: MAT.Canvas }], bare: true });
    }));
    spots.push({ at, kind: 'trade', ref: id });
  }
  spots.push({ at: plaza, kind: 'post', ref: well });

  // ---- the wall's gates: posts where the wall runs end (structures' walls: linear.ts / the radial rampart) ---------
  const wallRuns = city.linear.filter((f) => f.kind === 'wall');
  if (wallRuns.length || city.tiles.use.includes('gate')) {
    const wid = thing({ id: `${rec.id}:wall`, kind: 'wall', material: civ.lookMat.foundation, owner: { settlement: rec.id, faction: rec.faction ?? undefined }, place: { in: 'world', region: rec.region, at: [cx + ox, cy + oy, groundAt(cx, cy)] } });
    buildings.push({ id: wid, thing: wid, grid: rec.grids[0].id, cells: [], storeys: 1, use: ['defence'] });
    for (const f of wallRuns) if (!f.closed) for (const p of [f.points[0], f.points[f.points.length - 1]]) spots.push({ at: [p[0] + (cx - p[0]) * 0.08, p[1] + (cy - p[1]) * 0.08], kind: 'post', ref: wid });
    for (let q = 0; q < city.tiles.use.length; q++) if (city.tiles.use[q] === 'gate') spots.push({ at: quadCentreOf(city, q), kind: 'post', ref: wid });
  }

  // ---- fields: the farmland's crop plots (a field thing each, a farm job at its middle), nearest the town first -------
  const plots = new Map<number, { x: number; y: number; n: number; cells: number[] }>();
  city.tiles.use.forEach((u, q) => {
    if (u !== 'field' && u !== 'orchard') return;
    const [x, y] = quadCentreOf(city, q);
    const b = city.tiles.block[q];
    const p = plots.get(b) ?? plots.set(b, { x: 0, y: 0, n: 0, cells: [] }).get(b)!;
    p.x += x;
    p.y += y;
    p.n++;
    p.cells.push(q);
  });
  const farmers = Math.max(3, Math.round(people * 0.35));
  const plotList = [...plots.values()].map((p) => ({ ...p, at: [p.x / p.n, p.y / p.n] as Pt })).sort((a, b) => Math.hypot(a.at[0] - cx, a.at[1] - cy) - Math.hypot(b.at[0] - cx, b.at[1] - cy));
  plotList.slice(0, farmers).forEach((p, nf) => {
    const id = thing({ id: `${rec.id}:field${nf}`, kind: 'field', owner: { settlement: rec.id }, place: { in: 'world', region: rec.region, at: [p.at[0] + ox, p.at[1] + oy, groundAt(...p.at)] } });
    buildings.push({ id, thing: id, grid: rec.grids[1].id, cells: p.cells, storeys: 0, use: ['farm'], workers: ['farmer'] });
    lotUse.set(`f${nf}`, 'field');
    spots.push({ at: p.at, kind: 'farm', ref: id });
  });

  // ---- bare ground: no plants on the crop strips, the streets, the plaza and under the buildings (the old stamps had
  // them bare too: a field's crop is its own, not the meadow's tufts through it)
  {
    const t = city.tiles;
    const bareUse = new Set(['field', 'street', 'plaza', 'gate']);
    for (let q = 0; q < t.use.length; q++) {
      if (!bareUse.has(t.use[q]) && city.quadBuilding[q] < 0) continue;
      const ps: Pt[] = [0, 1, 2, 3].map((k) => [t.verts[t.quads[q * 4 + k] * 2], t.verts[t.quads[q * 4 + k] * 2 + 1]]);
      const [r0] = [cellAt(Math.min(...ps.map((p) => p[0])), Math.min(...ps.map((p) => p[1])))[1]];
      const r1 = cellAt(Math.max(...ps.map((p) => p[0])), Math.max(...ps.map((p) => p[1])))[1];
      const x0 = Math.min(...ps.map((p) => p[0]));
      const x1 = Math.max(...ps.map((p) => p[0]));
      for (let ry = r0 - 1; ry <= r1 + 1; ry++)
        for (let rx = Math.floor(x0) - 1; rx <= Math.ceil(x1) + 1; rx++) {
          if (rx < 0 || ry < 0 || rx >= W || ry >= H) continue;
          const [px, py] = cellPos(rx, ry);
          if (!inQuad(ps, px, py)) continue;
          const col = ry * W + rx;
          if (columns.has(col)) continue;
          columns.set(col, { lo: inp.ground[col], ivs: [], bare: true });
        }
    }
  }

  // ---- the piles: stone and logs heaped beside the hall, where the quarry's and the woods' loads go ----------
  const hallDoor = spots.find((x) => x.kind === 'post' && x.ref !== undefined && lotUse.get(`b${x.ref.split(':b').pop()}`) === 'hall')?.at ?? plaza;
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
    const best = quarrySpot;
    if (best) {
      const { at, dir } = best;
      const g0 = groundAt(...at);
      const spoil: Pt = best.spoil;
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
  const free = freeIds.map((bid) => {
    const b = city.buildings[bid];
    const c = buildingCentre(city, b);
    return { building: bid, centre: c, door: doorAt(b), v: vAt(c) };
  });
  return { rec, camp: campRec, things, columns, spots, city, standing, boxW: W, lotUse, centre, campAt, sites, quarry, field, free, ms: +(performance.now() - t0).toFixed(1) };
}

// ---- helpers: the town's buildings and tiles in the box's frame ------------------------------------------------------

/** a tile's middle */
export function quadCentreOf(city: CityPlan, q: number): Pt {
  const t = city.tiles;
  let x = 0;
  let y = 0;
  for (let k = 0; k < 4; k++) {
    const v = t.quads[q * 4 + k];
    x += t.verts[v * 2] / 4;
    y += t.verts[v * 2 + 1] / 4;
  }
  return [x, y];
}

/** a building's middle (its tiles' middles averaged) */
export function buildingCentre(city: CityPlan, b: BuildingRec): Pt {
  let x = 0;
  let y = 0;
  for (const q of b.quads) {
    const c = quadCentreOf(city, q);
    x += c[0] / b.quads.length;
    y += c[1] / b.quads.length;
  }
  return [x, y];
}

/** a building's front door, a step outside it (its ground-floor door façade; null: none) */
export function doorOf(city: CityPlan, b: BuildingRec): Pt | null {
  const f = city.facades.find((x) => x.building === b.id && x.level === 0 && x.kind === 'door');
  if (!f) return null;
  const t = city.tiles;
  const a = t.quads[f.quad * 4 + f.side];
  const c = t.quads[f.quad * 4 + ((f.side + 1) % 4)];
  const ax = t.verts[a * 2];
  const ay = t.verts[a * 2 + 1];
  const cx = t.verts[c * 2];
  const cy = t.verts[c * 2 + 1];
  const L = Math.hypot(cx - ax, cy - ay) || 1;
  // (outside: the right of the side — the tiles run counter-clockwise)
  return [(ax + cx) / 2 + ((cy - ay) / L) * 0.9, (ay + cy) / 2 - ((cx - ax) / L) * 0.9];
}

/** a civ's look among the structures styles: the hill holds' stone, the guilds' and the free folk's timber and tile, the
 *  foundry towns' and the old law's flat-fronted terraces */
export function styleFor(civ: CivEntry): StructureStyleId {
  const a = civ.profile.builds.architecture;
  if (a.includes('fortified') || a.includes('squat')) return 'bastion';
  if (a.includes('terraces') || a.includes('flat-roofs') || a.includes('tall')) return 'terrace';
  return 'hearth';
}

/**
 * The columns a far view's raster reads (raster.ts, the land past the window): the plan's ground works and, for the
 * buildings standing, their tops (roof-coloured) — the buildings are pieces in play (drawn, not stamped into the land),
 * so the raster alone is told where they stand.
 */
export function rasterColumns(plan: SettlementPlan, roof: number, wall: number): Map<number, ColumnPlan> {
  const out = new Map(plan.columns);
  const W = plan.boxW;
  for (const c of columnsOf(plan.city)) {
    if (c.building >= 0 && !plan.standing[c.building]) continue;
    const k = c.y * W + c.x;
    if (c.x < 0 || c.y < 0 || c.x >= W) continue;
    // (a column the plan only bared — no plants — takes the building's top; a ground work's stays)
    if (out.get(k)?.ivs.length) continue;
    out.set(k, { lo: c.z0, ivs: [{ z0: c.z0, z1: c.z1 + 1.5, mat: c.building >= 0 ? roof : wall }], bare: true });
  }
  return out;
}

/** The quarry's place: in a ring past the built edge, into a hill if one rises near, its own region's ground first. */
function chooseQuarry(
  inp: PlanInput,
  centre: Pt,
  R: number,
  colAt: (x: number, y: number) => number,
  groundAt: (x: number, y: number) => number,
  disc: (at: Pt, rad: number, f: (col: number, d: number, x: number, y: number) => void) => void,
  r: () => number,
): { at: Pt; s: number; dir: Pt; rise: number; spoil: Pt } | null {
  const [cx, cy] = centre;
  const rec = inp.rec;
  let best: { at: Pt; s: number; dir: Pt; rise: number } | null = null;
  for (let ring = 0; ring < 3; ring++)
    for (let t = 0; t < 24; t++) {
      const a = (t / 24) * Math.PI * 2 + ring * 0.13;
      const d = R + 9 + ring * 7;
      const at: Pt = [cx + Math.cos(a) * d, cy + Math.sin(a) * d];
      const c0 = colAt(...at);
      if (c0 < 0 || inp.water[c0] > 0.05 || inp.ground[c0] < inp.sea + 1) continue;
      let clash = false;
      disc(at, 8, (col) => {
        if (inp.water[col] > 0.1) clash = true;
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
      // (its own region's ground first: elsewhere it needs mineral rights there)
      const own = !inp.regionAt || inp.regionAt(...at) === rec.region ? 3 : 0;
      const sc = own + rock + Math.min(rise, 10) * 0.4 + r() * 0.5 - ring * 0.3;
      if (!best || sc > best.s) best = { at, s: sc, dir, rise };
    }
  if (!best) return null;
  const { at, dir } = best;
  return { ...best, spoil: [at[0] - dir[0] * 9 + dir[1] * 4, at[1] - dir[1] * 9 - dir[0] * 4] };
}

/** is (x, y) inside a quad (any winding) */
function inQuad(p: Pt[], x: number, y: number): boolean {
  let c = false;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    const [xi, yi] = p[i];
    const [xj, yj] = p[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}
