// Agents (round 52, docs/AGENTS.md): units that walk the world's surfaces by
// following shared fields, and fight. The GPU does the walking and the
// behaviour (agents.wgsl: the surfaces peeled from the intervals, a distance
// field per goal relaxed a few sweeps a tick; units.wgsl: every unit's tick
// and its voxels). This side defines kinds, places units, says which field
// each group follows and where its seeds and the targets are, sends the
// game's hits, and reads units and events back.

import { makeBindGroup, makeCompute, ignoreTeardown, type BindSpec, type ComputeKernel } from '../gpu/pipeline';
import type { Profiler } from '../gpu/profiler';
import agentsWgsl from '../shaders/agents.wgsl?raw';
import commonWgsl from '../shaders/common.wgsl?raw';
import layersWgsl from '../shaders/layers.wgsl?raw';
import materialsWgsl from '../shaders/materials.wgsl?raw';
import unitsWgsl from '../shaders/units.wgsl?raw';
import type { SimSystem } from '../sim/system';
import type { WorldGpu } from '../sim/world-gpu';
import { MAT } from '../world/materials';
import { FieldReader } from './fieldreader';

/** surfaces a column (agents.wgsl NAV_K) */
export const NAV_K = 4;
/** unit slots (units.wgsl MAX_SLOTS: an id is generation × MAX_UNITS + slot) */
export const MAX_UNITS = 8192;
export const NFIELDS = 4;
export const MAX_GROUPS = 16;
export const MAX_KINDS = 8;
const MAX_SEEDS = 32;
const MAX_HITS = 32;
const MAX_TARGETS = 8;
const MAX_HOLDS = 8;
const MAX_LAUNCHES = 32;
const EVENT_CAP = 2048;
/** voxels drawn in all (units.wgsl MAX_INST), and in all the kinds' models */
const MAX_INST = 65536;
const MAX_MODEL_VOXELS = 8192;
/** sweeps of the fields a tick, and ticks between re-peeling the surfaces */
const SWEEPS = 8;
const PEEL_EVERY = 8;
/** the params uniform (agents.wgsl AgentParams), in u32s */
const P_SEEDS = 4;
const P_GFIELD = P_SEEDS + MAX_SEEDS * 4;
const P_GMAT = P_GFIELD + 16;
const P_FPLACE = P_GMAT + 16;
const P_N2 = P_FPLACE + 4;
const P_KINDS = P_N2 + 4;
const P_HITS = P_KINDS + MAX_KINDS * 12;
const P_TARGETS = P_HITS + MAX_HITS * 16;
const P_N3 = P_TARGETS + MAX_TARGETS * 4;
const P_HOLDS = P_N3 + 4;
const P_LAUNCHES = P_HOLDS + MAX_HOLDS * 4;
const PARAMS_BYTES = (P_LAUNCHES + MAX_LAUNCHES * 4) * 4;
/** what the tumbling units fall by (units.wgsl GRAVITY, cells/s²) */
export const AGENT_GRAVITY = 20;
/** bytes of a surface (agents.wgsl nav: vec4<u32>), and of a unit (four vec4) */
const NAV_BYTES = 16;
const UNIT_BYTES = 64;
/** each group's torso colour (the default figure), by material */
const GROUP_MATS = [MAT.Rust, MAT.Brick, MAT.Steel, MAT.Wood, MAT.Concrete, MAT.Grass, MAT.Basalt, MAT.Sand];
const STATES = ['wander', 'chase', 'swing', 'tumble', 'held'] as const;
export type AgentStateName = (typeof STATES)[number];

export interface Seed {
  x: number;
  y: number;
  /** height (world cells): which surface of the column; default the top */
  z?: number;
}

