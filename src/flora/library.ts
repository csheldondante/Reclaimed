// The plant library (round 117): every species' variants as meshes, made once from seeds, in the instanced mesh
// renderer's kind list (render/meshinst.ts). A kind is one (species, variant); the GPU picks a variant per plant by a
// hash of its column, so a forest of 4 birch variants × turn × lean × scale reads as hundreds of different trees.
//
// Why a fixed library of variants and not a mesh per plant: one indexed draw per kind (instancing) is what keeps a
// dense forest affordable on the phone; per-plant meshes would be a draw (or a compute-built mesh) each. The
// generator is cheap (a few ms for the whole library), so the library could be re-made per biome or per run later.

import { generate } from './generate';
import { hashSeed } from './rng';
import { SPECIES, type RGB, type SpeciesDef, type SpeciesId } from './species';
import type { FloraMesh } from './mesh';

export interface LibraryKind {
  name: string;
  species: SpeciesId;
  variant: number;
  /** level of detail (trees: 0 full, 1 coarse, 2 far — round 119; -1 close-up — round 128); 0 for the rest */
  lod: number;
  mesh: FloraMesh;
  /** meshinst.ts's MeshKind view of it */
  verts: Float32Array;
  index: Uint32Array;
}

export interface LibrarySpec {
  /** species and how many variants of each */
  species: { id: SpeciesId; variants: number }[];
  seed: number;
}

/** What the game draws today (vegplan.wgsl's four tree species, its shrubs, and the meadows' tall grass). */
export const GAME_LIBRARY: LibrarySpec = {
  species: [
    // (round 119, the phone: three variants a tree species — with three levels of detail each that is already 33 kinds,
    // a draw each; a forest's variety comes as much from turn, lean and scale as from the variant)
    { id: 'oak', variants: 3 },
    { id: 'pine', variants: 3 },
    { id: 'birch', variants: 3 },
    { id: 'giant', variants: 2 },
    { id: 'shrub', variants: 2 },
    { id: 'tallgrass', variants: 3 },
    { id: 'flower', variants: 2 },
    { id: 'fern', variants: 2 },
    { id: 'reed', variants: 2 },
    // (round 125, forest: the elder woods' mossy boulders)
    { id: 'boulder', variants: 2 },
  ],
  seed: 117,
};

const v4 = (c: RGB | undefined, w: number) => {
  const x = c ?? [0.8, 0.8, 0.8];
  return `vec4<f32>(${x[0].toFixed(3)}, ${x[1].toFixed(3)}, ${x[2].toFixed(3)}, ${w.toFixed(3)})`;
};

/**
 * The kinds' WGSL tables (the game's library and the viewer's scenes both: one layout). FLORA_COL, 6 vec4s a kind:
 * bark (w deciduous), bark mark (w sway stiffness), leaf dark (w moss at the foot 0..1), leaf light (w the bark's
 * marks: 0 lenticels, 1 ridged), autumn (w the mesh's height), flower/accent (w the mesh's radius; round 125: the
 * wind's lattice spans the plant). FLORA_ACC: the accent a kind (where the flower colour stands in for it: seed heads,
 * cattails).
 */
