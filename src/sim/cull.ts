// Dispatching only where the world is awake (on by default, ?simcull=0 off; round 85 — the user: "only simulate things that need it
// … to avoid dispatching for dead things I think it makes sense").
//
// The passes that change the ground skip a sleeping chunk (common.wgsl `asleep`, sim/sleep.ts), but they were
// still dispatched over the whole streamed window: every thread woke, read the mask and returned, and the
// ping-pong fields copied their whole buffers back. Now those passes are dispatched over a list of the
// chunks that are live this tick instead — awake, drowsy (just fallen asleep: its slots carried through once) or,
// for a flow with a sleeping rate (?flowhz=), on its slow turn (common.wgsl slowTick) — and the copies back run
// over the same list. A chunk not on the list is exactly what the pass's own asleep branch made of it: its
// current buffers untouched (the carry wrote next = current, and the copy put it back), and nothing reads the
// next buffers but their own pass and copy.
//
// The list is built on the CPU, where the mask is made (Sleep.update): no readback, the count known when the
// passes are encoded, so a pass with nothing live isn't dispatched at all (no indirect dispatch needed).
// Contract (WorldGpu.tiles): per flow rate n (0: live only), a uniform of chunk indices (cy · chunksX + cx), 4 a
// vec4, and its count; four 8 × 8 workgroups a chunk (the kernel's wrapper, cullSource, finds its columns).

import { CHUNK } from '../world/layout';
import { makeBindGroup, makeCompute, type BindSpec, type ComputeKernel } from '../gpu/pipeline';
import type { Profiler } from '../gpu/profiler';
import commonWgsl from '../shaders/common.wgsl?raw';
import materialsWgsl from '../shaders/materials.wgsl?raw';

/** on by default (round 85, measured: the same state asleep, bit for bit — scripts/culltest.mjs); ?simcull=0 off */
export const SIM_CULL = typeof location !== 'undefined' && new URLSearchParams(location.search).get('simcull') !== '0';

/** workgroups (8 × 8) a chunk (16 × 16) */
const WG_PER_CHUNK = (CHUNK / 8) * (CHUNK / 8);
/** the list of a pass with no sleeping rate: the chunks awake or drowsy */
export const LIVE = 0;
/** the binding the list sits at in a culled kernel */
export const TILES_BINDING = 39;

export class AwakeTiles {
  readonly cx: number;
  readonly cy: number;
  readonly chunks: number;
  /** vec4s in each list's uniform (the WGSL array's length) */
  readonly vec4s: number;
  private lists = new Map<number, { buf: GPUBuffer; count: number; data: Uint32Array }>();

  constructor(
    private device: GPUDevice,
    w: number,
    h: number,
  ) {
    if (w % CHUNK || h % CHUNK) throw new Error(`simcull: the window (${w} × ${h}) must be whole chunks of ${CHUNK}`);
    this.cx = w / CHUNK;
    this.cy = h / CHUNK;
    this.chunks = this.cx * this.cy;
    this.vec4s = Math.ceil(this.chunks / 4);
    if (this.vec4s * 16 > 65536) throw new Error(`simcull: ${this.chunks} chunks, a uniform list holds ${65536 / 4}`);
  }

