// One plant from (species, seed) (round 117): the L-system and turtle for the woody plants, the root automaton for
// the trees' surface roots, small direct generators for the herbs. Every plant is scaled into its species' height
// range by the seed, so variants differ in shape and size but read as one species.

import { expand, interpret, norm, type V3 } from './lsystem';
import { addSolidCrown, buildPlant, MeshBuilder, PART, sprayAt, type FloraMesh } from './mesh';
import { growRoots, rootSegments } from './roots';
import { addEpiphytes } from './epiphytes';
import { cached, meshKey, remember } from './meshcache';
import { colonize } from './colonize';
import { resolveKind, type GrassLook } from './forms';
import { rng, hashSeed } from './rng';
import { BARK_PLAIN, SPECIES, type Flare, type SpeciesDef, type SpeciesId } from './species';
import type { Segment } from './lsystem';

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
/**
 * A level of detail (the flora LOD ladder, round 128: close-up → full → coarse → far; ARCHITECTURE "The flora LOD
 * ladder"): 'close' the camera zoomed in — more stem sides and rings, twigs to a third the usual cut, leaf clusters
 * split into more, smaller ones, grass with more, finer, more bent blades; 0 full; 1 coarse; 2 far (a few triangles).
 */
/** 'bake' (round 128): the sprites' source only — the close-up level and more (the lobes cut twice, every twig): baked
 *  once a sprite, never drawn, so its triangles don't count at run time */
export type Lod = 'bake' | 'close' | 0 | 1 | 2;

/** `kind` (round 128, forms.ts): which of the species' kinds (a shrub's form, a grass's clump type) — the library's
 *  variant index; absent: by the seed (the viewer) */
export function generate(id: SpeciesId, seed: number, opts: { growth?: number; px?: number; lod?: Lod; def?: SpeciesDef; legacy?: boolean; kind?: number } = {}): FloraMesh {
  // (round 128: the trees' and thickets' meshes kept between loads — meshcache.ts; the small plants are cheap)
  const def0 = resolveKind(opts.legacy ? legacyDef(opts.def ?? SPECIES[id]) : (opts.def ?? SPECIES[id]), opts.kind ?? seed);
  const o = { ...opts, def: def0, legacy: false };
  if (def0.form !== 'tree' && def0.form !== 'shrub') return make(id, seed, o);
  const key = meshKey(def0, seed, `${String(opts.lod ?? 0)}|${opts.growth ?? 1}`, opts.px);
  const had = cached(key);
  if (had) return had;
  const m = make(id, seed, o);
  remember(key, m);
  return m;
}

