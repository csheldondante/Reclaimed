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
import { unpackColumns } from '../world/mapfile';
import { looseIntoGrid } from '../world/loose';
import { DayNight, type Daylight } from '../weather/daynight';
import { Weather } from '../weather/weather';
import { Structures } from '../grids/structures';
import { Places } from '../game/places';

export interface Quality {
  renderScale: number;
  maxDpr: number;
  rain: number;
  maxTicksPerFrame: number;
  particles: number;
  /** the agents' field relax sweeps a tick (default 8; agents.ts `sweeps`) */
  agentSweeps?: number;
  /** field mesh chunks rebuilt a frame at most (round 81: a phone's a slide's rebuilds spread over more frames; default 8) */
  meshSlots?: number;
  /** the sun's shadow map's side, texels (default 2048) */
  shadowSize?: number;
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
  /** structure grids over the nature grid (docs/GRIDS.md) */
  readonly structures: Structures;
  readonly weather: Weather;
  /** regions and rooms as named places (docs/PLACES.md): places.load(plan) */
  readonly places: Places;
  readonly dayNight = new DayNight();
  /** Seconds of simulation a year takes (round 51; globals.season); 0: the season stays put. */
  yearLength = 0;
  readonly camera = new Camera();
  readonly globals: GlobalsState;
  readonly packed: PackedWorld;
  readonly dims: { w: number; h: number; zMax: number };
  private acc = 0;
  private t0 = performance.now();
  private strikeAge = 99;
  pollution = 1;
  /** sleep and wake (round 80, sim/sleep.ts), when the scene has it: what writes the columns wakes them */
  sleep?: import('../sim/sleep').Sleep;
  /** per-column buffers of the modules a game installed (agents' fields): a streamed window's slide moves them (round 80) */
  readonly columnBufs: { name: string; buf: GPUBuffer; stride: number; planes: number }[] = [];
  /** what a slide moves besides the columns (units, bodies): dx cells, dy world units, dz cells (round 80) */
  readonly onShift: ((dx: number, dy: number, dz: number) => void)[] = [];
  /** bumped at a streamed window's slide's start and end: a readback that straddles one is stale (round 80) */
  windowEpoch = 0;
  light!: Daylight;

