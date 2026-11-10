// The level's frame: camera input, the planner and the window's slide, the world's systems, the sim's ticks, the
// story and hero updates, then the draw and the HUD. API: levelFrame(scene, now, dt) (LevelScene.frame), planFrame,
// lifeFrame, ceilingFrame, perfLines. Reads and sets the scene's fields; no other module's internals.
import { ignoreTeardown } from '../../gpu/pipeline';
import { reclamation, worldHealth } from '../../game/nature';
import { saveProgress } from '../../game/progress';
import { EventKind } from '../../sim/globals';
import { CUTS, OP, editOpOf } from '../../sim/edit-ops';
import { abilityHost, lifeFocus, wilderness } from '../../inhabitants/install';
import { mountViewer } from '../../inhabitants/viewer';
import { REGION } from '../streamer';
import { settleTol } from '../../sim/sleep';
import { CatchmentWet } from '../../weather/catchwet';
import { RiverWetField } from '../../weather/wetfield';
import { riverMode } from '../../sim/world-gpu';
import { Dither, Orbit, Slice } from '../../api/cutaway';
import { Puck } from '../../api/puck';
import { cpuLine, frameSteps, record, timed } from '../../gpu/cpustat';
import { CHUNK } from '../../world/layout';
import { poiWorld, ROW_H } from '../../world/lattice';
import { StreamPlanner } from '../planner';
import { driveOn, flyKeys, panOn } from './camera-moves';
import { stepGeysers } from './atlas-controls';
import { birdArrivals, confineToReach, hearing, refreshReach, showComplete } from './valley';
import { followFrame, pitView, skipFrame } from './fortress';
import { brush, drawRing } from './sandbox-tools';
import { aimBeam, stepMeteors } from './impacts';
import { CUTAWAY, PLANNER_OFF, COARSE_PARTS, CAM_CLAMP, PLAN_OFF } from './flags';
import type { LevelScene } from '../level';
import { worldApiOf } from './world-api';

