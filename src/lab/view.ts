// (round 128l, tooling) The lab's pieces host: draws the fortress's pieces (fortress/host.ts FortressPiecesHost `extra`)
// with the game's structures draw, as settle/view.ts SettlementsView does for the atlas level's fortress — its own grid,
// the pieces uploaded only when they're new. The lab has no settlements, so nothing else is drawn or claimed here (the
// fortress's own claims are fortress/claims.ts').
import type { StructurePieces } from '../api/contracts/structures';
import type { FortressPiecesHost } from '../fortress/host';
import { StructureGpu } from '../structures/gpu';

const KEY = 'fortress';

export class LabPiecesView implements FortressPiecesHost {
  extra: (() => { p: StructurePieces; dx: number; dy: number } | null) | null = null;
  readonly sg: StructureGpu;
  private p: StructurePieces | null = null;
  private grid = 0;
  private key = '';

  constructor(device: GPUDevice, renderer: { enableStructures(sg: StructureGpu): void }) {
    this.sg = new StructureGpu(device);
    renderer.enableStructures(this.sg);
  }

  /** each frame: the pieces uploaded when they're new, the grid's row when it moved */
  update(oz = 0): void {
    const ex = this.extra?.();
    if (ex && ex.p.count) {
      if (!this.grid) this.grid = this.sg.newGrid();
      if (ex.p !== this.p) {
        this.p = ex.p;
        this.sg.put(KEY, ex.p, this.grid);
      }
      const pos: [number, number, number] = [ex.dx, ex.dy, -oz];
      const key = pos.join(',');
      if (key !== this.key) {
        this.key = key;
        this.sg.setGrid(this.grid, { pos });
      }
    } else if (this.p) {
      this.sg.drop(KEY);
      this.p = null;
    }
  }
}
