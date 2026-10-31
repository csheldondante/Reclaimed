// Viewer scenes (round 117): a biome laid out on a disc, from a seed — the viewer page's "forest scene" and the
// showcase the user asked for ("Waking through lead covered forest floor with silver birches towering above and
// leaves falling and blowing in the wind"). Pure (no GPU): the kinds to draw and their instances, so it is tested.
// Placement here is the viewer's own scatter (Poisson-ish by rejection) with the niche weights of species.ts; in the
// game the plants stand where vegplan.wgsl / vegprep.wgsl put them.

import { generate } from './generate';
import type { FloraMesh } from './mesh';
import { MeshBuilder } from './mesh';
import { hashSeed, rng } from './rng';
import { SPECIES, type RGB, type SpeciesId } from './species';

export type Biome = 'birchwood' | 'mixedwood' | 'meadow' | 'riverbank' | 'ruin' | 'cave';

export const BIOMES: { id: Biome; name: string }[] = [
  { id: 'birchwood', name: 'Silver birch wood' },
  { id: 'mixedwood', name: 'Mixed wood' },
  { id: 'meadow', name: 'Tall-grass meadow' },
  { id: 'riverbank', name: 'Riverbank (reeds)' },
  { id: 'ruin', name: 'Overgrown ruin (ivy, moss)' },
  { id: 'cave', name: 'Cave light well (ferns)' },
];

export interface SceneKind {
  species: SpeciesId | 'host';
  mesh: FloraMesh;
}

export interface FloraScene {
  kinds: SceneKind[];
  /** 16 floats an instance: three affine rows (translation in w), then (kind, seed 0..1, 0, 0) */
  instances: Float32Array;
  /** per kind, its instances' range */
  ranges: { first: number; count: number }[];
  /** ground style (viewer.wgsl fsGround): 0 meadow, 1 forest floor in leaf litter, 2 riverbank */
  ground: number;
  /** where leaves fall from: crowns (x, y, z of the crown's middle, radius) and their species */
  crowns: { x: number; y: number; z: number; r: number; species: SpeciesId }[];
  radius: number;
}

/** what each biome holds: species, plants per 100 cells², and where (a band for the riverbank) */
const MIX: Record<Biome, { ground: number; parts: { id: SpeciesId; per100: number; band?: [number, number] }[] }> = {
  birchwood: {
    ground: 1,
    parts: [
      { id: 'birch', per100: 2.6 },
      { id: 'fern', per100: 3 },
      { id: 'tallgrass', per100: 4 },
      { id: 'shrub', per100: 0.3 },
    ],
  },
  mixedwood: {
    ground: 1,
    parts: [
      { id: 'oak', per100: 1.0 },
      { id: 'pine', per100: 1.0 },
      { id: 'birch', per100: 0.6 },
      { id: 'giant', per100: 0.08 },
      { id: 'shrub', per100: 0.8 },
      { id: 'fern', per100: 3 },
    ],
  },
  meadow: {
    ground: 0,
    parts: [
      { id: 'tallgrass', per100: 55 },
      { id: 'flower', per100: 8 },
      { id: 'shrub', per100: 0.4 },
      { id: 'oak', per100: 0.05 },
    ],
  },
  riverbank: {
    ground: 2,
    parts: [
      { id: 'reed', per100: 30, band: [-2.5, 2.5] },
      { id: 'tallgrass', per100: 30, band: [2, 14] },
      { id: 'flower', per100: 4, band: [3, 30] },
      { id: 'birch', per100: 1.2, band: [8, 40] },
      { id: 'fern', per100: 3, band: [4, 40] },
    ],
  },
  ruin: { ground: 0, parts: [{ id: 'tallgrass', per100: 20 }, { id: 'shrub', per100: 0.6 }, { id: 'birch', per100: 0.4 }] },
  cave: { ground: 1, parts: [{ id: 'fern', per100: 28 }, { id: 'moss', per100: 10 }] },
};

/** A box (a wall, a pillar, a boulder's block) as a host mesh: part 9 (the viewer's stone). */
function hostBox(sx: number, sy: number, sz: number): FloraMesh {
  const mb = new MeshBuilder(() => 0);
  const P = [
    [-sx, -sy, 0], [sx, -sy, 0], [sx, sy, 0], [-sx, sy, 0],
    [-sx, -sy, sz], [sx, -sy, sz], [sx, sy, sz], [-sx, sy, sz],
  ].map((p) => mb.vert(p as [number, number, number], 9));
  const F = [[0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7], [4, 5, 6, 7]];
  for (const [a, b, c, d] of F) {
    mb.tri(P[a], P[b], P[c]);
    mb.tri(P[a], P[c], P[d]);
  }
  return mb.done();
}

