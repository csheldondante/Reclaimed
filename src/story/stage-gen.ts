// ---- story/stage-gen.ts ---------------------------------------------------------
// A story's locations realised in the level's window (round 88, BACKLOG D10; docs/SYSTEMS.md system 3's
// `generator.brief` → places, the simplest pass): each StoryLocation's brief — its rooms and their
// connections, its locks and keys, its landmarks — built with the world API's edits where the atlas puts the
// place, and the Stage StoryPlay plays on handed back (where every place, room, person and lock is).
// - Where: toward the place's real spot on the atlas (its settlement's site, else its region's centre), from
//   the spawn, but pulled in near it (`reach`: a run on foot shouldn't be a ten-minute walk; the real
//   distances are hundreds of cells). The spot taken is the flattest dry one near that point.
// - Rooms: the brief's first room at the spot (the way in, nearest the player), the rest out from it along
//   the connections, away from the player (deeper rooms further in). A room is a circle: walled (stone,
//   plaster, wood by its kind) with a doorway toward each room it connects to, or open ground (a camp, a
//   square, a ford, a grove).
// - Locks: a connection's lock plugs the far room's doorway (bone for a bone door, wood for a wheel …); the
//   game opens it when the player comes to it holding the key (Stage.locks, StoryPlay).
// - Landmarks: matched by what they say (a bell, a mill wheel, stepping stones, oaks, carts, a dam, teeth of
//   rock) and raised in the room that fits them; the rest are left to the description.
// - The cast stand in their rooms (the brief's first room when they name none), a little in from its middle.
// - (round 99, `runstream`) What it builds comes back as pieces (StagePiece: a disc of a material so many cells
//   high, as the world API's terrain.build lays one), not edits: the caller realises them — queued as edits on a
//   still window, or kept in world cells and stamped into each region's land as it arrives (story/stage-land.ts),
//   so a streamed window keeps its places across slides and warps.

import type { SessionStory, StoryLocation } from '../api/contracts/story';
import type { Terrain } from '../api/terrain';
import type { Stage } from './play';

type V2 = [number, number];

export interface StageGenDeps {
  terrain: Terrain;
  /** water standing at (x, y) (cells; null outside) */
  waterAt?: (x: number, y: number) => number | null;
  /** the player's start (window x, y) */
  spawn: V2;
  /** a location's real spot (window x, y: maybe far outside the window) */
  spot: (l: StoryLocation) => V2;
  /** the window's size (x cells, y world units): places stay MARGIN inside it */
  size: V2;
  /** the nearest and furthest a place goes from the spawn (cells): default [22, 95] */
  reach?: V2;
}

const SIZE = { small: 4.5, medium: 6, large: 7.5 } as const;
const MARGIN = 30;
const WALL_H = 6;
const COLOURS = ['#b9d77e', '#e0b25c', '#8fb7d9', '#d98f7a', '#c6a5e0', '#9fd9c4', '#e0d17a'];

/** what a room's kind is built as: walled in a material, or open */
function roomStyle(kind: string): { wall: string | null } {
  const k = kind.toLowerCase();
  if (/barrow|ossuary|tomb|crypt|cave/.test(k)) return { wall: 'stone' };
  if (/hall|house|mill|keep|shop|sluice|tower/.test(k)) return { wall: /mill|sluice/.test(k) ? 'log' : 'plaster' };
  if (/dam/.test(k)) return { wall: 'stone' };
  return { wall: null };
}

/** a lock's plug, by its name */
function lockMaterial(lock: string): string {
  const k = lock.toLowerCase();
  if (k.includes('bone')) return 'bone';
  if (/wheel|sluice|gate/.test(k)) return 'log';
  return 'stone';
}

/**
 * (round 99) One thing the stage builds (window x, y as made; the caller keeps it where it likes): `layers` cells of
 * `material` laid on top within `radius` (full over the inner half, soft at the rim: edit.wgsl's OP_BUILD), or
 * (`grow`) plants grown there. `pass` 1 goes on what pass 0 laid (a bell on its post). `tag` says what it is
 * (`lock:<id>` a lock's plug, `wall`, `landmark`): an opened lock's plug is gone for good.
 */
export interface StagePiece {
  at: V2;
  material: string;
  radius: number;
  layers: number;
  pass: 0 | 1;
  tag: string;
  grow?: number;
}

export interface StageGen {
  stage: Stage;
  /** what to build (queued as edits, the world API's queue takes four a tick: they land over the next second or so) */
  pieces: StagePiece[];
}

