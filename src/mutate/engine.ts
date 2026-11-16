// The mutators over a world (docs/design/MUTATORS.md): the world modifier list (mutate/list.ts) and its GPU ops
// (mutate/gpu.ts) joined to a window of land. `apply` appends to the list and writes what is in the window at once;
// `landWritten` (the streamer's hook) writes arriving land; `townMade` writes a town's lot conditions when its lots are
// made. All three run the same ops from the same entries, so land ends the same whichever way it was written.
import type { Applied, Mutation, MutationRecord, MutationSpec, Mutators, PlaceState, Sign, SignSpec } from './index';
import { MUTATORS } from './index';
import type { MutateGpu, MutLots, Origin } from './gpu';
import { applied, GPU_KIND, GPU_LOOT, GPU_UNLOOT, isLand, WorldList, type ListWorld } from './list';
import { ROW_H } from '../world/lattice';

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
  landChanged?(x0: number, y0: number, x1: number, y1: number): void;
  /** the list changed: keep it (the save) */
  changed?(record: MutationRecord): void;
  /** the signs changed (one on, off or ended, or a restore): show them (the sky, the ash, the lots, the dead) */
  signsChanged?(signs: readonly Sign[]): void;
  /** the player's home place (its id and where: world units), for what a far event casts on it; null: none */
  home?(): { id: string; at: readonly [number, number] } | null;
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

  constructor(private host: MutateHost) {
    this.worldList = new WorldList(host.world);
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
      const box = land && isLand(m.kind) ? this.boxOf(m, o, within) : null;
      const ts = towns.filter((t) => this.touches(m, t, o));
      if (!box && !ts.length) continue;
      any = true;
      const r = this.host.gpu.write([m], o, box, ts.map((t) => t.lots), !!this.host.time);
      if (r) {
        last = r;
        void r.then((v) => (this.ms[m.kind] = v));
      }
      if (box) this.host.landChanged?.(...box);
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
    const { m, fresh } = this.worldList.add(spec);
    if (!fresh) return applied(m, false, false);
    const resident = this.write([m], undefined, this.host.towns());
    // (a distant eruption: ash fall and darkness on the home town for three seasons, stronger the nearer it is)
    const home = m.kind === 'melted' ? this.host.home?.() : null;
    if (home && m.place !== home.id) {
      const d = Math.hypot(m.cell[0] - home.at[0], m.cell[1] * ROW_H - home.at[1]);
      if (d > Math.max(m.radius, ERUPTION_NEAR)) {
        const strength = Math.min(1, Math.max(0.3, 1 - d / ERUPTION_REACH));
        const until = this.worldList.seasonNow + 3;
        this.worldList.sign({ kind: 'ashfall', place: home.id, strength, until, cause: m.id });
        this.worldList.sign({ kind: 'darkness', place: home.id, strength, until, cause: m.id });
        this.host.signsChanged?.(this.worldList.signs());
      }
    }
    this.host.changed?.(this.worldList.record());
    return applied(m, resident, true);
  }

  /** (the streamer's onWritten, after the static claims') window rectangle [lx, lx + w) × [ly, ly + h) was just written
   *  with arriving land: every land entry that reaches it written there, in list order. True: some entry did. */
  landWritten(lx: number, ly: number, w: number, h: number): boolean {
    if (!this.worldList.all.length) return false;
    return this.write(this.worldList.all, [lx, ly, lx + w, ly + h], []);
  }

  /** a town's lots were just made (or made again): every entry about it or over it written into their conditions */
  townMade(t: MutTown): boolean {
    if (!this.worldList.all.length) return false;
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
    return this.worldList.places();
  }

  place(id: string): PlaceState | null {
    return this.worldList.place(id);
  }

  record(): MutationRecord {
    return this.worldList.record();
  }

  restore(record: MutationRecord): void {
    this.worldList.restore(record);
    this.rewrite();
    this.host.signsChanged?.(this.worldList.signs());
  }

  sign(spec: SignSpec): Sign | null {
    const s = this.worldList.sign(spec);
    this.host.signsChanged?.(this.worldList.signs());
    this.host.changed?.(this.worldList.record());
    return s;
  }

  signs(place?: string): Sign[] {
    return this.worldList.signs(place);
  }

  season(n: number): void {
    if (!this.worldList.season(n)) return;
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
