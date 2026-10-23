// Places (docs/PLACES.md, round 51): regions, and rooms within them, as named
// places a runtime (a game, an LLM game master) can query and mutate. This
// file is the CPU side's model: the plan format, its rasterization onto the
// hex lattice (one u32 per column: low u16 the room of the open air on top,
// high u16 the room of the first enclosed level under it, 0 = the same), the
// graph of rooms (adjacency from the raster, suggested connections, the
// connection records) and the queries. No GPU here: sim/placeops.ts uploads
// the raster and table and runs the ops masked to a place.

import { type Sdf, band } from './kit';
import { cellAt, cellPos, nbr, NDIR, worldSize } from './lattice';
import { fbm, rng } from './noise';

/** Place ids fit a u16; 0 is "no place". */
export const MAX_PLACES = 4096;

export type PlaceKind = 'region' | 'room';

export interface Place {
  id: number;
  name: string;
  kind: PlaceKind;
  /** a room's region; a region's is 0 */
  parent: number;
  /** a region's rooms */
  children: number[];
  tags: string[];
  /** columns whose top room this is (rooms; a region: its rooms') */
  cells: number;
  /** world centre of its footprint and its extent's radius (cells from the centre) */
  centre: [number, number];
  radius: number;
}

export type ConnectionKind = 'open' | 'door' | 'gate' | 'rubble' | 'boulder' | 'ice' | 'vines' | 'water' | 'sand' | 'wall';

export interface Connection {
  a: number;
  b: number;
  kind: ConnectionKind;
  width: number;
  /** where on the border they meet (world xy) */
  at: [number, number];
  state: 'open' | 'closed';
}

export interface Adjacent {
  room: number;
  /** this place's columns that touch the other (column indices y·w + x) */
  border: number[];
  /** shared edges (cell sides) */
  length: number;
  /** world xy: the middle of the shared border */
  mid: [number, number];
}

interface NamedRoom {
  name: string;
  region?: string;
  tags?: string[];
}

/** A room drawn by hand: its footprint an SDF in world coordinates (kit.ts). */
export interface SdfRoom extends NamedRoom {
  sdf: Sdf;
}

/** A box room: [x0, y0, x1, y1] world. */
export interface BoxRoom extends NamedRoom {
  rect: [number, number, number, number];
}

/** A hall between two rooms (by name): a band between their centres. */
export interface Hall {
  a: string;
  b: string;
  width: number;
}

export interface Borders {
  /** world cells the borders wander (domain warp); 0: straight */
  amp?: number;
  /** world cells per wobble */
  scale?: number;
}

export type Shape = 'chain' | 'tree' | 'any';

export type Plan = Borders &
  (
    | {
        partition: 'voronoi';
        /** world cells between Voronoi seeds (Poisson-disc) */
        spacing: number;
        /** Voronoi cells a room joins, [min, max] */
        group?: [number, number];
        /** how many regions (nearest of a coarser set of seeds) */
        regions?: number;
        shape?: Shape;
      }
    | {
        partition: 'bands';
        /** noise frequency (per world cell) */
        freq: number;
        /** half-width of the halls, in noise units (near 0: thin tunnels) */
        tunnel: number;
        /** the noise level the halls follow (a bit off 0: islands) */
        island?: number;
        regions?: number;
        shape?: Shape;
      }
    | { partition: 'boxes'; rooms: BoxRoom[]; halls?: Hall[]; regions?: { name: string; tags?: string[] }[] }
    | { partition?: undefined; rooms: SdfRoom[]; halls?: Hall[]; regions?: { name: string; tags?: string[] }[] }
  );

/** Per-place mask matcher: the room ids that make up a place. */
export function roomsOf(p: Place): number[] {
  return p.kind === 'room' ? [p.id] : p.children.slice();
}

export class PlaceMap {
  readonly w: number;
  readonly h: number;
  /** per column: low u16 top room, high u16 enclosed level's room (0 = the same) */
  readonly cols: Uint32Array;
  readonly places: (Place | undefined)[] = [undefined];
  /** suggested connections from the plan's shape (W1 carves them) */
  suggested: { a: number; b: number }[] = [];
  readonly connections: Connection[] = [];
  private adj = new Map<number, Map<number, Adjacent>>();
  private byName = new Map<string, number>();

  constructor(w: number, h: number) {
    this.w = w;
    this.h = h;
    this.cols = new Uint32Array(w * h);
  }

  // ---- building ----------------------------------------------------------

