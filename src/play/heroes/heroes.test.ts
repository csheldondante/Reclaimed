// The play heroes at their contract (round 117): intent → motion and blows on tiny synthetic worlds (play/testing.ts).
import { describe, expect, it } from 'vitest';
import { BIKE_DEFAULTS } from '../controllers/hoverbike';
import { LICH_DEFAULTS } from '../controllers/lich';
import { drag, flick, input, tap, testWorld } from '../testing';
import { BikeHero } from './bike';
import { library } from '../library';
import { LichHero } from './lich';

const DT = 1 / 60;
const run = (n: number, f: (i: number) => void) => {
  for (let i = 0; i < n; i++) f(i);
};
const flat = () => 2;

describe('hoverbike hero', () => {
  it('is the faster bike of round 118: cruises past 28 cells/s, boosts past 40', () => {
    const w = testWorld(flat);
    const bike = new BikeHero(w, [50, 50]);
    run(300, () => bike.update(DT, { move: [1, 0], input: input({ dir: [1, 0] }) }));
    expect(bike.speed()).toBeGreaterThan(28);
    let top = 0;
    run(90, () => {
      bike.update(DT, { move: [1, 0], input: input({ dir: [1, 0], buttons: [true] }) });
      top = Math.max(top, bike.speed());
    });
    expect(top).toBeGreaterThan(40);
  });

  it('rides to its cruise speed on the stick, faster with boost held', () => {
    const w = testWorld(flat);
    const bike = new BikeHero(w, [50, 50]);
    run(300, () => bike.update(DT, { move: [1, 0], input: input({ dir: [1, 0] }) }));
    expect(bike.speed()).toBeGreaterThan(BIKE_DEFAULTS.max * 0.8);
    const boosted = new BikeHero(w, [50, 80]);
    run(300, () => boosted.update(DT, { move: [1, 0], input: input({ dir: [1, 0], buttons: [true] }) }));
    expect(boosted.position()[0]).toBeGreaterThan(bike.position()[0] + 5);
  });

  it('launches off a ramp taken fast: airborne past its crest', () => {
    // a kicker: rising 1 in 1 for 3 cells to a lip at x 103, then a drop back to the plain
    const ramp = (x: number) => (x > 100 && x < 103 ? 2 + (x - 100) : 2);
    const w = testWorld(ramp);
    const bike = new BikeHero(w, [40, 50]);
    let air = 0;
    run(240, () => {
      bike.update(DT, { move: [1, 0], input: input({ dir: [1, 0] }) });
      air = Math.max(air, bike.b.air);
    });
    expect(bike.position()[0]).toBeGreaterThan(103);
    expect(air).toBeGreaterThan(0.25);
  });

  it('a higher launch cap flies higher off the same steep kicker (live parameters)', () => {
    // (a kicker 1.4 steep for 4 cells, under the bike's climb: the throw is capped by launchMax)
    const ramp = (x: number) => (x > 99 && x < 103 ? 2 + (x - 99) * 1.4 : 2);
    const peak = (launchMax: number) => {
      const w = testWorld(ramp);
      const bike = new BikeHero(w, [40, 50], { ...BIKE_DEFAULTS, launchMax });
      let z = 0;
      run(300, () => {
        bike.update(DT, { move: [1, 0], input: input({ dir: [1, 0] }) });
        z = Math.max(z, bike.position()[2]);
      });
      return z;
    };
    expect(peak(20)).toBeGreaterThan(peak(8) + 1);
  });

  it('a swipe on its left side slashes the enemy it passes on that side, not one on the right', () => {
    const w = testWorld(flat);
    const bike = new BikeHero(w, [20, 50]);
    run(120, () => bike.update(DT, { move: [1, 0], input: input({ dir: [1, 0] }) }));
    const x = bike.position()[0];
    // (heading +x: its left is +y)
    const left = w.add([x + 8, 51.8]);
    const right = w.add([x + 8, 46]);
    const hits = () => w.strikes.filter((h) => h.radius < 1 && h.damage > 1);
    bike.update(DT, { move: [1, 0], input: input({ dir: [1, 0], acts: [flick([x + 1, 52], [1, 0])] }) });
    run(60, () => bike.update(DT, { move: [1, 0], input: input({ dir: [1, 0] }) }));
    const near = (id: number) => hits().some((h) => {
      const u = w.list.find((v) => v.id === id)!;
      return Math.hypot(h.at[0] - u.at[0], h.at[1] - u.at[1]) < 0.7;
    });
    expect(near(left)).toBe(true);
    expect(near(right)).toBe(false);
  });

  it('carries its climb over a kicker: it clears a gap to a landing at the same height (carry)', () => {
    // a kicker 0.6 steep up to 6.8 at x 103, a 10-cell gap down to 0, a landing back at 6.8 from x 113
    const course = (x: number) => (x < 95 ? 2 : x < 103 ? 2 + (x - 95) * 0.6 : x < 113 ? 0 : 6.8);
    const landed = (carry: number) => {
      const w = testWorld(course);
      const bike = new BikeHero(w, [40, 50], { ...BIKE_DEFAULTS, carry });
      run(240, () => bike.update(DT, { move: [1, 0], input: input({ dir: [1, 0] }) }));
      return bike.position();
    };
    expect(landed(1)[0]).toBeGreaterThan(113);
    expect(landed(1)[2]).toBeGreaterThan(6.8);
  });

  it('a slash leaves a glowing trail along the sweep of the blade, gone soon after', () => {
    const w = testWorld(flat);
    const bike = new BikeHero(w, [20, 50]);
    run(60, () => bike.update(DT, { move: [1, 0], input: input({ dir: [1, 0] }) }));
    const [x] = bike.position();
    bike.update(DT, { move: [1, 0], input: input({ dir: [1, 0], acts: [flick([x, 52], [1, 0])] }) });
    run(8, () => bike.update(DT, { move: [1, 0], input: input({ dir: [1, 0] }) }));
    const trail = bike.parts().find((p) => p.size !== undefined);
    expect(trail).toBeTruthy();
    expect(trail!.voxels.length).toBeGreaterThan(8);
    run(60, () => bike.update(DT, { move: [1, 0], input: input({ dir: [1, 0] }) }));
    expect(bike.parts().find((p) => p.size !== undefined)).toBeUndefined();
  });

  it('the hook: a tap on a foe puts it on the line; riding on drags it behind at the rope length', () => {
    const w = testWorld(flat);
    const bike = new BikeHero(w, [20, 50]);
    const id = w.add([26, 54]);
    bike.update(DT, { move: [0, 0], input: input({ acts: [tap([26, 54], 2)] }) });
    expect(bike.status()).toBe('ON THE LINE');
    run(120, () => bike.update(DT, { move: [1, 0], input: input({ dir: [1, 0] }) }));
    const u = w.list.find((v) => v.id === id)!;
    const [x, y] = bike.position();
    expect(u.held).toBe(true);
    expect(u.at[0]).toBeGreaterThan(40);
    expect(Math.hypot(u.at[0] - x, u.at[1] - y)).toBeLessThan(Math.hypot(6, 4) + 0.5);
    // (dragged fast, it's scraped)
    expect(u.health).toBeLessThan(3);
  });

  it('the hook: a swipe back toward the bike reels the foe in; a swipe away cuts it loose, flung as it went', () => {
    const reel = () => {
      const w = testWorld(flat);
      const bike = new BikeHero(w, [20, 50]);
      const id = w.add([28, 56]);
      bike.update(DT, { move: [0, 0], input: input({ acts: [tap([28, 56], 2)] }) });
      run(3, () => bike.update(DT, { move: [0, 0], input: input() }));
      // (from the foe, toward the bike)
      bike.update(DT, { move: [0, 0], input: input({ acts: [flick([28, 56], [-0.8, -0.6])] }) });
      return w.list.find((v) => v.id === id)!;
    };
    const u = reel();
    expect(u.held).toBe(false);
    expect(u.vel[0]).toBeLessThan(0);
    expect(u.vel[1]).toBeLessThan(0);
    expect(u.vel[2]).toBeGreaterThan(0);
    const w = testWorld(flat);
    const bike = new BikeHero(w, [20, 50]);
    const id = w.add([26, 54]);
    bike.update(DT, { move: [0, 0], input: input({ acts: [tap([26, 54], 2)] }) });
    run(90, () => bike.update(DT, { move: [1, 0], input: input({ dir: [1, 0] }) }));
    bike.update(DT, { move: [1, 0], input: input({ dir: [1, 0], acts: [flick([bike.position()[0], 60], [1, 0])] }) });
    const f = w.list.find((v) => v.id === id)!;
    expect(f.held).toBe(false);
    expect(f.vel[0]).toBeGreaterThan(5);
    expect(bike.status()).not.toBe('ON THE LINE');
  });

  it('the hook: a tap on another rider reels the bike up alongside it', () => {
    let rx = 40;
    const rival = () => [{ id: 'r1', at: [rx, 62, 2] as [number, number, number], vel: [20, 0, 0] as [number, number, number], heading: 0 }];
    const w = testWorld(flat, { vehicles: rival });
    const bike = new BikeHero(w, [30, 50]);
    run(30, () => {
      bike.update(DT, { move: [1, 0], input: input({ dir: [1, 0] }) });
      rx += 20 * DT;
    });
    bike.update(DT, { move: [1, 0], input: input({ dir: [1, 0], acts: [tap([rx, 62], 2.6)] }) });
    expect(bike.status()).toBe('ALONGSIDE');
    run(120, () => {
      bike.update(DT, { move: [1, 0], input: input({ dir: [1, 0] }) });
      rx += 20 * DT;
    });
    const [x, y] = bike.position();
    expect(Math.hypot(x - rx, y - 62)).toBeLessThan(3.5);
    expect(Math.abs(bike.b.vx - 20)).toBeLessThan(4);
  });

  it('the hook: a tap on the ground ahead and to one side swings the bike round it, a turn far tighter than it carves', () => {
    const turned = (hook: boolean) => {
      const w = testWorld(flat);
      const bike = new BikeHero(w, [20, 50]);
      run(90, () => bike.update(DT, { move: [1, 0], input: input({ dir: [1, 0] }) }));
      const [x, y] = bike.position();
      const h0 = bike.heading();
      if (hook) bike.update(DT, { move: [1, 0], input: input({ dir: [1, 0], acts: [tap([x + 4, y + 6], 2)] }) });
      // (the stick held straight on: the hook alone does the turning)
      run(45, () => bike.update(DT, { move: [1, 0], input: input({ dir: [1, 0] }) }));
      const d = bike.heading() - h0;
      return Math.abs(Math.atan2(Math.sin(d), Math.cos(d)));
    };
    expect(turned(false)).toBeLessThan(0.2);
    expect(turned(true)).toBeGreaterThan(1.2);
  });

  it('a swipe mid-swing cuts the rope: it flies on with the momentum it had', () => {
    const w = testWorld(flat);
    const bike = new BikeHero(w, [20, 50]);
    run(90, () => bike.update(DT, { move: [1, 0], input: input({ dir: [1, 0] }) }));
    const [x, y] = bike.position();
    bike.update(DT, { move: [1, 0], input: input({ dir: [1, 0], acts: [tap([x + 4, y + 6], 2)] }) });
    run(15, () => bike.update(DT, { move: [1, 0], input: input({ dir: [1, 0] }) }));
    const sp = bike.speed();
    const way = Math.atan2(bike.b.vy, bike.b.vx);
    bike.update(DT, { move: [1, 0], input: input({ dir: [1, 0], acts: [flick([x, y - 3], [0, -1])] }) });
    expect(bike.status()).not.toBe('SWING');
    expect(bike.speed()).toBeGreaterThan(sp * 0.9);
    const d = Math.atan2(bike.b.vy, bike.b.vx) - way;
    expect(Math.abs(Math.atan2(Math.sin(d), Math.cos(d)))).toBeLessThan(0.15);
  });

  it('after a swing, the stick still held the old way steers on the new way: no slide back', () => {
    const w = testWorld(flat);
    const bike = new BikeHero(w, [20, 50]);
    run(90, () => bike.update(DT, { move: [1, 0], input: input({ dir: [1, 0] }) }));
    const [x, y] = bike.position();
    bike.update(DT, { move: [1, 0], input: input({ dir: [1, 0], acts: [tap([x + 4, y + 6], 2)] }) });
    let slid = false;
    run(150, () => {
      bike.update(DT, { move: [1, 0], input: input({ dir: [1, 0] }) });
      if (bike.b.slide > 0) slid = true;
    });
    expect(slid).toBe(false);
    // (going on the swing's new way, well turned from +x)
    expect(Math.abs(Math.atan2(bike.b.vy, bike.b.vx))).toBeGreaterThan(1.2);
    // let go of the stick and push it again: plain again
    bike.update(DT, { move: [0, 0], input: input() });
    run(120, () => bike.update(DT, { move: [1, 0], input: input({ dir: [1, 0] }) }));
    expect(Math.abs(Math.atan2(bike.b.vy, bike.b.vx))).toBeLessThan(0.5);
  });

  it('a window slide mid-swing moves the anchor with the bike: the swing carries on the same', () => {
    const w = testWorld(flat);
    const bike = new BikeHero(w, [20, 50]);
    run(90, () => bike.update(DT, { move: [1, 0], input: input({ dir: [1, 0] }) }));
    const [x, y] = bike.position();
    bike.update(DT, { move: [1, 0], input: input({ dir: [1, 0], acts: [tap([x + 4, y + 6], 2)] }) });
    run(10, () => bike.update(DT, { move: [1, 0], input: input({ dir: [1, 0] }) }));
    bike.shift(-30, -20, 0);
    run(30, () => bike.update(DT, { move: [1, 0], input: input({ dir: [1, 0] }) }));
    expect(bike.status()).toBe('SWING');
    const [x1, y1] = bike.position();
    // (still on its rope round the moved anchor, ~7 cells off)
    expect(Math.hypot(x1 - (x + 4 - 30), y1 - (y + 6 - 20))).toBeLessThan(8);
  });

  it('a hook gives the bike a tighter turn in its profile; no hook, none', () => {
    expect(library.get('hoverbike')!.profile().turnRadius).toBeLessThan(10);
    expect(library.get('hoverbike')!.profile({ ...BIKE_DEFAULTS, hookRange: 0 }).turnRadius).toBeGreaterThan(10);
  });

  it('rams what it runs into at speed', () => {
    const w = testWorld(flat);
    const bike = new BikeHero(w, [20, 50]);
    w.add([60, 50]);
    run(180, () => bike.update(DT, { move: [1, 0], input: input({ dir: [1, 0] }) }));
    expect(w.list[0].health).toBeLessThan(3);
  });

  it('skims over water rather than sinking into it', () => {
    // the bed shelves down past x 60 to 3 under the water's surface, which stays at 2
    const bed = (x: number) => (x > 60 ? Math.max(-1, 2 - (x - 60)) : 2);
    const w = testWorld(bed, { water: (x) => 2 - bed(x) });
    const bike = new BikeHero(w, [30, 50]);
    run(240, () => bike.update(DT, { move: [1, 0], input: input({ dir: [1, 0] }) }));
    const [x, , z] = bike.position();
    expect(x).toBeGreaterThan(70);
    expect(z).toBeGreaterThan(2.3);
  });
});

