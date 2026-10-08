// Fixed-timestep orchestration of the simulation systems (design doc §24).
// Systems run in the documented order; each has its own period.

import type { Profiler } from '../gpu/profiler';
import { writeGlobals, GLOBALS_BYTES, type GlobalsState } from './globals';
import type { SimSystem } from './system';
import {
  ContaminationSystem,
  EcologySystem,
  MaterialSystem,
  MoistureSystem,
  OilSystem,
  RenderFieldsSystem,
  FireSystem,
  StatsSystem,
  SwaySystem,
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
    this.shadow = new RenderFieldsSystem(device, world, profiler);
    this.stats = new StatsSystem(device, world, profiler);
    this.particles = new ParticleSystem(device, world, profiler);
    // Order matters only through the contract buffers each system reads.
    this.systems = [
      new StructureSystem(device, world, profiler),
      new MaterialSystem(device, world, profiler),
      this.surface,
      new WaterSystem(device, world, profiler),
      new OilSystem(device, world, profiler),
      new ContaminationSystem(device, world, profiler),
      new MoistureSystem(device, world, profiler),
      new FireSystem(device, world, profiler),
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
    // events are one-tick impulses: consumed by exactly this tick
    globals.events = [];
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
