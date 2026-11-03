// The generator's steerable parameters (round 128, treegen): one table, read by the flora viewer's sliders and its
// URL, applied to a species as an edited copy. The user: "parameters for taper, branching distance and angle plus
// variance, whether we twist branches as we go, ... knots and direction changes", "Bark color and texture
// parameters". Pure (no DOM), so it is tested.

import { NO_EPIPHYTES, SPECIES, type SpeciesDef, type SpeciesId } from './species';
import { GRASS_TYPES, SHRUB_FORMS, type GrassLook } from './forms';

export interface Param {
  /** the URL key (p.<key>) and the slider's id */
  key: string;
  label: string;
  group: 'shape' | 'stem' | 'crown' | 'twigs' | 'bark' | 'epiphytes' | 'grass';
  /** (round 128) a one-line hint in plain words (the editor shows it on tap) */
  hint?: string;
  min: number;
  max: number;
  step: number;
  /** woody plants only (needs a turtle / a stem look) */
  woody?: boolean;
  /** (round 128) broadleaf crowns only (needs a crown look) */
  crown?: boolean;
  /** (round 128) plants with fine twigs only */
  twigs?: boolean;
  /** (round 128) a choice, not a number: its options' names (the editor shows a list; value = min + index) */
  options?: string[];
  /** (round 128) colonized crowns only (colonize.ts) */
  shape?: boolean;
  /** (round 128) shown only where this holds (a shrub's kinds, a grass's blades) */
  when?: (sp: SpeciesDef) => boolean;
  get(sp: SpeciesDef): number;
  set(sp: SpeciesDef, v: number): void;
}

