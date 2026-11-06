// A Globals buffer with only the tick's dt in it — all the road ride (shaders/roadride.wgsl) reads of the Globals.
import { GLOBALS_BYTES } from '../../src/sim/globals';

/** Globals.dt's f32 word (sim/globals.ts writeGlobals) */
const DT_WORD = 9;

export function globalsWithDt(dev: GPUDevice, dt: number): GPUBuffer {
  const b = new ArrayBuffer(GLOBALS_BYTES);
  new Float32Array(b)[DT_WORD] = dt;
  const buf = dev.createBuffer({ size: GLOBALS_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  dev.queue.writeBuffer(buf, 0, b);
  return buf;
}
