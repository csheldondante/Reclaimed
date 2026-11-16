// (mutators round 4) A region's inflow factor carries on downstream: weather/inflow.ts carryInflow.
import { expect, test } from 'vitest';
import { carryInflow } from '../../src/weather/inflow';

// a river of four nodes in a line (0 the spring, 3 the mouth), and a tributary (4) joining at node 2
const next = [1, 2, 3, 3, 2];
const own = [4, 1, 1, 1, 6];
// (ref: own and everything upstream)
const ref = [4, 5, 12, 13, 6];
const order = [0, 4, 1, 2, 3];
const run = (local: (k: number) => number) => {
  const out = new Float32Array(5);
  carryInflow(order, next, own, ref, local, out);
  return out;
};

test('a dried spring cuts the river below it, until a tributary makes it up', () => {
  const w = run((k) => (k === 0 ? 0 : 1));
  expect(w[0]).toBe(0);
  // (below the spring only the reach's own runoff is left: 1 of 5)
  expect(w[1]).toBeCloseTo(1 / 5);
  // (the tributary joins: 1 + 1 + 6 of 12)
  expect(w[2]).toBeCloseTo(8 / 12);
  expect(w[3]).toBeCloseTo(9 / 13);
  expect(w[4]).toBe(1);
});

test('no factor: every node at its reference', () => {
  expect(Array.from(run(() => 1))).toEqual([1, 1, 1, 1, 1]);
});

test('a factor in the middle leaves the reaches above it alone', () => {
  const w = run((k) => (k === 1 ? 0.5 : 1));
  expect(w[0]).toBe(1);
  expect(w[1]).toBeCloseTo(0.5);
  expect(w[2]).toBeCloseTo((2.5 + 1 + 6) / 12);
});
