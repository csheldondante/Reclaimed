// A city's purpose in its plan (round 120, `cities`; BACKLOG STR30, STR32, STR36): what it's for shapes the layout, the
// building mix and its works. Agreed with the user (DECISIONS round 120):
//   mining: "ore in cliffs or a cave mouth. Headframes, spoil heaps, rails into the mountain."
//   port: "a coast or a river mouth" — docks, piers, quays, warehouses, a lighthouse, ships moored in the harbour
//   lumber camp: "forest plus a river. Sawmill, log piles, logs on the river."
//   farming: "fertile flats. The farms exist; add grain stores and a mill."
//   trading post: "a crossroads or ford. Market square, caravan yards, stables."
//   hold: "a defensible height, a fortress like the Red Hold."
// And a town's history in its fabric (CityMark): a burned quarter, newer walls, a flooded lower town.
//
// Three passes, called by the planner (plan.ts) where each needs the plan to be: `purposeBuildings` once the buildings
// have grown (it finds the work site, turns shore tiles into quay, re-kinds buildings — warehouses, a sawmill, granaries,
// stables —, widens a market, wears what history marked); `purposeWorks` once the landmarks stand (piers, berths, the
// lighthouse, the headframe and its rails, the windmill, the props); `dressing` once the façades are chosen (street
// lamps, torches at doors and gates, banners, and every light's pool). Pure and deterministic, like the planner.
import type { Berth, BuildingRec, CityMark, CitySpec, Facade, GroundFn, LightSource, LinearFeature, MegaFeature, Prop, PropKind, TileMesh, V2, V3 } from '../api/contracts/structures';
import { quadCentre, quadCorners } from './tiles/builder';
import { hashf } from './rng';

/** what the passes share: the plan as it's being made (plan.ts owns it; these add to it) */
export interface PurposeCtx {
  spec: CitySpec;
  tiles: TileMesh;
  adj: Int32Array;
  /** per vertex its ground */
  gz: Float64Array;
  ground: GroundFn;
  water?: GroundFn;
  buildings: BuildingRec[];
  quadBuilding: Int32Array;
  isFarm: (q: number) => boolean;
  r: () => number;
}

export interface Works {
  at: V2;
  dir: V2;
}

/** a port's ships need this much water under them (m) */
export const SHIP_DRAFT = 1.2;
/** a pier's deck over the water (m) */
export const PIER_DECK = 1.1;

const unit = (x: number, y: number): V2 => {
  const L = Math.hypot(x, y) || 1;
  return [x / L, y / L];
};

/** the water's depth (0: dry) */
const depthOf = (ctx: PurposeCtx) => (x: number, y: number) => (ctx.water ? Math.max(0, ctx.water(x, y)) : 0);

/**
 * The purpose's work site, read from the ground (the host's when it chose one: spec.works). Port and lumber: the shore
 * nearest the town on the side with the most water (dir: out over the water). Mining: the steepest rise past the rim
 * (dir: into the hill). Farming: the highest open ground past the rim (the mill). Trading and hold: the middle; a hold's
 * the highest ground near it (its keep). Null: the land has nothing for it (a port with no water near says so).
 */
