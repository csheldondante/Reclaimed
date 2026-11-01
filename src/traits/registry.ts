// The trait modules' registry (LW1; contracts/traits.ts TraitModule): which game rules run, in what order, with what
// tables. Pure TS (Node unit tests): the GPU side (system.ts) builds a pipeline per module from it and rebuilds only
// what changed. Adding a module touches no other module — the registry is the only thing that knows the set.

import type { TraitModule } from '../api/contracts/traits';

/** a module's table: 16 vec4 at most (one uniform buffer each, bound at prelude.wgsl's binding 42) */
export const TABLE_WORDS = 64;
const NAME = /^[a-z][a-z0-9_]*$/;
const DEFAULT_ORDER = 100;

export interface Registered {
  name: string;
  wgsl: string;
  /** the table as 64 words (zero-padded) */
  table: Uint32Array;
  order: number;
  /** registration serial: ties in `order` run in the order registered */
  serial: number;
}

export class TraitRegistry {
  private mods = new Map<string, Registered>();
  private serial = 0;
  /** bumped on any change (the GPU side rebuilds its run list when it moves) */
  version = 0;

  register(m: TraitModule): Registered {
    if (!NAME.test(m.name)) throw new Error(`traits: a module's name is lower_snake (got "${m.name}")`);
    if (this.mods.has(m.name)) throw new Error(`traits: a module "${m.name}" is already registered`);
    if (!/fn\s+module_main\s*\(\s*u\s*:\s*u32\s*\)/.test(m.wgsl)) throw new Error(`traits: module "${m.name}" has no fn module_main(u: u32)`);
    if (/@group\s*\(|@compute/.test(m.wgsl)) throw new Error(`traits: module "${m.name}" declares bindings or entry points — the prelude owns those`);
    const r: Registered = { name: m.name, wgsl: m.wgsl, table: tableWords(m.name, m.table), order: m.order ?? DEFAULT_ORDER, serial: this.serial++ };
    this.mods.set(m.name, r);
    this.version++;
    return r;
  }

  unregister(name: string): void {
    if (!this.mods.delete(name)) throw new Error(`traits: no module "${name}"`);
    this.version++;
  }

  /** a module's table rewritten (same size rule) — tuning without recompiling */
  setTable(name: string, table: ArrayBufferView): Registered {
    const r = this.mods.get(name);
    if (!r) throw new Error(`traits: no module "${name}"`);
    r.table = tableWords(name, table);
    this.version++;
    return r;
  }

  get(name: string): Registered | undefined {
    return this.mods.get(name);
  }

  /** the modules in the order they run */
  list(): Registered[] {
    return [...this.mods.values()].sort((a, b) => a.order - b.order || a.serial - b.serial);
  }
}

function tableWords(name: string, t?: ArrayBufferView): Uint32Array {
  const out = new Uint32Array(TABLE_WORDS);
  if (!t) return out;
  if (t.byteLength % 4) throw new Error(`traits: module "${name}"'s table isn't whole words`);
  if (t.byteLength > TABLE_WORDS * 4) throw new Error(`traits: module "${name}"'s table is ${t.byteLength} bytes (${TABLE_WORDS * 4} at most)`);
  out.set(new Uint32Array(t.buffer, t.byteOffset, t.byteLength / 4));
  return out;
}

/**
 * A table from rows of numbers: each row's cells as u32 (an integer given as `{ u: n }`) or f32. Rows are padded to
 * `width` words (default 4: one vec4 a row).
 */
export function packTable(rows: readonly (readonly (number | { u: number })[])[], width = 4): Uint32Array {
  const out = new Uint32Array(rows.length * width);
  const f = new Float32Array(out.buffer);
  rows.forEach((r, i) => {
    if (r.length > width) throw new Error(`traits: a table row of ${r.length} cells (width ${width})`);
    r.forEach((c, j) => {
      if (typeof c === 'number') f[i * width + j] = c;
      else out[i * width + j] = c.u >>> 0;
    });
  });
  return out;
}
