// ---- api/atlas-world.ts -------------------------------------------------------
// An atlas world for a game (round 80, BACKLOG P5; the user: "make the hoverbike … able to use the new
// terrain, atlas and streaming"). Everything the atlas level wires up, in one call: the atlas (the world
// map: landforms, mesas, rivers, the sea, sites and their ways), the window onto it where the game starts,
// the WorldCore over it, the streamer (the window slides a region as the target nears its edge, in z as
// the ground nears its top or bottom), the band (what's above and below the window drawn), the sea held
// at its level past the window's edge, sleep and wake (what's still sleeps; the target's ring and the
// world's events wake), the land beyond the window out to the sky, the climate by latitude.
//
//   const aw = await createAtlasWorld(host, { at: [x, y], particles })
//   const sim = attachSim(aw.core)               // the world API's modules over it, as for any WorldCore
//   aw.onSlide.push((dx, dy, dz) => …)           // the window moved: shift what the game keeps in window coords
//   each frame: const busy = aw.frame(target)    // the target (window world units) keeps its ring awake,
//               if (!busy) core.advance(…)       // the streamer slides; while a slide runs, the sim waits
//
// Window coordinates: x in cells, y in world units (rows × ROW_H), z from the window's floor (aw.stream.oz);
// aw.toWorld / fromWorld convert to the atlas's world cells.

import { Atlas, atlasParamsFrom, type AtlasParams } from '../atlas/atlas';
import { FarLand } from '../atlas/far';
import { Streamer, REGION, TIER } from '../scenes/streamer';
import { WorldCore, type Host } from '../scenes/world-core';
import { Sleep } from '../sim/sleep';
import { Integrity } from '../game/integrity';
import { CHUNK, K_HEADROOM } from '../world/layout';
import { ROW_H } from '../world/lattice';

export interface AtlasWorldOptions {
  /** where to start: a world cell (x, y); the atlas's own spawn when not given */
  at?: [number, number];
  /** the window's side in cells (whole regions of 64; 256 a phone's, more for a desktop's look round) */
  win?: number;
  /** the window's height (the layers' z: 248 at most) */
  zMax?: number;
  /** the atlas's parameters (seed, style, sea …): over the defaults; or the page's `a.*` query */
  params?: Partial<AtlasParams> | URLSearchParams;
  /** particles the world holds (the host's quality's) */
  particles: number;
  /** sleep and wake (default on) */
  sleep?: boolean;
  /** the band above and below the window (default on) */
  band?: boolean;
  /** the land beyond the window (default on) */
  far?: boolean;
  /** (round 83) what's cut loose falls — structures, and rock (islands, overhangs past their span, undercut
   *  spires): game/integrity.ts, the world API's edits marking it (default on) */
  integrity?: boolean;
}

export interface AtlasWorld {
  atlas: Atlas;
  core: WorldCore;
  stream: Streamer;
  sleep?: Sleep;
  /** (round 83) what judges what's cut loose and makes it fall (opts.integrity) */
  integrity?: Integrity;
  /** the window moved by (dx, dy) cells or dz in z: the game shifts what it keeps in window coordinates */
  onSlide: ((dx: number, dy: number, dz: number) => void)[];
  /**
   * Each frame, before the sim's ticks: the target (window x, y in world units — the player) keeps the
   * chunks within `reach` awake, the streamer slides when it's near an edge. → true while a slide is
   * under way (the sim waits for the land coming in: skip core.advance).
   */
  frame(target: [number, number], reach?: number): boolean;
  /**
   * Jump the window to world cell (cx, cy) (round 80: the map's warp): the window round it, at a height for
   * the ground there; the camera at its middle. Then `onWarp` — the game puts its player down (what it kept
   * in window coordinates is void). Resolves when the land is in.
   */
  warp(cx: number, cy: number): Promise<void>;
  /** the window jumped (warp): its new origin (world cells) and oz */
  onWarp: ((ox: number, oy: number, oz: number) => void)[];
  /** a window point (x cells, y world units) as a world cell, and back */
  toWorld(x: number, y: number): [number, number];
  fromWorld(cx: number, cy: number): [number, number];
}

