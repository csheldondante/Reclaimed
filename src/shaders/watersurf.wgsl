// ---- (watersurf, FC2) the water's top as a surface: the lattice of the wet columns' centres ----------------
// The sims keep their per-column fields (water depth, the surface, the drift); here, at the renderer's boundary,
// they become a surface: the triangle lattice the columns' centres form (the hex rows are a triangular lattice),
// each triangle that has a wet corner listed once as three window-order column indices (winIdx). The renderer
// draws the list indexed (render.wgsl vsWaterSurf: a column's vertex at its water's level, worked out once per
// column and shared by its six triangles) and shades it with fsWater.
// Column p owns the two triangles above it: (p, its east, its upper right) and (p, its upper right, its upper
// left); every triangle of the lattice is one column's. Triangles off screen aren't listed.
@group(0) @binding(4) var<storage, read> surface: array<u32>;
@group(0) @binding(5) var<storage, read> water: array<f32>;
@group(0) @binding(7) var<storage, read_write> tris: array<u32>;
// drawIndexedIndirect's args: index count, instance count, first index, base vertex, first instance
@group(0) @binding(9) var<storage, read_write> args: array<atomic<u32>>;

// the view (render.wgsl Camera's first fields)
struct SurfCam {
  viewProj: mat4x4<f32>,
  eye: vec4<f32>,
  viewport: vec4<f32>,
};
@group(0) @binding(31) var<uniform> SC: SurfCam;

/** render.wgsl WATER_MIN_R: a column wetter than this is water */
const WET_MIN: f32 = 0.012;
/** a margin round the screen, clip units (the swell's tilt, a wave's height) */
const SURF_PAD: f32 = 0.04;

var<workgroup> wgN: atomic<u32>;
var<workgroup> wgBase: u32;

/** column q's bed (x: its surface and drift) and depth (y) */
fn bedDepth(q: vec2<i32>) -> vec2<f32> {
  let i = colIdxI(q);
  return vec2<f32>(f32(sfZ(surface[i])) + driftAt(q), water[i]);
}

/** is the triangle (corner levels as x, y, z of each) on screen? */
fn triSeen(a: vec3<f32>, b: vec3<f32>, c: vec3<f32>) -> bool {
  var lo = vec2<f32>(1e9);
  var hi = vec2<f32>(-1e9);
  let ps = array<vec3<f32>, 3>(a, b, c);
  for (var k = 0u; k < 3u; k++) {
    // (a dry corner lies at or under its bed: its bed and a cell under it bound it)
    for (var z = 0u; z < 2u; z++) {
      let q = SC.viewProj * vec4<f32>(ps[k].xy, ps[k].z - f32(z) * 1.5, 1.0);
      if (q.w <= 1e-3) { return true; }
      let n = q.xy / q.w;
      lo = min(lo, n);
      hi = max(hi, n);
    }
  }
  return all(hi > vec2<f32>(-1.0 - SURF_PAD)) && all(lo < vec2<f32>(1.0 + SURF_PAD));
}

@compute @workgroup_size(8, 8)
fn build(@builtin(global_invocation_id) id: vec3<u32>, @builtin(local_invocation_index) li: u32) {
  if (li == 0u) { atomicStore(&wgN, 0u); }
  workgroupBarrier();
  var t0 = false;
  var t1 = false;
  let p = vec2<i32>(id.xy);
  let o = p.y & 1;
  let e = p + vec2<i32>(1, 0);
  let ur = vec2<i32>(p.x + o, p.y + 1);
  let ul = vec2<i32>(p.x + o - 1, p.y + 1);
  // (round 107, pages: ur — the row above, shifted right on odd rows — is past the window's right edge for an odd
  // row's last column; both triangles use it, so neither is made there. ?pagecheck=1 found it looked up off the window)
  if (id.x < G.mapW && id.y + 1u < G.mapH && inMap(ur)) {
    let bp = bedDepth(p);
    let bur = bedDepth(ur);
    // (a heightfield chunk's water is the LOD rings' — hybrid; renderprep's rule for the boxes was the same)
    let wp = bp.y > WET_MIN && !heightfieldCol(id.xy);
    let wur = bur.y > WET_MIN && !heightfieldCol(vec2<u32>(ur));
    let zp = vec3<f32>(cellPos(p), bp.x + max(bp.y, 0.0));
    let zur = vec3<f32>(cellPos(ur), bur.x + max(bur.y, 0.0));
    if (inMap(e)) {
      let be = bedDepth(e);
      let we = be.y > WET_MIN && !heightfieldCol(vec2<u32>(e));
      t0 = (wp || we || wur) && triSeen(zp, vec3<f32>(cellPos(e), be.x + max(be.y, 0.0)), zur);
    }
    if (inMap(ul)) {
      let bl = bedDepth(ul);
      let wl = bl.y > WET_MIN && !heightfieldCol(vec2<u32>(ul));
      t1 = (wp || wur || wl) && triSeen(zp, zur, vec3<f32>(cellPos(ul), bl.x + max(bl.y, 0.0)));
    }
  }
  let n = u32(t0) + u32(t1);
  let off = atomicAdd(&wgN, n * 3u);
  workgroupBarrier();
  if (li == 0u) { wgBase = atomicAdd(&args[0], atomicLoad(&wgN)); }
  workgroupBarrier();
  var w = wgBase + off;
  // (the list's room is its worst case, two triangles a column: renderer.ts)
  if (t0) {
    tris[w] = winIdx(p);
    tris[w + 1u] = winIdx(e);
    tris[w + 2u] = winIdx(ur);
    w += 3u;
  }
  if (t1) {
    tris[w] = winIdx(p);
    tris[w + 1u] = winIdx(ur);
    tris[w + 2u] = winIdx(ul);
  }
}
