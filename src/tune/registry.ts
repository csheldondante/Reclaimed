// (round 108, BACKLOG AR5) The tuning registry: every physics and flow number that used to be a constant, in one
// place, with its range, default, units and the system that owns it. The values are live: a system reads its own
// group (a plain object, `TUNE.<group>.<key>`; CPU systems) or the Globals' `tune` struct (`G.tune.<groupKey>`; GPU
// kernels — common.wgsl `struct Tune`, packed by writeGlobals every tick). No system reads another's group.
//
// The contract (docs/ARCHITECTURE.md "The tuning registry"):
//   - a parameter's id is `<group>.<key>`; its default is the constant it replaced (behaviour unchanged at defaults);
//   - `gpu: true` parameters are fields of common.wgsl `struct Tune`, in the registry's order, named `<group><Key>`;
//     the struct is checked against the registry when the registry is made (a mismatch throws, with the struct the
//     registry expects in the message);
//   - presets are the changed values only, `{ id: value }`: JSON (export, import, localStorage) or a copyable
//     string (`?tune=<string>` on the page's address loads one);
//   - set() clamps to the range; an unknown id in a preset is reported, never silently dropped.

export interface ParamSpec {
  label: string;
  /** cells, cells/s, cells/s², 1/s, ×, share, s, … */
  units: string;
  min: number;
  max: number;
  step: number;
  /** the constant this replaced */
  def: number;
  /** one line: what it does */
  help?: string;
  /** read by GPU kernels (common.wgsl struct Tune) */
  gpu?: boolean;
  /** an older address parameter that sets it (?rbgrav=, ?crush=, …) */
  url?: string;
}

export interface GroupSpec {
  title: string;
  /** the system (and file) that reads it */
  owner: string;
  params: Record<string, ParamSpec>;
}

export type Values<S extends Record<string, GroupSpec>> = { [G in keyof S]: { [K in keyof S[G]['params']]: number } };

export interface ParamDef extends ParamSpec {
  id: string;
  group: string;
  key: string;
  title: string;
  owner: string;
  /** its float in the Globals' Tune struct (-1: CPU only) */
  slot: number;
}

export type Preset = Record<string, number>;

const camelField = (group: string, key: string) => group + key[0].toUpperCase() + key.slice(1);

export class Registry<S extends Record<string, GroupSpec>> {
  readonly defs: ParamDef[] = [];
  readonly byId = new Map<string, ParamDef>();
  readonly values: Values<S>;
  /** GPU parameters, in slot order */
  readonly gpuDefs: ParamDef[] = [];
  private listeners = new Set<(id: string | null) => void>();

  constructor(readonly spec: S) {
    const values: Record<string, Record<string, number>> = {};
    for (const [group, g] of Object.entries(spec)) {
      values[group] = {};
      for (const [key, p] of Object.entries(g.params)) {
        if (!(p.min <= p.def && p.def <= p.max)) throw new Error(`tune ${group}.${key}: default ${p.def} outside [${p.min}, ${p.max}]`);
        const d: ParamDef = { ...p, id: `${group}.${key}`, group, key, title: g.title, owner: g.owner, slot: p.gpu ? this.gpuDefs.length : -1 };
        this.defs.push(d);
        this.byId.set(d.id, d);
        if (p.gpu) this.gpuDefs.push(d);
        values[group][key] = p.def;
      }
    }
    this.values = values as Values<S>;
  }

  /** floats in the Globals' Tune struct (a whole number of vec4s) */
  get gpuFloats(): number {
    return Math.max(4, Math.ceil(this.gpuDefs.length / 4) * 4);
  }

  get(id: string): number {
    const d = this.need(id);
    return (this.values as Record<string, Record<string, number>>)[d.group][d.key];
  }

  set(id: string, v: number): void {
    const d = this.need(id);
    if (!Number.isFinite(v)) throw new Error(`tune ${id}: ${v} is not a number`);
    const c = Math.min(d.max, Math.max(d.min, v));
    (this.values as Record<string, Record<string, number>>)[d.group][d.key] = c;
    for (const l of this.listeners) l(id);
  }

