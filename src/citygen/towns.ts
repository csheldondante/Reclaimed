// (citygen M4b) The field towns streamed like land (the user: "I assumed we would stream in the grid generation as needed
// so when we pan to a new population center it appears but we can ignore it where there is no population or low enough
// not to necessitate a grid"). Every settlement with a grid (town.ts hasGrid) is a site here; one whose box comes
// within PREFETCH columns of the window is made (FieldTown: the atlas's raw ground over its box, its layout, its mesh and
// its claims, all on the GPU), one at a time; one farther than DROP is let go — its buffers freed, its claim slot back —
// and made again the same on return (a pure function of its seed, the ground and its population field). A small pool:
// the static claims' arena's slots (OWN_SLOTS); when they're all taken, the farthest town not wanted gives its slot up.
// The CPU picks which (the boxes against the window: integers) and passes the inputs; nothing is read back.
import { FieldTown, fieldTownBox, type FieldTownBox, type FieldTownIO, type FieldTownSite } from './town';
import { OPPORTUNITY_PURPOSE, type CityDistricts, type OpportunityKind, type TownDistrict, type DistrictStage } from '../api/contracts/citygen';
import { CLAIM_COUNT, DISTRICT_SPAN } from './gpu';
import { TownLogs } from './townlog';
import { wallGates, wallPosts, type WallGate } from './wallshape';

/** a town's box this near the window (columns) is made; this far, let go */
const PREFETCH = 128;
const DROP = 448;
/** how often the boxes are looked at (s) */
const EVERY = 0.25;

const near = (d: number, n: number) => d - Math.round(d / n) * n;

export class FieldTowns implements CityDistricts {
  readonly live = new Map<string, FieldTown>();
  /** (saving) each town's edit log (citygen/townlog.ts): its inputs, laid over it when it's made again */
  readonly logs = new TownLogs();
  readonly stats = { made: 0, dropped: 0, slotsFull: 0, lastMakeMs: 0 };
  private boxes = new Map<string, FieldTownBox>();
  private clock = 0;
  private making: Promise<unknown> | null = null;
  private dead = false;
  /** (the phone bench's pan back) no town made or let go while set */
  paused = false;

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

  /** (time-lapse) the towns' clock (s) and how fast it runs (the debug panel's slider, ?tlspeed=) */
  townTime = 0;
  speed = 1;

  /** (time-lapse) the live town nearest the window's middle (null: none) */
  nearest(): FieldTown | null {
    let best: FieldTown | null = null;
    let bd = Infinity;
    const [ox, oy] = this.io.origin();
    const { w, h } = this.io.dims;
    for (const t of this.live.values()) {
      if (!t.times) continue;
      const d = Math.hypot(t.box.x0 + t.box.w / 2 - (ox + w / 2), t.box.y0 + t.box.h / 2 - (oy + h / 2));
      if (d < bd) {
        bd = d;
        best = t;
      }
    }
    return best;
  }

  /** (time-lapse) the nearest town's districts not begun start one after another from its centre over `span` s */
  timelapse(span = 30): boolean {
    const t = this.nearest();
    if (!t) return false;
    t.timelapse(this.townTime, span);
    return true;
  }

  /**
   * (M4d hook, api/contracts/citygen.ts CityDistricts) An opportunity of this kind claims the best district not begun of
   * a town — `town`, or the nearest — (GPU argmax by purpose; four words read back) and starts it now. id −1: none left
   * (or no town).
   */
  async claimDistrict(kind: OpportunityKind, town?: string): Promise<TownDistrict> {
    const t = town !== undefined ? (this.live.get(town) ?? null) : this.nearest();
    if (!t) return { town: town ?? '', id: -1, at: [0, 0], left: 0 };
    const c = await t.claimDistrict(OPPORTUNITY_PURPOSE[kind], this.townTime);
    if (c.id >= 0) this.logs.claim(t.site.at, c.id, OPPORTUNITY_PURPOSE[kind]);
    return { town: t.site.id, ...c };
  }

