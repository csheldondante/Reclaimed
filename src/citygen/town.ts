// (citygen M4a) A settlement's town made in the game by the GPU field generator (?citygen=fields): the street lab's
// pipeline (gpu.ts) over the town's box of the live window — its land as the world has it — with the town's inputs
// uploaded (its centre, radius, seed, the directions its atlas roads leave by) and nothing read back but the run's
// timestamps and two counts, once. Its layout and mesh are in the box's own frame and stay on the GPU; the mesh is placed
// in the window by a 16-byte transform (Renderer.addMesh), written again when the window slides — never remade.
// The box must be in the window when the town is made (the level opens the window round it: citygen/town.ts
// fieldTownBox, level.ts); after that the window may go where it likes. docs/design/CITYGEN.md.
import type { Settlement } from '../api/contracts/settlement';
import type { CityLots } from '../api/contracts/citygen';
import { ROW_H } from '../world/lattice';
import { CityGen, NART, type StreetParams, type StreetTimes } from './gpu';
import { cityParams, scaled } from './params';

/** a town's radius (cells) by its size: the field generator's, round its centre */
const RADIUS: Record<Settlement['size'], number> = { camp: 24, hamlet: 32, village: 44, town: 60, city: 80 };
/** the town circle's bound with supercells (× its radius: gpu.ts CITY_REACH) and a few columns' margin */
const REACH = 1.6;
const MARGIN = 4;
/** the streamer's region: a box is whole ones (its first row even, so its rows' hex offsets are the window's) */
const REGION = 64;

/** what the generator takes of a settlement: its id, centre (world units), size, its roads' directions and its seed */
export interface FieldTownSite {
  id: string;
  name: string;
  at: readonly [number, number];
  size: Settlement['size'];
  approaches: readonly (readonly [number, number])[];
  seed: number;
}

/** a town's box: world columns and rows, whole regions round its centre — its radius's bound and a margin each way */
export interface FieldTownBox {
  x0: number;
  y0: number;
  w: number;
  h: number;
  /** the town's radius (cells) */
  R: number;
}
export function fieldTownBox(site: Pick<FieldTownSite, 'at' | 'size'>): FieldTownBox {
  const R = RADIUS[site.size];
  const reach = REACH * R + MARGIN;
  const cx = site.at[0];
  const cy = site.at[1] / ROW_H;
  const x0 = Math.floor((cx - reach) / REGION) * REGION;
  const y0 = Math.floor((cy - reach / ROW_H) / REGION) * REGION;
  const x1 = Math.ceil((cx + reach) / REGION) * REGION;
  const y1 = Math.ceil((cy + reach / ROW_H) / REGION) * REGION;
  return { x0, y0, w: x1 - x0, h: y1 - y0, R };
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
    if (site.approaches.length > NART) throw new Error(`citygen: ${site.id} has ${site.approaches.length} roads, room for ${NART}`);
    const centre: [number, number] = [near(site.at[0] - box.x0, cols), near(site.at[1] - box.y0 * ROW_H, rows * ROW_H)];
    this.gen = new CityGen(io.device, { w: box.w, h: box.h, box: [bx, by], ...io.world, centre });
    this.gen.setArterials(site.approaches);
    this.xform = io.device.createBuffer({ label: `citygen ${site.id} place`, size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.oz0 = io.oz();
    this.place();
    io.addMesh(this.gen.verts, this.gen.args, this.xform);
    // (the town's own inputs over the generator's defaults: its radius and seed)
    this.params = scaled(cityParams({ townR: box.R, citySeed: site.seed % 9973 }));
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
