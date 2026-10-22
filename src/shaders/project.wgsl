// ---- structure → nature projection (docs/GRIDS.md) -----------------------------
// What the nature grid sees of the structure grids: each nature column casts
// its world-vertical line (through the hex centre) down through every
// structure's rotated voxel grid — a 3D DDA in the grid's local space — and
// keeps every solid stretch it crosses, so the air inside a structure (a
// room, the gap under a tilted wall) stays air. Merged with the CPU's
// sleeping bodies (integrity.ts, bodyCpu), they are the column's projected
// intervals, in the layers' own interval form (common.wgsl projAt): up to
// PROJ_K per column, top first; stretches closer than MERGE_GAP join (no
// sand fits between them), and past PROJ_K the lowest join. The loose ground
// lies on them, falls through the air between them and is carried into it
// (sediment.wgsl); water lies on the top one, wind is sheltered by it.
//
//   bodyProj (out, 25): x the top one's top (-1 none), y the lowest one's
//     bottom, z id (CPU body; -1 a structure), w unused
//   foreign  (out, 26): xy the top face's world normal (its z ≥ 0 follows),
//     z structure + 1 (0 none), w its top material
//   proj     (out, 27): PROJ_K texels per column (x·PROJ_K + k): z0, z1,
//     material, structure + 1 (0 a CPU body); z1 ≤ z0 none
@group(0) @binding(3) var<storage, read> frames: array<Frame>;
@group(0) @binding(4) var<storage, read> vox: array<u32>;
// the physics voxels over each column (physics.ts, last tick): bitcast(top + 1),
// 0xffffffff − bitcast(bottom + 1); 0 none
@group(0) @binding(5) var<storage, read> physCols: array<u32>;
@group(0) @binding(24) var bodyCpu: texture_2d<f32>;
@group(0) @binding(25) var bodyOut: texture_storage_2d<rgba32float, write>;
@group(0) @binding(26) var foreignOut: texture_storage_2d<rgba32float, write>;
@group(0) @binding(27) var projOut: texture_storage_2d<rgba32float, write>;

const MERGE_GAP: f32 = 0.5;
const RAW_K: u32 = 8u;

/** The column's stretches so far, top first: x top, y bottom, z material, w structure + 1. */
var<private> L: array<vec4<f32>, RAW_K>;
var<private> nL: u32 = 0u;

/** Add the solid stretch s, joining what it touches; full, it joins the lowest. */
fn addStretch(s: vec4<f32>) {
  var c = s;
  // what it overlaps or nearly touches joins it (the higher one's material)
  var w = 0u;
  for (var k = 0u; k < nL; k++) {
    let o = L[k];
    if (o.y <= c.x + MERGE_GAP && c.y <= o.x + MERGE_GAP) {
      if (o.x > c.x) { c.z = o.z; c.w = o.w; }
      c.x = max(c.x, o.x);
      c.y = min(c.y, o.y);
    } else {
      L[w] = o;
      w += 1u;
    }
  }
  nL = w;
  if (nL == RAW_K) {
    // (full: it joins the lowest)
    let o = L[nL - 1u];
    nL -= 1u;
    if (o.x > c.x) { c.z = o.z; c.w = o.w; }
    c.x = max(c.x, o.x);
    c.y = min(c.y, o.y);
  }
  // in by its top
  var at = nL;
  while (at > 0u && L[at - 1u].x < c.x) {
    L[at] = L[at - 1u];
    at -= 1u;
  }
  L[at] = c;
  nL += 1u;
}

struct Top { n: vec3<f32>, z: f32 };

