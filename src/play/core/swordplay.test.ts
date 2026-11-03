// (knight, round 128) Reading the knight's right thumb: swipes strike, circles spin, the bow draws back and looses the
// other way, a quick flick on the bow rolls, a drag while spinning flings.
import { describe, expect, it } from 'vitest';
import type { Pt } from './gestures';
import { isDouble, StickyAim, THUMB, ThumbReader, type ThumbEvent, type ThumbMode } from './swordplay';

/** a stroke through these points, `dt` s apart, read for `mode`; let go at the last unless `hold` */
function stroke(mode: ThumbMode, pts: Pt[], dt: number, hold = false): { r: ThumbReader; events: ThumbEvent[] } {
  const r = new ThumbReader(mode, { at: pts[0], t: 0 });
  pts.slice(1).forEach((p, i) => r.move({ at: p, t: (i + 1) * dt }));
  if (!hold) r.end({ at: pts[pts.length - 1], t: pts.length * dt });
  return { r, events: r.drain() };
}
const line = (from: Pt, to: Pt, n: number): Pt[] => Array.from({ length: n + 1 }, (_, i) => [from[0] + ((to[0] - from[0]) * i) / n, from[1] + ((to[1] - from[1]) * i) / n]);
const ring = (sign: number, n = 26): Pt[] => Array.from({ length: n }, (_, i) => [200 + 60 * Math.cos((sign * i * Math.PI * 2) / 24), 200 + 60 * Math.sin((sign * i * Math.PI * 2) / 24)]);

describe('the sword thumb', () => {
  it('strikes the moment a swipe is 30 px long, that way, before the thumb lifts', () => {
    const { events } = stroke('sword', line([100, 100], [100, 60], 8), 0.01, true);
    expect(events).toHaveLength(1);
    const e = events[0];
    expect(e.kind).toBe('strike');
    if (e.kind === 'strike') {
      expect(e.dir[0]).toBeCloseTo(0, 5);
      expect(e.dir[1]).toBeCloseTo(-1, 5);
    }
  });

  it('a swipe shorter than 30 px strikes nothing; a short press is a tap', () => {
    expect(stroke('sword', line([100, 100], [120, 100], 4), 0.01).events.filter((e) => e.kind === 'strike')).toHaveLength(0);
    expect(stroke('sword', [[100, 100], [103, 101]], 0.05).events.map((e) => e.kind)).toEqual(['tap']);
  });

  it('strikes once a touch: a long zigzag is one slash, not a string of them', () => {
    const z: Pt[] = [[100, 100], [140, 100], [100, 120], [140, 140], [100, 160]];
    expect(stroke('sword', z, 0.02).events.filter((e) => e.kind === 'strike')).toHaveLength(1);
  });

  it('a circle drawn either way is the spin (after the swing its start made)', () => {
    for (const sign of [1, -1]) {
      const kinds = stroke('sword', ring(sign), 0.02).events.map((e) => e.kind);
      expect(kinds).toContain('spin');
      expect(kinds.filter((k) => k === 'spin')).toHaveLength(1);
    }
  });

  it('two swipes close in time and direction are a double (the lunge); far apart or turned, not', () => {
    expect(isDouble({ dir: [1, 0], t: 1 }, { dir: [1, 0], t: 1.2 })).toBe(true);
    expect(isDouble({ dir: [1, 0], t: 1 }, { dir: [1, 0], t: 1.5 })).toBe(false);
    expect(isDouble({ dir: [1, 0], t: 1 }, { dir: [0, 1], t: 1.1 })).toBe(false);
    expect(isDouble(null, { dir: [1, 0], t: 1 })).toBe(false);
  });
});

describe('the bow thumb', () => {
  it('drawn back, it aims the opposite way, the draw capped by the pull (full at 120 px)', () => {
    const { r } = stroke('bow', line([200, 200], [200, 260], 6), 0.05, true);
    expect(r.drawing).not.toBeNull();
    expect(r.drawing!.dir[0]).toBeCloseTo(0, 5);
    expect(r.drawing!.dir[1]).toBeCloseTo(-1, 5);
    expect(r.drawing!.draw).toBeCloseTo(60 / THUMB.slingFull, 5);
    const full = stroke('bow', line([200, 200], [80, 200], 12), 0.05, true).r;
    expect(full.drawing!.dir[0]).toBeCloseTo(1, 5);
    expect(full.drawing!.draw).toBe(1);
  });

  it('let go after a slow draw, it looses that way with its draw', () => {
    const { events } = stroke('bow', line([200, 200], [140, 260], 10), 0.05);
    expect(events).toHaveLength(1);
    const e = events[0];
    expect(e.kind).toBe('loose');
    if (e.kind === 'loose') {
      expect(e.dir[0]).toBeCloseTo(Math.SQRT1_2, 3);
      expect(e.dir[1]).toBeCloseTo(-Math.SQRT1_2, 3);
      expect(e.draw).toBeCloseTo(Math.hypot(60, 60) / THUMB.slingFull, 3);
    }
  });

  it('a quick long flick on the bow is a roll that way, not a shot', () => {
    const { events } = stroke('bow', line([200, 200], [280, 200], 4), 0.02);
    expect(events.map((e) => e.kind)).toEqual(['roll']);
    const e = events[0];
    if (e.kind === 'roll') expect(e.dir[0]).toBeCloseTo(1, 5);
  });

  it('pulled back inside the dead zone again, the draw eases to nothing (a release fizzles)', () => {
    const pts: Pt[] = [...line([200, 200], [200, 260], 6), ...line([200, 255], [200, 205], 5)];
    const { r } = stroke('bow', pts, 0.05, true);
    expect(r.drawing!.draw).toBe(0);
    expect(r.drawing!.dir[1]).toBeCloseTo(-1, 5);
  });
});

describe('spinning, the thumb flings', () => {
  it('a drag let go flings that way, as hard as it was long (full at 170 px)', () => {
    const { events } = stroke('fling', line([100, 100], [185, 100], 5), 0.05);
    expect(events).toHaveLength(1);
    const e = events[0];
    expect(e.kind).toBe('fling');
    if (e.kind === 'fling') {
      expect(e.dir[0]).toBeCloseTo(1, 5);
      expect(e.power).toBeCloseTo(85 / THUMB.flingFull, 5);
    }
  });
});

describe('sticky aim', () => {
  it('turns slower than the thumb over a target, and never lags it by more than 14°', () => {
    const s = new StickyAim();
    s.update(0, [0.05]);
    const a = s.update(0.1, [0.05]);
    expect(a).toBeLessThan(0.1);
    expect(a).toBeGreaterThan(0);
    let b = a;
    for (let k = 0.2; k < 1.5; k += 0.1) b = s.update(k, [0.05]);
    expect(1.4 - b).toBeLessThanOrEqual((14 * Math.PI) / 180 + 1e-6);
  });
});