  add(name: string, kind: PlaceKind, parent = 0, tags: string[] = []): Place {
    if (this.places.length >= MAX_PLACES) throw new Error(`places: more than ${MAX_PLACES - 1} places`);
    if (this.byName.has(name)) throw new Error(`places: "${name}" twice`);
    const p: Place = { id: this.places.length, name, kind, parent, children: [], tags, cells: 0, centre: [0, 0], radius: 0 };
    this.places.push(p);
    this.byName.set(name, p.id);
    if (parent) this.place(parent).children.push(p.id);
    return p;
  }

  /** After the raster is filled: footprints, centres, extents, adjacency. */
  finish(): void {
    const { w, h, cols } = this;
    const sx = new Float64Array(this.places.length);
    const sy = new Float64Array(this.places.length);
    for (const p of this.places)
      if (p) {
        p.cells = 0;
        p.radius = 0;
      }
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const r = cols[y * w + x] & 0xffff;
        if (!r) continue;
        const [px, py] = cellPos(x, y);
        const p = this.place(r);
        p.cells++;
        sx[r] += px;
        sy[r] += py;
        if (p.parent) {
          this.place(p.parent).cells++;
          sx[p.parent] += px;
          sy[p.parent] += py;
        }
      }
    for (const p of this.places) if (p && p.cells) p.centre = [sx[p.id] / p.cells, sy[p.id] / p.cells];
    // extents: the farthest column from the centre
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const r = cols[y * w + x] & 0xffff;
        if (!r) continue;
        const [px, py] = cellPos(x, y);
        for (const id of [r, this.place(r).parent]) {
          if (!id) continue;
          const p = this.place(id);
          p.radius = Math.max(p.radius, Math.hypot(px - p.centre[0], py - p.centre[1]));
        }
      }
    // adjacency between rooms, from the raster: each shared cell side once
    this.adj.clear();
    const mids = new Map<string, [number, number, number]>();
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const a = cols[i] & 0xffff;
        if (!a) continue;
        for (let k = 0; k < NDIR; k++) {
          const [nx, ny] = nbr(x, y, k);
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const b = cols[ny * w + nx] & 0xffff;
          if (!b || b === a) continue;
          const e = this.edge(a, b);
          if (!e.border.includes(i)) e.border.push(i);
          const j = ny * w + nx;
          if (j < i) continue;
          // (counted once per side: from the lower index)
          e.length++;
          this.edge(b, a).length++;
          const [ax, ay] = cellPos(x, y);
          const [bx, by] = cellPos(nx, ny);
          const key = a < b ? `${a},${b}` : `${b},${a}`;
          const m = mids.get(key) ?? [0, 0, 0];
          m[0] += (ax + bx) / 2;
          m[1] += (ay + by) / 2;
          m[2]++;
          mids.set(key, m);
        }
      }
    for (const [key, m] of mids) {
      const [a, b] = key.split(',').map(Number);
      const mid: [number, number] = [m[0] / m[2], m[1] / m[2]];
      this.edge(a, b).mid = mid;
      this.edge(b, a).mid = mid;
    }
  }

  private edge(a: number, b: number): Adjacent {
    let m = this.adj.get(a);
    if (!m) this.adj.set(a, (m = new Map()));
    let e = m.get(b);
    if (!e) m.set(b, (e = { room: b, border: [], length: 0, mid: [0, 0] }));
    return e;
  }

  // ---- queries -----------------------------------------------------------

  /** by name or id; throws for an unknown place */
  place(key: string | number): Place {
    const id = typeof key === 'number' ? key : this.byName.get(key);
    const p = id === undefined ? undefined : this.places[id];
    if (!p) throw new Error(`places: no place ${JSON.stringify(key)}`);
    return p;
  }

  has(key: string | number): boolean {
    const id = typeof key === 'number' ? key : this.byName.get(key);
    return id !== undefined && !!this.places[id];
  }

  /** every place (regions and rooms) */
  all(): Place[] {
    return this.places.filter((p): p is Place => !!p);
  }

  /**
   * The room at world (x, y): the top room, or with z below `groundAt` there
   * (the top of the column's open air) the enclosed level's room where the
   * column has one. 0: no place.
   */
  roomAt(x: number, y: number, z?: number, groundAt?: (x: number, y: number) => number): number {
    const [cx, cy] = cellAt(x, y);
    if (cx < 0 || cy < 0 || cx >= this.w || cy >= this.h) return 0;
    const v = this.cols[cy * this.w + cx];
    const low = v & 0xffff;
    const high = v >>> 16;
    if (!high || z === undefined) return low;
    if (!groundAt) throw new Error('places.at: a column with an enclosed level needs the ground height');
    return z < groundAt(x, y) - 0.5 ? high : low;
  }

  /** A room's rooms next to it, or a region's regions next to it (borders summed). */
  adjacent(key: string | number): Adjacent[] {
    const p = this.place(key);
    if (p.kind === 'room') return [...(this.adj.get(p.id)?.values() ?? [])].map((e) => ({ ...e, border: e.border.slice() }));
    const out = new Map<number, Adjacent & { n: number }>();
    for (const r of p.children)
      for (const e of this.adj.get(r)?.values() ?? []) {
        const other = this.place(e.room).parent;
        if (other === p.id) continue;
        const o = out.get(other) ?? { room: other, border: [], length: 0, mid: [0, 0] as [number, number], n: 0 };
        o.border.push(...e.border);
        o.mid = [o.mid[0] + e.mid[0] * e.length, o.mid[1] + e.mid[1] * e.length];
        o.length += e.length;
        out.set(other, o);
      }
    return [...out.values()].map(({ n: _n, ...o }) => ({ ...o, mid: [o.mid[0] / o.length, o.mid[1] / o.length] as [number, number] }));
  }

  connectionsOf(key: string | number): (Connection & { to: number })[] {
    const id = this.place(key).id;
    return this.connections.filter((c) => c.a === id || c.b === id).map((c) => ({ ...c, to: c.a === id ? c.b : c.a }));
  }

  /**
   * Record a connection between two adjacent rooms (a record only: carving
   * or building it in the terrain is step 2, W1). Replaces an existing one.
   */
  connect(a: string | number, b: string | number, opt: { kind?: ConnectionKind; width?: number; at?: [number, number] } = {}): Connection {
    const pa = this.place(a);
    const pb = this.place(b);
    if (pa.kind !== 'room' || pb.kind !== 'room') throw new Error('places.connect: rooms only');
    const e = this.adj.get(pa.id)?.get(pb.id);
    if (!e) throw new Error(`places.connect: "${pa.name}" and "${pb.name}" are not adjacent`);
    this.drop(pa.id, pb.id);
    const kind = opt.kind ?? 'open';
    const c: Connection = { a: pa.id, b: pb.id, kind, width: opt.width ?? 3, at: opt.at ?? e.mid, state: kind === 'open' ? 'open' : 'closed' };
    this.connections.push(c);
    return c;
  }

  /** Close it off with something (a record, like connect). */
  disconnect(a: string | number, b: string | number, opt: { with?: ConnectionKind } = {}): Connection {
    const c = this.connect(a, b, { kind: opt.with ?? 'wall' });
    c.state = 'closed';
    return c;
  }

  private drop(a: number, b: number): void {
    for (let i = this.connections.length - 1; i >= 0; i--) {
      const c = this.connections[i];
      if ((c.a === a && c.b === b) || (c.a === b && c.b === a)) this.connections.splice(i, 1);
    }
  }

  rename(key: string | number, name: string): void {
    const p = this.place(key);
    if (this.byName.has(name) && this.byName.get(name) !== p.id) throw new Error(`places: "${name}" is taken`);
    this.byName.delete(p.name);
    p.name = name;
    this.byName.set(name, p.id);
  }

  tag(key: string | number, ...tags: string[]): void {
    const p = this.place(key);
    for (const t of tags) if (!p.tags.includes(t)) p.tags.push(t);
  }

  /** room id → its region (regions → themselves), for the GPU table */
  table(): Uint32Array {
    const t = new Uint32Array(MAX_PLACES);
    for (const p of this.places) if (p) t[p.id] = p.kind === 'room' ? p.parent : p.id;
    return t;
  }
}

