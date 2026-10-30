import { describe, expect, it } from "vitest";
import { ASSIST, planPass, segmentDistance, type PassTarget, type Rider } from "./intercept";

const M = ASSIST.moderate;
/** riding along +x at 15 cells/s on flat ground; left is +y */
const rider = (over: Partial<Rider> = {}): Rider => ({ at: [0, 0, 0], vel: [15, 0, 0], heading: 0, hand: 1.1, gravity: 0, ...over });
const foe = (id: number, x: number, y: number, z = 0): PassTarget => ({ id, at: [x, y, z], vel: [0, 0, 0], height: 1.2, radius: 0.4 });

describe("the bike's slash: intent to a plan", () => {
  it("swiped on the left as a target comes up on the left: the blow waits for the pass", () => {
    const { plan } = planPass(rider(), 1, [foe(1, 6, 2)], M);
    expect(plan?.id).toBe(1);
    // (6 cells at 15 cells/s: the pass is 0.4 s off)
    expect(plan!.t).toBeGreaterThan(0.3);
    expect(plan!.t).toBeLessThan(0.5);
    expect(plan!.yaw).toBeCloseTo(Math.PI / 2, 1);
  });

  it("the wrong side, or too early: no artificial hit", () => {
    expect(planPass(rider(), -1, [foe(1, 6, 2)], M)).toEqual({ plan: null, miss: "nothing that side" });
    expect(planPass(rider(), 1, [foe(1, 30, 2)], M).miss).toBe("not passing in time");
  });

  it("a little out of reach: steered alongside within the budget, not beyond it", () => {
    const near = planPass(rider(), 1, [foe(1, 6, 3.6)], M).plan!;
    expect(near.steer[1]).toBeGreaterThan(0);
    expect(near.assist).toBeGreaterThan(0);
    expect(planPass(rider(), 1, [foe(1, 6, 8)], M).miss).toBe("too far");
  });

  it("airborne over a lower target on the left: the same swipe reaches down", () => {
    const air = rider({ at: [0, 0, 2.5], vel: [15, 0, 0], gravity: 20 });
    const { plan } = planPass(air, 1, [foe(1, 6, 1.5)], M);
    expect(plan).not.toBeNull();
    expect(plan!.pitch).toBeGreaterThan(0.2);
    // much too high: a miss
    const high = rider({ at: [0, 0, 9], vel: [15, 0, 4], gravity: 20 });
    expect(planPass(high, 1, [foe(1, 6, 1.5)], M).miss).toBe("too low");
  });

  it("budgets: the same input means the same thing; a looser budget helps more", () => {
    const hard = foe(1, 6, 3.4);
    expect(planPass(rider(), 1, [hard], ASSIST.strict).plan).toBeNull();
    expect(planPass(rider(), 1, [hard], ASSIST.forgiving).plan?.id).toBe(1);
  });

  it("measures a blade's distance to a body", () => {
    expect(segmentDistance([1, 1, 0], [0, 0, 0], [2, 0, 0])).toBeCloseTo(1);
    expect(segmentDistance([3, 0, 0], [0, 0, 0], [2, 0, 0])).toBeCloseTo(1);
  });
});
