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
//   info[4r+3]   u32 bits: its model (a heap index, hAt; 0 none), its deform slot while ROW_DEFORM, (f32) the height
//                it was grabbed at while ROW_GRAB, 0
// Rows the host adds have even indices, rows the GPU makes (settle) odd ones: neither needs the other's count.
// Samples and the heap (models, meshes) are each one buffer in two halves, the host's first then the GPU's: an index
// with bit 31 set counts from where the GPU's half starts (sAt, hAt), so either half grows without the other knowing.
// The awake list's buffer also holds the tick's work words, RWW a row from LIST_AT + the rows' room (rwAt): what the
// pair solver accumulates into a row from every pair it is in, as fixed-point atomics (the same sums in any order).
//   RW_DV, RW_DW   velocity and spin changes waiting to be taken (i32, 1/FPV): an awake row's by `rowSolve`; a
//                  sleeper's, stamped to wake, by the next tick's `compact`
//   RW_N           its pair contact rows this tick (tick & 0xffff) << 16 | count: the mass a contact may take
//   RW_FLAGS       this substep (RF_*): it touches a body, it is held (a room ran out: `missing`), it is to deform
//   RW_PUSH        position corrections out of overlaps (i32, 1/FPP), RW_PUSHN how many
//   RW_V, RW_W     its velocity and spin after gravity (f32 bits), for the terrain pass's weighing of a hit
//   RW_ENERGY      a sleeper's hardest hit while stamped (f32 bits): `compact` weighs it for deformation as it wakes
//   RW_WAKE        the tick a pair asked this sleeper to wake (`compact` wakes it the tick after)
const RWW: u32 = 40u;
const RW_DV: u32 = 0u;
const RW_DW: u32 = 3u;
const RW_N: u32 = 6u;
const RW_FLAGS: u32 = 7u;
const RW_PUSH: u32 = 8u;
const RW_PUSHN: u32 = 11u;
const RW_V: u32 = 12u;
const RW_W: u32 = 15u;
const RW_ENERGY: u32 = 18u;
const RW_WAKE: u32 = 19u;
// what the deforming voxels touching this row gave it since it last took them (engine_meet.wgsl): velocity and spin
// changes (i32, 1/FPM) — an awake row's taken by `integrate` at the next tick's start, a sleeper's stamped to wake by
// `compact` — the contacts counted (a contact a voxel a lattice substep), last tick's count (the mass a contact may
// take), the fastest closing among them (f32 bits), a sleeper's: what the voxels it stopped would have given it
// (mass x closing, 1/256), and whether a voxel tougher than the row lies deep in it
const RW_MDV: u32 = 20u;
const RW_MDW: u32 = 23u;
const RW_MN: u32 = 26u;
const RW_MNP: u32 = 27u;
const RW_MC: u32 = 28u;
const RW_MP: u32 = 29u;
const RW_MX: u32 = 30u;
// The support a row has from the voxels under it. The reaction above comes a tick late (the lattice steps after the
// rigid substeps), so a row resting on voxels would sink by a tick of gravity every tick, and voxels are never pushed
// out. So what the voxels gave it is offered again before it moves: RW_MT the voxels touching it this tick and
// RW_MNS the sum of their normals (i32, 1/1024) give the way it is held; RW_MCAP (f32 bits) is the most the hold may
// take this tick — what the hold took last tick and what the voxels' reaction added along that way — and RW_MUSED
// what it has taken so far. It only ever stops an approach, by no more than the voxels have shown they bear.
const RW_MT: u32 = 31u;
const RW_MNS: u32 = 32u;
const RW_MCAP: u32 = 35u;
const RW_MUSED: u32 = 36u;
// (the way it is held this tick, three f32s, kept by the tick's first substep for the later ones)
const RW_MH: u32 = 37u;
const FPM: f32 = 1048576.0;
const RF_TOUCH: u32 = 1u;
const RF_HOLD: u32 = 2u;
const RF_EXPAND: u32 = 4u;
// (this substep) the row is clear of the ground: it has no terrain rows and none is read (engine_ground.wgsl)
const RF_AIR: u32 = 8u;
const FPV: f32 = 4096.0;
const FPP: f32 = 65536.0;
// the list's header word that is the sleep epoch (the coarse pass reads it: it goes up whenever a row falls asleep,
// wakes, is made asleep or is moved asleep; never cleared)
const LIST_EPOCH: u32 = 7u;
// A sample (the surface cells of its one baked voxel model, body frame, about the centre of mass):
//   samples[s]   xyz, w its radius (half its cell's edge; < 0: eroded away)
//   contacts[4s..4s+3]  two contacts a sample (the ground under it; the deepest wall beside it), each
//                [normal xyz, depth (cells; < 0 a gap; <= NO_CONTACT none)] [material, granular 0/1, its impulse this substep, the speed out a hit is given]
const ROW_ALIVE: u32 = 1u;
const ROW_ASLEEP: u32 = 2u;
// (build step 2) its impact passed its material's threshold this tick: `expand` gives it particles (engine_deform.wgsl)
const ROW_EXPAND: u32 = 4u;
// its particles carry it (the lattice deforms it): no rigid kernel moves it till it settles. It is in the awake list
// all the same, so the coarse pass pairs it with the rows near it: its centre and bound radius are its voxels' (kept
// by `slots`, engine_deform.wgsl) and its rotation is the zero quaternion, which tells the pair passes it has no rigid
// shape (the coarse pass tests its sphere only, the fine pass gives it no samples: its voxels meet the rows of its
// pairs themselves, engine_meet.wgsl)
const ROW_DEFORM: u32 = 8u;
// no room for its particles this tick: it stays rigid (cleared at the end of the next tick)
const ROW_DENIED: u32 = 16u;
// asleep, and listed so in the draw list (engine_draw.wgsl: the triangles of rows asleep are placed once, not every
// frame); `compact` asks for the list again when a row's sleep and this bit disagree
const ROW_LISTED_ASLEEP: u32 = 32u;
// a row settle made, asleep where its particles stood: `compact` gives it the ground's word it sleeps on
const ROW_NEWSLEEP: u32 = 64u;
// the host's grab holds it (the pool's P_GRAB names it; `compact` sets and clears this every tick): a spring pulls its
// centre to the host's target (grabPull) and it does not fall asleep
const ROW_GRAB: u32 = 128u;
// A part settle made, while its body's particles stand in for its collision shape (it has no distance field of its
// own yet: engine_deform.wgsl S_HELD): it stays asleep where it is — no wake, no impulse — or it would leave its
// collider behind. (256 since the merge into physics10-one: 128 is the grab's)
const ROW_HELD: u32 = 256u;
// (DESIGN §3, §10 "At rest"; engine_claim.wgsl) asleep, its space is claimed in the columns as External intervals that
// name it: `compact` sets this when it gives the claim's write a job, and clears it when it gives its clearing one
const ROW_CLAIMED: u32 = 512u;
// asleep and too wide for a tick's claim jobs (CJ_MAX chunks): it claims nothing (counted once: P_CLAIM_BIG)
const ROW_NOCLAIM: u32 = 1024u;
// ---- a row's claim (sim/external.ts "GPU-owned rows" has the contract; mirrored there and in colapply.wgsl) ----------
// An External interval's word 3 names its owner: bits 29-31 the owner's kind (OWN_ROW: an engine row), bit 28 the row's
// own (its underside stood on something when it was claimed: the support watch, engine_ground.wgsl), bits 20-27 the
// claim's generation (1..255: a row used again never owns a dead claim), bits 0-19 the row.
const OWN_KIND_MASK: u32 = 0xe0000000u;
const OWN_ROW: u32 = 0x20000000u;
const OWN_SUP: u32 = 0x10000000u;
fn ownIsRow(w: u32) -> bool { return (w & OWN_KIND_MASK) == OWN_ROW; }
fn ownRowOf(w: u32) -> u32 { return w & 0xfffffu; }
fn ownGenOf(w: u32) -> u32 { return (w >> 20u) & 0xffu; }
fn ownWord(row: u32, gen: u32, sup: bool) -> u32 { return OWN_ROW | select(0u, OWN_SUP, sup) | ((gen & 0xffu) << 20u) | (row & 0xfffffu); }
// The claims' table (u32; engine.ts `claimT`): [0] the tick's jobs (cleared by the host each tick, with the locks),
// [CJ_LOCK ..] a bit a window chunk: a job writes it this tick (two jobs never write one column), [CJ_AT ..] CJ_MAX
// jobs of CJ_WORDS: [row, op (1 write, 2 clear) | generation << 8 | material << 16, chunk x | chunk y << 16, spare],
// then CR_WORDS a row from CR_AT: [0] its generation counter, [1] its live claim's generation (0: none; the orphan
// pass reads this word), [2] the claim's first column x | y << 16, [3] its columns across | down << 16
const CJ_LOCK: u32 = 8u;
const CJ_LOCK_WORDS: u32 = 128u;
const CJ_AT: u32 = 136u;
const CJ_WORDS: u32 = 4u;
const CJ_MAX: u32 = 32u;
const CR_AT: u32 = 264u;
const CR_WORDS: u32 = 4u;
const CJ_WRITE: u32 = 1u;
const CJ_CLEAR: u32 = 2u;
// the pool's header words of the claims: live claims; jobs that found no room in their tick (it only goes up: the host
// keeps ticking while it moves); claimed spans a column had no free slot for (DA-P3); rows too wide to claim
const P_CLAIMS: u32 = 43u;
const P_CLAIM_WAIT: u32 = 44u;
const P_CLAIM_FULL: u32 = 45u;
const P_CLAIM_BIG: u32 = 46u;
// the tick + 1 `tground` last made again a chunk that holds a row's live claim, or in which one was cut (engine_ground.wgsl):
// the ground by a sleeper is changing. The host's read sees the word move and keeps ticking, so the support watch is
// run for as long as an edit goes on changing those columns (a dig takes a cell a tick: the claim is gone, and its row
// woken, ticks after the host's event)
const P_CLAIM_STIR: u32 = 47u;
// the pool's header word that asks for the draw list again (engine_deform.wgsl has the rest of the header)
const P_DL_DIRTY: u32 = 20u;
// the pool's header word `compact` adds to for every row it finds waiting to deform (ROW_EXPAND), each tick it waits:
// it only ever goes up. The host reads it with the header and encodes stage 4 when it has moved (engine.ts s4Open)
const P_EXPAND_WAIT: u32 = 40u;
// the pool's header word that is the host's grab (engine.ts grab): 0 none, else (4095 - how far along the pick ray
// its centre is, in 1/4 cells) << 20 | the row — the greatest is the nearest the eye, taken by `compact` with an
// atomic max the tick the command comes (rows past 2^20 cannot be named: the rows' room is far under it). The height
// of the plane it is dragged in — its centre's when the hold began — is the row's own: info[4r+3].z
const P_GRAB: u32 = 23u;
// 1 in a tick the draw list is made again (`drawArm`): the list's two kernels, dispatched direct, read it
const P_DL_MAKING: u32 = 41u;
const NONE: u32 = 0xffffffffu;
const NO_CONTACT: f32 = -1e8;
// the list buffer (u32): [0] workgroups of 64 awake rows, [1] 1, [2] 1 (an indirect dispatch's arguments), [3] rows
// awake, [4] rows awake, [5] 1, [6] 1 (a workgroup a row), [7] the sleep epoch, then the rows awake from LIST_AT, then
// the rows' work words (rwAt)
const LIST_AT: u32 = 8u;
// the event buffer (u32): [0] workgroups of 64 events, [1] 1, [2] 1, [3] events this tick, then EV_WORDS a event from
// EV_AT: [kind, row, column (a per-column buffer's index) or 0, material] [point xyz, energy or volume as f32 bits]
const EV_AT: u32 = 4u;
const EV_WORDS: u32 = 8u;
const EV_IMPACT: u32 = 1u;
const EV_ERODE: u32 = 2u;
/** (PA10) the hits on owners' matter kept after the events' room: engine.ts HIT_ROOM (pushHit) */
const HIT_ROOM: u32 = 16u;
/** (PQ3) a hit on the ground itself joins that ring from this energy up, its energy stored negative (an owner's hit
 *  is positive): the host hands it to the edit pass as a blow (Integrity.groundBlow), which decides what the ground
 *  does. 1000 is the lowest `impact.groundEnergy` can be tuned to (tune/params.ts), so no blow that could crumble
 *  ground is kept from the host and the small ones do not crowd the ring. */
