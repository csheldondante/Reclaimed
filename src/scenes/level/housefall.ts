// (PA11) Houses knocked down, in the level: under `?solver=engine`, a row of the physics engine that hits a building
// (an External interval) hard enough — `TUNE.engine.houseBreak`, the energy the stop took — takes the building's lot
// from its town (FieldTown.lotAt, takeLot: flagged gone, its mesh sunk, its claim left out) and, in the same step,
// lets the lot's External spans go and adds blocks of the engine in their place (game/housefall.ts), under dust.
// A swap, not a break of the house's mesh: the crude first version, logged PA12.
//
// Data flow: the hit is kept on the GPU (the ring after the engine's events) and reaches the host with the engine's
// chained read, after the event; then two small reads of the town (36 B: whose columns; 100 B: the lot's record).
// Nothing is read a frame. One lot a tick at most: each block is baked on the CPU when added (PT3), so the hits wait
// in a queue (PA14: the hitch is logged in `housefall.log`).
// API: installHouseFall(scene); `globalThis.housefall` = { log, queued } for the lab's scripts.
import type { OwnerHit } from '../../engine/engine';
import { fellLot } from '../../game/housefall';
import { edit } from '../../game/integrity/columns';
import { TUNE } from '../../tune/params';
import { cellPos } from '../../world/lattice';
import { MAT } from '../../world/materials';
import type { LevelScene } from '../level';

/** what a felled house's blocks are made of: no lot names a material yet (its claim's fallback is rubble); plain
 *  concrete is the nearest in colour to the houses' walls (PA12) */
const HOUSE_MAT = MAT.Concrete;

export interface HouseFallen {
  town: string;
  lot: number;
  energy: number;
  /** the middle of its footprint (window world units when it fell) and its base */
  at: [number, number, number];
  columns: number;
  blocks: number;
  cells: number;
  /** the host's time for the swap: the spans let go and the blocks baked and added (ms) */
  ms: number;
  tick: number;
}

export function installHouseFall(scene: LevelScene): void {
  const kit = scene.engine;
  const ig = scene.integrity;
  if (!kit || !ig) return;
  const { core } = scene;
  const queue: OwnerHit[] = [];
  const log: HouseFallen[] = [];
  let busy = false;

  const fell = async (h: OwnerHit): Promise<void> => {
    for (const [id, town] of scene.fieldTowns?.live ?? []) {
      const lot = await town.lotAt(h.p[0], h.p[1]);
      if (lot === null) continue;
      const box = await town.takeLot(lot);
      if (!box) return;
      const t0 = performance.now();
      const out = fellLot(box, HOUSE_MAT, {
        release: (spans) => edit(ig, [{ cuts: [], release: spans }]),
        drop: (cells) => void kit.drop(cells),
      });
      if (!out) return;
      const ms = performance.now() - t0;
      // (the ground's mesh there now, and dust over the swap)
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      for (const [cx, cy] of out.columns) {
        const [x, y] = cellPos(cx, cy);
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x);
        y1 = Math.max(y1, y);
      }
      core.renderer.fieldMesh.urgent(x0 - 1, y0 - 1, x1 + 1, y1 + 1);
      const mid: [number, number, number] = [(x0 + x1) / 2, (y0 + y1) / 2, box.base + box.height / 2];
      const r = Math.hypot(x1 - x0, y1 - y0) / 2;
      ig.onDust?.(mid[0], mid[1], mid[2], Math.min(120, out.cells / 3), r, HOUSE_MAT);
      ig.onDust?.(mid[0], mid[1], box.base + box.height, Math.min(60, out.cells / 6), r * 0.7, HOUSE_MAT);
      ig.onCollapse?.(mid[0], mid[1], mid[2], out.cells);
      kit.engine.wakeNear(mid, r + 4);
      log.push({ town: id, lot, energy: Math.round(h.energy), at: [mid[0], mid[1], box.base], columns: out.columns.length, blocks: out.blocks.length, cells: out.cells, ms: +ms.toFixed(1), tick: core.ticksRun });
      console.log(`[housefall] ${town.site.name}: lot ${lot} knocked down by a hit of ${Math.round(h.energy)} — ${out.blocks.length} blocks, ${out.cells} cells, ${ms.toFixed(1)} ms`);
      return;
    }
  };

  const pump = async (): Promise<void> => {
    if (busy) return;
    busy = true;
    try {
      while (queue.length) {
        const tick = core.ticksRun;
        await fell(queue.shift()!);
        // (one lot a tick: the next waits for the world's next tick)
        while (queue.length && core.ticksRun === tick) await new Promise((res) => setTimeout(res, 8));
      }
    } finally {
      busy = false;
    }
  };

  kit.engine.onOwnerHit = (h) => {
    if (h.energy < TUNE.engine.houseBreak) return;
    queue.push(h);
    void pump();
  };
  (globalThis as { housefall?: unknown }).housefall = {
    log,
    get queued() {
      return queue.length;
    },
  };
}
