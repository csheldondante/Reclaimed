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
import terrainShapeWgsl from '../shaders/terrainshape.wgsl?raw';
import fireWgsl from '../shaders/fire.wgsl?raw';
import statsWgsl from '../shaders/stats.wgsl?raw';
import swayWgsl from '../shaders/sway.wgsl?raw';
import wiltWgsl from '../shaders/wilt.wgsl?raw';
import windFieldWgsl from '../shaders/windfield.wgsl?raw';
import sedimentWgsl from '../shaders/sediment.wgsl?raw';
import climateWgsl from '../shaders/climate.wgsl?raw';
import editWgsl from '../shaders/edit.wgsl?raw';
import placeOpWgsl from '../shaders/placeop.wgsl?raw';
import layerPullWgsl from '../shaders/layerpull.wgsl?raw';
import landBrushWgsl from '../shaders/landbrush.wgsl?raw';
import townStampWgsl from '../shaders/townstamp.wgsl?raw';
import { writeSlot } from '../world/layout';
import { dispatch, type SimSystem } from './system';
import { STATS_COUNT, type WorldGpu } from './world-gpu';
import { SETTLE, SLEEP_MORE } from './sleep';

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
) {
  const parts = useLayers ? [...WITH_ALL, src] : [commonWgsl, materialsWgsl, src];
  const base: BindSpec = useLayers ? BASE : { 0: 'uniform', 2: 'uniform' };
  const k = makeCompute(device, label, parts, { ...base, ...spec });
  const bound: Record<number, GPUBuffer | GPUTextureView> = { 0: world.globals, 2: world.materials, ...buffers };
  if (useLayers) bound[1] = world.chunks;
  const group = makeBindGroup(device, label, k.layout, bound);
  return { k, group };
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
    );
  }
  encode(enc: GPUCommandEncoder): void {
    dispatch(enc, this.prof, this.name, this.s.k, this.s.group, this.world.groups);
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
    );
  }
  encode(enc: GPUCommandEncoder): void {
    dispatch(enc, this.prof, this.name, this.s.k, this.s.group, this.world.groups);
    if (!INPLACE) enc.copyBufferToBuffer(this.world.layersNext, 0, this.world.layers, 0, this.world.layers.size);
  }
}

export class WaterSystem implements SimSystem {
  readonly name = 'water';
  readonly period = 1;
  private flux;
  private depth;
  constructor(device: GPUDevice, private world: WorldGpu, private prof: Profiler) {
    this.flux = kernel(
      device,
      world,
      'water-flux',
      `const FLUX_SEED: bool = ${!SETTLE};` + waterFluxWgsl,
      { 3: 'read', 4: 'read', 5: 'rw', 6: 'read', 17: 'tex', 21: 'tex' },
      { 3: world.surface, 4: world.water, 5: world.flux, 6: world.oil, 17: world.driftView, 21: world.bodyProjView },
    );
    this.depth = kernel(
      device,
      world,
      'water-depth',
      waterDepthWgsl,
      { 3: 'read', 4: 'read', 5: 'read', 6: 'rw', 7: 'rw', 8: 'read' },
      { 3: world.water, 4: world.flux, 5: world.waterSource, 6: world.waterNext, 7: world.waterPrev, 8: world.surface },
    );
  }
  encode(enc: GPUCommandEncoder): void {
    dispatch(enc, this.prof, 'water-flux', this.flux.k, this.flux.group, this.world.groups);
    dispatch(enc, this.prof, 'water-depth', this.depth.k, this.depth.group, this.world.groups);
    enc.copyBufferToBuffer(this.world.waterNext, 0, this.world.water, 0, this.world.water.size);
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
      oilFluxWgsl,
      { 3: 'read', 4: 'read', 5: 'read', 6: 'rw', 7: 'read', 17: 'tex' },
      { 3: world.surface, 4: world.water, 5: world.oil, 6: world.oilFlux, 7: world.flux, 17: world.driftView },
    );
    this.depth = kernel(
      device,
      world,
      'oil-depth',
      oilDepthWgsl,
      { 3: 'read', 4: 'read', 5: 'rw', 6: 'read', 7: 'rw', 8: 'read', 9: 'read', 10: 'rw', 17: 'tex' },
      { 3: world.oil, 4: world.oilFlux, 5: world.oilNext, 6: world.water, 7: world.contamDelta, 8: world.surface, 9: world.fire, 10: world.oilStored, 17: world.driftView },
    );
  }
  encode(enc: GPUCommandEncoder): void {
    dispatch(enc, this.prof, 'oil-flux', this.flux.k, this.flux.group, this.world.groups);
    dispatch(enc, this.prof, 'oil-depth', this.depth.k, this.depth.group, this.world.groups);
    enc.copyBufferToBuffer(this.world.oilNext, 0, this.world.oil, 0, this.world.oil.size);
  }
}

