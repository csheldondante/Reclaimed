// (trackA-forces; docs/design/SEASON_LOOP.md "Soldiers and waves") TownForces: the one adapter between the season loop
// and the Units contract for a town's soldiers and raiders. Its interface is the calls agreed with Track B for U2 round
// 5 — spawnAt(kind, faction, at: PlaceRef, n) → GroupId, orderGroup(g, { kind: guard | go | attack, at: PlaceRef }), and
// the events arrived(g) once a group, orderFailed(g, why) with why a place status, died with `by` — so that Track B's
// GPU calls replace this file's insides and nothing else changes. Every Units call the season makes is in here.
//
// INTERIM (to delete when Track B's place-based spawnAt / orderGroup land): the places are found on the CPU from one
// tiny async read of the town's slot of the place table (800 bytes: the header and the 23 named entries), made only
// after an event (a season's resolve landed, a wave starting, the window sliding) and never per frame — listed in
// gpu/transfers.ts (TownForces.read). With the place a point, the existing jobs do the walking (guard / go; attack on a
// place is hostile and going there). arrived(g) is emulated from the units' own states (each member seen walking, then
// none walking — no position read), orderFailed from the read's statuses.
import type { FactionId } from '../api/contracts/world';
import type { UnitId, Units, UnitView, V2 } from '../api/contracts/units';
import { NAMED_PLACES, PLACE_STATUS, type GroupId, type PlaceRef, type PlaceStatusName } from '../api/contracts/townplaces';
import { TOWN_WORDS } from '../towncontracts/contracts';

/** what the adapter reads the places from: the town contracts' table (TownContractsApi) and its device */
export interface PlaceSource {
  readonly device: GPUDevice;
  readonly places: GPUBuffer;
}

export type ForceKind = 'soldier' | 'raider';
export interface ForceOrder {
  kind: 'guard' | 'go' | 'attack';
  at: PlaceRef;
}

/** how a group is doing (the season's report) */
export interface GroupReport {
  id: GroupId;
  kind: ForceKind;
  /** spawned (0 until its place is found; stays 0 if spawning failed) */
  size: number;
  alive: number;
  dead: number;
  arrived: boolean;
  failed: PlaceStatusName | null;
}

/** a town slot's header words and named entries (townplace.wgsl PLT_NAMED_AT, PLT_ENTRY): the 800 bytes read */
const NAMED_AT = 16;
const ENTRY = 8;
const READ_WORDS = NAMED_AT + NAMED_PLACES * ENTRY;
/** frames after an event before the read: the place solve is woken by the event's upload and runs in the next frame's
 *  pass (towncontracts plWake → the indirect solve), so the second frame's copy sees it */
const SETTLE_FRAMES = 2;
/** a guard's reach round its place (cells): soldiers hold the yard or the gate, not one cell */
const GUARD_RADIUS = 5;

/** each kind's unit (the Units contract's spawn options) */
const KIND: Record<ForceKind, { kind: string; hostile: boolean; opts: { role: string; health: number; sight: number; speed: number } }> = {
  soldier: { kind: 'guard', hostile: false, opts: { role: 'guard', health: 3, sight: 22, speed: 3.2 } },
  raider: { kind: 'raider', hostile: true, opts: { role: 'raider', health: 3, sight: 24, speed: 3.4 } },
};

interface Named {
  status: number;
  at: V2;
}

interface Group {
  id: GroupId;
  kind: ForceKind;
  faction: FactionId;
  units: UnitId[];
  dead: number;
  order: ForceOrder | null;
  /** members seen walking under the current order (arrived: all of them, then none walking) */
  walked: Set<UnitId>;
  arrived: boolean;
  failed: PlaceStatusName | null;
  /** a spawn or order waiting on the read: its token (a later one supersedes it) */
  token: number;
}

const STATUS_NAME = Object.fromEntries(Object.entries(PLACE_STATUS).map(([k, v]) => [v, k])) as Record<number, PlaceStatusName>;

export class TownForces {
  /** a group stands at its order's place: once an order */
  readonly arrived: ((g: GroupId) => void)[] = [];
  /** a spawn or an order whose place (its last choice) isn't valid: why is the place's status */
  readonly orderFailed: ((g: GroupId, why: PlaceStatusName, at: PlaceRef) => void)[] = [];
  /** a member died: `by` as the Units contract's died */
  readonly died: ((g: GroupId, u: UnitView, by: UnitId | string | null) => void)[] = [];
  /** a member was hurt */
  readonly hurt: ((g: GroupId, u: UnitView, damage: number, by: UnitId | string | null) => void)[] = [];

