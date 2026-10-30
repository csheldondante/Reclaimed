import { describe, expect, it } from "vitest";
import { makeBike } from "./bike";
import { LEVITATE, stepLevitate } from "./levitate";

const DT = 1 / 60;
const BOUNDS: [number, number] = [200, 200];
const t = { ...LEVITATE, hover: 2 };

describe("levitation", () => {
  it("holds its height still over a slope, and doesn't slide down it", () => {
    const slope = (x: number) => x * 0.5;
    const b = makeBike(50, 50, slope);
    for (let i = 0; i < 300; i++) stepLevitate(b, [0, 0], DT, slope, BOUNDS, t);
    // (its height counts the land round it: a little over the slope's uphill side)
    expect(b.z - slope(b.x)).toBeGreaterThanOrEqual(2 - 1e-3);
    expect(b.z - slope(b.x)).toBeLessThanOrEqual(2 + 0.5 * LEVITATE.foot + 1e-3);
    expect(Math.abs(b.x - 50)).toBeLessThan(1e-6);
    expect(b.vz).toBeCloseTo(0, 3);
  });

  it("rises onto a ledge without overshooting it", () => {
    const ledge = (x: number) => (x > 52 ? 4 : 0);
    const b = makeBike(48, 50, ledge);
    b.z = 2;
    let top = 0;
    for (let i = 0; i < 240; i++) {
      stepLevitate(b, [1, 0], DT, ledge, BOUNDS, t);
      top = Math.max(top, b.z);
    }
    expect(b.x).toBeGreaterThan(55);
    expect(top).toBeLessThanOrEqual(6 + 1e-3);
    expect(b.z).toBeCloseTo(6, 2);
  });

  it("starts rising before it's over a rise ahead, and never dips into the ground", () => {
    const wall = (x: number) => (x > 52 ? 3 : 0);
    const b = makeBike(46, 50, wall);
    b.z = 2;
    let risenBefore = false;
    for (let i = 0; i < 240; i++) {
      stepLevitate(b, [1, 0], DT, wall, BOUNDS, t);
      if (b.x < 52 && b.z > 2.3) risenBefore = true;
      expect(b.z).toBeGreaterThan(wall(b.x));
    }
    expect(risenBefore).toBe(true);
  });

  it("floats up a cliff first, then over it, climbing at a steady pace", () => {
    const cliff = (x: number) => (x > 52 ? 8 : 0);
    const b = makeBike(49, 50, cliff);
    b.z = 2;
    const climbs: number[] = [];
    for (let i = 0; i < 360; i++) {
      stepLevitate(b, [1, 0], DT, cliff, BOUNDS, t);
      if (b.x > 52) expect(b.z).toBeGreaterThanOrEqual(8 + LEVITATE.clear);
      else if (b.z > 4 && b.z < 7) climbs.push(b.vz);
    }
    expect(climbs.length).toBeGreaterThan(10);
    for (const v of climbs) expect(v).toBeCloseTo(LEVITATE.climb, 5);
    expect(b.x).toBeGreaterThan(55);
    expect(b.z).toBeCloseTo(10, 1);
  });

  it("climbs a cliff only while it's pushed at, as fast as it's pushed, and settles back when let go", () => {
    const cliff = (x: number) => (x > 52 ? 8 : 0);
    const b = makeBike(51.5, 50, cliff);
    b.z = 2;
    for (let i = 0; i < 120; i++) stepLevitate(b, [0.5, 0], DT, cliff, BOUNDS, t);
    expect(b.vz).toBeCloseTo(LEVITATE.climb * 0.5, 5);
    const z = b.z;
    for (let i = 0; i < 300; i++) stepLevitate(b, [0, 0], DT, cliff, BOUNDS, t);
    expect(b.z).toBeLessThan(z);
    expect(b.z).toBeLessThan(2 + LEVITATE.step + 0.1);
  });

  it("slides along a cliff's foot as it rises", () => {
    const cliff = (x: number) => (x > 52 ? 8 : 0);
    const b = makeBike(51, 50, cliff);
    b.z = 2;
    for (let i = 0; i < 20; i++) stepLevitate(b, [0.7, 0.7], DT, cliff, BOUNDS, t);
    expect(b.y).toBeGreaterThan(50.5);
  });

  it("comes to a stop when the stick's let go", () => {
    const flat = () => 0;
    const b = makeBike(50, 50, flat);
    for (let i = 0; i < 60; i++) stepLevitate(b, [1, 0], DT, flat, BOUNDS, t);
    expect(b.vx).toBeGreaterThan(3);
    for (let i = 0; i < 120; i++) stepLevitate(b, [0, 0], DT, flat, BOUNDS, t);
    expect(Math.hypot(b.vx, b.vy)).toBeLessThan(0.05);
  });
});