export class ContaminationSystem implements SimSystem {
  readonly name = 'contamination';
  readonly period = 1;
  private s;
  constructor(device: GPUDevice, private world: WorldGpu, private prof: Profiler) {
    this.s = kernel(
      device,
      world,
      'contamination',
      contamWgsl + flowWgsl,
      { 3: 'read', 4: 'read', 5: 'read', 6: 'read', 7: 'rw', 8: 'read', 9: 'rw' },
      { 3: world.waterPrev, 4: world.water, 5: world.flux, 6: world.contam, 7: world.contamNext, 8: world.veg, 9: world.contamDelta },
    );
  }
  encode(enc: GPUCommandEncoder): void {
    dispatch(enc, this.prof, this.name, this.s.k, this.s.group, this.world.groups);
    enc.copyBufferToBuffer(this.world.contamNext, 0, this.world.contam, 0, this.world.contam.size);
  }
}

export class MoistureSystem implements SimSystem {
  readonly name = 'moisture';
  readonly period = 1;
  private s;
  constructor(device: GPUDevice, private world: WorldGpu, private prof: Profiler) {
    this.s = kernel(
      device,
      world,
      'moisture',
      moistureWgsl + slopeWgsl,
      { 3: 'read', 4: 'read', 5: 'rw', 6: 'read', 7: 'read', 17: 'tex' },
      { 3: world.water, 4: world.moisture, 5: world.moistureNext, 6: world.veg, 7: world.surface, 17: world.driftView },
    );
  }
  encode(enc: GPUCommandEncoder): void {
    dispatch(enc, this.prof, this.name, this.s.k, this.s.group, this.world.groups);
    enc.copyBufferToBuffer(this.world.moistureNext, 0, this.world.moisture, 0, this.world.moisture.size);
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
    );
  }
  encode(enc: GPUCommandEncoder): void {
    dispatch(enc, this.prof, this.name, this.s.k, this.s.group, this.world.groups);
  }
}

export class EcologySystem implements SimSystem {
  readonly name = 'ecology';
  readonly period = 15;
  private s;
  constructor(device: GPUDevice, private world: WorldGpu, private prof: Profiler) {
    this.s = kernel(
      device,
      world,
      'ecology',
      ecologyWgsl + slopeWgsl,
      { 3: 'read', 4: 'read', 5: 'read', 6: 'read', 7: 'read', 8: 'rw', 10: 'read', 17: 'tex' },
      { 3: world.surface, 4: world.wilt, 5: world.moisture, 6: world.water, 7: world.veg, 8: world.vegNext, 10: world.fire, 17: world.driftView },
    );
  }
  encode(enc: GPUCommandEncoder): void {
    dispatch(enc, this.prof, this.name, this.s.k, this.s.group, this.world.groups);
    enc.copyBufferToBuffer(this.world.vegNext, 0, this.world.veg, 0, this.world.veg.size);
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
      terrainShapeWgsl + meshRegionWgsl + `const SLEEP_MORE: bool = ${SLEEP_MORE};
` + renderFieldsWgsl + flowWgsl,
      { 3: 'read', 4: 'read', 5: 'read', 6: 'read', 7: 'rw', 8: 'read', 9: 'read', 10: 'read', 16: 'stex', 17: 'tex', 30: 'uniform' },
      { 3: world.surface, 4: world.moisture, 5: world.fire, 6: world.flux, 7: world.renderFields, 8: world.water, 9: world.veg, 10: world.lava, 16: world.cornerView, 17: world.driftView, 30: world.meshRegion },
    );
  }
  encode(enc: GPUCommandEncoder): void {
    dispatch(enc, this.prof, this.name, this.s.k, this.s.group, this.world.groups);
  }
}

