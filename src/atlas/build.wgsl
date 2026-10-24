// ---- atlas/build.wgsl -----------------------------------------------------
// The macro passes (round 67), n × n texels over the torus, one thread a
// texel (8 × 8 workgroups):
//  base        continents (fbm above a threshold, domain-warped) and faults
//  cc*         connected components (GPU flood fill: hooking the roots of
//              neighbours with the same key onto the smaller, and pointer
//              jumping; run to a fixed point); ccCount their sizes
//  clean       islands and lakes too small to keep are flipped
//  regionKey   the partition: a texel's key is its land or water, its
//              Voronoi cell and which side of the fault's band it is on (two
//              thresholds of one noise: below, between — the fault's strip —
//              above); regions are the components of equal keys
//  jfa*        jump flooding from the regions' borders and from the coast:
//              the distance to each, and the region across
//  macroHeight the ground at each texel (compose.wgsl) for the map and stats

@group(0) @binding(1) var<storage, read_write> fieldA: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read_write> keyB: array<u32>;
@group(0) @binding(3) var<storage, read_write> label: array<atomic<u32>>;
@group(0) @binding(4) var<storage, read_write> sizeB: array<atomic<u32>>;
@group(0) @binding(5) var<storage, read_write> flag: array<atomic<u32>>;
@group(0) @binding(6) var<storage, read_write> regionW: array<u32>;
@group(0) @binding(7) var<storage, read_write> jfaSrc: array<vec2<u32>>;
@group(0) @binding(8) var<storage, read_write> jfaDst: array<vec2<u32>>;
@group(0) @binding(9) var<storage, read_write> distW: array<vec4<f32>>;
@group(0) @binding(10) var<storage, read_write> infoB: array<u32>;
@group(0) @binding(11) var<storage, read_write> hmac: array<f32>;

fn texU(id: vec2<u32>) -> vec2<f32> { return (vec2<f32>(id) + 0.5) / f32(AP.n); }
fn nb(id: vec2<u32>, k: i32) -> u32 {
  var o = vec2<i32>(1, 0);
  if (k == 1) { o = vec2<i32>(-1, 0); }
  if (k == 2) { o = vec2<i32>(0, 1); }
  if (k == 3) { o = vec2<i32>(0, -1); }
  return texIdxW(vec2<i32>(id.xy) + o);
}
fn macroWarp(u: vec2<f32>) -> vec2<f32> {
  return vec2<f32>(pfbm(u, 4, 4u, AP.seed + 11u), pfbm(u + 0.37, 4, 4u, AP.seed + 12u)) * AP.warp;
}

@compute @workgroup_size(8, 8)
fn base(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= AP.n || id.y >= AP.n) { return; }
  let i = id.y * AP.n + id.x;
  let u = texU(id.xy);
  let wq = macroWarp(u);
  let c = pfbm(u + wq, i32(AP.landPer), 7u, AP.seed + 1u);
  let f = pfbm(u + wq * 0.5, i32(AP.faultPer), 5u, AP.seed + 3u);
  let land = select(0.0, 1.0, c > AP.landThresh);
  fieldA[i] = vec4<f32>(c, f, land, 0.0);
  keyB[i] = u32(land) + 1u;
}

@compute @workgroup_size(8, 8)
fn ccInit(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= AP.n || id.y >= AP.n) { return; }
  let i = id.y * AP.n + id.x;
  atomicStore(&label[i], i);
}

@compute @workgroup_size(8, 8)
fn ccHook(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= AP.n || id.y >= AP.n) { return; }
  let i = id.y * AP.n + id.x;
  let k = keyB[i];
  let mine = atomicLoad(&label[atomicLoad(&label[i])]);
  var best = mine;
  for (var d = 0; d < 4; d++) {
    let j = nb(id.xy, d);
    if (keyB[j] == k) {
      best = min(best, atomicLoad(&label[atomicLoad(&label[j])]));
    }
  }
  if (best < mine) {
    // (parents only ever go down, within the component: always a forest)
    let old = atomicMin(&label[mine], best);
    if (old > best) { atomicStore(&flag[0], 1u); }
    atomicMin(&label[i], best);
  }
}

@compute @workgroup_size(8, 8)
fn ccJump(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= AP.n || id.y >= AP.n) { return; }
  let i = id.y * AP.n + id.x;
  let p = atomicLoad(&label[i]);
  let pp = atomicLoad(&label[p]);
  if (pp < p) {
    atomicStore(&label[i], pp);
    atomicStore(&flag[0], 1u);
  }
}

@compute @workgroup_size(8, 8)
fn ccCount(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= AP.n || id.y >= AP.n) { return; }
  let i = id.y * AP.n + id.x;
  atomicAdd(&sizeB[atomicLoad(&label[i])], 1u);
}

@compute @workgroup_size(8, 8)
fn clean(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= AP.n || id.y >= AP.n) { return; }
  let i = id.y * AP.n + id.x;
  var a = fieldA[i];
  let size = atomicLoad(&sizeB[atomicLoad(&label[i])]);
  if (a.z > 0.5 && size < AP.minIsland) { a.z = 0.0; }
  else if (a.z < 0.5 && size < AP.minLake) { a.z = 1.0; }
  fieldA[i] = a;
  keyB[i] = u32(a.z) + 1u;
}