export function findWorks(ctx: PurposeCtx): Works | null {
  const { spec } = ctx;
  if (spec.works) return spec.works;
  const [cx, cy] = spec.at;
  const R = spec.radius;
  const depth = depthOf(ctx);
  const A = 48;
  switch (spec.purpose) {
    case 'port':
    case 'lumber': {
      // the side with the most water within 1.6 R
      let bestA = -1;
      let bestW = 0;
      for (let k = 0; k < A; k++) {
        const a = (k / A) * Math.PI * 2;
        let w = 0;
        for (let d = R * 0.3; d <= R * 1.6; d += 3) if (depth(cx + Math.cos(a) * d, cy + Math.sin(a) * d) > 0.3) w += 1 / (1 + d / R);
        if (w > bestW) {
          bestW = w;
          bestA = a;
        }
      }
      if (bestA < 0) return null;
      // (the shore: the first wet point out from the middle that way)
      const dir: V2 = [Math.cos(bestA), Math.sin(bestA)];
      for (let d = 0; d <= R * 1.6; d += 1) {
        const x = cx + dir[0] * d;
        const y = cy + dir[1] * d;
        if (depth(x, y) > 0.3) return { at: [x - dir[0], y - dir[1]], dir };
      }
      return null;
    }
    case 'mining': {
      let best: Works | null = null;
      let bestRise = 2;
      for (let k = 0; k < A; k++) {
        const a = (k / A) * Math.PI * 2;
        const at: V2 = [cx + Math.cos(a) * (R + 8), cy + Math.sin(a) * (R + 8)];
        if (depth(at[0], at[1]) > 0.1) continue;
        const g0 = ctx.ground(at[0], at[1]);
        const rise = ctx.ground(at[0] + Math.cos(a) * 12, at[1] + Math.sin(a) * 12) - g0;
        if (rise > bestRise) {
          bestRise = rise;
          best = { at, dir: [Math.cos(a), Math.sin(a)] };
        }
      }
      // (no hill: a shaft sunk on the flat past the rim, the way out from the middle)
      return best ?? { at: [cx + R + 8, cy], dir: [1, 0] };
    }
    case 'farming': {
      let best: Works | null = null;
      let hi = -Infinity;
      for (let k = 0; k < A; k++) {
        const a = (k / A) * Math.PI * 2;
        for (const f of [1.15, 1.4]) {
          const at: V2 = [cx + Math.cos(a) * R * f, cy + Math.sin(a) * R * f];
          if (depth(at[0], at[1]) > 0.05) continue;
          const g = ctx.ground(at[0], at[1]);
          if (g > hi) {
            hi = g;
            best = { at, dir: [Math.cos(a), Math.sin(a)] };
          }
        }
      }
      return best;
    }
    case 'hold': {
      let best: Works = { at: [cx, cy], dir: [1, 0] };
      let hi = -Infinity;
      for (let k = 0; k < 24; k++)
        for (const f of [0, 0.25, 0.45]) {
          const a = (k / 24) * Math.PI * 2;
          const at: V2 = [cx + Math.cos(a) * R * f, cy + Math.sin(a) * R * f];
          const g = ctx.ground(at[0], at[1]);
          if (g > hi + 0.5) {
            hi = g;
            best = { at, dir: [Math.cos(a), Math.sin(a)] };
          }
        }
      return best;
    }
    case 'trading':
      return { at: [cx, cy], dir: [1, 0] };
    default:
      return null;
  }
}

function buildingCentre(t: TileMesh, b: BuildingRec): V2 {
  let x = 0;
  let y = 0;
  for (const q of b.quads) {
    const c = quadCentre(t, q);
    x += c[0] / b.quads.length;
    y += c[1] / b.quads.length;
  }
  return [x, y];
}

/** is a building free to be re-kinded (a plain town building, not a landmark, not out on a farm) */
const plain = (ctx: PurposeCtx, b: BuildingRec) => !b.mega && (b.kind === 'house' || b.kind === 'hut') && !ctx.isFarm(b.quads[0]);

/** buildings nearest a point, plain ones, within a reach */
function nearest(ctx: PurposeCtx, at: V2, reach: number, n: number, ok = (b: BuildingRec) => plain(ctx, b)): BuildingRec[] {
  return ctx.buildings
    .filter(ok)
    .map((b) => [b, Math.hypot(buildingCentre(ctx.tiles, b)[0] - at[0], buildingCentre(ctx.tiles, b)[1] - at[1])] as const)
    .filter(([, d]) => d <= reach)
    .sort((a, b) => a[1] - b[1])
    .slice(0, n)
    .map(([b]) => b);
}

/** re-kind a building (its storeys and their height follow its kind) */
function rekind(b: BuildingRec, kind: BuildingRec['kind'], storeys: number, storeyH: number): void {
  b.kind = kind;
  b.storeys = storeys;
  b.storeyH = storeyH;
  // (no district roof colour: its kind's own roof)
  b.look &= 0x0fff;
}

/**
 * After the buildings have grown: the work site; a port's quay (its shore tiles paved); the purpose's buildings
 * re-kinded from the town's (warehouses by the quay, a sawmill by the river, granaries by the plaza, stables by the
 * caravan yards); a trading post's market widened; history's marks worn into what they touch.
 */
