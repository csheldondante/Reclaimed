// Everything a live world needs, independent of what the scene does with it:
// GPU state, simulation, renderer, weather, day/night, camera and Globals.
// The level and the menu each own one (the menu's is a tiny diorama).

import type { Gpu } from '../gpu/device';
import type { Profiler } from '../gpu/profiler';
import { Camera } from '../render/camera';
import { Renderer } from '../render/renderer';
import type { GlobalsState } from '../sim/globals';
import { Simulation, TICK_DT } from '../sim/simulation';
import type { SimSystem } from '../sim/system';
import { WorldGpu } from '../sim/world-gpu';
import { CHUNK, packColumns, type PackedWorld } from '../world/layout';
import type { MapData } from '../world/mapgen';
import { DayNight, type Daylight } from '../weather/daynight';
import { Weather } from '../weather/weather';

export interface Quality {
  renderScale: number;
  maxDpr: number;
  rain: number;
  maxTicksPerFrame: number;
  particles: number;
}

/** Shared services a scene runs on. */
export interface Host {
  gpu: Gpu;
  profiler: Profiler;
  quality: Quality;
  qualityName: string;
  params: URLSearchParams;
  canvas: HTMLCanvasElement;
  ui: HTMLElement;
}

export interface Scene {
  /** @param dt real seconds since last frame (clamped) */
  frame(now: number, dt: number): void;
  resize(renderW: number, renderH: number, cssW: number, cssH: number): void;
  dispose(): void;
}

export class WorldCore {
  readonly world: WorldGpu;
  readonly sim: Simulation;
  readonly renderer: Renderer;
  readonly weather: Weather;
  readonly dayNight = new DayNight();
  readonly camera = new Camera();
  readonly globals: GlobalsState;
  readonly packed: PackedWorld;
  readonly dims: { w: number; h: number; zMax: number };
  private acc = 0;
  private t0 = performance.now();
  private strikeAge = 99;
  pollution = 1;
  light!: Daylight;

  constructor(
    private host: Host,
    readonly map: MapData,
    particleCap: number,
  ) {
    const { device } = host.gpu;
    this.dims = map.grid.dims;
    this.packed = packColumns(map.grid);
    this.world = new WorldGpu(device, host.profiler, this.packed, map, particleCap);
    this.sim = new Simulation(device, this.world, host.profiler);
    this.renderer = new Renderer(device, host.gpu.format, this.world, host.profiler);
    this.weather = new Weather(map.surface, this.dims.w, this.dims.h);
    this.globals = {
      mapW: this.dims.w,
      mapH: this.dims.h,
      tick: 0,
      chunkSize: CHUNK,
      chunksX: this.packed.chunksX,
      zMax: this.dims.zMax,
      seed: 1,
      time: 0,
      dt: TICK_DT,
      windX: this.weather.windX,
      windY: this.weather.windY,
      sun: [0.75, -0.3, 0.62],
      pollution: 1,
      storms: [],
      events: [],
      collapseEnabled: false,
      flash: 0,
      gusts: [],
      sky: [0.34, 0.33, 0.31, 0],
      sunCol: [2.4, 2.0, 1.55, 0.35],
      lens: [0, 0, 0, 0],
      windOff: [0, 0],
      debrisBoost: 1,
      difficulty: 1,
      dusts: [],
      cyclone: [0, 0, 1, 0],
      cycloneB: [0, 0, 0, 0],
    };
    this.light = this.dayNight.light(1);
  }

  /** Settle the generated world with the real systems before anyone looks. */
  async warmup(ticks: number, filter?: (s: SimSystem) => boolean): Promise<void> {
    this.sim.prime(this.globals);
    for (let i = 0; i < ticks; i++) {
      // support needs a few ticks to propagate before collapse can be judged
      this.globals.collapseEnabled = i > 120;
      this.sim.step(this.globals, filter);
    }
    this.globals.collapseEnabled = true;
    await this.host.gpu.device.queue.onSubmittedWorkDone();
  }

  /** Advance light, weather and the fixed-step simulation. Returns ticks run. */
  advance(now: number, simDt: number, speed: number, filter?: (s: SimSystem) => boolean): number {
    const g = this.globals;
    this.weather.time = g.time;
    this.weather.update(simDt);
    g.windX = this.weather.windX;
    g.windY = this.weather.windY;
    g.time = (now - this.t0) / 1000;
    g.storms = this.weather.uniforms();
    g.pollution = this.pollution;
    // lightning: powers set flash = 1 at the strike; it flickers and fades
    // (a bright stroke, a brief dip, a re-strike, then a decay over ~1 s)
    if (g.flash >= 1) this.strikeAge = 0;
    this.strikeAge += simDt / speed;
    g.flash = Math.min(0.999, flashEnvelope(this.strikeAge));
    g.windOff = [g.windOff[0] + g.windX * simDt, g.windOff[1] + g.windY * simDt];
    g.dusts = this.weather.dustUniforms();
    const cy = this.weather.cycloneUniform();
    g.cyclone = cy.a;
    g.cycloneB = cy.b;
    this.dayNight.update(simDt);
    this.light = this.dayNight.light(this.pollution);
    g.sun = this.light.dir;
    g.sunCol = [this.light.col[0], this.light.col[1], this.light.col[2], this.light.timeOfDay];
    g.sky = [this.light.sky[0], this.light.sky[1], this.light.sky[2], this.light.night];

    const maxTicks = this.host.quality.maxTicksPerFrame * speed;
    this.acc += simDt;
    let ticks = 0;
    while (this.acc >= TICK_DT && ticks < maxTicks) {
      this.sim.step(g, filter);
      this.acc -= TICK_DT;
      ticks++;
    }
    if (ticks === maxTicks) this.acc = Math.min(this.acc, TICK_DT); // drop time instead of spiralling
    return ticks;
  }

