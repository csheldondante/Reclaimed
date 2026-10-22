// The field mesh (G13 C, a prototype; fieldmesh.wgsl, meshdraw.wgsl): over
// one region, the terrain and the structure grids drawn as one surface
// meshed from a field evaluated from the intervals and voxels, instead of as
// prisms and cubes. ?mesh=1 turns it on over the map's middle (?mesh=x,y,r:
// centred on world x, y, r cells each way); ?meshh= the sample spacing (0.5);
// ?meshevery=N rebuilds every N frames (1: every frame, the worst case — no
// dirty tracking yet). The GPU does all of it; this side writes the region
// (a uniform) and dispatches.

import { ignoreTeardown, makeBindGroup, makeCompute, type ComputeKernel } from '../gpu/pipeline';
import type { Profiler } from '../gpu/profiler';
import commonWgsl from '../shaders/common.wgsl?raw';
import layersWgsl from '../shaders/layers.wgsl?raw';
import materialsWgsl from '../shaders/materials.wgsl?raw';
import gridsWgsl from '../shaders/grids.wgsl?raw';
import meshRegionWgsl from '../shaders/meshregion.wgsl?raw';
import fieldMeshWgsl from '../shaders/fieldmesh.wgsl?raw';
import type { WorldGpu } from '../sim/world-gpu';

/** bytes of the region uniform (meshregion.wgsl MeshRegion) */
export const REGION_BYTES = 48;
const MAX_VERTS = 1 << 19;
const MAX_INDICES = 6 * MAX_VERTS;
const ROW_H = Math.sqrt(3) / 2;

export class FieldMesh {
  /** the region uniform (bound by renderprep, vegprep and structprep too: off when the mesh is) */
  readonly region: GPUBuffer;
  readonly verts: GPUBuffer;
  readonly indices: GPUBuffer;
  /** drawIndexedIndirect args, then the vertex count */
  readonly counts: GPUBuffer;
  readonly on: boolean;
  private kernels: ComputeKernel[] = [];
  private groups: GPUBindGroup[] = [];
  private scratch?: GPUBuffer;
  private n: [number, number, number] = [0, 0, 0];
  private every: number;
  private frame = 0;
  /** last-known vertex and index counts (async readback) */
  stats = { verts: 0, indices: 0 };
  private statBuf: GPUBuffer;
  private statBusy = false;
  private statNeeded = false;