export function levelFrame(scene: LevelScene, now: number, dt: number, driven = false): void {
  // (round 128l, tooling: lab.run steps the scene itself, as fast as the GPU goes — the display's frames wait)
  if (scene.lab?.driving && !driven) return;
  const cpu0 = performance.now();
  const { core, audio, powers, hud } = scene;
  const { camera, weather, globals, sim, map, dims } = core;
  scene.fps = scene.fps * 0.95 + (1 / Math.max(dt, 1e-4)) * 0.05;
  const fms = dt * 1000;
  scene.frameMs.push(fms);
  if (scene.frameMs.length > 300) scene.frameMs.shift();
  if (fms > 50) {
    scene.hitches++;
    // (what ran in it: none — the GPU's, or the browser's)
    scene.longFrames.push(`${fms.toFixed(0)}ms${scene.stream?.busy ? ' busy' : ''}: ${frameSteps.join(', ') || '-'}`);
    if (scene.longFrames.length > 24) scene.longFrames.shift();
  }
  frameSteps.length = 0;
  scene.worstMs = Math.max(scene.worstMs, fms);
  scene.host.profiler.beginFrame();

  // keyboard pan
  const panSpeed = 500 / camera.zoom;
  let kx = 0;
  let ky = 0;
  const k = scene.keys;
  if (scene.drive) driveOn(scene, dt);
  else if (scene.pan && !camera.fly) panOn(scene, dt);
  else if (camera.fly) flyKeys(scene, dt);
  else if (scene.storyPlay?.holdsInput || scene.heroRun || scene.play) {
    // (a talk or a story shot has the camera; a hero run has the keys)
  } else {
  if (k.has('a') || k.has('arrowleft')) kx -= 1;
  if (k.has('d') || k.has('arrowright')) kx += 1;
  if (k.has('w') || k.has('arrowup')) ky -= 1;
  if (k.has('s') || k.has('arrowdown')) ky += 1;
  if (kx || ky) {
    const [wx, wy] = camera.screenDeltaToWorld(kx * panSpeed * dt, ky * panSpeed * dt);
    camera.target[0] += wx;
    camera.target[1] += wy;
  }
  }
  if (scene.ceiling && scene.far) {
    ceilingFrame(scene, dt, cpu0);
    return;
  }
  // (round 91, the user: "I easily hit the edge of the loaded ground": a streamed window kept the camera a region in
  // from its edge — a pan faster than the slides waited for them there. Round 113, `tilesfirst` SF10, the user on
  // places: "This version seems to stop me from scrolling when I get near the edge of what is loaded which is not
  // desirable either." The stand-in and the tiles draw everything the camera sees, so it's never held back by what's
  // loaded: a streamed world has no edge (the atlas wraps), the window slides after the camera and catches up behind
  // it. A fixed map keeps its own bounds. ?camclamp=1 the round-91 clamp, to compare)
  if (!scene.stream || CAM_CLAMP) {
    const edge = scene.stream ? REGION : 0;
    camera.target[0] = Math.max(edge, Math.min(dims.w - edge, camera.target[0]));
    camera.target[1] = Math.max(edge * ROW_H, Math.min((dims.h - edge) * ROW_H, camera.target[1]));
  }
  if (scene.reach) {
    scene.reachRefresh -= dt;
    if (scene.reachRefresh <= 0) {
      scene.reachRefresh = 1;
      void refreshReach(scene);
    }
    confineToReach(scene);
  }
  // (round 113, tilesfirst — the planner: one footprint, each layer's reach from its measured latency at the camera's
  // speed, holes first and rendering before simulation; scenes/planner.ts)
  planFrame(scene);
  // (a slide in progress: the sim waits for the regions coming in)
  // (round 128i, FT-67; the user on the Pixel 9a: "flickering of the town (position jumping)") The slide runs here,
  // right after the camera moved and before anything this frame reads or writes window coordinates: its synchronous
  // part moves the camera, the window's origin and what the game keeps in window coordinates (onShift, onSlide), so
  // the towns' grid rows (SettlementsView.update), the fortress's road stamp (FortressCrowd.update) and the rest are
  // written for the window as it is now and land before this frame's draw. Run after them (as it was), the slide
  // moved the camera after the rows were written: the town drew a region off for one frame (131.6 px at zoom 2.6,
  // scripts/townslide.mjs) and jumped back the next.
  void scene.stream?.update();
  scene.director.update(dt);
  // geysers (round 75)
  if (scene.opts.atlas) stepGeysers(scene, dt * scene.speed);
  // the coarse world goes on (round 71): a step every 4th frame (a step a frame cost ~1.5 ms). (Round 114, framepace:
  // its three parts on three frames of the four — the whole step on one frame was its GPU's largest spike; Coarse.
  // stepPart. ?coarseparts=0 the whole step every 4th frame, to compare)
  if (scene.opts.atlas) {
    const c = scene.opts.atlas.atlas.coarse;
    const k = ++scene.coarseFrame % 4;
    if (!COARSE_PARTS) k === 0 && c.step(1);
    else if (k < 3) c.stepPart();
  }
  // (round 88) the units' sync and thinking, the settlements' rounds and rates, the debug view
  // (round 94: the settlements past the window planned for the bake, whatever the streamer's doing)
  scene.settlements?.farUpdate(dt);
  // (citygen M4b: the field towns near the window made, the far ones let go)
  scene.fieldTowns?.update(dt);
  // (living town: new towns' people; the frame's GPU work is in the renderer's frameCompute)
  scene.livingTowns?.update(dt * scene.speed);
  // (round 119) the settlements' pieces: made again when a plan, a storey or the window changed
  scene.settlementsView?.update();
  scene.lab?.frame();
  scene.statics?.frame();
  scene.shipsView?.update();
  if (scene.inhabitants) lifeFrame(scene, dt * scene.speed);
  if (scene.units && !scene.stream?.busy) {
    scene.units.update(dt * scene.speed);
    timed('settle', () => scene.settlements?.update(dt * scene.speed));
    // (round 128o: the fortress waits while the window's ground is read again after a slide — scene.groundReady)
    if (scene.fortressCrowd && scene.groundReady) {
      scene.fortressCrowd.update(dt * scene.speed);
      // (round 128l, m4) the attack wave: its clock, its raiders, the gates
      scene.fortressRaid?.update(dt * scene.speed);
      if (scene.fortressSkip) skipFrame(scene, dt * scene.speed);
      // (round 128l, m4) Follow: the camera on the person picked
      followFrame(scene);
      pitView(scene, dt);
      // (the stores and progress lines: twice a second)
      if ((scene.fortressBarAt += dt) > 0.5) {
        scene.fortressBarAt = 0;
        scene.fortressBar?.render();
      }
    }
    scene.townDebug?.draw();
  }

  const simDt = dt * scene.speed;
  if (scene.hoverWorld) powers.hover(scene.hoverWorld[0], scene.hoverWorld[1], dt);
  powers.update(dt);

  const stats = sim.stats.latest;
  if (stats && scene.initialContam === 0) scene.initialContam = stats.soilContam;
  if (stats) {
    if (scene.lastCollapsed >= 0 && stats.collapsed > scene.lastCollapsed) audio.crumble(stats.collapsed - scene.lastCollapsed);
    scene.lastCollapsed = stats.collapsed;
    // clean land + life weighted by stage (round 8)
    scene.reclaimed = reclamation(stats);
  }
  const health = worldHealth(stats, scene.initialContam);
  core.pollution += (health.pollution - core.pollution) * Math.min(1, dt * 0.5);
  scene.life += (health.life - scene.life) * Math.min(1, dt * 0.5);
  scene.nature.update(simDt, stats);
  // (round 128o, DA-B5) the sandbox valley's reads — the painted wind for its storms, smoke and grime for its Nature,
  // veg and water for its ambience — none in fortress play (level/valley-reads.ts)
  scene.valleyReads?.frame(dt);

  scene.lensK += ((scene.lensOn ? 1 : 0) - scene.lensK) * Math.min(1, dt * 8);
  const lc = scene.hoverWorld ?? [camera.target[0], camera.target[1]];
  globals.lens = [lc[0], lc[1], 24, scene.lensK < 0.01 ? 0 : scene.lensK];

  // (hybrid) what's voxels this frame: the events edit what they touch; the focus is the camera's target
  // (round 86) a cut's chunks (a dig, a crater) are meshed the next frame, whatever the tier's rebuild budget (fieldmesh.ts urgent)
  // (a crater's radius is its ejecta's, 2.5 times its bowl's: the dust lands later, through the sediment)
  for (const e of globals.events) {
    if (e.kind !== EventKind.Edit || !CUTS.has(editOpOf(e.z ?? 0))) continue;
    const r = editOpOf(e.z ?? 0) === OP.CRATER ? e.radius / 2.5 + 2 : e.radius;
    core.renderer.fieldMesh.urgent(e.x - r, e.y - r, e.x + r, e.y + r);
  }
  if (scene.hybrid) {
    for (const e of globals.events) scene.hybrid.edit(e.x, e.y, e.radius, e.kind);
    const hy = scene.hybrid;
    if (hy.update(camera.fly ? [camera.fly.pos[0], camera.fly.pos[1]] : [camera.target[0], camera.target[1]])) {
      core.renderer.setMeshWanted(hy.wanted);
      // (round 86: the heightfield chunks the grid draws — the window's own columns, the mesh's look — and the
      // rest the rings')
      core.renderer.setGrid(hy.grid, hy.lo, hy.hi);
      scene.far?.setGrid(hy.gridBits());
      globals.hfield = { bits: hy.bits(), across: core.renderer.fieldMesh.chunkGrid[0], side: core.renderer.fieldMesh.chunkGrid[2] };
      // (the sim where the voxels are, and the grid's within the storms' reach — a storm raining there wakes it)
      scene.sleep?.only(hy.sleepFilter(dims.w / CHUNK, dims.h / CHUNK));
    }
    scene.hybrid.count(core.renderer.fieldMesh.drawn);
  }
  // (round 84) the rivers' wetness: the season and the storms (weather/riverwet.ts); (round 109) on the atlas level
  // the storms per watershed — the climate's the season alone, each river's storm water its own catchment's
  // (round 110: and a fixed map's authored river table's — world/rivertable.ts riverGraph, its window the map)
  const atl = scene.opts.atlas?.atlas;
  if (atl?.riverCatchments && scene.stream && !scene.catchWet) {
    scene.catchWet = new CatchmentWet({ nodes: atl.riverNodes, catchments: atl.riverCatchments, n: atl.p.n, worldW: atl.worldW, worldH: atl.worldH });
    scene.wetField = new RiverWetField(scene.host.gpu.device, core.world.riverWet);
  }
  if (core.map.riverGraph && !scene.stream && !scene.catchWet && riverMode() === 'table') {
    scene.catchWet = new CatchmentWet(core.map.riverGraph);
    scene.wetField = new RiverWetField(scene.host.gpu.device, core.world.riverWet);
  }
  if (scene.catchWet && scene.wetField) {
    const S = scene.stream ?? { origin: [0, 0] };
    const key = `${S.origin[0]},${S.origin[1]}`;
    if (key !== scene.catchAt) {
      scene.catchAt = key;
      scene.catchWet.setWindow(S.origin[0], S.origin[1], dims.w, dims.h);
      if (scene.settlements) scene.catchWet.setInflow((x, y) => scene.settlements!.regionAt(x, y), scene.riverInflow);
      scene.wetField.map(scene.catchWet);
    }
    scene.catchWet.update(dt * scene.speed, weather);
    scene.wetField.write(scene.catchWet.ex, scene.catchWet.inflow, scene.riverWet.value);
    globals.riverWet = scene.riverWet.update(dt * scene.speed, globals.season ?? 0, []);
  } else globals.riverWet = scene.riverWet.update(dt * scene.speed, globals.season ?? 0, weather.storms);
  // (round 80) what's awake this frame: round the player (the camera's target), the events, the storms
  if (scene.sleep) {
    globals.sleep = scene.sleep.update(performance.now() / 1000, [camera.target[0], camera.target[1], 40], globals.events, weather.storms, core.sim.tick);
    globals.drowse = scene.sleep.drowse;
    globals.settle = scene.sleep.settling.map((s) => s.rect);
    // (round 128o, DA-B20: the chunks maybe still settling their water, the GPU holding them while it changes — no read)
    globals.settleTol = settleTol();
    globals.settleCand = globals.settleTol > 0 ? scene.sleep.settleCand : undefined;
  }
  // (?skip=sim, round 80: the frame without the sim — on a phone, how much of it the sim is)
  const tSim = performance.now(); // (round 100, hitchrec: timing)
  // (round 114, framepace: a frame the sim is held — the streamer busy — is a pause to the tick clock, counted by why)
  const held = scene.stream?.busy ? `stream-${scene.stream.busyWhy}` : scene.noSim ? 'skip' : '';
  if (held) {
    core.clock.pause(simDt, scene.speed);
    scene.simHeld[held] = (scene.simHeld[held] ?? 0) + 1;
  }
  // (round 128l: the lab may run only some of the sim's systems — lab.sims, src/lab/lab.ts)
  const ticks = held ? 0 : core.advance(now, simDt, scene.speed, scene.lab?.simFilter);
  record('sim', performance.now() - tSim); // (round 100, hitchrec: timing)
  scene.ticksAvg = scene.ticksAvg * 0.95 + ticks * 0.05;
  // (round 83, V21: ?cutaway=1 — the camera's puck, the slice and the orbit round it; `cutFeet` a script's
  // stand-in character, kept seen)
  // (round 83, dialog: the story's run, cameras and badges; its own cut when the cutaway's not on)
  const tStory = performance.now(); // (round 100, hitchrec: timing)
  if (scene.storyPlay) {
    scene.storyPlay.update(dt);
    if (scene.storyCut && !camera.fly) scene.storyCut.dither.update(dt);
  }
  // (round 88: the hero run — hero, units, its story, the chase camera)
  if (scene.heroRun && !camera.fly) scene.heroRun.update(dt);
  // (round 117: the play sandbox — its hero, controls and the chase camera)
  if (scene.play && !camera.fly) scene.play.update(dt);
  // (round 119, runplay: the run's hero and the stage it plays)
  if (scene.runSession && !camera.fly) {
    scene.runSession.update(dt);
    scene.runPlayer?.update(dt);
  }
  scene.plannedRun?.update(dt);
  scene.situationRun?.update(dt);
  if (scene.storyPlay || scene.heroRun) record('story', performance.now() - tStory); // (round 100, hitchrec: timing)
  // (round 90: the player's turn of the view — not flying, not while a story shot or the cutaway has the camera)
  if (scene.turn && !camera.fly && !CUTAWAY && !scene.storyPlay?.cam.busy && !scene.heroRun && !scene.play && !scene.runSession) scene.turn.update(dt);
  // (round 91: the compass follows the view, flying too — the flyer's look)
  scene.compass?.update(camera.fly ? camera.fly.yaw + Math.PI : camera.azimuth);
  if (CUTAWAY && !camera.fly) {
    const t = worldApiOf(scene).terrain!;
    const c = (scene.cutaway ??= { puck: new Puck(t, camera), slice: new Slice(t, camera), orbit: new Orbit(t, camera), dither: new Dither(t, camera) });
    c.puck.update(dt);
    const p = c.puck.pos;
    // (a story shot cuts the slice over what it frames: story/camera.ts)
    if (p && !scene.storyPlay?.cam.busy) {
      c.slice.update(p[0], p[1], p[2], dt);
      c.orbit.update(p[0], p[1], p[2], dt);
    }
    if (scene.cutFeet) c.dither.see('feet', ...scene.cutFeet);
    else c.dither.forget('feet');
    c.dither.update(dt);
  } else if (camera.fly) {
    // (round 83: flying, nothing's cut — the slice left from the fixed view cut the world under the flyer)
    camera.cut = { slice: null, see: [], boxes: [] };
  }
  const tRender = performance.now(); // (round 100, hitchrec: timing)
  core.render();
  record('render', performance.now() - tRender); // (round 100, hitchrec: timing)

  hud.setWind(powers.windTier());
  const goal = scene.level.goal ?? 1;
  hud.setReclaim(scene.reclaimed, goal);
  // the brush paints every frame while held
  if (scene.brushAt && scene.editor) brush(scene, scene.brushAt[0], scene.brushAt[1]);
  stepMeteors(scene, dt);
  drawRing(scene);
  if (scene.beamAt && scene.physics && !scene.beamPicking) aimBeam(scene, scene.beamAt);
  // (round 120) the held body pulled to where the finger is, at the height it was lifted to
  if (scene.dragHold && scene.integrity) {
    const [tx, ty] = camera.groundAt(scene.dragHold.at[0], scene.dragHold.at[1], () => scene.dragHold!.h);
    if (!scene.integrity.pull(scene.dragHold.g, [tx, ty, scene.dragHold.h], Math.min(dt, 1 / 20))) scene.dragHold = undefined;
  }
  // (round 87: the beam bores through rock with no edit event — what it undercuts is judged while it's held)
  const lb = scene.lava?.beam;
  if (lb && scene.integrity && performance.now() - scene.beamCutAt > 250) {
    scene.beamCutAt = performance.now();
    scene.integrity.cutAt(lb.at[0], lb.at[1], lb.radius + 1.5);
  }
  if (scene.integrity) {
    // cyclones batter what they pass: look there
    for (const cy of weather.cyclones) scene.integrity.markDirty(cy.x, cy.y, cy.radius * 2.5);
    const tJudge = performance.now(); // (round 100, hitchrec: timing)
    scene.integrity.update(dt * scene.speed);
    record('judge', performance.now() - tJudge); // (round 100, hitchrec: timing)
  }
  weather.dustiness = core.pollution;
  birdArrivals(scene, dt, stats);

  // progress feeds the menu scene; the level ends at the goal
  scene.saveTimer -= dt;
  if (scene.saveTimer <= 0 && scene.level.goal) {
    scene.saveTimer = 5;
    saveProgress(scene.level.id, (scene.reclaimed / scene.level.goal) * 0.95);
  }
  if (!scene.completed && scene.level.goal && scene.reclaimed >= scene.level.goal) {
    scene.completed = true;
    saveProgress(scene.level.id, 1);
    showComplete(scene);
  }

  if (globals.time > scene.nextGroan) {
    scene.nextGroan = globals.time + 14 + Math.random() * 16;
    const [dx, dy] = poiWorld(map.poi.dam);
    const near = 1 - Math.min(1, Math.hypot(camera.target[0] - dx, camera.target[1] - dy) / 120);
    const holding = stats ? Math.min(1, stats.waterVolume / 20000) : 1;
    audio.groan(near * holding);
  }
  const light = core.light;
  const drag = powers.dragWind();
  audio.dragWind(drag ? Math.min(1, drag.strength / 15) : 0, drag ? camera.project(drag.x, drag.y, 0)[0] / camera.viewportW : 0.5);
  // one roar: the loudest cyclone (nearest and strongest) sets it
  let roar = 0;
  let roarPan = 0.5;
  for (const cy of weather.cyclones) {
    const near = Math.max(0, 1 - Math.hypot(cy.x - camera.target[0], cy.y - camera.target[1]) / (camera.viewportW / camera.zoom));
    const level = cy.strength * (0.3 + 0.7 * near);
    if (level > roar) {
      roar = level;
      roarPan = camera.project(cy.x, cy.y, 0)[0] / camera.viewportW;
    }
  }
  audio.cyclone(roar, roarPan);
  const heard = hearing(scene);
  audio.update({
    pollution: core.pollution,
    life: scene.life,
    ...heard,
    // barren land howls; living land in view quiets it
    barren: Math.min(1, (1 - heard.lifeNear) * 0.7 + core.pollution * 0.3),
    night: light.night,
    fire: stats ? Math.min(1, stats.fireCells / 120) : 0,
    wind: Math.min(1, Math.hypot(weather.windX, weather.windY) / 6 + weather.storms.reduce((a, s) => a + s.intensity * 0.3, 0)),
  });
  scene.perf.update(
    {
      fps: scene.fps,
      cpuFrameMs: performance.now() - cpu0,
      ticksPerFrame: scene.ticksAvg,
      instancesOpaque: core.renderer.instanceCounts.opaque,
      instancesBlend: core.renderer.instanceCounts.blend,
      renderW: scene.renderW,
      renderH: scene.renderH,
      stats,
      adapter: scene.host.gpu.adapterInfo,
      quality: scene.host.qualityName,
      extra: () => perfLines(scene),
    },
    scene.host.profiler,
    sim,
  );
}

