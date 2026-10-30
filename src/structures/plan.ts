// The planner: a CitySpec and the ground → a CityPlan (tiles, buildings, occupancy spans, façades, landmarks, nav).
// Pure and deterministic (same spec + ground → same plan) so it can run anywhere — a worker, Node's tests, the viewer —
// and be stored as just its spec (towns grow as stored progress, round 110: the plan is re-made, the progress kept).
//
// Why on the CPU (the rule is GPU first where data is large or per-frame): a city's plan is small (a few thousand
// tiles, ~100 KB), made once when its land arrives, and its hard parts are sequential (WFC's propagation, growing
// buildings tile by tile). What is large or per-frame — drawing its pieces, stamping its columns — is on the GPU.
// Measured: data/perf/structures-*.json (plan ms per city size).
import type { BuildingRec, CityPlan, CitySpec, Facade, FacadeKind, GroundFn, MegaFeature, Span, TileMesh, TileUse, V2 } from '../api/contracts/structures';
import { tileSystem } from './tiles/systems';
import { adjacency, quadArea, quadCentre, quadCorners } from './tiles/builder';
import { fbm, hashf, rng } from './rng';
import { solve, type WfcProblem } from './wfc';
import { bakeNav } from './nav';
import { styleOf } from './styles';

export const STOREY_H = 3;
/** a rampart's height over the ground (m) */
export const WALL_H = 7;

