// GPU-resident world state: every buffer that forms a contract between
// systems is allocated (and documented) here. Systems never allocate shared
// state themselves, so replacing one system's implementation cannot silently
// change what another system sees.

import type { Profiler } from '../gpu/profiler';
import type { PackedWorld } from '../world/layout';
import type { MapData } from '../world/mapgen';
import { packMaterialTable } from '../world/materials';
import { GLOBALS_BYTES } from './globals';

export const STATS_COUNT = 16;

const S = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;

export class WorldGpu {
  readonly w: number;
  readonly h: number;
  readonly cells: number;
  readonly zMax: number;
  readonly maxK: number;

  // shared, read by nearly every shader
  readonly globals: GPUBuffer;
  readonly materials: GPUBuffer;
  readonly chunks: GPUBuffer;

  // canonical layered world (material physics owns writes)
  readonly layers: GPUBuffer;
  readonly layersNext: GPUBuffer;
  /** per column: top z | top mat << 8 | slot count << 16 (surface system) */
  readonly surface: GPUBuffer;

  // water contract (water system owns writes)
  readonly water: GPUBuffer;
  readonly waterNext: GPUBuffer;
  readonly waterPrev: GPUBuffer;
  /** vec4 volume leaving toward +x,-x,+y,-y this tick */
  readonly flux: GPUBuffer;
  readonly waterSource: GPUBuffer;

  // oil: second liquid, floats on water (oil system owns writes)
  readonly oil: GPUBuffer;
  readonly oilNext: GPUBuffer;
  /** vec4 oil volume leaving toward +x,-x,+y,-y this tick */
  readonly oilFlux: GPUBuffer;
  /** vec2 per column: oil sealed in a closed tank (amount, roof z) — oil system releases it on breach */
  readonly oilStored: GPUBuffer;

  // environmental fields
  /** vec2: soil-bound, dissolved */
  readonly contam: GPUBuffer;
  readonly contamNext: GPUBuffer;
  readonly moisture: GPUBuffer;
  readonly moistureNext: GPUBuffer;
  /** succession stage 0..5 */
  readonly veg: GPUBuffer;
  readonly vegNext: GPUBuffer;

  /** fire intensity 0..1 per column (fire system owns writes) */
  readonly fire: GPUBuffer;
  readonly fireNext: GPUBuffer;

  // render preparation
  /** vec4 per column: shadow z, moisture, fire glow, flow speed (renderfields.wgsl) */
  readonly renderFields: GPUBuffer;
  /**
   * Wind field: rgba32float, one texel per 2×2 columns (cells/s): rg painted
   * wind, ba whole wind (map wind + painted; windfield.wgsl). Everything that
   * feels wind reads it. `windField` is read, `windFieldNext` written.
   */
  readonly windField: GPUTexture;
  readonly windFieldNext: GPUTexture;
  readonly windFieldView: GPUTextureView;
  readonly windFieldNextView: GPUTextureView;
  /**
   * Loose material arriving per column, vec4 (sediment.wgsl folds it into the
   * layers and zeroes it): x what the editor adds (+, its material from the
   * brush state) or takes away (−; edit.wgsl); y, z an amount and material
   * from the CPU (a crumbled body; game/integrity.ts writes them)
   */
  readonly deposit: GPUBuffer;
  /** sediment.wgsl's outflows per column (7 vec4: to each neighbour, the wind's easing, totals, spills out of exposed faces) */
  readonly sedOut: GPUBuffer;
  /**
   * The loose ground as seen from above (a view derived from the layers by
   * the surface pass, round 22): x depth of the granular run on top of the
   * column, y its top interval's depth, z that interval's material, w what
   * the wind sent up into the air off it (from `air`)
   */
  readonly drift: GPUTexture;
  readonly driftView: GPUTextureView;
  /** what the sediment pass's wind lifted into the air per column (copied into drift .w) */
  readonly air: GPUTexture;
  readonly airView: GPUTextureView;
  /** sleeping rigid bodies projected per column: top, bottom (top < 0: none) — game/integrity.ts writes it */
  readonly bodyProj: GPUTexture;
  readonly bodyProjView: GPUTextureView;
  /** derived by the surface pass: xyz the granular intervals beneath the top one in the run on top (bottom first, packed mat·1000 + depth), w the run's base z */
  readonly strata: GPUTexture;
  readonly strataView: GPUTextureView;
  /** sandbox brush state per column (edit.wgsl reads `editState`, writes `editStateNext`; particles read it) */
  readonly editState: GPUTexture;
  readonly editStateNext: GPUTexture;
  readonly editStateView: GPUTextureView;
  readonly editStateNextView: GPUTextureView;
  /** smoothed soft-ground corner heights (rgba32float, one texel per grid point; x = height or -1) */
  readonly cornerTex: GPUTexture;
  readonly cornerView: GPUTextureView;
  /** f32 per column: 1 = flowers in bloom, < 1 = shed by the wind and regrowing (particles.wgsl petalEmit) */
  readonly petals: GPUBuffer;
  /** vec2 per column: ground hostility to plants, plant brownness (wilt.wgsl) */
  readonly wilt: GPUBuffer;
  /** vec4 per column: vegetation lean xy + its velocity (sway.wgsl spring) */
  readonly bend: GPUBuffer;

