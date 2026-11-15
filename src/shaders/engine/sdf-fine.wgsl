// Fine collision, body ↔ body (src/engine/sdf/fine.ts; docs/design/PHYSICS_ENGINE.md). sdf-model.wgsl is put in
// front. Structs mirror src/engine/sdf/contract.ts.
//
// Every candidate pair is tested both ways (a's surface samples in b's field, then b's in a's): a corner of one body
// in a flat face of the other is only seen by the corner's own sample.
//   slots   a thread a pair: the pair's record cleared, and its slot in the persistent table found or claimed (below)
//   expand  a thread a half pair: the transform from the sampler's voxels to the field's, composed once; then the
//           field's box (grown by the margin) as a box of the sampler's bricks, and a cull item for each row of
//           bricks along x inside it: [half pair] [y | z << 8 | first x << 16 | last x << 24]. A crumb on a slab asks
//           for one row of the crumb's and the few of the slab's under it, whatever the store's biggest model is
//   cullArgs  the cull dispatch's size from the items
//   cull    a thread a cull item (short loops: a thread's loop is serial, and a long one holds the whole dispatch
//           up): the row's bricks (4 x 4 x 4 voxels of samples, sorted at the bake) whose box, turned into the
//           field's frame, reaches the field's box, each one an entry in the work list. Threads follow the overlap,
//           not the model.
//   pairArgs, cullArgs, fineArgs  every dispatch's size from the pair count, the cull items and the surviving groups
//           (no CPU read; nothing is sized by a buffer's room)
//   fine    a workgroup 16 samples of a surviving brick, a thread a sample: into the field's frame, out if past its bounds, the
//           field read (8 words, trilinear), and if inside the margin the pair's record takes it in: its count, its
//           largest energy, its normal summed with the others that point the same way, and its bid for each of the
//           pair's four contact slots
//   reduce  a thread a pair: the four places' winners (the deepest, and the farthest out along three directions 120
//           degrees apart across the line of centres) computed again and written as the pair's contact rows, at
//           slot * 4
//
// Stable pair slots (docs/design/PHYSICS_ENGINE.md "Round 6"). A pair's contact rows stay in one place for as long as
// the pair is in the pair list every pass, so the solver can keep impulses there. The table is open addressing over
// P.slots entries (a power of two), keyed by the pair's rows (lower, higher). An entry is a stamp (slotStamp, atomic:
// the epoch of the last pass that touched it; 0 never used) and a key record (slotKey: lower row, higher row, age in
// passes, the pair's index this pass); its contact rows are rows slot * 4 on. The epoch (counts[9]) goes up by one a
// pass. An entry is live in pass e when its stamp is e - 1 or e; anything older is free: a pair absent for one pass
// has lost its slot, with no sweep.
//   one probe sequence a pair a pass, double hashing: entry (h + i * step) & (P.slots - 1), step odd, i < PROBES.
//   The pair's thread walks it until it meets its own key in an entry stamped e - 1 (found: stamped e, age + 1) or a
//   never-used entry (the key is not further on: every key took the first free entry of its sequence). Not found: it
//   claims the first free entry it passed (compare-exchange of the stamp to e), writes the key with age 0 and zeroes
//   the four rows. Each pair is in the list once, so no two threads look for the same key, and a key record is only
//   ever written by the thread that owns its entry this pass.
//   No free entry in PROBES: the pair has no slot this pass (record word 7 = NO_SLOT, no rows), both its rows are
//   flagged MISS_SLOTS, and the table grows. The table also grows at half full (collide.ts), by `rehash`: every entry
//   live at the last pass is put in the bigger table with its key, age and rows, and slotRemap[old] says where.
//
// The work buffer: HP_WORDS a half pair (index pair * 2 + way), then the brick list from P.maxPairs * 2 * HP_WORDS
// on, two words a group of up to 16 samples of one brick: [half pair | samples << 27] [the first sample, a word index
// in the data]; then the cull items, two words each, from P.maxChunks * 2 words further.
//
// Rooms (docs/design/PHYSICS_ENGINE.md "Round 6"). The cull items and the list of sample groups can run out. What was
// asked for is counted whole (counts[5] and counts[2], and the most since the CPU last read in counts[12] and
// counts[11]), so the rooms can be made bigger (fine.ts grow, called by collide.ts); until they are, an item or a
// group that found no room flags both rows of its pair in `missing` (contract.ts MISS_CULL, MISS_GROUPS): the pair's
// contacts are not all there and the engine holds both rows still.
//   0-11  three rows of the 3 x 4 transform: sampler padded-voxel point -> field coordinate (voxel centres at integers)
//   12 a   13 b   14 the sampler's first sample (a word index in the data)   15 its sample count
//   16 the sample stride (1: every sample every tick; s: this tick, the samples at places = tick mod s in the model's
//      list) | way << 31; 0: the half pair is not tested
//   17 fieldBase   18 dims   19 f32 sampler voxels in field voxels   20 f32 margin in field voxels
//   21-23 f32 the field model's centre of mass   24 f32 the field model's cells a voxel
//   25 the sampler's brick table (a word index in the data)   26 the sampler's dims
//
// The pair record (contract.ts PAIR_HIT_*), PH_WORDS a pair, atomics:
//   0-3   the slots' best bids: score (15 bits) << 17 | way << 16 | sample
//   4     sample contacts this pass   5 the largest energy (f32 bits)   6 contact rows written   7 the pair's slot
//   8-31  six bins by the normal's dominant axis in the pair's own axes (the line of centres and two across it, each
//         way): the world normal's sum x, y, z (fixed point, 1/1024), count

