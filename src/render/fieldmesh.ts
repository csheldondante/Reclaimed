// The field mesh (G13 h; fieldmesh.wgsl, meshdraw.wgsl): the whole map's
// terrain drawn as one surface meshed from a field evaluated from the
// intervals and the structures' voxels, in place of prisms and sheets. In
// chunks of the world; the GPU finds the chunks that changed and rebuilds a
// few a frame. ?mesh=1 turns it on; ?meshh= the sample spacing (1; 0.5 is
// finer and four times the cost). This side writes the layout (a uniform),
// dispatches, and culls to the view: the chunks drawn, and the chunks
// rebuilt (near the view; the rest when they come into it).

import { ignoreTeardown, makeBindGroup, makeCompute, type ComputeKernel } from '../gpu/pipeline';
import type { Profiler } from '../gpu/profiler';
import commonWgsl from '../shaders/common.wgsl?raw';
import layersWgsl from '../shaders/layers.wgsl?raw';
import materialsWgsl from '../shaders/materials.wgsl?raw';
import gridsWgsl from '../shaders/grids.wgsl?raw';
import meshRegionWgsl from '../shaders/meshregion.wgsl?raw';
import fieldMeshWgsl from '../shaders/fieldmesh.wgsl?raw';
import type { WorldGpu } from '../sim/world-gpu';
import type { Camera } from './camera';

/** bytes of the layout uniform (meshregion.wgsl MeshRegion) */
export const REGION_BYTES = 64;
/** a chunk's side, world units */
const CHUNK = 32;
const ROW_H = Math.sqrt(3) / 2;
/** fieldmesh.wgsl CHUNK0, CSTRIDE (u32s) */
const CHUNK0 = 16;
const CSTRIDE = 12;

export class FieldMesh {
  /** the layout uniform (world.meshRegion: renderprep, vegprep and renderfields read it) */
  readonly region: GPUBuffer;
  readonly on: boolean;
  private verts!: GPUBuffer;
  private indices!: GPUBuffer;
  /** change detection, rebuild slots, and each chunk's draw args (fieldmesh.wgsl binding 9) */
  private state!: GPUBuffer;
  private scratch!: GPUBuffer;
  private kernels: ComputeKernel[] = [];
  private groups: GPUBindGroup[] = [];
  private hash!: ComputeKernel;
  private hashGroup!: GPUBindGroup;
  /** chunks along x, y; samples along z; a chunk's cells per side (N); rebuild slots */
  private nx = 0;
  private ny = 0;
  private nz = 0;
  private side = 0;
  private slots = 0;
  /** chunks drawn last frame (after culling) */
  drawn = 0;
  /** per chunk: near the view (rebuilt when changed; written to the state), in it (drawn) */
  private near = new Uint32Array(0);
  private inView = new Uint8Array(0);
  /** last-known: chunks found changed that frame, the mesh's size, chunks out of room (async readback) */
  stats = { changed: 0, verts: 0, indices: 0, full: 0 };
  private statBuf?: GPUBuffer;
  private statBusy = false;
  private statNeeded = false;
  private statEvery = 0;

  constructor(
    private device: GPUDevice,
    private world: WorldGpu,
    private profiler: Profiler,
  ) {
    const q = new URLSearchParams(location.search);
    const arg = q.get('mesh');
    this.on = arg !== null && arg !== '0';
    this.region = world.meshRegion;
    if (!this.on) {
      device.queue.writeBuffer(this.region, 0, new ArrayBuffer(REGION_BYTES));
      return;
    }
    const h = Number(q.get('meshh') ?? 1);
    const W = world.w + 0.5;
    const H = world.h * ROW_H;
    this.nx = Math.ceil(W / CHUNK);
    this.ny = Math.ceil(H / CHUNK);
    this.side = Math.round(CHUNK / h);
    this.nz = Math.ceil((world.zMax + 2) / h) + 2;
    // rebuild slots a frame: their scratch is the big cost in memory
    this.slots = h >= 1 ? 8 : 3;
    // room per chunk: ~1.3k vertices per 1000 columns at spacing 1 (~5k at
    // 0.5; DEVLOG 2026-10-22), a chunk ~1.2k columns, four times that for
    // cliffs and caves
    const vertsPer = Math.ceil(6144 / (h * h) / 64) * 64;
    const indicesPer = vertsPer * 6;
    const chunks = this.nx * this.ny;
    const ab = new ArrayBuffer(REGION_BYTES);
    const f = new Float32Array(ab);
    const u = new Uint32Array(ab);
    f.set([CHUNK, h, 0, 0], 0);
    u.set([this.nx, this.ny, this.nz, 1], 4);
    u.set([this.side, this.slots, vertsPer, indicesPer], 8);
    // every column is the mesh's
    f.set([-1, -1, W + 1, H + 1], 12);
    device.queue.writeBuffer(this.region, 0, ab);

    this.verts = world.buf('meshVerts', chunks * vertsPer * 32, GPUBufferUsage.STORAGE);
    this.indices = world.buf('meshIndices', chunks * indicesPer * 4, GPUBufferUsage.STORAGE | GPUBufferUsage.INDEX);
    const stateWords = CHUNK0 + chunks * (CSTRIDE + 1);
    this.state = world.buf('meshState', stateWords * 4, GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC);
    const init = new Uint32Array(stateWords);
    for (let c = 0; c < chunks; c++) init.set([0, 1, c * indicesPer, c * vertsPer, 0], CHUNK0 + c * CSTRIDE);
    device.queue.writeBuffer(this.state, 0, init);
    const s = this.side + 3;
    this.scratch = world.buf('meshScratch', this.slots * s * s * this.nz * 8, GPUBufferUsage.STORAGE);
    this.statBuf = world.buf('meshStats', stateWords * 4, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST);

    const parts = [commonWgsl, layersWgsl, materialsWgsl, gridsWgsl, meshRegionWgsl, fieldMeshWgsl];
    const spec = { 0: 'uniform', 1: 'read', 2: 'uniform', 3: 'read', 4: 'read', 5: 'read', 6: 'rw', 7: 'rw', 8: 'rw', 9: 'rw', 30: 'uniform' } as const;
    const group = (k: ComputeKernel) =>
      makeBindGroup(device, 'fieldmesh', k.layout, {
        0: world.globals,
        1: world.chunks,
        2: world.materials,
        3: world.layers,
        4: world.strFrames,
        5: world.strVox,
        6: this.scratch,
        7: this.verts,
        8: this.indices,
        9: this.state,
        30: this.region,
      });
    this.hash = makeCompute(device, 'fieldmesh-hash', parts, spec, 'hashChunks');
    this.hashGroup = group(this.hash);
    for (const entry of ['sampleField', 'makeVerts', 'makeQuads']) {
      const k = makeCompute(device, `fieldmesh-${entry}`, parts, spec, entry);
      this.kernels.push(k);
      this.groups.push(group(k));
    }
  }

