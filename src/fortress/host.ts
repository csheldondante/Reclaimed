// (round 128l, tooling) What the fortress's start (scenes/level.ts startFortress) needs of the world it's started in,
// as small contracts: the town that becomes the fortress, the window it stands in, and where the town is drawn and
// claimed. The atlas level gives its Settlements, its Streamer and its SettlementsView (all meet these structurally);
// the behaviour lab (src/lab/: ?level=lab) gives a town of its own (lab/town.ts), a window that never slides and its own
// town view (lab/view.ts). Nothing else of them is read.
// (round 128m, onetown) The fortress is the player editing the town's one plan: the source gives the town's site
// (build/site.ts), and the view host draws and claims it with the fortress's edit state (its hook) — there is no second
// grid, plan or slab for the fortress.
import type { V2 } from '../api/contracts/units';
import type { Settlement } from '../api/contracts/settlement';
import type { LiveSpot } from '../settle/live';
import type { TownSite } from '../build/site';
import type { TownHook } from '../settle/view';
import type { KeepRect } from '../scenes/streamer/keep';

/** the record of the town that becomes the fortress: what startFortress reads and writes (its stores) */
export type FortressTownRec = Pick<Settlement, 'id' | 'name' | 'faction' | 'at' | 'stores'>;

/** where the fortress's town comes from (Settlements; lab/town.ts LabTown) */
export interface FortressTownSource {
  /** the town held as the player's (its own people run by the fortress: ownLife) */
  pin(id: string, ownLife?: boolean): FortressTownRec;
  /** its spots (a 'pile' — the heap the builders take from until a warehouse stands — and its houses' doors), in window coordinates */
  spotsOf(id: string): LiveSpot[] | null;
  /** (onetown) its site: its one plan, what stands of it, its grid and box (the fortress edits it) */
  siteOf(id: string): TownSite;
  /** world → window */
  toWindow(at: V2): V2;
}

/** the window the fortress stands in (scenes/streamer.ts Streamer; the lab's still window) */
export interface FortressWindow {
  origin: [number, number];
  oz: number;
  /** regions of the window whose land hasn't been written yet ([x, y] corners, R a side) */
  unwritten: [number, number][];
  R: number;
  onSlide: ((dx: number, dy: number, dz: number) => void)[];
  onBeforeSlide: ((dx: number, dy: number, dz: number) => void)[];
  onWarp: ((ox: number, oy: number, oz: number) => void)[];
  onRelief: ((x0: number, y0: number, x1: number, y1: number) => void)[];
  /** (round 128m, townlab) keep these world columns in the window from now on: no slide leaves them out (the Streamer:
   *  scenes/streamer/keep.ts; the lab's still window never slides). Throws when the window doesn't hold them now. */
  keep(k: KeepRect | null): void;
}

/** (onetown) where the fortress's town is drawn and claimed (settle/view.ts SettlementsView; lab/view.ts LabTownView) */
export interface TownViewHost {
  /** the fortress's edit state drawn and claimed with the town from now (null: none) */
  setHook(id: string, hook: TownHook | null): void;
  /** the town's plan or what stands changed: drawn and claimed again */
  changed(id: string): void;
  /** only drawn again (a ghost's look, Inspect's pick) */
  redraw(id: string): void;
}
