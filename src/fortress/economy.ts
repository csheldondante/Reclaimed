// The fortress's economy (fortress slice 1, milestone 3: "the economy feeds the building"). Pure: no GPU, no units, so
// the numbers are tested (economy.test.ts). FortressLife (life.ts) runs it: who works where (the JobBoard), what a worker
// brings a trip, how fast grain grows and is eaten, the beds and the warehouses' room, what Erase gives back.
//
// Goods come in only by being carried: a miner digs the quarry's pit and carries stone (a share of it ore) to the
// warehouse; a woodcutter fells a tree in the lumber camp's reach and carries its logs; grain grows on the farm cells and
// farmers carry it in. People eat grain; with none, nobody new comes (nothing else: hunger kills no one in slice 1).
import type { Good, Goods, Structure, StructureDef, StructureType } from '../api/contracts/fortress';
import { DEFS, ECON, JOB_ORDER } from './defs';
import type { FortressPlan } from './plan';

export type JobKind = (typeof JOB_ORDER)[number];

/** A structure's jobs (or the builders'): `count` people at most. */
export interface JobSlot {
  /** 'build', or the structure's id as `s<id>` */
  key: string;
  kind: JobKind;
  /** the structure (null: the builders) */
  structure: number | null;
  count: number;
}

/** goods that take room in the stores (soldiers and power don't) */
export const STORED: readonly Good[] = ['log', 'stone', 'ore', 'grain', 'weapons'];

type Built = (cell: number, level: number) => boolean;

/** a structure's built blocks */
export function builtBlocks(plan: FortressPlan, s: Structure, built: Built): number {
  let n = 0;
  for (const c of s.cells.keys()) for (const L of plan.levels.each(c)) if (built(c, L)) n++;
  return n;
}

/**
 * The jobs open now, in priority order (JOB_ORDER, then the structures as they were made): each built block of a farm,
 * quarry or lumber camp gives its type's `jobs`; the builders' slots while there's something to build.
 */
export function jobSlots(plan: FortressPlan, built: Built, building: boolean, defs: Record<StructureType, StructureDef> = DEFS, econ = ECON): JobSlot[] {
  const out: JobSlot[] = [];
  for (const kind of JOB_ORDER) {
    if (kind === 'build') {
      if (building && econ.builders > 0) out.push({ key: 'build', kind, structure: null, count: econ.builders });
      continue;
    }
    for (const s of plan.structures().sort((a, b) => a.id - b.id)) {
      if (s.type !== kind) continue;
      const n = (defs[s.type].perBlock.jobs ?? 0) * builtBlocks(plan, s, built);
      if (n > 0) out.push({ key: `s${s.id}`, kind, structure: s.id, count: n });
    }
  }
  return out;
}

/**
 * Who works where. Jobs go in priority order to the people there are: the first slots are filled, the last go empty
 * when people are short. A person keeps their job while its slot still wants them (nobody is moved for nothing); the
 * rest are given out in priority order. Pure (people are ids; no units).
 */
export class JobBoard {
  private job = new Map<number, string>();

  /** The people's jobs for these slots (priority order). Returns the people whose job changed. */
  assign(people: readonly number[], slots: readonly JobSlot[]): number[] {
    const before = this.job;
    // (how many each slot gets: in priority order, while people last)
    let left = people.length;
    const want = new Map<string, number>();
    for (const s of slots) {
      const n = Math.max(0, Math.min(s.count, left));
      want.set(s.key, (want.get(s.key) ?? 0) + n);
      left -= n;
    }
    const next = new Map<number, string>();
    const have = new Map<string, number>();
    for (const p of people) {
      const k = before.get(p);
      if (k === undefined) continue;
      const h = have.get(k) ?? 0;
      if (h < (want.get(k) ?? 0)) {
        next.set(p, k);
        have.set(k, h + 1);
      }
    }
    const free = people.filter((p) => !next.has(p));
    let i = 0;
    for (const s of slots) {
      let h = have.get(s.key) ?? 0;
      const w = want.get(s.key) ?? 0;
      while (h < w && i < free.length) {
        next.set(free[i++], s.key);
        h++;
      }
      have.set(s.key, h);
    }
    this.job = next;
    return people.filter((p) => before.get(p) !== next.get(p));
  }

