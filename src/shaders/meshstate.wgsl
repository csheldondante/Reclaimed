// ---- the field mesh's state: its published layout (round 83) ------------------
// The field mesh (render/fieldmesh.ts, fieldmesh.wgsl binding 9) owns this buffer; what reads it from outside
// (the LOD rings: atlas/far.wgsl meshBuilt) includes this, never its own copy of the numbers.
// CHUNK0 words, then CSTRIDE a chunk (its record), then a word a chunk (near the view), then four a mesh
// range (its translation), then three (the rebuild's dispatch). In a chunk's record:
const CHUNK0: u32 = 16u;
const CSTRIDE: u32 = 14u;
/** word 0: its indices drawn (drawIndexedIndirect's first word) */
const MS_INDICES: u32 = 0u;
/** word 5: the hash it was built for — FRESH (or 0): not built */
const MS_BUILT: u32 = 5u;
const FRESH: u32 = 0x9e3779b9u;
