// (tilekit, docs/design/TILEKIT.md §7) An architectural theme as data: proportions, openings, the profiles swept
// along walls (plinth, band, cornice), corners, timber frame, roof, palette, warp. kit.ts reads only these values; no
// code path looks at a theme's name. Two ship, to show two looks from data alone.

export type RGB = [number, number, number];

/** a cross-section swept along a panel: (w out of the wall, z up from the band's base), metres; its colour */
export interface Profile {
  pts: [number, number][];
  col: RGB;
}

export interface Theme {
  name: string;
  /** storey heights: the ground storey, those above */
  groundH: number;
  storeyH: number;
  /** every box's chamfer */
  bevel: number;
  wall: {
    /** house colours (a building picks one) */
    palette: RGB[];
    /** the ground storey's wall colour when it is a different material (stone under timber), else null */
    ground: RGB | null;
  };
  window: {
    w: number;
    h: number;
    /** sill height above the storey's floor */
    sill: number;
    recess: number;
    frame: number;
    frameDepth: number;
    frameCol: RGB;
    sillDepth: number;
    glass: RGB;
    /** a mullion and transom in the recess */
    cross: boolean;
    /** shutters beside the frame (their colour), or null */
    shutters: RGB | null;
  };
  door: { w: number; h: number; recess: number; col: RGB; frame: number; frameCol: RGB };
  /** a panel shorter than this gets no window */
  minWindowPanel: number;
  /** odds of a blank panel where a window would fit */
  blankOdds: number;
  plinth: Profile;
  /** between storeys (z from the storey's top) */
  band: Profile | null;
  /** under the eave (z from the storey's top) */
  cornice: Profile;
  /** stone quoins at convex corners, or null */
  quoins: { w: number; long: number; short: number; h: number; depth: number; col: RGB } | null;
  /** half-timber: posts at panel ends, rails at floor and head, braces on blank panels; null none */
  timber: { post: number; rail: number; depth: number; braces: boolean; col: RGB; groundToo: boolean } | null;
  roof: { pitch: number; overhang: number; thickness: number; cap: number; palette: RGB[]; fascia: RGB };
  ground: { col: RGB; paving: RGB };
  warp: { wonk: number; sag: number };
}

const hex = (h: string): RGB => [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255];

/** a southern render town: pastel plaster, stone quoins and plinth, deep plain windows with shutters, a moulded
 *  cornice, low terracotta roofs */
export const PLASTER: Theme = {
  name: 'plaster',
  groundH: 3.2,
  storeyH: 2.9,
  bevel: 0.035,
  wall: { palette: ['#e9d9b8', '#e7c0a0', '#d9e2cf', '#efe6d2', '#e3b98f', '#cfd8de'].map(hex), ground: null },
  window: { w: 0.82, h: 1.35, sill: 0.95, recess: 0.26, frame: 0.1, frameDepth: 0.05, frameCol: hex('#f4efe4'), sillDepth: 0.12, glass: hex('#2c3c48'), cross: false, shutters: hex('#5d7f6a') },
  door: { w: 1.05, h: 2.25, recess: 0.32, col: hex('#6b4a33'), frame: 0.14, frameCol: hex('#d8cbb3') },
  minWindowPanel: 1.7,
  blankOdds: 0.18,
  plinth: { pts: [[0, 0], [0.13, 0], [0.13, 0.5], [0.06, 0.58], [0, 0.58]], col: hex('#b9ab95') },
  band: { pts: [[0, -0.1], [0.05, -0.1], [0.05, 0.02], [0, 0.04]], col: hex('#f1ead9') },
  cornice: { pts: [[0, -0.5], [0.04, -0.5], [0.04, -0.42], [0.1, -0.36], [0.17, -0.22], [0.26, -0.12], [0.3, -0.12], [0.3, 0], [0, 0]], col: hex('#f1ead9') },
  quoins: { w: 0.42, long: 0.62, short: 0.38, h: 0.32, depth: 0.04, col: hex('#cdbfa5') },
  timber: null,
  roof: { pitch: 0.55, overhang: 0.42, thickness: 0.16, cap: 3.0, palette: ['#b5573a', '#c0683f', '#a94f3a', '#b8623f'].map(hex), fascia: hex('#efe6d2') },
  ground: { col: hex('#b8ad98'), paving: hex('#a39883') },
  warp: { wonk: 0.05, sag: 0 },
};

/** a northern timber town: stone ground floor, white infill between dark posts, rails and braces, small paned
 *  windows, a plain band, steep dark roofs with deep eaves */
export const TIMBER: Theme = {
  name: 'timber',
  groundH: 2.8,
  storeyH: 2.6,
  bevel: 0.03,
  wall: { palette: ['#f1ece0', '#ece3cf', '#efe9dc', '#e8dcc4'].map(hex), ground: hex('#a59a88') },
  window: { w: 0.66, h: 1.1, sill: 0.85, recess: 0.18, frame: 0.08, frameDepth: 0.06, frameCol: hex('#4a3426'), sillDepth: 0.09, glass: hex('#26323a'), cross: true, shutters: null },
  door: { w: 0.95, h: 2.05, recess: 0.24, col: hex('#3f2b1f'), frame: 0.16, frameCol: hex('#4a3426') },
  minWindowPanel: 1.5,
  blankOdds: 0.3,
  plinth: { pts: [[0, 0], [0.1, 0], [0.1, 0.3], [0, 0.36]], col: hex('#8f8676') },
  band: null,
  cornice: { pts: [[0, -0.2], [0.08, -0.2], [0.08, 0], [0, 0]], col: hex('#4a3426') },
  quoins: null,
  timber: { post: 0.2, rail: 0.18, depth: 0.05, braces: true, col: hex('#4a3426'), groundToo: false },
  roof: { pitch: 1.05, overhang: 0.6, thickness: 0.2, cap: 4.2, palette: ['#4f5257', '#5a4d47', '#46494f', '#5b5148'].map(hex), fascia: hex('#3b2c22') },
  ground: { col: hex('#a7a291'), paving: hex('#948f80') },
  warp: { wonk: 0.12, sag: 0 },
};

export const THEMES: Theme[] = [PLASTER, TIMBER];
