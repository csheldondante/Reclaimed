// Agents (round 52, docs/AGENTS.md): units that walk the world's surfaces by
// following shared fields, and fight. The GPU does the walking and the
// behaviour (agents.wgsl: the surfaces peeled from the intervals, a distance
// field per goal relaxed a few sweeps a tick; units.wgsl: every unit's tick
// and its voxels). This side defines kinds, places units, says which field
// each group follows and where its seeds and the targets are, sends the
// game's hits, and reads units and events back.

import { Translator } from '../sim/translate';
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
import { materialId, materialName, materialState, type MaterialName } from '../api/common';
import type { Terrain } from '../api/terrain';
import { FieldReader } from './fieldreader';
import { AgentScope } from './scope';
import { CUSTOM, TILES_BINDING, cullKernel } from '../sim/cull';
import { ROW_H } from '../world/lattice';

/** (round 104, simscale) the fields kept only round what the agents do and relaxed only where something changed
 *  (agents/scope.ts); ?agentscope=0: the whole window every tick, as before */
const SCOPE = typeof location === 'undefined' || new URLSearchParams(location.search).get('agentscope') !== '0';
/** the scope's tile lists (sim/cull.ts CUSTOM): its chunks, and those new to it this tick */
const SCOPE_LIST = CUSTOM + 10;
const ENTER_LIST = CUSTOM + 11;
/** chunks marked changed by the CPU this tick (a seed placed or moved) */
const MARK_LIST = CUSTOM + 12;

/**
 * (round 104, simscale) The relax kernel dispatched indirect over the front (agents.wgsl frontList): its 8 x 8 entry
 * renamed, a wrapper by its name finding its columns from the list, four workgroups a chunk (sim/cull.ts cullSource's
 * shape, the list in storage).
 */
function frontSource(src: string, entry: string): string {
  const re = new RegExp(`@compute\\s+@workgroup_size\\(8,\\s*8\\)\\s*fn ${entry}\\(@builtin\\(global_invocation_id\\) (\\w+): vec3<u32>\\)`);
  const m = src.match(re);
  if (!m) throw new Error(`agents: ${entry} isn't an 8 x 8 per-column pass`);
  return (
    src.replace(re, `fn ${entry}_column(${m[1]}: vec3<u32>)`) +
    `
@compute @workgroup_size(8, 8)
fn ${entry}(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_id) l: vec3<u32>) {
  let c = frontList[wg.x >> 2u];
  let s = wg.x & 3u;
  let q = vec2<u32>((c % G.chunksX) * G.chunkSize + (s & 1u) * 8u + l.x, (c / G.chunksX) * G.chunkSize + (s >> 1u) * 8u + l.y);
  if (q.x >= G.mapW || q.y >= G.mapH) { return; }
  ${entry}_column(vec3<u32>(q, 0u));
}
`
  );
}
/** ticks between reads of the units' box and of what moved */
const READ_EVERY = 8;

/** surfaces a column (agents.wgsl NAV_K) */
export const NAV_K = 4;
/** unit slots (units.wgsl MAX_SLOTS: an id is generation × MAX_UNITS + slot) */
export const MAX_UNITS = 8192;
export const NFIELDS = 12;
export const MAX_GROUPS = 16;
export const MAX_KINDS = 8;
const MAX_SEEDS = 48;
const MAX_HITS = 32;
const MAX_TARGETS = 8;
const MAX_HOLDS = 8;
const MAX_LAUNCHES = 32;
const EVENT_CAP = 2048;
/** voxels drawn in all (units.wgsl MAX_INST), and in all the kinds' models */
const MAX_INST = 65536;
const MAX_MODEL_VOXELS = 8192;
/** sweeps of the fields a tick, and ticks between re-peeling the surfaces */
const PEEL_EVERY = 8;
/** the params uniform (agents.wgsl AgentParams), in u32s */
const P_SEEDS = 4;
const P_GFIELD = P_SEEDS + MAX_SEEDS * 4;
const P_GMAT = P_GFIELD + 16;
const P_FPLACE = P_GMAT + 16;
const P_N2 = P_FPLACE + 12;
const P_KINDS = P_N2 + 4;
const P_HITS = P_KINDS + MAX_KINDS * 12;
const P_TARGETS = P_HITS + MAX_HITS * 16;
const P_N3 = P_TARGETS + MAX_TARGETS * 4;
const P_HOLDS = P_N3 + 4;
const P_LAUNCHES = P_HOLDS + MAX_HOLDS * 4;
const P_TARGET_H = P_LAUNCHES + MAX_LAUNCHES * 4;
/** units moved to another group a tick (agents.wgsl regroups) */
const MAX_REGROUPS = 64;
const P_REGROUPS = P_TARGET_H + MAX_TARGETS;
const PARAMS_BYTES = (P_REGROUPS + MAX_REGROUPS) * 4;
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
  /** an upward speed (cells/s, divided by the unit's mass) on top of the push: it throws them (without it, a push past 5 cells/s after the mass hops them by a third of it) */
  lift?: number;
  /** seconds they stay down once settled, beyond the usual 0.6 s getting up; a hit that doesn't throw them holds them where they stand (up to 20) */
  stun?: number;
  /** sets them alight */
  fire?: boolean;
  /** only these groups' units feel it (round 63: a lich's fireball spares its raised dead) */
  groups?: readonly number[];
  /** these groups' units don't feel it */
  spare?: readonly number[];
}

/** A throw's options: `stun`, seconds it stays down once settled, beyond the usual getting up (up to 20). */
export interface LaunchOpts {
  stun?: number;
}

const MAX_STUN = 20;

export interface Target {
  x: number;
  y: number;
  z: number;
  /** its size: reach counts to its edge */
  radius?: number;
  /** how tall it stands from z (its feet), cells (default 1.5): reach counts to the nearest point of it */
  height?: number;
}

