import { describe, expect, it } from 'vitest';
import type { CamPose, SightWorld } from '../api/contracts/camera';
import { CameraRig } from '../play/camera/rig';
import { boxWorld } from '../play/camera/testworld';
import { PresentMode, regionWeight } from './mode';
import { canyonProfile, CANYON_DEFAULT, FOREST_DEFAULT, forestProfile } from './profiles';
import { densestStand, rideStart, standRoute } from './stand';

const SCREEN = { w: 412, h: 915, margin: 56 };
const pose = (x: number, y: number, vx = 0, vy = 0): CamPose => ({ at: [x, y, 0], floor: 0, heading: Math.atan2(vy, vx), vel: [vx, vy], fast: Math.min(1, Math.hypot(vx, vy) / 30) });
const open = (): SightWorld => boxWorld([]);

function ride(rig: CameraRig, w: SightWorld, secs: number, p: (t: number) => CamPose, dt = 1 / 60) {
  let f = rig.step(dt, p(0), { move: [0, 0] }, w, SCREEN);
  for (let t = dt; t < secs; t += dt) f = rig.step(dt, p(t), { move: [0, 0] }, w, SCREEN);
  return f;
}

describe('region presentation (PRE1)', () => {
  it('weighs a region: 1 inside, 0 past its edge, smooth between', () => {
    const r = { id: 'r', centre: [0, 0] as [number, number], radius: 10, edge: 10 };
    expect(regionWeight(r, 5, 0)).toBe(1);
    expect(regionWeight(r, 25, 0)).toBe(0);
    const m = regionWeight(r, 15, 0);
    expect(m).toBeGreaterThan(0.3);
    expect(m).toBeLessThan(0.7);
  });

  it('outside its region it changes nothing: the frame as the rig alone makes it, no present look', () => {
    const a = new CameraRig(['chase']);
    const b = new CameraRig(['chase']);
    b.setPresent(new PresentMode(forestProfile({ ...FOREST_DEFAULT, vis: ['dither', 'stipple'], light: true }), { id: 'r', centre: [500, 500], radius: 10, edge: 10 }));
    const fa = ride(a, open(), 3, () => pose(64, 64));
    const fb = ride(b, open(), 3, () => pose(64, 64));
    expect(fb.view.zoom).toBeCloseTo(fa.view.zoom, 6);
    expect(fb.view.elevation).toBeCloseTo(fa.view.elevation, 6);
    expect(fb.view.target).toEqual(fa.view.target);
    expect(fb.present ?? null).toBeNull();
  });

  it('inside, it eases the zoom in over the transition and writes the canopy treatment', () => {
    const rig = new CameraRig(['chase']);
    const m = new PresentMode(forestProfile({ ...FOREST_DEFAULT, vis: ['dither'], seconds: 2 }), { id: 'r', centre: [64, 64], radius: 10, edge: 5 });
    rig.setPresent(m);
    const half = ride(rig, open(), 1, () => pose(64, 64));
    expect(m.w).toBeGreaterThan(0.4);
    expect(m.w).toBeLessThan(0.6);
    const z1 = half.view.zoom;
    const full = ride(rig, open(), 2, () => pose(64, 64));
    expect(m.w).toBe(1);
    expect(full.view.zoom).toBeCloseTo(FOREST_DEFAULT.zoom, 3);
    expect(z1).toBeLessThan(full.view.zoom);
    expect(full.present?.canopy.dither).toBe(true);
    expect(full.present?.weight).toBe(1);
  });

  it('the transition styles: zoom on at once, the iris and the dissolve by the weight', () => {
    for (const [style, even] of [['zoomDither', 0], ['crossfade', 1]] as const) {
      const rig = new CameraRig(['chase']);
      const m = new PresentMode(forestProfile({ ...FOREST_DEFAULT, vis: ['stipple'], transition: style, seconds: 2 }), null);
      rig.setPresent(m);
      const f = ride(rig, open(), 0.5, () => pose(64, 64));
      expect(f.present!.even).toBe(even);
      expect(f.present!.weight).toBeLessThan(0.5);
    }
    const rig = new CameraRig(['chase']);
    rig.setPresent(new PresentMode(forestProfile({ ...FOREST_DEFAULT, vis: ['stipple'], transition: 'zoom', seconds: 2 }), null));
    expect(ride(rig, open(), 0.2, () => pose(64, 64)).present!.weight).toBe(1);
  });

  it('route-facing: the view turns behind the heading without flips (rate-limited, no jumps over 3° a frame)', () => {
    const rig = new CameraRig(['chase']);
    rig.setPresent(new PresentMode(canyonProfile({ ...CANYON_DEFAULT, cam: 'route' }), null));
    // a ride round a circle of radius 30 at 15 cells/s
    const p = (t: number) => {
      const a = (t * 15) / 30;
      return pose(64 + Math.cos(a) * 30, 64 + Math.sin(a) * 30, -Math.sin(a) * 15, Math.cos(a) * 15);
    };
    let last: number | null = null;
    let worst = 0;
    const dt = 1 / 60;
    for (let t = 0; t < 12; t += dt) {
      const f = rig.step(dt, p(t), { move: [0, 0] }, open(), SCREEN);
      if (last !== null) worst = Math.max(worst, Math.abs(Math.atan2(Math.sin(f.view.azimuth - last), Math.cos(f.view.azimuth - last))));
      last = f.view.azimuth;
    }
    expect((worst * 180) / Math.PI).toBeLessThan(3);
    // (settled: the eye behind the heading within the spring's lag)
    const f = rig.frame;
    const h = Math.atan2(p(12).vel[1], p(12).vel[0]);
    const off = Math.abs(Math.atan2(Math.sin(f.view.azimuth - (h + Math.PI)), Math.cos(f.view.azimuth - (h + Math.PI))));
    expect((off * 180) / Math.PI).toBeLessThan(45);
  });

  it('finds the densest birch stand and a route through it', () => {
    const trees = [];
    for (let i = 0; i < 30; i++) trees.push({ x: 100 + (i % 6) * 3, y: 100 + Math.floor(i / 6) * 3, species: 'birch' });
    for (let i = 0; i < 10; i++) trees.push({ x: 10 + i * 4, y: 10, species: 'birch' });
    trees.push({ x: 102, y: 102, species: 'conifer' });
    const s = densestStand(trees)!;
    expect(s.birches).toBeGreaterThanOrEqual(25);
    expect(Math.hypot(s.at[0] - 107.5, s.at[1] - 106)).toBeLessThan(4);
    const route = standRoute(s.at, () => true);
    const d = route.map((p) => Math.hypot(p.at[0] - s.at[0], p.at[1] - s.at[1]));
    expect(Math.min(...d)).toBeLessThan(6);
    expect(d[0]).toBeGreaterThan(30);
    expect(route.some((p) => p.speed < 1)).toBe(true);
    const k = rideStart(route, s.at, 24);
    expect(Math.hypot(route[k].at[0] - s.at[0], route[k].at[1] - s.at[1])).toBeGreaterThanOrEqual(24);
  });
});
