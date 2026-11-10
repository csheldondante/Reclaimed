// Starting the game layers a URL asks for on the level: the play sandbox (?play), a situation or planned run
// (?runplan), a hero run story (?run) and a dialog story (?story). API: startPlay, startSituationRun, startPlannedRun,
// startHeroRun, startStory, playRaise, useRiverWorld. Each layer is loaded on demand and talks to the world through
// the Sim API (api/world.ts).
import { AgentUnits, RAISED_GROUP } from '../../units/agent-units';
import { MemoryWorldState } from '../../api/contracts/world-state';
import { precacheWarp, warpReady, warpWindow } from '../../api/atlas-world';
import { Dither, Orbit, Slice } from '../../api/cutaway';
import { Puck } from '../../api/puck';
import { StoryPlay } from '../../story/play';
import { demoStory } from '../../story/demo';
import { loadRunStory, runWorld, startAtlasRun } from '../../story/atlas-run';
import { ROW_H } from '../../world/lattice';
import { terrainSystem } from './atlas-controls';
import { CUTAWAY } from './flags';
import type { LevelScene } from '../level';
import { worldApiOf } from './world-api';

/** ?play=<hero>: the play layer's sandbox on the atlas level (src/play/sandbox/sandbox.ts) */
export async function startPlay(scene: LevelScene, id: string): Promise<void> {
  const a = scene.opts.atlas;
  if (!a || !scene.stream) throw new Error('?play= plays on the atlas level (?level=atlas)');
  if (!scene.units) throw new Error('?play=: needs the atlas level units (the settlements are off: ?towns=0)');
  const hero = id === '1' ? 'hoverbike' : id;
  if (hero !== 'hoverbike' && hero !== 'lich') throw new Error(`?play=${id}: no such hero (hoverbike, lich)`);
  const { PlaySandbox } = await import('../../play/sandbox/sandbox');
  const api = worldApiOf(scene);
  scene.editor?.setVisible(false);
  // (the level's own camera buttons, turn and score bar hidden while the sandbox has the screen: sandbox.css)
  scene.host.ui.classList.add('play-on');
  const S = scene.stream;
  const dims = scene.core.dims;
  scene.play = await PlaySandbox.start({
    ui: scene.host.ui,
    api,
    units: scene.units,
    camera: scene.core.camera,
    renderer: scene.core.renderer,
    device: scene.host.gpu.device,
    bounds: [dims.w, dims.h * ROW_H],
    hero,
    tune: scene.host.params.get('tune') === '1',
    raise: playRaise(scene, scene.units),
  });
  // (the window slid: the hero moves with what's kept in window coordinates; the map's warp drops it where the camera is)
  scene.core.onShift.push((dx, dy, dz) => scene.play?.shift(-dx, -dy, -dz));
  S.onWarp.push(() => {
    const c = scene.core.camera.target;
    scene.play?.warped([c[0], c[1]]);
  });
  (window as unknown as { reclaimed: Record<string, unknown> }).reclaimed.play = scene.play;
}

/**
 * (merge123, BACKLOG LW1-1 / M122-7) play's raise dead, put together here at the boundary: the trait system's raise
 * effect (traits' one-line hook, ARCHITECTURE "Traits and effects") stands the fallen up in the units' RAISED_GROUP,
 * and each one raised is ordered to follow the hero (the Units contract's follow job on the 'hero' actor).
 */
export function playRaise(scene: LevelScene, units: AgentUnits): (x: number, y: number, radius: number) => void {
  if (!scene.playRaising) {
    scene.playRaising = true;
    units.raised.push((u) => units.order(u.id, { kind: 'follow', target: 'hero', distance: 3 }));
  }
  return (x, y, radius) => void scene.traits.apply({ op: 'raise', group: RAISED_GROUP, at: [x, y], radius });
}