@compute @workgroup_size(8, 8)
fn regionKey(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= AP.n || id.y >= AP.n) { return; }
  let i = id.y * AP.n + id.x;
  let a = fieldA[i];
  let u = texU(id.xy);
  let cells = i32(AP.cellsPer);
  // the cells bend at their own scale (two octaves, as far as about half a cell) so none is a polygon
  let cw = 1.0 / AP.cellsPer;
  let w1 = vec2<f32>(pfbm(u, max(cells / 2, 1), 3u, AP.seed + 13u), pfbm(u, max(cells / 2, 1), 3u, AP.seed + 14u));
  let w2 = vec2<f32>(pfbm(u, cells * 2, 2u, AP.seed + 15u), pfbm(u, cells * 2, 2u, AP.seed + 16u));
  let q = u + macroWarp(u) * 0.6 + w1 * cw * 1.1 + w2 * cw * 0.35;
  let w = pworley(q * f32(cells), vec2<i32>(cells), AP.jitter, AP.seed + 5u);
  // provinces: a coarser partition the region's kinds take after
  let pc = max(1, cells / 6);
  let pw = pworley(q * f32(pc), vec2<i32>(pc), 0.9, AP.seed + 6u);
  let land = a.z > 0.5;
  var band = 1u;
  if (a.y < AP.faultLo) { band = 0u; }
  if (a.y > AP.faultHi) { band = 2u; }
  if (land) {
    keyB[i] = w.id * 6u + 2u + band;
  } else {
    band = 0u;
    keyB[i] = w.id * 6u + 1u;
  }
  infoB[i] = u32(land) | (band << 1u) | (pw.id << 3u);
}

// ---- jump flooding ----------------------------------------------------------

fn packXY(x: u32, y: u32) -> u32 { return (x | (y << 16u)) + 1u; }
fn unpackXY(v: u32) -> vec2<i32> { return vec2<i32>(i32((v - 1u) & 0xffffu), i32((v - 1u) >> 16u)); }
/** world units between texels a and b, the short way round the torus */
fn tdist(a: vec2<i32>, b: vec2<i32>) -> f32 {
  let n = i32(AP.n);
  var d = abs(a - b);
  d = min(d, vec2<i32>(n) - d);
  return length(vec2<f32>(d) * vec2<f32>(AP.worldW, AP.worldH) / f32(AP.n));
}
fn texelW() -> f32 { return 0.5 * (AP.worldW + AP.worldH) / f32(AP.n); }

@compute @workgroup_size(8, 8)
fn jfaSeedR(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= AP.n || id.y >= AP.n) { return; }
  let i = id.y * AP.n + id.x;
  let r = regionW[i];
  var out = vec2<u32>(0u);
  for (var d = 0; d < 4; d++) {
    let o = regionW[nb(id.xy, d)];
    if (o != r) { out = vec2<u32>(packXY(id.x, id.y), o); }
  }
  jfaSrc[i] = out;
}

@compute @workgroup_size(8, 8)
fn jfaSeedC(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= AP.n || id.y >= AP.n) { return; }
  let i = id.y * AP.n + id.x;
  let land = isLand(regs[regionW[i]]);
  var out = vec2<u32>(0u);
  for (var d = 0; d < 4; d++) {
    if (isLand(regs[regionW[nb(id.xy, d)]]) != land) { out = vec2<u32>(packXY(id.x, id.y), 0u); }
  }
  jfaSrc[i] = out;
}

@compute @workgroup_size(8, 8)
fn jfaStep(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= AP.n || id.y >= AP.n) { return; }
  let i = id.y * AP.n + id.x;
  let me = vec2<i32>(id.xy);
  var best = jfaSrc[i];
  var bd = 1e30;
  if (best.x != 0u) { bd = tdist(me, unpackXY(best.x)); }
  let k = i32(AP.step);
  for (var dy = -1; dy <= 1; dy++) {
    for (var dx = -1; dx <= 1; dx++) {
      if (dx == 0 && dy == 0) { continue; }
      let c = jfaSrc[texIdxW(me + vec2<i32>(dx, dy) * k)];
      if (c.x == 0u) { continue; }
      let d = tdist(me, unpackXY(c.x));
      if (d < bd) {
        bd = d;
        best = c;
      }
    }
  }
  jfaDst[i] = best;
}

@compute @workgroup_size(8, 8)
fn jfaOutR(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= AP.n || id.y >= AP.n) { return; }
  let i = id.y * AP.n + id.x;
  let s = jfaSrc[i];
  let r = regionW[i];
  var o = distW[i];
  if (s.x == 0u) {
    // (one region all round the world: no border)
    o.x = 1e6;
    o.z = bitcast<f32>(r);
  } else {
    let sp = unpackXY(s.x);
    let d = tdist(vec2<i32>(id.xy), sp);
    let rs = regionW[texIdxW(sp)];
    // the border runs half a texel beyond the seed's centre
    if (rs == r) {
      o.x = d + 0.5 * texelW();
      o.z = bitcast<f32>(s.y);
    } else {
      o.x = max(d - 0.5 * texelW(), 0.0);
      o.z = bitcast<f32>(rs);
    }
  }
  distW[i] = o;
}

@compute @workgroup_size(8, 8)
fn jfaOutC(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= AP.n || id.y >= AP.n) { return; }
  let i = id.y * AP.n + id.x;
  let s = jfaSrc[i];
  let land = isLand(regs[regionW[i]]);
  var o = distW[i];
  var d = 1e6;
  if (s.x != 0u) {
    let sp = unpackXY(s.x);
    let same = isLand(regs[regionW[texIdxW(sp)]]) == land;
    d = tdist(vec2<i32>(id.xy), sp);
    d = select(max(d - 0.5 * texelW(), 0.0), d + 0.5 * texelW(), same);
  }
  o.y = select(-d, d, land);
  distW[i] = o;
}

@compute @workgroup_size(8, 8)
fn macroHeight(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= AP.n || id.y >= AP.n) { return; }
  let i = id.y * AP.n + id.x;
  let p = texU(id.xy) * vec2<f32>(AP.worldW, AP.worldH);
  hmac[i] = ground(p).h;
}
