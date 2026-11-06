// (round 128p, DA-B22 (c)(3); DESIGN §11, §19) Combat targeting on the GPU (shaders/notice.wgsl): an agents stage run
// once a frame, after the units' last step. Each fighter's target lives in its unit record (word f.y: a target code);
// a new one is told as a `noticed` event. The game's rules over who may take on whom are data here — a combat word per
// unit, a side map per column, a few flags — uploaded when they change, so the CPU never reads every unit to choose.
//
// What it owns: the combat words, the side map, the buckets (a list of units per BUCKET² columns, made each run), its
// params. What it reads: the agents' units and events buffers (written through: the target word, `noticed` events).

import { makeBindGroup, makeCompute, type BindSpec, type ComputeKernel } from '../gpu/pipeline';
import type { WorldGpu } from '../sim/world-gpu';
import commonWgsl from '../shaders/common.wgsl?raw';
import noticeWgsl from '../shaders/notice.wgsl?raw';

/** combat flags (notice.wgsl CW_*); bits 0-7 the faction (NO_FACTION none) */
export const CW = {
  hostile: 0x100,
  guard: 0x200,
  noFight: 0x400,
  posted: 0x800,
  raider: 0x1000,
  bound: 0x2000,
  home: 0x4000,
} as const;
export const NO_FACTION = 255;
/** a target code that names the i-th actor of the frame (notice.wgsl ACTOR) */
export const ACTOR = 0x80000000;
const BUCKET = 16;
const MAX_ACTORS = 8;
const MAX_SETS = 64;
const NR_RULES = 1;
const NR_OPEN = 2;
/** NoticeParams (notice.wgsl): n, dims, f, 8 actors, 2 faction vec4s, 32 set vec4s */
const PARAMS_WORDS = 4 + 4 + 4 + MAX_ACTORS * 4 + 8 + (MAX_SETS / 2) * 4;

/** One unit's part in the fighting (Agents.combat) */
export interface CombatSpec {
  /** its faction's number (0..254), or NO_FACTION */
  faction: number;
  hostile: boolean;
  /** a guard looks for hostiles in sight (a hostile always looks) */
  guard?: boolean;
  /** neither fights nor is fought while the rules are on (in at home, a cart) */
  noFight?: boolean;
  /** holds its post: takes no one on while the rules are on (an archer on the wall) */
  posted?: boolean;
  /** the rules over sides and height apply where one is involved */
  raider?: boolean;
  /** out of the fighting here: raised by another (bound to it), or no one's fighter at all — what a slot is until the
   *  game says otherwise (Agents.spawn: `out`) */
  bound?: boolean;
  /** how far it looks (cells; 0: it never looks for a target, though it may be given one) */
  sight: number;
  /** a guard's post: a target farther than the leash from it is let go */
  home?: readonly [number, number] | null;
}

/** The game's rules (Agents.fightRules): off, a hostile and a peaceful one of another faction fight wherever they are */
export interface FightRules {
  /** the rules over sides, height, posts and the no-fight on */
  on: boolean;
  /** the wall is open (broken): sides no longer part anyone */
  open: boolean;
  /** the most two may differ in height and still fight */
  heightLimit: number;
  /** a hunter lets its target go past max(sight × 2, leash); a guard past leash from its post */
  leash: number;
}

export class UnitNotice {
  private combat: GPUBuffer;
  private sides: GPUBuffer;
  private head: GPUBuffer;
  private next: GPUBuffer;
  private hunted: GPUBuffer;
  private params: GPUBuffer;
  private k: Record<'bucketClear' | 'bucketFill' | 'huntClear' | 'notice' | 'huntWrite', ComputeKernel>;
  private group: GPUBindGroup;
  private bw: number;
  private bh: number;
  private rules: FightRules = { on: false, open: false, heightLimit: 1.6, leash: 28 };
  private actorList: { at: readonly [number, number, number] | null; faction: number }[] = [];
  private sets: [number, number][] = [];
  private data = new ArrayBuffer(PARAMS_WORDS * 4);
  /** a side map is in place (none: every column the same side) */
  hasSides = false;

