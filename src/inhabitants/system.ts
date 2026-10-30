// The inhabitants system (round 117, docs/INHABITANTS.md): a GPU population of creatures with bodies, behind the
// Inhabitants contract (api/contracts/inhabitants.ts). The CPU keeps the species, the groups and their orders and
// reads the groups' sums back a few times a second; everything per creature (behaviour, animation, the mesh) is on
// the GPU (inhabitants.wgsl): it is per frame and grows with the count (5 000 creatures × ~25 points × 60 Hz), the
// "GPU first where data is large or per-frame" rule.
//
// What it reads of the world: only WorldGpu's contract buffers — the surface words (the ground's height), the fire
// and water fields and the wind texture. What it gives: a triangle list drawn by Renderer.addMesh.
// Not GameplayGM's or the settlements' units (src/agents): those fight and work; these live. They meet through
// this contract (presence, orders), not through each other's buffers.

import type { WorldGpu } from '../sim/world-gpu';
import type { SimSystem } from '../sim/system';
import { dispatch } from '../sim/system';
import type { Profiler } from '../gpu/profiler';
import { makeBindGroup, makeCompute, type BindSpec, type ComputeKernel } from '../gpu/pipeline';
import commonWgsl from '../shaders/common.wgsl?raw';
import lifeWgsl from '../shaders/inhabitants.wgsl?raw';
import { ignoreTeardown } from '../gpu/pipeline';
import type { AbilityHost, GroupId, GroupOrder, GroupView, Inhabitants, Presence, SpeciesId, SpeciesSpec, WalkPaths } from '../api/contracts/inhabitants';
import type { V2 } from '../api/contracts/units';
import { buildRig, MAX_POINTS, rand01, type Rig } from './rig';
import { MAX_SPECIES, packSpecies, preyMaskOf, TABLE_VEC4 } from './pack';
import { presence } from './presence';
import { packPaths, PATH_EDGES, PATH_NODES } from './paths';

export const MAX_GROUPS = 256;
const AS = 5; // vec4s an agent (inhabitants.wgsl AS)
const BIN = 8;
const BIN_CAP = 12;
const GS = 8;
const PARAMS_BYTES = 80;
const ROW_H = Math.sqrt(3) / 2;

/** what a creature is doing (inhabitants.wgsl S_*) */
export const STATE = ['idle', 'walk', 'run', 'stalk', 'rest', 'fly', 'down'] as const;

const ORDER_KIND = { roam: 0, go: 1, flee: 2, paths: 3, pace: 4 } as const;
const GAIT = { idle: 0, walk: 1, run: 2, fly: 3 } as const;

interface Group {
  id: GroupId;
  species: SpeciesId;
  slots: number[];
  order: GroupOrder;
  home: V2;
  radius: number;
  fleeUntil: number;
  centre: [number, number, number];
  count: number;
  /** per ability, seconds till it may fire again */
  cool: number[];
}

export interface InhabitantsOpts {
  /** creatures at most (default 8192) */
  maxAgents?: number;
  /** vertices the mesh may hold (default: what 2 500 deer need, at most the device's binding size) */
  maxVerts?: number;
}

export class InhabitantsGpu implements SimSystem, Inhabitants {
  readonly name = 'inhabitants';
  readonly period = 1;
  readonly maxAgents: number;
  readonly maxVerts: number;
  /** the mesh (render.wgsl vsSkin's form) and its draw args — Renderer.addMesh */
  readonly verts: GPUBuffer;
  readonly drawArgs: GPUBuffer;
  /** the agents' state (5 vec4 each: pos+species, vel+heading, group/state/timer/phase, aim/alert/air, fresh/seed/path) */
  readonly agentBuf: GPUBuffer;
  readonly poseBuf: GPUBuffer;
  /** where the mesh is built: creatures farther than `focusR` from it are skipped (the camera's view; the level sets it) */
  focus: V2 = [0, 0];
  focusR = 1e9;
  /**
   * How much bigger than life creatures are drawn, about their feet (1: life size). Readability on a phone: at the
   * atlas's wide zooms a deer is 3 px — the level sets this from the camera's zoom (install.ts lifeFocus). Only the
   * mesh; behaviour, presence and hits keep the true size.
   */
  drawScale = 1;
  /** the mesh's detail: 0 full (bones two rings and two tips), 1 far (a ring and two tips: half the vertices) — install.ts sets it from the zoom */
  lod = 0;
  /** (the GPU work toggles: the perf test turns them off one at a time) */
  meshOn = true;

