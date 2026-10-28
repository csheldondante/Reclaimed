// (watersurf, FC2) The window's water drawn as one surface, not a prism a wet column. The sims keep their per-column
// fields (water depth, surface, drift: WorldGpu's contract buffers); this converts them, at the renderer's boundary,
// into the triangles of the lattice the columns' centres form that have a wet corner and are on screen
// (watersurf.wgsl), listed as window-order column indices for an indexed draw (render.wgsl vsWaterSurf /
// fsWaterSurf). A column's vertex is worked out once and shared by its six triangles: about one vertex shader run a
// wet column on screen, where the prisms ran thirty. The list is made on renderprep's frames; the vertices read the
// water live every frame.
import { makeBindGroup, makeCompute, type ComputeKernel } from '../gpu/pipeline';
import type { Profiler } from '../gpu/profiler';
import type { WorldGpu } from '../sim/world-gpu';
import commonWgsl from '../shaders/common.wgsl?raw';
import waterSurfWgsl from '../shaders/watersurf.wgsl?raw';

/** drawIndexedIndirect's five words: index count, instance count, first index, base vertex, first instance */
const ARGS_RESET = new Uint32Array([0, 1, 0, 0, 0]);

export class WaterSurface {
  /** the triangles' column indices (an index buffer), two triangles a column at most */
  readonly tris: GPUBuffer;
  /** the draw's args (drawIndexedIndirect) */
  readonly args: GPUBuffer;
  private kernel: ComputeKernel;
  private group: GPUBindGroup;

  constructor(
    private device: GPUDevice,
    private world: WorldGpu,
    private profiler: Profiler,
    /** the view: the renderer's Camera uniform (its first fields: viewProj, eye, viewport) */
    cam: GPUBuffer,
  ) {
    this.tris = world.buf('waterSurf tris', world.cells * 6 * 4, GPUBufferUsage.STORAGE | GPUBufferUsage.INDEX);
    this.args = world.buf('waterSurf args', 32, GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC);
    this.kernel = makeCompute(device, 'watersurf', [commonWgsl, waterSurfWgsl], { 0: 'uniform', 4: 'read', 5: 'read', 7: 'rw', 9: 'rw', 17: 'tex', 31: 'uniform' }, 'build');
    this.group = makeBindGroup(device, 'watersurf', this.kernel.layout, {
      0: world.globals,
      4: world.surface,
      5: world.water,
      7: this.tris,
      9: this.args,
      17: world.driftView,
      31: cam,
    });
  }

  /** Make the list again (the camera uniform already written this frame). */
  encode(enc: GPUCommandEncoder): void {
    this.device.queue.writeBuffer(this.args, 0, ARGS_RESET);
    const pass = enc.beginComputePass({ label: 'watersurf', timestampWrites: this.profiler.timestamps('watersurf') });
    pass.setPipeline(this.kernel.pipeline);
    pass.setBindGroup(0, this.group);
    const [gx, gy] = this.world.groups;
    pass.dispatchWorkgroups(gx, gy);
    pass.end();
    this.profiler.dispatches++;
  }

  /** Draw it (the water surface's pipeline and a bind group of the draw layout set). */
  draw(pass: GPURenderPassEncoder): void {
    pass.setIndexBuffer(this.tris, 'uint32');
    pass.drawIndexedIndirect(this.args, 0);
    this.profiler.draws++;
  }
}
