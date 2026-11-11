// ---- agents/fieldseam.ts: the orders' fields, on the CPU side (U2 round 6; the paged field atlas, §9b, swaps this) ----
// Which field an order walks is decided here only: a field for a key (a place, a gate's route, a man order's wall runs),
// shared by every order group holding the same key, from the order fields' pool (the old rounds' 0-6). Its GPU half is
// shaders/fieldseam.wgsl (a field's distance, its way down, a seed set or let go). Round 7 pages the fields: this keeps
// its calls and hands out field ids that name pages' owners instead.

/** the order fields: the old rounds' (agents fields 0-6) — no rounds run on the agents in the GPU towns */
export const ORDER_FIELDS = [0, 1, 2, 3, 4, 5, 6] as const;

export class OrderFields {
  private held = new Map<number, { key: string; fields: number[] }>();

  constructor(private pool: readonly number[] = ORDER_FIELDS) {}

  /**
   * The fields order group `holder` walks for `key`: those another holder of the same key has (shared), else up to
   * `want` free ones. Null when none is free (the order isn't sent: 'pool-full'). A holder taking another key lets its
   * last go first.
   */
  fieldFor(holder: number, key: string, want = 1): number[] | null {
    const mine = this.held.get(holder);
    if (mine?.key === key) return mine.fields;
    const others = [...this.held].filter(([h]) => h !== holder).map(([, v]) => v);
    const shared = others.find((v) => v.key === key);
    const taken = new Set(others.flatMap((v) => v.fields));
    const fields = shared ? shared.fields : this.pool.filter((f) => !taken.has(f)).slice(0, Math.max(1, want));
    if (!fields.length) return null;
    this.held.set(holder, { key, fields });
    return fields;
  }

  /** order group `holder` holds no field any more */
  release(holder: number): void {
    this.held.delete(holder);
  }

  /** the fields `holder` holds (none: []) */
  of(holder: number): number[] {
    return this.held.get(holder)?.fields ?? [];
  }
}
