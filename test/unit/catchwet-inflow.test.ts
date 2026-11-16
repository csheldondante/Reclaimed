// (mutators round 4) A region's inflow factor carries on downstream: weather/inflow.ts carryInflow.
import { expect, test } from 'vitest';
import { briarEngine } from '../../src/living/briar';
import { carryInflow, reachAbove } from '../../src/weather/inflow';

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

// ---- (mutators round 5) a river run dry at a place: the reaches above it cut, carried on below it (BACKLOG MU-42)
test('reachAbove: the seeded node and every reach above it, not the tributary that joins below, not the reaches below', () => {
  // (seeded at node 1: its spring 0 is above it; the tributary 4 joins at 2, below)
  expect(Array.from(reachAbove(order, next, [0, 1, 0, 0, 0]))).toEqual([1, 1, 0, 0, 0]);
  // (seeded at the confluence: both branches are above it)
  expect(Array.from(reachAbove(order, next, [0, 0, 1, 0, 0]))).toEqual([1, 1, 1, 0, 1]);
  expect(Array.from(reachAbove(order, next, [0, 0, 0, 0, 0]))).toEqual([0, 0, 0, 0, 0]);
});

test('a river dry at a place is dry from its spring to the place, and low below it until a tributary joins', () => {
  const up = reachAbove(order, next, [0, 1, 0, 0, 0]);
  const w = run((k) => (up[k] ? 0 : 1));
  expect(w[0]).toBe(0);
  expect(w[1]).toBe(0);
  // (below the place: the reach's own runoff and the tributary — 1 + 6 of 12)
  expect(w[2]).toBeCloseTo(7 / 12);
  expect(w[4]).toBe(1);
});

// ---- the template engine's droughts through the carry (round 4 changed every river-inflow event's reach)
test('the drought arc’s river-inflow events: a region’s nodes at exactly its factor when the water above is whole, never under it; above untouched; below between the factor and 1', () => {
  const e = briarEngine(true);
  const seen: { regions: number[]; magnitude: number }[] = [];
  e.w.ws.onEvent.push((ev) => void (ev.kind === 'river-inflow' && seen.push({ regions: [...ev.regions], magnitude: ev.magnitude })));
  e.deal();
  e.advance();
  // (the arc's first stage: Briar Hollow's region at 0.7 and Millbrook's at 0.75 — AtlasEvents the river field hears:
  // scenes/level/runs.ts useRiverWorld)
  expect(seen).toEqual([
    { regions: [11], magnitude: 0.7 },
    { regions: [12], magnitude: 0.75 },
  ]);
  expect(e.w.ws.region(11).wetness).toBeCloseTo(0.7);
  // (the line of four nodes: node 0 above both regions, 1 in the first, 2 in the second, 3 below; the tributary 4 outside)
  const factors = new Map(seen.map((s) => [s.regions[0], s.magnitude]));
  const regionOf = [5, 11, 12, 6, 7];
  const w = run((k) => factors.get(regionOf[k]) ?? 1);
  expect(w[0]).toBe(1);
  expect(w[1]).toBeCloseTo(0.7);
  // (the second region: 0.75 of what runs through it — the cut river from above and the whole tributary — so under
  // its own factor, never under the two together, never dry)
  expect(w[2]).toBeCloseTo(((1 + 3.5 + 6) * 0.75) / 12);
  expect(w[2]).toBeGreaterThan(0.7 * 0.75);
  expect(w[2]).toBeLessThan(0.75);
  expect(w[3]).toBeGreaterThan(w[2]);
  expect(w[3]).toBeLessThan(1);
  expect(w[4]).toBe(1);
});
