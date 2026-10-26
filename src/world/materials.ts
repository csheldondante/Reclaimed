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
  /**
   * (round 83) Rock (strength 1, solid): how far it hangs over air, cells for each cell of its thickness,
   * before it gives (fracture.ts analyseRock; default 3). Infinity: it never gives (bedrock: for what must stand).
   */
  span?: number;
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
   * (all four columns at a corner must allow it); 0 = hard steps (concrete,
   * brick). Stone smooths too (round 28): only rises of over 2 stay sheer.
   */
  smooth: number;
  /** See-through (round 50): drawn blended and faceted (ice, crystal; renderprep.wgsl glassMat); 0 = opaque. */
  glass?: number;
  /**
   * Loose ground (granular only; round 22 moved these from drift.wgsl's
   * looseOf/washOf into the table): wind (cells/s, sheltered) needed to move
   * it (≥ 1e8: never), share of what the wind lifts that goes airborne as
   * dust grains, how readily moving water carries it, and the net water flow
   * (volume/tick) below which it doesn't.
   */
  windLift: number;
  airborne: number;
  washMobility: number;
  washFlow: number;
}

const NEVER = 1e9;

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
  Steel: 20,
  Canvas: 21,
  Silt: 22,
  /** what lava sets into (sim/lava.ts) */
  Basalt: 23,
  /** molten rock: a liquid field (WorldGpu.lava), drawn as prisms; never in the layers */
  Lava: 24,
  /** round 50: loose, light; drifts in light wind, falls in cold storms, melts (sim/climate.ts) */
  Snow: 25,
  /** round 50: fallen leaves, loose and light; they blow as leaves and rot to soil */
  LeafLitter: 26,
  /** round 50: see-through; water freezes to it in the cold, it melts back */
  Ice: 27,
  /** round 50: faceted, see-through, glowing faintly */
  Crystal: 28,
  /** round 63: felled trees, cut — solid, stacked in piles by workers; they crumble to ash-like chips */
  Log: 29,
  /** round 64: the mesas' warm strata (landforms.ts) */
  Sandstone: 30,
  /** round 65: the town's walls and floors (build/town.ts) */
  Plaster: 31,
  /** round 65: the town's roofs */
  Tile: 32,
  /** round 69: the atlas's forms — flesh (vessels, the flesh style's ground), coral (shells and branches), obsidian (by lava) */
  Flesh: 33,
  Coral: 34,
  Obsidian: 35,
  /** round 75: giant crystals (terrain: they stand), and the sinter round a geyser's vent */
  Quartz: 36,
  Sinter: 37,
  /** round 83: rock that never gives (fracture.ts analyseRock: no span limit) — for what must stand */
  Bedrock: 38,
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
  windLift: NEVER,
  airborne: 0,
  washMobility: 0,
  washFlow: NEVER,
};

