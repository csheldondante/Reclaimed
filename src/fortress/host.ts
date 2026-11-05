// (round 128l, tooling) What the fortress's start (scenes/level.ts startFortress) needs of the world it's started in,
// as two small contracts: the town that becomes the fortress, and the window it stands in. The atlas level gives its
// Settlements and its Streamer (both meet these structurally); the behaviour lab (src/lab/: ?level=lab) gives a town of
// its own (lab/town.ts) and a window that never slides. Nothing else of either is read.
import type { V2 } from '../api/contracts/units';
import type { Settlement } from '../api/contracts/settlement';
import type { LiveSpot } from '../settle/life';
import type { TownThing } from '../settle/thing';
import type { StructurePieces } from '../api/contracts/structures';

/** the record of the town that becomes the fortress: what startFortress reads and writes (its stores) */
export type FortressTownRec = Pick<Settlement, 'id' | 'name' | 'faction' | 'at' | 'stores'>;

/** where the fortress's town comes from (Settlements; lab/town.ts LabTown) */
export interface FortressTownSource {
  /** the town held as the player's (its own people run by the fortress: ownLife) */
  pin(id: string, ownLife?: boolean): FortressTownRec;
  /** its spots (a 'pile' — the heap the builders take from until a warehouse stands — and its houses' doors), in window coordinates */
  spotsOf(id: string): LiveSpot[] | null;
  /** what of the town stands at a point (window coordinates): Inspect on it */
  thingAt(id: string, at: V2): TownThing | null;
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
}

/** what draws the fortress's pieces (settle/view.ts SettlementsView's `extra`; lab/view.ts) */
export interface FortressPiecesHost {
  extra: (() => { p: StructurePieces; dx: number; dy: number } | null) | null;
}
