// Sites and roads (round 78, branch `places`): the atlas's superstructure of
// settlement. Sites go where the land makes them: on a plateau's rim over
// its cliff (Bulwark's cliffside cities), at a river's mouth on a coast, by
// a river in the lowlands, on a massif's flank, on a crater's rim; spaced
// apart, the best first. Roads join neighbouring sites of a continent (a
// relative neighbourhood graph), each found by A* over a coarse grid of the
// macro ground (slope costs, the sea can't be crossed). Walking each road
// says where it meets the macro features and how it crosses them — a ramp,
// switchbacks or a lift up a landform's edge (by the drop), a tunnel
// through a massif, a bridge over a river or a gorge. Those crossings are
// what a region's brief hands its generator (BACKLOG V2): the region stamps
// them intentionally.

import { rng } from '../world/noise';
import { TIER, type Landform } from './landforms';

export const SITE = { village: 0, town: 1, city: 2, metropolis: 3 } as const;
export const SITE_NAMES = ['village', 'town', 'city', 'metropolis'];
/** where a site is: what it was placed for */
export const SETTING = { cliff: 0, port: 1, river: 2, flank: 3, crater: 4, plain: 5 } as const;
export const SETTING_NAMES = ['cliffside', 'port', 'river', 'mountain flank', 'crater rim', 'plain'];
export const CROSS = { ramp: 0, switchbacks: 1, lift: 2, tunnel: 3, bridge: 4 } as const;
export const CROSS_NAMES = ['ramp', 'switchbacks', 'lift', 'tunnel', 'bridge'];

export interface Site {
  /** world position */
  x: number;
  y: number;
  size: number;
  setting: number;
  /** its landform (−1 none) and its continent */
  landform: number;
  cont: number;
  /** the ground there */
  h: number;
}

export interface Crossing {
  kind: number;
  /** where it starts and ends (world) and the ground at each */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  h0: number;
  h1: number;
}

export interface Road {
  a: number;
  b: number;
  /** world points along it (x, y pairs) */
  path: Float32Array;
  crossings: Crossing[];
  /** length in world units */
  length: number;
}

export interface Settlement {
  sites: Site[];
  roads: Road[];
  ms: number;
}

/** what the atlas knows, per texel (n × n) */
export interface SiteInput {
  n: number;
  seed: number;
  hmac: Float32Array;
  /** per texel: its landform (−1: water) */
  landformOf: Int32Array;
  forms: Landform[];
  /** per texel: its continent (an id; −1 water) */
  contOf: Int32Array;
  /** per texel: a river's node there (≠ 0) */
  river: Uint32Array;
  craters: Float32Array;
  craterWords: number;
  worldW: number;
  worldH: number;
  sea: number;
  count: number;
}

/** texels a coarse cell a side (the search's grid) */
const C = 4;
/** coarse cells between sites at least */
const SPACING = 18;
/** a road joins sites at most this far apart (coarse cells) */
const ROAD_REACH = 70;
/** a step up or down more than this (world units, between coarse cells) is a landform's edge to cross */
const STEP = 10;
/** a pass this high over both sides within this many cells of its top is tunnelled */
const TUNNEL_RISE = 45;
const TUNNEL_REACH = 14;