const HP_WORDS: u32 = 28u;
const PH_WORDS: u32 = 32u;
const SLOTS: u32 = 4u;
const ARGS_ROW: u32 = 256u;
const GROUP: u32 = 16u;
const NO_BID: u32 = 0u;
const MISS_GROUPS: u32 = 4u;
const MISS_SLOTS: u32 = 8u;
const MISS_CULL: u32 = 16u;
// (workgroups a row of the cull dispatch)
const CULL_ROW: u32 = 1024u;
const NO_SLOT: u32 = 0xffffffffu;
const PROBES: u32 = 32u;

// (fine.ts FineParams, 48 B)
struct FineParams {
  margin: f32,
  cap: u32,
  tick: u32,
  // the slot table a growth is leaving (rehash): its entries
  oldSlots: u32,
  maxChunks: u32,
  maxPairs: u32,
  pairUpper: u32,
  // the cull items' room
  maxCull: u32,
  // the slot table's entries, a power of two
  slots: u32,
  pad1: u32,
  pad2: u32,
  pad3: u32,
}
// (contract.ts "the engine's rows": the layout of physics10's engine.wgsl)
struct BodyPose {
  pos: vec3<f32>,
  invMass: f32,
  quat: vec4<f32>,
}
struct BodyVel {
  lin: vec3<f32>,
  ang: vec3<f32>,
  radius: f32,
}
// (contract.ts "A contact row", 48 B)
struct Contact {
  a: u32,
  b: u32,
  energy: f32,
  mats: u32,
  point: vec3<f32>,
  depth: f32,
  normal: vec3<f32>,
  closing: f32,
}

@group(0) @binding(0) var<uniform> P: FineParams;
@group(0) @binding(1) var<storage, read> pairs: array<vec2<u32>>;
@group(0) @binding(2) var<storage, read> pairCount: array<u32>;
@group(0) @binding(3) var<storage, read> pose: array<vec4<f32>>;
@group(0) @binding(4) var<storage, read> vel: array<vec4<f32>>;
@group(0) @binding(5) var<storage, read> info: array<vec4<f32>>;
@group(0) @binding(6) var<storage, read> models: array<SdfModel>;
// (contract.ts COUNT_*)
@group(0) @binding(7) var<storage, read_write> counts: array<atomic<u32>, 16>;
// (a word a body row, contract.ts MISS_*: the coarse pass clears it each tick)
@group(0) @binding(15) var<storage, read_write> missing: array<atomic<u32>>;
@group(0) @binding(8) var<storage, read_write> work: array<u32>;
@group(0) @binding(9) var<storage, read> data: array<u32>;
@group(0) @binding(10) var<storage, read_write> contacts: array<Contact>;
@group(0) @binding(11) var<storage, read_write> args: array<u32>;
@group(0) @binding(12) var<storage, read_write> hits: array<atomic<u32>>;
// (the args again, read only, for the fine kernel: word 3 is the group count)
@group(0) @binding(14) var<storage, read> argsR: array<u32>;
// (the model row of each body row)
@group(0) @binding(13) var<storage, read> bodyModel: array<u32>;
// (the slot table: stamps, key records; and at a growth the table being left and where each of its entries went)
@group(0) @binding(16) var<storage, read_write> slotStamp: array<atomic<u32>>;
@group(0) @binding(17) var<storage, read_write> slotKey: array<vec4<u32>>;
@group(0) @binding(19) var<storage, read> oldStamp: array<u32>;
@group(0) @binding(20) var<storage, read> oldKey: array<vec4<u32>>;
@group(0) @binding(21) var<storage, read> oldContacts: array<Contact>;
@group(0) @binding(22) var<storage, read_write> slotRemap: array<u32>;

fn poseOf(r: u32) -> BodyPose {
  let c = pose[4u * r + 2u];
  // (an inverse mass below zero is a row that cannot be moved)
  return BodyPose(c.xyz, max(c.w, 0.0), pose[4u * r + 3u]);
}

fn velOf(r: u32) -> BodyVel {
  let a = vel[2u * r + 1u];
  return BodyVel(vel[2u * r].xyz, a.xyz, a.w);
}

/** u . (inverse inertia of row r) u, u in the body's frame: the diagonal and the off-diagonal (xy, xz, yz) */
fn invInertiaOn(r: u32, u: vec3<f32>) -> f32 {
  let d = info[3u * r].xyz;
  let o = info[3u * r + 1u].xyz;
  return dot(u * d, u) + 2.0 * (o.x * u.x * u.y + o.y * u.x * u.z + o.z * u.y * u.z);
}

fn materialOf(r: u32) -> u32 {
  return bitcast<u32>(info[3u * r + 2u].z);
}

