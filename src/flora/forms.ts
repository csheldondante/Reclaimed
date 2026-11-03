// (round 128, treegen) The shrubs' kinds and the grass's clump types: one species grown several ways. The user: "Can
// tree gen move onto grasses and shrubs and adopt the same techniques that worked for trees?"; main's brief: shrubs
// "with species variety (round bush, spreading, upright, berry/flowering, bramble)", grass with "clump types".
// A kind is a patch on the species (the same colonised stems, layered crown and bark), chosen by the library's
// variant index — so a thicket in the world mixes them with no new species, slot or kind table. Pure (no DOM, no GPU).

import type { SpeciesDef } from './species';

/** How a grass clump is built (generate.ts grassClump). Lengths a share of the plant's height unless noted. */
export interface GrassLook {
  /** blades in a clump (the normal level; the close-up has more) */
  blades: number;
  /** the clump's foot radius (cells) */
  spread: number;
  /** how far the blades lean out at the foot (0 upright .. 1 at 45°) */
  lean: number;
  /** how much a blade arches over along its length (0 straight .. 1 its tip hanging) */
  arch: number;
  /** a blade's width at its foot (cells) */
  width: number;
  /** segments along a blade (the bend's smoothness: 1B bends at its joints) */
  segs: number;
  /** the share of blades that carry a seed head (the accent colour) */
  heads: number;
}

export const SHRUB_FORMS = ['round bush', 'spreading', 'upright', 'berry bush', 'bramble'] as const;
export type ShrubForm = (typeof SHRUB_FORMS)[number];

export const GRASS_TYPES = ['fountain', 'tuft', 'seed heads'] as const;

/**
 * The species as kind `i` of its shrub forms (SHRUB_FORMS; −1 or none: the species as written). Each keeps the
 * species' colours and bark; the berry bush adds `berries` (accent-coloured clusters at the twig tips).
 */
export function shrubForm(sp: SpeciesDef, i: number): SpeciesDef {
  if (i < 0 || !sp.colonize || !sp.crown) return sp;
  const c = { ...sp.colonize };
  const cr = { ...sp.crown };
  const out: SpeciesDef = { ...sp, colonize: c, crown: cr };
  switch (SHRUB_FORMS[i % SHRUB_FORMS.length]) {
    case 'round bush':
      break;
    case 'spreading':
      // (wide and low: limbs out sideways from the foot, a flat-topped umbrella of leaves)
      Object.assign(c, { width: 1.05, envelope: 'umbrella', crownBase: 0.15, upBend: 0.05, forks: 5, maxAngle: 65 });
      Object.assign(cr, { lobeShape: 'pad', clump: 1.5 });
      out.height = [sp.height[0] * 0.75, sp.height[1] * 0.8];
      break;
    case 'upright':
      // (a column of stiff rising stems: a box or a juniper)
      Object.assign(c, { width: 0.32, envelope: 'column', upBend: 0.7, maxAngle: 30, forks: 3, straight: 0.7 });
      Object.assign(cr, { lobeShape: 'column', clump: 1.1 });
      out.height = [sp.height[0] * 1.3, sp.height[1] * 1.4];
      break;
    case 'berry bush':
      // (a round bush in flower in spring and with berries after)
      out.blossom = 0.8;
      out.berries = 1;
      Object.assign(cr, { gaps: 0.08 });
      break;
    case 'bramble':
      // (arching canes that root where they land: few leaves, the stems showing — a tangle more than a bush)
      Object.assign(c, { width: 0.95, weep: 0.75, upBend: 0.35, points: 90, thin: 0.75, forks: 6, maxAngle: 60, straight: 0.75 });
      Object.assign(cr, { fill: 0.55, shell: 0.9, gaps: 0.3, core: 0, clump: 0.9 });
      out.berries = 0.5;
      out.colours = { ...sp.colours, bark: [0.33, 0.17, 0.2], accent: [0.1, 0.06, 0.12] };
      break;
  }
  return out;
}

/** The grass as clump type `i` (GRASS_TYPES; −1 / none: as written). */
export function grassType(g: GrassLook, i: number): GrassLook {
  if (i < 0) return g;
  switch (GRASS_TYPES[i % GRASS_TYPES.length]) {
    case 'fountain':
      return { ...g, arch: Math.max(g.arch, 0.65), lean: Math.max(g.lean, 0.45), heads: 0 };
    case 'tuft':
      return { ...g, arch: Math.min(g.arch, 0.2), lean: Math.min(g.lean, 0.25), blades: Math.round(g.blades * 1.3), heads: 0 };
    case 'seed heads':
      return { ...g, arch: Math.min(g.arch, 0.3), heads: Math.max(g.heads, 0.45) };
  }
  return g;
}

/** How many kinds a species has (its library variants cycle through them). */
export function kindCount(sp: SpeciesDef): number {
  if (sp.form === 'shrub' && sp.colonize && sp.crown) return SHRUB_FORMS.length;
  if (sp.form === 'grass' && sp.grass) return GRASS_TYPES.length;
  return 1;
}

/**
 * The species as the kind it is drawn as: `sp.kind` when set (the editor's pick), else `variant` (the library's variant
 * index, the viewer's seed) round its kinds. Marked done (`kindDone`), so resolving again leaves it as it is.
 */
export function resolveKind(sp: SpeciesDef, variant: number): SpeciesDef {
  if (sp.kindDone) return sp;
  const n = kindCount(sp);
  if (n <= 1) return sp;
  const k = (sp.kind ?? -1) >= 0 ? sp.kind! % n : ((variant % n) + n) % n;
  const out = sp.form === 'shrub' ? shrubForm(sp, k) : { ...sp, grass: grassType(sp.grass!, k) };
  return { ...out, kind: k, kindDone: true };
}
