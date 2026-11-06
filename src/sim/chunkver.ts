// (round 128o, DA-B9) The chunks' versions, after a chunk table in its buffer (shaders/chunkver.wgsl: four words a
// chunk), per chunk the tick + 1 that last changed
//   its columns (any bit),
//   (DA-B26) what its surfaces read beside them (its water's class, shaders/waterclass.wgsl, or its places),
//   its water's depth at all,
//   (DA-B28) its shape as the field mesh sees it (shaders/shapekey.wgsl: a slot's ends to 1/16, its material) or the
//   structures over it.
// Every writer of the columns or the water moves them where it changes them: a GPU kernel by calling bumpColumn /
// bumpWater (gpu/pipeline.ts makeCompute then makes the table writable for it and appends chunkver.wgsl), the CPU by
// WorldGpu.bumpChunks. Readers work only where the words they follow moved: the agents' re-peel (columns and class)
// and their surfaces' water (depth) through sim/cull.ts ChangedTiles; the field mesh (shape, fieldmesh.wgsl
// changedChunk), also over the band's and the rock mesh's own tables, versioned the same way by their CPU writes.
// Keyed by where a chunk's columns lie (its first slot / 256) so a slide (the table rotating over the same storage)
// moves none. API: CHUNKS_READ, writerCode, VERSION_WORDS, VW_*, versionIndex, waterVersionIndex, depthVersionIndex,
// shapeVersionIndex, versionWords, versionChunks.
import chunkverWgsl from '../shaders/chunkver.wgsl?raw';
import waterclassWgsl from '../shaders/waterclass.wgsl?raw';
import shapekeyWgsl from '../shaders/shapekey.wgsl?raw';
import { CHUNK, SLOT_WORDS } from '../world/layout';

/** layers.wgsl's declaration of the chunk table (read-only for every kernel that only reads the columns) */
export const CHUNKS_READ = '@group(0) @binding(1) var<storage, read> chunks: array<vec2<u32>>;';
const CHUNKS_RW = '@group(0) @binding(1) var<storage, read_write> chunks: array<vec2<u32>>;';

/**
 * A kernel's code that writes the columns or the water (it calls bumpColumn or bumpWater): the chunk table writable,
 * chunkver.wgsl (and waterclass.wgsl, shapekey.wgsl, unless the code has them) after layers.wgsl. Null if it calls
 * neither. Throws if it does without the chunk table declared.
 */
export function writerCode(code: string): string | null {
  if (!/\bbump(Column|Water)\(/.test(code) || code.includes('fn bumpColumn(')) return null;
  const i = code.indexOf(CHUNKS_READ);
  if (i < 0) throw new Error('chunk versions: a kernel calls bumpColumn or bumpWater without layers.wgsl (the chunk table)');
  const end = i + CHUNKS_READ.length;
  const more = [code.includes('fn waterClassCrossed(') ? '' : waterclassWgsl, code.includes('fn shapeKey(') ? '' : shapekeyWgsl].filter((s) => s);
  return [code.slice(0, i) + CHUNKS_RW, ...more, chunkverWgsl + code.slice(end)].join('\n');
}

/** u32 words of versions a chunk has (chunkver.wgsl) */
export const VERSION_WORDS = 4;
/** the words, in a chunk's four */
export const VW_COLUMNS = 0;
export const VW_CLASS = 1;
export const VW_DEPTH = 2;
export const VW_SHAPE = 3;

/** a chunk table: per window chunk its first slot and its slots a column */
type Table = { chunkTable: Uint32Array };

/** window chunk ci's columns' version's index (u32 words after the table): where its columns start / 256, four words each */
export function versionIndex(p: Table, ci: number): number {
  return (p.chunkTable[ci * 2] / (CHUNK * CHUNK)) * VERSION_WORDS;
}

/** window chunk ci's class version's index (its water's class or its places) */
export function waterVersionIndex(p: Table, ci: number): number {
  return versionIndex(p, ci) + VW_CLASS;
}

/** window chunk ci's water depth's version's index */
export function depthVersionIndex(p: Table, ci: number): number {
  return versionIndex(p, ci) + VW_DEPTH;
}

/** window chunk ci's shape version's index (DA-B28) */
export function shapeVersionIndex(p: Table, ci: number): number {
  return versionIndex(p, ci) + VW_SHAPE;
}

/** chunks of storage a layers buffer of `slotsWords` u32 holds (versions are kept for each) */
export function versionChunks(slotsWords: number): number {
  return Math.ceil(slotsWords / SLOT_WORDS / (CHUNK * CHUNK));
}

/** u32 words of versions a world needs (four per 256 slots) */
export function versionWords(p: { slots: { length: number } }): number {
  return versionChunks(p.slots.length) * VERSION_WORDS;
}

/**
 * (round 128o, DA-B28) A chunk table the CPU writes, with its versions after it, for a source of its own (the band's,
 * the rock mesh's: render/band.ts, render/rockmesh.ts): what it writes into a chunk's storage, or a chunk pointed at
 * other storage, moves that storage's versions (every word) to a stamp of its own, counted up. The field mesh over
 * it (fieldmesh.wgsl changedChunk) rebuilds a chunk whose key moved, as over the window's.
 */
export class VersionedTable {
  buffer: GPUBuffer;
  private stamp = 0;
  private bytes: number;
  constructor(
    private device: GPUDevice,
    private make: (label: string, size: number) => GPUBuffer,
    private label: string,
    private table: Uint32Array,
    slotsWords: number,
  ) {
    this.bytes = table.byteLength;
    this.buffer = make(label, this.bytes + versionChunks(slotsWords) * VERSION_WORDS * 4);
    this.writeTable();
  }

  /** the table (its chunks pointed at their storage) written */
  writeTable(): void {
    this.device.queue.writeBuffer(this.buffer, 0, this.table);
  }

  /** these chunks' storage was written (or they point elsewhere now): their versions moved */
  bump(chunks: Iterable<number>): void {
    const v = new Uint32Array(VERSION_WORDS).fill(++this.stamp);
    for (const c of chunks) this.device.queue.writeBuffer(this.buffer, this.bytes + versionIndex({ chunkTable: this.table }, c) * 4, v);
  }

  /** room for the versions of `slotsWords` of storage: a bigger buffer, the old one's contents copied over (the caller
   *  makes its bind groups again and lets the old one go) */
  grow(slotsWords: number): GPUBuffer {
    const old = this.buffer;
    const size = this.bytes + versionChunks(slotsWords) * VERSION_WORDS * 4;
    if (size <= old.size) return old;
    this.buffer = this.make(this.label, size);
    const enc = this.device.createCommandEncoder({ label: `${this.label} grow` });
    enc.copyBufferToBuffer(old, 0, this.buffer, 0, old.size);
    this.device.queue.submit([enc.finish()]);
    return old;
  }
}
