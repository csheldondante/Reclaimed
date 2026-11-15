// Fine collision, body ↔ body (src/engine/sdf/fine.ts; docs/design/PHYSICS_ENGINE.md). sdf-model.wgsl is put in
// front. Structs mirror src/engine/sdf/contract.ts.
//
// Every candidate pair is tested both ways (a's surface samples in b's field, then b's in a's): a corner of one body
// in a flat face of the other is only seen by the corner's own sample.
//   expand  a thread a half pair: bound spheres rejected; the samples it will test (at most P.cap, spread evenly over
//           the model's list, the offset turning with the tick); the transform from the sampler's voxels to the
//           field's, composed once; its chunks of 64 samples appended to the work list
//   args    the fine dispatch's size from the chunk count (no CPU read)
//   fine    a workgroup a chunk, a thread a sample: into the field's frame, out if past its bounds, the field read
//           (8 reads, trilinear; the gradient from the same 8 values, or in grad8 the kept gradients interpolated),
//           a contact appended if inside the margin
//
// The work buffer: 24 words a half pair (HP_WORDS; index pair * 2 + way), then the chunk list from P.maxPairs * 2 *
// HP_WORDS on, a word a chunk: half pair | chunk << 20.
//   0-11  three rows of the 3 x 4 transform: sampler padded-voxel point -> field coordinate (voxel centres at integers)
//   12 a   13 b   14 sampleBase   15 sampleCount   16 samples taken | way << 31
//   17 fieldBase   18 dims   19 f32 sampler voxels in field voxels   20 f32 margin in field voxels

const HP_WORDS: u32 = 24u;
const CHUNK: u32 = 64u;
const ARGS_ROW: u32 = 256u;