export function purposeBuildings(ctx: PurposeCtx): Works | null {
  const { spec, tiles: t, adj } = ctx;
  const works = spec.purpose ? findWorks(ctx) : null;
  const nq = t.use.length;
  const [cx, cy] = spec.at;
  const R = spec.radius;
  const depth = depthOf(ctx);
  if (spec.purpose === 'port' && works) {
    // the quay: open shore tiles (yards and streets the water's edge kept unbuilt) beside a wet one, in the town
    for (let q = 0; q < nq; q++) {
      const u = t.use[q];
      if ((u !== 'yard' && u !== 'street') || ctx.quadBuilding[q] >= 0 || ctx.isFarm(q)) continue;
      const [x, y] = quadCentre(t, q);
      if (Math.hypot(x - cx, y - cy) > R * 1.15) continue;
      let wet = false;
      for (let s = 0; s < 4 && !wet; s++) {
        const n = adj[q * 4 + s];
        const p = quadCorners(t, q);
        const m: V2 = [(p[s][0] + p[(s + 1) % 4][0]) / 2, (p[s][1] + p[(s + 1) % 4][1]) / 2];
        wet = (n < 0 || t.use[n] === 'outside') && depth(m[0] + (m[0] - x) * 1.2, m[1] + (m[1] - y) * 1.2) > 0.1;
      }
      if (wet) t.use[q] = 'quay';
    }
    // warehouses: the buildings nearest the quay
    const quay: V2[] = [];
    for (let q = 0; q < nq; q++) if (t.use[q] === 'quay') quay.push(quadCentre(t, q));
    const nearQuay = (b: BuildingRec) => {
      const c = buildingCentre(t, b);
      let d = Infinity;
      for (const p of quay) d = Math.min(d, Math.hypot(p[0] - c[0], p[1] - c[1]));
      return d;
    };
    const n = R >= 30 ? 4 : 2;
    const ws = ctx.buildings.filter((b) => plain(ctx, b) && nearQuay(b) < 16).sort((a, b) => nearQuay(a) - nearQuay(b)).slice(0, n);
    for (const b of ws) rekind(b, 'warehouse', 2, 3.4);
  } else if (spec.purpose === 'lumber' && works) {
    const [mill] = nearest(ctx, works.at, R * 1.2, 1);
    if (mill) rekind(mill, 'sawmill', 1, 4.2);
  } else if (spec.purpose === 'farming') {
    const plaza = plazaCentre(t) ?? [cx, cy];
    for (const b of nearest(ctx, plaza, R, 2, (b) => plain(ctx, b) && b.quads.length <= 3)) {
      rekind(b, 'granary', 1, 3.6);
      // (on staddle stones: a step up off the ground, out of the damp and the rats' reach)
      b.base += 0.7;
    }
  } else if (spec.purpose === 'trading') {
    // the market: the plaza widened over the unbuilt tiles round it, twice
    for (let pass = 0; pass < 2; pass++) {
      const grow: number[] = [];
      for (let q = 0; q < nq; q++) {
        if (t.use[q] !== 'plaza') continue;
        for (let s = 0; s < 4; s++) {
          const n = adj[q * 4 + s];
          if (n >= 0 && ctx.quadBuilding[n] < 0 && (t.use[n] === 'yard' || t.use[n] === 'street' || t.use[n] === 'lot') && !ctx.isFarm(n)) grow.push(n);
        }
      }
      for (const q of grow) t.use[q] = 'plaza';
    }
    // stables by each caravan yard (the yards themselves: purposeWorks)
    for (const a of approachesOf(spec)) {
      const at: V2 = [cx + a[0] * R * 0.85, cy + a[1] * R * 0.85];
      const [s] = nearest(ctx, at, R * 0.6, 1);
      if (s) rekind(s, 'stable', 1, 3.4);
    }
  }
  // history in the fabric
  for (const m of spec.marks ?? []) wear(ctx, m);
  return works;
}

/** the roads' directions in (the host's), else three spread round */
export function approachesOf(spec: CitySpec): V2[] {
  if (spec.approaches?.length) return spec.approaches.slice(0, 4).map((a) => unit(a[0], a[1]));
  const a0 = hashf(spec.seed, 61) * Math.PI * 2;
  return [0, 1, 2].map((k) => [Math.cos(a0 + (k * Math.PI * 2) / 3), Math.sin(a0 + (k * Math.PI * 2) / 3)] as V2);
}

function plazaCentre(t: TileMesh): V2 | null {
  let x = 0;
  let y = 0;
  let n = 0;
  for (let q = 0; q < t.use.length; q++)
    if (t.use[q] === 'plaza') {
      const c = quadCentre(t, q);
      x += c[0];
      y += c[1];
      n++;
    }
  return n ? [x / n, y / n] : null;
}

/** a mark worn into the buildings it touches: a burned quarter gutted (a storey lost, no roof, soot); a flood's lower
 *  town abandoned (a waterline); new walls are the pieces' (pieces.ts reads spec.marks) */
