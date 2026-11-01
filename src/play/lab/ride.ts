// ---- play/lab/ride.ts -------------------------------------------------------------------------------------------
// (round 121, herolab) A hero ridden round a lab station by the autopilot with a camera rig, in Node: the camera
// metrics per mode × terrain (metrics.ts) without a browser. The hero is play's own (makeHero) on the lab's heights,
// the camera's sight the lab's columns and trees (labworld.ts). Pure.

import type { CamModeId, CamPose, V2 } from '../../api/contracts/camera';
import { Registry } from '../../tune/registry';
import { CamMetrics, type MetricsSummary } from '../camera/metrics';
import { PointsSource } from '../camera/interests';
import { CAM_SPEC } from '../camera/params';
import { CameraRig } from '../camera/rig';
import { makeHero, type PlayHeroId } from '../heroes/make';
import { input, testWorld } from '../testing';
import { Autopilot } from './autopilot';
import { labSight } from './labworld';
import { LAB_TERRAINS } from './terrains';

let SIGHT: ReturnType<typeof labSight> | null = null;
export const sight = () => (SIGHT ??= labSight());

export interface RideResult extends MetricsSummary {
  terrain: string;
  cam: string;
  who: PlayHeroId;
  /** laps of the path ridden */
  laps: number;
  /** cells a second, the mean */
  speed: number;
}

/** The rig a lab station uses: the modes and the station's points of interest as objectives. */
export function labRig(terrain: string, modes: readonly CamModeId[], values = new Registry(CAM_SPEC).values): CameraRig {
  const t = LAB_TERRAINS.find((x) => x.id === terrain);
  if (!t) throw new Error(`herolab: no terrain "${terrain}"`);
  const rig = new CameraRig(modes, values);
  if (t.pois.length) {
    const s = sight();
    rig.sources.push(new PointsSource('poi', 'objective', () => t.pois.map((p): [number, number, number] => [p[0], p[1], s.top(p[0], p[1])]), 0.6, 2));
  }
  return rig;
}

export function ride(terrain: string, modes: readonly CamModeId[], opts: { hero?: PlayHeroId; secs?: number; dt?: number; screen?: { w: number; h: number; margin: number }; tune?: Record<string, number> } = {}): RideResult {
  const heroId = opts.hero ?? 'hoverbike';
  const secs = opts.secs ?? 40;
  const dt = opts.dt ?? 1 / 30;
  const screen = opts.screen ?? { w: 412, h: 915, margin: 56 };
  const t = LAB_TERRAINS.find((x) => x.id === terrain)!;
  const s = sight();
  const world = testWorld((x, y) => s.top(x, y), { maxHeld: 4 });
  const pilot = new Autopilot(t.path);
  const st = pilot.start();
  const hero = makeHero(heroId, world, st.at);
  const reg = new Registry(CAM_SPEC);
  for (const [k, v] of Object.entries(opts.tune ?? {})) reg.set(k, v);
  const rig = labRig(terrain, modes, reg.values);
  rig.setHero(hero.camera.chase, hero.camera.zoom);
  const m = new CamMetrics();
  let last: V2 | null = null;
  let dist = 0;
  let laps = 0;
  let prog = 0;
  for (let time = 0; time < secs; time += dt) {
    const p = hero.position();
    const dir = pilot.steer([p[0], p[1]]);
    hero.update(dt, { move: dir, input: input({ dir }) });
    const q = hero.position();
    const vel: V2 = last ? [(q[0] - last[0]) / dt, (q[1] - last[1]) / dt] : [0, 0];
    if (last) dist += Math.hypot(q[0] - last[0], q[1] - last[1]);
    last = [q[0], q[1]];
    const pr = pilot.progress;
    if (pr < prog - 0.5) laps++;
    prog = pr;
    const pose: CamPose = { at: [q[0], q[1], q[2]], floor: s.top(q[0], q[1]), heading: hero.heading(), vel, fast: hero.fast() };
    const f = rig.step(dt, pose, { move: dir }, s, screen);
    // (the first second is the framing settling)
    if (time > 1) m.add(dt, f, rig.interests, s);
  }
  const sum = m.summary();
  return { ...sum, terrain, cam: modes.filter((x) => x !== 'chase').join('+') || 'chase', who: heroId, laps: laps + prog, speed: dist / secs };
}
