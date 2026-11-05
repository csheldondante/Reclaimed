// The town generator: a CitySpec and the ground → what the town is and where (a draft: tiles, buildings, landmarks,
// the purpose's works), then placed into the town's one plan (build/plan.ts) through the plan's API, as the player
// builds (round 128m, onetown; the user: "Generation needs to use the same system as the built town" — "It can do
// things to add plazas and roads but it should not be a different system"). The draft is the generator's working state,
// never kept: what the town is afterwards is its plan, and what's drawn is the plan's view (build/view.ts).
// Pure and deterministic (same spec + ground → same plan) so it can run anywhere — a worker, Node's tests, the viewer —
// and be stored as just its spec (towns grow as stored progress, round 110: the plan is re-made, the progress kept).
//
// Why on the CPU (the rule is GPU first where data is large or per-frame): a city's plan is small (a few thousand
// tiles, ~100 KB), made once when its land arrives, and its hard parts are sequential (WFC's propagation, growing
// buildings tile by tile). What is large or per-frame — drawing its pieces, stamping its columns — is on the GPU.
// Measured: data/perf/structures-*.json (plan ms per city size).
import type { Berth, BuildingKind, BuildingRec, CityPlan, CitySpec, DensityFn, GroundFn, LinearFeature, MegaFeature, Prop, TileMesh, V2 } from '../api/contracts/structures';
import { tileSystem } from './tiles/systems';
import { farmPlots } from './tiles/farmland';
import { adjacency, quadArea, quadCentre, quadCorners } from './tiles/builder';
import { fbm, hashf, rng } from './rng';
import { styleOf } from './styles';
import { routes, resample } from './linear';
import { purposeBuildings, purposeWorks, type PurposeCtx } from './purpose';

export const STOREY_H = 3;
/** a rampart's height over the ground (m) */
export const WALL_H = 7;

/** the house / hut line (people per area): denser is a town house, thinner a hut */
export const HOUSE_D = 0.42;

/**
 * A density field from the spec alone (the viewer's, a town without a field of its own): full at the middle, falling off
 * smoothly past the rim (no hard ring), lumpy with noise — the middle's houses, huts toward the edge, farmsteads out in
 * the farmland where a little is left.
 */
export function defaultDensity(spec: CitySpec): DensityFn {
  const [cx, cy] = spec.at;
  const R = spec.radius;
  const k = spec.density ?? 0.8;
  const F = spec.farmland ?? 0;
  return (x, y) => {
    const r = Math.hypot(x - cx, y - cy);
    const t = r / (R * 1.15);
    const town = k * 1.25 * Math.exp(-2.4 * t * t) * (0.7 + 0.6 * fbm(x * 0.03, y * 0.03, spec.seed + 3));
    // (the country round it: a few people out to the farmland's edge, thinning — farmsteads, not nobody)
    const country = F > R ? 0.16 * Math.max(0, Math.min(1, (F - r) / (F - R))) * (0.4 + 0.9 * fbm(x * 0.012, y * 0.012, spec.seed + 4)) : 0;
    return Math.min(1, town + country);
  };
}

/**
 * What the generator decided, before it's placed (placeDraft): the tiles (the town's one grid, out to its extent), the
 * buildings and their tiles' storeys, the landmarks, the purpose's works, the layout's features. Its working state —
 * nothing reads it after placing but settle/plan.ts, which chooses what each building is for (its type) first.
 */
export interface CityDraft {
  spec: CitySpec;
  tiles: TileMesh;
  /** per vertex the ground under it */
  gz: Float64Array;
  adj: Int32Array;
  buildings: BuildingRec[];
  quadBuilding: Int32Array;
  /** per tile its storeys (its building's, a tile now and then a storey up or down) */
  quadStoreys: Int32Array;
  megas: MegaFeature[];
  linear: LinearFeature[];
  works: { at: V2; dir: V2 } | null;
  berths: Berth[];
  props: Prop[];
  placed: { id: string; building: number }[];
  /** the build order (building ids, the old core first) */
  order: number[];
  /** the farmland's first block (a tile's block at or past it is a farm plot's); the plots hedged round */
  farmBlock0: number;
  hedged: Set<number>;
  stats: Record<string, number>;
}

