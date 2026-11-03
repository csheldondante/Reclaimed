// (knight, round 128) On foot: the run, steps and walls, slopes, drops, a lunge bleeding off, the spin's slide.
import { describe, expect, it } from 'vitest';
import { carom, FOOT, makeFoot, speedOf, stepFoot, type SlideTuning } from './foot';

const DT = 1 / 60;
const B: [number, number] = [400, 400];
const run = (n: number, f: () => void) => {
  for (let i = 0; i < n; i++) f();
};

describe('on foot', () => {
  it('comes to its run snappily: full speed within a fifth of a second', () => {
    const f = makeFoot(50, 50, () => 0);
    run(12, () => stepFoot(f, [FOOT.speed, 0], DT, () => 0, null, B));
    expect(speedOf(f)).toBeCloseTo(FOOT.speed, 3);
  });

  it('a lunge carries it a little way and bleeds back to its run', () => {
    const f = makeFoot(50, 50, () => 0);
    f.vx = 20;
    let x0 = f.x;
    run(6, () => stepFoot(f, [0, 0], DT, () => 0, null, B));
    expect(f.x - x0).toBeGreaterThan(1);
    run(60, () => stepFoot(f, [0, 0], DT, () => 0, null, B));
    expect(speedOf(f)).toBeLessThan(0.01);
    x0 = f.x;
    expect(x0).toBeLessThan(54);
  });

  it('steps up a kerb, but a cliff is a wall it slides along', () => {
    const kerb = (x: number) => (x > 55 ? 0.6 : 0);
    const f = makeFoot(50, 50, kerb);
    run(90, () => stepFoot(f, [FOOT.speed, 0], DT, kerb, null, B));
    expect(f.x).toBeGreaterThan(56);
    expect(f.z).toBeCloseTo(0.6, 1);
    const cliff = (x: number) => (x > 55 ? 5 : 0);
    const g = makeFoot(50, 50, cliff);
    run(90, () => stepFoot(g, [FOOT.speed * 0.7, FOOT.speed * 0.7], DT, cliff, null, B));
    expect(g.x).toBeLessThan(55.1);
    expect(g.y).toBeGreaterThan(54);
  });

  it('walks up a slope it can take, slower than on the flat; one too steep is a wall', () => {
    const gentle = (x: number) => (x > 52 ? (x - 52) * 0.6 : 0);
    const f = makeFoot(50, 50, gentle);
    const flat = makeFoot(50, 60, () => 0);
    run(120, () => {
      stepFoot(f, [FOOT.speed, 0], DT, gentle, null, B);
      stepFoot(flat, [FOOT.speed, 0], DT, () => 0, null, B);
    });
    expect(f.x).toBeGreaterThan(56);
    expect(f.x).toBeLessThan(flat.x - 1);
    const steep = (x: number) => (x > 52 ? (x - 52) * 2.5 : 0);
    const g = makeFoot(50, 50, steep);
    run(120, () => stepFoot(g, [FOOT.speed, 0], DT, steep, null, B));
    expect(g.x).toBeLessThan(53);
  });

  it('off a ledge it falls and lands', () => {
    const ledge = (x: number) => (x < 52 ? 6 : 0);
    const f = makeFoot(50, 50, ledge);
    let air = 0;
    let landed = 0;
    run(90, () => {
      stepFoot(f, [FOOT.speed, 0], DT, ledge, null, B);
      air = Math.max(air, f.air);
      landed = Math.max(landed, f.landed);
    });
    expect(air).toBeGreaterThan(0.3);
    expect(landed).toBeGreaterThan(10);
    expect(f.z).toBe(0);
  });

  it('won\'t wade into water deeper than it wades', () => {
    const deep = (x: number) => (x > 55 ? 2 : 0);
    const f = makeFoot(50, 50, () => 0);
    run(90, () => stepFoot(f, [FOOT.speed, 0], DT, () => 0, deep, B));
    expect(f.x).toBeLessThan(55.1);
  });

  it('sliding (the spin), it bounces off a wall and off a body, keeping most of its speed', () => {
    const slide: SlideTuning = { drag: 0.55, decel: 1.6, restitution: 0.82, steer: 0, max: 9 };
    const wall = (x: number) => (x > 55 ? 5 : 0);
    const f = makeFoot(50, 50, wall);
    f.vx = 20;
    run(30, () => stepFoot(f, [0, 0], DT, wall, null, B, FOOT, slide));
    expect(f.vx).toBeLessThan(-10);
    const g = makeFoot(50, 50, () => 0);
    g.vx = 15;
    g.x = 49.5;
    expect(carom(g, [50.2, 50], 0.9, 0.82)).toBe(true);
    expect(g.vx).toBeCloseTo(-15 * 0.82, 5);
    expect(g.x).toBeCloseTo(50.2 - 0.9, 5);
  });
});
