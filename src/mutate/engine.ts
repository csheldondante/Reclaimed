// The mutators over a world (docs/design/MUTATORS.md): the world modifier list (mutate/list.ts) and its GPU ops
// (mutate/gpu.ts) joined to a window of land. `apply` appends to the list and writes what is in the window at once;
// `landWritten` (the streamer's hook) writes arriving land; `townMade` writes a town's lot conditions when its lots are
// made. All three run the same ops from the same entries, so land ends the same whichever way it was written.
import type { Applied, Mutation, MutationRecord, MutationSpec, Mutators, PlaceState, Sign, SignSpec } from './index';
import { MUTATORS } from './index';
import type { MutateGpu, MutLots, Origin } from './gpu';
import { applied, GPU_KIND, GPU_LOOT, GPU_UNGRAVES, GPU_UNLOOT, isLand, landOp, WorldList, type LandMark, type ListWorld } from './list';
import { ROW_H } from '../world/lattice';
import type { FactWorld } from '../living/world';
import type { TileLandWritten } from '../render/tileland';
import { hasEvent, placeState, placeStates, recordMutation, recordSign } from './facts';

/** a live town: where it is in the window now (world units), how far its lots reach, its lots, and what to do once
 *  they changed */
export interface MutTown {
  id: string;
  centre(): readonly [number, number];
  radius: number;
  lots: MutLots;
  /** its lots' conditions were written: draw them again (`released`: some may have lost their claim) */
  changed(released: boolean): void;
}

export interface MutateHost {
  gpu: MutateGpu;
  world: ListWorld;
  /** the window's origin now: world cells (x, row) and its oz. null: no window (nothing is resident) */
  origin(): Origin | null;
  towns(): readonly MutTown[];
  /** the world's size in cells when it wraps (the atlas's cols and rows) */
  wrap?: { cols: number; rows: number };
  /** window box [x0, y0, x1, y1) was written by a mutator: what's derived from its columns follows (the liquid's
   *  records of its chunks, the meshes) */
  landChanged?(x0: number, y0: number, x1: number, y1: number, kind: Mutation['kind']): void;
  /** (round 6, MU-49) the land of a box of world cells (x0, y0, w, h) was changed by an entry, resident or not: what
   *  draws it from its own copy of the land (the far tiles) is made again */
  farChanged?(x0: number, y0: number, w: number, h: number): void;
  /** the list changed: keep it (the save) */
  changed?(record: MutationRecord): void;
  /** the signs changed (one on, off or ended, or a restore): show them (the sky, the ash, the lots, the dead) */
  signsChanged?(signs: readonly Sign[]): void;
  /** the player's home place (its id and where: world units), for what a far event casts on it; null: none.
   *  FIXED-CITY (BACKLOG MU-26): one fixed home settlement a run; a run that follows a moving group needs "where the
   *  run's base is now" here instead */
  home?(): { id: string; at: readonly [number, number] } | null;
  /** the region of a world point (x cells, y world units), for the fact events of changes that name no settlement */
  regionAt?(x: number, y: number): number;
  /** false: some of the window's land is still on its way (a slide or a warp under way) — a flood's level is not
   *  taken from it yet. Left out: the window's land is always whole */
  loaded?(): boolean;
  /** true: each write is timed (a lab, a test) — `lastMs` */
  time?: boolean;
}

/** an eruption nearer the home town than this (world units) is seen itself: no sign is cast */
export const ERUPTION_NEAR = 250;
/** how far an eruption's ash and darkness reach (world units): at this distance they are at their weakest */
export const ERUPTION_REACH = 4000;

export class MutateEngine implements Mutators {
  readonly worldList: WorldList;
  /** the last write's GPU ms, when the host asks for timing (null: no timestamp queries, or nothing written) */
  lastMs: Promise<number | null> = Promise.resolve(null);
  /** per kind, the GPU ms of its last timed write */
  readonly ms: Record<string, number | null> = {};

  /** flood entries whose level is being read back (16 bytes, once): their writes wait for it */
  private levelling = new Set<Mutation>();
  private waited = new Set<Mutation>();
  /** resolves when no flood level is on its way (a test's and the lab's wait) */
  levels: Promise<void> = Promise.resolve();

  /** the fact world written to and read from (mutate/facts.ts); null: none bound — land kinds still write the land,
   *  state kinds are refused (there is nowhere for the state to live) */
  world: FactWorld | null = null;

  constructor(private host: MutateHost) {
    this.worldList = new WorldList(host.world);
  }

  useWorld(w: FactWorld | null): void {
    this.world = w;
    if (w) this.replay();
  }

