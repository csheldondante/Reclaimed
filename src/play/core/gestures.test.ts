import { describe, expect, it } from "vitest";
import { Stroke } from "./gestures";

/** a stroke through these points, `dt` s apart */
const stroke = (pts: [number, number][], dt: number) => {
  const s = new Stroke(pts[0], 0);
  pts.slice(1).forEach((p, i) => s.move(p, (i + 1) * dt));
  return s.end(pts.length * dt);
};

describe("reading the right thumb", () => {
  it("a short press is a tap", () => {
    expect(stroke([[100, 100], [103, 101]], 0.05).kind).toBe("tap");
  });

  it("a quick straight move is a flick, with its direction", () => {
    const g = stroke([[100, 100], [130, 100], [160, 100], [190, 100]], 0.03);
    expect(g.kind).toBe("flick");
    if (g.kind === "flick") {
      expect(g.dir[0]).toBeCloseTo(1, 5);
      expect(g.speed).toBeGreaterThan(300);
    }
  });

  it("a circle drawn either way is a circle, with which way", () => {
    const ring = (sign: number) => Array.from({ length: 26 }, (_, i) => [200 + 60 * Math.cos((sign * i * Math.PI * 2) / 24), 200 + 60 * Math.sin((sign * i * Math.PI * 2) / 24)] as [number, number]);
    const cw = stroke(ring(1), 0.03);
    const ccw = stroke(ring(-1), 0.03);
    expect(cw.kind).toBe("circle");
    expect(ccw.kind).toBe("circle");
    if (cw.kind === "circle" && ccw.kind === "circle") {
      expect(cw.ccw).toBe(false);
      expect(ccw.ccw).toBe(true);
      expect(cw.centre[0]).toBeCloseTo(200, -1);
    }
  });

  it("a circle says how many times round it went", () => {
    const loops = (n: number) => Array.from({ length: Math.round(24 * n) + 1 }, (_, i) => [200 + 60 * Math.cos((i * Math.PI * 2) / 24), 200 + 60 * Math.sin((i * Math.PI * 2) / 24)] as [number, number]);
    const once = stroke(loops(1), 0.03);
    const twice = stroke(loops(2), 0.03);
    if (once.kind !== "circle" || twice.kind !== "circle") throw new Error("not circles");
    expect(once.turns).toBeCloseTo(1, 1);
    expect(twice.turns).toBeCloseTo(2, 1);
  });

  it("a zigzag isn't a circle, and a slow move is a drag", () => {
    const zig = stroke(Array.from({ length: 20 }, (_, i) => [100 + i * 15, 100 + (i % 2) * 30] as [number, number]), 0.05);
    expect(zig.kind).toBe("drag");
  });
});