function make(id: SpeciesId, seed: number, opts: { growth?: number; px?: number; lod?: Lod; def?: SpeciesDef; legacy?: boolean }): FloraMesh {
  // (round 128, treegen: `def` a species edited in the viewer — its sliders; `legacy` the stems as round 117 made them,
  // the viewer's "old" side of its old/new pair: the turtle's new variances off and a prism a step)
  const sp0 = opts.legacy ? legacyDef(opts.def ?? SPECIES[id]) : (opts.def ?? SPECIES[id]);
  const g = Math.min(1, Math.max(0.05, opts.growth ?? 1));
  const sp = g < 1 && sp0.colonize
    ? { ...sp0, colonize: { ...sp0.colonize, rounds: Math.max(2, Math.round(sp0.colonize.rounds * g)), height: sp0.colonize.height * (0.35 + 0.65 * g) } }
    : g < 1 && sp0.lsystem
      ? { ...sp0, lsystem: { ...sp0.lsystem, iterations: Math.max(1, Math.round(sp0.lsystem.iterations * (0.35 + 0.65 * g))) } }
      : sp0;
  const r = rng(hashSeed(seed, id.length * 7919 + id.charCodeAt(0)));
  const h = (sp.height[0] + (sp.height[1] - sp.height[0]) * r()) * (0.25 + 0.75 * g);
  switch (sp.form) {
    case 'tree':
      // (round 119, the phone: levels of detail by size on screen — 1 the same tree coarse, its twigs and roots gone, its
      // leaves merged; 2 a few triangles: a trunk and the crown's masses, from the same skeleton so the shape holds)
      if (opts.lod === 2) return scaleTo(farTree(sp, seed), h);
      // (made for ~2.2 px a cell: the trunk and main limbs kept — a birch's white trunk is what makes it read — twigs
      // and roots gone, leaves merged)
      if (opts.lod === 1) return scaleTo(woody(sp, seed, h, 2.2, false), h);
      return scaleTo(woody(sp, seed, h, opts.lod === 'close' || opts.lod === 'bake' ? undefined : opts.px, true, opts.lod === 'close' || opts.lod === 'bake', opts.lod === 'bake'), h);
    case 'shrub':
      // (round 119: a thicket far off is a lump — a few triangles, from the same skeleton; round 128, main's review: the
      // lump's octahedra read as brown pyramids on the woods' floor — now a few big spray cards on its main stems)
      if (opts.lod === 2) return scaleTo(farShrub(sp, seed), h);
      {
        const m = woody(sp, seed, h, opts.lod === 'close' || opts.lod === 'bake' ? undefined : opts.px, true, opts.lod === 'close' || opts.lod === 'bake', opts.lod === 'bake');
        return scaleTo(sp.berries ? withBerries(m, sp.berries, h, hashSeed(seed, 7)) : m, h);
      }
    case 'fern':
      return scaleTo(woody(sp, seed, h, opts.px), h);
    case 'vine':
      return scaleTo(vine(sp, seed), h);
    case 'grass': {
      // (round 128: the species' clump look — forms.ts GrassLook, its kind applied; the round-117 tuft where it has none)
      const gl: GrassLook = sp.grass ?? { blades: 9, spread: 0.5, lean: 0.4, arch: 0.3, width: 0.16, segs: 2, heads: 0.25 };
      // (close: more, finer blades, two more joints to bend at)
      if (opts.lod === 'close') return grassClump(h, seed, { ...gl, blades: Math.round(gl.blades * 1.6), width: gl.width * 0.7, segs: gl.segs + 2 });
      // (a blade at least ~1.7 px wide; fewer of them when they are wide)
      const w = opts.px ? Math.max(gl.width, 1.7 / opts.px) : gl.width;
      return grassClump(h, seed, { ...gl, width: w, blades: w > 0.22 ? Math.max(4, Math.round(gl.blades * 0.6)) : gl.blades });
    }
    case 'reed':
      return reeds(h, seed);
    case 'flower':
      return flower(h, seed);
    case 'moss':
      return scaleTo(moss(h, seed), h);
    case 'rock':
      return scaleTo(boulder(h, seed), h);
  }
}