/** The solid stretches of structure s under world point xy (a DDA down the vertical); returns its top face. */
fn stretchesOf(s: u32, f: Frame, xy: vec2<f32>) -> Top {
  var tp = Top(vec3<f32>(0.0, 0.0, 1.0), -1.0);
  let zTop = f32(G.zMax) + 2.0;
  let o = toLocal(f, vec3<f32>(xy, zTop));
  let dir = qrot(qconj(f.q), vec3<f32>(0.0, 0.0, -1.0));
  let dims = vec3<f32>(f.d.xyz);
  // the line's stretch inside the grid's box (slabs)
  let inv = 1.0 / select(dir, vec3<f32>(1e-8), abs(dir) < vec3<f32>(1e-8));
  let ta = (vec3<f32>(0.0) - o) * inv;
  let tb = (dims - o) * inv;
  let tlo = min(ta, tb);
  let thi = max(ta, tb);
  let t0 = max(max(tlo.x, tlo.y), max(tlo.z, 0.0));
  let t1 = min(min(thi.x, thi.y), thi.z);
  if (t1 <= t0) { return tp; }
  // the axis of the face the line came in by (the last slab it entered)
  var axis = 2;
  if (tlo.x >= tlo.y && tlo.x >= tlo.z) { axis = 0; } else if (tlo.y >= tlo.z) { axis = 1; }
  let p = o + dir * (t0 + 1e-4);
  var c = clamp(vec3<i32>(floor(p)), vec3<i32>(0), vec3<i32>(f.d.xyz) - 1);
  let st = vec3<i32>(sign(dir));
  let tDelta = abs(inv);
  var tMax = (vec3<f32>(c) + max(vec3<f32>(st), vec3<f32>(0.0)) - o) * inv;
  tMax = select(tMax, vec3<f32>(1e9), abs(dir) < vec3<f32>(1e-8));
  var t = t0;
  var inSolid = false;
  var top = 0.0;
  var mat = 0u;
  let steps = i32(f.d.x + f.d.y + f.d.z) + 2;
  for (var i = 0; i < steps; i++) {
    let v = vox[voxIndex(f, c)];
    let solid = voxMat(v) != 0u;
    if (solid && !inSolid) {
      inSolid = true;
      top = zTop - t;
      mat = voxMat(v);
      if (tp.z < 0.0) {
        tp.z = top;
        // the face entered: its normal points back up the line
        var nl = vec3<f32>(0.0);
        nl[axis] = -f32(st[axis]);
        tp.n = qrot(f.q, nl);
      }
    } else if (!solid && inSolid) {
      inSolid = false;
      addStretch(vec4<f32>(top, zTop - t, f32(mat), f32(s + 1u)));
    }
    // to the next voxel along the line
    if (tMax.x < tMax.y && tMax.x < tMax.z) { axis = 0; } else if (tMax.y < tMax.z) { axis = 1; } else { axis = 2; }
    t = tMax[axis];
    c[axis] += st[axis];
    tMax[axis] += tDelta[axis];
    if (t >= t1 || !inGrid(f, c)) {
      if (inSolid) { addStretch(vec4<f32>(top, zTop - min(t, t1), f32(mat), f32(s + 1u))); }
      break;
    }
  }
  return tp;
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= G.mapW || id.y >= G.mapH) { return; }
  let p = vec2<i32>(id.xy);
  let xy = cellPos(p);
  nL = 0u;
  let cpu = textureLoad(bodyCpu, p, 0);
  var out = cpu;
  // (a CPU body is one stretch; its material isn't known here: stone)
  if (cpu.x >= 0.0) { addStretch(vec4<f32>(cpu.x, cpu.y, f32(MAT_STONE), 0.0)); }
  // (the physics voxels over it: one stretch, as a CPU body)
  let ci = colIdx(id.x, id.y);
  let pt = physCols[2u * ci];
  if (pt != 0u) {
    let top = bitcast<f32>(pt) - 1.0;
    let bot = bitcast<f32>(0xffffffffu - physCols[2u * ci + 1u]) - 1.0;
    addStretch(vec4<f32>(top, bot, f32(MAT_STONE), 0.0));
    if (out.x < top) { out.x = top; out.z = -1.0; }
  }
  var fo = vec4<f32>(0.0, 0.0, 0.0, 0.0);
  for (var s = 0u; s < MAX_STRUCTS; s++) {
    let f = frames[s];
    if (f.d.x == 0u) { continue; }
    if (xy.x < f.b.x || xy.y < f.b.y || xy.x > f.b.z || xy.y > f.b.w) { continue; }
    let tp = stretchesOf(s, f, xy);
    if (tp.z < 0.0) { continue; }
    if (out.x < 0.0 || tp.z > out.x) {
      out.z = -1.0;
      fo = vec4<f32>(tp.n.xy, f32(s + 1u), 0.0);
    }
    out.x = max(out.x, tp.z);
  }
  // past PROJ_K the lowest join
  while (nL > PROJ_K) {
    let a = L[nL - 2u];
    let b = L[nL - 1u];
    L[nL - 2u] = vec4<f32>(a.x, min(a.y, b.y), a.z, a.w);
    nL -= 1u;
  }
  if (nL > 0u) {
    out.x = L[0].x;
    out.y = L[nL - 1u].y;
    fo.w = L[0].z;
  }
  for (var k = 0u; k < PROJ_K; k++) {
    var v = vec4<f32>(0.0);
    // (bottom, top: the layers' order within an interval)
    if (k < nL) { v = vec4<f32>(L[k].y, L[k].x, L[k].z, L[k].w); }
    textureStore(projOut, vec2<i32>(p.x * i32(PROJ_K) + i32(k), p.y), v);
  }
  textureStore(bodyOut, p, out);
  textureStore(foreignOut, p, fo);
}
