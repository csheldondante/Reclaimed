// ---- atlas/columns.wgsl ---------------------------------------------------
// Columns for the streamer from the atlas (round 67): a batch of w × h world
// cells from (AP.x0, AP.y0), wrapped round the torus.
//  colHeight  the ground (compose.wgsl) of the batch and a margin of one
//  caves      two dual-threshold noises crossing make tunnels, a third's
//             peaks caverns (the viewer's map of them; forms.wgsl's column
//             march uses caveField, the same as a signed value)
// Each column's finish and solid (what lies on it, what stands on it, what's
// cut out of it) is forms.wgsl's colFinish.

struct ColG {
  h: f32,
  w: f32,
  coast: f32,
  pv: f32,
  a: u32,
  b: u32,
  /** the border: distance (signed towards a), the lower side's height */
  s: f32,
  hlo: f32,
  /** a river: its level (−1: none), distance from its line in half-widths, 1 lava */
  rl: f32,
  rx: f32,
  rflags: u32,
  /** the coarse world: loose ground's material, its depth, water, lava, what added rock is */
  lmat: u32,
  loose: f32,
  cw: f32,
  clava: f32,
  cap: u32,
  /** a great cavern under it (round 78, compose.wgsl cavernAt): floor, roof (none when roof ≤ floor) */
  cf: f32,
  cr: f32,
  /** an oddity's material (compose.wgsl Ground.smat) */
  smat: u32,
}

@group(0) @binding(30) var<storage, read_write> colG: array<ColG>;

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
  var cav = cavernAt(p, g);
  var h = g.h;
  var loose = g.loose;
  // a mesa's overhang (round 78): the lip raises the column, the open under it carved as a cavern's is
  // (under a lip, the talus there is the open's floor: what's loose lies on a column's top)
  if (cav.y <= cav.x && g.ov.z > g.ov.y) {
    cav = g.ov.yz;
    if (g.ov.x > h) {
      cav.x += loose;
      loose = 0.0;
      h = g.ov.x;
    }
  }
  colG[id.y * mw + id.x] = ColG(h, g.w, g.coast, g.pv, g.a, g.b, g.s, g.hlo, g.rl, g.rx, g.rflags, g.lmat, loose, g.cw, g.clava, g.cap, cav.x, cav.y, g.smat);
}

/** a cave noise's height scale: its scale at caveScale 40, grown with it (round 79: bigger caves both ways) */
fn caveZ(z40: f32) -> f32 { return z40 * AP.caveScale / 40.0; }

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
    let a = vfbm3(vec3<f32>(q, z / caveZ(9.0)), vec2<i32>(per), 2u, AP.seed + 61u);
    let b = vfbm3(vec3<f32>(q, z / caveZ(9.0)), vec2<i32>(per), 2u, AP.seed + 62u);
    let big = vfbm3(vec3<f32>(qb, z / caveZ(14.0)), vec2<i32>(perB), 2u, AP.seed + 63u);
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

/** the caves as a value at height z (> 0 open): tunnels where two noises are both near zero, caverns at a third's peaks */
fn caveField(q: vec2<f32>, qb: vec2<f32>, per: i32, perB: i32, z: f32, cave: f32) -> f32 {
  let t = 0.03 + 0.035 * cave;
  let a = vfbm3(vec3<f32>(q, z / caveZ(9.0)), vec2<i32>(per), 2u, AP.seed + 61u);
  let b = vfbm3(vec3<f32>(q, z / caveZ(9.0)), vec2<i32>(per), 2u, AP.seed + 62u);
  let big = vfbm3(vec3<f32>(qb, z / caveZ(14.0)), vec2<i32>(perB), 2u, AP.seed + 63u);
  return max((t - max(abs(a), abs(b))) / t, (big - (0.5 - 0.06 * cave)) * 8.0);
}
