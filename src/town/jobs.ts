// A town's jobs (round 128o, DA-A6: moved here from fortress/economy.ts and fortress/work.ts — every town's people work
// a job board, not only the player's): the jobs' priority, a slot, the JobBoard that gives people their jobs, a load a
// builder carries. Pure.
import type { Good } from '../api/contracts/fortress';

/**
 * Which jobs people take first when there aren't enough for all (the JobBoard's priority): the builders (ECON.builders,
 * while there's building), then food, then stone, then wood; (round 128l, milestone 4) then the smiths, then the
 * recruits. (DA-A2, round 128o: the builders were after food — with one plan a town's generated farmland is farm
 * structures, the user's start town 368 farm blocks, a job each, so every person farmed and nothing was built. And moved
 * here from defs.ts: the job board's order isn't the building types' data — defs.ts is among the land generator's
 * sources, so a change to it made every saved region and the lab's fixture stale, GEN_VERSION.)
 */
export const JOB_ORDER = ['build', 'farm', 'quarry', 'lumber', 'blacksmith', 'barracks'] as const;
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

/** goods a builder carries to a block */
export interface Load {
  good: Good;
  amount: number;
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
