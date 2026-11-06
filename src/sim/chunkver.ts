// (round 128o, DA-B9) The chunks' versions: per chunk the tick + 1 that last changed its columns, after the chunk table
// in WorldGpu.chunks (shaders/chunkver.wgsl). Every writer of the columns bumps the chunks it changes: a GPU kernel by
// calling bumpChunk (gpu/pipeline.ts makeCompute then makes the table writable for it and appends chunkver.wgsl), the
// CPU by WorldGpu.bumpChunks. Readers work only on the chunks whose version moved since they last looked (the first:
// DA-B9's indirect culled dispatch, its own row). Keyed by where a chunk's columns lie — its first slot / 256 — so a
// slide (the table rotating over the same storage) moves none. API: CHUNKS_READ, writerParts, versionIndex,
// versionWords.
import chunkverWgsl from '../shaders/chunkver.wgsl?raw';
import { CHUNK, SLOT_WORDS, type PackedWorld } from '../world/layout';

/** layers.wgsl's declaration of the chunk table (read-only for every kernel that only reads the columns) */
export const CHUNKS_READ = '@group(0) @binding(1) var<storage, read> chunks: array<vec2<u32>>;';
const CHUNKS_RW = '@group(0) @binding(1) var<storage, read_write> chunks: array<vec2<u32>>;';

/**
 * A kernel's code that writes the columns (it calls bumpChunk): the chunk table writable, chunkver.wgsl after
 * layers.wgsl. Null if the code doesn't call bumpChunk. Throws if it does without the chunk table declared.
 */
export function writerCode(code: string): string | null {
  if (!/\bbumpChunk\(/.test(code) || code.includes('fn bumpChunk(')) return null;
  const i = code.indexOf(CHUNKS_READ);
  if (i < 0) throw new Error('chunk versions: a kernel calls bumpChunk without layers.wgsl (the chunk table)');
  const end = i + CHUNKS_READ.length;
  return code.slice(0, i) + CHUNKS_RW + '\n' + chunkverWgsl + code.slice(end);
}

/** chunk ci's version's index (u32 words after the table): where its columns start / 256 */
export function versionIndex(p: PackedWorld, ci: number): number {
  return p.chunkTable[ci * 2] / (CHUNK * CHUNK);
}

/** u32 words of versions a world needs (its slots / 256, even) */
export function versionWords(p: PackedWorld): number {
  const n = Math.ceil(p.slots.length / SLOT_WORDS / (CHUNK * CHUNK));
  return n + (n & 1);
}
