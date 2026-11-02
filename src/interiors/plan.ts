// A building's inside from its structures plan (contracts/interiors.ts; docs/ARCHITECTURE.md "Interiors"). Pure and
// deterministic: the same plan gives the same inside (Node-testable, no GPU).
//
// What it reads of the plan: the building's tiles and their tops (each tile's own storey count — the stepped skyline:
// round((quadTop - base) / storeyH)), the façades (which wall of which storey shows a door, a window, a shop front or a
// balcony), the tiles' adjacency. From those, per storey:
//  1. the tiles standing at that height; walls where a tile side meets another building, the street or a tile that's
//     lower (the façade's line — its openings exactly the façade modules' holes, modules.ts wallSet's fractions);
//  2. rooms by purpose (the street door's tiles a hall or a living room, the farthest ground tile a kitchen, sleeping
//     rooms up the house, stores under the roof), partitions with a doorway between two rooms;
//  3. stairs where the storeys stack: a straight flight along an outside wall of a tile that stands on both storeys,
//     the floor above opened over it;
//  4. furniture by purpose from the CC prop set (sizes from data/props/props.json), against walls and clear of doors,
//     leaving a way round; the spots people use (seats, beds, the cook's fire) and the lights (candles, the hearth).
import type { CityPlan, Facade } from '../api/contracts/structures';
import type { InteriorLight, InteriorPlan, InteriorRoom, InteriorStair, InteriorStorey, InteriorWall, Opening, PropPlacement, RoomPurpose, Spot, V2, V3 } from '../api/contracts/interiors';
import { adjacency, quadCorners } from '../structures/tiles/builder';
import { across, centre, inQuad, sideAxes, sideLength, sidePoint, type Quad } from './frame';
import { WalkGrid } from './grid';

/** the structures' wall thickness (pieces.ts WALL_T): the outside walls' line inside the tile */
export const WALL_T = 0.35;
const PARTITION_T = 0.16;
const SLAB = 0.22;
/** the façade modules' holes (modules.ts wallSet: u along the wall, w up the storey, 0..1) */
const HOLES: Record<string, { u0: number; u1: number; w0: number; w1: number; kind: Opening['kind'] }[]> = {
  window: [{ u0: 0.38, u1: 0.62, w0: 0.3, w1: 0.74, kind: 'window' }],
  window2: [{ u0: 0.2, u1: 0.38, w0: 0.3, w1: 0.74, kind: 'window' }, { u0: 0.62, u1: 0.8, w0: 0.3, w1: 0.74, kind: 'window' }],
  door: [{ u0: 0.39, u1: 0.61, w0: 0, w1: 0.7, kind: 'door' }],
  shop: [{ u0: 0.14, u1: 0.86, w0: 0.08, w1: 0.66, kind: 'shop' }],
  balcony: [{ u0: 0.36, u1: 0.64, w0: 0.04, w1: 0.74, kind: 'balcony' }],
};

/** a prop's size (m): along its front (x), across it (y), up (z) */
export type PropSize = (id: string) => V3;

export interface PlannedInterior {
  plan: InteriorPlan;
  /** per storey its walkable floor (what's left free once furnished) */
  grids: WalkGrid[];
}

/** a tiny deterministic random from integers */
function rnd(...k: number[]): number {
  let h = 2166136261;
  for (const x of k) {
    h ^= x | 0;
    h = Math.imul(h, 16777619);
    h ^= h >>> 13;
  }
  return ((h >>> 0) % 100000) / 100000;
}