function woody(sp: SpeciesDef, seed: number, h: number, px?: number, withRoots = true, close = false, bake = false): FloraMesh {
  if (!sp.lsystem || !sp.turtle || !sp.leaf) throw new Error(`species ${sp.id}: a woody plant needs an L-system, a turtle and leaves`);
  // (round 128: a crown grown by space colonization where the species has one — colonize.ts; else the L-system's turtle)
  const sk = sp.colonize ? colonize(sp.colonize, hashSeed(seed, 2), { kinkChance: sp.turtle.kinkChance, kinkAngle: sp.turtle.kinkAngle, twist: sp.turtle.twist }) : interpret(expand(sp.lsystem, hashSeed(seed, 1)), sp.turtle, hashSeed(seed, 2));
  // (the scale it will be drawn at: the minimum widths in world cells, then in the skeleton's units)
  const k = h / Math.max(sk.height, 1e-3);
  const minRadius = px ? 0.85 / px / k : 0;
  const minLeaf = px ? 1.5 / px / k : 0;
  // the root automaton's surface roots, in the skeleton's units (the plant is scaled after)
  // (round 128: a colonized crown's skeleton is in cells, its trunk `colonize.trunkRadius` — the roots and buttresses,
  // made in the turtle's units, scaled to that trunk)
  const rk = sp.colonize ? sp.colonize.trunkRadius / sp.turtle.radius : 1;
  const sc = (g: Segment): Segment => ({ ...g, a: [g.a[0] * rk, g.a[1] * rk, g.a[2] * rk], b: [g.b[0] * rk, g.b[1] * rk, g.b[2] * rk], r0: g.r0 * rk, r1: g.r1 * rk });
  const roots = sp.roots && withRoots ? rootSegments(growRoots(sp.roots, hashSeed(seed, 3)), sp.roots.res * 1.5, sp.turtle.radius * 0.8).map(sc) : [];
  // (round 125, forest: the elder's buttresses — kept at every level but the far one: they are its silhouette's foot)
  if (sp.flare) roots.push(...flareSegments(sp.flare, sp.turtle.radius, hashSeed(seed, 5), withRoots).map(sc));
  // (round 128, close: the same skeleton with more of it drawn — two more sides, rings twice as close, twigs to a third
  // of the cut — and each leaf cluster split into smaller ones)
  // (round 128: the user's "way more verts" — 12 sides close up, 16 for the sprites' bake; 8 at the normal level)
  const stem = close && sp.stem ? { ...sp.stem, sides: bake ? 16 : Math.max(12, sp.stem.sides + 2), ring: sp.stem.ring / 2 } : sp.stem;
  const leaf = close && (sp.leaf.style === 'cluster' || sp.leaf.style === 'drop') ? { ...sp.leaf, size: sp.leaf.size * 0.7, per: sp.leaf.per * 2 } : sp.leaf;
  // (the crown's sprays: close up more cards, smaller, one more spray a twig)
  const crown0 = sp.crown && sp.crown.style === 'cones' && sp.colonize ? { ...sp.crown, coneTiers: sp.colonize.tiers, coneH: sp.colonize.height } : sp.crown;
  const crown = crown0 && close && crown0.style !== 'cones' ? { ...crown0, size: crown0.size * 0.75, leaves: Math.round(crown0.leaves * 1.5), perTwig: crown0.perTwig + 1 } : crown0;
  return buildPlant(sk, leaf, hashSeed(seed, 4), { crown, twigs: sp.twigs, px, bake, roots, sides: sp.form === 'tree' ? 6 : 4, minTwig: sp.form === 'tree' ? (close ? 0.012 : 0.035) : 0, minRadius: sp.form === 'tree' ? minRadius : 0, minLeaf, stem, scale: k, keepLimbs: sp.colours.deciduous, extra: (mb, cut) => {
    // (round 128) epiphytes (the coarse level keeps them: lines and vines are the silhouette's) and a tree's icicles
    if (sp.epiphytes) addEpiphytes(mb, sk, sp.epiphytes, hashSeed(seed, 6), k, { icicles: sp.form === 'tree' ? 14 : 0, cut });
  } });
}

/** (round 128) a species as round 117-125 grew it: no stem look (prisms a step), the turtle's new variances off */
export function legacyDef(sp: SpeciesDef): SpeciesDef {
  // (the bark as round 125 drew it: a birch's lenticels where the mark colour differs, the elder's ridges, else plain)
  const ridged = sp.bark.furrows > 0.5;
  const marked = !!sp.colours.barkMark && Math.hypot(...sp.colours.barkMark.map((v, i) => v - sp.colours.bark[i])) > 0.1;
  const bark = ridged ? { ...BARK_PLAIN, furrows: 0.8, roughness: 0.8 } : { ...BARK_PLAIN, roughness: 0, stripes: marked ? 0.2 : 0 };
  if (!sp.turtle) return { ...sp, stem: undefined, crown: undefined, twigs: undefined, colonize: undefined, bark, epiphytes: undefined, blossom: undefined };
  const { taperVar: _a, spacing: _b, stepVar: _c, twist: _d, kinkChance: _e, kinkAngle: _f, ...turtle } = sp.turtle;
  return { ...sp, stem: undefined, crown: undefined, twigs: undefined, colonize: undefined, turtle, bark, epiphytes: undefined, blossom: undefined };
}

