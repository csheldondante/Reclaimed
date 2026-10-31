// Solver step 1 (BACKLOG AR9, AR10; the design doc's "Why it feels wrong"): one world gravity every mover reads, a
// per-object scale only where wanted, no speed caps, and a fixed step drawn between its last two states. Written from
// the brief before the change.
import { afterEach, expect, test } from 'vitest';
import { TUNING, TUNE, worldG } from '../../src/tune/params';
import { RockBodies, SUB_DT, type RockGround } from '../../src/game/rockbodies';

afterEach(() => TUNING.reset());

/** no ground at all: a body falls freely */
const AIR: RockGround = { probe: () => null, topIn: () => -1e9 };

function block(rb: RockBodies) {
  const cells = [];
  for (let x = 0; x < 3; x++) for (let y = 0; y < 3; y++) for (let z = 40; z < 43; z++) cells.push({ x: 10 + x, y: 10 + y, z, mat: 1 });
  const b = rb.spawn(cells)!;
  expect(b).toBeTruthy();
  return b;
}

test('the world gravity × scales the one gravity', () => {
  expect(worldG()).toBeCloseTo(9.8, 6);
  TUNING.set('world.gravityX', 2);
  expect(worldG()).toBeCloseTo(19.6, 6);
});

test('no speed caps: the old top-speed parameters are gone', () => {
  for (const id of ['rigid.maxV', 'pieces.maxV', 'voxels.vmax']) expect(TUNING.byId.has(id)).toBe(false);
});

test('the rigid rock falls at the world gravity, uncapped (it was held to 14 cells/s)', () => {
  TUNE.rigid.airDrag = 0;
  const rb = new RockBodies(AIR);
  const b = block(rb);
  for (let i = 0; i < 180; i++) rb.update(1 / 60); // 3 s
  // v = g t = 29.4 cells/s, well past the old cap
  expect(-b.v[2]).toBeGreaterThan(29);
  expect(-b.v[2]).toBeLessThan(29.6);
});

test('world gravity × 2 doubles the fall', () => {
  TUNE.rigid.airDrag = 0;
  TUNING.set('world.gravityX', 2);
  const rb = new RockBodies(AIR);
  const b = block(rb);
  for (let i = 0; i < 60; i++) rb.update(1 / 60);
  expect(-b.v[2]).toBeCloseTo(19.6, 0);
});

test('fixed step: a 144 Hz frame runs whole steps and draws between the last two', () => {
  TUNE.rigid.airDrag = 0;
  const rb = new RockBodies(AIR);
  const b = block(rb);
  // the same sim time in odd frames and in whole steps ends at the same state (the step doesn't follow the frame)
  const rb2 = new RockBodies(AIR);
  const b2 = block(rb2);
  for (let i = 0; i < 144; i++) rb.update(1 / 144);
  for (let i = 0; i < 120; i++) rb2.update(SUB_DT);
  expect(Math.abs(b.v[2] - b2.v[2])).toBeLessThan(worldG() * SUB_DT * 1.01);
  // drawn between its last two steps: never ahead of where it is, never behind where it was
  for (let i = 0; i < 7; i++) {
    rb.update(1 / 144);
    const z = rb.drawPose(b).pos[2];
    expect(z).toBeLessThanOrEqual(b.prevPos![2] + 1e-9);
    expect(z).toBeGreaterThanOrEqual(b.pos[2] - 1e-9);
    expect(rb.alpha).toBeGreaterThanOrEqual(0);
    expect(rb.alpha).toBeLessThan(1);
  }
});