  constructor(
    private device: GPUDevice,
    private world: WorldGpu,
    private profiler: Profiler,
  ) {
    const q = new URLSearchParams(location.search);
    const arg = q.get('mesh');
    this.on = arg !== null && arg !== '0';
    this.every = Math.max(1, Number(q.get('meshevery') ?? 1));
    this.region = world.buf('meshRegion', REGION_BYTES, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    this.verts = world.buf('meshVerts', this.on ? MAX_VERTS * 32 : 32, GPUBufferUsage.STORAGE);
    this.indices = world.buf('meshIndices', this.on ? MAX_INDICES * 4 : 4, GPUBufferUsage.STORAGE | GPUBufferUsage.INDEX);
    this.counts = world.buf('meshCounts', 32, GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC);
    this.statBuf = world.buf('meshStats', 32, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST);
    if (!this.on) {
      device.queue.writeBuffer(this.region, 0, new ArrayBuffer(REGION_BYTES));
      return;
    }
    const parts = arg!.split(',').map(Number);
    const W = world.w + 0.5;
    const H = world.h * ROW_H;
    const [cx, cy, r] = parts.length >= 3 ? parts : [W / 2, H / 2, 24];
    this.setRegion(cx, cy, r, Number(q.get('meshh') ?? 0.5));
    for (const entry of ['sampleField', 'makeVerts', 'makeQuads']) {
      const k = makeCompute(
        device,
        `fieldmesh-${entry}`,
        [commonWgsl, layersWgsl, materialsWgsl, gridsWgsl, meshRegionWgsl, fieldMeshWgsl],
        { 0: 'uniform', 1: 'read', 2: 'uniform', 3: 'read', 4: 'read', 5: 'read', 6: 'rw', 7: 'rw', 8: 'rw', 9: 'rw', 30: 'uniform' },
        entry,
      );
      this.kernels.push(k);
    }
  }

  /** Mesh the square r cells each way round world (cx, cy), sampled every h. */
  setRegion(cx: number, cy: number, r: number, h = 0.5): void {
    const zHi = this.world.zMax + 2;
    const nx = Math.ceil((2 * r) / h) + 1;
    const nz = Math.ceil((zHi + 1) / h) + 1;
    this.n = [nx, nx, nz];
    const x0 = cx - r;
    const y0 = cy - r;
    const ab = new ArrayBuffer(REGION_BYTES);
    const f = new Float32Array(ab);
    const u = new Uint32Array(ab);
    // (the samples start a step under the bedrock so its floor closes)
    f.set([x0, y0, -h, h], 0);
    u.set([nx, nx, nz, 1], 4);
    // the prisms leave the mesh the columns whose centres lie a cell inside
    // it (its outermost vertices sit a quarter cell in: the mesh's edge and
    // the prisms' overlap rather than gape)
    f.set([x0 + 1, y0 + 1, x0 + 2 * r - 1, y0 + 2 * r - 1], 8);
    this.device.queue.writeBuffer(this.region, 0, ab);
    const samples = nx * nx * nz;
    this.scratch?.destroy();
    this.scratch = this.world.buf('meshScratch', samples * 8, GPUBufferUsage.STORAGE);
    this.groups = this.kernels.length ? this.makeGroups() : [];
    this.frame = 0;
  }

  private makeGroups(): GPUBindGroup[] {
    const w = this.world;
    return this.kernels.map((k) =>
      makeBindGroup(this.device, 'fieldmesh', k.layout, {
        0: w.globals,
        1: w.chunks,
        2: w.materials,
        3: w.layers,
        4: w.strFrames,
        5: w.strVox,
        6: this.scratch!,
        7: this.verts,
        8: this.indices,
        9: this.counts,
        30: this.region,
      }),
    );
  }

  /** Rebuild the mesh (every `every` frames). */
  encode(enc: GPUCommandEncoder): void {
    if (!this.on) return;
    if (!this.groups.length) this.groups = this.makeGroups();
    if (this.frame++ % this.every !== 0) return;
    this.device.queue.writeBuffer(this.counts, 0, new Uint32Array([0, 1, 0, 0, 0, 0, 0, 0]));
    const pass = enc.beginComputePass({ label: 'fieldmesh', timestampWrites: this.profiler.timestamps('fieldmesh') });
    const [nx, ny, nz] = this.n;
    const wg: [number, number, number] = [Math.ceil(nx / 4), Math.ceil(ny / 4), Math.ceil(nz / 4)];
    this.kernels.forEach((k, i) => {
      pass.setPipeline(k.pipeline);
      pass.setBindGroup(0, this.groups[i]);
      pass.dispatchWorkgroups(...wg);
    });
    pass.end();
    this.profiler.dispatches += 3;
    if (!this.statBusy) {
      enc.copyBufferToBuffer(this.counts, 0, this.statBuf, 0, 32);
      this.statBusy = true;
      this.statNeeded = true;
    }
  }

  draw(pass: GPURenderPassEncoder): void {
    if (!this.on) return;
    pass.setIndexBuffer(this.indices, 'uint32');
    pass.drawIndexedIndirect(this.counts, 0);
  }

  afterSubmit(): void {
    if (!this.statNeeded) return;
    this.statNeeded = false;
    this.statBuf.mapAsync(GPUMapMode.READ).then(() => {
      const u = new Uint32Array(this.statBuf.getMappedRange());
      this.stats = { verts: u[5], indices: u[0] };
      this.statBuf.unmap();
      setTimeout(() => (this.statBusy = false), 250);
    }, ignoreTeardown);
  }
}