export function planCity(spec: CitySpec, ground: GroundFn): CityPlan {
  const t0 = performance.now();
  const tiles = tileSystem({ spec, ground });
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
  const density = spec.density ?? 0.8;
  const [sMid, sRim] = spec.storeys ?? style.storeys;
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

  // ---- which lots are built (the rest are yards: gardens, courtyards, room to grow)
  const built = new Uint8Array(nq);
  for (let q = 0; q < nq; q++) {
    if (tiles.use[q] !== 'lot') continue;
    const [cxq, cyq] = quadCentre(tiles, q);
    const d = Math.hypot(cxq - cx, cyq - cy) / R;
    const [lo, hi] = quadG(q);
    const n = fbm(cxq * 0.05, cyq * 0.05, spec.seed + 3);
    const p = density * (1.05 - 0.35 * d * d) * (0.7 + 0.6 * n);
    if (hi - lo > STOREY_H * 1.3 || hashf(q, spec.seed, 1) > p || quadArea(tiles, q) < 2.5) tiles.use[q] = 'yard';
    else built[q] = 1;
  }

  // ---- buildings: grown tile by tile inside a block, a few tiles each, on ground no steeper than a storey
  const quadBuilding = new Int32Array(nq).fill(-1);
  const buildings: BuildingRec[] = [];
  const order = Array.from({ length: nq }, (_, q) => q).filter((q) => built[q]);
  for (let k = order.length - 1; k > 0; k--) {
    const m = Math.floor(r() * (k + 1));
    [order[k], order[m]] = [order[m], order[k]];
  }
  for (const q0 of order) {
    if (quadBuilding[q0] >= 0) continue;
    const id = buildings.length;
    const want = 1 + Math.floor(r() * r() * style.maxTiles);
    const quads = [q0];
    quadBuilding[q0] = id;
    let [lo, hi] = quadG(q0);
    for (let i = 0; i < quads.length && quads.length < want; i++)
      for (let s = 0; s < 4 && quads.length < want; s++) {
        const n = adj[quads[i] * 4 + s];
        if (n < 0 || !built[n] || quadBuilding[n] >= 0 || tiles.block[n] !== tiles.block[q0]) continue;
        const [l2, h2] = quadG(n);
        if (Math.max(hi, h2) - Math.min(lo, l2) > STOREY_H * 0.9) continue;
        lo = Math.min(lo, l2);
        hi = Math.max(hi, h2);
        quadBuilding[n] = id;
        quads.push(n);
      }
    const [bx, by] = quadCentre(tiles, q0);
    const d = Math.min(1, Math.hypot(bx - cx, by - cy) / R);
    const storeys = Math.max(1, Math.round(sMid + (sRim - sMid) * Math.pow(d, 0.8) + (fbm(bx * 0.04, by * 0.04, spec.seed + 9) - 0.5) * 2.2 + (r() - 0.5) * 0.8));
    buildings.push({ id, quads, base: hi + 0.15 - (spec.sunk ?? 0), storeys, storeyH: STOREY_H, look: Math.floor(r() * 65536) });
  }

  // ---- landmarks (mega tiles): the tallest building near the middle becomes a tower; a fountain in the plaza
  const megas: MegaFeature[] = [];
  const quadTop = new Float64Array(nq).fill(NaN);
  const quadStoreys = new Int32Array(nq);
  for (const b of buildings)
    for (const q of b.quads) {
      // (a tile now and then a storey up or down from its building: Townscaper's stepped skylines)
      const h = hashf(q, spec.seed, 2);
      const s = Math.max(1, b.storeys + (h < 0.14 ? 1 : h > 0.88 && b.quads.length > 1 ? -1 : 0));
      quadStoreys[q] = s;
      quadTop[q] = b.base + s * b.storeyH;
    }
  if (style.towers > 0) {
    const cand = buildings.filter((b) => b.quads.length === 1).sort((a, b) => {
      const da = Math.hypot(quadCentre(tiles, a.quads[0])[0] - cx, quadCentre(tiles, a.quads[0])[1] - cy);
      const db = Math.hypot(quadCentre(tiles, b.quads[0])[0] - cx, quadCentre(tiles, b.quads[0])[1] - cy);
      return da - db;
    });
    for (const b of cand.slice(0, style.towers)) {
      const q = b.quads[0];
      b.mega = 'tower';
      b.storeys = Math.max(b.storeys + 3, Math.round(sMid) + 3);
      quadStoreys[q] = b.storeys;
      quadTop[q] = b.base + b.storeys * b.storeyH;
      megas.push({ kind: 'tower', quads: [q], frame: quadCorners(tiles, q), z0: b.base, z1: quadTop[q] });
    }
  }
  const plaza = Array.from({ length: nq }, (_, q) => q).filter((q) => tiles.use[q] === 'plaza');
  if (plaza.length) {
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

  // ---- spans (the occupancy truth): foundations, storeys, ramparts
  const spans: Span[] = [];
  const roofRise: number[] = [];
  for (const b of buildings) {
    let edge = 0;
    let ne = 0;
    for (const q of b.quads) {
      const p = quadCorners(tiles, q);
      for (let k = 0; k < 4; k++) {
        edge += Math.hypot(p[(k + 1) % 4][0] - p[k][0], p[(k + 1) % 4][1] - p[k][1]);
        ne++;
      }
    }
    roofRise.push((edge / ne) * style.pitch);
    for (const q of b.quads) {
      const [lo] = quadG(q);
      if (b.base > lo) spans.push({ quad: q, z0: lo - 0.5, z1: b.base, kind: 'foundation', building: b.id });
      spans.push({ quad: q, z0: b.base, z1: quadTop[q], kind: b.mega === 'tower' ? 'tower' : 'room', building: b.id });
    }
  }
  for (let q = 0; q < nq; q++)
    if (tiles.use[q] === 'wall' || tiles.use[q] === 'gate') {
      const [lo, hi] = quadG(q);
      spans.push({ quad: q, z0: lo - 0.5, z1: hi + WALL_H, kind: 'rampart', building: -1 });
      quadTop[q] = hi + WALL_H;
    }

  // ---- façades: which wall each storey of each side shows (WFC per building)
  const facades = facadesOf(tiles, adj, buildings, quadBuilding, quadStoreys, spec.seed);
  const t2 = performance.now();
  const plan: CityPlan = {
    spec,
    tiles,
    ground: gz,
    spans,
    buildings,
    facades,
    quadBuilding,
    quadTop,
    roofRise,
    megas,
    linear: [],
    nav: { nodes: [], links: [] },
    stats: {},
  };
  plan.nav = bakeNav(plan, adj);
  const t3 = performance.now();
  plan.stats = {
    tiles: nq,
    buildings: buildings.length,
    facades: facades.length,
    navNodes: plan.nav.nodes.length,
    navLinks: plan.nav.links.length,
    tilesMs: +(t1 - t0).toFixed(2),
    planMs: +(t2 - t1).toFixed(2),
    navMs: +(t3 - t2).toFixed(2),
  };
  return plan;
}

// ------------------------------------------------------------------ façades

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

function facadesOf(tiles: TileMesh, adj: Int32Array, buildings: BuildingRec[], quadBuilding: Int32Array, quadStoreys: Int32Array, seed: number): Facade[] {
  const out: Facade[] = [];
  for (const b of buildings) {
    if (b.mega || quadBuilding[b.quads[0]] !== b.id) continue;
    const nodes: Facade[] = [];
    const len: number[] = [];
    const street: boolean[] = [];
    for (const q of b.quads) {
      const p = quadCorners(tiles, q);
      for (let s = 0; s < 4; s++) {
        const n = adj[q * 4 + s];
        const L = Math.hypot(p[(s + 1) % 4][0] - p[s][0], p[(s + 1) % 4][1] - p[s][1]);
        for (let l = 0; l < quadStoreys[q]; l++) {
          const z0 = b.base + l * b.storeyH;
          const z1 = z0 + b.storeyH;
          // hidden where a neighbour's storeys cover this one (its own building's, or one leaning on it)
          if (n >= 0 && quadBuilding[n] >= 0) {
            const nb = buildings[quadBuilding[n]];
            const top = nb.base + quadStoreys[n] * nb.storeyH;
            if (nb.base <= z0 + 0.01 && top >= z1 - 0.01) continue;
          }
          nodes.push({ quad: q, side: s, level: l, z0, z1, kind: 'blank', building: b.id });
          len.push(L);
          street.push(n >= 0 && (tiles.use[n] === 'street' || tiles.use[n] === 'plaza'));
        }
      }
    }
    if (!nodes.length) continue;
    const T = KINDS.length;
    const domain = new Uint32Array(nodes.length);
    const weight = new Float64Array(nodes.length * T);
    // the front door: the longest street-facing ground wall (else the longest ground wall)
    let front = -1;
    nodes.forEach((f, i) => {
      if (f.level !== 0) return;
      // (long enough for a door first, then facing the street, then the longest)
      const score = (len[i] >= 1.8 ? 1000 : 0) + (street[i] ? 100 : 0) + len[i];
      const was = front < 0 ? -1 : (len[front] >= 1.8 ? 1000 : 0) + (street[front] ? 100 : 0) + len[front];
      if (score > was) front = i;
    });
    nodes.forEach((f, i) => {
      const L = len[i];
      let d = f.level === 0 ? bits(BLANK, WINDOW, WINDOW2, DOOR, SHOP) : bits(BLANK, WINDOW, WINDOW2, BALCONY);
      if (L < 1.8) d = bits(BLANK);
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
    const sol = solve(prob, seed * 977 + b.id);
    nodes.forEach((f, i) => {
      f.kind = KINDS[sol[i]];
      out.push(f);
    });
  }
  return out;
}

/** the tiles' corners as points, for the viewer's outlines */
export function tileOutline(t: TileMesh, q: number): V2[] {
  return quadCorners(t, q);
}

/**
 * One building of a plan on its own (the viewer's building view): the others taken away, its façades and roofs worked
 * out again as if it stood alone — the walls its neighbours hid are shown, its roofs no longer lean on theirs.
 */
export function isolate(plan: CityPlan, id: number): CityPlan {
  const b = plan.buildings[id];
  const nq = plan.tiles.use.length;
  const quadBuilding = new Int32Array(nq).fill(-1);
  const quadTop = new Float64Array(nq).fill(NaN);
  const quadStoreys = new Int32Array(nq);
  for (const q of b.quads) {
    quadBuilding[q] = id;
    quadTop[q] = plan.quadTop[q];
    quadStoreys[q] = Math.round((plan.quadTop[q] - b.base) / b.storeyH);
  }
  const adj = adjacency(plan.tiles);
  const facades = facadesOf(plan.tiles, adj, plan.buildings, quadBuilding, quadStoreys, plan.spec.seed);
  const tiles = { ...plan.tiles, use: plan.tiles.use.map((u): TileUse => (u === 'lot' || u === 'yard' ? 'yard' : u)) };
  for (const q of b.quads) tiles.use[q] = 'lot';
  return { ...plan, tiles, quadBuilding, quadTop, facades, megas: [], spans: plan.spans.filter((s) => s.building === id) };
}
