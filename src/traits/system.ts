// The trait system on the GPU agents (LW1; contracts/traits.ts, docs/ARCHITECTURE.md "Traits and effects").
//
// What it owns: one trait record a unit slot (prelude.wgsl: the trait word, the source, the occupant, an expiry tick a
// status), the effects of this tick (a uniform), and the run list — the core's bookkeeping (core.wgsl) around the
// game's modules, each its own kernel with its own table. Two halves:
//  - a SimSystem ('traits', every tick, before the agents): the effects' lives on the CPU (a field's seconds, a burst's
//    one tick), their reach into the world (Grow, Mend events: they don't need an agent about), this tick's params;
//  - an agents stage (agents.addStage): the kernels, after the units' step, before their draw, inside the agents' pass —
//    so whatever the rules decide this tick is what's drawn and what the step reads next tick (CAPS), and nothing per
//    agent ever touches the CPU.
//
// What it doesn't own: the units (the agents'), what the rules are (the game's modules), the world's fields (effects
// reach them only through the systems' own event channel: Grow for vegetation, Mend for structures).
//
// ?traits=0 turns the stage off (install.ts) — how its cost is measured on a tiler GPU (round 120: toggle, don't time).

import { makeBindGroup, makeCompute, ignoreTeardown, type BindSpec, type ComputeKernel } from '../gpu/pipeline';
import commonWgsl from '../shaders/common.wgsl?raw';
import layersWgsl from '../shaders/layers.wgsl?raw';
import materialsWgsl from '../shaders/materials.wgsl?raw';
import preludeWgsl from './prelude.wgsl?raw';
import coreWgsl from './core.wgsl?raw';
import { Agents, MAX_KINDS, MAX_UNITS } from '../agents/agents';
import type { SimSystem } from '../sim/system';
import { DAMAGE_TYPES, statusIndex, traitMask, traitNames, type EffectId, type EffectSpec, type IntrinsicName, type TraitModule, type TraitName, type TraitsApi } from '../api/contracts/traits';
import { TraitRegistry, TABLE_WORDS, type Registered } from './registry';
import { EventKind, type GlobalsState } from '../sim/globals';
import type { WorldGpu } from '../sim/world-gpu';

/** effects in a tick (prelude.wgsl TraitParams.effects) */
export const MAX_EFFECTS = 32;
/** trait assignments a tick (TraitParams.assigns); more wait for the next tick */
const MAX_ASSIGNS = 64;
/** u32s a slot's record (prelude.wgsl TRAIT_V vec4) */
const TRAIT_WORDS = 12;
/** the params uniform, in u32s: n, m, kindSeed (8), assigns (16 vec4), effects (32 × 3 vec4) */
const P_N = 0;
const P_M = 4;
const P_SEED = 8;
const P_ASSIGN = 16;
const P_EFF = P_ASSIGN + MAX_ASSIGNS * 4;
const PARAMS_WORDS = P_EFF + MAX_EFFECTS * 12;
const OPS = { heal: 1, raise: 2, damage: 3, status: 4 } as const;
const NONE = 0xffffffff;
const ENTRY = `
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= TP.n.x) { return; }
  module_main(id.x);
}
`;
const SPEC: BindSpec = { 0: 'uniform', 7: 'rw', 13: 'rw', 40: 'rw', 41: 'uniform', 42: 'uniform' };

interface Live {
  id: EffectId;
  spec: EffectSpec;
  /** seconds left (Infinity: until ended; 0: this tick only) */
  left: number;
  /** seconds to the next world pulse (heal's grow / mend) */
  pulse: number;
}

interface Run {
  name: string;
  wgsl: string;
  kernel: ComputeKernel;
  table: GPUBuffer;
  group: GPUBindGroup;
}

export interface TraitSystemOpts {
  /** seconds a corpse lies before it decays (default 40) */
  corpseSeconds?: number;
  /** a world effect landed at (x, y) within r (the level wakes the land there: sleeping chunks don't tick) */
  onWorld?: (x: number, y: number, r: number) => void;
}