  /** an entry's change recorded in the bound fact world (its event's id kept on the entry) */
  private fact(m: Mutation): void {
    if (!this.world) return;
    m.fact = recordMutation(this.world, m, { cause: m.cause, regionAt: this.host.regionAt });
  }

  /** every entry (and sign) whose fact event the bound world lacks recorded in it, in list order: a saved list laid
   *  over a world that never heard of it (a new run's world made from the atlas) */
  private replay(): void {
    const w = this.world;
    if (!w) return;
    for (const m of this.worldList.all) if (!m.fact || !hasEvent(w, m.fact, m.kind === 'founded' ? 'founding' : m.kind)) this.fact(m);
    for (const s of this.worldList.signs()) recordSign(w, s.kind, s.place, true, s.cause ?? undefined);
  }

  list() {
    return MUTATORS;
  }

  /** the window's origin as entry `m` sees it: moved by whole worlds so the entry's cell is the copy nearest the window */
  private originFor(m: Mutation, o: Origin): Origin {
    const wr = this.host.wrap;
    if (!wr) return o;
    const { w, h } = this.host.gpu.dims;
    const kx = Math.round((m.cell[0] - (o[0] + w / 2)) / wr.cols);
    const ky = Math.round((m.cell[1] - (o[1] + h / 2)) / wr.rows);
    return [o[0] + kx * wr.cols, o[1] + ky * wr.rows, o[2]];
  }

  /** the part of window box `within` an entry reaches (null: none) */
  private boxOf(m: Mutation, o: Origin, within?: readonly [number, number, number, number]): [number, number, number, number] | null {
    const { w, h } = this.host.gpu.dims;
    const q = within ?? [0, 0, w, h];
    const cx = m.cell[0] - o[0];
    const cy = m.cell[1] - o[1];
    const ry = m.radius / ROW_H;
    const b: [number, number, number, number] = [Math.max(q[0], Math.floor(cx - m.radius - 1)), Math.max(q[1], Math.floor(cy - ry - 1)), Math.min(q[2], Math.ceil(cx + m.radius + 2)), Math.min(q[3], Math.ceil(cy + ry + 2))];
    return b[2] > b[0] && b[3] > b[1] ? b : null;
  }

  /** does entry `m` change town `t`'s lots? (it names the town, or its area reaches the town's lots) */
  private touches(m: Mutation, t: MutTown, o: Origin): boolean {
    if (GPU_KIND[m.kind] === null) return false;
    if (m.place !== null && m.place === t.id) return true;
    if (!isLand(m.kind)) return false;
    const c = t.centre();
    return Math.hypot(m.cell[0] + 0.5 - o[0] - c[0], (m.cell[1] + 0.5 - o[1]) * ROW_H - c[1]) <= m.radius + t.radius;
  }

  /** entries written (in order) into window box `within` and into `towns`' lots; true: something was */
  private write(ms: readonly Mutation[], within: readonly [number, number, number, number] | undefined, towns: readonly MutTown[], land = true): boolean {
    const o0 = this.host.origin();
    if (!o0) return false;
    let any = false;
    let last: Promise<number | null> | null = null;
    const released = new Set<MutTown>();
    const drawn = new Set<MutTown>();
    for (const m of ms) {
      const o = this.originFor(m, o0);
      let box = land && landOp(m) !== null ? this.boxOf(m, o, within) : null;
      let ts = towns.filter((t) => this.touches(m, t, o));
      // (a flood whose level is not taken from the land yet — index.ts Mutation.params: it is written whole, once its
      // whole area is in the window, with its level chosen there on the GPU; until then nothing of it is written, so
      // land arriving a piece at a time ends as land flooded in one go)
      const pickLevel = m.kind === 'flooded' && m.params[1] !== 1;
      if (pickLevel) {
        if (this.levelling.has(m)) {
          this.waited.add(m);
          continue;
        }
        const whole = this.boxOf(m, o);
        const { w, h } = this.host.gpu.dims;
        const ry = m.radius / ROW_H;
        const cx = m.cell[0] - o[0];
        const cy = m.cell[1] - o[1];
        if (!whole || cx - m.radius - 1 < 0 || cy - ry - 1 < 0 || cx + m.radius + 2 > w || cy + ry + 2 > h || this.host.loaded?.() === false) continue;
        box = whole;
        ts = this.host.towns().filter((t) => this.touches(m, t, o));
      }
      if (!box && !ts.length) continue;
      any = true;
      const r = this.host.gpu.write([m], o, box, ts.map((t) => t.lots), !!this.host.time, undefined, pickLevel ? new Set([m]) : undefined);
      if (pickLevel) {
        this.levelling.add(m);
        const oz = o[2];
        const got = this.host.gpu.readLevels(1).then((lv) => {
          m.params = [lv[0] + oz, 1, lv[1] < -1e8 ? -1e9 : lv[1] + oz];
          this.levelling.delete(m);
          // (what waited for the level — land that arrived, a town made meanwhile — written now; the same ops, so
          // what was written already stays as it is)
          if (this.waited.delete(m)) this.write([m], undefined, this.host.towns());
          this.far(m);
          this.host.changed?.(this.worldList.record());
        });
        this.levels = Promise.all([this.levels, got]).then(() => undefined);
      }
      if (r) {
        last = r;
        void r.then((v) => (this.ms[m.kind] = v));
      }
      if (box) this.host.landChanged?.(box[0], box[1], box[2], box[3], m.kind);
      for (const t of ts) {
        drawn.add(t);
        if (m.kind === 'melted') released.add(t);
      }
    }
    if (last) this.lastMs = last;
    for (const t of drawn) t.changed(released.has(t));
    return any;
  }