export async function startSituationRun(scene: LevelScene, hero: string, opps = false): Promise<void> {
  const a = scene.opts.atlas;
  if (!a || !scene.stream || !scene.atlasMap) throw new Error(`${opps ? '?run=opps' : '?runplan='} plays on the atlas level (?level=atlas)`);
  const id = hero === 'bike' ? 'hoverbike' : hero;
  if (id !== 'hoverbike' && id !== 'lich') throw new Error(`?runplan=${hero}: a situation run is played by a play hero (hoverbike, lich)`);
  const units = scene.units;
  const st = scene.settlements;
  if (!units || !st) throw new Error('?runplan=: the situation plays with the atlas level units and settlements (the settlements are off: ?towns=0)');
  const S = scene.stream;
  const dims = scene.core.dims;
  const { LevelSit } = await import('../../runsit/level-sit');
  const Run = opps ? (await import('../../opps/level-opps')).LevelOpps : LevelSit;
  const { PlaySession } = await import('../../play/session');
  scene.editor?.setVisible(false);
  scene.host.ui.classList.add('play-on');
  const api = worldApiOf(scene);
  const bounds: [number, number] = [dims.w, dims.h * ROW_H];
  const session = await PlaySession.start({ ui: scene.host.ui, api, units, camera: scene.core.camera, renderer: scene.core.renderer, device: scene.host.gpu.device, bounds, respawnAfter: null, raise: playRaise(scene, units) });
  const c = scene.core.camera.target;
  session.choose(id, session.dryNear([c[0], c[1]]));
  scene.runSession = session;
  // (in step with the window from the moment the hero exists — round 120's phone bug: this was registered after the
  // run was made, so when making it failed every slide left the hero a region off: "teleports me around the map")
  let sitNow: import('../../runsit/level-sit').LevelSit | null = null;
  scene.core.onShift.push((dx, dy, dz) => {
    session.shift(-dx, -dy, -dz);
    sitNow?.shift(-dx, -dy);
  });
  const W = a.atlas.worldW;
  const H = a.atlas.p.rows * ROW_H;
  const wrap = (d: number, n: number) => d - Math.round(d / n) * n;
  // (merge124) one world for the run and the systems that realise it: the rivers (a region's inflow). (Switchover: the
  // old towns realised its settlement events too — charred, peopled — deleted with them: BACKLOG SW-G5)
  const world = MemoryWorldState.restore(structuredClone(st.wiki.snapshot));
  useRiverWorld(scene, world);
  const sit = new Run({
    world,
    atlas: a.atlas,
    terrain: terrainSystem(scene),
    map: scene.atlasMap,
    ui: scene.host.ui,
    hero: id,
    session,
    api,
    units,
    settlements: st,
    bounds,
    // (world units → the window as it is now: the nearest way round the torus from the window's middle)
    toWin: (p) => [wrap(p[0] - S.origin[0] - dims.w / 2, W) + dims.w / 2, wrap(p[1] - S.origin[1] * ROW_H - (dims.h * ROW_H) / 2, H) + (dims.h * ROW_H) / 2],
    precache: (x, y) => precacheWarp(a.atlas, S, dims, x, y),
    ready: (x, y) => warpReady(a.atlas, S, dims, x, y),
    warp: (x, y) => warpWindow(a.atlas, S, dims, x, y),
    say: (s, sec) => scene.hud.say(s, sec ?? 4),
    gm: scene.host.params.get('runsitgm') !== '0',
  });
  scene.situationRun = sit;
  sitNow = sit;
  const R = (window as unknown as { reclaimed: Record<string, unknown> }).reclaimed;
  R.runsit = sit;
  if (opps) R.opps = sit;
  R.runhero = session;
}

/** (merge124) a world's rivers' inflow (WorldState's `river-inflow`, the regions' wetness) realised in the river field */
export function useRiverWorld(scene: LevelScene, world: MemoryWorldState): void {
  for (const r of world.snapshot().regions) if (r.state.wetness !== 1) scene.riverInflow.set(r.id, r.state.wetness);
  world.onEvent.push((e) => {
    if (e.kind !== 'river-inflow') return;
    for (const r of e.regions) scene.riverInflow.set(r, e.magnitude);
    // (the field's nodes take it the next frame: the window's catchments fitted again)
    scene.catchAt = '';
  });
}