// (fine.ts FineParams, 32 B)
struct FineParams {
  margin: f32,
  cap: u32,
  tick: u32,
  maxContacts: u32,
  maxChunks: u32,
  maxPairs: u32,
  pairUpper: u32,
  pad: u32,
}
// (contract.ts: bodyPose, bodyVel, bodyInfo, 32 B each)
struct BodyPose {
  pos: vec3<f32>,
  invMass: f32,
  quat: vec4<f32>,
}
struct BodyVel {
  lin: vec3<f32>,
  rest: f32,
  ang: vec3<f32>,
  radius: f32,
}
struct BodyInfo {
  invInertia: vec3<f32>,
  material: u32,
  flags: u32,
  priority: u32,
  model: u32,
  grid: u32,
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
@group(0) @binding(3) var<storage, read> pose: array<BodyPose>;
@group(0) @binding(4) var<storage, read> vel: array<BodyVel>;
@group(0) @binding(5) var<storage, read> info: array<BodyInfo>;
@group(0) @binding(6) var<storage, read> models: array<SdfModel>;
// (contract.ts COUNT_*: contacts, contacts dropped, chunks, chunks dropped)
@group(0) @binding(7) var<storage, read_write> counts: array<atomic<u32>, 4>;
@group(0) @binding(8) var<storage, read_write> work: array<u32>;
@group(0) @binding(9) var<storage, read> data: array<u32>;
@group(0) @binding(10) var<storage, read_write> contacts: array<Contact>;
@group(0) @binding(11) var<storage, read_write> args: array<u32>;

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

@compute @workgroup_size(64)
fn expand(@builtin(global_invocation_id) gid: vec3<u32>) {
  let h = gid.x;
  let pi = h >> 1u;
  if (pi >= min(min(pairCount[0], P.pairUpper), P.maxPairs)) {
    return;
  }
  let way = h & 1u;
  let pr = pairs[pi];
  // (s: the body whose samples are tested; f: the body whose field they are tested in)
  let s = select(pr.x, pr.y, way == 1u);
  let f = select(pr.y, pr.x, way == 1u);
  let o = h * HP_WORDS;
  // (no samples taken until shown otherwise: a stale record is never read, but keep it honest)
  work[o + 16u] = 0u;
  let ps = pose[s];
  let pf = pose[f];
  let reach = vel[s].radius + vel[f].radius + P.margin;
  let dp = ps.pos - pf.pos;
  if (dot(dp, dp) > reach * reach) {
    return;
  }
  let ms = models[info[s].model];
  let mf = models[info[f].model];
  let count = ms.sampleCount;
  if (count == 0u) {
    return;
  }
  let take = min(count, P.cap);
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
  work[o + 12u] = pr.x;
  work[o + 13u] = pr.y;
  work[o + 14u] = ms.sampleBase;
  work[o + 15u] = count;
  work[o + 16u] = take | (way << 31u);
  work[o + 17u] = mf.fieldBase;
  work[o + 18u] = mf.dims;
  work[o + 19u] = bitcast<u32>(scale);
  work[o + 20u] = bitcast<u32>(P.margin / mf.voxel);
  let chunks = (take + CHUNK - 1u) / CHUNK;
  let first = atomicAdd(&counts[2], chunks);
  let list = P.maxPairs * 2u * HP_WORDS;
  for (var c = 0u; c < chunks; c++) {
    if (first + c >= P.maxChunks) {
      atomicAdd(&counts[3], chunks - c);
      break;
    }
    work[list + first + c] = h | (c << 20u);
  }
}

@compute @workgroup_size(1)
fn fineArgs() {
  let n = min(atomicLoad(&counts[2]), P.maxChunks);
  args[0] = min(n, ARGS_ROW);
  args[1] = (n + ARGS_ROW - 1u) / ARGS_ROW;
  args[2] = 1u;
}

fn fieldAt(base: u32, i: u32) -> f32 {
  if (SDF_FORMAT == SDF_SNORM8) {
    let w = data[base + (i >> 2u)];
    let b = (w >> ((i & 3u) * 8u)) & 0xffu;
    return f32(bitcast<i32>(b << 24u) >> 24u) * (1.0 / SDF_SNORM_SCALE);
  }
  return bitcast<f32>(data[base + i]);
}

@compute @workgroup_size(64)
fn fine(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_index) li: u32) {
  let ci = wg.y * ARGS_ROW + wg.x;
  if (ci >= min(atomicLoad(&counts[2]), P.maxChunks)) {
    return;
  }
  let cw = work[P.maxPairs * 2u * HP_WORDS + ci];
  let h = cw & 0xfffffu;
  let o = h * HP_WORDS;
  let j = (cw >> 20u) * CHUNK + li;
  let tw = work[o + 16u];
  let take = tw & 0x7fffffffu;
  if (j >= take) {
    return;
  }
  let count = work[o + 15u];
  // (the samples taken, spread evenly over the list; the offset turns with the tick so every sample has its tick)
  var si = j;
  if (take < count) {
    let stride = (count + take - 1u) / take;
    si = (min(u32(f32(j) * f32(count) / f32(take)), count - 1u) + P.tick % stride) % count;
  }
  let sw = data[work[o + 14u] + si];
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
    return;
  }
  // the field at q: trilinear inside the hull of the voxel centres; past it, the hull's value plus the way out
  let qc = clamp(q, vec3<f32>(0.0), hi);
  let i0 = min(vec3<u32>(qc), dims - vec3<u32>(2u));
  let fr = qc - vec3<f32>(i0);
  let base = work[o + 17u];
  let i = i0.x + dims.x * (i0.y + dims.y * i0.z);
  let sy = dims.x;
  let sz = dims.x * dims.y;
  var d: f32;
  var g: vec3<f32>;
  if (SDF_FORMAT == SDF_GRAD8) {
    // (a word a voxel: the distance and the unit gradient, all four interpolated: the normal is continuous)
    let v = mix(
      mix(mix(unpack4x8snorm(data[base + i]), unpack4x8snorm(data[base + i + 1u]), fr.x), mix(unpack4x8snorm(data[base + i + sy]), unpack4x8snorm(data[base + i + sy + 1u]), fr.x), fr.y),
      mix(mix(unpack4x8snorm(data[base + i + sz]), unpack4x8snorm(data[base + i + sz + 1u]), fr.x), mix(unpack4x8snorm(data[base + i + sz + sy]), unpack4x8snorm(data[base + i + sz + sy + 1u]), fr.x), fr.y),
      fr.z,
    );
    d = v.x * (127.0 / SDF_SNORM_SCALE);
    g = v.yzw;
  } else {
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
    d = mix(y0, y1, fr.z);
    g = vec3<f32>(
      mix(mix(c100 - c000, c110 - c010, fr.y), mix(c101 - c001, c111 - c011, fr.y), fr.z),
      mix(x10 - x00, x11 - x01, fr.z),
      y1 - y0,
    );
  }
  if (d - ball > margin && all(q == qc)) {
    return;
  }
  let way = tw >> 31u;
  let a = work[o + 12u];
  let b = work[o + 13u];
  let fb = select(b, a, way == 1u);
  let pf = pose[fb];
  let mf = models[info[fb].model];
  let gl = length(g);
  var n: vec3<f32>;
  if (gl > 1e-4) {
    n = g / gl;
  } else {
    // (a flat field: deep inside past the snorm8 range, or on a medial sheet; away from the centre of mass)
    let away = qc - (mf.com - vec3<f32>(0.5));
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
    return;
  }
  let k = atomicAdd(&counts[0], 1u);
  if (k >= P.maxContacts) {
    atomicAdd(&counts[1], 1u);
    return;
  }
  // midway between the sampler's surface (q - n * ball) and the field's (q - n * d)
  let mid = q - n * (0.5 * (d + ball));
  let point = pf.pos + rot(pf.quat, (mid + vec3<f32>(0.5) - mf.com) * mf.voxel);
  // (from b towards a: the field's outward normal when a gives the samples)
  let nw = rot(pf.quat, n) * select(1.0, -1.0, way == 1u);
  let pa = pose[a];
  let pb = pose[b];
  let ra = point - pa.pos;
  let rb = point - pb.pos;
  let va = vel[a];
  let vb = vel[b];
  let closing = -dot((va.lin + cross(va.ang, ra)) - (vb.lin + cross(vb.ang, rb)), nw);
  let ua = unrot(pa.quat, cross(ra, nw));
  let ub = unrot(pb.quat, cross(rb, nw));
  let ia = info[a];
  let ib = info[b];
  let w = pa.invMass + pb.invMass + dot(ua * ia.invInertia, ua) + dot(ub * ib.invInertia, ub);
  let approach = max(closing, 0.0);
  var c: Contact;
  c.a = a;
  c.b = b;
  c.energy = select(0.0, 0.5 * approach * approach / w, w > 0.0);
  c.mats = (ia.material & 0xffffu) | (ib.material << 16u);
  c.point = point;
  c.depth = -gap * mf.voxel;
  c.normal = nw;
  c.closing = closing;
  contacts[k] = c;
}