/** A kind of unit. A worker (notice 0) always follows its group's field; a hostile kind wanders until its field says a target is near. */
export interface KindSpec {
  name: string;
  /** cells tall (also how deep water drowns it), its mass (pushes divide by it), its hit points, walking speed (cells/s) */
  height: number;
  mass: number;
  hp: number;
  speed: number;
  /** how near (cells, to a target's edge) it swings, the damage a swing does, seconds between swings */
  reach?: number;
  damage?: number;
  swingPeriod?: number;
  /** how far along its field it notices a target (0: a worker) */
  notice?: number;
  /** the default figure's materials (MAT ids); torso default: its group's colour */
  colours?: { legs?: number; head?: number; torso?: number };
  /** its own look: voxels [x, y, z, material] in voxel units round its feet (z from 0 up), `voxel` cells each */
  model?: { voxels: readonly (readonly [number, number, number, number])[]; voxel: number };
}

export interface HitSpec {
  x: number;
  y: number;
  /** height of its centre; default any height */
  z?: number;
  radius: number;
  damage?: number;
  /** a push (cells/s, divided by the unit's mass): along `dir`, or outward from the centre */
  push?: number;
  dir?: readonly [number, number];
  outward?: boolean;
  /** a cone instead of a circle: its full angle (degrees) round `axis` (default `dir`) */
  cone?: number;
  axis?: readonly [number, number];
  /** sets them alight */
  fire?: boolean;
}

export interface Target {
  x: number;
  y: number;
  z: number;
  /** its size: reach counts to its edge */
  radius?: number;
}

export type AgentEvent =
  /** a swing begins: the blow lands on `target` in `lands` seconds, if it's still in reach (a parry's window) */
  | { type: 'windup'; id: number; target: number; lands: number; x: number; y: number; z: number }
  | { type: 'swing'; id: number; target: number; damage: number; x: number; y: number; z: number }
  | { type: 'hurt'; id: number; hit: number | 'impact'; damage: number; x: number; y: number; z: number }
  | { type: 'death'; id: number; by: number | 'fire' | 'water' | 'impact' | 'lava'; x: number; y: number; z: number }
  | { type: 'alight'; id: number; by: number | 'fire'; x: number; y: number; z: number };

export interface AgentState {
  id: number;
  x: number;
  y: number;
  z: number;
  /** facing (radians, from +x) */
  heading: number;
  /** its velocity (cells/s): walking, flying when tumbling, the hand's when held */
  vx: number;
  vy: number;
  vz: number;
  state: AgentStateName;
  alight: boolean;
  hp: number;
  kind: string;
  group: number;
}

const DEFAULT_KINDS: KindSpec[] = [
  { name: 'worker', height: 1.0, mass: 1, hp: 10, speed: 2.4 },
  { name: 'raider', height: 1.2, mass: 1, hp: 10, speed: 3.2, reach: 1.2, damage: 2, swingPeriod: 1.0, notice: 30 },
  { name: 'ogre', height: 2, mass: 3, hp: 22, speed: 1.8, reach: 1.8, damage: 5, swingPeriod: 1.6, notice: 25 },
];

export class Agents implements SimSystem {
  readonly name = 'agents';
  readonly period = 1;
  /** per surface: height, headroom, wet, links, room, region (agents.wgsl) */
  readonly nav: GPUBuffer;
  readonly dist: GPUBuffer;
  readonly units: GPUBuffer;
  readonly inst: GPUBuffer;
  readonly indirect: GPUBuffer;
  private occ: GPUBuffer;
  private shove: GPUBuffer;
  private events: GPUBuffer;
  private models: GPUBuffer;
  private kindModelsBuf: GPUBuffer;
  private params: GPUBuffer;
  private k: Record<'surfaces' | 'links' | 'relax' | 'occClear' | 'unitStep' | 'unitDraw', ComputeKernel>;
  private peelGroup: GPUBindGroup;
  private fieldGroup: GPUBindGroup;
  private unitGroup: GPUBindGroup;
  private drawGroup: GPUBindGroup;
  private fieldPlace = new Uint32Array(NFIELDS);
  /** slots in use: the high-water mark; freed slots (deaths, removals) are reused first */
  private count = 0;
  private free: number[] = [];
  private gen = new Uint16Array(MAX_UNITS);
  private seeds: (Seed & { field: number })[] = [];
  private groupField = new Uint32Array(MAX_GROUPS).fill(0xffffffff);
  private fieldsUsed = 0;
  private kinds: (KindSpec | undefined)[] = [];
  private kindModel = new Uint32Array(MAX_KINDS * 4);
  private modelVoxels = 0;
  private hits: (HitSpec & { id: number })[] = [];
  private nextHit = 1;
  private targets: Target[] = [];
  private holds = new Map<number, [number, number, number]>();
  private launches: [number, number, number, number][] = [];
  private ticks = 0;
  /** events that didn't fit the buffer, all told (0 normally) */
  dropped = 0;