/** The player's persistent wind field (windfield.wgsl): advect, spread, decay, stamp strokes. */
export class WindFieldSystem implements SimSystem {
  readonly name = 'windfield';
  readonly period = 1;
  private s;
  private groups: [number, number];
  constructor(device: GPUDevice, private world: WorldGpu, private prof: Profiler) {
    this.s = kernel(device, world, 'windfield', windFieldWgsl, { 15: 'tex', 16: 'stex', 30: 'read', 31: 'read' }, { 15: world.windFieldView, 16: world.windFieldNextView, 30: world.physPuff, 31: world.windBlows });
    this.groups = [Math.ceil(world.windField.width / 8), Math.ceil(world.windField.height / 8)];
  }
  encode(enc: GPUCommandEncoder): void {
    dispatch(enc, this.prof, this.name, this.s.k, this.s.group, this.groups);
    enc.copyTextureToTexture({ texture: this.world.windFieldNext }, { texture: this.world.windField }, [this.world.windField.width, this.world.windField.height]);
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
    dispatch(enc, this.prof, this.name, this.s.k, this.s.group, this.world.groups);
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
    const parts = [commonWgsl, layersWgsl, materialsWgsl, sedimentWgsl + flowWgsl];
    const tex = { 15: world.windFieldView, 17: world.driftView, 19: world.strataView, 21: world.bodyProjView, 28: world.projView, 29: world.levelsView, 30: world.shakeView };
    const outK = makeCompute(device, 'sediment-out', parts, { 0: 'uniform', 1: 'read', 2: 'uniform', 3: 'rw', 4: 'read', 6: 'read', 7: 'read', 9: 'read', 10: 'rw', 11: 'read', 15: 'tex', 17: 'tex', 19: 'tex', 21: 'tex', 28: 'tex', 29: 'tex', 30: 'tex' }, 'outflow');
    this.out = { k: outK, group: makeBindGroup(device, 'sediment-out', outK.layout, { 0: world.globals, 1: world.chunks, 2: world.materials, 3: world.layers, 4: world.water, 6: world.flux, 7: world.veg, 9: world.moisture, 10: world.sedOut, 11: world.surface, ...tex }) };
    this.s = kernel(
      device,
      world,
      'sediment',
      sedimentWgsl + flowWgsl,
      { 3: 'rw', 5: 'rw', 7: 'read', 8: 'rw', 10: 'rw', 15: 'tex', 16: 'stex', 17: 'tex', 18: 'tex', 19: 'tex', 21: 'tex', 28: 'tex', 29: 'tex', 30: 'tex' },
      { 3: world.layers, 5: world.deposit, 7: world.veg, 8: world.contamDelta, 10: world.sedOut, 16: world.airView, 18: world.editStateView, ...tex },
      true,
    );
  }
  encode(enc: GPUCommandEncoder): void {
    dispatch(enc, this.prof, 'sediment-out', this.out.k, this.out.group, this.world.groups);
    dispatch(enc, this.prof, this.name, this.s.k, this.s.group, this.world.groups);
  }
}

/**
 * The climate (round 50, climate.wgsl): snow from cold storms, snow and ice
 * melting, water freezing, trees dropping leaves that rot into soil — by the
 * air's temperature (Globals climate) and the heat of lava and fire.
 */
export class ClimateSystem implements SimSystem {
  readonly name = 'climate';
  readonly period = 4;
  private s;
  constructor(device: GPUDevice, private world: WorldGpu, private prof: Profiler) {
    this.s = kernel(
      device,
      world,
      'climate',
      climateWgsl,
      { 3: 'rw', 4: 'rw', 5: 'rw', 6: 'read', 7: 'read', 8: 'read', 9: 'read' },
      { 3: world.layers, 4: world.water, 5: world.deposit, 6: world.veg, 7: world.moisture, 8: world.fire, 9: world.lava },
      true,
    );
  }
  encode(enc: GPUCommandEncoder): void {
    dispatch(enc, this.prof, this.name, this.s.k, this.s.group, this.world.groups);
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
    );
  }
  encode(enc: GPUCommandEncoder): void {
    dispatch(enc, this.prof, this.name, this.s.k, this.s.group, this.world.groups);
    enc.copyBufferToBuffer(this.world.fireNext, 0, this.world.fire, 0, this.world.fire.size);
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
