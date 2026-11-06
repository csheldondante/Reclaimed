// (round 128o, DA-B20; DESIGN.md §24 — no timed read back in play) The water's settling hold, on the GPU: a woken chunk
// whose water still changes stays awake (shaders/settlehold.wgsl), where the level read the change per chunk back twice
// a second (8 KB) for sim/sleep.ts to extend its time. The CPU keeps what it knows — which chunks an event woke within
// SETTLE_MAX_S (Sleep.settleCand), put on the culled passes' lists — and the GPU decides, each tick, which of them
// still run. API: SettleHold, HOLD_S.
import commonWgsl from '../shaders/common.wgsl?raw';
import settleholdWgsl from '../shaders/settlehold.wgsl?raw';
import { makeBindGroup, makeCompute, type ComputeKernel } from '../gpu/pipeline';
import type { WorldGpu } from './world-gpu';
import { TICK_DT } from './simulation';

/** how long a chunk is held after its water last changed by more than the tolerance (s of sim time) */
export const HOLD_S = 0.75;
/** how long a chunk let go is drowsy (s of sim time: sim/sleep.ts DROWSE_S) */
const DROWSE_S = 0.25;
/** where Globals.sleep starts (sim/globals.ts writeGlobals: word 284), and the drowse after it (word 348) */
const SLEEP_BYTE = 284 * 4;
/** the two masks, 64 words each */
const MASKS_BYTES = 512;
const SLOTS = 2048;

export class SettleHold {
  private k: ComputeKernel;
  private cand: GPUBuffer;
  private held: GPUBuffer;
  private eff: GPUBuffer;
  private params: GPUBuffer;
  private group: GPUBindGroup;

  constructor(
    private device: GPUDevice,
    private world: WorldGpu,
  ) {
    this.k = makeCompute(device, 'settlehold', [commonWgsl, settleholdWgsl], { 0: 'uniform', 3: 'read', 4: 'read', 5: 'rw', 6: 'rw', 7: 'uniform' }, 'hold');
    const S = GPUBufferUsage.STORAGE;
    this.cand = device.createBuffer({ label: 'settle cand', size: 256, usage: S | GPUBufferUsage.COPY_DST });
    this.held = device.createBuffer({ label: 'settle held', size: SLOTS * 8, usage: S });
    this.eff = device.createBuffer({ label: 'settle masks', size: MASKS_BYTES, usage: S | GPUBufferUsage.COPY_SRC });
    this.params = device.createBuffer({ label: 'settle params', size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.group = makeBindGroup(device, 'settlehold', this.k.layout, { 0: world.globals, 3: world.waterChange, 4: this.cand, 5: this.held, 6: this.eff, 7: this.params });
  }

  /**
   * This tick's hold, before its passes: `cand` the slots that may still be settling (a bit a slot), `tol` the water's
   * change a step that keeps one awake. The Globals' sleep and drowse masks are overwritten with the held ones.
   */
  encode(enc: GPUCommandEncoder, cand: Uint32Array, tol: number): void {
    const p = new ArrayBuffer(16);
    new Float32Array(p, 0, 1)[0] = tol;
    new Uint32Array(p, 4, 2).set([Math.ceil(HOLD_S / TICK_DT), Math.ceil(DROWSE_S / TICK_DT)]);
    this.device.queue.writeBuffer(this.params, 0, p);
    this.device.queue.writeBuffer(this.cand, 0, cand.buffer, cand.byteOffset, 256);
    const pass = enc.beginComputePass({ label: 'settlehold' });
    pass.setPipeline(this.k.pipeline);
    pass.setBindGroup(0, this.group);
    pass.dispatchWorkgroups(1);
    pass.end();
    enc.copyBufferToBuffer(this.eff, 0, this.world.globals, SLEEP_BYTE, MASKS_BYTES);
    enc.clearBuffer(this.world.waterChange);
  }

  destroy(): void {
    for (const b of [this.cand, this.held, this.eff, this.params]) b.destroy();
  }
}
