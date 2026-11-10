// (citygen M4a) A settlement's town made in the game by the GPU field generator (?citygen=fields): the street lab's
// pipeline (gpu.ts) over the town's box of the live window — its land as the world has it — with the town's inputs
// uploaded (its centre, radius, seed, its atlas roads' points) and nothing read back but the run's
// timestamps and two counts, once. Its layout and mesh are in the box's own frame and stay on the GPU; the mesh is placed
// in the window by a 16-byte transform (Renderer.addMesh), written again when the window slides — never remade.
// The box must be in the window when the town is made (the level opens the window round it: citygen/town.ts
// fieldTownBox, level.ts); after that the window may go where it likes. docs/design/CITYGEN.md.
import { LIQUID } from '../flow/model';
import type { Settlement } from '../api/contracts/settlement';
import type { CityLots, CityRoutes } from '../api/contracts/citygen';
import { ROW_H } from '../world/lattice';
import { BUILD_S, CityGen, LM_ROOM, NAP, NART, POP_PURPOSE, REC_LM, TOWN_VERT_ROOM, type StreetParams, type StreetTimes } from './gpu';
import type { StaticClaims, StaticGrid, GridPlace, OwnedSlot } from '../sim/static-claims';
import { cellAt } from '../world/lattice';
import { makeBindGroup, makeCompute, type ComputeKernel } from '../gpu/pipeline';
import commonWgsl from '../shaders/common.wgsl?raw';
import bareWgsl from './bare.wgsl?raw';
import { cityParams, scaled } from './params';
import { urlFlags } from '../flags';

/** a town's radius (cells) by its size — a town the lab's Muru the user approved (radius 120, 400+ lots) */
const RADIUS: Record<Settlement['size'], number> = { camp: 30, hamlet: 48, village: 72, town: 120, city: 150 };
/** (M4b) the population field's peak density by size; the roads' tone (1 dirt for the small, 2 stone for the big) */
const DENSITY: Record<Settlement['size'], number> = { camp: 0.35, hamlet: 0.45, village: 0.6, town: 0.8, city: 1 };
/** (M4b) the population a grid needs (its peak density): below it a settlement is a hamlet, farms or nothing — no grid
 *  (the user: "we can ignore it where there is no population or low enough not to necessitate a grid") */
const GRID_DENSITY = 0.6;
export function hasGrid(size: Settlement['size']): boolean {
  return DENSITY[size] >= GRID_DENSITY;
}
const TONE: Record<Settlement['size'], number> = { camp: 1, hamlet: 1, village: 1, town: 2, city: 2 };
/** the box's half side (× the radius): the lab's sites, 320 columns round a town of 120 — the supercells' limit
 *  (0.9 radii ± 35%) inside it */
const BOX = 4 / 3;
/** the core (× the radius) where the atlas's own road and plaza stamps are cleared (Settlements.byFields): the arterials
 *  are drawn at least this far, so they meet the stamped roads past it (the supercells' limit is 0.9 radii ± 35%) */
const CORE = 0.5;
/** (M4b) the field towns' claims' owner (sim/external.ts OwnerId; the old towns' grids are 256 and up) */
const OWNER_FIELD_TOWN = 1 << 20;
/** the atlas's raw ground's tile (region-land.ts rawGroundGpu) */
const TILE = 64;

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

/** a town's box: world columns and rows round its centre (as many rows as columns, whole 64-column tiles, the first
 *  row even), the town's radius (cells) and its core */
export interface FieldTownBox {
  x0: number;
  y0: number;
  w: number;
  h: number;
  R: number;
  /** the core: the atlas's stamps cleared within it (world units) */
  core: number;
}
export function fieldTownBox(site: Pick<FieldTownSite, 'at' | 'size'>): FieldTownBox {
  const R = RADIUS[site.size];
  // (whole 64-column tiles: the atlas's raw ground is made a tile at a time)
  const side = Math.ceil((2 * Math.ceil(BOX * R)) / TILE) * TILE;
  const cx = Math.round(site.at[0]);
  const cy = Math.round(site.at[1] / ROW_H);
  const x0 = cx - side / 2;
  const y0 = 2 * Math.floor((cy - side / 2) / 2);
  return { x0, y0, w: side, h: side, R, core: CORE * R };
}