/**
 * The window to world cell (cx, cy) (round 80): its origin the whole regions round it, its oz the tier that
 * holds the ground there well inside it (as the streamer keeps it: over its floor, under its top).
 */
export function warpWindow(atlas: Atlas, stream: Streamer, dims: { w: number; h: number; zMax: number }, wcx: number, wcy: number): Promise<void> {
  const { cols, rows, zTop } = atlas.p;
  const x = ((Math.round(wcx) % cols) + cols) % cols;
  const y = ((Math.round(wcy) % rows) + rows) % rows;
  const ox = Math.round((x - dims.w / 2) / REGION) * REGION;
  const oy = Math.round((y - dims.h / 2) / REGION) * REGION;
  // (as the first window's: the tier holding the most of the ground's tops over it — 8 over its floor, 24
  // under its top — the ground at its middle in it, by the atlas's macro heights)
  const gMid = atlas.macroAt(x + 0.5, (y + 0.5) * ROW_H);
  const gs: number[] = [];
  for (let j = 0; j < 16; j++) for (let i = 0; i < 16; i++) gs.push(atlas.macroAt(ox + ((i + 0.5) * dims.w) / 16, (oy + ((j + 0.5) * dims.h) / 16) * ROW_H));
  let oz = 0;
  let most = -1;
  for (let c = 0; c + dims.zMax <= zTop + TIER; c += TIER) {
    if (gMid < c + 8 || gMid > c + dims.zMax - 40) continue;
    const n = gs.filter((v) => v >= c + 8 && v <= c + dims.zMax - 24).length;
    if (n > most) {
      most = n;
      oz = c;
    }
  }
  return stream.warp(ox, oy, oz);
}

/** the atlas level's columns: 16 slots, two of them headroom (scenes/level.ts SANDBOX_K) */
const SLOTS = 16;
/** the field mesh's room a chunk (the atlas level's: rough land) */
const MESH_ROOM = 5;

