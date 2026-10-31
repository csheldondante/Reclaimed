// (round 120, PL20) The chase camera's framing at speed: fitted in time, no pumping, no lag, the lich's framing kept.
import { describe, expect, it } from 'vitest';
import { Camera } from '../../render/camera';
import { BIKE_CAMERA } from '../controllers/hoverbike';
import { Chase, DEFAULT_CHASE, fitZoom, leadFor, reach, reachAlong, type ChaseView } from './chase';

const bike = BIKE_CAMERA.chase!;

/** a 412×915 phone through the real camera (azimuth π/4, 30° elevation) */
function phone(): { cam: Camera; view: () => ChaseView } {
  const cam = new Camera();
  cam.viewportW = 412;
  cam.viewportH = 915;
  cam.target = [0, 0, 0];
  cam.zoom = 20;
  cam.update();
  const view = (): ChaseView => {
    const z = cam.zoom;
    const o = cam.project(cam.target[0], cam.target[1], 0);
    return {
      w: 412,
      h: 915,
      squash: 1 / (z * Math.hypot(...cam.screenDeltaToWorld(0, -1))),
      margin: 56,
      screenOf: (dx, dy) => {
        const q = cam.project(cam.target[0] + dx, cam.target[1] + dy, 0);
        return [(q[0] - o[0]) / z, (q[1] - o[1]) / z];
      },
    };
  };
  return { cam, view };
}

describe('chase framing (play/core/chase.ts)', () => {
  it("reads the view's squash as sin 30° and the worst reach as the phone's half width less the margin", () => {
    const v = phone().view();
    expect(v.squash).toBeCloseTo(0.5, 5);
    expect(reach(v)).toBeCloseTo(206 - 56, 5);
    // (straight up the screen reaches twice as far per px, and less the squash: (457.5 − 56) / 0.5)
    const up = phone().cam.screenDeltaToWorld(0, -1);
    const l = Math.hypot(up[0], up[1]);
    expect(reachAlong(v, up[0] / l, up[1] / l)).toBeCloseTo((457.5 - 56) / 0.5, 3);
  });

  it('keeps `ahead` seconds on screen in front of the hero, zooming out only as far as that needs', () => {
    const v = phone().view();
    for (const speed of [15, 25, 32, 46]) {
      const z = fitZoom(bike, BIKE_CAMERA.zoom, speed, v);
      const lead = Math.min(speed * bike.lead, bike.leadMax, (bike.leadShare * reach(v)) / z);
      const ahead = lead + reach(v) / z;
      if (z > bike.minZoom + 1e-9 && z < BIKE_CAMERA.zoom - 1e-9) expect(ahead).toBeCloseTo(speed * bike.ahead, 5);
      else expect(z === bike.minZoom || ahead >= speed * bike.ahead - 1e-9).toBe(true);
    }
    // at rest, the bike's own zoom; faster, wider; never past minZoom
    expect(fitZoom(bike, BIKE_CAMERA.zoom, 0, v)).toBe(BIKE_CAMERA.zoom);
    expect(fitZoom(bike, BIKE_CAMERA.zoom, 15, v)).toBeLessThan(BIKE_CAMERA.zoom);
    expect(fitZoom(bike, BIKE_CAMERA.zoom, 25, v)).toBeLessThan(fitZoom(bike, BIKE_CAMERA.zoom, 15, v));
    expect(fitZoom(bike, BIKE_CAMERA.zoom, 200, v)).toBe(bike.minZoom);
  });

  it('a big landscape screen hardly zooms out: the fit is in time, against the reach there is', () => {
    const wide: ChaseView = { w: 1920, h: 1080, squash: 0.5, margin: 56 };
    expect(fitZoom(bike, BIKE_CAMERA.zoom, 46, wide)).toBe(BIKE_CAMERA.zoom);
    expect(fitZoom(bike, BIKE_CAMERA.zoom, 46, phone().view())).toBe(bike.minZoom);
  });

  it('leads along the velocity, at most leadShare of the way to the edge that way (the hero stays on screen)', () => {
    const { view } = phone();
    const v = view();
    const [lx, ly] = leadFor(bike, 46, 0, 10, v);
    expect(ly).toBe(0);
    expect(lx).toBeGreaterThan(0);
    expect(lx).toBeLessThanOrEqual((bike.leadShare * reachAlong(v, 1, 0)) / 10 + 1e-9);
    expect(lx).toBeLessThanOrEqual(46 * bike.lead + 1e-9);
  });

  it('settles on the hero plus its lead with no lag behind a steady velocity', () => {
    const { cam, view } = phone();
    const c = new Chase(bike, BIKE_CAMERA.zoom);
    for (let i = 0; i < 600; i++) {
      c.step(1 / 60, 46, 0, 1, view());
      cam.zoom = c.zoom;
      cam.update();
    }
    const want = leadFor(bike, 46, 0, c.zoom, view());
    expect(c.lead[0]).toBeCloseTo(want[0], 3);
    expect(c.zoom).toBeCloseTo(fitZoom(bike, BIKE_CAMERA.zoom, 46, view()), 3);
  });

  it("doesn't pump: round a loop at a steady speed, and over bumps that shake the speed ±25%, the zoom holds within 3%", () => {
    const { cam, view } = phone();
    const c = new Chase(bike, BIKE_CAMERA.zoom);
    let lo = Infinity;
    let hi = 0;
    for (let i = 0; i < 1200; i++) {
      const t = i / 60;
      const a = t * 0.7; // (a loop's turn)
      const sp = 30 * (1 + 0.25 * Math.sin(t * 2 * Math.PI * 2.5));
      c.step(1 / 60, Math.cos(a) * sp, Math.sin(a) * sp, 0, view());
      cam.zoom = c.zoom;
      cam.update();
      if (t > 8) (lo = Math.min(lo, c.zoom)), (hi = Math.max(hi, c.zoom));
    }
    expect((hi - lo) / lo).toBeLessThan(0.03);
  });

  it("frames the lich as before (no `chase` in its HeroCamera): its zoom pulled back by half at full `fast`, a 0.5 s lead of at most 12 cells", () => {
    const v = phone().view();
    const c = new Chase(DEFAULT_CHASE, 30);
    for (let i = 0; i < 600; i++) c.step(1 / 60, 40, 0, 1, v);
    expect(c.zoom).toBeCloseTo(15, 3);
    expect(c.lead[0]).toBeCloseTo(12, 3);
    const d = new Chase(DEFAULT_CHASE, 30);
    for (let i = 0; i < 600; i++) d.step(1 / 60, 8, 0, 0.3, v);
    expect(d.zoom).toBeCloseTo(30 * (1 - 0.5 * 0.3), 3);
    expect(d.lead[0]).toBeCloseTo(4, 3);
  });
});