export function floraTables(kinds: { sp: SpeciesDef; mesh: { height: number; radius: number; verts?: Float32Array }; close?: boolean }[]): string {
  const rows: string[] = [];
  // (round 125, forest) FLORA_CROWN: a tree kind's crown base (local z: the lowest fifth of its leaves) and its bole's
  // radius — under the canopy only the trunk is drawn (the user: "Just the shadows and the trunks"): its wood below the
  // crown base, and above it only within ~1.6 bole radii of the axis (the leader on up; the limbs go). (1e9, 0) for
  // the rest (never cut).
  const crown = kinds.map(({ sp, mesh }): [number, number] => {
    if (sp.form !== 'tree' || !mesh.verts) return [1e9, 0];
    const zs: number[] = [];
    let bole = 0;
    for (let i = 0; i < mesh.verts.length; i += 4) {
      const part = Math.floor(mesh.verts[i + 3] % 16);
      if (part === 4) zs.push(mesh.verts[i + 2]);
      if (part === 3 && mesh.verts[i + 2] < mesh.height * 0.05) bole = Math.max(bole, Math.hypot(mesh.verts[i], mesh.verts[i + 1]));
    }
    if (!zs.length) return [1e9, 0];
    zs.sort((a, b) => a - b);
    return [zs[Math.floor(zs.length * 0.2)], bole];
  });
  for (const { sp, mesh } of kinds) {
    const c = sp.colours;
    rows.push(
      v4(c.bark, c.deciduous ? 1 : 0),
      v4(c.barkMark ?? c.bark, sp.sway),
      v4(c.leafDark, sp.moss ?? 0),
      v4(c.leafLight, sp.bark.furrows > 0.5 ? 1 : 0),
      v4(c.autumn, mesh.height),
      v4(c.flower ?? c.accent, mesh.radius),
    );
  }
  const acc = kinds.map(({ sp }) => v4(sp.colours.accent ?? sp.colours.leafLight, 0));
  // (round 128, treegen) FLORA_BARK, 2 vec4s a kind: the bark's texture (species.ts BarkLook) — (furrows, their
  // frequency, plates, plate size), (stripes, their frequency, roughness, 0)
  const bark = kinds.flatMap(({ sp }) => {
    const k = sp.bark;
    const f = (x: number) => x.toFixed(3);
    return [`vec4<f32>(${f(k.furrows)}, ${f(k.furrowFreq)}, ${f(k.plates)}, ${f(k.plateSize)})`, `vec4<f32>(${f(k.stripes)}, ${f(k.stripeFreq)}, ${f(k.roughness)}, 0.0)`];
  });
  // (round 128) FLORA_EPI, a vec4 a kind: (lichen, moss on the limbs, blossom share, 0) — the epiphytes drawn in the look
  // (w: 1 a close-up kind — the look adds its finer detail, the bark's second octave and the leaves' veins)
  const epi = kinds.map(({ sp, close }) => `vec4<f32>(${(sp.epiphytes?.lichen ?? 0).toFixed(3)}, ${(sp.epiphytes?.moss ?? 0).toFixed(3)}, ${(sp.blossom ?? 0).toFixed(3)}, ${close ? '1.0' : '0.0'})`);
  const crownW = `const FLORA_CROWN = array<vec2<f32>, ${crown.length}>(${crown.map(([z, r]) => `vec2<f32>(${z >= 1e9 ? '1e9' : z.toFixed(3)}, ${r.toFixed(3)})`).join(', ')});`;
  return `${crownW}
const FLORA_COL = array<vec4<f32>, ${rows.length}>(${rows.join(', ')});
const FLORA_ACC = array<vec4<f32>, ${acc.length}>(${acc.join(', ')});
const FLORA_BARK = array<vec4<f32>, ${bark.length}>(${bark.join(', ')});
const FLORA_EPI = array<vec4<f32>, ${epi.length}>(${epi.join(', ')});`;
}

/** (round 128) the species with a close-up level: the trees, the thicket and the tall grass (the LOD ladder's top) */
export function hasClose(id: SpeciesId): boolean {
  const f = SPECIES[id].form;
  return f === 'tree' || f === 'shrub' || f === 'grass';
}

export class FloraLibrary {
  readonly kinds: LibraryKind[] = [];
  /** per species: its first kind and variant count (a tree's full-detail level) */
  readonly ranges = new Map<SpeciesId, { first: number; count: number }>();
  /** (round 119) per tree species: each level of detail's kinds (0 full, 1 coarse, 2 far) */
  readonly lods = new Map<SpeciesId, { first: number; count: number }[]>();
  /** (round 128) the close-up level (the flora LOD ladder's top): trees, thickets and tall grass — FL_<ID>_C */
  readonly closes = new Map<SpeciesId, { first: number; count: number }>();
  readonly ms: number;
  /** per kind: does it cast a shadow (trees and thickets; grass, flowers and ferns are left out of the shadow pass —
   *  their shadows are under a pixel and they are most of the triangles) */
  readonly shadowKinds: boolean[] = [];