/** (round 113) the planner's frame: its inputs read, its plan given to the streamer, the tiles, the mesh, the pacer, the sim */
export function planFrame(scene: LevelScene): void {
  const S = scene.stream;
  const core = scene.core;
  const TL = core.renderer.tiles;
  if (!S || !TL || PLANNER_OFF) return;
  if (!scene.planner) {
    const fm = core.renderer.fieldMesh;
    const keyOf = (rx: number, ry: number) => `${rx},${ry}`;
    scene.planner = new StreamPlanner({
      vel: () => [S.vel[0], S.vel[1]],
      cover: () => TL.coverCheck(core.camera),
      arriving: () => S.unwritten.map(([lx, ly]) => keyOf(Math.floor((S.origin[0] + lx) / S.R), Math.floor((S.origin[1] + ly) / S.R))),
      windowDraws: (k) => {
        const [rx, ry] = k.split(',').map(Number);
        const lx = rx * S.R - S.origin[0];
        const ly = ry * S.R - S.origin[1];
        if (lx < 0 || ly < 0 || lx >= S.W || ly >= S.H) return false;
        const [nx, ny, side] = fm.chunkGrid;
        const wd = core.renderer.windowDrawn();
        for (let j = ly / side; j < (ly + S.R) / side; j++)
          for (let i = lx / side; i < (lx + S.R) / side; i++) {
            if (i >= nx || j >= ny) continue;
            const v = wd[j * nx + i];
            if (v !== 1 && v !== 2) return false;
          }
        return true;
      },
      landLatency: () => S.landLatency(),
      tileLatency: () => TL.tileLatency(),
    });
    const a = scene.opts.atlas?.atlas;
    if (a && !PLAN_OFF.has('pacer')) a.pacer.holes = () => scene.planner!.plan.holes;
    // (round 115, `tilecal`: the tiles' rate is measured while the pacer gives them the frame's turns for holes — a
    // screenful filling, the zoom floor's case)
    if (a && !PLAN_OFF.has('pacer')) TL.cal.holes = () => scene.planner!.plan.holes;
  }
  const P = scene.planner.update();
  // (?planoff=slide,tile,mesh,sim: a consumer left as before — the A/B of each)
  S.reach = { land: P.reach.land, slide: PLAN_OFF.has('slide') ? 0 : P.reach.window, dir: P.dir };
  TL.reach = PLAN_OFF.has('tile') ? null : P.reach.tile;
  core.renderer.fieldMesh.lead = PLAN_OFF.has('mesh') ? [0, 0] : [P.dir[0] * P.reach.window, P.dir[1] * P.reach.window * ROW_H];
  core.simCap = PLAN_OFF.has('sim') ? null : P.simCap;
}