fn quatMat(q: vec4<f32>) -> mat3x3<f32> {
  let x = q.x; let y = q.y; let z = q.z; let w = q.w;
  return mat3x3<f32>(
    vec3<f32>(1.0 - 2.0 * (y * y + z * z), 2.0 * (x * y + z * w), 2.0 * (x * z - y * w)),
    vec3<f32>(2.0 * (x * y - z * w), 1.0 - 2.0 * (x * x + z * z), 2.0 * (y * z + x * w)),
    vec3<f32>(2.0 * (x * z + y * w), 2.0 * (y * z - x * w), 1.0 - 2.0 * (x * x + y * y)),
  );
}

fn rot(q: vec4<f32>, v: vec3<f32>) -> vec3<f32> {
  return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v);
}

fn unrot(q: vec4<f32>, v: vec3<f32>) -> vec3<f32> {
  return rot(vec4<f32>(-q.xyz, q.w), v);
}

// The dispatches' sizes from the pair count (no CPU read, and nothing sized by the buffers' room): args words 4-6
// expand, 12-14 reduce and slots. (Words 0-3 are fineArgs': the fine dispatch and the group count; 7-10 cullArgs':
// the cull items and the cull dispatch.)
@compute @workgroup_size(1)
fn pairArgs() {
  // (this pass's counts start at zero; the words from 9 on are kept from pass to pass)
  for (var k = 0u; k < 9u; k++) {
    atomicStore(&counts[k], 0u);
  }
  // (the slot table's epoch: one a pass)
  atomicAdd(&counts[9], 1u);
  let n = min(pairCount[0], min(P.pairUpper, P.maxPairs));
  let halves = (2u * n + 63u) / 64u;
  args[4] = halves;
  args[5] = 1u;
  args[6] = 1u;
  args[12] = (n + 63u) / 64u;
  args[13] = 1u;
  args[14] = 1u;
}

/** where a pair's probe sequence starts (x) and its step (y, odd) */
fn slotHash(lo: u32, hi: u32) -> vec2<u32> {
  var x = (lo * 0x9e3779b1u) ^ ((hi + 0x7f4a7c15u) * 0x85ebca6bu);
  x ^= x >> 15u;
  x *= 0x2c1b3c6du;
  x ^= x >> 12u;
  var y = (x * 0x297a2d39u) ^ (hi * 0xc2b2ae35u);
  y ^= y >> 13u;
  return vec2<u32>(x, y | 1u);
}

/** entry s's stamp from `seen` to `to` if nobody was first; false: another thread has it (a compare-exchange that fails for no reason is tried again) */
fn claimSlot(s: u32, seen: u32, to: u32) -> bool {
  var cur = seen;
  for (var t = 0u; t < 8u; t++) {
    let r = atomicCompareExchangeWeak(&slotStamp[s], cur, to);
    if (r.exchanged) {
      return true;
    }
    if (r.old_value != cur) {
      return false;
    }
  }
  return false;
}

@compute @workgroup_size(64)
fn slots(@builtin(global_invocation_id) gid: vec3<u32>) {
  let pi = gid.x;
  if (pi >= min(P.pairUpper, P.maxPairs)) {
    return;
  }
  // (the pair's record, cleared here: only the records the pass's dispatches cover are touched)
  let r = pi * PH_WORDS;
  for (var k = 0u; k < PH_WORDS; k++) {
    atomicStore(&hits[r + k], 0u);
  }
  atomicStore(&hits[r + 7u], NO_SLOT);
  if (pi >= pairCount[0]) {
    return;
  }
  let pr = pairs[pi];
  let lo = min(pr.x, pr.y);
  let hi = max(pr.x, pr.y);
  let e = atomicLoad(&counts[9]);
  let mask = P.slots - 1u;
  let hs = slotHash(lo, hi);
  var slot = NO_SLOT;
  var free = PROBES;
  for (var i = 0u; i < PROBES; i++) {
    let s = (hs.x + i * hs.y) & mask;
    let st = atomicLoad(&slotStamp[s]);
    if (st == e - 1u) {
      let key = slotKey[s];
      if (key.x == lo && key.y == hi) {
        slot = s;
        break;
      }
    } else if (st != e) {
      free = min(free, i);
      if (st == 0u) {
        break;
      }
    }
  }
  if (slot != NO_SLOT) {
    atomicStore(&slotStamp[slot], e);
    slotKey[slot] = vec4<u32>(lo, hi, slotKey[slot].z + 1u, pi);
  } else {
    for (var i = free; i < PROBES; i++) {
      let s = (hs.x + i * hs.y) & mask;
      let st = atomicLoad(&slotStamp[s]);
      if (st != e && st != e - 1u && claimSlot(s, st, e)) {
        slot = s;
        break;
      }
    }
    if (slot == NO_SLOT) {
      // (no free entry in the sequence: no rows for the pair this pass, and both its rows say so)
      atomicAdd(&counts[8], 1u);
      atomicOr(&missing[pr.x], MISS_SLOTS);
      atomicOr(&missing[pr.y], MISS_SLOTS);
      return;
    }
    atomicAdd(&counts[7], 1u);
    slotKey[slot] = vec4<u32>(lo, hi, 0u, pi);
    for (var k = 0u; k < SLOTS; k++) {
      contacts[slot * SLOTS + k] = Contact();
    }
  }
  atomicStore(&hits[r + 7u], slot);
}

