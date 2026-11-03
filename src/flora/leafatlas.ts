// The leaf-cluster atlas (round 128, the user: "I want the leaf cluster cards that was what I asked for"): one texture of
// leaf clusters — a row a species, CLUSTER_VARIANTS clusters a row — each tile several overlapping leaves of the
// species' shape (5-12), with veins, darker edges, the shadow of the leaves over them, their own alpha silhouette and
// normals. The layered crown's cards (mesh.ts addLayeredCrown) each show one tile; the look (floralook.wgsl) tints it
// by the species' colours, the season and the shell's occlusion. Made once on the CPU (pure: tested), with its mips
// (coverage kept, so a far crown doesn't thin out), and shared by the instanced draw, the sprite bake and the viewer.
// Channels: r coverage, g the leaf's shade (veins, edge, its own brightness, the shadow from above), b a the tangent
// normal (x, y) × 0.5 + 0.5.

import { rng, hashSeed } from './rng';
import type { SpeciesId } from './species';

export const LEAF_TILE = 64;
export const CLUSTER_VARIANTS = 4;

interface LeafShape {
  /** leaves a cluster */
  count: [number, number];
  /** a leaf's length and its half-width at the widest, a share of the tile */
  length: number;
  width: number;
  /** the outline: oak's lobes, a birch's diamond, a willow's narrow lance, an elder's broad round leaf */
  profile: 'lobed' | 'round' | 'diamond' | 'lance' | 'oval';
  /** how far the leaves fan from the cluster's middle (0 all from one point .. 1 spread over the tile) */
  spread: number;
  /** the leaves hang (willow): their tips pulled toward the tile's bottom */
  hang?: number;
}

/** the species drawn with leaf clusters, a row each (the conifers keep their needle shells) */
export const LEAF_SHAPES: Partial<Record<SpeciesId, LeafShape>> = {
  oak: { count: [7, 9], length: 0.42, width: 0.15, profile: 'lobed', spread: 0.55 },
  giant: { count: [6, 8], length: 0.44, width: 0.19, profile: 'round', spread: 0.5 },
  birch: { count: [10, 13], length: 0.38, width: 0.13, profile: 'diamond', spread: 0.6 },
  willow: { count: [12, 15], length: 0.46, width: 0.07, profile: 'lance', spread: 0.45, hang: 0.35 },
  shrub: { count: [10, 12], length: 0.36, width: 0.12, profile: 'oval', spread: 0.6 },
};
export const LEAF_ROWS = Object.keys(LEAF_SHAPES) as SpeciesId[];

/** the atlas row of a species' clusters, −1 none */
export function leafRow(id: SpeciesId): number {
  return LEAF_ROWS.indexOf(id);
}

/** a leaf's half-width at a (0 base .. 1 tip), a share of its widest */
function profile(p: LeafShape['profile'], a: number): number {
  if (a <= 0 || a >= 1) return 0;
  const s = Math.sin(Math.PI * a);
  switch (p) {
    case 'lobed':
      return Math.pow(s, 0.8) * (0.82 + 0.18 * Math.cos(a * Math.PI * 7));
    case 'round':
      return Math.pow(s, 0.55) * (a < 0.85 ? 1 : 1 - (a - 0.85) * 2);
    case 'diamond':
      return a < 0.4 ? a / 0.4 : (1 - a) / 0.6;
    case 'lance':
      return Math.pow(s, 0.9);
    case 'oval':
      return Math.pow(s, 0.7);
  }
}

interface Leaf {
  bx: number;
  by: number;
  dx: number;
  dy: number;
  len: number;
  wid: number;
  shade: number;
}

function clusterLeaves(sh: LeafShape, seed: number): Leaf[] {
  const r = rng(seed);
  const n = sh.count[0] + Math.floor(r() * (sh.count[1] - sh.count[0] + 1));
  const out: Leaf[] = [];
  for (let i = 0; i < n; i++) {
    // fanned round the tile's middle, from a stalk point a little below it; the later ones (on top) nearer the middle
    const a = (i / n) * Math.PI * 2 + (r() - 0.5) * 0.9;
    const len = sh.length * (0.8 + 0.35 * r());
    const rad = sh.spread * 0.22 * (0.4 + 0.6 * r()) * (1 - 0.35 * (i / n));
    let dx = Math.cos(a);
    let dy = Math.sin(a);
    if (sh.hang) {
      dy = dy * (1 - sh.hang) + sh.hang;
      const l = Math.hypot(dx, dy) || 1;
      dx /= l;
      dy /= l;
    }
    // (from a stalk point near the middle, out along its own way: the cluster's leaves radiate)
    const bx = 0.5 + Math.cos(a) * rad * 0.35;
    const by = 0.5 + Math.sin(a) * rad * 0.35;
    out.push({ bx, by, dx, dy, len, wid: sh.width * (0.85 + 0.3 * r()), shade: 0.78 + 0.27 * r() });
  }
  return out;
}

/** which leaf (topmost) covers tile point (x, y), its along/across there; null none */
function hit(leaves: Leaf[], sh: LeafShape, x: number, y: number, above = -1): { i: number; a: number; c: number } | null {
  for (let i = leaves.length - 1; i > above; i--) {
    const L = leaves[i];
    const qx = x - L.bx;
    const qy = y - L.by;
    const a = (qx * L.dx + qy * L.dy) / L.len;
    const w = profile(sh.profile, a) * L.wid;
    if (w <= 0) continue;
    const c = (-qx * L.dy + qy * L.dx) / w;
    if (Math.abs(c) < 1) return { i, a, c };
  }
  return null;
}

