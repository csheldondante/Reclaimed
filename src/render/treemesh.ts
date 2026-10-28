// Tree meshes for the instanced mesh renderer (round 99, `?meshinst=1`; render/meshinst.ts). One mesh a species
// (vegplan.wgsl: 0 broadleaf, 1 conifer, 2 birch, 3 old giant), made here in code: low-poly, faceted (the fragment
// shades each face flat from its derivatives, so the vertices are shared and indexed). A vertex is (x, y, z, part):
//   part 0, the trunk: x, y in cells (its radius baked in), z 0..1 — the instance stretches it to its trunk's height;
//   part 1, the crown: x, y −1..1 (× the instance's crown half-width), z 0..1 (× its crown height, on its base).
// Winding: counter-clockwise seen from outside (back faces culled).

export interface MeshKind {
  name: string;
  /** vertices, 4 floats each: x, y, z, part */
  verts: Float32Array;
  /** triangles (indices into verts) */
  index: Uint32Array;
}

class Builder {
  v: number[] = [];
  i: number[] = [];
  vert(x: number, y: number, z: number, part: number): number {
    this.v.push(x, y, z, part);
    return this.v.length / 4 - 1;
  }
  tri(a: number, b: number, c: number): void {
    this.i.push(a, b, c);
  }
  /** an n-sided prism's sides (no caps), radius r at the bottom, rt at the top, z0..z1 */
  prism(n: number, r: number, rt: number, z0: number, z1: number, part: number, turn = 0): void {
    const lo: number[] = [];
    const hi: number[] = [];
    for (let k = 0; k < n; k++) {
      const a = turn + (k / n) * Math.PI * 2;
      lo.push(this.vert(Math.cos(a) * r, Math.sin(a) * r, z0, part));
      hi.push(this.vert(Math.cos(a) * rt, Math.sin(a) * rt, z1, part));
    }
    for (let k = 0; k < n; k++) {
      const j = (k + 1) % n;
      this.tri(lo[k], lo[j], hi[j]);
      this.tri(lo[k], hi[j], hi[k]);
    }
  }
  /** a cone (n-sided, with its bottom), base radius r at z0, its point at z1, centred at (cx, cy) */
  cone(n: number, r: number, z0: number, z1: number, part: number, cx = 0, cy = 0, turn = 0): void {
    const ring: number[] = [];
    for (let k = 0; k < n; k++) {
      const a = turn + (k / n) * Math.PI * 2;
      ring.push(this.vert(cx + Math.cos(a) * r, cy + Math.sin(a) * r, z0, part));
    }
    const top = this.vert(cx, cy, z1, part);
    const bot = this.vert(cx, cy, z0, part);
    for (let k = 0; k < n; k++) {
      const j = (k + 1) % n;
      this.tri(ring[k], ring[j], top);
      this.tri(ring[j], ring[k], bot);
    }
  }
  /** an icosahedron (20 faces: a lumpy blob, faceted), centre c, radii r (x, y, z), a little jitter */
  blob(c: [number, number, number], r: [number, number, number], part: number, seed: number): void {
    const t = (1 + Math.sqrt(5)) / 2;
    const P = [
      [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0],
      [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
      [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
    ];
    const F = [
      [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
      [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
      [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
      [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
    ];
    let s = seed;
    const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    const L = Math.hypot(1, t);
    const ids = P.map(([x, y, z]) => {
      const j = 0.85 + 0.3 * rnd();
      return this.vert(c[0] + (x / L) * r[0] * j, c[1] + (y / L) * r[1] * j, c[2] + (z / L) * r[2] * j, part);
    });
    for (const [a, b, d] of F) this.tri(ids[a], ids[b], ids[d]);
  }
  done(name: string): MeshKind {
    return { name, verts: new Float32Array(this.v), index: new Uint32Array(this.i) };
  }
}

/** The four species' meshes, in vegplan.wgsl's order. */
export function treeKinds(): MeshKind[] {
  // broadleaf: a half-cell trunk, a crown of three lumps
  const a = new Builder();
  a.prism(6, 0.26, 0.2, 0, 1, 0);
  a.blob([0, 0, 0.55], [0.85, 0.85, 0.5], 1, 11);
  a.blob([0.4, 0.25, 0.4], [0.55, 0.55, 0.36], 1, 23);
  a.blob([-0.35, -0.3, 0.42], [0.55, 0.55, 0.38], 1, 37);
  // conifer: a short trunk, three stacked cones
  const b = new Builder();
  b.prism(6, 0.24, 0.18, 0, 1, 0);
  b.cone(7, 1.0, 0, 0.5, 1);
  b.cone(7, 0.78, 0.3, 0.8, 1, 0, 0, 0.4);
  b.cone(7, 0.5, 0.6, 1.0, 1, 0, 0, 0.9);
  // birch: a slender trunk, a small airy crown of two lumps
  const c = new Builder();
  c.prism(5, 0.14, 0.1, 0, 1, 0);
  c.blob([0.1, 0, 0.6], [0.75, 0.75, 0.42], 1, 51);
  c.blob([-0.2, 0.15, 0.32], [0.5, 0.5, 0.3], 1, 67);
  // the old giant: a thick trunk flaring at its foot, a broad crown of four lumps
  const d = new Builder();
  d.prism(7, 0.62, 0.42, 0, 0.18, 0);
  d.prism(7, 0.42, 0.32, 0.18, 1, 0);
  d.blob([0, 0, 0.6], [0.8, 0.8, 0.42], 1, 71);
  d.blob([0.45, 0.3, 0.4], [0.55, 0.55, 0.36], 1, 83);
  d.blob([-0.45, 0.2, 0.42], [0.55, 0.55, 0.38], 1, 97);
  d.blob([0.05, -0.5, 0.38], [0.55, 0.55, 0.36], 1, 101);
  return [a.done('broadleaf'), b.done('conifer'), c.done('birch'), d.done('giant')];
}
