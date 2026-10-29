// First (simplest) implementations of each simulation system. Each one is a
// thin wrapper binding a WGSL kernel to WorldGpu contract buffers.

import { ignoreTeardown, makeBindGroup, makeCompute, type BindSpec, type ComputeKernel } from '../gpu/pipeline';
import type { Profiler } from '../gpu/profiler';
import commonWgsl from '../shaders/common.wgsl?raw';
import layersWgsl from '../shaders/layers.wgsl?raw';
import materialsWgsl from '../shaders/materials.wgsl?raw';
import surfaceWgsl from '../shaders/surface.wgsl?raw';
import structureWgsl from '../shaders/structure.wgsl?raw';
import flowWgsl from '../shaders/flow.wgsl?raw';
import slopeWgsl from '../shaders/slope.wgsl?raw';
import oilFluxWgsl from '../shaders/oil_flux.wgsl?raw';
import oilDepthWgsl from '../shaders/oil_depth.wgsl?raw';
import waterFluxWgsl from '../shaders/water_flux.wgsl?raw';
import waterDepthWgsl from '../shaders/water_depth.wgsl?raw';
import contamWgsl from '../shaders/contamination.wgsl?raw';
import moistureWgsl from '../shaders/moisture.wgsl?raw';
import ecologyWgsl from '../shaders/ecology.wgsl?raw';
import renderFieldsWgsl from '../shaders/renderfields.wgsl?raw';
import meshRegionWgsl from '../shaders/meshregion.wgsl?raw';
import meshStateWgsl from '../shaders/meshstate.wgsl?raw';
import terrainShapeWgsl from '../shaders/terrainshape.wgsl?raw';
import fireWgsl from '../shaders/fire.wgsl?raw';
import statsWgsl from '../shaders/stats.wgsl?raw';
import swayWgsl from '../shaders/sway.wgsl?raw';
import wiltWgsl from '../shaders/wilt.wgsl?raw';
import windFieldWgsl from '../shaders/windfield.wgsl?raw';
import sedimentWgsl from '../shaders/sediment.wgsl?raw';
import climateWgsl from '../shaders/climate.wgsl?raw';
import tiersWgsl from '../shaders/tiers.wgsl?raw';
import editWgsl from '../shaders/edit.wgsl?raw';
import placeOpWgsl from '../shaders/placeop.wgsl?raw';
import layerPullWgsl from '../shaders/layerpull.wgsl?raw';
import landBrushWgsl from '../shaders/landbrush.wgsl?raw';
import townStampWgsl from '../shaders/townstamp.wgsl?raw';
import { writeSlot } from '../world/layout';
import { dispatch, type SimSystem } from './system';
import { TILES_BINDING as TILES } from './cull';
import riverHeldWgsl from '../shaders/riverheld.wgsl?raw';
import { RIVERS, RIVER_PULL, RIVER_DEPTH_EXP, RIVER_SPEED_EXP, RIVER_WET_CELLS, STATS_COUNT, type WorldGpu } from './world-gpu';

/** (round 84) riverheld.wgsl with its constants: the atlas's rivers held at their steady state (world-gpu riverFlow) */
/**
 * (round 104, simscale) With ?rivers=table the water is dispatched over the live chunks, those next to them, and the
 * rest on a slow turn every RIVER_SLOW_N ticks (sim/cull.ts NEAR): a held river asleep only follows the rivers'
 * wetness (the climate's), slowly — off from anything live it relaxes RIVER_SLOW_N steps at once (water_depth.wgsl).
 * ?riverslow=1: every tick everywhere, as before.
 */
const RIVER_SLOW_N = (() => {
  const v = typeof location === 'undefined' ? null : new URLSearchParams(location.search).get('riverslow');
  const n = v === null ? 15 : Number(v);
  if (!(n >= 1 && Number.isInteger(n))) throw new Error(`?riverslow=${v}: ticks between a far river's updates, 1 or more`);
  return n;
})();
const RIVER_SLOW = SIM_CULL && RIVERS === 'table' && RIVER_SLOW_N > 1;
const riverHeld = `const RIVER_SLOW_N: u32 = ${RIVER_SLOW ? RIVER_SLOW_N : 1}u;
const RIVER_TABLE: bool = ${RIVERS === 'table'};
const RIVER_DEPTH_EXP: f32 = ${RIVER_DEPTH_EXP};
const RIVER_SPEED_EXP: f32 = ${RIVER_SPEED_EXP};
const RIVER_PULL: f32 = ${RIVER_PULL};
const RIVER_WET_CELLS: f32 = ${RIVER_WET_CELLS};
` + riverHeldWgsl;
import { SETTLE, SLEEP_MORE } from './sleep';
import { FLOW_SUB, WIND_K, fieldPass, fieldPeriod, flowConst, flowN } from './flow';
import { LIVE, NEAR, SIM_CULL, cullKernel, dispatchTiles } from './cull';
import { WindRects } from './windrect';
import { EventKind, type GlobalsState, type WorldEvent } from './globals';

/**
 * (round 104, simscale) ?windbox=0: the wind field over its whole texture every update, as before. On: the painted
 * wind updated only where something painted it lately (sim/windrect.ts), the map's own wind under it refreshed a band
 * an update — all of it every WIND_BANDS updates (?windbands=N).
 */
const WIND_BOX = typeof location === 'undefined' || new URLSearchParams(location.search).get('windbox') !== '0';
const WIND_BANDS = (() => {
  const v = typeof location === 'undefined' ? null : new URLSearchParams(location.search).get('windbands');
  const n = v === null ? 16 : Number(v);
  if (!(n >= 1 && Number.isInteger(n))) throw new Error(`?windbands=${v}: a whole number of bands, 1 or more`);
  return n;
})();

/**
 * (perfopt, ?inplace=1) The passes that rewrite whole columns — the editor's brush, the structures, the layer
 * pulls — write the layers in place instead of into layersNext copied back whole (16 MB a tick each in the atlas's
 * window: on a phone the bandwidth of the copies alone was a share of the frame). Each thread rewrites only its
 * own column (the structures read their neighbours' support: one tick's Gauss-Seidel instead of Jacobi). With
 * it the brush runs only while an edit is in flight (a pour lands for up to ~4 s after the press).
 */
export const INPLACE = typeof location !== 'undefined' && new URLSearchParams(location.search).get('inplace') === '1';
/** a column pass's code and its two layer bindings, in place or not */
const columnPass = (code: string, world: WorldGpu) =>
  INPLACE ? { code: code.replaceAll('layersIn[', 'layersOut['), in: world.layersNext, out: world.layers } : { code, in: world.layers, out: world.layersNext };
/** (perfopt, inplace) ticks the brush runs after an edit (the longest pour's fall, 3.9 s, and some) */
const EDIT_LINGER = 300;

const BASE: BindSpec = { 0: 'uniform', 1: 'read', 2: 'uniform' };
const WITH_ALL = [commonWgsl, layersWgsl, materialsWgsl];

