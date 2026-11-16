// The frame census (phone-idle, 2026-11-15; the user on the Pixel 9a: the atlas town "very very slow. Unplayable
// really"). `?census=1`: every GPU call the page makes is counted where it is issued, per frame and per system — render
// and compute passes, direct and indirect dispatches, draws, clears and copies (bytes), queue uploads (bytes), mapAsync
// reads (bytes), pipelines, bind groups, buffers and textures made, submits, and the sim's ticks. Off by default:
// nothing is wrapped, and the scope calls below return at once.
//
// Why counts: on the phone's tiler GPU per-pass timestamps don't add up, and the measured cost there is per call, not
// per workgroup — an indirect dispatch costs ~0.1 ms whether it does 1 workgroup or 0 (Chrome validates its arguments
// on the GPU), a direct one ~0.008 ms, a pass ~0.02 ms (docs/FRAMECOST.md "The phone's cost model"). `estimateMs`
// applies that model to a row; the ranking it gives is what to cut first, and the phone bench (perf/idlebench.ts) is
// the judge.
//
// Who a call belongs to: the scope open when it is made (`censusEnter(name)` … `censusLeave(prev)`: the sim's systems
// by name, the level frame's steps, the renderer's parts), else its pass's or buffer's label under `(label)`. A pass's
// dispatches and draws belong to whoever began the pass.
// It lives with the engine's GPU helpers (the sim and the renderer open scopes); the page's side — the flag, the table,
// the download — is perf/census.ts.
// API: Census (the counter, pure), installCensus (wraps the WebGPU prototypes), censusUse, censusOn, censusEnter /
// censusLeave / censusTick / censusFrame, estimateMs, PHONE_MODEL.

export const FIELDS = [
  'renderPasses',
  'computePasses',
  'direct',
  'indirect',
  'draws',
  'drawsIndirect',
  'clears',
  'clearBytes',
  'copies',
  'copyBytes',
  'uploads',
  'uploadBytes',
  'reads',
  'readBytes',
  'pipelines',
  'bindGroups',
  'buffers',
  'textures',
  'submits',
] as const;
export type Field = (typeof FIELDS)[number];
export type Counts = Record<Field, number>;

export const zero = (): Counts => Object.fromEntries(FIELDS.map((f) => [f, 0])) as Counts;

/**
 * The phone's measured cost of a call (the user's Pixel 9a, 2026-11-15, GPU-done time over an empty frame): 65 indirect
 * dispatches 6.4-6.6 ms; 65 direct in one pass 0.5 ms; 65 direct, a pass each, 1.5 ms (so a pass ~0.015-0.02); CPU
 * reads of 1-3 MB 20-35 ms each (~13 ms a MB; a small read's own cost was not measured: counted, not priced). Render
 * passes, draws and indirect draws were not measured: a render pass is priced as a compute pass, draws at nothing —
 * the bench's toggles are their measure.
 */
export const PHONE_MODEL = { indirect: 0.1, direct: 0.008, pass: 0.02, readPerMB: 13 } as const;

/** a row's estimated phone ms by the model (per whatever the row is per: a frame's averages give ms a frame) */
export function estimateMs(c: Counts): number {
  return c.indirect * PHONE_MODEL.indirect + c.direct * PHONE_MODEL.direct + (c.computePasses + c.renderPasses) * PHONE_MODEL.pass + (c.readBytes / 1048576) * PHONE_MODEL.readPerMB;
}

export interface CensusRow extends Counts {
  system: string;
  /** estimated phone ms a frame (estimateMs of the per-frame averages) */
  phoneMs: number;
  /** the labels under it, by estimated cost (a pass's or a buffer's), with their per-frame counts */
  labels: ({ label: string; phoneMs: number } & Partial<Counts>)[];
}
export interface CensusReport {
  frames: number;
  ticks: number;
  ticksPerFrame: number;
  seconds: number;
  /** per-frame averages by system, by estimated phone ms */
  systems: CensusRow[];
  /** per-frame averages over every system */
  total: Counts & { phoneMs: number };
}

