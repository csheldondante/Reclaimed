// (round 128o, DA-B9) The chunks' versions: per chunk the tick + 1 that last changed its columns, and (DA-B26) the
// tick + 1 that last changed its water or its places, after the chunk table in WorldGpu.chunks (shaders/chunkver.wgsl:
// a vec2 a chunk). Every writer of the columns bumps the chunks it changes, every writer of the water their water's: a
// GPU kernel by calling bumpChunk / bumpWater (gpu/pipeline.ts makeCompute then makes the table writable for it and
// appends chunkver.wgsl), the CPU by WorldGpu.bumpChunks. Readers work only on the chunks whose versions moved since
// they last looked (the first: DA-B26's GPU tile lists, sim/cull.ts). Keyed by where a chunk's columns lie (its first
// slot / 256) so a slide (the table rotating over the same storage) moves none. API: CHUNKS_READ, writerCode,
// versionIndex, waterVersionIndex, versionWords.
import chunkverWgsl from '../shaders/chunkver.wgsl?raw';
import { CHUNK, SLOT_WORDS, type PackedWorld } from '../world/layout';

/** layers.wgsl's declaration of the chunk table (read-only for every kernel that only reads the columns) */
export const CHUNKS_READ = '@group(0) @binding(1) var<storage, read> chunks: array<vec2<u32>>;';
const CHUNKS_RW = '@group(0) @binding(1) var<storage, read_write> chunks: array<vec2<u32>>;';

/**
 * A kernel's code that writes the columns or the water (it calls bumpChunk or bumpWater): the chunk table writable,
 * chunkver.wgsl after layers.wgsl. Null if it calls neither. Throws if it does without the chunk table declared.
 */
export function writerCode(code: string): string | null {
  if (!/\bbump(Chunk|Water)\(/.test(code) || code.includes('fn bumpChunk(')) return null;
  const i = code.indexOf(CHUNKS_READ);
  if (i < 0) throw new Error('chunk versions: a kernel calls bumpChunk or bumpWater without layers.wgsl (the chunk table)');
  const end = i + CHUNKS_READ.length;
  return code.slice(0, i) + CHUNKS_RW + '\n' + chunkverWgsl + code.slice(end);
}

/** window chunk ci's columns' version's index (u32 words after the table): where its columns start / 256, two words each */
export function versionIndex(p: PackedWorld, ci: number): number {
  return (p.chunkTable[ci * 2] / (CHUNK * CHUNK)) * 2;
}

/** window chunk ci's water's version's index: the word after its columns' */
export function waterVersionIndex(p: PackedWorld, ci: number): number {
  return versionIndex(p, ci) + 1;
}

/** u32 words of versions a world needs (two per 256 slots) */
export function versionWords(p: PackedWorld): number {
  return Math.ceil(p.slots.length / SLOT_WORDS / (CHUNK * CHUNK)) * 2;
}