/**
 * The generator's decisions (round 128m, onetown: the planner's first half): the tiles — out to the extent (the land
 * the town is built on, its farmland, and where the player builds round it; at least the radius and the farmland's
 * edge) —, which are streets, plazas, lots, the wall; the buildings and their storeys; the landmarks and the works.
 */
export function draftCity(spec: CitySpec, ground: GroundFn, water?: GroundFn, densityIn?: DensityFn, extent?: number, clip?: [number, number, number, number]): CityDraft {
  const t0 = performance.now();
  const dens = densityIn ?? defaultDensity(spec);
  const E = Math.max(extent ?? 0, spec.radius, spec.farmland ?? 0);
  // (onetown) the tiles in the town's box only (`clip`: x0, y0, x1, y1): every cell of its grid has its columns
  const tiles = clip ? clipTiles(tileSystem({ spec, ground, extent: E }), clip) : tileSystem({ spec, ground, extent: E });
  // roads out first: the farmland's farmsteads gather along them
  const linear = routes(spec, ground, water, spec.walls === true && spec.system !== 'radial');
  let farmBlock0 = Infinity;
  const hedged = new Set<number>();
  if ((spec.farmland ?? 0) > spec.radius) {
    let b0 = 0;
    for (let q = 0; q < tiles.use.length; q++) b0 = Math.max(b0, tiles.block[q] + 1);
    farmBlock0 = b0 + 1;
    const roadPts: V2[] = [];
    for (const f of linear) if (f.kind === 'road') for (const s of resample(f, 8)) roadPts.push([s.p[0], s.p[1]]);
    // (onetown) the plots over the one grid: the outside tiles whose middles lie in a plot are its cells (a farmstead's
    // are lots for its farmhouse and barn); the plots' edges follow the tiles (the user accepted it)
    const plots = farmPlots({ spec, ground, density: dens, rIn: spec.radius, rOut: spec.farmland!, roads: roadPts, block0: farmBlock0 });
    for (const pl of plots) {
      if (pl.hedge) hedged.add(pl.block);
      let lx = Infinity;
      let ly = Infinity;
      let hx = -Infinity;
      let hy = -Infinity;
      for (const [x, y] of pl.poly) (lx = Math.min(lx, x)), (ly = Math.min(ly, y)), (hx = Math.max(hx, x)), (hy = Math.max(hy, y));
      for (let q = 0; q < tiles.use.length; q++) {
        if (tiles.use[q] !== 'outside') continue;
        const [x, y] = quadCentre(tiles, q);
        if (x < lx || x > hx || y < ly || y > hy || !inPoly(pl.poly, x, y)) continue;
        // (in a river or the sea, or kept out — a quarry, its spoil —: left to the ground)
        if (water && water(x, y) > 0.3) continue;
        if ((spec.keepOut ?? []).some((k) => Math.hypot(x - k.at[0], y - k.at[1]) < k.r)) continue;
        tiles.use[q] = pl.use === 'farmstead' ? 'lot' : pl.use;
        tiles.block[q] = pl.block;
      }
    }
  }
  const isFarm = (q: number) => tiles.block[q] >= farmBlock0;
  // (what's kept out — a quarry, its spoil — is left to the ground)
  for (const k of spec.keepOut ?? [])
    for (let q = 0; q < tiles.use.length; q++) {
      const [x, y] = quadCentre(tiles, q);
      if (Math.hypot(x - k.at[0], y - k.at[1]) < k.r) tiles.use[q] = 'outside';
    }
  const t1 = performance.now();
  const r = rng(spec.seed * 31 + 11);
  const style = styleOf(spec.style);
  const nq = tiles.use.length;
  const nv = tiles.verts.length / 2;
  const gz = new Float64Array(nv);
  for (let v = 0; v < nv; v++) gz[v] = ground(tiles.verts[v * 2], tiles.verts[v * 2 + 1]);
  const adj = adjacency(tiles);
  const [cx, cy] = spec.at;
  const R = spec.radius;
  const [sMid, sRim] = spec.storeys ?? style.storeys;
  /** built into the earth (spec.sunk): buildings on steep ground, their backs in the hill */
  const into = spec.sunk !== undefined && spec.sunk >= 0;
  const quadG = (q: number) => {
    let lo = Infinity;
    let hi = -Infinity;
    for (let k = 0; k < 4; k++) {
      const z = gz[tiles.quads[q * 4 + k]];
      lo = Math.min(lo, z);
      hi = Math.max(hi, z);
    }
    return [lo, hi];
  };

  // ---- under water: nothing built or paved (a lake shore, a river through the town: bridges are STR11's); no house
  // within a few metres of the water (a shore of yards and lanes, not walls standing in the sea)
  if (water)
    for (let q = 0; q < nq; q++) {
      const [x, y] = quadCentre(tiles, q);
      let wet = water(x, y) > 0.3;
      for (let k = 0; k < 4 && !wet; k++) {
        const v = tiles.quads[q * 4 + k];
        wet = water(tiles.verts[v * 2], tiles.verts[v * 2 + 1]) > 0.3;
      }
      if (wet) tiles.use[q] = 'outside';
      else if (tiles.use[q] === 'lot') {
        const m = (spec.tile ?? 4) * 1.2;
        for (let k = 0; k < 8; k++) if (water(x + Math.cos((k * Math.PI) / 4) * m, y + Math.sin((k * Math.PI) / 4) * m) > 0.3) tiles.use[q] = 'yard';
      }
    }

  // ---- districts: a few quarters round the middle, each its roofs' colour, its height and a landmark (the plan reads
  // from afar: the user's "sprawling fantastic cities" need quarters, not one blob of roofs)
  const nd = Math.max(1, Math.min(7, Math.round(R / 26)));
  const dTurn = r() * Math.PI * 2;
  const dCentres: V2[] = [[cx, cy]];
  for (let k = 1; k < nd; k++) {
    const a = dTurn + (k / (nd - 1)) * Math.PI * 2;
    dCentres.push([cx + Math.cos(a) * R * 0.62, cy + Math.sin(a) * R * 0.62]);
  }
  const dRoof = dCentres.map(() => Math.floor(r() * 8));
  const dBias = dCentres.map((_, k) => (k === 0 ? 0.6 : (r() - 0.5) * 1.6));
  const districtOf = (x: number, y: number) => {
    let best = 0;
    let bd = Infinity;
    dCentres.forEach((c, k) => {
      const d = Math.hypot(x - c[0], y - c[1]) * (k === 0 ? 1.35 : 1) + (fbm(x * 0.03, y * 0.03, spec.seed + 21) - 0.5) * R * 0.3;
      if (d < bd) {
        bd = d;
        best = k;
      }
    });
    return best;
  };

  // ---- roads out (and their bridges), the town wall if asked (linear.ts): what's under a road inside the town is street
  for (const f of linear) {
    if (f.kind !== 'road') continue;
    for (const s of resample(f, 2))
      for (let q = 0; q < nq; q++) {
        if (tiles.use[q] !== 'lot' && tiles.use[q] !== 'yard') continue;
        const [x, y] = quadCentre(tiles, q);
        if (Math.hypot(x - s.p[0], y - s.p[1]) < f.width * 0.5 + 1.2) tiles.use[q] = 'street';
      }
  }

  // ---- which lots are built, by the density there (the rest are yards: gardens, courtyards, room to grow); a
  // farmstead's lots all may be (its farmhouse and its barn are chosen as the buildings grow)
  const built = new Uint8Array(nq);
  const dq = new Float32Array(nq);
  for (let q = 0; q < nq; q++) {
    const [cxq, cyq] = quadCentre(tiles, q);
    dq[q] = dens(cxq, cyq);
    if (tiles.use[q] !== 'lot') continue;
    const [lo, hi] = quadG(q);
    const p = isFarm(q) ? 1 : Math.min(1, dq[q] * 1.6);
    if (hi - lo > STOREY_H * (into ? 3 : 1.3) || hashf(q, spec.seed, 1) > p || quadArea(tiles, q) < 2.5) tiles.use[q] = 'yard';
    else built[q] = 1;
  }

  // ---- buildings: grown tile by tile inside a block, a few tiles each, on ground no steeper than a storey
  const quadBuilding = new Int32Array(nq).fill(-1);
  const buildings: BuildingRec[] = [];
  const megas: MegaFeature[] = [];
  // a domed temple over four tiles that meet at a vertex (a mega tile: one feature over several tiles), in the middle
  // quarter, on ground flat enough: the first building, so the rest grow round it
  if (R >= 30) {
    const around = new Map<number, number[]>();
    for (let q = 0; q < nq; q++) for (let k = 0; k < 4; k++) (around.get(tiles.quads[q * 4 + k]) ?? around.set(tiles.quads[q * 4 + k], []).get(tiles.quads[q * 4 + k])!).push(q);
    let best = -1;
    let bestD = Infinity;
    for (const [v, qs] of around) {
      if (qs.length !== 4 || !qs.every((q) => built[q] && !isFarm(q) && dq[q] >= HOUSE_D && tiles.block[q] === tiles.block[qs[0]])) continue;
      const d = Math.abs(Math.hypot(tiles.verts[v * 2] - cx, tiles.verts[v * 2 + 1] - cy) - R * 0.3);
      let lo = Infinity;
      let hi = -Infinity;
      for (const q of qs) {
        const [l, h] = quadG(q);
        lo = Math.min(lo, l);
        hi = Math.max(hi, h);
      }
      if (hi - lo < STOREY_H && d < bestD) {
        bestD = d;
        best = v;
      }
    }
    if (best >= 0) {
      const qs = around.get(best)!;
      const vx = tiles.verts[best * 2];
      const vy = tiles.verts[best * 2 + 1];
      // the patch's corners: each tile's corner opposite the shared vertex, counter-clockwise round it
      const outer = qs
        .map((q) => {
          const k = [0, 1, 2, 3].find((i) => tiles.quads[q * 4 + i] === best)!;
          const o = tiles.quads[q * 4 + ((k + 2) % 4)];
          return [tiles.verts[o * 2], tiles.verts[o * 2 + 1]] as V2;
        })
        .sort((a, b) => Math.atan2(a[1] - vy, a[0] - vx) - Math.atan2(b[1] - vy, b[0] - vx));
      let hi = -Infinity;
      for (const q of qs) hi = Math.max(hi, quadG(q)[1]);
      const id = buildings.length;
      // (its drum a storey over the middle's houses: the dome stands clear of their roofs)
      const st = Math.max(3, Math.round(sMid) + 1);
      const b: BuildingRec = { id, kind: 'house', quads: qs, base: hi + 0.15, storeys: st, storeyH: STOREY_H, look: Math.floor(r() * 4096), mega: 'dome', district: 0 };
      buildings.push(b);
      for (const q of qs) quadBuilding[q] = id;
      megas.push({ kind: 'dome', quads: qs, frame: [outer[0], outer[1], outer[2], outer[3]], z0: b.base, z1: b.base + st * STOREY_H });
    }
  }
  const order = Array.from({ length: nq }, (_, q) => q).filter((q) => built[q]);
  for (let k = order.length - 1; k > 0; k--) {
    const m = Math.floor(r() * (k + 1));
    [order[k], order[m]] = [order[m], order[k]];
  }
  // (a farmstead: its first building a farmhouse, its second a barn, the rest of its lots its farmyard)
  const farmCount = new Map<number, number>();
  for (const q0 of order) {
    if (quadBuilding[q0] >= 0) continue;
    const id = buildings.length;
    let kind: BuildingKind;
    if (isFarm(q0)) {
      const n = farmCount.get(tiles.block[q0]) ?? 0;
      if (n >= 2) {
        tiles.use[q0] = 'yard';
        built[q0] = 0;
        continue;
      }
      farmCount.set(tiles.block[q0], n + 1);
      kind = n === 0 ? 'farmhouse' : 'barn';
    } else kind = dq[q0] >= HOUSE_D ? 'house' : 'hut';
    const want = kind === 'house' ? 1 + Math.floor(r() * r() * style.maxTiles) : kind === 'hut' ? 1 + (r() < 0.3 ? 1 : 0) : kind === 'barn' ? 2 + (r() < 0.4 ? 1 : 0) : 1 + (r() < 0.5 ? 1 : 0);
    const quads = [q0];
    quadBuilding[q0] = id;
    let [lo, hi] = quadG(q0);
    for (let i = 0; i < quads.length && quads.length < want; i++)
      for (let s = 0; s < 4 && quads.length < want; s++) {
        const n = adj[quads[i] * 4 + s];
        if (n < 0 || !built[n] || quadBuilding[n] >= 0 || tiles.block[n] !== tiles.block[q0]) continue;
        // (a house doesn't run on into the huts' density, nor a hut into the town's)
        if (kind === 'house' ? dq[n] < HOUSE_D * 0.85 : kind === 'hut' ? dq[n] >= HOUSE_D * 1.15 : false) continue;
        const [l2, h2] = quadG(n);
        if (Math.max(hi, h2) - Math.min(lo, l2) > STOREY_H * (into ? 2.5 : 0.9)) continue;
        lo = Math.min(lo, l2);
        hi = Math.max(hi, h2);
        quadBuilding[n] = id;
        quads.push(n);
      }
    const [bx, by] = quadCentre(tiles, q0);
    const d = Math.min(1, Math.hypot(bx - cx, by - cy) / R);
    const dk = districtOf(bx, by);
    void d;
    // storeys by the density: a house from the rim's to the middle's as it rises past the hut line; a hut one (two now
    // and then where it's nearly a town); a farmhouse one or two; a barn one tall one
    const dd = Math.min(1, Math.max(0, (dq[q0] - HOUSE_D) / 0.5));
    const storeys =
      kind === 'house' ? Math.max(1, Math.round(sRim + (sMid - sRim) * dd + dBias[dk] + (fbm(bx * 0.04, by * 0.04, spec.seed + 9) - 0.5) * 2.2 + (r() - 0.5) * 0.8))
      : kind === 'hut' ? (dq[q0] > HOUSE_D * 0.75 && r() < 0.35 ? 2 : 1)
      : kind === 'farmhouse' ? (r() < 0.5 ? 2 : 1)
      : 1;
    // (look: 12 random bits; bit 15 + bits 12-14 the district's roof colour, most of the time — a few odd ones out; the
    // huts' and the farms' thatch their own)
    const look = Math.floor(r() * 4096) | (kind === 'house' && r() < 0.82 ? 0x8000 | (dRoof[dk] << 12) : 0);
    // (built into the earth — spec.sunk: its floor on the ground's low side, its back in the hill, storeys enough that its
    // roof stands clear of the hill; else on the high side, a plinth under the low)
    const base = into ? lo + 0.15 - (spec.sunk ?? 0) : hi + 0.15;
    const st = into ? Math.max(storeys, Math.ceil((hi - base) / STOREY_H) + 1) : storeys;
    buildings.push({ id, kind, quads, base, storeys: st, storeyH: kind === 'barn' ? 4.4 : kind === 'hut' ? 2.7 : STOREY_H, look, district: dk });
  }

  // ---- (round 120) the purpose: its work site, a port's quay, the purpose's buildings (warehouses, a sawmill, granaries,
  // stables), a market widened; history's marks worn in (purpose.ts)
  const pctx: PurposeCtx = { spec, tiles, adj, gz, ground, water, buildings, quadBuilding, isFarm, r };
  const works = purposeBuildings(pctx);

  // ---- landmarks (mega tiles): the tallest building near the middle becomes a tower; a fountain in the plaza
  const quadTop = new Float64Array(nq).fill(NaN);
  const quadStoreys = new Int32Array(nq);
  for (const b of buildings)
    for (const q of b.quads) {
      // (a tile now and then a storey up or down from its building: Townscaper's stepped skylines)
      const h = hashf(q, spec.seed, 2);
      const s = b.mega ? b.storeys : Math.max(1, b.storeys + (h < 0.14 ? 1 : h > 0.88 && b.quads.length > 1 ? -1 : 0));
      quadStoreys[q] = s;
      quadTop[q] = b.base + s * b.storeyH;
    }
  if (style.towers > 0) {
    // the landmarks: the style's towers near the middle, and one in each outer quarter (taller in the middle)
    // (a lone tile with open ground beside it: a tower has a door and a lift — nav — so it needs a way in)
    const open = (q: number) => [0, 1, 2, 3].some((s) => {
      const n = adj[q * 4 + s];
      return n >= 0 && (tiles.use[n] === 'street' || tiles.use[n] === 'plaza' || tiles.use[n] === 'yard');
    });
    const lone = buildings.filter((b) => b.kind === 'house' && b.quads.length === 1 && open(b.quads[0]));
    const near = (c: V2) => (a: BuildingRec, b: BuildingRec) => {
      const da = Math.hypot(quadCentre(tiles, a.quads[0])[0] - c[0], quadCentre(tiles, a.quads[0])[1] - c[1]);
      const db = Math.hypot(quadCentre(tiles, b.quads[0])[0] - c[0], quadCentre(tiles, b.quads[0])[1] - c[1]);
      return da - db;
    };
    const picks = lone.slice().sort(near([cx, cy])).slice(0, style.towers).map((b): [BuildingRec, number] => [b, 6]);
    for (let k = 1; k < nd; k++) {
      const b = lone.filter((x) => x.district === k && !picks.some(([p]) => p === x)).sort(near(dCentres[k]))[0];
      if (b) picks.push([b, 3]);
    }
    for (const [b, extra] of picks) {
      const q = b.quads[0];
      b.mega = 'tower';
      b.storeys = Math.max(b.storeys + extra, Math.round(sMid) + extra);
      quadStoreys[q] = b.storeys;
      quadTop[q] = b.base + b.storeys * b.storeyH;
      megas.push({ kind: 'tower', quads: [q], frame: quadCorners(tiles, q), z0: b.base, z1: quadTop[q] });
    }
  }
  // (merge124) structures the world placed (a card's outcome — WorldState's `settlement-building`, realised when the land
  // is made): each raised as a landmark tower on a lone lot with open ground beside it, nearest the middle — through this
  // contract, so the town draws it like its own
  const placed: { id: string; building: number }[] = [];
  if (spec.placed?.length) {
    const openQ = (q: number) => [0, 1, 2, 3].some((s) => {
      const n = adj[q * 4 + s];
      return n >= 0 && (tiles.use[n] === 'street' || tiles.use[n] === 'plaza' || tiles.use[n] === 'yard');
    });
    const midD = (b: BuildingRec) => Math.hypot(quadCentre(tiles, b.quads[0])[0] - cx, quadCentre(tiles, b.quads[0])[1] - cy);
    for (const p of spec.placed) {
      const b = buildings.filter((x) => (x.kind === 'house' || x.kind === 'hut') && !x.mega && x.quads.length === 1 && openQ(x.quads[0])).sort((a, c) => midD(a) - midD(c))[0];
      if (!b) break;
      const q = b.quads[0];
      b.mega = 'tower';
      b.storeys = Math.max(b.storeys + 4, Math.round(sMid) + 4);
      quadStoreys[q] = b.storeys;
      quadTop[q] = b.base + b.storeys * b.storeyH;
      megas.push({ kind: 'tower', quads: [q], frame: quadCorners(tiles, q), z0: b.base, z1: quadTop[q] });
      placed.push({ id: p.id, building: b.id });
    }
  }
  const plaza = Array.from({ length: nq }, (_, q) => q).filter((q) => tiles.use[q] === 'plaza');
  if (spec.system === 'radial' && plaza.length) {
    // Bulwark's heart: a great round keep in the middle of the plaza (a ring of the plaza left round it)
    let gx = 0;
    let gy = 0;
    let hi = -Infinity;
    for (const q of plaza) {
      const [x, y] = quadCentre(tiles, q);
      gx += x / plaza.length;
      gy += y / plaza.length;
      hi = Math.max(hi, quadG(q)[1]);
    }
    const s = (spec.tile ?? 4) * 1.35;
    const z1 = hi + Math.max(5, Math.round(sMid) + 4) * STOREY_H;
    megas.push({ kind: 'keep', quads: [], frame: [[gx - s, gy - s], [gx + s, gy - s], [gx + s, gy + s], [gx - s, gy + s]], z0: hi + 0.1, z1 });
  } else if (plaza.length) {
    let pz = Infinity;
    for (const q of plaza) pz = Math.min(pz, quadG(q)[0]);
    // the fountain stands where the plaza's tiles meet (their shared vertex nearest the middle)
    const counts = new Map<number, number>();
    for (const q of plaza) for (let k = 0; k < 4; k++) counts.set(tiles.quads[q * 4 + k], (counts.get(tiles.quads[q * 4 + k]) ?? 0) + 1);
    let best = -1;
    let bd = Infinity;
    for (const [v, c] of counts) {
      if (c < 3) continue;
      const d = Math.hypot(tiles.verts[v * 2] - cx, tiles.verts[v * 2 + 1] - cy);
      if (d < bd) {
        bd = d;
        best = v;
      }
    }
    if (best >= 0) {
      const fx = tiles.verts[best * 2];
      const fy = tiles.verts[best * 2 + 1];
      const s = (spec.tile ?? 4) * 0.55;
      const z = gz[best];
      megas.push({ kind: 'fountain', quads: plaza, frame: [[fx - s, fy - s], [fx + s, fy - s], [fx + s, fy + s], [fx - s, fy + s]], z0: z - 0.1, z1: z + 2.6 });
    }
  }

  // ---- (round 120) the purpose's works: piers, ships, a lighthouse, a headframe and rails, a windmill, the props
  const { berths, props } = purposeWorks(pctx, works, megas, linear);

  void quadTop;
  const t2 = performance.now();
  return {
    spec,
    tiles,
    gz,
    adj,
    buildings,
    quadBuilding,
    quadStoreys,
    megas,
    linear,
    works,
    berths,
    props,
    placed,
    order: buildOrder(buildings, tiles, spec),
    farmBlock0,
    hedged,
    stats: { tiles: nq, buildings: buildings.length, props: props.length, berths: berths.length, piers: linear.filter((f) => f.kind === 'pier').length, tilesMs: +(t1 - t0).toFixed(2), planMs: +(t2 - t1).toFixed(2) },
  };
}