  private groups = new Map<GroupId, Group>();
  private ofUnit = new Map<UnitId, GroupId>();
  private next = 1;
  private frame = 0;
  /** the frame after which a read sees the newest places (an event moves it on) */
  private freshAt = 0;
  /** the place table's named entries read, by town slot (one read an event) */
  private cache = new Map<number, Promise<Named[]>>();
  private waiters: { at: number; go: () => void }[] = [];
  /** (the report, tests) reads made */
  reads = 0;

  constructor(
    private units: Units,
    private source: () => PlaceSource | null,
  ) {
    units.died.push((u, by) => {
      const g = this.groups.get(this.ofUnit.get(u.id) ?? -1);
      if (!g) return;
      g.dead++;
      for (const f of this.died) f(g.id, u, by);
    });
    units.hurt.push((u, d, by) => {
      const g = this.ofUnit.get(u.id);
      if (g !== undefined) for (const f of this.hurt) f(g, u, d, by);
    });
  }

  // ---- the agreed calls ----------------------------------------------------------------------------

  /** n units of a kind at a place: the group's id now, its units once the place is found (or orderFailed) */
  spawnAt(kind: ForceKind, faction: FactionId, at: PlaceRef, n: number): GroupId {
    const g: Group = { id: this.next++, kind, faction, units: [], dead: 0, order: null, walked: new Set(), arrived: false, failed: null, token: 0 };
    this.groups.set(g.id, g);
    const token = ++g.token;
    void this.resolve(at).then(({ at: p, why }) => {
      if (token !== g.token) return;
      if (!p) return this.fail(g, why, at);
      const k = KIND[kind];
      for (let i = 0; i < n; i++) {
        // (a small ring round the place, so a squad doesn't start in one cell)
        const a = (i / Math.max(1, n)) * Math.PI * 2;
        const r = n > 1 ? 1.2 : 0;
        const id = this.units.spawn(k.kind, [p[0] + Math.cos(a) * r, p[1] + Math.sin(a) * r], faction, { ...k.opts, hostile: k.hostile, job: { kind: 'guard', at: p, radius: GUARD_RADIUS } });
        g.units.push(id);
        this.ofUnit.set(id, g.id);
      }
      // (an order given before the units stood: given now)
      if (g.order) this.apply(g, g.order);
    });
    return g.id;
  }

  /** the group's order: guard a place, go there, or attack it (hostile to whatever is there, heading for it) */
  orderGroup(id: GroupId, order: ForceOrder): void {
    const g = this.groups.get(id);
    if (!g) throw new Error(`forces: no group ${id}`);
    g.order = order;
    g.arrived = false;
    g.walked.clear();
    g.failed = null;
    if (g.units.length) this.apply(g, order);
  }

  // ---- the season's other needs (Track B: report and remove stay Units calls over the group's members) -------------

  report(id: GroupId): GroupReport | null {
    const g = this.groups.get(id);
    if (!g) return null;
    return { id, kind: g.kind, size: g.units.length, alive: this.living(g).length, dead: g.dead, arrived: g.arrived, failed: g.failed };
  }

  /** the group's living members taken out of play (raiders leaving, soldiers sent home), and the group forgotten */
  disband(id: GroupId): void {
    const g = this.groups.get(id);
    if (!g) return;
    g.token++;
    for (const u of g.units) {
      if (this.units.get(u)?.alive) this.units.remove(u);
      this.ofUnit.delete(u);
    }
    this.groups.delete(id);
  }

  /**
   * An event moved the town's places (a season's stages landed, a wall finished, a district begun, the window slid):
   * the next spawn or order reads them again — after the GPU's solve has had its frames.
   */
  placesMoved(): void {
    this.cache.clear();
    this.freshAt = this.frame + SETTLE_FRAMES;
  }

  /** each frame: counts frames for the read, and tells arrivals from the units' states (no position read) */
  update(): void {
    this.frame++;
    const due = this.waiters.filter((w) => w.at <= this.frame);
    this.waiters = this.waiters.filter((w) => w.at > this.frame);
    for (const w of due) w.go();
    for (const g of this.groups.values()) {
      if (!g.order || g.arrived || g.failed || !g.units.length) continue;
      const live = this.living(g);
      if (!live.length) continue;
      let walking = false;
      for (const v of live) {
        if (v.state === 'walk') {
          g.walked.add(v.id);
          walking = true;
        }
      }
      if (walking || !live.every((v) => g.walked.has(v.id))) continue;
      g.arrived = true;
      for (const f of this.arrived) f(g.id);
    }
  }

