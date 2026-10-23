// Agents (round 52, docs/AGENTS.md): units that walk the world's surfaces by
// following shared fields. The GPU does the walking (agents.wgsl): the
// surfaces peeled from the intervals and linked to their neighbours, a
// distance field per goal relaxed a few sweeps a tick, and every unit
// stepping down its group's field. This side places units, says which field
// each group follows and where each field's seeds are, and reads back.

import { makeBindGroup, makeCompute, ignoreTeardown, type BindSpec, type ComputeKernel } from '../gpu/pipeline';
import type { Profiler } from '../gpu/profiler';
import agentsWgsl from '../shaders/agents.wgsl?raw';
import commonWgsl from '../shaders/common.wgsl?raw';
import layersWgsl from '../shaders/layers.wgsl?raw';
import materialsWgsl from '../shaders/materials.wgsl?raw';
import type { SimSystem } from '../sim/system';
import type { WorldGpu } from '../sim/world-gpu';
import { MAT } from '../world/materials';
import { FieldReader } from './fieldreader';

/** surfaces a column (agents.wgsl NAV_K) */
export const NAV_K = 4;
export const MAX_UNITS = 8192;
export const NFIELDS = 4;
export const MAX_GROUPS = 16;
const MAX_SEEDS = 32;
/** sweeps of the fields a tick, and ticks between re-peeling the surfaces */
const SWEEPS = 8;
const PEEL_EVERY = 8;
const PARAMS_BYTES = 16 + MAX_SEEDS * 16 + 64 + 64 + 16;
/** bytes of a surface (agents.wgsl nav: vec4<u32>) */
const NAV_BYTES = 16;
/** each group's torso colour, by material */
const GROUP_MATS = [MAT.Rust, MAT.Brick, MAT.Steel, MAT.Wood, MAT.Concrete, MAT.Grass, MAT.Basalt, MAT.Sand];

export interface Seed {
  x: number;
  y: number;
  /** height (world cells): which surface of the column; default the top */
  z?: number;
}

export class Agents implements SimSystem {
  readonly name = 'agents';
  readonly period = 1;
  /** per surface: height, headroom, wet, links (agents.wgsl) */
  readonly nav: GPUBuffer;
  readonly dist: GPUBuffer;
  readonly units: GPUBuffer;
  readonly inst: GPUBuffer;
  readonly indirect: GPUBuffer;
  private occ: GPUBuffer;
  private params: GPUBuffer;
  private k: Record<'surfaces' | 'links' | 'relax' | 'occClear' | 'unitStep', ComputeKernel>;
  private group: GPUBindGroup;
  private peelGroup: GPUBindGroup;
  private fieldPlace = new Uint32Array(NFIELDS);
  private count = 0;
  private seeds: (Seed & { field: number })[] = [];
  private groupField = new Uint32Array(MAX_GROUPS).fill(0xffffffff);
  private fieldsUsed = 0;
  private ticks = 0;

