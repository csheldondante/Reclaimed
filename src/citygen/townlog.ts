// (season saving; docs/design/SEASON_LOOP.md "Saving") A town's changes as an edit log, keyed by its place in the world,
// laid over the town made again from its seed, ground and population field (DESIGN §23: generated towns are re-made,
// what play changed is saved; the user: town changes saved like terrain changes, a per-town edit log keyed by world
// position). The log is the inputs the town was given — the districts claimed, each card's share and stage, the wall's
// ring and stage — and two small GPU states read back at save points only: the wall's ring (once, after it's made) and
// the living town's works (the quarry's benches, the clearing's camp: a few hundred bytes a season end). Kept in
// memory for the session (a town let go and made again — SL3), and in the world store (`?fresh=1` clears it) for a
// reload. Replayed when the town is made: claims by id, stages there at once, the wall's words written back.
import type { DistrictStage } from '../api/contracts/citygen';

export interface TownLog {
  /** the town's place in the world (world units): its key */
  at: [number, number];
  /** districts claimed (their ids, in order) */
  claims: number[];
  /** (town contracts) the purpose (streets.wgsl P_*) each claimed district was claimed for, by id — a keep card's
   *  district is the keep's whatever the population field said there */
  purposes?: Record<number, number>;
  /** each district's slots' stages, as last set (its `to` reached) */
  stages: { id: number; stage: DistrictStage }[];
  /** the wall: its words (streets.wgsl WALL: the ring, gates; read back once made) and its stage reached */
  wall?: { words: number[]; to: number };
  /** the living town's works words (routes.wgsl LT: the quarry's L_Q and the clearing's L_F heads) */
  works?: { q: number[]; f: number[] };
}

/** where a town's log is kept: memory, and the world store (any key–value store of bytes: the region store) */
export interface LogStore {
  get(key: string): Promise<Uint8Array | null>;
  put(key: string, bytes: Uint8Array): Promise<void>;
}

export const townKey = (at: readonly [number, number]) => `town:${Math.round(at[0])},${Math.round(at[1])}`;

export class TownLogs {
  private logs = new Map<string, TownLog>();
  store: LogStore | null = null;
  /** the bytes last written, by key (the report's sizes) */
  readonly sizes = new Map<string, number>();

  /** a town's log (made empty the first time) */
  of(at: readonly [number, number]): TownLog {
    const k = townKey(at);
    let l = this.logs.get(k);
    if (!l) {
      l = { at: [at[0], at[1]], claims: [], stages: [] };
      this.logs.set(k, l);
    }
    return l;
  }

  has(at: readonly [number, number]): boolean {
    return this.logs.has(townKey(at));
  }

  /** a town's log from the store, if the session hasn't one (a reload) */
  async load(at: readonly [number, number]): Promise<TownLog | null> {
    const k = townKey(at);
    const mem = this.logs.get(k);
    if (mem) return mem;
    const b = await this.store?.get(k);
    if (!b) return null;
    const l = JSON.parse(new TextDecoder().decode(b)) as TownLog;
    this.logs.set(k, l);
    return l;
  }

  claim(at: readonly [number, number], id: number, purpose?: number): void {
    const l = this.of(at);
    if (!l.claims.includes(id)) l.claims.push(id);
    if (purpose !== undefined) (l.purposes ??= {})[id] = purpose;
  }

  stage(at: readonly [number, number], id: number, stage: DistrictStage): void {
    const l = this.of(at);
    const s = l.stages.find((x) => x.id === id && x.stage.slot === stage.slot);
    // (kept as reached: a replay sets it at once)
    const reached = { ...stage, from: stage.to };
    if (s) s.stage = reached;
    else l.stages.push({ id, stage: reached });
  }

  /** the town's log written to the store (a save point: a season's end) */
  async save(at: readonly [number, number]): Promise<number> {
    const k = townKey(at);
    const l = this.logs.get(k);
    if (!l || !this.store) return 0;
    const b = new TextEncoder().encode(JSON.stringify(l));
    const n = b.byteLength;
    this.sizes.set(k, n);
    // (the store takes the bytes: their buffer is transferred)
    await this.store.put(k, b);
    return n;
  }
}