describe('lich hero', () => {
  it('glides to where the ground is tapped and stops there', () => {
    const w = testWorld(flat);
    const lich = new LichHero(w, [20, 20]);
    lich.update(DT, { move: [0, 0], input: input({ acts: [tap([30, 24])] }) });
    run(300, () => lich.update(DT, { move: [0, 0], input: input() }));
    const [x, y, z] = lich.position();
    expect(Math.hypot(x - 30, y - 24)).toBeLessThan(0.8);
    expect(z).toBeCloseTo(2 + LICH_DEFAULTS.floatLow, 0);
  });

  it('is never moved by blows (immune to the forces of the world)', () => {
    const w = testWorld(flat);
    const lich = new LichHero(w, [20, 20]);
    lich.take(1, [19, 20]);
    run(30, () => lich.update(DT, { move: [0, 0], input: input() }));
    expect(lich.position()[0]).toBeCloseTo(20, 3);
    expect(lich.health).toBeLessThan(lich.maxHealth);
  });

  it('floats up a cliff it is pushed at, with no jump', () => {
    const cliff = (x: number) => (x > 25 ? 14 : 2);
    const w = testWorld(cliff);
    const lich = new LichHero(w, [20, 20]);
    run(600, () => lich.update(DT, { move: [1, 0], input: input({ dir: [1, 0] }) }));
    const [x, , z] = lich.position();
    expect(x).toBeGreaterThan(26);
    expect(z).toBeGreaterThan(14);
  });

  it('a tap on an enemy floats it (held in the air); a drag carries it; let go, it flies', () => {
    const w = testWorld(flat);
    const lich = new LichHero(w, [20, 20]);
    const id = w.add([24, 20]);
    lich.update(DT, { move: [0, 0], input: input({ acts: [tap([24, 20], 2)] }) });
    run(10, () => lich.update(DT, { move: [0, 0], input: input() }));
    expect(lich.held()).toContain(id);
    expect(w.list[0].held).toBe(true);
    expect(w.list[0].at[2]).toBeGreaterThan(3);
    // drag it from where it floats toward (30, 20)
    const u = w.list[0];
    const from: [number, number] = [u.at[0], u.at[1]];
    run(30, (i) => lich.update(DT, { move: [0, 0], input: input({ drag: drag(from, [from[0] + (6 * i) / 30, from[1]], u.at[2]) }) }));
    expect(w.list[0].at[0]).toBeGreaterThan(from[0] + 2);
    lich.update(DT, { move: [0, 0], input: input() });
    expect(w.list[0].held).toBe(false);
    expect(lich.held()).not.toContain(id);
  });

  it('a double tap on a foe floats it up before the lich, hung at the height of the lich face, rising, not snapping', () => {
    const w = testWorld(flat);
    const lich = new LichHero(w, [20, 20]);
    const id = w.add([24, 22], 20);
    lich.update(DT, { move: [0, 0], input: input({ acts: [tap([24, 22], 2)] }) });
    lich.update(DT, { move: [0, 0], input: input({ acts: [tap([24, 22], 2)] }) });
    const u = () => w.list.find((v) => v.id === id)!;
    lich.update(DT, { move: [0, 0], input: input() });
    // (a frame in: still near where it was floated by the first tap, not snapped before the lich)
    expect(Math.hypot(u().at[0] - 24, u().at[1] - 22)).toBeLessThan(0.5);
    run(60, () => lich.update(DT, { move: [0, 0], input: input() }));
    const [x, y, z] = lich.position();
    const f = u();
    expect(lich.status()).toMatch(/FACE TO FACE/);
    // (before it: 1-2.4 cells off, the way the lich now faces; its feet at the lich face height)
    const d = Math.hypot(f.at[0] - x, f.at[1] - y);
    expect(d).toBeGreaterThan(1);
    expect(d).toBeLessThan(2.4);
    expect(Math.abs(f.at[2] - (z + 1.4))).toBeLessThan(0.3);
    expect(f.health).toBeLessThan(20);
  });

  it('a flick away with nothing held is a force push: a cone of shove that way', () => {
    const w = testWorld(flat);
    const lich = new LichHero(w, [20, 20]);
    lich.update(DT, { move: [0, 0], input: input({ acts: [flick([21, 20], [1, 0])] }) });
    const push = w.strikes.find((h) => h.cone !== undefined);
    expect(push).toBeTruthy();
    expect(push!.dir).toEqual([1, 0]);
    expect(push!.push!).toBeGreaterThan(0);
  });

  it('a tap on itself slams: a crater under it and a ring that shoves and throws; then a cooldown', () => {
    const w = testWorld(flat);
    const lich = new LichHero(w, [20, 20]);
    lich.update(DT, { move: [0, 0], input: input({ acts: [tap([20, 20], 3.6, true)] }) });
    expect(w.craters.length).toBe(1);
    const ring = w.strikes.find((h) => (h.lift ?? 0) > 0 && h.radius >= LICH_DEFAULTS.slamReach);
    expect(ring).toBeTruthy();
    lich.update(DT, { move: [0, 0], input: input({ buttons: [true] }) });
    expect(w.craters.length).toBe(1);
  });

  it('never holds more than the units allow (a storm over a crowd)', () => {
    const w = testWorld(flat, { maxHeld: 8 });
    const lich = new LichHero(w, [20, 20]);
    for (let i = 0; i < 14; i++) w.add([20 + Math.cos(i) * 3, 20 + Math.sin(i) * 3]);
    lich.update(DT, { move: [0, 0], input: input({ acts: [{ kind: 'circle', centre: [20, 20], ccw: true, turns: 1.5 }] }) });
    run(60, () => lich.update(DT, { move: [0, 0], input: input() }));
    expect(lich.held().length).toBe(8);
    expect(w.list.filter((u) => u.held).length).toBe(8);
  });
});
