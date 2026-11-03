// The generator's steerable parameters (round 128, treegen): one table, read by the flora viewer's sliders and its
// URL, applied to a species as an edited copy. The user: "parameters for taper, branching distance and angle plus
// variance, whether we twist branches as we go, ... knots and direction changes", "Bark color and texture
// parameters". Pure (no DOM), so it is tested.

import { NO_EPIPHYTES, SPECIES, type SpeciesDef, type SpeciesId } from './species';

export interface Param {
  /** the URL key (p.<key>) and the slider's id */
  key: string;
  label: string;
  group: 'stem' | 'bark' | 'epiphytes';
  min: number;
  max: number;
  step: number;
  /** woody plants only (needs a turtle / a stem look) */
  woody?: boolean;
  get(sp: SpeciesDef): number;
  set(sp: SpeciesDef, v: number): void;
}

const T = (k: keyof NonNullable<SpeciesDef['turtle']>, d = 0) => ({
  get: (sp: SpeciesDef) => (sp.turtle?.[k] as number | undefined) ?? d,
  set: (sp: SpeciesDef, v: number) => {
    if (sp.turtle) (sp.turtle as unknown as Record<string, number>)[k] = v;
  },
});
const S = (k: keyof NonNullable<SpeciesDef['stem']>) => ({
  get: (sp: SpeciesDef) => sp.stem?.[k] ?? 0,
  set: (sp: SpeciesDef, v: number) => {
    if (sp.stem) sp.stem[k] = v;
  },
});
const E = (k: keyof NonNullable<SpeciesDef['epiphytes']>) => ({
  get: (sp: SpeciesDef) => sp.epiphytes?.[k] ?? 0,
  set: (sp: SpeciesDef, v: number) => {
    sp.epiphytes = { ...(sp.epiphytes ?? NO_EPIPHYTES), [k]: v };
  },
});
const B = (k: keyof SpeciesDef['bark']) => ({
  get: (sp: SpeciesDef) => sp.bark[k],
  set: (sp: SpeciesDef, v: number) => {
    sp.bark[k] = v;
  },
});

export const PARAMS: Param[] = [
  { key: 'taper', label: 'taper', group: 'stem', min: 0.7, max: 1, step: 0.005, woody: true, ...T('taper') },
  { key: 'taperVar', label: 'taper ±', group: 'stem', min: 0, max: 1, step: 0.01, woody: true, ...T('taperVar') },
  { key: 'spacing', label: 'branch dist', group: 'stem', min: 0.5, max: 2, step: 0.01, woody: true, ...T('spacing', 1) },
  { key: 'stepVar', label: 'dist ±', group: 'stem', min: 0, max: 0.6, step: 0.01, woody: true, ...T('stepVar') },
  { key: 'angle', label: 'angle', group: 'stem', min: 5, max: 70, step: 0.5, woody: true, ...T('angle') },
  { key: 'jitter', label: 'angle ±', group: 'stem', min: 0, max: 40, step: 0.5, woody: true, ...T('jitter') },
  { key: 'twist', label: 'twist °/step', group: 'stem', min: 0, max: 40, step: 0.5, woody: true, ...T('twist') },
  { key: 'kinkChance', label: 'kinks', group: 'stem', min: 0, max: 0.8, step: 0.01, woody: true, ...T('kinkChance') },
  { key: 'kinkAngle', label: 'kink °', group: 'stem', min: 0, max: 45, step: 0.5, woody: true, ...T('kinkAngle') },
  { key: 'sides', label: 'sides', group: 'stem', min: 3, max: 12, step: 1, woody: true, ...S('sides') },
  { key: 'noise', label: 'noise', group: 'stem', min: 0, max: 0.4, step: 0.005, woody: true, ...S('noise') },
  { key: 'noiseFreq', label: 'noise freq', group: 'stem', min: 0.05, max: 2, step: 0.01, woody: true, ...S('noiseFreq') },
  { key: 'knots', label: 'knots /10', group: 'stem', min: 0, max: 10, step: 0.1, woody: true, ...S('knots') },
  { key: 'knotSize', label: 'knot size', group: 'stem', min: 0, max: 1, step: 0.01, woody: true, ...S('knotSize') },
  { key: 'ring', label: 'ring cells', group: 'stem', min: 0.2, max: 6, step: 0.05, woody: true, ...S('ring') },
  { key: 'furrows', label: 'furrows', group: 'bark', min: 0, max: 1, step: 0.01, ...B('furrows') },
  { key: 'furrowFreq', label: 'furrow freq', group: 'bark', min: 0.5, max: 8, step: 0.1, ...B('furrowFreq') },
  { key: 'plates', label: 'plates', group: 'bark', min: 0, max: 1, step: 0.01, ...B('plates') },
  { key: 'plateSize', label: 'plate size', group: 'bark', min: 0.1, max: 2, step: 0.01, ...B('plateSize') },
  { key: 'stripes', label: 'stripes', group: 'bark', min: 0, max: 0.6, step: 0.01, ...B('stripes') },
  { key: 'stripeFreq', label: 'stripe freq', group: 'bark', min: 1, max: 14, step: 0.1, ...B('stripeFreq') },
  { key: 'roughness', label: 'roughness', group: 'bark', min: 0, max: 1, step: 0.01, ...B('roughness') },
  { key: 'lichen', label: 'lichens', group: 'epiphytes', min: 0, max: 1, step: 0.01, ...E('lichen') },
  { key: 'mossLimbs', label: 'mosses', group: 'epiphytes', min: 0, max: 1, step: 0.01, ...E('moss') },
  { key: 'plants', label: 'plants', group: 'epiphytes', min: 0, max: 1, step: 0.01, woody: true, ...E('plants') },
  { key: 'vines', label: 'vines', group: 'epiphytes', min: 0, max: 1, step: 0.01, woody: true, ...E('vines') },
  { key: 'lines', label: 'lines', group: 'epiphytes', min: 0, max: 1, step: 0.01, woody: true, ...E('lines') },
  {
    key: 'blossom',
    label: 'blossom',
    group: 'epiphytes',
    min: 0,
    max: 1,
    step: 0.01,
    woody: true,
    get: (sp) => sp.blossom ?? 0,
    set: (sp, v) => {
      sp.blossom = v;
    },
  },
];

