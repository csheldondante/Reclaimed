// (round 128l, tooling) The behaviour lab's town: what the fortress starts from (fortress/host.ts FortressTownSource) on
// a lab's fixed window — a record with its stores, the heap the builders take from until a warehouse stands, its houses'
// doors, and (round 128m, onetown) its site: the town's one plan, what stands and its grid (build/site.ts). The atlas
// level's comes from its Settlements (a generated town, placed into its plan); a recipe's is a Townscaper grid on a box
// round the heap with nothing on it (the walled recipe builds a small town into the plan); a fixture's (the `town`
// recipe) is the start town's site as the game had it (lab/townfixture.ts).
// The window never slides: a recipe's window is the world (origin 0, oz 0); a fixture's is the captured window's.
import type { V2 } from '../api/contracts/units';
import type { FortressTownRec, FortressTownSource, FortressWindow } from '../fortress/host';
import type { LiveSpot } from '../settle/live';
import { TownSite, type SiteData } from '../build/site';
import { ROW_H } from '../world/lattice';
import { keepHeld } from '../scenes/streamer/keep';

/** a recipe's town's box (columns): the fortress's of rounds 128d-128l, round the heap */
const BOX_W = 240;

export class LabTown implements FortressTownSource {
  readonly rec: FortressTownRec;

  constructor(
    readonly heap: V2,
    readonly homes: V2[],
    readonly site: TownSite,
    /** (round 128m, townlab) a captured town's (lab/townfixture.ts): its id, name and place and its other spots */
    from?: { id: string; name: string; at: V2; spots: LiveSpot[] },
  ) {
    this.rec = { id: from?.id ?? site.id, name: from?.name ?? 'The Lab', faction: null, at: from ? [from.at[0], from.at[1]] : [heap[0], heap[1]], stores: {} };
    this.more = from?.spots.filter((s) => s.kind !== 'pile' && s.kind !== 'home') ?? [];
  }

  private readonly more: LiveSpot[];

  /**
   * A recipe's town: an empty plan on Townscaper's grid over a box round the heap (the lab's world: window and world
   * coordinates the same), its ground the recipe's.
   */
  static plain(heap: V2, homes: V2[], ground: (x: number, y: number) => number): LabTown {
    const w = BOX_W;
    const h = 2 * Math.round(BOX_W / ROW_H / 2);
    const x0 = Math.round(heap[0] - w / 2);
    const y0 = 2 * Math.round((heap[1] / ROW_H - h / 2) / 2);
    return new LabTown(heap, homes, TownSite.plain('lab', { x0, y0, w, h }, ground));
  }

  /** a captured town's (its site, heap, doors and gate posts as the game had them) */
  static of(t: { id: string; name: string; at: V2; spots: LiveSpot[] }, site: SiteData): LabTown {
    const piles = t.spots.filter((s) => s.kind === 'pile');
    const p = piles.find((s) => s.what !== 'log') ?? piles[0];
    if (!p) throw new Error(`lab town ${t.id}: no heap (a 'pile' spot)`);
    return new LabTown([p.w[0], p.w[1]], t.spots.filter((s) => s.kind === 'home').map((s) => [s.w[0], s.w[1]]), TownSite.fromData(site), t);
  }

  pin(id: string): FortressTownRec {
    if (id !== this.rec.id) throw new Error(`lab town: no settlement ${id}`);
    return this.rec;
  }

  spotsOf(id: string): LiveSpot[] | null {
    if (id !== this.rec.id) return null;
    return [{ kind: 'pile', what: 'stone', at: [...this.heap], w: [...this.heap] }, ...this.homes.map((h): LiveSpot => ({ kind: 'home', at: [...h], w: [...h] })), ...this.more];
  }

  siteOf(id: string): TownSite {
    if (id !== this.rec.id) throw new Error(`lab town: no settlement ${id}`);
    return this.site;
  }

  toWindow(at: V2): V2 {
    return [at[0], at[1]];
  }
}

/**
 * a window that never slides (the lab's): its land all written from the start. A recipe's is the world (origin 0, oz 0);
 * a fixture's the captured window's (its origin, and its z less the fixture's base: the site's heights are world z).
 * What it's asked to keep (the town's site box) must already be in it (round 128m townlab C: it never slides).
 */
export function stillWindow(dims: { w: number; h: number }, origin: [number, number] = [0, 0], oz = 0): FortressWindow {
  return {
    origin,
    oz,
    unwritten: [],
    R: 64,
    onSlide: [],
    onBeforeSlide: [],
    onWarp: [],
    onRelief: [],
    keep: (k) => {
      if (k && !keepHeld(origin, dims.w, dims.h, k)) throw new Error(`the lab's window (${dims.w} x ${dims.h} at ${origin}) doesn't hold the rect it's asked to keep (${k.x0},${k.y0} - ${k.x1},${k.y1})`);
    },
  };
}
