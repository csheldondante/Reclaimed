// (board, docs/design/BOARD.md) The home town as a small isometric tile map: where each of the model's sites stands,
// the river, the mountain, the woods, the fields, and the roads between them. Pure: no DOM, no model — the page reads
// the model (table/game.ts) and draws on this. The town's sites are the model's SITES (season/realm-templates.ts); the
// map is laid out by hand round them (the table has no town plan: BACKLOG CT-17, BD-1).
import { SITES, type SiteKey } from '../season/realm-templates';

export const N = 26;

export const enum T {
  Grass = 0,
  Rock = 1,
  Water = 2,
  Field = 3,
  Forest = 4,
  Road = 5,
  Bridge = 6,
  Sand = 7,
}

export interface Cell {
  x: number;
  y: number;
}

export interface Layout {
  n: number;
  /** ground kind per cell (index y * n + x) */
  tiles: Uint8Array;
  /** ground height step per cell (0 low by the river, 1 the town, 2 the mountain): water rises over the low ones first */
  height: Uint8Array;
  sites: Record<SiteKey, Cell>;
  /** where people come in from outside: by the east road (raiders, riders, carts), the south road, the river (ships) */
  entries: { east: Cell; south: Cell; river: Cell };
  /** the road cells, for walking */
  roads: Cell[];
  /** decorative house plots near the roads in the town's core, nearest the keep first */
  plots: Cell[];
}

export const idx = (x: number, y: number): number => y * N + x;
export const inside = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < N && y < N;

/** the river's top bank at column x (two cells of water from there) */
export const riverY = (x: number): number => 19 + Math.round(Math.sin(x * 0.45) * 1.2);

/** the sites' cells: laid out so the raiders' road (east) passes the watch post, the wall and the gate before the keep */
function siteCells(): Record<SiteKey, Cell> {
  return {
    keep: { x: 12, y: 10 },
    forge: { x: 15, y: 7 },
    quarter: { x: 9, y: 13 },
    fields: { x: 18, y: riverY(18) - 2 },
    market: { x: 13, y: 13 },
    gate: { x: 20, y: 11 },
    tower: { x: 8, y: 6 },
    dam: { x: 3, y: riverY(3) - 1 },
    shrine: { x: 3, y: 2 },
    mill: { x: 6, y: riverY(6) - 2 },
    wall: { x: 19, y: 14 },
    watch: { x: 23, y: 9 },
    harbour: { x: 10, y: riverY(10) - 1 },
    quarry: { x: 7, y: 1 },
    woods: { x: 22, y: 3 },
    river: { x: 14, y: riverY(14) },
    road: { x: 24, y: 13 },
    pit: { x: 11, y: 3 },
    wagons: { x: 17, y: 10 },
    graves: { x: 5, y: 9 },
  };
}

/** A* over the grid: roads are cheap (paths share them), water dear except where a bridge may go */
function path(tiles: Uint8Array, from: Cell, to: Cell, bridge: (c: Cell) => boolean): Cell[] {
  const cost = (x: number, y: number): number => {
    const t = tiles[idx(x, y)];
    if (t === T.Road || t === T.Bridge) return 0.35;
    if (t === T.Water) return bridge({ x, y }) ? 1 : 80;
    if (t === T.Rock) return 3;
    if (t === T.Forest || t === T.Field) return 2.5;
    return 1;
  };
  const g = new Float64Array(N * N).fill(Infinity);
  const prev = new Int32Array(N * N).fill(-1);
  const open: number[] = [idx(from.x, from.y)];
  g[open[0]] = 0;
  const h = (i: number): number => Math.abs((i % N) - to.x) + Math.abs(Math.floor(i / N) - to.y);
  const goal = idx(to.x, to.y);
  while (open.length) {
    let bi = 0;
    for (let k = 1; k < open.length; k++) if (g[open[k]] + h(open[k]) * 0.35 < g[open[bi]] + h(open[bi]) * 0.35) bi = k;
    const i = open.splice(bi, 1)[0];
    if (i === goal) break;
    const x = i % N;
    const y = Math.floor(i / N);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx;
      const ny = y + dy;
      if (!inside(nx, ny)) continue;
      const j = idx(nx, ny);
      const ng = g[i] + cost(nx, ny);
      if (ng < g[j]) {
        g[j] = ng;
        prev[j] = i;
        if (!open.includes(j)) open.push(j);
      }
    }
  }
  const out: Cell[] = [];
  for (let i = goal; i >= 0; i = prev[i]) out.unshift({ x: i % N, y: Math.floor(i / N) });
  return out[0] && out[0].x === from.x && out[0].y === from.y ? out : [];
}