  private table = new Float32Array(TABLE_VEC4 * 4);
  private tableDirty = true;
  private specs: SpeciesSpec[] = [];
  private rigs: Rig[] = [];
  private groupList: (Group | null)[] = [];
  private free: number[] = [];
  private hi = 0;
  private live = 0;
  private orders = new Float32Array((MAX_GROUPS * 2 + PATH_NODES * 2 + PATH_EDGES) * 4);
  private ordersDirty = true;
  private paths: { nodes: number; edges: number } = { nodes: 0, edges: 0 };
  private pathData: WalkPaths | null = null;
  private params = new ArrayBuffer(PARAMS_BYTES);
  private pendingShift: [number, number, number] | null = null;
  private abilityHost: AbilityHost | null = null;
  private time = 0;
  private readPending = false;
  private readDue = false;
  private ticks = 0;
  private bufs: { params: GPUBuffer; table: GPUBuffer; bins: GPUBuffer; orders: GPUBuffer; gsum: GPUBuffer; read: GPUBuffer };
  private k: Record<'binIt' | 'behave' | 'animate' | 'meshIt' | 'meshArgs' | 'shiftIt', ComputeKernel>;
  private g: Record<'binIt' | 'behave' | 'animate' | 'meshIt' | 'meshArgs' | 'shiftIt', GPUBindGroup>;
  private binsX: number;
  private binsY: number;