/**
 * Buttress roots (round 125, forest; the reference's "flaring mossy roots"): `count` fins round the trunk, each a thick
 * tapered tube from `rise` radii up the trunk out and down to the ground `reach` radii away, then a sprawl along the
 * ground, forking once, thinning (in the skeleton's units; r the trunk's radius). The coarse level keeps the fins and
 * drops the sprawl's forks.
 */
export function flareSegments(f: Flare, r: number, seed: number, detail = true): Segment[] {
  const rnd = rng(seed ^ 0xf1a4e);
  const out: Segment[] = [];
  const t0 = rnd() * Math.PI * 2;
  for (let k = 0; k < f.count; k++) {
    const a = t0 + ((k + (rnd() - 0.5) * 0.5) / f.count) * Math.PI * 2;
    const reach = f.reach * (0.75 + 0.5 * rnd());
    const c = Math.cos(a);
    const sn = Math.sin(a);
    const rise = f.rise * (0.8 + 0.4 * rnd());
    // the fin: from inside the trunk (so it grows out of it), out and down to the ground
    const top: V3 = [c * r * 0.35, sn * r * 0.35, r * rise];
    const knee: V3 = [c * r * reach * 0.55, sn * r * reach * 0.55, r * rise * 0.3];
    const foot: V3 = [c * r * reach, sn * r * reach, r * 0.08];
    out.push({ a: top, b: knee, r0: r * 0.62, r1: r * 0.4, depth: 0 });
    out.push({ a: knee, b: foot, r0: r * 0.4, r1: r * 0.24, depth: 0 });
    // the sprawl: on along the ground, bending, thinning (a fork off it)
    const b = a + (rnd() - 0.5) * 0.7;
    const end: V3 = [foot[0] + Math.cos(b) * r * f.sprawl, foot[1] + Math.sin(b) * r * f.sprawl, r * 0.02];
    out.push({ a: foot, b: end, r0: r * 0.24, r1: r * 0.1, depth: 1 });
    if (detail) {
      const fb = b + (rnd() < 0.5 ? -1 : 1) * (0.6 + 0.5 * rnd());
      const mid: V3 = [(foot[0] + end[0]) / 2, (foot[1] + end[1]) / 2, r * 0.05];
      out.push({ a: mid, b: [mid[0] + Math.cos(fb) * r * f.sprawl * 0.6, mid[1] + Math.sin(fb) * r * f.sprawl * 0.6, r * 0.02], r0: r * 0.14, r1: r * 0.06, depth: 2 });
    }
  }
  return out;
}

/**
 * A far tree (round 119): ~20-30 triangles from the same skeleton — the trunk as one tapered prism to where the crown
 * starts, and the crown as a mass or two (an ellipsoid round each half of its leaves, a cone for a conifer). What a
 * tree under ~60 render pixels tall can show anyway.
 */
