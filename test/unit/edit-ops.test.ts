// (DA-B8) The edit pass's schedule: it runs on a tick that carries an Edit event and, after one, only while brush state
// is in flight (sim/edit-ops.ts EditBusy) — a unit's take or put leaves none, so the builders' quiet edits don't
// keep the pass running. The rates it reckons with are the shaders' (common.wgsl, edit.wgsl).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EditBusy, OP, POUR_FALL, POUR_RATE, STROKE_START, UPLIFT_RATE } from '../../src/sim/edit-ops';
import { SRC } from '../support/source-scan';

const wgsl = (name: string) => readFileSync(join(SRC, 'shaders', name), 'utf8');
const constOf = (text: string, name: string): number => {
  const m = new RegExp(`const ${name}: f32 = ([0-9.]+);`).exec(text);
  if (!m) throw new Error(`${name} not found`);
  return Number(m[1]);
};
const DT = 1 / 60;
const ev = (op: number, strength: number, start = true, mat = 1) => ({ z: op * 32 + mat + (start ? STROKE_START : 0), strength });

const busy = (from: EditBusy | null, tick: number, events: { z: number; strength: number }[], dt = DT) => {
  const b = from ?? new EditBusy();
  b.take(events, tick, dt);
  return b;
};
const ticks = (s: number) => Math.ceil(s / DT);

describe('EditBusy', () => {
  it('uses the rates of the shaders', () => {
    expect(constOf(wgsl('common.wgsl'), 'POUR_FALL')).toBe(POUR_FALL);
    expect(constOf(wgsl('common.wgsl'), 'POUR_RATE')).toBe(POUR_RATE);
    expect(constOf(wgsl('edit.wgsl'), 'UPLIFT_RATE')).toBe(UPLIFT_RATE);
  });

  it('leaves nothing in flight for ops done in their tick (a builder take or put)', () => {
    const quiet = [OP.TAKE, OP.PUT, OP.FELL, OP.WATER, OP.DRAIN, OP.OIL, OP.POLLUTE, OP.CLEAN, OP.PLANT, OP.SMASH, OP.CRATER].map((op) => ev(op, 3, false));
    expect(busy(null, 100, quiet).until).toBe(-1);
    // (a take keeps an earlier pour's time, neither more nor less)
    const b = busy(null, 100, [ev(OP.POUR, 2)]);
    const u = b.until;
    expect(busy(b, 110, [ev(OP.TAKE, 1, false)]).until).toBe(u);
  });

  it('runs a pour through its fall and its landing, and two ticks more', () => {
    const end = busy(null, 100, [ev(OP.POUR, 2)]).until;
    expect(end).toBe(100 + ticks(POUR_FALL) + Math.ceil(2 / (POUR_RATE * DT)) + 2);
    // (the pass's own reckoning, a tick at a time: the timer runs out, then 2 cells at 4 a second)
    let timer = POUR_FALL;
    let pending = 2;
    let t = 100;
    while (pending > 0) {
      t++;
      if (timer > 0) timer = Math.max(timer - DT, 0);
      else pending -= Math.min(pending, POUR_RATE * DT);
    }
    expect(end).toBeGreaterThanOrEqual(t + 1);
  });

  it('queues a new press behind what is still in flight', () => {
    const b = busy(null, 100, [ev(OP.POUR, 2)]);
    const a = b.until;
    expect(busy(b, 101, [ev(OP.POUR, 2)]).until).toBe(a + Math.ceil(2 / (POUR_RATE * DT)) + 2);
  });

  it('extends a press only by what its later events add', () => {
    const b = busy(null, 100, [ev(OP.POUR, 2)]);
    const a = b.until;
    // (as strong: new columns fall from their own tick)
    expect(busy(b, 101, [ev(OP.POUR, 2, false)]).until).toBe(a + 1);
    // (stronger: the difference queued)
    expect(busy(b, 102, [ev(OP.POUR, 3, false)]).until).toBe(a + 1 + Math.ceil(3 / (POUR_RATE * DT)) - Math.ceil(2 / (POUR_RATE * DT)) + 2);
  });

  it('starts a new press at any stroke start (it resets what every column was given)', () => {
    // (seen on the GPU, the town lab: a pour, a build's start in the same tick, then the pour's next event — the
    // build's start cleared the pour's columns' given, so they took the pour's strength again: 5 cells pending)
    const b = busy(null, 0, [ev(OP.POUR, 2, true, 3), ev(OP.BUILD, 3)]);
    busy(b, 5, [ev(OP.POUR, 3, false, 3)]);
    const steady = ticks(POUR_FALL) + Math.ceil(5 / (POUR_RATE * DT));
    expect(b.until).toBeGreaterThanOrEqual(steady + 1);
  });

  it('lands a build or a dig a cell a tick, bedrock at its rate', () => {
    expect(busy(null, 10, [ev(OP.BUILD, 3)]).until).toBe(10 + 3 + 2);
    expect(busy(null, 10, [ev(OP.DIG, 1)]).until).toBe(10 + 1 + 2);
    expect(busy(null, 10, [ev(OP.BEDROCK, 3)]).until).toBe(10 + Math.ceil(3 / (UPLIFT_RATE * DT)) + 2);
  });

  it('reckons a slower tick in world time', () => {
    expect(busy(null, 0, [ev(OP.POUR, 2)], 1 / 30).until).toBe(Math.ceil(POUR_FALL * 30) + Math.ceil(2 / (POUR_RATE / 30)) + 2);
  });
});