  constructor(
    private device: GPUDevice,
    private world: WorldGpu,
    private prof: Profiler,
  ) {
    const cols = world.w * world.h;
    const S = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST;
    this.nav = world.buf('agentNav', cols * NAV_K * NAV_BYTES, S);
    this.dist = world.buf('agentDist', NFIELDS * cols * NAV_K * 4, S);
    this.units = world.buf('agentUnits', MAX_UNITS * 32, S);
    this.occ = world.buf('agentOcc', 2 * cols * 4, S);
    this.inst = world.buf('agentInst', MAX_UNITS * 3 * 32, GPUBufferUsage.STORAGE);
    this.indirect = world.buf('agentIndirect', 16, GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST);
    this.params = world.buf('agentParams', PARAMS_BYTES, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    device.queue.writeBuffer(this.indirect, 0, new Uint32Array([36, 0, 0, 0]));
    // (nothing reached yet: every field starts unreachable)
    device.queue.writeBuffer(this.dist, 0, new Float32Array(NFIELDS * cols * NAV_K).fill(1e9));
    const spec: BindSpec = { 0: 'uniform', 1: 'read', 2: 'uniform', 3: 'read', 4: 'read', 5: 'rw', 6: 'rw', 7: 'rw', 8: 'rw', 9: 'rw', 10: 'uniform' };
    const parts = [commonWgsl, layersWgsl, materialsWgsl, agentsWgsl];
    const mk = (e: string, sp = spec) => makeCompute(device, `agents-${e}`, parts, sp, e);
    // (the peel reads the places too: its own layout, so the rest keep to 8 storage buffers)
    const peelSpec: BindSpec = { 0: 'uniform', 1: 'read', 2: 'uniform', 3: 'read', 4: 'read', 5: 'rw', 11: 'read', 12: 'read' };
    this.k = { surfaces: mk('surfaces', peelSpec), links: mk('links'), relax: mk('relax'), occClear: mk('occClear'), unitStep: mk('unitStep') };
    this.peelGroup = makeBindGroup(device, 'agents-peel', this.k.surfaces.layout, {
      0: world.globals,
      1: world.chunks,
      2: world.materials,
      3: world.layers,
      4: world.water,
      5: this.nav,
      11: world.places,
      12: world.placeTable,
    });
    this.group = makeBindGroup(device, 'agents', this.k.links.layout, {
      0: world.globals,
      1: world.chunks,
      2: world.materials,
      3: world.layers,
      4: world.water,
      5: this.nav,
      6: this.dist,
      7: this.units,
      8: this.occ,
      9: this.inst,
      10: this.params,
    });
  }

  get size(): number {
    return this.count;
  }

  /**
   * `n` units of `group` scattered round world (x, y) within `spread` cells;
   * they land on the top surface there. Returns the first unit's index.
   */
  spawn(n: number, x: number, y: number, opts: { group?: number; spread?: number } = {}): number {
    const g = opts.group ?? 0;
    if (g < 0 || g >= MAX_GROUPS) throw new Error(`agents: group ${g} out of 0..${MAX_GROUPS - 1}`);
    if (this.count + n > MAX_UNITS) throw new Error(`agents: ${this.count} + ${n} units is over ${MAX_UNITS}`);
    const spread = opts.spread ?? Math.sqrt(n) * 0.6;
    const d = new Float32Array(n * 8);
    const u = new Uint32Array(d.buffer);
    for (let i = 0; i < n; i++) {
      const r = spread * Math.sqrt(Math.random());
      const a = Math.random() * Math.PI * 2;
      d[i * 8] = x + Math.cos(a) * r;
      d[i * 8 + 1] = y + Math.sin(a) * r;
      // (from above: the first step drops it onto the top surface)
      d[i * 8 + 2] = 1e4;
      u[i * 8 + 3] = g | (1 << 8);
      d[i * 8 + 6] = Math.random();
    }
    const first = this.count;
    this.device.queue.writeBuffer(this.units, first * 32, d);
    this.count += n;
    this.device.queue.writeBuffer(this.indirect, 0, new Uint32Array([36, this.count * 3, 0, 0]));
    return first;
  }

  /** Group `g` follows field `f` (0..NFIELDS-1), or stands still (f < 0). */
  follow(g: number, f: number): void {
    if (f >= NFIELDS) throw new Error(`agents: field ${f} out of 0..${NFIELDS - 1}`);
    this.groupField[g] = f < 0 ? 0xffffffff : f;
    this.fieldsUsed = Math.max(this.fieldsUsed, f + 1);
  }

  /** Field `f`'s seeds (its distance is 0 there): a goal, a stockpile, a threat. */
  seed(f: number, seeds: Seed[]): void {
    if (f < 0 || f >= NFIELDS) throw new Error(`agents: field ${f} out of 0..${NFIELDS - 1}`);
    const rest = this.seeds.filter((s) => s.field !== f);
    if (rest.length + seeds.length > MAX_SEEDS) throw new Error(`agents: more than ${MAX_SEEDS} seeds`);
    this.seeds = [...rest, ...seeds.map((s) => ({ ...s, field: f }))];
    this.fieldsUsed = Math.max(this.fieldsUsed, f + 1);
  }

  /**
   * Keep field `f` to one place (a room, or a region: all its rooms): its
   * distances live only on that place's surfaces, so a group following it
   * stays there (a horde kept to its room). `null`: anywhere again.
   */
  confine(f: number, place: { id: number; kind: 'room' | 'region' } | null): void {
    if (f < 0 || f >= NFIELDS) throw new Error(`agents: field ${f} out of 0..${NFIELDS - 1}`);
    this.fieldPlace[f] = place ? (place.id | (place.kind === 'region' ? 0x80000000 : 0)) >>> 0 : 0;
  }

  /** A CPU copy of field `f` to sample (fieldreader.ts; refresh it every few hundred ms). */
  reader(f: number): FieldReader {
    if (f < 0 || f >= NFIELDS) throw new Error(`agents: field ${f} out of 0..${NFIELDS - 1}`);
    return new FieldReader(this, f, this.world.w, this.world.h);
  }

  /** The surfaces and one field's distances, read back together (FieldReader). */
  async readField(f: number): Promise<{ nav: Uint32Array; dist: Float32Array }> {
    const N = this.world.w * this.world.h * NAV_K;
    const tmp = this.device.createBuffer({ size: N * NAV_BYTES + N * 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const enc = this.device.createCommandEncoder();
    enc.copyBufferToBuffer(this.nav, 0, tmp, 0, N * NAV_BYTES);
    enc.copyBufferToBuffer(this.dist, f * N * 4, tmp, N * NAV_BYTES, N * 4);
    this.device.queue.submit([enc.finish()]);
    let out = { nav: new Uint32Array(0), dist: new Float32Array(0) };
    await tmp.mapAsync(GPUMapMode.READ).then(() => {
      const b = tmp.getMappedRange();
      out = { nav: new Uint32Array(b.slice(0, N * NAV_BYTES)), dist: new Float32Array(b.slice(N * NAV_BYTES)) };
      tmp.unmap();
    }, ignoreTeardown);
    tmp.destroy();
    return out;
  }

  /** Send group `g` to world (x, y): its own field (field g % NFIELDS) seeded there. */
  goTo(g: number, x: number, y: number, z?: number): void {
    const f = g % NFIELDS;
    this.seed(f, [{ x, y, z }]);
    this.follow(g, f);
  }

  private writeParams(): void {
    const b = new ArrayBuffer(PARAMS_BYTES);
    const u = new Uint32Array(b);
    const f = new Float32Array(b);
    u[0] = this.count;
    u[1] = this.seeds.length;
    u[2] = this.fieldsUsed;
    u[3] = this.ticks;
    this.seeds.forEach((s, i) => {
      f[4 + i * 4] = s.x;
      f[4 + i * 4 + 1] = s.y;
      f[4 + i * 4 + 2] = s.z ?? 1e4;
      f[4 + i * 4 + 3] = s.field;
    });
    const gf = 4 + MAX_SEEDS * 4;
    for (let g = 0; g < MAX_GROUPS; g++) {
      // (a group following nothing reads past the fields in use: it stands)
      u[gf + g] = this.groupField[g] === 0xffffffff ? NFIELDS : this.groupField[g];
      u[gf + 16 + g] = GROUP_MATS[g % GROUP_MATS.length];
    }
    u.set(this.fieldPlace, gf + 32);
    this.device.queue.writeBuffer(this.params, 0, b);
  }

  encode(enc: GPUCommandEncoder): void {
    // (the tick number rides in the params: the occupancy halves swap on it)
    this.writeParams();
    const [gx, gy] = this.world.groups;
    const pass = enc.beginComputePass({ label: 'agents', timestampWrites: this.prof.timestamps('agents') });
    if (this.ticks % PEEL_EVERY === 0) {
      pass.setBindGroup(0, this.peelGroup);
      pass.setPipeline(this.k.surfaces.pipeline);
      pass.dispatchWorkgroups(gx, gy);
    }
    pass.setBindGroup(0, this.group);
    if (this.ticks % PEEL_EVERY === 0) {
      pass.setPipeline(this.k.links.pipeline);
      pass.dispatchWorkgroups(gx, gy);
      this.prof.dispatches += 2;
    }
    if (this.fieldsUsed > 0) {
      pass.setPipeline(this.k.relax.pipeline);
      for (let i = 0; i < SWEEPS; i++) pass.dispatchWorkgroups(gx, gy);
      this.prof.dispatches += SWEEPS;
    }
    if (this.count > 0) {
      pass.setPipeline(this.k.occClear.pipeline);
      pass.dispatchWorkgroups(Math.ceil((this.world.w * this.world.h) / 64));
      pass.setPipeline(this.k.unitStep.pipeline);
      pass.dispatchWorkgroups(Math.ceil(this.count / 64));
      this.prof.dispatches += 2;
    }
    pass.end();
    this.ticks++;
  }

  /** The units now: [x, y, z, group] each. */
  async read(): Promise<Float32Array> {
    const n = this.count;
    const out = new Float32Array(n * 4);
    if (!n) return out;
    const tmp = this.device.createBuffer({ size: n * 32, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const enc = this.device.createCommandEncoder();
    enc.copyBufferToBuffer(this.units, 0, tmp, 0, n * 32);
    this.device.queue.submit([enc.finish()]);
    await tmp.mapAsync(GPUMapMode.READ).then(() => {
      const f = new Float32Array(tmp.getMappedRange());
      const u = new Uint32Array(f.buffer);
      for (let i = 0; i < n; i++) {
        out[i * 4] = f[i * 8];
        out[i * 4 + 1] = f[i * 8 + 1];
        out[i * 4 + 2] = f[i * 8 + 2];
        out[i * 4 + 3] = u[i * 8 + 3] & 0xff;
      }
      tmp.unmap();
    }, ignoreTeardown);
    tmp.destroy();
    return out;
  }

  /** A raw readback of one of its buffers (tests). */
  async readRaw(which: 'nav' | 'dist'): Promise<ArrayBuffer> {
    const src = this[which];
    const tmp = this.device.createBuffer({ size: src.size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const enc = this.device.createCommandEncoder();
    enc.copyBufferToBuffer(src, 0, tmp, 0, src.size);
    this.device.queue.submit([enc.finish()]);
    await tmp.mapAsync(GPUMapMode.READ);
    const out = tmp.getMappedRange().slice(0);
    tmp.destroy();
    return out;
  }
}
