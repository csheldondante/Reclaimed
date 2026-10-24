// ---- atlas/patsim.wgsl ----------------------------------------------------
// The simulated tiles of the pattern bank (round 67): Gray–Scott reaction–
// diffusion on a wrapping PAT_TILE² grid (coral at one feed/kill, a maze at
// another). One thread a texel, ping-pong between two state buffers.

struct RDP {
  feed: f32,
  kill: f32,
  du: f32,
  dv: f32,
  n: u32,
  out: u32,
  _p0: u32,
  _p1: u32,
}

@group(0) @binding(0) var<uniform> RD: RDP;
@group(0) @binding(1) var<storage, read> src: array<vec2<f32>>;
@group(0) @binding(2) var<storage, read_write> dst: array<vec2<f32>>;
@group(0) @binding(3) var<storage, read_write> tiles: array<f32>;

fn at(x: i32, y: i32) -> vec2<f32> {
  let n = i32(RD.n);
  return src[u32(((y % n) + n) % n) * RD.n + u32(((x % n) + n) % n)];
}

@compute @workgroup_size(8, 8)
fn rdStep(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= RD.n || id.y >= RD.n) { return; }
  let x = i32(id.x);
  let y = i32(id.y);
  let c = at(x, y);
  let lap = 0.2 * (at(x + 1, y) + at(x - 1, y) + at(x, y + 1) + at(x, y - 1)) + 0.05 * (at(x + 1, y + 1) + at(x - 1, y + 1) + at(x + 1, y - 1) + at(x - 1, y - 1)) - c;
  let uvv = c.x * c.y * c.y;
  let u = c.x + RD.du * lap.x - uvv + RD.feed * (1.0 - c.x);
  let v = c.y + RD.dv * lap.y + uvv - (RD.feed + RD.kill) * c.y;
  dst[id.y * RD.n + id.x] = vec2<f32>(clamp(u, 0.0, 1.0), clamp(v, 0.0, 1.0));
}

@compute @workgroup_size(8, 8)
fn rdOut(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= RD.n || id.y >= RD.n) { return; }
  let i = id.y * RD.n + id.x;
  tiles[RD.out * RD.n * RD.n + i] = smoothstep(0.08, 0.32, src[i].y);
}

// Several steps a dispatch (the dispatches are what cost): each workgroup
// loads its 16² tile with a halo of RD_HALO into workgroup memory and steps
// it RD_HALO times there; the halo goes stale a texel a step, the tile stays
// exact.
const RD_TS: u32 = 16u;
const RD_HALO: u32 = 6u;
const RD_SW: u32 = 28u;
var<workgroup> sa: array<vec2<f32>, 784>;
var<workgroup> sb: array<vec2<f32>, 784>;

fn rdUpdate(c: vec2<f32>, edges: vec2<f32>, corners: vec2<f32>) -> vec2<f32> {
  let lap = 0.2 * edges + 0.05 * corners - c;
  let uvv = c.x * c.y * c.y;
  let u = c.x + RD.du * lap.x - uvv + RD.feed * (1.0 - c.x);
  let v = c.y + RD.dv * lap.y + uvv - (RD.feed + RD.kill) * c.y;
  return vec2<f32>(clamp(u, 0.0, 1.0), clamp(v, 0.0, 1.0));
}

fn inner(k: u32) -> bool {
  let x = k % RD_SW;
  let y = k / RD_SW;
  return x > 0u && y > 0u && x < RD_SW - 1u && y < RD_SW - 1u;
}

// (twice, sa → sb and sb → sa: pointers to workgroup memory can't be passed)
fn stepAB(li: u32) {
  for (var k = li; k < RD_SW * RD_SW; k += 256u) {
    if (!inner(k)) { sb[k] = sa[k]; continue; }
    sb[k] = rdUpdate(sa[k], sa[k + 1u] + sa[k - 1u] + sa[k + RD_SW] + sa[k - RD_SW], sa[k + RD_SW + 1u] + sa[k + RD_SW - 1u] + sa[k - RD_SW + 1u] + sa[k - RD_SW - 1u]);
  }
}
fn stepBA(li: u32) {
  for (var k = li; k < RD_SW * RD_SW; k += 256u) {
    if (!inner(k)) { sa[k] = sb[k]; continue; }
    sa[k] = rdUpdate(sb[k], sb[k + 1u] + sb[k - 1u] + sb[k + RD_SW] + sb[k - RD_SW], sb[k + RD_SW + 1u] + sb[k + RD_SW - 1u] + sb[k - RD_SW + 1u] + sb[k - RD_SW - 1u]);
  }
}

@compute @workgroup_size(16, 16)
fn rdMulti(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_index) li: u32) {
  let ox = i32(wg.x * RD_TS) - i32(RD_HALO);
  let oy = i32(wg.y * RD_TS) - i32(RD_HALO);
  for (var k = li; k < RD_SW * RD_SW; k += 256u) {
    sa[k] = at(ox + i32(k % RD_SW), oy + i32(k / RD_SW));
  }
  workgroupBarrier();
  for (var s = 0u; s < RD_HALO / 2u; s++) {
    stepAB(li);
    workgroupBarrier();
    stepBA(li);
    workgroupBarrier();
  }
  let lx = li % RD_TS;
  let ly = li / RD_TS;
  let gx = wg.x * RD_TS + lx;
  let gy = wg.y * RD_TS + ly;
  dst[gy * RD.n + gx] = sa[(ly + RD_HALO) * RD_SW + lx + RD_HALO];
}