  constructor(
    readonly host: Host,
    readonly map: MapData,
    particleCap: number,
    minK?: number,
    /** drawn with the field mesh unless ?mesh=0 (the sandbox, round 45; a game that wants it) */
    fieldMesh = false,
    /** the field mesh's room a chunk, times its default (rougher land needs more: the atlas's, round 67) */
    meshRoom = 1,
  ) {
    const { device } = host.gpu;
    this.dims = map.grid.dims;
    // a map's loose stacks (drift, strata) go into the layers as intervals
    // (round 22: one representation for everything on the land)
    looseIntoGrid(map);
    this.packed = packColumns(map.grid, minK);
    this.world = new WorldGpu(device, host.profiler, this.packed, map, particleCap);
    this.sim = new Simulation(device, this.world, host.profiler);
    this.renderer = new Renderer(device, host.gpu.format, this.world, host.profiler, fieldMesh, host.quality.shadowSize, meshRoom, host.quality.meshSlots);
    this.structures = new Structures(device, this.world);
    this.weather = new Weather(map.surface, this.dims.w, this.dims.h);
    this.places = new Places(device, this.world, this.sim.placeOps, this.weather);
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
      cyclones: [],
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
    this.strikeAge += speed > 0 ? simDt / speed : 1 / 60;
    g.flash = Math.min(0.999, flashEnvelope(this.strikeAge));
    g.windOff = [g.windOff[0] + g.windX * simDt, g.windOff[1] + g.windY * simDt];
    g.dusts = this.weather.dustUniforms();
    g.cyclones = this.weather.cycloneUniforms();
    this.dayNight.update(simDt);
    // the year turns (round 51: seconds per year; 0 holds the season where it is)
    if (this.yearLength > 0) g.season = ((g.season ?? 0) + simDt / this.yearLength) % 1;
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
    // (round 82, ?skip=render: nothing drawn or prepared to draw — the mesh not built, no prep, no passes;
    // streaming, generation and the sim go on: what the frame costs without its rendering)
    if (Renderer.skip.has('render')) {
      const after = prof.endFrame(enc);
      device.queue.submit([enc.finish()]);
      after?.();
      return;
    }
    this.renderer.encode(enc, context.getCurrentTexture().createView(), this.camera, {
      clear: flashSky(this.light.clear, this.globals.flash),
      sun: this.light.dir,
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
    return this.readTexture(this.world.windField);
  }

  /** Read back an rgba32float texture, rows unpadded (4 floats per texel). */
  async readTexture(tex: GPUTexture): Promise<{ data: Float32Array; w: number; h: number }> {
    const { device } = this.host.gpu;
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

  /** The live world as map data (saving a sandbox map: world/mapfile.ts). */
  async captureMap(): Promise<MapData> {
    const N = this.dims.w * this.dims.h;
    const [layers, water, contam, moisture, veg, oil, oilStored, waterSource] = await Promise.all([
      this.readBuffer('layers'),
      this.readBuffer('water'),
      this.readBuffer('contam'),
      this.readBuffer('moisture'),
      this.readBuffer('veg'),
      this.readBuffer('oil'),
      this.readBuffer('oilStored'),
      this.readBuffer('waterSource'),
    ]);
    const grid = unpackColumns(this.packed, new Uint32Array(layers.buffer));
    const surface = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const c = grid.cols[i];
      surface[i] = c.length ? c[c.length - 1].z1 : 0;
    }
    // (the loose ground is in the layers: no separate stacks to save)
    const d = new Float32Array(N);
    return {
      grid,
      water: water.slice(0, N),
      contam: contam.slice(0, N * 2),
      moisture: moisture.slice(0, N),
      vegetation: veg.slice(0, N),
      oil: oil.slice(0, N),
      oilStored: oilStored.slice(0, N * 2),
      waterSource: waterSource.slice(0, N),
      drift: d,
      surface,
      poi: this.map.poi,
    };
  }

  // ---- undo (sandbox): GPU-side copies of the editable world state ----------
  private undoRing: { bufs: GPUBuffer[] }[] = [];
  private undoNext = 0;
  private undoCount = 0;
  private static readonly UNDO_DEPTH = 8;
  private undoSources(): GPUBuffer[] {
    const w = this.world;
    return [w.layers, w.water, w.oil, w.oilStored, w.contam, w.moisture, w.veg];
  }

  /** Remember the world as it is now (called at the start of each brush press). */
  snapshot(): void {
    const { device } = this.host.gpu;
    const src = this.undoSources();
    if (this.undoRing.length < WorldCore.UNDO_DEPTH && this.undoRing.length <= this.undoNext) {
      this.undoRing.push({
        bufs: src.map((b) => this.world.buf(`undo:${b.label}`, b.size, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST)),
      });
    }
    const slot = this.undoRing[this.undoNext];
    const enc = device.createCommandEncoder({ label: 'snapshot' });
    src.forEach((b, k) => enc.copyBufferToBuffer(b, 0, slot.bufs[k], 0, b.size));
    device.queue.submit([enc.finish()]);
    this.undoNext = (this.undoNext + 1) % WorldCore.UNDO_DEPTH;
    this.undoCount = Math.min(this.undoCount + 1, WorldCore.UNDO_DEPTH);
  }

  /** Forget the snapshots (the streamed window slid: they're of another place). */
  clearUndo(): void {
    this.undoCount = 0;
  }

  /** Put back the last snapshot; false when there is none. */
  undo(): boolean {
    if (this.undoCount === 0) return false;
    const { device } = this.host.gpu;
    this.undoNext = (this.undoNext + WorldCore.UNDO_DEPTH - 1) % WorldCore.UNDO_DEPTH;
    this.undoCount--;
    const slot = this.undoRing[this.undoNext];
    const src = this.undoSources();
    const enc = device.createCommandEncoder({ label: 'undo' });
    src.forEach((b, k) => enc.copyBufferToBuffer(slot.bufs[k], 0, b, 0, b.size));
    // (the loose ground lives in the layers; its view is derived each tick)
    // pours in flight would land on the restored ground: drop them
    enc.clearBuffer(this.world.deposit);
    device.queue.submit([enc.finish()]);
    const zero = new Float32Array(this.dims.w * this.dims.h * 4);
    for (const t of [this.world.editState, this.world.editStateNext]) {
      device.queue.writeTexture({ texture: t }, zero, { bytesPerRow: this.dims.w * 16 }, [this.dims.w, this.dims.h]);
    }
    return true;
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