const SEP = String.fromCharCode(9);

export class Census {
  frames = 0;
  ticks = 0;
  private rows = new Map<string, Counts>();
  private stack: string[] = [];
  private t0 = 0;

  constructor(private now: () => number = () => 0) {
    this.t0 = now();
  }

  /** the system a call made now belongs to: the open scope, else `(label)` */
  systemOf(label: string): string {
    return this.stack.length ? this.stack[this.stack.length - 1] : `(${label || 'unlabeled'})`;
  }

  /** the key a pass's later calls (dispatches, draws) are counted under */
  keyOf(label: string): string {
    return this.systemOf(label) + SEP + (label || 'unlabeled');
  }

  add(key: string, field: Field, n = 1): void {
    let r = this.rows.get(key);
    if (!r) this.rows.set(key, (r = zero()));
    r[field] += n;
  }

  /** a call outside a pass (a copy, an upload, a read, something made), by its buffer's label */
  count(label: string, field: Field, n = 1): void {
    this.add(this.keyOf(label), field, n);
  }

  enter(name: string): number {
    return this.stack.push(name);
  }

  /** back to the depth before `enter` (what it returned, less one): a scope left by a throw can't leak into the next */
  leave(depth: number): void {
    this.stack.length = Math.max(0, depth - 1);
  }

  tick(): void {
    this.ticks++;
  }

  endFrame(): void {
    this.frames++;
    this.stack.length = 0;
  }

  reset(): void {
    this.rows.clear();
    this.frames = 0;
    this.ticks = 0;
    this.t0 = this.now();
  }

  /** the counts since the last reset as per-frame averages, by system and estimated phone ms; `reset` after (default) */
  take(reset = true): CensusReport {
    const n = Math.max(1, this.frames);
    const per = (c: Counts): Counts => Object.fromEntries(FIELDS.map((f) => [f, +(c[f] / n).toFixed(3)])) as Counts;
    const bySystem = new Map<string, { sum: Counts; labels: [string, Counts][] }>();
    const total = zero();
    for (const [key, c] of this.rows) {
      const [system, label] = key.split(SEP);
      let s = bySystem.get(system);
      if (!s) bySystem.set(system, (s = { sum: zero(), labels: [] }));
      for (const f of FIELDS) {
        s.sum[f] += c[f];
        total[f] += c[f];
      }
      s.labels.push([label, c]);
    }
    const systems: CensusRow[] = [...bySystem].map(([system, s]) => {
      const avg = per(s.sum);
      const labels = s.labels
        .map(([label, c]) => {
          const a = per(c);
          const nz = Object.fromEntries(FIELDS.filter((f) => a[f] !== 0).map((f) => [f, a[f]])) as Partial<Counts>;
          return { label, phoneMs: +estimateMs(a).toFixed(3), ...nz };
        })
        .sort((a, b) => b.phoneMs - a.phoneMs);
      return { system, phoneMs: +estimateMs(avg).toFixed(3), ...avg, labels };
    });
    systems.sort((a, b) => b.phoneMs - a.phoneMs || b.uploads + b.copies + b.draws - (a.uploads + a.copies + a.draws));
    const t = per(total);
    const report: CensusReport = {
      frames: this.frames,
      ticks: this.ticks,
      ticksPerFrame: +(this.ticks / n).toFixed(3),
      seconds: +((this.now() - this.t0) / 1000).toFixed(2),
      systems,
      total: { ...t, phoneMs: +estimateMs(t).toFixed(3) },
    };
    if (reset) this.reset();
    return report;
  }
}

/** the WebGPU classes the census wraps (the page's globals; a test gives fakes) */
export interface GpuClasses {
  GPUCommandEncoder: { prototype: object };
  GPUComputePassEncoder: { prototype: object };
  GPURenderPassEncoder: { prototype: object };
  GPUQueue: { prototype: object };
  GPUBuffer: { prototype: object };
  GPUDevice: { prototype: object };
}

