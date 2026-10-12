// Fixed-timestep orchestration of the simulation systems (design doc §24).
// Systems run in the documented order; each has its own period.

import type { Profiler } from '../gpu/profiler';
import { EventKind, writeGlobals, GLOBALS_BYTES, type GlobalsState } from './globals';
import type { SimSystem } from './system';
import {
  ContaminationSystem,
  EcologySystem,
  MoistureSystem,
  OilSystem,
  RenderFieldsSystem,
  FireSystem,
  StatsSystem,
  SwaySystem,
  WindFieldSystem,
  EditSystem,
  SedimentSystem,
  WiltSystem,
  StructureSystem,
  SurfaceSystem,
  WaterSystem,
} from './systems';
import type { WorldGpu } from './world-gpu';
import { ParticleSystem } from './particles';

export const TICK_HZ = 60;
export const TICK_DT = 1 / TICK_HZ;

export class Simulation {
  readonly systems: SimSystem[];
  readonly stats: StatsSystem;
  readonly surface: SurfaceSystem;
  readonly wind: WindFieldSystem;
  readonly edit: EditSystem;
  readonly shadow: RenderFieldsSystem;
  readonly particles: ParticleSystem;
  tick = 0;
  private globalsData = new ArrayBuffer(GLOBALS_BYTES);
  /** Per-system CPU encode time (ms, smoothed). */
  readonly cpuMs = new Map<string, number>();

  constructor(
    private device: GPUDevice,
    private world: WorldGpu,
    profiler: Profiler,
  ) {
    this.surface = new SurfaceSystem(device, world, profiler);
    this.wind = new WindFieldSystem(device, world, profiler);
    this.edit = new EditSystem(device, world, profiler);
    this.shadow = new RenderFieldsSystem(device, world, profiler);
    this.stats = new StatsSystem(device, world, profiler);
    this.particles = new ParticleSystem(device, world, profiler);
    // Order matters only through the contract buffers each system reads.
    this.systems = [
      this.edit,
      this.wind,
      new StructureSystem(device, world, profiler),
      this.surface,
      new WaterSystem(device, world, profiler),
      new OilSystem(device, world, profiler),
      new ContaminationSystem(device, world, profiler),
      new MoistureSystem(device, world, profiler),
      new FireSystem(device, world, profiler),
      new SedimentSystem(device, world, profiler),
      new WiltSystem(device, world, profiler),
      new EcologySystem(device, world, profiler),
      this.particles,
      new SwaySystem(device, world, profiler),
      this.shadow,
      this.stats,
    ];
  }

  /** Bring derived buffers (surface, shadow) up to date before the first tick. */
  prime(globals: GlobalsState): void {
    this.uploadGlobals(globals);
    const enc = this.device.createCommandEncoder({ label: 'prime' });
    // the wind field starts as the map's own wind, before anything reads it
    this.wind.encode(enc);
    this.surface.encode(enc);
    this.shadow.encode(enc);
    this.device.queue.submit([enc.finish()]);
  }

  /**
   * Encode and submit one tick. Globals are uploaded per tick so each tick sees
   * its own tick number/time (queue.writeBuffer is ordered with submits).
   */
  step(globals: GlobalsState, filter?: (s: SimSystem) => boolean): void {
    globals.tick = this.tick;
    this.uploadGlobals(globals);
    // events are one-tick impulses: consumed by exactly this tick; so are the
    // stroke segments stamped into the wind field (gusts[1..])
    this.edit.pending = globals.events.some((e) => e.kind === EventKind.Edit);
    globals.events = [];
    if (globals.gusts.length > 1) {
      for (const gg of globals.gusts.slice(1)) gg.len = 0;
      globals.strokeSent = true;
    }
    const enc = this.device.createCommandEncoder({ label: `tick ${this.tick}` });
    for (const sys of this.systems) {
      if (this.tick % sys.period !== 0) continue;
      if (filter && !filter(sys)) continue;
      const t0 = performance.now();
      sys.encode(enc, this.tick);
      const dt = performance.now() - t0;
      this.cpuMs.set(sys.name, (this.cpuMs.get(sys.name) ?? dt) * 0.95 + dt * 0.05);
    }
    this.device.queue.submit([enc.finish()]);
    this.stats.afterSubmit();
    this.tick++;
  }

  uploadGlobals(g: GlobalsState): void {
    writeGlobals(g, this.globalsData);
    this.device.queue.writeBuffer(this.world.globals, 0, this.globalsData);
  }
}
