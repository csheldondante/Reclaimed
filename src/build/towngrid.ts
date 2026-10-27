// The town's irregular grid (round 65; Townscaper's, after Oskar Stålberg):
// a big hexagon of triangles, neighbouring triangles merged at random into
// quads, every polygon cut into quads (centre to edge midpoints), then
// relaxed toward squares. The cells are quads with four neighbours each
// (across their edges, -1 at the border), laid over the hex lattice: each
// hex column belongs to the cell its centre falls in (`cellOf`).
import { cellAt, cellPos } from '../world/lattice';

export interface TownGridOpts {
  seed?: number;
  /** the triangles' edge (world units); the cells come out about half that across */
  spacing?: number;
  /** relaxation passes */
  relax?: number;
}

/**
 * What the town (town.ts) builds on: quads with four neighbours each, over the hex columns. TownGrid is
 * Townscaper's; the settlements' generators (src/settle/grids.ts: radial, contour-Voronoi, orthogonal) make
 * others (round 88).
 */
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

export class TownGrid implements CellGrid {
  /** corner positions, x y interleaved */
  readonly verts: Float32Array;
  /** per cell its four corners (counter-clockwise) */
  readonly quads: Int32Array;
  /** per cell its neighbour across edge e (corner e to e + 1), -1 none */
  readonly nbr: Int32Array;
  /** per hex column (y * w + x) its cell, -1 none */
  readonly cellOf: Int32Array;
  /** per cell the hex columns in it */
  readonly columns: number[][];
  readonly count: number;