  /** The vertices (meshdraw.wgsl binding 3). */
  get vertexBuffer(): GPUBuffer {
    return this.verts;
  }

  /** Find the chunks near the view that changed and rebuild a few of them. */
  encode(enc: GPUCommandEncoder, cam: Camera): void {
    if (!this.on) return;
    this.cull(cam);
    const chunks = this.nx * this.ny;
    this.device.queue.writeBuffer(this.state, 0, new Uint32Array([0]));
    this.device.queue.writeBuffer(this.state, (CHUNK0 + chunks * CSTRIDE) * 4, this.near);
    {
      const pass = enc.beginComputePass({ label: 'fieldmesh-hash', timestampWrites: this.profiler.timestamps('fieldmesh-hash') });
      pass.setPipeline(this.hash.pipeline);
      pass.setBindGroup(0, this.hashGroup);
      pass.dispatchWorkgroups(chunks);
      pass.end();
    }
    // (the threads of empty slots return at once)
    const s = this.side + 3;
    const wg: [number, number, number] = [Math.ceil(s / 4), Math.ceil(s / 4), Math.ceil(this.nz / 4) * this.slots];
    this.kernels.forEach((k, i) => {
      const name = ['fieldmesh-sample', 'fieldmesh-verts', 'fieldmesh-quads'][i];
      const pass = enc.beginComputePass({ label: name, timestampWrites: this.profiler.timestamps(name) });
      pass.setPipeline(k.pipeline);
      pass.setBindGroup(0, this.groups[i]);
      pass.dispatchWorkgroups(...wg);
      pass.end();
    });
    this.profiler.dispatches += 4;
    if (!this.statBusy && this.statEvery++ % 30 === 0) {
      enc.copyBufferToBuffer(this.state, 0, this.statBuf!, 0, this.statBuf!.size);
      this.statBusy = true;
      this.statNeeded = true;
    }
  }

  /**
   * Which chunks are in view (drawn) and near it (rebuilt: a margin, so
   * panning finds them current): each chunk's box in clip space against the
   * screen's edges.
   */
  private cull(cam: Camera): void {
    const m = cam.viewProj;
    const zHi = this.world.zMax;
    const chunks = this.nx * this.ny;
    if (this.near.length !== chunks) {
      this.near = new Uint32Array(chunks);
      this.inView = new Uint8Array(chunks);
    }
    for (let cy = 0; cy < this.ny; cy++)
      for (let cx = 0; cx < this.nx; cx++) {
        let lo = [Infinity, Infinity];
        let hi = [-Infinity, -Infinity];
        for (let k = 0; k < 8; k++) {
          const x = (cx + (k & 1)) * CHUNK;
          const y = (cy + ((k >> 1) & 1)) * CHUNK;
          const z = k & 4 ? zHi : -1;
          const px = m[0] * x + m[4] * y + m[8] * z + m[12];
          const py = m[1] * x + m[5] * y + m[9] * z + m[13];
          lo = [Math.min(lo[0], px), Math.min(lo[1], py)];
          hi = [Math.max(hi[0], px), Math.max(hi[1], py)];
        }
        const c = cy * this.nx + cx;
        const within = (e: number) => hi[0] >= -e && lo[0] <= e && hi[1] >= -e && lo[1] <= e;
        this.inView[c] = within(1) ? 1 : 0;
        this.near[c] = within(1.5) ? 1 : 0;
      }
  }

  /** Draw the chunks in view (one indexed indirect draw each). */
  draw(pass: GPURenderPassEncoder): void {
    if (!this.on) return;
    pass.setIndexBuffer(this.indices, 'uint32');
    let n = 0;
    for (let c = 0; c < this.nx * this.ny; c++) {
      if (!this.inView[c]) continue;
      pass.drawIndexedIndirect(this.state, (CHUNK0 + c * CSTRIDE) * 4);
      n++;
    }
    this.drawn = n;
    this.profiler.draws += n;
  }

  afterSubmit(): void {
    if (!this.statNeeded) return;
    this.statNeeded = false;
    const buf = this.statBuf!;
    buf.mapAsync(GPUMapMode.READ).then(() => {
      const u = new Uint32Array(buf.getMappedRange());
      let verts = 0;
      let indices = 0;
      let full = 0;
      for (let c = 0; c < this.nx * this.ny; c++) {
        const b = CHUNK0 + c * CSTRIDE;
        indices += u[b];
        verts += u[b + 7];
        full += u[b + 9];
      }
      this.stats = { changed: u[0], verts, indices, full };
      buf.unmap();
      this.statBusy = false;
    }, ignoreTeardown);
  }
}
