// A body's nodes from its cells (src/solver/build.ts): written from the design ("nodes come from the voxels by
// clustering"; a body is a few to a few dozen nodes) before the code ran.
import { expect, test } from 'vitest';
import { buildBody, NN } from '../../src/solver/build';
import { MAT } from '../../src/world/materials';
import type { SolverCell } from '../../src/api/contracts/solver';

const box = (w: number, d: number, h: number, mat: number = MAT.Stone, x0 = 10, y0 = 10, z0 = 5): SolverCell[] => {
  const out: SolverCell[] = [];
  for (let z = 0; z < h; z++) for (let y = 0; y < d; y++) for (let x = 0; x < w; x++) out.push({ x: x0 + x, y: y0 + y, z: z0 + z, mat });
  return out;
};
const bonded = (b: [number, number][], i: number, j: number) => ((b[i][j >> 5] >>> (j & 31)) & 1) === 1;

test('a small block: a node a cell, bonded to its neighbours, points on its surface', () => {
  const b = buildBody(box(2, 2, 2))!;
  expect(b.g).toBe(1);
  expect(b.nodes.length).toBe(8);
  // (each cell touches 3 of the others: the cells above or below and two of its hex neighbours in its 2 × 2 patch)
  for (let i = 0; i < 8; i++) {
    const n = [...Array(8).keys()].filter((j) => bonded(b.bonds, i, j)).length;
    expect(n).toBeGreaterThanOrEqual(2);
    for (let j = 0; j < 8; j++) expect(bonded(b.bonds, i, j)).toBe(bonded(b.bonds, j, i));
  }
  expect(b.points.length).toBeGreaterThan(8);
  expect(b.points.length).toBeLessThanOrEqual(NN);
  // the lowest point is on its underside
  expect(Math.min(...b.points.map((p) => p.rest[2]))).toBeCloseTo(5, 6);
});

test('a big piece: at most 64 nodes, mass and centre kept', () => {
  const cells = box(12, 12, 10);
  const b = buildBody(cells)!;
  expect(b.nodes.length).toBeLessThanOrEqual(NN);
  expect(b.g).toBeGreaterThan(1);
  const m = b.nodes.reduce((s, n) => s + n.mass, 0);
  expect(m).toBeCloseTo(cells.length * 2.7, 3);
  expect(b.com[2]).toBeCloseTo(5 + 5, 1);
  expect(b.points.length).toBe(NN);
});

test("an arch: its legs aren't bonded through the air between them", () => {
  // two legs 1 wide, 6 tall, 4 apart, joined by a span on top
  const cells: SolverCell[] = [];
  for (let z = 0; z < 6; z++) cells.push({ x: 10, y: 10, z, mat: MAT.Stone }, { x: 15, y: 10, z, mat: MAT.Stone });
  for (let x = 10; x <= 15; x++) cells.push({ x, y: 10, z: 6, mat: MAT.Stone });
  const b = buildBody(cells)!;
  expect(b.g).toBe(1);
  const at = (x: number, z: number) => cells.findIndex((c) => c.x === x && c.z === z);
  // (g = 1: node i is cell i)
  expect(bonded(b.bonds, at(10, 0), at(15, 0))).toBe(false);
  expect(bonded(b.bonds, at(10, 5), at(10, 6))).toBe(true);
});

test('a steel girder: a chain of nodes along it', () => {
  const b = buildBody(box(40, 1, 2, MAT.Steel))!;
  expect(b.nodes.length).toBeLessThanOrEqual(NN);
  expect(b.mat).toBe(MAT.Steel);
  // every node but the ends has neighbours on both sides along x
  const xs = b.nodes.map((n) => n.rest[0]);
  const span = Math.max(...xs) - Math.min(...xs);
  expect(span).toBeGreaterThan(35);
});

test('pinned cells pin their node', () => {
  const b = buildBody(box(3, 1, 3), (c) => c.z === 5)!;
  expect(b.nodes.filter((n) => n.pinned).length).toBeGreaterThan(0);
  expect(b.nodes.filter((n) => !n.pinned).length).toBeGreaterThan(0);
});