/** (round 117, ?life=) the inhabitants each frame: spawned once the ground's first read is in, the mesh built round the view */
export function lifeFrame(scene: LevelScene, dt: number): void {
  const life = scene.inhabitants!;
  const { core } = scene;
  // (round 128o: the ground round the camera read first — the stand-in town's paths stand on it — then spawned)
  if (!scene.lifeSpawned && scene.worldApi?.terrain) {
    scene.lifeSpawned = true;
    const [cx, cy] = core.camera.target;
    void scene.worldApi.terrain.load(cx - 64, cy - 64, cx + 64, cy + 64).then(() => spawnLife(scene), ignoreTeardown);
  }
  lifeFocus(life, core);
  life.update(dt);
}

/** (round 117) the inhabitants spawned round the camera, its ground read (lifeFrame) */
function spawnLife(scene: LevelScene): void {
  const life = scene.inhabitants!;
  const { core, host } = scene;
  {
    const mode = host.params.get('life');
    const t = core.camera.target;
    life.setAbilityHost(
      abilityHost(core, {
        lavaBeam: (b) => scene.lava && (scene.lava.beam = b),
        blast: (x, y, r, st, tm) => worldApiOf(scene).wind?.blast(x, y, r, st, tm),
      }),
    );
    if (mode === 'viewer') {
      scene.editor?.setVisible(false);
      mountViewer(host.ui, life, core, scene.groundRead);
    }
    else if (mode !== 'empty') wilderness(life, [t[0], t[1]], { herd: Number(host.params.get('lifeherd') ?? 12), dragon: mode === 'dragon', town: mode === 'town', ground: scene.groundRead });
  }
}

