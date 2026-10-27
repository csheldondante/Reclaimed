// The recipe content (data/recipes/, round 88) read into the contracts' shapes (recipe.ts), and the civ
// profiles with what picks them. Plain data in, typed records out; compose.ts reads them.
import core from '../../data/recipes/core.json';
import civs from '../../data/recipes/civs.json';
import type { CapabilityRule, CivProfile, Instance, InstanceId, Kind, KindId, Material, Recipe } from '../api/contracts/recipe';
import type { Catalogue } from '../api/contracts/compose';
import { MAT } from '../world/materials';

/** How a civ's buildings are drawn: world materials (MAT ids) for walls, roofs, foundations, trim. */
export interface CivLook {
  wall: number;
  roof: number;
  foundation: number;
  trim: number;
}

export interface CivEntry {
  profile: CivProfile;
  era: string[];
  settings: string[];
  camp: boolean;
  look: CivLook;
  /** the same, as recipe material ids (what a building's Instance is made of) */
  lookMat: Record<keyof CivLook, string>;
}

const matByName = MAT as unknown as Record<string, number>;

export const MATERIALS: Material[] = (core.materials as unknown as (Omit<Material, 'voxel'> & { voxel?: string })[]).map((m) => {
  const v = m.voxel ? matByName[m.voxel] : undefined;
  if (m.voxel && v === undefined) throw new Error(`data/recipes: material ${m.id} draws as unknown voxel ${m.voxel}`);
  return { ...m, voxel: v };
});
const matIndex = new Map(MATERIALS.map((m) => [m.id, m]));

/** a recipe material's world voxel */
export function voxelOf(id: string): number {
  const m = matIndex.get(id);
  if (!m || m.voxel === undefined) throw new Error(`data/recipes: no voxel for material ${id}`);
  return m.voxel;
}

export const KINDS: Kind[] = core.kinds as unknown as Kind[];
export const RECIPES: Recipe[] = core.recipes as unknown as Recipe[];
export const RULES: CapabilityRule[] = core.rules as unknown as CapabilityRule[];

export const CIVS: CivEntry[] = (civs.civs as unknown as { profile: CivProfile; era: string[]; settings: string[]; camp?: boolean; look: Record<keyof CivLook, string> }[]).map((c) => ({
  profile: c.profile,
  era: c.era,
  settings: c.settings,
  camp: !!c.camp,
  look: { wall: voxelOf(c.look.wall), roof: voxelOf(c.look.roof), foundation: voxelOf(c.look.foundation), trim: voxelOf(c.look.trim) },
  lookMat: c.look,
}));
for (const k of KINDS) if (k.material && !matIndex.has(k.material)) throw new Error(`data/recipes: kind ${k.id}'s material ${k.material} isn't defined`);

export function civById(id: string): CivEntry {
  const c = CIVS.find((x) => x.profile.id === id);
  if (!c) throw new Error(`no civ profile ${id}`);
  return c;
}

/**
 * The profile for a people of `era` (a realm's, or 'free' for unaligned towns) at a site of `setting`: the ones
 * of that era, a setting's own first; a draw among equals by `roll`.
 */
export function pickCiv(era: string, setting: string, roll: number): CivEntry {
  const own = CIVS.filter((c) => !c.camp && c.era.includes(era));
  const pool = own.length ? own : CIVS.filter((c) => !c.camp && c.era.includes('free'));
  const fit = pool.filter((c) => c.settings.includes(setting));
  const from = fit.length ? fit : pool;
  return from[Math.floor(roll * from.length) % from.length];
}

export function campCiv(): CivEntry {
  const c = CIVS.find((x) => x.camp);
  if (!c) throw new Error('data/recipes/civs.json: no camp profile');
  return c;
}

/** A catalogue over the content and a set of things (a settlement's, or the world's). */
export function catalogue(things: Map<InstanceId, Instance>): Catalogue {
  return { kinds: new Map<KindId, Kind>(KINDS.map((k) => [k.id, k])), things, rules: RULES };
}

export function recipe(id: string): Recipe {
  const r = RECIPES.find((x) => x.id === id);
  if (!r) throw new Error(`no recipe ${id}`);
  return r;
}
