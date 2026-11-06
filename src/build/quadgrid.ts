// (round 128m, onetown) A town's cells from any quad mesh: the grid one plan is painted on (build/plan.ts). The user:
// "Generation needs to use the same system as the built town" — the generator's tile systems (structures/tiles:
// irregular, contour-voronoi, radial, orthogonal) make the mesh, and the player paints on the same cells. Townscaper's
// grid (towngrid.ts) is one such mesh.
//
// Cells are the mesh's quads (counter-clockwise), each with its neighbour across each edge (shared vertices; -1 at the
// rim or across a T-junction), laid over the hex lattice of a box w x h columns: each hex column belongs to the cell its
// centre falls in (`cellOf`). Coordinates are the box's (local world units: column (k, r) at cellPos(k, r)).
import { cellAt, cellPos } from '../world/lattice';

/** What the town (town.ts) and the plan build on: quads with four neighbours each, over the hex columns. */
export interface CellGrid {
  readonly w: number;
  readonly h: number;
  readonly count: number;
  /** per cell its neighbour across edge e (corner e to e + 1), -1 none */
  readonly nbr: Int32Array;
  /** per hex column (y * w + x) its cell, -1 none */
  readonly cellOf: Int32Array;
  /** per cell the hex columns in it */
  readonly columns: number[][];
  corner(c: number, k: number): [number, number];
  contains(c: number, x: number, y: number): boolean;
  cellAtWorld(x: number, y: number): number;
  edgeDist(c: number, e: number, x: number, y: number): [number, number];
  centre(c: number): [number, number];
}

/** how far off a side's line another's ends may lie and still lie along it (m): a T-junction's (tJunctions) */
const T_OFF = 0.6;

export class QuadGrid implements CellGrid {
  /** corner positions, x y interleaved */
  readonly verts: Float32Array;
  /** per cell its four corners (vertex ids, counter-clockwise) */
  readonly quads: Int32Array;
  readonly nbr: Int32Array;
  cellOf!: Int32Array;
  /** (round 128p) bumped when the vertices move (what's worked out from them is stale: edgenet.ts EdgeStatics) */
  version = 0;
  columns!: number[][];
  readonly count: number;

  /** `verts`: x, y interleaved (box-local); `quads`: 4 vertex ids a cell, counter-clockwise */
  constructor(readonly w: number, readonly h: number, verts: ArrayLike<number>, quads: ArrayLike<number>) {
    this.verts = Float32Array.from(verts);
    this.quads = Int32Array.from(quads);
    this.count = this.quads.length / 4;
    const nv = this.verts.length / 2;
    this.nbr = new Int32Array(this.count * 4).fill(-1);
    const edge = new Map<number, number>();
    for (let c = 0; c < this.count; c++)
      for (let e = 0; e < 4; e++) {
        const a = this.quads[c * 4 + e];
        const b = this.quads[c * 4 + ((e + 1) & 3)];
        const k = Math.min(a, b) * nv + Math.max(a, b);
        const o = edge.get(k);
        if (o === undefined) edge.set(k, c * 4 + e);
        else {
          this.nbr[c * 4 + e] = o >> 2;
          this.nbr[o] = c;
        }
      }
    this.tJunctions();
    this.recolumn();
  }

  /**
   * (round 128p, DA-A13: shape modifiers) The vertices moved — a road's edge snapped, the radial relax — the cells the
   * same: the columns each holds worked out again.
   */
  moveVerts(next: ArrayLike<number>): void {
    if (next.length !== this.verts.length) throw new Error(`QuadGrid.moveVerts: ${next.length / 2} vertices for ${this.verts.length / 2}`);
    this.verts.set(next);
    this.version++;
    this.recolumn();
  }

  /** the hex columns in each cell (centres inside the quad) */
  private recolumn(): void {
    const { w, h } = this;
    this.cellOf = new Int32Array(w * h).fill(-1);
    this.columns = Array.from({ length: this.count }, () => []);
    const px = (v: number) => this.verts[v * 2];
    const py = (v: number) => this.verts[v * 2 + 1];
    for (let c = 0; c < this.count; c++) {
      let lx = Infinity;
      let ly = Infinity;
      let hx = -Infinity;
      let hy = -Infinity;
      for (let k = 0; k < 4; k++) {
        const v = this.quads[c * 4 + k];
        lx = Math.min(lx, px(v));
        hx = Math.max(hx, px(v));
        ly = Math.min(ly, py(v));
        hy = Math.max(hy, py(v));
      }
      const [, r0] = cellAt(lx, ly);
      const [, r1] = cellAt(hx, hy);
      for (let r = Math.max(0, r0 - 1); r <= Math.min(h - 1, r1 + 1); r++) {
        const [c0] = cellAt(lx, cellPos(0, r)[1]);
        const [c1] = cellAt(hx, cellPos(0, r)[1]);
        for (let k = Math.max(0, c0 - 1); k <= Math.min(w - 1, c1 + 1); k++) {
          const [x, y] = cellPos(k, r);
          if (this.cellOf[r * w + k] < 0 && this.contains(c, x, y)) {
            this.cellOf[r * w + k] = c;
            this.columns[c].push(r * w + k);
          }
        }
      }
    }
  }

