// (archgen) Style profiles: a style is data — colours, materials, massing odds, window rhythm — compiled to STYLE_VEC4S
// vec4s a style for arch.wgsl (massing) and draw.wgsl (surfaces). Mirrors: arch.wgsl SV and the reads of sty(s, i) /
// styleV(s, i). Picked per district (citygen's districtStyle word, Track A, once it lands; a hash of the district
// until then), or forced in the lab.

export const STYLE_VEC4S = 8;

/** wall materials (draw.wgsl fsArch) */
export const WALL = { plaster: 0, brick: 1, ashlar: 2, timber: 3 } as const;
/** roof coverings */
export const ROOF = { tile: 0, slate: 1, thatch: 2 } as const;

type RGB = [number, number, number];

export interface Style {
  name: string;
  wall: RGB;
  wallMat: number;
  /** window frames, cornices, mortar */
  trim: RGB;
  roof: RGB;
  roofMat: number;
  /** plinth, chimneys, towers */
  stone: RGB;
  /** rise over half-span */
  pitch: number;
  /** eaves out past the walls, world units */
  overhang: number;
  /** upper floors out over the ground floor (0 none) */
  jetty: number;
  chimneyOdds: number;
  hipOdds: number;
  /** a tower's spire: its height over its width */
  spire: number;
  /** flat roofs behind a parapet */
  flat: boolean;
  /** gables turned to the street (the port's) */
  gablesToStreet: boolean;
  /** a house unit's frontage: the street side split into units about this wide */
  unitWidth: number;
  towerOdds: number;
  shutters: boolean;
  /** window bays: width, the window's width, its top and bottom above the storey's floor */
  bay: number;
  winWidth: number;
  winTop: number;
  winBottom: number;
}

export const STYLES: Style[] = [
  {
    name: 'homes',
    wall: [0.95, 0.9, 0.8], wallMat: WALL.plaster, trim: [0.98, 0.97, 0.93], roof: [0.74, 0.37, 0.24], roofMat: ROOF.tile,
    stone: [0.66, 0.63, 0.58], pitch: 0.8, overhang: 0.35, jetty: 0, chimneyOdds: 0.6, hipOdds: 0.25, spire: 2.2,
    flat: false, gablesToStreet: false, unitWidth: 6, towerOdds: 0.04, shutters: true, bay: 2.3, winWidth: 0.9, winTop: 2.3,
    winBottom: 1.0,
  },
  {
    name: 'timber',
    wall: [0.94, 0.88, 0.74], wallMat: WALL.timber, trim: [0.32, 0.21, 0.13], roof: [0.42, 0.46, 0.53], roofMat: ROOF.slate,
    stone: [0.6, 0.58, 0.55], pitch: 1.1, overhang: 0.3, jetty: 0.35, chimneyOdds: 0.5, hipOdds: 0.1, spire: 2.4,
    flat: false, gablesToStreet: false, unitWidth: 5.5, towerOdds: 0.05, shutters: false, bay: 1.9, winWidth: 0.8,
    winTop: 2.2, winBottom: 1.1,
  },
  {
    name: 'port',
    wall: [0.67, 0.37, 0.27], wallMat: WALL.brick, trim: [0.86, 0.81, 0.72], roof: [0.36, 0.38, 0.43], roofMat: ROOF.slate,
    stone: [0.62, 0.6, 0.56], pitch: 0.9, overhang: 0.2, jetty: 0, chimneyOdds: 0.3, hipOdds: 0.0, spire: 2.0, flat: false,
    gablesToStreet: true, unitWidth: 7, towerOdds: 0.0, shutters: false, bay: 2.6, winWidth: 1.1, winTop: 2.4, winBottom: 0.9,
  },
  {
    name: 'keep',
    wall: [0.76, 0.73, 0.66], wallMat: WALL.ashlar, trim: [0.82, 0.8, 0.74], roof: [0.34, 0.41, 0.52], roofMat: ROOF.slate,
    stone: [0.7, 0.67, 0.6], pitch: 1.1, overhang: 0.1, jetty: 0, chimneyOdds: 0, hipOdds: 0.0, spire: 2.6, flat: true,
    gablesToStreet: false, unitWidth: 9, towerOdds: 0.9, shutters: false, bay: 3.0, winWidth: 0.5, winTop: 2.4,
    winBottom: 1.2,
  },
];

/** the table as vec4s (STYLE_VEC4S a style) */
export function styleWords(styles: Style[] = STYLES): Float32Array {
  const f = new Float32Array(styles.length * STYLE_VEC4S * 4);
  styles.forEach((s, i) => {
    const v = [
      [...s.wall, s.wallMat],
      [...s.trim, 0],
      [...s.roof, s.roofMat],
      [...s.stone, 0],
      [s.pitch, s.overhang, s.jetty, s.chimneyOdds],
      [s.hipOdds, s.spire, s.flat ? 1 : 0, s.gablesToStreet ? 1 : 0],
      [s.unitWidth, s.towerOdds, s.shutters ? 1 : 0, 0],
      [s.bay, s.winWidth, s.winTop, s.winBottom],
    ];
    f.set(v.flat(), i * STYLE_VEC4S * 4);
  });
  return f;
}
