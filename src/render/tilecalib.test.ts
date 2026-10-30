// Round 115 (tilecal): the tiles' calibration without a browser — the rate's estimator and the zoom floor's two tests
// (the rate's and the room's) on synthetic inputs. `npm test`.
import { describe, expect, it } from 'vitest';
import { TileCalibration, floorSearch, type FloorInput } from './tilecalib';

/** frames of `ms` each, `baked` tiles a frame, from t0; returns the time after */
function run(c: TileCalibration, frames: number, ms: number, baked: number, bottleneck = true, t0 = 1000): number {
  let t = t0;
  for (let i = 0; i < frames; i++) {
    t += ms;
    c.landFrame(baked, bottleneck, t);
  }
  return t;
}

describe('TileCalibration: the rate', () => {
  it('starts at the tier prior', () => {
    expect(new TileCalibration(false).rate).toBe(120);
    expect(new TileCalibration(true).rate).toBe(18);
    expect(new TileCalibration(false).stats.source).toBe('prior');
  });

  it('a second of bottlenecked frames moves the estimate 30% of the way', () => {
    const c = new TileCalibration(false);
    // (60 frames of 1000/60 ms, 1 tile each: 60 tiles/s; the first frame only starts the clock)
    run(c, 62, 1000 / 60, 1);
    expect(c.stats.blocks).toBe(1);
    expect(c.stats.source).toBe('measured');
    expect(c.rate).toBeCloseTo(120 + (60 - 120) * 0.3, 0);
  });

  it('converges on the measured rate', () => {
    const c = new TileCalibration(true);
    run(c, 60 * 30, 1000 / 60, 0.5);
    expect(c.rate).toBeCloseTo(30, 0);
    expect(c.fillTiles).toBeCloseTo(30 * 5, -1);
  });

  it('ignores frames that are not the bottleneck, stalls and frames without holes', () => {
    const c = new TileCalibration(false);
    run(c, 600, 16, 5, false);
    expect(c.stats.measuredS).toBe(0);
    // (a frame over 250 ms: a stall or a hidden tab)
    run(c, 20, 400, 5);
    expect(c.stats.measuredS).toBe(0);
    c.holes = () => false;
    run(c, 600, 16, 5);
    expect(c.stats.measuredS).toBe(0);
    expect(c.rate).toBe(120);
    c.holes = () => true;
    run(c, 200, 16, 1);
    expect(c.stats.measuredS).toBeGreaterThan(3);
  });

  it('keeps the lowest out-of-memory ceiling and asks only under it', () => {
    const c = new TileCalibration(false);
    expect(c.mayAsk(1e12)).toBe(true);
    c.oom(800e6);
    c.oom(900e6);
    expect(c.stats.ceilingBytes).toBe(800e6);
    expect(c.mayAsk(799e6)).toBe(true);
    expect(c.mayAsk(800e6)).toBe(false);
    c.oom(500e6);
    expect(c.mayAsk(600e6)).toBe(false);
  });
});

/** a screen whose ground at zoom z0 is w x h world units (a rectangle: area w·h, perimeter 2(w + h)) */
function screen(w: number, h: number, over: Partial<FloorInput> = {}): FloorInput {
  return { z0: 4, area0: w * h, perim0: 2 * (w + h), side: 64, margin: 1.35, slots: 1e6, room: 0.8, fillTiles: 1e6, frac: () => 1, ...over };
}
const regions = (I: FloorInput, z: number, m = 1) => {
  const k = (I.z0 / z) * m;
  return (I.area0 * k * k) / (I.side * I.side) + (I.perim0 * k) / I.side + 4;
};

describe('floorSearch: the zoom floor', () => {
  it('a square of side L: (L / side + 2)^2 regions, as round 112 counted', () => {
    const I = screen(640, 640);
    expect(regions(I, 4)).toBeCloseTo((640 / 64 + 2) ** 2, 6);
  });

  it("the rate's test: the widest zoom whose screen's own regions the rate fills", () => {
    const I = screen(400, 225, { fillTiles: 300 });
    const r = floorSearch(I);
    expect(r.bound).toBe('rate');
    expect(regions(I, r.floor)).toBeLessThanOrEqual(300);
    expect(regions(I, r.floor / 1.04)).toBeGreaterThan(300);
    expect(r.tiles).toBeCloseTo(regions(I, r.floor), 6);
  });

  it("the room's test: the screen with its margin, each in its part of a slot, in 80% of the atlas", () => {
    const I = screen(400, 225, { fillTiles: 2000, slots: 200, frac: () => 0.5 });
    const r = floorSearch(I);
    expect(r.bound).toBe('room');
    expect(regions(I, r.floor, 1.35) * 0.5).toBeLessThanOrEqual(200 * 0.8);
    expect(regions(I, r.floor / 1.04, 1.35) * 0.5).toBeGreaterThan(200 * 0.8);
    // (the slots the rate's own floor would take: what the atlas grows to — more than it has)
    expect(r.slotsAtRate).toBeGreaterThan(200);
    const grown = floorSearch({ ...I, slots: r.slotsAtRate });
    expect(grown.floor).toBeLessThan(r.floor);
  });

  it('a wide screen of the same area holds a closer floor (its longer edges)', () => {
    const sq = screen(300, 300, { fillTiles: 200 });
    const wd = screen(1200, 75, { fillTiles: 200 });
    expect(regions(wd, 4)).toBeGreaterThan(regions(sq, 4));
    expect(floorSearch(wd).floor).toBeGreaterThan(floorSearch(sq).floor);
  });

  it('a faster device gets a wider floor', () => {
    const slow = floorSearch(screen(400, 225, { fillTiles: 150 }));
    const fast = floorSearch(screen(400, 225, { fillTiles: 600 }));
    expect(fast.floor).toBeLessThan(slow.floor);
  });

  it('nothing binds: the search runs out at its widest', () => {
    const r = floorSearch(screen(10, 10));
    expect(r.bound).toBe('none');
    expect(r.floor).toBeLessThan(0.52);
  });
});