export function settle(inp: SiteInput): Settlement {
  const t0 = performance.now();
  const { n, hmac } = inp;
  const m = n / C;
  const M = m * m;
  const r = rng(inp.seed * 8191 + 77);
  // ---- the coarse grid: mean height, the middle texel's landform and continent, any river -------------
  const h = new Float32Array(M);
  const lf = new Int32Array(M);
  const cont = new Int32Array(M);
  const riv = new Uint8Array(M);
  for (let cy = 0; cy < m; cy++)
    for (let cx = 0; cx < m; cx++) {
      let s = 0;
      let rv = 0;
      for (let k = 0; k < C * C; k++) {
        const t = (cy * C + (k >> 2)) * n + cx * C + (k & 3);
        s += hmac[t];
        if (inp.river[t]) rv = 1;
      }
      const c = cy * m + cx;
      const mid = (cy * C + 2) * n + cx * C + 2;
      h[c] = s / (C * C);
      lf[c] = inp.landformOf[mid];
      cont[c] = inp.contOf[mid];
      riv[c] = rv;
    }
  const wrap = (x: number, y: number) => ((((y % m) + m) % m) * m + (((x % m) + m) % m)) | 0;
  const land = (c: number) => lf[c] >= 0 && h[c] > inp.sea;
  const tierOf = (c: number) => (lf[c] >= 0 ? inp.forms[lf[c]].tier : -1);
  const cellW = inp.worldW / m;
  const cellH = inp.worldH / m;
  const world = (c: number): [number, number] => [((c % m) + 0.5) * cellW, (Math.floor(c / m) + 0.5) * cellH];

  // ---- candidates: each land cell's best setting and its score --------------------------------------
  const craterNear = (x: number, y: number) => {
    for (let i = 0; i < inp.craters.length; i += inp.craterWords) {
      let dx = x - inp.craters[i];
      let dy = y - inp.craters[i + 1];
      dx -= Math.round(dx / inp.worldW) * inp.worldW;
      dy -= Math.round(dy / inp.worldH) * inp.worldH;
      const t = Math.hypot(dx, dy) / inp.craters[i + 2];
      if (t > 0.85 && t < 1.2) return true;
    }
    return false;
  };
  const cand: [number, number, number][] = [];
  for (let cy = 0; cy < m; cy++)
    for (let cx = 0; cx < m; cx++) {
      const c = cy * m + cx;
      if (!land(c)) continue;
      const t = tierOf(c);
      let sea = false;
      let drop = 0;
      let rough = 0;
      for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++) {
          const o = wrap(cx + dx, cy + dy);
          if (!land(o)) sea = true;
          else {
            drop = Math.max(drop, h[c] - h[o]);
            rough += Math.abs(h[c] - h[o]);
          }
        }
      const [wx, wy] = world(c);
      let setting: number = SETTING.plain;
      let score = 0.2;
      if (t === TIER.plateau && drop > 60) {
        setting = SETTING.cliff;
        score = 1.2;
      } else if (sea && riv[c]) {
        setting = SETTING.port;
        score = 1.4;
      } else if (riv[c] && t <= TIER.upland) {
        setting = SETTING.river;
        score = 1;
      } else if (t === TIER.massif && drop > 25 && drop < 90) {
        setting = SETTING.flank;
        score = 0.7;
      } else if (craterNear(wx, wy)) {
        setting = SETTING.crater;
        score = 0.9;
      } else if (sea) {
        setting = SETTING.port;
        score = 0.6;
      }
      // (flat ground is easier to build on, except where the setting is the cliff)
      if (setting !== SETTING.cliff) score -= Math.min(rough / 600, 0.5);
      cand.push([c, setting, score + r() * 0.5]);
    }
  cand.sort((a, b) => b[2] - a[2]);
  // ---- the best, spaced apart ---------------------------------------------------------------------------
  const taken: number[] = [];
  const sites: Site[] = [];
  const near = new Int32Array(M).fill(-1);
  for (const [c, setting] of cand) {
    if (sites.length >= inp.count) break;
    if (near[c] >= 0) continue;
    const cx = c % m;
    const cy = Math.floor(c / m);
    const [x, y] = world(c);
    const u = r();
    const size = u < 0.06 ? SITE.metropolis : u < 0.22 ? SITE.city : u < 0.6 ? SITE.town : SITE.village;
    sites.push({ x, y, size, setting, landform: lf[c], cont: cont[c], h: h[c] });
    taken.push(c);
    for (let dy = -SPACING; dy <= SPACING; dy++)
      for (let dx = -SPACING; dx <= SPACING; dx++) if (dx * dx + dy * dy <= SPACING * SPACING) near[wrap(cx + dx, cy + dy)] = sites.length - 1;
  }

  // ---- roads: the relative neighbourhood graph of each continent's sites ---------------------------
  const cdist = (a: number, b: number) => {
    let dx = (taken[a] % m) - (taken[b] % m);
    let dy = Math.floor(taken[a] / m) - Math.floor(taken[b] / m);
    dx -= Math.round(dx / m) * m;
    dy -= Math.round(dy / m) * m;
    return Math.hypot(dx, dy);
  };
  const edges: [number, number][] = [];
  for (let a = 0; a < sites.length; a++)
    for (let b = a + 1; b < sites.length; b++) {
      if (sites[a].cont !== sites[b].cont) continue;
      const d = cdist(a, b);
      if (d > ROAD_REACH) continue;
      let keep = true;
      for (let k = 0; k < sites.length && keep; k++) {
        if (k === a || k === b || sites[k].cont !== sites[a].cont) continue;
        if (Math.max(cdist(a, k), cdist(b, k)) < d) keep = false;
      }
      if (keep) edges.push([a, b]);
    }
  const roads: Road[] = [];
  for (const [a, b] of edges) {
    const path = findPath(taken[a], taken[b], m, h, land, riv, tierOf);
    if (!path) continue;
    roads.push(walk(a, b, path, m, h, riv, world));
  }
  return { sites, roads, ms: +(performance.now() - t0).toFixed(1) };
}

