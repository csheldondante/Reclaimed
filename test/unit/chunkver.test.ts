// (round 128o, DA-B9) Every writer of the columns moves the chunks' versions (sim/chunkver.ts): a writer that forgets is
// silent staleness, so the sources are held to it here, and each writer's effect on Dawn (test/gpu/chunkver.test.ts).
//  - a WGSL kernel with the columns writable (layers, layersE, colapply's slots) calls bumpChunk (or colapply's bumpOf);
//  - a TS function that writes the window's layers from the CPU (writeBuffer into them) tells WorldCore.columnsWritten
//    (or ColumnCopy's `written`), which bumps them.
//  - (DA-B26) a WGSL kernel with the water writable (water, the depth pass's waterOut, the flow's open runs and waterB)
//    calls bumpWater; a TS file that writes the window's water from the CPU tells WorldCore.columnsWritten.
import { describe, expect, it } from 'vitest';
import { readSrc, srcFiles } from '../support/source-scan';

const COLUMNS_RW = /var<storage,\s*read_write>\s*(layers|layersE|slots)\s*:\s*array<vec4<u32>>/;
const CPU_WRITE = /writeBuffer\((wg|w|world|this\.world|core\.world)\.layers\b|writeBuffer\(this\.host\.layers\(\)/;
const WATER_RW = /var<storage,\s*read_write>\s*(water|waterOut|waterB|open)\s*:\s*array<f32>/;
/** a writeBuffer into the window's water, or a loop of writes over it with its next and previous */
const CPU_WATER = /writeBuffer\((wg|w|world|this\.world|core\.world)\.water\b|of \[(wg|w|world)\.water\b|of \['water', 'waterNext'/;

describe("the chunks' versions: every writer bumps", () => {
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

  it("every CPU write of the window's layers tells WorldCore.columnsWritten", () => {
    const missing: string[] = [];
    for (const f of srcFiles()) {
      const s = readSrc(f);
      if (!CPU_WRITE.test(s)) continue;
      if (!/\bcolumnsWritten\(|\bwritten\?\.\(/.test(s)) missing.push(f);
    }
    expect(missing).toEqual([]);
  });

  it("every kernel with the water writable bumps the water's version (DA-B26)", () => {
    const missing: string[] = [];
    const writers: string[] = [];
    for (const f of srcFiles(['.wgsl'])) {
      const s = readSrc(f);
      if (!WATER_RW.test(s)) continue;
      writers.push(f);
      if (!/\bbumpWater\(/.test(s)) missing.push(f);
    }
    expect(missing).toEqual([]);
    // (the 6 known: climate, edit, lava, liquid, placeop, water_depth)
    expect(writers.length).toBeGreaterThanOrEqual(6);
  });

  it("every CPU write of the window's water tells WorldCore.columnsWritten (DA-B26)", () => {
    const missing: string[] = [];
    const writers: string[] = [];
    for (const f of srcFiles()) {
      const s = readSrc(f);
      if (!CPU_WATER.test(s)) continue;
      writers.push(f);
      if (!/\bcolumnsWritten\(/.test(s)) missing.push(f);
    }
    expect(missing).toEqual([]);
    // (the warp and WorldCore's replaceWindow)
    expect(writers.length).toBeGreaterThanOrEqual(2);
  });
});
