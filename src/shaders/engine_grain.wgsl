// ---- the grain of a material, in a body's rest frame (the owner, 2026-11-15: a broken thing's "shape resembles whole
// bricks or whatever the material grain is"; BACKLOG PE22, PE35) ----------------------------------------------------------
// A material's grain cuts a body's rest lattice into grain cells: whole bricks in their courses, blocks of bedded stone,
// lumps of concrete. One function, two users:
//  - the lattice (engine_lattice.wgsl): a bond between two voxels of different grain cells is a flaw — it snaps at a
//    share of the material's give, so a hard hit parts a brittle body along its grain into chunks, not into a flexing
//    whole or into dust;
//  - the break faces (engine_settle.wgsl): the surface between two parts is drawn where the grain's boundary runs.
// The frame: the model's lattice cell plus its grain origin (the model's header: where its box's low corner stood in
// the lattice of the body it first was — a part keeps its parent's, so a brick is the same brick however often the body
// breaks), and a seed (the first body's). Nothing here reads the world: the grain travels and turns with the body.
// Numbers a material (the tuning panel; engine.ts `thresholds`): ET[GR_AT + 2m] = kind, cell size along x, along y
// (rows), up; ET[GR_AT + 2m + 1] = x the offset a course (brick: a share of a brick's length) or the jitter of the
// cells' seeds (0..1), y the break faces' roughness (cells), z the flaw (the share of the give a bond across the grain
// has; 1: no flaw), w how far its mesh corners are rounded (modelmesh.ts; 0: the cells' own corners, flat-shaded).
const GR_AT: u32 = 24u;
const GR_NONE: u32 = 0u;
const GR_BRICK: u32 = 1u;
const GR_BEDDED: u32 = 2u;
const GR_LUMPS: u32 = 3u;

fn grainA(m: u32) -> vec4<f32> { return ET[GR_AT + 2u * (m & 63u)]; }
fn grainB(m: u32) -> vec4<f32> { return ET[GR_AT + 2u * (m & 63u) + 1u]; }
fn grHash(x: u32, y: u32, z: u32) -> u32 { return pcg(x ^ pcg(y ^ pcg(z))); }
fn grRand(x: i32, y: i32, z: i32, s: u32) -> vec3<f32> {
  let h = grHash(bitcast<u32>(x) + s, bitcast<u32>(y), bitcast<u32>(z));
  return vec3<f32>(f32(h & 1023u), f32((h >> 10u) & 1023u), f32((h >> 20u) & 1023u)) / 1023.0;
}
/** How weak the joint between two grain cells of material m is: the share of the give and of the crack speed its bonds
 *  have. Grain cells hold together in clumps (a grain id's top 8 bits: grainAt): a joint between two clumps has the
 *  material's flaw, a joint inside a clump its square root (stronger) — so a wall comes apart in clumps of bricks with
 *  whole bricks at their edges, and only a harder hit takes a clump apart brick by brick. (Joints drawn at random a
 *  pair do not work: every grain cell touches many others, and a body with half its joints left is still one part.) */
fn flawOf(m: u32, ga: u32, gb: u32) -> f32 {
  let f = grainB(m).z;
  return select(sqrt(f), f, (ga >> 18u) != (gb >> 18u));
}
// a clump is this many grain cells across (HACK, BACKLOG PE36: a fixed ratio, not a number a material)
const GR_CLUMP: f32 = 2.5;
/** a model's grain frame: xyz its box's low corner in the first body's lattice, w the seed */
fn grainFrame(mh: u32) -> vec4<u32> {
  let o = bitcast<u32>(heap[mh + 2u].z);
  return vec4<u32>(o & 2047u, (o >> 11u) & 2047u, o >> 22u, bitcast<u32>(heap[mh + 2u].w));
}
fn grainFramePack(o: vec3<u32>) -> u32 { return (o.x & 2047u) | ((o.y & 2047u) << 11u) | ((o.z & 1023u) << 22u); }
/** where a lattice cell (the first body's lattice) stands in the grain's frame: the hex pattern's place, its layer's middle */
fn grainPos(c: vec3<i32>) -> vec3<f32> { return vec3<f32>(cellPos(c.xy), f32(c.z) + 0.5); }