const G = (k: keyof GrassLook) => ({
  when: (sp: SpeciesDef) => !!sp.grass,
  get: (sp: SpeciesDef) => sp.grass?.[k] ?? 0,
  set: (sp: SpeciesDef, v: number) => {
    if (sp.grass) sp.grass[k] = v;
  },
});
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
  // (round 128: a shrub's kind and a grass's clump type — forms.ts; "by the seed" the library's mix)
  { key: 'kind', label: 'kind of shrub', hint: 'the shape the thicket grows in; "by the seed": each new seed picks one', options: ['by the seed', ...SHRUB_FORMS], group: 'shape', min: -1, max: SHRUB_FORMS.length - 1, step: 1, when: (sp) => sp.form === 'shrub', get: (sp) => sp.kind ?? -1, set: (sp, v) => { sp.kind = Math.round(v); } },
  { key: 'gKind', label: 'clump type', hint: 'how the blades stand: arching, upright tuft, or with seed heads', options: ['by the seed', ...GRASS_TYPES], group: 'grass', min: -1, max: GRASS_TYPES.length - 1, step: 1, when: (sp) => sp.form === 'grass', get: (sp) => sp.kind ?? -1, set: (sp, v) => { sp.kind = Math.round(v); } },
  { key: 'gBlades', label: 'blades', hint: 'blades in a clump (the close-up has more)', group: 'grass', min: 3, max: 40, step: 1, ...G('blades') },
  { key: 'gSpread', label: 'clump width', hint: 'how wide the clump\'s foot is, in cells', group: 'grass', min: 0.1, max: 1.5, step: 0.01, ...G('spread') },
  { key: 'gLean', label: 'lean', hint: 'how far the blades lean out from the foot', group: 'grass', min: 0, max: 1, step: 0.01, ...G('lean') },
  { key: 'gArch', label: 'arch', hint: 'how much each blade curves over toward its tip', group: 'grass', min: 0, max: 1.5, step: 0.01, ...G('arch') },
  { key: 'gWidth', label: 'blade width', hint: 'a blade\'s width at its foot, in cells', group: 'grass', min: 0.03, max: 0.4, step: 0.01, ...G('width') },
  { key: 'gSegs', label: 'joints', hint: 'pieces along a blade: more bend more smoothly in the wind', group: 'grass', min: 1, max: 8, step: 1, ...G('segs') },
  { key: 'gHeads', label: 'seed heads', hint: 'the share of blades with a seed head', group: 'grass', min: 0, max: 1, step: 0.01, ...G('heads') },
  { key: 'sCrownBase', label: 'crown starts at', hint: 'how far up the trunk the leaves begin', group: 'shape', min: 0.05, max: 0.8, step: 0.01, shape: true, ...SH('crownBase') },
  { key: 'sWidth', label: 'crown width', hint: 'how wide the crown is against the tree\'s height', group: 'shape', min: 0.05, max: 0.9, step: 0.01, shape: true, ...SH('width') },
  { key: 'sEnvelope', label: 'crown shape', hint: 'the outline the branches grow to fill', options: ['dome', 'cone', 'column', 'umbrella'], group: 'shape', min: 0, max: 3, step: 1, shape: true, get: (sp) => ENVELOPES.indexOf(sp.colonize?.envelope ?? 'dome'), set: (sp, v) => { if (sp.colonize) sp.colonize.envelope = ENVELOPES[Math.round(v)] ?? 'dome'; } },
  { key: 'sPoints', label: 'crown fullness', hint: 'more: a denser, more branched crown', group: 'shape', min: 20, max: 1500, step: 10, shape: true, ...SH('points') },
  { key: 'sStep', label: 'branch length', hint: 'how long each grown piece of branch is: shorter is finer and twistier', group: 'shape', min: 0.2, max: 4, step: 0.05, shape: true, ...SH('step') },
  { key: 'sInfluence', label: 'branch reach', hint: 'how far a branch looks for empty space to grow into', group: 'shape', min: 2, max: 15, step: 0.5, shape: true, ...SH('influence') },
  { key: 'sUpBend', label: 'upward curve', hint: 'how much branches curve up as they grow; below 0 they bend down', group: 'shape', min: -1, max: 1.5, step: 0.01, shape: true, ...SH('upBend') },
  { key: 'sWeep', label: 'weeping', hint: 'how much the outer branches arch over and hang, like a willow', group: 'shape', min: 0, max: 1, step: 0.01, shape: true, ...SH('weep') },
  { key: 'sMaxAngle', label: 'widest branch angle', hint: 'the widest a new branch leaves its parent', group: 'shape', min: 10, max: 90, step: 1, shape: true, ...SH('maxAngle') },
  { key: 'sLeader', label: 'trunk', hint: 'carries on up through the crown (a birch, a pine) or splits into limbs (an oak)', options: ['splits into limbs', 'trunk carries on'], group: 'shape', min: 0, max: 1, step: 1, shape: true, get: (sp) => (sp.colonize?.leader ? 1 : 0), set: (sp, v) => { if (sp.colonize) sp.colonize.leader = v >= 0.5; } },
  { key: 'sForks', label: 'main limbs', hint: 'how many big limbs the trunk splits into', group: 'shape', min: 1, max: 7, step: 1, shape: true, ...SH('forks') },
  { key: 'sTrunk', label: 'trunk thickness', hint: 'the trunk\'s radius at the foot', group: 'shape', min: 0.1, max: 8, step: 0.05, shape: true, ...SH('trunkRadius') },
  { key: 'sThin', label: 'branch slimness', hint: 'how fast branches get thinner toward the tips', group: 'shape', min: 0.3, max: 1, step: 0.01, shape: true, ...SH('thin') },
  { key: 'sStraight', label: 'straightness', hint: 'how much a branch keeps going the way it was', group: 'shape', min: 0, max: 1, step: 0.01, shape: true, ...SH('straight') },
  { key: 'taper', label: 'taper', hint: 'how much a branch thins along its length', group: 'stem', min: 0.7, max: 1, step: 0.005, woody: true, ...T('taper') },
  { key: 'taperVar', label: 'taper variation', hint: 'how much the thinning varies from branch to branch', group: 'stem', min: 0, max: 1, step: 0.01, woody: true, ...T('taperVar') },
  { key: 'spacing', label: 'branch spacing', hint: 'the distance between side branches', group: 'stem', min: 0.5, max: 2, step: 0.01, woody: true, ...T('spacing', 1) },
  { key: 'stepVar', label: 'spacing variation', hint: 'how much that distance varies', group: 'stem', min: 0, max: 0.6, step: 0.01, woody: true, ...T('stepVar') },
  { key: 'angle', label: 'branch angle', hint: 'the angle side branches leave at', group: 'stem', min: 5, max: 70, step: 0.5, woody: true, ...T('angle') },
  { key: 'jitter', label: 'angle variation', hint: 'how much that angle varies', group: 'stem', min: 0, max: 40, step: 0.5, woody: true, ...T('jitter') },
  { key: 'twist', label: 'twist', hint: 'branches spiral as they grow', group: 'stem', min: 0, max: 40, step: 0.5, woody: true, ...T('twist') },
  { key: 'kinkChance', label: 'kinks', hint: 'how often a branch changes direction', group: 'stem', min: 0, max: 0.8, step: 0.01, woody: true, ...T('kinkChance') },
  { key: 'kinkAngle', label: 'kink size', hint: 'how sharply it turns', group: 'stem', min: 0, max: 45, step: 0.5, woody: true, ...T('kinkAngle') },
  { key: 'sides', label: 'roundness', hint: 'sides of the trunk and limbs: more is rounder', group: 'stem', min: 3, max: 12, step: 1, woody: true, ...S('sides') },
  { key: 'noise', label: 'bumpiness', hint: 'how lumpy the trunk and limbs are', group: 'stem', min: 0, max: 0.4, step: 0.005, woody: true, ...S('noise') },
  { key: 'noiseFreq', label: 'bump size', hint: 'small quick bumps or long swells', group: 'stem', min: 0.05, max: 2, step: 0.01, woody: true, ...S('noiseFreq') },
  { key: 'knots', label: 'knots', hint: 'burls and branch scars along the trunk', group: 'stem', min: 0, max: 10, step: 0.1, woody: true, ...S('knots') },
  { key: 'knotSize', label: 'knot size', hint: 'how big the knots are', group: 'stem', min: 0, max: 1, step: 0.01, woody: true, ...S('knotSize') },
  { key: 'ring', label: 'bark rings', hint: 'how finely the trunk is built along its length', group: 'stem', min: 0.2, max: 6, step: 0.05, woody: true, ...S('ring') },
  { key: 'cSize', label: 'leaf size', hint: 'the size of a leaf card', group: 'crown', min: 0.3, max: 8, step: 0.05, crown: true, ...CR('size') },
  { key: 'cPer', label: 'sprays per twig', hint: 'leaf sprays at each twig\'s end', group: 'crown', min: 1, max: 8, step: 1, crown: true, ...CR('perTwig') },
  { key: 'cSpacing', label: 'spray spacing', hint: 'the distance between sprays along a branch', group: 'crown', min: 0, max: 4, step: 0.05, crown: true, ...CR('spacing') },
  { key: 'cFill', label: 'leaf cover', hint: 'how many sprays are kept: lower leaves gaps', group: 'crown', min: 0.1, max: 1, step: 0.01, crown: true, ...CR('fill') },
  { key: 'cLeaves', label: 'leaves per spray', hint: 'cards in each spray', group: 'crown', min: 2, max: 20, step: 1, crown: true, ...CR('leaves') },
  { key: 'cDroop', label: 'leaf droop', hint: 'how much the leaves hang', group: 'crown', min: 0, max: 1, step: 0.01, crown: true, ...CR('droop') },
  { key: 'cStyle', label: 'crown style', hint: 'how the leaves are built', options: ['leaf cards', 'solid lobes', 'lobe-lit cards', 'core and cards', 'layered leaves', 'needle cones', 'needle pads'], group: 'crown', min: 0, max: 6, step: 1, crown: true, get: (sp) => ['sprays', 'solid', 'lobecards', 'hybrid', 'layers', 'cones', 'needlepads'].indexOf(sp.crown?.style ?? 'sprays'), set: (sp, v) => { if (sp.crown) sp.crown.style = (['sprays', 'solid', 'lobecards', 'hybrid', 'layers', 'cones', 'needlepads'] as const)[Math.round(v)] ?? 'sprays'; } },
  { key: 'cSeparate', label: 'lobe separation', hint: 'how far apart the crown\'s clumps stand', group: 'crown', min: 0, max: 1, step: 0.01, crown: true, get: (sp) => sp.crown?.separate ?? 0.25, set: (sp, v) => { if (sp.crown) sp.crown.separate = v; } },
  { key: 'cLobeShape', label: 'clump shape', hint: 'the shape of each leafy clump', options: ['round', 'pad', 'shelf', 'column', 'teardrop'], group: 'crown', min: 0, max: 4, step: 1, crown: true, get: (sp) => ['round', 'pad', 'shelf', 'column', 'tear'].indexOf(sp.crown?.lobeShape ?? 'round'), set: (sp, v) => { if (sp.crown) sp.crown.lobeShape = (['round', 'pad', 'shelf', 'column', 'tear'] as const)[Math.round(v)] ?? 'round'; } },
  { key: 'cLayers', label: 'leaf layers', hint: 'shells of leaves in each clump', group: 'crown', min: 1, max: 5, step: 1, crown: true, get: (sp) => sp.crown?.layers ?? 3, set: (sp, v) => { if (sp.crown) sp.crown.layers = v; } },
  { key: 'cLayerGap', label: 'layer gap', hint: 'the gap between leaf layers, in leaf widths', group: 'crown', min: 0.05, max: 2, step: 0.05, crown: true, get: (sp) => sp.crown?.layerGap ?? 0.35, set: (sp, v) => { if (sp.crown) sp.crown.layerGap = v; } },
  { key: 'cDepthDark', label: 'depth shading', hint: 'how much darker the inner layers are', group: 'crown', min: 0, max: 1, step: 0.01, crown: true, get: (sp) => sp.crown?.depthDark ?? 0.6, set: (sp, v) => { if (sp.crown) sp.crown.depthDark = v; } },
  { key: 'cBend', label: 'leaf curve', hint: 'how much the leaves follow the clump\'s curve', group: 'crown', min: 0, max: 1, step: 0.01, crown: true, get: (sp) => sp.crown?.bend ?? 0.7, set: (sp, v) => { if (sp.crown) sp.crown.bend = v; } },
  { key: 'cCore', label: 'dark core', hint: 'a solid dark mass under the leaves (no see-through holes)', options: ['no', 'yes'], group: 'crown', min: 0, max: 1, step: 1, crown: true, get: (sp) => sp.crown?.core ?? 1, set: (sp, v) => { if (sp.crown) sp.crown.core = v; } },
  { key: 'cShell', label: 'leaf density', hint: 'leaves on each clump\'s surface', group: 'crown', min: 0, max: 2, step: 0.01, crown: true, get: (sp) => sp.crown?.shell ?? 0.35, set: (sp, v) => { if (sp.crown) sp.crown.shell = v; } },
  { key: 'cClump', label: 'clump size', hint: 'how big each leafy clump is', group: 'crown', min: 0.5, max: 16, step: 0.1, crown: true, get: (sp) => sp.crown?.clump ?? 6, set: (sp, v) => { if (sp.crown) sp.crown.clump = v; } },
  { key: 'cGaps', label: 'holes', hint: 'holes punched in solid clumps', group: 'crown', min: 0, max: 0.8, step: 0.01, crown: true, get: (sp) => sp.crown?.gaps ?? 0.05, set: (sp, v) => { if (sp.crown) sp.crown.gaps = v; } },
  { key: 'cLumps', label: 'lumpiness', hint: 'how lumpy each clump is', group: 'crown', min: 0, max: 1, step: 0.01, crown: true, get: (sp) => sp.crown?.lumps ?? 0.3, set: (sp, v) => { if (sp.crown) sp.crown.lumps = v; } },
  { key: 'cBlend', label: 'soft lighting', hint: 'how much the leaves are lit as one round clump', group: 'crown', min: 0, max: 1, step: 0.01, crown: true, get: (sp) => sp.crown?.lobeBlend ?? 0.85, set: (sp, v) => { if (sp.crown) sp.crown.lobeBlend = v; } },
  { key: 'tCount', label: 'twigs', hint: 'fine twigs at each branch tip', group: 'twigs', min: 0, max: 6, step: 1, twigs: true, ...TW('count') },
  { key: 'tAngle', label: 'twig angle', hint: 'the angle twigs leave at', group: 'twigs', min: 5, max: 80, step: 1, twigs: true, ...TW('angle') },
  { key: 'tLength', label: 'twig length', hint: 'how long the twigs are', group: 'twigs', min: 0.2, max: 5, step: 0.05, twigs: true, ...TW('length') },
  { key: 'tFalloff', label: 'twig shrink', hint: 'how much shorter each finer twig is', group: 'twigs', min: 0.2, max: 1, step: 0.01, twigs: true, ...TW('falloff') },
  { key: 'tOrders', label: 'twig levels', hint: 'one or two levels of fine twigs', options: ['one', 'two'], group: 'twigs', min: 1, max: 2, step: 1, twigs: true, ...TW('orders') },
  { key: 'tDroop', label: 'twig droop', hint: 'how much the twigs hang', group: 'twigs', min: 0, max: 1, step: 0.01, twigs: true, ...TW('droop') },
  { key: 'furrows', label: 'furrows', hint: 'long grooves in the bark', group: 'bark', min: 0, max: 1, step: 0.01, ...B('furrows') },
  { key: 'furrowFreq', label: 'furrow count', hint: 'how many grooves round the trunk', group: 'bark', min: 0.5, max: 8, step: 0.1, ...B('furrowFreq') },
  { key: 'plates', label: 'plates', hint: 'bark broken into plates, like a pine\'s', group: 'bark', min: 0, max: 1, step: 0.01, ...B('plates') },
  { key: 'plateSize', label: 'plate size', hint: 'how big the plates are', group: 'bark', min: 0.1, max: 2, step: 0.01, ...B('plateSize') },
  { key: 'stripes', label: 'stripes', hint: 'dark dashes across the bark, like a birch\'s', group: 'bark', min: 0, max: 0.6, step: 0.01, ...B('stripes') },
  { key: 'stripeFreq', label: 'stripe count', hint: 'how many dashes up the trunk', group: 'bark', min: 1, max: 14, step: 0.1, ...B('stripeFreq') },
  { key: 'roughness', label: 'roughness', hint: 'streaks and patches in the bark', group: 'bark', min: 0, max: 1, step: 0.01, ...B('roughness') },
  { key: 'lichen', label: 'lichen', hint: 'pale crusts on the bark', group: 'epiphytes', min: 0, max: 1, step: 0.01, ...E('lichen') },
  { key: 'mossLimbs', label: 'moss', hint: 'moss on the tops of the limbs', group: 'epiphytes', min: 0, max: 1, step: 0.01, ...E('moss') },
  { key: 'plants', label: 'perching plants', hint: 'little ferns in the forks', group: 'epiphytes', min: 0, max: 1, step: 0.01, woody: true, ...E('plants') },
  { key: 'vines', label: 'vines', hint: 'climbers spiralling up the trunk', group: 'epiphytes', min: 0, max: 1, step: 0.01, woody: true, ...E('vines') },
  { key: 'lines', label: 'hanging moss', hint: 'strands hanging from the limbs', group: 'epiphytes', min: 0, max: 1, step: 0.01, woody: true, ...E('lines') },
  {
    key: 'winterLeaves', label: 'winter leaves', hint: 'dead leaves kept through the winter',
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
    key: 'blossom', label: 'blossom', hint: 'flowers in spring',
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
    grass: sp.grass ? { ...sp.grass } : undefined,
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