  render(): void {
    const { device, context } = this.host.gpu;
    const prof = this.host.profiler;
    this.camera.update();
    this.sim.uploadGlobals(this.globals);
    const enc = device.createCommandEncoder({ label: 'frame' });
    const q = this.host.quality;
    this.renderer.encode(enc, context.getCurrentTexture().createView(), this.camera, {
      clear: flashSky(this.light.clear, this.globals.flash),
      rainParticles: Math.round(this.weather.storms.reduce((a, st) => a + q.rain * 0.55 * st.intensity * (st.radius / 26), 0)),
    });
    const afterProfile = prof.endFrame(enc);
    device.queue.submit([enc.finish()]);
    this.renderer.afterSubmit();
    afterProfile?.();
  }

  resize(renderW: number, renderH: number, cssW: number, cssH: number): void {
    this.camera.viewportW = cssW;
    this.camera.viewportH = cssH;
    this.renderer.resize(renderW, renderH);
  }

  destroy(): void {
    this.renderer.destroy();
    this.world.destroy();
  }

  /** Debug / occasional gameplay readback of a whole world buffer. */
  async readBuffer(name: keyof WorldGpu): Promise<Float32Array> {
    const { device } = this.host.gpu;
    const src = this.world[name] as unknown as GPUBuffer;
    const tmp = device.createBuffer({ size: src.size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const enc = device.createCommandEncoder();
    enc.copyBufferToBuffer(src, 0, tmp, 0, src.size);
    device.queue.submit([enc.finish()]);
    await tmp.mapAsync(GPUMapMode.READ);
    const out = new Float32Array(tmp.getMappedRange()).slice();
    tmp.destroy();
    return out;
  }

  /**
   * Read back the wind field (rgba32float, one texel per 2×2 columns: rg
   * painted, ba whole wind) for CPU consumers (storms). Rows are padded to
   * 256 bytes on the GPU side.
   */
  async readWindField(): Promise<{ data: Float32Array; w: number; h: number }> {
    const { device } = this.host.gpu;
    const tex = this.world.windField;
    const w = tex.width;
    const h = tex.height;
    const rowBytes = Math.ceil((w * 16) / 256) * 256;
    const tmp = device.createBuffer({ size: rowBytes * h, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const enc = device.createCommandEncoder();
    enc.copyTextureToBuffer({ texture: tex }, { buffer: tmp, bytesPerRow: rowBytes }, [w, h]);
    device.queue.submit([enc.finish()]);
    await tmp.mapAsync(GPUMapMode.READ);
    const raw = new Float32Array(tmp.getMappedRange());
    const data = new Float32Array(w * h * 4);
    const rowF = rowBytes / 4;
    for (let y = 0; y < h; y++) data.set(raw.subarray(y * rowF, y * rowF + w * 4), y * w * 4);
    tmp.unmap();
    tmp.destroy();
    return { data, w, h };
  }

  /** Debug: mean of a per-column field over a square region. */
  async probe(name: keyof WorldGpu, x: number, y: number, r = 6, stride = 1, comp = 0): Promise<number> {
    const f = await this.readBuffer(name);
    const { w, h } = this.dims;
    let s = 0;
    let n = 0;
    for (let yy = y - r; yy <= y + r; yy++)
      for (let xx = x - r; xx <= x + r; xx++) {
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        s += f[(yy * w + xx) * stride + comp];
        n++;
      }
    return s / n;
  }
}

/** Lightning brightness over time since the strike (0 after ~1 s). */
function flashEnvelope(t: number): number {
  if (t > 1.2) return 0;
  const flicker = t < 0.07 ? 1 : t < 0.13 ? 0.2 : t < 0.2 ? 0.9 : t < 0.26 ? 0.35 : 1;
  return Math.exp(-t * 3.2) * flicker;
}

/** The sky (clear colour) flares cold white with the flash. */
function flashSky(c: [number, number, number], f: number): [number, number, number] {
  return [c[0] + (0.85 - c[0]) * f, c[1] + (0.88 - c[1]) * f, c[2] + (0.98 - c[2]) * f];
}