  constructor(
    private device: GPUDevice,
    private world: WorldGpu,
    private prof: Profiler,
    opts: InhabitantsOpts = {},
  ) {
    this.maxAgents = opts.maxAgents ?? 8192;
    const maxBind = device.limits.maxStorageBufferBindingSize;
    this.maxVerts = Math.min(opts.maxVerts ?? 2500 * 1000, Math.floor(maxBind / 32));
    const S = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
    const worldW = world.w + 0.5;
    const worldH = world.h * ROW_H;
    this.binsX = Math.ceil(worldW / BIN);
    this.binsY = Math.ceil(worldH / BIN);
    const nb = this.binsX * this.binsY;
    this.agentBuf = world.buf('lifeAgents', this.maxAgents * AS * 16, S);
    this.poseBuf = world.buf('lifePose', this.maxAgents * MAX_POINTS * 2 * 16, S);
    this.verts = world.buf('lifeVerts', this.maxVerts * 32, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
    this.drawArgs = world.buf('lifeDrawArgs', 32, GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC);
    this.bufs = {
      params: world.buf('lifeParams', PARAMS_BYTES, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST),
      table: world.buf('lifeSpecies', TABLE_VEC4 * 16, S),
      bins: world.buf('lifeBins', nb * (1 + BIN_CAP) * 4, S),
      orders: world.buf('lifeOrders', this.orders.byteLength, S),
      gsum: world.buf('lifeGroupSums', MAX_GROUPS * GS * 4, S),
      read: world.buf('lifeGroupRead', MAX_GROUPS * GS * 4, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST),
    };
    // every slot empty (species -1)
    const empty = new Float32Array(this.maxAgents * AS * 4);
    for (let i = 0; i < this.maxAgents; i++) empty[i * AS * 4 + 3] = -1;
    device.queue.writeBuffer(this.agentBuf, 0, empty);
    device.queue.writeBuffer(this.drawArgs, 0, new Uint32Array([0, 1, 0, 0, 0, 0, 0, 0]));
    const parts = [commonWgsl, lifeWgsl];
    const mk = (e: string, sp: BindSpec) => makeCompute(device, `life-${e}`, parts, sp, e);
    const base = { 0: 'uniform', 40: 'uniform', 41: 'read' } as const;
    const specs: Record<string, BindSpec> = {
      binIt: { ...base, 42: 'rw', 44: 'rw', 46: 'rw' },
      behave: { ...base, 15: 'tex', 17: 'tex', 21: 'tex', 42: 'rw', 44: 'rw', 45: 'read', 46: 'rw', 49: 'read', 50: 'read', 51: 'read' },
      animate: { ...base, 15: 'tex', 17: 'tex', 21: 'tex', 42: 'rw', 43: 'rw', 49: 'read' },
      meshIt: { ...base, 17: 'tex', 21: 'tex', 42: 'rw', 43: 'rw', 47: 'rw', 48: 'rw', 49: 'read' },
      meshArgs: { ...base, 48: 'rw' },
      shiftIt: { ...base, 42: 'rw', 43: 'rw' },
    };
    const res: Record<number, GPUBuffer | GPUTextureView> = {
      0: world.globals,
      15: world.windFieldView,
      17: world.driftView,
      21: world.bodyProjView,
      40: this.bufs.params,
      41: this.bufs.table,
      42: this.agentBuf,
      43: this.poseBuf,
      44: this.bufs.bins,
      45: this.bufs.orders,
      46: this.bufs.gsum,
      47: this.verts,
      48: this.drawArgs,
      49: world.surface,
      50: world.fire,
      51: world.water,
    };
    const k = {} as InhabitantsGpu['k'];
    const g = {} as InhabitantsGpu['g'];
    for (const [e, spec] of Object.entries(specs) as [keyof InhabitantsGpu['k'], BindSpec][]) {
      k[e] = mk(e, spec);
      g[e] = makeBindGroup(device, `life-${e}`, k[e].layout, Object.fromEntries(Object.keys(spec).map((b) => [b, res[Number(b)]])));
    }
    this.k = k;
    this.g = g;
  }

  // ---------------------------------------------------------------- the contract

  get count(): number {
    return this.live;
  }

  define(spec: SpeciesSpec): SpeciesId {
    let i = this.specs.findIndex((s) => s.id === spec.id);
    if (i < 0) {
      if (this.specs.length >= MAX_SPECIES) throw new Error(`inhabitants: more than ${MAX_SPECIES} species`);
      i = this.specs.length;
      this.specs.push(spec);
      this.rigs.push(buildRig(spec));
    } else {
      this.specs[i] = spec;
      this.rigs[i] = buildRig(spec);
    }
    // (every stalker's prey mask may name the new id)
    const ids = this.specs.map((s) => s.id);
    this.specs.forEach((s, j) => packSpecies(this.table, j, s, this.rigs[j], preyMaskOf(s, ids)));
    this.tableDirty = true;
    return i;
  }

  species(id: SpeciesId): SpeciesSpec {
    const s = this.specs[id];
    if (!s) throw new Error(`inhabitants: no species ${id}`);
    return s;
  }

  rig(id: SpeciesId): Rig {
    return this.rigs[id];
  }

  spawnGroup(species: SpeciesId, at: V2, n: number, opts: { spread?: number; seed?: number } = {}): GroupId {
    const spec = this.species(species);
    const rig = this.rigs[species];
    let gid = this.groupList.findIndex((g) => g === null);
    if (gid < 0) gid = this.groupList.length;
    if (gid >= MAX_GROUPS) throw new Error(`inhabitants: more than ${MAX_GROUPS} groups`);
    const seed = opts.seed ?? gid * 7919 + 17;
    const spread = opts.spread ?? Math.max(2, Math.sqrt(n) * rig.radius * 2.2);
    const slots: number[] = [];
    for (let k = 0; k < n; k++) {
      const s = this.free.pop() ?? (this.hi < this.maxAgents ? this.hi++ : -1);
      if (s < 0) throw new Error(`inhabitants: no room for more than ${this.maxAgents} creatures`);
      slots.push(s);
    }
    const flock = spec.behaviour.kind === 'flock';
    const data = new Float32Array(AS * 4);
    for (const [k, s] of slots.entries()) {
      const r = spread * Math.sqrt(rand01(seed, k * 3 + 1));
      const a = rand01(seed, k * 3 + 2) * Math.PI * 2;
      const x = at[0] + Math.cos(a) * r;
      const y = at[1] + Math.sin(a) * r;
      const h = rand01(seed, k * 3 + 3) * Math.PI * 2;
      const st = flock ? 5 : spec.behaviour.kind === 'stalker' ? 4 : 0;
      data.set([x, y, flock ? 40 : 0, species, 0, 0, 0, h, gid, st, rand01(seed, k + 99) * 3, 0, x, y, 0, 0, 1, (seed * 131 + k * 977) % 1e6, 1e6, 0], 0);
      this.device.queue.writeBuffer(this.agentBuf, s * AS * 16, data);
    }
    const g: Group = { id: gid, species, slots, order: { kind: 'roam', around: [at[0], at[1]], radius: Math.max(12, spread * 3) }, home: [at[0], at[1]], radius: Math.max(12, spread * 3), fleeUntil: 0, centre: [at[0], at[1], 0], count: n, cool: (spec.abilities ?? []).map(() => 0) };
    this.groupList[gid] = g;
    this.live += n;
    this.writeOrder(g);
    return gid;
  }

  drive(group: GroupId, order: GroupOrder): void {
    const g = this.group(group);
    g.order = order;
    if (order.kind === 'roam') {
      g.home = [order.around[0], order.around[1]];
      g.radius = order.radius;
    } else if (order.kind === 'go') {
      g.home = [order.to[0], order.to[1]];
      g.radius = Math.min(g.radius, 10);
    } else if (order.kind === 'flee') g.fleeUntil = this.time + (order.seconds ?? 4);
    else if (order.kind === 'pace') {
      g.home = [order.around[0], order.around[1]];
      g.radius = order.radius;
    }
    this.writeOrder(g);
  }

  remove(group: GroupId): void {
    const g = this.group(group);
    const dead = new Float32Array([0, 0, 0, -1]);
    for (const s of g.slots) {
      this.device.queue.writeBuffer(this.agentBuf, s * AS * 16, dead);
      this.free.push(s);
    }
    this.live -= g.slots.length;
    this.groupList[group] = null;
    this.orders.fill(0, group * 8, group * 8 + 8);
    this.orders[group * 8 + 3] = -1;
    this.ordersDirty = true;
  }

  groups(): readonly GroupView[] {
    return this.groupList.filter((g): g is Group => !!g).map((g) => ({ id: g.id, species: this.specs[g.species].id, count: g.count, centre: [...g.centre], order: g.order }));
  }

  setPaths(paths: WalkPaths): void {
    this.pathData = paths;
    this.paths = packPaths(paths, this.orders, MAX_GROUPS * 2 * 4);
    this.ordersDirty = true;
  }

  setAbilityHost(host: AbilityHost | null): void {
    this.abilityHost = host;
  }

  presence(rect: { x0: number; y0: number; x1: number; y1: number }, cell: number): Presence {
    const samples = this.groupList
      .filter((g): g is Group => !!g)
      .map((g) => {
        const rig = this.rigs[g.species];
        const spec = this.specs[g.species];
        return { x: g.centre[0], y: g.centre[1], count: g.count, threat: spec.threat ?? (spec.behaviour.kind === 'stalker' ? 0.8 : 0), spread: Math.max(2, Math.sqrt(g.count) * rig.radius * 2) };
      });
    return presence(samples, rect, cell);
  }

  shift(dx: number, dy: number, dz: number): void {
    const p = this.pendingShift ?? [0, 0, 0];
    this.pendingShift = [p[0] + dx, p[1] + dy, p[2] + dz];
    for (const g of this.groupList) {
      if (!g) continue;
      // (WorldCore.onShift's sense: the window moved by (dx, dy, dz), so what's in it moves by minus that)
      g.home = [g.home[0] - dx, g.home[1] - dy];
      g.centre = [g.centre[0] - dx, g.centre[1] - dy, g.centre[2] - dz];
      if (g.order.kind === 'roam') g.order = { ...g.order, around: g.home };
      if (g.order.kind === 'go') g.order = { ...g.order, to: g.home };
      if (g.order.kind === 'pace') g.order = { ...g.order, around: g.home };
      this.writeOrder(g);
    }
    if (this.pathData)
      this.setPaths({ ...this.pathData, nodes: this.pathData.nodes.map((n) => ({ at: [n.at[0] - dx, n.at[1] - dy, n.at[2] === null ? null : n.at[2] - dz] })) });
  }

  update(dt: number): void {
    this.time += dt;
    // abilities: through the level's hooks, from the group's last-read centre (a dragon is a group of one)
    const host = this.abilityHost;
    if (!host) return;
    for (const g of this.groupList) {
      if (!g || g.count <= 0) continue;
      const spec = this.specs[g.species];
      (spec.abilities ?? []).forEach((ab, k) => {
        g.cool[k] -= dt;
        if (g.cool[k] > 0) return;
        const [x, y, z] = g.centre;
        if (ab.kind === 'wingGust') {
          host.blow(x, y, ab.radius, ab.strength, 0.35);
          g.cool[k] = ab.every;
        } else if (ab.kind === 'fireBreath') {
          // at the nearest prey group within range
          const prey = spec.behaviour.kind === 'stalker' ? spec.behaviour.prey : [];
          let best: Group | null = null;
          let bd = ab.range;
          for (const o of this.groupList) {
            if (!o || o === g || !prey.includes(this.specs[o.species].id)) continue;
            const d = Math.hypot(o.centre[0] - x, o.centre[1] - y);
            if (d < bd) (bd = d), (best = o);
          }
          if (!best) return;
          const [tx, ty, tz] = best.centre;
          host.ignite(tx, ty, ab.radius ?? 2.5, 1);
          host.heat([tx, ty, tz], (ab.radius ?? 2.5) * 0.6, 9000, 0.8);
          g.cool[k] = ab.every;
          void z;
        }
      });
    }
  }

  // ---------------------------------------------------------------- the GPU

  encode(enc: GPUCommandEncoder): void {
    const n = this.hi;
    this.ticks++;
    if (this.tableDirty) {
      this.device.queue.writeBuffer(this.bufs.table, 0, this.table);
      this.tableDirty = false;
    }
    if (this.ordersDirty) {
      this.device.queue.writeBuffer(this.bufs.orders, 0, this.orders);
      this.ordersDirty = false;
    }
    // (one writeBuffer a tick: it lands before this tick's submit, so the shift it carries is this tick's only)
    this.writeParams(n);
    const shifting = !!this.pendingShift;
    this.pendingShift = null;
    if (n === 0) {
      enc.clearBuffer(this.drawArgs, 0, 4);
      return;
    }
    const wg = Math.ceil(n / 64);
    if (shifting) dispatch(enc, this.prof, 'life shift', this.k.shiftIt, this.g.shiftIt, [wg, 1]);
    enc.clearBuffer(this.bufs.bins, 0, this.binsX * this.binsY * 4);
    enc.clearBuffer(this.bufs.gsum);
    dispatch(enc, this.prof, 'life bins', this.k.binIt, this.g.binIt, [wg, 1]);
    if (this.ticks % 10 === 0 && !this.readPending) {
      enc.copyBufferToBuffer(this.bufs.gsum, 0, this.bufs.read, 0, MAX_GROUPS * GS * 4);
      this.readDue = true;
    }
    dispatch(enc, this.prof, 'life behave', this.k.behave, this.g.behave, [wg, 1]);
    dispatch(enc, this.prof, 'life animate', this.k.animate, this.g.animate, [wg, 1]);
    enc.clearBuffer(this.drawArgs);
    if (this.meshOn) {
      dispatch(enc, this.prof, 'life mesh', this.k.meshIt, this.g.meshIt, [wg, 1]);
      dispatch(enc, this.prof, 'life meshArgs', this.k.meshArgs, this.g.meshArgs, [1, 1]);
    }
  }

  afterSubmit(): void {
    if (!this.readDue) return;
    this.readDue = false;
    this.readPending = true;
    const rb = this.bufs.read;
    rb.mapAsync(GPUMapMode.READ).then(() => {
      const s = new Int32Array(rb.getMappedRange().slice(0));
      rb.unmap();
      this.readPending = false;
      for (const g of this.groupList) {
        if (!g) continue;
        const c = s[g.id * GS + 3];
        g.count = c;
        if (c > 0) g.centre = [s[g.id * GS] / (8 * c), s[g.id * GS + 1] / (8 * c), s[g.id * GS + 2] / (8 * c)];
        // a herd that bolted settles where it ran to, not back beside the wolf (its roam moves with it)
        if (c > 0 && s[g.id * GS + 4] > 0 && g.order.kind === 'roam') {
          g.home = [g.centre[0], g.centre[1]];
          g.order = { ...g.order, around: g.home };
          this.writeOrder(g);
        }
      }
    }, ignoreTeardown);
  }

  /** (tests, debugging) the draw args, creature `slot`'s state and its first points, the first vertices — read back now */
  async probe(slot = 0, nVerts = 4, nPoints = 8): Promise<{ args: number[]; agent: number[]; pose: number[]; verts: number[] }> {
    const d = this.device;
    const sizes = [32, AS * 16, nPoints * 32, Math.max(1, nVerts) * 32];
    const rb = d.createBuffer({ size: sizes.reduce((a, b) => a + b, 0), usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const enc = d.createCommandEncoder();
    let o = 0;
    enc.copyBufferToBuffer(this.drawArgs, 0, rb, o, sizes[0]);
    enc.copyBufferToBuffer(this.agentBuf, slot * AS * 16, rb, (o += sizes[0]), sizes[1]);
    enc.copyBufferToBuffer(this.poseBuf, slot * MAX_POINTS * 32, rb, (o += sizes[1]), sizes[2]);
    enc.copyBufferToBuffer(this.verts, 0, rb, (o += sizes[2]), sizes[3]);
    d.queue.submit([enc.finish()]);
    await rb.mapAsync(GPUMapMode.READ);
    const all = rb.getMappedRange().slice(0);
    rb.unmap();
    rb.destroy();
    const u = new Uint32Array(all);
    const f = new Float32Array(all);
    const r = (a: Float32Array | Uint32Array, s: number, n: number) => [...a.slice(s / 4, s / 4 + n / 4)].map((v) => +(+v).toFixed(3));
    return { args: r(u, 0, 32), agent: r(f, 32, sizes[1]), pose: r(f, 32 + sizes[1], sizes[2]), verts: r(f, 32 + sizes[1] + sizes[2], sizes[3]) };
  }

  private group(id: GroupId): Group {
    const g = this.groupList[id];
    if (!g) throw new Error(`inhabitants: no group ${id}`);
    return g;
  }

  private writeOrder(g: Group): void {
    const o = this.orders;
    const b = g.id * 8;
    // (pace: o1.x the gait)
    const fromXY = g.order.kind === 'flee' ? g.order.from : g.order.kind === 'pace' ? [GAIT[g.order.gait], 0] : [0, 0];
    o.set([g.home[0], g.home[1], g.radius, ORDER_KIND[g.order.kind]], b);
    o.set([fromXY[0], fromXY[1], g.fleeUntil, g.species], b + 4);
    this.ordersDirty = true;
  }

  private writeParams(n: number): void {
    const u = new Uint32Array(this.params);
    const f = new Float32Array(this.params);
    u[0] = n;
    u[1] = this.groupList.length;
    u[2] = this.binsX;
    u[3] = this.binsY;
    f[4] = BIN;
    f[5] = this.focus[0];
    f[6] = this.focus[1];
    f[7] = this.focusR;
    u[8] = this.lod;
    u[9] = this.paths.nodes;
    u[10] = this.paths.edges;
    u[11] = this.maxVerts;
    f[12] = this.time;
    f[13] = this.world.w + 0.5;
    f[14] = this.world.h * ROW_H;
    f[15] = this.drawScale;
    const sh = this.pendingShift ?? [0, 0, 0];
    f[16] = sh[0];
    f[17] = sh[1];
    f[18] = sh[2];
    f[19] = 0;
    this.device.queue.writeBuffer(this.bufs.params, 0, this.params);
  }
}
