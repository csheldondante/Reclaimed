// The fortress's built blocks in the world's columns (round 128d; the user: "Does the flow field around the city path
// around structures?" — it didn't: the fortress was pieces only, nothing in the columns, and units walked through its
// walls). Each structure's solid (solid.ts: a block's cell, a wall's thin band, a gate's lintel) is claimed as External
// intervals (sim/external.ts), one instance a structure, as the settlements' buildings are (settle/view.ts): the agents'
// surfaces go round them and over them, water runs round them, the terrain's draws skip them.
//
// What's claimed follows the Town (Fortress.onChange): a structure whose solid changed (a block built, one erased) lets
// go of its old claim (to air) and claims the new. One wholly in the window or not at all: a slide that would take part
// of it out lets it go first (beforeSlide), and it claims again when it's all back (slid). Claims are quiet (the
// integrity's edit only touches the chunks: sim/sleep.ts) — a block standing doesn't wake the ground round it.
import type { ExternalCol, ExternalInstance, ExternalRegistry } from '../sim/external';
import { OWNER_FORT } from '../sim/external';
import { MAT } from '../world/materials';
import { ROW_H } from '../world/lattice';
import type { Fortress } from './fortress';
import { solidSpans } from './solid';

export interface ClaimsIO {
  /** the External registry (null: none — the fortress is drawn, nothing claimed) */
  external(): ExternalRegistry | null;
  /** `then` once these window columns (x, y) can be read (the registry's claim reads them) */
  columns(cols: [number, number][], then: () => void): Promise<void>;
  dims: { w: number; h: number };
  /** the chunks over a claim (window world bounds): the hybrid draws them as voxels */
  touched?(x0: number, y0: number, x1: number, y1: number): void;
}

export class FortressClaims {
  private claims = new Map<number, { inst: ExternalInstance; key: string }>();
  /** structures whose claim was cut (dug, smashed): let go, not claimed again until they change */
  private lostKeys = new Map<number, string>();
  private version = 0;
  private owned: ExternalRegistry | null = null;
  readonly stats = { structures: 0, columns: 0, lost: 0 };

  constructor(
    private fort: Fortress,
    private io: ClaimsIO,
  ) {
    fort.onChange.push(() => this.update());
  }

  /** what's claimed now: per structure id its instance's columns (tests, probes) */
  claimed(): Map<number, ExternalCol[]> {
    return new Map([...this.claims].map(([id, c]) => [id, c.inst.cols]));
  }

  /** The claims made to match the Town's built blocks. */
  update(): void {
    const ext = this.io.external();
    if (!ext) return;
    // (the registry may come after the fortress: its owner told on the first claim)
    if (this.owned !== ext) {
      this.owned = ext;
      ext.owner(OWNER_FORT, { name: 'fortress', onLost: (inst) => this.lost(inst) });
    }
    const v = ++this.version;
    const [ox, oy] = this.fort.offset();
    const { w, h } = this.io.dims;
    const wants = new Map<number, { cols: ExternalCol[]; key: string }>();
    for (const [id, spans] of solidSpans(this.solidInputs())) {
      const cols = spans.map((s) => ({ x: s.x + ox, y: s.y + oy, z0: s.z0, z1: s.z1 }));
      if (!cols.every((c) => c.x >= 0 && c.y >= 0 && c.x < w && c.y < h)) continue;
      const key = cols.map((c) => `${c.x},${c.y},${c.z0.toFixed(2)},${c.z1.toFixed(2)}`).join(';');
      if (this.lostKeys.get(id) === key) continue;
      this.lostKeys.delete(id);
      wants.set(id, { cols, key });
    }
    // (gone, or changed: let go — to air, the pieces drawn there are the fortress's)
    for (const [id, c] of [...this.claims]) {
      const want = wants.get(id);
      if (want && want.key === c.key) continue;
      ext.release(c.inst.id, true);
      this.claims.delete(id);
    }
    const fresh = [...wants].filter(([id]) => !this.claims.has(id));
    this.count();
    if (!fresh.length) return;
    void this.io.columns(
      fresh.flatMap(([, f]) => f.cols.map((c) => [c.x, c.y] as [number, number])),
      () => {
        // (the plan moved on meanwhile: the latest update claims)
        if (v !== this.version) return;
        for (const [id, f] of fresh) {
          if (this.claims.has(id)) continue;
          const inst = ext.claim(OWNER_FORT, f.cols, MAT.Rubble);
          if (!inst) continue;
          this.claims.set(id, { inst, key: f.key });
          this.touch(inst);
        }
        this.count();
      },
    );
  }

  /** before the window slides by (dx, dy) columns: a structure that would leave it lets go of its columns (to air) */
  beforeSlide(dx: number, dy: number): void {
    const ext = this.io.external();
    const { w, h } = this.io.dims;
    for (const [id, c] of [...this.claims])
      if (c.inst.cols.some((q) => q.x - dx < 0 || q.y - dy < 0 || q.x - dx >= w || q.y - dy >= h)) {
        ext?.release(c.inst.id, true);
        this.claims.delete(id);
      }
    this.count();
  }

  /** after it slid (the registry moved the claims with the land): those whole in the window again claim */
  slid(): void {
    // (the claims kept moved with the land: their keys are the window's columns, made again)
    this.rekey();
    this.update();
  }

  /** the claims' keys in the window's columns now (after a slide they moved) */
  private rekey(): void {
    const [ox, oy] = this.fort.offset();
    const spans = solidSpans(this.solidInputs());
    for (const [id, c] of this.claims) {
      const s = spans.get(id);
      if (!s) continue;
      c.key = s.map((q) => `${q.x + ox},${q.y + oy},${q.z0.toFixed(2)},${q.z1.toFixed(2)}`).join(';');
    }
  }

  private solidInputs() {
    const f = this.fort;
    return { plan: f.plan, town: f.town, grid: f.grid, ground: (col: number) => f.groundAt(col), ways: f.ways() };
  }

  /** a structure's claim was cut (an edit, a meteor) or hangs free: let go to rubble where it stood */
  private lost(inst: ExternalInstance): void {
    for (const [id, c] of this.claims) {
      if (c.inst.id !== inst.id) continue;
      this.claims.delete(id);
      this.lostKeys.set(id, c.key);
      this.io.external()?.release(inst.id);
      this.stats.lost++;
      this.count();
      return;
    }
  }

  private touch(inst: ExternalInstance): void {
    if (!this.io.touched) return;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const c of inst.cols) {
      x0 = Math.min(x0, c.x);
      x1 = Math.max(x1, c.x + 1);
      y0 = Math.min(y0, c.y * ROW_H);
      y1 = Math.max(y1, (c.y + 1) * ROW_H);
    }
    this.io.touched(x0, y0, x1, y1);
  }

  private count(): void {
    this.stats.structures = this.claims.size;
    let n = 0;
    for (const c of this.claims.values()) n += c.inst.cols.length;
    this.stats.columns = n;
  }

  dispose(): void {
    const ext = this.io.external();
    for (const c of this.claims.values()) ext?.release(c.inst.id, true);
    this.claims.clear();
  }
}
