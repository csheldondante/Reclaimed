// GPU particle system: emission from world state, CPU-requested bursts, and
// integration in the shared wind field. See src/shaders/particles.wgsl.

import { makeBindGroup, makeCompute, type ComputeKernel } from '../gpu/pipeline';
import type { Profiler } from '../gpu/profiler';
import commonWgsl from '../shaders/common.wgsl?raw';
import materialsWgsl from '../shaders/materials.wgsl?raw';
import particlesWgsl from '../shaders/particles.wgsl?raw';
import vegplanWgsl from '../shaders/vegplan.wgsl?raw';
import { dispatch, type SimSystem } from './system';
import { AWAY, LIVE, TILES_BINDING, cullKernel, dispatchTiles } from './cull';
import type { BindKind } from '../gpu/pipeline';

/** (round 104, simscale) ?emitslow=N: a sleeping chunk's emitters run every N ticks at N times the chances (1: every
 *  tick, the whole window, as before) */
const EMIT_SLOW = (() => {
  const v = typeof location === 'undefined' ? null : new URLSearchParams(location.search).get('emitslow');
  const n = v === null ? 8 : Number(v);
  if (!(n >= 1 && Number.isInteger(n))) throw new Error(`?emitslow=${v}: ticks between a sleeping chunk's emissions, 1 or more`);
  return n;
})();

/**
 * The emitters' code for a sleeping chunk's slow turn: every chance EMIT_SLOW times as large (particles.wgsl rare()
 * is a spawn's chance a tick; the petals' and the flames' draws; the petals' regrowth a tick).
 */
function slowEmit(src: string): string {
  let out = `const EMIT_K: f32 = ${EMIT_SLOW}.0;\n` + src;
  const swap = (a: string | RegExp, b: string) => {
    const before = out;
    out = out.replace(a, b);
    if (out === before) throw new Error(`particles: slowEmit found no ${a}`);
  };
  swap('/ 4294967296.0 / simStep(); }', '/ 4294967296.0 / (simStep() * EMIT_K); }');
  swap('min(fl.y * RUN_GRAINS * 0.5, 3.0) * min(f32(arrayLength(&parts)) / 65536.0, 1.0) * simStep();', 'min(fl.y * RUN_GRAINS * 0.5, 3.0) * min(f32(arrayLength(&parts)) / 65536.0, 1.0) * simStep() * EMIT_K;');
  swap('pt + 1.0 / (45.0 * 60.0)', 'pt + EMIT_K / (45.0 * 60.0)');
  swap('< (ws - 9.0) * 0.01)', '< (ws - 9.0) * 0.01 * EMIT_K)');
  swap('< (ws - 7.0) * 0.02)', '< (ws - 7.0) * 0.02 * EMIT_K)');
  swap('if (r1 < f * 0.35)', 'if (r1 < f * 0.35 * EMIT_K)');
  swap('if (r2 < f * 0.03)', 'if (r2 < f * 0.03 * EMIT_K)');
  swap('if (r2 < f * 0.07)', 'if (r2 < f * 0.07 * EMIT_K)');
  swap('if (r3 < f * 0.015)', 'if (r3 < f * 0.015 * EMIT_K)');
  return out;
}
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
  Petal = 18,
  Glow = 19,
  Funnel = 20,
  Grain = 21,
}

export interface Burst {
  kind: PK;
  x: number;
  y: number;
  z: number;
  count: number;
  speed: number;
  /** total contamination payload split across the burst (Haze: the material that tints it) */
  payload?: number;
  spread?: number;
  /** cells/s added to each particle's own velocity (not birds: they fly their own way) */
  vel?: readonly [number, number, number];
}

const MAX_BURSTS = 64;
/** floats a burst request (particles.wgsl bursts: three vec4) */
const REQ = 12;

