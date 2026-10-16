// ---- structure → nature projection (docs/GRIDS.md) -----------------------------
// What the nature grid sees of the structure grids: each nature column casts
// its world-vertical line (through the hex centre) down through every
// structure's rotated voxel grid — a 3D DDA in the grid's local space — and
// keeps the solid it meets: the top of the first solid run from above, with
// the world normal of the face the line entered it by (exact for voxel
// boxes), and the bottom of the last. Merged with the CPU's sleeping bodies
// (integrity.ts, bodyCpu), it is the body projection every system already
// respects (bodyTopAt: water lies on it, loose ground banks against it and
// lands on it, wind is sheltered by it). Air pockets inside a structure count
// as solid for now (one span per column).
//
//   bodyProj (out, 25): x top (-1 none), y bottom, z id (CPU body; -1 a
//     structure), w unused
//   foreign  (out, 26): xy the top face's world normal (its z ≥ 0 follows),
//     z structure + 1 (0 none), w its top material
@group(0) @binding(3) var<storage, read> frames: array<Frame>;
@group(0) @binding(4) var<storage, read> vox: array<u32>;
@group(0) @binding(24) var bodyCpu: texture_2d<f32>;
@group(0) @binding(25) var bodyOut: texture_storage_2d<rgba32float, write>;
@group(0) @binding(26) var foreignOut: texture_storage_2d<rgba32float, write>;

struct Span { top: f32, bottom: f32, n: vec3<f32>, mat: u32, hit: bool };

/** The solid span of structure f under world point xy (DDA down the vertical). */
fn spanOf(f: Frame, xy: vec2<f32>) -> Span {
  var sp = Span(-1.0, 1e9, vec3<f32>(0.0, 0.0, 1.0), 0u, false);
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
  if (t1 <= t0) { return sp; }
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
  let steps = i32(f.d.x + f.d.y + f.d.z) + 2;
  for (var i = 0; i < steps; i++) {
    let v = vox[voxIndex(f, c)];
    let solid = voxMat(v) != 0u;
    if (solid && !inSolid) {
      inSolid = true;
      if (!sp.hit) {
        sp.hit = true;
        sp.top = zTop - t;
        // the face entered: its normal points back up the line
        var nl = vec3<f32>(0.0);
        nl[axis] = -f32(st[axis]);
        sp.n = qrot(f.q, nl);
        sp.mat = voxMat(v);
      }
    } else if (!solid && inSolid) {
      inSolid = false;
      sp.bottom = zTop - t;
    }
    // to the next voxel along the line
    if (tMax.x < tMax.y && tMax.x < tMax.z) { axis = 0; } else if (tMax.y < tMax.z) { axis = 1; } else { axis = 2; }
    t = tMax[axis];
    c[axis] += st[axis];
    tMax[axis] += tDelta[axis];
    if (t >= t1 || !inGrid(f, c)) {
      if (inSolid) { sp.bottom = zTop - min(t, t1); }
      break;
    }
  }
  return sp;
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= G.mapW || id.y >= G.mapH) { return; }
  let p = vec2<i32>(id.xy);
  let xy = cellPos(p);
  var out = textureLoad(bodyCpu, p, 0);
  var fo = vec4<f32>(0.0, 0.0, 0.0, 0.0);
  for (var s = 0u; s < MAX_STRUCTS; s++) {
    let f = frames[s];
    if (f.d.x == 0u) { continue; }
    if (xy.x < f.b.x || xy.y < f.b.y || xy.x > f.b.z || xy.y > f.b.w) { continue; }
    let sp = spanOf(f, xy);
    if (!sp.hit) { continue; }
    if (out.x < 0.0) {
      out = vec4<f32>(sp.top, sp.bottom, -1.0, 0.0);
      fo = vec4<f32>(sp.n.xy, f32(s + 1u), f32(sp.mat));
    } else {
      if (sp.top > out.x) { out.z = -1.0; fo = vec4<f32>(sp.n.xy, f32(s + 1u), f32(sp.mat)); }
      out.x = max(out.x, sp.top);
      out.y = min(out.y, sp.bottom);
    }
  }
  textureStore(bodyOut, p, out);
  textureStore(foreignOut, p, fo);
}
