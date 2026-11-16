// The settled gate (src/gpu/settled.ts): a solve encoded only between a CPU-known event and the read that says it's done.
import { expect, test } from 'vitest';
import { SettledGate } from '../../src/gpu/settled';

test('awake to begin with; a believed "settled" puts it to sleep', () => {
  const g = new SettledGate(0);
  expect(g.awake).toBe(true);
  const t = g.tick()!;
  g.answer(t, false);
  expect(g.awake).toBe(true);
  g.answer(g.tick()!, true);
  expect(g.awake).toBe(false);
});

test('a wake after a read was taken outlives that read', () => {
  const g = new SettledGate(0);
  const t = g.tick()!;
  g.wake();
  // (the read shows the state before the event)
  g.answer(t, true);
  expect(g.awake).toBe(true);
  g.answer(g.tick()!, true);
  expect(g.awake).toBe(false);
});

test('no read is taken in the frames a wake holds: an event that lands a tick later is not slept through', () => {
  const g = new SettledGate(2);
  g.answer(g.tick()!, true);
  expect(g.awake).toBe(false);
  g.wake();
  expect(g.awake).toBe(true);
  expect(g.tick()).toBeNull();
  expect(g.tick()).toBeNull();
  const t = g.tick();
  expect(t).not.toBeNull();
  g.answer(t!, true);
  expect(g.awake).toBe(false);
  expect(g.stats).toMatchObject({ wakes: 1, slept: 2 });
});
