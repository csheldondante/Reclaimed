// A tiny world on Dawn in Node (docs/TESTING.md): the real WorldCore — the level's WorldGpu buffers, kernels and
// Simulation — made from a map, stepped with the fixed-step sim (Simulation.step, as WorldCore.warmup and the contract
// tier do) and its contract buffers read back. Which systems step is the test's choice, by name (sim/systems.ts).
import { Profiler } from '../../src/gpu/profiler';
import { beginPipelineBatch, endPipelineBatch } from '../../src/gpu/pipeline';
import { WorldCore, type Host, type Quality } from '../../src/scenes/world-core';
import type { SimSystem } from '../../src/sim/system';
import { useRivers } from '../../src/sim/world-gpu';
import { CHUNK } from '../../src/world/layout';
import type { MapData } from '../../src/world/mapgen';
import type { TestGpu } from './dawn';

/** contract.ts's quality (the low tier's) */
const QUALITY: Quality = { renderScale: 0.5, maxDpr: 1, rain: 1500, maxTicksPerFrame: 2, particles: 4096, agentSweeps: 2, shadowSize: 1024, meshSlots: 1 };

export interface TinyWorld {
  core: WorldCore;
  ticks: number;
  /** the names of the systems this world has (sim/systems.ts) */
  systems: string[];
  step(n: number): Promise<void>;
  /** a per-column buffer in window order (y * w + x) */
  read(name: 'water' | 'surface' | 'layers' | 'waterSource'): Promise<Float32Array>;
  /** the sum of a per-column buffer over [x0, x1) × [y0, y1) */
  sum(buf: Float32Array, x0?: number, y0?: number, x1?: number, y1?: number): number;
  destroy(): void;
}

export async function tinyWorld(g: TestGpu, map: MapData, systems: string[] | 'all', rivers: 'sim' | 'table' = 'sim'): Promise<TinyWorld> {
  // (no canvas and no page: the world's constructor doesn't draw — a Host as far as WorldCore reads it)
  const host: Host = {
    gpu: { adapter: undefined as unknown as GPUAdapter, device: g.device, context: undefined as unknown as GPUCanvasContext, format: 'bgra8unorm', hasTimestamps: false, adapterInfo: g.adapterInfo },
    profiler: new Profiler(g.device, false),
    quality: { ...QUALITY },
    qualityName: 'low',
    params: new URLSearchParams(),
    canvas: undefined as unknown as HTMLCanvasElement,
    ui: undefined as unknown as HTMLElement,
  };
  useRivers(rivers);
  beginPipelineBatch();
  const core = new WorldCore(host, map, host.quality.particles, CHUNK, false);
  await endPipelineBatch();
  const all = core.sim.systems.map((s) => s.name);
  const names = new Set(systems === 'all' ? all : systems);
  for (const n of names) if (!all.includes(n)) throw new Error(`no system "${n}" (${all.join(', ')})`);
  const filter = (s: SimSystem) => names.has(s.name);
  core.tiers.apply();
  core.sim.prime(core.globals);
  core.globals.collapseEnabled = true;
  await g.device.queue.onSubmittedWorkDone();
  const w: TinyWorld = {
    core,
    ticks: 0,
    systems: all,
    step: async (n) => {
      for (let i = 0; i < n; i++) core.sim.step(core.globals, filter);
      w.ticks += n;
      await g.device.queue.onSubmittedWorkDone();
    },
    read: (b) => core.readBuffer(b),
    sum: (buf, x0 = 0, y0 = 0, x1 = core.dims.w, y1 = core.dims.h) => {
      const W = core.dims.w;
      let s = 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) s += buf[y * W + x];
      return s;
    },
    destroy: () => core.destroy(),
  };
  return w;
}
