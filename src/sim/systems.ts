// First (simplest) implementations of each simulation system. Each one is a
// thin wrapper binding a WGSL kernel to WorldGpu contract buffers.

import { makeBindGroup, makeCompute, type BindSpec } from '../gpu/pipeline';
import type { Profiler } from '../gpu/profiler';
import commonWgsl from '../shaders/common.wgsl?raw';
import layersWgsl from '../shaders/layers.wgsl?raw';
import materialsWgsl from '../shaders/materials.wgsl?raw';
import surfaceWgsl from '../shaders/surface.wgsl?raw';
import materialWgsl from '../shaders/material.wgsl?raw';
import structureWgsl from '../shaders/structure.wgsl?raw';
import waterFluxWgsl from '../shaders/water_flux.wgsl?raw';
import waterDepthWgsl from '../shaders/water_depth.wgsl?raw';
import contamWgsl from '../shaders/contamination.wgsl?raw';
import moistureWgsl from '../shaders/moisture.wgsl?raw';
import ecologyWgsl from '../shaders/ecology.wgsl?raw';
import shadowWgsl from '../shaders/shadow.wgsl?raw';
import statsWgsl from '../shaders/stats.wgsl?raw';
import { dispatch, type SimSystem } from './system';
import { STATS_COUNT, type WorldGpu } from './world-gpu';

const BASE: BindSpec = { 0: 'uniform', 1: 'read', 2: 'uniform' };
const WITH_ALL = [commonWgsl, layersWgsl, materialsWgsl];

/** Builds a single-kernel system whose bindings 0..2 are the shared globals/chunks/materials. */
function kernel(
  device: GPUDevice,
  world: WorldGpu,
  label: string,
  src: string,
  spec: BindSpec,
  buffers: Record<number, GPUBuffer>,
) {
  const k = makeCompute(device, label, [...WITH_ALL, src], { ...BASE, ...spec });
  const group = makeBindGroup(device, label, k.layout, {
    0: world.globals,
    1: world.chunks,
    2: world.materials,
    ...buffers,
  });
  return { k, group };
}

export class SurfaceSystem implements SimSystem {
  readonly name = 'surface';
  readonly period = 1;
  private s;
  constructor(device: GPUDevice, private world: WorldGpu, private prof: Profiler) {
    this.s = kernel(device, world, 'surface', surfaceWgsl, { 3: 'read', 4: 'rw' }, { 3: world.layers, 4: world.surface });
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
      structureWgsl,
      { 3: 'read', 4: 'rw', 5: 'rw' },
      { 3: world.layers, 4: world.layersNext, 5: world.stats },
    );
  }
  encode(enc: GPUCommandEncoder): void {
    dispatch(enc, this.prof, this.name, this.s.k, this.s.group, this.world.groups);
    enc.copyBufferToBuffer(this.world.layersNext, 0, this.world.layers, 0, this.world.layers.size);
  }
}

export class MaterialSystem implements SimSystem {
  readonly name = 'material';
  readonly period = 1;
  private s;
  constructor(device: GPUDevice, private world: WorldGpu, private prof: Profiler) {
    this.s = kernel(
      device,
      world,
      'material',
      materialWgsl,
      { 3: 'read', 4: 'rw', 5: 'read', 6: 'read', 7: 'rw' },
      { 3: world.layers, 4: world.layersNext, 5: world.surface, 6: world.moisture, 7: world.stats },
    );
  }
  encode(enc: GPUCommandEncoder): void {
    dispatch(enc, this.prof, this.name, this.s.k, this.s.group, this.world.groups);
    enc.copyBufferToBuffer(this.world.layersNext, 0, this.world.layers, 0, this.world.layers.size);
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
      waterFluxWgsl,
      { 3: 'read', 4: 'read', 5: 'rw' },
      { 3: world.surface, 4: world.water, 5: world.flux },
    );
    this.depth = kernel(
      device,
      world,
      'water-depth',
      waterDepthWgsl,
      { 3: 'read', 4: 'read', 5: 'read', 6: 'rw', 7: 'rw' },
      { 3: world.water, 4: world.flux, 5: world.waterSource, 6: world.waterNext, 7: world.waterPrev },
    );
  }
  encode(enc: GPUCommandEncoder): void {
    dispatch(enc, this.prof, 'water-flux', this.flux.k, this.flux.group, this.world.groups);
    dispatch(enc, this.prof, 'water-depth', this.depth.k, this.depth.group, this.world.groups);
    enc.copyBufferToBuffer(this.world.waterNext, 0, this.world.water, 0, this.world.water.size);
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
      contamWgsl,
      { 3: 'read', 4: 'read', 5: 'read', 6: 'read', 7: 'rw', 8: 'read' },
      { 3: world.waterPrev, 4: world.water, 5: world.flux, 6: world.contam, 7: world.contamNext, 8: world.veg },
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
      moistureWgsl,
      { 3: 'read', 4: 'read', 5: 'rw', 6: 'read' },
      { 3: world.water, 4: world.moisture, 5: world.moistureNext, 6: world.veg },
    );
  }
  encode(enc: GPUCommandEncoder): void {
    dispatch(enc, this.prof, this.name, this.s.k, this.s.group, this.world.groups);
    enc.copyBufferToBuffer(this.world.moistureNext, 0, this.world.moisture, 0, this.world.moisture.size);
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
      ecologyWgsl,
      { 3: 'read', 4: 'read', 5: 'read', 6: 'read', 7: 'read', 8: 'rw' },
      { 3: world.surface, 4: world.contam, 5: world.moisture, 6: world.water, 7: world.veg, 8: world.vegNext },
    );
  }
  encode(enc: GPUCommandEncoder): void {
    dispatch(enc, this.prof, this.name, this.s.k, this.s.group, this.world.groups);
    enc.copyBufferToBuffer(this.world.vegNext, 0, this.world.veg, 0, this.world.veg.size);
  }
}

export class ShadowSystem implements SimSystem {
  readonly name = 'shadow';
  readonly period = 6;
  private s;
  constructor(device: GPUDevice, private world: WorldGpu, private prof: Profiler) {
    this.s = kernel(device, world, 'shadow', shadowWgsl, { 3: 'read', 4: 'rw' }, { 3: world.surface, 4: world.shadow });
  }
  encode(enc: GPUCommandEncoder): void {
    dispatch(enc, this.prof, this.name, this.s.k, this.s.group, this.world.groups);
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
      { 3: 'read', 4: 'read', 5: 'read', 6: 'read', 7: 'rw' },
      { 3: world.contam, 4: world.veg, 5: world.water, 6: world.flux, 7: world.stats },
    );
    for (let i = 0; i < 3; i++)
      this.staging.push({
        buf: device.createBuffer({ label: 'stats-staging', size: STATS_COUNT * 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }),
        busy: false,
      });
  }

  encode(enc: GPUCommandEncoder): void {
    // clear the per-pass sums but keep cumulative counters (overflow) at the end
    enc.clearBuffer(this.world.stats, 0, 12 * 4);
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
          collapsed: u[STAT.collapsed],
          overflow: u[STAT.overflow],
          cells,
        };
      });
    });
  }

  /** Call after queue.submit so mapAsync follows the copy. */
  afterSubmit(): void {
    for (const f of this.pendingMaps) f();
    this.pendingMaps = [];
  }
}
