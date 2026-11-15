// ---- the physics engine: rigid rows (DESIGN §10; docs/design/PHYSICS_ENGINE.md, build step 1) ----------------------
// Bodies are rows in structure-of-arrays buffers; each stage of a fixed step is a dispatch over the rows awake (an
// index list compacted on the GPU, the dispatches indirect: a row asleep is read once a tick by `compact` and by
// nothing else). Step 1: integration, fine collision against the terrain's columns, the contact solve with the agreed
// rules, sleep decided here. Nothing is read back. Host: src/engine/engine.ts (the layouts are mirrored there).
//
// A row r:
//   pose[4r]     xyz its centre of mass when the tick began (drawn between this and now); asleep, w is the surface
//                pass's word (u32 bits) of the column under it when it fell asleep: its ground, watched by `compact`
//   pose[4r+1]   its rotation then (body frame -> world; the body frame is the world's at spawn)
//   pose[4r+2]   xyz its centre of mass, w its inverse mass (< 0: the row is freed)
//   pose[4r+3]   its rotation
//   vel[2r]      xyz velocity (cells/s), w how long it has been still (s)
//   vel[2r+1]    xyz spin (rad/s, world), w its bound radius
//   info[4r]     xyz the diagonal of its inverse inertia (body frame), w flags (u32 bits)
//   info[4r+1]   xyz the off-diagonal (xy, xz, yz), w its mass
//   info[4r+2]   u32 bits: first sample (sAt), samples, material | loose << 8; w (f32) a cell's mass
//   info[4r+3]   u32 bits: its model (a heap index, hAt; 0 none), its deform slot while ROW_DEFORM, 0, 0
// Rows the host adds have even indices, rows the GPU makes (settle) odd ones: neither needs the other's count.
// Samples and the heap (models, meshes) are each one buffer in two halves, the host's first then the GPU's: an index
// with bit 31 set counts from where the GPU's half starts (sAt, hAt), so either half grows without the other knowing.
// A sample (the surface cells of its one baked voxel model, body frame, about the centre of mass):
//   samples[s]   xyz, w its radius (half its cell's edge; < 0: eroded away)
//   contacts[4s..4s+3]  two contacts a sample (the ground under it; the deepest wall beside it), each
//                [normal xyz, depth (cells; < 0 a gap; <= NO_CONTACT none)] [material, granular 0/1, its impulse this substep, the speed out a hit is given]
const ROW_ALIVE: u32 = 1u;
const ROW_ASLEEP: u32 = 2u;
// (build step 2) its impact passed its material's threshold this tick: `expand` gives it particles (engine_deform.wgsl)
const ROW_EXPAND: u32 = 4u;
// its particles carry it (the lattice deforms it): no rigid kernel visits it till it settles
const ROW_DEFORM: u32 = 8u;
// no room for its particles this tick: it stays rigid (cleared at the end of the next tick)
const ROW_DENIED: u32 = 16u;
const NONE: u32 = 0xffffffffu;
const NO_CONTACT: f32 = -1e8;
// the list buffer (u32): [0] workgroups of 64 awake rows, [1] 1, [2] 1 (an indirect dispatch's arguments), [3] rows
// awake, [4] rows awake, [5] 1, [6] 1 (a workgroup a row), [7] spare, then the rows awake from LIST_AT
const LIST_AT: u32 = 8u;
// the event buffer (u32): [0] workgroups of 64 events, [1] 1, [2] 1, [3] events this tick, then EV_WORDS a event from
// EV_AT: [kind, row, column (a per-column buffer's index) or 0, material] [point xyz, energy or volume as f32 bits]
const EV_AT: u32 = 4u;
const EV_WORDS: u32 = 8u;
const EV_IMPACT: u32 = 1u;
const EV_ERODE: u32 = 2u;

struct EngU {
  // x substep (s), y friction, z restitution, w the fastest an overlap is pushed out (cells/s)
  a: vec4<f32>,
  // overlap allowed: x slop, y k, z exponent, w cap (slop + min(cap, k * cells^p))
  b: vec4<f32>,
  // x erode depth (past the slop), y rest speed, z rest spin, w rest time
  c: vec4<f32>,
  // x air drag (1/s), y spin damping (1/s), z step up (a ledge this high isn't a wall), w an impact's least energy for an event
  d: vec4<f32>,
  // x how near a gap is still a contact (cells), y the event buffer's room (as f32), z ground damping (1/s)
  f: vec4<f32>,
  // x the rows' room (every row slot is read by `compact`), y commands, z solver passes, w bits: 1 the heightfield
  // fast path, 2 the tick's first substep, 4 deformation on (build step 2), 8 still bodies settle into rows (letter D)
  e: vec4<u32>,
  // (build step 2, engine_deform.wgsl) x the pages' room, y the slots' room, z pages a slot's table holds, w the tick
  g: vec4<u32>,
  // where the pool's parts start: x the free pages' stack, y the free slots', z the free rows', w the slots' sums
  h: vec4<u32>,
  // where dmeta's parts start: x the pages' owners, y the slots' records, z the slots' page tables; w draw room (triangles)
  i: vec4<u32>,
  // x where the samples' GPU half starts, y its room, z where the heap's GPU half starts, w its room
  j: vec4<u32>,
  // x still speed (cells/s), y still time (s), z crumb size (voxels), w the lattice's substep (s)
  k: vec4<f32>,
  // x the lattice's solver iterations, y spare, z the lattice's substeps a tick, w spare
  l: vec4<u32>,
};
// an impact's energy over the body's mass past which it deforms, a material (0: never)
@group(0) @binding(17) var<uniform> ET: array<vec4<f32>, 12>;
fn expandAt(m: u32) -> f32 { return ET[(m & 63u) >> 2u][m & 3u]; }
fn sAt(i: u32) -> u32 { return select(i, EU.j.x + (i & 0x7fffffffu), (i >> 31u) == 1u); }
fn hAt(i: u32) -> u32 { return select(i, EU.j.z + (i & 0x7fffffffu), (i >> 31u) == 1u); }
@group(0) @binding(3) var<uniform> EU: EngU;
// what the host asks this tick (engine.ts): a xyz + w, b: kind (1 a velocity change dv = a.xyz to row b.y, 2 wake row
// b.y, 3 wake every row within a.w of a.xyz, 4 move every row by a.xyz — the window slid, 5 row b.y deforms now
// whatever hit it — a lab's button, a test — 6 the deforming body of row b.y is let go, or with b.y NONE all of them)
struct EngCmd { a: vec4<f32>, b: vec4<u32> };
@group(0) @binding(16) var<uniform> EC: array<EngCmd, 16>;
@group(0) @binding(4) var<storage, read_write> pose: array<vec4<f32>>;
@group(0) @binding(5) var<storage, read_write> vel: array<vec4<f32>>;
@group(0) @binding(6) var<storage, read_write> info: array<vec4<f32>>;
@group(0) @binding(7) var<storage, read_write> samples: array<vec4<f32>>;
@group(0) @binding(8) var<storage, read_write> contacts: array<vec4<f32>>;

fn rowFlags(r: u32) -> u32 { return bitcast<u32>(info[4u * r].w); }
fn eqrot(q: vec4<f32>, v: vec3<f32>) -> vec3<f32> {
  let t = 2.0 * cross(q.xyz, v);
  return v + q.w * t + cross(q.xyz, t);
}
fn eqinv(q: vec4<f32>) -> vec4<f32> { return vec4<f32>(-q.xyz, q.w); }
