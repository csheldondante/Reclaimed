// The level's tools, wired once at attach: the HUD and the powers (their probes of the world), the animals and birds
// the valley opens with, the director, agents, traits and inhabitants, and the sandbox's physics, lava, editor,
// overlays and integrity callbacks; the test beds' panels. API: attachTools(scene). Sets the scene's fields only.
import { Powers } from '../../game/powers';
import { Director } from '../../game/director';
import { loadLevelProgress } from '../../game/progress';
import { Editor } from '../../ui/editor';
import { PK } from '../../sim/particles';
import { installPhysics } from '../../physics/install';
import { installAgents } from '../../agents/install';
import { installInhabitants } from '../../inhabitants/install';
import { installTraits } from '../../traits/install';
import { registerSlice } from '../../game/traits/modules';
import { Hud } from '../../ui/hud';
import { Sleep } from '../../sim/sleep';
import { rockbodyFor } from '../../game/rockbodies';
import { TUNE } from '../../tune/params';
import { Integrity } from '../../game/integrity';
import { WorldVox } from '../../game/fracture';
import { MAT } from '../../world/materials';
import { cellAt, cellPos, poiWorld, ROW_H } from '../../world/lattice';
import { sendBuilders } from './town-tools';
import { undo } from './sandbox-tools';
import { mountLab, mountNoiseLab } from './labs';
import type { LevelScene } from '../level';

