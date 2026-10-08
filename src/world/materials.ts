// Shared material table (design doc §12). Cells store only a material id;
// every property lives here and is uploaded once as a uniform array.

export const enum MatState {
  Empty = 0,
  Solid = 1,
  Granular = 2,
  Liquid = 3,
  Vegetation = 4,
}

export interface MaterialDef {
  name: string;
  /** sRGB albedo 0..1 */
  albedo: [number, number, number];
  emissive: number;
  state: MatState;
  /** Max stable height drop (cells) to a neighbour when dry / when wet. Granular only. */
  reposeDry: number;
  reposeWet: number;
  /** Structural strength 0..1 (used by the structural system, later milestones). */
  strength: number;
  /** Max vegetation stage this substrate can carry (0 = nothing grows). */
  growthCap: number;
  /** Growth-rate multiplier for vegetation on this substrate. */
  suitability: number;
  /** Specular strength 0..1 */
  specular: number;
  /** How much moisture darkens the surface 0..1 */
  porosity: number;
  /**
   * Soft-surface smoothing (round 10): the top of this material is drawn as a
   * slope toward neighbours whose height differs by at most this many cells
   * (all four columns at a corner must allow it); 0 = hard steps (stone).
   */
  smooth: number;
}

export const MAT = {
  Air: 0,
  Stone: 1,
  Soil: 2,
  Sand: 3,
  Rubble: 4,
  Concrete: 5,
  Asphalt: 6,
  Rust: 7,
  Water: 8,
  Leaves: 9,
  Wood: 10,
  Brick: 11,
  Trash: 12,
  Oil: 13,
  Grass: 14,
  Flower: 15,
  Bone: 16,
  Ash: 17,
  Litter: 18,
  Drift: 19,
} as const;

const NONE: Omit<MaterialDef, 'name' | 'albedo' | 'state'> = {
  emissive: 0,
  reposeDry: 99,
  reposeWet: 99,
  strength: 1,
  growthCap: 0,
  suitability: 0,
  specular: 0.05,
  porosity: 0,
  smooth: 0,
};

export const MATERIALS: MaterialDef[] = [
  { ...NONE, name: 'air', albedo: [0, 0, 0], state: MatState.Empty },
  { ...NONE, name: 'stone', albedo: [0.4, 0.39, 0.37], state: MatState.Solid, growthCap: 1.2, suitability: 0.3, porosity: 0.25 },
  { ...NONE, name: 'soil', albedo: [0.45, 0.36, 0.27], state: MatState.Granular, reposeDry: 3, reposeWet: 1, strength: 0.2, growthCap: 5, suitability: 1, porosity: 0.6, smooth: 2 },
  { ...NONE, name: 'sand', albedo: [0.72, 0.65, 0.5], state: MatState.Granular, reposeDry: 1, reposeWet: 1, strength: 0.1, growthCap: 2.5, suitability: 0.4, porosity: 0.5, smooth: 2 },
  { ...NONE, name: 'rubble', albedo: [0.44, 0.41, 0.38], state: MatState.Granular, reposeDry: 4, reposeWet: 3, strength: 0.3, growthCap: 3, suitability: 0.5, porosity: 0.3, smooth: 1 },
  { ...NONE, name: 'concrete', albedo: [0.66, 0.65, 0.62], state: MatState.Solid, strength: 0.8, growthCap: 1.5, suitability: 0.25, porosity: 0.35 },
  { ...NONE, name: 'asphalt', albedo: [0.24, 0.24, 0.25], state: MatState.Solid, strength: 0.6, growthCap: 2, suitability: 0.3, specular: 0.1, porosity: 0.3 },
  { ...NONE, name: 'rust', albedo: [0.5, 0.29, 0.17], state: MatState.Solid, strength: 0.85, growthCap: 1, suitability: 0.2, specular: 0.2, porosity: 0.2 },
  { ...NONE, name: 'water', albedo: [0.2, 0.33, 0.38], state: MatState.Liquid, specular: 0.8 },
  { ...NONE, name: 'leaves', albedo: [0.25, 0.45, 0.18], state: MatState.Vegetation, strength: 0.1 },
  { ...NONE, name: 'wood', albedo: [0.36, 0.25, 0.15], state: MatState.Vegetation, strength: 0.4 },
  { ...NONE, name: 'brick', albedo: [0.58, 0.34, 0.27], state: MatState.Solid, strength: 0.6, growthCap: 1.5, suitability: 0.3, porosity: 0.4 },
  // compacted waste: holds together against water until it is burned (it
  // then leaves ash — DECISIONS round 5); rendered as multicoloured specks
  { ...NONE, name: 'trash', albedo: [0.52, 0.5, 0.47], state: MatState.Solid, strength: 1, growthCap: 1, suitability: 0.15, porosity: 0.2 },
  // render-only id for the oil liquid field (oil lives in its own buffer, not in layers)
  { ...NONE, name: 'oil', albedo: [0.07, 0.06, 0.05], state: MatState.Liquid, specular: 0.9 },
  // render-only: grass tufts and wildflowers (vegetation detail instances)
  { ...NONE, name: 'grass', albedo: [0.36, 0.54, 0.19], state: MatState.Vegetation },
  { ...NONE, name: 'flower', albedo: [0.9, 0.85, 0.4], state: MatState.Vegetation },
  // old bone: ivory, weathered; hard and stable (never collapses), takes moss
  { ...NONE, name: 'bone', albedo: [0.84, 0.8, 0.7], state: MatState.Solid, strength: 1, growthCap: 1.4, suitability: 0.35, porosity: 0.3 },
  // reddish-grey dust and ash (the menu's mound; what burned waste leaves):
  // loose, blown about by wind and carried by water, fertile once clean
  { ...NONE, name: 'ash', albedo: [0.55, 0.42, 0.38], state: MatState.Granular, reposeDry: 2, reposeWet: 1, strength: 0.1, growthCap: 3, suitability: 0.6, porosity: 0.45, smooth: 2 },
  // scattered litter lying on the land: loose; strong wind strips it a cell at a
  // time (litterStrip in common.wgsl), water carries it; nothing grows on it
  { ...NONE, name: 'litter', albedo: [0.55, 0.52, 0.47], state: MatState.Granular, reposeDry: 1, reposeWet: 1, strength: 0.05, growthCap: 1, suitability: 0.15, porosity: 0.2, smooth: 1.5 },
  // render-only: drifted dust (its depth lives in the drift texture, not in layers)
  { ...NONE, name: 'drift', albedo: [0.6, 0.5, 0.39], state: MatState.Granular, porosity: 0.4 },
];

export const MAX_MATERIALS = 32;
/** Floats per material in the GPU uniform: 4 x vec4<f32>. Must match materials.wgsl. */
export const MATERIAL_STRIDE_FLOATS = 16;

export function packMaterialTable(): Float32Array {
  if (MATERIALS.length > MAX_MATERIALS) throw new Error('material table overflow');
  const out = new Float32Array(MAX_MATERIALS * MATERIAL_STRIDE_FLOATS);
  MATERIALS.forEach((m, i) => {
    const o = i * MATERIAL_STRIDE_FLOATS;
    out.set([m.albedo[0], m.albedo[1], m.albedo[2], m.emissive], o);
    out.set([m.state, m.reposeDry, m.reposeWet, m.strength], o + 4);
    out.set([m.growthCap, m.suitability, m.specular, m.porosity], o + 8);
    out.set([m.smooth, 0, 0, 0], o + 12);
  });
  return out;
}
