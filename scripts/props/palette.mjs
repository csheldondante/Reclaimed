// The interior prop palette (written into data/props/props.json by voxelise.mjs; src/interiors/palette.ts reads it there).
// Muted, dark-leaning colours in the Rain World mood: every CC model's colours are mapped to the
// nearest of these in the prepass, so props from different packs share one look.
export const VOX = 16; // prop voxels per world cell (a sixteenth-cell grid: the renderer's finest voxel size code)

export const PROP_PALETTE = [
  { name: 'black', rgb: [0.06, 0.055, 0.05] },
  { name: 'woodDeep', rgb: [0.2, 0.12, 0.07] },
  { name: 'woodDark', rgb: [0.33, 0.2, 0.11] },
  { name: 'wood', rgb: [0.5, 0.32, 0.18] },
  { name: 'woodLight', rgb: [0.66, 0.47, 0.29] },
  { name: 'stoneDark', rgb: [0.22, 0.22, 0.23] },
  { name: 'stone', rgb: [0.4, 0.39, 0.37] },
  { name: 'stoneLight', rgb: [0.6, 0.58, 0.54] },
  { name: 'ironDark', rgb: [0.14, 0.15, 0.17] },
  { name: 'iron', rgb: [0.32, 0.34, 0.37] },
  { name: 'brass', rgb: [0.62, 0.48, 0.22] },
  { name: 'clothRed', rgb: [0.48, 0.13, 0.11] },
  { name: 'clothRedDark', rgb: [0.28, 0.07, 0.07] },
  { name: 'clothGreen', rgb: [0.2, 0.32, 0.18] },
  { name: 'clothBlue', rgb: [0.17, 0.23, 0.36] },
  { name: 'clothTeal', rgb: [0.17, 0.36, 0.31] },
  { name: 'clothOchre', rgb: [0.6, 0.44, 0.17] },
  { name: 'linen', rgb: [0.74, 0.68, 0.56] },
  { name: 'wax', rgb: [0.86, 0.8, 0.64] },
  { name: 'flame', rgb: [1.0, 0.72, 0.3] },
  { name: 'leaf', rgb: [0.26, 0.4, 0.2] },
  { name: 'clay', rgb: [0.55, 0.3, 0.2] },
  { name: 'straw', rgb: [0.7, 0.6, 0.32] },
  { name: 'ironLight', rgb: [0.5, 0.52, 0.54] },
  { name: 'glass', rgb: [0.2, 0.32, 0.36] },
  { name: 'bone', rgb: [0.82, 0.78, 0.7] },
];
