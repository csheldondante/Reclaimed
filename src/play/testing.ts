// ---- play/testing.ts --------------------------------------------------------------------------------------------
// A tiny synthetic PlayWorld for the play layer's Node tests (round 117, TDD: "make some unit tests so you can stop
// hogging my browser"): a height function, units that stand where they're put (held ones move where they're held,
// released ones fly ballistically for a moment), every blow, crater and blast recorded. The camera is a plain top-down
// projection: screen px = world cells x 20.

import type { AreaHit, UnitId, UnitView, V3 } from '../api/contracts/units';
import type { Pt } from './core/gestures';
import type { Act, Drag, PlayInput } from './input/types';
import type { Blow, PlayWorld, Vehicle } from './world';

export const PX = 20;

export interface FakeUnit {
  id: UnitId;
  at: V3;
  vel: V3;
  health: number;
  held: boolean;
}

export interface TestWorld extends PlayWorld {
  list: FakeUnit[];
  strikes: AreaHit[];
  craters: { x: number; y: number; r: number }[];
  blasts: number;
  add(at: [number, number], health?: number): UnitId;
  /** move the units a step (released ones fly and land) */
  tick(dt: number): void;
}

export function testWorld(height: (x: number, y: number) => number, opts: { water?: (x: number, y: number) => number; maxHeld?: number; vehicles?: () => Vehicle[] } = {}): TestWorld {
  const list: FakeUnit[] = [];
  const strikes: AreaHit[] = [];
  const craters: { x: number; y: number; r: number }[] = [];
  let next = 1;
  const view = (u: FakeUnit): UnitView => ({ id: u.id, kind: 'raider', role: 'raider', faction: null, at: [...u.at], heading: 0, health: u.health, maxHealth: 3, hostile: true, alive: u.health > 0, job: { kind: 'idle' }, state: 'idle', colour: '#fff' });
  const blow = (): Blow => ({ set: () => {}, stop: () => {}, alive: true });
  const w: TestWorld = {
    list,
    strikes,
    craters,
    blasts: 0,
    top: (x, y) => height(x, y) + (opts.water?.(x, y) ?? 0),
    floor: height,
    depth: (x, y) => opts.water?.(x, y) ?? 0,
    bounds: [512, 512],
    units: {
      near: (x, y, r) => list.filter((u) => u.health > 0 && Math.hypot(u.at[0] - x, u.at[1] - y) <= r).map(view),
      get: (id) => {
        const u = list.find((v) => v.id === id);
        return u ? view(u) : null;
      },
      strike: (h) => {
        strikes.push(h);
        for (const u of list) if (Math.hypot(u.at[0] - h.at[0], u.at[1] - h.at[1]) <= h.radius) u.health -= h.damage;
      },
      hold: (id, at) => {
        const u = list.find((v) => v.id === id && v.health > 0);
        if (!u) return false;
        if (!u.held && list.filter((v) => v.held).length >= (opts.maxHeld ?? 8)) throw new Error('test world: more than maxHeld held');
        u.held = true;
        u.at = [...at];
        return true;
      },
      release: (id, vel) => {
        const u = list.find((v) => v.id === id);
        if (!u) return;
        u.held = false;
        u.vel = vel ? [...vel] : [0, 0, 0];
      },
      maxHeld: opts.maxHeld ?? 8,
    },
    burst: () => {},
    wake: () => {},
    gust: () => {},
    blow,
    blast: () => void w.blasts++,
    crater: (x, y, r) => void craters.push({ x, y, r }),
    project: (x, y, z) => [x * PX, (y - z) * PX],
    groundAt: (s) => [s[0] / PX, s[1] / PX],
    vehicles: opts.vehicles,
    add(at, health = 3) {
      const id = next++;
      list.push({ id, at: [at[0], at[1], height(at[0], at[1])], vel: [0, 0, 0], health, held: false });
      return id;
    },
    tick(dt) {
      for (const u of list) {
        if (u.held) continue;
        const g = height(u.at[0], u.at[1]);
        if (u.at[2] > g + 1e-3 || u.vel[2] > 0) {
          u.vel[2] -= 20 * dt;
          for (let i = 0; i < 3; i++) u.at[i] += u.vel[i] * dt;
          if (u.at[2] <= g) {
            u.at[2] = g;
            u.vel = [0, 0, 0];
          }
        } else u.vel = [0, 0, 0];
      }
    },
  };
  return w;
}

/** Inputs, scripted: a stick, buttons, a drag, gestures (in world cells; screen points by the test camera). */
export const input = (o: Partial<PlayInput> = {}): PlayInput => ({ dir: [0, 0], buttons: [], drag: null, acts: [], ...o });

/** where a world point (on the ground at height z) is on the test camera's screen */
export const screenOf = (x: number, y: number, z = 0): Pt => [x * PX, (y - z) * PX];

export function tap(at: Pt, z = 0, self = false): Act {
  return { kind: 'tap', at, screen: screenOf(at[0], at[1], z), self };
}

export function flick(from: Pt, dir: Pt, z = 0, self = false, power = 1): Act {
  return { kind: 'flick', from, dir, power, screen: screenOf(from[0], from[1], z), self };
}

/** a drag held from `from` (on a thing at height z) to `to` */
export function drag(from: Pt, to: Pt, z = 0, self = false): Drag {
  const s = screenOf(from[0], from[1], z);
  const e = screenOf(to[0], to[1], z);
  const d = Math.hypot(to[0] - from[0], to[1] - from[1]);
  return { from, at: to, dir: d > 0 ? [(to[0] - from[0]) / d, (to[1] - from[1]) / d] : [0, 0], extent: Math.min(1, d / 6), up: s[1] - e[1], self, screen: s, screenAt: e };
}
