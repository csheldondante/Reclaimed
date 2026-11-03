// The wind on foliage (round 125, `forest`; BACKLOG FLO30; the user's matrix, docs/design/FOLIAGE_WIND.md): which of the
// treatments the draw runs, as floralook.wgsl's FWIND bits (a pipeline override, so the off pairs cost nothing).
//   static  0  the baseline: nothing moves (the matrix's row 0)
//   sway    1  as it was: the column's lean, the leaves' flutter, the meadow's wave (the grass's 1B vertex bending)
//   1A      3  + the wind-shading ripple (fragment: leaves and blades brighten and darken as a gust runs over)
//   1C      5  + the coarse lattice (a tree's crown moved by 8 control points of a traveling gust field)
//   1A1C    7  both (the default)
// `?fwind=` picks one; an unknown name throws (no quiet default).
export const FWIND_MODES = { static: 0, sway: 1, '1A': 3, '1C': 5, '1A1C': 7 } as const;
export type FwindMode = keyof typeof FWIND_MODES;
export const FWIND_DEFAULT: FwindMode = '1A1C';

export function fwindBits(name: string | null): number {
  const n = name ?? FWIND_DEFAULT;
  if (!(n in FWIND_MODES)) throw new Error(`?fwind=${n}: one of ${Object.keys(FWIND_MODES).join(', ')}`);
  return FWIND_MODES[n as FwindMode];
}

/** this page's (read once, so A/B pairs differ only by it) */
export const FWIND = fwindBits(typeof location !== 'undefined' ? new URLSearchParams(location.search).get('fwind') : null);
