// (citygen M4b) The field towns streamed like land (the user: "I assumed we would stream in the grid generation as needed
// so when we pan to a new population center it appears but we can ignore it where there is no population or low enough
// not to necessitate a grid"). Every settlement with a grid (town.ts hasGrid) is a site here; one whose box comes
// within PREFETCH columns of the window is made (FieldTown: the atlas's raw ground over its box, its layout, its mesh and
// its claims, all on the GPU), one at a time; one farther than DROP is let go — its buffers freed, its claim slot back —
// and made again the same on return (a pure function of its seed, the ground and its population field). A small pool:
// the static claims' arena's slots (OWN_SLOTS); when they're all taken, the farthest town not wanted gives its slot up.
// The CPU picks which (the boxes against the window: integers) and passes the inputs; nothing is read back.
import { FieldTown, fieldTownBox, type FieldTownBox, type FieldTownIO, type FieldTownSite } from './town';

/** a town's box this near the window (columns) is made; this far, let go */
const PREFETCH = 128;
const DROP = 448;
/** how often the boxes are looked at (s) */
const EVERY = 0.25;

const near = (d: number, n: number) => d - Math.round(d / n) * n;

export class FieldTowns {
  readonly live = new Map<string, FieldTown>();
  readonly stats = { made: 0, dropped: 0, slotsFull: 0, lastMakeMs: 0 };
  private boxes = new Map<string, FieldTownBox>();
  private clock = 0;
  private making: Promise<unknown> | null = null;
  private dead = false;

  constructor(
    private io: FieldTownIO & { freeSlots(): number; landIn(): boolean },
    readonly sites: FieldTownSite[],
  ) {
    for (const s of sites) this.boxes.set(s.id, fieldTownBox(s));
  }

  /** how far a town's box is from the window (columns, rows; 0 overlapping) */
  gap(id: string): number {
    const b = this.boxes.get(id)!;
    const [ox, oy] = this.io.origin();
    const { w, h } = this.io.dims;
    const { cols, rows } = this.io.wrap;
    const dx = Math.abs(near(b.x0 + b.w / 2 - (ox + w / 2), cols)) - (b.w + w) / 2;
    const dy = Math.abs(near(b.y0 + b.h / 2 - (oy + h / 2), rows)) - (b.h + h) / 2;
    return Math.max(0, dx, dy);
  }

  /** each frame: the towns near the window made (one at a time), the far ones let go */
  update(dt: number): void {
    this.clock -= dt;
    if (this.clock > 0 || this.dead) return;
    this.clock = EVERY;
    if (this.reachDue && this.io.landIn()) {
      this.reachDue = false;
      for (const t of this.live.values()) void t.checkReach();
    }
    for (const [id, t] of this.live) {
      if (this.gap(id) <= DROP) continue;
      this.drop(id, t);
    }
    if (this.making) return;
    let want: FieldTownSite | null = null;
    let wg = Infinity;
    for (const s of this.sites) {
      if (this.live.has(s.id)) continue;
      const g = this.gap(s.id);
      if (g <= PREFETCH && g < wg) {
        wg = g;
        want = s;
      }
    }
    if (!want) return;
    if (!this.io.freeSlots()) {
      // (the pool full: the farthest town not wanted gives its slot up; none — the nearer ones stay, this one waits)
      let far: [string, FieldTown] | null = null;
      let fg = PREFETCH;
      for (const [id, t] of this.live) {
        const g = this.gap(id);
        if (g > fg) {
          fg = g;
          far = [id, t];
        }
      }
      if (!far) {
        this.stats.slotsFull++;
        return;
      }
      this.drop(far[0], far[1]);
    }
    this.make(want);
  }

  private make(s: FieldTownSite): void {
    const t0 = performance.now();
    const town = new FieldTown(this.io, s);
    this.live.set(s.id, town);
    this.stats.made++;
    this.making = town.made.then(
      (t) => {
        this.stats.lastMakeMs = +(performance.now() - t0).toFixed(1);
        console.log(`[citygen] ${s.name} (${s.id}, ${s.size}) made: ${t.lots} lots, ${s.roads.length} approach roads; GPU ms ${t.total?.toFixed(2) ?? 'n/a'}; ${(town.bytes / 1048576).toFixed(1)} MB; ${this.stats.lastMakeMs} ms to made`);
        this.making = null;
      },
      (e) => {
        this.making = null;
        // (let go before it was made: nothing to show)
        if (!(e instanceof DOMException && e.name === 'AbortError') && !(e instanceof Error && /disposed/.test(e.message))) throw e;
      },
    );
  }

  private drop(id: string, t: FieldTown): void {
    t.dispose();
    this.live.delete(id);
    this.stats.dropped++;
    console.log(`[citygen] ${t.site.name} (${id}) let go`);
  }

  /** the window slid: each town's mesh placed again; its reach looked at again once the land the slide brings is in
   *  (update: a reach over land still coming in joins nothing there) */
  slid(): void {
    for (const t of this.live.values()) t.place();
    this.reachDue = true;
  }
  private reachDue = false;

  /** the window warped: placed again */
  warped(): void {
    for (const t of this.live.values()) t.place();
  }

  dispose(): void {
    this.dead = true;
    for (const t of this.live.values()) t.dispose();
    this.live.clear();
  }
}
