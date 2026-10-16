// ---- structure grids → draw instances (docs/GRIDS.md) --------------------------
// One thread per voxel of the pool: a solid voxel with a face open to the air
// becomes one rotated-cube instance in the body format (render.wgsl vsBody:
// centre xyz as f32 bits + material word, then the rotation), appended with
// one global atomic per workgroup. The material word carries the voxel's moss
// and sand cover (bits 8..23) for the shading, and bit 31: a structure voxel
// (not a CPU body).
@group(0) @binding(3) var<storage, read> frames: array<Frame>;
@group(0) @binding(4) var<storage, read> vox: array<u32>;
@group(0) @binding(5) var<storage, read_write> inst: array<vec4<u32>>;
// [0] vertex count (36), [1] instance count
@group(0) @binding(6) var<storage, read_write> indirect: array<atomic<u32>>;

var<workgroup> wgN: atomic<u32>;
var<workgroup> wgBase: u32;

/** The structure voxel v of the pool belongs to, and its cell there (x < 0: none). */
fn locate(v: u32) -> vec4<i32> {
  for (var s = 0u; s < MAX_STRUCTS; s++) {
    let f = frames[s];
    if (f.d.x == 0u) { continue; }
    let n = f.d.x * f.d.y * f.d.z;
    if (v < f.d.w || v >= f.d.w + n) { continue; }
    let k = v - f.d.w;
    return vec4<i32>(i32(k % f.d.x), i32((k / f.d.x) % f.d.y), i32(k / (f.d.x * f.d.y)), i32(s));
  }
  return vec4<i32>(-1);
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3<u32>, @builtin(local_invocation_index) li: u32) {
  if (li == 0u) { atomicStore(&wgN, 0u); }
  workgroupBarrier();
  let v = id.x;
  var show = false;
  var f: Frame;
  var c = vec3<i32>(0);
  var w = 0u;
  if (v < arrayLength(&vox)) {
    let at = locate(v);
    if (at.x >= 0) {
      f = frames[u32(at.w)];
      c = at.xyz;
      w = vox[v];
      if (voxMat(w) != 0u) {
        for (var k = 0u; k < 6u; k++) {
          let q = c + FACE6[k];
          if (!inGrid(f, q) || voxMat(vox[voxIndex(f, q)]) == 0u) { show = true; }
        }
      }
    }
  }
  let off = atomicAdd(&wgN, select(0u, 1u, show));
  workgroupBarrier();
  if (li == 0u) { wgBase = atomicAdd(&indirect[1], atomicLoad(&wgN)); }
  workgroupBarrier();
  if (!show) { return; }
  let centre = toWorld(f, vec3<f32>(c) + 0.5);
  let o = (wgBase + off) * 2u;
  inst[o] = vec4<u32>(bitcast<u32>(centre.x), bitcast<u32>(centre.y), bitcast<u32>(centre.z), w | 0x80000000u);
  inst[o + 1u] = vec4<u32>(bitcast<u32>(f.q.x), bitcast<u32>(f.q.y), bitcast<u32>(f.q.z), bitcast<u32>(f.q.w));
}
