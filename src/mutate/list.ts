// The world modifier list (docs/design/MUTATORS.md): the persistent truth of what the mutators did. Pure — no GPU, no
// DOM: entries made from a spec (their numbers fixed from the atlas's ground, never from the window), found by the land
// they touch, and the places' states derived from them. The GPU ops (mutate/gpu.ts) are a pure function of an entry and
// a column, so the list is all a save needs.
import { MAT } from '../world/materials';
import { ROW_H } from '../world/lattice';
import type { Applied, Mutation, MutationRecord, MutationSpec, MutatorKind, PhysicalKind, PlaceState, Sign, SignSpec } from './index';

/** a place as the atlas knows it (a settlement's record: settle/settlements.ts), positions in world units */
export interface AtlasPlace {
  id: string;
  name: string;
  /** world units (x cells, y · ROW_H) */
  at: readonly [number, number];
  radius: number;
  size: string;
  faction?: string | null;
}

/** what the list asks of the world it's for */
export interface ListWorld {
  /** the atlas's ground (world z) at a world point (x cells, y world units): coarse, known everywhere, never the window's */
  ground(x: number, y: number): number;
  /** the sea's level (world z; -1e9 none) */
  sea: number;
  place(id: string): AtlasPlace | null;
  places(): AtlasPlace[];
}

const LAND: ReadonlySet<MutatorKind> = new Set(['flooded', 'burned', 'melted', 'buried', 'dried', 'withered', 'greened']);
export const isLand = (k: MutatorKind): k is PhysicalKind => LAND.has(k);

/** mutate/land.wgsl MUT_* */
/** mutLots' codes for the 'crime' sign: a share of the lots looted, and put right again */
export const GPU_LOOT = 8;
export const GPU_UNLOOT = 9;

export const GPU_KIND: Record<MutatorKind, number | null> = { flooded: 0, burned: 1, melted: 2, buried: 3, destroyed: 4, abandoned: 5, captured: 6, vassal: null, founded: null, withered: 10, greened: 11, dried: 12 };

/** the radius of an area given without one, and of a place the atlas gives none */
export const DEFAULT_RADIUS = 28;

const rnd = (seed: number, k: number) => {
  let h = (Math.imul(seed | 0, 0x9e3779b1) ^ Math.imul(k + 1, 0x85ebca6b)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0;
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39) >>> 0;
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
};

/** a holder's colour index (0..255) for its lots' roofs: from its name, so the same holder is the same colour */
export function holderHue(by: string): number {
  let h = 2166136261;
  for (let i = 0; i < by.length; i++) h = Math.imul(h ^ by.charCodeAt(i), 16777619);
  return (h >>> 0) % 256;
}

export class WorldList {
  private entries: Mutation[] = [];
  private on: Sign[] = [];
  /** the loop's season (signs end by it) */
  seasonNow = 0;

  /** A sign on, replaced or (strength 0) off. Returns the sign as it stands (null: off). */
  sign(spec: SignSpec): Sign | null {
    const place = spec.place ?? null;
    this.on = this.on.filter((s) => !(s.kind === spec.kind && s.place === place));
    const strength = Math.min(1, Math.max(0, spec.strength ?? 1));
    if (strength <= 0) return null;
    const s: Sign = { kind: spec.kind, place, strength, until: spec.until ?? null, cause: spec.cause ?? null, unrest: spec.kind === 'crime' ? Math.ceil(strength * 2) : spec.kind === 'deadrise' ? 1 : 0 };
    this.on.push(s);
    return s;
  }

  signs(place?: string): Sign[] {
    return this.on.filter((s) => place === undefined || s.place === place || s.place === null).map((s) => ({ ...s }));
  }

  /** the season is `n` now: true if a sign ended */
  season(n: number): boolean {
    this.seasonNow = n;
    const before = this.on.length;
    this.on = this.on.filter((s) => s.until === null || s.until >= n);
    return this.on.length !== before;
  }
  constructor(private world: ListWorld) {}

  get all(): readonly Mutation[] {
    return this.entries;
  }