/**
 * ?ceiling=1: the frame of the perf ceiling — the camera, then one pass of the heightfield (far.ts's rings and
 * far land; the rings make only the strips new to them as the camera moves). The window doesn't slide: the
 * camera leaves it behind (the rings are anchored to the world), its height following the atlas's macro ground.
 */
export function ceilingFrame(scene: LevelScene, dt: number, cpu0: number): void {
  const { core } = scene;
  const { camera, dims } = core;
  const S = scene.stream!;
  const far = scene.far!;
  const a = scene.opts.atlas!.atlas;
  // (the target's height: the macro ground under it, bilinear — as the window's z follows the land when it slides)
  const n = a.p.n;
  const tx = (((camera.target[0] + S.origin[0]) / a.worldW) * n - 0.5 + n * 4) % n;
  const ty = (((camera.target[1] + S.origin[1] * ROW_H) / a.worldH) * n - 0.5 + n * 4) % n;
  const x0 = Math.floor(tx);
  const y0 = Math.floor(ty);
  const fx = tx - x0;
  const fy = ty - y0;
  const H = (x: number, y: number) => a.hmac[((y + n) % n) * n + ((x + n) % n)];
  const h = (H(x0, y0) * (1 - fx) + H(x0 + 1, y0) * fx) * (1 - fy) + (H(x0, y0 + 1) * (1 - fx) + H(x0 + 1, y0 + 1) * fx) * fy;
  camera.target[2] += (Math.max(h, a.p.sea) - S.oz - camera.target[2]) * Math.min(1, dt * 2);
  camera.update();
  far.org = [S.origin[0], S.origin[1] * ROW_H, S.oz];
  far.win = [dims.w + 0.5, dims.h * ROW_H];
  far.zMax = dims.zMax;
  far.mid = [camera.target[0], camera.target[1]];
  far.focus = null;
  const { device, context } = scene.host.gpu;
  const enc = device.createCommandEncoder({ label: 'ceiling' });
  const clear = core.light.clear;
  core.renderer.encodeCeiling(enc, context.getCurrentTexture().createView(), camera, clear, (pass) => far.draw(pass, clear));
  const after = scene.host.profiler.endFrame(enc);
  device.queue.submit([enc.finish()]);
  after?.();
  scene.perf.update(
    {
      fps: scene.fps,
      cpuFrameMs: performance.now() - cpu0,
      ticksPerFrame: 0,
      instancesOpaque: 0,
      instancesBlend: 0,
      renderW: scene.renderW,
      renderH: scene.renderH,
      stats: core.sim.stats.latest,
      adapter: scene.host.gpu.adapterInfo,
      quality: `${scene.host.qualityName} ceiling near ${far.lod!.spacings[0]}`,
      extra: () => perfLines(scene),
    },
    scene.host.profiler,
    core.sim,
  );
}

