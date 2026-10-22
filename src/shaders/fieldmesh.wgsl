// ---- field mesh (G13 C, a prototype) -------------------------------------------
// The terrain and the structure grids drawn as one surface: a signed field is
// evaluated on the fly from what's stored — the columns' intervals and the
// structures' voxels — and meshed with surface nets over the region's sample
// grid (meshregion.wgsl). Nothing new is stored but the mesh itself (and a
// scratch grid while it's built). The field is negative inside:
//   terrain   each column's vertical distance to its nearest solid boundary
//             (touching intervals are one solid; below 0 is bedrock),
//             blended over the three nearest columns (the triangle lattice of
//             centres), so slopes run smooth and caves and overhangs stay
//   structure the distance to its voxels' boxes in its own rotated frame
//             (outside: to the nearest solid voxel; inside: to the nearest
//             air), so its edges stay sharp
//   both      a smooth minimum, so sand against a wall makes a fillet
// The look comes from the intervals per fragment (meshdraw.wgsl): the field
// gives the shape, the intervals the layers.
//
// Three passes over the region: sampleField (the field at every sample), makeVerts (a
// vertex per sample cell the surface crosses, at the mean of its edge
// crossings, with the field's gradient for its normal) and makeQuads (two
// triangles per crossed sample edge, joining the four cells around it).
@group(0) @binding(3) var<storage, read> layers: array<vec4<u32>>;
@group(0) @binding(4) var<storage, read> frames: array<Frame>;
@group(0) @binding(5) var<storage, read> vox: array<u32>;
// the field at each sample (f32 bits), then each cell's vertex (NONE: none)
@group(0) @binding(6) var<storage, read_write> scratch: array<u32>;
// two vec4<u32> per vertex: (x, y, z as f32 bits, structure voxel word),
// (normal xyz as f32 bits, structure share 0..1 as f32 bits)
@group(0) @binding(7) var<storage, read_write> verts: array<vec4<u32>>;
@group(0) @binding(8) var<storage, read_write> indices: array<u32>;
// [0..4] drawIndexedIndirect args (index count at 0), [5] vertex count
@group(0) @binding(9) var<storage, read_write> counts: array<atomic<u32>>;

const NONE: u32 = 0xffffffffu;
/** How far either field reaches (cells): past it, it's just "far". */
const FAR: f32 = 3.0;
/** The smooth minimum's reach (the fillet where terrain meets a structure). */
const FILLET: f32 = 0.6;

/** Vertical signed distance to column q's solid at height z (negative inside). */
fn colDist(q: vec2<i32>, z: f32) -> f32 {
  if (z < 0.0) { return max(z, -FAR); }
  var d = z;
  if (!inMap(q)) { return min(d, FAR); }
  let cs = colSlots(u32(q.x), u32(q.y));
  // the solid runs: touching intervals are one (a boundary between two
  // layers isn't a surface)
  var lo = 0.0;
  var hi = 0.0;
  for (var i = 0u; i < cs.y; i++) {
    let v = layers[cs.x + i];
    if (ivEmpty(v)) { break; }
    let z0 = ivZ0(v);
    let z1 = ivZ1(v);
    if (z0 - hi > 1e-3) {
      // a gap: the run so far is done
      if (z >= lo && z <= hi) { return max(-min(select(z - lo, FAR, lo <= 0.0), hi - z), -FAR); }
      d = min(d, min(abs(z - lo), abs(z - hi)));
      lo = z0;
    }
    hi = z1;
  }
  if (z >= lo && z <= hi) { return max(-min(select(z - lo, FAR, lo <= 0.0), hi - z), -FAR); }
  d = min(d, min(abs(z - lo), abs(z - hi)));
  return min(d, FAR);
}

fn terrainField(p: vec3<f32>) -> f32 {
  let t = triAt(p.xy);
  var d = 0.0;
  for (var k = 0; k < 3; k++) { d += t.w[k] * colDist(t.c[k], p.z); }
  return d;
}

