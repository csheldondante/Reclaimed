// (round 128, herolab) The tour with the auto camera, in Node: the bike ridden round it by the autopilot on the lab's
// land and trees; the zoom pulled back on the field, shrubs and low trees, closer in the old woods; the view tilted by
// the canyon plateau's wall, isometric (30°) in the woods; no pumping on the field.
import { describe, expect, it } from 'vitest';
import type { CamPose, V2 } from '../../api/contracts/camera';
import { Registry } from '../../tune/registry';
import { AutoMode, around } from '../camera/modes';
import { CAM_SPEC } from '../camera/params';
import { CameraRig } from '../camera/rig';
import { makeHero } from '../heroes/make';
import { input, testWorld } from '../testing';
import { Autopilot } from './autopilot';
import { sight } from './ride';
import { TOUR } from './terrains';

const P = new Registry(CAM_SPEC).values;
const legOf = (x: number, y: number): string =>
  y > 115 && x > 95 ? 'field' : y >= 93 && y < 107 && x > 176 && x < 205 ? 'shrubs' : y >= 93 && y < 107 && x > 225 ? 'low trees' : y < 85 && x > 185 ? 'woods' : y > 106 && y < 112 && x > 95 && x < 165 ? 'cliff' : x < 85 && y > 112 ? 'town' : 'between';

describe('the tour, auto camera', () => {
  it('measures what sticks up: little on the field, much in the woods; the plateau wall a cliff, the town not', () => {
    const s = sight();
    const at = (p: V2) => around(s, [p[0], p[1], s.top(p[0], p[1])], s.top(p[0], p[1]), P.auto, false);
    expect(at([130, 135]).up).toBeLessThan(0.05);
    expect(at([215, 72]).up).toBeGreaterThan(at([195, 100]).up);
    expect(at([130, 109]).wall).toBeGreaterThan(0.2);
    expect(at([70.5, 125]).wall).toBe(0);
    expect(around(s, [70.5, 125, s.top(70.5, 125)], s.top(70.5, 125), P.auto, true).wall).toBeGreaterThan(0.2);
  });

  it('rides the loop: pulled back on the field, closer in the woods, tilted only by the cliff', () => {
    const s = sight();
    const world = testWorld((x, y) => s.top(x, y), { maxHeld: 4 });
    const pilot = new Autopilot(TOUR.path);
    const hero = makeHero('hoverbike', world, pilot.start().at);
    const rig = new CameraRig(['chase', 'auto'], P);
    rig.setHero(hero.camera.chase, hero.camera.zoom);
    const auto = (rig as unknown as { all: { auto: AutoMode } }).all.auto;
    const legs = new Map<string, { k: number[]; el: number[] }>();
    let last: V2 | null = null;
    let travelled = 0;
    const dt = 1 / 30;
    for (let t = 0; t < 60; t += dt) {
      const p = hero.position();
      const dir = pilot.steer([p[0], p[1]]);
      hero.update(dt, { move: dir, input: input({ dir }) });
      const q = hero.position();
      const vel: V2 = last ? [(q[0] - last[0]) / dt, (q[1] - last[1]) / dt] : [0, 0];
      if (last) travelled += Math.hypot(q[0] - last[0], q[1] - last[1]);
      last = [q[0], q[1]];
      const pose: CamPose = { at: [q[0], q[1], q[2]], floor: s.top(q[0], q[1]), heading: hero.heading(), vel, fast: hero.fast() };
      const f = rig.step(dt, pose, { move: dir }, s, { w: 412, h: 915, margin: 56 });
      const leg = legOf(q[0], q[1]);
      const l = legs.get(leg) ?? { k: [], el: [] };
      l.k.push(auto.now);
      l.el.push((f.view.elevation * 180) / Math.PI);
      legs.set(leg, l);
    }
    const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
    const sum = Object.fromEntries([...legs].map(([k, v]) => [k, { n: v.k.length, zoomIn: +mean(v.k).toFixed(2), el: +mean(v.el).toFixed(1), elMax: +Math.max(...v.el).toFixed(1) }]));
    console.log(JSON.stringify({ travelled: Math.round(travelled), legs: sum }));
    expect(travelled).toBeGreaterThan(TOUR.path.length * 10);
    for (const k of ['field', 'woods', 'cliff', 'town']) expect(legs.has(k), k).toBe(true);
    expect(sum.woods.zoomIn).toBeGreaterThan(sum.field.zoomIn + 0.2);
    expect(sum.field.el).toBeLessThan(31);
    expect(sum.woods.el).toBeLessThan(33);
    expect(sum.cliff.elMax).toBeGreaterThan(38);
  });
});
