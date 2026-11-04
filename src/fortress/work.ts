// What the fortress's builders owe and have brought (fortress slice 1, milestone 2). Pure: no GPU, no units. A block
// planned costs its type's per-block cost (defs.ts); builders take loads out of the stores (the stores go down as they
// take), carry them to the block and work them in; when the whole cost is in, the block stands. A load on its way is
// counted against the block it's for, so two builders don't both fetch the last of it.
import type { Good, Goods } from '../api/contracts/fortress';
import type { Block } from '../build/town';

// (round 128d: no level cap — a key per block that doesn't pack the level into a few bits)
const key = (b: Block) => `${b.cell}:${b.level}`;

export interface Load {
  good: Good;
  amount: number;
}

export class BuildBook {
  /** per block in the works: what's been worked in */
  private paid = new Map<string, Goods>();
  /** per block: what's on its way there */
  private coming = new Map<string, Goods>();

  /** `costOf`: what a block costs (its type's per-block cost) */
  constructor(private costOf: (b: Block) => Goods) {}

  /** What a block still lacks, not counting what's on its way (`withComing`: counting it). */
  need(b: Block, withComing = true): Goods {
    const cost = this.costOf(b);
    const paid = this.paid.get(key(b)) ?? {};
    const coming = withComing ? (this.coming.get(key(b)) ?? {}) : {};
    const out: Goods = {};
    for (const [g, v] of Object.entries(cost) as [Good, number][]) {
      const left = v - (paid[g] ?? 0) - (coming[g] ?? 0);
      if (left > 1e-6) out[g] = left;
    }
    return out;
  }

  /**
   * A builder at the heap: a load for block b — the first good it still lacks that the stores have, at most `most` —
   * taken out of the stores. Null: nothing it lacks is in the stores (or it lacks nothing).
   */
  fetch(b: Block, stores: Goods, most: number): Load | null {
    for (const [g, left] of Object.entries(this.need(b)) as [Good, number][]) {
      const have = stores[g] ?? 0;
      if (have < 1e-6) continue;
      const amount = Math.min(left, most, have);
      stores[g] = have - amount;
      add(this.coming, key(b), g, amount);
      return { good: g, amount };
    }
    return null;
  }

  /** A load brought to b worked in: true when b's whole cost is in (its record goes: the block stands). */
  pay(b: Block, load: Load): boolean {
    add(this.coming, key(b), load.good, -load.amount);
    add(this.paid, key(b), load.good, load.amount);
    if (Object.keys(this.need(b, false)).length) return false;
    this.paid.delete(key(b));
    this.coming.delete(key(b));
    return true;
  }

  /** A load meant for `from` given to `to` instead (a builder came to another block first). */
  move(from: Block, to: Block, load: Load): void {
    add(this.coming, key(from), load.good, -load.amount);
    add(this.coming, key(to), load.good, load.amount);
  }

  /** A load that wasn't needed after all (the block was erased): back into the stores. */
  giveBack(b: Block, load: Load, stores: Goods): void {
    add(this.coming, key(b), load.good, -load.amount);
    stores[load.good] = (stores[load.good] ?? 0) + load.amount;
  }

  /** What's been worked into b so far. */
  paidOf(b: Block): Goods {
    return { ...(this.paid.get(key(b)) ?? {}) };
  }
}

function add(m: Map<string, Goods>, k: string, g: Good, v: number): void {
  const o = m.get(k) ?? {};
  o[g] = (o[g] ?? 0) + v;
  if (Math.abs(o[g]!) < 1e-9) delete o[g];
  if (Object.keys(o).length) m.set(k, o);
  else m.delete(k);
}