  // ---- inside --------------------------------------------------------------------------------------

  private living(g: Group): UnitView[] {
    return g.units.map((u) => this.units.get(u)).filter((v): v is UnitView => !!v && v.alive);
  }

  private apply(g: Group, order: ForceOrder): void {
    const token = ++g.token;
    void this.resolve(order.at).then(({ at: p, why }) => {
      if (token !== g.token) return;
      if (!p) return this.fail(g, why, order.at);
      const ids = this.living(g).map((v) => v.id);
      if (order.kind === 'attack') for (const u of ids) this.units.setHostile(u, true);
      this.units.order(ids, order.kind === 'guard' ? { kind: 'guard', at: p, radius: GUARD_RADIUS } : { kind: 'go', to: p });
    });
  }

  private fail(g: Group, why: PlaceStatusName, at: PlaceRef): void {
    g.failed = why;
    for (const f of this.orderFailed) f(g.id, why, at);
  }

  /** a place chain's first valid place (window x, y), or the last one's status */
  private async resolve(ref: PlaceRef): Promise<{ at: V2 | null; why: PlaceStatusName }> {
    for (let r: PlaceRef | undefined = ref; r; r = r.else) {
      if (!('place' in r)) throw new Error('forces: a district place (district, purpose, rank) waits for Track B’s spawnAt / orderGroup — the interim read holds the named places only');
      if (r.town < 0) {
        if (!r.else) return { at: null, why: 'noTown' };
        continue;
      }
      const named = await this.named(r.town);
      const e = named[r.place];
      if (!e) throw new Error(`forces: no named place ${r.place}`);
      const also = r.also === undefined ? PLACE_STATUS.ok : (named[r.also]?.status ?? PLACE_STATUS.none);
      if (e.status === PLACE_STATUS.ok && also === PLACE_STATUS.ok) return { at: e.at, why: 'ok' };
      if (!r.else) return { at: null, why: STATUS_NAME[e.status !== PLACE_STATUS.ok ? e.status : also] ?? 'none' };
    }
    return { at: null, why: 'none' };
  }

  private named(town: number): Promise<Named[]> {
    let p = this.cache.get(town);
    if (!p) {
      p = this.afterSettle().then(() => this.read(town));
      this.cache.set(town, p);
    }
    return p;
  }

  private afterSettle(): Promise<void> {
    if (this.frame >= this.freshAt) return Promise.resolve();
    return new Promise((go) => this.waiters.push({ at: this.freshAt, go }));
  }

  /** INTERIM (Track B's place-based calls delete it): one town slot's header and named entries, 800 bytes, async */
  private async read(town: number): Promise<Named[]> {
    const s = this.source();
    if (!s) return Array.from({ length: NAMED_PLACES }, () => ({ status: PLACE_STATUS.noTown, at: [0, 0] as V2 }));
    this.reads++;
    const bytes = READ_WORDS * 4;
    const st = s.device.createBuffer({ label: 'forces places read', size: bytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const enc = s.device.createCommandEncoder({ label: 'forces places read' });
    enc.copyBufferToBuffer(s.places, town * TOWN_WORDS * 4, st, 0, bytes);
    s.device.queue.submit([enc.finish()]);
    await st.mapAsync(GPUMapMode.READ);
    const u = new Uint32Array(st.getMappedRange().slice(0));
    st.unmap();
    st.destroy();
    return decodeNamed(u);
  }
}

/** a town slot's first READ_WORDS words → its named places in the window (townplace.wgsl place, placeStatus) */
export function decodeNamed(u: Uint32Array): Named[] {
  const f = new Float32Array(u.buffer, u.byteOffset, u.length);
  const live = u[0] === 1;
  const out: Named[] = [];
  for (let p = 0; p < NAMED_PLACES; p++) {
    const e = NAMED_AT + p * ENTRY;
    out.push({ status: live ? u[e + 3] : PLACE_STATUS.noTown, at: [f[e] + f[4], f[e + 1] + f[5]] });
  }
  return out;
}