export function planInterior(city: CityPlan, building: number, use: string, size: PropSize): PlannedInterior {
  const b = city.buildings[building];
  if (!b) throw new Error(`interiors: no building ${building}`);
  if (b.mega) throw new Error(`interiors: building ${building} is a landmark (${b.mega}); no interior planned for it`);
  const t = city.tiles;
  const adj = adjacency(t);
  const H = b.storeyH;
  const corners = new Map<number, Quad>();
  for (const q of b.quads) corners.set(q, quadCorners(t, q));
  const tileStoreys = new Map<number, number>();
  for (const q of b.quads) tileStoreys.set(q, Math.max(1, Math.round((city.quadTop[q] - b.base) / H)));
  const nStoreys = Math.max(...tileStoreys.values());
  const facade = new Map<string, Facade>();
  for (const f of city.facades) if (f.building === building) facade.set(`${f.quad},${f.side},${f.level}`, f);
  const front = city.facades.find((f) => f.building === building && f.level === 0 && f.kind === 'door');
  const seed = city.spec.seed * 31 + building;

  // the building's bounds (for the grids)
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const c of corners.values()) for (const p of c) (x0 = Math.min(x0, p[0])), (y0 = Math.min(y0, p[1])), (x1 = Math.max(x1, p[0])), (y1 = Math.max(y1, p[1]));

  const storeys: InteriorStorey[] = [];
  const grids: WalkGrid[] = [];
  const doors: InteriorPlan['doors'] = [];
  for (let l = 0; l < nStoreys; l++) {
    const z = b.base + l * H;
    const tiles = b.quads.filter((q) => tileStoreys.get(q)! > l);
    storeys.push({ level: l, z, ceiling: z + H - SLAB, tiles, rooms: [], walls: [], stairs: [], props: [], spots: [], lights: [] });
    grids.push(new WalkGrid(x0 - 0.5, y0 - 0.5, x1 + 0.5, y1 + 0.5));
  }
  const present = (q: number, l: number) => q >= 0 && city.quadBuilding[q] === building && (tileStoreys.get(q) ?? 0) > l;

  // ---- rooms
  for (const st of storeys) st.rooms = roomsOf(st, use, front?.quad ?? -1, adj, present, corners, nStoreys, seed);
  const roomOf = (st: InteriorStorey, q: number) => st.rooms.find((r) => r.tiles.includes(q));

  // ---- stairs: a flight from each storey to the next, in a tile standing on both, along an outside wall without a door
  for (let l = 0; l + 1 < nStoreys; l++) {
    const st = storeys[l];
    const up = storeys[l + 1];
    // each separate wing upstairs needs its own way up
    for (const wing of components(up.tiles, adj, (q) => present(q, l + 1))) {
      let best: { q: number; s: number; score: number } | null = null;
      for (const q of wing) {
        const room = roomOf(st, q)!;
        for (let s = 0; s < 4; s++) {
          const n = adj[q * 4 + s];
          // (an outside wall on both storeys: the flight against it, nothing in its way)
          if (present(n, l) || present(n, l + 1)) continue;
          const L = sideLength(corners.get(q)!, s);
          if (L < 2.6) continue;
          const f0 = facade.get(`${q},${s},${l}`)?.kind ?? 'blank';
          const f1 = facade.get(`${q},${s},${l + 1}`)?.kind ?? 'blank';
          if (f0 === 'door' || f0 === 'shop' || f1 === 'balcony' || f0 === 'balcony') continue;
          // (the same wall the flight below came up: another, so the stairs turn; blank walls first; not the hall's door wall)
          const below = l > 0 && storeys[l - 1].stairs.some((x) => x.tile === q && x.side === s);
          // (never the wall the flight from below comes up along: its top would land in the new one's foot)
          if (below) continue;
          const score = L + across(corners.get(q)!, s) * 1.5 + (f0 === 'blank' ? 2 : 0) + (f1 === 'blank' ? 1 : 0) - (below ? 6 : 0) - (room.purpose === 'hall' ? 1.5 : 0) + rnd(seed, q, s) * 0.5;
          if (!best || score > best.score) best = { q, s, score };
        }
      }
      if (!best) throw new Error(`interiors: building ${building} storey ${l}: no outside wall for a stair up`);
      const c = corners.get(best.q)!;
      const L = sideLength(c, best.s);
      const D = across(c, best.s);
      const depth = Math.min(0.45, (1.0 + WALL_T) / D);
      // (the flight's middle line, a little off the wall; on and off at its two ends)
      const inner = (WALL_T + (depth * D - WALL_T) / 2) / D;
      // (room at the top to step off: the far wall's thickness and a stride)
      const tEnd = 1 - (WALL_T + 0.55) / L;
      const t0 = 0.08, t1 = Math.min(tEnd - 0.3 / L, t0 + Math.max(2.4, H * 1.0) / L);
      const fp = sidePoint(c, best.s, t0, inner);
      const tp = sidePoint(c, best.s, Math.min(tEnd, t1 + 0.4 / L), inner);
      st.stairs.push({ tile: best.q, side: best.s, t0, t1, depth, z0: st.z, z1: up.z, foot: [fp[0], fp[1], st.z], top: [tp[0], tp[1], up.z] });
    }
  }

  // ---- walls and their openings
  for (const st of storeys) {
    const l = st.level;
    for (const q of st.tiles) {
      const c = corners.get(q)!;
      for (let s = 0; s < 4; s++) {
        const n = adj[q * 4 + s];
        const a = c[s], bb = c[(s + 1) % 4];
        const L = sideLength(c, s);
        if (!present(n, l)) {
          const f = facade.get(`${q},${s},${l}`);
          const openings: Opening[] = (HOLES[f?.kind ?? ''] ?? []).map((h) => ({ kind: h.kind, u0: h.u0, u1: h.u1, z0: h.w0 * H, z1: h.w1 * H }));
          st.walls.push({ tile: q, side: s, a, b: bb, outer: true, thick: WALL_T, openings });
          if (f?.kind === 'door' && l === 0) {
            const m = sidePoint(c, s, 0.5, (WALL_T * 0.5) / across(c, s));
            const { inward } = sideAxes(c, s);
            doors.push({ at: [m[0], m[1], st.z], out: [-inward[0], -inward[1]], level: 0 });
          }
        } else if (n > q) {
          // a partition: once a shared side (from the lower id), with a doorway when it parts two rooms
          const ra = roomOf(st, q)!, rb = roomOf(st, n)!;
          if (ra === rb) continue;
          // (the doorway clear of a stair along either side of the wall)
          let mid = 0.5;
          const onIt = st.stairs.some((x) => (x.tile === q && x.side === s) || (x.tile === n && adj[n * 4 + x.side] === q));
          if (onIt) mid = 0.86;
          const w = Math.min(0.45, 0.95 / L);
          st.walls.push({ tile: q, side: s, a, b: bb, outer: false, thick: PARTITION_T, openings: [{ kind: 'arch', u0: mid - w, u1: mid + w, z0: 0, z1: Math.min(2.2, H - 0.5) }] });
        }
      }
    }
  }

  // ---- the walkable floors: tiles less walls, stair bands (and the holes over them)
  storeys.forEach((st, l) => {
    for (const q of st.tiles) {
      const c = corners.get(q)!;
      grids[l].paint([x0, y0], [x1, y1], (p) => inQuad(c, p, 0), 1);
    }
  });
  storeys.forEach((st, l) => {
    const g = grids[l];
      // the walls' thickness off the floor (an outer wall inside its tile; a partition on both sides), doorways open
    for (const w of st.walls) {
      const { dir, inward } = sideAxes(corners.get(w.tile)!, w.side);
      const L = Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]);
      const off = w.outer ? w.thick / 2 : 0;
      const hx = L / 2, hy = w.thick / 2;
      const c: V2 = [(w.a[0] + w.b[0]) / 2 + inward[0] * off, (w.a[1] + w.b[1]) / 2 + inward[1] * off];
      g.paintRect(c, dir, hx, hy, 0);
      for (const o of w.openings) {
        if (o.kind !== 'arch' && o.kind !== 'door') continue;
        const um = (o.u0 + o.u1) / 2, hw = ((o.u1 - o.u0) * L) / 2;
        const oc: V2 = [w.a[0] + dir[0] * um * L, w.a[1] + dir[1] * um * L];
        g.paintRect([oc[0] + inward[0] * off, oc[1] + inward[1] * off], dir, hw, hy + 0.05, 1);
      }
    }
    // a stair's band: its own (people walk it as a link, not the floor) and, on the storey above, the hole over it
    for (const s of st.stairs) {
      const band = stairBand(corners.get(s.tile)!, s);
      g.paint(band.lo, band.hi, band.inside, 0);
      grids[l + 1].paint(band.lo, band.hi, band.insideHole, 0);
    }
  });

  // ---- furniture, spots and lights, room by room
  storeys.forEach((st, l) => {
    for (const room of st.rooms) furnish(st, room, grids[l], corners, size, H, seed, doors, l === 0 ? front : undefined, l > 0 ? storeys[l - 1].stairs : []);
  });

  // (what's left free, less a body's margin: where people walk)
  const walk = grids.map((g) => g.eroded(1));
  // (the pockets behind furniture let go: a spot or a stair's end snaps into the floor everyone shares)
  for (const g of walk) g.dropPockets();
  // each spot's way in: the nearest free floor in front of it, else behind it (a bench is sat from behind), else beside
  storeys.forEach((st, l) => {
    const g = walk[l];
    const ok = (p: V2) => g.isFree(p);
    st.spots = st.spots.filter((sp) => {
      const f: V2 = [Math.cos(sp.face), Math.sin(sp.face)];
      const side: V2 = [-f[1], f[0]];
      for (const d of [0, 0.45, 0.65, 0.9]) {
        for (const dir of [f, [-f[0], -f[1]] as V2, side, [-side[0], -side[1]] as V2]) {
          const p: V2 = [sp.at[0] + dir[0] * d, sp.at[1] + dir[1] * d];
          if (ok(p)) {
            sp.from = [p[0], p[1], st.z];
            return true;
          }
        }
      }
      // (none: a spot no one can reach is no spot)
      return false;
    });
  });
  return { plan: { building, use, base: b.base, storeyH: H, storeys, doors, corners }, grids: walk };
}

