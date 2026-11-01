import { describe, expect, it } from 'vitest';
import type { CamPose, SightWorld } from '../../api/contracts/camera';
import { BIKE_CAMERA } from '../controllers/hoverbike';
import { CamMetrics } from './metrics';
import { hiddenShare, lookAt } from './modes';
import { CAM_SPEC } from './params';
import { CameraRig, camString, parseCam } from './rig';
import { Registry } from '../../tune/registry';
import { eyeDir, hiddenBy, sliceReach } from './sight';
import { boxWorld } from './testworld';

const SCREEN = { w: 412, h: 915, margin: 56 };
const fresh = () => new Registry(CAM_SPEC).values;

/** the hero at (64, 64), at rest facing +x; a wall on the eye's side (+x+y) hides it */
const pose = (vx = 0, vy = 0): CamPose => ({ at: [64, 64, 0], floor: 0, heading: 0, vel: [vx, vy], fast: 0 });
const walled = (): SightWorld => boxWorld([[68, 60, 74, 100, 24]]);

function run(rig: CameraRig, w: SightWorld, secs: number, p = pose(), dt = 1 / 60) {
  for (let t = 0; t < secs; t += dt) rig.step(dt, p, { move: [0, 0] }, w, SCREEN);
  return rig.frame;
}

describe('?cam=', () => {
  it('names the modes, the chase always first', () => {
    expect(parseCam(null)).toEqual(['chase', 'cutaway', 'tilt']);
    expect(parseCam('chase')).toEqual(['chase']);
    expect(parseCam('rotate+dither')).toEqual(['chase', 'rotate', 'dither']);
    expect(parseCam('edge,dither cut')).toEqual(['chase', 'edge', 'dither', 'cutaway']);
    expect(() => parseCam('wobble')).toThrow(/no camera mode/);
    expect(camString(['chase'])).toBe('chase');
    expect(camString(['chase', 'tilt', 'edge'])).toBe('tilt+edge');
  });
});

