import { describe, expect, it } from 'vitest';
import { cellTops, finish, mitre, valences, walls, weldCells, type GridMesh } from './grid';

/** an n × n square grid, unit cells */
function squares(n: number): GridMesh {
  const xy: number[] = [];
  for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) xy.push(i, j);
  const cells: number[] = [];
  const v = (i: number, j: number) => j * (n + 1) + i;
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) cells.push(v(i, j), v(i + 1, j), v(i + 1, j + 1), v(i, j + 1));
  return finish(new Float64Array(xy), new Int32Array(cells));
}

/** a triangle cut into 3 quads (the grid's lone triangle): a valence-3 centre */
function triangle(): GridMesh {
  const A = [0, 0];
  const B = [2, 0];
  const C = [1, Math.sqrt(3)];
  const mid = (p: number[], q: number[]) => [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
  const cen = [(A[0] + B[0] + C[0]) / 3, (A[1] + B[1] + C[1]) / 3];
  const pts = [A, B, C, mid(A, B), mid(B, C), mid(C, A), cen];
  const xy = new Float64Array(pts.flat());
  // corners: A=0 B=1 C=2 mAB=3 mBC=4 mCA=5 cen=6
  return finish(xy, new Int32Array([0, 3, 6, 5, 1, 4, 6, 3, 2, 5, 6, 4]));
}

describe('grid weld', () => {
  it('welds shared corners by their bits and orients cells CCW', () => {
    // two unit squares sharing an edge, the second written clockwise
    const raw = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1, 0, 0, 1, 0, 2, 0, 2, 1, 1, 1, 0, 0]);
    const m = weldCells(raw, 2);
    expect(m.nv).toBe(6);
    expect(m.across.filter((a) => a >= 0).length).toBe(2);
  });
  it('valence of interior vertices', () => {
    expect(valences(squares(3)).get(4)).toBe(4);
    expect(valences(triangle()).get(3)).toBe(1);
  });
});

describe('walls and joints', () => {
  it('a 2 × 1 block on squares: 6 panels a storey, 4 convex and 2 straight joints', () => {
    const m = squares(4);
    const t = cellTops(m, [{ x: 2, y: 1.5, w: 2, d: 1, rot: 0, storeys: 2 }]);
    expect([...t].filter((x) => x).length).toBe(2);
    const w = walls(m, t);
    expect(w.panels.length).toBe(12);
    expect(w.joints).toEqual([8, 4, 0]);
    expect(w.pinches).toBe(0);
    // every panel's next starts where it ends, and the outline closes
    for (const p of w.panels) expect(w.panels[p.next].a).toBe(p.b);
    // a convex corner's mitre: the diagonal, length √2
    const conv = w.panels.find((p) => p.end.kind === 0)!;
    expect(Math.hypot(conv.end.mx, conv.end.my)).toBeCloseTo(Math.SQRT2, 6);
    // outward normals point away from the block
    for (const p of w.panels) {
      const mx = (m.xy[p.a * 2] + m.xy[p.b * 2]) / 2 + p.nx * 0.1;
      const my = (m.xy[p.a * 2 + 1] + m.xy[p.b * 2 + 1]) / 2 + p.ny * 0.1;
      expect(mx < 1 || mx > 3 || my < 1 || my > 2).toBe(true);
    }
  });
  it('an L block has one concave joint a storey', () => {
    const m = squares(4);
    const t = cellTops(m, [
      { x: 2, y: 1.5, w: 2, d: 1, rot: 0, storeys: 1 },
      { x: 1.5, y: 2, w: 1, d: 2, rot: 0, storeys: 1 },
    ]);
    const w = walls(m, t);
    expect(w.joints[2]).toBe(1);
    expect(w.joints[0]).toBe(5);
  });
  it('a checkerboard pair pinches', () => {
    const m = squares(4);
    const t = new Uint8Array(m.nc);
    t[1 * 4 + 1] = 1;
    t[2 * 4 + 2] = 1;
    expect(walls(m, t).pinches).toBe(1);
  });
  it('a valence-3 vertex: one quad of a triangle occupied, its joint at the centre is convex at 120°', () => {
    const m = triangle();
    const t = new Uint8Array([1, 0, 0]);
    const w = walls(m, t);
    const atCen = w.panels.filter((p) => p.b === 6);
    expect(atCen.length).toBe(1);
    expect(atCen[0].end.angle).toBeCloseTo(120, 3);
    expect(atCen[0].end.kind).toBe(0);
  });
  it('mitre: m·n = 1 on both sides, clamped when sharp', () => {
    const a = Math.PI / 5;
    const [mx, my] = mitre(1, 0, Math.cos(a), Math.sin(a));
    expect(mx * 1 + my * 0).toBeCloseTo(1, 9);
    expect(mx * Math.cos(a) + my * Math.sin(a)).toBeCloseTo(1, 9);
    const [sx, sy] = mitre(1, 0, -0.99, 0.141);
    expect(Math.hypot(sx, sy)).toBeLessThanOrEqual(2.5 + 1e-9);
  });
});
