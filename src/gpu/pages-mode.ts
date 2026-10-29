// Round 107 (`pages`, docs/PAGES.md P2.0-P2.3): how a kernel finds a window chunk's page (common.wgsl colPlace).
//   ?pages=ring     THE GAME'S WAY (the default): the ring's wrap computed (c + Globals.ring mod the window's chunks) —
//                   the dense window's slots are the ring's places
//   ?pages=table    A TEST PATH ONLY, for ?pageperm= (shuffled slots: the identity test, scripts/pagetest.mjs): the
//                   table in the Globals, sized to the window. Never the game's: a table inside Globals made every
//                   kernel ~45 % slower on the desktop's D3D11 (scripts/kernelab.mjs; PAGES.md §1) — P2.4's sparse
//                   table gets a binding of its own. Nothing in the game branches on it; only this file, the pipeline
//                   and WorldGpu's sizing of the Globals do.
//   ?pages=storage  (M1 only) the table in a read-only storage buffer at binding 61, for the kernels the M1 bench
//                   times that have a storage slot free (PAGE_STORAGE_KERNELS); every other kernel computes the ring
// All three give the same columns (scripts/pagetest.mjs). The swap is made on a module's code when it is made
// (gpu/pipeline.ts makeModule).

export type PageAddr = 'ring' | 'table' | 'storage';

/** the build's addressing (?pages=) */
export const PAGE_ADDR: PageAddr = (() => {
  const v = typeof location === 'undefined' ? null : new URLSearchParams(location.search).get('pages');
  // (round 107, PG4: the ring computed — on the desktop's D3D11 a table in the Globals, dynamically indexed, made every
  // kernel ~45 % slower per workgroup, each of its Globals reads, not only the lookups (scripts/kernelab.mjs). The
  // table waits for a binding of its own (P2.4); ?pages=table keeps it for the identity tests and ?pageperm=)
  if (v === null) return 'ring';
  if (v !== 'ring' && v !== 'table' && v !== 'storage') throw new Error(`?pages=${v}: ring, table or storage`);
  return v;
})();

/** the storage table's binding (M1's ?pages=storage) */
export const PAGE_TAB_BINDING = 61;

/** (M1) the kernels the bench times that take the table from storage with ?pages=storage (each module's label) */
export const PAGE_STORAGE_KERNELS = new Set(['water-flux', 'sediment', 'sediment-out', 'liquid-water-flux', 'liquid-water-jets', 'liquid-water-depth']);

const MARK = 'fn colPlaceLookup(c: vec2<u32>) -> vec2<u32> { return colPlaceRing(c); } // PAGE_ADDR';
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

/**
 * (round 107, PG4) The page tables in the Globals are sized to the window (vec4s of 8 entries each), not to the
 * largest window: on the desktop's D3D11 iGPU an 18 KB Globals made every kernel ~50 % slower per workgroup, the
 * lookups or not (scripts/kernelab.mjs; DEVLOG round 107). WorldGpu sets it before any of its kernels is made.
 */
export const pageTables = { vec4: 512 };
const SIZE_MARK = 'array<vec4<u32>, 512>, // PAGE_VEC4';
const ENTRIES_MARK = 'const PAGE_ENTRIES: u32 = 4096u; // PAGE_ENTRIES';

/** the Globals' page tables sized to the window */
function sized(code: string): string {
  if (!code.includes(SIZE_MARK)) return code;
  return code.replaceAll(SIZE_MARK, `array<vec4<u32>, ${pageTables.vec4}>,`).replace(ENTRIES_MARK, `const PAGE_ENTRIES: u32 = ${pageTables.vec4 * 8}u;`);
}

/** a module's code with colSlot the build's way; `storage`: this module takes the table from binding 61; `check`: its pageMiss entry */
export function pagesCode(code0: string, storage: boolean, check?: number): string {
  const code = sized(code0);
  if (!code.includes(MARK)) return code;
  if (check !== undefined) {
    const inner = PAGE_ADDR === 'table' ? 'colPlaceTable' : 'colPlaceRing';
    const c = code.replace(MARK, `fn colPlaceLookup(c: vec2<u32>) -> vec2<u32> { if (c.x >= pagesX() || c.y >= pagesY()) { atomicAdd(&pageMiss[${check}u], 1u); } return ${inner}(c); }`);
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
      code.replace(MARK, 'fn colPlaceLookup(c: vec2<u32>) -> vec2<u32> { return colPlaceStore(c); }') +
      `
// (round 107, M1: ?pages=storage) the page table in a storage buffer, an entry a u32 (the slot)
@group(0) @binding(${PAGE_TAB_BINDING}) var<storage, read> pageTab: array<u32>;
fn colPlaceStore(c: vec2<u32>) -> vec2<u32> { return pageEntryPlace(pageTab[min(c.y * pagesX() + c.x, arrayLength(&pageTab) - 1u)]); }
`
    );
  if (PAGE_ADDR === 'table') return code.replace(MARK, 'fn colPlaceLookup(c: vec2<u32>) -> vec2<u32> { return colPlaceTable(c); }').replace(MARK_TABLE, 'const PAGE_TABLE: bool = true;');
  return code;
}

/** (M1) the storage table every bind group of a storage-table layout gets (WorldGpu sets it; one live world at a time) */
export const pageTab: { buf: GPUBuffer | null; layouts: WeakSet<GPUBindGroupLayout>; storageKernels: Set<string> } = { buf: null, layouts: new WeakSet(), storageKernels: new Set() };