// A growth (fine.ts grow): every entry of the table being left that was live at the last pass goes into the new
// table with its key, age and rows; slotRemap[old entry] = its new entry, or NO_SLOT. Runs before pairArgs, so
// counts[9] is still the last pass's epoch.
@compute @workgroup_size(64)
fn rehash(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= P.oldSlots) {
    return;
  }
  slotRemap[i] = NO_SLOT;
  let e = atomicLoad(&counts[9]);
  if (oldStamp[i] != e) {
    return;
  }
  let key = oldKey[i];
  let mask = P.slots - 1u;
  let hs = slotHash(key.x, key.y);
  for (var j = 0u; j < PROBES; j++) {
    let s = (hs.x + j * hs.y) & mask;
    if (claimSlot(s, 0u, e)) {
      slotKey[s] = key;
      for (var k = 0u; k < SLOTS; k++) {
        contacts[s * SLOTS + k] = oldContacts[i * SLOTS + k];
      }
      slotRemap[i] = s;
      return;
    }
  }
  // (no room in its sequence in a table at most a quarter full: the pair starts again in a new slot)
  atomicAdd(&counts[15], 1u);
}

@compute @workgroup_size(64)
fn expand(@builtin(global_invocation_id) gid: vec3<u32>) {
  let h = gid.x;
  let pi = h >> 1u;
  if (pi >= min(P.pairUpper, P.maxPairs)) {
    return;
  }
  // (not tested until shown otherwise: reduce reads the half pairs of every pair the dispatch covers)
  work[h * HP_WORDS + 16u] = 0u;
  if (pi >= pairCount[0]) {
    return;
  }
  let way = h & 1u;
  let pr = pairs[pi];
  // (s: the body whose samples are tested; f: the body whose field they are tested in)
  let s = select(pr.x, pr.y, way == 1u);
  let f = select(pr.y, pr.x, way == 1u);
  let o = h * HP_WORDS;
  work[o + 12u] = pr.x;
  work[o + 13u] = pr.y;
  let ps = poseOf(s);
  let pf = poseOf(f);
  let dp = ps.pos - pf.pos;
  let ms = models[bodyModel[s]];
  let mf = models[bodyModel[f]];
  let count = ms.sampleCount;
  if (count == 0u) {
    return;
  }
  let scale = ms.voxel / mf.voxel;
  let rf = transpose(quatMat(pf.quat));
  let m3 = rf * quatMat(ps.quat) * scale;
  let t = rf * dp / mf.voxel + mf.com - vec3<f32>(0.5) - m3 * ms.com;
  for (var r = 0u; r < 3u; r++) {
    work[o + r * 4u] = bitcast<u32>(m3[0][r]);
    work[o + r * 4u + 1u] = bitcast<u32>(m3[1][r]);
    work[o + r * 4u + 2u] = bitcast<u32>(m3[2][r]);
    work[o + r * 4u + 3u] = bitcast<u32>(t[r]);
  }
  let bd = sdfBricks(sdfDims(ms.dims));
  let nb = bd.x * bd.y * bd.z;
  let first = ms.sampleBase + nb + 1u;
  let margin = P.margin / mf.voxel;
  work[o + 14u] = first;
  work[o + 15u] = count;
  // (a model with more samples than the cap: every stride-th sample a tick, the offset turning with the tick)
  work[o + 16u] = ((count + P.cap - 1u) / P.cap) | (way << 31u);
  work[o + 17u] = mf.fieldBase;
  work[o + 18u] = mf.dims;
  work[o + 19u] = bitcast<u32>(scale);
  work[o + 20u] = bitcast<u32>(margin);
  work[o + 21u] = bitcast<u32>(mf.com.x);
  work[o + 22u] = bitcast<u32>(mf.com.y);
  work[o + 23u] = bitcast<u32>(mf.com.z);
  work[o + 24u] = bitcast<u32>(mf.voxel);
  work[o + 25u] = ms.sampleBase;
  work[o + 26u] = ms.dims;
  // The sampler's bricks that could hold a sample inside the field's box: the field's box (voxel centres 0 to
  // dims - 1, grown by the margin and half a sampler voxel for a ball sample) turned into the sampler's frame, and
  // that box's bounds there (m3 is a rotation times the scale: its inverse is its transpose over the scale squared).
  let hf = 0.5 * (vec3<f32>(sdfDims(mf.dims)) - vec3<f32>(1.0));
  let gf = hf + vec3<f32>(margin + 0.5 * scale);
  let inv = 1.0 / (scale * scale);
  let cs = vec3<f32>(dot(m3[0], hf - t), dot(m3[1], hf - t), dot(m3[2], hf - t)) * inv;
  let es = vec3<f32>(dot(abs(m3[0]), gf), dot(abs(m3[1]), gf), dot(abs(m3[2]), gf)) * inv + vec3<f32>(0.01);
  let top = vec3<i32>(bd) - vec3<i32>(1);
  let b0 = max(vec3<i32>(floor((cs - es) * 0.25)), vec3<i32>(0));
  let b1 = min(vec3<i32>(floor((cs + es) * 0.25)), top);
  if (any(b1 < b0)) {
    return;
  }
  // a cull item a row of those bricks along x
  let ny = u32(b1.y - b0.y + 1);
  let n = ny * u32(b1.z - b0.z + 1);
  let k0 = atomicAdd(&counts[5], n);
  let items = (P.maxPairs * 2u * HP_WORDS) + 2u * P.maxChunks;
  for (var j = 0u; j < n; j++) {
    if (k0 + j >= P.maxCull) {
      // (no room for the rest: the pair's contacts are not all there, and both its rows say so)
      atomicAdd(&counts[6], n - j);
      atomicOr(&missing[pr.x], MISS_CULL);
      atomicOr(&missing[pr.y], MISS_CULL);
      break;
    }
    let y = u32(b0.y) + j % ny;
    let z = u32(b0.z) + j / ny;
    work[items + 2u * (k0 + j)] = h;
    work[items + 2u * (k0 + j) + 1u] = y | (z << 8u) | (u32(b0.x) << 16u) | (u32(b1.x) << 24u);
  }
}

