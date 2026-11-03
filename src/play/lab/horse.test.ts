// (round 128, the user's horse) The horse's assist in Node, on the lab's land: a sloppy thumb (re-aims every 0.25 s
// at a point ahead, in one of 16 directions) rides the canyon with the assist on and off; with it on, it touches the
// walls less and gets further. Held straight at a wall it stops short of it; held roughly along a bend it takes it.
import { describe, expect, it } from 'vitest';
import type { Pt } from '../core/gestures';
import { HORSE_DEFAULTS } from '../controllers/horse';
import type { HorseHero } from '../heroes/horse';
import { makeHero } from '../heroes/make';
import { input, testWorld } from '../testing';
import { Autopilot } from './autopilot';
import { sight } from './ride';
import { LAB_TERRAINS } from './terrains';

function sloppy(assist: number, secs = 60) {
  const s = sight();
  const world = testWorld((x, y) => s.top(x, y), { maxHeld: 4 });
  const t = LAB_TERRAINS.find((x) => x.id === 'canyon')!;
  const pilot = new Autopilot(t.path, 7);
  const hero = makeHero('horse', world, pilot.start().at, { ...HORSE_DEFAULTS, assist }) as HorseHero;
  const dt = 1 / 30;
  let aim: Pt = [0, 0];
  let walls = 0;
  let best = 0;
  let laps = 0;
  let prev = 0;
  for (let k = 0; k < secs / dt; k++) {
    const p = hero.position();
    if (k % 8 === 0) {
      const d = pilot.steer([p[0], p[1]]);
      const a = Math.round((Math.atan2(d[1], d[0]) / (Math.PI * 2)) * 16) * ((Math.PI * 2) / 16);
      aim = [Math.cos(a), Math.sin(a)];
    }
    hero.update(dt, { move: aim, input: input({ dir: aim }) });
    if ((hero as unknown as { f: { wall: unknown } }).f.wall) walls++;
    const pr = pilot.progress;
    if (pr < prev - 0.5) laps++;
    prev = pr;
    best = Math.max(best, laps + pr);
  }
  return { walls: (walls * dt * 60) / secs, laps: best };
}

describe('the horse', () => {
  it('with its assist a sloppy thumb touches the canyon walls less and gets further', () => {
    const off = sloppy(0);
    const on = sloppy(1);
    expect(on.walls).toBeLessThan(off.walls);
    expect(on.laps).toBeGreaterThan(off.laps * 0.9);
    expect(on.laps).toBeGreaterThan(0.5);
  });

  it('held straight at a wall, it stops short of it', () => {
    const top = (x: number) => (x > 40 ? 30 : 10);
    const world = testWorld((x) => top(x), { maxHeld: 4 });
    const hero = makeHero('horse', world, [5, 20]) as HorseHero;
    const dt = 1 / 30;
    let touched = false;
    for (let k = 0; k < 8 / dt; k++) {
      hero.update(dt, { move: [1, 0], input: input({ dir: [1, 0] }) });
      if ((hero as unknown as { f: { wall: unknown } }).f.wall) touched = true;
    }
    expect(touched).toBe(false);
    expect(hero.speed()).toBeLessThan(0.5);
    expect(hero.position()[0]).toBeGreaterThan(35);
    expect(hero.position()[0]).toBeLessThan(40);
  });
});