/** The structures' field at p (x) and the word of the solid voxel nearest it (y; 0 none). */
fn structField(p: vec3<f32>) -> vec2<f32> {
  var best = vec2<f32>(FAR, 0.0);
  for (var s = 0u; s < MAX_STRUCTS; s++) {
    let f = frames[s];
    if (f.d.x == 0u) { continue; }
    if (p.x < f.b.x || p.y < f.b.y || p.x > f.b.z || p.y > f.b.w) { continue; }
    let l = toLocal(f, p);
    let dims = vec3<f32>(f.d.xyz);
    if (any(l < vec3<f32>(-1.0)) || any(l > dims + 1.0)) { continue; }
    let c0 = vec3<i32>(floor(l));
    let solid = inGrid(f, c0) && voxMat(vox[voxIndex(f, c0)]) != 0u;
    // the nearest voxel of the other kind among the 27 round it
    var d = 1.0;
    var word = 0u;
    if (solid) { word = vox[voxIndex(f, c0)]; }
    for (var k = 0u; k < 27u; k++) {
      let c = c0 + vec3<i32>(i32(k % 3u) - 1, i32((k / 3u) % 3u) - 1, i32(k / 9u) - 1);
      var v = 0u;
      if (inGrid(f, c)) { v = vox[voxIndex(f, c)]; }
      if ((voxMat(v) != 0u) == solid) { continue; }
      // (distance to that voxel's box)
      let q = abs(l - vec3<f32>(c) - 0.5) - 0.5;
      let bd = length(max(q, vec3<f32>(0.0)));
      if (bd < d) {
        d = bd;
        if (!solid) { word = v; }
      }
    }
    if (solid) { d = -d; }
    if (d < best.x) { best = vec2<f32>(d, bitcast<f32>(word)); }
  }
  return best;
}

fn smin(a: f32, b: f32, k: f32) -> f32 {
  let h = max(k - abs(a - b), 0.0) / k;
  return min(a, b) - h * h * k * 0.25;
}

fn field(p: vec3<f32>) -> f32 { return smin(terrainField(p), structField(p).x, FILLET); }

fn sampleIdx(c: vec3<u32>) -> u32 { return c.x + MR.n.x * (c.y + MR.n.y * c.z); }
fn nSamples() -> u32 { return MR.n.x * MR.n.y * MR.n.z; }
fn samplePos(c: vec3<u32>) -> vec3<f32> { return MR.o.xyz + vec3<f32>(c) * MR.o.w; }
fn fieldAt(c: vec3<u32>) -> f32 { return bitcast<f32>(scratch[sampleIdx(c)]); }

@compute @workgroup_size(4, 4, 4)
fn sampleField(@builtin(global_invocation_id) id: vec3<u32>) {
  if (any(id >= MR.n.xyz)) { return; }
  scratch[sampleIdx(id)] = bitcast<u32>(field(samplePos(id)));
}

const CORNER = array<vec3<u32>, 8>(
  vec3<u32>(0u, 0u, 0u), vec3<u32>(1u, 0u, 0u), vec3<u32>(0u, 1u, 0u), vec3<u32>(1u, 1u, 0u),
  vec3<u32>(0u, 0u, 1u), vec3<u32>(1u, 0u, 1u), vec3<u32>(0u, 1u, 1u), vec3<u32>(1u, 1u, 1u));
// the cube's twelve edges as corner pairs
const EDGE = array<vec2<u32>, 12>(
  vec2<u32>(0u, 1u), vec2<u32>(2u, 3u), vec2<u32>(4u, 5u), vec2<u32>(6u, 7u),
  vec2<u32>(0u, 2u), vec2<u32>(1u, 3u), vec2<u32>(4u, 6u), vec2<u32>(5u, 7u),
  vec2<u32>(0u, 4u), vec2<u32>(1u, 5u), vec2<u32>(2u, 6u), vec2<u32>(3u, 7u));