@compute @workgroup_size(1)
fn cullArgs() {
  // (the most cull items asked for in a pass since the CPU last read)
  atomicMax(&counts[12], atomicLoad(&counts[5]));
  let n = min(atomicLoad(&counts[5]), P.maxCull);
  let groups = (n + 63u) / 64u;
  args[7] = n;
  args[8] = min(groups, CULL_ROW);
  args[9] = (groups + CULL_ROW - 1u) / CULL_ROW;
  args[10] = 1u;
}

@compute @workgroup_size(64)
fn cull(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_index) li: u32) {
  let ci = (wg.y * CULL_ROW + wg.x) * 64u + li;
  // (the item count from the args, a plain read)
  if (ci >= argsR[7]) {
    return;
  }
  let list = P.maxPairs * 2u * HP_WORDS;
  let item = list + 2u * P.maxChunks + 2u * ci;
  let h = work[item];
  let pk = work[item + 1u];
  let gy = pk & 0xffu;
  let gz = (pk >> 8u) & 0xffu;
  let o = h * HP_WORDS;
  let r0 = vec4<f32>(bitcast<f32>(work[o]), bitcast<f32>(work[o + 1u]), bitcast<f32>(work[o + 2u]), bitcast<f32>(work[o + 3u]));
  let r1 = vec4<f32>(bitcast<f32>(work[o + 4u]), bitcast<f32>(work[o + 5u]), bitcast<f32>(work[o + 6u]), bitcast<f32>(work[o + 7u]));
  let r2 = vec4<f32>(bitcast<f32>(work[o + 8u]), bitcast<f32>(work[o + 9u]), bitcast<f32>(work[o + 10u]), bitcast<f32>(work[o + 11u]));
  let table = work[o + 25u];
  let first = work[o + 14u];
  let sd = sdfDims(work[o + 26u]);
  let bd = sdfBricks(sd);
  // the bricks whose box (its voxels inside the grid, turned into the field's frame: its reach along each of the
  // field's axes; half a voxel more for a ball sample) reaches the field's box grown by the margin
  let hi = vec3<f32>(sdfDims(work[o + 18u])) - vec3<f32>(1.0);
  let margin = bitcast<f32>(work[o + 20u]);
  let scale = bitcast<f32>(work[o + 19u]);
  let stride = work[o + 16u] & 0x7fffffffu;
  let phase = P.tick % stride;
  for (var bx = (pk >> 16u) & 0xffu; bx <= (pk >> 24u); bx++) {
    let b = bx + bd.x * (gy + bd.y * gz);
    let lo = vec3<u32>(bx, gy, gz) * 4u;
    let half = 0.5 * vec3<f32>(min(lo + vec3<u32>(4u), sd) - lo);
    let c = vec4<f32>(vec3<f32>(lo) + half, 1.0);
    let q = vec3<f32>(dot(r0, c), dot(r1, c), dot(r2, c));
    let grow = vec3<f32>(margin + 0.5 * scale) + vec3<f32>(dot(abs(r0.xyz), half), dot(abs(r1.xyz), half), dot(abs(r2.xyz), half));
    if (any(q < -grow) || any(q > hi + grow)) {
      continue;
    }
    let begin = data[table + b];
    let n = data[table + b + 1u] - begin;
    if (n == 0u) {
      continue;
    }
    // (a model past the cap: only this tick's samples get threads, every stride-th by its place in the model's list)
    let lead = (stride + phase - begin % stride) % stride;
    if (lead >= n) {
      continue;
    }
    let m = (n - lead + stride - 1u) / stride;
    // (a workgroup of the fine pass takes GROUP samples: a brick is one to four of them)
    for (var s = 0u; s < m; s += GROUP) {
      let k = atomicAdd(&counts[2], 1u);
      if (k >= P.maxChunks) {
        // (no room for the group: the pair's contacts are not all there, and both its rows say so)
        atomicAdd(&counts[3], 1u);
        atomicOr(&missing[work[o + 12u]], MISS_GROUPS);
        atomicOr(&missing[work[o + 13u]], MISS_GROUPS);
        continue;
      }
      work[list + 2u * k] = h | (min(GROUP, m - s) << 27u);
      work[list + 2u * k + 1u] = first + begin + lead + s * stride;
    }
  }
}