/** A* on the coarse grid (8 neighbours, wrapping): distance, slope, high ground and rivers cost; no sea */
function findPath(s: number, g: number, m: number, h: Float32Array, land: (c: number) => boolean, riv: Uint8Array, tierOf: (c: number) => number): number[] | null {
  const gx = g % m;
  const gy = Math.floor(g / m);
  const heur = (c: number) => {
    let dx = (c % m) - gx;
    let dy = Math.floor(c / m) - gy;
    dx -= Math.round(dx / m) * m;
    dy -= Math.round(dy / m) * m;
    return Math.hypot(dx, dy);
  };
  const cost = new Map<number, number>([[s, 0]]);
  const from = new Map<number, number>();
  // a binary heap of [f, cell]
  const heap: [number, number][] = [[heur(s), s]];
  const push = (e: [number, number]) => {
    heap.push(e);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p][0] <= heap[i][0]) break;
      [heap[p], heap[i]] = [heap[i], heap[p]];
      i = p;
    }
  };
  const pop = (): [number, number] => {
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const rr = l + 1;
        let k = i;
        if (l < heap.length && heap[l][0] < heap[k][0]) k = l;
        if (rr < heap.length && heap[rr][0] < heap[k][0]) k = rr;
        if (k === i) break;
        [heap[k], heap[i]] = [heap[i], heap[k]];
        i = k;
      }
    }
    return top;
  };
  let expanded = 0;
  while (heap.length) {
    const [, c] = pop();
    if (c === g) {
      const out = [c];
      let k = c;
      while (from.has(k)) out.push((k = from.get(k)!));
      return out.reverse();
    }
    if (++expanded > 60000) return null;
    const cc = cost.get(c)!;
    const cx = c % m;
    const cy = Math.floor(c / m);
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const o = ((((cy + dy) % m) + m) % m) * m + ((((cx + dx) % m) + m) % m);
        if (!land(o)) continue;
        const len = dx && dy ? Math.SQRT2 : 1;
        const dh = Math.abs(h[o] - h[c]);
        // (a gentle grade is free; a landform's edge is a crossing to build, dear but possible)
        let step = len * (1 + Math.max(0, dh - 2) * 0.08);
        if (dh > STEP) step += 6 + dh * 0.05;
        if (riv[o] && !riv[c]) step += 2;
        if (tierOf(o) === TIER.massif) step += h[o] * 0.004;
        const nc = cc + step;
        if (nc < (cost.get(o) ?? Infinity)) {
          cost.set(o, nc);
          from.set(o, c);
          push([nc + heur(o), o]);
        }
      }
  }
  return null;
}

