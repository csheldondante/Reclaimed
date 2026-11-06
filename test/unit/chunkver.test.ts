// (round 128o, DA-B9) Every writer of the columns moves the chunks' versions (sim/chunkver.ts): a writer that forgets is
// silent staleness, so the sources are held to it here, and each writer's effect on Dawn (test/gpu/chunkver.test.ts).
//  - a WGSL kernel with the columns writable (layers, layersE, colapply's slots) calls bumpChunk (or colapply's bumpOf);
//  - a TS function that writes the window's layers from the CPU (writeBuffer into them) tells WorldCore.columnsWritten
//    (or ColumnCopy's `written`), which bumps them.
import { describe, expect, it } from 'vitest';
import { readSrc, srcFiles } from '../support/source-scan';

const COLUMNS_RW = /var<storage,\s*read_write>\s*(layers|layersE|slots)\s*:\s*array<vec4<u32>>/;
const CPU_WRITE = /writeBuffer\((wg|w|world|this\.world|core\.world)\.layers\b|writeBuffer\(this\.host\.layers\(\)/;

describe('the chunks\' versions: every writer bumps', () => {
  it('every kernel with the columns writable bumps the chunks it changes', () => {
    const missing: string[] = [];
    const writers: string[] = [];
    for (const f of srcFiles(['.wgsl'])) {
      const s = readSrc(f);
      if (!COLUMNS_RW.test(s)) continue;
      writers.push(f);
      if (!/\bbumpChunk\(|\bbumpOf\(/.test(s)) missing.push(f);
    }
    expect(missing).toEqual([]);
    // (the 10 known — climate, colapply, edit, landbrush, lava, layerpull, liquid, sediment, structure, townstamp: a new
    // one is fine if it bumps; the list going short means the scan stopped seeing them)
    expect(writers.length).toBeGreaterThanOrEqual(10);
  });

  it('every CPU write of the window\'s layers tells WorldCore.columnsWritten', () => {
    const missing: string[] = [];
    for (const f of srcFiles()) {
      const s = readSrc(f);
      if (!CPU_WRITE.test(s)) continue;
      if (!/\bcolumnsWritten\(|\bwritten\?\.\(/.test(s)) missing.push(f);
    }
    expect(missing).toEqual([]);
  });
});
