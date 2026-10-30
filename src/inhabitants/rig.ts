// The body generator (round 117, docs/INHABITANTS.md): a species' body plan and parameters → a rig, the skeleton the
// GPU animates and meshes. Pure and deterministic from the spec (unit-tested: rig.test.ts).
//
// A rig is points and segments.
// - Points are ordered parents first. Each has a ROLE that says how the animation kernel (inhabitants.wgsl animate)
//   moves it, a parent, a rest offset in its parent's frame (x forward, y left, z up) and four role parameters.
//   The roles are the Rain World recipe: a body whose root the behaviour moves, a spine that FOLLOWS it (follow the
//   leader: a turn bends the body), feet PLANTED on the ground that step when they fall too far behind, knees and
//   elbows solved by two-bone IK, and soft parts (tails, capes, fur, antennae) as verlet CHAINS that lag, swing and
//   blow in the world's wind. Nothing is keyframed.
// - Segments are what's drawn: a bone (a low-poly spindle between two points, a radius at each end) or a triangle
//   (cape cloth, wing membrane) between three. Each has a colour.
//
// Why points and roles rather than a skinned mesh: the GPU moves ~20 points a creature and writes a few hundred
// flat-shaded triangles from them; no rig weights, no authored meshes, one code path for every plan. Low-poly
// spindles read as limbs at the game's zooms (a phone at q=low shows a deer as ~20 px) where voxels at that size
// would be 2-3 blocks and lose the gait. See DEVLOG round 117 (inhabitants) for the measurements.

import type { BodyPlan, Gear, Palette, SpeciesSpec } from '../api/contracts/inhabitants';

/** how the animation kernel moves a point (mirrored in inhabitants.wgsl ROLE_*) */
export const enum Role {
  /** the body's root: where the behaviour puts it, `p.x` above the ground (p: [height, slither amplitude (serpents), -, -]) */
  Root = 0,
  /** follows its parent at |rest| (p: [height above ground, ground pull 0..1, -, -]) */
  Spine = 1,
  /** rigid in its parent's frame (p: [lean with speed (rad at full run), -, -, -]) */
  Rigid = 2,
  /** planted on the ground; steps when it falls behind (p: [gait group, lead (× stride), -, -]) */
  Foot = 3,
  /** two-bone IK between its parent and point p.x (p: [end point, upper length, lower length, pole: +1 fwd, -1 back, 0 up]) */
  Knee = 4,
  /** verlet: lags, swings, blows in the wind (p: [stiffness 0..1, gravity (cells/s²), wind response 0..1, damping 0..1]) */
  Chain = 5,
  /** flaps about its parent's forward axis while flying, folds when grounded (p: [amplitude rad, phase lag, -, -]) */
  Wing = 6,
  /** swings about its parent's left axis with the gait (arms, p: [amplitude rad, phase offset, -, -]) */
  Swing = 7,
  /** rigid, but dips to graze and lowers to stalk (p: [graze drop (cells), -, -, -]) */
  Head = 8,
}

export const MAX_POINTS = 32;
export const MAX_SEGS = 48;
/** a bone: a spindle of two square rings and two tips, 16 triangles */
export const BONE_VERTS = 48;
/** a bone at the far LOD (system.ts lod 1): a ring and two tips, 8 triangles */
export const BONE_VERTS_FAR = 24;
export const TRI_VERTS = 3;
/** a dark footprint on the ground under each creature (two triangles): contrast on grass, and a bird's place in the air */
export const SHADOW_VERTS = 6;

export interface RigPoint {
  role: Role;
  parent: number;
  rest: [number, number, number];
  p: [number, number, number, number];
  name: string;
}

export interface RigSegment {
  kind: 'bone' | 'tri';
  a: number;
  b: number;
  c: number;
  ra: number;
  rb: number;
  /** 0xrrggbb */
  colour: number;
}

