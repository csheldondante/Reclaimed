// The fortress's recipes (round 128l, m4: fortress slice 1, milestone 4 — "the blacksmith makes weapons from ore; the
// barracks trains soldiers"). Pure: no GPU, no units, so it's tested (recipes.test.ts). The recipes are data
// (data/recipes/fortress.json): a structure type turns goods into goods (craft: the blacksmith's ore and wood into a
// weapon) or a person and goods into a unit (train: the barracks' recruit and a weapon into a soldier), a batch at a
// time. FortressLife (life.ts) walks it: a worker takes a batch's `in` out of the stores (`take`), carries it to the
// structure, works `seconds` there (`work`), and carries the `out` back to the stores — or, trained, stands up as the
// unit (the person is that unit now: a villager removed, a guard at the barracks).
import type { Good, Goods, StructureType } from '../api/contracts/fortress';
import data from '../../data/recipes/fortress.json';

export interface Recipe {
  id: string;
  /** the structure type that runs it */
  at: StructureType;
  kind: 'craft' | 'train';
  /** what its worker is called (the card's job) */
  worker: string;
  /** a batch's goods in, taken out of the stores */
  in: Goods;
  /** people a batch turns into its unit (train) */
  people?: number;
  /** a batch's goods out (train: the units it stands up, as goods: soldiers) */
  out: Goods;
  /** a batch's work at the structure (sim seconds) */
  seconds: number;
}

export const RECIPES: readonly Recipe[] = (data.recipes as Recipe[]).map((r) => ({ ...r }));

/**
 * What a structure of this type takes in for what it makes (its recipe's `in` as often as `makes` holds its `out`), and
 * the people it turns into units (train). Nothing: no recipe.
 */
export function recipeTakes(type: StructureType, makes: Goods, recipes: readonly Recipe[] = RECIPES): { goods: Goods; people: number } {
  const r = recipes.find((q) => q.at === type);
  if (!r) return { goods: {}, people: 0 };
  const [g, v] = (Object.entries(r.out) as [Good, number][])[0];
  const batches = (makes[g] ?? 0) / v;
  const goods: Goods = {};
  for (const [k, n] of Object.entries(r.in) as [Good, number][]) goods[k] = n * batches;
  return { goods, people: (r.people ?? 0) * batches };
}

/** what the runner needs to know to start a train batch: the units there are, and the room for them */
export interface TrainRoom {
  /** units of the recipe's out (soldiers) there are now, and in training */
  units: number;
  /** beds for them (the barracks' built blocks) */
  beds: number;
}

/** A batch on its way: who took it, for which structure, and how far its work is. */
export interface Batch {
  recipe: Recipe;
  structure: number;
  /** sim seconds of work done */
  done: number;
}

export class RecipeRunner {
  private batches = new Map<number, Batch>();
  /** per structure what it made so far (its out) */
  readonly made = new Map<number, Goods>();
  /** batches started, finished, given back */
  readonly stats = { started: 0, finished: 0, givenBack: 0 };

  constructor(readonly recipes: readonly Recipe[] = RECIPES) {}

  /** The recipe a structure type runs (null: none). */
  recipeAt(type: StructureType): Recipe | null {
    return this.recipes.find((r) => r.at === type) ?? null;
  }

  /**
   * Whether a batch can start at a structure of this type now: the stores hold its `in`, and (train) there's a bed
   * for one more unit.
   */
  canStart(type: StructureType, stores: Goods, room?: TrainRoom): boolean {
    const r = this.recipeAt(type);
    if (!r) return false;
    for (const [g, v] of Object.entries(r.in) as [Good, number][]) if ((stores[g] ?? 0) < v) return false;
    if (r.kind === 'train' && (!room || room.units + (r.out.soldiers ?? 1) > room.beds)) return false;
    return true;
  }

  /**
   * A worker (by id) starts a batch for a structure: the goods to take out of the stores (the caller takes them), or
   * null when it can't start (canStart). One batch a worker at a time.
   */
  start(worker: number, type: StructureType, structure: number, stores: Goods, room?: TrainRoom): Goods | null {
    if (this.batches.has(worker) || !this.canStart(type, stores, room)) return null;
    const r = this.recipeAt(type)!;
    this.batches.set(worker, { recipe: r, structure, done: 0 });
    this.stats.started++;
    return { ...r.in };
  }

  /** a worker's batch (null: none) */
  batchOf(worker: number): Batch | null {
    return this.batches.get(worker) ?? null;
  }

  /** batches being made now (a train batch is a unit on its way) */
  inProgress(kind?: Recipe['kind']): number {
    let n = 0;
    for (const b of this.batches.values()) if (!kind || b.recipe.kind === kind) n++;
    return n;
  }

  /** batches being made now for one structure */
  inProgressAt(structure: number): number {
    let n = 0;
    for (const b of this.batches.values()) if (b.structure === structure) n++;
    return n;
  }

  /**
   * dt sim seconds of the worker's work at its structure: the batch's out when it's done (the batch is over: craft — the
   * goods to carry to the stores; train — the units to stand up), else null.
   */
  work(worker: number, dt: number): Goods | null {
    const b = this.batches.get(worker);
    if (!b) return null;
    b.done += dt;
    if (b.done < b.recipe.seconds) return null;
    this.batches.delete(worker);
    this.stats.finished++;
    const m = this.made.get(b.structure) ?? {};
    for (const [g, v] of Object.entries(b.recipe.out) as [Good, number][]) m[g] = (m[g] ?? 0) + v;
    this.made.set(b.structure, m);
    return { ...b.recipe.out };
  }

  /** a batch dropped before it was done (its worker given other work, gone): its `in`, to go back to the stores */
  giveBack(worker: number): Goods | null {
    const b = this.batches.get(worker);
    if (!b) return null;
    this.batches.delete(worker);
    this.stats.givenBack++;
    return { ...b.recipe.in };
  }

  /** what one worker makes a day at this type, working without a break (sim seconds a day) */
  perWorkerDay(type: StructureType, daySec: number): Goods {
    const r = this.recipeAt(type);
    const out: Goods = {};
    if (!r) return out;
    for (const [g, v] of Object.entries(r.out) as [Good, number][]) out[g] = (v * daySec) / r.seconds;
    return out;
  }

  /** what one worker takes in a day at this type (its `in`, as often as perWorkerDay) */
  perWorkerDayIn(type: StructureType, daySec: number): Goods {
    const r = this.recipeAt(type);
    const out: Goods = {};
    if (!r) return out;
    for (const [g, v] of Object.entries(r.in) as [Good, number][]) out[g] = (v * daySec) / r.seconds;
    return out;
  }
}