/** the phone's profile (round 79): frame times over the last 300 frames, hitches, the streamer's slides */
export function perfLines(scene: LevelScene): string[] {
  const f = [...scene.frameMs].sort((a, b) => a - b);
  const q = (p: number) => (f.length ? f[Math.min(f.length - 1, Math.floor(p * f.length))] : 0);
  const out = [`frame ms p50 ${q(0.5).toFixed(1)}  p95 ${q(0.95).toFixed(1)}  worst ${scene.worstMs.toFixed(0)}  hitches(>50) ${scene.hitches}`];
  const S = scene.stream;
  if (S) out.push(`stream slides ${S.stats.slides}  z ${S.stats.tiers}  last ${S.stats.lastMs}ms  made ${S.stats.generated}  thawed ${S.stats.thawed}${S.busy ? '  BUSY' : ''}`);
  if (scene.drive) out.push(`drive ${scene.drive.speed}/s  zoom ${scene.core.camera.zoom.toFixed(2)}`);
  out.push(`cpu worst ms: ${cpuLine()}`);
  // (the last long frames and what ran in them: '-' is the GPU's or the browser's)
  for (const l of scene.longFrames.slice(-3)) out.push(`long ${l.slice(0, 90)}`);
  if (scene.sleep) out.push(`awake chunks ${scene.sleep.awake} of ${(scene.core.dims.w / CHUNK) * (scene.core.dims.h / CHUNK)}`);
  const hs = scene.hybrid?.stats;
  if (hs) out.push(`hybrid voxel chunks ${hs.voxel} of ${hs.chunks} (land ${hs.land}, steep ${hs.steep}, edited ${hs.edited}, near ${hs.near}); drawn ${scene.core.renderer.fieldMesh.drawn}; grid ${hs.grid} (sim may wake ${hs.simmed}), rings ${hs.ring}`);
  return out;
}