export function buildScene(biome: Biome, seed: number, opts: { radius?: number; density?: number; variants?: number; season?: number } = {}): FloraScene {
  const R = opts.radius ?? 36;
  const dens = opts.density ?? 1;
  const V = opts.variants ?? 3;
  const r = rng(hashSeed(seed, 0xb10));
  const kinds: SceneKind[] = [];
  const per: number[][] = [];
  const kindOf = new Map<string, number[]>();
  const kindsFor = (id: SpeciesId): number[] => {
    let ks = kindOf.get(id);
    if (!ks) {
      ks = [];
      for (let v = 0; v < V; v++) {
        ks.push(kinds.length);
        kinds.push({ species: id, mesh: generate(id, hashSeed(seed, v, id.charCodeAt(0), id.length)) });
        per.push([]);
      }
      kindOf.set(id, ks);
    }
    return ks;
  };
  const crowns: FloraScene['crowns'] = [];
  const put = (k: number, x: number, y: number, z: number, yaw: number, s: number, lean: [number, number], xform?: number[]) => {
    const c = Math.cos(yaw) * s;
    const n = Math.sin(yaw) * s;
    per[k].push(...(xform ?? [c, -n, lean[0] * s, x, n, c, lean[1] * s, y, 0, 0, s, z]), k, r());
  };
  // the trees first, spaced (a tree keeps others out of its trunk's reach); small plants anywhere
  const taken: { x: number; y: number; rr: number }[] = [];
  const free = (x: number, y: number, rr: number) => taken.every((t) => (t.x - x) ** 2 + (t.y - y) ** 2 > (t.rr + rr) ** 2);
  const mix = MIX[biome];
  const order = [...mix.parts].sort((a, b) => (SPECIES[b.id].form === 'tree' ? 1 : 0) - (SPECIES[a.id].form === 'tree' ? 1 : 0));
  for (const part of order) {
    const sp = SPECIES[part.id];
    const ks = kindsFor(part.id);
    const area = Math.PI * R * R;
    const n = Math.round((area / 100) * part.per100 * dens);
    const tree = sp.form === 'tree';
    const keep = tree ? 2.2 : sp.form === 'shrub' ? 1.2 : 0;
    let placed = 0;
    for (let tries = 0; placed < n && tries < n * 8; tries++) {
      const a = r() * Math.PI * 2;
      const d = Math.sqrt(r()) * R;
      const x = Math.cos(a) * d;
      const y = Math.sin(a) * d;
      if (part.band && (x < part.band[0] || x > part.band[1])) continue;
      if (biome === 'riverbank' && x < -2.5) continue;
      if (keep > 0 && !free(x, y, keep)) continue;
      if (keep > 0) taken.push({ x, y, rr: keep });
      const k = ks[Math.floor(r() * ks.length)];
      const s = 0.85 + 0.3 * r();
      put(k, x, y, 0, r() * Math.PI * 2, s, [(r() - 0.5) * 0.08, (r() - 0.5) * 0.08]);
      if (tree) {
        const m = kinds[k].mesh;
        crowns.push({ x, y, z: m.height * s * 0.7, r: Math.max(1, m.radius * s * 0.7), species: part.id });
      }
      placed++;
    }
  }
  // the ruin: walls and blocks (hosts) with ivy up their faces and moss on their tops — plants instanced onto other
  // geometry; the cave: boulders with moss
  if (biome === 'ruin' || biome === 'cave') {
    const walls = biome === 'ruin' ? 7 : 0;
    const hostK = kinds.length;
    kinds.push({ species: 'host', mesh: hostBox(4, 0.5, 5) });
    per.push([]);
    const blockK = kinds.length;
    kinds.push({ species: 'host', mesh: hostBox(1.2, 1.2, 1.4) });
    per.push([]);
    const ivy = kindsFor('ivy');
    const moss = kindsFor('moss');
    for (let w = 0; w < walls; w++) {
      const a = r() * Math.PI * 2;
      const d = 6 + r() * (R - 12);
      const x = Math.cos(a) * d;
      const y = Math.sin(a) * d;
      const yaw = r() * Math.PI;
      const hgt = 0.5 + 0.6 * r();
      const c = Math.cos(yaw);
      const s = Math.sin(yaw);
      per[hostK].push(c, -s, 0, x, s, c, 0, y, 0, 0, hgt, 0, hostK, r());
      // ivy on both faces: the vine's plane (y, z) is the wall's face, its +x the face's normal
      for (const side of [1, -1]) {
        for (let v = 0; v < 3; v++) {
          const along = (r() - 0.5) * 6;
          // local: x = side × 0.5 (the face), y = along; the vine's +x → the face's normal (side × the wall's y axis)
          const nx = -s * side;
          const ny = c * side;
          const px = x + c * along + nx * 0.5;
          const py = y + s * along + ny * 0.5;
          const sc = 0.7 + 0.4 * r();
          // columns: vine x → (nx, ny), vine y → (c, s) along the wall, vine z → up
          per[ivy[Math.floor(r() * ivy.length)]].push(nx * sc, c * sc, 0, px, ny * sc, s * sc, 0, py, 0, 0, sc * Math.min(1, (hgt * 5) / 4.5), 0, ivy[0], r());
        }
      }
      // moss along the top
      for (let m = 0; m < 3; m++) {
        const along = (r() - 0.5) * 7;
        put(moss[Math.floor(r() * moss.length)], x + c * along, y + s * along, hgt * 5, r() * 6.28, 0.8, [0, 0]);
      }
    }
    const blocks = biome === 'ruin' ? 10 : 18;
    for (let b = 0; b < blocks; b++) {
      const a = r() * Math.PI * 2;
      const d = 3 + r() * (R - 6);
      const x = Math.cos(a) * d;
      const y = Math.sin(a) * d;
      const yaw = r() * Math.PI;
      const sc = 0.6 + 0.9 * r();
      put(blockK, x, y, -0.2, yaw, sc, [(r() - 0.5) * 0.3, (r() - 0.5) * 0.3]);
      put(moss[Math.floor(r() * moss.length)], x, y, 1.4 * sc - 0.25, r() * 6.28, sc * 1.1, [0, 0]);
    }
  }
  // (the ivy's instances were pushed with their kind as written; fix each record's kind to the list it is in)
  const ranges: FloraScene['ranges'] = [];
  const out: number[] = [];
  per.forEach((list, k) => {
    const first = out.length / 14;
    for (let i = 0; i < list.length; i += 14) {
      out.push(...list.slice(i, i + 12), k, list[i + 13]);
    }
    ranges.push({ first, count: list.length / 14 });
  });
  // 14 floats → 16 (the fourth vec4: kind, seed, 0, 0)
  const inst = new Float32Array((out.length / 14) * 16);
  for (let i = 0; i < out.length / 14; i++) {
    inst.set(out.slice(i * 14, i * 14 + 14), i * 16);
  }
  return { kinds, instances: inst, ranges, ground: mix.ground, crowns, radius: R };
}

/** the library's colour table for the scene's kinds (as FloraLibrary.wgsl, per scene kind) */
export function sceneWgsl(kinds: SceneKind[]): string {
  const v4 = (c: RGB | undefined, w: number) => {
    const x = c ?? [0.5, 0.5, 0.5];
    return `vec4<f32>(${x[0].toFixed(3)}, ${x[1].toFixed(3)}, ${x[2].toFixed(3)}, ${w.toFixed(3)})`;
  };
  const rows: string[] = [];
  const acc: string[] = [];
  for (const k of kinds) {
    const sp = k.species === 'host' ? SPECIES.moss : SPECIES[k.species];
    const c = sp.colours;
    rows.push(v4(c.bark, c.deciduous ? 1 : 0), v4(c.barkMark ?? c.bark, sp.sway), v4(c.leafDark, 0), v4(c.leafLight, 0), v4(c.autumn, 0), v4(c.flower ?? c.accent, 0));
    acc.push(v4(c.accent ?? c.leafLight, 0));
  }
  return `const FLORA_COL = array<vec4<f32>, ${rows.length}>(${rows.join(', ')});\nconst FLORA_ACC = array<vec4<f32>, ${acc.length}>(${acc.join(', ')});\n`;
}

