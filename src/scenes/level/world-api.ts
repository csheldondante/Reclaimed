// (round 128n, phonefix) The level's world API (api/world.ts), attached once, its mirror never on a timer: the game's
// questions of the ground go to the WorldQuery (game/worldquery.ts), a page at a time when asked. The tools that still
// read the whole window's ground from the mirror (the cutaway, the sandbox's, a story run's, the test API) say so with
// mirroredApiOf: the mirror refreshes on its timer from then on, as it did for everything before (the phone's fortress
// had 35 MB mapped every 250 ms from its first Build). API: worldApiOf, mirroredApiOf, worldQueryOf.
import { SIM_ALL, attachSim, type Sim } from '../../api/world';
import type { LevelScene } from '../level';
import { GpuPages, WorldQuery } from '../../game/worldquery';
import { EventKind } from '../../sim/globals';

/** the level's world API: edits, effects, the units' terrain — no mirror reads on a timer */
export function worldApiOf(scene: LevelScene): Sim {
  return (scene.worldApi ??= attachSim(scene.core, { ...SIM_ALL, refreshMs: 0 }));
}

/** the level's world API with its mirror refreshed on the timer (a tool that reads the whole window's ground) */
export function mirroredApiOf(scene: LevelScene): Sim {
  const api = worldApiOf(scene);
  api.keepMirrored();
  return api;
}

/**
 * (round 128n, phonefix) The level's WorldQuery (game/worldquery.ts): the heights, layers and trees the fortress asks
 * of the window, read back a page at a time when asked — not the world API's mirror on a timer (35 MB mapped every
 * 250 ms once Build attached it). Its pages go stale where an edit, a strike or a chip lands (the sim's event taps)
 * and wherever a column apply runs (claims, stamps), and on a slide or a warp (the window's epoch).
 */
export function worldQueryOf(scene: LevelScene): WorldQuery {
  if (scene.worldQuery) return scene.worldQuery;
  const core = scene.core;
  const p = core.packed;
  const chunk = (cx: number, cy: number): [number, number] => {
    const ci = cy * p.chunksX + cx;
    return [p.chunkTable[ci * 2], p.chunkTable[ci * 2 + 1]];
  };
  const q = new WorldQuery({
    dims: { w: core.dims.w, h: core.dims.h },
    epoch: () => core.windowEpoch,
    kOf: (cx, cy) => chunk(cx, cy)[1],
    origin: () => core.globals.origin ?? [0, 0],
    reader: new GpuPages({
      device: scene.host.gpu.device,
      levels: () => core.world.levels,
      layers: () => core.world.layers,
      veg: () => core.world.veg,
      slot: (cx, cy) => core.ring.slot(cx, cy),
      texPage: (s) => core.ring.texPage(s),
      chunk,
    }),
  });
  core.sim.eventTaps.push((sent) => {
    for (const e of sent) if (e.kind === EventKind.Edit || e.kind === EventKind.Lightning || e.kind === EventKind.Chip) q.touch(e.x, e.y, e.radius + 2);
  });
  core.columnApply.onApply.push(() => q.touch());
  scene.worldQuery = q;
  return q;
}
