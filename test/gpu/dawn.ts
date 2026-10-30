// Helpers for the gpu tier (docs/TESTING.md): the game's device (gpu/device.ts requestGpu, as the page asks for it),
// GPU validation errors collected and failed on (never swallowed: CLAUDE.md "GPU validation errors surface"), and a
// buffer read back.
import { requestGpu } from '../../src/gpu/device';

export interface TestGpu {
  device: GPUDevice;
  adapterInfo: string;
  /** the uncaptured errors since the last call (and cleared) */
  takeErrors(): string[];
  /** a buffer's bytes [off, off + size) */
  read(buf: GPUBuffer, size: number, off?: number): Promise<ArrayBuffer>;
  destroy(): void;
}

/**
 * The tier's one device (vitest.config.ts: the gpu files run in one worker, not isolated). Dawn keeps what it compiled
 * for a device: the first tiny WorldCore pays its ~100 pipelines (~10 s on DXC here), every later one ~0.1 s.
 */
let shared: Promise<TestGpu> | null = null;
export function testGpu(): Promise<TestGpu> {
  return (shared ??= makeGpu());
}

async function makeGpu(): Promise<TestGpu> {
  const g = await requestGpu(navigator.gpu);
  const errors: string[] = [];
  g.device.addEventListener('uncapturederror', (ev) => errors.push(String((ev as GPUUncapturedErrorEvent).error.message)));
  return {
    device: g.device,
    adapterInfo: g.adapterInfo,
    takeErrors: () => errors.splice(0),
    read: async (buf, size, off = 0) => {
      const dev = g.device;
      const rd = dev.createBuffer({ label: 'test readback', size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
      const enc = dev.createCommandEncoder();
      enc.copyBufferToBuffer(buf, off, rd, 0, size);
      dev.queue.submit([enc.finish()]);
      await rd.mapAsync(GPUMapMode.READ);
      const out = rd.getMappedRange().slice(0);
      rd.unmap();
      rd.destroy();
      return out;
    },
    // (the device is the tier's: a file's teardown only drops what errors it left)
    destroy: () => void errors.splice(0),
  };
}
