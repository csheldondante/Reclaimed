// ---- atlas/columns.wgsl ---------------------------------------------------
// Columns for the streamer from the atlas (round 67): a batch of w × h world
// cells from (AP.x0, AP.y0), wrapped round the torus.
//  colHeight  the ground (compose.wgsl) of the batch and a margin of one
//  colFinish  each column: its slope from its six neighbours, then what lies
//             on it (loose cover at its angle of repose, sand where it's wet,
//             snow where it's cold, the region's own material, its accent
//             where the pattern stands highest), the caves under it (two
//             dual-threshold noises crossing make tunnels, a third's peaks
//             caverns), water below the sea, moisture and plants.

struct ColG {
  h: f32,
  w: f32,
  coast: f32,
  pv: f32,
  a: u32,
  b: u32,
  _p0: u32,
  _p1: u32,
}

/** per column: top, cover depth, materials (top | rock << 8), water, moisture, plants, two caves (z0, z1), region, kind */
struct ColOut {
  top: f32,
  cover: f32,
  mats: u32,
  water: f32,
  moisture: f32,
  veg: f32,
  c0: vec2<f32>,
  c1: vec2<f32>,
  region: u32,
  kind: u32,
}

@group(0) @binding(30) var<storage, read_write> colG: array<ColG>;
@group(0) @binding(31) var<storage, read_write> colOut: array<ColOut>;

const MAT_SAND: u32 = 3u;
const MAT_SILT: u32 = 22u;
const MAT_SNOW: u32 = 25u;

/** the world cell (x, y) wrapped, and its centre */
fn cellW(x: i32, y: i32) -> vec2<f32> {
  let cols = i32(round(AP.worldW));
  let rows = i32(round(AP.worldH / ROW_H_A));
  let w = wrapi(vec2<i32>(x, y), vec2<i32>(cols, rows));
  return vec2<f32>(f32(w.x) + 0.5 + 0.5 * f32(w.y & 1), (f32(w.y) + 0.5) * ROW_H_A);
}

@compute @workgroup_size(8, 8)
fn colHeight(@builtin(global_invocation_id) id: vec3<u32>) {
  let mw = AP.w + 2u;
  if (id.x >= mw || id.y >= AP.h + 2u) { return; }
  let p = cellW(AP.x0 - 1 + i32(id.x), AP.y0 - 1 + i32(id.y));
  let g = ground(p);
  colG[id.y * mw + id.x] = ColG(g.h, g.w, g.coast, g.pv, g.a, g.b, 0u, 0u);
}

fn caves(p: vec2<f32>, top: f32, r: Region) -> vec4<f32> {
  var out = vec4<f32>(0.0);
  if (r.cave <= 0.0) { return out; }
  let zLo = 3.0;
  let zHi = top - AP.caveDepth;
  if (zHi < zLo + 3.0) { return out; }
  let per = perOf(AP.caveScale);
  let q = torusU(p) * f32(per);
  let perB = max(1, per / 3);
  let qb = torusU(p) * f32(perB);
  let t = 0.03 + 0.035 * r.cave;
  var n = 0;
  var start = -1.0;
  for (var z = zLo; z < zHi; z += 1.0) {
    let a = vfbm3(vec3<f32>(q, z / 9.0), vec2<i32>(per), 2u, AP.seed + 61u);
    let b = vfbm3(vec3<f32>(q, z / 9.0), vec2<i32>(per), 2u, AP.seed + 62u);
    let big = vfbm3(vec3<f32>(qb, z / 14.0), vec2<i32>(perB), 2u, AP.seed + 63u);
    let open = (abs(a) < t && abs(b) < t) || big > 0.5 - 0.06 * r.cave;
    if (open && start < 0.0) { start = z; }
    if ((!open || z + 1.0 >= zHi) && start >= 0.0) {
      let end = select(z, z + 1.0, open);
      if (end - start >= 2.0) {
        if (n == 0) { out = vec4<f32>(start, end, out.zw); }
        else { out = vec4<f32>(out.xy, start, end); }
        n++;
        if (n == 2) { break; }
      }
      start = -1.0;
    }
  }
  return out;
}

@compute @workgroup_size(8, 8)
fn colFinish(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= AP.w || id.y >= AP.h) { return; }
  let mw = AP.w + 2u;
  let x = AP.x0 + i32(id.x);
  let y = AP.y0 + i32(id.y);
  let rows = i32(round(AP.worldH / ROW_H_A));
  let odd = ((((y % rows) + rows) % rows) & 1) == 1;
  let g = colG[(id.y + 1u) * mw + id.x + 1u];
  let p = cellW(x, y);
  // the slope: the steepest step to a neighbour (odd-r offsets, lattice.ts)
  var dxs = array<i32, 6>(1, -1, 0, -1, -1, 0);
  var dys = array<i32, 6>(0, 0, 1, -1, 1, -1);
  if (odd) { dxs = array<i32, 6>(1, -1, 1, 0, 0, 1); }
  var slope = 0.0;
  for (var k = 0; k < 6; k++) {
    let n = colG[u32(i32(id.y) + 1 + dys[k]) * mw + u32(i32(id.x) + 1 + dxs[k])];
    slope = max(slope, abs(n.h - g.h));
  }
  // whose ground this is (dithered across a blend)
  let hsh = hf(hash2u(x, y, AP.seed + 71u));
  var ri = g.b;
  if (g.w + (hsh - 0.5) * 0.3 > 0.5) { ri = g.a; }
  let R = regs[ri];
  let top = g.h;
  let wet = top < AP.sea + 1.2;
  let temp = temperature(p, top);
  let snowy = temp < 0.0;
  var cover = max(R.cover - slope * 0.5, 0.0);
  var topMat = R.topMat;
  if (slope > 1.6) {
    cover = 0.0;
  } else if (wet) {
    cover = 1.5;
    topMat = select(MAT_SAND, MAT_SILT, R.topMat == MAT_SILT);
  } else if (snowy) {
    cover = 0.8;
    topMat = MAT_SNOW;
  }
  // (only the peaks: at 0.7 the kaleido's domes were carpeted in crystal)
  if (R.accent != 0u && g.a == ri && g.pv > 0.9 && !wet) {
    topMat = R.accent;
    cover = max(cover, 1.0);
  }
  var o: ColOut;
  o.top = top;
  o.cover = min(cover, top - 1.0);
  o.mats = topMat | (R.rockMat << 8u);
  o.water = max(AP.sea - top, 0.0);
  var m = moistureAt(p, g.coast, R.moist);
  if (wet) { m = max(m, 0.8); }
  o.moisture = m;
  o.veg = 0.0;
  if (o.water == 0.0 && !snowy && o.cover > 0.0 && R.veg > 0.0 && top < AP.sea + 70.0) {
    let woods = smoothstep(0.05, 0.35, pfbm(torusU(p), perOf(55.0), 3u, AP.seed + 6u)) * smoothstep(AP.sea + 60.0, AP.sea + 20.0, top);
    o.veg = clamp(R.veg * (1.0 + m * 1.6 + woods * 2.2) + (hf(hash2u(x, y, AP.seed + 7u)) - 0.5) * 0.6, 0.0, 4.2);
  }
  let cv = caves(p, top - o.cover, R);
  o.c0 = cv.xy;
  o.c1 = cv.zw;
  o.region = ri;
  o.kind = R.kind;
  colOut[id.y * AP.w + id.x] = o;
}
