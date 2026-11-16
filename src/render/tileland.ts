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
  /** (mutators round 6, MU-49; Streamer.onTileLand) a tile's land is in its world, generated and not yet prepared for
   *  its bake: what the window's land gets written into it after its generation (Streamer.onWritten: the world
   *  modifier list) encoded here, into the bake's own encoder. Nothing read back; nothing when no one listens. */
  written?(t: TileLandWritten): void;
}

/** a tile's land as its writers see it (render/tileworld.ts): the per-column contract buffers of a world `side` cells
 *  square whose cell (0, 0) is world cell (x0, y0), cut at window height oz */
export interface TileLandWritten {
  enc: GPUCommandEncoder;
  world: { globals: GPUBuffer; chunks: GPUBuffer; materials: GPUBuffer; layers: GPUBuffer; water: GPUBuffer; veg: GPUBuffer; lava: GPUBuffer; wilt: GPUBuffer; contam: GPUBuffer };
  /** the slot the land was generated into (in `world.layers`), and its record's layout: the kept fields the tiles'
   *  world has no buffer for (the water's sources) are read from there */
  layout: RegionLayout;
  slotOff: number;
  x0: number;
  y0: number;
  oz: number;
  side: number;
  /** the renderer's frame (TileCache.frameNo): several tiles are written in one frame's encoder */
  frame: number;
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