/** a tile mesh less the tiles with a corner outside x0..x1, y0..y1 (the rest renumbered in order) */
function clipTiles(t: TileMesh, [x0, y0, x1, y1]: [number, number, number, number]): TileMesh {
  const keep: number[] = [];
  for (let q = 0; q < t.use.length; q++) {
    let inside = true;
    for (let k = 0; k < 4 && inside; k++) {
      const v = t.quads[q * 4 + k];
      const x = t.verts[v * 2];
      const y = t.verts[v * 2 + 1];
      inside = x >= x0 && y >= y0 && x <= x1 && y <= y1;
    }
    if (inside) keep.push(q);
  }
  const quads = new Uint32Array(keep.length * 4);
  keep.forEach((q, i) => quads.set(t.quads.subarray(q * 4, q * 4 + 4), i * 4));
  return { verts: t.verts, quads, use: keep.map((q) => t.use[q]), block: Int32Array.from(keep, (q) => t.block[q]) };
}

/** is (x, y) inside a polygon (any winding) */
function inPoly(p: V2[], x: number, y: number): boolean {
  let c = false;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++)
    if (p[i][1] > y !== p[j][1] > y && x < ((p[j][0] - p[i][0]) * (y - p[i][1])) / (p[j][1] - p[i][1]) + p[i][0]) c = !c;
  return c;
}

