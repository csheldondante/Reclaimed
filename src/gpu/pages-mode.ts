// Round 107 (`pages`, docs/PAGES.md P2.0 M1 / P2.1): how a kernel finds a window chunk's page (common.wgsl colPage).
//   ?pages=ring     the ring's wrap computed (c + Globals.ring mod the window's chunks; P2.2: the identity's slots only)
//   ?pages=table    the page table looked up in the Globals (Globals.pages: a uniform, no new binding)
//   ?pages=storage  (M1 only) the table in a read-only storage buffer at binding 61, for the kernels the M1 bench
//                   times that have a storage slot free (PAGE_STORAGE_KERNELS); every other kernel computes the ring
// All three give the same columns (scripts/pagetest.mjs); they differ only in what the lookup costs (M1:
// src/perf/pagebench.ts). The swap is made on a module's code when it is made (gpu/pipeline.ts makeModule).

export type PageAddr = 'ring' | 'table' | 'storage';

/** the build's addressing (?pages=) */
export const PAGE_ADDR: PageAddr = (() => {
  const v = typeof location === 'undefined' ? null : new URLSearchParams(location.search).get('pages');
  // (round 107: the table, P2.1 — TileLand's scratch writes its own identity table, render/tilelandgpu.ts)
  if (v === null) return 'table';
  if (v !== 'ring' && v !== 'table' && v !== 'storage') throw new Error(`?pages=${v}: ring, table or storage`);
  return v;
})();

/** the storage table's binding (M1's ?pages=storage) */
export const PAGE_TAB_BINDING = 61;

/** (M1) the kernels the bench times that take the table from storage with ?pages=storage (each module's label) */
export const PAGE_STORAGE_KERNELS = new Set(['water-flux', 'sediment', 'sediment-out', 'liquid-water-flux', 'liquid-water-jets', 'liquid-water-depth']);

const MARK = 'fn colPlace(c: vec2<u32>) -> vec2<u32> { return colPlaceRing(c); } // PAGE_ADDR';
const MARK_TABLE = 'const PAGE_TABLE: bool = false; // PAGE_TABLE';

/** does this module's code find columns (common.wgsl colSlot)? */
export function usesPages(code: string): boolean {
  return code.includes(MARK);
}

/**
 * (round 107, ?pagecheck=1: a debug build) Every kernel that can take one more storage buffer counts its lookups of a
 * chunk off the window (a neighbour's read or write past the edge that isn't guarded) in pageMiss at binding 60, an
 * entry a kernel; scripts/pagetest.mjs reads them back (WorldGpu.readPageMiss) and asserts 0. The table's clamp
 * (colPlaceTable) is robustness, not the fix: a caller off the window is a bug.
 */
export const PAGE_CHECK = typeof location !== 'undefined' && new URLSearchParams(location.search).get('pagecheck') === '1';
export const PAGE_MISS_BINDING = 60;
export const PAGE_MISS_MAX = 1024;
export const pageMiss: { buf: GPUBuffer | null; labels: string[]; unchecked: Set<string>; layouts: WeakSet<GPUBindGroupLayout> } = { buf: null, labels: [], unchecked: new Set(), layouts: new WeakSet() };

/** a module's code with colSlot the build's way; `storage`: this module takes the table from binding 61; `check`: its pageMiss entry */
export function pagesCode(code: string, storage: boolean, check?: number): string {
  if (!code.includes(MARK)) return code;
  if (check !== undefined) {
    const inner = PAGE_ADDR === 'table' ? 'colPlaceTable' : 'colPlaceRing';
    const c = code.replace(MARK, `fn colPlace(c: vec2<u32>) -> vec2<u32> { if (c.x >= pagesX() || c.y >= pagesY()) { atomicAdd(&pageMiss[${check}u], 1u); } return ${inner}(c); }`);
    return (
      (PAGE_ADDR === 'table' ? c.replace(MARK_TABLE, 'const PAGE_TABLE: bool = true;') : c) +
      `
// (round 107, ?pagecheck=1) this kernel's lookups of a chunk off the window
@group(0) @binding(${PAGE_MISS_BINDING}) var<storage, read_write> pageMiss: array<atomic<u32>>;
`
    );
  }
  if (storage)
    return (
      code.replace(MARK, 'fn colPlace(c: vec2<u32>) -> vec2<u32> { return colPlaceStore(c); }') +
      `
// (round 107, M1: ?pages=storage) the page table in a storage buffer, an entry a u32 (the slot)
@group(0) @binding(${PAGE_TAB_BINDING}) var<storage, read> pageTab: array<u32>;
fn colPlaceStore(c: vec2<u32>) -> vec2<u32> { return pageEntryPlace(pageTab[min(c.y * pagesX() + c.x, arrayLength(&pageTab) - 1u)]); }
`
    );
  if (PAGE_ADDR === 'table') return code.replace(MARK, 'fn colPlace(c: vec2<u32>) -> vec2<u32> { return colPlaceTable(c); }').replace(MARK_TABLE, 'const PAGE_TABLE: bool = true;');
  return code;
}

/** (M1) the storage table every bind group of a storage-table layout gets (WorldGpu sets it; one live world at a time) */
export const pageTab: { buf: GPUBuffer | null; layouts: WeakSet<GPUBindGroupLayout>; storageKernels: Set<string> } = { buf: null, layouts: new WeakSet(), storageKernels: new Set() };