@compute @workgroup_size(1)
fn fineArgs() {
  // (the most groups asked for in a pass since the CPU last read)
  atomicMax(&counts[11], atomicLoad(&counts[2]));
  // the slot table: the entries that may be live (last pass's pairs and this pass's new ones), the most since the
  // last read; the pairs that found no slot since then; and this pass's pairs with a slot, for the next
  let pairsNow = min(pairCount[0], min(P.pairUpper, P.maxPairs));
  let failed = atomicLoad(&counts[8]);
  atomicMax(&counts[13], atomicLoad(&counts[10]) + atomicLoad(&counts[7]));
  atomicAdd(&counts[14], failed);
  atomicStore(&counts[10], pairsNow - failed);
  let n = min(atomicLoad(&counts[2]), P.maxChunks);
  args[0] = min(n, ARGS_ROW);
  args[1] = (n + ARGS_ROW - 1u) / ARGS_ROW;
  args[2] = 1u;
  args[3] = n;
  // (pairs the coarse stage wrote past this pass's room: not tested, counted)
  atomicStore(&counts[1], pairCount[0] - min(pairCount[0], P.maxPairs));
}

fn fieldAt(base: u32, i: u32) -> f32 {
  if (SDF_FORMAT == SDF_SNORM8) {
    let w = data[base + (i >> 2u)];
    let b = (w >> ((i & 3u) * 8u)) & 0xffu;
    return f32(bitcast<i32>(b << 24u) >> 24u) * (1.0 / SDF_SNORM_SCALE);
  }
  return bitcast<f32>(data[base + i]);
}

/** the field at qc (inside the hull of the voxel centres): gradient xyz, distance w (voxels) */
fn fieldSample(base: u32, dims: vec3<u32>, qc: vec3<f32>) -> vec4<f32> {
  let i0 = min(vec3<u32>(qc), dims - vec3<u32>(2u));
  let fr = qc - vec3<f32>(i0);
  let i = i0.x + dims.x * (i0.y + dims.y * i0.z);
  let sy = dims.x;
  let sz = dims.x * dims.y;
  if (SDF_FORMAT == SDF_GRAD8) {
    // (a word a voxel: the distance and the unit gradient, all four interpolated: the normal is continuous)
    let v = mix(
      mix(mix(unpack4x8snorm(data[base + i]), unpack4x8snorm(data[base + i + 1u]), fr.x), mix(unpack4x8snorm(data[base + i + sy]), unpack4x8snorm(data[base + i + sy + 1u]), fr.x), fr.y),
      mix(mix(unpack4x8snorm(data[base + i + sz]), unpack4x8snorm(data[base + i + sz + 1u]), fr.x), mix(unpack4x8snorm(data[base + i + sz + sy]), unpack4x8snorm(data[base + i + sz + sy + 1u]), fr.x), fr.y),
      fr.z,
    );
    return vec4<f32>(v.yzw, v.x * (127.0 / SDF_SNORM_SCALE));
  }
  // (the trilinear field's own gradient: one-sided at a cell's faces, so the normal can step there)
  let c000 = fieldAt(base, i);
  let c100 = fieldAt(base, i + 1u);
  let c010 = fieldAt(base, i + sy);
  let c110 = fieldAt(base, i + sy + 1u);
  let c001 = fieldAt(base, i + sz);
  let c101 = fieldAt(base, i + sz + 1u);
  let c011 = fieldAt(base, i + sz + sy);
  let c111 = fieldAt(base, i + sz + sy + 1u);
  let x00 = mix(c000, c100, fr.x);
  let x10 = mix(c010, c110, fr.x);
  let x01 = mix(c001, c101, fr.x);
  let x11 = mix(c011, c111, fr.x);
  let y0 = mix(x00, x10, fr.y);
  let y1 = mix(x01, x11, fr.y);
  return vec4<f32>(mix(mix(c100 - c000, c110 - c010, fr.y), mix(c101 - c001, c111 - c011, fr.y), fr.z), mix(x10 - x00, x11 - x01, fr.z), y1 - y0, mix(y0, y1, fr.z));
}

struct Hit {
  ok: bool,
  a: u32,
  b: u32,
  // world: midway between the two surfaces
  point: vec3<f32>,
  // world, from b towards a
  normal: vec3<f32>,
  // cells, positive overlap
  depth: f32,
  // a's velocity less b's at the point
  vrel: vec3<f32>,
  // 1 / effective mass along the normal (0: neither can move)
  w: f32,
}