  constructor(
    private device: GPUDevice,
    world: WorldGpu,
    units: GPUBuffer,
    events: GPUBuffer,
    maxUnits: number,
    private eventCap: number,
  ) {
    const S = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST;
    this.bw = Math.ceil(world.w / BUCKET);
    this.bh = Math.ceil(world.h / BUCKET);
    this.combat = world.buf('agentCombat', maxUnits * 16, S);
    this.sides = world.buf('agentSides', world.w * world.h * 4, S);
    this.head = world.buf('agentBuckets', this.bw * this.bh * 4, S);
    this.next = world.buf('agentBucketNext', maxUnits * 4, S);
    this.hunted = world.buf('agentHunted', maxUnits * 4, S);
    this.params = world.buf('agentNotice', PARAMS_WORDS * 4, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    const spec: BindSpec = { 0: 'uniform', 7: 'rw', 13: 'rw', 41: 'read', 42: 'read', 43: 'rw', 44: 'rw', 45: 'uniform', 46: 'rw' };
    const mk = (e: string) => makeCompute(device, `agents-${e}`, [commonWgsl, noticeWgsl], spec, e);
    this.k = { bucketClear: mk('bucketClear'), bucketFill: mk('bucketFill'), huntClear: mk('huntClear'), notice: mk('notice'), huntWrite: mk('huntWrite') };
    this.group = makeBindGroup(device, 'agents-notice', this.k.notice.layout, { 0: world.globals, 7: units, 13: events, 41: this.combat, 42: this.sides, 43: this.head, 44: this.next, 45: this.params, 46: this.hunted });
  }

  /** a unit slot's part in the fighting (written at once: a spawn, a change of side, post or job) */
  set(slot: number, c: CombatSpec): void {
    let w = (c.faction & 0xff) | (c.hostile ? CW.hostile : 0) | (c.guard ? CW.guard : 0) | (c.noFight ? CW.noFight : 0) | (c.posted ? CW.posted : 0) | (c.raider ? CW.raider : 0) | (c.bound ? CW.bound : 0);
    if (c.home) w |= CW.home;
    const b = new ArrayBuffer(16);
    const u = new Uint32Array(b);
    const f = new Float32Array(b);
    u[0] = w;
    f[1] = c.sight;
    f[2] = c.home?.[0] ?? 0;
    f[3] = c.home?.[1] ?? 0;
    this.device.queue.writeBuffer(this.combat, slot * 16, b);
  }

  /** a slot out of the fighting: as a unit is spawned, until the game gives it a part (`set`) */
  out(slot: number): void {
    this.set(slot, { faction: NO_FACTION, hostile: false, bound: true, sight: 0 });
  }

  setRules(r: FightRules): void {
    this.rules = { ...r };
  }

  /** the side of each window column (y * W + x; 0 the same for all, else a side's number), or null: no sides */
  setSides(map: Uint32Array | null): void {
    this.hasSides = map !== null;
    if (map) this.device.queue.writeBuffer(this.sides, 0, map);
  }

  /** the game's actors this frame (≤ 8: the hero …): where (null: gone), and their faction (NO_FACTION none) */
  setActors(list: { at: readonly [number, number, number] | null; faction: number }[]): void {
    if (list.length > MAX_ACTORS) throw new Error(`agents.actors: ${list.length} (${MAX_ACTORS} at most)`);
    this.actorList = list;
  }

  /** a unit slot given a target by the game (an order; a unit struck turning on who struck it): code 0 lets it go */
  aim(slot: number, code: number): void {
    const i = this.sets.findIndex((s) => s[0] === slot);
    if (i >= 0) this.sets[i][1] = code;
    else this.sets.push([slot, code]);
  }

  /** the stage: once a frame, after the units' last step (count: the unit slots in use) */
  encode(pass: GPUComputePassEncoder, count: number): void {
    if (!count) return;
    const u = new Uint32Array(this.data);
    const f = new Float32Array(this.data);
    u.fill(0);
    const sets = this.sets.splice(0, MAX_SETS);
    const flags = (this.rules.on ? NR_RULES : 0) | (this.rules.open || !this.hasSides ? NR_OPEN : 0);
    u.set([count, this.actorList.length, sets.length, flags], 0);
    u.set([this.bw, this.bh, this.eventCap, 0], 4);
    f.set([this.rules.heightLimit, this.rules.leash, 0, 0], 8);
    this.actorList.forEach((a, i) => {
      f.set(a.at ? [a.at[0], a.at[1], a.at[2], 1] : [0, 0, 0, 0], 12 + i * 4);
      u[12 + MAX_ACTORS * 4 + i] = a.faction;
    });
    sets.forEach(([slot, code], i) => u.set([slot, code], 12 + MAX_ACTORS * 4 + 8 + i * 2));
    this.device.queue.writeBuffer(this.params, 0, this.data);
    pass.setBindGroup(0, this.group);
    pass.setPipeline(this.k.bucketClear.pipeline);
    pass.dispatchWorkgroups(Math.ceil((this.bw * this.bh) / 64));
    pass.setPipeline(this.k.bucketFill.pipeline);
    pass.dispatchWorkgroups(Math.ceil(count / 64));
    pass.setPipeline(this.k.huntClear.pipeline);
    pass.dispatchWorkgroups(Math.ceil(count / 64));
    pass.setPipeline(this.k.notice.pipeline);
    pass.dispatchWorkgroups(Math.ceil(count / 64));
    pass.setPipeline(this.k.huntWrite.pipeline);
    pass.dispatchWorkgroups(Math.ceil(count / 64));
  }
}