type Fn = (this: unknown, ...a: unknown[]) => unknown;
const labelOf = (x: unknown): string => (x as { label?: string } | undefined)?.label ?? '';
const sizeOf = (x: unknown): number => (x as { size?: number } | undefined)?.size ?? 0;

/** bytes a queue.writeBuffer(buffer, offset, data, dataOffset?, size?) moves: dataOffset and size are in elements for a typed array */
export function uploadBytes(data: unknown, dataOffset?: number, size?: number): number {
  const d = data as { byteLength: number; BYTES_PER_ELEMENT?: number };
  const el = d.BYTES_PER_ELEMENT ?? 1;
  if (size !== undefined) return size * el;
  return d.byteLength - (dataOffset ?? 0) * el;
}

/** bytes a copyBufferToBuffer moves: (src, srcOffset, dst, dstOffset, size?) or (src, dst, size?) */
export function copyBytes(a: unknown[]): number {
  if (typeof a[1] === 'number') return (a[4] as number | undefined) ?? sizeOf(a[0]) - (a[1] as number);
  return (a[2] as number | undefined) ?? sizeOf(a[0]);
}

/** a texture copy's size as texels × 4 bytes (the format's real size isn't read: an estimate, for ranking) */
function extentBytes(e: unknown): number {
  if (Array.isArray(e)) return (e[0] ?? 1) * (e[1] ?? 1) * (e[2] ?? 1) * 4;
  const o = e as { width?: number; height?: number; depthOrArrayLayers?: number };
  return (o.width ?? 1) * (o.height ?? 1) * (o.depthOrArrayLayers ?? 1) * 4;
}

/**
 * Wraps the WebGPU prototypes so every call is counted in `c`. Returns the undo (a test's; the page keeps it for good).
 */
