// (round 120, `cities`) A region kind's land as a settlement's purpose sees it (settle/purpose.ts): from atlas/regions.ts
// KINDS, put in the atlas facts (gm/atlas-facts.ts) so the wiki — which runs in Node from the cached facts — needn't
// import the atlas.
import { KINDS } from './regions';
import { MAT } from '../world/materials';

/** (round 120) A region kind's land as a settlement's purpose sees it (settle/purpose.ts). */
export interface KindTraits {
  /** its top is rock (stone, basalt, sandstone, rubble) or soil */
  rockTop: boolean;
  soilTop: boolean;
  /** loose cover over the rock (m-ish: under 1 the rock shows) */
  cover: number;
  /** growth (0 bare .. 1.3 lush), caves (0 .. 1.6), a crystal or bone accent (veins in the rock) */
  veg: number;
  cave: number;
  accent: boolean;
}

/** a region kind's traits (KINDS) */
export function kindTraits(kind: string): KindTraits {
  const k = KINDS[kind];
  if (!k) throw new Error(`atlas facts: no region kind "${kind}"`);
  return { rockTop: k.top === MAT.Stone || k.top === MAT.Basalt || k.top === MAT.Sandstone || k.top === MAT.Rubble, soilTop: k.top === MAT.Soil, cover: k.cover, veg: k.veg, cave: k.cave, accent: k.accent !== undefined };
}