  apply(spec: MutationSpec): Applied {
    if (!isLand(spec.kind) && !this.world && !spec.fact) throw new Error(`mutators: ${spec.kind} changes a place's state, and no fact world is bound to hold it (mutators.useWorld)`);
    const { m, fresh } = this.worldList.add(spec);
    if (!fresh) return applied(m, false, false);
    // (the facts first: a refused state change — an unknown holder — leaves no entry behind)
    if (!spec.fact) {
      try {
        this.fact(m);
      } catch (e) {
        this.worldList.drop(m);
        throw e;
      }
    }
    const resident = this.write([m], undefined, this.host.towns());
    this.far(m);
    // (a distant eruption: ash fall and darkness on the home town for three seasons, stronger the nearer it is)
    // FIXED-CITY (BACKLOG MU-26): the signs are cast on the home settlement's id, and the distance is taken from where
    // it stands when the eruption happens
    const home = m.kind === 'melted' ? this.host.home?.() : null;
    if (home && m.place !== home.id) {
      const d = Math.hypot(m.cell[0] - home.at[0], m.cell[1] * ROW_H - home.at[1]);
      if (d > Math.max(m.radius, ERUPTION_NEAR)) {
        const strength = Math.min(1, Math.max(0.3, 1 - d / ERUPTION_REACH));
        const until = this.worldList.seasonNow + 3;
        this.worldList.sign({ kind: 'ashfall', place: home.id, strength, until, cause: m.id });
        this.worldList.sign({ kind: 'darkness', place: home.id, strength, until, cause: m.id });
        if (this.world) for (const k of ['ashfall', 'darkness'] as const) recordSign(this.world, k, home.id, true, m.cause);
        this.host.signsChanged?.(this.worldList.signs());
      }
    }
    this.host.changed?.(this.worldList.record());
    return applied(m, resident, true);
  }

  /** (the streamer's onWritten, after the static claims') window rectangle [lx, lx + w) × [ly, ly + h) was just written
   *  with arriving land: every land entry that reaches it written there, in list order. True: some entry did. */
  landWritten(lx: number, ly: number, w: number, h: number): boolean {
    if (!this.worldList.all.length && !this.marksNow.length) return false;
    return this.write([...this.worldList.all, ...this.marksNow], [lx, ly, lx + w, ly + h], []);
  }

  /**
   * (round 6, BACKLOG MU-49; the streamer's onTileLand) A far tile's land was just generated, into its own world: every
   * land entry that reaches it written there, in list order, by the same ops as the window's — so the tile is baked
   * with the change in it and the land looks the same either side of the window's edge. A flood whose level has not
   * been taken from its real ground yet is written at the atlas's level (the window writes it only once levelled; its
   * tiles are made again then). True: some entry did.
   */
  tileWritten(t: TileLandWritten): boolean {
    if (!this.worldList.all.length && !this.marksNow.length) return false;
    const wr = this.host.wrap;
    const jobs: { m: Mutation; o: Origin; box: [number, number, number, number] }[] = [];
    for (const m of [...this.worldList.all, ...this.marksNow]) {
      if (landOp(m) === null) continue;
      // (the tile's origin as the entry sees it: moved by whole worlds to the copy nearest the tile)
      const kx = wr ? Math.round((m.cell[0] - (t.x0 + t.side / 2)) / wr.cols) : 0;
      const ky = wr ? Math.round((m.cell[1] - (t.y0 + t.side / 2)) / wr.rows) : 0;
      const o: Origin = [t.x0 + kx * (wr?.cols ?? 0), t.y0 + ky * (wr?.rows ?? 0), t.oz];
      const cx = m.cell[0] - o[0];
      const cy = m.cell[1] - o[1];
      const ry = m.radius / ROW_H;
      const box: [number, number, number, number] = [Math.max(0, Math.floor(cx - m.radius - 1)), Math.max(0, Math.floor(cy - ry - 1)), Math.min(t.side, Math.ceil(cx + m.radius + 2)), Math.min(t.side, Math.ceil(cy + ry + 2))];
      if (box[2] > box[0] && box[3] > box[1]) jobs.push({ m, o, box });
    }
    this.host.gpu.tileWrite(t, jobs);
    return jobs.length > 0;
  }

