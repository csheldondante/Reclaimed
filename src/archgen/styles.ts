// (archgen) Style profiles: a style is data — colours, materials, massing odds, window rhythm, dressing — compiled to
// STYLE_VEC4S vec4s a style for arch.wgsl (massing) and draw.wgsl (surfaces). Mirrors: arch.wgsl SV and the reads of
// sty(s, i) / styleV(s, i). Picked per district (citygen's districtStyle word, Track A, once it lands; a hash of the
// district until then), or forced in the lab. The palette follows the user's Tiny Glade references (2026-11-11): warm
// ochre stone, cream plaster, dark timber; sage, teal and lavender-grey roofs.

export const STYLE_VEC4S = 10;

/** wall materials (draw.wgsl archSurface) */
export const WALL = { plaster: 0, brick: 1, ashlar: 2, timber: 3 } as const;
/** roof coverings */
export const ROOF = { tile: 0, slate: 1, thatch: 2, patchwork: 3 } as const;
/** what a style builds on a building lot (arch.wgsl gen); plazas are markets and parks gardens whatever the style */
export const ARCHETYPE = { house: 0, keep: 1, shanty: 2, docks: 3, industrial: 4, grid: 5 } as const;

type RGB = [number, number, number];

export interface Style {
  name: string;
  wall: RGB;
  wallMat: number;
  /** window frames, cornices, mortar */
  trim: RGB;
  roof: RGB;
  roofMat: number;
  /** plinths, chimneys, towers, lot walls */
  stone: RGB;
  /** rise over half-span */
  pitch: number;
  /** eaves out past the walls, world units */
  overhang: number;
  /** upper floors out over the ground floor (0 none) */
  jetty: number;
  chimneyOdds: number;
  hipOdds: number;
  /** a tower's spire or cone: its height over its radius */
  spire: number;
  /** what's built on a lot (arch.wgsl's archetypes) */
  archetype: number;
  /** gables turned to the street (the port's) */
  gablesToStreet: boolean;
  towerOdds: number;
  shutters: boolean;
  /** window bays: width, the window's width, its top and bottom above the storey's floor */
  bay: number;
  winWidth: number;
  winTop: number;
  winBottom: number;
  /** a tower round rather than square */
  roundOdds: number;
  /** the front garden's depth (world units) */
  setback: number;
  lotWallOdds: number;
  porchOdds: number;
  /** an outside stair to the first floor */
  stairOdds: number;
  /** a wing turned on purpose */
  wingTurnOdds: number;
  /** dormers and flower boxes */
  dressOdds: number;
  /** the ground floor raised over a taller plinth (world units) */
  raised: number;
  /** the street door's width and height (default 1.1 × 2.1; the industrial's big doors) */
  door?: [number, number];
}

