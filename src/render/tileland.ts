// The render-only land's shared types (round 104 TC2; round 105, tilelatency: the playable path that lived here —
// the streamer's regionInto, its settlement plan awaited, its finish read back, the CPU's loop, the mesher's frames —
// retired: render/tilelandgpu.ts is the only path, everything on the GPU from the ask to the draw).

import type { RegionLayout } from '../world/region-record';

/** what makes a region's land for a tile (level.ts: the streamer's) */
export interface TileLandSource {
  /** (round 108, TC19) a tile's scratch: the region and `border` cells round it, in the corner of this layout's slot */
  layout: RegionLayout;
  border: number;
  /** the window's oz (the land is cut at it) */
  oz(): number;
  /** (round 112, `tilefix`) region (corner x0, y0: world cells)'s heights as the CPU knows them (world z), or null */
  zRange(x0: number, y0: number): [number, number] | null;
  /** (Streamer.tileLand) region (corner x0, y0: world cells)'s land and its border into buf at off (the border's corner
   *  the slot's), its per-column summary (the batch's, (R + 2 border)²) into meta — nothing read back; resolves once
   *  it's all submitted. (round 112, tilefast) `order`: its place in the pacer's tiles' lane, lower first */
  landTile(x0: number, y0: number, buf: GPUBuffer, off: number, meta: { buf: GPUBuffer; off: number }, order: number): Promise<void> | null;
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
  /** (round 112, tilefast) the renderer's frames from its start to its land made (TileCache.frameNo) */
  frames?: number;
}
