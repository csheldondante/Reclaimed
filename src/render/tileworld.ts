// A render-only tile's world (round 108, TC18; DECISIONS round 108 — the user: "My expectation is that the tiles are
// essentially the visual only version of full tiles so I wouldn't expect them to me different").
//
// The window's land is drawn from what its render preparation derives from its columns: SurfaceSystem (each column's
// surface word — the base of its loose ground, the material under it, its slot count — and the drift, strata and
// levels textures: the loose ground drawn smoothed, snow and sand among it) and RenderFieldsSystem (the moisture the
// wet ground darkens by, the glow, the held rivers' flow). A render-only tile's land had none of it: its surface was the
// top's height alone, its drift, moisture and flow zero. Here the same two systems run on the tile's own land — a
// world of the scratch's size whose layers are the scratch slot's pages, its kept fields copied in as the streamer
// copies a region into the window — and the bake draws through what they made. No simulation runs: nothing else
// steps this world.
//
// One a TileLandGpu: its bakes are encoded one after another, each a copy in (`arrive`), the preparation (`prepare`),
// the bake reading it.

import type { Profiler } from '../gpu/profiler';
import type { WorldGpu } from '../sim/world-gpu';
import { RenderFieldsSystem, SurfaceSystem, type PrepWorld } from '../sim/systems';
import type { RegionLayout } from '../world/region-record';
import { PROJ_K } from '../grids/structures';

export class TileWorld implements PrepWorld {
  readonly globals: GPUBuffer;
  readonly materials: GPUBuffer;
  readonly chunks: GPUBuffer;
  readonly tiles = null;
  readonly layers: GPUBuffer;
  readonly surface: GPUBuffer;
  readonly moisture: GPUBuffer;
  readonly fire: GPUBuffer;
  readonly flux: GPUBuffer;
  readonly renderFields: GPUBuffer;
  readonly water: GPUBuffer;
  readonly veg: GPUBuffer;
  readonly lava: GPUBuffer;
  readonly contam: GPUBuffer;
  readonly wilt: GPUBuffer;
  readonly meshRegion: GPUBuffer;
  readonly driftView: GPUTextureView;
  readonly airView: GPUTextureView;
  readonly strataView: GPUTextureView;
  readonly projView: GPUTextureView;
  readonly levelsView: GPUTextureView;
  readonly cornerView: GPUTextureView;
  readonly riverFlowView: GPUTextureView;
  private riverFlow: GPUTexture;
  private surfaceSys: SurfaceSystem;
  private fieldsSys: RenderFieldsSystem;
  /** the per-column buffers copied in from a slot (the layout's kept ones this world has) */
  private copies: { name: string; dst: GPUBuffer }[] = [];

  /** `side`: the scratch's cells a side (its layout's R); `land`: the slots' buffer, the layers the chunk table reads */
  constructor(dev: GPUDevice, world: WorldGpu, profiler: Profiler, private layout: RegionLayout, land: GPUBuffer) {
    const S = layout.R;
    const N = S * S;
    const B = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST;
    const buf = (label: string, bytes: number, usage = B) => world.buf(`tileworld ${label}`, bytes, usage);
    this.globals = buf('globals', world.globals.size, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    this.materials = world.materials;
    // (the window's: the field mesh on — renderfields takes the flow, not the sun's march — as the window's own)
    this.meshRegion = world.meshRegion;
    this.chunks = buf('chunks', layout.rc * layout.rc * 8);
    this.layers = land;
    this.surface = buf('surface', N * 4);
    this.renderFields = buf('renderFields', N * 16);
    const per = (name: string, stride: number) => {
      const b = buf(name, N * stride);
      if (layout.bufs.some((x) => x.name === name)) this.copies.push({ name, dst: b });
      return b;
    };
    this.moisture = per('moisture', 4);
    this.fire = per('fire', 4);
    this.flux = per('flux', 24);
    this.water = per('water', 4);
    this.veg = per('veg', 4);
    this.lava = per('lava', 16);
    this.contam = per('contam', 8);
    this.wilt = per('wilt', 16);
    const tu = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_DST;
    const tex = (label: string, w: number) => dev.createTexture({ label: `tileworld ${label}`, size: [w, S], format: 'rgba32float', usage: tu });
    this.driftView = tex('drift', S).createView();
    this.airView = tex('air', S).createView();
    this.strataView = tex('strata', S).createView();
    this.levelsView = tex('levels', S).createView();
    this.projView = tex('proj', S * PROJ_K).createView();
    this.cornerView = tex('corners', S * 5).createView();
    this.riverFlow = tex('riverFlow', S);
    this.riverFlowView = this.riverFlow.createView();
    profiler.trackMemory('tileworld', N * (4 + 16 + 4 + 4 + 24 + 4 + 4 + 16 + 8 + 16) + N * 16 * (6 + PROJ_K + 5));
    const tp = profiler.named('tile-');
    this.surfaceSys = new SurfaceSystem(dev, this, tp);
    this.fieldsSys = new RenderFieldsSystem(dev, this, tp);
  }

  get groups(): [number, number] {
    return [Math.ceil(this.layout.R / 8), Math.ceil(this.layout.R / 8)];
  }

  /** a slot's land into this world: its chunk table (onto the slot's pages), its kept fields and the rivers' table —
   *  as the streamer's copyIn brings a pool slot into the window. The Globals are the caller's (written into `globals`) */
  arrive(enc: GPUCommandEncoder, table: GPUBuffer, slotOff: number): void {
    const L = this.layout;
    enc.copyBufferToBuffer(table, 0, this.chunks, 0, this.chunks.size);
    for (const c of this.copies) {
      const b = L.bufs.find((x) => x.name === c.name)!;
      enc.copyBufferToBuffer(this.layers, slotOff + b.off, c.dst, 0, b.bytes);
    }
    // (what isn't kept starts empty, as a fresh region's does)
    if (!this.copies.some((c) => c.name === 'flux')) enc.clearBuffer(this.flux);
    if (!this.copies.some((c) => c.name === 'fire')) enc.clearBuffer(this.fire);
    const t = L.texs.find((x) => x.name === 'riverFlow');
    if (!t) throw new Error('TileWorld: the region layout keeps no riverFlow');
    enc.copyBufferToTexture({ buffer: this.layers, offset: slotOff + t.off, bytesPerRow: t.rowBytes, rowsPerImage: t.th }, { texture: this.riverFlow }, [t.tw, t.th]);
  }

  /** the window's render preparation on it (no simulation): the surface words and textures, the render fields */
  prepare(enc: GPUCommandEncoder): void {
    this.surfaceSys.encode(enc);
    this.fieldsSys.encode(enc);
  }
}