/** The atlas's mip 0: (CLUSTER_VARIANTS × LEAF_TILE) × (rows × LEAF_TILE) RGBA8. */
export function leafAtlasBase(seed = 128): { data: Uint8Array; w: number; h: number } {
  const w = CLUSTER_VARIANTS * LEAF_TILE;
  const h = LEAF_ROWS.length * LEAF_TILE;
  const data = new Uint8Array(w * h * 4);
  const SS = [0.25, 0.75];
  LEAF_ROWS.forEach((id, row) => {
    const sh = LEAF_SHAPES[id]!;
    for (let v = 0; v < CLUSTER_VARIANTS; v++) {
      const leaves = clusterLeaves(sh, hashSeed(seed, row * 31 + v, 7));
      for (let py = 0; py < LEAF_TILE; py++)
        for (let px = 0; px < LEAF_TILE; px++) {
          let cov = 0;
          let g = 0;
          let nx = 0;
          let ny = 0;
          for (const sy of SS)
            for (const sx of SS) {
              const x = (px + sx) / LEAF_TILE;
              const y = (py + sy) / LEAF_TILE;
              const t = hit(leaves, sh, x, y);
              if (!t) continue;
              const L = leaves[t.i];
              cov++;
              // the leaf's shade: its own brightness, the midrib and side veins lighter, the edge darker, the fold (a
              // leaf creased along its midrib: the upper half lit), and the shadow of a leaf on top a little up-left
              const rib = 1 - Math.min(1, Math.abs(t.c) / 0.12);
              const side = Math.max(0, 1 - Math.abs(((t.a * 5 + Math.abs(t.c) * 1.6) % 1) - 0.5) * 8) * (1 - Math.abs(t.c)) * 0.6;
              const edge = Math.max(0, (Math.abs(t.c) - 0.6) / 0.4);
              const fold = t.c > 0 ? 1.06 : 0.9;
              const shadowed = hit(leaves, sh, x + 0.035, y + 0.035, t.i) ? 0.68 : 1;
              g += L.shade * (1 + 0.12 * rib + 0.06 * side - 0.28 * edge) * fold * shadowed;
              // the normal: the crease (across the leaf, ± the fold) and the leaf's tilt toward its tip
              const cx = -L.dy * Math.sign(t.c) * 0.35;
              const cy = L.dx * Math.sign(t.c) * 0.35;
              nx += cx + L.dx * 0.15 * (t.a - 0.5);
              ny += cy + L.dy * 0.15 * (t.a - 0.5);
            }
          const o = (((row * LEAF_TILE + py) * w) + v * LEAF_TILE + px) * 4;
          data[o] = Math.round((cov / 4) * 255);
          if (cov > 0) {
            data[o + 1] = Math.round(Math.min(1, (g / cov) * 0.9) * 255);
            data[o + 2] = Math.round(Math.min(1, Math.max(0, (nx / cov) * 0.5 + 0.5)) * 255);
            data[o + 3] = Math.round(Math.min(1, Math.max(0, (ny / cov) * 0.5 + 0.5)) * 255);
          } else {
            data[o + 2] = 128;
            data[o + 3] = 128;
          }
        }
    }
  });
  return { data, w, h };
}

/**
 * The mip chain (2 × 2 boxes; the shade and the normal weighted by coverage; the coverage raised a little a level — a
 * cluster's leaves would otherwise thin to nothing far off), down to a tile 1 texel. Level 0 first.
 */
export function leafAtlasMips(base: { data: Uint8Array; w: number; h: number }): { data: Uint8Array; w: number; h: number }[] {
  const out = [base];
  let cur = base;
  for (let t = LEAF_TILE; t > 1; t >>= 1) {
    const w = cur.w >> 1;
    const h = cur.h >> 1;
    const d = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        let a = 0;
        let g = 0;
        let nx = 0;
        let ny = 0;
        for (let j = 0; j < 2; j++)
          for (let i = 0; i < 2; i++) {
            const o = ((y * 2 + j) * cur.w + x * 2 + i) * 4;
            const c = cur.data[o];
            a += c;
            g += cur.data[o + 1] * c;
            nx += cur.data[o + 2] * c;
            ny += cur.data[o + 3] * c;
          }
        const o = (y * w + x) * 4;
        d[o] = Math.min(255, Math.round((a / 4) * 1.15));
        d[o + 1] = a ? Math.round(g / a) : 0;
        d[o + 2] = a ? Math.round(nx / a) : 128;
        d[o + 3] = a ? Math.round(ny / a) : 128;
      }
    cur = { data: d, w, h };
    out.push(cur);
  }
  return out;
}

let made: { data: Uint8Array; w: number; h: number }[] | null = null;
/** the atlas's levels (made once a page) */
export function leafAtlas(): { data: Uint8Array; w: number; h: number }[] {
  return (made ??= leafAtlasMips(leafAtlasBase()));
}

/** The atlas as a GPU texture, every level written (rgba8unorm, read by textureLoad at a level the look picks). */
export function leafAtlasTexture(device: GPUDevice): GPUTexture {
  const levels = leafAtlas();
  const tex = device.createTexture({ label: 'leaf-atlas', size: [levels[0].w, levels[0].h], format: 'rgba8unorm', mipLevelCount: levels.length, usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
  levels.forEach((l, i) => device.queue.writeTexture({ texture: tex, mipLevel: i }, l.data, { bytesPerRow: l.w * 4 }, [l.w, l.h]));
  return tex;
}