/** Builds a single-kernel system whose bindings 0..2 are the shared globals/chunks/materials. */
function kernel(
  device: GPUDevice,
  world: WorldGpu,
  label: string,
  src: string,
  spec: BindSpec,
  buffers: Record<number, GPUBuffer | GPUTextureView>,
  /** Bind the chunk table (layers.wgsl). Off for kernels that never touch layers,
   *  so they don't spend one of the 8 storage-buffer slots on it. */
  useLayers = false,
  /** (round 85, simcull — sim/cull.ts) a pass that skips sleeping chunks: dispatched over the live ones only,
   *  the list for this flow's sleeping rate (LIVE: none) */
  cull?: number,
) {
  let parts = useLayers ? [...WITH_ALL, src] : [commonWgsl, materialsWgsl, src];
  const base: BindSpec = useLayers ? BASE : { 0: 'uniform', 2: 'uniform' };
  let all: BindSpec = { ...base, ...spec };
  const bound: Record<number, GPUBuffer | GPUTextureView> = { 0: world.globals, 2: world.materials, ...buffers };
  const culled = cull !== undefined && world.tiles !== null;
  if (culled) {
    const c = cullKernel(world.tiles!, parts.join('\n'), all, 'main', cull);
    parts = [c.code];
    all = c.spec;
    bound[TILES] = c.buf;
  }
  const k = makeCompute(device, label, parts, all);
  if (useLayers) bound[1] = world.chunks;
  const group = makeBindGroup(device, label, k.layout, bound);
  return { k, group, cull: culled ? cull : undefined };
}

/** a kernel() pass, over the live chunks when it's culled (sim/cull.ts), else the whole window */
function run(enc: GPUCommandEncoder, prof: Profiler, name: string, s: { k: ComputeKernel; group: GPUBindGroup; cull?: number }, world: WorldGpu): void {
  if (s.cull !== undefined) dispatchTiles(enc, prof, name, s.k, s.group, world.tiles!, s.cull);
  else dispatch(enc, prof, name, s.k, s.group, world.groups);
}

/** a ping-pong field's copy back (next -> current, `words` u32 a column): over the live chunks when culled */
function copyBack(enc: GPUCommandEncoder, prof: Profiler, world: WorldGpu, src: GPUBuffer, dst: GPUBuffer, words: number, cull: number | undefined): void {
  if (cull !== undefined) world.tileCopy!.copy(enc, prof, src, dst, words, cull);
  else enc.copyBufferToBuffer(src, 0, dst, 0, dst.size);
}

export class SurfaceSystem implements SimSystem {
  readonly name = 'surface';
  readonly period = 1;
  private s;
  constructor(device: GPUDevice, private world: WorldGpu, private prof: Profiler) {
    this.s = kernel(
      device,
      world,
      'surface',
      `const SLEEP_MORE: bool = ${SLEEP_MORE};
` + surfaceWgsl,
      { 3: 'read', 4: 'rw', 16: 'stex', 19: 'tex', 20: 'stex', 28: 'tex', 30: 'stex' },
      { 3: world.layers, 4: world.surface, 16: world.driftView, 19: world.airView, 20: world.strataView, 28: world.projView, 30: world.levelsView },
      true,
      // (it skips sleeping chunks only with ?sleepmore=1)
      SLEEP_MORE ? LIVE : undefined,
    );
  }
  encode(enc: GPUCommandEncoder): void {
    run(enc, this.prof, this.name, this.s, this.world);
  }
}

export class StructureSystem implements SimSystem {
  readonly name = 'structure';
  readonly period = 1;
  private s;
  constructor(device: GPUDevice, private world: WorldGpu, private prof: Profiler) {
    this.s = kernel(
      device,
      world,
      'structure',
      columnPass(structureWgsl, world).code + flowWgsl,
      { 3: 'read', 4: 'rw', 5: 'rw', 6: 'read', 7: 'read', 8: 'read', 9: 'read' },
      { 3: columnPass('', world).in, 4: columnPass('', world).out, 5: world.stats, 6: world.surface, 7: world.water, 8: world.flux, 9: world.fire },
      true,
      LIVE,
    );
  }
  encode(enc: GPUCommandEncoder): void {
    run(enc, this.prof, this.name, this.s, this.world);
    if (!INPLACE) enc.copyBufferToBuffer(this.world.layersNext, 0, this.world.layers, 0, this.world.layers.size);
  }
}

/**
 * (perfopt, round 83 — the user: "all generators make a steady state so when we arrive nothing is simulated until
 * the player interacts with it") With ?settle=0, land come in is drowsy for a few ticks (sim/sleep.ts) and, asleep,
 * would freeze its water as the generator wrote it — a river filled to its level, not to what its springs keep it
 * at, so it rushed off downstream when anything woke it. While any chunk is drowsy, each tick runs SETTLE_ITERS more
 * water passes over the drowsy columns only (the pipes at the 60 Hz step): the new land's water settles, its flux
 * becomes the flow the river keeps, and then it's frozen so. ?settleiters=N (0 off).
 */
const SETTLE_ITERS = (() => {
  const q = typeof location === 'undefined' ? null : new URLSearchParams(location.search).get('settleiters');
  return q !== null ? Math.max(0, Number(q) | 0) : 0;
})();

