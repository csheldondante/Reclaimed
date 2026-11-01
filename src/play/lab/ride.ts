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
import type { Params } from '../../api/contracts/play';
import { BIKE_DEFAULTS } from '../controllers/hoverbike';
import { steerAssist } from '../core/steer';
import type { BikeHero } from '../heroes/bike';
import { applyTurn, HANDLING_SPEC, steerParams, useHandling, type HandlingId } from './handling';

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

// ---- (round 120, PL30) the bike's handling variants, measured -------------------------------------------------------

export interface HandlingResult {
  terrain: string;
  variant: string;
  /** barricade hits (glances and crashes) a minute, and crashes a minute */
  hits: number;
  crashes: number;
  /** cells a second, the mean over the ride */
  speed: number;
  /** seconds a lap (the path's length over the progress made) */
  lap: number;
  /** share of frames the stick fought the assist (a strong steer held off a bend it wanted) */
  fight: number;
  /** share of frames the assist bent the stick */
  bent: number;
}

/**
 * The bike ridden round a station by a sloppy rider — a thumb, not the autopilot's precision: it re-aims every
 * `every` s at a point `look` cells on, in one of 16 directions, full stick — with the handling variants on.
 */
export function rideHandling(terrain: string, ids: readonly HandlingId[], opts: { secs?: number; dt?: number; look?: number; every?: number; starts?: number } = {}): HandlingResult {
  // (a ride is a noisy sample — one wedge against a wall dominates it: the mean of rides from `starts` points round the loop)
  const n = opts.starts ?? 4;
  const rows = Array.from({ length: n }, (_, k) => rideOnce(terrain, ids, opts, k / n));
  const mean = (f: (r: HandlingResult) => number) => rows.reduce((a, r) => a + f(r), 0) / n;
  return { terrain, variant: ids.join('+'), hits: mean((r) => r.hits), crashes: mean((r) => r.crashes), speed: mean((r) => r.speed), lap: n / rows.reduce((a, r) => a + 1 / r.lap, 0), fight: mean((r) => r.fight), bent: mean((r) => r.bent) };
}

function rideOnce(terrain: string, ids: readonly HandlingId[], opts: { secs?: number; dt?: number; look?: number; every?: number }, from: number): HandlingResult {
  const secs = opts.secs ?? 60;
  const dt = opts.dt ?? 1 / 60;
  const t = LAB_TERRAINS.find((x) => x.id === terrain)!;
  const s = sight();
  const world = testWorld((x, y) => s.top(x, y), { maxHeld: 4 });
  const pilot = new Autopilot(t.path, opts.look ?? 6);
  const st = pilot.start(Math.floor(from * t.path.length));
  const reg = new Registry(HANDLING_SPEC);
  useHandling(reg, ids);
  const params = { ...BIKE_DEFAULTS } as unknown as Params;
  applyTurn(reg.values, params);
  const hero = makeHero('hoverbike', world, st.at, params) as BikeHero;
  const assist = steerParams(reg.values);
  const every = opts.every ?? 0.25;
  let stick: V2 = [0, 0];
  let vel: V2 = [0, 0];
  let aimT = 0;
  let last: V2 | null = null;
  let dist = 0;
  let hits = 0;
  let crashes = 0;
  let wasHit = false;
  let fought = 0;
  let bent = 0;
  let frames = 0;
  let laps = 0;
  let prog = 0;
  for (let time = 0; time < secs; time += dt) {
    const p = hero.position();
    aimT -= dt;
    if (aimT <= 0) {
      aimT = every;
      const d = pilot.steer([p[0], p[1]]);
      const m = Math.hypot(d[0], d[1]);
      const a = Math.round(Math.atan2(d[1], d[0]) / (Math.PI / 8)) * (Math.PI / 8);
      stick = m > 0.05 ? [Math.cos(a) * Math.min(1, m * 1.4), Math.sin(a) * Math.min(1, m * 1.4)] : [0, 0];
    } else pilot.steer([p[0], p[1]]);
    let dir = stick;
    if (last) {
      const o = steerAssist(stick, [p[0], p[1]], vel, world.top, [], hero.profileClimb(), assist);
      dir = o.dir;
      if (o.by && o.bend !== 0) bent++;
      if (o.fought) fought++;
    }
    hero.update(dt, { move: dir, input: input({ dir }) });
    frames++;
    const q = hero.position();
    dist += Math.hypot(q[0] - p[0], q[1] - p[1]);
    vel = [(q[0] - p[0]) / dt, (q[1] - p[1]) / dt];
    last = [q[0], q[1]];
    const b = hero.drive;
    if (b.hit > 0 && !wasHit) hits++;
    wasHit = b.hit > 0;
    if (b.crash > 0) crashes++;
    const pr = pilot.progress;
    if (pr < prog - 0.5) laps++;
    prog = pr;
  }
  const done = laps + ((prog - from + 1) % 1);
  const min = secs / 60;
  return { terrain, variant: ids.join('+'), hits: hits / min, crashes: crashes / min, speed: dist / secs, lap: done > 0 ? secs / done : Infinity, fight: fought / frames, bent: bent / frames };
}