  /** `px`: render pixels a cell the plants are made for (generate's; absent: full detail) */
  constructor(readonly spec: LibrarySpec = GAME_LIBRARY, readonly px?: number) {
    const t = performance.now();
    for (const { id, variants } of spec.species) {
      // (trees: full, coarse, far; thickets: full and far — FL_SHRUB_L1 is the far one)
      const lodsOf = SPECIES[id].form === 'tree' ? [0, 1, 2] : SPECIES[id].form === 'shrub' ? [0, 2] : [0];
      const levels = lodsOf.length;
      const lr: { first: number; count: number }[] = [];
      for (const lod of lodsOf) {
        lr.push({ first: this.kinds.length, count: variants });
        for (let v = 0; v < variants; v++) {
          const mesh = generate(id, hashSeed(spec.seed, v, id.charCodeAt(0), id.length), { px, lod: lod as 0 | 1 | 2 });
          this.kinds.push({ name: `${id}-${v}${lod ? `-l${lod}` : ''}`, species: id, variant: v, lod, mesh, verts: mesh.verts, index: mesh.index });
          this.shadowKinds.push(SPECIES[id].form === 'tree' || SPECIES[id].form === 'shrub' || SPECIES[id].form === 'rock');
        }
      }
      this.ranges.set(id, lr[0]);
      if (levels > 1) this.lods.set(id, lr);
      if (hasClose(id)) {
        this.closes.set(id, { first: this.kinds.length, count: variants });
        for (let v = 0; v < variants; v++) {
          const mesh = generate(id, hashSeed(spec.seed, v, id.charCodeAt(0), id.length), { lod: 'close' });
          this.kinds.push({ name: `${id}-${v}-c`, species: id, variant: v, lod: -1, mesh, verts: mesh.verts, index: mesh.index });
          this.shadowKinds.push(SPECIES[id].form !== 'grass');
        }
      }
    }
    this.ms = performance.now() - t;
  }

  /** The same constants with nothing behind them (FLORA off: the kernels still name them in dead branches). */
  static stubWgsl(): string {
    const ids = new Set(GAME_LIBRARY.species.map((s) => s.id));
    const z = 'vec4<f32>(0.0)';
    const lines = [...ids].map((id) => `const FL_${id.toUpperCase()} = vec2<u32>(0u, 1u);`);
    for (const id of ids) if (SPECIES[id].form === 'tree') lines.push(`const FL_${id.toUpperCase()}_L1 = vec2<u32>(0u, 1u);`, `const FL_${id.toUpperCase()}_L2 = vec2<u32>(0u, 1u);`);
    lines.push('const FL_SHRUB_L1 = vec2<u32>(0u, 1u);');
    for (const id of ids) if (hasClose(id)) lines.push(`const FL_${id.toUpperCase()}_C = vec2<u32>(0u, 1u);`);
    lines.push(`const FLORA_COL = array<vec4<f32>, 6>(${[z, z, z, z, z, z].join(', ')});`, `const FLORA_ACC = array<vec4<f32>, 1>(${z});`, `const FLORA_BARK = array<vec4<f32>, 2>(${z}, ${z});`, `const FLORA_EPI = array<vec4<f32>, 1>(${z});`, 'const FLORA_CROWN = array<vec2<f32>, 1>(vec2<f32>(1e9, 0.0));');
    return lines.join('\n') + '\n';
  }

  range(id: SpeciesId): { first: number; count: number } {
    const r = this.ranges.get(id);
    if (!r) throw new Error(`flora library: no species ${id}`);
    return r;
  }

  /**
   * WGSL constants for the kernels and the draw (appended after meshinst.ts's): each species' first kind and variant
   * count (FL_<ID>), and per kind its colours and wind response (FLORA_COL: 6 vec4s a kind — bark, bark mark, leaf
   * dark, leaf light, autumn, flower/accent; w of the first: deciduous; w of the second: sway; of the third: moss; of
   * the fourth: the bark's marks).
   */
  wgsl(): string {
    const lines: string[] = [];
    for (const [id, r] of this.ranges) lines.push(`const FL_${id.toUpperCase()} = vec2<u32>(${r.first}u, ${r.count}u);`);
    // (round 119) a tree's coarse and far levels: FL_<ID>_L1, FL_<ID>_L2
    for (const [id, lr] of this.lods) lr.slice(1).forEach((r, i) => lines.push(`const FL_${id.toUpperCase()}_L${i + 1} = vec2<u32>(${r.first}u, ${r.count}u);`));
    // (round 128) the close-up level: FL_<ID>_C
    for (const [id, r] of this.closes) lines.push(`const FL_${id.toUpperCase()}_C = vec2<u32>(${r.first}u, ${r.count}u);`);
    lines.push(floraTables(this.kinds.map((k) => ({ sp: SPECIES[k.species], mesh: k.mesh, close: k.lod === -1 }))));
    return lines.join('\n') + '\n';
  }
}
