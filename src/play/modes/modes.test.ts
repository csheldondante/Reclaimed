// (round 128b, playmodes) The play modes: the game's pick and the brief auto that hands back on a touch; what the stick
// means in the lane and the profile; the course's loop in its order.
import { describe, expect, it } from 'vitest';
import type { V2 } from '../../api/contracts/camera';
import { AREAS, areaStart, BOULDERS, courseColumn, ROUTE } from '../course/course';
import { facingAzimuth, MODES, ModeSwitcher, modeStick, type ModeId } from './modes';

describe('ModeSwitcher', () => {
  const pick = (p: V2): ModeId => (p[0] < 10 ? 'open' : 'canyon');

  it('picks the mode from where the hero is, steers for the entry seconds, then hands back', () => {
    const s = new ModeSwitcher(pick, [0, 0]);
    expect(s.mode).toBe('open');
    let st = s.step(0.1, [20, 0], false);
    expect(st).toMatchObject({ mode: 'canyon', changed: true, auto: true });
    for (let t = 0; t < MODES.canyon.entry.autoSeconds - 0.3; t += 0.1) st = s.step(0.1, [20, 0], false);
    expect(st.auto).toBe(true);
    for (let k = 0; k < 5; k++) st = s.step(0.1, [20, 0], false);
    expect(st.auto).toBe(false);
    expect(st.changed).toBe(false);
  });

  it('hands back the moment the player touches the screen', () => {
    const s = new ModeSwitcher(pick, [0, 0]);
    expect(s.step(0.1, [20, 0], false).auto).toBe(true);
    expect(s.step(0.016, [20, 0], true).auto).toBe(false);
    // (and stays the player's: no auto again until the next change)
    expect(s.step(0.1, [20, 0], false).auto).toBe(false);
  });

  it('a touch on the very step the mode changes hands back at once', () => {
    const s = new ModeSwitcher(pick, [0, 0]);
    expect(s.step(0.1, [20, 0], true)).toMatchObject({ mode: 'canyon', changed: true, auto: false });
  });

  it('a forced mode holds wherever the hero goes; a teleport has no brief auto', () => {
    const s = new ModeSwitcher(pick, [0, 0]);
    s.forced = 'woods';
    expect(s.step(0.1, [0, 0], false).mode).toBe('woods');
    expect(s.step(0.1, [20, 0], false).mode).toBe('woods');
    s.forced = null;
    s.reset([20, 0]);
    expect(s.step(0.1, [20, 0], false)).toMatchObject({ mode: 'canyon', auto: false, changed: false });
  });
});

describe('modeStick', () => {
  const here = { tan: [1, 0] as V2, nrm: [0, 1] as V2, off: 0 };

  it('free: the stick as it is', () => {
    expect(modeStick(MODES.open, [0.3, -0.4], here, false)).toEqual([0.3, -0.4]);
  });

  it('lane: runs on along the route by itself; the stick across moves across at once', () => {
    const none = modeStick(MODES.canyon, [0, 0], here, false);
    expect(none[0]).toBeCloseTo(MODES.canyon.assists.speed);
    expect(none[1]).toBe(0);
    const left = modeStick(MODES.canyon, [0, 1], here, false);
    expect(left[1]).toBeGreaterThan(0.5);
    expect(left[0]).toBeGreaterThan(0.1);
    // (past the lane's edge it's pulled back in)
    const out = modeStick(MODES.canyon, [0, 0], { ...here, off: MODES.canyon.assists.laneHalf + 2 }, false);
    expect(out[1]).toBeLessThan(0);
    // (the brief auto: the player's stick ignored)
    expect(modeStick(MODES.canyon, [0, 1], here, true)[1]).toBe(0);
  });

  it('profile: the stick along the route runs forward or back; the hero is held on the line', () => {
    const fwd = modeStick(MODES.woods, [1, 0.6], here, false);
    expect(fwd[0]).toBeGreaterThan(0.5);
    expect(Math.abs(fwd[1])).toBeLessThan(1e-9);
    expect(modeStick(MODES.woods, [-1, 0], here, false)[0]).toBeLessThan(-0.5);
    expect(modeStick(MODES.woods, [0, 0], { ...here, off: 1 }, false)[1]).toBeLessThan(0);
    // (the brief auto runs on at the mode's speed)
    expect(modeStick(MODES.woods, [0, 0], here, true)[0]).toBeCloseTo(MODES.woods.assists.speed);
  });

  it('the facing puts the eye behind the way, or off its side', () => {
    expect(facingAzimuth('behind', [1, 0])).toBeCloseTo(Math.PI);
    expect(facingAzimuth('right', [1, 0])).toBeCloseTo(-Math.PI / 2);
    expect(facingAzimuth('left', [1, 0])).toBeCloseTo(Math.PI / 2);
  });
});

describe('the course', () => {
  it('one closed loop, the areas in their order, each a long stretch', () => {
    const order: string[] = [];
    for (const p of ROUTE.pts) if (order[order.length - 1] !== p.area) order.push(p.area);
    expect(order).toEqual(AREAS.map((a) => a.id));
    for (const a of AREAS) {
      const [s0, s1] = ROUTE.span(a.id);
      expect(s1 - s0, a.id).toBeGreaterThan(70);
    }
    // (no jumps between points)
    for (let k = 0; k < ROUTE.pts.length; k++) {
      const a = ROUTE.pts[k].at;
      const b = ROUTE.pts[(k + 1) % ROUTE.pts.length].at;
      expect(Math.hypot(b[0] - a[0], b[1] - a[1])).toBeLessThan(3);
    }
  });

  it('the road is passable: no step over 1.2 cells along it, outside the canyon boulders', () => {
    let worst = 0;
    let at: unknown = null;
    for (let s = 0; s < ROUTE.length; s += 0.5) {
      const p = ROUTE.pointAt(s).at;
      const q = ROUTE.pointAt(s + 0.5).at;
      if (BOULDERS.some((b) => Math.hypot(p[0] - b[0], p[1] - b[1]) < 2.5 || Math.hypot(q[0] - b[0], q[1] - b[1]) < 2.5)) continue;
      const d = Math.abs(courseColumn(q[0], q[1]).top - courseColumn(p[0], p[1]).top);
      if (d > worst) (worst = d), (at = [s, ROUTE.pointAt(s).area, p[0], p[1]]);
    }
    expect(worst, JSON.stringify(at)).toBeLessThan(1.2);
  });

  it('every area start is on its own stretch', () => {
    for (const a of AREAS) expect(ROUTE.nearest(areaStart(a.id).at).area).toBe(a.id);
  });
});