  /** A spec as an entry: its area resolved, its numbers fixed from the atlas's ground. Not added. */
  make(spec: MutationSpec): Mutation {
    const pl = spec.place ? this.place0(spec.place) : null;
    if (spec.place && !pl && spec.kind !== 'founded') throw new Error(`mutators: no place "${spec.place}"`);
    if (!pl && !spec.at) throw new Error(`mutators: ${spec.kind} needs a place or an \`at\``);
    const cell: [number, number] = spec.at ? [Math.round(spec.at[0]), Math.round(spec.at[1])] : [Math.round(pl!.at[0]), Math.round(pl!.at[1] / ROW_H)];
    const radius = Math.max(4, Math.round(spec.radius ?? pl?.radius ?? DEFAULT_RADIUS));
    const strength = Math.min(1, Math.max(0, spec.strength ?? 1));
    const seed = (spec.seed ?? 1) >>> 0;
    const place = spec.kind === 'founded' ? (spec.place ?? `founded-${cell[0]}-${cell[1]}`) : (spec.place ?? null);
    const m: Mutation = { id: '', kind: spec.kind, place, cell, radius, strength, seed, params: this.params(spec.kind, cell, radius, strength, seed), seq: -1 };
    if (spec.by !== undefined) m.by = spec.by;
    if (spec.tribute !== undefined) m.tribute = spec.tribute;
    if (spec.cause !== undefined) m.cause = spec.cause;
    if (spec.kind === 'founded') {
      m.name = spec.name ?? 'New camp';
      m.size = spec.size ?? 'camp';
    }
    m.id = [m.kind, place ?? '', cell[0], cell[1], radius, strength, seed, m.by ?? '', m.tribute ?? ''].join(':');
    return m;
  }

  /** Add an entry (the same one again is the one it has: `fresh` false). */
  add(spec: MutationSpec): { m: Mutation; fresh: boolean } {
    const m = this.make(spec);
    const had = this.entries.find((e) => e.id === m.id);
    if (had) return { m: had, fresh: false };
    m.seq = this.entries.length;
    this.entries.push(m);
    return { m, fresh: true };
  }

  /** the op's own numbers (index.ts Mutation.params), world z */
  private params(kind: MutatorKind, cell: readonly [number, number], radius: number, strength: number, seed: number): number[] {
    const g = (x: number, row: number) => this.world.ground(x, row * ROW_H);
    const [cx, cy] = cell;
    if (kind === 'flooded') {
      // the level: over the lowest ground of the area by a share of how much it rises (the low part goes under), and
      // never under the sea come up
      let lo = g(cx, cy);
      let sum = lo;
      const N = 24;
      for (let k = 0; k < N; k++) {
        const a = (k / N) * Math.PI * 2;
        const rr = radius * (k % 2 ? 0.75 : 0.4);
        const z = g(cx + Math.cos(a) * rr, cy + (Math.sin(a) * rr) / ROW_H);
        lo = Math.min(lo, z);
        sum += z;
      }
      const mean = sum / (N + 1);
      const base = Math.max(lo, this.world.sea > -1e8 ? this.world.sea : lo);
      return [base + strength * Math.max(2.5, 1 + 0.6 * (mean - lo))];
    }
    if (kind === 'melted') {
      // downhill by the atlas's ground over the area; the vent on the uphill side
      const e = radius * 0.5;
      let dx = g(cx - e, cy) - g(cx + e, cy);
      let dy = g(cx, cy - e / ROW_H) - g(cx, cy + e / ROW_H);
      let l = Math.hypot(dx, dy);
      if (l < 0.05) {
        const a = rnd(seed, 1) * Math.PI * 2;
        dx = Math.cos(a);
        dy = Math.sin(a);
        l = 1;
      }
      dx /= l;
      dy /= l;
      // (the vent's cell: world x, world y in units — kept as numbers of the entry)
      const vx = cx + 0.5 - dx * radius * 0.45;
      const vy = (cy + 0.5) * ROW_H - dy * radius * 0.45;
      return [vx, vy, this.world.ground(vx, vy) + 1, radius * (0.9 + 0.5 * strength), dx, dy];
    }
    if (kind === 'buried') {
      const a = rnd(seed, 2) * Math.PI * 2;
      return [2 + 5 * strength, MAT.Sand, Math.cos(a), Math.sin(a)];
    }
    // (how deep the water taken off is: what lies deeper stays as pools)
    if (kind === 'dried') return [1 + 3 * strength];
    return [];
  }

