// (round 128p, DA-B22 (c)(1)(4)) The few units the CPU reads, on the GPU (shaders/unitreads.wgsl): the observed units'
// records gathered into one block for the sync (one copy, not one a unit, and no cap but the device's), and a query's
// answer — the live units within a radius of a point, with where they stand — read back on its own.

import { makeBindGroup, makeCompute, ignoreTeardown, type ComputeKernel } from '../gpu/pipeline';
import readsWgsl from '../shaders/unitreads.wgsl?raw';

/** a unit's record (UNIT_V vec4s: agents.ts) */
const UNIT_BYTES = 6 * 16;

/** A unit a query found: its id and where it stands */
export interface UnitFound {
  id: number;
  x: number;
  y: number;
  z: number;
}

/** A unit at one of the points asked (nearMany): the point's index, its id, where it stands (x, y) */
export interface UnitAt {
  k: number;
  id: number;
  x: number;
  y: number;
}

/** the points one nearMany asks about at most (unitreads.wgsl MANY) */
export const MANY = 32;

export class UnitReads {
  private k: Record<'gather' | 'near' | 'nearMany', ComputeKernel>;
  private pts: GPUBuffer;
  private slots!: GPUBuffer;
  private out!: GPUBuffer;
  private count: GPUBuffer;
  private params: GPUBuffer;
  private group!: GPUBindGroup;
  /** a query's answers, apart from the gathered records (a sync may gather between a query's two reads) */
  private nearOut: GPUBuffer;
  private nearGroup!: GPUBindGroup;
  /** the slots and records the buffers hold room for (they grow: an observed set the device can't hold is an error) */
  private room = 0;
  private busy: Promise<unknown> = Promise.resolve();