/**
 * (M4b) A town's layout set up — its box, its raw ground's buffer (to fill: Atlas.rawGroundGpu), its generator with its
 * inputs (centre, population field, its roads as arterials) and its run's parameters — the one setup FieldTown and the
 * phone bench (perf/citygenbench.ts) share. The caller fills `raw`, then runs `gen.run(params, 'field')`.
 */
export function townLayout(
  device: GPUDevice,
  site: FieldTownSite,
  wrap: { cols: number; rows: number },
  sea: number,
  opts: { claimInto?: GPUBufferBinding; vertRoom?: number; built?: 'all' | 'core' } = {},
): { box: FieldTownBox; raw: GPUBuffer; gen: CityGen; params: StreetParams; centre: [number, number]; local: (p: readonly [number, number]) => [number, number] } {
  const box = fieldTownBox(site);
  const { cols, rows } = wrap;
  // (its ground the atlas's raw ground over the whole box, made on the GPU — the window may be anywhere)
  const raw = device.createBuffer({ label: `citygen ${site.id} raw ground`, size: box.w * box.h * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  if (site.roads.length > NART) throw new Error(`citygen: ${site.id} has ${site.roads.length} roads, room for ${NART}`);
  // (the grid's world units: its first column's corner at 0, 0)
  const ox0 = site.at[0] - near(site.at[0] - box.x0, cols);
  const oy0 = site.at[1] - near(site.at[1] - box.y0 * ROW_H, rows * ROW_H);
  const local = ([x, y]: readonly [number, number]): [number, number] => [x - ox0, y - oy0];
  const centre = local(site.at);
  const town = { density: DENSITY[site.size], purpose: site.purpose !== undefined ? (POP_PURPOSE[site.purpose] ?? -1) : -1 };
  const gen = new CityGen(device, { w: box.w, h: box.h, ground: { kind: 'raw', raw, sea }, centre, town, claimInto: opts.claimInto, vertRoom: opts.vertRoom ?? TOWN_VERT_ROOM, built: opts.built });
  // (each atlas road from the town's centre out: its points every 4 units, from the one nearest the centre, as far as
  // the box — the GPU cuts it at the box's edge and the town's limit)
  const R2 = Math.hypot(box.w, box.h * ROW_H);
  gen.setArterials(
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
  // (the town's own inputs over the generator's defaults: its radius and seed)
  // (the street skeleton from the address: ?skel=0|1|2 &skelmargin= &minorahead=0|1 — citygen/params.ts)
  const q = urlFlags();
  const skel: Partial<StreetParams> = {};
  if (q.get('skel') !== null) skel.skelReach = Number(q.get('skel'));
  if (q.get('skelmargin') !== null) skel.skelMargin = Number(q.get('skelmargin'));
  if (q.get('minorahead') !== null) skel.minorAhead = Number(q.get('minorahead'));
  const params = scaled(cityParams({ townR: box.R, citySeed: site.seed % 9973, marks: 0, roadTone: TONE[site.size], ...skel }));
  return { box, raw, gen, params, centre, local };
}

/** what the town needs of the game: the device, the world's buffers, the renderer, and where the window is */
export interface FieldTownIO {
  device: GPUDevice;
  /** (M4b) the static claims (the town's claims GPU-owned there), the world's buffers the bare pass writes (the plants)
   *  and a reach over the window (build/reachgpu.ts FortressReachGpu: markFrom, marks) */
  statics(): StaticClaims | null;
  plants: { globals: GPUBuffer; veg: GPUBuffer; vegNext: GPUBuffer };
  reach(): { markFrom(stores: [number, number]): Promise<number>; marks: GPUBuffer; planSpans: GPUBuffer; w: number; h: number };
  /** the reach's turn: one town's solve at a time */
  reachTurn(f: () => Promise<void>): Promise<void>;
  /** the atlas's raw ground over a box into a buffer (Atlas.rawGroundGpu); the sea's level (world z) */
  rawGround(x0: number, y0: number, w: number, h: number, out: GPUBuffer): Promise<void>;
  sea: number;
  addMesh(verts: GPUBuffer, args: GPUBuffer, xform: GPUBuffer): void;
  removeMesh(args: GPUBuffer): void;
  /** the window: its first world column and row, its z offset; its size (columns, rows); the world's (it wraps) */
  origin(): readonly [number, number];
  oz(): number;
  dims: { w: number; h: number };
  wrap: { cols: number; rows: number };
}

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
  private raw: GPUBuffer;
  /** (M4b) its claims (GPU-owned), the bare pass, the reach's last rounds, the records an edit damaged */
  private grid: StaticGrid | null = null;
  private slot: OwnedSlot;
  private gone = false;
  private centreLocal: [number, number];
  private bare: ComputeKernel;
  private bareU: GPUBuffer;
  reachRounds = 0;
  readonly damaged = new Set<number>();
  /** a road point at the core's distance (grid world): where the reach starts — on the town's road, past its centre */
  private seed: [number, number];

  constructor(
    private io: FieldTownIO,
    readonly site: FieldTownSite,
  ) {
    // (M4b: its claim grid in a slot of the static claims' arena — the slot its owner's while it lives)
    const st = io.statics();
    if (!st) throw new Error('citygen: no static claims to own the town\'s columns (the level has no integrity registry)');
    const slot = st.ownedSlot();
    if (!slot) throw new Error(`citygen: no claim slot free for ${site.id} (FieldTowns frees one first)`);
    this.slot = slot;
    // (a game town starts with its core built; the rest grows by claims and time-lapses)
    const L = townLayout(io.device, site, io.wrap, io.sea, { claimInto: slot.binding, vertRoom: TOWN_VERT_ROOM, built: 'core' });
    const { box, centre, local } = L;
    this.centreLocal = centre;
    this.box = box;
    this.raw = L.raw;
    this.gen = L.gen;
    this.params = L.params;
    this.xform = io.device.createBuffer({ label: `citygen ${site.id} place`, size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.place();
    io.addMesh(this.gen.verts, this.gen.args, this.xform);
    this.bare = makeCompute(io.device, 'citygen bare', [commonWgsl, bareWgsl], { 0: 'uniform', 3: 'read', 4: 'rw', 5: 'rw', 6: 'uniform' });
    this.bareU = io.device.createBuffer({ label: `citygen ${site.id} bare`, size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    // (the reach's start: the first road's point at the core's distance — on the road into town, not in the river)
    const road = site.roads.map((l) => l.map(local)).find((l) => l.length > 1) ?? [centre];
    this.seed = road.reduce((b, p) => (Math.abs(Math.hypot(p[0] - centre[0], p[1] - centre[1]) - box.core) < Math.abs(Math.hypot(b[0] - centre[0], b[1] - centre[1]) - box.core) ? p : b), road[0]);
    this.made = io
      .rawGround(box.x0, box.y0, box.w, box.h, this.raw)
      .then(() => {
        if (this.gone) throw new DOMException('citygen: the town was let go', 'AbortError');
        return this.gen.run(this.params, 'field');
      })
      .then((t) => {
        this.times = t;
        this.claim();
        return t;
      });
  }

  /** (M4b) where the grid lies in the window now (columns; z: world z to window z) */
  gridPlace(): GridPlace {
    const [ox, oy] = this.io.origin();
    const { cols, rows } = this.io.wrap;
    return { dx: near(this.box.x0 - ox, cols), dy: near(this.box.y0 - oy, rows), dz: -this.io.oz() };
  }

  /**
   * (M4b) Its claims GPU-owned in the static claims: its claim grid (made with the town, on the GPU) claimed over the
   * window's written land now and as land arrives; the plants cleared under them as they're claimed; the damaged lots
   * told after an edit. Then its reach.
   */
  private claim(): void {
    const st = this.io.statics();
    if (!st) throw new Error('citygen: no static claims to own the town\'s columns (the level has no integrity registry)');
    if (this.gone) return;
    this.grid = st.gpuGrid(`citygen ${this.site.id}`, OWNER_FIELD_TOWN, () => this.gridPlace(), {
      slot: this.slot,
      w: this.box.w,
      h: this.box.h,
      maxKey: REC_LM + LM_ROOM + 1,
      claimed: (rects, p) => this.bareOver(rects, p),
      damaged: (keys) => {
        for (const k of keys) if (k > 0) this.damaged.add(k - 1);
        console.log(`[citygen] ${this.site.name}: an edit damaged ${keys.filter((k) => k > 0).length} building(s)${keys.includes(0) ? ' and its roads' : ''} — records ${keys.filter((k) => k > 0).map((k) => k - 1).join(', ')}`);
      },
    });
    void this.checkReach();
  }

  /** (M4b) the plants under the town's claims cleared in these window rectangles (bare.wgsl) */
  private bareOver(rects: [number, number, number, number][], p: GridPlace): void {
    const d = this.io.device;
    const P = this.io.plants;
    for (const [x0, y0, x1, y1] of rects) {
      if (x1 <= x0 || y1 <= y0) continue;
      const a = new ArrayBuffer(32);
      new Int32Array(a).set([p.dx, p.dy, this.box.w, this.box.h]);
      new Uint32Array(a).set([Math.max(0, x0), Math.max(0, y0), Math.max(0, x1), Math.max(0, y1)], 4);
      // (the uniform written, then its pass submitted: a rectangle a submit)
      d.queue.writeBuffer(this.bareU, 0, a);
      const enc = d.createCommandEncoder({ label: 'citygen bare' });
      const cp = enc.beginComputePass({ label: 'citygen bare' });
      cp.setPipeline(this.bare.pipeline);
      cp.setBindGroup(0, makeBindGroup(d, 'citygen bare', this.bare.layout, { 0: P.globals, 3: this.gen.claimGrid, 4: P.veg, 5: P.vegNext, 6: this.bareU }));
      cp.dispatchWorkgroups(Math.ceil((x1 - x0) / 8), Math.ceil((y1 - y0) / 8));
      cp.end();
      d.queue.submit([enc.finish()]);
    }
  }

  private reachBusy = false;
  /**
   * (M4b) The town's reach over the window (FortressReachGpu: connected components of the walkable surfaces, the town's
   * claims in them) from its road; the buildings it doesn't join outlined red (CityGen.markReach). Nothing read back but
   * the solve's flag a round.
   */
  async checkReach(): Promise<void> {
    if (this.reachBusy) return;
    this.reachBusy = true;
    try {
      // (the window's one reach, a town at a time: its decks written, solved from its road, its marks read)
      await this.io.reachTurn(async () => {
        const r = this.io.reach();
        const p = this.gridPlace();
        const [cx, cy] = cellAt(this.seed[0] + p.dx, this.seed[1] + p.dy * ROW_H);
        if (this.gone || !this.grid || cx < 0 || cy < 0 || cx >= r.w || cy >= r.h) return;
        // (the decks as the reach's plan solid: walked, though not in the world's columns — under the pipes. Under the flow
        // model the decks are claimed into the columns, real solid the reach walks as any ground: trackA-liquids, CG15)
        if (LIQUID !== 'flow') this.gen.deckSpans(r.planSpans, p.dx, p.dy, p.dz, r.w, r.h);
        this.reachRounds = await r.markFrom([cx, cy]);
        if (!this.gone) await this.gen.markReach(r.marks, p.dx, p.dy, r.w, r.h);
      });
    } catch (e) {
      // (let go meanwhile: its generator's gone — nothing to show)
      if (!this.gone) throw e;
    } finally {
      this.reachBusy = false;
    }
  }

  /** the mesh placed in the window as it is now: the box's first column's window world position, z less the window's
   *  oz (16 bytes; a slide, a warp) */
  place(): void {
    const [ox, oy] = this.io.origin();
    const { cols, rows } = this.io.wrap;
    const x = near(this.box.x0 - ox, cols);
    const y = near(this.box.y0 - oy, rows) * ROW_H;
    // (the mesh's heights are world z: the window's z is less its oz)
    this.io.device.queue.writeBuffer(this.xform, 0, new Float32Array([x, y, -this.io.oz(), 0]));
  }

  /** the town's lots for what builds on it (api/contracts/citygen.ts) */
  get lots(): CityLots {
    return { records: this.gen.lotRecords, counts: this.gen.lotCounts, progress: this.gen.progress, place: this.xform };
  }

  /** (time-lapse) the clock it animates till (the town's clock, s), and when its claims were last made again */
  private animUntil = -Infinity;
  private lastClaim = -Infinity;
  private reclaiming = false;

  /**
   * (time-lapse) Each frame, the town's clock (s): while districts are building, the lots' progress and the buildings
   * risen on the GPU (CityGen.animate: one submit, nothing read); every 2 s of it and once at the end, the claim grid
   * made again from the progress and claimed over the window (a mesh run: the claims follow what's risen).
   */
  frame(now: number): void {
    if (this.gone || !this.grid) return;
    const busy = now < this.animUntil;
    if (busy) this.gen.animate(now);
    const due = busy ? now - this.lastClaim > 2 : this.lastClaim < this.animUntil && this.animUntil > -Infinity;
    if (due && !this.reclaiming) {
      this.lastClaim = now;
      this.reclaiming = true;
      this.gen.animate(now);
      void this.gen.run(this.params, 'mesh').then(
        () => {
          this.reclaiming = false;
          this.meshRuns++;
          if (!this.gone && this.grid) this.io.statics()?.reclaim(this.grid);
        },
        (e) => {
          this.reclaiming = false;
          if (!this.gone) throw e;
        },
      );
    }
  }

  /** (time-lapse) every district not begun starts from now, the centre first, over `span` s of the town's clock */
  timelapse(now: number, span: number): void {
    if (this.gone || !this.grid) return;
    this.gen.timelapse(now, span, now);
    this.animUntil = Math.max(this.animUntil, now + span + BUILD_S * 1.75 + 0.5);
  }

  /** (M4d hook) the best district not begun for this purpose (streets.wgsl P_*) started now: its id (−1 none left) */
  async claimDistrict(purpose: number, now: number): Promise<number> {
    if (this.gone) return -1;
    const id = await this.gen.claimDistrict(purpose, now);
    if (id >= 0) this.animUntil = Math.max(this.animUntil, now + BUILD_S * 1.75 + 0.5);
    return id;
  }

  /** (the street skeleton) which main roads show and are walked (citygen/params.ts skelReach, skelMargin,
   *  minorAhead): the mesh run again, the claims after it; the living town's graph follows (meshRuns) */
  setSkeleton(s: { skelReach?: number; skelMargin?: number; minorAhead?: number }): void {
    if (this.gone || !this.times) return;
    Object.assign(this.params, s);
    void this.gen.run(this.params, 'mesh').then(() => {
      this.meshRuns++;
      if (!this.gone && this.grid) this.io.statics()?.reclaim(this.grid);
    });
  }

  /** (living town) mesh runs since it was made: its road raster drawn again (the living town's graph follows) */
  meshRuns = 0;
  /** (living town) its routes' inputs (api/contracts/citygen.ts CityRoutes), its centre in the grid's frame */
  get routes(): CityRoutes {
    return this.gen.routeInputs;
  }
  get centre(): [number, number] {
    return this.centreLocal;
  }

  /** the bytes it holds on the GPU (its generator's buffers and its raw ground; its claim slot is the arena's) */
  get bytes(): number {
    return this.gen.bytes + this.raw.size;
  }

  dispose(): void {
    this.gone = true;
    this.io.statics()?.freeSlot(this.slot);
    this.bareU.destroy();
    this.io.removeMesh(this.gen.args);
    this.gen.dispose();
    this.xform.destroy();
    this.raw.destroy();
  }
}