  constructor(
    private device: GPUDevice,
    private world: WorldGpu,
    private prof: Profiler,
  ) {
    const cols = world.w * world.h;
    const S = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST;
    this.nav = world.buf('agentNav', cols * NAV_K * NAV_BYTES, S);
    this.dist = world.buf('agentDist', NFIELDS * cols * NAV_K * 4, S);
    this.units = world.buf('agentUnits', MAX_UNITS * UNIT_BYTES, S);
    this.occ = world.buf('agentOcc', 2 * cols * 4, S);
    this.shove = world.buf('agentShove', 2 * cols * 16, S);
    this.events = world.buf('agentEvents', (4 + EVENT_CAP * 8) * 4, S);
    this.inst = world.buf('agentInst', MAX_INST * 32, GPUBufferUsage.STORAGE);
    this.indirect = world.buf('agentIndirect', 16, GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST);
    this.models = world.buf('agentModels', MAX_MODEL_VOXELS * 16, S);
    this.kindModelsBuf = world.buf('agentKindModels', MAX_KINDS * 16, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    this.params = world.buf('agentParams', PARAMS_BYTES, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    device.queue.writeBuffer(this.indirect, 0, new Uint32Array([36, 0, 0, 0]));
    // (nothing reached yet: every field starts unreachable)
    device.queue.writeBuffer(this.dist, 0, new Float32Array(NFIELDS * cols * NAV_K).fill(1e9));
    device.queue.writeBuffer(this.kindModelsBuf, 0, this.kindModel);
    const parts = [commonWgsl, layersWgsl, materialsWgsl, agentsWgsl, unitsWgsl];
    const mk = (e: string, sp: BindSpec) => makeCompute(device, `agents-${e}`, parts, sp, e);
    // four layouts, each within 8 storage buffers: the peel (it reads the
    // layers and the places), the fields, the units' tick, their draw
    const peelSpec: BindSpec = { 0: 'uniform', 1: 'read', 2: 'uniform', 3: 'read', 4: 'read', 5: 'rw', 11: 'read', 12: 'read' };
    const fieldSpec: BindSpec = { 0: 'uniform', 2: 'uniform', 5: 'rw', 6: 'rw', 10: 'uniform' };
    const unitSpec: BindSpec = { 0: 'uniform', 2: 'uniform', 5: 'rw', 6: 'rw', 7: 'rw', 8: 'rw', 10: 'uniform', 13: 'rw', 14: 'read', 15: 'read', 16: 'rw', 19: 'tex' };
    const drawSpec: BindSpec = { 0: 'uniform', 2: 'uniform', 7: 'rw', 9: 'rw', 10: 'uniform', 22: 'rw', 23: 'read', 24: 'uniform' };
    this.k = {
      surfaces: mk('surfaces', peelSpec),
      links: mk('links', fieldSpec),
      relax: mk('relax', fieldSpec),
      occClear: mk('occClear', unitSpec),
      unitStep: mk('unitStep', unitSpec),
      unitDraw: mk('unitDraw', drawSpec),
    };
    const base = { 0: world.globals, 2: world.materials };
    this.peelGroup = makeBindGroup(device, 'agents-peel', this.k.surfaces.layout, {
      ...base,
      1: world.chunks,
      3: world.layers,
      4: world.water,
      5: this.nav,
      11: world.places,
      12: world.placeTable,
    });
    this.fieldGroup = makeBindGroup(device, 'agents-fields', this.k.relax.layout, { ...base, 5: this.nav, 6: this.dist, 10: this.params });
    this.unitGroup = makeBindGroup(device, 'agents-units', this.k.unitStep.layout, {
      ...base,
      5: this.nav,
      6: this.dist,
      7: this.units,
      8: this.occ,
      10: this.params,
      13: this.events,
      14: world.fire,
      15: world.lava,
      16: this.shove,
      19: world.sparkView,
    });
    this.drawGroup = makeBindGroup(device, 'agents-draw', this.k.unitDraw.layout, {
      ...base,
      7: this.units,
      9: this.inst,
      10: this.params,
      22: this.indirect,
      23: this.models,
      24: this.kindModelsBuf,
    });
    DEFAULT_KINDS.forEach((k, i) => this.defineKind(i, k));
    // the surfaces now, not at the first tick: a game reading them before
    // the world has ticked (a level installs agents after its warmup) finds them
    this.writeParams([]);
    const enc = device.createCommandEncoder({ label: 'agents-prime' });
    const pass = enc.beginComputePass({ label: 'agents-prime' });
    const [gx, gy] = world.groups;
    pass.setBindGroup(0, this.peelGroup);
    pass.setPipeline(this.k.surfaces.pipeline);
    pass.dispatchWorkgroups(gx, gy);
    pass.setBindGroup(0, this.fieldGroup);
    pass.setPipeline(this.k.links.pipeline);
    pass.dispatchWorkgroups(gx, gy);
    pass.end();
    device.queue.submit([enc.finish()]);
  }

  /** Slots in use (the live and the freed below the high-water mark). */
  get size(): number {
    return this.count;
  }

  /** Define (or redefine) kind `i` (0..7). Defaults: 0 worker, 1 raider, 2 ogre. */
  defineKind(i: number, spec: KindSpec): void {
    if (i < 0 || i >= MAX_KINDS) throw new Error(`agents: kind ${i} out of 0..${MAX_KINDS - 1}`);
    this.kinds[i] = spec;
    if (spec.model) {
      const vs = spec.model.voxels;
      if (this.modelVoxels + vs.length > MAX_MODEL_VOXELS) throw new Error(`agents: kind models over ${MAX_MODEL_VOXELS} voxels`);
      const code = Math.round(spec.model.voxel * 16);
      if (code < 1 || code > 63) throw new Error(`agents: a model voxel of ${spec.model.voxel} cells is outside 1/16..63/16`);
      const s = spec.model.voxel;
      const d = new Float32Array(vs.length * 4);
      const u = new Uint32Array(d.buffer);
      vs.forEach(([x, y, z, m], j) => {
        // (voxel centres: x, y round the feet, z up from them)
        d[j * 4] = x * s;
        d[j * 4 + 1] = y * s;
        d[j * 4 + 2] = (z + 0.5) * s;
        u[j * 4 + 3] = m;
      });
      this.device.queue.writeBuffer(this.models, this.modelVoxels * 16, d);
      this.kindModel.set([this.modelVoxels, vs.length, code, 0], i * 4);
      this.modelVoxels += vs.length;
    } else this.kindModel.set([0, 0, 0, 0], i * 4);
    this.device.queue.writeBuffer(this.kindModelsBuf, 0, this.kindModel);
  }

  /** A kind's index by name. */
  kindId(name: string): number {
    const i = this.kinds.findIndex((k) => k?.name === name);
    if (i < 0) throw new Error(`agents: no kind "${name}"`);
    return i;
  }

  /**
   * `n` units of a kind (index or name; default the worker) in `group`,
   * scattered round world (x, y) within `spread` cells; they land on the top
   * surface there. Returns their ids (generation × MAX_UNITS + slot: an id
   * stays unique when its slot is reused).
   */
  spawn(n: number, x: number, y: number, opts: { group?: number; kind?: number | string; spread?: number } = {}): number[] {
    const g = opts.group ?? 0;
    if (g < 0 || g >= MAX_GROUPS) throw new Error(`agents: group ${g} out of 0..${MAX_GROUPS - 1}`);
    const kind = typeof opts.kind === 'string' ? this.kindId(opts.kind) : (opts.kind ?? 0);
    const spec = this.kinds[kind];
    if (!spec) throw new Error(`agents: kind ${kind} isn't defined`);
    if (this.free.length + (MAX_UNITS - this.count) < n) throw new Error(`agents: no room for ${n} more units (${MAX_UNITS} slots)`);
    const spread = opts.spread ?? Math.sqrt(n) * 0.6;
    const ids: number[] = [];
    const d = new Float32Array(16);
    const u = new Uint32Array(d.buffer);
    for (let i = 0; i < n; i++) {
      const slot = this.free.length ? this.free.pop()! : this.count++;
      const gen = (this.gen[slot] = (this.gen[slot] + 1) & 0xffff);
      const r = spread * Math.sqrt(Math.random());
      const a = Math.random() * Math.PI * 2;
      d.fill(0);
      d[0] = x + Math.cos(a) * r;
      d[1] = y + Math.sin(a) * r;
      // (from above: the first step drops it onto the top surface)
      d[2] = 1e4;
      u[3] = g | (1 << 8) | (kind << 9) | (gen << 16);
      d[7] = Math.random();
      d[8] = spec.hp;
      d[11] = a;
      d[15] = Math.random() * Math.PI * 2;
      this.device.queue.writeBuffer(this.units, slot * UNIT_BYTES, d);
      ids.push(gen * MAX_UNITS + slot);
    }
    return ids;
  }

  /** Take units out at once (no death event). */
  remove(ids: readonly number[]): void {
    const z = new Float32Array(16);
    for (const id of ids) {
      const slot = id % MAX_UNITS;
      if (Math.floor(id / MAX_UNITS) !== this.gen[slot]) continue;
      this.device.queue.writeBuffer(this.units, slot * UNIT_BYTES, z);
      this.free.push(slot);
      this.holds.delete(slot);
    }
  }

  /** Group `g` follows field `f` (0..NFIELDS-1), or stands still (f < 0). */
  follow(g: number, f: number): void {
    if (f >= NFIELDS) throw new Error(`agents: field ${f} out of 0..${NFIELDS - 1}`);
    this.groupField[g] = f < 0 ? 0xffffffff : f;
    this.fieldsUsed = Math.max(this.fieldsUsed, f + 1);
  }

  /** Field `f`'s seeds (its distance is 0 there): a goal, a stockpile, a threat. */
  seed(f: number, seeds: readonly Seed[]): void {
    if (f < 0 || f >= NFIELDS) throw new Error(`agents: field ${f} out of 0..${NFIELDS - 1}`);
    const rest = this.seeds.filter((s) => s.field !== f);
    if (rest.length + seeds.length > MAX_SEEDS) throw new Error(`agents: more than ${MAX_SEEDS} seeds`);
    this.seeds = [...rest, ...seeds.map((s) => ({ ...s, field: f }))];
    this.fieldsUsed = Math.max(this.fieldsUsed, f + 1);
  }

  /**
   * What hostile kinds go for (the player's units, up to 8), each frame:
   * reach and swings count to these; `field` (default 3; < 0 none) is seeded
   * on them, for the groups that follow it to close in by.
   */
  setTargets(targets: readonly Target[], field = 3): void {
    if (targets.length > MAX_TARGETS) throw new Error(`agents: more than ${MAX_TARGETS} targets`);
    this.targets = targets.slice();
    if (field >= 0) this.seed(field, targets);
  }

  /**
   * A hit from the game: damage, a push, fire, over a circle or a cone. Up to
   * 32 go each tick; more wait for the next. Returns its id (death and hurt
   * events name it).
   */
  hit(h: HitSpec): number {
    if (h.cone !== undefined && !h.axis && !h.dir) throw new Error('agents: a cone hit needs a dir or an axis');
    const id = this.nextHit++;
    this.hits.push({ ...h, id });
    return id;
  }

  /** The slot of a live id, or -1 for an id whose unit is gone (its slot reused). */
  private slotOf(id: number): number {
    const slot = id % MAX_UNITS;
    return Math.floor(id / MAX_UNITS) === this.gen[slot] && slot < this.count ? slot : -1;
  }

  /**
   * Hold unit `id` at world (x, y, z) (its feet), each frame while held (a
   * lich, a gorilla carrying it): nothing else moves it. Up to 8 at once.
   * Returns false when the unit is gone.
   */
  hold(id: number, x: number, y: number, z: number): boolean {
    const slot = this.slotOf(id);
    if (slot < 0) return false;
    if (!this.holds.has(slot) && this.holds.size >= MAX_HOLDS) throw new Error(`agents: more than ${MAX_HOLDS} units held`);
    this.holds.set(slot, [x, y, z]);
    return true;
  }

  /** Let go of a held unit: it tumbles with `vel` (cells/s; default: as it was moving). */
  release(id: number, vel?: readonly [number, number, number]): void {
    const slot = this.slotOf(id);
    if (slot < 0) return;
    this.holds.delete(slot);
    if (vel) this.launches.push([vel[0], vel[1], vel[2], slot]);
  }

  /** Throw a unit (held or not) with a velocity: it tumbles, bounces, knocks others over, gets up. */
  launch(id: number, vel: readonly [number, number, number]): void {
    const slot = this.slotOf(id);
    if (slot < 0) return;
    this.holds.delete(slot);
    this.launches.push([vel[0], vel[1], vel[2], slot]);
  }

  /**
   * Lob a unit from (x, y, z) so it lands at `to`, in `time` seconds
   * (default: by distance, 0.5-1.5 s): the velocity it's launched with.
   */
  lob(id: number, from: readonly [number, number, number], to: readonly [number, number, number], time?: number): [number, number, number] {
    const d = Math.hypot(to[0] - from[0], to[1] - from[1]);
    const t = time ?? Math.min(1.5, Math.max(0.5, d / 14));
    const v: [number, number, number] = [(to[0] - from[0]) / t, (to[1] - from[1]) / t, (to[2] - from[2] + 0.5 * AGENT_GRAVITY * t * t) / t];
    this.launch(id, v);
    return v;
  }

  /**
   * Keep field `f` to one place (a room, or a region: all its rooms): its
   * distances live only on that place's surfaces, and a unit following it
   * never steps off it, so a horde stays in its room. `null`: anywhere again.
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

  /**
   * The live units and the events since the last sync, in one readback (call
   * it each frame or close to it; it resolves a frame or two later). Deaths
   * free their slots here, so a game spawning to keep a horde up must sync.
   */
  async sync(): Promise<{ units: AgentState[]; events: AgentEvent[]; dropped: number }> {
    const n = this.count;
    const evBytes = (4 + EVENT_CAP * 8) * 4;
    const tmp = this.device.createBuffer({ size: evBytes + Math.max(n, 1) * UNIT_BYTES, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const enc = this.device.createCommandEncoder();
    enc.copyBufferToBuffer(this.events, 0, tmp, 0, evBytes);
    if (n) enc.copyBufferToBuffer(this.units, 0, tmp, evBytes, n * UNIT_BYTES);
    this.device.queue.submit([enc.finish()]);
    // (cleared after the copy, before any later tick appends)
    this.device.queue.writeBuffer(this.events, 0, new Uint32Array([0]));
    const units: AgentState[] = [];
    const events: AgentEvent[] = [];
    let dropped = 0;
    await tmp.mapAsync(GPUMapMode.READ).then(() => {
      const b = tmp.getMappedRange();
      const eu = new Uint32Array(b, 0, evBytes / 4);
      const ef = new Float32Array(b, 0, evBytes / 4);
      const m = Math.min(eu[0], EVENT_CAP);
      dropped = eu[0] - m;
      const BY: Record<number, 'fire' | 'water' | 'impact' | 'lava'> = { 0xffffffff: 'fire', 0xfffffffe: 'water', 0xfffffffd: 'impact', 0xfffffffc: 'lava' };
      const by = (v: number) => BY[v] ?? v;
      for (let e = 0; e < m; e++) {
        const o = 4 + e * 8;
        const p = { x: ef[o + 4], y: ef[o + 5], z: ef[o + 6] };
        const id = eu[o + 1];
        const kind = eu[o];
        if (kind === 1) events.push({ type: 'swing', id, target: eu[o + 2], damage: ef[o + 3], ...p });
        else if (kind === 2) events.push({ type: 'hurt', id, hit: by(eu[o + 2]) as number | 'impact', damage: ef[o + 3], ...p });
        else if (kind === 3) {
          events.push({ type: 'death', id, by: by(eu[o + 2]), ...p });
          this.free.push(id % MAX_UNITS);
          this.holds.delete(id % MAX_UNITS);
        } else if (kind === 4) events.push({ type: 'alight', id, by: by(eu[o + 2]) as number | 'fire', ...p });
        else if (kind === 5) events.push({ type: 'windup', id, target: eu[o + 2], lands: ef[o + 3], ...p });
      }
      if (n) {
        const uf = new Float32Array(b, evBytes, n * 16);
        const uu = new Uint32Array(b, evBytes, n * 16);
        for (let s = 0; s < n; s++) {
          const info = uu[s * 16 + 3];
          if (!((info >>> 8) & 1)) continue;
          units.push({
            id: (info >>> 16) * MAX_UNITS + s,
            x: uf[s * 16],
            y: uf[s * 16 + 1],
            z: uf[s * 16 + 2],
            heading: uf[s * 16 + 11],
            vx: uf[s * 16 + 4],
            vy: uf[s * 16 + 5],
            vz: uf[s * 16 + 6],
            state: STATES[(info >>> 12) & 7] ?? 'wander',
            alight: ((info >>> 15) & 1) === 1,
            hp: uf[s * 16 + 8],
            kind: this.kinds[(info >>> 9) & 7]?.name ?? '?',
            group: info & 0xff,
          });
        }
      }
      tmp.unmap();
    }, ignoreTeardown);
    tmp.destroy();
    if (dropped) console.warn(`agents: ${dropped} events didn't fit (${EVENT_CAP} a sync): sync more often`);
    this.dropped += dropped;
    return { units, events, dropped };
  }

  /** The live units now: [x, y, z, group] each. */
  async read(): Promise<Float32Array> {
    const { units } = await this.sync();
    const out = new Float32Array(units.length * 4);
    units.forEach((u, i) => out.set([u.x, u.y, u.z, u.group], i * 4));
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

  private writeParams(hits: (HitSpec & { id: number })[]): void {
    const b = new ArrayBuffer(PARAMS_BYTES);
    const u = new Uint32Array(b);
    const f = new Float32Array(b);
    u[0] = this.count;
    u[1] = this.seeds.length;
    u[2] = this.fieldsUsed;
    u[3] = this.ticks;
    this.seeds.forEach((s, i) => f.set([s.x, s.y, s.z ?? 1e4, s.field], P_SEEDS + i * 4));
    for (let g = 0; g < MAX_GROUPS; g++) {
      // (a group following nothing reads past the fields in use: it stands)
      u[P_GFIELD + g] = this.groupField[g] === 0xffffffff ? NFIELDS : this.groupField[g];
      u[P_GMAT + g] = GROUP_MATS[g % GROUP_MATS.length];
    }
    u.set(this.fieldPlace, P_FPLACE);
    u.set([hits.length, this.targets.length, EVENT_CAP, 0], P_N2);
    this.kinds.forEach((k, i) => {
      if (!k) return;
      const o = P_KINDS + i * 12;
      f.set([k.height, k.mass, k.hp, k.speed, k.reach ?? 0, k.damage ?? 0, k.swingPeriod ?? 1, k.notice ?? 0], o);
      u.set([k.colours?.legs ?? 0, k.colours?.head ?? 0, k.colours?.torso ?? 0, 0], o + 8);
    });
    hits.forEach((h, i) => {
      const o = P_HITS + i * 16;
      const unit = (v?: readonly [number, number]): [number, number] => {
        const l = v ? Math.hypot(v[0], v[1]) : 0;
        return v && l > 0 ? [v[0] / l, v[1] / l] : [0, 0];
      };
      const dir = unit(h.dir);
      const axis = h.axis ? unit(h.axis) : dir;
      const cone = h.cone !== undefined ? Math.cos(((h.cone / 2) * Math.PI) / 180) : -2;
      f.set([h.x, h.y, h.z ?? -1e9, h.radius, dir[0], dir[1], cone, h.damage ?? 0, h.push ?? 0, h.outward ? 1 : 0, h.fire ? 1 : 0, h.id, axis[0], axis[1], 0, 0], o);
    });
    this.targets.forEach((t, i) => f.set([t.x, t.y, t.z, t.radius ?? 0.5], P_TARGETS + i * 4));
    const holds = [...this.holds].slice(0, MAX_HOLDS);
    const launches = this.launches.splice(0, MAX_LAUNCHES);
    u.set([holds.length, launches.length, 0, 0], P_N3);
    holds.forEach(([slot, p], i) => f.set([p[0], p[1], p[2], slot], P_HOLDS + i * 4));
    launches.forEach((l, i) => f.set(l, P_LAUNCHES + i * 4));
    this.device.queue.writeBuffer(this.params, 0, b);
  }

  encode(enc: GPUCommandEncoder): void {
    // (the tick number rides in the params: the occupancy halves swap on it)
    this.writeParams(this.hits.splice(0, MAX_HITS));
    const [gx, gy] = this.world.groups;
    const pass = enc.beginComputePass({ label: 'agents', timestampWrites: this.prof.timestamps('agents') });
    if (this.ticks % PEEL_EVERY === 0) {
      pass.setBindGroup(0, this.peelGroup);
      pass.setPipeline(this.k.surfaces.pipeline);
      pass.dispatchWorkgroups(gx, gy);
      pass.setBindGroup(0, this.fieldGroup);
      pass.setPipeline(this.k.links.pipeline);
      pass.dispatchWorkgroups(gx, gy);
      this.prof.dispatches += 2;
    }
    if (this.fieldsUsed > 0) {
      pass.setBindGroup(0, this.fieldGroup);
      pass.setPipeline(this.k.relax.pipeline);
      for (let i = 0; i < SWEEPS; i++) pass.dispatchWorkgroups(gx, gy);
      this.prof.dispatches += SWEEPS;
    }
    if (this.count > 0) {
      pass.setBindGroup(0, this.unitGroup);
      pass.setPipeline(this.k.occClear.pipeline);
      pass.dispatchWorkgroups(Math.ceil((this.world.w * this.world.h) / 64));
      pass.setPipeline(this.k.unitStep.pipeline);
      pass.dispatchWorkgroups(Math.ceil(this.count / 64));
      // the draw's instance count restarts each tick (written before this tick's submit)
      this.device.queue.writeBuffer(this.indirect, 0, new Uint32Array([36, 0, 0, 0]));
      pass.setBindGroup(0, this.drawGroup);
      pass.setPipeline(this.k.unitDraw.pipeline);
      pass.dispatchWorkgroups(Math.ceil(this.count / 64));
      this.prof.dispatches += 3;
    }
    pass.end();
    this.ticks++;
  }
}