  /** every parameter back to its default (or one group's) */
  reset(group?: string): void {
    for (const d of this.defs) if (!group || d.group === group) (this.values as Record<string, Record<string, number>>)[d.group][d.key] = d.def;
    for (const l of this.listeners) l(null);
  }

  /** called with the id changed (null: many) */
  onChange(f: (id: string | null) => void): () => void {
    this.listeners.add(f);
    return () => this.listeners.delete(f);
  }

  /** the values that differ from their defaults */
  changed(): Preset {
    const out: Preset = {};
    for (const d of this.defs) {
      const v = this.get(d.id);
      if (v !== d.def) out[d.id] = v;
    }
    return out;
  }

  /** every value (the bug report's) */
  all(): Preset {
    const out: Preset = {};
    for (const d of this.defs) out[d.id] = this.get(d.id);
    return out;
  }

  /** a preset applied over the defaults; returns the ids it didn't know (reported by the caller) */
  apply(p: Preset, over = false): string[] {
    if (!over) for (const d of this.defs) (this.values as Record<string, Record<string, number>>)[d.group][d.key] = d.def;
    const unknown: string[] = [];
    for (const [id, v] of Object.entries(p)) {
      const d = this.byId.get(id);
      if (!d || typeof v !== 'number' || !Number.isFinite(v)) unknown.push(id);
      else (this.values as Record<string, Record<string, number>>)[d.group][d.key] = Math.min(d.max, Math.max(d.min, v));
    }
    for (const l of this.listeners) l(null);
    return unknown;
  }

  /** the copyable string of a preset: base64url of its JSON */
  encode(p: Preset = this.changed()): string {
    const s = JSON.stringify(p);
    return btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  decode(s: string): Preset {
    const t = s.trim().replace(/^.*[?&]tune=/, '').replace(/&.*$/, '');
    const b = t.replace(/-/g, '+').replace(/_/g, '/');
    let json: unknown;
    try {
      json = JSON.parse(decodeURIComponent(escape(atob(b + '='.repeat((4 - (b.length % 4)) % 4)))));
    } catch {
      // (JSON pasted as it is)
      json = JSON.parse(s);
    }
    if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error('a tuning preset is an object of { id: value }');
    // (a bug report's or an export's file: its params)
    const o = json as Record<string, unknown>;
    return (o.params && typeof o.params === 'object' ? o.params : o) as Preset;
  }

  /** The GPU parameters into the Globals' Tune struct at word `at` of `f`. */
  packGpu(f: Float32Array, at: number): void {
    const v = this.values as Record<string, Record<string, number>>;
    for (let i = 0; i < this.gpuDefs.length; i++) {
      const d = this.gpuDefs[i];
      f[at + i] = v[d.group][d.key];
    }
    for (let i = this.gpuDefs.length; i < this.gpuFloats; i++) f[at + i] = 0;
  }

  /** common.wgsl's `struct Tune` as the registry needs it */
  wgslStruct(): string {
    const lines = this.gpuDefs.map((d) => `  ${camelField(d.group, d.key)}: f32,`);
    for (let i = this.gpuDefs.length; i < this.gpuFloats; i++) lines.push(`  pad${i}: f32,`);
    return `struct Tune {\n${lines.join('\n')}\n};`;
  }

  /** Throws unless `wgsl` declares the Tune struct the registry packs (field names in order, padded to vec4s). */
  checkWgsl(wgsl: string): void {
    const m = /struct Tune \{([\s\S]*?)\};/.exec(wgsl);
    const want = this.wgslStruct();
    const fields = (s: string) => [...s.matchAll(/(\w+)\s*:\s*f32/g)].map((x) => x[1]);
    const got = m ? fields(m[1]) : [];
    const need = fields(want.slice(want.indexOf('{')));
    if (got.join(',') !== need.join(',')) throw new Error(`common.wgsl struct Tune is out of step with src/tune/params.ts — it should read:\n${want}`);
  }

  private need(id: string): ParamDef {
    const d = this.byId.get(id);
    if (!d) throw new Error(`tune: no parameter ${id}`);
    return d;
  }
}
