// (archgen, ?arch=1) The building generator in the game: citygen's TownBuildingsSink (api/contracts/citygen.ts). Each
// live town gets an ArchGen over its lot records, its parts made whenever a run rewrites the records (a whole town is
// well under a millisecond of GPU: DEVLOG archgen), drawn by the renderer placed by the town's own transform, its
// construction progress copied in each frame (a few KB, GPU to GPU) for the rise. Nothing is read back.

import type { CityLots, TownBuildingsSink } from '../api/contracts/citygen';
import { ArchGen, KIND, PARTS_PER_LOT } from './archgen';
import { archTextures } from './textures';

export interface TownBuildingsIO {
  device: GPUDevice;
  addArch(arch: GPUBuffer, args: GPUBuffer, xform: GPUBuffer): void;
  removeArch(args: GPUBuffer): void;
  /** run at the start of each frame's encode (Renderer.frameCompute) */
  frameCompute: ((enc: GPUCommandEncoder) => void)[];
}

/** lot slots for a count: room to grow without a remake (a later run's count past it remakes the generator) */
const roomFor = (count: number) => Math.ceil((count * 1.25 + 64) / 64) * 64;

export class TownBuildings implements TownBuildingsSink {
  private towns = new Map<string, { gen: ArchGen; lots: CityLots; room: number }>();
  readonly stats = { made: 0, remade: 0, runs: 0 };
  private hook = (enc: GPUCommandEncoder) => {
    for (const t of this.towns.values()) t.gen.copyProgress(enc, t.lots.progress);
  };

  constructor(private io: TownBuildingsIO) {
    io.frameCompute.push(this.hook);
    // (the Synty plants, when the local conversion loads: every town's lots made again with them)
    archTextures(io.device).whenPlants(() => this.remakeAll());
  }

  townMade(id: string, lots: CityLots, count: number): void {
    this.townDropped(id);
    const room = roomFor(count);
    const gen = new ArchGen(this.io.device, lots.records, lots.counts, { lots: room });
    this.towns.set(id, { gen, lots, room });
    this.io.addArch(gen.arch, gen.args, lots.place);
    this.stats.made++;
    this.make(id);
  }

  lotsChanged(id: string, count: number): void {
    const t = this.towns.get(id);
    if (!t) return;
    if (count > t.room) {
      // (more lots than its room: made again bigger — rare, a town that grew past a quarter more lots)
      this.stats.remade++;
      this.townMade(id, t.lots, count);
      return;
    }
    this.make(id);
  }

  townDropped(id: string): void {
    const t = this.towns.get(id);
    if (!t) return;
    this.io.removeArch(t.gen.args);
    t.gen.destroy();
    this.towns.delete(id);
  }

  /** every lot of the town made again, then the draw lists */
  private make(id: string): void {
    const t = this.towns.get(id)!;
    const e = this.io.device.createCommandEncoder({ label: `arch ${id}` });
    t.gen.generate(e, 0, t.room);
    t.gen.compact(e);
    this.io.device.queue.submit([e.finish()]);
    this.stats.runs++;
  }

  /** (the phone bench) every town's lots made again now */
  remakeAll(): void {
    for (const id of this.towns.keys()) this.make(id);
  }

  /** (the phone bench, never in play: a readback) each kind's instances over the live towns */
  async counts(): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    const names = Object.entries(KIND);
    for (const t of this.towns.values()) {
      const rb = this.io.device.createBuffer({ size: t.gen.args.size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
      const e = this.io.device.createCommandEncoder();
      e.copyBufferToBuffer(t.gen.args, 0, rb, 0, t.gen.args.size);
      this.io.device.queue.submit([e.finish()]);
      await rb.mapAsync(GPUMapMode.READ);
      const a = new Uint32Array(rb.getMappedRange().slice(0));
      rb.destroy();
      for (const [n, k] of names) {
        out[n] = (out[n] ?? 0) + a[k * 4 + 1];
        out.vertices = (out.vertices ?? 0) + a[k * 4] * a[k * 4 + 1];
      }
    }
    return out;
  }

  /** (?archdump=1, a debugging read, never in play) a town's generated parts and its lot records */
  townBuffers(id: string): { arch: GPUBuffer; partsWord: number; slots: number; records: GPUBuffer; counts: GPUBuffer } | null {
    const t = this.towns.get(id);
    if (!t) return null;
    return { arch: t.gen.arch, partsWord: t.gen.base.parts, slots: t.room * PARTS_PER_LOT, records: t.lots.records, counts: t.lots.counts };
  }

  get live(): number {
    return this.towns.size;
  }

  dispose(): void {
    for (const id of [...this.towns.keys()]) this.townDropped(id);
    const i = this.io.frameCompute.indexOf(this.hook);
    if (i >= 0) this.io.frameCompute.splice(i, 1);
  }
}
