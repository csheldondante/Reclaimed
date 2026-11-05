// The renderer's sizes, formats and URL flags (CAM_BYTES, SHADOW_SIZE, TILES, SKIP ...), its public types (PickHit,
// RenderOptions; re-exported by renderer.ts) and cutOn. Owns no state.
import { CAMERA_BYTES, CAMERA_CUT_BYTES, type Camera } from '../camera';

/** the draw shaders' camera (render.wgsl Camera): the view's, then the sun's shadow matrix */
export const CAM_BYTES = CAMERA_BYTES + 64 + 16 + CAMERA_CUT_BYTES;
/** the sun's shadow map, texels a side (the whole map: ~0.15 cells a texel on 256²) */
export const SHADOW_SIZE = 2048;
export const SHADOW_FORMAT: GPUTextureFormat = 'depth32float';

// a hex prism: the top in four triangles + three sides (render.wgsl)
export const VERTS_PER_PRISM = 30;
// a plant box: the top + two sides
export const VERTS_PER_BOX = 18;
// a prism whose sides are all hidden: its top alone (the prism's first 12)
export const VERTS_PER_TOP = 12;
/** Extra instances a column may emit beyond its slots (shrub/trunk+crown, tufts, flower). */
// per cell worst case: plan (tree 2 + tufts 3 + flower 1) + a planting (6) + drift (1)
export const VEG_INSTANCES = 13;
/**
 * (round 93; on unless ?instgrow=0, measured: DEVLOG round 93) The instance lists sized to use, not their worst case (a column's every interval, every
 * plant box, four blended boxes): they start at INST_START of a list's worst case and grow by half (to at least
 * 1.25 × what was asked) when a frame asks for more than INST_GROW_AT of the room (renderprep.wgsl putO, putW;
 * vegprep.wgsl putP, clampVeg — the writes past the room are left out and the counts clamped meanwhile).
 */
export const INST_GROW = new URLSearchParams(location.search).get('instgrow') !== '0';
export const INST_START = 0.1;
export const INST_GROW_AT = 0.85;
export const PICK_FORMAT: GPUTextureFormat = 'rg32uint';

/** What the pick target says is under a pixel. */
export interface PickHit {
  cell: number;
  mat: number;
  z: number;
  /** instance flags (2 = vegetation, …) */
  flags: number;
}
export const DEPTH_FORMAT: GPUTextureFormat = 'depth24plus';

export interface RenderOptions {
  rainParticles: number;
  /** sRGB background */
  clear: [number, number, number];
  /** toward the sun (world, unit) */
  sun: [number, number, number];
}

/** (perfopt) the winding of the mesh's faces out of the solid on screen (fieldmesh.wgsl makeQuads; ?front=cw to try the other) */
export const STRUCT_CULL: GPUCullMode = (new URLSearchParams(location.search).get('scull') ?? 'back') as GPUCullMode;
export const MESH_FRONT: GPUFrontFace = new URLSearchParams(location.search).get('front') === 'cw' ? 'cw' : 'ccw';
/** (round 86) ?hybrid=1 (phone-flags' LITE_SET on the low tier): the window's heightfield chunks drawn as a grid
 *  (meshdraw.wgsl vsGrid) — its pipelines made */
export const HYBRID = new URLSearchParams(location.search).get('hybrid') === '1';
/** (round 103) the world-anchored tile cache (render/tilecache.ts) — the land past the window drawn from tiles; round
 *  105 (DECISIONS: the user signed off on the tiles): on by default, ?tiles=0 off */
export const TILES = new URLSearchParams(location.search).get('tiles') !== '0';
/** meshdraw.wgsl GRID_N: a grid chunk's lattice, vertices a side (its 32 columns and one past each edge) */
export const GRID_N = 34;
/** (perfopt) the look's pieces ?nodetail= can leave out (meshdraw.wgsl ND_*; shadow: render.wgsl lighting) */
export const DETAIL_BITS: Record<string, number> = { strata: 1, water: 2, plants: 4, stains: 8, struct: 16, shadow: 32, warp: 64, fields: 128, specks: 256 };

// (perf branch: ?skip=render (round 82: world-core.ts — nothing drawn),opaque,tops,plants,prisms,mesh,bodies,structs,voxels,skins,water,particles,rain,shadow,prep,meshprep
// leaves that piece out of the frame, to measure what it costs: scripts/perfprofile.mjs)
/** (perfopt, tcache) the cached terrain layer's margin past the screen, render pixels a side */
export const TC_MARGIN = 24;
export const SKIP = new Set((new URLSearchParams(location.search).get('skip') ?? '').split(',').filter(Boolean));


/** (round 83) is anything cut from the camera's view (a slice, a hole round a point kept seen)? */
export function cutOn(cam: Camera): boolean {
  return cam.cut.slice !== null || cam.cut.see.length > 0;
}