// ---- rasterizing a plan -----------------------------------------------------

/** Build the places of a plan on a w × h nature grid. */
export function buildPlaces(plan: Plan, w: number, h: number, seed = 1): PlaceMap {
  const m = new PlaceMap(w, h);
  const amp = plan.amp ?? 3;
  const scale = plan.scale ?? 10;
  const warp = (px: number, py: number): [number, number] =>
    amp ? [px + amp * fbm(px / scale, py / scale, 3, seed + 11), py + amp * fbm(px / scale, py / scale, 3, seed + 23)] : [px, py];
  const rand = rng(seed * 7919 + 1);
  if (plan.partition === 'voronoi') voronoi(m, plan, warp, rand);
  else if (plan.partition === 'bands') bands(m, plan, warp, rand, seed);
  else if (plan.partition === 'boxes') {
    const rooms: SdfRoom[] = plan.rooms.map((r) => ({ ...r, sdf: rectSdf(r.rect) }));
    drawn(m, rooms, plan.halls ?? [], plan.regions ?? [], warp);
  } else drawn(m, plan.rooms, plan.halls ?? [], plan.regions ?? [], warp);
  m.finish();
  if ('shape' in plan && plan.shape) m.suggested = suggest(m, plan.shape, rand);
  return m;
}

const rectSdf =
  ([x0, y0, x1, y1]: [number, number, number, number]): Sdf =>
  (x, y) => {
    const dx = Math.max(x0 - x, x - x1);
    const dy = Math.max(y0 - y, y - y1);
    return dx > 0 || dy > 0 ? Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) : Math.max(dx, dy);
  };