export class TraitSystem implements TraitsApi, SimSystem {
  readonly name = 'traits';
  readonly period = 1;
  readonly traits: GPUBuffer;
  private params: GPUBuffer;
  private paramData = new Uint32Array(PARAMS_WORDS);
  private noTable: GPUBuffer;
  private pre: ComputeKernel;
  private post: ComputeKernel;
  private preG: GPUBindGroup;
  private postG: GPUBindGroup;
  private registry = new TraitRegistry();
  private runs: Run[] = [];
  private built = -1;
  private live: Live[] = [];
  private nextId = 1;
  private kindSeed = new Uint32Array(MAX_KINDS);
  private assigns: [number, number, number][] = [];
  private lastRead: Uint32Array | null = null;
  private corpseSeconds: number;
  private on = true;
  /**
   * Off: nothing encoded (?traits=0, the perf toggle) — and corpse mode off with it: no core lays the fallen out or lets
   * them decay, so the bodies lying now are cleared and the dead are freed at death again, as without the system.
   */
  get enabled(): boolean {
    return this.on;
  }
  set enabled(v: boolean) {
    if (v === this.on) return;
    this.on = v;
    this.agents.setKeepCorpses(v);
  }
  /** per tick: effects sent, modules run, dispatches */
  stats = { effects: 0, modules: 0, dispatches: 0 };
  /** the slots this tick's params were written for (0: none — the stage dispatches nothing) */
  private slots = 0;

