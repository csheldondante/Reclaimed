// The generator's steerable parameters (round 128, treegen): one table, read by the flora viewer's sliders and its
// URL, applied to a species as an edited copy. The user: "parameters for taper, branching distance and angle plus
// variance, whether we twist branches as we go, ... knots and direction changes", "Bark color and texture
// parameters". Pure (no DOM), so it is tested.

import { NO_EPIPHYTES, SPECIES, type SpeciesDef, type SpeciesId } from './species';

export interface Param {
  /** the URL key (p.<key>) and the slider's id */
  key: string;
  label: string;
  group: 'shape' | 'stem' | 'crown' | 'bark' | 'epiphytes';
  min: number;
  max: number;
  step: number;
  /** woody plants only (needs a turtle / a stem look) */
  woody?: boolean;
  /** (round 128) broadleaf crowns only (needs a crown look) */
  crown?: boolean;
  /** (round 128) plants with fine twigs only */
  twigs?: boolean;
  /** (round 128) colonized crowns only (colonize.ts) */
  shape?: boolean;
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
const CR = (k: 'size' | 'perTwig' | 'spacing' | 'fill' | 'leaves' | 'droop') => ({
  get: (sp: SpeciesDef) => sp.crown?.[k] ?? 0,
  set: (sp: SpeciesDef, v: number) => {
    if (sp.crown) sp.crown[k] = v;
  },
});
const TW = (k: keyof NonNullable<SpeciesDef['twigs']>) => ({
  get: (sp: SpeciesDef) => sp.twigs?.[k] ?? 0,
  set: (sp: SpeciesDef, v: number) => {
    if (sp.twigs) sp.twigs[k] = v;
  },
});
const SH = (k: 'crownBase' | 'width' | 'points' | 'step' | 'upBend' | 'weep' | 'maxAngle' | 'forks' | 'trunkRadius' | 'thin' | 'straight' | 'influence') => ({
  get: (sp: SpeciesDef) => (sp.colonize?.[k] as number | undefined) ?? 0,
  set: (sp: SpeciesDef, v: number) => {
    if (sp.colonize) (sp.colonize as unknown as Record<string, number>)[k] = v;
  },
});
const ENVELOPES = ['dome', 'cone', 'column', 'umbrella'] as const;
const B = (k: keyof SpeciesDef['bark']) => ({
  get: (sp: SpeciesDef) => sp.bark[k],
  set: (sp: SpeciesDef, v: number) => {
    sp.bark[k] = v;
  },
});

export const PARAMS: Param[] = [
  // (round 128: the crown's shape — space colonization, colonize.ts)
  { key: 'sCrownBase', label: 'crown base', group: 'shape', min: 0.05, max: 0.8, step: 0.01, shape: true, ...SH('crownBase') },
  { key: 'sWidth', label: 'crown width', group: 'shape', min: 0.05, max: 0.9, step: 0.01, shape: true, ...SH('width') },
  { key: 'sEnvelope', label: 'shape 0 dome 1 cone 2 column 3 umbrella', group: 'shape', min: 0, max: 3, step: 1, shape: true, get: (sp) => ENVELOPES.indexOf(sp.colonize?.envelope ?? 'dome'), set: (sp, v) => { if (sp.colonize) sp.colonize.envelope = ENVELOPES[Math.round(v)] ?? 'dome'; } },
  { key: 'sPoints', label: 'fill points', group: 'shape', min: 20, max: 1500, step: 10, shape: true, ...SH('points') },
  { key: 'sStep', label: 'node length', group: 'shape', min: 0.4, max: 4, step: 0.05, shape: true, ...SH('step') },
  { key: 'sInfluence', label: 'reach', group: 'shape', min: 2, max: 15, step: 0.5, shape: true, ...SH('influence') },
  { key: 'sUpBend', label: 'up bend', group: 'shape', min: -1, max: 1.5, step: 0.01, shape: true, ...SH('upBend') },
  { key: 'sWeep', label: 'weep', group: 'shape', min: 0, max: 1, step: 0.01, shape: true, ...SH('weep') },
  { key: 'sMaxAngle', label: 'max branch angle', group: 'shape', min: 10, max: 90, step: 1, shape: true, ...SH('maxAngle') },
  { key: 'sLeader', label: 'leader', group: 'shape', min: 0, max: 1, step: 1, shape: true, get: (sp) => (sp.colonize?.leader ? 1 : 0), set: (sp, v) => { if (sp.colonize) sp.colonize.leader = v >= 0.5; } },
  { key: 'sForks', label: 'limbs at the fork', group: 'shape', min: 1, max: 7, step: 1, shape: true, ...SH('forks') },
  { key: 'sTrunk', label: 'trunk radius', group: 'shape', min: 0.1, max: 8, step: 0.05, shape: true, ...SH('trunkRadius') },
  { key: 'sThin', label: 'branch thinning', group: 'shape', min: 0.3, max: 1, step: 0.01, shape: true, ...SH('thin') },
  { key: 'sStraight', label: 'straightness', group: 'shape', min: 0, max: 1, step: 0.01, shape: true, ...SH('straight') },
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
  { key: 'cSize', label: 'spray size', group: 'crown', min: 0.3, max: 8, step: 0.05, crown: true, ...CR('size') },
  { key: 'cPer', label: 'per twig', group: 'crown', min: 1, max: 8, step: 1, crown: true, ...CR('perTwig') },
  { key: 'cSpacing', label: 'spacing', group: 'crown', min: 0, max: 4, step: 0.05, crown: true, ...CR('spacing') },
  { key: 'cFill', label: 'fill', group: 'crown', min: 0.1, max: 1, step: 0.01, crown: true, ...CR('fill') },
  { key: 'cLeaves', label: 'cards', group: 'crown', min: 2, max: 20, step: 1, crown: true, ...CR('leaves') },
  { key: 'cDroop', label: 'droop', group: 'crown', min: 0, max: 1, step: 0.01, crown: true, ...CR('droop') },
  { key: 'cStyle', label: 'style 0 cards 1 lobes 2 lobe-cards 3 hybrid 4 layers 5 cones', group: 'crown', min: 0, max: 5, step: 1, crown: true, get: (sp) => ['sprays', 'solid', 'lobecards', 'hybrid', 'layers', 'cones'].indexOf(sp.crown?.style ?? 'sprays'), set: (sp, v) => { if (sp.crown) sp.crown.style = (['sprays', 'solid', 'lobecards', 'hybrid', 'layers', 'cones'] as const)[Math.round(v)] ?? 'sprays'; } },
  { key: 'cSeparate', label: 'lobe separation', group: 'crown', min: 0, max: 1, step: 0.01, crown: true, get: (sp) => sp.crown?.separate ?? 0.25, set: (sp, v) => { if (sp.crown) sp.crown.separate = v; } },
  { key: 'cLobeShape', label: 'lobe 0 round 1 pad 2 shelf 3 column 4 tear', group: 'crown', min: 0, max: 4, step: 1, crown: true, get: (sp) => ['round', 'pad', 'shelf', 'column', 'tear'].indexOf(sp.crown?.lobeShape ?? 'round'), set: (sp, v) => { if (sp.crown) sp.crown.lobeShape = (['round', 'pad', 'shelf', 'column', 'tear'] as const)[Math.round(v)] ?? 'round'; } },
  { key: 'cLayers', label: 'layers', group: 'crown', min: 1, max: 5, step: 1, crown: true, get: (sp) => sp.crown?.layers ?? 3, set: (sp, v) => { if (sp.crown) sp.crown.layers = v; } },
  { key: 'cLayerGap', label: 'layer gap (leaf widths)', group: 'crown', min: 0.05, max: 2, step: 0.05, crown: true, get: (sp) => sp.crown?.layerGap ?? 0.35, set: (sp, v) => { if (sp.crown) sp.crown.layerGap = v; } },
  { key: 'cDepthDark', label: 'depth dark', group: 'crown', min: 0, max: 1, step: 0.01, crown: true, get: (sp) => sp.crown?.depthDark ?? 0.6, set: (sp, v) => { if (sp.crown) sp.crown.depthDark = v; } },
  { key: 'cBend', label: 'card bend', group: 'crown', min: 0, max: 1, step: 0.01, crown: true, get: (sp) => sp.crown?.bend ?? 0.7, set: (sp, v) => { if (sp.crown) sp.crown.bend = v; } },
  { key: 'cCore', label: 'core', group: 'crown', min: 0, max: 1, step: 1, crown: true, get: (sp) => sp.crown?.core ?? 1, set: (sp, v) => { if (sp.crown) sp.crown.core = v; } },
  { key: 'cShell', label: 'shell cards', group: 'crown', min: 0, max: 2, step: 0.01, crown: true, get: (sp) => sp.crown?.shell ?? 0.35, set: (sp, v) => { if (sp.crown) sp.crown.shell = v; } },
  { key: 'cClump', label: 'lobe size', group: 'crown', min: 0.5, max: 16, step: 0.1, crown: true, get: (sp) => sp.crown?.clump ?? 6, set: (sp, v) => { if (sp.crown) sp.crown.clump = v; } },
  { key: 'cGaps', label: 'gaps', group: 'crown', min: 0, max: 0.8, step: 0.01, crown: true, get: (sp) => sp.crown?.gaps ?? 0.05, set: (sp, v) => { if (sp.crown) sp.crown.gaps = v; } },
  { key: 'cLumps', label: 'lumps', group: 'crown', min: 0, max: 1, step: 0.01, crown: true, get: (sp) => sp.crown?.lumps ?? 0.3, set: (sp, v) => { if (sp.crown) sp.crown.lumps = v; } },
  { key: 'cBlend', label: 'lobe normals', group: 'crown', min: 0, max: 1, step: 0.01, crown: true, get: (sp) => sp.crown?.lobeBlend ?? 0.85, set: (sp, v) => { if (sp.crown) sp.crown.lobeBlend = v; } },
  { key: 'tCount', label: 'twigs', group: 'crown', min: 0, max: 6, step: 1, twigs: true, ...TW('count') },
  { key: 'tAngle', label: 'twig angle', group: 'crown', min: 5, max: 80, step: 1, twigs: true, ...TW('angle') },
  { key: 'tLength', label: 'twig length', group: 'crown', min: 0.2, max: 5, step: 0.05, twigs: true, ...TW('length') },
  { key: 'tFalloff', label: 'twig falloff', group: 'crown', min: 0.2, max: 1, step: 0.01, twigs: true, ...TW('falloff') },
  { key: 'tOrders', label: 'twig orders', group: 'crown', min: 1, max: 2, step: 1, twigs: true, ...TW('orders') },
  { key: 'tDroop', label: 'twig droop', group: 'crown', min: 0, max: 1, step: 0.01, twigs: true, ...TW('droop') },
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
    key: 'winterLeaves',
    label: 'winter leaves',
    group: 'epiphytes',
    min: 0,
    max: 0.5,
    step: 0.01,
    woody: true,
    get: (sp) => sp.winterLeaves ?? 0,
    set: (sp, v) => {
      sp.winterLeaves = v;
    },
  },
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
    crown: sp.crown ? { ...sp.crown } : undefined,
    colonize: sp.colonize ? { ...sp.colonize } : undefined,
    twigs: sp.twigs ? { ...sp.twigs } : undefined,
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