/** half pair h's sample at data word `at` against the field: the contact, or ok false */
fn hitOf(h: u32, at: u32) -> Hit {
  var out: Hit;
  out.ok = false;
  let o = h * HP_WORDS;
  let sw = data[at];
  let open = sw >> 24u;
  let off = 0.5 * (vec3<f32>(f32(open & 1u), f32((open >> 2u) & 1u), f32((open >> 4u) & 1u)) - vec3<f32>(f32((open >> 1u) & 1u), f32((open >> 3u) & 1u), f32((open >> 5u) & 1u)));
  let ps = vec3<f32>(sdfXyz(sw)) + vec3<f32>(0.5) + off;
  let scale = bitcast<f32>(work[o + 19u]);
  // (a voxel with no single open side is a ball of half a voxel)
  let ball = select(0.0, 0.5 * scale, all(off == vec3<f32>(0.0)));
  let q = vec3<f32>(
    dot(vec3<f32>(bitcast<f32>(work[o]), bitcast<f32>(work[o + 1u]), bitcast<f32>(work[o + 2u])), ps) + bitcast<f32>(work[o + 3u]),
    dot(vec3<f32>(bitcast<f32>(work[o + 4u]), bitcast<f32>(work[o + 5u]), bitcast<f32>(work[o + 6u])), ps) + bitcast<f32>(work[o + 7u]),
    dot(vec3<f32>(bitcast<f32>(work[o + 8u]), bitcast<f32>(work[o + 9u]), bitcast<f32>(work[o + 10u])), ps) + bitcast<f32>(work[o + 11u]),
  );
  let dims = sdfDims(work[o + 18u]);
  let hi = vec3<f32>(dims) - vec3<f32>(1.0);
  let margin = bitcast<f32>(work[o + 20u]);
  let slack = margin + ball;
  if (any(q < vec3<f32>(-slack)) || any(q > hi + vec3<f32>(slack))) {
    return out;
  }
  // the field at q: trilinear inside the hull of the voxel centres; past it, the hull's value plus the way out
  let qc = clamp(q, vec3<f32>(0.0), hi);
  let base = work[o + 17u];
  let fs = fieldSample(base, dims, qc);
  var d = fs.w;
  if (d - ball > margin && all(q == qc)) {
    return out;
  }
  let com = vec3<f32>(bitcast<f32>(work[o + 21u]), bitcast<f32>(work[o + 22u]), bitcast<f32>(work[o + 23u]));
  let g = fs.xyz;
  let gl = length(g);
  var n: vec3<f32>;
  if (gl > 1e-4) {
    n = g / gl;
  } else {
    // (a flat field: deep inside past the snorm8 range, or on a medial sheet; away from the centre of mass)
    let away = qc - (com - vec3<f32>(0.5));
    let al = length(away);
    n = select(vec3<f32>(0.0, 0.0, 1.0), away / al, al > 1e-4);
  }
  let past = q - qc;
  if (dot(past, past) > 0.0) {
    let v = past + n * max(d, 0.0);
    d = length(v);
    n = v / d;
  }
  let gap = d - ball;
  if (gap > margin) {
    return out;
  }
  let tw = work[o + 16u];
  let way = tw >> 31u;
  let a = work[o + 12u];
  let b = work[o + 13u];
  let pf = poseOf(select(b, a, way == 1u));
  let voxel = bitcast<f32>(work[o + 24u]);
  // midway between the sampler's surface (q - n * ball) and the field's (q - n * d)
  let mid = q - n * (0.5 * (d + ball));
  let point = pf.pos + rot(pf.quat, (mid + vec3<f32>(0.5) - com) * voxel);
  // (from b towards a: the field's outward normal when a gives the samples)
  let nw = rot(pf.quat, n) * select(1.0, -1.0, way == 1u);
  let pa = poseOf(a);
  let pb = poseOf(b);
  let ra = point - pa.pos;
  let rb = point - pb.pos;
  let va = velOf(a);
  let vb = velOf(b);
  let ua = unrot(pa.quat, cross(ra, nw));
  let ub = unrot(pb.quat, cross(rb, nw));
  out.ok = true;
  out.a = a;
  out.b = b;
  out.point = point;
  out.normal = nw;
  out.depth = -gap * voxel;
  out.vrel = (va.lin + cross(va.ang, ra)) - (vb.lin + cross(vb.ang, rb));
  out.w = pa.invMass + pb.invMass + invInertiaOn(a, ua) + invInertiaOn(b, ub);
  return out;
}

/** a pair's own axes: the line of centres (b to a), and two across it */
fn pairFrame(pa: vec3<f32>, pb: vec3<f32>) -> mat3x3<f32> {
  let axis = pa - pb;
  let al = length(axis);
  let n0 = select(vec3<f32>(0.0, 0.0, 1.0), axis / al, al > 1e-5);
  let t1 = normalize(cross(n0, select(vec3<f32>(1.0, 0.0, 0.0), vec3<f32>(0.0, 1.0, 0.0), abs(n0.x) > 0.7)));
  return mat3x3<f32>(n0, t1, cross(n0, t1));
}

/** the bin of a normal given in the pair's axes: its dominant axis and sign */
fn binOf(n: vec3<f32>) -> u32 {
  let m = abs(n);
  if (m.x >= m.y && m.x >= m.z) {
    return select(0u, 1u, n.x < 0.0);
  }
  if (m.y >= m.z) {
    return select(2u, 3u, n.y < 0.0);
  }
  return select(4u, 5u, n.z < 0.0);
}

/** a score in [0, 1] and a sample's id as a slot's bid (a higher score wins; equal scores, the higher id) */
fn bid(score: f32, id: u32) -> u32 {
  return ((1u + u32(clamp(score, 0.0, 1.0) * 32766.0)) << 17u) | id;
}

/** a bid for a word that keeps the largest (no read first: on D3D an atomic load is itself an interlocked
 *  operation, and reading before writing measured twice as slow) */
fn bidFor(i: u32, v: u32) {
  if (v != 0u) {
    atomicMax(&hits[i], v);
  }
}