/** a road's points and where it crosses the macro features */
function walk(
  a: number,
  b: number,
  path: number[],
  m: number,
  h: Float32Array,
  riv: Uint8Array,
  world: (c: number) => [number, number],
): Road {
  const pts = new Float32Array(path.length * 2);
  let length = 0;
  let prev: [number, number] | null = null;
  path.forEach((c, i) => {
    let [x, y] = world(c);
    // (unwrapped along the road, so its points run on across the world's edge)
    if (prev) {
      const W = world(m - 1)[0] + world(0)[0];
      const H = world((m - 1) * m)[1] + world(0)[1];
      x = prev[0] + (((x - prev[0] + W / 2) % W) + W) % W - W / 2;
      y = prev[1] + (((y - prev[1] + H / 2) % H) + H) % H - H / 2;
      length += Math.hypot(x - prev[0], y - prev[1]);
    }
    pts[i * 2] = x;
    pts[i * 2 + 1] = y;
    prev = [x, y];
  });
  const P = (i: number) => [pts[i * 2], pts[i * 2 + 1]] as const;
  const crossings: Crossing[] = [];
  const add = (kind: number, i: number, j: number) => {
    const [x0, y0] = P(i);
    const [x1, y1] = P(j);
    crossings.push({ kind, x0, y0, x1, y1, h0: h[path[i]], h1: h[path[j]] });
  };
  // tunnels: a pass — the road climbs TUNNEL_RISE or more to a top and comes down as far within
  // TUNNEL_REACH cells each side: straight through under it instead
  const inTunnel = new Uint8Array(path.length);
  const H = (i: number) => h[path[i]];
  for (let k = 1; k + 1 < path.length; k++) {
    if (inTunnel[k] || H(k) < H(k - 1) || H(k) < H(k + 1)) continue;
    let i0 = -1;
    for (let i = k - 1; i >= Math.max(0, k - TUNNEL_REACH); i--)
      if (H(k) - H(i) >= TUNNEL_RISE) {
        i0 = i;
        break;
      }
    let j1 = -1;
    for (let j = k + 1; j < Math.min(path.length, k + TUNNEL_REACH + 1); j++)
      if (H(k) - H(j) >= TUNNEL_RISE) {
        j1 = j;
        break;
      }
    if (i0 < 0 || j1 < 0 || inTunnel[i0]) continue;
    add(CROSS.tunnel, i0, j1);
    inTunnel.fill(1, i0, j1 + 1);
  }
  for (let i = 0; i + 1 < path.length; i++) {
    if (inTunnel[i]) continue;
    const c = path[i];
    const o = path[i + 1];
    // up or down a landform's edge: the steep run together, classed by its drop
    if (Math.abs(h[o] - h[c]) > STEP) {
      let j = i + 1;
      while (j + 1 < path.length && !inTunnel[j] && Math.abs(h[path[j + 1]] - h[path[j]]) > STEP) j++;
      const drop = Math.abs(h[path[j]] - h[c]);
      add(drop < 30 ? CROSS.ramp : drop < 90 ? CROSS.switchbacks : CROSS.lift, i, j);
      i = j - 1;
      continue;
    }
    // a gorge: the ground falls away and comes back up within a few cells
    if (i >= 1 && i + 3 < path.length && h[path[i - 1]] - h[o] > 20 && h[path[i + 3]] - h[o] > 20) {
      add(CROSS.bridge, i - 1, i + 3);
      i += 2;
      continue;
    }
    // a river: bridged where the road goes over it (a road running along one isn't crossing it)
    if (riv[o] && !riv[c]) {
      let j = i + 1;
      while (j + 1 < path.length && riv[path[j + 1]]) j++;
      if (j - i <= 3) add(CROSS.bridge, i, Math.min(j + 1, path.length - 1));
      i = j;
    }
  }
  return { a, b, path: pts, crossings, length };
}