const HIT_GROUND_MIN: f32 = 1000.0;

struct EngU {
  // x substep (s), y friction, z restitution, w the fastest an overlap is pushed out (cells/s)
  a: vec4<f32>,
  // overlap allowed: x slop, y k, z exponent, w cap (slop + min(cap, k * cells^p))
  b: vec4<f32>,
  // x erode depth (past the slop), y rest speed, z rest spin, w rest time
  c: vec4<f32>,
  // x air drag (1/s), y spin damping (1/s), z step up (a ledge this high isn't a wall), w an impact's least energy for an event
  d: vec4<f32>,
  // x how near a gap is still a contact (cells), y the event buffer's room (as f32), z ground damping (1/s), w break
  // face roughness (cells)
  f: vec4<f32>,
  // x the rows' room (every row slot is read by `compact`), y commands, z solver passes, w bits: 1 the heightfield
  // fast path, 2 the tick's first substep, 4 deformation on (build step 2), 8 still bodies settle into rows (letter D),
  // 16 a hard hit between bodies, or a deep overlap, hands a body to stage 4 (engine_pairs.wgsl), 32 a settled
  // body's particles stand in for its parts' collision shapes (engine_deform.wgsl S_HELD), 64 they stand only till
  // each part's own distance field is baked on the GPU (engine_partsdf.wgsl: the default), 256 a bench's held
  // scene (rowFinish moves nothing and nothing falls asleep: Engine.hold)
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
  // x the lattice's solver iterations, y break face smoothing (f32 bits), z the lattice's substeps a tick, w which
  // substep of the tick this is (the rigid rows': `integrate` and `tfine` keep a terrain list a substep)
  l: vec4<u32>,
  // (body against body, engine_pairs.wgsl) x a sleeper wakes when a hit's energy over its mass passes this, y the
  // share of a pair's kept impulse it starts the next tick with, z what a rim row's depth is given back (cells), w the
  // margin of the row's test against the ground tops (cells; engine_ground.wgsl)
  m: vec4<f32>,
  // x the pair solver's iterations a substep, y the pairs' room, z the pair slots' room, w the old slots' room (a
  // growth's remap)
  n: vec4<u32>,
  // (the host's grab, engine.ts grabTarget) xyz a point on the finger's view ray, w > 0.5 while the grab is held
  o: vec4<f32>,
  // the grab's spring: x stiffness (1/s²), y damping (share of critical), z the most it accelerates a row (cells/s²)
  p: vec4<f32>,
  // xyz the finger's view ray's direction (unit), w how far over the height it was grabbed at the row is held
  q: vec4<f32>,
  // (the look; moved twice by merges: l.w is the substep's, o the grab's) x the share of a hit's shock that passes a
  // bond, yzw spare
  r: vec4<f32>,
};
// Numbers a material (engine.ts `thresholds`): [0..11] an impact's energy over the body's mass past which it deforms
// (0: never); [12..23] the share of the speed into a contact a rigid row is given back (bounceAt: for the rigid solve,
// which reads EU.a.z for every material until it takes this); from 24 the grain (engine_grain.wgsl)
@group(0) @binding(17) var<uniform> ET: array<vec4<f32>, 120>;
fn expandAt(m: u32) -> f32 { return ET[(m & 63u) >> 2u][m & 3u]; }
fn bounceAt(m: u32) -> f32 { return ET[12u + ((m & 63u) >> 2u)][m & 3u]; }
fn sAt(i: u32) -> u32 { return select(i, EU.j.x + (i & 0x7fffffffu), (i >> 31u) == 1u); }
fn hAt(i: u32) -> u32 { return select(i, EU.j.z + (i & 0x7fffffffu), (i >> 31u) == 1u); }
@group(0) @binding(3) var<uniform> EU: EngU;
// what the host asks this tick (engine.ts): a xyz + w, b: kind (1 a velocity change dv = a.xyz to row b.y, 2 wake row
// b.y, 3 wake every row within a.w of a.xyz, 4 move every row by a.xyz — the window slid, 5 row b.y deforms now
// whatever hit it — a lab's button, a test — 6 the deforming body of row b.y is let go, or with b.y NONE all of them,
// 7 a pick ray from a.xyz along b.yzw (f32 bits, unit): of the rows whose bound sphere it passes within a.w of, the
// one nearest along it is grabbed: P_GRAB)
struct EngCmd { a: vec4<f32>, b: vec4<u32> };
@group(0) @binding(16) var<uniform> EC: array<EngCmd, 16>;
@group(0) @binding(4) var<storage, read_write> pose: array<vec4<f32>>;
@group(0) @binding(5) var<storage, read_write> vel: array<vec4<f32>>;
@group(0) @binding(6) var<storage, read_write> info: array<vec4<f32>>;
@group(0) @binding(7) var<storage, read_write> samples: array<vec4<f32>>;
@group(0) @binding(8) var<storage, read_write> contacts: array<vec4<f32>>;