/** the stair's band in the plan (as a point test, its box), and the hole the storey above leaves over it */
export function stairBand(c: Quad, s: InteriorStair): { lo: V2; hi: V2; inside: (p: V2) => boolean; insideHole: (p: V2) => boolean } {
  const { dir, inward } = sideAxes(c, s.side);
  const L = sideLength(c, s.side);
  const D = across(c, s.side);
  const a = c[s.side];
  const pts = [sidePoint(c, s.side, s.t0, 0), sidePoint(c, s.side, s.t1, 0), sidePoint(c, s.side, s.t0, s.depth), sidePoint(c, s.side, s.t1, s.depth)];
  const lo: V2 = [Math.min(...pts.map((p) => p[0])) - 0.3, Math.min(...pts.map((p) => p[1])) - 0.3];
  const hi: V2 = [Math.max(...pts.map((p) => p[0])) + 0.3, Math.max(...pts.map((p) => p[1])) + 0.3];
  const local = (p: V2) => {
    const dx = p[0] - a[0], dy = p[1] - a[1];
    return [(dx * dir[0] + dy * dir[1]) / L, (dx * inward[0] + dy * inward[1]) / D];
  };
  return {
    lo,
    hi,
    inside: (p) => {
      const [tt, dd] = local(p);
      return tt >= s.t0 - 0.02 && tt <= s.t1 + 0.02 && dd <= s.depth + 0.04;
    },
    insideHole: (p) => {
      const [tt, dd] = local(p);
      // (the hole over the flight: from its foot to where there's head room, and a rail round it)
      return tt >= s.t0 - 0.04 && tt <= s.t1 - 0.02 && dd <= s.depth + 0.1;
    },
  };
}

/** connected tiles among `tiles` (through shared sides where `ok`) */
function components(tiles: number[], adj: Int32Array, ok: (q: number) => boolean): number[][] {
  const left = new Set(tiles);
  const out: number[][] = [];
  while (left.size) {
    const s = left.values().next().value as number;
    left.delete(s);
    const comp = [s];
    for (let i = 0; i < comp.length; i++)
      for (let k = 0; k < 4; k++) {
        const n = adj[comp[i] * 4 + k];
        if (n >= 0 && left.has(n) && ok(n)) {
          left.delete(n);
          comp.push(n);
        }
      }
    out.push(comp);
  }
  return out;
}