export const MATERIALS: MaterialDef[] = [
  { ...NONE, name: 'air', albedo: [0, 0, 0], state: MatState.Empty },
  { ...NONE, name: 'stone', albedo: [0.4, 0.39, 0.37], state: MatState.Solid, growthCap: 1.2, suitability: 0.3, porosity: 0.25, smooth: 2 },
  { ...NONE, name: 'soil', albedo: [0.45, 0.36, 0.27], state: MatState.Granular, reposeDry: 1.4, reposeWet: 1, strength: 0.2, growthCap: 5, suitability: 1, porosity: 0.6, smooth: 2, washMobility: 0.6, washFlow: 0.12 },
  { ...NONE, name: 'sand', albedo: [0.72, 0.65, 0.5], state: MatState.Granular, reposeDry: 1, reposeWet: 1, strength: 0.1, growthCap: 2.5, suitability: 0.4, porosity: 0.5, smooth: 2, windLift: 14, airborne: 0.15, washMobility: 1, washFlow: 0.08 },
  { ...NONE, name: 'rubble', albedo: [0.44, 0.41, 0.38], state: MatState.Granular, reposeDry: 1.7, reposeWet: 1.5, strength: 0.3, growthCap: 3, suitability: 0.5, porosity: 0.3, smooth: 1, washMobility: 0.25, washFlow: 0.3 },
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
  { ...NONE, name: 'ash', albedo: [0.55, 0.42, 0.38], state: MatState.Granular, reposeDry: 0.9, reposeWet: 0.8, strength: 0.1, growthCap: 3, suitability: 0.6, porosity: 0.45, smooth: 2, windLift: 10, airborne: 0.5, washMobility: 1, washFlow: 0.03 },
  // scattered litter lying on the land: loose; strong wind strips it a cell at a
  // time (litterStrip in common.wgsl), water carries it; nothing grows on it
  { ...NONE, name: 'litter', albedo: [0.55, 0.52, 0.47], state: MatState.Granular, reposeDry: 1, reposeWet: 1, strength: 0.05, growthCap: 1, suitability: 0.15, porosity: 0.2, smooth: 1.5, washMobility: 1, washFlow: 0.03 },
  // drifted dust: fine, blown about by a gust (it lies in the layers like any loose ground)
  { ...NONE, name: 'drift', albedo: [0.6, 0.5, 0.39], state: MatState.Granular, reposeDry: 0.8, reposeWet: 0.6, porosity: 0.4, windLift: 9, airborne: 0.4, washMobility: 1, washFlow: 0.03 },
  // faded painted metal: car bodies, ship hulls, pylons (models.ts; round 13 F5)
  { ...NONE, name: 'steel', albedo: [0.44, 0.48, 0.5], state: MatState.Solid, strength: 0.85, growthCap: 1, suitability: 0.2, specular: 0.25, porosity: 0.15 },
  // tent fabric: weathered off-white canvas, weak
  { ...NONE, name: 'canvas', albedo: [0.78, 0.75, 0.66], state: MatState.Solid, strength: 0.3, growthCap: 1, suitability: 0.2, porosity: 0.5 },
  // packed dust: a deep dust layer compacted into ground (round 15, H3)
  { ...NONE, name: 'silt', albedo: [0.56, 0.47, 0.37], state: MatState.Granular, reposeDry: 1.4, reposeWet: 1, strength: 0.15, growthCap: 3.5, suitability: 0.7, porosity: 0.5, smooth: 2, washMobility: 0.6, washFlow: 0.12 },
  // set lava: dark, glassy-rough stone (round 47)
  { ...NONE, name: 'basalt', albedo: [0.2, 0.19, 0.19], state: MatState.Solid, growthCap: 1.2, suitability: 0.35, specular: 0.12, porosity: 0.2 },
  // molten rock (a field, like oil; its glow is drawn by temperature)
  { ...NONE, name: 'lava', albedo: [0.9, 0.35, 0.08], state: MatState.Liquid, emissive: 1 },
  // snow (round 50): bright, holds a fair slope dry, slumps wet; a breeze
  // moves it (drifts in the lee), water carries it; melts to water when warm
  { ...NONE, name: 'snow', albedo: [0.84, 0.86, 0.9], state: MatState.Granular, reposeDry: 1.3, reposeWet: 0.7, strength: 0.05, growthCap: 0, porosity: 0, specular: 0.3, smooth: 2, windLift: 6, airborne: 0, washMobility: 1, washFlow: 0.05 },
  // fallen leaves (round 50): light, loose; blow about in a breeze, rot into soil
  { ...NONE, name: 'leaf litter', albedo: [0.55, 0.36, 0.16], state: MatState.Granular, reposeDry: 1.5, reposeWet: 1.2, strength: 0.05, growthCap: 4, suitability: 0.9, porosity: 0.5, smooth: 1.5, windLift: 5, airborne: 0, washMobility: 1, washFlow: 0.03 },
  // ice (round 50): see-through pale blue, glossy; melts back to water
  { ...NONE, name: 'ice', albedo: [0.72, 0.86, 0.95], state: MatState.Solid, strength: 0.4, specular: 0.9, glass: 1 },
  // crystal (round 50): faceted, see-through, a faint glow of its own
  { ...NONE, name: 'crystal', albedo: [0.62, 0.5, 0.9], state: MatState.Solid, emissive: 0.25, strength: 0.7, specular: 1, glass: 1 },
  // logs (round 63): felled trunks, cut and stacked (wood is the living trunk, plant matter)
  { ...NONE, name: 'log', albedo: [0.45, 0.31, 0.18], state: MatState.Solid, strength: 0.45, growthCap: 1, suitability: 0.2 },
  // sandstone (round 64): warm banded rock, the mesas' strata; terrain (round 69: strength 1 — the
  // atlas's mesas, badlands and dunes stand on it; api/terrain.ts already counted it as ground)
  { ...NONE, name: 'sandstone', albedo: [0.74, 0.47, 0.32], state: MatState.Solid, growthCap: 1.2, suitability: 0.3, porosity: 0.3 },
  // plaster and roof tiles (round 65): what the town is built of (build/town.ts): pale walls, terracotta roofs
  { ...NONE, name: 'plaster', albedo: [0.86, 0.8, 0.68], state: MatState.Solid, strength: 0.6, growthCap: 1.2, suitability: 0.25, porosity: 0.3 },
  { ...NONE, name: 'tile', albedo: [0.68, 0.3, 0.2], state: MatState.Solid, strength: 0.6, growthCap: 1.3, suitability: 0.3, specular: 0.15, porosity: 0.2 },
  // the atlas's forms (round 69; what's meant to stand is strong — "if you want it to stand make a stronger material"):
  // flesh: soft-looking, wet, red; the flesh style's ground, so terrain (strength 1): its vessels stand
  { ...NONE, name: 'flesh', albedo: [0.7, 0.34, 0.34], state: MatState.Solid, growthCap: 1.5, suitability: 0.45, specular: 0.35, porosity: 0.6, smooth: 2 },
  // coral: pale, porous, light and fairly strong (shells, branches, vessels)
  { ...NONE, name: 'coral', albedo: [0.9, 0.74, 0.68], state: MatState.Solid, strength: 0.85, growthCap: 1.6, suitability: 0.4, porosity: 0.55, smooth: 1 },
  // obsidian: black volcanic glass by the lava; terrain (never falls)
  { ...NONE, name: 'obsidian', albedo: [0.07, 0.06, 0.09], state: MatState.Solid, specular: 0.95, porosity: 0.05 },
  // quartz (round 75): the giant crystals, mountains of it — faceted, glowing a little; terrain. Round 83: in
  // the field mesh, cut as a gem (meshdraw.wgsl gemLook), not see-through prisms column by column
  { ...NONE, name: 'quartz', albedo: [0.74, 0.66, 0.96], state: MatState.Solid, emissive: 0.2, specular: 1 },
  // sinter: the pale crust a geyser's water leaves round its vent; terrain
  { ...NONE, name: 'sinter', albedo: [0.86, 0.82, 0.72], state: MatState.Solid, growthCap: 0.5, suitability: 0.1, porosity: 0.4, smooth: 2 },
  // bedrock (round 83, the user: "If things are breaking just make a material that is stronger so they don't
  // break"): dark, dense rock whose overhangs never give — for what must stand (a cave's roof, an arch)
  { ...NONE, name: 'bedrock', albedo: [0.26, 0.25, 0.25], state: MatState.Solid, porosity: 0.05, smooth: 2, span: Infinity },
];

export const MAX_MATERIALS = 40;
/** Floats per material in the GPU uniform: 5 x vec4<f32>. Must match materials.wgsl. */
export const MATERIAL_STRIDE_FLOATS = 20;

export function packMaterialTable(): Float32Array {
  if (MATERIALS.length > MAX_MATERIALS) throw new Error('material table overflow');
  const out = new Float32Array(MAX_MATERIALS * MATERIAL_STRIDE_FLOATS);
  MATERIALS.forEach((m, i) => {
    const o = i * MATERIAL_STRIDE_FLOATS;
    out.set([m.albedo[0], m.albedo[1], m.albedo[2], m.emissive], o);
    out.set([m.state, m.reposeDry, m.reposeWet, m.strength], o + 4);
    out.set([m.growthCap, m.suitability, m.specular, m.porosity], o + 8);
    out.set([m.smooth, m.glass ?? 0, 0, 0], o + 12);
    out.set([m.windLift, m.airborne, m.washMobility, m.washFlow], o + 16);
  });
  return out;
}
