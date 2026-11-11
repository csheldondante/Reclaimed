// ---- agents/fieldseam.ts: the orders' fields, on the CPU side (U2 round 6; round 7: field ids from the page pool) ----
// Which field an order walks is decided here only: a field for a key (a place, a gate's route, a man order's wall runs),
// shared by every order group holding the same key. Fields are ids of the agents' field page pool (Agents.newField:
// rows sized from memory, no fixed count); a key no holder holds any more gives its fields back (freeField). Its GPU
// half is shaders/fieldseam.wgsl.

/** where the field ids come from (Agents) */
export interface FieldSource {
  newField(): number | null;
  freeField(f: number): void;
}

export class OrderFields {
  private held = new Map<number, { key: string; fields: number[] }>();

  constructor(private src: FieldSource) {}

  /**
   * The fields order group `holder` walks for `key`: those another holder of the same key has (shared), else `want`
   * new ones. Null only when the field pool's rows are used up (the order isn't sent: 'pool-full'). A holder taking
   * another key lets its last go first.
   */
  fieldFor(holder: number, key: string, want = 1): number[] | null {
    const mine = this.held.get(holder);
    if (mine?.key === key) return mine.fields;
    this.release(holder);
    const shared = [...this.held.values()].find((v) => v.key === key);
    let fields = shared?.fields;
    if (!fields) {
      fields = [];
      for (let i = 0; i < Math.max(1, want); i++) {
        const f = this.src.newField();
        if (f === null) {
          for (const g of fields) this.src.freeField(g);
          return null;
        }
        fields.push(f);
      }
    }
    this.held.set(holder, { key, fields });
    return fields;
  }

  /** order group `holder` holds no field any more (the last holder of a key gives its fields back) */
  release(holder: number): void {
    const mine = this.held.get(holder);
    if (!mine) return;
    this.held.delete(holder);
    if (![...this.held.values()].some((v) => v.key === mine.key)) for (const f of mine.fields) this.src.freeField(f);
  }

  /** the fields `holder` holds (none: []) */
  of(holder: number): number[] {
    return this.held.get(holder)?.fields ?? [];
  }
}
