// The instanced mesh renderer (round 99, `?meshinst=1`; the user, DECISIONS round 99: "I think we want to replace the
// characters and the buildings and trees with meshes and instancing. We want this to be faster on phone"). A small
// set of mesh kinds (made in code: render/treemesh.ts) in one vertex and one index buffer; instances in one storage
// buffer, CAP a kind; drawn with one indexed indirect draw a kind (its args' instance count written by whoever makes
// the instances: the GPU's vegetation pass for trees), lit and shadowed as the terrain is (render.wgsl lighting),
// depth-tested against it, cut away as it is (cutAway). meshinst.wgsl draws them.
//
// An instance is four vec4<f32>: three rows of an affine transform (local → world: turn, scale, lean, skew — rows
// x, y, z, translation in w) and its params (x the trunk's height, y the crown's base, z its height, w its half-width:
// the mesh's parts are stretched to them before the transform; a part-2 vertex is taken as it is).

import type { MeshKind } from './treemesh';

/** instances a kind may have at once */
export const MI_CAP = 8192;
/** vec4s an instance */
export const MI_STRIDE = 4;
/** where the kinds' draw args start in the renderer's indirect buffer (u32 words; 5 a kind: drawIndexedIndirect's) */
export const MI_ARGS_WORD = 24;

export class MeshInstances {
  readonly verts: GPUBuffer;
  readonly index: GPUBuffer;
  readonly instances: GPUBuffer;
  /** per kind: first index, index count, base vertex, vertex count */
  readonly ranges: { first: number; count: number; base: number; nv: number }[] = [];
  readonly stats = { kinds: 0, verts: 0, tris: 0, bytes: 0 };

  constructor(
    device: GPUDevice,
    readonly kinds: MeshKind[],
    buf: (label: string, size: number, usage: number) => GPUBuffer,
    /** (round 119, flora) instances a kind may have (MI_CAP by default; the flora library's many kinds take fewer) */
    readonly cap = MI_CAP,
  ) {
    let nv = 0;
    let ni = 0;
    for (const k of kinds) {
      this.ranges.push({ first: ni, count: k.index.length, base: nv, nv: k.verts.length / 4 });
      nv += k.verts.length / 4;
      ni += k.index.length;
    }
    const v = new Float32Array(nv * 4);
    const ix = new Uint32Array(ni);
    kinds.forEach((k, i) => {
      v.set(k.verts, this.ranges[i].base * 4);
      // (round 119, the phone: the kind rides in each vertex's w, + 16 × kind — meshinst.wgsl reads it in one step where
      // it searched every kind's vertex range per vertex, a loop of ~40 on the phone's vertex stage)
      for (let j = this.ranges[i].base * 4 + 3; j < (this.ranges[i].base + this.ranges[i].nv) * 4; j += 4) v[j] += 16 * i;
      ix.set(k.index, this.ranges[i].first);
    });
    this.verts = buf('meshinst verts', v.byteLength, GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST);
    device.queue.writeBuffer(this.verts, 0, v);
    this.index = buf('meshinst index', Math.ceil(ix.byteLength / 4) * 4, GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST);
    device.queue.writeBuffer(this.index, 0, ix);
    this.instances = buf('meshinst instances', kinds.length * cap * MI_STRIDE * 16, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
    this.stats = { kinds: kinds.length, verts: nv, tris: ni / 3, bytes: v.byteLength + ix.byteLength + kinds.length * cap * MI_STRIDE * 16 };
  }

  /** The draw args a frame starts from (each kind: its indices, no instances yet), at MI_ARGS_WORD. */
  argsReset(): Uint32Array {
    const a = new Uint32Array(this.kinds.length * 5);
    this.ranges.forEach((r, k) => a.set([r.count, 0, r.first, r.base, 0], k * 5));
    return a;
  }

  /** The WGSL constants meshinst.wgsl (and the kernels that write instances) read. */
  wgsl(): string {
    const rows = this.ranges.map((r) => `vec2<u32>(${r.base}u, ${r.base + r.nv}u)`).join(', ');
    return `const MI_CAP: u32 = ${this.cap}u;\nconst MI_N: u32 = ${this.kinds.length}u;\nconst MI_ARGS: u32 = ${MI_ARGS_WORD}u;\nconst MI_KINDS = array<vec2<u32>, ${this.kinds.length}>(${rows});\n`;
  }

  /** (tests, the perf overlay) the instances each kind drew last (read back from the draw args) */
  async counts(device: GPUDevice, indirect: GPUBuffer): Promise<number[]> {
    const n = this.kinds.length * 5 * 4;
    const tmp = device.createBuffer({ label: 'meshinst counts', size: n, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const enc = device.createCommandEncoder();
    enc.copyBufferToBuffer(indirect, MI_ARGS_WORD * 4, tmp, 0, n);
    device.queue.submit([enc.finish()]);
    await tmp.mapAsync(GPUMapMode.READ);
    const u = new Uint32Array(tmp.getMappedRange().slice(0));
    tmp.destroy();
    return this.kinds.map((_, k) => u[k * 5 + 1]);
  }

  /** Draw every kind (the pipeline, the group and the vertex/index buffers set by the caller); `only` (round 117,
   *  flora: the shadow pass) a flag a kind, those left out not drawn. */
  draw(pass: GPURenderPassEncoder, indirect: GPUBuffer, only?: boolean[]): number {
    pass.setVertexBuffer(0, this.verts);
    pass.setIndexBuffer(this.index, 'uint32');
    let n = 0;
    for (let k = 0; k < this.kinds.length; k++) {
      if (only && !only[k]) continue;
      pass.drawIndexedIndirect(indirect, (MI_ARGS_WORD + k * 5) * 4);
      n++;
    }
    return n;
  }
}