  private place0(id: string): AtlasPlace | null {
    const a = this.world.place(id);
    if (a) return a;
    const f = this.entries.find((m) => m.kind === 'founded' && m.place === id);
    return f ? { id, name: f.name ?? id, at: [f.cell[0], f.cell[1] * ROW_H], radius: f.radius, size: f.size ?? 'camp', faction: f.by ?? null } : null;
  }

  /** One place as the list has left it (an atlas place the list never touched: standing, its own). */
  place(id: string): PlaceState | null {
    const a = this.place0(id);
    if (!a) return null;
    const s: PlaceState = { id, name: a.name, at: [Math.round(a.at[0]), Math.round(a.at[1] / ROW_H)], size: a.size, owner: a.faction ?? '', status: 'standing', tribute: 0, population: 1, conditions: [], restless: false, history: [] };
    for (const m of this.entries) {
      const mine = m.place === id;
      // (a land entry by area counts for a place whose centre lies in it)
      const inArea = isLand(m.kind) && Math.hypot(m.cell[0] - a.at[0], m.cell[1] * ROW_H - a.at[1]) <= m.radius;
      if (!mine && !inArea) continue;
      s.history.push(m.id);
      if (isLand(m.kind)) {
        s.conditions.push(m.kind);
        if (s.population > 0) s.population = Math.max(0.1, s.population * (1 - 0.5 * m.strength));
        continue;
      }
      if (m.kind === 'founded') {
        s.status = 'founded';
        s.owner = m.by ?? '';
      } else if (m.kind === 'destroyed') {
        s.status = 'destroyed';
        s.population = 0;
        s.tribute = 0;
      } else if (m.kind === 'abandoned') {
        s.status = 'abandoned';
        s.population = 0;
        s.tribute = 0;
      } else if (m.kind === 'captured') {
        s.status = 'occupied';
        s.owner = m.by ?? 'unknown';
        s.tribute = 0;
      } else if (m.kind === 'vassal') {
        s.status = 'vassal';
        s.owner = m.by ?? 'unknown';
        s.tribute = m.tribute ?? 1;
      }
    }
    s.restless = (s.status === 'vassal' || s.status === 'occupied') && s.population > 0;
    return s;
  }

  /** every place the list has touched (by name or by area), in the order it first did */
  places(): PlaceState[] {
    const ids: string[] = [];
    const add = (id: string) => void (ids.includes(id) || ids.push(id));
    const atlas = this.world.places();
    for (const m of this.entries) {
      if (m.place) add(m.place);
      else for (const a of atlas) if (Math.hypot(m.cell[0] - a.at[0], m.cell[1] * ROW_H - a.at[1]) <= m.radius) add(a.id);
    }
    return ids.map((id) => this.place(id)).filter((p): p is PlaceState => p !== null);
  }

  record(): MutationRecord {
    return { version: 2, list: this.entries.map((m) => ({ ...m, cell: [...m.cell] as [number, number], params: [...m.params] })), signs: this.on.map((s) => ({ ...s })), season: this.seasonNow };
  }

  /** the list as saved (its entries keep their numbers: the atlas isn't asked again) */
  restore(r: MutationRecord): void {
    if (r.version !== 2) throw new Error(`mutators: a record of version ${(r as { version: number }).version}, this build reads 2`);
    this.entries = r.list.map((m, i) => ({ ...m, cell: [...m.cell] as [number, number], params: [...m.params], seq: i }));
    this.on = (r.signs ?? []).map((s) => ({ ...s }));
    this.seasonNow = r.season ?? 0;
  }
}

export const applied = (m: Mutation, resident: boolean, fresh: boolean): Applied => ({ ...m, resident, fresh });