export class ParticleSystem implements SimSystem {
  readonly name = 'particles';
  readonly period = 1;
  private emitK: ComputeKernel;
  private burstK: ComputeKernel;
  private updateK: ComputeKernel;
  private fireK: ComputeKernel;
  private petalK: ComputeKernel;
  private groupPetal: GPUBindGroup;
  private groupFire: GPUBindGroup;
  private group: GPUBindGroup;
  private groupBurst: GPUBindGroup;
  private groupUpdate: GPUBindGroup;
  private reqBuf: GPUBuffer;
  private reqData = new Float32Array(4 + MAX_BURSTS * REQ);
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
      17: 'tex',
      18: 'tex',
      19: 'tex',
      21: 'tex',
      22: 'stex',
    } as const;
    this.emitK = makeCompute(device, 'particles-emit', parts, spec, 'emit');
    // (round 104, simscale: the emitters over the live chunks every tick, the sleeping ones on a slow turn — below)
    if (world.tiles && EMIT_SLOW > 1) this.split = { emit: [], fire: [], petals: [] };
    this.burstK = makeCompute(device, 'particles-burst', parts, spec, 'bursts');
    this.updateK = makeCompute(device, 'particles-update', parts, spec, 'update');
    const fireSpec: Record<number, BindKind> = { 0: 'uniform', 2: 'uniform', 3: 'rw', 4: 'rw', 5: 'read', 12: 'read', 13: 'read', 15: 'tex' };
    const petalSpec: Record<number, BindKind> = { 0: 'uniform', 2: 'uniform', 3: 'rw', 4: 'rw', 5: 'read', 9: 'rw', 14: 'read', 15: 'tex', 16: 'rw', 17: 'tex' };
    this.fireK = makeCompute(device, 'particles-fire', parts, fireSpec, 'fireEmit');
    this.petalK = makeCompute(device, 'particles-petals', parts, petalSpec, 'petalEmit');
    const petalBufs = {
      0: world.globals,
      2: world.materials,
      3: world.particles,
      4: world.particleCounters,
      5: world.surface,
      9: world.veg,
      14: world.wilt,
      15: world.windFieldView,
      16: world.petals,
      17: world.driftView,
    };
    this.groupPetal = makeBindGroup(device, 'particles-petals', this.petalK.layout, petalBufs);
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
      17: world.driftView,
      18: world.editStateView,
      19: world.airView,
      21: world.bodyProjView,
      22: world.sparkView,
    };
    this.group = makeBindGroup(device, 'particles', this.emitK.layout, bufs);
    this.groupBurst = makeBindGroup(device, 'particles', this.burstK.layout, bufs);
    this.groupUpdate = makeBindGroup(device, 'particles', this.updateK.layout, bufs);
    const fireBufs = {
      0: world.globals,
      2: world.materials,
      3: world.particles,
      4: world.particleCounters,
      5: world.surface,
      12: world.fire,
      13: world.oil,
      15: world.windFieldView,
    };
    this.groupFire = makeBindGroup(device, 'particles-fire', this.fireK.layout, fireBufs);
    if (this.split) {
      this.splitOf('emit', 'emit', spec, bufs);
      this.splitOf('fire', 'fireEmit', fireSpec, fireBufs);
      this.splitOf('petals', 'petalEmit', petalSpec, petalBufs);
    }
  }

  /**
   * (round 104, simscale) The emitters split by the sleep mask (sim/cull.ts): over the live chunks every tick as
   * before, and over the sleeping ones each on its turn every EMIT_SLOW ticks with EMIT_SLOW times the chances — the
   * same dust, leaves, petals and flames on average, at 1/EMIT_SLOW the cost. Null: ?emitslow=1, the whole window
   * every tick.
   */
  private split: Record<'emit' | 'fire' | 'petals', { k: ComputeKernel; g: GPUBindGroup; n: number }[]> | null = null;
  private splitOf(name: 'emit' | 'fire' | 'petals', entry: string, spec: Record<number, BindKind>, bufs: Record<number, GPUBuffer | GPUTextureView>): void {
    const t = this.world.tiles!;
    const src = [commonWgsl, materialsWgsl, vegplanWgsl, particlesWgsl].join('\n');
    for (const [n, code] of [
      [LIVE, src],
      [AWAY + EMIT_SLOW, slowEmit(src)],
    ] as const) {
      const c = cullKernel(t, code, spec, entry, n);
      const k = makeCompute(this.device, `particles-${name}`, [c.code], c.spec, entry);
      this.split![name].push({ k, n, g: makeBindGroup(this.device, `particles-${name} ${n}`, k.layout, { ...bufs, [TILES_BINDING]: c.buf }) });
    }
  }

  /** Queue a burst; spawned on the next tick (past MAX_BURSTS a tick, on the ticks after). */
  burst(b: Burst): void {
    this.queue.push(b);
  }

  encode(enc: GPUCommandEncoder): void {
    if (this.split) {
      for (const [name, list] of Object.entries(this.split)) for (const x of list) dispatchTiles(enc, this.prof, `particles-${name}`, x.k, x.g, this.world.tiles!, x.n);
    } else {
      dispatch(enc, this.prof, 'particles-emit', this.emitK, this.group, this.world.groups);
      dispatch(enc, this.prof, 'particles-fire', this.fireK, this.groupFire, this.world.groups);
      dispatch(enc, this.prof, 'particles-petals', this.petalK, this.groupPetal, this.world.groups);
    }
    if (this.queue.length) {
      const d = this.reqData;
      d.fill(0);
      const now = this.queue.slice(0, MAX_BURSTS);
      d[0] = now.length;
      now.forEach((b, i) => {
        const o = 4 + i * REQ;
        const v = b.vel ?? [0, 0, 0];
        d.set([b.x, b.y, b.z, b.count, b.kind, b.speed, b.payload ?? 0, b.spread ?? 0.5, v[0], v[1], v[2], 0], o);
      });
      // ordered before this tick's submit, so the burst kernel sees it
      this.device.queue.writeBuffer(this.reqBuf, 0, d);
      dispatch(enc, this.prof, 'particles-burst', this.burstK, this.groupBurst, [1, 1]);
      this.queue = this.queue.slice(MAX_BURSTS);
    }
    dispatch(enc, this.prof, 'particles-update', this.updateK, this.groupUpdate, [Math.ceil(this.world.particleCap / 64), 1]);
  }
}
