import { describe, expect, it } from 'vitest';
import type { CamView } from '../../api/contracts/camera';
import { Camera } from '../../render/camera';
import { wayAhead } from './ahead';
import { cutOpens, eyeDir, hiddenBy, screenOf } from './sight';
import { boxWorld } from './testworld';

const FIXED = { az: Math.PI / 4, el: (30 * Math.PI) / 180 };

describe('sight', () => {
  it('a wall between the point and the eye hides it; behind the eye it does not', () => {
    // (the eye is toward +x+y: a wall at larger x+y hides, one at smaller doesn't)
    const w = boxWorld([[70, 50, 74, 90, 20]]);
    const e = eyeDir(FIXED.az, FIXED.el);
    const h = hiddenBy(w, [64, 64, 0.5], e);
    expect(h).not.toBeNull();
    expect(h!.height).toBeCloseTo(19.5, 5);
    const w2 = boxWorld([[50, 50, 54, 90, 20]]);
    expect(hiddenBy(w2, [64, 64, 0.5], e)).toBeNull();
  });

  it('looking from straight above, only a roof hides', () => {
    const w = boxWorld([[70, 50, 74, 90, 20]]);
    expect(hiddenBy(w, [64, 64, 0.5], eyeDir(FIXED.az, Math.PI / 2 - 1e-3))).toBeNull();
  });

  it('a slice over the hero opens the wall; a slice too small on screen does not', () => {
    const w = boxWorld([[70, 50, 74, 90, 20]]);
    const e = eyeDir(FIXED.az, FIXED.el);
    // (the wall is cut down to 3 cells: the eye's line from the hero's chest passes over what's left)
    const all = { slice: { z: 3, at: [64, 64] as [number, number], radius: 0, rim: 0.3 }, see: [] };
    expect(hiddenBy(w, [64, 64, 1.2], e, all)).toBeNull();
    const tiny = { slice: { z: 3, at: [10, 10] as [number, number], radius: 2, rim: 0.3 }, see: [] };
    expect(hiddenBy(w, [64, 64, 1.2], e, tiny)).not.toBeNull();
  });

  it('a hole round the point opens what is in front of it, not what is beside it', () => {
    const e = eyeDir(FIXED.az, FIXED.el);
    const cut = { slice: null, see: [{ id: 'hero', at: [64, 64, 0] as [number, number, number], r: 6 }] };
    // (in front of the hero along the eye, over its base: opened)
    expect(cutOpens(cut, [64 + e[0] * 5, 64 + e[1] * 5, e[2] * 5], e)).toBe(true);
    // (behind it: not)
    expect(cutOpens(cut, [64 - e[0] * 5, 64 - e[1] * 5, 1], e)).toBe(false);
    // (far to the side on the screen: not)
    expect(cutOpens(cut, [64 + 20, 64 - 20, 3], e)).toBe(false);
    const w = boxWorld([[70, 50, 74, 90, 20]]);
    expect(hiddenBy(w, [64, 64, 0.5], e, cut)).toBeNull();
  });

  it('screenOf is the camera projection', () => {
    const cam = new Camera();
    cam.viewportW = 400;
    cam.viewportH = 800;
    cam.zoom = 12;
    cam.target = [50, 40, 6];
    cam.azimuth = 1.1;
    cam.update();
    const v: CamView = { target: [50, 40, 6], zoom: 12, azimuth: 1.1, elevation: FIXED.el, w: 400, h: 800, margin: 0 };
    for (const p of [[50, 40, 6], [60, 41, 3], [45, 30, 12]] as [number, number, number][]) {
      const a = cam.project(...p);
      const b = screenOf(v, p);
      expect(b[0]).toBeCloseTo(a[0], 3);
      expect(b[1]).toBeCloseTo(a[1], 3);
    }
  });

  it('the camera takes an elevation (top-down tilt) and projects with it', () => {
    const cam = new Camera();
    cam.viewportW = 400;
    cam.viewportH = 800;
    cam.zoom = 10;
    cam.target = [50, 40, 6];
    cam.elevation = 1.2;
    cam.update();
    const v: CamView = { target: [50, 40, 6], zoom: 10, azimuth: Math.PI / 4, elevation: 1.2, w: 400, h: 800, margin: 0 };
    const a = cam.project(55, 47, 9);
    const b = screenOf(v, [55, 47, 9]);
    expect(b[0]).toBeCloseTo(a[0], 3);
    expect(b[1]).toBeCloseTo(a[1], 3);
    // (and a ground step comes back through screenDeltaToWorld at that elevation)
    const s0 = cam.project(50, 40, 6);
    const s1 = cam.project(53, 44, 6);
    const d = cam.screenDeltaToWorld(s1[0] - s0[0], s1[1] - s0[1]);
    expect(d[0]).toBeCloseTo(3, 3);
    expect(d[1]).toBeCloseTo(4, 3);
  });
});

describe('the way ahead', () => {
  const O = { dist: 40, step: 1, climb: 1, fan: Math.PI / 12, maxTurn: (2 * Math.PI) / 3, bounds: [128, 128] as [number, number], margin: 1 };

  it('open land goes on', () => {
    const w = boxWorld([]);
    const a = wayAhead(w.top, [20, 64], 0, O);
    expect(a.open).toBe(true);
    expect(a.end[0]).toBeCloseTo(60, 5);
  });

  it('round a cliff corner it goes on, and says it turned', () => {
    // (a wall across the way ahead from y 40 to 128: the way swings to the -y side and goes on)
    const w = boxWorld([[40, 40, 50, 128, 30]]);
    const a = wayAhead(w.top, [20, 64], 0, O);
    expect(a.open).toBe(true);
    expect(Math.abs(a.turned)).toBeGreaterThan(Math.PI / 6);
  });

  it('a box canyon is a dead end', () => {
    // (walls on three sides: north, south and the end)
    const w = boxWorld([
      [10, 50, 60, 54, 30],
      [10, 74, 60, 78, 30],
      [56, 50, 60, 78, 30],
    ]);
    const a = wayAhead(w.top, [30, 64], 0, O);
    expect(a.open).toBe(false);
    expect(a.end[0]).toBeGreaterThan(48);
  });

  it('a slope it can ride is no wall; a steeper one is', () => {
    const ramp = (k: number) => (x: number) => Math.max(0, (x - 30) * k);
    expect(wayAhead((x) => ramp(0.8)(x), [20, 64], 0, O).open).toBe(true);
    // (a corridor that ends in a ramp too steep: a dead end)
    const steep = wayAhead((x, y) => (y > 58 && y < 70 ? ramp(3)(x) : 99), [20, 64], 0, O);
    expect(steep.open).toBe(false);
  });
});
