// (trackA-forces; docs/design/SEASON_LOOP.md "Soldiers and waves") TownForces: the one adapter between the season loop
// and the Units contract for a town's soldiers and raiders. Every Units call the season makes is in here.
//
// (trackA-forces2, BACKLOG SF-1) On Track B's GPU place orders (U2 round 5): spawnAt(kind, faction, PlaceRef, n),
// orderGroup(g, { guard | go | attack, at }), members(g), and the events arrived(g) (once an order) and orderFailed(g,
// why). The places are resolved on the GPU from the town contracts' table where the orders run; nothing here reads the
// table, keeps a frame count or watches the units' states. What stays on the CPU: the group's bookkeeping (its id, its
// kind, the units it started with, the dead counted from `died`), and the PlaceRef turned into the Units contract's
// shape (townplaces' `also` is a place number; the Units contract's a ref).
//
// (trackA-forces3, BACKLOG SF-2 / SF-8) On Track B's round 6 orders: drill (a formation round a yard), man (the
// wall-walks), march (out along a gate's route; `leave` tells left(g)), and a formation on go / guard / attack. A spawn
// with no order group free is Track B's own 'pool-full' event (no units made, its orders failing the same): this
// adapter no longer counts the groups itself. Each kind's spawn opts (sight, pace, health) are set here.
import type { FactionId } from '../api/contracts/world';
import type { Formation, OrderFailure, PlaceRef as UnitsPlaceRef, SpawnAtOpts, SquadOrder, UnitId, Units, UnitView } from '../api/contracts/units';
import { chainLength, type GroupId, type PlaceRef } from '../api/contracts/townplaces';

export type ForceKind = 'soldier' | 'raider';
/** a group's order, with townplaces' PlaceRefs (turned into the Units contract's at the call) */
export type ForceOrder =
  | { kind: 'guard' | 'go' | 'attack'; at: PlaceRef; formation?: Formation }
  | { kind: 'drill'; at: PlaceRef; formation: Formation }
  | { kind: 'man'; town: number; side?: number }
  | { kind: 'march'; town: number; gate: number; leave?: boolean };

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
/** each kind's spawn opts: sight in cells (a raider sees a little farther: it hunts), pace class, health. The pace
 *  itself is the kind's on the GPU (soldier 3.2, raider 3.4); `speed` only picks the class */
export const FORCE_OPTS: Record<ForceKind, SpawnAtOpts> = { soldier: { sight: 22, speed: 3.2, health: 3 }, raider: { sight: 24, speed: 3.4, health: 3 } };

interface Group {
  id: GroupId;
  kind: ForceKind;
  /** the Units contract's order group (its spawn may have failed: then it has no members and its orders fail) */
  ug: GroupId;
  dead: number;
  /** what was last asked (the spawn's place, then each order): orderFailed names it */
  at: PlaceRef | ForceOrder;
  arrived: boolean;
  failed: OrderFailure | null;
}

/** a townplaces PlaceRef as the Units contract's: its `also` (a place number of the same town) a ref */
export function unitsRef(r: PlaceRef): UnitsPlaceRef {
  const { else: orElse, ...p } = r;
  const base: UnitsPlaceRef = 'place' in p ? { town: p.town, place: p.place, ...(p.also !== undefined ? { also: { town: p.town, place: p.also } } : {}) } : { town: p.town, district: p.district, kind: p.kind, rank: p.rank };
  return orElse ? { ...base, else: unitsRef(orElse) } : base;
}

/** a ForceOrder as the Units contract's */
function squadOrder(o: ForceOrder): SquadOrder {
  if (o.kind === 'man' || o.kind === 'march') return o;
  return { ...o, at: unitsRef(o.at) } as SquadOrder;
}

type PlaceUnits = Units & Required<Pick<Units, 'spawnAt' | 'orderGroup' | 'members' | 'arrived' | 'orderFailed' | 'left'>>;

export class TownForces {
  /** a group stands at its order's place: once an order */
  readonly arrived: ((g: GroupId) => void)[] = [];
  /** a spawn or an order whose whole place chain isn't valid (why: the last choice's status), or no group slot or
   *  field free for it ('pool-full'); a march's gate not valid (its status), or its route not traced ('failed') */
  readonly orderFailed: ((g: GroupId, why: OrderFailure, at: PlaceRef | ForceOrder) => void)[] = [];
  /** a march that leaves: its last member left the window */
  readonly left: ((g: GroupId) => void)[] = [];
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
    if (!units.spawnAt || !units.orderGroup || !units.members || !units.arrived || !units.orderFailed || !units.left) throw new Error('forces: the units have no place orders (spawnAt / orderGroup / members / arrived / orderFailed / left)');
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
    this.units.left.push((ug) => {
      const g = this.groups.get(this.ofUg.get(ug) ?? -1);
      if (g) for (const f of this.left) f(g.id);
    });
  }

  // ---- the agreed calls ----------------------------------------------------------------------------

  /** n units of a kind at a place, standing there until ordered; orderFailed (none made) if no choice is valid, or
   *  'pool-full' if Track B has no order group free (its later orders fail the same) */
  spawnAt(kind: ForceKind, faction: FactionId, at: PlaceRef, n: number): GroupId {
    chainLength(at);
    const ug = this.units.spawnAt(KIND[kind], faction, unitsRef(at), n, FORCE_OPTS[kind]);
    const g: Group = { id: this.next++, kind, ug, dead: 0, at, arrived: false, failed: null };
    this.groups.set(g.id, g);
    this.ofUg.set(ug, g.id);
    for (const u of this.units.members(ug)) this.ofUnit.set(u, g.id);
    return g.id;
  }

  /** the group's order: guard a place, go there, attack it (hostile to whatever is on the way and there), drill round
   *  it, man the walls, or march out of a gate */
  orderGroup(id: GroupId, order: ForceOrder): void {
    const g = this.groups.get(id);
    if (!g) throw new Error(`forces: no group ${id}`);
    if ('at' in order) chainLength(order.at);
    g.at = order;
    g.arrived = false;
    g.failed = null;
    this.units.orderGroup(g.ug, squadOrder(order));
  }

  // ---- the season's other needs -----------------------------------------------------------------------

  report(id: GroupId): GroupReport | null {
    const g = this.groups.get(id);
    if (!g) return null;
    const alive = this.units.members(g.ug).length;
    return { id, kind: g.kind, size: alive + g.dead, alive, dead: g.dead, arrived: g.arrived, failed: g.failed };
  }

  /** the group's living members taken out of play (raiders leaving, soldiers sent home), and the group forgotten */
  disband(id: GroupId): void {
    const g = this.groups.get(id);
    if (!g) return;
    for (const u of this.units.members(g.ug)) this.units.remove(u);
    this.ofUg.delete(g.ug);
    for (const [u, of] of this.ofUnit) if (of === id) this.ofUnit.delete(u);
    this.groups.delete(id);
  }

  // ---- inside --------------------------------------------------------------------------------------

  private fail(g: Group, why: OrderFailure): void {
    g.failed = why;
    for (const f of this.orderFailed) f(g.id, why, g.at);
  }
}