export interface Rig {
  plan: BodyPlan;
  points: RigPoint[];
  segments: RigSegment[];
  /** the root's height over the ground standing (cells) */
  height: number;
  /** a step's length (cells) */
  stride: number;
  /** a step's time at a walk (s) */
  stepTime: number;
  /** how high a foot lifts (cells) */
  lift: number;
  /** a body radius others keep clear of (cells) */
  radius: number;
  /** the body's length nose to tail (cells) */
  length: number;
  /** flies (birds; dragons take off) */
  flies: boolean;
  vertsPerAgent: number;
}

/** '#rrggbb' → 0xrrggbb (throws on anything else: a bad colour is a spec's bug) */
export function hex(c: string): number {
  if (!/^#[0-9a-fA-F]{6}$/.test(c)) throw new Error(`inhabitants: colour "${c}" is not #rrggbb`);
  return parseInt(c.slice(1), 16);
}

/** a colour scaled (a shade darker or lighter) */
export function shade(c: number, k: number): number {
  const ch = (s: number) => Math.max(0, Math.min(255, Math.round(((c >> s) & 255) * k)));
  return (ch(16) << 16) | (ch(8) << 8) | ch(0);
}

/** deterministic 0..1 from a seed and a salt */
export function rand01(seed: number, salt: number): number {
  let h = (Math.imul(seed | 0, 0x9e3779b1) ^ Math.imul(salt + 0x632be5ab, 0x85ebca77)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0;
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39) >>> 0;
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}

class Builder {
  points: RigPoint[] = [];
  segments: RigSegment[] = [];
  point(name: string, role: Role, parent: number, rest: [number, number, number], p: [number, number, number, number] = [0, 0, 0, 0]): number {
    if (this.points.length >= MAX_POINTS) throw new Error(`inhabitants: rig "${name}" past ${MAX_POINTS} points`);
    if (parent >= this.points.length) throw new Error(`inhabitants: point "${name}"'s parent ${parent} comes after it`);
    this.points.push({ name, role, parent, rest, p });
    return this.points.length - 1;
  }
  bone(a: number, b: number, ra: number, rb: number, colour: number): void {
    this.segments.push({ kind: 'bone', a, b, c: -1, ra, rb, colour });
  }
  tri(a: number, b: number, c: number, colour: number): void {
    this.segments.push({ kind: 'tri', a, b, c, ra: 0, rb: 0, colour });
  }
}

interface Ctx {
  spec: SpeciesSpec;
  S: number;
  pr: Required<Omit<NonNullable<SpeciesSpec['proportions']>, 'size' | 'segments'>> & { segments: number };
  col: { body: number; belly: number; accent: number; eye: number; fur: number };
  rnd: (salt: number) => number;
}

const PLAN_SIZE: Record<BodyPlan, number> = { biped: 0.9, quadruped: 1.1, bird: 0.35, serpent: 0.28, insect: 0.35, beast: 1.3, winged: 2.4 };

/** a leg: hip on `anchor` at side s, a foot and a knee; returns [hip, knee, foot] */
function leg(b: Builder, name: string, anchor: number, hipAt: [number, number, number], len: number, group: number, pole: number, lead: number, r0: number, r1: number, colour: number, footColour: number): [number, number, number] {
  const hip = b.point(`${name}.hip`, Role.Rigid, anchor, hipAt);
  const foot = b.point(`${name}.foot`, Role.Foot, hip, [0, 0, -len], [group, lead, 0, 0]);
  const knee = b.point(`${name}.knee`, Role.Knee, hip, [0, 0, -len / 2], [foot, len * 0.52, len * 0.52, pole]);
  b.bone(hip, knee, r0, r0 * 0.7, colour);
  b.bone(knee, foot, r0 * 0.6, r1, footColour);
  return [hip, knee, foot];
}

/** a chain of n links from `from`, each `rest` from the last */
function chain(b: Builder, name: string, from: number, n: number, rest: [number, number, number], p: [number, number, number, number], r0: number, r1: number, colour: number): number[] {
  const out: number[] = [];
  let last = from;
  for (let i = 0; i < n; i++) {
    const q = b.point(`${name}${i}`, Role.Chain, last, rest, p);
    const t0 = i / n;
    const t1 = (i + 1) / n;
    b.bone(last, q, r0 + (r1 - r0) * t0, r0 + (r1 - r0) * t1, colour);
    out.push(q);
    last = q;
  }
  return out;
}

/** fur: tufts along the back from point `a` toward `b` (rest offsets in `a`'s frame), swaying chains */
function fur(b: Builder, ctx: Ctx, on: number, along: number, up: number, n: number, len: number): void {
  for (let i = 0; i < n; i++) {
    const f = -along * (i + 0.5) / n;
    const base = b.point(`fur${i}.base`, Role.Rigid, on, [f, 0, up]);
    const tip = b.point(`fur${i}`, Role.Chain, base, [-len * 0.5, 0, len], [0.35, 6, 0.9, 0.12]);
    b.bone(base, tip, len * 0.35, len * 0.06, ctx.col.fur);
  }
}

function eyes(b: Builder, ctx: Ctx, head: number, fwd: number, side: number, up: number, r: number): void {
  for (const s of [1, -1]) {
    const e = b.point(`eye${s > 0 ? 'L' : 'R'}`, Role.Rigid, head, [fwd, s * side, up]);
    b.bone(head, e, r * 0.3, r, ctx.col.eye);
  }
}

function gearOf(spec: SpeciesSpec, slot: Gear['slot']): Gear | undefined {
  return spec.gear?.find((g) => g.slot === slot);
}

function quadruped(b: Builder, ctx: Ctx, heavy: boolean): { height: number; stride: number; length: number; radius: number; chest: number; hips: number; head: number } {
  const { S, pr, col } = ctx;
  const L = S * 0.82 * pr.legs;
  const B = S * 1.05 * pr.body * (heavy ? 0.95 : 1);
  const r = S * 0.27 * pr.girth * (heavy ? 1.45 : 1);
  const height = L + r * 0.25;
  const chest = b.point('chest', Role.Root, -1, [0, 0, 0], [height, 0, 0, 0]);
  const hips = b.point('hips', Role.Spine, chest, [-B, 0, 0], [height - (heavy ? r * 0.35 : 0), 0.6, 0, 0]);
  const neck = b.point('neck', Role.Rigid, chest, [r * 0.7, 0, r * 0.45], [0.25, 0, 0, 0]);
  const nk = S * 0.55 * pr.neck * (heavy ? 0.6 : 1);
  const head = b.point('head', Role.Head, neck, heavy ? [nk * 0.8, 0, nk * 0.1] : [nk * 0.55, 0, nk * 0.8], [heavy ? 0.15 : nk * 0.9, 0, 0, 0]);
  const hd = S * 0.32 * pr.head * (heavy ? 1.3 : 1);
  const snout = b.point('snout', Role.Rigid, head, [hd, 0, -hd * 0.25]);
  b.bone(chest, hips, r, r * 0.82, col.body);
  if (heavy) {
    // a hump over the forequarters
    const hump = b.point('hump', Role.Rigid, chest, [-B * 0.2, 0, r * 0.55]);
    b.bone(chest, hump, r * 0.85, r * 0.7, shade(col.body, 0.85));
  }
  b.bone(chest, neck, r * 0.7, r * 0.5, col.body);
  b.bone(neck, head, r * 0.45, hd * 0.42, col.body);
  b.bone(head, snout, hd * 0.42, hd * 0.2, col.belly);
  eyes(b, ctx, head, hd * 0.3, hd * 0.3, hd * 0.22, hd * 0.12);
  // ears or horns
  for (const s of [1, -1]) {
    const tip = b.point(`ear${s > 0 ? 'L' : 'R'}`, Role.Rigid, head, heavy ? [hd * 0.1, s * hd * 0.5, hd * 0.25] : [-hd * 0.3, s * hd * 0.5, hd * 0.75]);
    b.bone(head, tip, hd * 0.14, hd * 0.03, col.accent);
  }
  const lr = r * (heavy ? 0.42 : 0.34);
  const hipZ = -r * 0.3;
  const fl = heavy ? 1.08 : 1;
  leg(b, 'fl', chest, [0, r * 0.62, hipZ], L * fl, 0, 1, 0.55, lr, lr * 0.45, col.body, col.accent);
  leg(b, 'fr', chest, [0, -r * 0.62, hipZ], L * fl, 1, 1, 0.55, lr, lr * 0.45, col.body, col.accent);
  leg(b, 'bl', hips, [0, r * 0.6, hipZ], L, 1, -1, 0.55, lr * 1.1, lr * 0.45, col.body, col.accent);
  leg(b, 'br', hips, [0, -r * 0.6, hipZ], L, 0, -1, 0.55, lr * 1.1, lr * 0.45, col.body, col.accent);
  const tl = S * 0.35 * pr.tail;
  if (tl > 0.02) {
    const flex = ctx.spec.secondary?.tailFlex ?? (heavy ? 0.3 : 0.5);
    chain(b, 'tail', hips, heavy ? 2 : 3, [-tl / (heavy ? 2 : 3), 0, tl * 0.1], [0.5 - flex * 0.4, 8, 0.6, 0.1], r * 0.28, r * 0.08, col.body);
  }
  const furAmt = ctx.spec.secondary?.fur ?? (heavy ? 1 : 0);
  if (furAmt > 0) fur(b, ctx, chest, B * 0.7, r * 0.85, Math.max(1, Math.round(3 * furAmt)), S * 0.28 * Math.sqrt(furAmt) * (heavy ? 1.3 : 1));
  return { height, stride: L * 0.85, length: B + nk + hd + tl, radius: r * 1.4, chest, hips, head };
}

function biped(b: Builder, ctx: Ctx): { height: number; stride: number; length: number; radius: number } {
  const { S, pr, col, spec } = ctx;
  const L = S * pr.legs;
  const height = L * 0.97;
  const torso = S * 0.55 * pr.body;
  const r = S * 0.19 * pr.girth;
  const pelvis = b.point('pelvis', Role.Root, -1, [0, 0, 0], [height, 0, 0, 0]);
  const chest = b.point('chest', Role.Rigid, pelvis, [0, 0, torso], [0.35, 0, 0, 0]);
  const hd = S * 0.15 * pr.head;
  const head = b.point('head', Role.Head, chest, [0.02, 0, hd * 1.4], [0.05, 0, 0, 0]);
  const crown = b.point('crown', Role.Rigid, head, [0.01, 0, hd * 1.5]);
  b.bone(pelvis, chest, r * 0.9, r * 1.1, col.body);
  const hood = gearOf(spec, 'hood');
  b.bone(head, crown, hd, hd * 0.85, hood ? hex(hood.colour) : col.belly);
  eyes(b, ctx, head, hd * 0.75, hd * 0.4, hd * 0.7, hd * 0.2);
  const arm = L * 0.82;
  const shoulders: number[] = [];
  const hands: number[] = [];
  for (const s of [1, -1]) {
    const sh = b.point(`shoulder${s > 0 ? 'L' : 'R'}`, Role.Rigid, chest, [-0.02, s * r * 1.25, -0.02]);
    const hand = b.point(`hand${s > 0 ? 'L' : 'R'}`, Role.Swing, sh, [0.05, s * 0.04, -arm], [0.55, s > 0 ? Math.PI : 0, 0, 0]);
    const elbow = b.point(`elbow${s > 0 ? 'L' : 'R'}`, Role.Knee, sh, [0, 0, -arm / 2], [hand, arm * 0.52, arm * 0.52, -1]);
    b.bone(sh, elbow, r * 0.42, r * 0.34, col.body);
    b.bone(elbow, hand, r * 0.32, r * 0.26, col.belly);
    shoulders.push(sh);
    hands.push(hand);
  }
  leg(b, 'l', pelvis, [0, r * 0.6, -0.02], L, 0, 1, 0.5, r * 0.5, r * 0.32, shade(col.body, 0.75), col.accent);
  leg(b, 'r', pelvis, [0, -r * 0.6, -0.02], L, 1, 1, 0.5, r * 0.5, r * 0.32, shade(col.body, 0.75), col.accent);
  const cape = gearOf(spec, 'cape');
  if (cape) {
    // two strands of three links from the shoulders: cloth between them (triangles), each link verlet
    const len = cape.size ?? S * 1.25;
    const cc = hex(cape.colour);
    const strand = (s: number) => {
      const o: number[] = [shoulders[s > 0 ? 0 : 1]];
      for (let i = 0; i < 3; i++) o.push(b.point(`cape${s > 0 ? 'L' : 'R'}${i}`, Role.Chain, o[i], [-0.05, s * 0.03, -len / 3], [0.12, 14, 1, 0.06]));
      return o;
    };
    const L1 = strand(1);
    const R1 = strand(-1);
    for (let i = 0; i < 3; i++) {
      b.tri(L1[i], R1[i], L1[i + 1], cc);
      b.tri(R1[i], R1[i + 1], L1[i + 1], shade(cc, 0.85));
    }
  }
  const pack = gearOf(spec, 'pack');
  if (pack) {
    const p0 = b.point('pack0', Role.Rigid, chest, [-r * 1.1, 0, -torso * 0.1]);
    const p1 = b.point('pack1', Role.Rigid, chest, [-r * 1.2, 0, -torso * 0.65]);
    b.bone(p0, p1, r * 0.75, r * 0.85, hex(pack.colour));
  }
  const weapon = gearOf(spec, 'weapon');
  if (weapon) {
    const tip = b.point('weapon', Role.Rigid, hands[1], [(weapon.size ?? S * 0.9) * 0.6, 0, (weapon.size ?? S * 0.9) * 0.8]);
    b.bone(hands[1], tip, r * 0.12, r * 0.06, hex(weapon.colour));
  }
  const shield = gearOf(spec, 'shield');
  if (shield) {
    const s1 = b.point('shield', Role.Rigid, hands[0], [0.12, 0.08, 0.15]);
    b.bone(hands[0], s1, r * 1.0, r * 1.0, hex(shield.colour));
  }
  return { height, stride: L * 0.75, length: r * 2, radius: r * 1.8 };
}

function bird(b: Builder, ctx: Ctx): { height: number; stride: number; length: number; radius: number } {
  const { S, pr, col } = ctx;
  const L = S * 0.6 * pr.legs;
  const r = S * 0.45 * pr.girth;
  const height = L + r * 0.6;
  const body = b.point('body', Role.Root, -1, [0, 0, 0], [height, 0, 0, 0]);
  const rump = b.point('rump', Role.Spine, body, [-r * 1.8 * pr.body, 0, 0], [height, 0.2, 0, 0]);
  const hd = r * 0.7 * pr.head;
  const head = b.point('head', Role.Head, body, [r * 1.2, 0, r * 0.9 * pr.neck], [0.15, 0, 0, 0]);
  const beak = b.point('beak', Role.Rigid, head, [hd * 1.4, 0, -hd * 0.2]);
  b.bone(body, rump, r, r * 0.6, col.body);
  b.bone(body, head, r * 0.5, hd, col.body);
  b.bone(head, beak, hd * 0.4, hd * 0.05, col.accent);
  eyes(b, ctx, head, hd * 0.6, hd * 0.55, hd * 0.35, hd * 0.25);
  const span = S * 2.2 * pr.wings;
  for (const s of [1, -1]) {
    const sh = b.point(`shoulder${s > 0 ? 'L' : 'R'}`, Role.Rigid, body, [r * 0.3, s * r * 0.6, r * 0.4]);
    const el = b.point(`elbow${s > 0 ? 'L' : 'R'}`, Role.Wing, sh, [-r * 0.1, s * span * 0.22, 0], [0.9, 0, 0, 0]);
    const tip = b.point(`wtip${s > 0 ? 'L' : 'R'}`, Role.Wing, sh, [-r * 0.9, s * span * 0.5, 0], [1.1, 0.5, 0, 0]);
    const trail = b.point(`wtrail${s > 0 ? 'L' : 'R'}`, Role.Wing, sh, [-r * 1.6, s * span * 0.2, 0], [0.8, 0.3, 0, 0]);
    b.bone(sh, el, r * 0.25, r * 0.15, col.body);
    b.tri(sh, el, trail, shade(col.body, 0.92));
    b.tri(el, tip, trail, col.accent === col.body ? shade(col.body, 0.8) : shade(col.belly, 0.95));
  }
  const tail = b.point('tail', Role.Chain, rump, [-r * 1.4 * pr.tail, 0, r * 0.2], [0.7, 2, 0.3, 0.2]);
  for (const s of [1, -1]) {
    const tl = b.point(`tail${s}`, Role.Rigid, rump, [-r * 1.3 * pr.tail, s * r * 0.5, r * 0.15]);
    b.tri(rump, tail, tl, shade(col.body, 0.85));
  }
  leg(b, 'l', body, [0, r * 0.35, -r * 0.5], L, 0, 1, 0.4, r * 0.12, r * 0.08, col.accent, col.accent);
  leg(b, 'r', body, [0, -r * 0.35, -r * 0.5], L, 1, 1, 0.4, r * 0.12, r * 0.08, col.accent, col.accent);
  return { height, stride: L * 0.8, length: r * 4, radius: span * 0.3 };
}

function serpent(b: Builder, ctx: Ctx): { height: number; stride: number; length: number; radius: number } {
  const { S, pr, col } = ctx;
  const n = Math.max(4, Math.min(20, Math.round(pr.segments)));
  const r = S * pr.girth;
  const len = S * 1.1 * pr.body;
  const head = b.point('head', Role.Root, -1, [0, 0, 0], [r * 0.9, r * 2.2, 0, 0]);
  let last = head;
  for (let i = 0; i < n; i++) {
    const t = (i + 1) / n;
    const q = b.point(`spine${i}`, Role.Spine, last, [-len, 0, 0], [r * (1 - 0.7 * t), 1, 0, 0]);
    const ra = r * (1 - 0.7 * (i / n));
    b.bone(last, q, ra, r * (1 - 0.7 * t), i % 2 ? col.body : col.accent);
    last = q;
  }
  const hd = r * 1.3 * pr.head;
  const snout = b.point('snout', Role.Rigid, head, [hd * 1.6, 0, 0]);
  b.bone(head, snout, hd, hd * 0.45, col.body);
  eyes(b, ctx, head, hd * 0.7, hd * 0.6, hd * 0.5, hd * 0.28);
  // a forked tongue flicks: a chain off the snout
  const tongue = b.point('tongue', Role.Chain, snout, [hd * 0.8, 0, 0], [0.6, 0, 0, 0.3]);
  b.bone(snout, tongue, hd * 0.08, hd * 0.03, 0xd04050);
  return { height: r, stride: len, length: len * n + hd * 2, radius: r * 1.5 };
}

function insect(b: Builder, ctx: Ctx): { height: number; stride: number; length: number; radius: number } {
  const { S, pr, col } = ctx;
  const r = S * 0.5 * pr.girth;
  const L = S * 1.2 * pr.legs;
  const height = r * 1.1 + L * 0.2;
  const thorax = b.point('thorax', Role.Root, -1, [0, 0, 0], [height, 0, 0, 0]);
  const hd = r * 0.7 * pr.head;
  const head = b.point('head', Role.Head, thorax, [r * 1.1, 0, 0.02], [0.03, 0, 0, 0]);
  const segs = Math.max(1, Math.min(4, Math.round(pr.segments)));
  let last = thorax;
  for (let i = 0; i < segs; i++) {
    const q = b.point(`abdomen${i}`, Role.Spine, last, [-r * 1.3 * pr.body, 0, 0], [height + r * 0.1, 0.4, 0, 0]);
    b.bone(last, q, r * (i === 0 ? 0.9 : 1.1), r * (i === segs - 1 ? 0.5 : 1.2), i % 2 ? col.accent : col.body);
    last = q;
  }
  b.bone(thorax, head, r * 0.8, hd, col.body);
  eyes(b, ctx, head, hd * 0.5, hd * 0.6, hd * 0.3, hd * 0.3);
  for (const s of [1, -1]) chain(b, `antenna${s > 0 ? 'L' : 'R'}`, head, 2, [hd * 0.7, s * hd * 0.5, hd * 0.6], [0.6, 0, 0.5, 0.2], hd * 0.07, hd * 0.03, col.accent);
  // a tripod gait: L1 R2 L3 one group, R1 L2 R3 the other; knees up
  for (let i = 0; i < 3; i++)
    for (const s of [1, -1]) {
      const g = (i + (s > 0 ? 0 : 1)) % 2;
      const [hip] = [b.point(`leg${i}${s}.hip`, Role.Rigid, thorax, [r * (0.5 - 0.5 * i), s * r * 0.7, -r * 0.2])];
      const foot = b.point(`leg${i}${s}.foot`, Role.Foot, hip, [r * (0.6 - 0.6 * i), s * L * 0.7, -height], [g, 0.45, 0, 0]);
      const knee = b.point(`leg${i}${s}.knee`, Role.Knee, hip, [0, s * L * 0.3, r], [foot, L * 0.5, L * 0.75, 0]);
      b.bone(hip, knee, r * 0.18, r * 0.12, col.accent);
      b.bone(knee, foot, r * 0.12, r * 0.05, col.accent);
    }
  return { height, stride: L * 0.55, length: r * (2 + 1.3 * segs), radius: L };
}

function winged(b: Builder, ctx: Ctx): { height: number; stride: number; length: number; radius: number } {
  const { S, pr, col } = ctx;
  const L = S * 0.7 * pr.legs;
  const B = S * 0.95 * pr.body;
  const r = S * 0.32 * pr.girth;
  const height = L + r * 0.2;
  const chest = b.point('chest', Role.Root, -1, [0, 0, 0], [height, 0, 0, 0]);
  const hips = b.point('hips', Role.Spine, chest, [-B, 0, 0], [height * 0.95, 0.6, 0, 0]);
  b.bone(chest, hips, r, r * 0.85, col.body);
  // a long neck as a stiff chain: it lags a turn and sways
  const nk = S * 0.45 * pr.neck;
  const n1 = b.point('neck0', Role.Chain, chest, [nk * 0.7, 0, nk * 0.5], [0.55, 0, 0.1, 0.2]);
  const n2 = b.point('neck1', Role.Chain, n1, [nk * 0.6, 0, nk * 0.55], [0.55, 0, 0.1, 0.2]);
  const hd = S * 0.3 * pr.head;
  const head = b.point('head', Role.Head, n2, [hd * 0.4, 0, 0.05], [0.1, 0, 0, 0]);
  const snout = b.point('snout', Role.Rigid, head, [hd * 1.1, 0, -hd * 0.2]);
  b.bone(chest, n1, r * 0.6, r * 0.45, col.body);
  b.bone(n1, n2, r * 0.45, r * 0.38, col.body);
  b.bone(n2, head, r * 0.38, hd * 0.5, col.body);
  b.bone(head, snout, hd * 0.5, hd * 0.25, col.belly);
  eyes(b, ctx, head, hd * 0.35, hd * 0.35, hd * 0.3, hd * 0.12);
  for (const s of [1, -1]) {
    const h = b.point(`horn${s > 0 ? 'L' : 'R'}`, Role.Rigid, head, [-hd * 0.6, s * hd * 0.35, hd * 0.6]);
    b.bone(head, h, hd * 0.14, hd * 0.02, col.accent);
  }
  const lr = r * 0.4;
  leg(b, 'fl', chest, [0, r * 0.6, -r * 0.3], L, 0, 1, 0.5, lr, lr * 0.5, col.body, col.accent);
  leg(b, 'fr', chest, [0, -r * 0.6, -r * 0.3], L, 1, 1, 0.5, lr, lr * 0.5, col.body, col.accent);
  leg(b, 'bl', hips, [0, r * 0.6, -r * 0.3], L, 1, -1, 0.5, lr * 1.15, lr * 0.5, col.body, col.accent);
  leg(b, 'br', hips, [0, -r * 0.6, -r * 0.3], L, 0, -1, 0.5, lr * 1.15, lr * 0.5, col.body, col.accent);
  const span = S * 2.6 * pr.wings;
  for (const s of [1, -1]) {
    const sh = b.point(`wing${s > 0 ? 'L' : 'R'}`, Role.Rigid, chest, [-r * 0.2, s * r * 0.7, r * 0.6]);
    const el = b.point(`welbow${s > 0 ? 'L' : 'R'}`, Role.Wing, sh, [r * 0.3, s * span * 0.25, span * 0.12], [0.7, 0, 0, 0]);
    const tip = b.point(`wtip${s > 0 ? 'L' : 'R'}`, Role.Wing, sh, [-B * 0.5, s * span * 0.55, span * 0.05], [0.9, 0.45, 0, 0]);
    b.bone(sh, el, r * 0.2, r * 0.12, col.accent);
    b.bone(el, tip, r * 0.12, r * 0.04, col.accent);
    b.tri(sh, el, tip, shade(col.belly, 0.9));
    b.tri(sh, tip, hips, shade(col.belly, 0.75));
  }
  const tl = S * 0.5 * pr.tail;
  chain(b, 'tail', hips, 3, [-tl / 3, 0, 0], [0.35, 6, 0.4, 0.1], r * 0.45, r * 0.08, col.body);
  return { height, stride: L * 0.8, length: B + nk * 1.3 + hd + tl, radius: span * 0.4 };
}

/** The rig for a species: its plan's skeleton, sized and coloured by its parameters. */
export function buildRig(spec: SpeciesSpec): Rig {
  const p = spec.proportions ?? {};
  const seed = spec.seed ?? 1;
  const rnd = (salt: number) => rand01(seed, salt);
  // (a seed varies a body a little: ±6% per proportion, so a species' seeds read as kin, not clones)
  const v = (k: number | undefined, salt: number) => (k ?? 1) * (0.94 + 0.12 * rnd(salt));
  const S = p.size ?? PLAN_SIZE[spec.plan];
  if (!(S > 0)) throw new Error(`inhabitants: species "${spec.id}" size ${S}`);
  const pal: Palette = spec.palette;
  const body = hex(pal.body);
  const ctx: Ctx = {
    spec,
    S,
    pr: {
      legs: v(p.legs, 1),
      body: v(p.body, 2),
      girth: v(p.girth, 3),
      neck: v(p.neck, 4),
      head: v(p.head, 5),
      tail: v(p.tail, 6),
      wings: v(p.wings, 7),
      segments: p.segments ?? (spec.plan === 'serpent' ? 12 : 2),
    },
    col: {
      body,
      belly: pal.belly ? hex(pal.belly) : shade(body, 1.25),
      accent: pal.accent ? hex(pal.accent) : shade(body, 0.6),
      eye: pal.eye ? hex(pal.eye) : 0x101010,
      fur: spec.secondary?.fur_colour ? hex(spec.secondary.fur_colour) : shade(body, 0.7),
    },
    rnd,
  };
  const b = new Builder();
  let m: { height: number; stride: number; length: number; radius: number };
  switch (spec.plan) {
    case 'quadruped':
      m = quadruped(b, ctx, false);
      break;
    case 'beast':
      m = quadruped(b, ctx, true);
      break;
    case 'biped':
      m = biped(b, ctx);
      break;
    case 'bird':
      m = bird(b, ctx);
      break;
    case 'serpent':
      m = serpent(b, ctx);
      break;
    case 'insect':
      m = insect(b, ctx);
      break;
    case 'winged':
      m = winged(b, ctx);
      break;
  }
  if (b.segments.length > MAX_SEGS) throw new Error(`inhabitants: species "${spec.id}" has ${b.segments.length} segments (max ${MAX_SEGS})`);
  const verts = SHADOW_VERTS + b.segments.reduce((a, s) => a + (s.kind === 'bone' ? BONE_VERTS : TRI_VERTS), 0);
  const walkStep = spec.plan === 'insect' ? 0.16 : spec.plan === 'bird' ? 0.14 : 0.3 * Math.sqrt(S);
  return {
    plan: spec.plan,
    points: b.points,
    segments: b.segments,
    height: m.height,
    stride: m.stride,
    stepTime: walkStep,
    lift: Math.max(0.05, m.stride * 0.25),
    radius: m.radius,
    length: m.length,
    flies: spec.plan === 'bird' || spec.plan === 'winged',
    vertsPerAgent: verts,
  };
}
