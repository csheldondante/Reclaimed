// The pieces on the GPU (any host: the viewer, the game's renderer): the module library in one vertex and one index
// buffer, the palette and the pieces in one storage buffer (shaders/structmesh.wgsl reads both), one instanced draw a
// module in use (pieces sorted by module; firstInstance offsets into them — core WebGPU, no indirect-first-instance).
// Why instancing: a module is stored once however many thousand walls use it; the pieces are 64 bytes each.
import type { StructurePieces } from '../api/contracts/structures';
import { library } from './modules';
import { PIECE_FLOATS } from './pieces';
import { PARTS } from './modules';
import { STYLES, STYLE_IDS, VARIANTS } from './styles';

/** vec4s of palette at the head of the data buffer */
export const SP_PAL = STYLE_IDS.length * PARTS * VARIANTS;

export interface DrawRange {
  module: number;
  /** its far look (modules.ts lodOf) */
  lod: number;
  first: number;
  count: number;
}

export class StructureGpu {
  verts!: GPUBuffer;
  index!: GPUBuffer;
  data!: GPUBuffer;
  /** bumped whenever a buffer is made anew (the host makes its bind group again) */
  version = 0;
  ranges: DrawRange[] = [];
  private mods: { first: number; count: number; base: number }[] = [];
  private libSize = 0;
  private dataCap = 0;
  readonly stats = { pieces: 0, draws: 0, tris: 0, lodTris: 0, modules: 0, bytes: 0 };

  constructor(private device: GPUDevice) {
    this.uploadLibrary();
    this.ensureData(64);
  }

  wgsl(): string {
    return `const SP_PAL: u32 = ${SP_PAL}u;\n`;
  }

  private uploadLibrary(): void {
    const lib = library();
    if (lib.modules.length === this.libSize) return;
    let nv = 0;
    let ni = 0;
    this.mods = lib.modules.map((m) => {
      const r = { first: ni, count: m.index.length, base: nv };
      nv += m.verts.length / 4;
      ni += m.index.length;
      return r;
    });
    const v = new Float32Array(nv * 4);
    const ix = new Uint32Array(ni);
    lib.modules.forEach((m, i) => {
      v.set(m.verts, this.mods[i].base * 4);
      ix.set(m.index, this.mods[i].first);
    });
    this.verts?.destroy();
    this.index?.destroy();
    this.verts = this.device.createBuffer({ label: 'struct verts', size: v.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(this.verts, 0, v);
    this.index = this.device.createBuffer({ label: 'struct index', size: ix.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(this.index, 0, ix);
    this.libSize = lib.modules.length;
    this.stats.modules = lib.modules.length;
  }

  private ensureData(pieces: number): void {
    const need = (SP_PAL + pieces * 4) * 16;
    if (need <= this.dataCap) return;
    const cap = Math.max(need, Math.ceil(this.dataCap * 1.5));
    this.data?.destroy();
    this.data = this.device.createBuffer({ label: 'struct data', size: cap, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.dataCap = cap;
    this.version++;
    const pal = new Float32Array(SP_PAL * 4);
    STYLE_IDS.forEach((id, s) => {
      const st = STYLES[id];
      for (let p = 0; p < PARTS; p++) {
        const vars = st.palette[p];
        for (let k = 0; k < VARIANTS; k++) {
          const c = vars[Math.min(k, vars.length - 1)];
          const o = ((s * PARTS + p) * VARIANTS + k) * 4;
          // (linear: the palette is authored in sRGB)
          pal[o] = Math.pow(c[0], 2.2);
          pal[o + 1] = Math.pow(c[1], 2.2);
          pal[o + 2] = Math.pow(c[2], 2.2);
          pal[o + 3] = Math.min(vars.length, VARIANTS);
        }
      }
    });
    this.device.queue.writeBuffer(this.data, 0, pal);
  }

  /** Show these pieces (replacing what was shown). */
  set(p: StructurePieces): void {
    // (the far looks first: asking for one may make a module — then the library is uploaded with it)
    const lib = library();
    const lodOf = new Map<number, number>();
    for (let i = 0; i < p.count; i++) if (!lodOf.has(p.module[i])) lodOf.set(p.module[i], lib.lodOf(p.module[i]));
    this.uploadLibrary();
    this.ensureData(p.count);
    const order = Array.from({ length: p.count }, (_, i) => i).sort((a, b) => p.module[a] - p.module[b]);
    const buf = new Float32Array(p.count * PIECE_FLOATS);
    this.ranges = [];
    order.forEach((src, dst) => {
      buf.set(p.data.subarray(src * PIECE_FLOATS, src * PIECE_FLOATS + PIECE_FLOATS), dst * PIECE_FLOATS);
      const m = p.module[src];
      const last = this.ranges[this.ranges.length - 1];
      if (last && last.module === m) last.count++;
      else this.ranges.push({ module: m, lod: lodOf.get(m)!, first: dst, count: 1 });
    });
    if (buf.byteLength) this.device.queue.writeBuffer(this.data, SP_PAL * 16, buf);
    let tris = 0;
    let lodTris = 0;
    for (const r of this.ranges) {
      tris += (this.mods[r.module].count / 3) * r.count;
      lodTris += (this.mods[r.lod].count / 3) * r.count;
    }
    this.stats.lodTris = lodTris;
    this.stats.pieces = p.count;
    this.stats.draws = this.ranges.length;
    this.stats.tris = tris;
    this.stats.bytes = this.dataCap + this.verts.size + this.index.size;
  }

  /** the draws (pipeline and bind group set by the host); `lod`: every piece in its far look */
  draw(pass: GPURenderPassEncoder, lod = false): number {
    pass.setVertexBuffer(0, this.verts);
    pass.setIndexBuffer(this.index, 'uint32');
    for (const r of this.ranges) {
      const m = this.mods[lod ? r.lod : r.module];
      pass.drawIndexed(m.count, r.count, m.first, m.base, r.first);
    }
    return this.ranges.length;
  }

  /** the vertex layout every host's pipeline uses */
  static vertexLayout(): GPUVertexBufferLayout {
    return { arrayStride: 16, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x4' }] };
  }

  destroy(): void {
    this.verts.destroy();
    this.index.destroy();
    this.data.destroy();
  }
}
