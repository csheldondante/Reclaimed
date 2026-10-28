// Round 107 (`pages`, docs/PAGES.md P2.0 M1 / P2.1): how a kernel finds a window chunk's page (common.wgsl colPage).
//   ?pages=ring     the ring's wrap computed (c + Globals.ring mod the window's chunks; P2.2: the identity's slots only)
//   ?pages=table    the page table looked up in the Globals (Globals.pages: a uniform, no new binding)
//   ?pages=storage  (M1 only) the table in a read-only storage buffer at binding 37, for the kernels the M1 bench
//                   times that have a storage slot free (PAGE_STORAGE_KERNELS); every other kernel computes the ring
// All three give the same columns (scripts/pagetest.mjs); they differ only in what the lookup costs (M1:
// src/perf/pagebench.ts). The swap is made on a module's code when it is made (gpu/pipeline.ts makeModule).

export type PageAddr = 'ring' | 'table' | 'storage';

/** the build's addressing (?pages=) */
export const PAGE_ADDR: PageAddr = (() => {
  const v = typeof location === 'undefined' ? null : new URLSearchParams(location.search).get('pages');
  // (the default stays the ring until TileLand's scratch gets its own identity table: render/tileland.ts)
  if (v === null) return 'ring';
  if (v !== 'ring' && v !== 'table' && v !== 'storage') throw new Error(`?pages=${v}: ring, table or storage`);
  return v;
})();

/** the storage table's binding (M1's ?pages=storage) */
export const PAGE_TAB_BINDING = 37;

/** (M1) the kernels the bench times that take the table from storage with ?pages=storage (each module's label) */
export const PAGE_STORAGE_KERNELS = new Set(['water-flux', 'sediment', 'sediment-out', 'liquid-water-flux', 'liquid-water-jets', 'liquid-water-depth']);

const MARK = 'fn colSlot(c: vec2<u32>) -> u32 { return colSlotRing(c); } // PAGE_ADDR';
const MARK_TABLE = 'const PAGE_TABLE: bool = false; // PAGE_TABLE';

/** a module's code with colSlot the build's way; `storage`: this module takes the table from binding 37 */
export function pagesCode(code: string, storage: boolean): string {
  if (!code.includes(MARK)) return code;
  if (storage)
    return (
      code.replace(MARK, 'fn colSlot(c: vec2<u32>) -> u32 { return colSlotStore(c); }') +
      `
// (round 107, M1: ?pages=storage) the page table in a storage buffer, an entry a u32 (the slot)
@group(0) @binding(${PAGE_TAB_BINDING}) var<storage, read> pageTab: array<u32>;
fn colSlotStore(c: vec2<u32>) -> u32 { return pageTab[c.y * pagesX() + c.x]; }
`
    );
  if (PAGE_ADDR === 'table') return code.replace(MARK, 'fn colSlot(c: vec2<u32>) -> u32 { return colSlotTable(c); }').replace(MARK_TABLE, 'const PAGE_TABLE: bool = true;');
  return code;
}

/** (M1) the storage table every bind group of a storage-table layout gets (WorldGpu sets it; one live world at a time) */
export const pageTab: { buf: GPUBuffer | null; layouts: WeakSet<GPUBindGroupLayout>; storageKernels: Set<string> } = { buf: null, layouts: new WeakSet(), storageKernels: new Set() };