/** smooth noise of a place in the plane, 0..1 (the beds of a stone are not flat) */
fn grNoise2(p: vec2<f32>, s: u32) -> f32 {
  let i = vec2<i32>(floor(p));
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  let a = grRand(i.x, i.y, 7, s).x;
  let b = grRand(i.x + 1, i.y, 7, s).x;
  let c = grRand(i.x, i.y + 1, 7, s).x;
  let d = grRand(i.x + 1, i.y + 1, 7, s).x;
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// A grain cell at a place: its id (never 0 where the material has a grain), and how far the place is inside it — the
// distance to the nearest other cell's side (cells; the break faces put their corners where this is 0).
struct Grain { id: u32, d: f32 };

/** jittered cells in space (scale: the place over the cell's size an axis; layer: what else tells its cells apart) */
fn grCells(q: vec3<f32>, jit: f32, layer: u32, s: u32, planar: bool, size: f32) -> Grain {
  let b = vec3<i32>(floor(q));
  var d1 = 1e9;
  var d2 = 1e9;
  var id = 0u;
  let z0 = select(-1, 0, planar);
  let z1 = select(1, 0, planar);
  for (var dz = z0; dz <= z1; dz++) {
    for (var dy = -1; dy <= 1; dy++) {
      for (var dx = -1; dx <= 1; dx++) {
        let c = b + vec3<i32>(dx, dy, dz);
        let h = grHash(bitcast<u32>(c.x) + s, bitcast<u32>(c.y) ^ (layer * 0x9e3779b9u), bitcast<u32>(c.z));
        var o = (vec3<f32>(f32(h & 1023u), f32((h >> 10u) & 1023u), f32((h >> 20u) & 1023u)) / 1023.0 - 0.5) * jit + 0.5;
        if (planar) { o.z = fract(q.z); }
        let d = length(vec3<f32>(c) + o - q);
        if (d < d1) {
          d2 = d1;
          d1 = d;
          id = h | 1u;
        } else if (d < d2) {
          d2 = d;
        }
      }
    }
  }
  var g: Grain;
  g.id = id;
  g.d = 0.5 * (d2 - d1) * size;
  return g;
}

/** the grain cell of material m at place p (the grain's frame: grainPos of a cell, or any place between): 26 bits of
 *  id — 18 of the cell's own, then 8 of the clump it is in */
fn grainAt(m: u32, p: vec3<f32>, s: u32) -> Grain {
  var g = grainCellAt(m, p, s);
  if (g.id == 0u) { return g; }
  let A = grainA(m);
  let clump = grCells(p / (GR_CLUMP * vec3<f32>(A.y, max(A.y, A.z * ROW_H), max(A.w, 0.5 * A.y))), 1.0, 0x77u, s ^ 0x5bd1u, false, 1.0).id;
  g.id = ((g.id >> 8u) & 0x3ffffu) | (((clump >> 8u) & 0xffu) << 18u);
  return g;
}
fn grainCellAt(m: u32, p: vec3<f32>, s: u32) -> Grain {
  let A = grainA(m);
  let B = grainB(m);
  let kind = u32(A.x);
  var g: Grain;
  g.id = 0u;
  g.d = 1e9;
  if (kind == GR_BRICK) {
    // courses A.w high; in a course, bricks A.y long along x, each course set off by B.x of a brick; A.z rows deep
    let k = floor(p.z / A.w);
    let u = (p.x + 0.25) / A.y + B.x * k;
    // (a row's middle is at (row + 0.5) x ROW_H — common.wgsl cellPos — so the joints run between the rows. It had + 0.5
    // here, which put every row's middle exactly on a joint: which brick a voxel was in went by a float's rounding.)
    let v = p.y / (A.z * ROW_H);
    let i = floor(u);
    let j = floor(v);
    g.id = grHash(bitcast<u32>(i32(i)) + s, bitcast<u32>(i32(j)), bitcast<u32>(i32(k))) | 1u;
    let fu = fract(u);
    let fv = fract(v);
    let fw = fract(p.z / A.w);
    g.d = min(min(min(fu, 1.0 - fu) * A.y, min(fv, 1.0 - fv) * A.z * ROW_H), min(fw, 1.0 - fw) * A.w);
    return g;
  }
  if (kind == GR_BEDDED) {
    // beds A.w thick, their planes rolling a little; in a bed, blocks A.y across, their joints not lined up bed to bed
    let zb = (p.z + 0.8 * (grNoise2(p.xy / 5.0, s) - 0.5)) / A.w;
    let k = floor(zb);
    g = grCells(vec3<f32>(p.xy / A.y, zb), B.x, bitcast<u32>(i32(k)) + 1u, s, true, A.y);
    let fw = fract(zb);
    g.d = min(g.d, min(fw, 1.0 - fw) * A.w);
    return g;
  }
  if (kind == GR_LUMPS) {
    return grCells(p / vec3<f32>(A.y, A.y, A.w), B.x, 0u, s, false, min(A.y, A.w));
  }
  return g;
}
