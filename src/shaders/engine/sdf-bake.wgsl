// The model store's bake (src/engine/sdf/models.ts): occupancy bits in, a signed distance field and the surface
// sample list out, many models a dispatch. sdf-model.wgsl is put in front.
//
// A batch is a list of jobs. A thread is one padded voxel of one job: thread t belongs to the last job whose tBase is
// at most t (a binary search of at most log2(jobs) steps). The scratch holds, per thread, the nearest occupied voxel
// and the nearest empty voxel found so far (x | y << 8 | z << 16, or SDF_NONE).
//   seed      every voxel is its own nearest of its kind; an occupied voxel with an open face is appended to the
//             model's samples (an atomic counter a model, kept to the job's room)
//   jfa       a jump flood pass at P.step: the 26 neighbours at that stride offer their nearest of each kind
//   finalize  empty voxel: + distance to the nearest occupied voxel's box; occupied: - distance to the nearest empty
//             voxel's box. So the zero is on the voxel faces and corners are exact. grad8 also keeps the unit
//             gradient, by central differences of those distances (one-sided at the grid's edge).
//   commit    the model row's sample count, from the counter
// Distance is from the voxel's centre to the other voxel's box (the cube of side 1 round its centre), in voxels.

struct BakeParams {
  jobs: u32,
  threads: u32,
  step: u32,
  pad: u32,
}
struct Job {
  model: u32,
  tBase: u32,
  occBase: u32,
  sampleCap: u32,
}

@group(0) @binding(0) var<uniform> P: BakeParams;
@group(0) @binding(1) var<storage, read> jobs: array<Job>;
@group(0) @binding(2) var<storage, read_write> models: array<SdfModel>;
@group(0) @binding(3) var<storage, read> occ: array<u32>;
@group(0) @binding(4) var<storage, read> src: array<vec2<u32>>;
@group(0) @binding(5) var<storage, read_write> dst: array<vec2<u32>>;
@group(0) @binding(6) var<storage, read_write> data: array<u32>;
@group(0) @binding(7) var<storage, read_write> bakeCount: array<atomic<u32>>;