@compute @workgroup_size(16)
fn fine(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_index) li: u32) {
  let ci = wg.y * ARGS_ROW + wg.x;
  // (the group count from the args, a plain read: an atomic load a thread is an interlocked operation on D3D)
  if (ci >= argsR[3]) {
    return;
  }
  let list = P.maxPairs * 2u * HP_WORDS;
  let cw = work[list + 2u * ci];
  if (li >= (cw >> 27u)) {
    return;
  }
  let h = cw & 0x7ffffffu;
  let o = h * HP_WORDS;
  let tw = work[o + 16u];
  let at = work[list + 2u * ci + 1u] + li * (tw & 0x7fffffffu);
  let gi = at - work[o + 14u];
  let c = hitOf(h, at);
  if (!c.ok) {
    return;
  }
  let pi = h >> 1u;
  let r = pi * PH_WORDS;
  let approach = max(-dot(c.vrel, c.normal), 0.0);
  bidFor(r + 5u, bitcast<u32>(select(0.0, 0.5 * approach * approach / c.w, c.w > 0.0)));
  let pa = poseOf(c.a);
  let pb = poseOf(c.b);
  let fr = pairFrame(pa.pos, pb.pos);
  let bin = r + 8u + binOf(c.normal * fr) * 4u;
  let fx = vec3<i32>(round(c.normal * 1024.0));
  atomicAdd(&hits[bin], bitcast<u32>(fx.x));
  atomicAdd(&hits[bin + 1u], bitcast<u32>(fx.y));
  atomicAdd(&hits[bin + 2u], bitcast<u32>(fx.z));
  atomicAdd(&hits[bin + 3u], 1u);
  // the bids: the deepest; the farthest out along three directions 120 degrees apart, across the line of centres
  let reach = velOf(c.a).radius + velOf(c.b).radius + P.margin;
  let id = ((tw >> 31u) << 16u) | (gi & 0xffffu);
  let t1 = fr[1];
  let t2 = fr[2];
  let rel = (c.point - 0.5 * (pa.pos + pb.pos)) / reach;
  bidFor(r, bid((c.depth + P.margin) / (reach + P.margin), id));
  bidFor(r + 1u, bid(0.5 + 0.5 * dot(rel, t1), id));
  bidFor(r + 2u, bid(0.5 + 0.5 * dot(rel, -0.5 * t1 + 0.8660254 * t2), id));
  bidFor(r + 3u, bid(0.5 + 0.5 * dot(rel, -0.5 * t1 - 0.8660254 * t2), id));
}

@compute @workgroup_size(64)
fn reduce(@builtin(global_invocation_id) gid: vec3<u32>) {
  let pi = gid.x;
  // (a pair past the coarse stage's count has no sample contacts: the pair records are cleared every pass)
  if (pi >= min(P.pairUpper, P.maxPairs)) {
    return;
  }
  let r = pi * PH_WORDS;
  // (the pair's sample contacts: the six bins' counts)
  var found = 0u;
  for (var k = 0u; k < 6u; k++) {
    found += atomicLoad(&hits[r + 11u + k * 4u]);
  }
  atomicStore(&hits[r + 4u], found);
  // (a pair with no slot has nowhere to put rows: its rows are flagged, slots)
  let slot = atomicLoad(&hits[r + 7u]);
  if (found == 0u || slot == NO_SLOT) {
    return;
  }
  let energy = bitcast<f32>(atomicLoad(&hits[r + 5u]));
  var kept = 0u;
  var ids: array<u32, 4>;
  for (var k = 0u; k < SLOTS; k++) {
    let key = atomicLoad(&hits[r + k]);
    if (key == NO_BID) {
      continue;
    }
    let id = key & 0x1ffffu;
    var again = false;
    for (var j = 0u; j < kept; j++) {
      again = again || ids[j] == id;
    }
    if (again) {
      continue;
    }
    let h = pi * 2u + (id >> 16u);
    let c = hitOf(h, work[h * HP_WORDS + 14u] + (id & 0xffffu));
    if (!c.ok) {
      continue;
    }
    // the normal: the mean of the pair's sample normals that point the same way as this one
    let bin = r + 8u + binOf(c.normal * pairFrame(poseOf(c.a).pos, poseOf(c.b).pos)) * 4u;
    let sum = vec3<f32>(vec3<i32>(bitcast<i32>(atomicLoad(&hits[bin])), bitcast<i32>(atomicLoad(&hits[bin + 1u])), bitcast<i32>(atomicLoad(&hits[bin + 2u]))));
    let sl = length(sum);
    let n = select(c.normal, sum / sl, sl > 1.0);
    var row: Contact;
    row.a = c.a;
    row.b = c.b;
    row.energy = energy;
    row.mats = (materialOf(c.a) & 0xffffu) | (materialOf(c.b) << 16u);
    row.point = c.point;
    row.depth = c.depth;
    row.normal = n;
    row.closing = -dot(c.vrel, n);
    contacts[slot * SLOTS + kept] = row;
    ids[kept] = id;
    kept++;
  }
  atomicStore(&hits[r + 6u], kept);
  atomicAdd(&counts[0], kept);
  atomicAdd(&counts[4], found);
}
