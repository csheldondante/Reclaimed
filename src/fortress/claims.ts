// The fortress's built blocks in the world's columns (round 128d; the user: "Does the flow field around the city path
// around structures?" — it didn't: the fortress was pieces only, nothing in the columns, and units walked through its
// walls). Each structure's solid (solid.ts: a block's cell, a wall's thin band, a gate's lintel) is claimed as External
// intervals (sim/external.ts), one instance a structure, as the settlements' buildings are (settle/view.ts): the agents'
// surfaces go round them and over them, water runs round them, the terrain's draws skip them.
//
// (round 128j, claims at load) The fortress is a static grid (sim/static-claims.ts): its structures' spans on the GPU in
// the fortress's frame, claimed where free by the kernel that writes arriving land — nothing let go when part of it
// leaves the window, nothing claimed again when it comes back, no waiting for a structure to be whole in the window. What's
// claimed follows the Town (Fortress.onChange): the grid's things set again — a structure whose solid changed lets go of
// its old claim where it lies (to air) and its new one is claimed over the window's written land, on the GPU. Claims are
// quiet: a block standing doesn't wake the ground round it.
import type { ExternalCol, ExternalInstance, ExternalRegistry } from '../sim/external';
import { OWNER_FORT } from '../sim/external';
import type { StaticClaims, StaticGrid } from '../sim/static-claims';
import { MAT } from '../world/materials';
import type { Fortress } from './fortress';
import { solidSpans } from './solid';

export interface ClaimsIO {
  /** the External registry (null: none — the fortress is drawn, nothing claimed) */
  external(): ExternalRegistry | null;
  /** (round 128j) the static grids' claims, written with the land (null: none — drawn, nothing claimed) */
  statics(): StaticClaims | null;
}

export class FortressClaims {
  private claims = new Map<number, { inst: ExternalInstance; key: string }>();
  /** structures whose claim was cut (dug, smashed): let go, not claimed again until they change */
  private lostKeys = new Map<number, string>();
  private owned: ExternalRegistry | null = null;
  private grid: StaticGrid | null = null;
  readonly stats = { structures: 0, columns: 0, lost: 0 };

  constructor(
    private fort: Fortress,
    private io: ClaimsIO,
  ) {
    fort.onChange.push(() => this.update());
  }

  /** what's claimed now: per structure id its instance's columns, in the window's frame (tests, probes) */
  claimed(): Map<number, ExternalCol[]> {
    return new Map([...this.claims].map(([id, c]) => [id, c.inst.cols]));
  }

  /** The claims made to match the Town's built blocks: the static grid's things set (sim/static-claims.ts). */
  update(): void {
    const ext = this.io.external();
    const st = this.io.statics();
    if (!ext || !st) return;
    // (the registry may come after the fortress: its owner told on the first claim)
    if (this.owned !== ext) {
      this.owned = ext;
      ext.owner(OWNER_FORT, { name: 'fortress', onLost: (inst) => this.lost(inst) });
    }
    // (the grid's frame: the fortress's local columns; z the window's — its ground is read in window z)
    this.grid ??= st.grid('fortress', OWNER_FORT, () => {
      const [dx, dy] = this.fort.offset();
      return { dx, dy, dz: 0 };
    });
    const things: { key: number; cols: ExternalCol[]; fallback: number }[] = [];
    const keys = new Map<number, string>();
    for (const [id, spans] of solidSpans(this.solidInputs())) {
      const key = spans.map((c) => `${c.x},${c.y},${c.z0.toFixed(2)},${c.z1.toFixed(2)}`).join(';');
      if (this.lostKeys.get(id) === key) continue;
      this.lostKeys.delete(id);
      keys.set(id, key);
      things.push({ key: id, cols: spans.map((s) => ({ x: s.x, y: s.y, z0: s.z0, z1: s.z1 })), fallback: MAT.Rubble });
    }
    const got = st.set(this.grid, things);
    this.claims = new Map([...got].map(([id, inst]) => [id, { inst, key: keys.get(id)! }]));
    this.count();
  }

  private solidInputs() {
    const f = this.fort;
    return { plan: f.plan, town: f.town, grid: f.grid, ground: (col: number) => f.groundAt(col), ways: f.ways(), shut: f.gatesShut };
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

  private count(): void {
    this.stats.structures = this.claims.size;
    let n = 0;
    for (const c of this.claims.values()) n += c.inst.cols.length;
    this.stats.columns = n;
  }

  dispose(): void {
    const st = this.io.statics();
    if (st && this.grid) st.remove(this.grid);
    this.grid = null;
    this.claims.clear();
  }
}