  constructor(readonly w: number, readonly h: number, opts: TownGridOpts = {}) {
    const L = opts.spacing ?? 12;
    let s = (opts.seed ?? 1) >>> 0 || 1;
    const rnd = () => {
      s ^= s << 13;
      s ^= s >>> 17;
      s ^= s << 5;
      return (s >>> 0) / 4294967296;
    };
    // the hexagon: big enough to cover the map
    const [mx, my] = cellPos(w / 2, h / 2);
    const R = Math.hypot(mx, my) + L;
    const N = Math.ceil(R / L / (Math.sqrt(3) / 2));
    const vx: number[] = [];
    const vy: number[] = [];
    const vfix: boolean[] = [];
    const id = new Map<string, number>();
    const vert = (q: number, r: number) => {
      const k = `${q},${r}`;
      let i = id.get(k);
      if (i === undefined) {
        i = vx.length;
        id.set(k, i);
        vx.push(mx + L * (q + r / 2));
        vy.push(my + L * r * (Math.sqrt(3) / 2));
        vfix.push(Math.max(Math.abs(q), Math.abs(r), Math.abs(q + r)) === N);
      }
      return i;
    };
    const inHex = (q: number, r: number) => Math.max(Math.abs(q), Math.abs(r), Math.abs(q + r)) <= N;
    // triangles (counter-clockwise; y down the rows, so "up" = +r)
    const tris: number[][] = [];
    for (let q = -N; q <= N; q++)
      for (let r = -N; r <= N; r++) {
        if (inHex(q, r) && inHex(q + 1, r) && inHex(q, r + 1)) tris.push([vert(q, r), vert(q + 1, r), vert(q, r + 1)]);
        if (inHex(q + 1, r) && inHex(q + 1, r + 1) && inHex(q, r + 1)) tris.push([vert(q + 1, r), vert(q + 1, r + 1), vert(q, r + 1)]);
      }
    // merge neighbouring triangles into quads, at random
    const ekey = (a: number, b: number) => (a < b ? `${a},${b}` : `${b},${a}`);
    const byEdge = new Map<string, number[]>();
    tris.forEach((t, i) => {
      for (let e = 0; e < 3; e++) {
        const k = ekey(t[e], t[(e + 1) % 3]);
        if (!byEdge.has(k)) byEdge.set(k, []);
        byEdge.get(k)!.push(i);
      }
    });
    const order = tris.map((_, i) => i);
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    const used = new Uint8Array(tris.length);
    const polys: number[][] = [];
    for (const i of order) {
      if (used[i]) continue;
      const t = tris[i];
      const opts: [number, number][] = [];
      for (let e = 0; e < 3; e++) {
        const o = byEdge.get(ekey(t[e], t[(e + 1) % 3]))!.find((j) => j !== i && !used[j]);
        if (o !== undefined) opts.push([e, o]);
      }
      used[i] = 1;
      // (a third of them stay triangles: they cut into three quads, the
      // merged into four, and the mix is what makes it irregular)
      if (!opts.length || rnd() < 0.33) {
        polys.push(t);
        continue;
      }
      const [e, j] = opts[Math.floor(rnd() * opts.length)];
      used[j] = 1;
      const a = t[e];
      const b = t[(e + 1) % 3];
      const c = t[(e + 2) % 3];
      const d = tris[j].find((v) => v !== a && v !== b)!;
      // a b c and the other's far corner d sits across a-b: a d b c
      polys.push([a, d, b, c]);
    }
    // cut each into quads: corner, edge midpoint, centre, previous midpoint
    const mids = new Map<string, number>();
    const mid = (a: number, b: number) => {
      const k = ekey(a, b);
      let i = mids.get(k);
      if (i === undefined) {
        i = vx.length;
        mids.set(k, i);
        vx.push((vx[a] + vx[b]) / 2);
        vy.push((vy[a] + vy[b]) / 2);
        vfix.push(vfix[a] && vfix[b]);
      }
      return i;
    };
    const quads: number[][] = [];
    for (const p of polys) {
      const c = vx.length;
      vx.push(p.reduce((s, v) => s + vx[v], 0) / p.length);
      vy.push(p.reduce((s, v) => s + vy[v], 0) / p.length);
      vfix.push(false);
      for (let e = 0; e < p.length; e++) {
        const prev = p[(e + p.length - 1) % p.length];
        const next = p[(e + 1) % p.length];
        quads.push([p[e], mid(p[e], next), c, mid(prev, p[e])]);
      }
    }
    // relax toward squares: each quad pulls its corners toward the square
    // that best fits it (its corner offsets turned onto one, averaged)
    const nv = vx.length;
    const px = Float64Array.from(vx);
    const py = Float64Array.from(vy);
    const fx = new Float64Array(nv);
    const fy = new Float64Array(nv);
    for (let it = 0; it < (opts.relax ?? 40); it++) {
      fx.fill(0);
      fy.fill(0);
      for (const q of quads) {
        const cx = (px[q[0]] + px[q[1]] + px[q[2]] + px[q[3]]) / 4;
        const cy = (py[q[0]] + py[q[1]] + py[q[2]] + py[q[3]]) / 4;
        // corner k turned back by k quarter turns (counter-clockwise order)
        let ax = 0;
        let ay = 0;
        for (let k = 0; k < 4; k++) {
          let dx = px[q[k]] - cx;
          let dy = py[q[k]] - cy;
          for (let t = 0; t < k; t++) [dx, dy] = [dy, -dx];
          ax += dx / 4;
          ay += dy / 4;
        }
        let sx = ax;
        let sy = ay;
        for (let k = 0; k < 4; k++) {
          fx[q[k]] += cx + sx - px[q[k]];
          fy[q[k]] += cy + sy - py[q[k]];
          [sx, sy] = [-sy, sx];
        }
      }
      for (let v = 0; v < nv; v++) {
        if (vfix[v]) continue;
        px[v] += fx[v] * 0.25;
        py[v] += fy[v] * 0.25;
      }
    }
    // keep the cells inside the map (a margin of a cell)
    const [x1, y1] = cellPos(w - 1.5, h - 1.5);
    const keep = quads.filter((q) => q.every((v) => px[v] > 1 && py[v] > 1 && px[v] < x1 && py[v] < y1));
    // (their winding: counter-clockwise in world x, y)
    for (const q of keep) {
      let a = 0;
      for (let k = 0; k < 4; k++) a += px[q[k]] * py[q[(k + 1) % 4]] - px[q[(k + 1) % 4]] * py[q[k]];
      if (a < 0) q.reverse();
    }
    this.count = keep.length;
    this.verts = new Float32Array(nv * 2);
    for (let v = 0; v < nv; v++) {
      this.verts[v * 2] = px[v];
      this.verts[v * 2 + 1] = py[v];
    }
    this.quads = Int32Array.from(keep.flat());
    this.nbr = new Int32Array(this.count * 4).fill(-1);
    const owner = new Map<string, [number, number]>();
    keep.forEach((q, c) => {
      for (let e = 0; e < 4; e++) {
        const k = ekey(q[e], q[(e + 1) % 4]);
        const o = owner.get(k);
        if (o) {
          this.nbr[c * 4 + e] = o[0];
          this.nbr[o[0] * 4 + o[1]] = c;
        } else owner.set(k, [c, e]);
      }
    });
    // the hex columns in each cell (centres inside the quad)
    this.cellOf = new Int32Array(w * h).fill(-1);
    this.columns = keep.map(() => []);
    keep.forEach((q, c) => {
      let lx = Infinity;
      let ly = Infinity;
      let hx = -Infinity;
      let hy = -Infinity;
      for (const v of q) {
        lx = Math.min(lx, px[v]);
        hx = Math.max(hx, px[v]);
        ly = Math.min(ly, py[v]);
        hy = Math.max(hy, py[v]);
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
    });
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

  /** The cell at world (x, y) (the hex column's there), -1 none. */
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