type Warp = (x: number, y: number) => [number, number];

/** Hand-drawn (or box) rooms: each column takes the room deepest inside at its warped point; halls after. */
function drawn(m: PlaceMap, rooms: SdfRoom[], halls: Hall[], regions: { name: string; tags?: string[] }[], warp: Warp): void {
  for (const r of regions) m.add(r.name, 'region', 0, r.tags ?? []);
  const regionOf = (name?: string): number => {
    const n = name ?? 'world';
    if (!m.has(n)) m.add(n, 'region');
    return m.place(n).id;
  };
  const ids = rooms.map((r) => m.add(r.name, 'room', regionOf(r.region), r.tags ?? []).id);
  const { w, h } = m;
  const cx = new Float64Array(rooms.length);
  const cy = new Float64Array(rooms.length);
  const cn = new Float64Array(rooms.length);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const [qx, qy] = warp(...cellPos(x, y));
      let best = 0;
      let bd = 0;
      for (let k = 0; k < rooms.length; k++) {
        const d = rooms[k].sdf(qx, qy);
        if (d < bd) {
          bd = d;
          best = k + 1;
        }
      }
      if (!best) continue;
      m.cols[y * w + x] = ids[best - 1];
      const [px, py] = cellPos(x, y);
      cx[best - 1] += px;
      cy[best - 1] += py;
      cn[best - 1]++;
    }
  // halls: a band between the two rooms' centres, over columns no room took
  for (const hl of halls) {
    const ka = rooms.findIndex((r) => r.name === hl.a);
    const kb = rooms.findIndex((r) => r.name === hl.b);
    if (ka < 0 || kb < 0) throw new Error(`places: a hall between unknown rooms "${hl.a}" and "${hl.b}"`);
    if (!cn[ka] || !cn[kb]) throw new Error(`places: hall "${hl.a}"–"${hl.b}": a room has no columns`);
    const pa: [number, number] = [cx[ka] / cn[ka], cy[ka] / cn[ka]];
    const pb: [number, number] = [cx[kb] / cn[kb], cy[kb] / cn[kb]];
    const sdf = band([pa, pb], hl.width / 2);
    const p = m.add(`${hl.a}~${hl.b}`, 'room', m.place(ids[ka]).parent, ['hall']);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (m.cols[i]) continue;
        const [qx, qy] = warp(...cellPos(x, y));
        if (sdf(qx, qy) < 0) m.cols[i] = p.id;
      }
  }
}

/** Poisson-disc points (dart throwing) over the world rect, `spacing` apart. */
function poisson(W: number, H: number, spacing: number, rand: () => number): [number, number][] {
  const pts: [number, number][] = [];
  const cell = spacing / Math.SQRT2;
  const gw = Math.ceil(W / cell);
  const gh = Math.ceil(H / cell);
  const grid = new Int32Array(gw * gh).fill(-1);
  const tries = Math.ceil((W * H) / (spacing * spacing)) * 30;
  for (let t = 0; t < tries; t++) {
    const x = rand() * W;
    const y = rand() * H;
    const gx = Math.floor(x / cell);
    const gy = Math.floor(y / cell);
    let ok = true;
    for (let j = Math.max(0, gy - 2); j <= Math.min(gh - 1, gy + 2) && ok; j++)
      for (let i = Math.max(0, gx - 2); i <= Math.min(gw - 1, gx + 2); i++) {
        const k = grid[j * gw + i];
        if (k >= 0 && Math.hypot(pts[k][0] - x, pts[k][1] - y) < spacing) {
          ok = false;
          break;
        }
      }
    if (!ok) continue;
    grid[gy * gw + gx] = pts.length;
    pts.push([x, y]);
  }
  return pts;
}