export type AgentEvent =
  /** a swing begins: the blow lands on `target` in `lands` seconds, if it's still in reach (a parry's window) */
  | { type: 'windup'; id: number; target: number; lands: number; x: number; y: number; z: number }
  | { type: 'swing'; id: number; target: number; damage: number; x: number; y: number; z: number }
  | { type: 'hurt'; id: number; hit: number | 'impact'; damage: number; x: number; y: number; z: number }
  | { type: 'death'; id: number; by: number | 'fire' | 'water' | 'impact' | 'lava'; x: number; y: number; z: number }
  | { type: 'alight'; id: number; by: number | 'fire'; x: number; y: number; z: number }
  /** a thrown (or dropped) item came down: `amount` of it is ground there now (0: the column had no room) */
  | { type: 'landed'; item: number; material: MaterialName; amount: number; x: number; y: number; z: number };

/** What a unit carries: an amount (cellsÂ³) of a material, ground taken up or to be put down. */
export interface Item {
  material: MaterialName;
  amount: number;
}

/** units.wgsl MAX_FLY: items in flight at once */
const MAX_FLY = 128;
/** units.wgsl GRAVITY */
const GRAVITY = 20;

interface Flight {
  id: number;
  mat: number;
  amount: number;
  pos: [number, number, number];
  vel: [number, number, number];
  spin: number;
  hit?: ThrowHit;
}

