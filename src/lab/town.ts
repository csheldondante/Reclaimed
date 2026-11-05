// (round 128l, tooling) The behaviour lab's town: what the fortress starts from (fortress/host.ts FortressTownSource) on
// a lab's fixed window — a record with its stores, the heap the builders take from until a warehouse stands, and its
// houses' doors. The atlas level's comes from its Settlements (a planned town with buildings); the lab's has no town
// buildings of its own: what stands is the fortress's (the walled recipe builds a small town as fortress blocks).
// The window never slides: window and world coordinates are the same.
import type { V2 } from '../api/contracts/units';
import type { FortressTownRec, FortressTownSource, FortressWindow } from '../fortress/host';
import type { LiveSpot } from '../settle/life';
import type { TownThing } from '../settle/thing';

export class LabTown implements FortressTownSource {
  readonly rec: FortressTownRec;

  constructor(
    readonly heap: V2,
    readonly homes: V2[],
    /** (round 128m, townlab) a captured town's (lab/townfixture.ts): its id, name and place (the fortress's box is laid
     *  round it, as in the game) and its other spots (the wall's gate posts: where the fortress's roads start) */
    from?: { id: string; name: string; at: V2; spots: LiveSpot[] },
  ) {
    this.rec = { id: from?.id ?? 'lab', name: from?.name ?? 'The Lab', faction: null, at: from ? [from.at[0], from.at[1]] : [heap[0], heap[1]], stores: {} };
    this.more = from?.spots.filter((s) => s.kind !== 'pile' && s.kind !== 'home') ?? [];
  }

  private readonly more: LiveSpot[];

  /** a captured town's (its heap, doors and gate posts as the game had them) */
  static of(t: { id: string; name: string; at: V2; spots: LiveSpot[] }): LabTown {
    const piles = t.spots.filter((s) => s.kind === 'pile');
    const p = piles.find((s) => s.what !== 'log') ?? piles[0];
    if (!p) throw new Error(`lab town ${t.id}: no heap (a 'pile' spot)`);
    return new LabTown([p.w[0], p.w[1]], t.spots.filter((s) => s.kind === 'home').map((s) => [s.w[0], s.w[1]]), t);
  }

  pin(id: string): FortressTownRec {
    if (id !== this.rec.id) throw new Error(`lab town: no settlement ${id}`);
    return this.rec;
  }

  spotsOf(id: string): LiveSpot[] | null {
    if (id !== this.rec.id) return null;
    return [{ kind: 'pile', what: 'stone', at: [...this.heap], w: [...this.heap] }, ...this.homes.map((h): LiveSpot => ({ kind: 'home', at: [...h], w: [...h] })), ...this.more];
  }

  thingAt(_id: string, _at: V2): TownThing | null {
    return null;
  }

  toWindow(at: V2): V2 {
    return [at[0], at[1]];
  }
}

/** a window that never slides (the lab's): its land all written from the start */
export function stillWindow(): FortressWindow {
  return { origin: [0, 0], oz: 0, unwritten: [], R: 64, onSlide: [], onBeforeSlide: [], onWarp: [], onRelief: [] };
}