  /** a person's job (null: no work) */
  jobOf(p: number): string | null {
    return this.job.get(p) ?? null;
  }

  /** how many work in a slot */
  count(key: string): number {
    let n = 0;
    for (const k of this.job.values()) if (k === key) n++;
    return n;
  }
}

/** What one worker of a type makes a day: its `makes` a block over its `jobs` a block. */
export function perWorker(def: StructureDef): Goods {
  const jobs = def.perBlock.jobs ?? 0;
  const out: Goods = {};
  if (!jobs) return out;
  for (const [g, v] of Object.entries(def.perBlock.makes ?? {}) as [Good, number][]) out[g] = v / jobs;
  return out;
}

/** Seconds a worker of a type works for one load (econ.haul of its good): the quarry's miners, the woodcutters. */
export function workSeconds(def: StructureDef, econ = ECON): number {
  const rate = Object.values(perWorker(def))[0] ?? 0;
  if (!(rate > 0)) throw new Error(`fortress economy: ${def.type} makes nothing a worker`);
  return (econ.haul / rate) * econ.daySec;
}

/** A miner's load: stone, a share of it ore (the user's answer 4). */
export function quarryLoad(amount: number, econ = ECON): Goods {
  return { stone: amount * (1 - econ.oreShare), ore: amount * econ.oreShare };
}

/** Grain grown in dt seconds on a farm's built blocks (its type's `makes` a block a day). */
export function grown(blocks: number, dt: number, def: StructureDef = DEFS.farm, econ = ECON): number {
  return ((def.perBlock.makes?.grain ?? 0) * blocks * dt) / econ.daySec;
}

/** Grain eaten in dt seconds by this many people. */
export function eaten(people: number, dt: number, econ = ECON): number {
  return (people * econ.eat * dt) / econ.daySec;
}

/** Beds: the town's own houses' and the house blocks built (not the barracks': those are the soldiers'). */
export function bedsOf(plan: FortressPlan, built: Built, defs: Record<StructureType, StructureDef> = DEFS, econ = ECON): number {
  let n = econ.startBeds;
  for (const s of plan.structures()) if (s.type === 'house') n += (defs.house.perBlock.beds ?? 0) * builtBlocks(plan, s, built);
  return n;
}

/** The stores' room: the town's own and every built warehouse block's. */
export function roomOf(plan: FortressPlan, built: Built, defs: Record<StructureType, StructureDef> = DEFS, econ = ECON): number {
  let n = econ.townRoom;
  for (const s of plan.structures()) n += (defs[s.type].perBlock.storage ?? 0) * builtBlocks(plan, s, built);
  return n;
}

/** Goods in the stores that take room. */
export function storedOf(stores: Goods): number {
  let n = 0;
  for (const g of STORED) n += Math.max(0, stores[g] ?? 0);
  return n;
}

/** Whether a load of this size still fits. */
export function fits(stores: Goods, room: number, amount: number): boolean {
  return storedOf(stores) + amount <= room + 1e-6;
}

/** Goods put in as far as they fit (in the order given): what went in. */
export function putIn(stores: Goods, room: number, goods: Goods): Goods {
  const out: Goods = {};
  let left = Math.max(0, room - storedOf(stores));
  for (const [g, v] of Object.entries(goods) as [Good, number][]) {
    const counts = STORED.includes(g);
    const n = counts ? Math.min(v, left) : v;
    if (n <= 0) continue;
    stores[g] = (stores[g] ?? 0) + n;
    out[g] = n;
    if (counts) left -= n;
  }
  return out;
}

/** Whether a newcomer may come: a bed free, grain in the stores, and under the most people. */
export function mayArrive(people: number, beds: number, grain: number, econ = ECON): boolean {
  return people < beds && grain >= 1 && people < econ.maxPeople;
}

/** What Erase gives back for a built block: a share of its cost, each good rounded down. */
export function refundOf(cost: Goods, econ = ECON): Goods {
  const out: Goods = {};
  for (const [g, v] of Object.entries(cost) as [Good, number][]) {
    const n = Math.floor(v * econ.refund);
    if (n > 0) out[g] = n;
  }
  return out;
}

/** A lumber camp's reach for trees (world units): more the bigger it is. */
export function reachOf(blocks: number, econ = ECON): number {
  return econ.reach0 + econ.reachPerBlock * blocks;
}
