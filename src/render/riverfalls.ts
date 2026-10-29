// (riverfalls, BACKLOG WF1, round 107) The held rivers' falls drawn as the flow model's arcing sheet, render-only. The
// user, on waterfalls in the atlas: "Yes or just fake it based on flow speed over gaps and make it a parabolic arc.
// Either way". A held river (?rivers=table, riverheld.wgsl) isn't simulated; here its lips - a river column whose
// downstream neighbour's top lies FALL_MIN or more under its water - are found every tick from the contract alone
// (surface, water, the drift, riverFlow), each thrown off as a parabola by the held flow's speed and heading and the
// world's gravity (common.wgsl WORLD_G), clipped where it meets the columns under it, and listed (the ones on screen)
// in the flow model's stream format, so the water pipeline draws them with render.wgsl streamVertex / shadeStream - the
// curtain and band, the shading riding the water. Spray along the path and splash and mist at the foot go to the
// particle ring, budgeted by the discharge. Nothing is simulated or read back on the frame's path (probe() is for
// scripts).
import { makeBindGroup, makeCompute, type ComputeKernel } from '../gpu/pipeline';
import type { Profiler } from '../gpu/profiler';
import { ROW_H } from '../world/lattice';
import type { Camera } from './camera';
import commonWgsl from '../shaders/common.wgsl?raw';
import riverHeldWgsl from '../shaders/riverheld.wgsl?raw';
import riverFallsWgsl from '../shaders/riverfalls.wgsl?raw';
import { dispatch, type SimSystem } from '../sim/system';
import { RIVER_DEPTH_EXP, RIVER_SPEED_EXP, type WorldGpu } from '../sim/world-gpu';

/** the most falls' columns listed at once (on screen) */
export const MAX_FALLS = 2048;
/** the heights round the view's target (cells) a fixed view's rect covers: a fall further up or down isn't looked for */
const VIEW_DZ = 80;
/** a margin round the view (cells): a fall's lip off screen whose sheet comes into it */
const VIEW_PAD = 12;
/** a stream's sheet (render.wgsl streamVertex: 2 ribbons x 3 segments x 6; liquid.ts VERTS_PER_PRISM) */
const VERTS = 36;

export interface FallProbe {
  col: [number, number];
  /** where it leaves the lip (window world x, y, z), its velocity xy (cells/s), how long it falls (s), cells³/s */
  e: [number, number, number];
  u: [number, number];
  tEnd: number;
  rate: number;
}

export class RiverFalls implements SimSystem {
  readonly name = 'riverfalls';
  readonly period = 1;
  /** the stream list (liquid.wgsl prep's layout) and its drawIndirect args: the water pipeline draws it */
  readonly inst: GPUBuffer;
  readonly indirect: GPUBuffer;
  private kernel: ComputeKernel;
  private group: GPUBindGroup;
  /** the falls' columns the last tick listed (riverfalls.wgsl listedPrev) */
  private prev: GPUBuffer;
  /** the columns dispatched over (riverfalls.wgsl FR) */
  private rectBuf: GPUBuffer;
  private rect = new Uint32Array(4);

