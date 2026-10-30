// The plant library (round 117): every species' variants as meshes, made once from seeds, in the instanced mesh
// renderer's kind list (render/meshinst.ts). A kind is one (species, variant); the GPU picks a variant per plant by a
// hash of its column, so a forest of 4 birch variants × turn × lean × scale reads as hundreds of different trees.
//
// Why a fixed library of variants and not a mesh per plant: one indexed draw per kind (instancing) is what keeps a
// dense forest affordable on the phone; per-plant meshes would be a draw (or a compute-built mesh) each. The
// generator is cheap (a few ms for the whole library), so the library could be re-made per biome or per run later.

import { generate } from './generate';
import { hashSeed } from './rng';
import { SPECIES, type RGB, type SpeciesId } from './species';
import type { FloraMesh } from './mesh';

export interface LibraryKind {
  name: string;
  species: SpeciesId;
  variant: number;
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
    { id: 'oak', variants: 4 },
    { id: 'pine', variants: 4 },
    { id: 'birch', variants: 5 },
    { id: 'giant', variants: 3 },
    { id: 'shrub', variants: 3 },
    { id: 'tallgrass', variants: 4 },
    { id: 'flower', variants: 2 },
    { id: 'fern', variants: 2 },
    { id: 'reed', variants: 2 },
  ],
  seed: 117,
};

export class FloraLibrary {
  readonly kinds: LibraryKind[] = [];
  /** per species: its first kind and variant count */
  readonly ranges = new Map<SpeciesId, { first: number; count: number }>();
  readonly ms: number;
  /** per kind: does it cast a shadow (trees and thickets; grass, flowers and ferns are left out of the shadow pass —
   *  their shadows are under a pixel and they are most of the triangles) */
  readonly shadowKinds: boolean[] = [];

  constructor(readonly spec: LibrarySpec = GAME_LIBRARY) {
    const t = performance.now();
    for (const { id, variants } of spec.species) {
      this.ranges.set(id, { first: this.kinds.length, count: variants });
      for (let v = 0; v < variants; v++) {
        const mesh = generate(id, hashSeed(spec.seed, v, id.charCodeAt(0), id.length));
        this.kinds.push({ name: `${id}-${v}`, species: id, variant: v, mesh, verts: mesh.verts, index: mesh.index });
        this.shadowKinds.push(SPECIES[id].form === 'tree' || SPECIES[id].form === 'shrub');
      }
    }
    this.ms = performance.now() - t;
  }

  /** The same constants with nothing behind them (FLORA off: the kernels still name them in dead branches). */
  static stubWgsl(): string {
    const ids = new Set(GAME_LIBRARY.species.map((s) => s.id));
    const z = 'vec4<f32>(0.0)';
    const lines = [...ids].map((id) => `const FL_${id.toUpperCase()} = vec2<u32>(0u, 1u);`);
    lines.push(`const FLORA_COL = array<vec4<f32>, 6>(${[z, z, z, z, z, z].join(', ')});`, `const FLORA_ACC = array<vec4<f32>, 1>(${z});`);
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
   * dark, leaf light, autumn, flower/accent; w of the first: deciduous; w of the second: sway).
   */
  wgsl(): string {
    const lines: string[] = [];
    for (const [id, r] of this.ranges) lines.push(`const FL_${id.toUpperCase()} = vec2<u32>(${r.first}u, ${r.count}u);`);
    const v4 = (c: RGB | undefined, w: number) => {
      const x = c ?? [0.8, 0.8, 0.8];
      return `vec4<f32>(${x[0].toFixed(3)}, ${x[1].toFixed(3)}, ${x[2].toFixed(3)}, ${w.toFixed(3)})`;
    };
    const rows: string[] = [];
    for (const k of this.kinds) {
      const sp = SPECIES[k.species];
      const c = sp.colours;
      rows.push(
        v4(c.bark, c.deciduous ? 1 : 0),
        v4(c.barkMark ?? c.bark, sp.sway),
        v4(c.leafDark, 0),
        v4(c.leafLight, 0),
        v4(c.autumn, 0),
        v4(c.flower ?? c.accent, 0),
      );
    }
    lines.push(`const FLORA_COL = array<vec4<f32>, ${rows.length}>(${rows.join(', ')});`);
    // the accent colour where the flower colour stands in for it (grass seed heads, cattails)
    const acc = this.kinds.map((k) => v4(SPECIES[k.species].colours.accent ?? SPECIES[k.species].colours.leafLight, 0));
    lines.push(`const FLORA_ACC = array<vec4<f32>, ${acc.length}>(${acc.join(', ')});`);
    return lines.join('\n') + '\n';
  }
}
