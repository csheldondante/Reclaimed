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
  /**
   * (round 128o, DA-B22) Render-only: what it keeps is only drawn, so it runs once a frame — on the frame's last tick —
   * however many ticks the frame runs (fast-forward: DESIGN §12), at one tick's step (its look is the wall's, not the
   * sim's speed). Simulation.frameTicks / tickOfFrame say where a tick lies in its frame.
   */
  readonly perFrame?: boolean;
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
