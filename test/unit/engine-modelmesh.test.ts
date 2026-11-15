// A model's mesh is chosen by material (DESIGN §10; src/engine/modelmesh.ts): what is built keeps the cells' own
// corners and flat faces; rock is rounded (surface nets over its voxels) and smooth-shaded. Either way it is closed,
// and every triangle is one cell's.
import { expect, test } from 'vitest';
import type { EngineCell } from '../../src/engine/engine';
import { BM_VERT, buildBodyMesh } from '../../src/render/bodymeshbuild';
import { MAT } from '../../src/world/materials';

// (engine.ts reaches modules that name GPU constants as they load: test/unit/steady.test.ts does the same)
const gl = globalThis as unknown as { GPUBufferUsage?: Record<string, number> };
gl.GPUBufferUsage ??= { STORAGE: 0x80, COPY_SRC: 0x4, COPY_DST: 0x8, MAP_READ: 0x1, UNIFORM: 0x40, INDIRECT: 0x100 };
const { bakeBody, bakeModel, MESH_V } = await import('../../src/engine/engine');
const { modelMesh } = await import('../../src/engine/modelmesh');

const box = (w: number, d: number, h: number, mat: number): EngineCell[] => {
  const out: EngineCell[] = [];
  for (let z = 4; z < 4 + h; z++) for (let y = 6; y < 6 + d; y++) for (let x = 10; x < 10 + w; x++) out.push({ x, y, z, mat });
  return out;
};
const mesh = (cells: EngineCell[], round: number) => {
  const b = bakeBody(cells);
  const m = bakeModel(cells, b.com);
  const v = modelMesh(cells, (mat) => (mat === MAT.Stone ? round : 0))({ com: b.com, lo: m.lo, dims: m.dims });
  return { v, n: v.length / (MESH_V * 4), com: b.com };
};
/** edges not shared by exactly two triangles, vertices welded at 1e-3 */
function openEdges(v: Float32Array, n: number): number {
  const key = (i: number) => `${Math.round(v[i * 12 + 8] * 500)},${Math.round(v[i * 12 + 9] * 500)},${Math.round(v[i * 12 + 10] * 500)}`;
  const edges = new Map<string, number>();
  for (let t = 0; t < n; t += 3)
    for (let k = 0; k < 3; k++) {
      const a = key(t + k);
      const b = key(t + ((k + 1) % 3));
      if (a === b) continue;
      const e = a < b ? `${a}|${b}` : `${b}|${a}`;
      edges.set(e, (edges.get(e) ?? 0) + 1);
    }
  return [...edges.values()].filter((c) => c !== 2).length;
}

test('what is built keeps the body mesh: brick has the cells\' own corners and is flat-shaded', () => {
  const cells = box(5, 3, 3, MAT.Brick);
  const { v, n, com } = mesh(cells, 1);
  const ref = buildBodyMesh(cells);
  expect(n).toBe(ref.length / BM_VERT);
  for (let i = 0; i < n; i++) {
    for (let q = 0; q < 3; q++) expect(v[i * 12 + 8 + q]).toBeCloseTo(ref[i * BM_VERT + q] - com[q], 5);
    expect(v[i * 12 + 7]).toBe(0);
  }
  expect(openEdges(v, n)).toBe(0);
});

test('rock is rounded and smooth-shaded: closed, inside its cells, straight sides flat, edges drawn in, normals outward', () => {
  const cells = box(6, 4, 3, MAT.Stone);
  const { v, n, com } = mesh(cells, 1);
  const ref = buildBodyMesh(cells);
  expect(openEdges(v, n)).toBe(0);
  let moved = 0;
  let lo = Infinity;
  let hi = -Infinity;
  const sideY: number[] = [];
  for (let i = 0; i < n; i++) {
    const p = [v[i * 12 + 8], v[i * 12 + 9], v[i * 12 + 10]];
    const r = [ref[i * BM_VERT] - com[0], ref[i * BM_VERT + 1] - com[1], ref[i * BM_VERT + 2] - com[2]];
    const d = Math.hypot(p[0] - r[0], p[1] - r[1], p[2] - r[2]);
    moved = Math.max(moved, d);
    // (never further than a cell's corner is from its middle)
    expect(d).toBeLessThan(0.6);
    lo = Math.min(lo, p[2]);
    hi = Math.max(hi, p[2]);
    const nr = [v[i * 12 + 4], v[i * 12 + 5], v[i * 12 + 6]];
    expect(Math.hypot(nr[0], nr[1], nr[2])).toBeCloseTo(1, 4);
    expect(v[i * 12 + 7]).toBe(1);
    // (a convex box: every normal looks away from its middle)
    expect(nr[0] * p[0] + nr[1] * p[1] + nr[2] * p[2]).toBeGreaterThan(0);
    // the low-y side at mid height, away from the ends: the hex zigzag (0.29 cells deep on the body mesh) is gone
    if (Math.abs(p[2]) < 0.6 && p[1] < -1 && Math.abs(p[0]) < 1.8 && nr[1] < -0.5) sideY.push(p[1]);
  }
  expect(moved).toBeGreaterThan(0.2);
  // top and bottom stay where the cells' are
  expect(hi).toBeCloseTo(1.5, 5);
  expect(lo).toBeCloseTo(-1.5, 5);
  expect(sideY.length).toBeGreaterThan(8);
  expect(Math.max(...sideY) - Math.min(...sideY)).toBeLessThan(0.05);
});

test('rounding 0 leaves rock on the cells\' corners (the panel\'s number)', () => {
  const cells = box(3, 3, 2, MAT.Stone);
  const { v, n, com } = mesh(cells, 0);
  const ref = buildBodyMesh(cells);
  for (let i = 0; i < n; i++) for (let q = 0; q < 3; q++) expect(v[i * 12 + 8 + q]).toBeCloseTo(ref[i * BM_VERT + q] - com[q], 5);
});