function farTree(sp: SpeciesDef, seed: number): FloraMesh {
  const sk = sp.colonize ? colonize(sp.colonize, hashSeed(seed, 2)) : interpret(expand(sp.lsystem!, hashSeed(seed, 1)), sp.turtle!, hashSeed(seed, 2));
  const H = Math.max(sk.height, 0.5);
  const mb = new MeshBuilder((p) => Math.pow(Math.max(0, p[2]) / H, 1.6) * 0.8);
  const leaves = sk.leaves.filter((l) => l.depth >= sp.leaf!.minDepth);
  const lowLeaf = leaves.reduce((m, l) => Math.min(m, l.p[2]), H);
  const r0 = sp.turtle!.radius * 1.2;
  mb.tube({ a: [0, 0, 0], b: [0, 0, Math.max(lowLeaf, H * 0.35)], r0, r1: r0 * 0.6, depth: 0 }, 4, PART.wood);
  const r01 = rng(hashSeed(seed, 9));
  if (sp.leaf!.style === 'needles') {
    let spread = 0;
    for (const l of leaves) spread = Math.max(spread, Math.hypot(l.p[0], l.p[1]));
    mb.cone([0, 0, lowLeaf * 0.9], [0, 0, 1], H - lowLeaf * 0.9, spread * 0.85, 6, PART.leaf, 0.1);
  } else {
    const mid = (lowLeaf + H) / 2;
    for (const half of [leaves.filter((l) => l.p[2] < mid), leaves.filter((l) => l.p[2] >= mid)]) {
      if (!half.length) continue;
      const c = [0, 1, 2].map((i) => half.reduce((a, l) => a + l.p[i], 0) / half.length) as V3;
      const e = [0, 1, 2].map((i) => Math.sqrt(half.reduce((a, l) => a + (l.p[i] - c[i]) ** 2, 0) / half.length) * 1.6 + sp.leaf!.size) as V3;
      mb.blob(c, e, PART.leaf, r01, 0.12);
    }
  }
  return mb.done();
}

/** (round 128) A far thicket: its first stems as thin prisms and a few big sprays of cards at some of its leaf sites
 *  (~40-60 triangles; the crown's look, not round 119's octahedra). */
