// ---- story/atlas-run.ts -----------------------------------------------------------
// (round 97, heroapi) A run story on an atlas world, for any game: what scenes/level.ts did for `?run=` in one
// call, so a hero game (the hoverbike game, over createAtlasWorld) starts the same run with its own hero, units
// and controller. It holds the window still round the spawn (the story's places are built in window coordinates;
// a run over the streamed world is BACKLOG RS9), maps each story location to its spot on the atlas (its
// settlement's site while that's still in the story's region, else the region's centre), starts HeroRun, and
// keeps it in step with the window: a slide shifts it, the map's warp moves the hero (the story's places stay).
//
//   const story = await loadRunStory('bell')
//   const world = runWorld(story, savedSnapshot)          // the world it was written for, or as a save left it
//   const hr = await startAtlasRun({ atlas, stream, core, api, story, world, ui, device, heightAt, say, makeHero, units, makeController })
//   each frame: hr.update(dt)

import type { SessionStory, WorldSnapshot, WorldState } from '../api/contracts';
import { MemoryWorldState } from '../api/contracts';
import type { Sim } from '../api/world';
import type { AtlasMap } from '../api/atlas-map';
import { Dither, Orbit } from '../api/cutaway';
import type { Atlas } from '../atlas/atlas';
import type { Streamer } from '../scenes/streamer';
import type { WorldCore } from '../scenes/world-core';
import { ROW_H } from '../world/lattice';
import { HeroRun, type HeroRunDeps } from './hero-run';

/** The run stories a game can start by id (the GM's, written for the atlas seed 1). */
export const RUN_STORIES: Record<string, { title: string; load: () => Promise<SessionStory> }> = {
  bell: { title: 'The Bell Under Kaudru', load: async () => (await import('../../data/stories/the-bell-under-kaudru.json')).default as unknown as SessionStory },
};

export async function loadRunStory(id: string): Promise<SessionStory> {
  const s = RUN_STORIES[id];
  if (!s) throw new Error(`run story "${id}": no such story (${Object.keys(RUN_STORIES).join(', ')})`);
  return s.load();
}

/**
 * The world a story was written for: its factions and regions (data/wiki/seed1.run.json, cut from the GM's wiki),
 * fresh; or, given a snapshot (a save between runs), the world as that left it. A snapshot of another seed is a
 * caller's bug.
 */
export async function runWorld(story: SessionStory, saved?: WorldSnapshot | null): Promise<MemoryWorldState> {
  if (saved) {
    if (saved.seed !== story.from.seed) throw new Error(`run world: the save is of seed ${saved.seed}, the story was written for ${story.from.seed}`);
    return MemoryWorldState.restore(saved);
  }
  const wiki = (await import('../../data/wiki/seed1.run.json')).default as unknown as { seed: number; factions: ConstructorParameters<typeof MemoryWorldState>[2]; regions: { id: number; name: string; kind: string }[] };
  return new MemoryWorldState(wiki.seed, wiki.regions, wiki.factions);
}

export interface AtlasRunDeps extends Pick<HeroRunDeps, 'ui' | 'say' | 'makeHero' | 'units' | 'makeController' | 'ownCamera' | 'again' | 'remember'> {
  atlas: Atlas;
  stream: Streamer;
  core: WorldCore;
  api: Sim;
  device: GPUDevice;
  story: SessionStory;
  world: WorldState;
  /** the world's top at (x, y) (window coordinates): the camera's ground picks */
  heightAt: (x: number, y: number) => number;
  /** where the hero starts: a world cell (default the atlas's spawn) */
  at?: [number, number];
  /** the game's cutaway, when it runs one (default: the run's own) */
  orbit?: Orbit;
  dither?: Dither;
  /** the atlas map: the hero's dot and facing, the objective's pin */
  map?: AtlasMap;
}