  constructor(
    private device: GPUDevice,
    private units: GPUBuffer,
    private maxUnits: number,
    /** the units' combat words (agents/notice.ts): a query of one faction */
    private combat: GPUBuffer,
  ) {
    const spec = { 1: 'read', 2: 'rw', 3: 'uniform', 4: 'rw', 5: 'uniform', 6: 'read', 7: 'read' } as const;
    this.k = { gather: makeCompute(device, 'agents-gather', [readsWgsl], spec, 'gather'), near: makeCompute(device, 'agents-near', [readsWgsl], spec, 'near'), nearMany: makeCompute(device, 'agents-near-many', [readsWgsl], spec, 'nearMany') };
    this.pts = device.createBuffer({ label: 'unitReads points', size: MANY * 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.count = device.createBuffer({ label: 'unitReads count', size: 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
    this.params = device.createBuffer({ label: 'unitReads params', size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.nearOut = device.createBuffer({ label: 'unitReads near', size: maxUnits * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    this.grow(64);
  }

  private grow(n: number): void {
    if (n <= this.room) return;
    if (n > this.maxUnits) throw new Error(`agents: ${n} units read at once, past the ${this.maxUnits} there are`);
    const room = Math.min(this.maxUnits, Math.max(n, this.room * 2));
    this.slots?.destroy();
    this.out?.destroy();
    this.slots = this.device.createBuffer({ label: 'unitReads slots', size: room * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.out = this.device.createBuffer({ label: 'unitReads out', size: room * UNIT_BYTES, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    this.group = makeBindGroup(this.device, 'agents-reads', this.k.gather.layout, { 1: this.slots, 2: this.out, 3: this.params, 4: this.count, 5: this.pts, 6: this.combat, 7: this.units });
    this.nearGroup = makeBindGroup(this.device, 'agents-near', this.k.near.layout, { 1: this.slots, 2: this.nearOut, 3: this.params, 4: this.count, 5: this.pts, 6: this.combat, 7: this.units });
    this.room = room;
  }

  /**
   * (the sync's) the records of `slots` gathered and copied into `dst` at `at` (UNIT_BYTES each, in their order) —
   * encoded on `enc`, before its copy out
   */
  gather(enc: GPUCommandEncoder, slots: readonly number[], dst: GPUBuffer, at: number): void {
    const n = slots.length;
    if (!n) return;
    this.grow(n);
    this.device.queue.writeBuffer(this.slots, 0, new Uint32Array(slots));
    this.device.queue.writeBuffer(this.params, 0, new Uint32Array([n, 0, 0, 0, 0, 0, 0, 0]));
    const pass = enc.beginComputePass({ label: 'agents-gather' });
    pass.setPipeline(this.k.gather.pipeline);
    pass.setBindGroup(0, this.group);
    pass.dispatchWorkgroups(Math.ceil(n / 64));
    pass.end();
    enc.copyBufferToBuffer(this.out, 0, dst, at, n * UNIT_BYTES);
  }

  /**
   * The live units within `r` of (x, y) among the first `count` slots, with where they stand (at most `most`). Two
   * small reads: the count, then as many answers. Asks are taken in turn.
   */
  near(x: number, y: number, r: number, count: number, most = 1024, faction: number | null = null): Promise<UnitFound[]> {
    const run = this.busy.then(() => this.runNear(x, y, r, count, most, faction));
    this.busy = run.catch(() => undefined);
    return run;
  }

  /**
   * The live units within each point's radius (`pts`: x, y, radius; at most MANY), one pass: each a point's index, an id
   * and where it stands. Asks are taken in turn.
   */
  nearMany(pts: readonly (readonly [number, number, number])[], count: number, most = 1024): Promise<UnitAt[]> {
    if (pts.length > MANY) throw new Error(`agents.nearMany: ${pts.length} points (${MANY} at most)`);
    const run = this.busy.then(async () => {
      if (!count || !pts.length) return [];
      const p = new Float32Array(MANY * 4);
      pts.forEach((q, i) => p.set([q[0], q[1], q[2], 0], i * 4));
      this.device.queue.writeBuffer(this.pts, 0, p);
      const raw = await this.query('nearMany', count, most, [0, 0, 0], pts.length);
      return raw.map((r) => ({ k: r.w, id: r.z, x: r.x, y: r.y }));
    });
    this.busy = run.catch(() => undefined);
    return run;
  }

  /** a query's kernel run, its count read, then as many answers (vec4: x y as floats, z w as u32) */
  private async query(entry: 'near' | 'nearMany', count: number, most: number, at: readonly [number, number, number], npts = 0, faction: number | null = null): Promise<{ x: number; y: number; z: number; w: number; zf: number }[]> {
    const m = Math.min(most, this.maxUnits);
    const b = new ArrayBuffer(32);
    new Uint32Array(b, 0, 4).set([count, m, npts, faction === null ? 0 : faction + 1]);
    new Float32Array(b, 16, 4).set([at[0], at[1], at[2], 0]);
    this.device.queue.writeBuffer(this.params, 0, b);
    this.device.queue.writeBuffer(this.count, 0, new Uint32Array(4));
    const enc = this.device.createCommandEncoder({ label: `agents ${entry}` });
    const pass = enc.beginComputePass({ label: `agents-${entry}` });
    pass.setPipeline(this.k[entry].pipeline);
    pass.setBindGroup(0, this.nearGroup);
    pass.dispatchWorkgroups(Math.ceil(count / 64));
    pass.end();
    // (the count first: the answers read are as many as it says)
    const head = this.device.createBuffer({ size: 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    enc.copyBufferToBuffer(this.count, 0, head, 0, 16);
    this.device.queue.submit([enc.finish()]);
    let n = 0;
    await head.mapAsync(GPUMapMode.READ).then(() => {
      n = Math.min(new Uint32Array(head.getMappedRange())[0], m);
      head.unmap();
    }, ignoreTeardown);
    head.destroy();
    if (!n) return [];
    const tmp = this.device.createBuffer({ size: n * 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const e2 = this.device.createCommandEncoder({ label: `agents ${entry} read` });
    e2.copyBufferToBuffer(this.nearOut, 0, tmp, 0, n * 16);
    this.device.queue.submit([e2.finish()]);
    const out: { x: number; y: number; z: number; w: number; zf: number }[] = [];
    await tmp.mapAsync(GPUMapMode.READ).then(() => {
      const f = new Float32Array(tmp.getMappedRange());
      const u = new Uint32Array(f.buffer);
      for (let i = 0; i < n; i++) out.push({ x: f[i * 4], y: f[i * 4 + 1], zf: f[i * 4 + 2], z: u[i * 4 + 2], w: u[i * 4 + 3] });
      tmp.unmap();
    }, ignoreTeardown);
    tmp.destroy();
    return out;
  }

  private async runNear(x: number, y: number, r: number, count: number, most: number, faction: number | null): Promise<UnitFound[]> {
    if (!count) return [];
    return (await this.query('near', count, most, [x, y, r], 0, faction)).map((q) => ({ id: q.w, x: q.x, y: q.y, z: q.zf }));
  }


}
