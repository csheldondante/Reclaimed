// Round 120 (the user: "it switches for rendering as voxels. Rendering and simulation should not be coupled that way"):
// a body's own mesh (render/bodymeshbuild.ts) — its cells' surface as hex prisms, thin members kept, each vertex bound
// to its cell's node first.
import { expect, test } from 'vitest';
import { BM_VERT, buildBodyMesh } from '../../src/render/bodymeshbuild';
import { buildBody } from '../../src/solver/build';
import { MAT } from '../../src/world/materials';

const tris = (v: Float32Array) => v.length / BM_VERT / 3;
const vert = (v: Float32Array, i: number) => Array.from(v.subarray(i * BM_VERT, i * BM_VERT + 3));
const nrm = (v: Float32Array, i: number) => Array.from(v.subarray(i * BM_VERT + 4, i * BM_VERT + 7));

test('one cell: a hex prism — a top and a bottom of 4 triangles, six sides of 2', () => {
  const v = buildBodyMesh([{ x: 5, y: 4, z: 3, mat: MAT.Steel }]);
  expect(tris(v)).toBe(4 + 4 + 12);
});

test("faces between the body's own cells aren't drawn: two stacked cells are one prism two tall", () => {
  const v = buildBodyMesh([
    { x: 5, y: 4, z: 3, mat: MAT.Steel },
    { x: 5, y: 4, z: 4, mat: MAT.Steel },
  ]);
  expect(tris(v)).toBe(4 + 4 + 24);
});

test('every triangle faces its normal (wound outward)', () => {
  const cells = [];
  for (let x = 0; x < 3; x++) for (let z = 0; z < 2; z++) cells.push({ x: 10 + x, y: 7, z, mat: MAT.Steel });
  const v = buildBodyMesh(cells);
  for (let t = 0; t < tris(v); t++) {
    const [a, b, c] = [vert(v, t * 3), vert(v, t * 3 + 1), vert(v, t * 3 + 2)];
    const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const cr = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const n = nrm(v, t * 3);
    expect(cr[0] * n[0] + cr[1] * n[1] + cr[2] * n[2]).toBeGreaterThan(0);
  }
});

test("a member one cell thick keeps its shape (the field mesh drops it: RB12)", () => {
  const cells = [];
  for (let z = 0; z < 12; z++) cells.push({ x: 4, y: 4, z, mat: MAT.Steel });
  const v = buildBodyMesh(cells);
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < v.length / BM_VERT; i++) {
    lo = Math.min(lo, vert(v, i)[2]);
    hi = Math.max(hi, vert(v, i)[2]);
  }
  expect(lo).toBe(0);
  expect(hi).toBe(12);
});

test("each vertex is bound to its cell's node first, its weights summing to one", () => {
  const cells = [];
  for (let x = 0; x < 12; x++) for (let z = 0; z < 2; z++) cells.push({ x: 2 + x, y: 6, z: 10 + z, mat: MAT.Steel });
  const built = buildBody(cells, undefined, 2)!;
  const v = buildBodyMesh(cells, { nodeRest: built.nodes.map((n) => n.rest), cellNode: built.cellNode, g: built.g });
  const u = new Uint32Array(v.buffer);
  const n = v.length / BM_VERT;
  for (let i = 0; i < n; i++) {
    const w = v.subarray(i * BM_VERT + 8, i * BM_VERT + 12);
    expect(w[0] + w[1] + w[2] + w[3]).toBeCloseTo(1, 5);
    expect(w[0]).toBeGreaterThan(0);
    expect(u[i * BM_VERT + 12]).toBeLessThan(built.nodes.length);
  }
  // (the first triangle's: the first cell's node)
  expect(u[12]).toBe(built.cellNode[0]);
});

test("on the voxel lattice: each vertex bound to the particles under it, nearest first, weights summing to one", async () => {
  const { bindSkinTo } = await import('../../src/physics/mesh');
  const { cellPos } = await import('../../src/world/lattice');
  const cells = [];
  for (let x = 0; x < 4; x++) cells.push({ x: 3 + x, y: 2, z: 5, mat: MAT.Steel });
  const v = buildBodyMesh(cells);
  const { data, tris } = bindSkinTo(
    v,
    BM_VERT,
    cells.map((c, i) => {
      const [px, py] = cellPos(c.x, c.y);
      return { i, c: [px, py, c.z + 0.5] as [number, number, number] };
    }),
  );
  expect(tris).toBe(v.length / BM_VERT / 3);
  const U = new Uint32Array(data.buffer);
  for (let k = 0; k < tris * 3; k++) {
    expect(U[k * 28]).toBeLessThan(cells.length);
    const w = data.subarray(k * 28 + 4, k * 28 + 8);
    expect(w[0] + w[1] + w[2] + w[3]).toBeCloseTo(1, 4);
    expect(U[k * 28 + 11]).toBe(MAT.Steel);
  }
});