export class WaterSystem implements SimSystem {
  readonly name = 'water';
  readonly period = 1;
  private flux;
  private depth;
  private settleFlux;
  private settleDepth;
  /** (perfopt) the rects of land come in still settling (columns: x, y, w, h; Simulation.step sets them) */
  settling: [number, number, number, number][] = [];
  /** its uniform (water_flux.wgsl, water_depth.wgsl SR) */
  private rect: GPUBuffer;
  /** the first half of a settling iteration (water → the next buffer): the tick's own kernels with the rect */
  private settleA?: { flux: ComputeKernel; fg: GPUBindGroup; depth: ComputeKernel; dg: GPUBindGroup };
  constructor(private device: GPUDevice, private world: WorldGpu, private prof: Profiler) {
    this.rect = device.createBuffer({ label: 'water settle rect', size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    // (simcull: not with ?rivers=table — a held river's columns are simulated asleep, riverheld.wgsl: they relax to
    // the atlas's table and their flux follows, and the flux pass's cost is theirs. A list of the chunks with rivers
    // made on the GPU each tick cost more (0.04 ms a frame) than the water's passes over the rest saved.)
    // (round 104, simscale: with rivers=table, the live chunks, those beside them and the rest's slow turns — NEAR)
    const tiles = RIVERS === 'table' ? (RIVER_SLOW ? NEAR + RIVER_SLOW_N : undefined) : flowN('water');
    const fluxK = (settle: boolean) =>
      kernel(
        device,
        world,
        settle ? 'water-settle-flux' : 'water-flux',
        `const FLUX_SEED: bool = ${!SETTLE};\nconst SETTLE_PASS: bool = ${settle};\n` + flowConst('water') + waterFluxWgsl + riverHeld,
        { 3: 'read', 4: 'read', 5: 'rw', 6: 'read', 17: 'tex', 21: 'tex', 22: 'tex', 62: 'tex', 31: 'uniform' },
        { 3: world.surface, 4: settle ? world.waterNext : world.water, 5: world.flux, 6: world.oil, 17: world.driftView, 21: world.bodyProjView, 22: world.riverFlowView, 62: world.riverWetView, 31: this.rect },
        false,
        settle ? undefined : tiles,
      );
    const depthK = (settle: boolean) =>
      kernel(
        device,
        world,
        settle ? 'water-settle-depth' : 'water-depth',
        `const SETTLE_PASS: bool = ${settle};\n` + flowConst('water') + waterDepthWgsl + riverHeld,
        { 3: 'read', 4: 'read', 5: 'read', 6: 'rw', 7: 'rw', 8: 'read', 9: 'rw', 22: 'tex', 62: 'tex', 31: 'uniform' },
        // (a settling pass's second half: from the next buffer back into the water — the passes ping-pong)
        { 3: settle ? world.waterNext : world.water, 4: world.flux, 5: world.waterSource, 6: settle ? world.water : world.waterNext, 7: world.waterPrev, 8: world.surface, 9: world.waterChange, 22: world.riverFlowView, 62: world.riverWetView, 31: this.rect },
        false,
        settle ? undefined : tiles,
      );
    // (the settling passes read the next buffer as the water everywhere: a culled tick leaves it stale asleep)
    if (SETTLE_ITERS && world.tiles) throw new Error('?settleiters= needs ?simcull=0: the settling passes read the next buffer as the water everywhere');
    this.flux = fluxK(false);
    this.depth = depthK(false);
    // (settling: B — flux from the next buffer, depth from it back into the water; A — the same kernels with the
    // buffers the other way round, so an iteration is A then B and ends in the water, no copies)
    this.settleFlux = SETTLE_ITERS ? fluxK(true) : undefined;
    this.settleDepth = SETTLE_ITERS ? depthK(true) : undefined;
    if (this.settleFlux && this.settleDepth) {
      const f = this.settleFlux.k;
      const d = this.settleDepth.k;
      this.settleA = {
        flux: f,
        fg: makeBindGroup(device, 'water-settle-flux-a', f.layout, { 0: world.globals, 2: world.materials, 3: world.surface, 4: world.water, 5: world.flux, 6: world.oil, 17: world.driftView, 21: world.bodyProjView, 22: world.riverFlowView, 62: world.riverWetView, 31: this.rect }),
        depth: d,
        dg: makeBindGroup(device, 'water-settle-depth-a', d.layout, { 0: world.globals, 2: world.materials, 3: world.water, 4: world.flux, 5: world.waterSource, 6: world.waterNext, 7: world.waterPrev, 8: world.surface, 9: world.waterChange, 22: world.riverFlowView, 62: world.riverWetView, 31: this.rect }),
      };
    }
  }
  encode(enc: GPUCommandEncoder): void {
    // (perfopt: land just come in settles first, in one pass over its rect, the tick's own passes after — what the
    // others read is theirs. The next buffer holds the water at the tick's start everywhere (the last tick's depth
    // pass wrote all of it, then it was copied over), so outside the rect the two agree throughout.)
    // (one rect a tick — the oldest first: a slide's strips settle one after another)
    const r = this.settling[0];
    if (r && this.settleFlux && this.settleDepth && this.settleA) {
      this.device.queue.writeBuffer(this.rect, 0, new Uint32Array([Math.max(0, r[0]), Math.max(0, r[1]), r[2] + Math.min(0, r[0]), r[3] + Math.min(0, r[1])]));
      const A = this.settleA;
      const gx = Math.ceil(r[2] / 8);
      const gy = Math.ceil(r[3] / 8);
      const pass = enc.beginComputePass({ label: 'water-settle', timestampWrites: this.prof.timestamps('water-settle') });
      for (let s = 0; s < SETTLE_ITERS; s++) {
        pass.setPipeline(A.flux.pipeline);
        pass.setBindGroup(0, A.fg);
        pass.dispatchWorkgroups(gx, gy);
        pass.setPipeline(A.depth.pipeline);
        pass.setBindGroup(0, A.dg);
        pass.dispatchWorkgroups(gx, gy);
        pass.setPipeline(this.settleFlux.k.pipeline);
        pass.setBindGroup(0, this.settleFlux.group);
        pass.dispatchWorkgroups(gx, gy);
        pass.setPipeline(this.settleDepth.k.pipeline);
        pass.setBindGroup(0, this.settleDepth.group);
        pass.dispatchWorkgroups(gx, gy);
      }
      pass.end();
    }
    // (perfopt, simhz: the pipes stable only at the 60 Hz step — FLOW_SUB of them a tick, sim/flow.ts)
    for (let s = 0; s < FLOW_SUB; s++) {
      run(enc, this.prof, 'water-flux', this.flux, this.world);
      run(enc, this.prof, 'water-depth', this.depth, this.world);
      copyBack(enc, this.prof, this.world, this.world.waterNext, this.world.water, 1, this.depth.cull);
    }
  }
}

export class OilSystem implements SimSystem {
  readonly name = 'oil';
  readonly period = 1;
  private flux;
  private depth;
  constructor(device: GPUDevice, private world: WorldGpu, private prof: Profiler) {
    this.flux = kernel(
      device,
      world,
      'oil-flux',
      flowConst('oil') + oilFluxWgsl,
      { 3: 'read', 4: 'read', 5: 'read', 6: 'rw', 7: 'read', 17: 'tex' },
      { 3: world.surface, 4: world.water, 5: world.oil, 6: world.oilFlux, 7: world.flux, 17: world.driftView },
      false,
      flowN('oil'),
    );
    this.depth = kernel(
      device,
      world,
      'oil-depth',
      flowConst('oil') + oilDepthWgsl,
      { 3: 'read', 4: 'read', 5: 'rw', 6: 'read', 7: 'rw', 8: 'read', 9: 'read', 10: 'rw', 17: 'tex' },
      { 3: world.oil, 4: world.oilFlux, 5: world.oilNext, 6: world.water, 7: world.contamDelta, 8: world.surface, 9: world.fire, 10: world.oilStored, 17: world.driftView },
      false,
      flowN('oil'),
    );
  }
  encode(enc: GPUCommandEncoder): void {
    for (let s = 0; s < FLOW_SUB; s++) {
      run(enc, this.prof, 'oil-flux', this.flux, this.world);
      run(enc, this.prof, 'oil-depth', this.depth, this.world);
      copyBack(enc, this.prof, this.world, this.world.oilNext, this.world.oil, 1, this.depth.cull);
    }
  }
}

const CONTAM_P = fieldPeriod(1);
const MOIST_P = fieldPeriod(1);
const ECO_P = fieldPeriod(15);
const CLIMATE_P = fieldPeriod(4);

export class ContaminationSystem implements SimSystem {
  readonly name = 'contamination';
  // (perfopt, ?fieldhz=: sim/flow.ts)
  readonly period = CONTAM_P.period;
  private s;
  constructor(device: GPUDevice, private world: WorldGpu, private prof: Profiler) {
    this.s = kernel(
      device,
      world,
      'contamination',
      fieldPass(contamWgsl, CONTAM_P.k) + flowWgsl,
      { 3: 'read', 4: 'read', 5: 'read', 6: 'read', 7: 'rw', 8: 'read', 9: 'rw' },
      { 3: world.waterPrev, 4: world.water, 5: world.flux, 6: world.contam, 7: world.contamNext, 8: world.veg, 9: world.contamDelta },
      false,
      LIVE,
    );
  }
  encode(enc: GPUCommandEncoder): void {
    run(enc, this.prof, this.name, this.s, this.world);
    copyBack(enc, this.prof, this.world, this.world.contamNext, this.world.contam, 2, this.s.cull);
  }
}

export class MoistureSystem implements SimSystem {
  readonly name = 'moisture';
  readonly period = MOIST_P.period;
  private s;
  constructor(device: GPUDevice, private world: WorldGpu, private prof: Profiler) {
    this.s = kernel(
      device,
      world,
      'moisture',
      fieldPass(moistureWgsl, MOIST_P.k) + slopeWgsl,
      { 3: 'read', 4: 'read', 5: 'rw', 6: 'read', 7: 'read', 17: 'tex' },
      { 3: world.water, 4: world.moisture, 5: world.moistureNext, 6: world.veg, 7: world.surface, 17: world.driftView },
      false,
      LIVE,
    );
  }
  encode(enc: GPUCommandEncoder): void {
    run(enc, this.prof, this.name, this.s, this.world);
    copyBack(enc, this.prof, this.world, this.world.moistureNext, this.world.moisture, 1, this.s.cull);
  }
}

/** Plant health: ground hostility + brownness (wilt.wgsl); runs just before ecology. */
export class WiltSystem implements SimSystem {
  readonly name = 'wilt';
  // every tick: grow-taps are one-tick events
  readonly period = 1;
  private s;
  constructor(device: GPUDevice, private world: WorldGpu, private prof: Profiler) {
    this.s = kernel(
      device,
      world,
      'wilt',
      wiltWgsl,
      { 3: 'read', 4: 'read', 5: 'read', 6: 'read', 7: 'read', 8: 'read', 9: 'read', 10: 'rw', 15: 'tex', 17: 'tex' },
      { 3: world.surface, 4: world.contam, 5: world.moisture, 6: world.water, 7: world.veg, 8: world.oil, 9: world.fire, 10: world.wilt, 15: world.windFieldView, 17: world.driftView },
      false,
      LIVE,
    );
  }
  encode(enc: GPUCommandEncoder): void {
    run(enc, this.prof, this.name, this.s, this.world);
  }
}

export class EcologySystem implements SimSystem {
  readonly name = 'ecology';
  readonly period = ECO_P.period;
  private s;
  constructor(device: GPUDevice, private world: WorldGpu, private prof: Profiler) {
    this.s = kernel(
      device,
      world,
      'ecology',
      tiersWgsl + fieldPass(ecologyWgsl, ECO_P.k) + slopeWgsl,
      { 3: 'read', 4: 'read', 5: 'read', 6: 'read', 7: 'read', 8: 'rw', 10: 'read', 17: 'tex', 50: 'tex' },
      { 3: world.surface, 4: world.wilt, 5: world.moisture, 6: world.water, 7: world.veg, 8: world.vegNext, 10: world.fire, 17: world.driftView, 50: world.tierView },
      false,
      LIVE,
    );
  }
  encode(enc: GPUCommandEncoder): void {
    run(enc, this.prof, this.name, this.s, this.world);
    copyBack(enc, this.prof, this.world, this.world.vegNext, this.world.veg, 1, this.s.cull);
  }
}

/** Packs render-only fields (shadow, moisture, fire glow, flow) for the draw shaders. */
export class RenderFieldsSystem implements SimSystem {
  readonly name = 'renderfields';
  readonly period = 2;
  private s;
  constructor(device: GPUDevice, private world: WorldGpu, private prof: Profiler) {
    this.s = kernel(
      device,
      world,
      'renderfields',
      terrainShapeWgsl + meshStateWgsl + meshRegionWgsl + `const SLEEP_MORE: bool = ${SLEEP_MORE};
` + renderFieldsWgsl + flowWgsl + riverHeld,
      { 3: 'read', 4: 'read', 5: 'read', 6: 'read', 7: 'rw', 8: 'read', 9: 'read', 10: 'read', 16: 'stex', 17: 'tex', 22: 'tex', 62: 'tex', 30: 'uniform' },
      { 3: world.surface, 4: world.moisture, 5: world.fire, 6: world.flux, 7: world.renderFields, 8: world.water, 9: world.veg, 10: world.lava, 16: world.cornerView, 17: world.driftView, 22: world.riverFlowView, 62: world.riverWetView, 30: world.meshRegion },
      false,
      // (round 104, simscale: with ?sleepmore=1 it skips a sleeping chunk but a drowsy one — the live list exactly —
      // so it's dispatched over the live chunks only; the field mesh's region is always set, MR.n.w 1)
      SLEEP_MORE ? LIVE : undefined,
    );
  }
  encode(enc: GPUCommandEncoder): void {
    run(enc, this.prof, this.name, this.s, this.world);
  }
}

/** The player's persistent wind field (windfield.wgsl): advect, spread, decay, stamp strokes. */
export class WindFieldSystem implements SimSystem {
  readonly name = 'windfield';
  // (perfopt, ?windhz=: every WIND_K ticks, each update the time since — sim/flow.ts)
  readonly period = WIND_K;
  private k: ComputeKernel;
  /** (round 104, simscale) a uniform and its bind group per dispatch of a tick: the painted box, the band, strips */
  private slots: { buf: GPUBuffer; group: GPUBindGroup }[] = [];
  /** where the painted wind is (sim/windrect.ts); null: ?windbox=0, the whole field every update as before */
  readonly rects: WindRects | null;
  /** (simscale) while any says so, the whole field is painted (physics: things landing shove the air anywhere) */
  readonly wholeWhile: (() => boolean)[] = [];
  /** the next band of the map's own wind to refresh */
  private band = 0;
  /** texel rects of land just come in (a slide's strips): their map wind made at the next update */
  private fresh: [number, number, number, number][] = [];
  /** the last update's painted box (the perf overlay, tests) */
  lastBox: [number, number, number, number] | null = null;
  private tw: number;
  private th: number;
  constructor(private device: GPUDevice, private world: WorldGpu, private prof: Profiler) {
    this.tw = world.windField.width;
    this.th = world.windField.height;
    this.k = makeCompute(device, 'windfield', [commonWgsl, materialsWgsl, `const WIND_K: f32 = ${WIND_K}.0;
` + windFieldWgsl], { 0: 'uniform', 2: 'uniform', 15: 'tex', 16: 'stex', 30: 'read', 31: 'read', 32: 'uniform' });
    this.rects = WIND_BOX ? new WindRects(this.tw, this.th, FLOW_SUB) : null;
  }
  private slot(i: number): { buf: GPUBuffer; group: GPUBindGroup } {
    let s = this.slots[i];
    if (!s) {
      const buf = this.device.createBuffer({ label: `windfield rect ${i}`, size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      const w = this.world;
      s = { buf, group: makeBindGroup(this.device, `windfield ${i}`, this.k.layout, { 0: w.globals, 2: w.materials, 15: w.windFieldView, 16: w.windFieldNextView, 30: w.physPuff, 31: w.windBlows, 32: buf }) };
      this.slots[i] = s;
    }
    return s;
  }
  /** this tick's painting (Simulation.step): the player's strokes and the clicks' ripples */
  collect(g: GlobalsState, sent: readonly WorldEvent[], tick: number): void {
    const r = this.rects;
    if (!r) return;
    for (const gg of g.gusts.slice(1)) {
      if (!(gg.strength > 0) || !(gg.len ?? 0)) continue;
      const len = gg.len ?? 0;
      // (a segment ending at (x, y), len back along (dx, dy))
      r.stir(gg.x - (gg.dx * len) / 2, gg.y - (gg.dy * len) / 2, gg.radius + len / 2, tick);
    }
    for (const e of sent) if (e.kind === EventKind.Ripple) r.stir(e.x, e.y, e.radius, tick);
    if (this.wholeWhile.some((f) => f())) r.stirAll(tick);
  }
  /** the window slid (columns, rows): the painted boxes go with it, the strips come in get their map wind */
  shift(dx: number, dy: number): void {
    const tx = Math.round(dx / 2);
    const ty = Math.round(dy / 2);
    this.rects?.shift(tx, ty);
    if (tx > 0) this.fresh.push([this.tw - tx, 0, this.tw, this.th]);
    if (tx < 0) this.fresh.push([0, 0, -tx, this.th]);
    if (ty > 0) this.fresh.push([0, this.th - ty, this.tw, this.th]);
    if (ty < 0) this.fresh.push([0, 0, this.tw, -ty]);
  }
  private run(enc: GPUCommandEncoder, i: number, r: [number, number, number, number], mode: number): void {
    const [x0, y0, x1, y1] = r;
    if (x1 <= x0 || y1 <= y0) return;
    const s = this.slot(i);
    this.device.queue.writeBuffer(s.buf, 0, new Uint32Array([x0, y0, mode, 0]));
    dispatch(enc, this.prof, this.name, this.k, s.group, [Math.ceil((x1 - x0) / 8), Math.ceil((y1 - y0) / 8)]);
    // (round 105, ringwin: the rectangle where it lies, cut at the ring's seam)
    for (const q of this.world.ring.pieces(x0, y0, x1, y1, true)) enc.copyTextureToTexture({ texture: this.world.windFieldNext, origin: { x: q.px, y: q.py } }, { texture: this.world.windField, origin: { x: q.px, y: q.py } }, [q.w, q.h]);
  }
  encode(enc: GPUCommandEncoder, tick = 0): void {
    if (!this.rects) {
      this.run(enc, 0, [0, 0, this.tw, this.th], 0);
      return;
    }
    let i = 0;
    // the painted wind, where it is
    const box = (this.lastBox = this.rects.box(tick));
    if (box) this.run(enc, i++, box, 0);
    // the map's own wind under it everywhere else: a band an update (all of it every WIND_BANDS updates), and the
    // land just come in at once
    const rows = Math.ceil(this.th / WIND_BANDS);
    const b0 = this.band * rows;
    this.band = (this.band + 1) % WIND_BANDS;
    this.run(enc, i++, [0, b0, this.tw, Math.min(this.th, b0 + rows)], 1);
    for (const f of this.fresh.splice(0)) this.run(enc, i++, [Math.max(0, f[0]), Math.max(0, f[1]), Math.min(this.tw, f[2]), Math.min(this.th, f[3])], 1);
  }
  /** (prime) the whole field made at once: the map's own wind everywhere, before anything reads it */
  prime(enc: GPUCommandEncoder): void {
    this.run(enc, 0, [0, 0, this.tw, this.th], this.rects ? 1 : 0);
  }
}

/** The sandbox editor's brush (edit.wgsl): applies EV_EDIT events to layers and fields. */
export class EditSystem implements SimSystem {
  readonly name = 'edit';
  // every tick: brush strokes are one-tick events
  readonly period = 1;
  private s;
  constructor(device: GPUDevice, private world: WorldGpu, private prof: Profiler) {
    this.s = kernel(
      device,
      world,
      'edit',
      columnPass(editWgsl, world).code,
      { 3: 'read', 4: 'rw', 5: 'rw', 6: 'rw', 7: 'rw', 8: 'rw', 9: 'rw', 16: 'stex', 17: 'tex', 18: 'tex', 26: 'stex' },
      { 3: columnPass('', world).in, 4: columnPass('', world).out, 5: world.water, 6: world.oil, 7: world.contam, 8: world.veg, 9: world.deposit, 16: world.editStateNextView, 17: world.driftView, 18: world.editStateView, 26: world.editResultView },
      true,
      LIVE,
    );
  }
  /** The tick carries an edit. */
  pending = false;
  /** Run every tick (the sandbox: pours keep landing after the press). */
  always = false;
  /** (perfopt, inplace) ticks since the last edit: with `always`, the brush runs EDIT_LINGER ticks after one */
  private idle = 1e9;
  encode(enc: GPUCommandEncoder): void {
    this.idle = this.pending ? 0 : this.idle + 1;
    if (!this.pending && !(this.always && (!INPLACE || this.idle < EDIT_LINGER))) return;
    this.pending = false;
    run(enc, this.prof, this.name, this.s, this.world);
    if (!INPLACE) enc.copyBufferToBuffer(this.world.layersNext, 0, this.world.layers, 0, this.world.layers.size);
    const size = [this.world.w, this.world.h];
    enc.copyTextureToTexture({ texture: this.world.editStateNext }, { texture: this.world.editState }, size);
  }
}

/**
 * The loose ground in the layers (sediment.wgsl): wind carries it, shelter
 * piles it, water washes and pipes through it, slopes slump to their repose,
 * granular intervals over air fall. Reads the view the surface pass derives.
 */
export class SedimentSystem implements SimSystem {
  readonly name = 'sediment';
  readonly period = 2;
  private out;
  private s;
  constructor(device: GPUDevice, private world: WorldGpu, private prof: Profiler) {
    // (round 108, simtiers: tiers.wgsl, the slow processes' rates — binding 50)
    const parts = [commonWgsl, layersWgsl, materialsWgsl, tiersWgsl + flowConst('sediment') + sedimentWgsl + flowWgsl];
    const tex = { 50: world.tierView, 15: world.windFieldView, 17: world.driftView, 19: world.strataView, 21: world.bodyProjView, 28: world.projView, 29: world.levelsView, 30: world.shakeView };
    const outSpec: BindSpec = { 0: 'uniform', 1: 'read', 2: 'uniform', 3: 'rw', 4: 'read', 6: 'read', 7: 'read', 9: 'read', 10: 'rw', 11: 'read', 15: 'tex', 17: 'tex', 19: 'tex', 21: 'tex', 28: 'tex', 29: 'tex', 30: 'tex', 50: 'tex' };
    const outRes: Record<number, GPUBuffer | GPUTextureView> = { 0: world.globals, 1: world.chunks, 2: world.materials, 3: world.layers, 4: world.water, 6: world.flux, 7: world.veg, 9: world.moisture, 10: world.sedOut, 11: world.surface, ...tex };
    const n = flowN('sediment');
    const c = world.tiles ? cullKernel(world.tiles, parts.join('\n'), outSpec, 'outflow', n) : null;
    if (c) outRes[TILES] = c.buf;
    const outK = c ? makeCompute(device, 'sediment-out', [c.code], c.spec, 'outflow') : makeCompute(device, 'sediment-out', parts, outSpec, 'outflow');
    this.out = { k: outK, group: makeBindGroup(device, 'sediment-out', outK.layout, outRes), cull: c ? n : undefined };
    this.s = kernel(
      device,
      world,
      'sediment',
      tiersWgsl + flowConst('sediment') + sedimentWgsl + flowWgsl,
      { 3: 'rw', 5: 'rw', 7: 'read', 8: 'rw', 10: 'rw', 15: 'tex', 16: 'stex', 17: 'tex', 18: 'tex', 19: 'tex', 21: 'tex', 28: 'tex', 29: 'tex', 30: 'tex', 50: 'tex' },
      { 3: world.layers, 5: world.deposit, 7: world.veg, 8: world.contamDelta, 10: world.sedOut, 16: world.airView, 18: world.editStateView, ...tex },
      true,
      flowN('sediment'),
    );
  }
  encode(enc: GPUCommandEncoder): void {
    run(enc, this.prof, 'sediment-out', this.out, this.world);
    run(enc, this.prof, this.name, this.s, this.world);
  }
}

/**
 * The climate (round 50, climate.wgsl): snow from cold storms, snow and ice
 * melting, water freezing, trees dropping leaves that rot into soil — by the
 * air's temperature (Globals climate) and the heat of lava and fire.
 */
export class ClimateSystem implements SimSystem {
  readonly name = 'climate';
  readonly period = CLIMATE_P.period;
  private s;
  constructor(device: GPUDevice, private world: WorldGpu, private prof: Profiler) {
    this.s = kernel(
      device,
      world,
      'climate',
      tiersWgsl + fieldPass(climateWgsl, CLIMATE_P.k),
      { 3: 'rw', 4: 'rw', 5: 'rw', 6: 'read', 7: 'read', 8: 'read', 9: 'read', 50: 'tex' },
      { 3: world.layers, 4: world.water, 5: world.deposit, 6: world.veg, 7: world.moisture, 8: world.fire, 9: world.lava, 50: world.tierView },
      true,
      LIVE,
    );
  }
  encode(enc: GPUCommandEncoder): void {
    run(enc, this.prof, this.name, this.s, this.world);
  }
}

/** Vegetation sway springs (render-only state with memory; sway.wgsl). */
export class SwaySystem implements SimSystem {
  readonly name = 'sway';
  readonly period = 1;
  private s;
  constructor(device: GPUDevice, private world: WorldGpu, private prof: Profiler) {
    this.s = kernel(device, world, 'sway', swayWgsl, { 3: 'read', 4: 'rw', 15: 'tex' }, { 3: world.surface, 4: world.bend, 15: world.windFieldView });
  }
  encode(enc: GPUCommandEncoder): void {
    dispatch(enc, this.prof, this.name, this.s.k, this.s.group, this.world.groups);
  }
}

export class FireSystem implements SimSystem {
  readonly name = 'fire';
  // every tick: it must see one-tick lightning events
  readonly period = 1;
  private s;
  constructor(device: GPUDevice, private world: WorldGpu, private prof: Profiler) {
    this.s = kernel(
      device,
      world,
      'fire',
      fireWgsl,
      { 3: 'read', 4: 'rw', 5: 'read', 6: 'read', 7: 'read', 8: 'read', 9: 'read', 10: 'read', 15: 'tex', 22: 'tex' },
      { 3: world.fire, 4: world.fireNext, 5: world.oil, 6: world.veg, 7: world.moisture, 8: world.water, 9: world.surface, 10: world.oilStored, 15: world.windFieldView, 22: world.sparkView },
      false,
      LIVE,
    );
  }
  encode(enc: GPUCommandEncoder): void {
    run(enc, this.prof, this.name, this.s, this.world);
    copyBack(enc, this.prof, this.world, this.world.fireNext, this.world.fire, 1, this.s.cull);
  }
}

/** Indices into the stats buffer (see stats.wgsl). */
export const STAT = {
  soilContam: 0,
  dissolved: 1,
  vegCells: 2,
  vegSum: 3,
  waterVolume: 4,
  flow: 5,
  cleanCells: 6,
  wetCells: 7,
  matureCells: 8,
  oil: 9,
  fire: 10,
  drowning: 11,
  cleanLand: 12,
  litter: 13,
  collapsed: 14,
  overflow: 15,
} as const;

export interface WorldStats {
  soilContam: number;
  dissolved: number;
  vegCells: number;
  vegMean: number;
  waterVolume: number;
  flow: number;
  cleanCells: number;
  wetCells: number;
  matureCells: number;
  oilVolume: number;
  fireCells: number;
  /** living cells under standing water (they die back; Nature pays) */
  drowningCells: number;
  /** cells with no poison, oil, trash or litter */
  cleanLand: number;
  litterCells: number;
  collapsed: number;
  overflow: number;
  cells: number;
}

/** Aggregates world state on the GPU and reads it back asynchronously (small, infrequent). */
export class StatsSystem implements SimSystem {
  readonly name = 'stats';
  readonly period = 20;
  private s;
  private staging: { buf: GPUBuffer; busy: boolean }[] = [];
  latest?: WorldStats;
  private pendingMaps: (() => void)[] = [];

  constructor(device: GPUDevice, private world: WorldGpu, private prof: Profiler) {
    this.s = kernel(
      device,
      world,
      'stats',
      statsWgsl,
      { 3: 'read', 4: 'read', 5: 'read', 6: 'read', 7: 'rw', 8: 'read', 9: 'read', 10: 'read', 17: 'tex' },
      { 3: world.contam, 4: world.veg, 5: world.water, 6: world.flux, 7: world.stats, 8: world.oil, 9: world.fire, 10: world.surface, 17: world.driftView },
    );
    for (let i = 0; i < 3; i++)
      this.staging.push({
        buf: world.buf('stats-staging', STATS_COUNT * 4, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST),
        busy: false,
      });
  }

  encode(enc: GPUCommandEncoder): void {
    // clear the per-pass sums but keep cumulative counters (overflow) at the end
    enc.clearBuffer(this.world.stats, 0, 14 * 4);
    dispatch(enc, this.prof, this.name, this.s.k, this.s.group, this.world.groups);
    const slot = this.staging.find((s) => !s.busy);
    if (!slot) return;
    slot.busy = true;
    enc.copyBufferToBuffer(this.world.stats, 0, slot.buf, 0, STATS_COUNT * 4);
    this.pendingMaps.push(() => {
      slot.buf.mapAsync(GPUMapMode.READ).then(() => {
        const u = new Uint32Array(slot.buf.getMappedRange()).slice();
        slot.buf.unmap();
        slot.busy = false;
        const cells = this.world.cells;
        this.latest = {
          soilContam: u[STAT.soilContam] / 1000,
          dissolved: u[STAT.dissolved] / 1000,
          vegCells: u[STAT.vegCells],
          vegMean: u[STAT.vegSum] / 100 / cells,
          waterVolume: u[STAT.waterVolume] / 100,
          flow: u[STAT.flow] / 1000,
          cleanCells: u[STAT.cleanCells],
          wetCells: u[STAT.wetCells],
          matureCells: u[STAT.matureCells],
          oilVolume: u[STAT.oil] / 1000,
          fireCells: u[STAT.fire],
          drowningCells: u[STAT.drowning],
          cleanLand: u[STAT.cleanLand],
          litterCells: u[STAT.litter],
          collapsed: u[STAT.collapsed],
          overflow: u[STAT.overflow],
          cells,
        };
      }, ignoreTeardown);
    });
  }

  /** Call after queue.submit so mapAsync follows the copy. */
  afterSubmit(): void {
    for (const f of this.pendingMaps) f();
    this.pendingMaps = [];
  }
}

/** A layer pull (layerpull.wgsl): one frame's call of a stroke. */
export interface LayerPull {
  x: number;
  y: number;
  radius: number;
  /** the stroke's height now (cells; < 0 pulls down): each column moves toward height × the brush there */
  height: number;
  material: number;
  mode: 0 | 1;
  slot: number;
  start: boolean;
  roughness: number;
  dir: [number, number];
  lean: number;
  /** shake the loose ground it lifts (0..1): it slips at a lower angle for a while */
  shake: number;
}

/** Stroke slots (layerpull.wgsl pullGiven): strokes under way at once. */
export const PULL_SLOTS = 8;
const PULLS_A_TICK = 16;

/**
 * Layer pulls (BACKLOG E2): the queued calls, up to 16 a tick (the rest the
 * next), each column toward its stroke's target. Every tick there are any,
 * after the editor's brush and before anything reads the layers.
 */
export class LayerPullSystem implements SimSystem {
  readonly name = 'layerpull';
  readonly period = 1;
  private s;
  private params: GPUBuffer;
  private given: GPUBuffer;
  readonly queue: LayerPull[] = [];
  constructor(private device: GPUDevice, private world: WorldGpu, private prof: Profiler) {
    this.params = device.createBuffer({ label: 'layerpull-params', size: 16 + PULLS_A_TICK * 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.given = world.buf('pullGiven', PULL_SLOTS * world.w * world.h * 4, GPUBufferUsage.STORAGE);
    this.s = kernel(
      device,
      world,
      'layerpull',
      columnPass(layerPullWgsl, world).code,
      { 3: 'read', 4: 'rw', 5: 'rw', 6: 'uniform', 7: 'stex' },
      { 3: columnPass('', world).in, 4: columnPass('', world).out, 5: this.given, 6: this.params, 7: world.shakeView },
      true,
    );
  }
  encode(enc: GPUCommandEncoder): void {
    if (!this.queue.length) return;
    const batch = this.queue.splice(0, PULLS_A_TICK);
    const buf = new ArrayBuffer(16 + PULLS_A_TICK * 48);
    const u = new Uint32Array(buf);
    const f = new Float32Array(buf);
    u[0] = batch.length;
    batch.forEach((p, k) => {
      const o = 4 + k * 12;
      f.set([p.x, p.y, p.radius, p.height], o);
      // (the shake rides in the material word's high bits: 0..255)
      u.set([p.material | (Math.round(Math.min(Math.max(p.shake, 0), 1) * 255) << 8), p.mode, p.slot, p.start ? 1 : 0], o + 4);
      f.set([p.roughness, p.dir[0], p.dir[1], p.lean], o + 8);
    });
    // (written before this tick's submit: one batch a tick)
    this.device.queue.writeBuffer(this.params, 0, buf);
    dispatch(enc, this.prof, this.name, this.s.k, this.s.group, this.world.groups);
    if (!INPLACE) enc.copyBufferToBuffer(this.world.layersNext, 0, this.world.layers, 0, this.world.layers.size);
  }
}

/** A landform brush stamp (landbrush.wgsl): a stroke's segment this tick. */
export interface LandStamp {
  from: [number, number];
  to: [number, number];
  /** half-width (cells) */
  radius: number;
  /** range: its height (cells over the ground); mesa: its top level (absolute z) */
  height: number;
  shape: 'range' | 'mesa';
  /** the stroke it belongs to (a serial from 1: a column new to it starts over) */
  stroke: number;
}

const STAMPS_A_TICK = 16;

/**
 * The landform brushes (round 64; landbrush.wgsl): strokes stamp ranges and
 * mesas, the rock rises toward what they ask at 18 cells/s. In place on the
 * layers (each thread its own column); runs while anything is still rising.
 */
export class LandBrushSystem implements SimSystem {
  readonly name = 'landbrush';
  readonly period = 1;
  readonly queue: LandStamp[] = [];
  private params: GPUBuffer;
  private state: GPUBuffer;
  private stamp: { k: ComputeKernel; group: GPUBindGroup };
  private rise: { k: ComputeKernel; group: GPUBindGroup };
  /** ms of performance.now() until which it keeps rising (a stamp's height / 18 cells/s, and some) */
  private until = 0;
  constructor(private device: GPUDevice, private world: WorldGpu, private prof: Profiler) {
    this.params = device.createBuffer({ label: 'landbrush-params', size: 16 + STAMPS_A_TICK * 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.state = world.buf('landBrush', world.w * world.h * 16, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
    const spec: BindSpec = { ...BASE, 3: 'rw', 4: 'rw', 6: 'uniform', 7: 'stex' };
    const bound = { 0: world.globals, 1: world.chunks, 2: world.materials, 3: world.layers, 4: this.state, 6: this.params, 7: world.shakeView };
    const mk = (entry: string) => {
      const k = makeCompute(device, `landbrush-${entry}`, [...WITH_ALL, landBrushWgsl], spec, entry);
      return { k, group: makeBindGroup(device, `landbrush-${entry}`, k.layout, bound) };
    };
    this.stamp = mk('stamp');
    this.rise = mk('rise');
  }
  encode(enc: GPUCommandEncoder): void {
    const now = performance.now();
    if (!this.queue.length && now > this.until) return;
    const batch = this.queue.splice(0, STAMPS_A_TICK);
    const buf = new ArrayBuffer(16 + STAMPS_A_TICK * 32);
    const u = new Uint32Array(buf);
    const f = new Float32Array(buf);
    u[0] = batch.length;
    batch.forEach((s, k) => {
      f.set([s.from[0], s.from[1], s.to[0], s.to[1], s.radius, s.height, s.shape === 'mesa' ? 1 : 0, s.stroke], 4 + k * 8);
      // (a range of h cells rises in h / 18 s; a mesa's level is absolute: allow for the tallest)
      this.until = Math.max(this.until, now + 1000 * ((s.shape === 'mesa' ? this.world.zMax : s.height) / 18 + 1));
    });
    this.device.queue.writeBuffer(this.params, 0, buf);
    if (batch.length) dispatch(enc, this.prof, 'landbrush-stamp', this.stamp.k, this.stamp.group, this.world.groups);
    dispatch(enc, this.prof, 'landbrush-rise', this.rise.k, this.rise.group, this.world.groups);
  }
}

/** A town column stamp (townstamp.wgsl; build/town.ts): its span [lo, hi) rewritten as the design. */
export interface ColumnStamp {
  /** the column (y * w + x) */
  col: number;
  lo: number;
  hi: number;
  /** a stone foundation from the column's top under lo up to lo */
  foundation: boolean;
  /** within [lo, hi), bottom up */
  design: { z0: number; z1: number; mat: number }[];
}

const STAMP_COLS = 4096;
const STAMP_IVS = 16;

/**
 * The town's columns (round 65; townstamp.wgsl): stamps from build/town.ts,
 * up to STAMP_COLS columns a tick, in place on the layers. A column queued
 * twice before it's written keeps only its latest stamp (the town works out
 * each stamp's span with the one before it in mind).
 */
export class TownStampSystem implements SimSystem {
  readonly name = 'townstamp';
  readonly period = 1;
  private queue = new Map<number, ColumnStamp>();
  private params: GPUBuffer;
  private recs: GPUBuffer;
  private design: GPUBuffer;
  private s: { k: ComputeKernel; group: GPUBindGroup };
  constructor(private device: GPUDevice, world: WorldGpu, private prof: Profiler) {
    this.params = device.createBuffer({ label: 'townstamp-params', size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.recs = device.createBuffer({ label: 'townstamp-recs', size: STAMP_COLS * 32, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.design = device.createBuffer({ label: 'townstamp-design', size: STAMP_COLS * STAMP_IVS * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    const spec: BindSpec = { ...BASE, 3: 'rw', 4: 'read', 5: 'read', 6: 'uniform' };
    const k = makeCompute(device, 'townstamp', [...WITH_ALL, townStampWgsl], spec, 'stampCols');
    this.s = { k, group: makeBindGroup(device, 'townstamp', k.layout, { 0: world.globals, 1: world.chunks, 2: world.materials, 3: world.layers, 4: this.recs, 5: this.design, 6: this.params }) };
  }
  /** Columns waiting to be written. */
  get pending(): number {
    return this.queue.size;
  }
  stamp(stamps: ColumnStamp[]): void {
    for (const s of stamps) {
      if (s.design.length > STAMP_IVS) throw new Error(`a town column of ${s.design.length} intervals (> ${STAMP_IVS})`);
      // (re-queued: to the back, so the order of writes stays the order of stamps)
      this.queue.delete(s.col);
      this.queue.set(s.col, s);
    }
  }
  encode(enc: GPUCommandEncoder): void {
    if (!this.queue.size) return;
    const batch: ColumnStamp[] = [];
    for (const [col, s] of this.queue) {
      if (batch.length >= STAMP_COLS) break;
      batch.push(s);
      this.queue.delete(col);
    }
    const rec = new ArrayBuffer(batch.length * 32);
    const ru = new Uint32Array(rec);
    const rf = new Float32Array(rec);
    const n = batch.reduce((a, s) => a + s.design.length, 0);
    const des = new ArrayBuffer(Math.max(n, 1) * 16);
    const du = new Uint32Array(des);
    let o = 0;
    batch.forEach((s, k) => {
      ru.set([s.col, s.design.length, o, s.foundation ? 1 : 0], k * 8);
      rf[k * 8 + 4] = s.lo;
      rf[k * 8 + 5] = s.hi;
      for (const iv of s.design) writeSlot(du, o++, iv.z0, iv.z1, iv.mat, 240);
    });
    this.device.queue.writeBuffer(this.recs, 0, rec);
    this.device.queue.writeBuffer(this.design, 0, des);
    this.device.queue.writeBuffer(this.params, 0, new Uint32Array([batch.length, 0, 0, 0]));
    dispatch(enc, this.prof, this.name, this.s.k, this.s.group, [Math.ceil(batch.length / 64), 1]);
  }
}

/** An op masked to a place (placeop.wgsl): op 1 bury, 2 flood, 3 drain. */
export interface PlaceOp {
  op: 1 | 2 | 3;
  place: number;
  material?: number;
  amount?: number;
  noise?: number;
  scale?: number;
  seed?: number;
}

/**
 * Ops masked to a place (docs/PLACES.md step 1), one a tick from a queue.
 * Period 2, before the sediment pass in the list: it runs on the sediment's
 * ticks, so a bury's deposit is folded in the same tick (the climate pass,
 * after it, overwrites deposit .yz with its snow and leaves).
 */
export class PlaceOpSystem implements SimSystem {
  readonly name = 'placeop';
  readonly period = 2;
  private s;
  private params: GPUBuffer;
  readonly queue: PlaceOp[] = [];
  constructor(private device: GPUDevice, private world: WorldGpu, private prof: Profiler) {
    this.params = device.createBuffer({ label: 'placeop-params', size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.s = kernel(
      device,
      world,
      'placeop',
      placeOpWgsl,
      { 3: 'read', 4: 'read', 5: 'rw', 6: 'rw', 7: 'uniform' },
      { 3: world.places, 4: world.placeTable, 5: world.water, 6: world.deposit, 7: this.params },
    );
  }
  encode(enc: GPUCommandEncoder): void {
    const o = this.queue.shift();
    if (!o) return;
    const buf = new ArrayBuffer(32);
    new Uint32Array(buf, 0, 4).set([o.op, o.place, o.material ?? 0, o.seed ?? 1]);
    new Float32Array(buf, 16, 4).set([o.amount ?? 0, o.noise ?? 0, o.scale ?? 8, 0]);
    // (written before this tick's submit: one op a tick, so no two share it)
    this.device.queue.writeBuffer(this.params, 0, buf);
    dispatch(enc, this.prof, this.name, this.s.k, this.s.group, this.world.groups);
  }
}