function wear(ctx: PurposeCtx, m: CityMark): void {
  for (const b of ctx.buildings) {
    if (b.mega) continue;
    const [x, y] = buildingCentre(ctx.tiles, b);
    if (m.kind === 'burned' && m.at && Math.hypot(x - m.at[0], y - m.at[1]) < (m.r ?? 12) * (0.75 + 0.5 * hashf(b.id, 71))) {
      b.wear = 'burned';
      b.storeys = Math.max(1, b.storeys - 1);
    } else if (m.kind === 'flooded' && m.level !== undefined && b.base < m.level) b.wear = 'flooded';
  }
}

/**
 * After the landmarks: the purpose's works — a port's piers out to water deep enough, ships moored at them and one or two
 * anchored out, a lighthouse on the most open point of the quay, cranes and crates; a mine's headframe by the mouth, rails
 * from the town into the hill, spoil heaps and ore carts; a lumber camp's waterwheel, log piles, logs on the river; a
 * farming town's windmill and haystacks; a trading post's stalls and caravan yards; a hold's banners on its keep.
 */
export function purposeWorks(ctx: PurposeCtx, works: Works | null, megas: MegaFeature[], linear: LinearFeature[]): { berths: Berth[]; props: Prop[] } {
  const { spec, tiles: t, adj } = ctx;
  const berths: Berth[] = [];
  const props: Prop[] = [];
  const nq = t.use.length;
  const [cx, cy] = spec.at;
  const R = spec.radius;
  const depth = depthOf(ctx);
  const surf = (x: number, y: number) => ctx.ground(x, y) + depth(x, y);
  const prop = (kind: PropKind, x: number, y: number, heading: number, size: number, z = ctx.ground(x, y)) => props.push({ kind, at: [x, y, z], heading, size, seed: hashf(x, y, 81) });
  if (!works) return { berths, props };
  if (spec.purpose === 'port') {
    // the quay's water edges: a side's middle and its way out
    const edges: { at: V2; out: V2 }[] = [];
    for (let q = 0; q < nq; q++) {
      if (t.use[q] !== 'quay') continue;
      const p = quadCorners(t, q);
      const c = quadCentre(t, q);
      for (let s = 0; s < 4; s++) {
        const n = adj[q * 4 + s];
        if (n >= 0 && t.use[n] !== 'outside') continue;
        const m: V2 = [(p[s][0] + p[(s + 1) % 4][0]) / 2, (p[s][1] + p[(s + 1) % 4][1]) / 2];
        // (out: the side's normal, away from the tile's middle)
        let o = unit(p[(s + 1) % 4][1] - p[s][1], -(p[(s + 1) % 4][0] - p[s][0]));
        if ((m[0] - c[0]) * o[0] + (m[1] - c[1]) * o[1] < 0) o = [-o[0], -o[1]];
        if (depth(m[0] + o[0] * 2, m[1] + o[1] * 2) > 0.3) edges.push({ at: m, out: o });
      }
    }
    // piers: from the edges nearest the harbour's way, 12 m apart at least, out until a ship can lie beside
    edges.sort((a, b) => Math.hypot(a.at[0] - works.at[0], a.at[1] - works.at[1]) - Math.hypot(b.at[0] - works.at[0], b.at[1] - works.at[1]));
    const want = R >= 30 ? 3 : 2;
    const piers: { a: V2; b: V2; out: V2; z: number }[] = [];
    for (const e of edges) {
      if (piers.length >= want) break;
      if (piers.some((p) => Math.hypot(p.a[0] - e.at[0], p.a[1] - e.at[1]) < 12)) continue;
      // (straight out along the side's normal, leaning toward the harbour's way)
      const o = unit(e.out[0] + works.dir[0] * 1.2, e.out[1] + works.dir[1] * 1.2);
      let len = 0;
      for (let d = 2; d <= 24; d += 1) {
        // (over the shallows at the foot of the quay, on over open water; back onto dry ground, it's no pier)
        if (d > 4 && depth(e.at[0] + o[0] * d, e.at[1] + o[1] * d) < 0.05) break;
        len = d;
        if (d >= 10 && depth(e.at[0] + o[0] * d, e.at[1] + o[1] * d) >= SHIP_DRAFT + 0.3) break;
      }
      if (len < 8 || depth(e.at[0] + o[0] * len, e.at[1] + o[1] * len) < SHIP_DRAFT) continue;
      const b: V2 = [e.at[0] + o[0] * len, e.at[1] + o[1] * len];
      const z = surf(b[0], b[1]) + PIER_DECK;
      piers.push({ a: e.at, b, out: o, z });
      const pts: V3[] = [];
      const gs: number[] = [];
      for (let k = 0; k <= Math.ceil(len / 3); k++) {
        const s = Math.min(len, k * 3);
        const x = e.at[0] + o[0] * s;
        const y = e.at[1] + o[1] * s;
        pts.push([x, y, z]);
        gs.push(ctx.ground(x, y));
      }
      linear.push({ kind: 'pier', points: pts, ground: gs, width: 3 });
    }
    // ships alongside each pier, then one or two at anchor out in the harbour
    piers.forEach((p, i) => {
      const L = 9 + 5 * hashf(i, spec.seed, 82);
      const kind = i % 2 ? 'sloop' : 'cog';
      for (const side of [1, -1]) {
        const nx = -p.out[1] * side;
        const ny = p.out[0] * side;
        const mid: V2 = [p.b[0] - p.out[0] * L * 0.45 + nx * 3.6, p.b[1] - p.out[1] * L * 0.45 + ny * 3.6];
        const ok = [-0.5, 0, 0.5].every((f) => depth(mid[0] + p.out[0] * L * f, mid[1] + p.out[1] * L * f) >= SHIP_DRAFT);
        if (!ok) continue;
        berths.push({ at: [mid[0], mid[1], surf(mid[0], mid[1])], heading: Math.atan2(p.out[1], p.out[0]), length: L, kind, seed: hashf(i, spec.seed, 83) });
        break;
      }
      // a crane at the pier's root
      prop('crane', p.a[0] - p.out[0] * 2 - p.out[1] * 2.2, p.a[1] - p.out[1] * 2 + p.out[0] * 2.2, Math.atan2(p.out[1], p.out[0]), 7);
      // a lantern at its end
      prop('lamp', p.b[0], p.b[1], 0, 3.2, p.z);
    });
    for (let k = 0; k < (R >= 30 ? 2 : 1); k++) {
      const a = Math.atan2(works.dir[1], works.dir[0]) + (k ? 0.6 : -0.4);
      for (let d = R * 0.5; d <= R * 1.6; d += 3) {
        const x = works.at[0] + Math.cos(a) * d;
        const y = works.at[1] + Math.sin(a) * d;
        if (depth(x, y) < SHIP_DRAFT + 0.8 || piers.some((p) => Math.hypot(p.b[0] - x, p.b[1] - y) < 14)) continue;
        berths.push({ at: [x, y, surf(x, y)], heading: a + 1.2 + hashf(k, 84), length: 12 + 4 * hashf(k, spec.seed, 85), kind: 'cog', seed: hashf(k, spec.seed, 86) });
        break;
      }
    }
    // the lighthouse: on the quay edge with the most open water round it
    let best: { at: V2; out: V2 } | null = null;
    let bestW = -1;
    for (const e of edges) {
      let w = 0;
      for (let k = 0; k < 16; k++) if (depth(e.at[0] + Math.cos((k / 16) * Math.PI * 2) * 14, e.at[1] + Math.sin((k / 16) * Math.PI * 2) * 14) > 0.3) w++;
      if (w > bestW && !piers.some((p) => Math.hypot(p.a[0] - e.at[0], p.a[1] - e.at[1]) < 6)) {
        bestW = w;
        best = e;
      }
    }
    if (best) {
      const c: V2 = [best.at[0] - best.out[0] * 2.4, best.at[1] - best.out[1] * 2.4];
      const h = 2.2;
      const z0 = ctx.ground(c[0], c[1]);
      megas.push({ kind: 'lighthouse', quads: [], frame: [[c[0] - h, c[1] - h], [c[0] + h, c[1] - h], [c[0] + h, c[1] + h], [c[0] - h, c[1] + h]], z0, z1: z0 + 15 });
    }
    // crates and barrels on the quay
    for (let q = 0; q < nq; q++) if (t.use[q] === 'quay' && hashf(q, spec.seed, 87) < 0.22) {
      const [x, y] = quadCentre(t, q);
      prop('crates', x, y, hashf(q, 88) * Math.PI, 1.6);
    }
  } else if (spec.purpose === 'mining') {
    const { at, dir } = works;
    const perp: V2 = [-dir[1], dir[0]];
    // the headframe beside the mouth, over its shaft
    const hf: V2 = [at[0] - dir[0] * 3 + perp[0] * 7, at[1] - dir[1] * 3 + perp[1] * 7];
    const z0 = ctx.ground(hf[0], hf[1]);
    const h = 2.4;
    megas.push({ kind: 'headframe', quads: [], frame: [[hf[0] - h, hf[1] - h], [hf[0] + h, hf[1] - h], [hf[0] + h, hf[1] + h], [hf[0] - h, hf[1] + h]], z0, z1: z0 + 13 });
    // rails from the town's rim into the mountain
    const a0 = Math.atan2(at[1] - cy, at[0] - cx);
    const from: V2 = [cx + Math.cos(a0) * R * 0.95, cy + Math.sin(a0) * R * 0.95];
    const to: V2 = [at[0] + dir[0] * 3, at[1] + dir[1] * 3];
    const L = Math.hypot(to[0] - from[0], to[1] - from[1]);
    const pts: V3[] = [];
    const gs: number[] = [];
    for (let k = 0; k <= Math.ceil(L / 4); k++) {
      const f = Math.min(1, (k * 4) / L);
      const x = from[0] + (to[0] - from[0]) * f;
      const y = from[1] + (to[1] - from[1]) * f;
      const g = ctx.ground(x, y);
      pts.push([x, y, g + 0.3]);
      gs.push(g);
    }
    linear.push({ kind: 'rail', points: pts, ground: gs, width: 1.8 });
    // ore carts on the rails, spoil heaps beside the mouth and the headframe
    for (const f of [0.35, 0.7]) {
      const p = pts[Math.floor(f * (pts.length - 1))];
      prop('cart', p[0], p[1], a0, 1.6, p[2] - 0.3);
    }
    for (const [u, v, s] of [[-6, -9, 6], [-12, 8, 4.5], [-3, 15, 5.5]]) prop('spoil', at[0] + dir[0] * u + perp[0] * v, at[1] + dir[1] * u + perp[1] * v, hashf(u, v, 89) * 6, s);
  } else if (spec.purpose === 'lumber') {
    const mill = ctx.buildings.find((b) => b.kind === 'sawmill');
    const { at, dir } = works;
    if (mill) {
      // the waterwheel on the mill's side nearest the water
      const c = buildingCentre(t, mill);
      let best: { m: V2; o: V2 } | null = null;
      let bd = Infinity;
      for (const q of mill.quads) {
        const p = quadCorners(t, q);
        for (let s = 0; s < 4; s++) {
          const n = adj[q * 4 + s];
          if (n >= 0 && ctx.quadBuilding[n] === mill.id) continue;
          const m: V2 = [(p[s][0] + p[(s + 1) % 4][0]) / 2, (p[s][1] + p[(s + 1) % 4][1]) / 2];
          const d = Math.hypot(m[0] - at[0], m[1] - at[1]);
          if (d < bd) {
            bd = d;
            best = { m, o: unit(m[0] - c[0], m[1] - c[1]) };
          }
        }
      }
      if (best) prop('waterwheel', best.m[0] + best.o[0] * 0.9, best.m[1] + best.o[1] * 0.9, Math.atan2(best.o[1], best.o[0]) + Math.PI / 2, 4.2, mill.base + 1.5);
      // log piles in the yards round it
      const mc = buildingCentre(t, mill);
      const yards = Array.from({ length: nq }, (_, q) => q)
        .filter((q) => t.use[q] === 'yard' && ctx.quadBuilding[q] < 0 && !ctx.isFarm(q))
        .map((q) => [q, Math.hypot(quadCentre(t, q)[0] - mc[0], quadCentre(t, q)[1] - mc[1])] as const)
        .sort((a, b) => a[1] - b[1])
        .slice(0, 7);
      for (const [q] of yards) {
        const [x, y] = quadCentre(t, q);
        const p = quadCorners(t, q);
        prop('logpile', x, y, Math.atan2(p[1][1] - p[0][1], p[1][0] - p[0][0]), 3.2 + 1.2 * hashf(q, 90));
      }
    }
    // logs floating on the river near the mill: along the river (across the way to the water)
    const along = Math.atan2(dir[0], -dir[1]);
    let n = 0;
    for (let k = 0; k < 60 && n < 12; k++) {
      const a = hashf(k, spec.seed, 91) * Math.PI * 2;
      const d = 4 + 30 * hashf(k, spec.seed, 92);
      const x = at[0] + dir[0] * 3 + Math.cos(a) * d;
      const y = at[1] + dir[1] * 3 + Math.sin(a) * d;
      if (depth(x, y) < 0.5) continue;
      prop('log', x, y, along + (hashf(k, 93) - 0.5) * 0.7, 3.5 + 2 * hashf(k, 94), surf(x, y) - 0.12);
      n++;
    }
  } else if (spec.purpose === 'farming') {
    const { at, dir } = works;
    const z0 = ctx.ground(at[0], at[1]);
    const h = 2.3;
    megas.push({ kind: 'windmill', quads: [], frame: [[at[0] - h, at[1] - h], [at[0] + h, at[1] - h], [at[0] + h, at[1] + h], [at[0] - h, at[1] + h]], z0, z1: z0 + 9 });
    // (its tile left open: the mill stands on it)
    for (let q = 0; q < nq; q++) {
      const [x, y] = quadCentre(t, q);
      if (Math.hypot(x - at[0], y - at[1]) < 4 && ctx.quadBuilding[q] < 0 && t.use[q] !== 'outside') t.use[q] = 'yard';
    }
    void dir;
    // haystacks in the farmsteads' yards
    for (let q = 0; q < nq; q++) if (ctx.isFarm(q) && t.use[q] === 'yard' && hashf(q, spec.seed, 95) < 0.35) {
      const [x, y] = quadCentre(t, q);
      prop('haystack', x, y, hashf(q, 96) * Math.PI, 2.6);
    }
  } else if (spec.purpose === 'trading') {
    // stalls over the market, facing its middle
    const pc = plazaCentre(t) ?? [cx, cy];
    const fountain = megas.find((m) => m.kind === 'fountain');
    for (let q = 0; q < nq; q++) {
      if (t.use[q] !== 'plaza' || hashf(q, spec.seed, 97) > 0.5) continue;
      const [x, y] = quadCentre(t, q);
      if (fountain && Math.hypot(x - fountain.frame[0][0], y - fountain.frame[0][1]) < 4) continue;
      prop('stall', x, y, Math.atan2(pc[1] - y, pc[0] - x), 2.8);
    }
    // the caravan yards: open tiles near the rim where the roads come in, wagons and a trough
    for (const a of approachesOf(spec)) {
      const at: V2 = [cx + a[0] * R * 0.95, cy + a[1] * R * 0.95];
      const open = Array.from({ length: nq }, (_, q) => q)
        .filter((q) => (t.use[q] === 'yard' || t.use[q] === 'lot') && ctx.quadBuilding[q] < 0 && !ctx.isFarm(q))
        .map((q) => [q, Math.hypot(quadCentre(t, q)[0] - at[0], quadCentre(t, q)[1] - at[1])] as const)
        .filter(([, d]) => d < 14)
        .sort((x, y) => x[1] - y[1])
        .slice(0, 4);
      open.forEach(([q], i) => {
        t.use[q] = 'yard';
        const [x, y] = quadCentre(t, q);
        prop(i === 3 ? 'trough' : 'wagon', x, y, Math.atan2(a[1], a[0]) + (hashf(q, 98) - 0.5) * 0.8, i === 3 ? 2 : 3.6);
      });
    }
  }
  return { berths, props };
}

