// (round 128l, tooling) The lab's town view: draws its town (round 128m, onetown: the town's one plan — build/view.ts
// townPieces, with the fortress's edit state through its hook) with the game's structures draw, and claims what stands
// of it in the columns (build/claims.ts TownClaims: the same rule as every town's in the game) — as settle/view.ts
// SettlementsView does for the atlas level's towns. The lab has one town: always drawn, its pieces uploaded only when
// they changed.
import type { StructurePieces } from '../api/contracts/structures';
import type { TownViewHost } from '../fortress/host';
import type { TownHook } from '../settle/view';
import type { ExternalRegistry } from '../sim/external';
import type { StaticClaims } from '../sim/static-claims';
import { StructureGpu } from '../structures/gpu';
import { townPieces } from '../build/view';
import { TownClaims } from '../build/claims';
import { typeIndex } from '../build/plan';
import type { TownSite } from '../build/site';
import { ROW_H } from '../world/lattice';
import type { FortressWindow } from '../fortress/host';

const KEY = 'town';

export interface LabViewIO {
  device: GPUDevice;
  renderer: { enableStructures(sg: StructureGpu): void };
  external(): ExternalRegistry | null;
  statics(): StaticClaims | null;
}

export class LabTownView implements TownViewHost {
  readonly sg: StructureGpu;
  readonly claims: TownClaims;
  private p: StructurePieces | null = null;
  private grid = 0;
  private key = '';
  private hook: TownHook | null = null;
  /** its claims made once (the registry comes with the level's first frames): changes claim again after */
  private claimed = false;

  constructor(
    io: LabViewIO,
    readonly site: TownSite,
    private win: FortressWindow,
  ) {
    this.sg = new StructureGpu(io.device);
    io.renderer.enableStructures(this.sg);
    this.claims = new TownClaims(site, {
      external: () => io.external(),
      statics: () => io.statics(),
      place: () => {
        const [dx, dy] = this.offset();
        return { dx, dy, dz: -this.win.oz };
      },
      solid: () => this.hook?.solid() ?? {},
      lost: (structure) => this.lost(structure),
    });
  }

  /** the box's origin in the window (columns, rows) */
  private offset(): [number, number] {
    return [this.site.box.x0 - this.win.origin[0], this.site.box.y0 - this.win.origin[1]];
  }

  claimsOf(id: string): TownClaims | null {
    return id === this.site.id ? this.claims : null;
  }

  setHook(id: string, hook: TownHook | null): void {
    if (id !== this.site.id) throw new Error(`lab view: no town ${id}`);
    this.hook = hook;
    this.changed(id);
  }

  changed(id: string): void {
    if (id !== this.site.id) return;
    this.p = null;
    this.claimed = this.claims.update();
  }

  redraw(id: string): void {
    if (id === this.site.id) this.p = null;
  }

  /** a structure's claim was cut: the hook's to say (the fortress breaks it), else it comes down, planned again */
  private lost(structure: number): void {
    if (this.hook?.lost) this.hook.lost(structure);
    else {
      const st = structure > 0 ? this.site.plan.structure(structure) : null;
      if (st) for (const c of st.cells.keys()) for (const L of [...this.site.town.built.each(c)]) (this.site.town.remove(c, L), this.site.town.plan(c, L, true, st.id, typeIndex(st.type)));
    }
    this.p = null;
  }

  /** each frame: the pieces made and uploaded when they changed, the grid's row when it moved */
  update(): void {
    const site = this.site;
    if (!this.claimed) this.claimed = this.claims.update();
    if (!this.p) {
      const hook = this.hook?.view() ?? {};
      this.p = townPieces(site, { ground: (x, y) => site.groundAt(x, y), ghost: (c, l) => !site.town.has(c, l), ...hook });
      if (!this.grid) this.grid = this.sg.newGrid();
      if (this.p.count) this.sg.put(KEY, this.p, this.grid);
      else this.sg.drop(KEY);
    }
    const [dx, dy] = this.offset();
    const pos: [number, number, number] = [dx, dy * ROW_H, -this.win.oz];
    const key = pos.join(',');
    if (key !== this.key && this.grid) {
      this.key = key;
      this.sg.setGrid(this.grid, { pos });
    }
  }
}