/** ?runplan=<hero>&runstages=1: a run planned from the spawn on this atlas; its legs travelled on the atlas map while the land loads */
export async function startPlannedRun(scene: LevelScene, hero: string): Promise<void> {
  const a = scene.opts.atlas;
  if (!a || !scene.stream || !scene.atlasMap) throw new Error('?runplan= plays on the atlas level (?level=atlas)');
  const S = scene.stream;
  const dims = scene.core.dims;
  const { LevelRun } = await import('../../runplan/level-run');
  const { heroProfile, ROLES } = await import('../../runplan/heroes');
  // (as ?run=: the sandbox tools are hidden during a run)
  scene.editor?.setVisible(false);
  // (round 119, runplay) the stages played by play's hero: a PlaySession — the sandbox's hero, controls and chase
  // camera, tuned there — and the run's stage player (src/runplay/player.ts). A hero play hasn't got (the knight)
  // has its stages picked from the card, as before.
  const playId = ROLES[hero];
  let player: import('../../runplay/player').RunPlayer | undefined;
  if (playId === 'hoverbike' || playId === 'lich') {
    const units = scene.units;
    if (!units) throw new Error('?runplan=: the hero plays against the atlas level units (the settlements are off: ?towns=0)');
    const api = worldApiOf(scene);
    const { PlaySession } = await import('../../play/session');
    const { RunPlayer } = await import('../../runplay/player');
    scene.host.ui.classList.add('play-on');
    const bounds: [number, number] = [dims.w, dims.h * ROW_H];
    const session = await PlaySession.start({ ui: scene.host.ui, api, units, camera: scene.core.camera, renderer: scene.core.renderer, device: scene.host.gpu.device, bounds, respawnAfter: null, raise: playRaise(scene, units) });
    const c = scene.core.camera.target;
    session.choose(playId, session.dryNear([c[0], c[1]]));
    const enc = scene.host.params.get('runencounter') as import('../../api/contracts/run').EncounterKind | null;
    const p = new RunPlayer({ ui: scene.host.ui, api, units, session, bounds, encounter: enc ?? undefined });
    player = p;
    scene.runSession = session;
    scene.runPlayer = p;
    // (the window slid: the hero and the stage's pieces move with what's kept in window coordinates)
    scene.core.onShift.push((dx, dy, dz) => {
      session.shift(-dx, -dy, -dz);
      p.shift(-dx, -dy, -dz);
    });
    const R = (window as unknown as { reclaimed: Record<string, unknown> }).reclaimed;
    R.runplay = p;
    R.runhero = session;
  }
  // (?runminutes=8-15: a shorter run than the planner's 15-50 — the scripted playthrough's)
  const rm = scene.host.params.get('runminutes')?.split('-').map(Number);
  scene.plannedRun = new LevelRun({
    atlas: a.atlas,
    terrain: terrainSystem(scene),
    map: scene.atlasMap,
    ui: scene.host.ui,
    hero,
    body: heroProfile(hero),
    player,
    minutes: rm && rm.length === 2 && rm.every(Number.isFinite) ? [rm[0], rm[1]] : undefined,
    precache: (x, y) => precacheWarp(a.atlas, S, dims, x, y),
    ready: (x, y) => warpReady(a.atlas, S, dims, x, y),
    warp: (x, y) => warpWindow(a.atlas, S, dims, x, y),
    say: (s, sec) => scene.hud.say(s, sec ?? 4),
  });
  (window as unknown as { reclaimed: Record<string, unknown> }).reclaimed.runplan = scene.plannedRun;
}

/** ?run=<id>: the GM's story staged near the spawn, played as a hero (story/hero-run.ts; round 97: through story/atlas-run.ts, as any game starts one) */
export async function startHeroRun(scene: LevelScene, id: string): Promise<void> {
  const a = scene.opts.atlas;
  if (!a || !scene.stream) throw new Error('?run= plays on the atlas level (?level=atlas)');
  const story = await loadRunStory(id);
  const world = await runWorld(story);
  const api = worldApiOf(scene);
  scene.editor?.setVisible(false);
  const at = scene.host.params.get('at');
  scene.heroRun = await startAtlasRun({
    atlas: a.atlas,
    stream: scene.stream,
    core: scene.core,
    api,
    device: scene.host.gpu.device,
    story,
    world,
    ui: scene.host.ui,
    heightAt: scene.heightAt,
    at: at ? (at.split(',').map(Number) as [number, number]) : undefined,
    map: scene.atlasMap,
    say: (s, sec) => scene.hud.say(s, sec ?? 4),
  });
  (window as unknown as { reclaimed: Record<string, unknown> }).reclaimed.run = Object.assign(scene.heroRun, { world });
}

/** ?story=<id>: the run, the dialog, the objective list and the story cameras over the world API (story/play.ts) */
export async function startStory(scene: LevelScene, id: string): Promise<void> {
  if (id !== 'demo') throw new Error(`?story=${id}: no such story (demo)`);
  const api = worldApiOf(scene);
  const t = api.terrain!;
  const camera = scene.core.camera;
  // (the cutaway's dither and slice when ?cutaway=1 runs them, else the story's own)
  let cut: { dither: Dither; slice: Slice };
  // (two statements: a free function's `scene.cutaway ??= {…}` takes `cut`'s type as its literal's, unlike the method's `this.`)
  if (CUTAWAY) {
    scene.cutaway ??= { puck: new Puck(t, camera), slice: new Slice(t, camera), orbit: new Orbit(t, camera), dither: new Dither(t, camera) };
    cut = scene.cutaway;
  } else cut = scene.storyCut = { dither: new Dither(t, camera), slice: new Slice(t, camera) };
  const { story, stage, world } = demoStory();
  scene.storyPlay = await StoryPlay.start({
    ui: scene.host.ui,
    camera,
    api,
    world,
    story,
    stage,
    cut,
  });
  (window as unknown as { reclaimed: Record<string, unknown> }).reclaimed.story = Object.assign(scene.storyPlay, { world });
}
