// LevelScene.attach: wires a made level to the page once — the HUD and powers, the sandbox's tools, the controls and
// keys, the window.reclaimed test API, the streamed world's sleep and slides, and what the URL asks to start.
// API: attach(scene). Reads and sets the scene's own fields; other systems only through their public APIs.
import { worldApiOf } from './world-api';
import { Reach } from '../../game/reach';
import { showFatal } from '../../gpu/device';
import { modelById } from '../../world/models';
import { poiWorld } from '../../world/lattice';
import { qYawPitchRoll } from '../../grids/structures';
import { startHeroRun, startPlannedRun, startPlay, startSituationRun, startStory } from './runs';
import { openValley, refreshReach, runIntro } from './valley';
import type { LevelScene } from '../level';

import { attachTools } from './attach-tools';
import { wireInput } from './input-wiring';
import { exposeTestApi, testApi } from './test-api';
import { attachStream } from './stream-setup';
import { startLab } from './fortress';
export function attach(scene: LevelScene): void {
  const { core, host } = scene;
  const { camera, weather, map, dims } = core;
  attachTools(scene);
  // (round 128o, DA-B19: the world API now, its agents installed — scene.heightAt reads the ground through it)
  worldApiOf(scene);
  wireInput(scene);
  const api = testApi(scene);
  attachStream(scene);
  // (round 128l, tooling) the behaviour lab: the fortress on the lab's own town (src/lab/)
  if (scene.level.behaviourLab) startLab(scene);
  exposeTestApi(scene, api);
  core.places.groundAt = scene.heightAt;
  // ?plan=voronoi|bands|tree (seed: ?planseed=): places from a generated plan (the places test hook)
  const plan = host.params.get('plan');
  // (a generated map's own plan: its places — landforms.ts)
  const own = (map as { plan?: { plan: import('../../world/places').Plan; seed: number } }).plan;
  if (own && !plan) core.places.load(own.plan, own.seed);
  if (plan) {
    const seed = Number(host.params.get('planseed') ?? 1);
    if (plan === 'voronoi') core.places.load({ partition: 'voronoi', spacing: 22, group: [1, 3], shape: 'chain' }, seed);
    else if (plan === 'tree') core.places.load({ partition: 'voronoi', spacing: 22, group: [1, 3], shape: 'tree' }, seed);
    else if (plan === 'bands') core.places.load({ partition: 'bands', freq: 0.03, tunnel: 0.06, island: 0.05, shape: 'tree' }, seed);
    else throw new Error(`?plan: no plan "${plan}" (voronoi, tree, bands)`);
  }
  // ?structure=model,x,y,yaw,pitch,roll (grid cells, degrees): a structure grid
  // placed at load (the grids branch's test hook)
  const sp = host.params.get('structure');
  if (sp) {
    const [id, ...nums] = sp.split(',');
    const [x, y, yaw, pitch, roll, sink] = nums.map(Number);
    const m = modelById(id);
    if (!m) throw new Error(`?structure: no model "${id}"`);
    const [wx, wy] = poiWorld([x, y]);
    const r = Math.PI / 180;
    // (the ground's heights arrive with the first surface readback: wait for it)
    const placeIt = () => {
      // (round 128o: the ground under its footprint read first — its pages asked: placed when they're in)
      if (core.structures.place(m, wx, wy, qYawPitchRoll((yaw || 0) * r, (pitch || 0) * r, (roll || 0) * r), scene.heightAt, sink || 0) === undefined) requestAnimationFrame(placeIt);
    };
    placeIt();
  }

  if (scene.story) {
    // the story opens on the green that's left (game/reach.ts: the reach grows from it)
    const [hx, hy] = map.poi.healthy;
    scene.reach = new Reach(dims.w, dims.h, [hx, hy]);
    core.world.writeReach(scene.reach.revealed);
    camera.target = [...poiWorld([hx, hy]), 12];
    void refreshReach(scene);
  }
  if (scene.intro) {
    weather.holdNatural(600);
    void runIntro(scene);
  } else openValley(scene);
  // round 83 (dialog): ?story=demo — a story played on this level
  const storyId = host.params.get('story');
  if (storyId) void startStory(scene, storyId);
  // round 88 (runstory): ?run=bell — a run story as a hero on the atlas level
  const runId = host.params.get('run');
  // (round 124, opportunities) ?run=opps: the horde run as opportunities on the map (src/opps/level-opps.ts); the
  // situation flow stays behind ?runplan= until this replaces it. `&hero=lich` for the lich.
  if (runId === 'opps')
    startSituationRun(scene, host.params.get('hero') ?? 'hoverbike', true).catch((e: unknown) => showFatal(`the run couldn't start: ${e instanceof Error ? e.message : String(e)}`));
  else if (runId) void startHeroRun(scene, runId);
  // round 117 (runplan): ?runplan=<hero> — a planned run travelled on the atlas map (src/runplan/level-run.ts)
  const planHero = host.params.get('runplan');
  // (round 120, runsit: a run is a situation on the live map — the old arcade stages only with &runstages=1, kept for
  // comparison until the user says to delete them: BACKLOG RS23)
  // (round 120, the phone bug: a run that can't start is the fatal overlay with its reason — it was a swallowed rejection,
  // the hero left free with nothing in step with the window)
  if (planHero && planHero !== 'view')
    (host.params.get('runstages') === '1' ? startPlannedRun(scene, planHero) : startSituationRun(scene, planHero)).catch((e: unknown) => showFatal(`the run couldn't start: ${e instanceof Error ? e.message : String(e)}`));
  // round 117 (play): ?play=<hero> — the play sandbox (the game layer, loaded only when asked for: the engine doesn't import it)
  const playId = host.params.get('play');
  if (playId) void startPlay(scene, playId);
}