/** Realise every location's brief near the spawn; the Stage for StoryPlay. */
export function stageStory(story: SessionStory, d: StageGenDeps): StageGen {
  const [near, far] = d.reach ?? [22, 95];
  const stage: Stage = { locations: {}, cast: {}, rooms: {}, locks: [] };
  const pieces: StagePiece[] = [];
  const build = (x: number, y: number, m: string, radius: number, layers: number, tag = 'wall') => {
    pieces.push({ at: [x, y], material: m, radius, layers, pass: 0, tag });
  };
  // (how far each place's real spot is: the nearest real one comes in at `near`, the furthest at `far`)
  const real = story.locations.map((l) => {
    const [sx, sy] = d.spot(l);
    return { l, dx: sx - d.spawn[0], dy: sy - d.spawn[1], d: Math.hypot(sx - d.spawn[0], sy - d.spawn[1]) };
  });
  const dMax = Math.max(1, ...real.map((r) => r.d));
  const taken: { at: V2; r: number }[] = [{ at: d.spawn, r: 3 }];
  real.forEach(({ l, dx, dy, d: dist }, li) => {
    const ang = dist < 1 ? li * 2.4 : Math.atan2(dy, dx);
    const want0 = near + (far - near) * Math.sqrt(dist / dMax);
    const rooms = layoutRooms(l, ang);
    const extent = Math.max(...rooms.map((r) => Math.hypot(r.at[0], r.at[1]) + r.r)) + 2;
    // (its way in, the first room, clear of the spawn)
    const want = Math.max(want0, rooms[0].r + 6);
    const at = pick(d, ang, want, extent, rooms, taken);
    for (const r of rooms) taken.push({ at: [at[0] + r.at[0], at[1] + r.at[1]], r: r.r + 4 });
    stage.locations[l.id] = { at: [at[0] + rooms[0].at[0] * 0.5, at[1] + rooms[0].at[1] * 0.5], radius: extent };
    const rs: Record<string, { at: V2; radius: number }> = {};
    for (const r of rooms) rs[r.id] = { at: [at[0] + r.at[0], at[1] + r.at[1]], radius: r.r - 0.8 };
    stage.rooms![l.id] = rs;
    // the walls, with their doorways
    for (const r of rooms) {
      const { wall } = roomStyle(r.kind);
      const c = rs[r.id].at;
      if (wall) {
        const doors = r.doors.map((o) => Math.atan2(rs[o].at[1] - c[1], rs[o].at[0] - c[0]));
        // (a way in from outside too, for the brief's first room: toward the player)
        if (r === rooms[0]) doors.push(Math.atan2(d.spawn[1] - c[1], d.spawn[0] - c[0]));
        const gap = 2.4 / r.r;
        // (two rings of columns, 0.8 apart along them: one ring of hex columns leaves slits a body can't pass
        // but a path on a square grid thinks it can — round 88, the hero stuck against the bell chamber's wall)
        for (const rr of [r.r, r.r + 0.9]) {
          const n = Math.ceil((2 * Math.PI * rr) / 0.8);
          for (let k = 0; k < n; k++) {
            const a = (k / n) * Math.PI * 2;
            if (doors.some((g) => Math.abs(wrap(a - g)) < gap)) continue;
            build(c[0] + Math.cos(a) * rr, c[1] + Math.sin(a) * rr, wall, 0.9, WALL_H);
          }
        }
      }
    }
    // the locks: the far room's doorway plugged
    for (const cn of l.brief.connections ?? []) {
      if (!cn.lock) continue;
      const a = rs[cn.from].at;
      const b = rs[cn.to].at;
      const rb = rooms.find((r) => r.id === cn.to)!.r;
      const g = Math.atan2(a[1] - b[1], a[0] - b[0]);
      const p: V2 = [b[0] + Math.cos(g) * rb, b[1] + Math.sin(g) * rb];
      const mat = lockMaterial(cn.lock);
      build(p[0], p[1], mat, 2.8, WALL_H, `lock:${cn.lock}`);
      const key = l.brief.keys?.find((k) => k.lock === cn.lock)?.key ?? {};
      stage.locks!.push({ id: cn.lock, location: l.id, room: cn.to, at: p, key, material: mat, open: false });
    }
    // the landmarks
    for (const lm of l.brief.landmarks ?? []) landmark(lm, rooms, rs, pieces);
  });
  // the cast, in their rooms
  story.cast.forEach((c, i) => {
    const l = story.locations.find((x) => x.id === c.location);
    if (!l) throw new Error(`stage: ${c.id}'s location "${c.location}" isn't in the story`);
    const rs = stage.rooms![l.id];
    const room = c.room ?? l.brief.rooms?.[0]?.id;
    const r = room ? rs[room] : undefined;
    const base = r?.at ?? stage.locations[l.id].at;
    // (in from the middle, toward the spawn: the landmark keeps the middle)
    const a = Math.atan2(d.spawn[1] - base[1], d.spawn[0] - base[0]) + (i % 3) * 0.5;
    const off = r ? Math.min(2.6, r.radius * 0.5) : 2;
    stage.cast[c.id] = { at: [base[0] + Math.cos(a) * off, base[1] + Math.sin(a) * off], colour: COLOURS[i % COLOURS.length], material: 'plaster' };
  });
  return { stage, pieces };
}

