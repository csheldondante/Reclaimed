// A town's built blocks in the world's columns (round 128m, onetown; was the fortress's — round 128d: "Does the flow
// field around the city path around structures?" — and the settlements' — round 119). One rule for every town: each
// structure's solid as it stands (fortress/solid.ts: a block's cell, a wall's thin band, a gate's lintel, a wall's
// stairs, the ramps) and the layout's decks (a road's bridge, a pier: structures/columns.ts linearColumns), claimed as
// External intervals (sim/external.ts), one instance a structure (a deck: its negative id), owned by the town's grid
// id (TownSite.gridId) — "intervals on the map that indicate another grid owns it" (the user).
//
// (round 128j, claims at load) A town is a static grid (sim/static-claims.ts): its structures' spans on the GPU in its
// box's frame, claimed where free by the kernel that writes arriving land — nothing let go when part of it leaves the
// window, nothing claimed again when it comes back. A change (`update`) sets the grid's things again: a structure whose
// solid changed lets go of its old claim where it lies (to air) and its new one is claimed over the written land.
import type { ColumnSpan } from '../api/contracts/structures';
import type { ExternalCol, ExternalInstance, ExternalRegistry } from '../sim/external';
import type { GridPlace, StaticClaims, StaticGrid } from '../sim/static-claims';
import { MAT } from '../world/materials';
import { solidSpans } from '../fortress/solid';
import type { Ways } from '../fortress/ways';
import { linearColumns } from '../structures/columns';
import type { TownSite } from './site';

export interface TownClaimsIO {
  /** the External registry (null: none — the town is drawn, nothing claimed) */
  external(): ExternalRegistry | null;
  /** the static grids' claims, written with the land (null: none) */
  statics(): StaticClaims | null;
  /** where the town's box lies in the window: its column (0, 0) at (dx, dy); window z = its (world) z + dz */
  place(): GridPlace;
  /** what the player's edit state adds to the solid (the fortress's: its ways' stairs, the gates shut) */
  solid?(): { ways?: Ways; shut?: boolean };
  /** a structure's claim was cut (dug out, smashed, hanging free): it has been let go (its columns); the town decides
   *  what's left of it */
  lost?(structure: number, cols: readonly ExternalCol[]): void;
}

export class TownClaims {
  private claims = new Map<number, { inst: ExternalInstance; key: string }>();
  /** structures whose claim was cut: let go, not claimed again until their solid changes */
  private lostKeys = new Map<number, string>();
  private owned: ExternalRegistry | null = null;
  private grid: StaticGrid | null = null;
  readonly stats = { structures: 0, columns: 0, lost: 0 };

  constructor(
    readonly site: TownSite,
    private io: TownClaimsIO,
  ) {}

  /** the town's solid as it stands, by structure (box columns; world z) */
  spans(): Map<number, ColumnSpan[]> {
    const { plan, town, grid } = this.site;
    const out = solidSpans({ plan, town, grid, ground: (col) => this.site.ground(col), ...(this.io.solid?.() ?? {}) });
    for (const c of linearColumns(plan.layout.linear)) {
      const l = out.get(c.building);
      if (l) l.push(c);
      else out.set(c.building, [c]);
    }
    return out;
  }

  /** what's claimed now: per structure its instance's columns (the window's frame: tests, probes) */
  claimed(): Map<number, ExternalCol[]> {
    return new Map([...this.claims].map(([id, c]) => [id, c.inst.cols]));
  }

  /** The claims made to match what stands: the static grid's things set (sim/static-claims.ts). False: no registry yet. */
  update(): boolean {
    const ext = this.io.external();
    const st = this.io.statics();
    if (!ext || !st) return false;
    // (the registry may come after the town: its owner told on the first claim)
    if (this.owned !== ext) {
      this.owned = ext;
      ext.owner(this.site.gridId, { name: `town ${this.site.id}`, onLost: (inst) => this.lostInst(inst) });
    }
    this.grid ??= st.grid(`town ${this.site.id}`, this.site.gridId, () => this.io.place());
    const things: { key: number; cols: ExternalCol[]; fallback: number }[] = [];
    const keys = new Map<number, string>();
    for (const [id, spans] of this.spans()) {
      const key = spans.map((c) => `${c.x},${c.y},${c.z0.toFixed(2)},${c.z1.toFixed(2)}`).join(';');
      if (this.lostKeys.get(id) === key) continue;
      this.lostKeys.delete(id);
      keys.set(id, key);
      things.push({ key: id, cols: spans.map((s) => ({ x: s.x, y: s.y, z0: s.z0, z1: s.z1 })), fallback: MAT.Rubble });
    }
    const got = st.set(this.grid, things);
    this.claims = new Map([...got].map(([id, inst]) => [id, { inst, key: keys.get(id)! }]));
    this.count();
    return true;
  }

  /** a structure's claim was cut (an edit, a meteor) or hangs free: let go to rubble where it stood, the town told */
  private lostInst(inst: ExternalInstance): void {
    for (const [id, c] of this.claims) {
      if (c.inst.id !== inst.id) continue;
      this.claims.delete(id);
      this.lostKeys.set(id, c.key);
      this.io.external()?.release(inst.id);
      this.stats.lost++;
      this.count();
      this.io.lost?.(id, inst.cols);
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