  /** u32 aggregate counters, see src/sim/stats.ts */
  readonly stats: GPUBuffer;

  // particles (contract: particles.wgsl Particle struct, 48 bytes)
  readonly particleCap: number;
  readonly particles: GPUBuffer;
  /** [0] = ring head (monotonic), [1] = live estimate */
  readonly particleCounters: GPUBuffer;
  /**
   * Fixed-point (×1e5) soil-contamination exchange per column. Particles
   * atomically subtract when they pick pollution up and add when they drop it;
   * the contamination system folds it into `contam` and zeroes it.
   */
  readonly contamDelta: GPUBuffer;

  constructor(
    private device: GPUDevice,
    private profiler: Profiler,
    packed: PackedWorld,
    map: MapData,
    particleCap: number,
  ) {
    const { w, h, zMax } = packed.dims;
    this.w = w;
    this.h = h;
    this.cells = w * h;
    this.zMax = zMax;
    this.maxK = packed.maxK;
    const N = this.cells;

    this.globals = this.buf('globals', GLOBALS_BYTES, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    const mats = packMaterialTable();
    this.materials = this.buf('materials', mats.byteLength, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    device.queue.writeBuffer(this.materials, 0, mats);
    this.chunks = this.buf('chunks', packed.chunkTable.byteLength, S);
    device.queue.writeBuffer(this.chunks, 0, packed.chunkTable);

    this.layers = this.buf('layers', packed.slots.byteLength, S);
    this.layersNext = this.buf('layersNext', packed.slots.byteLength, S);
    device.queue.writeBuffer(this.layers, 0, packed.slots);
    this.surface = this.buf('surface', N * 4, S);

    this.water = this.buf('water', N * 4, S);
    this.waterNext = this.buf('waterNext', N * 4, S);
    this.waterPrev = this.buf('waterPrev', N * 4, S);
    this.flux = this.buf('flux', N * 16, S);
    this.waterSource = this.buf('waterSource', N * 4, S);
    device.queue.writeBuffer(this.water, 0, map.water);
    device.queue.writeBuffer(this.waterSource, 0, map.waterSource);

    this.oil = this.buf('oil', N * 4, S);
    this.oilNext = this.buf('oilNext', N * 4, S);
    this.oilFlux = this.buf('oilFlux', N * 16, S);
    device.queue.writeBuffer(this.oil, 0, map.oil);
    this.oilStored = this.buf('oilStored', N * 8, S);
    device.queue.writeBuffer(this.oilStored, 0, map.oilStored);

    this.contam = this.buf('contam', N * 8, S);
    this.contamNext = this.buf('contamNext', N * 8, S);
    device.queue.writeBuffer(this.contam, 0, map.contam);
    this.moisture = this.buf('moisture', N * 4, S);
    this.moistureNext = this.buf('moistureNext', N * 4, S);
    device.queue.writeBuffer(this.moisture, 0, map.moisture);
    this.veg = this.buf('veg', N * 4, S);
    this.vegNext = this.buf('vegNext', N * 4, S);
    device.queue.writeBuffer(this.veg, 0, map.vegetation);

    this.fire = this.buf('fire', N * 4, S);
    this.fireNext = this.buf('fireNext', N * 4, S);
    this.renderFields = this.buf('renderFields', N * 16, S);
    this.bend = this.buf('bend', N * 16, S);
    this.wilt = this.buf('wilt', N * 16, S);
    this.petals = this.buf('petals', N * 4, S);
    device.queue.writeBuffer(this.petals, 0, new Float32Array(N).fill(1));
    const wsize = { width: Math.ceil(this.w / 2), height: Math.ceil(this.h / 2) };
    const tusage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST;
    this.windField = device.createTexture({ label: 'windField', size: wsize, format: 'rgba32float', usage: tusage });
    this.windFieldNext = device.createTexture({ label: 'windFieldNext', size: wsize, format: 'rgba32float', usage: tusage });
    this.textures.push(this.windField, this.windFieldNext);
    this.windFieldView = this.windField.createView();
    this.cornerTex = device.createTexture({ label: 'corners', size: { width: this.w, height: this.h }, format: 'rgba32float', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING });
    this.textures.push(this.cornerTex);
    this.cornerView = this.cornerTex.createView();
    this.windFieldNextView = this.windFieldNext.createView();
    const dsize = { width: this.w, height: this.h };
    this.drift = device.createTexture({ label: 'drift', size: dsize, format: 'rgba32float', usage: tusage });
    this.air = device.createTexture({ label: 'air', size: dsize, format: 'rgba32float', usage: tusage });
    this.textures.push(this.drift, this.air);
    this.driftView = this.drift.createView();
    this.airView = this.air.createView();
    this.bodyProj = device.createTexture({ label: 'bodyProj', size: dsize, format: 'rgba32float', usage: tusage });
    this.textures.push(this.bodyProj);
    this.bodyProjView = this.bodyProj.createView();
    {
      const none = new Float32Array(N * 4);
      for (let k = 0; k < N; k++) none[k * 4] = -1;
      device.queue.writeTexture({ texture: this.bodyProj }, none, { bytesPerRow: this.w * 16 }, dsize);
    }
    this.strata = device.createTexture({ label: 'strata', size: dsize, format: 'rgba32float', usage: tusage });
    this.textures.push(this.strata);
    this.strataView = this.strata.createView();
    this.editState = device.createTexture({ label: 'editState', size: dsize, format: 'rgba32float', usage: tusage });
    this.editStateNext = device.createTexture({ label: 'editStateNext', size: dsize, format: 'rgba32float', usage: tusage });
    this.textures.push(this.editState, this.editStateNext);
    this.editStateView = this.editState.createView();
    this.editStateNextView = this.editStateNext.createView();
    this.stats = this.buf('stats', STATS_COUNT * 4, S);

    this.particleCap = particleCap;
    this.particles = this.buf('particles', particleCap * 48, S);
    this.particleCounters = this.buf('particleCounters', 16, S);
    // two halves: [0, N) contamination, [N, 2N) dust landing from the air
    // (particles carry what the wind lifts off the loose layer; drift.wgsl
    // folds it back in where they land — round 15)
    this.contamDelta = this.buf('contamDelta', N * 8, S);
    this.deposit = this.buf('deposit', N * 16, S);
    this.sedOut = this.buf('sedOut', N * 7 * 16, S);
  }

  private owned: GPUBuffer[] = [];
  private textures: GPUTexture[] = [];

  /** Free every GPU buffer this world (and anything allocated through buf()) owns. */
  destroy(): void {
    for (const b of this.owned) b.destroy();
    for (const t of this.textures) t.destroy();
    this.owned = [];
    this.textures = [];
  }

  buf(label: string, size: number, usage: GPUBufferUsageFlags): GPUBuffer {
    const b = this.device.createBuffer({ label, size: Math.ceil(size / 4) * 4, usage });
    this.owned.push(b);
    this.profiler.trackMemory(label, size);
    return b;
  }

  /** A texture shaped like `like` (copies of world textures, e.g. undo), freed with the world. */
  texture(label: string, like: GPUTexture): GPUTexture {
    const t = this.device.createTexture({ label, size: [like.width, like.height], format: like.format, usage: GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST });
    this.textures.push(t);
    return t;
  }

  /** Workgroup counts for an 8×8 per-column dispatch. */
  get groups(): [number, number] {
    return [Math.ceil(this.w / 8), Math.ceil(this.h / 8)];
  }
}
