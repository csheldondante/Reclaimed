// GPU particle system: emission from world state, CPU-requested bursts, and
// integration in the shared wind field. See src/shaders/particles.wgsl.

import { makeBindGroup, makeCompute, type ComputeKernel } from '../gpu/pipeline';
import type { Profiler } from '../gpu/profiler';
import commonWgsl from '../shaders/common.wgsl?raw';
import materialsWgsl from '../shaders/materials.wgsl?raw';
import particlesWgsl from '../shaders/particles.wgsl?raw';
import vegplanWgsl from '../shaders/vegplan.wgsl?raw';
import { dispatch, type SimSystem } from './system';
import type { WorldGpu } from './world-gpu';

export const enum PK {
  Dust = 1,
  Litter = 2,
  Leaf = 3,
  Ash = 4,
  Chip = 5,
  Cloud = 6,
  Splash = 7,
  Smoke = 8,
  Ember = 9,
  Bird = 10,
  Firefly = 11,
  Flame = 12,
  Deer = 13,
  Rabbit = 14,
  Haze = 15,
  Seed = 16,
  Spark = 17,
}

export interface Burst {
  kind: PK;
  x: number;
  y: number;
  z: number;
  count: number;
  speed: number;
  /** total contamination payload split across the burst */
  payload?: number;
  spread?: number;
}

const MAX_BURSTS = 64;

export class ParticleSystem implements SimSystem {
  readonly name = 'particles';
  readonly period = 1;
  private emitK: ComputeKernel;
  private burstK: ComputeKernel;
  private updateK: ComputeKernel;
  private fireK: ComputeKernel;
  private groupFire: GPUBindGroup;
  private group: GPUBindGroup;
  private groupBurst: GPUBindGroup;
  private groupUpdate: GPUBindGroup;
  private reqBuf: GPUBuffer;
  private reqData = new Float32Array((1 + MAX_BURSTS * 2) * 4);
  private queue: Burst[] = [];

  constructor(
    private device: GPUDevice,
    private world: WorldGpu,
    private prof: Profiler,
  ) {
    const parts = [commonWgsl, materialsWgsl, vegplanWgsl, particlesWgsl];
    const spec = {
      0: 'uniform',
      2: 'uniform',
      3: 'rw',
      4: 'rw',
      5: 'read',
      6: 'read',
      7: 'read',
      8: 'rw',
      9: 'rw',
      10: 'read',
      11: 'uniform',
      15: 'tex',
    } as const;
    this.emitK = makeCompute(device, 'particles-emit', parts, spec, 'emit');
    this.burstK = makeCompute(device, 'particles-burst', parts, spec, 'bursts');
    this.updateK = makeCompute(device, 'particles-update', parts, spec, 'update');
    this.fireK = makeCompute(device, 'particles-fire', parts, { 0: 'uniform', 2: 'uniform', 3: 'rw', 4: 'rw', 5: 'read', 12: 'read', 13: 'read', 15: 'tex' }, 'fireEmit');
    this.reqBuf = world.buf('particleRequests', this.reqData.byteLength, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    const bufs = {
      0: world.globals,
      2: world.materials,
      3: world.particles,
      4: world.particleCounters,
      5: world.surface,
      6: world.water,
      7: world.contam,
      8: world.contamDelta,
      9: world.veg,
      10: world.moisture,
      11: this.reqBuf,
      15: world.windFieldView,
    };
    this.group = makeBindGroup(device, 'particles', this.emitK.layout, bufs);
    this.groupBurst = makeBindGroup(device, 'particles', this.burstK.layout, bufs);
    this.groupUpdate = makeBindGroup(device, 'particles', this.updateK.layout, bufs);
    this.groupFire = makeBindGroup(device, 'particles-fire', this.fireK.layout, {
      0: world.globals,
      2: world.materials,
      3: world.particles,
      4: world.particleCounters,
      5: world.surface,
      12: world.fire,
      13: world.oil,
      15: world.windFieldView,
    });
  }

  /** Queue a burst; spawned on the next tick. */
  burst(b: Burst): void {
    if (this.queue.length < MAX_BURSTS) this.queue.push(b);
  }

  encode(enc: GPUCommandEncoder): void {
    dispatch(enc, this.prof, 'particles-emit', this.emitK, this.group, this.world.groups);
    dispatch(enc, this.prof, 'particles-fire', this.fireK, this.groupFire, this.world.groups);
    if (this.queue.length) {
      const d = this.reqData;
      d.fill(0);
      d[0] = this.queue.length;
      this.queue.forEach((b, i) => {
        const o = 4 + i * 8;
        d.set([b.x, b.y, b.z, b.count, b.kind, b.speed, b.payload ?? 0, b.spread ?? 0.5], o);
      });
      // ordered before this tick's submit, so the burst kernel sees it
      this.device.queue.writeBuffer(this.reqBuf, 0, d);
      dispatch(enc, this.prof, 'particles-burst', this.burstK, this.groupBurst, [1, 1]);
      this.queue = [];
    }
    dispatch(enc, this.prof, 'particles-update', this.updateK, this.groupUpdate, [Math.ceil(this.world.particleCap / 64), 1]);
  }
}