export async function startAtlasRun(d: AtlasRunDeps): Promise<HeroRun> {
  const { atlas: A, stream: S, core, api, story } = d;
  if (A.p.seed !== story.from.seed) throw new Error(`run "${story.id}": written for the atlas seed ${story.from.seed}, this is ${A.p.seed}`);
  const t = api.terrain;
  if (!t) throw new Error(`run "${story.id}": needs the world API terrain module`);
  const camera = core.camera;
  const [cx, cy] = d.at ?? A.spawn();
  // (a world cell → the window; world units → the window, the shortest way round the torus)
  const { cols, rows } = A.p;
  const near = (v: number, o: number, n: number) => o + ((((v - o) % n) + n * 1.5) % n) - n / 2;
  const toWin = (wx: number, wyUnits: number): [number, number] => {
    const ox = S.origin[0];
    const oy = S.origin[1] * ROW_H;
    return [near(wx, ox + core.dims.w / 2, cols) - ox, near(wyUnits, oy + (core.dims.h * ROW_H) / 2, rows * ROW_H) - oy];
  };
  // (the camera to the spawn first, and the window let slide round it until it's still: the places are built in
  // window coordinates, and edits queued across a slide would land a region off)
  const s0 = toWin(cx + 0.5, (cy + 0.5) * ROW_H);
  camera.target = [s0[0], s0[1], d.heightAt(s0[0], s0[1])];
  for (let quiet = 0, o = `${S.origin}`; quiet < 15; ) {
    await new Promise((res) => setTimeout(res, 100));
    if (S.busy || `${S.origin}` !== o) {
      quiet = 0;
      o = `${S.origin}`;
    } else quiet++;
  }
  // (and then held there: the run's places are in this window — BACKLOG RS9)
  S.auto = false;
  const spawn = toWin(cx + 0.5, (cy + 0.5) * ROW_H);
  const regionAt = (x: number, y: number) => A.regionOf[(((Math.floor((y / A.worldH) * A.p.n) % A.p.n) + A.p.n) % A.p.n) * A.p.n + (((Math.floor((x / A.worldW) * A.p.n) % A.p.n) + A.p.n) % A.p.n)];
  const hr = await HeroRun.start({
    ui: d.ui,
    camera,
    api,
    story,
    world: d.world,
    spawn,
    // (where the atlas has it: its settlement's site while that's still in the story's region, else the region's centre)
    spot: (l) => {
      const site = l.settlement ? A.settlement.sites[Number(l.settlement.replace(/^s/, ''))] : undefined;
      if (site && regionAt(site.x, site.y) === l.region) return toWin(site.x, site.y);
      if (site) console.warn(`run "${story.id}": ${l.id}'s settlement ${l.settlement} is in region ${regionAt(site.x, site.y)} now, not ${l.region} (the atlas changed since the story was written): placed by the region's centre`);
      const def = A.defs[l.region];
      if (!def) throw new Error(`run "${story.id}": no region ${l.region} in the atlas`);
      return toWin(def.stat.cx * A.worldW, def.stat.cy * A.worldH);
    },
    size: [core.dims.w, core.dims.h * ROW_H],
    orbit: d.orbit ?? new Orbit(t, camera),
    dither: d.dither ?? new Dither(t, camera),
    renderer: core.renderer,
    device: d.device,
    groundAt: (sx, sy) => camera.groundAt(sx, sy, d.heightAt),
    say: d.say,
    makeHero: d.makeHero,
    units: d.units,
    makeController: d.makeController,
    ownCamera: d.ownCamera,
    again: d.again,
    remember: d.remember,
  });
  // (the window's origin as the run last knew it: a slide shifts the run by its step, a warp by its jump)
  let org: [number, number, number] = [S.origin[0], S.origin[1], S.oz];
  core.onShift.push((dx, dy, dz) => {
    hr.shift(-dx, -dy, -dz);
    org = [S.origin[0], S.origin[1], S.oz];
  });
  // (round 94; the user: "Keep warp on for now because the character is way too slow") the map's warp moves the
  // hero: put down where the camera is (the window's middle); the story's places stay put
  S.onWarp.push((ox, oy, oz) => {
    const c = camera.target;
    hr.warped(org[0] - ox, (org[1] - oy) * ROW_H, org[2] - oz, [c[0], c[1]]);
    org = [ox, oy, oz];
  });
  // (round 94) the atlas map: the hero's dot and wedge, the objective's pin
  const map = d.map;
  if (map) {
    const cell = (x: number, y: number): [number, number] => [S.origin[0] + x, S.origin[1] + y / ROW_H];
    map.playerAt = () => {
      const h = hr.hero.position();
      return cell(h[0], h[1]);
    };
    map.facing = () => hr.hero.heading();
    map.marks = () => {
      const tg = hr.target;
      return tg ? [{ at: cell(tg.at[0], tg.at[1]), name: tg.name }] : [];
    };
  }
  return hr;
}