  /** the signs' ground marks written now (list.ts LandMark: derived from the signs on, written wherever entries are) */
  marksNow: LandMark[] = [];

  /** The signs changed: a mark whose sign ended is taken off the land again (the inverse op, and its far tiles made
   *  again), a new sign's mark written. Nothing while no sign with a mark is on or was. */
  private syncMarks(): void {
    // FIXED-CITY (BACKLOG MU-26): a sign that names no place marks the home settlement
    const now = this.worldList.marks(this.host.home?.()?.id ?? null);
    const put = (m: LandMark) => {
      this.write([m], undefined, []);
      this.far(m);
    };
    for (const m of this.marksNow) if (!now.some((q) => q.id === m.id)) put({ ...m, op: GPU_UNGRAVES });
    for (const m of now) if (!this.marksNow.some((q) => q.id === m.id)) put(m);
    this.marksNow = now;
  }

  /** an entry's land changed (it was applied, or its flood's level was taken): what draws its area from a copy of the
   *  land — the far tiles — is told (the host's farChanged: a box of world cells) */
  private far(m: Mutation): void {
    if (landOp(m) === null) return;
    const ry = Math.ceil(m.radius / ROW_H) + 2;
    this.host.farChanged?.(m.cell[0] - m.radius - 2, m.cell[1] - ry, 2 * m.radius + 4, 2 * ry);
  }

  /** a town's lots were just made (or made again): every entry about it or over it written into their conditions */
  townMade(t: MutTown): boolean {
    if (!this.worldList.all.length) return false;
    const waiting = this.worldList.all.filter((m) => m.kind === 'flooded' && m.params[1] !== 1);
    if (waiting.length) this.write(waiting, undefined, [t]);
    return this.write(this.worldList.all, undefined, [t], false);
  }

  /** everything resident written again from the list (after a restore; idempotent) */
  rewrite(): void {
    this.write(this.worldList.all, undefined, this.host.towns());
  }

  /**
   * Presentation only. Not built yet (BACKLOG MU-3): `apply` has already written the end state, and no reveal has been
   * found that is cheap and honest (a ramp would need the op run before the write, or an undo). Resolves at once.
   */
  play(_m: Mutation, _opts: { seconds?: number } = {}): Promise<void> {
    return Promise.resolve();
  }

  places(): PlaceState[] {
    return this.world ? placeStates(this.world) : [];
  }

  place(id: string): PlaceState | null {
    return this.world ? placeState(this.world, id) : null;
  }

  record(): MutationRecord {
    return this.worldList.record();
  }

  restore(record: MutationRecord): void {
    // (the far tiles of what the list held and of what it holds now are made again)
    for (const m of this.worldList.all) this.far(m);
    this.worldList.restore(record);
    for (const m of this.worldList.all) this.far(m);
    this.replay();
    this.rewrite();
    this.syncMarks();
    this.host.signsChanged?.(this.worldList.signs());
  }

  sign(spec: SignSpec): Sign | null {
    const s = this.worldList.sign(spec);
    // FIXED-CITY (BACKLOG MU-26): a sign with no place is recorded on the home settlement
    if (this.world) recordSign(this.world, spec.kind, spec.place ?? this.host.home?.()?.id ?? null, s !== null, spec.cause);
    this.syncMarks();
    this.host.signsChanged?.(this.worldList.signs());
    this.host.changed?.(this.worldList.record());
    return s;
  }

  signs(place?: string): Sign[] {
    return this.worldList.signs(place);
  }

  season(n: number): void {
    const before = this.worldList.signs();
    if (!this.worldList.season(n)) return;
    const now = this.worldList.signs();
    if (this.world) for (const s of before) if (!now.some((q) => q.kind === s.kind && q.place === s.place)) recordSign(this.world, s.kind, s.place, false);
    this.syncMarks();
    this.host.signsChanged?.(this.worldList.signs());
    this.host.changed?.(this.worldList.record());
  }

  /** (the 'crime' sign) a share of town `t`'s standing lots looted (`on`), or its looted lots put right */
  loot(t: MutTown, on: boolean, strength: number, seed: number): void {
    const o = this.host.origin();
    if (!o) return;
    this.host.gpu.lotsOnly(on ? GPU_LOOT : GPU_UNLOOT, t.lots, strength, seed);
    t.changed(false);
  }
}
