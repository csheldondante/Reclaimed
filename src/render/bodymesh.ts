// Bodies' own meshes (round 120, the user: "it switches for rendering as voxels. Rendering and simulation should not be
// coupled that way"). One mesh a body (render/bodymeshbuild.ts: its cells' surface as the world draws what's built),
// made once when it wakes and kept to its rest, skinned each frame (bodymesh.wgsl) to whatever moves it — the node
// solver's nodes, or a matrix (the CPU rigid rock, a resting rock) — and drawn as one triangle list, lit and shadowed
// (Renderer.addMesh: render.wgsl vsSkin). A body is never drawn as its cells.

import { makeBindGroup, makeCompute, type ComputeKernel } from '../gpu/pipeline';
import type { Profiler } from '../gpu/profiler';
import { dispatch } from '../sim/system';
import type { WorldGpu } from '../sim/world-gpu';
import bodyMeshWgsl from '../shaders/bodymesh.wgsl?raw';
import { BM_VERT } from './bodymeshbuild';

/** what moves a mesh this frame */
export type MeshPose = { kind: 'nodes'; slot: number; com: readonly [number, number, number] } | { kind: 'matrix'; m: readonly number[] };

/** vec4s an entry (bodymesh.wgsl ENT_V) */
const ENT_V = 5;

interface Entry {
  verts: Float32Array;
  pose: MeshPose;
}

export class BodyMeshes {
  private entries = new Map<number, Entry>();
  private nextId = 1;
  private kernel: ComputeKernel;
  private group: GPUBindGroup | null = null;
  private uni: GPUBuffer;
  private rest!: GPUBuffer;
  private ents!: GPUBuffer;
  /** the skinned triangles (render.wgsl vsSkin's form) and their draw args */
  out!: GPUBuffer;
  readonly args: GPUBuffer;
  private room = 0;
  private entRoom = 0;
  private count = 0;
  private order: number[] = [];
  private dirty = false;
  private none: GPUBuffer;
  private nodes: { pose: GPUBuffer; lanes: GPUBuffer } | null = null;
  /** (the out buffer made again: the renderer's draw of it is to be made again) */
  onBuffers?: () => void;
  stats = { bodies: 0, verts: 0 };

  constructor(
    private device: GPUDevice,
    private world: WorldGpu,
    private profiler: Profiler,
  ) {
    this.kernel = makeCompute(device, 'body-mesh', [bodyMeshWgsl], { 0: 'uniform', 1: 'read', 2: 'read', 3: 'read', 4: 'read', 5: 'rw' }, 'main');
    this.uni = world.buf('body mesh uniform', 16, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    this.args = world.buf('body mesh args', 16, GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST);
    this.none = world.buf('body mesh no nodes', 256, GPUBufferUsage.STORAGE);
    this.grow(4096, 64);
  }

  /** the node solver's buffers its meshes are skinned to (made again when it grows) */
  setNodes(n: { pose: GPUBuffer; lanes: GPUBuffer } | null): void {
    this.nodes = n;
    this.group = null;
  }

  private grow(verts: number, ents: number): void {
    if (verts > this.room) {
      let r = Math.max(4096, this.room);
      while (r < verts) r *= 2;
      this.rest?.destroy();
      this.out?.destroy();
      this.rest = this.world.buf('body mesh rest', r * BM_VERT * 4, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
      this.out = this.world.buf('body mesh out', r * 32, GPUBufferUsage.STORAGE);
      this.room = r;
      this.group = null;
      this.dirty = true;
      this.onBuffers?.();
    }
    if (ents > this.entRoom) {
      let r = Math.max(64, this.entRoom);
      while (r < ents) r *= 2;
      this.ents?.destroy();
      this.ents = this.world.buf('body mesh entries', r * ENT_V * 16, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
      this.entRoom = r;
      this.group = null;
    }
  }

  /** a body's mesh (bodymeshbuild.ts), moved by `pose`: its id */
  add(verts: Float32Array, pose: MeshPose): number {
    const id = this.nextId++;
    this.entries.set(id, { verts, pose });
    this.dirty = true;
    return id;
  }

  /** what moves it now (a matrix: every frame) */
  setPose(id: number, pose: MeshPose): void {
    const e = this.entries.get(id);
    if (!e) throw new Error(`body mesh ${id}: no such mesh`);
    e.pose = pose;
  }

  has(id: number): boolean {
    return this.entries.has(id);
  }

  remove(id: number): void {
    if (this.entries.delete(id)) this.dirty = true;
  }

  clear(): void {
    if (!this.entries.size) return;
    this.entries.clear();
    this.dirty = true;
  }

  /** the frame's skinning (alpha: where the frame lies between the solver's last two ticks) */
  encode(enc: GPUCommandEncoder, alpha: number): void {
    if (this.dirty) this.upload();
    if (!this.count) return;
    const E = new Float32Array(this.order.length * ENT_V * 4);
    this.order.forEach((id, k) => {
      const p = this.entries.get(id)!.pose;
      const o = k * ENT_V * 4;
      if (p.kind === 'nodes') {
        E.set([1, p.slot, 0, 0], o);
        E.set([p.com[0], p.com[1], p.com[2], 0], o + 4);
      } else {
        E.set([2, 0, 0, 0], o);
        E.set(p.m, o + 8);
      }
    });
    this.device.queue.writeBuffer(this.ents, 0, E);
    const U = new ArrayBuffer(16);
    new Float32Array(U, 0, 1)[0] = alpha;
    new Uint32Array(U, 4, 1)[0] = this.count;
    this.device.queue.writeBuffer(this.uni, 0, U);
    if (!this.group) {
      const n = this.nodes;
      this.group = makeBindGroup(this.device, 'body-mesh', this.kernel.layout, { 0: this.uni, 1: this.rest, 2: this.ents, 3: n?.pose ?? this.none, 4: n?.lanes ?? this.none, 5: this.out });
    }
    dispatch(enc, this.profiler, 'body-mesh', this.kernel, this.group, [Math.ceil(this.count / 64), 1]);
  }

  /** the meshes again into one buffer (a body came or went) */
  private upload(): void {
    this.dirty = false;
    this.order = [...this.entries.keys()];
    let n = 0;
    for (const id of this.order) n += this.entries.get(id)!.verts.length / BM_VERT;
    this.grow(n, this.order.length);
    const all = new Float32Array(n * BM_VERT);
    const u = new Uint32Array(all.buffer);
    let o = 0;
    this.order.forEach((id, k) => {
      const v = this.entries.get(id)!.verts;
      all.set(v, o);
      // (each vertex's entry: the body's place in this frame's order)
      for (let i = o; i < o + v.length; i += BM_VERT) u[i + 7] = k;
      o += v.length;
    });
    if (n) this.device.queue.writeBuffer(this.rest, 0, all);
    this.count = n;
    this.device.queue.writeBuffer(this.args, 0, new Uint32Array([n, 1, 0, 0]));
    this.stats = { bodies: this.order.length, verts: n };
  }
}
