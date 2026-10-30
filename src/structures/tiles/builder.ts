// The tile systems' common ground: a planar quad mesh with shared vertices (contracts/structures.ts TileMesh). Every
// tile system ends here — Townscaper's irregular grid, Voronoi plots on isolines, Bulwark's rings, a lattice — so one
// massing, one module set and one nav baker serve them all (the user's why for modularity: "improvements are
// automatically inherited"). Polygons of any side count become quads Townscaper's way: centre to edge midpoints.
import type { TileMesh, TileUse, V2 } from '../../api/contracts/structures';

export class TileBuilder {
  readonly xy: number[] = [];
  readonly quads: number[] = [];
  readonly use: TileUse[] = [];
  readonly block: number[] = [];
  /** vertices pinned by relax (the rim, street edges) */
  readonly pinned = new Set<number>();
  private keyOf = new Map<string, number>();
  private mids = new Map<string, number>();

  /** a vertex at (x, y), shared with any already within 1 mm */
  vert(x: number, y: number): number {
    const k = `${Math.round(x * 1000)},${Math.round(y * 1000)}`;
    let i = this.keyOf.get(k);
    if (i === undefined) {
      i = this.xy.length / 2;
      this.xy.push(x, y);
      this.keyOf.set(k, i);
    }
    return i;
  }

  at(i: number): V2 {
    return [this.xy[i * 2], this.xy[i * 2 + 1]];
  }

  /** the midpoint of edge a–b, shared by both quads on it */
  mid(a: number, b: number): number {
    const k = a < b ? `${a},${b}` : `${b},${a}`;
    let m = this.mids.get(k);
    if (m === undefined) {
      const [ax, ay] = this.at(a);
      const [bx, by] = this.at(b);
      m = this.vert((ax + bx) / 2, (ay + by) / 2);
      this.mids.set(k, m);
    }
    return m;
  }

  /** a quad (counter-clockwise is enforced) */
  quad(a: number, b: number, c: number, d: number, use: TileUse, block = -1): number {
    const p = [a, b, c, d].map((i) => this.at(i));
    let area = 0;
    for (let i = 0; i < 4; i++) area += p[i][0] * p[(i + 1) % 4][1] - p[(i + 1) % 4][0] * p[i][1];
    if (area < 0) [b, d] = [d, b];
    this.quads.push(a, b, c, d);
    this.use.push(use);
    this.block.push(block);
    return this.use.length - 1;
  }

  /** a polygon (vertex ids, either winding) as quads from its centroid to its edges' midpoints */
  poly(ids: number[], use: TileUse, block = -1, split = false): number[] {
    if (ids.length === 4 && !split) return [this.quad(ids[0], ids[1], ids[2], ids[3], use, block)];
    let cx = 0;
    let cy = 0;
    for (const i of ids) {
      cx += this.xy[i * 2];
      cy += this.xy[i * 2 + 1];
    }
    const c = this.vert(cx / ids.length, cy / ids.length);
    const out: number[] = [];
    const n = ids.length;
    for (let i = 0; i < n; i++) {
      const a = ids[i];
      const mPrev = this.mid(ids[(i - 1 + n) % n], a);
      const mNext = this.mid(a, ids[(i + 1) % n]);
      out.push(this.quad(a, mNext, c, mPrev, use, block));
    }
    return out;
  }

  /** every quad cut in four (edge midpoints shared): finer tiles, same shapes */
  subdivide(): void {
    const q = this.quads.splice(0);
    const u = this.use.splice(0);
    const b = this.block.splice(0);
    this.mids.clear();
    for (let i = 0; i < u.length; i++) {
      const [v0, v1, v2, v3] = q.slice(i * 4, i * 4 + 4);
      const m01 = this.mid(v0, v1);
      const m12 = this.mid(v1, v2);
      const m23 = this.mid(v2, v3);
      const m30 = this.mid(v3, v0);
      const p = [v0, v1, v2, v3].map((k) => this.at(k));
      const c = this.vert((p[0][0] + p[1][0] + p[2][0] + p[3][0]) / 4, (p[0][1] + p[1][1] + p[2][1] + p[3][1]) / 4);
      // (a pinned edge's midpoint stays pinned: the rim and the streets keep their lines)
      if (this.pinned.has(v0) && this.pinned.has(v1)) this.pinned.add(m01);
      if (this.pinned.has(v1) && this.pinned.has(v2)) this.pinned.add(m12);
      if (this.pinned.has(v2) && this.pinned.has(v3)) this.pinned.add(m23);
      if (this.pinned.has(v3) && this.pinned.has(v0)) this.pinned.add(m30);
      this.quad(v0, m01, c, m30, u[i], b[i]);
      this.quad(m01, v1, m12, c, u[i], b[i]);
      this.quad(c, m12, v2, m23, u[i], b[i]);
      this.quad(m30, c, m23, v3, u[i], b[i]);
    }
  }

