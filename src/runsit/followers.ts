// ---- runsit/followers.ts ----------------------------------------------------------------------------------------
// (round 120, `runsit`; BACKLOG FO1) The hero's followers over the Units contract (contracts/orders.ts Followers): an
// Order turned into a unit job at this boundary — follow the leader actor, hold a spot, go somewhere, back to what they
// did. Nothing here knows how units walk (the GPU agents' goal fields, or SimpleUnits' steering in Node).
// The user (round 120): "ordering followers would be rad and is a natural way to enter a building mode and make your
// own settlements" — a later Order kind (work, build) is a case here, not a new system.

import type { Followers, Order } from '../api/contracts/orders';
import type { UnitId, UnitJob, Units, UnitView } from '../api/contracts/units';

export class UnitFollowers implements Followers {
  private orders = new Map<UnitId, Order>();
  /** each one's job when they were taken on (released back to it) */
  private before = new Map<UnitId, UnitJob>();

  constructor(
    private units: Units,
    readonly leader: string,
  ) {}

  recruit(ids: UnitId[]): void {
    for (const id of ids) {
      const u = this.units.get(id);
      if (!u?.alive || u.hostile || this.orders.has(id)) continue;
      this.before.set(id, u.job);
      this.orders.set(id, { kind: 'hold', at: [u.at[0], u.at[1]] });
    }
  }

  dismiss(ids: UnitId[]): void {
    this.order({ kind: 'release' }, ids);
    for (const id of ids) {
      this.orders.delete(id);
      this.before.delete(id);
    }
  }

  order(order: Order, who?: UnitId[]): void {
    const ids = (who ?? [...this.orders.keys()]).filter((id) => this.orders.has(id) && this.units.get(id)?.alive);
    for (const id of ids) {
      this.units.order(id, this.jobFor(id, order));
      if (order.kind !== 'release') this.orders.set(id, order);
    }
  }

  /** an Order as the unit's job */
  private jobFor(id: UnitId, o: Order): UnitJob {
    switch (o.kind) {
      case 'follow':
        return { kind: 'follow', target: this.leader, distance: o.distance ?? 3 };
      case 'hold':
        return { kind: 'guard', at: o.at, radius: 2 };
      case 'go':
        return { kind: 'go', to: o.to };
      case 'release':
        return this.before.get(id) ?? { kind: 'idle' };
    }
  }

  members(): { unit: UnitView; order: Order }[] {
    const out: { unit: UnitView; order: Order }[] = [];
    for (const [id, order] of this.orders) {
      const u = this.units.get(id);
      if (u?.alive) out.push({ unit: u, order });
    }
    return out;
  }

  /** the window slid: points held in orders move with it */
  shift(dx: number, dy: number): void {
    for (const [id, o] of this.orders) {
      if (o.kind === 'hold') this.orders.set(id, { kind: 'hold', at: [o.at[0] + dx, o.at[1] + dy] });
      else if (o.kind === 'go') this.orders.set(id, { kind: 'go', to: [o.to[0] + dx, o.to[1] + dy] });
    }
  }
}
