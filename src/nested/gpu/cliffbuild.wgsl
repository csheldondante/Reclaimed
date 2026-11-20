// ---- nested/gpu/cliffbuild.wgsl: the cliff rule's per-cell table for the 16 m window (round 32 step B2) ----------------
// One compute pass when the window's contents change (src/nested/cliffbox.ts: on a new window or after the store settles;
// never per frame). Per coarse cell of the window: the rule's derived record (crDerive from the real column tops, as B1's
// cliff4.wgsl reads them per pixel) and, for SPLIT cells, an entry in the box list (the instance count by an atomic in
// the indirect draw arguments). Module: TCAP, segWgsl (read), store.wgsl, then CR_LV / CR_UPL / CR_AMPL, cliffrule.wgsl
// and this file (cliffbox.ts buildCode).
//
// Record (CR_REC = 8 words, window-local index (cy - gy) * n + (cx - gx)):
//   w0 kind | saddle << 2 | (a + 8) << 4 | (b + 8) << 8 | top material id << 12;  w1 H;  w2 L;  w3 theta;
//   w4 dTheta (0: not stored yet);  w5 h;  w6 Lb (the box's bottom);  w7 maskMax (the mask's bound over the cell, /256);
//   w8..w11 the side walls E, W, N, S (a sheet neighbour's edge height, about; i32 min for none)
// Box list entry: (cx - gx) | (cy - gy) << 16.

struct CrBU {
  /** the window: gx, gy, n */
  win: vec4<i32>,
}
@group(0) @binding(0) var<uniform> bu: CrBU;
@group(0) @binding(1) var<storage, read> tab: array<u32>;
@group(0) @binding(2) var<storage, read_write> crTabW: array<u32>;
@group(0) @binding(3) var<storage, read_write> crListW: array<u32>;
@group(0) @binding(4) var<storage, read_write> crArgsW: array<atomic<u32>>;
fn tabLoad(i: u32) -> u32 { return tab[i]; }

var<private> crMissing: bool;
/** the top of column (L, X, Y)'s highest solid record (local units) and its material id; (-1e30, 0) when none */
fn crColTop(L: u32, X: i32, Y: i32) -> vec2<f32> {
  let n = recCount(L, X, Y);
  var t = -1e30;
  var m = 0u;
  for (var j = 0u; j < n; j++) {
    let r = recAt(L, X, Y, j);
    if (matSolid(r.y)) {
      t = bitcast<f32>(r.x);
      m = matId(r.y);
    }
  }
  return vec2<f32>(t, f32(m));
}
fn crH(x: i32, y: i32) -> i32 {
  let g = bu.win;
  let t = crColTop(CR_LV, clamp(x, g.x, g.x + g.z - 1), clamp(y, g.y, g.y + g.z - 1)).x;
  if (t < -1e29) {
    crMissing = true;
    return 0;
  }
  return crUnits(t, CR_UPL);
}

@compute @workgroup_size(64)
fn crBuild(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) nw: vec3<u32>) {
  let n = bu.win.z;
  let i = i32(gid.x + gid.y * nw.x * 64u);
  if (i >= n * n) { return; }
  let lx = i % n;
  let ly = i / n;
  let cx = bu.win.x + lx;
  let cy = bu.win.y + ly;
  crMissing = false;
  let r = crDerive(cx, cy);
  let mat = u32(crColTop(CR_LV, cx, cy).y);
  // (a cell with a missing column is a sheet: the sheet draw shows what it has)
  var kind = r.kind;
  if (crMissing) { kind = CR_SHEET; }
  let b = u32(i) * CR_REC;
  crTabW[b] = kind | (select(0u, 1u, r.saddle) << 2u) | (u32(r.a + 8) << 4u) | (u32(r.b + 8) << 8u) | (mat << 12u);
  crTabW[b + 1u] = bitcast<u32>(r.H);
  crTabW[b + 2u] = bitcast<u32>(r.L);
  crTabW[b + 3u] = bitcast<u32>(r.theta);
  crTabW[b + 4u] = bitcast<u32>(r.dTheta);
  crTabW[b + 5u] = bitcast<u32>(r.h);
  // (w6: the box's bottom Lb: the lowest of L and the heights within 2 cells (the 13-cell diamond), so the box's side faces
  // reach down to any lower neighbouring floor or sheet; inside the box everything below L is solid ground)
  var lb = r.L;
  for (var dy = -2; dy <= 2; dy++) {
    for (var dx = -2; dx <= 2; dx++) {
      if (abs(dx) + abs(dy) > 2) { continue; }
      lb = min(lb, crH(cx + dx, cy + dy));
    }
  }
  crTabW[b + 6u] = bitcast<u32>(lb);
  crTabW[b + 7u] = bitcast<u32>(crMaskMaxOf(cx, cy));
  // (w8..w11: per side E, W, N, S, the wall a sheet neighbour's edge makes: the higher of that side's two corners, each the
  // mean of the 4 cells round it (the sheets' corner heights, about), plus 1 m for the finer levels' detail; a SPLIT
  // neighbour: its floor L (its box closes the side above it). A ray leaving the cell through a side below it hits it:
  // fsBox5)
  for (var s = 0; s < 4; s++) {
    let nx = cx + CR_NBX[s];
    let ny = cy + CR_NBY[s];
    var wall = -2147483647;
    let nk = crKindOf(nx, ny).kind;
    if (kind == CR_SPLIT && nk == CR_SPLIT) {
      // (a SPLIT neighbour: its ground below its floor L is solid, and its box may not reach down to where this ray is)
      wall = crDerive(nx, ny).L;
    } else if (kind == CR_SPLIT) {
      // (the side's two corners: along y for E / W, along x for N / S)
      let t = vec2<i32>(abs(CR_NBY[s]), abs(CR_NBX[s]));
      var top = -2147483647;
      for (var c = -1; c <= 1; c += 2) {
        let ax = cx + t.x * c;
        let ay = cy + t.y * c;
        let m = crFdiv(crH(cx, cy) + crH(nx, ny) + crH(ax, ay) + crH(ax + CR_NBX[s], ay + CR_NBY[s]), 4);
        top = max(top, m);
      }
      wall = top + 64;
    }
    crTabW[b + 8u + u32(s)] = bitcast<u32>(wall);
  }
  if (kind == CR_SPLIT) {
    let k = atomicAdd(&crArgsW[1], 1u);
    crListW[k] = u32(lx) | (u32(ly) << 16u);
  }
}