export function installCensus(c: Census, G: GpuClasses, mapRead = 1): () => void {
  const undo: (() => void)[] = [];
  const wrap = (cls: { prototype: object }, name: string, before: (self: unknown, a: unknown[], out: (r: unknown) => void) => void) => {
    const proto = cls.prototype as Record<string, Fn>;
    const orig = proto[name];
    if (typeof orig !== 'function') return;
    proto[name] = function (this: unknown, ...a: unknown[]) {
      let after: ((r: unknown) => void) | undefined;
      before(this, a, (f) => (after = f as (r: unknown) => void));
      const r = orig.apply(this, a);
      after?.(r);
      return r;
    };
    undo.push(() => (proto[name] = orig));
  };
  /** the key each open pass counts under */
  const passKey = new WeakMap<object, string>();
  const keyOfPass = (p: unknown) => passKey.get(p as object) ?? c.keyOf('pass');

  wrap(G.GPUCommandEncoder, 'beginComputePass', (_s, a, out) => {
    const key = c.keyOf(labelOf(a[0]));
    c.add(key, 'computePasses');
    out(((p: object) => passKey.set(p, key)) as never);
  });
  wrap(G.GPUCommandEncoder, 'beginRenderPass', (_s, a, out) => {
    const key = c.keyOf(labelOf(a[0]));
    c.add(key, 'renderPasses');
    out(((p: object) => passKey.set(p, key)) as never);
  });
  wrap(G.GPUComputePassEncoder, 'dispatchWorkgroups', (s) => c.add(keyOfPass(s), 'direct'));
  wrap(G.GPUComputePassEncoder, 'dispatchWorkgroupsIndirect', (s) => c.add(keyOfPass(s), 'indirect'));
  for (const d of ['draw', 'drawIndexed']) wrap(G.GPURenderPassEncoder, d, (s) => c.add(keyOfPass(s), 'draws'));
  for (const d of ['drawIndirect', 'drawIndexedIndirect']) wrap(G.GPURenderPassEncoder, d, (s) => c.add(keyOfPass(s), 'drawsIndirect'));

  wrap(G.GPUCommandEncoder, 'clearBuffer', (_s, a) => {
    const key = c.keyOf(labelOf(a[0]));
    c.add(key, 'clears');
    c.add(key, 'clearBytes', (a[2] as number | undefined) ?? sizeOf(a[0]) - ((a[1] as number | undefined) ?? 0));
  });
  wrap(G.GPUCommandEncoder, 'copyBufferToBuffer', (_s, a) => {
    const dst = typeof a[1] === 'number' ? a[2] : a[1];
    const key = c.keyOf(labelOf(dst) || labelOf(a[0]));
    c.add(key, 'copies');
    c.add(key, 'copyBytes', copyBytes(a));
  });
  for (const t of ['copyTextureToTexture', 'copyBufferToTexture', 'copyTextureToBuffer'])
    wrap(G.GPUCommandEncoder, t, (_s, a) => {
      const tex = (x: unknown) => labelOf((x as { texture?: unknown; buffer?: unknown })?.texture ?? (x as { buffer?: unknown })?.buffer);
      const key = c.keyOf(tex(a[1]) || tex(a[0]) || t);
      c.add(key, 'copies');
      c.add(key, 'copyBytes', extentBytes(a[2]));
    });
  wrap(G.GPUQueue, 'writeBuffer', (_s, a) => {
    const key = c.keyOf(labelOf(a[0]));
    c.add(key, 'uploads');
    c.add(key, 'uploadBytes', uploadBytes(a[2], a[3] as number | undefined, a[4] as number | undefined));
  });
  wrap(G.GPUQueue, 'writeTexture', (_s, a) => {
    const key = c.keyOf(labelOf((a[0] as { texture?: unknown })?.texture) || 'writeTexture');
    c.add(key, 'uploads');
    c.add(key, 'uploadBytes', (a[1] as { byteLength: number }).byteLength);
  });
  wrap(G.GPUQueue, 'submit', () => c.count('submit', 'submits'));
  wrap(G.GPUBuffer, 'mapAsync', (s, a) => {
    if (!((a[0] as number) & mapRead)) return;
    const key = c.keyOf(labelOf(s) || `unlabeled ${sizeOf(s)}`);
    c.add(key, 'reads');
    c.add(key, 'readBytes', (a[2] as number | undefined) ?? sizeOf(s) - ((a[1] as number | undefined) ?? 0));
  });
  for (const p of ['createComputePipeline', 'createRenderPipeline', 'createComputePipelineAsync', 'createRenderPipelineAsync']) wrap(G.GPUDevice, p, (_s, a) => c.count(labelOf(a[0]) || p, 'pipelines'));
  wrap(G.GPUDevice, 'createBindGroup', (_s, a) => c.count(labelOf(a[0]) || 'bind group', 'bindGroups'));
  wrap(G.GPUDevice, 'createBuffer', (_s, a) => c.count(labelOf(a[0]) || 'buffer', 'buffers'));
  wrap(G.GPUDevice, 'createTexture', (_s, a) => c.count(labelOf(a[0]) || 'texture', 'textures'));
  return () => {
    for (const u of undo.reverse()) u();
  };
}

// ---------------------------------------------------------------- the page's census

/** the page's census, or null (no ?census=1): every scope call below is then one null check */
let live: Census | null = null;

export function censusOn(): Census | null {
  return live;
}
/** the page's census set (perf/census.ts startCensus; a test's) */
export function censusUse(c: Census | null): void {
  live = c;
}

/** open a scope: calls made until `censusLeave` of what this returns belong to `name` */
export function censusEnter(name: string): number {
  return live ? live.enter(name) : 0;
}
export function censusLeave(depth: number): void {
  if (live) live.leave(depth);
}
/** a sim tick stepped */
export function censusTick(): void {
  if (live) live.tick();
}
/** a frame's end (main.ts, after the scene's frame) */
export function censusFrame(): void {
  if (live) live.endFrame();
}
