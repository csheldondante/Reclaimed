// One plant from (species, seed) (round 117): the L-system and turtle for the woody plants, the root automaton for
// the trees' surface roots, small direct generators for the herbs. Every plant is scaled into its species' height
// range by the seed, so variants differ in shape and size but read as one species.

import { expand, interpret, norm, type V3 } from './lsystem';
import { buildPlant, MeshBuilder, PART, type FloraMesh } from './mesh';
import { growRoots, rootSegments } from './roots';
import { rng, hashSeed } from './rng';
import { SPECIES, type SpeciesDef, type SpeciesId } from './species';

/** Scale a mesh in place so its height is h (about its foot). */
function scaleTo(m: FloraMesh, h: number): FloraMesh {
  const k = h / Math.max(m.height, 1e-3);
  for (let i = 0; i < m.verts.length; i += 4) {
    m.verts[i] *= k;
    m.verts[i + 1] *= k;
    m.verts[i + 2] *= k;
  }
  m.height *= k;
  m.radius *= k;
  return m;
}

/**
 * Plant `id` from `seed`. `growth` 0..1 (default 1, mature): a young plant — the L-system rewritten fewer times (so a
 * sapling really is the tree's earlier stage, its first branches the same) and smaller; the viewer's grow slider.
 */
/**
 * `px` (round 117, the phone): render pixels a cell at the view the plant is made for (the library's: zoom 12 × the
 * tier's render pixels a CSS pixel). Below ~16, wood is kept at least ~1.7 px wide, leaves merge into clusters at
 * least ~3 px, grass has fewer, wider blades — so the phone's half-scale render reads as a forest, not noise. Absent:
 * full detail (the viewer, the desktop).
 */
export function generate(id: SpeciesId, seed: number, opts: { growth?: number; px?: number } = {}): FloraMesh {
  const sp0 = SPECIES[id];
  const g = Math.min(1, Math.max(0.05, opts.growth ?? 1));
  const sp = g < 1 && sp0.lsystem ? { ...sp0, lsystem: { ...sp0.lsystem, iterations: Math.max(1, Math.round(sp0.lsystem.iterations * (0.35 + 0.65 * g))) } } : sp0;
  const r = rng(hashSeed(seed, id.length * 7919 + id.charCodeAt(0)));
  const h = (sp.height[0] + (sp.height[1] - sp.height[0]) * r()) * (0.25 + 0.75 * g);
  switch (sp.form) {
    case 'tree':
    case 'shrub':
    case 'fern':
      return scaleTo(woody(sp, seed, h, opts.px), h);
    case 'vine':
      return scaleTo(vine(sp, seed), h);
    case 'grass': {
      // (a blade at least ~1.7 px wide; fewer of them when they are wide)
      const w = opts.px ? Math.max(0.16, 1.7 / opts.px) : 0.16;
      return grassClump(h, seed, w > 0.22 ? 6 : 9, 0.5, w);
    }
    case 'reed':
      return reeds(h, seed);
    case 'flower':
      return flower(h, seed);
    case 'moss':
      return scaleTo(moss(h, seed), h);
  }
}

function woody(sp: SpeciesDef, seed: number, h: number, px?: number): FloraMesh {
  if (!sp.lsystem || !sp.turtle || !sp.leaf) throw new Error(`species ${sp.id}: a woody plant needs an L-system, a turtle and leaves`);
  const str = expand(sp.lsystem, hashSeed(seed, 1));
  const sk = interpret(str, sp.turtle, hashSeed(seed, 2));
  // (the scale it will be drawn at: the minimum widths in world cells, then in the skeleton's units)
  const k = h / Math.max(sk.height, 1e-3);
  const minRadius = px ? 0.85 / px / k : 0;
  const minLeaf = px ? 1.5 / px / k : 0;
  // the root automaton's surface roots, in the skeleton's units (the plant is scaled after)
  const roots = sp.roots ? rootSegments(growRoots(sp.roots, hashSeed(seed, 3)), sp.roots.res * 1.5, sp.turtle.radius * 0.8) : [];
  return buildPlant(sk, sp.leaf, hashSeed(seed, 4), { roots, sides: sp.form === 'tree' ? 6 : 4, minTwig: sp.form === 'tree' ? 0.035 : 0, minRadius: sp.form === 'tree' ? minRadius : 0, minLeaf });
}

/** A vine on a wall: the L-system grows in the wall's plane (y, z); leaves stand off it (+x, the wall's normal). */
function vine(sp: SpeciesDef, seed: number): FloraMesh {
  const str = expand(sp.lsystem!, hashSeed(seed, 1));
  const sk = interpret(str, sp.turtle!, hashSeed(seed, 2));
  const r01 = rng(hashSeed(seed, 5));
  const H = Math.max(sk.height, 0.5);
  const mb = new MeshBuilder((p) => (Math.max(0, p[2]) / H) * 0.5);
  for (const g of sk.segments) {
    // pressed to the wall (x a little out from it)
    mb.tube({ ...g, a: [0.04, g.a[1], g.a[2]], b: [0.04, g.b[1], g.b[2]] }, 3, PART.wood);
  }
  for (const l of sk.leaves) {
    const s = sp.leaf!.size;
    mb.blob([0.12, l.p[1] + (r01() - 0.5) * s, l.p[2] + (r01() - 0.5) * s], [s * 0.35, s, s * 0.85], PART.leaf, r01, 0.1);
  }
  return mb.done();
}