export const STYLES: Style[] = [
  {
    name: 'homes',
    wall: [0.95, 0.9, 0.78], wallMat: WALL.plaster, trim: [0.97, 0.95, 0.9], roof: [0.5, 0.62, 0.52], roofMat: ROOF.tile,
    stone: [0.82, 0.72, 0.55], pitch: 1.05, overhang: 0.35, jetty: 0, chimneyOdds: 0.7, hipOdds: 0.15, spire: 2.3,
    archetype: ARCHETYPE.house, gablesToStreet: false, towerOdds: 0.3, shutters: true, bay: 2.3, winWidth: 0.85, winTop: 2.25,
    winBottom: 1.0, roundOdds: 0.6, setback: 2.2, lotWallOdds: 0.7, porchOdds: 0.6, stairOdds: 0.15, wingTurnOdds: 0.15,
    dressOdds: 0.5, raised: 0.0,
  },
  {
    name: 'timber',
    wall: [0.95, 0.88, 0.72], wallMat: WALL.timber, trim: [0.33, 0.22, 0.14], roof: [0.4, 0.55, 0.58], roofMat: ROOF.slate,
    stone: [0.8, 0.7, 0.52], pitch: 1.35, overhang: 0.3, jetty: 0.35, chimneyOdds: 0.6, hipOdds: 0.05, spire: 2.6,
    archetype: ARCHETYPE.house, gablesToStreet: false, towerOdds: 0.35, shutters: false, bay: 1.9, winWidth: 0.8, winTop: 2.2,
    winBottom: 1.05, roundOdds: 0.5, setback: 1.2, lotWallOdds: 0.5, porchOdds: 0.3, stairOdds: 0.35, wingTurnOdds: 0.35,
    dressOdds: 0.6, raised: 0.0,
  },
  {
    name: 'port',
    wall: [0.7, 0.4, 0.3], wallMat: WALL.brick, trim: [0.88, 0.82, 0.72], roof: [0.5, 0.47, 0.58], roofMat: ROOF.slate,
    stone: [0.76, 0.7, 0.6], pitch: 1.1, overhang: 0.2, jetty: 0, chimneyOdds: 0.4, hipOdds: 0.0, spire: 2.2, archetype: ARCHETYPE.house,
    gablesToStreet: true, towerOdds: 0.05, shutters: false, bay: 2.5, winWidth: 1.0, winTop: 2.4, winBottom: 0.9,
    roundOdds: 0.3, setback: 0.0, lotWallOdds: 0.2, porchOdds: 0.0, stairOdds: 0.3, wingTurnOdds: 0.1, dressOdds: 0.3,
    raised: 0.4,
  },
  {
    name: 'keep',
    wall: [0.84, 0.74, 0.56], wallMat: WALL.ashlar, trim: [0.88, 0.82, 0.68], roof: [0.42, 0.5, 0.6], roofMat: ROOF.slate,
    stone: [0.8, 0.7, 0.52], pitch: 1.1, overhang: 0.1, jetty: 0, chimneyOdds: 0, hipOdds: 0.0, spire: 2.6, archetype: ARCHETYPE.keep,
    gablesToStreet: false, towerOdds: 0.9, shutters: false, bay: 3.0, winWidth: 0.55, winTop: 2.4, winBottom: 1.2,
    roundOdds: 0.7, setback: 0.0, lotWallOdds: 0.0, porchOdds: 0.0, stairOdds: 0.0, wingTurnOdds: 0.0, dressOdds: 0.2,
    raised: 0.0,
  },
  {
    // (port slums: crooked plank huts, plank and cloth lean-tos, cloth awnings)
    name: 'shanty',
    wall: [0.62, 0.5, 0.36], wallMat: 4, trim: [0.4, 0.3, 0.2], roof: [0.58, 0.55, 0.5], roofMat: ROOF.patchwork,
    stone: [0.6, 0.56, 0.5], pitch: 0.4, overhang: 0.3, jetty: 0, chimneyOdds: 0.2, hipOdds: 0, spire: 2.0,
    archetype: ARCHETYPE.shanty, gablesToStreet: false, towerOdds: 0, shutters: false, bay: 1.8, winWidth: 0.6, winTop: 1.9,
    winBottom: 1.0, roundOdds: 0, setback: 0.5, lotWallOdds: 0, porchOdds: 0, stairOdds: 0, wingTurnOdds: 0,
    dressOdds: 0.2, raised: 0,
  },
  {
    name: 'docks',
    wall: [0.6, 0.48, 0.34], wallMat: 4, trim: [0.4, 0.3, 0.2], roof: [0.48, 0.44, 0.5], roofMat: ROOF.patchwork,
    stone: [0.62, 0.6, 0.56], pitch: 0.4, overhang: 0.3, jetty: 0, chimneyOdds: 0, hipOdds: 0, spire: 2.0,
    archetype: ARCHETYPE.docks, gablesToStreet: false, towerOdds: 0, shutters: false, bay: 1.8, winWidth: 0.6, winTop: 1.9,
    winBottom: 1.0, roundOdds: 0, setback: 0, lotWallOdds: 0, porchOdds: 0, stairOdds: 0, wingTurnOdds: 0, dressOdds: 0,
    raised: 0,
  },
  {
    name: 'industrial',
    wall: [0.64, 0.36, 0.27], wallMat: WALL.brick, trim: [0.8, 0.76, 0.68], roof: [0.42, 0.44, 0.48], roofMat: ROOF.slate,
    stone: [0.7, 0.66, 0.58], pitch: 0.6, overhang: 0.15, jetty: 0, chimneyOdds: 0, hipOdds: 0, spire: 2.0,
    archetype: ARCHETYPE.industrial, gablesToStreet: false, towerOdds: 0, shutters: false, bay: 2.4, winWidth: 1.3,
    winTop: 2.7, winBottom: 0.8, roundOdds: 0, setback: 0, lotWallOdds: 0, porchOdds: 0, stairOdds: 0, wingTurnOdds: 0,
    dressOdds: 0, raised: 0, door: [2.6, 3.3],
  },
  {
    // (the irregular-grid family: Townscaper's harbour town — narrow coloured columns, terracotta, terraces, arcades)
    name: 'harbour',
    wall: [0.95, 0.9, 0.8], wallMat: WALL.plaster, trim: [0.97, 0.96, 0.93], roof: [0.82, 0.42, 0.26], roofMat: ROOF.tile,
    stone: [0.8, 0.74, 0.62], pitch: 1.05, overhang: 0.18, jetty: 0, chimneyOdds: 0.3, hipOdds: 0, spire: 2.4,
    archetype: ARCHETYPE.grid, gablesToStreet: true, towerOdds: 0, shutters: false, bay: 1.6, winWidth: 0.6, winTop: 2.2,
    winBottom: 1.1, roundOdds: 0, setback: 0, lotWallOdds: 0, porchOdds: 0, stairOdds: 0, wingTurnOdds: 0, dressOdds: 0.3,
    raised: 0, door: [0.9, 2.0],
  },
  {
    // (the irregular grid as a shanty: plank columns on stilts, crooked, plank and cloth lean-tos)
    name: 'stilts',
    wall: [0.62, 0.5, 0.36], wallMat: 4, trim: [0.4, 0.3, 0.2], roof: [0.58, 0.55, 0.5], roofMat: ROOF.patchwork,
    stone: [0.6, 0.56, 0.5], pitch: 0.4, overhang: 0.25, jetty: 0, chimneyOdds: 0, hipOdds: 0, spire: 2.0,
    archetype: ARCHETYPE.grid, gablesToStreet: false, towerOdds: 0, shutters: false, bay: 1.6, winWidth: 0.6, winTop: 1.9,
    winBottom: 1.0, roundOdds: 0, setback: 0, lotWallOdds: 0, porchOdds: 0, stairOdds: 0, wingTurnOdds: 0, dressOdds: 0,
    raised: 0, door: [0.9, 1.9],
  },
];

/** the table as vec4s (STYLE_VEC4S a style); the layout arch.wgsl and draw.wgsl read */
export function styleWords(styles: Style[] = STYLES): Float32Array {
  const f = new Float32Array(styles.length * STYLE_VEC4S * 4);
  styles.forEach((s, i) => {
    const v = [
      [...s.wall, s.wallMat],
      [...s.trim, 0],
      [...s.roof, s.roofMat],
      [...s.stone, 0],
      [s.pitch, s.overhang, s.jetty, s.chimneyOdds],
      [s.hipOdds, s.spire, s.archetype, s.gablesToStreet ? 1 : 0],
      [s.door?.[0] ?? 1.1, s.towerOdds, s.shutters ? 1 : 0, s.door?.[1] ?? 2.1],
      [s.bay, s.winWidth, s.winTop, s.winBottom],
      [s.roundOdds, s.setback, s.lotWallOdds, s.porchOdds],
      [s.stairOdds, s.wingTurnOdds, s.dressOdds, s.raised],
    ];
    f.set(v.flat(), i * STYLE_VEC4S * 4);
  });
  return f;
}