/** Group labelled cells (1..n in `lab`) into rooms of [g0, g1] adjacent cells; returns cell → group (0-based). */
function groupCells(m: PlaceMap, lab: Int32Array, n: number, g0: number, g1: number, rand: () => number): Int32Array {
  const nb: Set<number>[] = Array.from({ length: n }, () => new Set());
  const { w, h } = m;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const a = lab[y * w + x];
      for (let k = 0; k < NDIR; k++) {
        const [nx, ny] = nbr(x, y, k);
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const b = lab[ny * w + nx];
        if (a !== b && a >= 0 && b >= 0) nb[a].add(b);
      }
    }
  const grp = new Int32Array(n).fill(-1);
  const order = [...Array(n).keys()].sort(() => rand() - 0.5);
  let g = 0;
  for (const s of order) {
    if (grp[s] >= 0) continue;
    const size = g0 + Math.floor(rand() * (g1 - g0 + 1));
    const members = [s];
    grp[s] = g;
    while (members.length < size) {
      const free = [...new Set(members.flatMap((c) => [...nb[c]]))].filter((c) => grp[c] < 0);
      if (!free.length) break;
      const c = free[Math.floor(rand() * free.length)];
      grp[c] = g;
      members.push(c);
    }
    g++;
  }
  return grp;
}

/** Rooms (by their centres) into `count` regions: nearest of farthest-point seeds. */
function regionsFor(m: PlaceMap, rooms: number[], count: number): void {
  const centres = rooms.map((r) => m.place(r).centre);
  const seeds: number[] = [0];
  while (seeds.length < Math.min(count, rooms.length)) {
    let bi = 0;
    let bd = -1;
    centres.forEach((c, i) => {
      const d = Math.min(...seeds.map((s) => Math.hypot(c[0] - centres[s][0], c[1] - centres[s][1])));
      if (d > bd) {
        bd = d;
        bi = i;
      }
    });
    seeds.push(bi);
  }
  const regs = seeds.map((_, k) => m.add(`region-${k + 1}`, 'region').id);
  rooms.forEach((r, i) => {
    let bk = 0;
    let bd = Infinity;
    seeds.forEach((s, k) => {
      const d = Math.hypot(centres[i][0] - centres[s][0], centres[i][1] - centres[s][1]);
      if (d < bd) {
        bd = d;
        bk = k;
      }
    });
    const p = m.place(r);
    p.parent = regs[bk];
    m.place(regs[bk]).children.push(r);
  });
}

/** Footprints first (rooms with no region yet), then regions by nearest seed. */
function settleRegions(m: PlaceMap, rooms: number[], count: number): void {
  m.finish();
  regionsFor(m, rooms, count);
}

function voronoi(m: PlaceMap, plan: Extract<Plan, { partition: 'voronoi' }>, warp: Warp, rand: () => number): void {
  const [W, H] = worldSize(m.w, m.h);
  const seeds = poisson(W, H, plan.spacing, rand);
  const { w, h } = m;
  const lab = new Int32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const [qx, qy] = warp(...cellPos(x, y));
      let bk = 0;
      let bd = Infinity;
      for (let k = 0; k < seeds.length; k++) {
        const d = (seeds[k][0] - qx) ** 2 + (seeds[k][1] - qy) ** 2;
        if (d < bd) {
          bd = d;
          bk = k;
        }
      }
      lab[y * w + x] = bk;
    }
  const [g0, g1] = plan.group ?? [1, 3];
  const grp = groupCells(m, lab, seeds.length, g0, g1, rand);
  const ng = Math.max(...grp) + 1;
  const rooms = Array.from({ length: ng }, (_, g) => m.add(`room-${g + 1}`, 'room').id);
  for (let i = 0; i < w * h; i++) m.cols[i] = rooms[grp[lab[i]]];
  settleRegions(m, rooms, plan.regions ?? Math.max(1, Math.round(ng / 5)));
}