/** What a thrown item does to the units where it lands (agents.hit). */
export interface ThrowHit {
  radius?: number;
  damage?: number;
  push?: number;
  lift?: number;
  stun?: number;
  /** only these groups feel it, or these are spared (HitSpec) */
  groups?: readonly number[];
  spare?: readonly number[];
}

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
  private k: Record<'surfaces' | 'links' | 'relax' | 'occClear' | 'unitStep' | 'unitDraw' | 'itemDraw', ComputeKernel>;
  /** what each unit carries (round 63): by slot, its material and edge; and items in flight */
  private carryBuf: GPUBuffer;
  private flyBuf: GPUBuffer;
  private carried = new Map<number, { mat: number; amount: number }>();
  private flights: Flight[] = [];
  private nextItem = 1;
  private landed: AgentEvent[] = [];
  private flyAt = 0;
  /** each live unit at the last sync, by slot: x, y, z, vx, vy, vz, state */
  private seen = new Map<number, AgentState>();
  private terrain?: Terrain;
  private flyDrawn = false;
  private peelGroup: GPUBindGroup;
  private fieldGroup: GPUBindGroup;
  /** (round 104, simscale) the scope's box (agents.wgsl AB); the front's per-chunk marks (two: a sweep's and the
   *  next's), its list and its dispatch (agents/scope.ts) */
  private abBuf: GPUBuffer;
  private dirty: [GPUBuffer, GPUBuffer];
  private frontArgs: GPUBuffer;
  private frontList: GPUBuffer;
  /** which of `dirty` is the current sweep's at the next tick's start */
  private par = 0;
  private uboxBuf: GPUBuffer;
  private readBuf: GPUBuffer;
  private reading = false;
  private lastRead = 0;
  /** (simscale) where the fields are kept and which are frozen (agents/scope.ts); null: ?agentscope=0 */
  readonly scope: AgentScope | null;
  private sk?: {
    surfaces: ComputeKernel;
    links: ComputeKernel;
    relax: ComputeKernel;
    occ: ComputeKernel;
    enter: ComputeKernel;
    box: ComputeKernel;
    reset: ComputeKernel;
    build: ComputeKernel;
    clear: ComputeKernel;
    mark: ComputeKernel;
    occG: GPUBindGroup;
    boxG: GPUBindGroup;
    resetG: GPUBindGroup;
    /** per parity (which of `dirty` is the current sweep's) */
    peelG: GPUBindGroup[];
    linksG: GPUBindGroup[];
    relaxG: GPUBindGroup[];
    enterG: GPUBindGroup[];
    buildG: GPUBindGroup[];
    clearG: GPUBindGroup[];
    markG: GPUBindGroup[];
  };
  /** (simscale) the fields set unreachable this tick (they lost their seeds: writeParams) */
  private clearNow = 0;
  /** (simscale) a read in flight: the spawns' serial it sees */
  private readIssued: { serial: number } | null = null;
  /** (simscale) its scope's chunks at the last tick (the perf overlay, tests) */
  lastScopeChunks = 0;
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
  private wasSeeded = 0;
  /** per group: drawn at work (round 88: bent to a tool, a tool in hand) */
  private groupPose = new Uint32Array(MAX_GROUPS);
  private kinds: (KindSpec | undefined)[] = [];
  private kindModel = new Uint32Array(MAX_KINDS * 4);
  private modelVoxels = 0;
  private hits: (HitSpec & { id: number })[] = [];
  private nextHit = 1;
  private targets: Target[] = [];
  private holds = new Map<number, [number, number, number]>();
  private launches: [number, number, number, number][] = [];
  private regroups: number[] = [];
  private ticks = 0;
  /** the surfaces weren't peeled while idle (round 88): peel on the next tick that needs them */
  private navStale = true;
  /** events that didn't fit the buffer, all told (0 normally) */
  dropped = 0;

  /**
   * Relax sweeps a tick (quality's `agentSweeps`; default 8). The fields'
   * fixed cost is the map's size × this. A change spreads this many cells a
   * tick (2: 120 cells/s, enough to follow anything that moves; a first
   * fill across a 256 map takes ~2 s rather than ~0.5).
   */
  sweeps: number;

  constructor(
    private device: GPUDevice,
    private world: WorldGpu,
    private prof: Profiler,
    sweeps = 8,
  ) {
    this.sweeps = sweeps;
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
    this.carryBuf = world.buf('agentCarry', MAX_UNITS * 16, S);
    this.flyBuf = world.buf('agentFly', MAX_FLY * 32, S);
    device.queue.writeBuffer(this.indirect, 0, new Uint32Array([36, 0, 0, 0]));
    // (nothing reached yet: every field starts unreachable)
    device.queue.writeBuffer(this.dist, 0, new Float32Array(NFIELDS * cols * NAV_K).fill(1e9));
    device.queue.writeBuffer(this.kindModelsBuf, 0, this.kindModel);
    const parts = [commonWgsl, layersWgsl, materialsWgsl, agentsWgsl, unitsWgsl];
    const mk = (e: string, sp: BindSpec) => makeCompute(device, `agents-${e}`, parts, sp, e);
    // four layouts, each within 8 storage buffers: the peel (it reads the
    // layers and the places), the fields, the units' tick, their draw
    const peelSpec: BindSpec = { 0: 'uniform', 1: 'read', 2: 'uniform', 3: 'read', 4: 'read', 5: 'rw', 11: 'read', 12: 'read', 34: 'rw' };
    const fieldSpec: BindSpec = { 0: 'uniform', 2: 'uniform', 5: 'rw', 6: 'rw', 10: 'uniform', 34: 'rw', 35: 'rw', 38: 'uniform' };
    // (round 104, simscale: agents/scope.ts)
    this.abBuf = world.buf('agentScope', 32, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    device.queue.writeBuffer(this.abBuf, 0, new Uint32Array([0, 0, world.w, world.h, 0, 0, 0, 0]));
    const nChunks = Math.max(1, (world.w / 16) * (world.h / 16));
    this.dirty = [world.buf('agentDirtyA', nChunks * 4, S), world.buf('agentDirtyB', nChunks * 4, S)];
    this.frontArgs = world.buf('agentFrontArgs', 16, GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST);
    this.frontList = world.buf('agentFrontList', nChunks * 4, S);
    this.uboxBuf = world.buf('agentUnitBox', 16, S);
    this.readBuf = world.buf('agentScopeRead', 16, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST);
    this.scope = SCOPE && world.tiles ? new AgentScope(world.w / 16, world.h / 16) : null;
    const unitSpec: BindSpec = { 0: 'uniform', 2: 'uniform', 5: 'rw', 6: 'rw', 7: 'rw', 8: 'rw', 10: 'uniform', 13: 'rw', 14: 'read', 15: 'tex', 16: 'rw', 19: 'tex', 25: 'read' };
    const drawSpec: BindSpec = { 0: 'uniform', 2: 'uniform', 7: 'rw', 9: 'rw', 10: 'uniform', 22: 'rw', 23: 'read', 24: 'uniform', 26: 'read', 27: 'read' };
    this.k = {
      surfaces: mk('surfaces', peelSpec),
      links: mk('links', fieldSpec),
      relax: mk('relax', fieldSpec),
      occClear: mk('occClear', unitSpec),
      unitStep: mk('unitStep', unitSpec),
      unitDraw: mk('unitDraw', drawSpec),
      itemDraw: mk('itemDraw', drawSpec),
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
      34: this.dirty[0],
    });
    this.fieldGroup = makeBindGroup(device, 'agents-fields', this.k.relax.layout, { ...base, 5: this.nav, 6: this.dist, 10: this.params, 34: this.dirty[0], 35: this.dirty[1], 38: this.abBuf });
    if (this.scope) {
      const t = world.tiles!;
      const src = parts.join('\n');
      const ck = (e: string, sp: BindSpec, n: number) => {
        const c = cullKernel(t, src, sp, e, n);
        return { k: makeCompute(device, `agents-${e} scoped`, [c.code], c.spec, e), buf: c.buf };
      };
      const occSpec: BindSpec = { 0: 'uniform', 2: 'uniform', 8: 'rw', 10: 'uniform', 16: 'rw' };
      const enterSpec: BindSpec = { 0: 'uniform', 2: 'uniform', 6: 'rw', 8: 'rw', 16: 'rw', 34: 'rw' };
      const surfaces = ck('surfaces', peelSpec, SCOPE_LIST);
      const links = ck('links', fieldSpec, SCOPE_LIST);
      const occ = ck('occClearCols', occSpec, SCOPE_LIST);
      const enter = ck('scopeIn', enterSpec, ENTER_LIST);
      const mark = ck('markChunks', { 0: 'uniform', 2: 'uniform', 34: 'rw' }, MARK_LIST);
      const relaxSpec: BindSpec = { ...fieldSpec, 36: 'rw' };
      const relax = makeCompute(device, 'agents-relax front', [frontSource(src, 'relax')], relaxSpec, 'relax');
      const box = makeCompute(device, 'agents-unitBox', parts, { 0: 'uniform', 2: 'uniform', 7: 'rw', 10: 'uniform', 28: 'rw' }, 'unitBox');
      const reset = makeCompute(device, 'agents-frontReset', parts, { 0: 'uniform', 2: 'uniform', 33: 'rw' }, 'frontReset');
      const build = makeCompute(device, 'agents-frontBuild', parts, { 0: 'uniform', 2: 'uniform', 33: 'rw', 34: 'rw', 36: 'rw', 38: 'uniform' }, 'frontBuild');
      const clear = makeCompute(device, 'agents-frontClear', parts, { 0: 'uniform', 2: 'uniform', 34: 'rw', 38: 'uniform' }, 'frontClear');
      const L = surfaces.buf;
      const par = <T,>(f: (cur: GPUBuffer, next: GPUBuffer, p: number) => T): T[] => [f(this.dirty[0], this.dirty[1], 0), f(this.dirty[1], this.dirty[0], 1)];
      this.sk = {
        surfaces: surfaces.k,
        links: links.k,
        relax,
        occ: occ.k,
        enter: enter.k,
        box,
        reset,
        build,
        clear,
        mark: mark.k,
        occG: makeBindGroup(device, 'agents-occ scoped', occ.k.layout, { ...base, 8: this.occ, 10: this.params, 16: this.shove, [TILES_BINDING]: L }),
        boxG: makeBindGroup(device, 'agents-unitBox', box.layout, { ...base, 7: this.units, 10: this.params, 28: this.uboxBuf }),
        resetG: makeBindGroup(device, 'agents-frontReset', reset.layout, { ...base, 33: this.frontArgs }),
        peelG: par((cur, _n, p) => makeBindGroup(device, `agents-peel scoped ${p}`, surfaces.k.layout, { ...base, 1: world.chunks, 3: world.layers, 4: world.water, 5: this.nav, 11: world.places, 12: world.placeTable, 34: cur, [TILES_BINDING]: L })),
        linksG: par((cur, next, p) => makeBindGroup(device, `agents-links scoped ${p}`, links.k.layout, { ...base, 5: this.nav, 6: this.dist, 10: this.params, 34: cur, 35: next, 38: this.abBuf, [TILES_BINDING]: L })),
        relaxG: par((cur, next, p) => makeBindGroup(device, `agents-relax front ${p}`, relax.layout, { ...base, 5: this.nav, 6: this.dist, 10: this.params, 34: cur, 35: next, 36: this.frontList, 38: this.abBuf })),
        enterG: par((cur, _n, p) => makeBindGroup(device, `agents-enter ${p}`, enter.k.layout, { ...base, 6: this.dist, 8: this.occ, 16: this.shove, 34: cur, [TILES_BINDING]: enter.buf })),
        buildG: par((cur, _n, p) => makeBindGroup(device, `agents-frontBuild ${p}`, build.layout, { ...base, 33: this.frontArgs, 34: cur, 36: this.frontList, 38: this.abBuf })),
        clearG: par((cur, _n, p) => makeBindGroup(device, `agents-frontClear ${p}`, clear.layout, { ...base, 34: cur, 38: this.abBuf })),
        markG: par((cur, _n, p) => makeBindGroup(device, `agents-mark ${p}`, mark.k.layout, { ...base, 34: cur, [TILES_BINDING]: mark.buf })),
      };
    }
    this.unitGroup = makeBindGroup(device, 'agents-units', this.k.unitStep.layout, {
      ...base,
      5: this.nav,
      6: this.dist,
      7: this.units,
      8: this.occ,
      10: this.params,
      13: this.events,
      14: world.fire,
      15: world.windFieldView,
      16: this.shove,
      19: world.sparkView,
      25: world.lava,
    });
    this.drawGroup = makeBindGroup(device, 'agents-draw', this.k.unitDraw.layout, {
      ...base,
      7: this.units,
      9: this.inst,
      10: this.params,
      22: this.indirect,
      23: this.models,
      24: this.kindModelsBuf,
      26: this.carryBuf,
      27: this.flyBuf,
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
  spawn(n: number, x: number, y: number, opts: { group?: number; kind?: number | string; spread?: number; hp?: number } = {}): number[] {
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
      this.scope?.place(d[0], d[1] / ROW_H);
      // (from above: the first step drops it onto the top surface)
      d[2] = 1e4;
      u[3] = g | (1 << 8) | (kind << 9) | (gen << 16);
      d[7] = Math.random();
      d[8] = opts.hp ?? spec.hp;
      d[11] = a;
      d[15] = Math.random() * Math.PI * 2;
      this.device.queue.writeBuffer(this.units, slot * UNIT_BYTES, d);
      ids.push(gen * MAX_UNITS + slot);
    }
    return ids;
  }

  private translator?: Translator;

  /**
   * The streamed window slid (round 80): every unit and item in flight moves with the land (−d: dx cells,
   * dy world units, dz cells); the fields and surfaces per column go with the streamer's (installAgents
   * hands them to it).
   */
  shift(dx: number, dy: number, dz: number): void {
    this.translator ??= new Translator(this.device);
    this.translator.run(this.units, MAX_UNITS, 4, 0b1, [dx, dy, dz]);
    this.translator.run(this.flyBuf, MAX_FLY, 2, 0b1, [dx, dy, dz]);
    for (const f of this.flights) f.pos = [f.pos[0] - dx, f.pos[1] - dy, f.pos[2] - dz];
    // (round 104, simscale: the scope's box with the land; the strips come in start over)
    this.scope?.shift(dx, Math.round(dy / ROW_H));
  }

  /** the per-column buffers a slide moves (name, buffer, bytes a column, planes) */
  columnBuffers(): { name: string; buf: GPUBuffer; stride: number; planes: number }[] {
    return [
      { name: 'agentNav', buf: this.nav, stride: NAV_K * NAV_BYTES, planes: 1 },
      { name: 'agentDist', buf: this.dist, stride: NAV_K * 4, planes: NFIELDS },
      { name: 'agentOcc', buf: this.occ, stride: 4, planes: 2 },
      { name: 'agentShove', buf: this.shove, stride: 16, planes: 2 },
    ];
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
      // (its load falls where it was last seen: ground isn't lost with it)
      const it = this.carried.get(slot);
      if (it) {
        this.carried.delete(slot);
        this.writeCarry(slot, undefined);
        const u = this.seen.get(slot);
        if (u) this.toss(materialName(it.mat), it.amount, [u.x, u.y, u.z + 1], [0, 0, 0]);
      }
    }
  }

  /** Group `g` follows field `f` (0..NFIELDS-1), or stands still (f < 0). */
  follow(g: number, f: number): void {
    if (f >= NFIELDS) throw new Error(`agents: field ${f} out of 0..${NFIELDS - 1}`);
    this.groupField[g] = f < 0 ? 0xffffffff : f;
    this.fieldsUsed = Math.max(this.fieldsUsed, f + 1);
  }

  /** Group `g`'s units are drawn at work (round 88): bending to a tool in their hands, while they stand. */
  workPose(g: number, on: boolean): void {
    if (g < 0 || g >= MAX_GROUPS) throw new Error(`agents.workPose: group ${g} out of 0..${MAX_GROUPS - 1}`);
    this.groupPose[g] = on ? 1 : 0;
  }

  /** Field `f`'s seeds (its distance is 0 there): a goal, a stockpile, a threat. */
  seed(f: number, seeds: readonly Seed[]): void {
    if (f < 0 || f >= NFIELDS) throw new Error(`agents: field ${f} out of 0..${NFIELDS - 1}`);
    const rest = this.seeds.filter((s) => s.field !== f);
    if (rest.length + seeds.length > MAX_SEEDS) throw new Error(`agents: more than ${MAX_SEEDS} seeds`);
    // (round 104, simscale: seeds that moved disturb the field — relaxed until it settles again)
    const was = this.seeds.filter((s) => s.field === f);
    const same = was.length === seeds.length && was.every((s, i) => Math.abs(s.x - seeds[i].x) < 1e-3 && Math.abs(s.y - seeds[i].y) < 1e-3 && (s.z ?? 1e4) === (seeds[i].z ?? 1e4));
    if (!same && this.scope) for (const s of [...was, ...seeds]) this.scope.mark(s.x, s.y / ROW_H);
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

  /**
   * Throw a unit (held or not) with a velocity: it tumbles, bounces, knocks
   * others over, gets up. A velocity, so whatever its mass (the thrower
   * decides it; a lob must land where it's aimed). For a force, a knock that
   * heavy kinds shrug off, use a `hit` with `push` and `lift`.
   */
  /**
   * Move unit `id` to group `g` (from the next tick): it follows that
   * group's field and is drawn in its colour (round 63: a worker off to its
   * job, then to the pile). Up to 64 a tick; the rest wait.
   */
  regroup(id: number, g: number): void {
    const slot = this.slotOf(id);
    if (slot < 0) return;
    if (g < 0 || g >= MAX_GROUPS) throw new Error(`agents.regroup: group ${g} out of 0..${MAX_GROUPS - 1}`);
    this.regroups.push(slot | (g << 16));
  }

  launch(id: number, vel: readonly [number, number, number], opts: LaunchOpts = {}): void {
    const slot = this.slotOf(id);
    if (slot < 0) return;
    this.holds.delete(slot);
    // (the stun rides in the slot's word, in hundredths of a second: units.wgsl)
    const stun = Math.round(Math.min(Math.max(opts.stun ?? 0, 0), MAX_STUN) * 100);
    this.launches.push([vel[0], vel[1], vel[2], slot + stun * MAX_UNITS]);
  }

  /**
   * Lob a unit from (x, y, z) so it lands at `to`, in `time` seconds
   * (default: by distance, 0.5-1.5 s): the velocity it's launched with.
   */
  lob(id: number, from: readonly [number, number, number], to: readonly [number, number, number], time?: number, opts: LaunchOpts = {}): [number, number, number] {
    const d = Math.hypot(to[0] - from[0], to[1] - from[1]);
    const t = time ?? Math.min(1.5, Math.max(0.5, d / 14));
    const v: [number, number, number] = [(to[0] - from[0]) / t, (to[1] - from[1]) / t, (to[2] - from[2] + 0.5 * AGENT_GRAVITY * t * t) / t];
    this.launch(id, v, opts);
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
    if (this.scope) this.scope.markAll = true;
  }

  /** A CPU copy of field `f` to sample (fieldreader.ts; refresh it every few hundred ms). */
  reader(f: number): FieldReader {
    if (f < 0 || f >= NFIELDS) throw new Error(`agents: field ${f} out of 0..${NFIELDS - 1}`);
    return new FieldReader(this, f, this.world.w, this.world.h, this.world.ring);
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
  // ---- carrying (round 63, docs/AGENTS.md "Carrying") -------------------------

  /** The world's terrain, for what units pick up, put down and throw (the world API hands it over). */
  useTerrain(t: Terrain): void {
    this.terrain = t;
  }

  private needTerrain(what: string): Terrain {
    if (!this.terrain) throw new Error(`agents.${what}: needs the world's terrain (createSim / attachSim hands it over)`);
    return this.terrain;
  }

  /** Where unit `id` stood at the last sync, or a clear error. */
  private seenAt(id: number, what: string): AgentState {
    const slot = this.slotOf(id);
    const u = slot < 0 ? undefined : this.seen.get(slot);
    if (!u) throw new Error(`agents.${what}: unit ${id} is gone, or hasn't been seen by a sync() yet`);
    return u;
  }

  /** The edge of the cube an amount makes (cells; drawn at most 3.9). */
  private static edge(amount: number): number {
    return Math.min(Math.max(Math.cbrt(amount), 0.2), 3.9);
  }

  private writeCarry(slot: number, it: { mat: number; amount: number } | undefined): void {
    const v = it ? [it.mat, Agents.edge(it.amount), 0, 0] : [0, 0, 0, 0];
    this.device.queue.writeBuffer(this.carryBuf, slot * 16, new Float32Array(v));
  }

  /**
   * Unit `id` carries `amount` cells³ of `material` (held over its head).
   * More of what it already carries adds to it; something else is an error.
   */
  carry(id: number, material: MaterialName, amount: number): void {
    const slot = this.slotOf(id);
    if (slot < 0) throw new Error(`agents.carry: unit ${id} is gone`);
    const m = materialId(material);
    const st = materialState(m);
    if (st !== 'solid' && st !== 'loose') throw new Error(`agents.carry: "${material}" isn't ground (a solid or loose material)`);
    if (!(amount > 0)) throw new Error(`agents.carry: amount must be > 0 (got ${amount})`);
    const had = this.carried.get(slot);
    if (had && had.mat !== m) throw new Error(`agents.carry: unit ${id} already carries ${materialName(had.mat)}`);
    const it = { mat: m, amount: (had?.amount ?? 0) + amount };
    this.carried.set(slot, it);
    this.writeCarry(slot, it);
  }

  /** What unit `id` carries (null: nothing). */
  carrying(id: number): Item | null {
    const it = this.carried.get(this.slotOf(id));
    return it ? { material: materialName(it.mat), amount: it.amount } : null;
  }

  /** Take unit `id`'s load off it (it goes nowhere: the game has it now). */
  unload(id: number): Item | null {
    const slot = this.slotOf(id);
    const it = this.carried.get(slot);
    if (!it) return null;
    this.carried.delete(slot);
    this.writeCarry(slot, undefined);
    return { material: materialName(it.mat), amount: it.amount };
  }

  /**
   * Unit `id` picks up `amount` cells³ off the top of the ground where it
   * stood at the last sync (terrain.take: exact, one material). Resolves
   * with what it took (amount 0: nothing it could carry; what it can't hold
   * goes back where it came from).
   */
  async pickUp(id: number, amount = 0.5): Promise<Item> {
    const t = this.needTerrain('pickUp');
    const u = this.seenAt(id, 'pickUp');
    const got = await t.take(u.x, u.y, amount);
    if (got.amount <= 0) return got;
    const slot = this.slotOf(id);
    const had = slot < 0 ? undefined : this.carried.get(slot);
    const st = materialState(materialId(got.material));
    if (slot < 0 || (had && had.mat !== materialId(got.material)) || (st !== 'solid' && st !== 'loose')) {
      await t.put(u.x, u.y, got.material, got.amount);
      return { material: got.material, amount: 0 };
    }
    this.carry(id, got.material, got.amount);
    return got;
  }

  /**
   * Unit `id` sets its load down where it stood at the last sync
   * (terrain.put: exact). Resolves with the amount put; what didn't fit (a
   * full column, BACKLOG Q21) stays carried.
   */
  async putDown(id: number): Promise<number> {
    const t = this.needTerrain('putDown');
    const u = this.seenAt(id, 'putDown');
    const slot = this.slotOf(id);
    const it = this.carried.get(slot);
    if (!it) return 0;
    this.carried.delete(slot);
    this.writeCarry(slot, undefined);
    const put = await t.put(u.x, u.y, materialName(it.mat), it.amount);
    const rest = it.amount - put;
    if (rest > 1e-6) {
      if (this.slotOf(id) === slot) this.carry(id, materialName(it.mat), rest);
      else this.toss(materialName(it.mat), rest, [u.x, u.y, u.z + 1], [0, 0, 0]);
    }
    return put;
  }

  /**
   * Unit `id` throws its load at `to` (world xyz), landing in `time` s
   * (default by distance). It flies, tumbling, and comes down as ground
   * where it lands (a 'landed' event), hitting units there with `hit`.
   * Returns the item's id (null: it carried nothing).
   */
  throwItem(id: number, to: [number, number, number], opts: { time?: number; hit?: ThrowHit } = {}): number | null {
    const u = this.seenAt(id, 'throwItem');
    const it = this.unload(id);
    if (!it) return null;
    const h = this.kinds.find((k) => k?.name === u.kind)?.height ?? 1.2;
    const from: [number, number, number] = [u.x, u.y, u.z + h + Agents.edge(it.amount) * 0.5];
    const d = Math.hypot(to[0] - from[0], to[1] - from[1]);
    const time = opts.time ?? Math.max(0.35, d / 12);
    const vel: [number, number, number] = [(to[0] - from[0]) / time, (to[1] - from[1]) / time, (to[2] - from[2]) / time + 0.5 * GRAVITY * time];
    return this.toss(it.material, it.amount, from, vel, opts.hit);
  }

  /** An item flying free: `amount` of `material` from `from` at `vel` (a boulder a giant hurls, debris). It lands as ground. */
  toss(material: MaterialName, amount: number, from: [number, number, number], vel: [number, number, number], hit?: ThrowHit): number {
    const m = materialId(material);
    const st = materialState(m);
    if (st !== 'solid' && st !== 'loose') throw new Error(`agents.toss: "${material}" isn't ground (a solid or loose material)`);
    if (!(amount > 0)) throw new Error(`agents.toss: amount must be > 0 (got ${amount})`);
    if (this.flights.length >= MAX_FLY) throw new Error(`agents.toss: ${MAX_FLY} items in flight at most`);
    const id = this.nextItem++;
    this.flights.push({ id, mat: m, amount, pos: [from[0], from[1], from[2]], vel: [vel[0], vel[1], vel[2]], spin: 0, hit });
    if (!this.flyAt) this.flyAt = performance.now();
    return id;
  }

  /** Items in flight now. */
  get inFlight(): { id: number; material: MaterialName; amount: number; x: number; y: number; z: number }[] {
    return this.flights.map((f) => ({ id: f.id, material: materialName(f.mat), amount: f.amount, x: f.pos[0], y: f.pos[1], z: f.pos[2] }));
  }

  /** Moves what's in flight on (each sync), lands what came down, and draws them. */
  private fly(): void {
    if (!this.flights.length && !this.flyDrawn) return;
    const now = performance.now();
    const dt = Math.min((now - (this.flyAt || now)) / 1000, 0.1);
    this.flyAt = now;
    const keep: Flight[] = [];
    for (const f of this.flights) {
      f.vel[2] -= GRAVITY * dt;
      for (let a = 0; a < 3; a++) f.pos[a] += f.vel[a] * dt;
      f.spin += 7 * dt;
      const [x, y, z] = f.pos;
      const t = this.needTerrain('toss');
      const ground = t.floorAt(x, y, z) ?? t.heightAt(x, y);
      // (off the map: gone)
      if (ground === null) continue;
      if (z > ground) {
        keep.push(f);
        continue;
      }
      const material = materialName(f.mat);
      void t.put(x, y, material, f.amount).then((amount) => this.landed.push({ type: 'landed', item: f.id, material, amount, x, y, z: ground }));
      if (f.hit) {
        const sp = Math.hypot(f.vel[0], f.vel[1]);
        this.hit({
          x,
          y,
          z: ground,
          radius: f.hit.radius ?? Math.max(0.8, Agents.edge(f.amount)),
          damage: f.hit.damage ?? 0,
          push: f.hit.push ?? 0,
          lift: f.hit.lift,
          stun: f.hit.stun,
          groups: f.hit.groups,
          spare: f.hit.spare,
          dir: sp > 1e-3 ? [f.vel[0] / sp, f.vel[1] / sp] : undefined,
        });
      }
    }
    this.flights = keep;
    if (!keep.length) this.flyAt = 0;
    const buf = new Float32Array(MAX_FLY * 8);
    keep.forEach((f, i) => {
      const sp = Math.hypot(f.vel[0], f.vel[1]);
      buf.set([f.pos[0], f.pos[1], f.pos[2], f.mat, Agents.edge(f.amount), f.spin, sp > 1e-3 ? -f.vel[1] / sp : 1, sp > 1e-3 ? f.vel[0] / sp : 0], i * 8);
    });
    this.device.queue.writeBuffer(this.flyBuf, 0, buf);
    this.flyDrawn = keep.length > 0;
  }

  /** What units carried when they went down: it falls off them (tumbling: flung with them; dead: where they fell). */
  private shed(units: AgentState[], events: AgentEvent[]): void {
    for (const e of events) {
      if (e.type !== 'death') continue;
      const slot = e.id % MAX_UNITS;
      const it = this.carried.get(slot);
      if (!it) continue;
      this.carried.delete(slot);
      this.writeCarry(slot, undefined);
      this.toss(materialName(it.mat), it.amount, [e.x, e.y, e.z + 1], [0, 0, 0]);
    }
    for (const u of units) {
      if (u.state !== 'tumble') continue;
      const slot = u.id % MAX_UNITS;
      const it = this.carried.get(slot);
      if (!it) continue;
      this.carried.delete(slot);
      this.writeCarry(slot, undefined);
      this.toss(materialName(it.mat), it.amount, [u.x, u.y, u.z + 1.2], [u.vx, u.vy, Math.max(u.vz, 2)]);
    }
  }

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
    // (carrying: where each stands, loads shed, items in flight moved on)
    this.seen.clear();
    for (const u of units) this.seen.set(u.id % MAX_UNITS, u);
    this.shed(units, events);
    this.fly();
    events.push(...this.landed);
    this.landed = [];
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
      u[P_GMAT + g] = GROUP_MATS[g % GROUP_MATS.length] | (this.groupPose[g] << 8);
    }
    u.set(this.fieldPlace, P_FPLACE);
    let seeded = 0;
    for (const s of this.seeds) seeded |= 1 << s.field;
    u.set([hits.length, this.targets.length, EVENT_CAP, seeded], P_N2);
    // (round 88: a field left without seeds is set unreachable once, then skipped — not rewritten every sweep)
    const clear = this.wasSeeded & ~seeded;
    this.wasSeeded = seeded;
    this.clearNow = clear;
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
      // (the groups it spares ride with the fire flag: bit 0 fire, bits 1-16 a group each)
      let spare = 0;
      for (const g of h.spare ?? []) spare |= 1 << g;
      if (h.groups) {
        let only = 0;
        for (const g of h.groups) only |= 1 << g;
        spare |= ~only & 0xffff;
      }
      f.set([h.x, h.y, h.z ?? -1e9, h.radius, dir[0], dir[1], cone, h.damage ?? 0, h.push ?? 0, h.outward ? 1 : 0, (h.fire ? 1 : 0) + spare * 2, h.id, axis[0], axis[1], h.lift ?? 0, Math.min(Math.max(h.stun ?? 0, 0), MAX_STUN)], o);
    });
    this.targets.forEach((t, i) => {
      f.set([t.x, t.y, t.z, t.radius ?? 0.5], P_TARGETS + i * 4);
      f[P_TARGET_H + i] = t.height ?? 1.5;
    });
    const holds = [...this.holds].slice(0, MAX_HOLDS);
    const launches = this.launches.splice(0, MAX_LAUNCHES);
    const regroups = this.regroups.splice(0, MAX_REGROUPS);
    u.set([holds.length, launches.length, regroups.length, clear], P_N3);
    u.set(regroups, P_REGROUPS);
    holds.forEach(([slot, p], i) => f.set([p[0], p[1], p[2], slot], P_HOLDS + i * 4));
    launches.forEach((l, i) => f.set(l, P_LAUNCHES + i * 4));
    this.device.queue.writeBuffer(this.params, 0, b);
  }

  encode(enc: GPUCommandEncoder): void {
    // (the tick number rides in the params: the occupancy halves swap on it)
    this.writeParams(this.hits.splice(0, MAX_HITS));
    const [gx, gy] = this.world.groups;
    // (round 88: no units, nothing in flight and no field seeded — nothing reads the surfaces or the fields, so
    // neither is made; the first tick that needs them peels at once)
    if (this.count - this.free.length === 0 && this.flights.length === 0 && this.seeds.length === 0) {
      this.navStale = true;
      this.ticks++;
      return;
    }
    if (this.scope && this.sk) {
      this.encodeScoped(enc, this.scope, this.sk);
      this.ticks++;
      return;
    }
    const pass = enc.beginComputePass({ label: 'agents', timestampWrites: this.prof.timestamps('agents') });
    if (this.ticks % PEEL_EVERY === 0 || this.navStale) {
      this.navStale = false;
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
      for (let i = 0; i < this.sweeps; i++) pass.dispatchWorkgroups(gx, gy);
      this.prof.dispatches += this.sweeps;
    }
    if (this.count > 0 || this.flights.length > 0) {
      pass.setBindGroup(0, this.unitGroup);
      pass.setPipeline(this.k.occClear.pipeline);
      pass.dispatchWorkgroups(Math.ceil((this.world.w * this.world.h) / 64));
      this.encodeUnits(pass);
    }
    pass.end();
    this.ticks++;
  }

  /** the units' step and their draws (every tick there are any) */
  private encodeUnits(pass: GPUComputePassEncoder): void {
    pass.setBindGroup(0, this.unitGroup);
    pass.setPipeline(this.k.unitStep.pipeline);
    pass.dispatchWorkgroups(Math.ceil(this.count / 64));
    // the draw's instance count restarts each tick (written before this tick's submit)
    this.device.queue.writeBuffer(this.indirect, 0, new Uint32Array([36, 0, 0, 0]));
    pass.setBindGroup(0, this.drawGroup);
    pass.setPipeline(this.k.unitDraw.pipeline);
    pass.dispatchWorkgroups(Math.ceil(Math.max(this.count, 1) / 64));
    pass.setPipeline(this.k.itemDraw.pipeline);
    pass.dispatchWorkgroups(MAX_FLY / 64);
    this.prof.dispatches += 3;
  }

  /**
   * (round 104, simscale — agents/scope.ts) The tick over the scope only: the chunks new to it started over, the
   * surfaces peeled there, each sweep relaxing only the front (the chunks where something changed in the last one,
   * and those next to them), the occupancy cleared there; the units as ever. Every READ_EVERY ticks the units' box is
   * read back.
   */
  private encodeScoped(enc: GPUCommandEncoder, sc: AgentScope, sk: NonNullable<Agents['sk']>): void {
    const t = this.world.tiles!;
    const pts: [number, number][] = [];
    for (const s of this.seeds) pts.push([s.x, s.y / ROW_H]);
    for (const g of this.targets) pts.push([g.x, g.y / ROW_H]);
    for (const p of this.holds.values()) pts.push([p[0], p[1] / ROW_H]);
    for (const f of this.flights) pts.push([f.pos[0], f.pos[1] / ROW_H]);
    const { list, enter } = sc.update(pts, this.ticks);
    this.lastScopeChunks = list.length;
    if (list.length) t.setList(SCOPE_LIST, list);
    if (enter.length) {
      t.setList(ENTER_LIST, enter);
      this.navStale = true;
    }
    // (a field cleared — its seeds gone — or confined: every chunk of the scope relaxed again)
    if (this.clearNow) sc.markAll = true;
    const marks = sc.markAll ? list : [...sc.marks].filter((c) => sc.box && list.includes(c));
    sc.marks.clear();
    sc.markAll = false;
    if (marks.length) t.setList(MARK_LIST, marks);
    const b = sc.box ?? [0, 0, 0, 0];
    this.device.queue.writeBuffer(this.abBuf, 0, new Uint32Array([b[0], b[1], b[2], b[3], 0, 0, 0, 0]));
    const read = !this.reading && this.ticks - this.lastRead >= READ_EVERY;
    if (read) this.device.queue.writeBuffer(this.uboxBuf, 0, new Uint32Array([0xffffffff, 0xffffffff, 0, 0]));
    const pass = enc.beginComputePass({ label: 'agents', timestampWrites: this.prof.timestamps('agents') });
    const n = list.length ? t.groups(SCOPE_LIST) : 0;
    let p = this.par;
    if (enter.length) {
      pass.setBindGroup(0, sk.enterG[p]);
      pass.setPipeline(sk.enter.pipeline);
      pass.dispatchWorkgroups(t.groups(ENTER_LIST));
      this.prof.dispatches++;
    }
    if (marks.length) {
      pass.setBindGroup(0, sk.markG[p]);
      pass.setPipeline(sk.mark.pipeline);
      pass.dispatchWorkgroups(t.groups(MARK_LIST));
      this.prof.dispatches++;
    }
    if (n) {
      if (this.ticks % PEEL_EVERY === 0 || this.navStale) {
        this.navStale = false;
        pass.setBindGroup(0, sk.peelG[p]);
        pass.setPipeline(sk.surfaces.pipeline);
        pass.dispatchWorkgroups(n);
        pass.setBindGroup(0, sk.linksG[p]);
        pass.setPipeline(sk.links.pipeline);
        pass.dispatchWorkgroups(n);
        this.prof.dispatches += 2;
      }
      if (this.fieldsUsed > 0) {
        const chunks = Math.ceil(list.length / 64);
        for (let i = 0; i < this.sweeps; i++) {
          pass.setBindGroup(0, sk.resetG);
          pass.setPipeline(sk.reset.pipeline);
          pass.dispatchWorkgroups(1);
          pass.setBindGroup(0, sk.buildG[p]);
          pass.setPipeline(sk.build.pipeline);
          pass.dispatchWorkgroups(chunks);
          pass.setBindGroup(0, sk.clearG[p]);
          pass.setPipeline(sk.clear.pipeline);
          pass.dispatchWorkgroups(chunks);
          pass.setBindGroup(0, sk.relaxG[p]);
          pass.setPipeline(sk.relax.pipeline);
          pass.dispatchWorkgroupsIndirect(this.frontArgs, 0);
          this.prof.dispatches += 4;
          // (what this sweep marked is the next one's to relax round)
          p ^= 1;
        }
      }
    }
    this.par = p;
    if (this.count > 0 || this.flights.length > 0) {
      if (n) {
        pass.setBindGroup(0, sk.occG);
        pass.setPipeline(sk.occ.pipeline);
        pass.dispatchWorkgroups(n);
        this.prof.dispatches++;
      }
      this.encodeUnits(pass);
      if (read && this.count > 0) {
        pass.setBindGroup(0, sk.boxG);
        pass.setPipeline(sk.box.pipeline);
        pass.dispatchWorkgroups(Math.ceil(this.count / 64));
        this.prof.dispatches++;
      }
    }
    pass.end();
    if (read) {
      enc.copyBufferToBuffer(this.uboxBuf, 0, this.readBuf, 0, 16);
      this.reading = true;
      this.readIssued = { serial: sc.serial };
      sc.serial++;
      this.lastRead = this.ticks;
    }
  }

  /** (simscale) after the tick's submit: the read issued in it mapped */
  afterSubmit(): void {
    const r = this.readIssued;
    if (!r || !this.scope) return;
    this.readIssued = null;
    const sc = this.scope;
    this.readBuf.mapAsync(GPUMapMode.READ).then(() => {
      const u = new Uint32Array(this.readBuf.getMappedRange().slice(0));
      this.readBuf.unmap();
      this.reading = false;
      const box: [number, number, number, number] | null = u[0] <= u[2] && u[1] <= u[3] ? [u[0], u[1], u[2], u[3]] : null;
      sc.read(r.serial, box);
    }, (e) => {
      this.reading = false;
      ignoreTeardown(e);
    });
  }
}
