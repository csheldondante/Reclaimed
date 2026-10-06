// Simulation system interface (design doc §9, §23, §24).
// A system is a black box that reads/writes WorldGpu contract buffers on a
// fixed tick period. Implementations can be swapped as long as they honour
// the buffers they publish (documented in world-gpu.ts and each shader).

import type { ComputeKernel } from '../gpu/pipeline';
import type { Profiler } from '../gpu/profiler';

export interface SimSystem {
  readonly name: string;
  /** Run every `period` ticks (1 = every tick). */
  readonly period: number;
  encode(enc: GPUCommandEncoder, tick: number): void;
}

export function dispatch(
  enc: GPUCommandEncoder,
  profiler: Profiler,
  name: string,
  kernel: ComputeKernel,
  group: GPUBindGroup,
  groups: [number, number],
): void {
  const pass = enc.beginComputePass({ label: name, timestampWrites: profiler.timestamps(name) });
  pass.setPipeline(kernel.pipeline);
  pass.setBindGroup(0, group);
  pass.dispatchWorkgroups(groups[0], groups[1]);
  pass.end();
  profiler.dispatches++;
}
