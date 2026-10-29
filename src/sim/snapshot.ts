// (round 112, testspeed) A warmed world, saved and put back: every buffer and texture the WorldGpu holds (the
// contract — sim/world-gpu.ts: every system's state lives there) and the sim's tick. A check starts from the world a
// fresh warmup would leave (scripts/warmprobe.mjs shows the two equal by every buffer's hash; only the particles
// differ, and they differ between two fresh warmups too), with every system running from there on.
//
// What isn't kept, by design: uniform buffers (the Globals: written from the CPU every tick) and textures the CPU
// writes (tiers, reach) or a tick derives without reading them back (corners) — those lack COPY_SRC; and what can be
// read but not written (COPY_SRC without COPY_DST: a tick's outputs the CPU reads back, editResult) — no tick reads
// them. The snapshot names what it left out (`skipped`), and warmprobe's hash of every buffer checks the rest.

export interface WorldSnapshot {
  tick: number;
  /** the world's buffers and textures read-only to a copy (a tick's outputs for the CPU): not kept */
  skipped?: string[];
  /** name → bytes (a buffer's whole contents; a texture's rows at its own bytes a row, unpadded) */
  parts: { name: string; kind: 'buffer' | 'texture'; bytes: Uint8Array }[];
}

interface Core {
  world: object;
  sim: { tick: number };
  host: { gpu: { device: GPUDevice } };
}

const texBpp = (f: GPUTextureFormat): number => {
  if (f === 'rgba32float' || f === 'rgba32uint') return 16;
  if (f === 'rg32float' || f === 'rgba16float') return 8;
  if (f === 'r32float' || f === 'r32uint' || f === 'rgba8unorm') return 4;
  if (f === 'r8unorm') return 1;
  throw new Error(`snapshot: texture format ${f} not handled`);
};

/** what a world holds that a snapshot keeps: its buffers and textures with COPY_SRC (UNIFORM buffers aside) */
function kept(core: Core, skipped: string[] = []): { name: string; v: GPUBuffer | GPUTexture }[] {
  const out: { name: string; v: GPUBuffer | GPUTexture }[] = [];
  for (const [name, v] of Object.entries(core.world)) {
    if (v instanceof GPUBuffer) {
      if (v.usage & GPUBufferUsage.UNIFORM || !(v.usage & GPUBufferUsage.COPY_SRC)) continue;
      if (!(v.usage & GPUBufferUsage.COPY_DST)) {
        skipped.push(name);
        continue;
      }
      out.push({ name, v });
    } else if (v instanceof GPUTexture) {
      if (!(v.usage & GPUTextureUsage.COPY_SRC)) continue;
      if (!(v.usage & GPUTextureUsage.COPY_DST)) {
        skipped.push(name);
        continue;
      }
      if (v.depthOrArrayLayers !== 1 || v.dimension !== '2d') throw new Error(`snapshot: texture ${name} isn't a plain 2D texture`);
      out.push({ name, v });
    }
  }
  return out;
}

/**
 * The world as it is now: the copies are encoded and submitted at once (in queue order — no later tick reaches
 * them); the promise resolves when they're read back.
 */