@compute @workgroup_size(4, 4, 4)
fn makeVerts(@builtin(global_invocation_id) id: vec3<u32>) {
  if (any(id >= MR.n.xyz)) { return; }
  let ci = nSamples() + sampleIdx(id);
  scratch[ci] = NONE;
  if (any(id + 1u >= MR.n.xyz)) { return; }
  var v: array<f32, 8>;
  var inside = 0u;
  for (var k = 0u; k < 8u; k++) {
    v[k] = fieldAt(id + CORNER[k]);
    if (v[k] < 0.0) { inside |= 1u << k; }
  }
  if (inside == 0u || inside == 255u) { return; }
  // the mean of the edge crossings
  var acc = vec3<f32>(0.0);
  var n = 0.0;
  for (var e = 0u; e < 12u; e++) {
    let a = EDGE[e].x;
    let b = EDGE[e].y;
    if ((v[a] < 0.0) == (v[b] < 0.0)) { continue; }
    let t = v[a] / (v[a] - v[b]);
    acc += mix(vec3<f32>(CORNER[a]), vec3<f32>(CORNER[b]), t);
    n += 1.0;
  }
  let p = samplePos(id) + acc / n * MR.o.w;
  let at = atomicAdd(&counts[5], 1u);
  if (at >= arrayLength(&verts) / 2u) { return; }
  scratch[ci] = at;
  // the normal: the field's gradient (central differences of the field itself,
  // not the samples, so it's smooth across cells)
  let e = MR.o.w * 0.35;
  let g = vec3<f32>(
    field(p + vec3<f32>(e, 0.0, 0.0)) - field(p - vec3<f32>(e, 0.0, 0.0)),
    field(p + vec3<f32>(0.0, e, 0.0)) - field(p - vec3<f32>(0.0, e, 0.0)),
    field(p + vec3<f32>(0.0, 0.0, e)) - field(p - vec3<f32>(0.0, 0.0, e)));
  let nrm = normalize(g + vec3<f32>(0.0, 0.0, 1e-6));
  // which of the two it is: the terrain, a structure, or the fillet between
  let s = structField(p);
  let share = clamp(0.5 + (terrainField(p) - s.x) / FILLET, 0.0, 1.0);
  verts[at * 2u] = vec4<u32>(bitcast<u32>(p.x), bitcast<u32>(p.y), bitcast<u32>(p.z), bitcast<u32>(s.y));
  verts[at * 2u + 1u] = vec4<u32>(bitcast<u32>(nrm.x), bitcast<u32>(nrm.y), bitcast<u32>(nrm.z), bitcast<u32>(share));
}

fn cellVert(c: vec3<u32>) -> u32 { return scratch[nSamples() + sampleIdx(c)]; }

/** Two triangles joining the vertices of the four cells round a crossed edge. */
fn quad(a: vec3<u32>, b: vec3<u32>, c: vec3<u32>, d: vec3<u32>) {
  let va = cellVert(a);
  let vb = cellVert(b);
  let vc = cellVert(c);
  let vd = cellVert(d);
  if (va == NONE || vb == NONE || vc == NONE || vd == NONE) { return; }
  let at = atomicAdd(&counts[0], 6u);
  if (at + 6u > arrayLength(&indices)) { return; }
  indices[at] = va;
  indices[at + 1u] = vb;
  indices[at + 2u] = vc;
  indices[at + 3u] = va;
  indices[at + 4u] = vc;
  indices[at + 5u] = vd;
}

@compute @workgroup_size(4, 4, 4)
fn makeQuads(@builtin(global_invocation_id) id: vec3<u32>) {
  if (any(id + 1u >= MR.n.xyz)) { return; }
  let s0 = fieldAt(id) < 0.0;
  let X = vec3<u32>(1u, 0u, 0u);
  let Y = vec3<u32>(0u, 1u, 0u);
  let Z = vec3<u32>(0u, 0u, 1u);
  // (the edges from this sample along +x, +y, +z; the cells round an edge
  // reach one sample back, so the region's first row of samples has none)
  if (id.y > 0u && id.z > 0u && s0 != (fieldAt(id + X) < 0.0)) { quad(id - Y - Z, id - Z, id, id - Y); }
  if (id.x > 0u && id.z > 0u && s0 != (fieldAt(id + Y) < 0.0)) { quad(id - X - Z, id - Z, id, id - X); }
  if (id.x > 0u && id.y > 0u && s0 != (fieldAt(id + Z) < 0.0)) { quad(id - X - Y, id - Y, id, id - X); }
}
