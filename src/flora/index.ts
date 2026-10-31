// The flora system (round 117): the contract (api/contracts/flora.ts) over the generators (library, species), the
// placement rules and the passability model. It reads the world only through a FloraSource (the succession field as
// the CPU mirror last read it, the window's size and origin), so it is tested on a made-up field.
import type { ControllerProfile } from '../api/contracts/play';
import type { Flora, FloraLibraryApi, FloraPlant, FloraRect, FloraSpeciesInfo } from '../api/contracts/flora';
import { cellAt, cellPos } from '../world/lattice';
import { generate } from './generate';
import { FloraLibrary, GAME_LIBRARY } from './library';
import { passage, coverage, type StandPlant } from './passability';
import { fit, standsAt, type Stand } from './placement';
import { SPECIES, SPECIES_IDS, type SpeciesId } from './species';

export interface FloraSource {
  dims(): { w: number; h: number };
  origin(): [number, number];
  /** the succession field at window column (cx, cy), null before the first read */
  veg(cx: number, cy: number): number | null;
  /** read the fields again (the CPU mirror) */
  refresh?(): Promise<void>;
}

export class FloraWorld implements Flora {
  readonly library: FloraLibraryApi;
  readonly placement: Flora['placement'];
  readonly passability: Flora['passability'];
  /** per species: its mean footprint radius and height (from the game library's meshes) */
  private shape = new Map<SpeciesId, { radius: number; height: number }>();

  refresh(): Promise<void> {
    return this.src.refresh?.() ?? Promise.resolve();
  }

  constructor(private src: FloraSource, lib = new FloraLibrary(GAME_LIBRARY)) {
    for (const k of lib.kinds) {
      if (k.lod) continue;
      const s = this.shape.get(k.species) ?? { radius: 0, height: 0 };
      const n = lib.range(k.species).count;
      s.radius += k.mesh.radius / n;
      s.height += k.mesh.height / n;
      this.shape.set(k.species, s);
    }
    this.library = {
      species: (): FloraSpeciesInfo[] =>
        SPECIES_IDS.map((id) => {
          const s = SPECIES[id];
          return { id, name: s.name, form: s.form, height: s.height, hosts: s.niche.hosts, deciduous: s.colours.deciduous, barrier: s.barrier };
        }),
      mesh: (id, seed) => {
        if (!(id in SPECIES)) throw new Error(`flora: no species ${id}`);
        return generate(id as SpeciesId, seed);
      },
      variants: (id) => lib.ranges.get(id as SpeciesId)?.count ?? 0,
    };
    this.placement = {
      fit: (site) => fit(site),
      plantsIn: (r) =>
        this.stands(r)
          .filter((s) => s.species !== 'tallgrass' && s.species !== 'fern')
          .map((s): FloraPlant => {
            const [x, y] = cellPos(s.cx, s.cy);
            return { species: s.species, x, y, cx: s.cx, cy: s.cy, height: (this.shape.get(s.species)?.height ?? 1) * s.scale };
          }),
    };
    this.passability = {
      density: (r, height = 2) => coverage(this.standPlants(r), this.area(r), height),
      passage: (r, body: ControllerProfile) => passage(this.standPlants(r), this.area(r), body),
    };
  }

  /** the columns a rectangle covers (half-open, clipped to the window) */
  private cols(r: FloraRect): [number, number, number, number] {
    const { w, h } = this.src.dims();
    const [ax, ay] = cellAt(r.x0, r.y0);
    const [bx, by] = cellAt(r.x1, r.y1);
    return [Math.max(0, Math.min(ax, bx)), Math.max(0, Math.min(ay, by)), Math.min(w, Math.max(ax, bx)), Math.min(h, Math.max(ay, by))];
  }
  private area(r: FloraRect): number {
    const [x0, y0, x1, y1] = this.cols(r);
    return Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  }
  private stands(r: FloraRect): Stand[] {
    const [x0, y0, x1, y1] = this.cols(r);
    const { w, h } = this.src.dims();
    const org = this.src.origin();
    const out: Stand[] = [];
    for (let cy = y0; cy < y1; cy++)
      for (let cx = x0; cx < x1; cx++) {
        const v = this.src.veg(cx, cy);
        if (v === null) continue;
        out.push(...standsAt(cx, cy, v, w, h, org));
      }
    return out;
  }
  private standPlants(r: FloraRect): StandPlant[] {
    return this.stands(r).map((s) => {
      const sh = this.shape.get(s.species) ?? { radius: 0.5, height: 1 };
      const tree = SPECIES[s.species].form === 'tree';
      // (grass and shrubs fill most of their mesh's reach at walking height; a tree only its trunk)
      return { barrier: SPECIES[s.species].barrier, radius: sh.radius * s.scale * 0.8, height: sh.height * s.scale, trunkOnly: tree };
    });
  }
}