fn rwAt(r: u32) -> u32 { return LIST_AT + EU.e.x + r * RWW; }
// (the word after the last row's work words: the ticks in which a row was awake, counted on the GPU — engine_pairs.wgsl gTick)
fn tickAt() -> u32 { return LIST_AT + EU.e.x * (1u + RWW); }
// (after it: the rows that may touch the ground, a list a substep — written by `integrate`, read by `tfine`; its
// dispatch arguments are words 4 s of a buffer of their own, engine_pairs.wgsl targs: a kernel cannot be dispatched
// from a buffer it writes)
fn tlAt(s: u32) -> u32 { return tickAt() + 4u + s * EU.e.x; }
const TARGS_AT: u32 = 0u;
fn rowFlags(r: u32) -> u32 { return bitcast<u32>(info[4u * r].w); }
fn eqrot(q: vec4<f32>, v: vec3<f32>) -> vec3<f32> {
  let t = 2.0 * cross(q.xyz, v);
  return v + q.w * t + cross(q.xyz, t);
}
fn eqinv(q: vec4<f32>) -> vec4<f32> { return vec4<f32>(-q.xyz, q.w); }

/**
 * A grabbed row's velocity after a step of the host's spring (Integrity.pull's, on the GPU): toward the target by how
 * far it is, damped, never past the cap; its weight held up. An acceleration, so every mass swings the same. The
 * target is where the finger's view ray crosses the level plane at the height the row was grabbed at (`h`) plus the
 * lift: grabbed high it stays high. A ray along that plane has no such point: no pull.
 */
fn grabPull(x: vec3<f32>, v: vec3<f32>, dt: f32, h: f32) -> vec3<f32> {
  let hold = vec3<f32>(0.0, 0.0, worldG() * dt);
  if (abs(EU.q.z) < 1e-4) { return v + hold; }
  let aim = EU.o.xyz + EU.q.xyz * ((h + EU.q.w - EU.o.z) / EU.q.z);
  var a = EU.p.x * (aim - x) - 2.0 * sqrt(EU.p.x) * EU.p.y * v;
  let l = length(a);
  if (l > EU.p.z) { a *= EU.p.z / l; }
  return v + a * dt + hold;
}