/** the HUD, powers, life, and (sandbox) the physics, editor and integrity: the first part of attach */
export function attachTools(scene: LevelScene): void {
  const { core, host, audio } = scene;
  const { camera, sim, weather, globals, map, dims } = core;
  const readSurface = async () => new Uint32Array((await core.readBuffer('surface')).buffer);

  scene.hud = new Hud(host.ui, (on) => (scene.lensOn = on));
  scene.powers = new Powers({
    weather,
    audio,
    hud: scene.hud,
    particles: sim.particles,
    globals,
    camera,
    dims,
    readSurface,
    heightAt: scene.heightAt,
    birdsFlushed: async () => new Uint32Array((await core.readBuffer('particleCounters')).buffer)[1],
    waterAt: (x, y) => {
      const [cx, cy] = cellAt(x, y);
      return cx < 0 || cy < 0 || cx >= dims.w || cy >= dims.h ? 0 : (scene.waterCache?.[core.ring.i(cx, cy)] ?? 0);
    },
  });
  // tapped metal rings by its size: count the metal voxels connected to the
  // tapped one (a capped flood fill on a read-back of the layers; round 20)
  scene.powers.metalSize = async (x, y, z) => {
    const w = new WorldVox(core.packed, new Uint32Array((await core.readBuffer('layers')).buffer));
    const metal = (m: number) => m === MAT.Rust || m === MAT.Steel;
    let start: [number, number, number] | undefined;
    for (const zz of [z, z - 1, z + 1]) if (metal(w.matAt(x, y, zz))) start = [x, y, zz];
    if (!start) return 1;
    const seen = new Set<string>([start.join(',')]);
    const stack = [start];
    while (stack.length && seen.size < 3000) {
      const [a, b, c] = stack.pop()!;
      for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
        const k = `${a + dx},${b + dy},${c + dz}`;
        if (seen.has(k) || !metal(w.matAt(a + dx, b + dy, c + dz))) continue;
        seen.add(k);
        stack.push([a + dx, b + dy, c + dz]);
      }
    }
    return seen.size;
  };

  // a few animals already live in the one healthy corner when the level opens
  const hz = map.surface[core.ring.i(map.poi.healthy[0], map.poi.healthy[1])];
  const [hx, hy] = poiWorld(map.poi.healthy);
  sim.particles.burst({ kind: PK.Rabbit, x: hx, y: hy, z: hz + 0.3, count: 4, speed: 1, spread: 4 });
  sim.particles.burst({ kind: PK.Deer, x: hx + 2, y: hy - 2, z: hz + 0.4, count: 2, speed: 1, spread: 3 });
  // birds already perch in its trees (they look for crowns as they arrive)
  sim.particles.burst({ kind: PK.Bird, x: hx, y: hy, z: hz + 8, count: 5, speed: 3, spread: 3 });
  scene.director = new Director(camera);
  const p = host.params;
  scene.intro = !scene.story && !!scene.level.intro && (p.get('tutorial') === '1' || (p.get('tutorial') !== '0' && p.get('skipmenu') !== '1' && loadLevelProgress(scene.level.id) === 0));
  scene.agents = installAgents(core);
  // (LW1) traits and effects on the agents: the engine's stage, the game's rules (the slice: healing vs necromancy).
  // Its world effects (a sanctuary's growth and mending) wake the land they land on: sleeping chunks don't tick
  scene.traits = installTraits(core, scene.agents, { onWorld: (x, y, r) => scene.sleep?.wake(x, y, r + 8, Sleep.EVENT_S, performance.now() / 1000) });
  registerSlice(scene.traits);
  // (round 117, inhabitants: ?life=1|dragon|town|viewer — creatures with bodies round the camera; src/inhabitants/install.ts)
  if (host.params.get('life')) scene.inhabitants = installInhabitants(core);
  if (scene.level.sandbox) {
    // the physics voxels (one GPU solver for every material, docs/PHYSICS.md)
    // and lava; the map's own ruins stay terrain until something touches
    // them (wake): the beam, the break tool, a body hitting them
    const kit = installPhysics(core, { wakeOnTouch: false });
    scene.physics = kit.physics;
    scene.lava = kit.lava;
    scene.waker = kit.waker;
    kit.physics.onTouch = (cols) => {
      for (const c of cols) {
        const [x, y] = cellPos(c % dims.w, Math.floor(c / dims.w));
        void scene.wake(x, y, -1, 1.5);
      }
    };
    scene.editor = new Editor(host.ui, (sp) => (scene.speed = sp), {
      undo: () => undo(scene),
      capture: () => scene.core.captureMap(),
      load: (map) => scene.opts.onLoadMap?.(map),
      fresh: () => scene.opts.onLoadMap?.(undefined),
      say: (t) => scene.hud.say(t, 3),
      crew: () => sendBuilders(scene),
    });
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'brush-ring');
    // inline: the UI layer's own rules give its children pointer events, and
    // a full-screen overlay that takes them swallows every click after the
    // ring first appears (round 14: "it doesn't let me place objects")
    svg.style.pointerEvents = 'none';
    scene.ring = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    svg.appendChild(scene.ring);
    scene.ring2 = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    scene.ring2.setAttribute('class', 'equator');
    svg.appendChild(scene.ring2);
    // the heat beam: a line down from the sky to where it's aimed, and a dot there
    // (its own overlay: the brush ring's hides when no brush is out)
    const beamSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    beamSvg.setAttribute('class', 'brush-ring');
    beamSvg.style.pointerEvents = 'none';
    scene.beamLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    scene.beamLine.setAttribute('class', 'heat-beam');
    beamSvg.appendChild(scene.beamLine);
    scene.beamDot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    scene.beamDot.setAttribute('class', 'heat-beam-dot');
    scene.beamDot.setAttribute('r', '0');
    beamSvg.appendChild(scene.beamDot);
    host.ui.appendChild(beamSvg);
    host.ui.appendChild(svg);
    // pours keep landing after the press: the edit pass runs every tick
    core.sim.edit.always = true;
    // the physics playground (F7, G5): what breaks free falls as rigid
    // pieces; the structure system only collapses damage
    const integ = new Integrity(core, rockbodyFor(scene.level.id));
    scene.integrity = integ;
    core.integrity = integ;
    // lightning seeks what you see (loose ground, fallen bodies) and breaks
    // the bodies it strikes (round 19)
    scene.powers.topAt = (x, y) => integ.bodyTopAt(x, y);
    scene.powers.onStrike = (x, y, z) => {
      integ.breakBodies([x, y, z], 2.6);
      integ.markDirty(x, y, 16);
    };
    // (round 86: a piece falling in the columns — the hybrid's chunks under it voxels from then on)
    integ.onTouched = (x0, y0, x1, y1) => {
      scene.hybrid?.edit((x0 + x1) / 2, (y0 + y1) / 2, Math.max(x1 - x0, y1 - y0) / 2);
      // (round 100: what fell landed there — kept with its region)
      scene.stream?.touch(x0, y0 / ROW_H, x1, y1 / ROW_H);
    };
    // (round 86: a piece landing hard throws its chips faster, up and out)
    scene.integrity.onChips = (x, y, z, count, speed) => {
      core.sim.particles.burst({ kind: PK.Chip, x, y, z, count, speed: speed ?? TUNE.bursts.chipSpeed, spread: 0.8, vel: speed ? [0, 0, speed * 0.6] : undefined });
      scene.audio.chip(camera.project(x, y, z)[0] / camera.viewportW);
    };
    scene.integrity.onCollapse = (x, y, z, amount) => scene.audio.collapse(amount, camera.project(x, y, z)[0] / camera.viewportW);
    // dust grains, and a see-through cloud of the material (one puff per five grains)
    // (round 108: their counts and speeds the tuning's `bursts`)
    scene.integrity.onDust = (x, y, z, count, spread, mat) => {
      const B = TUNE.bursts;
      const n = Math.round(count * B.dustCount);
      if (n <= 0) return;
      core.sim.particles.burst({ kind: PK.Dust, x, y, z, count: n, speed: B.dustSpeed, spread });
      core.sim.particles.burst({ kind: PK.Haze, x, y, z: z + 0.5, count: Math.ceil(n / 5), speed: B.hazeSpeed, payload: mat, spread: spread * 0.8 });
    };
    // (round 95, ?rockbody=1) rock hitting the ground hard throws sparks, up and out
    scene.integrity.onSparks = (x, y, z, count, speed) => core.sim.particles.burst({ kind: PK.Spark, x, y, z, count, speed, spread: 0.4, vel: [0, 0, speed * 0.4] });
    // (round 96; solver step 2) metal goes to the node solver (Integrity.wakeMetal); the physics voxels stay the
    // sandbox's tools' (the drop tool, the beam)
    if (scene.integrity.rigid && scene.physics) scene.integrity.physics = scene.physics;
    core.globals.spanCollapse = false;
    weather.holdNatural(1e9);
  }
  // (round 108, AR5) the tuning panel and the bug report: open in the test beds (level.lab), anywhere with ?tunepanel=1
  if (scene.level.lab || host.params.get('tunepanel') === '1') mountLab(scene);
  if (scene.level.noiseLab) mountNoiseLab(scene);
}