  /** the list for a flow's sleeping rate n (ticks between a sleeping chunk's updates; 0: frozen) — made on first ask */
  list(n: number): GPUBuffer {
    let l = this.lists.get(n);
    if (!l) {
      const data = new Uint32Array(this.vec4s * 4);
      for (let c = 0; c < this.chunks; c++) data[c] = c;
      const buf = this.device.createBuffer({ label: `tiles n${n}`, size: data.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      this.device.queue.writeBuffer(buf, 0, data);
      l = { buf, count: this.chunks, data };
      this.lists.set(n, l);
    }
    return l.buf;
  }

  /** workgroups to dispatch for list n this tick (0: skip the pass) */
  groups(n: number): number {
    const l = this.lists.get(n);
    if (!l) throw new Error(`simcull: no tile list for n=${n}`);
    return l.count * WG_PER_CHUNK;
  }

  /** chunks live in list n this tick (the perf overlay, tests) */
  count(n: number): number {
    return this.lists.get(n)?.count ?? this.chunks;
  }

  /** This tick's lists from the sleep mask (bits set: asleep; absent: all awake) and the drowsy mask. */
  update(tick: number, sleep?: Uint32Array, drowse?: Uint32Array): void {
    for (const [n, l] of this.lists) {
      let k = 0;
      for (let c = 0; c < this.chunks; c++) {
        const w = c >> 5;
        const b = 1 << (c & 31);
        const asleep = !!sleep && c < sleep.length * 32 && (sleep[w] & b) !== 0;
        const live = !asleep || (!!drowse && (drowse[w] & b) !== 0) || (n > 0 && (tick + c * 7) % n === 0);
        if (live) l.data[k++] = c;
      }
      if (k) this.device.queue.writeBuffer(l.buf, 0, l.data, 0, Math.max(4, Math.ceil(k / 4) * 4));
      l.count = k;
    }
  }

  destroy(): void {
    for (const l of this.lists.values()) l.buf.destroy();
    this.lists.clear();
  }
}

/**
 * A per-column kernel (`@compute @workgroup_size(8, 8) fn <entry>(@builtin(global_invocation_id) id: vec3<u32>)`)
 * dispatched over a tile list instead: the entry renamed, a wrapper by its name that finds this workgroup's
 * columns from the list. Throws if the kernel isn't of that shape (no silent full dispatch).
 */
export function cullSource(src: string, entry: string, vec4s: number): string {
  const re = new RegExp(`@compute\\s+@workgroup_size\\(8,\\s*8\\)\\s*fn ${entry}\\(@builtin\\(global_invocation_id\\) (\\w+): vec3<u32>\\)`);
  const m = src.match(re);
  if (!m) throw new Error(`simcull: kernel entry ${entry} isn't an 8 × 8 per-column pass`);
  const inner = `${entry}_column`;
  return (
    src.replace(re, `fn ${inner}(${m[1]}: vec3<u32>)`) +
    `
// (sim/cull.ts) the live chunks this tick, four 8 x 8 workgroups each
@group(0) @binding(${TILES_BINDING}) var<uniform> TILES: array<vec4<u32>, ${vec4s}>;
@compute @workgroup_size(8, 8)
fn ${entry}(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_id) l: vec3<u32>) {
  let t = wg.x >> 2u;
  let c = TILES[t >> 2u][t & 3u];
  let s = wg.x & 3u;
  let q = vec2<u32>((c % G.chunksX) * G.chunkSize + (s & 1u) * 8u + l.x, (c / G.chunksX) * G.chunkSize + (s >> 1u) * 8u + l.y);
  if (q.x >= G.mapW || q.y >= G.mapH) { return; }
  ${inner}(vec3<u32>(q, 0u));
}
`
  );
}

/** what a culled kernel needs: its code, its layout with the tile binding, the list bound there */
export function cullKernel(tiles: AwakeTiles, code: string, spec: BindSpec, entry: string, n: number): { code: string; spec: BindSpec; buf: GPUBuffer } {
  return { code: cullSource(code, entry, tiles.vec4s), spec: { ...spec, [TILES_BINDING]: 'uniform' }, buf: tiles.list(n) };
}

/** Dispatch a culled kernel over list n (no pass at all when no chunk is live). */
export function dispatchTiles(enc: GPUCommandEncoder, prof: Profiler, name: string, k: ComputeKernel, group: GPUBindGroup, tiles: AwakeTiles, n: number): void {
  const g = tiles.groups(n);
  if (!g) return;
  const pass = enc.beginComputePass({ label: name, timestampWrites: prof.timestamps(name) });
  pass.setPipeline(k.pipeline);
  pass.setBindGroup(0, group);
  pass.dispatchWorkgroups(g, 1);
  pass.end();
  prof.dispatches++;
}

const COPY_WGSL = (words: number) => `
@group(0) @binding(3) var<storage, read> src: array<u32>;
@group(0) @binding(4) var<storage, read_write> dst: array<u32>;
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let i = (id.y * G.mapW + id.x) * ${words}u;
  for (var k = 0u; k < ${words}u; k++) { dst[i + k] = src[i + k]; }
}
`;

/**
 * A ping-pong field's copy back (next -> current) over the live chunks only: a sleeping chunk's current buffer is
 * left as it is (what its pass's asleep branch carried through and the whole copy put back).
 */
export class TileCopy {
  private kernels = new Map<number, ComputeKernel>();
  private bound = new Map<string, GPUBindGroup>();
  constructor(
    private device: GPUDevice,
    private globals: GPUBuffer,
    private materials: GPUBuffer,
    private tiles: AwakeTiles,
    private cells: number,
  ) {}

  copy(enc: GPUCommandEncoder, prof: Profiler, src: GPUBuffer, dst: GPUBuffer, words: number, n: number): void {
    if (src.size < this.cells * words * 4 || dst.size < this.cells * words * 4) throw new Error(`simcull: ${src.label} -> ${dst.label} isn't ${words} words a column`);
    let k = this.kernels.get(words);
    if (!k) {
      const c = cullKernel(this.tiles, [commonWgsl, materialsWgsl, COPY_WGSL(words)].join('\n'), { 0: 'uniform', 2: 'uniform', 3: 'read', 4: 'rw' }, 'main', n);
      k = makeCompute(this.device, `copyback ${words}`, [c.code], c.spec);
      this.kernels.set(words, k);
    }
    const key = `${src.label}>${dst.label}:${n}`;
    let g = this.bound.get(key);
    if (!g) {
      g = makeBindGroup(this.device, `copyback ${key}`, k.layout, { 0: this.globals, 2: this.materials, 3: src, 4: dst, [TILES_BINDING]: this.tiles.list(n) });
      this.bound.set(key, g);
    }
    dispatchTiles(enc, prof, 'copyback', k, g, this.tiles, n);
  }
}