export function captureWorld(core: Core): Promise<WorldSnapshot> {
  const dev = core.host.gpu.device;
  const tick = core.sim.tick;
  const enc = dev.createCommandEncoder({ label: 'snapshot' });
  const reads: { name: string; kind: 'buffer' | 'texture'; st: GPUBuffer; row?: [number, number, number] }[] = [];
  const skipped: string[] = [];
  for (const { name, v } of kept(core, skipped)) {
    if (v instanceof GPUBuffer) {
      const st = dev.createBuffer({ size: v.size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
      enc.copyBufferToBuffer(v, 0, st, 0, v.size);
      reads.push({ name, kind: 'buffer', st });
    } else {
      const bpr = v.width * texBpp(v.format);
      const padded = Math.ceil(bpr / 256) * 256;
      const st = dev.createBuffer({ size: padded * v.height, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
      enc.copyTextureToBuffer({ texture: v }, { buffer: st, bytesPerRow: padded }, { width: v.width, height: v.height });
      reads.push({ name, kind: 'texture', st, row: [bpr, padded, v.height] });
    }
  }
  dev.queue.submit([enc.finish()]);
  return Promise.all(
    reads.map(async ({ name, kind, st, row }) => {
      await st.mapAsync(GPUMapMode.READ);
      const src = new Uint8Array(st.getMappedRange());
      let bytes: Uint8Array;
      if (!row) bytes = src.slice();
      else {
        const [bpr, padded, h] = row;
        bytes = new Uint8Array(bpr * h);
        for (let y = 0; y < h; y++) bytes.set(src.subarray(y * padded, y * padded + bpr), y * bpr);
      }
      st.unmap();
      st.destroy();
      return { name, kind, bytes };
    }),
  ).then((parts) => ({ tick, parts, skipped }));
}

/** Puts a snapshot back into a world made the same way (the same level, window, settings and build): every part must fit. */
export function restoreWorld(core: Core, snap: WorldSnapshot): void {
  const dev = core.host.gpu.device;
  const have = new Map(kept(core).map((k) => [k.name, k.v]));
  if (have.size !== snap.parts.length) throw new Error(`snapshot: ${snap.parts.length} parts for a world of ${have.size}`);
  for (const p of snap.parts) {
    const v = have.get(p.name);
    if (!v) throw new Error(`snapshot: the world has no ${p.name}`);
    if (v instanceof GPUBuffer) {
      if (p.kind !== 'buffer' || p.bytes.byteLength !== v.size) throw new Error(`snapshot: ${p.name} is ${p.bytes.byteLength} bytes, the world's ${v.size}`);
      dev.queue.writeBuffer(v, 0, p.bytes);
    } else {
      const bpr = v.width * texBpp(v.format);
      if (p.kind !== 'texture' || p.bytes.byteLength !== bpr * v.height) throw new Error(`snapshot: texture ${p.name} doesn't fit`);
      dev.queue.writeTexture({ texture: v }, p.bytes, { bytesPerRow: bpr, rowsPerImage: v.height }, { width: v.width, height: v.height });
    }
  }
  core.sim.tick = snap.tick;
}

/** one blob: a JSON header line (tick, the parts' names, kinds and sizes), then the parts' bytes in order */
export function encodeSnapshot(s: WorldSnapshot): Blob {
  const head = JSON.stringify({ v: 1, tick: s.tick, skipped: s.skipped, parts: s.parts.map((p) => [p.name, p.kind, p.bytes.byteLength]) });
  return new Blob([head, '\n', ...s.parts.map((p) => p.bytes as BlobPart)]);
}
export function decodeSnapshot(buf: ArrayBuffer): WorldSnapshot {
  const u = new Uint8Array(buf);
  const nl = u.indexOf(10);
  const head = JSON.parse(new TextDecoder().decode(u.subarray(0, nl))) as { v: number; tick: number; skipped?: string[]; parts: [string, 'buffer' | 'texture', number][] };
  if (head.v !== 1) throw new Error(`snapshot: version ${head.v}`);
  let o = nl + 1;
  const parts = head.parts.map(([name, kind, n]) => {
    const bytes = u.slice(o, o + n);
    o += n;
    return { name, kind, bytes };
  });
  if (o !== u.length) throw new Error('snapshot: its parts and its length disagree');
  return { tick: head.tick, parts, skipped: head.skipped };
}

/**
 * The test runner's snapshot store (scripts/lib/runner.mjs serves /__snap/<key> from .testcache/snap/): the snapshot
 * under `key`, or null when there is none yet. The game's own builds have no such endpoint and never ask (only a
 * `?warmsnap=` page does).
 */
export async function loadSnapshot(key: string): Promise<WorldSnapshot | null> {
  if (!/^[0-9a-f]{16,64}$/.test(key)) throw new Error(`?warmsnap=${key}: a hex key (the runner's)`);
  const r = await fetch(`./__snap/${key}`);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`warm snapshot ${key}: ${r.status} ${r.statusText}`);
  return decodeSnapshot(await r.arrayBuffer());
}
/** saves a capture under `key` (an error is the page's: console.error, which a check sees) */
export async function saveSnapshot(key: string, snap: Promise<WorldSnapshot>): Promise<void> {
  try {
    const r = await fetch(`./__snap/${key}`, { method: 'POST', body: encodeSnapshot(await snap) });
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    (globalThis as { __snapSaved?: string }).__snapSaved = key;
  } catch (e) {
    console.error(`warm snapshot ${key} not saved: ${(e as Error)?.message ?? e}`);
  }
}
