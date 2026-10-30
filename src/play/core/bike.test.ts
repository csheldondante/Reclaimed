import { describe, expect, it } from "vitest";
import { BIKE, makeBike, speedOf, stepBike } from "./bike";

const flat = () => 2;
const run = (n: number, f: () => void) => { for (let i = 0; i < n; i++) f(); };
const DT = 1 / 60;
const BOUNDS: [number, number] = [256, 222];

describe("hover bike", () => {
  it("rides at its hover height and speeds up to its top speed", () => {
    const b = makeBike(50, 50, flat);
    run(600, () => stepBike(b, [1, 0], DT, flat, BOUNDS));
    expect(b.z).toBeCloseTo(2 + BIKE.hover, 1);
    expect(speedOf(b)).toBeGreaterThan(BIKE.max * 0.8);
    expect(speedOf(b)).toBeLessThanOrEqual(BIKE.max + 1e-6);
  });

  it("speeds up downhill past its top speed, and slows uphill", () => {
    const flatRun = makeBike(20, 50, flat);
    const down = (x: number) => 60 - x * 0.4;
    const downRun = makeBike(20, 50, down);
    const up = (x: number) => x * 0.4;
    const upRun = makeBike(20, 50, up);
    run(240, () => {
      stepBike(flatRun, [1, 0], DT, flat, BOUNDS);
      stepBike(downRun, [1, 0], DT, down, BOUNDS);
      stepBike(upRun, [1, 0], DT, up, BOUNDS);
    });
    expect(speedOf(downRun)).toBeGreaterThan(BIKE.max * 1.1);
    expect(speedOf(downRun)).toBeGreaterThan(speedOf(flatRun));
    expect(speedOf(upRun)).toBeLessThan(speedOf(flatRun));
  });

  it("coasts on downhill with the stick let go", () => {
    const down = (x: number) => 60 - x * 0.4;
    const b = makeBike(20, 50, down);
    run(240, () => stepBike(b, [0, 0], DT, down, BOUNDS));
    expect(b.vx).toBeGreaterThan(4);
  });

  it("keeps its momentum when the stick lets go, then slows", () => {
    const b = makeBike(50, 50, flat);
    run(120, () => stepBike(b, [0, 1], DT, flat, BOUNDS));
    const v = speedOf(b);
    run(15, () => stepBike(b, [0, 0], DT, flat, BOUNDS));
    expect(speedOf(b)).toBeGreaterThan(v * 0.6);
    run(300, () => stepBike(b, [0, 0], DT, flat, BOUNDS));
    expect(speedOf(b)).toBeLessThan(0.5);
  });

  it("climbs a slope it can lift over", () => {
    const hill = (x: number) => (x < 60 ? 2 : Math.min(3, 2 + (x - 60) * 0.5));
    const b = makeBike(50, 50, hill);
    run(240, () => stepBike(b, [1, 0], DT, hill, BOUNDS));
    expect(b.x).toBeGreaterThan(70);
    expect(b.z).toBeGreaterThan(3 + BIKE.hover - 0.3);
  });

  it("rolls over rocks and ledges lower than itself, at speed, without stopping", () => {
    // a rock a cell high, then a ledge up a cell
    const rocky = (x: number) => (x > 60 && x < 61 ? 3 : x > 70 ? 3 : 2);
    const b = makeBike(40, 50, rocky);
    b.vx = 18;
    let hit = 0;
    run(120, () => {
      stepBike(b, [1, 0], DT, rocky, BOUNDS);
      hit = Math.max(hit, b.hit);
    });
    expect(hit).toBe(0);
    expect(b.crashed).toBe(0);
    expect(b.x).toBeGreaterThan(75);
  });

  it("flying into an opposite bank, it lands on it and rides up, not crashes", () => {
    // a dip, then a bank rising at a ridable grade far higher than the bike
    const bank = (x: number) => (x < 60 ? 2 : Math.min(20, 2 + (x - 60) * 1.2));
    const b = makeBike(54, 50, bank);
    b.z = 5;
    b.vx = 22;
    b.air = 0.5;
    let crashed = 0;
    run(30, () => {
      stepBike(b, [1, 0], DT, bank, BOUNDS);
      crashed = Math.max(crashed, b.crashed);
    });
    expect(crashed).toBe(0);
    // up the bank, still going
    expect(b.z).toBeGreaterThan(6);
    expect(b.vx).toBeGreaterThan(5);
  });

  it("pitches to the slope where it'll land, before it lands", () => {
    // off a crest onto a downslope
    const hill = (x: number) => (x < 60 ? 10 : 10 - (x - 60) * 0.8);
    const b = makeBike(58, 50, hill);
    b.vx = 15;
    b.z = 12;
    b.air = 0.1;
    run(12, () => stepBike(b, [0, 0], DT, hill, BOUNDS));
    expect(b.air).toBeGreaterThan(0);
    expect(b.pitch).toBeLessThan(-0.3);
  });

  it("a sharp bump taken fast throws it up; taken slowly, it rolls over", () => {
    // a rock half a cell high, rising over a fifth of a cell
    const rock = (x: number) => (x < 60 ? 2 : x < 60.2 ? 2 + (x - 60) * 2.5 : x < 61 ? 2.5 : 2);
    const fast = makeBike(50, 50, rock);
    fast.vx = 20;
    const slow = makeBike(59, 50, rock);
    slow.vx = 4;
    let fastAir = 0;
    let slowPeak = 0;
    let peak = 0;
    run(90, () => {
      stepBike(fast, [1, 0], DT, rock, BOUNDS);
      stepBike(slow, [0, 0], DT, rock, BOUNDS);
      fastAir = Math.max(fastAir, fast.air);
      peak = Math.max(peak, fast.z);
      slowPeak = Math.max(slowPeak, slow.z);
    });
    expect(fastAir).toBeGreaterThan(0.2);
    // (thrown, but not far: a few times the rock's height at most)
    expect(peak).toBeLessThan(2.5 + BIKE.hover + 0.5 * BIKE.launchHeight + 0.5);
    // slow, it rides up over it on the cushion, not thrown
    expect(slowPeak).toBeLessThan(2.5 + BIKE.hover + 0.8);
    expect(peak).toBeGreaterThan(slowPeak + 0.4);
    expect(slow.x).toBeGreaterThan(60.5);
  });

  it("a gentle hill doesn't throw it", () => {
    const hill = (x: number) => (x < 60 ? 2 : Math.min(5, 2 + (x - 60) * 0.3));
    const b = makeBike(40, 50, hill);
    b.vx = 20;
    let air = 0;
    run(50, () => {
      stepBike(b, [1, 0], DT, hill, BOUNDS);
      air = Math.max(air, b.air);
    });
    expect(air).toBe(0);
  });

  it("boosts past its top speed while the tank lasts, then refills", () => {
    const flat = () => 2;
    const b = makeBike(20, 50, flat);
    run(300, () => stepBike(b, [1, 0], DT, flat, BOUNDS));
    run(80, () => stepBike(b, [1, 0], DT, flat, BOUNDS, BIKE, true));
    expect(speedOf(b)).toBeGreaterThan(BIKE.max + 4);
    expect(b.fuel).toBeLessThan(0.2);
    run(Math.ceil(BIKE.boostTime * 60), () => stepBike(b, [1, 0], DT, flat, BOUNDS, BIKE, true));
    expect(b.fuel).toBe(0);
    expect(b.boosting).toBe(false);
    run(Math.ceil(60 / BIKE.refill), () => stepBike(b, [1, 0], DT, flat, BOUNDS));
    expect(b.fuel).toBe(1);
  });

  it("boosting, it gets up a face a little too steep to ride", () => {
    // a face at 3 rise over run, four cells high: steeper than `climb`, under `boostClimb`
    const face = (x: number) => (x < 60 ? 2 : Math.min(6, 2 + (x - 60) * 3));
    const plain = makeBike(52, 50, face);
    plain.vx = 15;
    const boosted = makeBike(52, 50, face);
    boosted.vx = 15;
    run(90, () => {
      stepBike(plain, [1, 0], DT, face, BOUNDS);
      stepBike(boosted, [1, 0], DT, face, BOUNDS, BIKE, true);
    });
    expect(plain.x).toBeLessThan(61);
    expect(boosted.x).toBeGreaterThan(63);
    expect(boosted.crashed).toBe(0);
  });

  it("never gets through a barricade higher than itself", () => {
    const wall = (x: number) => (x > 60 ? 12 : 2);
    const b = makeBike(50, 50, wall);
    run(240, () => stepBike(b, [1, 0], DT, wall, BOUNDS));
    expect(b.x).toBeLessThan(60);
  });

  it("crashes into a wall at speed: knocked back, spinning, no control for a while", () => {
    const wall = (x: number) => (x > 60 ? 12 : 2);
    const c = makeBike(55, 50, wall);
    c.vx = 20;
    let crash = 0;
    run(30, () => {
      stepBike(c, [1, 0], DT, wall, BOUNDS);
      crash = Math.max(crash, c.crash);
    });
    expect(crash).toBeGreaterThan(BIKE.crash);
    expect(c.crashed).toBeGreaterThan(0);
    expect(c.vx).toBeLessThan(0);
    // the stick does nothing until it rights itself
    const x = c.x;
    run(20, () => stepBike(c, [1, 0], DT, wall, BOUNDS));
    expect(c.x).toBeLessThanOrEqual(x);
    run(120, () => stepBike(c, [0, 0], DT, wall, BOUNDS));
    expect(c.crashed).toBe(0);
  });

  it("glances off a wall it hits slowly, without crashing", () => {
    const wall = (x: number) => (x > 60 ? 12 : 2);
    const c = makeBike(59, 50, wall);
    c.vx = 5;
    let hit = 0;
    run(30, () => {
      stepBike(c, [0, 0], DT, wall, BOUNDS);
      hit = Math.max(hit, c.hit);
    });
    expect(hit).toBeGreaterThan(2);
    expect(c.crashed).toBe(0);
    expect(c.vx).toBeLessThan(0);
  });

  it("flies over a wall when it's high enough", () => {
    const wall = (x: number) => (x > 60 && x < 62 ? 4 : 2);
    const b = makeBike(55, 50, wall);
    b.z = 7;
    b.vx = 15;
    run(40, () => stepBike(b, [1, 0], DT, wall, BOUNDS));
    expect(b.x).toBeGreaterThan(62);
    expect(b.crashed).toBe(0);
  });

  it("launches off a crest taken fast, flies, and lands", () => {
    // a ramp up to a crest at x 80, then a drop back to the plain
    const ramp = (x: number) => (x < 60 ? 2 : x < 80 ? 2 + (x - 60) * 0.4 : 2);
    const b = makeBike(20, 50, ramp);
    let air = 0;
    let landed = 0;
    run(400, () => {
      stepBike(b, [1, 0], DT, ramp, BOUNDS);
      air = Math.max(air, b.air);
      landed = Math.max(landed, b.landed);
    });
    expect(air).toBeGreaterThan(0.3);
    expect(landed).toBeGreaterThan(3);
  });

  it("turns to face where it goes", () => {
    const b = makeBike(50, 50, flat);
    run(120, () => stepBike(b, [0, 1], DT, flat, BOUNDS));
    expect(b.heading).toBeCloseTo(Math.PI / 2, 1);
  });

  it("hauled round at speed, it slides: sideways, laid over, braking, then away the other way", () => {
    const b = makeBike(50, 50, flat);
    run(90, () => stepBike(b, [1, 0], DT, flat, BOUNDS));
    expect(speedOf(b)).toBeGreaterThan(BIKE.slideMin);
    let sideways = false;
    let laid = 0;
    run(120, () => {
      stepBike(b, [-1, 0], DT, flat, BOUNDS);
      if (b.slide > 0 && Math.abs(Math.cos(b.heading)) < 0.5 && b.vx > 3) sideways = true;
      laid = Math.max(laid, Math.abs(b.bank));
    });
    expect(sideways).toBe(true);
    expect(laid).toBeGreaterThan(0.5);
    expect(b.slide).toBe(0);
    expect(b.vx).toBeLessThan(-3);
    expect(Math.cos(b.heading)).toBeLessThan(-0.9);
  });

  it("slow, hauling the stick round just turns it", () => {
    const b = makeBike(50, 50, flat);
    run(10, () => stepBike(b, [1, 0], DT, flat, BOUNDS));
    run(30, () => {
      stepBike(b, [-1, 0], DT, flat, BOUNDS);
      expect(b.slide).toBe(0);
    });
  });
});

describe("hover bike, ground rising under it", () => {
  it("rises out of ground that grew under it, instead of being walled in", () => {
    let floor = 2;
    const ground = () => floor;
    const b = makeBike(50, 50, ground);
    floor = 5; // the ground drifted up under it
    run(60, () => stepBike(b, [1, 0], DT, ground, BOUNDS));
    expect(b.x).toBeGreaterThan(52);
    expect(b.z).toBeGreaterThan(5);
  });
});