  /**
   * (onetown) A side no cell shares whole: across a T-junction — a radial town's ring that doubles, a band of streets
   * cut finer than the plot beside it — the cell whose side lies along it (within T_OFF of its line, facing it,
   * overlapping) the most. One a side:
   * a side two cells lie along has the longer as its neighbour (each of those has it as theirs) — the grid stays one
   * piece for the ways, the reach and the walls' joins.
   */
  private tJunctions(): void {
    const open: number[] = [];
    for (let i = 0; i < this.nbr.length; i++) if (this.nbr[i] < 0) open.push(i);
    if (!open.length) return;
    const B = 4;
    const key = (x: number, y: number) => `${Math.floor(x / B)},${Math.floor(y / B)}`;
    const bins = new Map<string, number[]>();
    for (const i of open) {
      const [ax, ay] = this.corner(i >> 2, i & 3);
      const [bx, by] = this.corner(i >> 2, (i & 3) + 1);
      const ks = new Set([key(ax, ay), key(bx, by), key((ax + bx) / 2, (ay + by) / 2)]);
      for (const k of ks) (bins.get(k) ?? bins.set(k, []).get(k)!).push(i);
    }
    const found = new Int32Array(this.nbr.length).fill(-1);
    for (const i of open) {
      const c = i >> 2;
      const [ax, ay] = this.corner(c, i & 3);
      const [bx, by] = this.corner(c, (i & 3) + 1);
      const L = Math.hypot(bx - ax, by - ay);
      if (L < 1e-6) continue;
      const ux = (bx - ax) / L;
      const uy = (by - ay) / L;
      let best = -1;
      let bo = 0.05;
      const seen = new Set<number>();
      for (const k of [key(ax, ay), key(bx, by), key((ax + bx) / 2, (ay + by) / 2)])
        for (const j of bins.get(k) ?? []) {
          if (seen.has(j) || j >> 2 === c) continue;
          seen.add(j);
          const [cx, cy] = this.corner(j >> 2, j & 3);
          const [dx, dy] = this.corner(j >> 2, (j & 3) + 1);
          // (along this side's line: both its ends within a hand of it — a radial town's plaza is cut on chords of its
          // first ring, whose sides bend at each of the ring's points)
          const off = (x: number, y: number) => Math.abs((x - ax) * uy - (y - ay) * ux);
          if (off(cx, cy) > T_OFF || off(dx, dy) > T_OFF) continue;
          // (facing it: the other side runs the other way round its own cell)
          if ((dx - cx) * ux + (dy - cy) * uy >= 0) continue;
          const t0 = (cx - ax) * ux + (cy - ay) * uy;
          const t1 = (dx - ax) * ux + (dy - ay) * uy;
          const o = Math.min(L, Math.max(t0, t1)) - Math.max(0, Math.min(t0, t1));
          if (o > bo) (bo = o), (best = j >> 2);
        }
      found[i] = best;
    }
    for (const i of open) if (found[i] >= 0) this.nbr[i] = found[i];
  }

  corner(c: number, k: number): [number, number] {
    const v = this.quads[c * 4 + (k & 3)];
    return [this.verts[v * 2], this.verts[v * 2 + 1]];
  }

  /** Whether (x, y) lies in cell c (its quad, counter-clockwise: left of every edge). */
  contains(c: number, x: number, y: number): boolean {
    for (let e = 0; e < 4; e++) {
      const [ax, ay] = this.corner(c, e);
      const [bx, by] = this.corner(c, e + 1);
      if ((bx - ax) * (y - ay) - (by - ay) * (x - ax) < 0) return false;
    }
    return true;
  }

  /** The cell at box-local (x, y) (the hex column's there), -1 none. */
  cellAtWorld(x: number, y: number): number {
    const [cx, cy] = cellAt(x, y);
    if (cx < 0 || cy < 0 || cx >= this.w || cy >= this.h) return -1;
    return this.cellOf[cy * this.w + cx];
  }

  /** Distance from (x, y) to edge e of cell c, and where along it (0..1). */
  edgeDist(c: number, e: number, x: number, y: number): [number, number] {
    const [ax, ay] = this.corner(c, e);
    const [bx, by] = this.corner(c, e + 1);
    const dx = bx - ax;
    const dy = by - ay;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
    return [Math.hypot(x - ax - dx * t, y - ay - dy * t), t];
  }

  /** The cell's centre. */
  centre(c: number): [number, number] {
    let x = 0;
    let y = 0;
    for (let k = 0; k < 4; k++) {
      const [a, b] = this.corner(c, k);
      x += a / 4;
      y += b / 4;
    }
    return [x, y];
  }

  /** Which edge of c leads to cell n (-1: not a neighbour). */
  edgeTo(c: number, n: number): number {
    for (let e = 0; e < 4; e++) if (this.nbr[c * 4 + e] === n) return e;
    return -1;
  }
}
