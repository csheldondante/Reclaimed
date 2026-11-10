// (citygen M4a) A settlement's town made in the game by the GPU field generator (?citygen=fields): the street lab's
// pipeline (gpu.ts) over the town's box of the live window — its land as the world has it — with the town's inputs
// uploaded (its centre, radius, seed, its atlas roads' points) and nothing read back but the run's
// timestamps and two counts, once. Its layout and mesh are in the box's own frame and stay on the GPU; the mesh is placed
// in the window by a 16-byte transform (Renderer.addMesh), written again when the window slides — never remade.
// The box must be in the window when the town is made (the level opens the window round it: citygen/town.ts
// fieldTownBox, level.ts); after that the window may go where it likes. docs/design/CITYGEN.md.
import type { Settlement } from '../api/contracts/settlement';
import type { CityLots } from '../api/contracts/citygen';
import { ROW_H } from '../world/lattice';
import { CityGen, NAP, NART, POP_PURPOSE, type StreetParams, type StreetTimes } from './gpu';
import { cityParams, scaled } from './params';

/** a town's radius (cells) by its size — a town the lab's Muru the user approved (radius 120, 400+ lots) */
const RADIUS: Record<Settlement['size'], number> = { camp: 30, hamlet: 48, village: 72, town: 120, city: 150 };
/** (M4b) the population field's peak density by size; the roads' tone (1 dirt for the small, 2 stone for the big) */
const DENSITY: Record<Settlement['size'], number> = { camp: 0.35, hamlet: 0.45, village: 0.6, town: 0.8, city: 1 };
const TONE: Record<Settlement['size'], number> = { camp: 1, hamlet: 1, village: 1, town: 2, city: 2 };
/** the box's half side (× the radius): the lab's sites, 320 columns round a town of 120 — the supercells' limit
 *  (0.9 radii ± 35%) inside it */
const BOX = 4 / 3;
/** the core (× the radius) where the atlas's own road and plaza stamps are cleared (Settlements.byFields): the arterials
 *  are drawn at least this far, so they meet the stamped roads past it (the supercells' limit is 0.9 radii ± 35%) */
const CORE = 0.5;
/** the streamer's region: the window holds the box's regions */
const REGION = 64;

/** what the generator takes of a settlement: its id, centre (world units), size, its atlas roads (world polylines,
 *  each from its end at the town: Settlements.approachWays) and its seed */
export interface FieldTownSite {
  id: string;
  name: string;
  at: readonly [number, number];
  size: Settlement['size'];
  roads: readonly (readonly (readonly [number, number])[])[];
  seed: number;
  /** what it's for (Settlement.purpose.kind): its population field weights that district purpose up */
  purpose?: string;
}

/** a town's box: world columns and rows round its centre (as many rows as columns, the first row even), the regions
 *  the window must hold for it, and the town's radius (cells) */
export interface FieldTownBox {
  x0: number;
  y0: number;
  w: number;
  h: number;
  cover: { x0: number; y0: number; w: number; h: number };
  R: number;
  /** the core: the atlas's stamps cleared within it (world units) */
  core: number;
}
export function fieldTownBox(site: Pick<FieldTownSite, 'at' | 'size'>): FieldTownBox {
  const R = RADIUS[site.size];
  const half = Math.ceil(BOX * R);
  const cx = Math.round(site.at[0]);
  const cy = Math.round(site.at[1] / ROW_H);
  const x0 = cx - half;
  const y0 = 2 * Math.floor((cy - half) / 2);
  const w = 2 * half;
  const h = 2 * half;
  const rx0 = Math.floor(x0 / REGION) * REGION;
  const ry0 = Math.floor(y0 / REGION) * REGION;
  const cover = { x0: rx0, y0: ry0, w: Math.ceil((x0 + w) / REGION) * REGION - rx0, h: Math.ceil((y0 + h) / REGION) * REGION - ry0 };
  return { x0, y0, w, h, cover, R, core: CORE * R };
}

/** what the town needs of the game: the device, the world's buffers, the renderer, and where the window is */
export interface FieldTownIO {
  device: GPUDevice;
  world: { globals: GPUBuffer; chunks: GPUBuffer; layers: GPUBuffer; water: GPUBuffer };
  addMesh(verts: GPUBuffer, args: GPUBuffer, xform: GPUBuffer): void;
  removeMesh(args: GPUBuffer): void;
  /** the window: its first world column and row, its z offset; its size (columns, rows); the world's (it wraps) */
  origin(): readonly [number, number];
  oz(): number;
  dims: { w: number; h: number };
  wrap: { cols: number; rows: number };
}