export function townLayout(): Layout {
  const tiles = new Uint8Array(N * N);
  const height = new Uint8Array(N * N).fill(1);
  const sites = siteCells();
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const i = idx(x, y);
      const ry = riverY(x);
      if (y === ry || y === ry + 1) {
        tiles[i] = T.Water;
        height[i] = 0;
      } else if (Math.abs(y - ry) <= 2 || (y > ry + 1 && y <= ry + 3)) {
        height[i] = 0;
        if (y === ry - 1 || y === ry + 2) tiles[i] = T.Sand;
      }
      if (x + y <= 6 && y < ry - 1) {
        tiles[i] = T.Rock;
        height[i] = 2;
      }
      // (the woods: the north-east corner, ragged)
      if (x >= 19 && y <= 6 && ((x * 7 + y * 13) % 5 !== 0 || (x > 21 && y < 5))) tiles[i] = T.Forest;
      // (the far bank: woods and fields)
      if (y > ry + 2 && (x * 5 + y * 3) % 4 === 0) tiles[i] = T.Forest;
    }
  // (the east fields: a patch by the river; more fields along the bank)
  const f = sites.fields;
  for (let y = f.y - 2; y <= f.y + 1; y++) for (let x = f.x - 2; x <= f.x + 3; x++) if (inside(x, y) && tiles[idx(x, y)] === T.Grass) tiles[idx(x, y)] = T.Field;
  const entries = { east: { x: N - 1, y: 12 }, south: { x: 14, y: N - 1 }, river: { x: 0, y: riverY(0) } };
  const bridgeAt = sites.river;
  const lay = (a: Cell, b: Cell): void => {
    for (const c of path(tiles, a, b, (q) => q.x === bridgeAt.x)) {
      const i = idx(c.x, c.y);
      tiles[i] = tiles[i] === T.Water || tiles[i] === T.Bridge ? T.Bridge : T.Road;
    }
  };
  // (the main roads first, so the others join them)
  lay(entries.east, sites.keep);
  lay(entries.south, sites.keep);
  const order = (Object.keys(sites) as SiteKey[]).sort((a, b) => dist(sites[a], sites.keep) - dist(sites[b], sites.keep));
  for (const k of order) if (k !== 'keep') lay(sites[k], sites.keep);
  const roads: Cell[] = [];
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if (tiles[idx(x, y)] === T.Road || tiles[idx(x, y)] === T.Bridge) roads.push({ x, y });
  // (house plots: grass next to a road, within the town's core, not on a site)
  const taken = new Set(Object.values(sites).map((c) => idx(c.x, c.y)));
  const plots: Cell[] = [];
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const i = idx(x, y);
      if (tiles[i] !== T.Grass || taken.has(i) || height[i] === 0) continue;
      if (dist({ x, y }, sites.keep) > 9) continue;
      const nearRoad = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => inside(x + dx, y + dy) && tiles[idx(x + dx, y + dy)] === T.Road);
      const nearSite = [...taken].some((j) => Math.abs((j % N) - x) <= 1 && Math.abs(Math.floor(j / N) - y) <= 1);
      if (nearRoad && !nearSite) plots.push({ x, y });
    }
  plots.sort((a, b) => dist(a, sites.keep) - dist(b, sites.keep) || a.x - b.x || a.y - b.y);
  return { n: N, tiles, height, sites, entries, roads, plots };
}

export const dist = (a: Cell, b: Cell): number => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

/** a walk along the roads from one cell to another (the first and last steps may leave the road) */
export function roadPath(l: Layout, from: Cell, to: Cell): Cell[] {
  const near = (c: Cell): Cell => (l.tiles[idx(c.x, c.y)] === T.Road || l.tiles[idx(c.x, c.y)] === T.Bridge ? c : l.roads.reduce((b, r) => (dist(r, c) < dist(b, c) ? r : b), l.roads[0]));
  const a = near(from);
  const b = near(to);
  // (BFS on road cells only)
  const key = (c: Cell) => idx(c.x, c.y);
  const isRoad = (x: number, y: number) => inside(x, y) && (l.tiles[idx(x, y)] === T.Road || l.tiles[idx(x, y)] === T.Bridge);
  const prev = new Map<number, number>([[key(a), -1]]);
  const q = [a];
  while (q.length) {
    const c = q.shift()!;
    if (c.x === b.x && c.y === b.y) break;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = c.x + dx;
      const ny = c.y + dy;
      if (!isRoad(nx, ny) || prev.has(idx(nx, ny))) continue;
      prev.set(idx(nx, ny), key(c));
      q.push({ x: nx, y: ny });
    }
  }
  const out: Cell[] = [];
  if (!prev.has(key(b))) return [from, to];
  for (let i = key(b); i >= 0; i = prev.get(i)!) out.unshift({ x: i % N, y: Math.floor(i / N) });
  if (from.x !== a.x || from.y !== a.y) out.unshift(from);
  if (to.x !== b.x || to.y !== b.y) out.push(to);
  return out;
}

/** the site keys in the model's order */
export const SITE_KEYS = SITES.map((s) => s.key) as SiteKey[];
