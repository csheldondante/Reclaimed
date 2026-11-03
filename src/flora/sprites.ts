// Baked sprites for the far level of detail (round 128, `treegen`; BACKLOG FLO48). The user: "ideally instead of the
// low poly lod we have now we can bake and instance sprites", "I imagine sprites of trees can be small and rendered on
// demand (likely we render normal and albedo and let sceenspace lighting take over right?)", and on the camera: "the
// camera is isometric and doesn't tilt except around cliffs and maybe cities so I'm hoping we can use baked sprites
// often without making too many angles."
//
// What a sprite is: a tree kind's full mesh (the generator's own, so the far tree is the near one) drawn once per yaw
// step at the fixed iso pitch into a small atlas cell — per texel its albedo and coverage, its normal (the tree's own
// frame) and its depth along the view — then drawn as one camera-facing quad an instance, lit per texel exactly as the
// mesh trees are (render.wgsl lighting: sun, sky, the shadow map, haze) from the normal turned by the instance's yaw and
// the point rebuilt from the depth, and written to the depth buffer at that point (frag_depth), so it meets the ground
// and its neighbours as the mesh did. Why not the terrain's G-buffer: the trees are drawn forward (meshinst.wgsl, lit
// in their own fragment), and the G-buffer's resolve is the terrain's look (its structure words) — a sprite lit by the
// same `lighting` from the same data is the same thing without teaching the terrain's resolve the flora's look.
//
// Pure (no GPU) here: the mode, the quad mesh, the bounds and the bake's view per yaw — tested in Node. The GPU side:
// render/florasprites.ts (the atlas and the bake), shaders/florasprite.wgsl (the bake), meshinst.wgsl (the draw).

import type { FloraMesh } from './mesh';

/** `?flod=` the far level: 'mesh' the low-poly tree (round 119), 'sprite' the baked sprite; anything else throws */
export type Flod = 'mesh' | 'sprite';
export function flodMode(q: string | null): Flod {
  if (q === null) return 'mesh';
  if (q !== 'mesh' && q !== 'sprite') throw new Error(`?flod=${q}: mesh or sprite`);
  return q;
}
export const FLOD: Flod = flodMode(typeof location !== 'undefined' ? new URLSearchParams(location.search).get('flod') : null);

/** yaw steps baked a kind (the tree turned in N steps; the camera's turn picks the nearest two and dissolves between) */
export const SPR_YAWS = Number((typeof location !== 'undefined' && new URLSearchParams(location.search).get('fyaws')) || 8);
/** a cell's side (texels): the far level is a tree under ~55 render px tall, so 64 is about a texel a pixel */
export const SPR_CELL = 64;
/** cells across the atlas */
export const SPR_COLS = 16;
/** the iso pitch (render/camera.ts ELEVATION): the bake's and the draw's */
export const SPR_ELEV = (30 * Math.PI) / 180;

/** mesh parts (mesh.ts PART's, past them): 12 the sprite's quad corner, 13 the far mesh kept for the shadow pass only */
export const PART_SPRITE = 12;
export const PART_SHADOW = 13;

/**
 * A sprite's bounds in its tree's frame (the source mesh's height H and radius R): the quad's extent in the view's up
 * axis (v0..v1 — the same for every yaw: the bounds are a cylinder) and the depth range along the eye (d0..d1).
 */
export function spriteBounds(H: number, R: number, elev = SPR_ELEV): { R: number; v0: number; v1: number; d0: number; d1: number } {
  const se = Math.sin(elev);
  const ce = Math.cos(elev);
  // (a margin: the faceted leaves stand a little past the vertices' radius at their faces' middles — no, the vertices
  // bound them; the margin is for the sway at the top)
  const r = R * 1.04;
  return { R: r, v0: -r * se, v1: H * ce + r * se, d0: -r * ce, d1: r * ce + H * se };
}

/** The bake's view for yaw step j of N, in the tree's frame: toward the eye, the view's right and up (unit). */
export function bakeView(j: number, N: number, elev = SPR_ELEV): { eye: [number, number, number]; right: [number, number, number]; up: [number, number, number] } {
  const t = (j / N) * Math.PI * 2;
  const eye: [number, number, number] = [Math.cos(t) * Math.cos(elev), Math.sin(t) * Math.cos(elev), Math.sin(elev)];
  const right: [number, number, number] = [-Math.sin(t), Math.cos(t), 0];
  // up = eye × right
  const up: [number, number, number] = [eye[1] * right[2] - eye[2] * right[1], eye[2] * right[0] - eye[0] * right[2], eye[0] * right[1] - eye[1] * right[0]];
  return { eye, right, up };
}

/**
 * A sprite kind's mesh: the far tree's triangles kept for the shadow pass only (part 13 — the sun's view is not the
 * bake's, so the shadow keeps the far mesh's shape) and a quad (part 12: x, y its corner 0..1, sway up it).
 */
export function spriteKindMesh(far: FloraMesh): FloraMesh {
  const nv = far.verts.length / 4;
  const v = new Float32Array((nv + 4) * 4);
  for (let i = 0; i < nv; i++) {
    v[i * 4] = far.verts[i * 4];
    v[i * 4 + 1] = far.verts[i * 4 + 1];
    v[i * 4 + 2] = far.verts[i * 4 + 2];
    v[i * 4 + 3] = PART_SHADOW + (far.verts[i * 4 + 3] % 1);
  }
  const q = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ];
  q.forEach(([x, y], k) => v.set([x, y, 0, PART_SPRITE + y * 0.8], (nv + k) * 4));
  const index = new Uint32Array(far.index.length + 6);
  index.set(far.index);
  index.set([nv, nv + 1, nv + 2, nv, nv + 2, nv + 3], far.index.length);
  const uv = new Float32Array((nv + 4) * 2);
  uv.set(far.uv);
  return { verts: v, uv, index, height: far.height, radius: far.radius, tris: index.length / 3 };
}