function roomsOf(st: InteriorStorey, use: string, doorTile: number, adj: Int32Array, present: (q: number, l: number) => boolean, corners: Map<number, Quad>, n: number, seed: number): InteriorRoom[] {
  const l = st.level;
  const tiles = st.tiles.slice();
  const rooms: InteriorRoom[] = [];
  const add = (purpose: RoomPurpose, ts: number[]) => {
    const cs = ts.map((q) => centre(corners.get(q)!));
    rooms.push({ id: rooms.length, purpose, tiles: ts, centre: [cs.reduce((a, c) => a + c[0], 0) / cs.length, cs.reduce((a, c) => a + c[1], 0) / cs.length] });
  };
  const left = new Set(tiles);
  const grow = (start: number, max: number): number[] => {
    const out = [start];
    left.delete(start);
    for (let i = 0; i < out.length && out.length < max; i++)
      for (let k = 0; k < 4 && out.length < max; k++) {
        const m = adj[out[i] * 4 + k];
        if (m >= 0 && left.has(m) && present(m, l)) {
          left.delete(m);
          out.push(m);
        }
      }
    return out;
  };
  const hall = use === 'hall' || use === 'temple';
  if (l === 0) {
    const start = left.has(doorTile) ? doorTile : tiles[0];
    // the room the street door opens into: a hall's great room (most of the floor), a house's living room
    const big = hall ? Math.max(1, tiles.length - (tiles.length >= 3 ? 1 : 0)) : Math.max(1, Math.ceil(tiles.length / 2));
    add(hall ? 'hall' : use === 'workshop' ? 'workshop' : 'living', grow(start, big));
    // the farthest tile from the door the kitchen (its fire), the rest stores
    const rest = [...left];
    rest.sort((a, c) => dist(corners, c, start) - dist(corners, a, start));
    rest.forEach((q, i) => {
      left.delete(q);
      add(i === 0 ? 'kitchen' : 'stores', [q]);
    });
    if (!rooms.some((r) => r.purpose === 'kitchen') && !hall && rooms[0].tiles.length > 1) {
      // (a one-room ground floor's far tile: the kitchen end — split it off)
      const r = rooms[0];
      const far = r.tiles[r.tiles.length - 1];
      r.tiles = r.tiles.slice(0, -1);
      add('kitchen', [far]);
    }
  } else {
    const top = l === n - 1 && n >= 3;
    let first = true;
    for (const q of tiles) {
      if (!left.has(q)) continue;
      if (top) add('stores', grow(q, 2));
      else if (hall && first && l === 1) add('chamber', grow(q, 2));
      else add('sleeping', grow(q, 1));
      first = false;
    }
  }
  void seed;
  return rooms;
}

function dist(corners: Map<number, Quad>, a: number, b: number): number {
  const ca = centre(corners.get(a)!), cb = centre(corners.get(b)!);
  return Math.hypot(ca[0] - cb[0], ca[1] - cb[1]);
}

// ---- furnishing

interface Slot {
  /** the wall's line inside the room here, the way into the room */
  at: V2;
  face: V2;
  /** the wall's length (m), where along it (0..1) */
  room: number;
  t: number;
  wall: InteriorWall;
  /** under a window here: only low things */
  low: boolean;
}

const yawOf = (d: V2) => Math.atan2(d[1], d[0]);