  constructor(
    private device: GPUDevice,
    private world: WorldGpu,
    private profiler: Profiler,
    /** the view: the renderer's Camera uniform (its first fields: viewProj, eye, viewport) */
    cam: GPUBuffer,
    /** the view on the CPU: the columns it can see */
    private camera: Camera,
  ) {
    const S = GPUBufferUsage.STORAGE;
    this.inst = world.buf('riverFalls inst', MAX_FALLS * 3 * 16, S | GPUBufferUsage.COPY_SRC);
    this.indirect = world.buf('riverFalls indirect', 16, S | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC);
    this.rectBuf = world.buf('riverFalls rect', 16, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    this.prev = world.buf('riverFalls prev', 16, S | GPUBufferUsage.COPY_DST);
    device.queue.writeBuffer(this.indirect, 0, new Uint32Array([VERTS, 0, 0, 0]));
    const held = `const RIVER_TABLE: bool = true;\nconst RIVER_DEPTH_EXP: f32 = ${RIVER_DEPTH_EXP};\nconst RIVER_SPEED_EXP: f32 = ${RIVER_SPEED_EXP};\n` + riverHeldWgsl;
    this.kernel = makeCompute(device, 'riverfalls', [commonWgsl, riverFallsWgsl, held], { 0: 'uniform', 4: 'read', 5: 'read', 12: 'rw', 13: 'rw', 17: 'tex', 22: 'tex', 29: 'rw', 30: 'rw', 31: 'uniform', 32: 'read', 33: 'uniform' }, 'falls');
    this.group = makeBindGroup(device, 'riverfalls', this.kernel.layout, {
      0: world.globals,
      4: world.surface,
      5: world.water,
      12: world.particles,
      13: world.particleCounters,
      17: world.driftView,
      22: world.riverFlowView,
      29: this.inst,
      30: this.indirect,
      31: cam,
      32: this.prev,
      33: this.rectBuf,
    });
  }

  encode(enc: GPUCommandEncoder): void {
    // (last tick's count kept for the spray's share, then the list emptied: in the encoder, in order)
    enc.copyBufferToBuffer(this.indirect, 4, this.prev, 0, 4);
    enc.clearBuffer(this.indirect, 4, 4);
    const r = this.viewRect();
    if (r[2] === 0 || r[3] === 0) return;
    this.rect.set(r);
    this.device.queue.writeBuffer(this.rectBuf, 0, this.rect);
    dispatch(enc, this.profiler, this.name, this.kernel, this.group, [Math.ceil(r[2] / 8), Math.ceil(r[3] / 8)]);
  }

  /**
   * The window's columns (x0, y0, w, h) the fixed view can see: its viewProj is affine, so each screen corner at a
   * height z is one ground point (a 2 x 2 solve); the box round the corners at the target's height +- VIEW_DZ, and a
   * margin. The free camera: the whole window.
   */
  private viewRect(): [number, number, number, number] {
    const W = this.world.w;
    const H = this.world.h;
    const c = this.camera;
    if (c.fly) return [0, 0, W, H];
    const m = c.viewProj;
    const det = m[0] * m[5] - m[4] * m[1];
    if (Math.abs(det) < 1e-12) return [0, 0, W, H];
    let x0 = Infinity;
    let x1 = -Infinity;
    let y0 = Infinity;
    let y1 = -Infinity;
    for (const z of [c.target[2] - VIEW_DZ, c.target[2] + VIEW_DZ])
      for (const cx of [-1, 1])
        for (const cy of [-1, 1]) {
          const bx = cx - m[8] * z - m[12];
          const by = cy - m[9] * z - m[13];
          const x = (bx * m[5] - m[4] * by) / det;
          const y = (m[0] * by - bx * m[1]) / det;
          x0 = Math.min(x0, x);
          x1 = Math.max(x1, x);
          y0 = Math.min(y0, y);
          y1 = Math.max(y1, y);
        }
    const cx0 = Math.max(0, Math.floor(x0 - VIEW_PAD));
    const cx1 = Math.min(W, Math.ceil(x1 + VIEW_PAD));
    const cy0 = Math.max(0, Math.floor(y0 / ROW_H - VIEW_PAD));
    const cy1 = Math.min(H, Math.ceil(y1 / ROW_H + VIEW_PAD));
    return [cx0, cy0, Math.max(0, cx1 - cx0), Math.max(0, cy1 - cy0)];
  }

  /** (scripts) The falls listed at the last tick. */
  async probe(): Promise<FallProbe[]> {
    const dev = this.device;
    const a = dev.createBuffer({ size: this.inst.size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const b = dev.createBuffer({ size: 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const enc = dev.createCommandEncoder();
    enc.copyBufferToBuffer(this.inst, 0, a, 0, this.inst.size);
    enc.copyBufferToBuffer(this.indirect, 0, b, 0, 16);
    dev.queue.submit([enc.finish()]);
    await Promise.all([a.mapAsync(GPUMapMode.READ), b.mapAsync(GPUMapMode.READ)]);
    const u = new Uint32Array(a.getMappedRange());
    const f = new Float32Array(u.buffer);
    const n = Math.min(new Uint32Array(b.getMappedRange())[1], MAX_FALLS);
    const out: FallProbe[] = [];
    for (let k = 0; k < n; k++) {
      const d = (MAX_FALLS + 2 * k) * 4;
      out.push({ col: [u[k * 4] & 0xfff, (u[k * 4] >> 12) & 0xfff], e: [f[d], f[d + 1], f[k * 4 + 1]], u: [f[d + 2], f[d + 3]], tEnd: f[d + 4], rate: f[d + 6] });
    }
    a.destroy();
    b.destroy();
    return out;
  }
}