const mod = (v: number, n: number) => ((v % n) + n) % n;
/** d wrapped to the nearest copy round the world (−n/2 … n/2) */
const near = (d: number, n: number) => d - Math.round(d / n) * n;

export class FieldTown {
  readonly gen: CityGen;
  readonly box: FieldTownBox;
  /** the run's GPU ms and counts (once made) */
  times: StreetTimes | null = null;
  /** resolves when the town is made */
  readonly made: Promise<StreetTimes>;
  /** the run's parameters: the generator's defaults with the town's radius and seed */
  readonly params: StreetParams;
  private xform: GPUBuffer;
  private oz0: number;

  constructor(
    private io: FieldTownIO,
    readonly site: FieldTownSite,
  ) {
    const box = (this.box = fieldTownBox(site));
    const { cols, rows } = io.wrap;
    const [ox, oy] = io.origin();
    // (the box in the window now: its land is what the town is made from)
    const bx = mod(box.x0 - ox, cols);
    const by = mod(box.y0 - oy, rows);
    if (bx + box.w > io.dims.w || by + box.h > io.dims.h)
      throw new Error(`citygen: ${site.id}'s box (${box.w} x ${box.h} at ${box.x0}, ${box.y0}) isn't in the window (${io.dims.w} x ${io.dims.h} at ${ox}, ${oy}) — the level opens the window round it`);
    if (site.roads.length > NART) throw new Error(`citygen: ${site.id} has ${site.roads.length} roads, room for ${NART}`);
    // (the grid's world units: its first column's corner at 0, 0)
    const ox0 = site.at[0] - near(site.at[0] - box.x0, cols);
    const oy0 = site.at[1] - near(site.at[1] - box.y0 * ROW_H, rows * ROW_H);
    const local = ([x, y]: readonly [number, number]): [number, number] => [x - ox0, y - oy0];
    const centre = local(site.at);
    const town = { density: DENSITY[site.size], purpose: site.purpose !== undefined ? (POP_PURPOSE[site.purpose] ?? -1) : -1 };
    this.gen = new CityGen(io.device, { w: box.w, h: box.h, box: [bx, by], ...io.world, centre, town });
    // (each atlas road from the town's centre out: its points every 4 units, from the one nearest the centre, as far as
    // the box — the GPU cuts it at the box's edge and the town's limit)
    const R2 = Math.hypot(box.w, box.h * ROW_H);
    this.gen.setArterials(
      box.core,
      site.roads.map((line) => {
        let k0 = 0;
        line.forEach((p, k) => {
          if (Math.hypot(p[0] - site.at[0], p[1] - site.at[1]) < Math.hypot(line[k0][0] - site.at[0], line[k0][1] - site.at[1])) k0 = k;
        });
        const out: [number, number][] = [centre];
        for (let k = k0; k < line.length && out.length < NAP; k += 2) {
          out.push(local(line[k]));
          if (Math.hypot(line[k][0] - site.at[0], line[k][1] - site.at[1]) > R2) break;
        }
        return out;
      }),
    );
    this.xform = io.device.createBuffer({ label: `citygen ${site.id} place`, size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.oz0 = io.oz();
    this.place();
    io.addMesh(this.gen.verts, this.gen.args, this.xform);
    // (the town's own inputs over the generator's defaults: its radius and seed)
    this.params = scaled(cityParams({ townR: box.R, citySeed: site.seed % 9973, marks: 0, roadTone: TONE[site.size] }));
    this.made = this.gen.run(this.params, 'field').then((t) => (this.times = t));
  }

  /** the mesh placed in the window as it is now: the box's first column's window world position, z by the window's
   *  move in z since the town was made (16 bytes; a slide, a warp) */
  place(): void {
    const [ox, oy] = this.io.origin();
    const { cols, rows } = this.io.wrap;
    const x = near(this.box.x0 - ox, cols);
    const y = near(this.box.y0 - oy, rows) * ROW_H;
    this.io.device.queue.writeBuffer(this.xform, 0, new Float32Array([x, y, this.oz0 - this.io.oz(), 0]));
  }

  /** the town's lots for what builds on it (api/contracts/citygen.ts) */
  get lots(): CityLots {
    return { records: this.gen.lotRecords, counts: this.gen.lotCounts, progress: this.gen.progress, place: this.xform };
  }

  dispose(): void {
    this.io.removeMesh(this.gen.args);
    this.gen.dispose();
    this.xform.destroy();
  }
}