  /** pin the mesh's boundary (edges with one quad) */
  pinBoundary(): void {
    const count = new Map<string, number>();
    const n = this.use.length;
    for (let i = 0; i < n; i++)
      for (let s = 0; s < 4; s++) {
        const a = this.quads[i * 4 + s];
        const b = this.quads[i * 4 + ((s + 1) % 4)];
        const k = a < b ? `${a},${b}` : `${b},${a}`;
        count.set(k, (count.get(k) ?? 0) + 1);
      }
    for (const [k, c] of count)
      if (c === 1)
        for (const v of k.split(',')) this.pinned.add(Number(v));
  }

  /**
   * Townscaper's relax: each quad pulls its corners toward the square that best fits it (its corners turned onto one
   * another and averaged); free vertices move by the sum. Tiles end up near-square, irregular but even.
   */
  relax(iterations: number, rate = 0.25): void {
    const nv = this.xy.length / 2;
    const n = this.use.length;
    for (let it = 0; it < iterations; it++) {
      const f = new Float64Array(nv * 2);
      for (let i = 0; i < n; i++) {
        const ids = this.quads.slice(i * 4, i * 4 + 4);
        const p = ids.map((k) => this.at(k));
        const cx = (p[0][0] + p[1][0] + p[2][0] + p[3][0]) / 4;
        const cy = (p[0][1] + p[1][1] + p[2][1] + p[3][1]) / 4;
        // turn each corner's offset back by its quarter turn and average: the square's first corner
        let sx = 0;
        let sy = 0;
        for (let k = 0; k < 4; k++) {
          let dx = p[k][0] - cx;
          let dy = p[k][1] - cy;
          for (let r = 0; r < k; r++) [dx, dy] = [dy, -dx];
          sx += dx;
          sy += dy;
        }
        sx /= 4;
        sy /= 4;
        for (let k = 0; k < 4; k++) {
          let dx = sx;
          let dy = sy;
          for (let r = 0; r < k; r++) [dx, dy] = [-dy, dx];
          f[ids[k] * 2] += cx + dx - p[k][0];
          f[ids[k] * 2 + 1] += cy + dy - p[k][1];
        }
      }
      for (let v = 0; v < nv; v++) {
        if (this.pinned.has(v)) continue;
        this.xy[v * 2] += f[v * 2] * rate;
        this.xy[v * 2 + 1] += f[v * 2 + 1] * rate;
      }
    }
  }

  build(minArea = 0.05): TileMesh {
    // (slivers — clipping and insets leave a few — are dropped: a hole of a few square centimetres, not a tile)
    for (let i = this.use.length - 1; i >= 0; i--) {
      const p = this.quads.slice(i * 4, i * 4 + 4).map((k) => this.at(k));
      let a = 0;
      for (let k = 0; k < 4; k++) a += p[k][0] * p[(k + 1) % 4][1] - p[(k + 1) % 4][0] * p[k][1];
      if (a / 2 >= minArea) continue;
      this.quads.splice(i * 4, 4);
      this.use.splice(i, 1);
      this.block.splice(i, 1);
    }
    // (drop vertices nothing uses: polygon cuts and subdivision leave some)
    const used = new Int32Array(this.xy.length / 2).fill(-1);
    let nv = 0;
    for (const v of this.quads) if (used[v] < 0) used[v] = nv++;
    const verts = new Float64Array(nv * 2);
    for (let v = 0; v < used.length; v++)
      if (used[v] >= 0) {
        verts[used[v] * 2] = this.xy[v * 2];
        verts[used[v] * 2 + 1] = this.xy[v * 2 + 1];
      }
    return {
      verts,
      quads: Uint32Array.from(this.quads, (v) => used[v]),
      use: this.use.slice(),
      block: Int32Array.from(this.block),
    };
  }
}

/** Per quad, its neighbour across each side (side s: corners s → s+1), -1 at the rim. */
export function adjacency(t: TileMesh): Int32Array {
  const n = t.use.length;
  const out = new Int32Array(n * 4).fill(-1);
  const edge = new Map<number, number>();
  const nv = t.verts.length / 2;
  for (let q = 0; q < n; q++)
    for (let s = 0; s < 4; s++) {
      const a = t.quads[q * 4 + s];
      const b = t.quads[q * 4 + ((s + 1) % 4)];
      const k = Math.min(a, b) * nv + Math.max(a, b);
      const o = edge.get(k);
      if (o === undefined) edge.set(k, q * 4 + s);
      else {
        out[q * 4 + s] = o >> 2;
        out[o] = q;
      }
    }
  return out;
}

export function quadCorners(t: TileMesh, q: number): [V2, V2, V2, V2] {
  const c = (k: number): V2 => {
    const v = t.quads[q * 4 + k];
    return [t.verts[v * 2], t.verts[v * 2 + 1]];
  };
  return [c(0), c(1), c(2), c(3)];
}

export function quadCentre(t: TileMesh, q: number): V2 {
  const p = quadCorners(t, q);
  return [(p[0][0] + p[1][0] + p[2][0] + p[3][0]) / 4, (p[0][1] + p[1][1] + p[2][1] + p[3][1]) / 4];
}

export function quadArea(t: TileMesh, q: number): number {
  const p = quadCorners(t, q);
  let a = 0;
  for (let i = 0; i < 4; i++) a += p[i][0] * p[(i + 1) % 4][1] - p[(i + 1) % 4][0] * p[i][1];
  return a / 2;
}