describe('camera modes', () => {
  it('the wall hides the hero from the fixed view (the test is real)', () => {
    const w = walled();
    expect(hiddenBy(w, [64, 64, 1.2], eyeDir(Math.PI / 4, Math.PI / 6))).not.toBeNull();
  });

  it('chase leads along the velocity, as today', () => {
    const rig = new CameraRig(['chase'], fresh());
    rig.setHero(BIKE_CAMERA.chase, BIKE_CAMERA.zoom);
    const f = run(rig, boxWorld([]), 2, pose(20, 0));
    expect(f.view.target[0]).toBeGreaterThan(64 + 3);
    expect(f.view.zoom).toBeLessThan(BIKE_CAMERA.zoom);
    expect(f.view.azimuth).toBeCloseTo(Math.PI / 4, 6);
    expect(f.cut.slice).toBeNull();
    expect(f.cut.see).toEqual([]);
  });

  it('auto-rotate turns to an angle the hero is seen from', () => {
    const w = walled();
    const rig = new CameraRig(['rotate'], fresh());
    rig.setHero(BIKE_CAMERA.chase, BIKE_CAMERA.zoom);
    const f = run(rig, w, 3);
    expect(Math.abs(f.view.azimuth - Math.PI / 4)).toBeGreaterThan(0.2);
    expect(hiddenBy(w, [64, 64, 1.2], eyeDir(f.view.azimuth, f.view.elevation))).toBeNull();
  });

  it('auto-rotate stays put when nothing hides', () => {
    const rig = new CameraRig(['rotate'], fresh());
    const f = run(rig, boxWorld([]), 2);
    expect(f.view.azimuth).toBeCloseTo(Math.PI / 4, 6);
  });

  it('the tilt rises over a wall and settles back once it is gone', () => {
    const p = fresh();
    const rig = new CameraRig(['tilt'], p);
    // (a lower wall a little further off: seen over from higher up)
    const low = boxWorld([[74, 60, 78, 100, 12]]);
    expect(hiddenShare(low, [{ at: [64, 64, 1.2], w: 1 }], Math.PI / 4, Math.PI / 6)).toBe(1);
    const f = run(rig, low, 3);
    expect(f.view.elevation).toBeGreaterThan((35 * Math.PI) / 180);
    expect(hiddenShare(low, [{ at: [64, 64, 1.2], w: 1 }], f.view.azimuth, f.view.elevation)).toBe(0);
    const g = run(rig, boxWorld([]), 8);
    expect(g.view.elevation).toBeCloseTo((p.tilt.base * Math.PI) / 180, 2);
  });

  it('the cutaway cuts down to a short height over the hero\'s floor while it is hidden, and the hero is seen', () => {
    const p = fresh();
    const rig = new CameraRig(['cutaway'], p);
    const f = run(rig, walled(), 2);
    expect(f.cut.slice).not.toBeNull();
    expect(f.cut.slice!.z).toBeCloseTo(p.cutaway.height, 1);
    expect(f.cut.slice!.rim).toBe(p.cutaway.rim);
    expect(hiddenBy(walled(), [64, 64, 1.2], eyeDir(f.view.azimuth, f.view.elevation), f.cut)).toBeNull();
    // (in the open, it lifts away after it lingers)
    const g = run(rig, boxWorld([]), 4);
    expect(g.cut.slice).toBeNull();
  });

  it('edge-only keeps a hole round the hero always, a share of the screen', () => {
    const p = fresh();
    const rig = new CameraRig(['edge'], p);
    const f = run(rig, boxWorld([]), 1);
    const hero = f.cut.see.find((s) => s.id === 'hero');
    expect(hero).toBeDefined();
    expect(hero!.r).toBeCloseTo((p.edge.centre * Math.min(SCREEN.w, SCREEN.h)) / 2 / f.view.zoom, 3);
  });

  it('dither opens a hole only while the point is hidden', () => {
    const rig = new CameraRig(['dither'], fresh());
    expect(run(rig, boxWorld([]), 1).cut.see).toEqual([]);
    const f = run(rig, walled(), 1);
    expect(f.cut.see.find((s) => s.id === 'hero')?.r).toBeGreaterThan(5);
    expect(hiddenBy(walled(), [64, 64, 1.2], eyeDir(f.view.azimuth, f.view.elevation), f.cut)).toBeNull();
  });

  it('modes combine, and the holes stay within the renderer\'s four', () => {
    const rig = new CameraRig(parseCam('edge+dither+cutaway'), fresh());
    rig.sources.push({ id: 'foes', interests: () => [1, 2, 3].map((k) => ({ id: `foe${k}`, kind: 'enemy' as const, at: [64 + k * 3, 70, 0] as [number, number, number], weight: 0.5 })) });
    const f = run(rig, walled(), 2);
    expect(f.cut.see.length).toBeLessThanOrEqual(4);
    expect(f.cut.see[0].id).toBe('hero');
  });

  it('the metrics count the hero hidden under the chase and seen with the cutaway', () => {
    const measure = (cam: string) => {
      const rig = new CameraRig(parseCam(cam), fresh());
      const m = new CamMetrics();
      const w = walled();
      for (let i = 0; i < 180; i++) {
        const f = rig.step(1 / 60, pose(), { move: [0, 0] }, w, SCREEN);
        m.add(1 / 60, f, rig.interests, w);
      }
      return m.summary();
    };
    expect(measure('chase').hero).toBe(1);
    expect(measure('cutaway').hero).toBeLessThan(0.3);
    expect(measure('chase').turn).toBe(0);
    expect(measure('rotate').turn).toBeGreaterThan(0);
  });

  it('a dead end ahead is signalled', () => {
    const rig = new CameraRig(['chase'], fresh());
    // (a box canyon open toward -x; the hero rides in along +x)
    const w = boxWorld([
      [40, 50, 90, 54, 30],
      [40, 74, 90, 78, 30],
      [86, 50, 90, 78, 30],
    ]);
    const p: CamPose = { at: [74, 64, 0], floor: 0, heading: 0, vel: [12, 0], fast: 0.4 };
    const f = run(rig, w, 0.2, p);
    expect(f.signals).toEqual([{ id: 'ahead', kind: 'dead', at: expect.any(Array) }]);
    expect(lookAt(rig.interests[0])[2]).toBeCloseTo(1.2, 6);
  });
});

describe('the dithered cut (round 120)', () => {
  it('thins out over its fade, and the hero is still seen through it', () => {
    const e = eyeDir(Math.PI / 4, Math.PI / 6);
    const s = { z: 3, at: [64, 64] as [number, number], radius: 10, rim: 0, fade: 2, fadeR: 0.4 };
    expect(sliceReach(s, [64, 64, 2.5], e)).toBe(0);
    expect(sliceReach(s, [64, 64, 4], e)).toBeCloseTo(0.5, 6);
    expect(sliceReach(s, [64, 64, 6], e)).toBe(1);
    // (at the edge of its radius it thins out too)
    const near = sliceReach(s, [64, 64, 6], e);
    const edge = sliceReach(s, [64 + 6, 64 - 6, 6], e);
    expect(edge).toBeLessThan(near);
    const rig = new CameraRig(parseCam('cutfade+tilt'), fresh());
    const f = run(rig, walled(), 2);
    expect(f.cut.slice?.fade).toBeGreaterThan(0);
    expect(hiddenBy(walled(), [64, 64, 1.2], eyeDir(f.view.azimuth, f.view.elevation), f.cut)).toBeNull();
  });
});