/** Tall grass: blades from a small patch, each leaning out and curving over, the tallest in the middle. */
export function grassClump(h: number, seed: number, blades: number, patch: number, width = 0.16): FloraMesh {
  const r = rng(hashSeed(seed, 11));
  // the wind takes the blades' tips: sway rises with the square of the height share, nearly all of it at the tip
  const mb = new MeshBuilder((p) => Math.pow(Math.max(0, p[2]) / h, 1.5) * 0.98);
  for (let k = 0; k < blades; k++) {
    const a = r() * Math.PI * 2;
    const d = Math.sqrt(r()) * patch;
    const p: V3 = [Math.cos(a) * d, Math.sin(a) * d, 0];
    const lean = 0.25 + 0.35 * r();
    const dir = norm([Math.cos(a) * lean, Math.sin(a) * lean, 1]);
    const len = h * (0.6 + 0.4 * (1 - d / patch)) * (0.8 + 0.25 * r());
    const bend: V3 = [Math.cos(a) * 0.16, Math.sin(a) * 0.16, -0.05];
    // (blades a fifth of a cell wide: wide enough to read as blades on the phone's low tier, where a thinner one is
    // under a pixel; two bends each)
    mb.blade(p, dir, len, width + 0.07 * r(), 2, bend, PART.blade);
    // a few seed heads (the accent colour) on the tallest
    if (k % 4 === 0) mb.cone([p[0] + dir[0] * len * 0.85, p[1] + dir[1] * len * 0.85, len * 0.84], dir, 0.22, 0.04, 3, PART.accent);
  }
  const m = mb.done();
  m.height = h;
  return m;
}

/** Reeds: straight stalks, narrow leaves, cattail heads. */
function reeds(h: number, seed: number): FloraMesh {
  const r = rng(hashSeed(seed, 12));
  const mb = new MeshBuilder((p) => Math.pow(Math.max(0, p[2]) / h, 1.3) * 0.9);
  const n = 6 + Math.floor(r() * 4);
  for (let k = 0; k < n; k++) {
    const a = r() * Math.PI * 2;
    const d = Math.sqrt(r()) * 0.45;
    const p: V3 = [Math.cos(a) * d, Math.sin(a) * d, 0];
    const len = h * (0.7 + 0.3 * r());
    const dir = norm([Math.cos(a) * 0.06, Math.sin(a) * 0.06, 1]);
    mb.tube({ a: p, b: [p[0] + dir[0] * len, p[1] + dir[1] * len, len], r0: 0.035, r1: 0.02, depth: 1 }, 3, PART.blade);
    if (k % 2 === 0) {
      // a cattail: a brown cylinder near the top
      const t0 = len * 0.72;
      mb.tube({ a: [p[0] + dir[0] * t0, p[1] + dir[1] * t0, t0], b: [p[0] + dir[0] * (t0 + 0.4), p[1] + dir[1] * (t0 + 0.4), t0 + 0.4], r0: 0.08, r1: 0.075, depth: 1 }, 5, PART.accent);
    } else {
      // a leaf arching off
      mb.blade(p, norm([Math.cos(a + 1) * 0.4, Math.sin(a + 1) * 0.4, 1]), len * 0.8, 0.09, 3, [Math.cos(a + 1) * 0.15, Math.sin(a + 1) * 0.15, -0.05], PART.blade);
    }
  }
  const m = mb.done();
  m.height = h;
  return m;
}

/** A wildflower: a stem, two leaves, a head of five petals round a heart. */
function flower(h: number, seed: number): FloraMesh {
  const r = rng(hashSeed(seed, 13));
  const mb = new MeshBuilder((p) => Math.pow(Math.max(0, p[2]) / h, 1.3) * 0.95);
  const top: V3 = [(r() - 0.5) * 0.15, (r() - 0.5) * 0.15, h];
  mb.tube({ a: [0, 0, 0], b: top, r0: 0.03, r1: 0.022, depth: 1 }, 3, PART.blade);
  for (let k = 0; k < 2; k++) {
    const a = r() * Math.PI * 2;
    mb.blade([0, 0, h * 0.2], norm([Math.cos(a), Math.sin(a), 0.8]), h * 0.45, 0.1, 2, [0, 0, -0.2], PART.blade);
  }
  const petals = 5;
  const pr = 0.16 + 0.06 * r();
  const turn = r() * Math.PI;
  for (let k = 0; k < petals; k++) {
    const a = turn + (k / petals) * Math.PI * 2;
    const tip: V3 = [top[0] + Math.cos(a) * pr, top[1] + Math.sin(a) * pr, top[2] + 0.04];
    const s0: V3 = [top[0] + Math.cos(a - 0.5) * pr * 0.45, top[1] + Math.sin(a - 0.5) * pr * 0.45, top[2]];
    const s1: V3 = [top[0] + Math.cos(a + 0.5) * pr * 0.45, top[1] + Math.sin(a + 0.5) * pr * 0.45, top[2]];
    mb.tri2(mb.vert(top, PART.flower), mb.vert(s0, PART.flower), mb.vert(tip, PART.flower));
    mb.tri2(mb.vert(top, PART.flower), mb.vert(tip, PART.flower), mb.vert(s1, PART.flower));
  }
  mb.blob([top[0], top[1], top[2] + 0.03], [0.05, 0.05, 0.04], PART.accent, r);
  const m = mb.done();
  m.height = h;
  return m;
}

/** Moss: a few low cushions on a patch about a cell across. */
function moss(h: number, seed: number): FloraMesh {
  const r = rng(hashSeed(seed, 14));
  const mb = new MeshBuilder(() => 0);
  const n = 4 + Math.floor(r() * 3);
  for (let k = 0; k < n; k++) {
    const a = r() * Math.PI * 2;
    const d = Math.sqrt(r()) * 0.4;
    const s = 0.18 + 0.15 * r();
    mb.blob([Math.cos(a) * d, Math.sin(a) * d, h * 0.3], [s, s, h * (0.6 + 0.4 * r())], PART.leaf, r);
  }
  return mb.done();
}
