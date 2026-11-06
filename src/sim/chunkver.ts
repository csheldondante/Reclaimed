// (round 128o, DA-B9) The chunks' versions: per chunk the tick + 1 that last changed its columns, and (DA-B26) what its
// surfaces read beside them (its water's class, shaders/waterclass.wgsl, or its places), and its water's depth at all,
// after the chunk table in WorldGpu.chunks (shaders/chunkver.wgsl: four words a chunk). Every writer of the columns
// bumps the chunks it changes, every writer of the water their water's: a GPU kernel by calling bumpChunk / bumpWater
// (gpu/pipeline.ts makeCompute then makes the table writable for it and appends chunkver.wgsl), the CPU by
// WorldGpu.bumpChunks. Readers work only on the chunks whose versions moved since they last looked (sim/cull.ts
// ChangedTiles): the agents' re-peel (columns and class: agents.ts encodeScoped) and their surfaces' water (depth: the
// units wade, drown and put out fire by it). Keyed by where a chunk's columns lie (its first slot / 256) so a slide
// (the table rotating over the same storage) moves none. API: CHUNKS_READ, writerCode, VERSION_WORDS, versionIndex,
// waterVersionIndex, depthVersionIndex, versionWords.
import chunkverWgsl from '../shaders/chunkver.wgsl?raw';
import waterclassWgsl from '../shaders/waterclass.wgsl?raw';
import { CHUNK, SLOT_WORDS, type PackedWorld } from '../world/layout';

/** layers.wgsl's declaration of the chunk table (read-only for every kernel that only reads the columns) */
export const CHUNKS_READ = '@group(0) @binding(1) var<storage, read> chunks: array<vec2<u32>>;';
const CHUNKS_RW = '@group(0) @binding(1) var<storage, read_write> chunks: array<vec2<u32>>;';

/**
 * A kernel's code that writes the columns or the water (it calls bumpChunk or bumpWater): the chunk table writable,
 * chunkver.wgsl (and waterclass.wgsl, unless the code has it) after layers.wgsl. Null if it calls neither. Throws if
 * it does without the chunk table declared.
 */
export function writerCode(code: string): string | null {
  if (!/\bbump(Chunk|Water)\(/.test(code) || code.includes('fn bumpChunk(')) return null;
  const i = code.indexOf(CHUNKS_READ);
  if (i < 0) throw new Error('chunk versions: a kernel calls bumpChunk or bumpWater without layers.wgsl (the chunk table)');
  const end = i + CHUNKS_READ.length;
  const cls = code.includes('fn waterClassCrossed(') ? [] : [waterclassWgsl];
  return [code.slice(0, i) + CHUNKS_RW, ...cls, chunkverWgsl + code.slice(end)].join('\n');
}

/** u32 words of versions a chunk has: its columns', its surfaces' other inputs' (water class, places), its water's
 *  depth's, one unused (chunkver.wgsl) */
export const VERSION_WORDS = 4;

/** window chunk ci's columns' version's index (u32 words after the table): where its columns start / 256, four words each */
export function versionIndex(p: PackedWorld, ci: number): number {
  return (p.chunkTable[ci * 2] / (CHUNK * CHUNK)) * VERSION_WORDS;
}

/** window chunk ci's class version's index (its water's class or its places): the word after its columns' */
export function waterVersionIndex(p: PackedWorld, ci: number): number {
  return versionIndex(p, ci) + 1;
}

/** window chunk ci's water depth's version's index */
export function depthVersionIndex(p: PackedWorld, ci: number): number {
  return versionIndex(p, ci) + 2;
}

/** u32 words of versions a world needs (four per 256 slots) */
export function versionWords(p: PackedWorld): number {
  return Math.ceil(p.slots.length / SLOT_WORDS / (CHUNK * CHUNK)) * VERSION_WORDS;
}
