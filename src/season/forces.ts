// (trackA-forces; docs/design/SEASON_LOOP.md "Soldiers and waves") TownForces: the one adapter between the season loop
// and the Units contract for a town's soldiers and raiders. Every Units call the season makes is in here.
//
// (trackA-forces2, BACKLOG SF-1) On Track B's GPU place orders (U2 round 5): spawnAt(kind, faction, PlaceRef, n),
// orderGroup(g, { guard | go | attack, at }), members(g), and the events arrived(g) (once an order) and orderFailed(g,
// why). The places are resolved on the GPU from the town contracts' table where the orders run; nothing here reads the
// table, keeps a frame count or watches the units' states. What stays on the CPU: the group's bookkeeping (its id, its
// kind, the units it started with, the dead counted from `died`), and the PlaceRef turned into the Units contract's
// shape (townplaces' `also` is a place number; the Units contract's a ref).
import type { FactionId } from '../api/contracts/world';
import type { OrderFailure, PlaceRef as UnitsPlaceRef, UnitId, Units, UnitView } from '../api/contracts/units';
import { chainLength, type GroupId, type PlaceRef } from '../api/contracts/townplaces';

export type ForceKind = 'soldier' | 'raider';
export interface ForceOrder {
  kind: 'guard' | 'go' | 'attack';
  at: PlaceRef;
}

/** how a group is doing (the season's report) */
export interface GroupReport {
  id: GroupId;
  kind: ForceKind;
  /** units that stood: living members and the dead (0 when its spawn failed) */
  size: number;
  alive: number;
  dead: number;
  arrived: boolean;
  failed: OrderFailure | null;
}

/** each kind's unit kind on the Units contract (the lab and the figures tell soldiers by 'guard') */
const KIND: Record<ForceKind, string> = { soldier: 'guard', raider: 'raider' };

interface Group {
  id: GroupId;
  kind: ForceKind;
  /** the Units contract's order group (null: none made — no group slot free) */
  ug: GroupId | null;
  dead: number;
  /** the last place asked for (the spawn's, then each order's): orderFailed names it */
  at: PlaceRef;
  arrived: boolean;
  failed: OrderFailure | null;
}

/** a townplaces PlaceRef as the Units contract's: its `also` (a place number of the same town) a ref */
export function unitsRef(r: PlaceRef): UnitsPlaceRef {
  const { else: orElse, ...p } = r;
  const base: UnitsPlaceRef = 'place' in p ? { town: p.town, place: p.place, ...(p.also !== undefined ? { also: { town: p.town, place: p.also } } : {}) } : { town: p.town, district: p.district, kind: p.kind, rank: p.rank };
  return orElse ? { ...base, else: unitsRef(orElse) } : base;
}

type PlaceUnits = Units & Required<Pick<Units, 'spawnAt' | 'orderGroup' | 'members' | 'arrived' | 'orderFailed'>>;

export class TownForces {
  /** a group stands at its order's place: once an order */
  readonly arrived: ((g: GroupId) => void)[] = [];
  /** a spawn or an order whose whole place chain isn't valid (why: the last choice's status), or no group slot or
   *  field free for it ('pool-full') */
  readonly orderFailed: ((g: GroupId, why: OrderFailure, at: PlaceRef) => void)[] = [];
  /** a member died: `by` as the Units contract's died */
  readonly died: ((g: GroupId, u: UnitView, by: UnitId | string | null) => void)[] = [];
  /** a member was hurt */
  readonly hurt: ((g: GroupId, u: UnitView, damage: number, by: UnitId | string | null) => void)[] = [];

  private units: PlaceUnits;
  private groups = new Map<GroupId, Group>();
  /** the Units contract's group → ours */
  private ofUg = new Map<GroupId, GroupId>();
  /** a unit → its group (filled at the spawn: members(g) is known at once) */
  private ofUnit = new Map<UnitId, GroupId>();
  private next = 1;

  constructor(units: Units) {
    if (!units.spawnAt || !units.orderGroup || !units.members || !units.arrived || !units.orderFailed) throw new Error('forces: the units have no place orders (spawnAt / orderGroup / members / arrived / orderFailed)');
    this.units = units as PlaceUnits;
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
    this.units.arrived.push((ug) => {
      const g = this.groups.get(this.ofUg.get(ug) ?? -1);
      if (!g || g.arrived) return;
      g.arrived = true;
      for (const f of this.arrived) f(g.id);
    });
    this.units.orderFailed.push((ug, why) => {
      const g = this.groups.get(this.ofUg.get(ug) ?? -1);
      if (g) this.fail(g, why);
    });
  }

  // ---- the agreed calls ----------------------------------------------------------------------------

  /** n units of a kind at a place, standing there until ordered; orderFailed (none made) if no choice is valid */
  spawnAt(kind: ForceKind, faction: FactionId, at: PlaceRef, n: number): GroupId {
    chainLength(at);
    const g: Group = { id: this.next++, kind, ug: null, dead: 0, at, arrived: false, failed: null };
    this.groups.set(g.id, g);
    if (!this.slotFree()) {
      // (no order group free: told as the Units contract tells a full field pool — after the caller has the id)
      queueMicrotask(() => this.groups.get(g.id) === g && this.fail(g, 'pool-full'));
      return g.id;
    }
    g.ug = this.units.spawnAt(KIND[kind], faction, unitsRef(at), n);
    this.ofUg.set(g.ug, g.id);
    for (const u of this.units.members(g.ug)) this.ofUnit.set(u, g.id);
    return g.id;
  }

  /** the group's order: guard a place, go there, or attack it (hostile to whatever is on the way and there) */
  orderGroup(id: GroupId, order: ForceOrder): void {
    const g = this.groups.get(id);
    if (!g) throw new Error(`forces: no group ${id}`);
    chainLength(order.at);
    if (g.ug === null) return;
    g.at = order.at;
    g.arrived = false;
    g.failed = null;
    this.units.orderGroup(g.ug, { kind: order.kind, at: unitsRef(order.at) });
  }

  // ---- the season's other needs -----------------------------------------------------------------------

  report(id: GroupId): GroupReport | null {
    const g = this.groups.get(id);
    if (!g) return null;
    const alive = g.ug === null ? 0 : this.units.members(g.ug).length;
    return { id, kind: g.kind, size: alive + g.dead, alive, dead: g.dead, arrived: g.arrived, failed: g.failed };
  }

  /** the group's living members taken out of play (raiders leaving, soldiers sent home), and the group forgotten */
  disband(id: GroupId): void {
    const g = this.groups.get(id);
    if (!g) return;
    if (g.ug !== null) {
      for (const u of this.units.members(g.ug)) this.units.remove(u);
      this.ofUg.delete(g.ug);
    }
    for (const [u, of] of this.ofUnit) if (of === id) this.ofUnit.delete(u);
    this.groups.delete(id);
  }

  // ---- inside --------------------------------------------------------------------------------------

  /** Track B's order groups (agents ORDER_GROUPS): the season's groups with members hold one each */
  static readonly GROUP_ROOM = 8;
  private slotFree(): boolean {
    let held = 0;
    for (const g of this.groups.values()) if (g.ug !== null && this.units.members(g.ug).length) held++;
    return held < TownForces.GROUP_ROOM;
  }

  private fail(g: Group, why: OrderFailure): void {
    g.failed = why;
    for (const f of this.orderFailed) f(g.id, why, g.at);
  }
}