function furnish(st: InteriorStorey, room: InteriorRoom, g: WalkGrid, corners: Map<number, Quad>, size: PropSize, H: number, seed: number, doors: InteriorPlan['doors'], front: Facade | undefined, below: InteriorStair[]): void {
  const placed: { i: number; at: V2; ax: V2; hx: number; hy: number }[] = [];
  const doorsHere = st.walls.filter((w) => room.tiles.includes(w.tile) || w.openings.some((o) => o.kind === 'arch'));
  void doors;
  void front;
  // the room's walls (its tiles' sides that are walls on this storey), as slots every ~1.1 m
  const slots: Slot[] = [];
  for (const w of st.walls) {
    const c = corners.get(w.tile)!;
    const mine = room.tiles.includes(w.tile);
    const { dir, inward } = sideAxes(c, w.side);
    // (a partition belongs to both rooms: the other side's normal for the tile across)
    let normal = inward;
    if (!mine) {
      if (w.outer) continue;
      // the far side of a partition: is the tile across in this room?
      const mid: V2 = [(w.a[0] + w.b[0]) / 2 - inward[0] * 0.4, (w.a[1] + w.b[1]) / 2 - inward[1] * 0.4];
      if (!room.tiles.some((q) => inQuad(corners.get(q)!, mid))) continue;
      normal = [-inward[0], -inward[1]];
    }
    const L = Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]);
    // (every quarter metre along it: wide things find the room a wall has)
    const n = Math.max(1, Math.floor(L / 0.25));
    for (let k = 0; k < n; k++) {
      const tt = (k + 0.5) / n;
      const low = w.openings.some((o) => (o.kind === 'window' || o.kind === 'shop') && tt > o.u0 - 0.05 && tt < o.u1 + 0.05);
      const off = w.outer ? w.thick : w.thick / 2;
      slots.push({ at: [w.a[0] + dir[0] * tt * L + normal[0] * off, w.a[1] + dir[1] * tt * L + normal[1] * off], face: normal, room: L, t: tt, wall: w, low });
    }
  }
  void doorsHere;
  // the people's grid must still reach every doorway and the stairs: a prop goes only where it leaves the room joined
  const keep: V2[] = [];
  for (const w of st.walls) for (const o of w.openings) {
    if (o.kind !== 'door' && o.kind !== 'arch') continue;
    const { dir, inward } = sideAxes(corners.get(w.tile)!, w.side);
    const L = Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]);
    const um = ((o.u0 + o.u1) / 2) * L;
    const off = w.outer ? w.thick + 0.45 : 0.45;
    keep.push([w.a[0] + dir[0] * um + inward[0] * off, w.a[1] + dir[1] * um + inward[1] * off]);
    if (!w.outer) keep.push([w.a[0] + dir[0] * um - inward[0] * off, w.a[1] + dir[1] * um - inward[1] * off]);
  }
  for (const s of st.stairs) keep.push([s.foot[0], s.foot[1]]);
  // (and where the flight from below comes up)
  for (const s of below) keep.push([s.top[0], s.top[1]]);
  const roomKeep = keep.filter((p) => room.tiles.some((q) => inQuad(corners.get(q)!, p, -0.3)));
  // (on the floor less a body's margin, as the people will walk it)
  // (and most of the room's floor stays one floor joined to them: no pocket walled in by crates)
  const inRoom = (x: number, y: number) => room.tiles.some((q) => inQuad(corners.get(q)!, g.centreOf(x, y)));
  const joined = () => {
    if (roomKeep.length < 1) return true;
    // (on the floor less an eighth of a metre round things: a gap a body fits through)
    const e = g.eroded(1);
    const r = e.reach(roomKeep[0]);
    if (!roomKeep.every((p) => {
      const c = e.nearestFree(p, 8);
      return !!c && r[c[1] * e.w + c[0]] === 1;
    })) return false;
    let free = 0, got = 0;
    for (let j = 0; j < e.h; j++)
      for (let i = 0; i < e.w; i++) {
        const k = j * e.w + i;
        if (!e.free[k] || !inRoom(i, j)) continue;
        free++;
        if (r[k]) got++;
      }
    return got >= free * 0.85;
  };
  const tryPlace = (prop: string, at: V2, face: V2, opts: { pad?: number; scale?: number; z?: number; block?: boolean } = {}): number => {
    const [sx, sy] = size(prop);
    const sc = opts.scale ?? 1;
    const hx = (sx * sc) / 2 + (opts.pad ?? 0.05), hy = (sy * sc) / 2 + (opts.pad ?? 0.05);
    // (checked a little inside its outline: the grid's cells are a quarter metre, a prop may stand against a wall)
    if (opts.block !== false && !g.rectFree(at, face, Math.max(0.05, (sx * sc) / 2 - 0.1), Math.max(0.05, (sy * sc) / 2 - 0.1))) return -1;
    if (!room.tiles.some((q) => inQuad(corners.get(q)!, at))) return -1;
    if (opts.block !== false) {
      g.paintRect(at, face, hx, hy, 0);
      if (!joined()) {
        g.paintRect(at, face, hx, hy, 1);
        return -1;
      }
    }
    const i = st.props.length;
    st.props.push({ prop, at: [at[0], at[1], opts.z ?? st.z], yaw: yawOf(face), room: room.id, ...(sc !== 1 ? { scale: sc } : {}) });
    placed.push({ i, at, ax: face, hx, hy });
    return i;
  };
  /** against a wall: the prop's back to it */
  const againstWall = (prop: string, pred: (s: Slot) => boolean = () => true, scale = 1): { i: number; slot: Slot } | null => {
    const [sx, sy, sz] = size(prop);
    const order = slots.map((s, k) => ({ s, k, r: rnd(seed, room.id, k, prop.length, st.level) })).sort((a, b) => a.r - b.r);
    for (const { s } of order) {
      if (!pred(s)) continue;
      // (its width along the wall: clear of doorways by a step, under a window only when it's lower than the sill)
      const hw = (sy * scale) / 2 / s.room;
      const t0 = s.t - hw, t1 = s.t + hw;
      if (t0 < 0 || t1 > 1) continue;
      const sill = (o: Opening) => o.z0;
      if (s.wall.openings.some((o) => (o.kind === 'door' || o.kind === 'arch' || o.kind === 'balcony') && t1 > o.u0 - 0.3 / s.room && t0 < o.u1 + 0.3 / s.room)) continue;
      if (s.wall.openings.some((o) => (o.kind === 'window' || o.kind === 'shop') && t1 > o.u0 && t0 < o.u1 && sz * scale > sill(o) - 0.05)) continue;
      const at: V2 = [s.at[0] + s.face[0] * ((sx * scale) / 2 + 0.04), s.at[1] + s.face[1] * ((sx * scale) / 2 + 0.04)];
      const i = tryPlace(prop, at, s.face, { scale });
      if (i >= 0) return { i, slot: s };
    }
    return null;
  };
  const spot = (kind: Spot['kind'], at: V2, face: V2, prop?: number, z = st.z) => st.spots.push({ kind, at: [at[0], at[1], z], face: yawOf(face), room: room.id, prop, from: [at[0], at[1], st.z] });
  const light = (kind: InteriorLight['kind'], at: V3) => {
    const L: Record<InteriorLight['kind'], { r: number; c: V3 }> = {
      candle: { r: 3.2, c: [1.0, 0.62, 0.28] },
      lantern: { r: 4.2, c: [1.0, 0.68, 0.34] },
      torch: { r: 5.0, c: [1.25, 0.6, 0.22] },
      hearth: { r: 6.5, c: [1.6, 0.66, 0.22] },
    };
    st.lights.push({ kind, at, radius: L[kind].r, colour: L[kind].c });
  };
  /** where a table goes: the room's middle first, then its tiles' middles and between them; along its long axis or across */
  const middles = (): { at: V2; ax: V2 }[] => {
    const cs = room.tiles.map((q) => corners.get(q)!);
    let ax: V2;
    if (room.tiles.length > 1) {
      const a = centre(cs[0]), b = centre(cs[cs.length - 1]);
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      ax = [(b[0] - a[0]) / L, (b[1] - a[1]) / L];
    } else ax = sideAxes(cs[0], sideLength(cs[0], 0) >= sideLength(cs[0], 1) ? 0 : 1).dir;
    const pts: V2[] = [room.centre, ...cs.map(centre)];
    for (let i = 0; i + 1 < cs.length; i++) {
      const a = centre(cs[i]), b = centre(cs[i + 1]);
      pts.push([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
    }
    const perp: V2 = [-ax[1], ax[0]];
    const out: { at: V2; ax: V2 }[] = [];
    for (const p of pts) for (const d of [ax, perp]) out.push({ at: p, ax: d });
    return out;
  };
  /** the first of the middles where `prop` fits */
  const inMiddle = (prop: string, pad: number, scale = 1): { i: number; at: V2; ax: V2 } | null => {
    for (const m of middles()) {
      const i = tryPlace(prop, m.at, m.ax, { pad, scale });
      if (i >= 0) return { i, ...m };
    }
    return null;
  };
  const middle = () => middles()[0];
  const onTop = (i: number, prop: string, dz: number, along = 0) => {
    const p = st.props[i];
    const ax: V2 = [Math.cos(p.yaw), Math.sin(p.yaw)];
    const ny: V2 = [-ax[1], ax[0]];
    const at: V2 = [p.at[0] + ny[0] * along, p.at[1] + ny[1] * along];
    st.props.push({ prop, at: [at[0], at[1], st.z + dz], yaw: p.yaw + 0.4, room: room.id });
    return st.props.length - 1;
  };
  const tableTop = (prop: string) => size(prop)[2];

  switch (room.purpose) {
    case 'hall': {
      // the seat of the town: a throne at the far wall facing the door, banners either side; a long table down the
      // middle with benches; chests and barrels round the walls; candles on the table, a hearth
      const doorP = st.walls.find((w) => w.outer && w.openings.some((o) => o.kind === 'door'));
      const dm: V2 = doorP ? [(doorP.a[0] + doorP.b[0]) / 2, (doorP.a[1] + doorP.b[1]) / 2] : room.centre;
      const farSlots = slots.filter((s) => !s.low).sort((a, b) => Math.hypot(b.at[0] - dm[0], b.at[1] - dm[1]) - Math.hypot(a.at[0] - dm[0], a.at[1] - dm[1]));
      const [tsx] = size('throne');
      for (const far of farSlots.slice(0, 60)) {
        const at: V2 = [far.at[0] + far.face[0] * (tsx / 2 + 0.06), far.at[1] + far.face[1] * (tsx / 2 + 0.06)];
        const hw = size('throne')[1] / 2 / far.room + 0.25 / far.room;
        if (far.t - hw < 0 || far.t + hw > 1) continue;
        const ti = tryPlace('throne', at, far.face);
        if (ti < 0) continue;
        spot('sit', at, far.face, ti);
        const side: V2 = [-far.face[1], far.face[0]];
        for (const sgn of [-1, 1]) {
          const bp: V2 = [far.at[0] + side[0] * sgn * 0.95 + far.face[0] * 0.08, far.at[1] + side[1] * sgn * 0.95 + far.face[1] * 0.08];
          tryPlace('banner', bp, far.face, { block: false });
        }
        const cp: V2 = [at[0] + side[0] * 0.8 + far.face[0] * 0.1, at[1] + side[1] * 0.8 + far.face[1] * 0.1];
        const ci = tryPlace('candles', cp, far.face, { pad: 0.02 });
        if (ci >= 0) light('candle', [cp[0], cp[1], st.z + 0.35]);
        break;
      }
      // the long table and its seats as one: tried at each middle, kept where it seats the most (at least two)
      let m = middle();
      let best: { n: number; m: { at: V2; ax: V2 } } | null = null;
      const seatSet = (mm: { at: V2; ax: V2 }, prop: string, commit: boolean): number => {
        const mark = { props: st.props.length, spots: st.spots.length, lights: st.lights.length, free: g.free.slice() };
        const tab = tryPlace(prop, mm.at, mm.ax, { pad: 0.08 });
        if (tab < 0) return -1;
        const [, sy] = size(prop);
        const ny: V2 = [-mm.ax[1], mm.ax[0]];
        let seats = 0;
        for (const sgn of [-1, 1]) {
          const face: V2 = [-ny[0] * sgn, -ny[1] * sgn];
          const off = sy / 2 + size('bench')[0] / 2 + 0.12;
          const bp: V2 = [mm.at[0] + ny[0] * sgn * off, mm.at[1] + ny[1] * sgn * off];
          // (a bench's front is its sitting side: toward the table, its length along it)
          const bi = tryPlace('bench', bp, face, { pad: 0.02 });
          if (bi >= 0) {
            for (const k of [-0.45, 0.45]) spot('sit', [bp[0] + mm.ax[0] * k, bp[1] + mm.ax[1] * k], face, bi);
            seats += 2;
            continue;
          }
          // (no room for a bench: stools along that side)
          const so = sy / 2 + size('stool')[0] / 2 + 0.1;
          for (const k of [-0.55, 0.55]) {
            const sp: V2 = [mm.at[0] + ny[0] * sgn * so + mm.ax[0] * k, mm.at[1] + ny[1] * sgn * so + mm.ax[1] * k];
            const si = tryPlace('stool', sp, face, { pad: 0.02 });
            if (si >= 0) {
              spot('sit', sp, face, si);
              seats++;
            }
          }
        }
        if (!commit) {
          st.props.length = mark.props;
          st.spots.length = mark.spots;
          st.lights.length = mark.lights;
          g.free.set(mark.free);
          return seats;
        }
        const p = st.props[tab];
        const h = tableTop(prop);
        light('candle', [p.at[0], p.at[1], st.z + h + 0.3]);
        onTop(tab, 'candles', h, 0);
        onTop(tab, 'pot', h, 0.35);
        spot('gather', [mm.at[0] + mm.ax[0] * 1.6, mm.at[1] + mm.ax[1] * 1.6], [-mm.ax[0], -mm.ax[1]]);
        return seats;
      };
      let bestProp = 'longtable';
      for (const prop of ['longtable', 'table'])
        for (const mm of middles()) {
          const n = seatSet(mm, prop, false);
          if (n > (best?.n ?? 1)) (best = { n, m: mm }), (bestProp = prop);
        }
      if (best) {
        seatSet(best.m, bestProp, true);
        m = best.m;
      }
      // (as many as the floor has room for: about one a 5 m² beyond the table's)
      const area = room.tiles.reduce((a, q) => a + quadAreaOf(corners.get(q)!), 0);
      const n = Math.max(1, Math.floor(area / 5) - 2);
      for (const prop of ['chest', 'barrel', 'bookcase', 'barrel', 'crate', 'urn'].slice(0, n)) againstWall(prop, prop === 'bookcase' ? (s) => !s.low : undefined);
      const lt = againstWall('sidetable');
      if (lt) {
        const p = st.props[lt.i];
        onTop(lt.i, 'lantern', size('sidetable')[2]);
        light('lantern', [p.at[0], p.at[1], st.z + size('sidetable')[2] + 0.35]);
      }
      tryPlace('rug', [m.at[0] - m.ax[0] * 0.2, m.at[1] - m.ax[1] * 0.2], m.ax, { block: false });
      break;
    }
    case 'kitchen':
    case 'living': {
      // (the cook's fire against a wall, else a fire pit in the floor)
      let fire = againstWall('cookfire', (s) => !s.low);
      if (!fire) {
        const pit = inMiddle('firepit', 0.1);
        if (pit) fire = { i: pit.i, slot: null as unknown as Slot };
      }
      if (fire) {
        const p = st.props[fire.i];
        light('hearth', [p.at[0], p.at[1], st.z + 0.6]);
        const f: V2 = [Math.cos(p.yaw), Math.sin(p.yaw)];
        spot('work', [p.at[0] + f[0] * 0.8, p.at[1] + f[1] * 0.8], [-f[0], -f[1]], fire.i);
      }
      const placedT = inMiddle('table', 0.06, 0.8);
      const m = placedT ?? middle();
      const tab = placedT?.i ?? -1;
      if (tab >= 0) {
        const [sx, sy] = size('table').map((v) => v * 0.8);
        const ny: V2 = [-m.ax[1], m.ax[0]];
        for (const [a, bq] of [[0, 1], [0, -1], [1, 0], [-1, 0]] as const) {
          // (the seat's middle its own half-depth off the table's edge, and a hand's gap)
          const off = (a !== 0 ? sx / 2 : sy / 2) + size('stool')[0] / 2 + 0.1;
          const sp: V2 = [m.at[0] + (m.ax[0] * a + ny[0] * bq) * off, m.at[1] + (m.ax[1] * a + ny[1] * bq) * off];
          const face: V2 = [-(m.ax[0] * a + ny[0] * bq), -(m.ax[1] * a + ny[1] * bq)];
          const si = tryPlace('stool', sp, face, { pad: 0.02 });
          if (si >= 0) spot('sit', sp, face, si);
        }
        onTop(tab, 'candle', size('table')[2] * 0.8);
        light('candle', [m.at[0], m.at[1], st.z + size('table')[2] * 0.8 + 0.25]);
      }
      for (const prop of ['barrel', 'barrelopen', 'crate', 'logs', 'bucket', 'cabinet', 'pot']) againstWall(prop);
      break;
    }
    case 'workshop': {
      const wb = againstWall('workbench');
      if (wb) {
        const p = st.props[wb.i];
        const f: V2 = [Math.cos(p.yaw), Math.sin(p.yaw)];
        spot('work', [p.at[0] + f[0] * 0.75, p.at[1] + f[1] * 0.75], [-f[0], -f[1]], wb.i);
      }
      const an = againstWall('anvil');
      if (an) spot('work', [st.props[an.i].at[0], st.props[an.i].at[1]], wb ? wb.slot.face : [1, 0], an.i);
      for (const prop of ['crate', 'barrel', 'logs', 'box']) againstWall(prop);
      const m = middle();
      light('lantern', [m.at[0], m.at[1], st.z + 2.2]);
      break;
    }
    case 'stores': {
      // (one a 2.5 m² or so: a store room is full but walkable)
      const area = room.tiles.reduce((a, q) => a + quadAreaOf(corners.get(q)!), 0);
      for (const prop of ['barrel', 'crate', 'barrel', 'chest', 'box', 'crate', 'barrelopen', 'logs', 'bookcase', 'box', 'pot'].slice(0, Math.max(2, Math.floor(area / 2.5)))) againstWall(prop, prop === 'bookcase' ? (s) => !s.low : undefined);
      const m = middle();
      const c = tryPlace('crate', m.at, m.ax, { pad: 0.3 });
      if (c >= 0) {
        onTop(c, 'lantern', size('crate')[2]);
        light('lantern', [m.at[0], m.at[1], st.z + size('crate')[2] + 0.35]);
      }
      break;
    }
    case 'sleeping': {
      const beds = room.tiles.length > 1 ? 2 : 1 + (rnd(seed, room.id, st.level) > 0.5 ? 1 : 0);
      for (let k = 0; k < beds; k++) {
        const bd = againstWall('bed', (s) => s.room > 0.6);
        if (!bd) break;
        const p = st.props[bd.i];
        const f: V2 = [Math.cos(p.yaw), Math.sin(p.yaw)];
        spot('sleep', [p.at[0], p.at[1]], f, bd.i, st.z + 0.4);
        spot('sit', [p.at[0] + f[0] * 0.2, p.at[1] + f[1] * 0.2], [-f[1], f[0]], bd.i);
      }
      const ch = againstWall('chest');
      void ch;
      const sd = againstWall('sidetable');
      if (sd) {
        onTop(sd.i, 'candle', size('sidetable')[2]);
        const p = st.props[sd.i];
        light('candle', [p.at[0], p.at[1], st.z + size('sidetable')[2] + 0.25]);
      }
      const m = middle();
      tryPlace('rug', m.at, m.ax, { block: false, scale: 0.75 });
      spot('stand', m.at, m.ax);
      againstWall('plant');
      break;
    }
    case 'chamber': {
      const placedT = inMiddle('table', 0.06);
      const m = placedT ?? middle();
      const tab = placedT?.i ?? -1;
      if (tab >= 0) {
        const [sx, sy] = size('table');
        const ny: V2 = [-m.ax[1], m.ax[0]];
        for (const [a, bq] of [[0, 1], [0, -1], [1, 0], [-1, 0]] as const) {
          const off = (a !== 0 ? sx / 2 : sy / 2) + size('chair')[0] / 2 + 0.1;
          const sp: V2 = [m.at[0] + (m.ax[0] * a + ny[0] * bq) * off, m.at[1] + (m.ax[1] * a + ny[1] * bq) * off];
          const face: V2 = [-(m.ax[0] * a + ny[0] * bq), -(m.ax[1] * a + ny[1] * bq)];
          const si = tryPlace('chair', sp, face, { pad: 0.02 });
          if (si >= 0) spot('sit', sp, face, si);
        }
        onTop(tab, 'candles', size('table')[2]);
        light('candle', [m.at[0], m.at[1], st.z + size('table')[2] + 0.3]);
      }
      for (const prop of ['bookcase', 'bookcase', 'chest', 'bannergreen', 'urn']) againstWall(prop, prop.startsWith('book') ? (s) => !s.low : undefined);
      tryPlace('rug', m.at, m.ax, { block: false });
      break;
    }
  }
  // standing spots: by the windows (looking out) and free floor
  for (const w of st.walls) {
    if (!w.outer || !room.tiles.includes(w.tile)) continue;
    for (const o of w.openings) {
      if (o.kind !== 'window') continue;
      const { dir, inward } = sideAxes(corners.get(w.tile)!, w.side);
      const L = Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]);
      const um = ((o.u0 + o.u1) / 2) * L;
      const p: V2 = [w.a[0] + dir[0] * um + inward[0] * (w.thick + 0.5), w.a[1] + dir[1] * um + inward[1] * (w.thick + 0.5)];
      if (g.isFree(p)) spot('stand', p, [-inward[0], -inward[1]]);
    }
  }
  void H;
  void placed;
}

function quadAreaOf(c: Quad): number {
  let a = 0;
  for (let i = 0; i < 4; i++) a += c[i][0] * c[(i + 1) % 4][1] - c[(i + 1) % 4][0] * c[i][1];
  return Math.abs(a / 2);
}

/** Every prop the plan places (for the draw: the set it needs). */
export function propsUsed(p: InteriorPlan): Set<string> {
  const s = new Set<string>();
  for (const st of p.storeys) for (const pr of st.props) s.add(pr.prop);
  return s;
}

export type { PropPlacement };