fn jobOf(t: u32) -> u32 {
  var lo = 0u;
  var hi = P.jobs;
  while (hi - lo > 1u) {
    let mid = (lo + hi) / 2u;
    if (jobs[mid].tBase <= t) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return lo;
}

fn lin(p: vec3<i32>, d: vec3<u32>) -> u32 {
  return u32(p.x) + d.x * (u32(p.y) + d.y * u32(p.z));
}

fn unlin(i: u32, d: vec3<u32>) -> vec3<i32> {
  return vec3<i32>(i32(i % d.x), i32((i / d.x) % d.y), i32(i / (d.x * d.y)));
}

fn inGrid(p: vec3<i32>, d: vec3<u32>) -> bool {
  return all(p >= vec3<i32>(0)) && all(p < vec3<i32>(d));
}

fn occAt(base: u32, p: vec3<i32>, d: vec3<u32>) -> bool {
  if (!inGrid(p, d)) {
    return false;
  }
  let i = lin(p, d);
  return ((occ[base + (i >> 5u)] >> (i & 31u)) & 1u) == 1u;
}

fn packXyz(p: vec3<i32>) -> u32 {
  return u32(p.x) | (u32(p.y) << 8u) | (u32(p.z) << 16u);
}

/** squared distance from voxel v's centre to seed s's box (voxels) */
fn boxD2(v: vec3<i32>, s: u32) -> f32 {
  if (s == SDF_NONE) {
    return 1e30;
  }
  let e = max(abs(vec3<f32>(v - sdfXyz(s))) - vec3<f32>(0.5), vec3<f32>(0.0));
  return dot(e, e);
}

@compute @workgroup_size(64)
fn seed(@builtin(global_invocation_id) gid: vec3<u32>) {
  let t = gid.x;
  if (t >= P.threads) {
    return;
  }
  let job = jobs[jobOf(t)];
  let m = models[job.model];
  let d = sdfDims(m.dims);
  let i = t - job.tBase;
  if (i >= d.x * d.y * d.z) {
    dst[t] = vec2<u32>(SDF_NONE, SDF_NONE);
    return;
  }
  let p = unlin(i, d);
  let me = packXyz(p);
  if (!occAt(job.occBase, p, d)) {
    dst[t] = vec2<u32>(SDF_NONE, me);
    return;
  }
  dst[t] = vec2<u32>(me, SDF_NONE);
  var open = 0u;
  if (!occAt(job.occBase, p + vec3<i32>(1, 0, 0), d)) { open |= 1u; }
  if (!occAt(job.occBase, p - vec3<i32>(1, 0, 0), d)) { open |= 2u; }
  if (!occAt(job.occBase, p + vec3<i32>(0, 1, 0), d)) { open |= 4u; }
  if (!occAt(job.occBase, p - vec3<i32>(0, 1, 0), d)) { open |= 8u; }
  if (!occAt(job.occBase, p + vec3<i32>(0, 0, 1), d)) { open |= 16u; }
  if (!occAt(job.occBase, p - vec3<i32>(0, 0, 1), d)) { open |= 32u; }
  if (open != 0u) {
    let k = atomicAdd(&bakeCount[job.model], 1u);
    if (k < job.sampleCap) {
      data[m.sampleBase + k] = me | (open << 24u);
    }
  }
}

@compute @workgroup_size(64)
fn jfa(@builtin(global_invocation_id) gid: vec3<u32>) {
  let t = gid.x;
  if (t >= P.threads) {
    return;
  }
  let job = jobs[jobOf(t)];
  let d = sdfDims(models[job.model].dims);
  let i = t - job.tBase;
  if (i >= d.x * d.y * d.z) {
    return;
  }
  let p = unlin(i, d);
  var best = src[t];
  var bo = boxD2(p, best.x);
  var be = boxD2(p, best.y);
  let s = i32(P.step);
  for (var dz = -1; dz <= 1; dz++) {
    for (var dy = -1; dy <= 1; dy++) {
      for (var dx = -1; dx <= 1; dx++) {
        let q = p + vec3<i32>(dx, dy, dz) * s;
        if (!inGrid(q, d)) {
          continue;
        }
        let c = src[job.tBase + lin(q, d)];
        let co = boxD2(p, c.x);
        if (co < bo) {
          bo = co;
          best.x = c.x;
        }
        let ce = boxD2(p, c.y);
        if (ce < be) {
          be = ce;
          best.y = c.y;
        }
      }
    }
  }
  dst[t] = best;
}

/** the signed distance of job-local voxel i (voxels), from the flood's result at scratch entry t */
fn signedAt(t: u32, i: u32, d: vec3<u32>) -> f32 {
  let p = unlin(i, d);
  let s = src[t];
  if (s.x == packXyz(p)) {
    // (occupied: it is its own nearest occupied voxel)
    return -min(sqrt(boxD2(p, s.y)), 1000.0);
  }
  return min(sqrt(boxD2(p, s.x)), 1000.0);
}

@compute @workgroup_size(64)
fn finalize(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (SDF_FORMAT == SDF_SNORM8) {
    // (a thread a word of four voxels: no two threads share a word)
    let t = gid.x * 4u;
    if (t >= P.threads) {
      return;
    }
    let job = jobs[jobOf(t)];
    let m = models[job.model];
    let d = sdfDims(m.dims);
    let n = d.x * d.y * d.z;
    let i = t - job.tBase;
    if (i >= n) {
      return;
    }
    var w = 0u;
    for (var k = 0u; k < 4u; k++) {
      var b = 127u;
      if (i + k < n) {
        b = sdfToByte(signedAt(t + k, i + k, d));
      }
      w |= b << (k * 8u);
    }
    data[m.fieldBase + (i >> 2u)] = w;
  } else {
    let t = gid.x;
    if (t >= P.threads) {
      return;
    }
    let job = jobs[jobOf(t)];
    let m = models[job.model];
    let d = sdfDims(m.dims);
    let i = t - job.tBase;
    if (i >= d.x * d.y * d.z) {
      return;
    }
    let here = signedAt(t, i, d);
    if (SDF_FORMAT == SDF_F32) {
      data[m.fieldBase + i] = bitcast<u32>(here);
      return;
    }
    let p = unlin(i, d);
    var g = vec3<f32>(0.0);
    for (var k = 0u; k < 3u; k++) {
      var e = vec3<i32>(0);
      e[k] = 1;
      var hi = here;
      var lo = here;
      if (p[k] + 1 < i32(d[k])) {
        let j = lin(p + e, d);
        hi = signedAt(job.tBase + j, j, d);
      }
      if (p[k] > 0) {
        let j = lin(p - e, d);
        lo = signedAt(job.tBase + j, j, d);
      }
      g[k] = hi - lo;
    }
    let gl = length(g);
    if (gl > 0.0) {
      g = g / gl;
    }
    data[m.fieldBase + i] = pack4x8snorm(vec4<f32>(clamp(round(here * SDF_SNORM_SCALE), -127.0, 127.0) / 127.0, g));
  }
}

@compute @workgroup_size(64)
fn commit(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= P.jobs) {
    return;
  }
  let job = jobs[gid.x];
  models[job.model].sampleCount = min(atomicLoad(&bakeCount[job.model]), job.sampleCap);
}