interface Room {
  id: string;
  kind: string;
  r: number;
  /** its centre from the location's spot */
  at: V2;
  /** the rooms it opens onto */
  doors: string[];
}

/** the brief's rooms laid out: the first at the spot, each next one out from the one it connects from */
function layoutRooms(l: StoryLocation, away: number): Room[] {
  const brief = l.brief.rooms?.length ? l.brief.rooms : [{ id: l.id, kind: l.kind, size: 'medium' as const }];
  const rooms: Room[] = brief.map((b) => ({ id: b.id, kind: b.kind, r: SIZE[b.size ?? 'medium'], at: [0, 0], doors: [] }));
  const by = new Map(rooms.map((r) => [r.id, r]));
  const cons = l.brief.connections ?? [];
  for (const c of cons) {
    by.get(c.from)?.doors.push(c.to);
    by.get(c.to)?.doors.push(c.from);
  }
  const placed = new Set([rooms[0].id]);
  const dir = new Map<string, number>([[rooms[0].id, away]]);
  const queue = [rooms[0]];
  while (queue.length) {
    const p = queue.shift()!;
    const kids = cons.filter((c) => c.from === p.id && !placed.has(c.to)).map((c) => by.get(c.to)!);
    kids.forEach((k, i) => {
      const spread = kids.length === 1 ? 0 : (i / (kids.length - 1) - 0.5) * 1.6;
      const a = dir.get(p.id)! + spread;
      const dist = p.r + k.r + 3;
      k.at = [p.at[0] + Math.cos(a) * dist, p.at[1] + Math.sin(a) * dist];
      dir.set(k.id, a);
      placed.add(k.id);
      queue.push(k);
    });
  }
  // (a room nothing leads to: beside the first)
  rooms.forEach((r, i) => {
    if (placed.has(r.id)) return;
    const a = away + Math.PI / 2 + i;
    r.at = [Math.cos(a) * (rooms[0].r + r.r + 3), Math.sin(a) * (rooms[0].r + r.r + 3)];
    placed.add(r.id);
  });
  return rooms;
}

/** the flattest dry spot near `want` cells from the spawn along `ang`, clear of the places already taken */
function pick(d: StageGenDeps, ang: number, want: number, extent: number, rooms: Room[], taken: { at: V2; r: number }[]): V2 {
  const t = d.terrain;
  let best: V2 | null = null;
  let bestScore = Infinity;
  // (nearest its bearing first; turned up to ~70° and brought in up to 40 cells when the window's edge or
  // another place is in the way)
  const dds = [0, -8, 8, -16, 16, -24, -32, -40].filter((x) => want + x >= 12);
  const das = [0, -0.18, 0.18, -0.36, 0.36, -0.6, 0.6, -0.9, 0.9, -1.2, 1.2];
  for (const dd of dds)
    for (const da of das) {
      const dist = want + dd;
      const a = ang + da;
      const p: V2 = [d.spawn[0] + Math.cos(a) * dist, d.spawn[1] + Math.sin(a) * dist];
      if (p[0] < MARGIN * 0.5 || p[1] < MARGIN * 0.5 || p[0] > d.size[0] - MARGIN * 0.5 || p[1] > d.size[1] - MARGIN * 0.5) continue;
      // (every room inside the window and clear of what's taken: other places' rooms, the spawn)
      const clear = rooms.every((r) => {
        const x = p[0] + r.at[0];
        const y = p[1] + r.at[1];
        if (x < MARGIN * 0.5 || y < MARGIN * 0.5 || x > d.size[0] - MARGIN * 0.5 || y > d.size[1] - MARGIN * 0.5) return false;
        return taken.every((o) => Math.hypot(o.at[0] - x, o.at[1] - y) >= o.r + r.r);
      });
      if (!clear) continue;
      let lo = Infinity;
      let hi = -Infinity;
      let wet = 0;
      let ok = true;
      for (let k = 0; k < 24 && ok; k++) {
        const r = extent * (k < 8 ? 0.35 : k < 16 ? 0.7 : 1);
        const q = (k / 8) * Math.PI * 2;
        const x = p[0] + Math.cos(q) * r;
        const y = p[1] + Math.sin(q) * r;
        const z = t.heightAt(x, y);
        if (z === null) ok = false;
        else {
          lo = Math.min(lo, z);
          hi = Math.max(hi, z);
          if ((d.waterAt?.(x, y) ?? 0) > 0.3) wet++;
        }
      }
      if (!ok) continue;
      const score = hi - lo + wet * 3 + Math.abs(dd) * 0.05 + Math.abs(da) * 2;
      if (score < bestScore) {
        bestScore = score;
        best = p;
      }
    }
  if (!best) throw new Error(`stage: no room for a place ${want.toFixed(0)} cells from the spawn (the window's too small or full)`);
  return best;
}

