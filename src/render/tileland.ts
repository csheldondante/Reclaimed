// The render-only land's shared types (round 104 TC2; round 105, tilelatency: the playable path that lived here —
// the streamer's regionInto, its settlement plan awaited, its finish read back, the CPU's loop, the mesher's frames —
// retired: render/tilelandgpu.ts is the only path, everything on the GPU from the ask to the draw).

import type { RegionLayout } from '../world/region-record';

/** what makes a region's land for a tile (level.ts: the streamer's) */
export interface TileLandSource {
  layout: RegionLayout;
  /** the window's oz (the land is cut at it) */
  oz(): number;
  /** (Streamer.landTile) the region's land into buf at off, its per-column summary into meta — nothing read back;
   *  resolves once it's all submitted */
  landTile(x0: number, y0: number, buf: GPUBuffer, off: number, meta: { buf: GPUBuffer; off: number }): Promise<void> | null;
}

/** (round 105, tilelatency) a region's way from wanted to drawn (performance.now() ms; 0: not that stage's) */
export interface LandTimes {
  key: string;
  wanted: number;
  start: number;
  cols: number;
  ways: number;
  mapped: number;
  ready: number;
  cur: number;
  baked: number;
  drawn: number;
}