  /** (season life) the town wall: its ring made now; its stage (Skip: at once) */
  wallStart(town: string): boolean {
    const t = this.live.get(town);
    if (!t) return false;
    t.wallStart(this.townTime);
    // (saving: the ring's words read back at the next save point — saveWall — not now: nothing in play reads them)
    this.logs.of(t.site.at).wall = { words: [], to: 0 };
    return true;
  }
  /** (saving, a save point) the wall's words read back into the town's edit log (a few hundred bytes), if it has one */
  async saveWall(town: string): Promise<void> {
    const t = this.live.get(town);
    const log = t ? this.logs.of(t.site.at) : undefined;
    if (!t || !log?.wall) return;
    log.wall.words = await t.gen.readWall();
  }
  wallStage(town: string, from: number, to: number, atOnce = false): boolean {
    const t = this.live.get(town);
    if (!t) return false;
    const now = this.townTime;
    t.wallStage(from, to, atOnce ? now - DISTRICT_SPAN - 1 : now, now);
    const log = this.logs.of(t.site.at);
    if (log.wall) log.wall.to = to;
    return true;
  }

  /**
   * (debug and tests only) The wall's posts in the window (x, y; z window): one on the wall-walk's middle of each piece
   * fully risen. From the ring's words as last saved (saveWall) — empty before the first save point. Orders don't use
   * it: Track B's `man` reads the wall-walk routes on the GPU (routeread.wgsl wallWalkRoute).
   */
  wallPosts(town: string): { seg: number; at: [number, number, number] }[] {
    const t = this.live.get(town);
    const wall = t ? this.logs.of(t.site.at).wall : undefined;
    if (!t || !wall?.words.length) return [];
    return wallPosts(wall.words, wall.to).map((p) => {
      const [x, y] = t.inWindow([p.at[0], p.at[1]]);
      return { seg: p.seg, at: [x, y, p.at[2] - t.oz()] };
    });
  }
  /** (debug and tests only) the wall's gates in the town grid's frame, from the ring's words as last saved; orders use
   *  routeread.wgsl gateRoute(k) on the GPU */
  wallGates(town: string): WallGate[] {
    const t = this.live.get(town);
    const wall = t ? this.logs.of(t.site.at).wall : undefined;
    return t && wall?.words.length ? wallGates(wall.words) : [];
  }

  /** (season loop) a point of a town's frame (a claim's centre) in the window now; null: the town isn't live */
  inWindow(town: string, at: readonly [number, number]): [number, number] | null {
    return this.live.get(town)?.inWindow(at) ?? null;
  }

  /** (season loop) the districts not begun in a town (or the nearest), counted on the GPU (four words back) */
  async districtsLeft(town?: string): Promise<{ town: string; left: number } | null> {
    const t = town !== undefined ? (this.live.get(town) ?? null) : this.nearest();
    if (!t) return null;
    const c = await t.claimDistrict(CLAIM_COUNT, this.townTime);
    return { town: t.site.id, left: c.left };
  }

  /** (season loop) a card's share of a claimed district built as far as its stage, eased over its build from now —
   *  or there at once (`atOnce`: Skip). A town let go meanwhile: false (its stages aren't kept: BACKLOG SL3). */
  stageDistrict(town: string, id: number, stage: DistrictStage, atOnce = false): boolean {
    const t = this.live.get(town);
    if (!t) return false;
    const now = this.townTime;
    t.stageDistrict(id, stage, atOnce ? now - DISTRICT_SPAN - 1 : now, now);
    this.logs.stage(t.site.at, id, stage);
    return true;
  }

  /** each frame: the towns' clock, their time-lapses; the towns near the window made (one at a time), the far ones
   *  let go */
  update(dt: number): void {
    if (Number.isFinite(dt)) this.townTime += dt * this.speed;
    for (const t of this.live.values()) t.frame(this.townTime);
    this.clock -= dt;
    if (this.clock > 0 || this.dead || this.paused) return;
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
        // (saving: its edit log laid over it — the session's, or the world store's after a reload)
        void this.logs.load(s.at).then((log) => {
          if (!log || this.live.get(s.id) !== town) return;
          town.replay(log, this.townTime);
          this.replayed.add(s.id);
          console.log(`[citygen] ${s.name}: its edit log laid over it — ${log.claims.length} districts, ${log.stages.length} stages${log.wall ? ', the wall' : ''}`);
        });
      },
      (e) => {
        this.making = null;
        // (let go before it was made: nothing to show)
        if (!(e instanceof DOMException && e.name === 'AbortError') && !(e instanceof Error && /disposed/.test(e.message))) throw e;
      },
    );
  }

  /** (saving) the towns whose edit log was laid over them since they were made (scripts, the season loop) */
  readonly replayed = new Set<string>();

  private drop(id: string, t: FieldTown): void {
    this.replayed.delete(id);
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