/** the tiles' corners as points, for the viewer's outlines */
export function tileOutline(t: TileMesh, q: number): V2[] {
  return quadCorners(t, q);
}

/** the old core first: by distance from the middle with noise, the landmarks early */
function buildOrder(buildings: BuildingRec[], tiles: TileMesh, spec: CitySpec): number[] {
  const [cx, cy] = spec.at;
  const score = buildings.map((b) => {
    const [x, y] = quadCentre(tiles, b.quads[0]);
    return Math.hypot(x - cx, y - cy) / spec.radius + 0.45 * hashf(b.id, spec.seed, 5) - (b.mega ? 0.6 : 0);
  });
  return buildings.map((b) => b.id).sort((a, b) => score[a] - score[b]);
}

/** Move a plan's frame by (dx, dy) world units, in place (a host whose world slides under it: the window's). */
export function shiftPlan(plan: CityPlan, dx: number, dy: number): void {
  const v = plan.tiles.verts;
  for (let i = 0; i < v.length; i += 2) {
    v[i] -= dx;
    v[i + 1] -= dy;
  }
  plan.spec = { ...plan.spec, at: [plan.spec.at[0] - dx, plan.spec.at[1] - dy] };
  for (const n of plan.nav.nodes) {
    n.at[0] -= dx;
    n.at[1] -= dy;
  }
  for (const m of plan.megas) for (const p of m.frame) (p[0] -= dx), (p[1] -= dy);
  for (const f of plan.linear) for (const p of f.points) (p[0] -= dx), (p[1] -= dy);
  // (onetown: the layout's things too — a plan's view is made in its box's frame)
  for (const p of plan.props) (p.at[0] -= dx), (p.at[1] -= dy);
  for (const b of plan.berths) (b.at[0] -= dx), (b.at[1] -= dy);
  for (const l of plan.lights) (l.at[0] -= dx), (l.at[1] -= dy);
  if (plan.works) plan.works = { at: [plan.works.at[0] - dx, plan.works.at[1] - dy], dir: plan.works.dir };
}