/**
 * After the façades: the dressing — street lamps every ~12 m along the streets (at the kerb), torches at the front doors
 * of the purpose's buildings and some houses and by the gates, banners on the landmarks and round the plaza — and every
 * light's pool.
 */
export function dressing(ctx: PurposeCtx, facades: Facade[], megas: MegaFeature[], props: Prop[], berths: Berth[]): LightSource[] {
  const { spec, tiles: t, adj } = ctx;
  const nq = t.use.length;
  const prop = (kind: PropKind, x: number, y: number, heading: number, size: number, z = ctx.ground(x, y)) => props.push({ kind, at: [x, y, z], heading, size, seed: hashf(x, y, 81) });
  // street lamps: street and plaza tiles in a hashed order, one wherever none stands within 12 m, at the side by a lot
  const lamps: V2[] = props.filter((p) => p.kind === 'lamp').map((p) => [p.at[0], p.at[1]]);
  const streets = Array.from({ length: nq }, (_, q) => q).filter((q) => t.use[q] === 'street' || t.use[q] === 'quay' || (t.use[q] === 'plaza' && hashf(q, 31) < 0.5));
  streets.sort((a, b) => hashf(a, spec.seed, 32) - hashf(b, spec.seed, 32));
  for (const q of streets) {
    const c = quadCentre(t, q);
    if (lamps.some((l) => Math.hypot(l[0] - c[0], l[1] - c[1]) < 12)) continue;
    const p = quadCorners(t, q);
    let at = c;
    for (let s = 0; s < 4; s++) {
      const n = adj[q * 4 + s];
      if (n < 0 || (t.use[n] !== 'lot' && t.use[n] !== 'yard')) continue;
      const m: V2 = [(p[s][0] + p[(s + 1) % 4][0]) / 2, (p[s][1] + p[(s + 1) % 4][1]) / 2];
      at = [m[0] + (c[0] - m[0]) * 0.25, m[1] + (c[1] - m[1]) * 0.25];
      break;
    }
    if (lamps.some((l) => Math.hypot(l[0] - at[0], l[1] - at[1]) < 12)) continue;
    lamps.push(at);
    prop('lamp', at[0], at[1], 0, 3.2);
  }
  // torches: by the front doors of the purpose's buildings and of one house in five, and either side of each gate
  for (const f of facades) {
    if (f.kind !== 'door' || f.level !== 0) continue;
    const b = ctx.buildings[f.building];
    if (b.wear) continue;
    if (b.kind === 'house' || b.kind === 'hut' || b.kind === 'farmhouse' || b.kind === 'barn') {
      if (hashf(b.id, spec.seed, 33) > 0.2) continue;
    }
    const p = quadCorners(t, f.quad);
    const a = p[f.side];
    const c = p[(f.side + 1) % 4];
    const o = unit(c[1] - a[1], -(c[0] - a[0]));
    // (beside the door, on the wall's face, a little out)
    const x = a[0] + (c[0] - a[0]) * 0.3 + o[0] * 0.35;
    const y = a[1] + (c[1] - a[1]) * 0.3 + o[1] * 0.35;
    prop('torch', x, y, Math.atan2(o[1], o[0]), 2.3, b.base);
  }
  for (let q = 0; q < nq; q++) {
    if (t.use[q] !== 'gate') continue;
    const p = quadCorners(t, q);
    for (const k of [0, 2]) prop('torch', p[k][0], p[k][1], 0, 2.6);
  }
  // banners: on the landmarks' tops and round the plaza
  for (const m of megas) {
    if (m.kind !== 'tower' && m.kind !== 'keep' && m.kind !== 'lighthouse') continue;
    const cxm = (m.frame[0][0] + m.frame[2][0]) / 2;
    const cym = (m.frame[0][1] + m.frame[2][1]) / 2;
    const half = Math.hypot(m.frame[2][0] - m.frame[0][0], m.frame[2][1] - m.frame[0][1]) / (2 * Math.SQRT2);
    if (m.kind === 'keep') prop('banner', cxm + half * 0.7, cym, 0, 6, m.z1);
    else if (m.kind === 'tower') prop('banner', cxm, cym + half * 0.6, 0, 4, m.z1);
  }
  const pc = plazaCentre(t);
  if (pc) for (let k = 0; k < 4; k++) {
    const a = (k / 4) * Math.PI * 2 + hashf(spec.seed, 34);
    let best = -1;
    let bd = Infinity;
    for (let q = 0; q < nq; q++) {
      if (t.use[q] !== 'plaza') continue;
      const c = quadCentre(t, q);
      const d = Math.hypot(c[0] - (pc[0] + Math.cos(a) * 9), c[1] - (pc[1] + Math.sin(a) * 9));
      if (d < bd) {
        bd = d;
        best = q;
      }
    }
    if (best >= 0 && bd < 6) {
      const c = quadCentre(t, best);
      prop('banner', c[0], c[1], 0, 6.5);
    }
  }
  // the lights: each lamp, torch and beacon a pool; the ships' stern lanterns
  const lights: LightSource[] = [];
  for (const p of props) {
    if (p.kind === 'lamp') lights.push({ at: [p.at[0], p.at[1], p.at[2] + p.size], kind: 'lamp', radius: 7, foot: ctx.ground(p.at[0], p.at[1]) });
    else if (p.kind === 'torch') lights.push({ at: [p.at[0], p.at[1], p.at[2] + p.size], kind: 'torch', radius: 5, foot: ctx.ground(p.at[0], p.at[1]) });
  }
  for (const m of megas)
    if (m.kind === 'lighthouse') {
      const c: V2 = [(m.frame[0][0] + m.frame[2][0]) / 2, (m.frame[0][1] + m.frame[2][1]) / 2];
      lights.push({ at: [c[0], c[1], m.z1 + 1.5], kind: 'beacon', radius: 16, foot: m.z0 });
    }
  for (const b of berths) lights.push({ at: [b.at[0] - Math.cos(b.heading) * b.length * 0.42, b.at[1] - Math.sin(b.heading) * b.length * 0.42, b.at[2] + 3], kind: 'lantern', radius: 5, foot: b.at[2] });
  return lights;
}