/** a landmark the brief names, raised where it fits → pieces */
function landmark(text: string, rooms: Room[], rs: Record<string, { at: V2; radius: number }>, out: StagePiece[]): void {
  const s = text.toLowerCase();
  const room = (re: RegExp) => rooms.find((r) => re.test(r.kind) || re.test(r.id)) ?? rooms[0];
  const at = (r: Room) => rs[r.id].at;
  const b = (x: number, y: number, m: string, radius: number, layers: number, pass: 0 | 1 = 0) => {
    out.push({ at: [x, y], material: m, radius, layers, pass, tag: 'landmark' });
  };
  if (s.includes('bell')) {
    // a bronze bell on a post (the bell laid on the post's top: pass 1)
    const [x, y] = at(room(/tomb|hall|bell/));
    b(x, y, 'log', 0.7, 5);
    b(x, y, 'rust', 1.4, 2, 1);
  } else if (s.includes('mill')) {
    const [x, y] = at(room(/mill/));
    b(x, y, 'log', 1.6, 3);
  } else if (s.includes('stepping stone')) {
    const [x, y] = at(room(/ford|river/));
    for (let k = -2; k <= 2; k++) b(x + k * 1.8, y + (k % 2) * 0.6, 'stone', 0.7, 1);
  } else if (/oak|tree|grove|wood/.test(s)) {
    const [x, y] = at(room(/grove|ring/));
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2;
      b(x + Math.cos(a) * 3, y + Math.sin(a) * 3, 'log', 0.5, 3);
    }
    out.push({ at: [x, y], material: 'log', radius: 5, layers: 0, pass: 0, tag: 'landmark', grow: 70 });
  } else if (/cart|barricade/.test(s)) {
    const r = room(/gate/);
    const [x, y] = at(r);
    for (let k = -1; k <= 1; k++) b(x + k * 2.2, y - 1.5, 'log', 0.9, 2);
  } else if (s.includes('dam')) {
    const r = room(/dam/);
    const [x, y] = at(r);
    for (let k = -3; k <= 3; k++) if (Math.abs(k) > 0) b(x + k * 1.4, y + r.r + 1.5, 'stone', 0.9, 3);
  } else if (/teeth|spire|crag|peak/.test(s)) {
    // rock rising behind the place: three teeth beyond its furthest room
    const c = rs[rooms[0].id].at;
    const fur = rooms.reduce((a, r) => (Math.hypot(r.at[0], r.at[1]) > Math.hypot(a.at[0], a.at[1]) ? r : a), rooms[0]);
    const fc = rs[fur.id].at;
    const ax = fc[0] - c[0];
    const ay = fc[1] - c[1];
    const al = Math.hypot(ax, ay) || 1;
    for (let k = -1; k <= 1; k++) {
      const x = fc[0] + (ax / al) * (fur.r + 6) - (ay / al) * k * 5;
      const y = fc[1] + (ay / al) * (fur.r + 6) + (ax / al) * k * 5;
      b(x, y, 'stone', 2.2, 10 + (k === 0 ? 6 : 0));
    }
  }
}

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
