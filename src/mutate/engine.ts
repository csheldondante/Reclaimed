// The mutators over a world (docs/design/MUTATORS.md): the world modifier list (mutate/list.ts) and its GPU ops
// (mutate/gpu.ts) joined to a window of land. `apply` appends to the list and writes what is in the window at once;
// `landWritten` (the streamer's hook) writes arriving land; `townMade` writes a town's lot conditions when its lots are
// made. All three run the same ops from the same entries, so land ends the same whichever way it was written.
import type { Applied, Mutation, MutationRecord, MutationSpec, Mutators, PlaceState } from './index';
import { MUTATORS } from './index';
import type { MutateGpu, MutLots, Origin } from './gpu';
import { applied, GPU_KIND, isLand, WorldList, type ListWorld } from './list';
import { ROW_H } from '../world/lattice';

/** a live town: where it is (world units), how far its lots reach, its lots, and what to do once they changed */
export interface MutTown {
  id: string;
  at: readonly [number, number];
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
  /** window box [x0, y0, x1, y1) was written by a mutator: what's derived from its columns follows (the liquid's
   *  records of its chunks, the meshes) */
  landChanged?(x0: number, y0: number, x1: number, y1: number): void;
  /** the list changed: keep it (the save) */
  changed?(record: MutationRecord): void;
  /** true: each write is timed (a lab, a test) — `lastMs` */
  time?: boolean;
}

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

  /** the part of the window an entry reaches (null: none) */
  private boxOf(m: Mutation, o: Origin): [number, number, number, number] | null {
    const { w, h } = this.host.gpu.dims;
    const cx = m.cell[0] - o[0];
    const cy = m.cell[1] - o[1];
    const ry = m.radius / ROW_H;
    const b: [number, number, number, number] = [Math.max(0, Math.floor(cx - m.radius - 1)), Math.max(0, Math.floor(cy - ry - 1)), Math.min(w, Math.ceil(cx + m.radius + 2)), Math.min(h, Math.ceil(cy + ry + 2))];
    return b[2] > b[0] && b[3] > b[1] ? b : null;
  }

  private townsOf(m: Mutation): MutTown[] {
    if (GPU_KIND[m.kind] === null) return [];
    return this.host.towns().filter((t) => (m.place !== null && m.place === t.id) || (isLand(m.kind) && Math.hypot(m.cell[0] - t.at[0], m.cell[1] * ROW_H - t.at[1]) <= m.radius + t.radius));
  }

  /** one entry written into what's resident of it; true: something was */
  private writeNow(m: Mutation, strength?: number): boolean {
    const o = this.host.origin();
    if (!o) return false;
    const box = isLand(m.kind) ? this.boxOf(m, o) : null;
    const towns = this.townsOf(m);
    if (!box && !towns.length) return false;
    const r = this.host.gpu.write([m], o, box, towns.map((t) => t.lots), !!this.host.time, strength);
    if (r) {
      this.lastMs = r;
      void r.then((v) => (this.ms[m.kind] = v));
    }
    if (box) this.host.landChanged?.(...box);
    for (const t of towns) t.changed(m.kind === 'melted');
    return true;
  }

  apply(spec: MutationSpec): Applied {
    const { m, fresh } = this.worldList.add(spec);
    if (!fresh) return applied(m, false, false);
    const resident = this.writeNow(m);
    this.host.changed?.(this.worldList.record());
    return applied(m, resident, true);
  }

  /** (the streamer's onWritten, after the static claims') window rectangle [lx, lx + w) × [ly, ly + h) was just written
   *  with arriving land: every land entry that reaches it written there, in list order. Returns the entries written. */
  landWritten(lx: number, ly: number, w: number, h: number): number {
    const o = this.host.origin();
    if (!o || !this.worldList.all.length) return 0;
    const ms = this.worldList.over(o[0] + lx, o[1] + ly, o[0] + lx + w, o[1] + ly + h);
    if (!ms.length) return 0;
    this.host.gpu.write(ms, o, [lx, ly, lx + w, ly + h], []);
    this.host.landChanged?.(lx, ly, lx + w, ly + h);
    return ms.length;
  }

  /** a town's lots were just made (or made again): every entry about it or over it written into their conditions */
  townMade(t: MutTown): number {
    const o = this.host.origin();
    if (!o) return 0;
    const ms = this.worldList.near(t.at, t.radius, t.id);
    if (!ms.length) return 0;
    this.host.gpu.write(ms, o, null, [t.lots]);
    t.changed(ms.some((m) => m.kind === 'melted'));
    return ms.length;
  }

  /** everything resident written again from the list (after a restore; idempotent) */
  rewrite(): void {
    const o = this.host.origin();
    if (!o) return;
    const { w, h } = this.host.gpu.dims;
    const land = this.worldList.over(o[0], o[1], o[0] + w, o[1] + h);
    if (land.length) {
      this.host.gpu.write(land, o, [0, 0, w, h], []);
      this.host.landChanged?.(0, 0, w, h);
    }
    for (const t of this.host.towns()) this.townMade(t);
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
  }
}
