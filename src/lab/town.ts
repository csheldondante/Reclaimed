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
  ) {
    this.rec = { id: 'lab', name: 'The Lab', faction: null, at: [heap[0], heap[1]], stores: {} };
  }

  pin(id: string): FortressTownRec {
    if (id !== this.rec.id) throw new Error(`lab town: no settlement ${id}`);
    return this.rec;
  }

  spotsOf(id: string): LiveSpot[] | null {
    if (id !== this.rec.id) return null;
    return [{ kind: 'pile', what: 'stone', at: [...this.heap], w: [...this.heap] }, ...this.homes.map((h): LiveSpot => ({ kind: 'home', at: [...h], w: [...h] }))];
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