export async function createAtlasWorld(host: Host, opts: AtlasWorldOptions): Promise<AtlasWorld> {
  const params = opts.params instanceof URLSearchParams ? atlasParamsFrom(opts.params) : atlasParamsFrom(new URLSearchParams(), opts.params ?? {});
  const atlas = await Atlas.build(host.gpu.device, params);
  atlas.profiler = host.profiler;
  const W = opts.win ?? 256;
  if (!(W >= 256 && W % REGION === 0)) throw new Error(`createAtlasWorld: win must be 256 or more, whole regions of ${REGION}`);
  const zMax = opts.zMax ?? 248;
  const [cx, cy] = opts.at ?? atlas.spawn();
  const origin: [number, number] = [Math.round((cx - W / 2) / REGION) * REGION, Math.round((cy - W / 2) / REGION) * REGION];
  const { map, oz, outside, ground } = await atlas.window({ w: W, h: W, zMax }, origin[0], origin[1], SLOTS - K_HEADROOM, TIER);
  const core = new WorldCore(host, map, opts.particles, SLOTS, true, MESH_ROOM);
  const dims = core.dims;
  const climate = (S: { origin: [number, number]; oz: number }) => atlas.climateAt(S.origin[0] + dims.w / 2, S.origin[1] + dims.h / 2, S.oz);
  core.globals.climate = climate({ origin, oz });
  core.globals.seaZ = params.sea - oz;
  // (the camera looks at the window's middle until the game moves it)
  core.camera.target = [dims.w / 2, (dims.h / 2) * ROW_H, map.surface[(dims.h / 2) * dims.w + dims.w / 2]];
  const stream = new Streamer(
    core,
    {
      // (a tile of its columns a frame: streaming mustn't stall the frame)
      region: (x0, y0, w, h) => atlas.regionLand(x0, y0, w, h, Infinity, true),
      wrap: [params.cols, params.rows],
      height: params.zTop,
      snapshot: (x0, y0, w, h) => atlas.snapshot(x0, y0, w, h),
      changes: (s, x0, y0, w, h) => atlas.changes(s, x0, y0, w, h),
    },
    origin,
    { oz, outside, ground },
  );
  if (opts.band !== false && core.renderer.enableBand(params.zTop)) stream.refreshBand();
  let sleep: Sleep | undefined;
  if (opts.sleep !== false) {
    sleep = new Sleep(dims.w / CHUNK, dims.h / CHUNK);
    sleep.settleAll(Sleep.SETTLE_S, performance.now() / 1000);
    core.sleep = sleep;
  }
  let integrity: Integrity | undefined;
  if (opts.integrity !== false) {
    integrity = new Integrity(core);
    core.integrity = integrity;
    // (as the sandbox: the structure system only collapses damage, the integrity system the rest)
    core.globals.spanCollapse = false;
  }
  stream.onSlide.push((dx, dy, dz) => {
    // (a slide in z: every column moved — what's falling goes)
    if (dz) integrity?.clear();
    core.globals.climate = climate(stream);
    core.globals.seaZ = params.sea - stream.oz;
    const t = performance.now() / 1000;
    if (dz) sleep?.settleAll(2, t);
    else sleep?.shift(dx, dy, t);
  });
  if (opts.far !== false) {
    const far = new FarLand(host.gpu.device, atlas, core.renderer.targets);
    // (round 83: the rings draw past the window's edge — no wall down it)
    if (far.lod) core.renderer.openEdges();
    core.renderer.extraDraws.push((pass, clear) => {
      far.org = [stream.origin[0], stream.origin[1] * ROW_H, stream.oz];
      far.win = [dims.w + 0.5, dims.h * ROW_H];
      far.zMax = dims.zMax;
      const c = core.camera.fly ? core.camera.fly.pos : core.camera.target;
      far.mid = [c[0], c[1]];
      far.focus = core.camera.fly ? null : [core.camera.target[0], core.camera.target[1], core.camera.target[2]];
      far.draw(pass, clear);
    });
  }
  const warp = (wcx: number, wcy: number) => warpWindow(atlas, stream, dims, wcx, wcy);
  stream.onWarp.push((_ox, _oy, nz) => {
    integrity?.clear();
    core.globals.climate = climate(stream);
    core.globals.seaZ = params.sea - nz;
    sleep?.settleAll(Sleep.SETTLE_S + 1, performance.now() / 1000);
    const i = Math.floor(dims.h / 2) * dims.w + Math.floor(dims.w / 2);
    core.camera.target = [dims.w / 2, (dims.h / 2) * ROW_H, core.map.surface[i]];
  });
  let lastFrame = performance.now();
  return {
    atlas,
    core,
    stream,
    sleep,
    integrity,
    warp,
    onWarp: stream.onWarp,
    onSlide: stream.onSlide,
    frame(target, reach = 40) {
      void stream.update();
      const now = performance.now();
      integrity?.update(Math.min(0.1, (now - lastFrame) / 1000));
      lastFrame = now;
      if (sleep) {
        const g = core.globals;
        g.sleep = sleep.update(performance.now() / 1000, [target[0], target[1], reach], g.events, core.weather.storms, core.sim.tick);
        g.drowse = sleep.drowse;
        g.settle = sleep.settling.map((s) => s.rect);
      }
      return stream.busy;
    },
    toWorld: (x, y) => [stream.origin[0] + x, stream.origin[1] + y / ROW_H],
    fromWorld: (wx, wy) => [wx - stream.origin[0], (wy - stream.origin[1]) * ROW_H],
  };
}