  constructor(
    private device: GPUDevice,
    private world: WorldGpu,
    readonly agents: Agents,
    private globals: GlobalsState,
    private opts: TraitSystemOpts = {},
  ) {
    this.corpseSeconds = opts.corpseSeconds ?? 40;
    const S = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST;
    this.traits = world.buf('traits', MAX_UNITS * TRAIT_WORDS * 4, S);
    this.params = world.buf('traitParams', PARAMS_WORDS * 4, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    this.noTable = world.buf('traitNoTable', TABLE_WORDS * 4, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    this.kindSeed.fill(traitMask(['living']));
    const parts = [commonWgsl, layersWgsl, materialsWgsl, preludeWgsl, coreWgsl];
    this.pre = makeCompute(device, 'traits-pre', parts, SPEC, 'traitPre');
    this.post = makeCompute(device, 'traits-post', parts, SPEC, 'traitPost');
    const res = (table: GPUBuffer) => ({ 0: world.globals, 7: agents.units, 13: agents.eventsBuffer, 40: this.traits, 41: this.params, 42: table });
    this.preG = makeBindGroup(device, 'traits-pre', this.pre.layout, res(this.noTable));
    this.postG = makeBindGroup(device, 'traits-post', this.post.layout, res(this.noTable));
    // (corpse mode: a fallen unit's body lies there till it rises or decays — the core lays it out)
    agents.setKeepCorpses(true);
    agents.addStage({ encode: (pass) => this.dispatch(pass) });
  }

  // ---- the contract -------------------------------------------------------------------------------------

  kindTraits(kind: number | string, traits: readonly IntrinsicName[]): void {
    const k = typeof kind === 'string' ? this.agents.kindId(kind) : kind;
    if (k < 0 || k >= MAX_KINDS) throw new Error(`traits.kindTraits: kind ${k} out of 0..${MAX_KINDS - 1}`);
    this.kindSeed[k] = traitMask(traits);
  }

  assign(ids: readonly number[], traits: readonly IntrinsicName[]): void {
    const mask = traitMask(traits);
    if (mask & 0xffff0000) throw new Error('traits.assign: intrinsic traits only (statuses happen to a unit)');
    for (const id of ids) this.assigns.push([id % MAX_UNITS, Math.floor(id / MAX_UNITS), mask]);
  }

  apply(e: EffectSpec): EffectId {
    if (!(e.radius > 0)) throw new Error(`traits.apply: radius must be > 0 (got ${e.radius})`);
    if (e.op === 'damage' && !DAMAGE_TYPES.includes(e.type)) throw new Error(`traits.apply: no damage type "${e.type}"`);
    if (e.op === 'status') statusIndex(e.status);
    if (e.op === 'raise' && (e.group < 0 || e.group > 255)) throw new Error(`traits.apply: raise group ${e.group} out of 0..255`);
    const lasts = e.seconds ?? (e.op === 'heal' ? Infinity : 0);
    if (this.live.length >= MAX_EFFECTS) throw new Error(`traits.apply: ${MAX_EFFECTS} effects at once at most`);
    const id = this.nextId++;
    this.live.push({ id, spec: e, left: lasts, pulse: 0 });
    return id;
  }

  end(id: EffectId): void {
    this.live = this.live.filter((l) => l.id !== id);
  }

  /** the effects in the world now (the station's readout) */
  get effects(): readonly { id: EffectId; spec: EffectSpec; left: number }[] {
    return this.live;
  }

  register(m: TraitModule): void {
    this.registry.register(m);
  }

  unregister(name: string): void {
    this.registry.unregister(name);
  }

  modules(): readonly string[] {
    return this.registry.list().map((r) => r.name);
  }

  /** a module's table replaced (tuning without a recompile) */
  setTable(name: string, table: ArrayBufferView): void {
    this.registry.setTable(name, table);
  }

  async read(): Promise<void> {
    const n = Math.max(this.agents.size, 1);
    const bytes = n * TRAIT_WORDS * 4;
    const tmp = this.device.createBuffer({ size: bytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const enc = this.device.createCommandEncoder({ label: 'traits-read' });
    enc.copyBufferToBuffer(this.traits, 0, tmp, 0, bytes);
    this.device.queue.submit([enc.finish()]);
    await tmp.mapAsync(GPUMapMode.READ).then(() => {
      this.lastRead = new Uint32Array(tmp.getMappedRange().slice(0));
      tmp.unmap();
    }, ignoreTeardown);
    tmp.destroy();
  }

  traitsOf(id: number): TraitName[] | null {
    const r = this.lastRead;
    const slot = id % MAX_UNITS;
    if (!r || slot * TRAIT_WORDS >= r.length) return null;
    if (r[slot * TRAIT_WORDS + 2] !== Math.floor(id / MAX_UNITS) + 1) return null;
    return traitNames(r[slot * TRAIT_WORDS]);
  }

  /** at the last read: how many slots carry each trait (live or lying) */
  census(): Partial<Record<TraitName, number>> {
    const out: Partial<Record<TraitName, number>> = {};
    const r = this.lastRead;
    if (!r) return out;
    for (let s = 0; s * TRAIT_WORDS < r.length; s++) {
      if (!r[s * TRAIT_WORDS + 2]) continue;
      for (const t of traitNames(r[s * TRAIT_WORDS])) out[t] = (out[t] ?? 0) + 1;
    }
    return out;
  }

  /** the streamed window slid (−dx cells, −dy world units): the effects move with the land */
  shift(dx: number, dy: number): void {
    for (const l of this.live) l.spec = { ...l.spec, at: [l.spec.at[0] - dx, l.spec.at[1] - dy] };
  }

  // ---- the tick ---------------------------------------------------------------------------------------

  /** (SimSystem) the effects' lives and their reach into the world; this tick's params for the stage */
  encode(_enc: GPUCommandEncoder, _tick: number): void {
    this.slots = 0;
    if (!this.on) return;
    const n = this.agents.size;
    this.writeParams(n);
    this.slots = n;
  }

  /** (the agents' stage) the core and the rules over every slot */
  private dispatch(pass: GPUComputePassEncoder): void {
    const n = this.slots;
    if (!n) return;
    this.build();
    const groups = Math.ceil(n / 64);
    pass.setBindGroup(0, this.preG);
    pass.setPipeline(this.pre.pipeline);
    pass.dispatchWorkgroups(groups);
    for (const r of this.runs) {
      pass.setBindGroup(0, r.group);
      pass.setPipeline(r.kernel.pipeline);
      pass.dispatchWorkgroups(groups);
    }
    pass.setBindGroup(0, this.postG);
    pass.setPipeline(this.post.pipeline);
    pass.dispatchWorkgroups(groups);
    // (params are a tick's: a tick the system didn't run, the stage doesn't either)
    this.slots = 0;
    this.stats.modules = this.runs.length;
    this.stats.dispatches = this.runs.length + 2;
  }

  // ---- insides --------------------------------------------------------------------------------------------

  /** the run list from the registry (a module's kernel compiled once; its table rewritten when it changes) */
  private build(): void {
    if (this.built === this.registry.version) return;
    this.built = this.registry.version;
    const old = new Map(this.runs.map((r) => [r.name, r]));
    const next: Run[] = [];
    for (const m of this.registry.list()) {
      const was = old.get(m.name);
      const run = was && was.wgsl === m.wgsl ? was : this.compile(m);
      old.delete(m.name);
      this.device.queue.writeBuffer(run.table, 0, m.table);
      next.push(run);
    }
    for (const r of old.values()) r.table.destroy();
    this.runs = next;
  }

  private compile(m: Registered): Run {
    const kernel = makeCompute(this.device, `traits-${m.name}`, [commonWgsl, layersWgsl, materialsWgsl, preludeWgsl, m.wgsl, ENTRY], SPEC, 'main');
    const table = this.device.createBuffer({ label: `traits-${m.name} table`, size: TABLE_WORDS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const group = makeBindGroup(this.device, `traits-${m.name}`, kernel.layout, {
      0: this.world.globals,
      7: this.agents.units,
      13: this.agents.eventsBuffer,
      40: this.traits,
      41: this.params,
      42: table,
    });
    return { name: m.name, wgsl: m.wgsl, kernel, table, group };
  }

  private writeParams(n: number): void {
    const p = this.paramData;
    const f = new Float32Array(p.buffer);
    p.fill(0);
    const dt = this.globals.dt > 0 ? this.globals.dt : 1 / 60;
    const assigns = this.assigns.splice(0, MAX_ASSIGNS);
    // (a tick's effects: the lasting ones, and the bursts once)
    const now = this.live.slice(0, MAX_EFFECTS);
    p.set([n, now.length, Agents.EVENT_CAP, Math.max(1, Math.round(this.corpseSeconds / dt))], P_N);
    p.set([assigns.length, 0, 0, 0], P_M);
    p.set(this.kindSeed, P_SEED);
    assigns.forEach(([slot, gen, mask], i) => p.set([slot, gen, mask, 0], P_ASSIGN + i * 4));
    now.forEach((l, i) => {
      const o = P_EFF + i * 12;
      const e = l.spec;
      const burst = !(l.left > 0);
      f.set([e.at[0], e.at[1], e.z ?? -1e9, e.radius], o);
      let amount = 0;
      let lasts = 0;
      let kind = 0;
      let group = NONE;
      if (e.op === 'heal') amount = e.rate;
      else if (e.op === 'raise') {
        amount = e.health ?? 0;
        lasts = e.bound ?? 0;
        group = e.group;
      } else if (e.op === 'damage') {
        amount = e.amount;
        kind = DAMAGE_TYPES.indexOf(e.type);
      } else {
        lasts = e.lasts;
        kind = statusIndex(e.status);
      }
      f.set([amount, lasts, 0, burst ? 1 : 0], o + 4);
      p.set([OPS[e.op], group >>> 0, kind, l.id], o + 8);
      this.pulseWorld(l, dt);
    });
    this.device.queue.writeBuffer(this.params, 0, p);
    this.stats.effects = now.length;
    // (time passes for the lasting; the bursts are spent)
    for (const l of now) l.left -= dt;
    this.live = this.live.filter((l) => l.left > 0);
  }

  /** a lasting heal's reach into the world: growth and mending, through the systems' own events */
  private pulseWorld(l: Live, dt: number): void {
    const e = l.spec;
    if (e.op !== 'heal' || !e.world) return;
    l.pulse -= dt;
    if (l.pulse > 0) return;
    l.pulse = e.world.every ?? 1;
    const [x, y] = e.at;
    // (growth: a tap's worth somewhere in the field each pulse — the Grow event plants a tree at its very middle, so one
    // spot pulsed again and again becomes one thicket)
    if (e.world.grow) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.random()) * e.radius * 0.85;
      this.globals.events.push({ kind: EventKind.Grow, x: x + Math.cos(a) * r, y: y + Math.sin(a) * r, radius: Math.min(3, e.radius), strength: 1 });
    }
    if (e.world.mend) this.globals.events.push({ kind: EventKind.Mend, x, y, radius: e.radius, strength: Math.min(1, 0.5 * e.rate) });
    this.opts.onWorld?.(x, y, e.radius);
  }
}