/** (round 128) the season control's named points (the year 0..1, G.rules.w; common.wgsl's season functions) */
export const SEASONS: { name: string; at: number }[] = [
  { name: 'flower', at: 0.97 },
  { name: 'leaf', at: 0.2 },
  { name: 'autumn', at: 0.47 },
  { name: 'bare', at: 0.76 },
  { name: 'winter', at: 0.85 },
];

/** colours steerable as hex (the bark's base and marks) */
export const COLOUR_PARAMS = ['bark', 'barkMark'] as const;

/** A deep copy of a species (the parts the parameters edit), so edits never touch the table. */
export function cloneDef(sp: SpeciesDef): SpeciesDef {
  return {
    ...sp,
    turtle: sp.turtle ? { ...sp.turtle, tropism: [...sp.turtle.tropism], tropismStrength: [...sp.turtle.tropismStrength] } : undefined,
    stem: sp.stem ? { ...sp.stem } : undefined,
    bark: { ...sp.bark },
    epiphytes: sp.epiphytes ? { ...sp.epiphytes } : undefined,
    colours: { ...sp.colours, bark: [...sp.colours.bark], barkMark: sp.colours.barkMark ? [...sp.colours.barkMark] : undefined },
    leaf: sp.leaf ? { ...sp.leaf } : undefined,
  };
}

export const hex = (c: [number, number, number]) => '#' + c.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('');
export const unhex = (h: string): [number, number, number] => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255) as [number, number, number];

/** The species with the overrides applied (`over`: param key → value; colour keys → '#rrggbb'). */
export function applyParams(id: SpeciesId, over: Record<string, number | string>): SpeciesDef {
  const sp = cloneDef(SPECIES[id]);
  for (const p of PARAMS) {
    const v = over[p.key];
    if (typeof v === 'number' && Number.isFinite(v)) p.set(sp, Math.min(p.max, Math.max(p.min, v)));
  }
  for (const c of COLOUR_PARAMS) {
    const v = over[c];
    if (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v)) sp.colours[c] = unhex(v);
  }
  return sp;
}

/** Overrides from a query string's p.<key> entries. */
export function paramsFromQuery(q: URLSearchParams): Record<string, number | string> {
  const o: Record<string, number | string> = {};
  for (const [k, v] of q) {
    if (!k.startsWith('p.')) continue;
    const key = k.slice(2);
    o[key] = (COLOUR_PARAMS as readonly string[]).includes(key) ? `#${v.replace(/^#/, '')}` : Number(v);
  }
  return o;
}