function farShrub(sp: SpeciesDef, seed: number): FloraMesh {
  // (round 128: from the colonized skeleton where it has one — so each kind's far lump keeps its outline: wide, upright)
  const sk = sp.colonize
    ? colonize(sp.colonize, hashSeed(seed, 2), { kinkChance: sp.turtle?.kinkChance, kinkAngle: sp.turtle?.kinkAngle, twist: sp.turtle?.twist })
    : interpret(expand(sp.lsystem!, hashSeed(seed, 1)), sp.turtle!, hashSeed(seed, 2));
  const H = Math.max(sk.height, 0.3);
  const mb = new MeshBuilder((p) => Math.pow(Math.max(0, p[2]) / H, 1.6) * 0.8);
  // (the main stems only: a colonized skeleton's depth counts every fork — keep its thick ones)
  const rMax = Math.max(...sk.segments.map((g) => g.r0));
  for (const g of sk.segments) if (sp.colonize ? g.r0 >= rMax * 0.55 : g.depth <= 1) mb.tube(g, 3, PART.wood);
  const r01 = rng(hashSeed(seed, 9));
  if (sp.colonize && sp.crown) {
    // (round 128, the grass-and-shrubs shots: the far sprays read as pale paper at the gameplay zoom — now the crown's own
    // lobes, an icosahedron each (20 faces), painted as the near crown's (the lobe ramp, the crevices' occlusion), the
    // clumps a fifth bigger so there are a few of them: 70-280 triangles)
    const k = (sp.height[0] + sp.height[1]) / 2 / H;
    addSolidCrown(mb, sk, 0, { ...sp.crown, gaps: 0, clump: (sp.crown.clump ?? 1.3) * 1.2 }, k, r01, 1);
    return mb.done();
  }
  const sites = sk.leaves.filter((_, i) => i % Math.max(1, Math.floor(sk.leaves.length / 6)) === 0);
  const size = Math.max(H * 0.45, 0.1);
  for (const l of sites) sprayAt(mb, l.p, l.d, size, 3, sp.crown?.droop ?? 0.2, r01);
  return mb.done();
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
/**
 * A grass clump (round 128, the user: "gras that bends in the wind and looks higher detail"): blades of several
 * segments rising from the clump's foot and arching over (`look.arch`), narrowing to a point, each vertex's sway
 * its share along the blade (so an arched tip bends with the gust even where it hangs low — FOLIAGE_WIND 1B) and its
 * normal the clump's dome (the blades lit as one rounded tuft, not as flat cards edge-on). The look darkens the
 * foot (the clump's own occlusion) and lightens toward the tips (floralook.wgsl part 5).
 */
export function grassClump(h: number, seed: number, look: GrassLook): FloraMesh {
  const r = rng(hashSeed(seed, 11));
  // (the sway is passed as `extra`: the share along the blade, eased — nearly all of the bend at the tip)
  const mb = new MeshBuilder((_p, e) => Math.pow(e, 1.6) * 0.98);
  const segs = Math.max(1, Math.round(look.segs));
  const domeC: V3 = [0, 0, -h * 0.35];
  const domeN = (q: V3): V3 => norm([q[0] - domeC[0], q[1] - domeC[1], q[2] - domeC[2]]);
  const vtx = (q: V3, u: number, t: number) => mb.vert(q, PART.blade, t, u, t, domeN(q));
  // one blade from its foot p: `segs` pieces, turning out (ca, sa) and down by `arch`, narrowing to a point
  const strip = (p: V3, d0: V3, len: number, width: number, ca: number, sa: number, arch: number) => {
    let dir = norm(d0);
    const side: V3 = norm([-sa, ca, 0]);
    let at = p;
    let L = vtx([at[0] - (side[0] * width) / 2, at[1] - (side[1] * width) / 2, at[2]], 0, 0);
    let R = vtx([at[0] + (side[0] * width) / 2, at[1] + (side[1] * width) / 2, at[2]], 1, 0);
    for (let s = 1; s <= segs; s++) {
      const t = s / segs;
      // (never under the ground: a hanging tip rests on it)
      at = [at[0] + (dir[0] * len) / segs, at[1] + (dir[1] * len) / segs, Math.max(0.03, at[2] + (dir[2] * len) / segs)];
      // (the arch: the blade turns out and down over its length, more toward the tip)
      dir = norm([dir[0] + ((ca * arch * 0.9) / segs) * (0.5 + t), dir[1] + ((sa * arch * 0.9) / segs) * (0.5 + t), dir[2] - ((arch * 1.1) / segs) * (0.3 + t)]);
      if (s === segs) {
        mb.tri2(L, R, vtx(at, 0.5, 1));
      } else {
        // (widest a third of the way up, then narrowing to the point)
        const w = width * Math.min(1.15, 0.85 + t) * (1 - t * t * 0.85);
        const L2 = vtx([at[0] - (side[0] * w) / 2, at[1] - (side[1] * w) / 2, at[2]], 0, t);
        const R2 = vtx([at[0] + (side[0] * w) / 2, at[1] + (side[1] * w) / 2, at[2]], 1, t);
        mb.tri2(L, R, R2);
        mb.tri2(L, R2, L2);
        L = L2;
        R = R2;
      }
    }
  };
  for (let k = 0; k < look.blades; k++) {
    const a = r() * Math.PI * 2;
    const d = Math.sqrt(r()) * look.spread;
    const p: V3 = [Math.cos(a) * d, Math.sin(a) * d, 0];
    // (the outer blades lean out more and are shorter: the clump's fountain)
    const out = d / Math.max(look.spread, 1e-3);
    const lean = look.lean * (0.4 + 0.8 * out) * (0.7 + 0.6 * r());
    const len = h * (0.65 + 0.35 * (1 - out)) * (0.8 + 0.3 * r());
    const arch = look.arch * (0.6 + 0.8 * r());
    // (each blade's own plane: facing round its lean, turned a little — so the clump shows blades at every angle)
    const ca = Math.cos(a + (r() - 0.5) * 0.8);
    const sa = Math.sin(a + (r() - 0.5) * 0.8);
    strip(p, [ca * lean, sa * lean, 1], len, look.width * (0.75 + 0.5 * r()), ca, sa, arch);
    // a seed head (the accent colour) on a share of the blades: a slim spike on a stalk of its own, upright
    if (r() < look.heads) {
      const sl = len * (1.05 + 0.2 * r());
      const sd: V3 = norm([ca * lean * 0.4, sa * lean * 0.4, 1]);
      const top: V3 = [p[0] + sd[0] * sl * 0.72, p[1] + sd[1] * sl * 0.72, sd[2] * sl * 0.72];
      strip(p, sd, sl * 0.72, 0.035, ca, sa, 0);
      mb.cone(top, sd, sl * 0.28, 0.06, 4, PART.accent, 0.95);
    }
  }
  const m = mb.done();
  m.height = h;
  return m;
}

/**
 * (round 128) Berries on a thicket's leaves (forms.ts: the berry bush, the bramble): small accent-coloured clusters on
 * a share of the crown's outer leaf vertices, a little out along their normal so they sit on the leaves.
 */
function withBerries(m: FloraMesh, density: number, h: number, seed: number): FloraMesh {
  const r = rng(seed);
  // (the mesh is in the skeleton's units until scaleTo: a berry ~0.07 cells)
  const k = h / Math.max(m.height, 1e-3);
  const br = 0.07 / k;
  const mb = new MeshBuilder(() => 0.6);
  const nv = m.verts.length / 4;
  let made = 0;
  const want = Math.round(24 * density);
  for (let tries = 0; tries < want * 30 && made < want; tries++) {
    const i = Math.floor(r() * nv);
    if (Math.floor(m.verts[i * 4 + 3]) !== PART.leaf) continue;
    const p: V3 = [m.verts[i * 4], m.verts[i * 4 + 1], m.verts[i * 4 + 2]];
    // (out along the vertex's smooth normal; where it has none, out from the axis)
    const ox = m.uv[i * 4 + 2];
    const oy = m.uv[i * 4 + 3];
    const l1 = Math.abs(ox) + Math.abs(oy);
    const n: V3 = l1 > 1e-5 && l1 <= 1 ? norm([ox, oy, 1 - l1]) : norm([p[0], p[1], 0.3 * Math.abs(p[2])]);
    // (the outer surface only: a vertex whose normal faces in toward the axis is an inner layer's)
    if (n[0] * p[0] + n[1] * p[1] < 0) continue;
    const c: V3 = [p[0] + n[0] * br * 1.5, p[1] + n[1] * br * 1.5, p[2] + n[2] * br * 1.5];
    for (let b = 0; b < 2; b++) mb.blob([c[0] + (r() - 0.5) * br * 2.2, c[1] + (r() - 0.5) * br * 2.2, c[2] + (r() - 0.5) * br * 2.2], [br, br, br], PART.accent, r, 0.6);
    made++;
  }
  const add = mb.done();
  const index = new Uint32Array(m.index.length + add.index.length);
  index.set(m.index);
  for (let q = 0; q < add.index.length; q++) index[m.index.length + q] = add.index[q] + nv;
  const verts = new Float32Array(m.verts.length + add.verts.length);
  verts.set(m.verts);
  verts.set(add.verts, m.verts.length);
  const uv = new Float32Array(m.uv.length + add.uv.length);
  uv.set(m.uv);
  uv.set(add.uv, m.uv.length);
  return { ...m, verts, uv, index, tris: index.length / 3 };
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

/** (round 125) A boulder: two or three faceted lumps of stone, flattened, leaning on each other (wood part: the bark's
 *  ridged stone colours, moss on the up faces by the species' moss — floralook.wgsl). No sway. */
function boulder(h: number, seed: number): FloraMesh {
  const r = rng(hashSeed(seed, 15));
  const mb = new MeshBuilder(() => 0);
  const n = 2 + Math.floor(r() * 2);
  for (let k = 0; k < n; k++) {
    const a = r() * Math.PI * 2;
    const d = k === 0 ? 0 : 0.5 + 0.4 * r();
    const s = (k === 0 ? 1 : 0.55 + 0.3 * r()) * h;
    mb.blob([Math.cos(a) * d * h, Math.sin(a) * d * h, s * 0.42], [s * (0.8 + 0.4 * r()), s * (0.7 + 0.4 * r()), s * 0.5], PART.wood, r, 0);
  }
  return mb.done();
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