function bands(m: PlaceMap, plan: Extract<Plan, { partition: 'bands' }>, warp: Warp, rand: () => number, seed: number): void {
  const { w, h } = m;
  const island = plan.island ?? 0;
  // hall (1) or not (0) per column, then connected components of each
  const hall = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const [qx, qy] = warp(...cellPos(x, y));
      const n = fbm(qx * plan.freq, qy * plan.freq, 3, seed + 41);
      hall[y * w + x] = Math.abs(n - island) < plan.tunnel ? 1 : 0;
    }
  const lab = new Int32Array(w * h).fill(-1);
  const sizes: number[] = [];
  const kinds: number[] = [];
  for (let s = 0; s < w * h; s++) {
    if (lab[s] >= 0) continue;
    const c = sizes.length;
    const stack = [s];
    lab[s] = c;
    let n = 0;
    while (stack.length) {
      const i = stack.pop()!;
      n++;
      const x = i % w;
      const y = (i / w) | 0;
      for (let k = 0; k < NDIR; k++) {
        const [nx, ny] = nbr(x, y, k);
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const j = ny * w + nx;
        if (lab[j] < 0 && hall[j] === hall[s]) {
          lab[j] = c;
          stack.push(j);
        }
      }
    }
    sizes.push(n);
    kinds.push(hall[s]);
  }
  // slivers (under 30 columns) join the neighbour they share most with
  const MIN = 30;
  const into = sizes.map((_, c) => c);
  const root = (c: number): number => (into[c] === c ? c : (into[c] = root(into[c])));
  for (let pass = 0; pass < 3; pass++)
    for (let i = 0; i < w * h; i++) {
      const c = root(lab[i]);
      if (sizes[c] >= MIN) continue;
      const x = i % w;
      const y = (i / w) | 0;
      for (let k = 0; k < NDIR; k++) {
        const [nx, ny] = nbr(x, y, k);
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const d = root(lab[ny * w + nx]);
        if (d !== c && sizes[d] >= MIN) {
          into[c] = d;
          sizes[d] += sizes[c];
          sizes[c] = 0;
          break;
        }
      }
    }
  const ids = new Map<number, number>();
  let nr = 0;
  let nh = 0;
  for (let i = 0; i < w * h; i++) {
    const c = root(lab[i]);
    if (!ids.has(c)) ids.set(c, kinds[c] ? m.add(`hall-${++nh}`, 'room', 0, ['hall']).id : m.add(`room-${++nr}`, 'room').id);
    m.cols[i] = ids.get(c)!;
  }
  void rand;
  const rooms = [...ids.values()];
  settleRegions(m, rooms, plan.regions ?? Math.max(1, Math.round(rooms.length / 5)));
}

/** Connections the plan's shape suggests over the room graph (W1 carves them). */
function suggest(m: PlaceMap, shape: Shape, rand: () => number): { a: number; b: number }[] {
  const rooms = m.all().filter((p) => p.kind === 'room' && p.cells > 0);
  // (a border shorter than 3 cell sides is no doorway)
  const nb = new Map(rooms.map((r) => [r.id, m.adjacent(r.id).filter((e) => e.length >= 3).map((e) => e.room)]));
  if (shape === 'any') {
    const out: { a: number; b: number }[] = [];
    for (const [a, list] of nb) for (const b of list) if (a < b) out.push({ a, b });
    return out;
  }
  const out: { a: number; b: number }[] = [];
  const seen = new Set<number>();
  const free = (r: number) => (nb.get(r) ?? []).filter((x) => !seen.has(x));
  for (const start of rooms) {
    if (seen.has(start.id)) continue;
    seen.add(start.id);
    if (shape === 'tree') {
      // random spanning tree (random Prim): grow from anywhere on the frontier
      const frontier = free(start.id).map((b) => ({ a: start.id, b }));
      while (frontier.length) {
        const e = frontier.splice(Math.floor(rand() * frontier.length), 1)[0];
        if (seen.has(e.b)) continue;
        seen.add(e.b);
        out.push(e);
        for (const c of free(e.b)) frontier.push({ a: e.b, b: c });
      }
    } else {
      // chain: a walk to the neighbour with the fewest free neighbours
      // (Warnsdorff), branching off the walk only where it gets stuck
      const stack = [start.id];
      while (stack.length) {
        const r = stack[stack.length - 1];
        const f = free(r);
        if (!f.length) {
          stack.pop();
          continue;
        }
        f.sort((x, y) => free(x).length - free(y).length || rand() - 0.5);
        const b = f[0];
        seen.add(b);
        out.push({ a: r, b });
        stack.push(b);
      }
    }
  }
  return out;
}
