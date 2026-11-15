// ---- the engine's settle: a still deforming body's parts become rigid rows again (DESIGN §10.4 "A body returns to
// rigid once settled"; docs/design/PHYSICS_ENGINE.md, build step 2, letter D) ------------------------------------------
// `slots` (engine_deform.wgsl) moves a still body's slot through S_LABEL0 -> S_LABEL1 -> S_PARTS -> S_RELEASE; the
// kernels here do the work of each state, dispatched over the live pages only while a body settles (dargs[4]):
//   labels   a label a voxel (pw[3i+2].x, u32 bits): the least lattice cell among the voxels it is bonded to, by
//            propagation with pointer jumping, till a whole tick changes none — a part is the voxels of one label, and
//            its root is the voxel whose label is its own cell
//   parts    a thread a root (`partScan`, `partAlloc`, `partRow`: each loops its body's lattice box) and a thread a
//            voxel or a listed triangle for what is written per voxel or per triangle. A part under the crumb size
//            crumbles (`deaths` lays it on the ground: mass conserved). A part that is the whole body, unbroken and
//            undeformed, gives its row back as it was, on the shared model. Any other part takes a row (an odd one),
//            samples and heap from the pool and gets a compact model of its own — a record a cell of its lattice box:
//            its rest place about the part's centre where it lies (the rest frame is the world's at this moment, the
//            row's rotation the identity: a bent beam keeps its bend to the voxel), material, the bonds that hold —
//            and its mesh baked: the faces of its cells that were the body's outer surface, where the skin put them,
//            and the break faces that close it (below). The row is written asleep where its particles stood.
// A root keeps its part's numbers in its own particle's words, which nothing else uses while a body settles:
//   pw[3r]      xyz the part's centre of mass, w its mass
//   pw[3r+1]    u32 bits: voxels, its lattice box's low corner (10 bits an axis), the high one, its row (NONE: none yet)
//   pw[3r+2]    u32 bits: its label, its model's heap index (NONE), its first sample (NONE), its verdict (V_*)
//   px[2r+1]    u32 bits: its mesh's triangles, its samples (w stays the particle's bonds: the draw reads them)
//   ps[3r]      its lattice's frame in the part's rest frame (a quaternion); a whole body: its fitted rotation
//   vh[vhRec(r)], [+2]  atomic counters: triangles, samples — counted, then counted again as they are written
//
// Break faces (the owner's method, BACKLOG PE22: an interface field, an extractor, a skinned break mesh). The field is
// the parts' labels over the body's rest lattice; the interface is where two bonded-at-birth cells are no longer one
// part. The extractor is surface nets on the hex-prism lattice: a vertex a lattice corner (the dual cell: three columns
// by two layers meet there), a polygon a face between a cell of the part and a cell that was the body's but is not the
// part's — the hexagon between two layers, the quad between two columns. A corner's place depends only on the corner
// (the labels of the six cells round it), so the faces of a part meet without gaps, and the two parts either side of a
// crack are given the same surface: they fit like a broken thing. A corner that also touches the body's outer surface
// stays at the cell's own corner, where the outer mesh's vertices are, so the break is sealed to the original surface
// with no re-meshing of it. Inside, the corner goes to the mean of the middles of the cut edges round it (surface
// nets: a straight crack through the hex zigzag comes out flat), by EU.l.y (0: the cells' corners), plus EU.f.w of
// roughness (a noise of the corner). The material grain (brick courses, bedded stone) is the next letter, behind this
// same field: it will move the interface, not the extractor. The new vertices are weighted to the part's cells round
// the corner and baked with the mesh.
@group(0) @binding(34) var<storage, read> dlS: array<u32>;

const V_NEW: u32 = 0u;
const V_CRUMB: u32 = 1u;
const V_WANT: u32 = 2u;
const V_SHARED: u32 = 3u;
const V_DONE: u32 = 4u;
const V_WRITE: u32 = 5u;
// a whole, unbroken body whose voxels lie within this of its model moved rigidly (cells) goes back to its shared model
const SHARED_TOL: f32 = 0.02;
// a hexagon's corner radius (cells): its flat sides half a cell from its centre
const HEX_R: f32 = 0.57735027;
// corner j of a column stands at 30 + 60 j degrees, between the directions CD1[j] and CD2[j]; side s spans the corners
// SIDE_A[s] (at its direction less 30 degrees) and SIDE_B[s] (render/bodymeshbuild.ts: the same faces, the same winding)
const CD1 = array<u32, 6>(0u, 2u, 4u, 1u, 3u, 5u);
const CD2 = array<u32, 6>(2u, 4u, 1u, 3u, 5u, 0u);
const SIDE_A = array<u32, 6>(5u, 2u, 0u, 3u, 1u, 4u);
const SIDE_B = array<u32, 6>(0u, 3u, 1u, 4u, 2u, 5u);

fn labelOf(i: u32) -> u32 { return bitcast<u32>(pw[3u * i + 2u].x); }
fn verdictOf(root: u32) -> u32 { return bitcast<u32>(pw[3u * root + 2u].w); }
fn pack3(v: vec3<u32>) -> u32 { return v.x | (v.y << 10u) | (v.z << 20u); }
fn unpack3(w: u32) -> vec3<u32> { return vec3<u32>(w & 1023u, (w >> 10u) & 1023u, (w >> 20u) & 1023u); }
fn qmulE(a: vec4<f32>, b: vec4<f32>) -> vec4<f32> { return vec4<f32>(a.w * b.xyz + b.w * a.xyz + cross(a.xyz, b.xyz), a.w * b.w - dot(a.xyz, b.xyz)); }
/** hex neighbour s of column c in a lattice box whose first row has parity par */
fn hexNbr(c: vec2<i32>, s: u32, par: i32) -> vec2<i32> { return nbr(c + vec2<i32>(0, par), s) - vec2<i32>(0, par); }

/** particle i of a body whose parts are being made, or ok false */
fn parting(i: u32) -> Lat {
  var L: Lat;
  if (i == NONE) { return L; }
  L = latOf(i);
  L.ok = L.ok && L.state == S_PARTS;
  return L;
}
/** the particle of lattice cell l of a slot if it lives and carries this label, else -1 */
fn partCell(slot: u32, l: vec3<i32>, d: vec3<u32>, label: u32) -> i32 {
  let j = latIdx(slot, l, d);
  if (j < 0 || !alive(u32(j)) || labelOf(u32(j)) != label) { return -1; }
  return j;
}
/** was lattice cell l the body's when it expanded (its model has a voxel there)? */
fn srcSolid(recs: u32, l: vec3<i32>, d: vec3<u32>) -> bool {
  if (any(l < vec3<i32>(0)) || any(vec3<u32>(l) >= d)) { return false; }
  return (bitcast<u32>(heap[recs + u32(l.x) + d.x * (u32(l.y) + d.y * u32(l.z))].w) & 63u) != 0u;
}
/** a contact sample: a cell of the part with one of the ten cells round it (above, below, the eight in its layer — the
 *  six hex neighbours are among them whatever the row's parity) not the part's */
fn surfaceCell(slot: u32, l: vec3<i32>, d: vec3<u32>, label: u32) -> bool {
  if (partCell(slot, l + vec3<i32>(0, 0, 1), d, label) < 0 || partCell(slot, l - vec3<i32>(0, 0, 1), d, label) < 0) { return true; }
  for (var dy = -1; dy <= 1; dy++) {
    for (var dx = -1; dx <= 1; dx++) {
      if (dx == 0 && dy == 0) { continue; }
      if (partCell(slot, l + vec3<i32>(dx, dy, 0), d, label) < 0) { return true; }
    }
  }
  return false;
}
/** the faces of cell l that are break faces (bit 0 above, bit 1 below, bits 2..7 its six sides): the cell beyond was
 *  the body's and is not this part's */
fn breakFaces(slot: u32, recs: u32, par: i32, l: vec3<i32>, d: vec3<u32>, label: u32) -> u32 {
  var m = 0u;
  let up = l + vec3<i32>(0, 0, 1);
  let dn = l - vec3<i32>(0, 0, 1);
  if (srcSolid(recs, up, d) && partCell(slot, up, d, label) < 0) { m |= 1u; }
  if (srcSolid(recs, dn, d) && partCell(slot, dn, d, label) < 0) { m |= 2u; }
  for (var s = 0u; s < 6u; s++) {
    let n = vec3<i32>(hexNbr(l.xy, s, par), l.z);
    if (srcSolid(recs, n, d) && partCell(slot, n, d, label) < 0) { m |= 4u << s; }
  }
  return m;
}
fn faceTris(m: u32) -> u32 { return 4u * countOneBits(m & 3u) + 2u * countOneBits(m >> 2u); }

// ---- labels ----------------------------------------------------------------------------------------------------------
@compute @workgroup_size(64)
fn labelInit(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_index) li: u32) {
  let i = pidx(wg.x, li);
  if (i == NONE) { return; }
  let L = latOf(i);
  if (!L.ok || L.state != S_LABEL0) { return; }
  pw[3u * i + 2u] = bitcast<vec4<f32>>(vec4<u32>(L.k, 0u, 0u, 0u));
}

// (run several times a tick: the least label among the voxels a voxel is bonded to — both ends hold the bond — then
// its label's own label, so a label crosses a part in a few passes; the slot's sums count what changed)
@compute @workgroup_size(64)
fn labelStep(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_index) li: u32) {
  let i = pidx(wg.x, li);
  if (i == NONE) { return; }
  let L = latOf(i);
  if (!L.ok || L.state != S_LABEL1 || !alive(i)) { return; }
  let l = cellOf(L.k, L.dims);
  let bonds = pb[i];
  let mine = labelOf(i);
  var best = mine;
  for (var k = 0u; k < 26u; k++) {
    if ((bonds & (1u << k)) == 0u) { continue; }
    let j = latIdx(L.slot, l + n26(k), L.dims);
    if (j < 0 || !alive(u32(j)) || (pb[u32(j)] & (1u << (25u - k))) == 0u) { continue; }
    best = min(best, labelOf(u32(j)));
  }
  best = min(best, labelOf(partAt(L.slot, best)));
  if (best != mine) {
    pw[3u * i + 2u] = bitcast<vec4<f32>>(vec4<u32>(best, 0u, 0u, 0u));
    atomicAdd(&pool[EU.h.w + SUMS_W * L.slot + 2u], 1u);
  }
}

// ---- parts: a thread a root ------------------------------------------------------------------------------------------
// The part counted and weighed, its verdict given: crumbs, the whole body back on its shared model, or a row to make.
@compute @workgroup_size(64)
fn partScan(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_index) li: u32) {
  let i = pidx(wg.x, li);
  let L = parting(i);
  if (!L.ok || !alive(i) || labelOf(i) != L.k) { return; }
  let v = verdictOf(i);
  if (v == V_WANT) {
    // (found no room last tick: counted again this tick)
    atomicStore(&vh[vhRec(i)], 0u);
    atomicStore(&vh[vhRec(i) + 2u], 0u);
    return;
  }
  if (v != V_NEW) { return; }
  let cells = L.dims.x * L.dims.y * L.dims.z;
  var n = 0u;
  var M = 0.0;
  var c = vec3<f32>(0.0);
  var lo = vec3<u32>(1023u);
  var hi = vec3<u32>(0u);
  for (var k = 0u; k < cells; k++) {
    let j = partAt(L.slot, k);
    if (!alive(j) || labelOf(j) != L.k) { continue; }
    let x = px[2u * j];
    let m = 1.0 / max(x.w, 1e-3);
    n++;
    M += m;
    c += x.xyz * m;
    let cl = vec3<u32>(cellOf(k, L.dims));
    lo = min(lo, cl);
    hi = max(hi, cl);
  }
  c /= M;
  var verdict = select(V_WANT, V_CRUMB, f32(n) < EU.k.z);
  let mh = hAt(dmeta[slotAt(L.slot) + 2u]);
  let recs = mh + MODEL_HDR;
  var q = ps[3u * i + 2u];
  var frame = qmulE(q, heap[mh + 3u]);
  if (verdict == V_WANT && n == bitcast<u32>(heap[mh].w)) {
    // the whole body in one part: does it still fit its model, moved rigidly, every bond holding?
    var c0 = vec3<f32>(0.0);
    for (var k = 0u; k < cells; k++) {
      let j = partAt(L.slot, k);
      if (!alive(j)) { continue; }
      c0 += heap[recs + k].xyz / max(px[2u * j].w, 1e-3);
    }
    c0 /= M;
    var a0 = vec3<f32>(0.0);
    var a1 = vec3<f32>(0.0);
    var a2 = vec3<f32>(0.0);
    for (var k = 0u; k < cells; k++) {
      let j = partAt(L.slot, k);
      if (!alive(j)) { continue; }
      let dx = (px[2u * j].xyz - c) / max(px[2u * j].w, 1e-3);
      let r = heap[recs + k].xyz - c0;
      a0 += dx * r.x;
      a1 += dx * r.y;
      a2 += dx * r.z;
    }
    for (var it = 0; it < 12; it++) {
      let r0 = eqrot(q, vec3<f32>(1.0, 0.0, 0.0));
      let r1 = eqrot(q, vec3<f32>(0.0, 1.0, 0.0));
      let r2 = eqrot(q, vec3<f32>(0.0, 0.0, 1.0));
      let om = (cross(r0, a0) + cross(r1, a1) + cross(r2, a2)) / (abs(dot(r0, a0) + dot(r1, a1) + dot(r2, a2)) + 1e-9);
      let w = length(om);
      if (w < 1e-7) { break; }
      q = normalize(qmulE(vec4<f32>(om / w * sin(w * 0.5), cos(w * 0.5)), q));
    }
    var worst = 0.0;
    var same = true;
    for (var k = 0u; k < cells; k++) {
      let j = partAt(L.slot, k);
      if (!alive(j)) { continue; }
      let rec = heap[recs + k];
      worst = max(worst, length(px[2u * j].xyz - (c + eqrot(q, rec.xyz - c0))));
      if (pb[j] != (bitcast<u32>(rec.w) >> 6u)) { same = false; }
    }
    if (same && worst < SHARED_TOL) {
      verdict = V_SHARED;
      c = c - eqrot(q, c0);
      frame = q;
    }
  }
  pw[3u * i] = vec4<f32>(c, M);
  pw[3u * i + 1u] = bitcast<vec4<f32>>(vec4<u32>(n, pack3(lo), pack3(hi), NONE));
  pw[3u * i + 2u] = bitcast<vec4<f32>>(vec4<u32>(L.k, NONE, NONE, verdict));
  px[2u * i + 1u] = vec4<f32>(0.0, 0.0, 0.0, px[2u * i + 1u].w);
  ps[3u * i] = frame;
  atomicStore(&vh[vhRec(i)], 0u);
  atomicStore(&vh[vhRec(i) + 2u], 0u);
}

// a thread a voxel: its part's samples and break triangles counted
@compute @workgroup_size(64)
fn partCount(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_index) li: u32) {
  let i = pidx(wg.x, li);
  let L = parting(i);
  if (!L.ok || !alive(i)) { return; }
  let label = labelOf(i);
  let root = partAt(L.slot, label);
  if (verdictOf(root) != V_WANT) { return; }
  let l = cellOf(L.k, L.dims);
  let mh = hAt(dmeta[slotAt(L.slot) + 2u]);
  if (surfaceCell(L.slot, l, L.dims, label)) { atomicAdd(&vh[vhRec(root) + 2u], 1u); }
  // (a body with no mesh has no break faces either)
  if (bitcast<u32>(heap[mh + 1u].y) == 0u) { return; }
  let tris = faceTris(breakFaces(L.slot, mh + MODEL_HDR, i32(bitcast<u32>(heap[mh + 1u].w) & 1u), l, L.dims, label));
  if (tris > 0u) { atomicAdd(&vh[vhRec(root)], tris); }
}

/** a listed triangle of a body whose parts are being made: the part of the cell whose face it is */
struct TriPart { ok: bool, slot: u32, root: u32, label: u32, v0: u32 };
fn triPart(t: u32) -> TriPart {
  var T: TriPart;
  if (t >= dlS[7] || t >= EU.i.w) { return T; }
  let r = dlS[DL_AT + 2u * t];
  if ((rowFlags(r) & (ROW_ALIVE | ROW_DEFORM)) != (ROW_ALIVE | ROW_DEFORM)) { return T; }
  T.slot = bitcast<u32>(info[4u * r + 3u].y);
  if (dmeta[slotAt(T.slot)] != S_PARTS) { return T; }
  T.v0 = dlS[DL_AT + 2u * t + 1u];
  let own = bitcast<u32>(heap[T.v0].x);
  if (own == NONE) { return T; }
  let j = partAt(T.slot, own);
  if (!alive(j)) { return T; }
  T.label = labelOf(j);
  T.root = partAt(T.slot, T.label);
  T.ok = true;
  return T;
}

// a thread a listed triangle: its part's outer triangles counted
@compute @workgroup_size(64)
fn triCount(@builtin(global_invocation_id) id: vec3<u32>) {
  // (a draw list past its room does not hold every triangle: no part is made from it — the host grows it)
  if (id.x == 0u) { atomicStore(&vh[1], select(0u, 1u, dlS[7] > EU.i.w)); }
  let T = triPart(id.x);
  if (!T.ok || verdictOf(T.root) != V_WANT) { return; }
  atomicAdd(&vh[vhRec(T.root)], 1u);
}

// a thread a root: its row, its heap and its samples taken; its model's header written
@compute @workgroup_size(64)
fn partAlloc(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_index) li: u32) {
  let i = pidx(wg.x, li);
  let L = parting(i);
  if (!L.ok || !alive(i) || labelOf(i) != L.k || verdictOf(i) != V_WANT) { return; }
  let sum = EU.h.w + SUMS_W * L.slot;
  let tris = atomicExchange(&vh[vhRec(i)], 0u);
  let ns = atomicExchange(&vh[vhRec(i) + 2u], 0u);
  if (atomicLoad(&vh[1]) != 0u) {
    atomicAdd(&pool[sum + 4u], 1u);
    return;
  }
  let A = bitcast<vec4<u32>>(pw[3u * i + 1u]);
  let B = bitcast<vec4<u32>>(pw[3u * i + 2u]);
  let lo = unpack3(A.y);
  let bd = unpack3(A.z) - lo + vec3<u32>(1u);
  let cellsB = bd.x * bd.y * bd.z;
  // (what it has from a tick that found no room for the rest is kept)
  var row = A.w;
  if (row == NONE) {
    let g = takeOne(P_ROW_TOP, P_ROW_NEXT, P_ROW_WANT, EU.h.z, EU.e.x / 2u);
    if (g != NONE) { row = 2u * g + 1u; }
  }
  var hp = B.y;
  if (hp == NONE) { hp = takeRun(P_HEAP_NEXT, P_HEAP_WANT, EU.j.w, MODEL_HDR + cellsB + 3u * MESH_V * tris); }
  var sp = B.z;
  if (sp == NONE) { sp = takeRun(P_SAMP_NEXT, P_SAMP_WANT, EU.j.y, ns); }
  let got = row != NONE && hp != NONE && sp != NONE;
  pw[3u * i + 1u] = bitcast<vec4<f32>>(vec4<u32>(A.x, A.y, A.z, row));
  pw[3u * i + 2u] = bitcast<vec4<f32>>(vec4<u32>(B.x, hp, sp, select(V_WANT, V_WRITE, got)));
  if (!got) {
    atomicAdd(&pool[sum + 4u], 1u);
    atomicAdd(&pool[P_FAIL_SETTLE], 1u);
    return;
  }
  px[2u * i + 1u] = bitcast<vec4<f32>>(vec4<u32>(tris, ns, 0u, bitcast<u32>(px[2u * i + 1u].w)));
  let c = pw[3u * i];
  let s = slotAt(L.slot);
  let src = hAt(dmeta[s + 2u]);
  let h = hAt(hp);
  // its bound, and its box's records cleared (a cell of the box that is not the part's has no voxel)
  var rad = 0.0;
  let cells = L.dims.x * L.dims.y * L.dims.z;
  for (var k = 0u; k < cells; k++) {
    let j = partAt(L.slot, k);
    if (!alive(j) || labelOf(j) != L.k) { continue; }
    rad = max(rad, length(px[2u * j].xyz - c.xyz) + 0.87);
  }
  for (var k = 0u; k < cellsB; k++) { heap[h + MODEL_HDR + k] = vec4<f32>(0.0); }
  let par = (bitcast<u32>(heap[src + 1u].w) + lo.y) & 1u;
  heap[h] = bitcast<vec4<f32>>(vec4<u32>(bd, A.x));
  heap[h + 1u] = bitcast<vec4<f32>>(vec4<u32>(((hp & 0x7fffffffu) + MODEL_HDR + cellsB) | 0x80000000u, 3u * tris, dmeta[s + 22u], par));
  // (its grain is the body's: its box's low corner in the first body's lattice, the same seed)
  let gf = grainFrame(src);
  heap[h + 2u] = vec4<f32>(c.w / f32(A.x), rad, bitcast<f32>(grainFramePack(gf.xyz + lo)), bitcast<f32>(gf.w));
  heap[h + 3u] = ps[3u * i];
  atomicAdd(&pool[P_PARTS], 1u);
}

/** where a part's numbers put cell l of the body's box in the part's own box */
fn boxCell(l: vec3<i32>, lo: vec3<u32>, bd: vec3<u32>) -> u32 {
  let b = vec3<u32>(l) - lo;
  return b.x + bd.x * (b.y + bd.y * b.z);
}

// a thread a voxel: a sample where it is on its part's surface
@compute @workgroup_size(64)
fn partSamples(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_index) li: u32) {
  let i = pidx(wg.x, li);
  let L = parting(i);
  if (!L.ok || !alive(i)) { return; }
  let label = labelOf(i);
  let root = partAt(L.slot, label);
  if (verdictOf(root) != V_WRITE) { return; }
  if (!surfaceCell(L.slot, cellOf(L.k, L.dims), L.dims, label)) { return; }
  let k = atomicAdd(&vh[vhRec(root) + 2u], 1u);
  if (k >= bitcast<u32>(px[2u * root + 1u].y)) { return; }
  samples[sAt(bitcast<u32>(pw[3u * root + 2u].z)) + k] = vec4<f32>(px[2u * i].xyz - pw[3u * root].xyz, 0.5);
}

/** A break vertex: the lattice corner j of column c on the plane under layer zl, for the part `label` whose cell `own`
 *  (in column c) has the face. rest: its place in the body's rest frame; p: where the part's voxels put it now. */
struct BV { p: vec3<f32>, idx: vec4<u32>, wt: vec4<f32> };
fn breakVertex(slot: u32, d: vec3<u32>, recs: u32, par: i32, frame: vec4<f32>, own: vec3<i32>, j: u32, zl: i32, label: u32, lo: vec3<u32>, bd: vec3<u32>) -> BV {
  var cols = array<vec2<i32>, 3>(own.xy, hexNbr(own.xy, CD1[j], par), hexNbr(own.xy, CD2[j], par));
  var rest: array<vec3<f32>, 6>;
  var id: array<u32, 6>;
  var part: array<i32, 6>;
  var cell: array<vec3<i32>, 6>;
  var rim = false;
  var mean = vec3<f32>(0.0);
  var lowK = NONE;
  var highK = 0u;
  for (var a = 0u; a < 6u; a++) {
    let l = vec3<i32>(cols[a % 3u], zl - 1 + i32(a / 3u));
    cell[a] = l;
    id[a] = NONE;
    part[a] = -1;
    if (!srcSolid(recs, l, d)) {
      rim = true;
      continue;
    }
    let k = u32(l.x) + d.x * (u32(l.y) + d.y * u32(l.z));
    lowK = min(lowK, k);
    highK = max(highK, k);
    rest[a] = heap[recs + k].xyz;
    mean += rest[a];
    let pj = partAt(slot, k);
    if (alive(pj)) {
      id[a] = labelOf(pj);
      if (id[a] == label) { part[a] = i32(pj); }
    }
  }
  let ownA = select(0u, 3u, zl == own.z);
  var rv: vec3<f32>;
  if (rim) {
    // on the body's outer surface: the cell's own corner, where the outer mesh has its vertices
    let ang = 0.5235988 + 1.0471976 * f32(j);
    rv = rest[ownA] + eqrot(frame, vec3<f32>(HEX_R * cos(ang), HEX_R * sin(ang), select(0.5, -0.5, zl == own.z)));
  } else {
    // inside: surface nets — the mean of the middles of the cut edges round the corner (three pairs of columns in
    // each layer, three columns between the layers)
    rv = mean / 6.0;
    var cut = vec3<f32>(0.0);
    var n = 0.0;
    for (var a = 0u; a < 6u; a++) {
      let b = (a / 3u) * 3u + (a + 1u) % 3u;
      if (id[a] != id[b]) {
        cut += 0.5 * (rest[a] + rest[b]);
        n += 1.0;
      }
      if (a < 3u && id[a] != id[a + 3u]) {
        cut += 0.5 * (rest[a] + rest[a + 3u]);
        n += 1.0;
      }
    }
    if (n > 0.0) { rv = mix(rv, cut / n, bitcast<f32>(EU.l.y)); }
    let hsh = hash3(lowK, highK, 0x7b3du);
    rv += (vec3<f32>(f32(hsh & 1023u), f32((hsh >> 10u) & 1023u), f32((hsh >> 20u) & 1023u)) / 511.5 - 1.0) * EU.f.w;
  }
  var o: BV;
  o.idx = vec4<u32>(NONE);
  o.wt = vec4<f32>(0.0);
  var p = vec3<f32>(0.0);
  var m = 0u;
  var all = 0.0;
  // (placed by every cell of the part round the corner — whichever face asks, the same place; weighted from now on to
  // the face's own cell and up to three more of them)
  for (var t = 0u; t < 6u; t++) {
    let a = (ownA + t) % 6u;
    if (part[a] < 0) { continue; }
    let pj = u32(part[a]);
    p += px[2u * pj].xyz + eqrot(ps[3u * pj + 2u], rv - rest[a]);
    all += 1.0;
    if (m < 4u) {
      o.idx[m] = boxCell(cell[a], lo, bd);
      m++;
    }
  }
  for (var t = 0u; t < m; t++) { o.wt[t] = 1.0 / f32(m); }
  o.p = p / max(all, 1.0);
  return o;
}
fn putVertex(at: u32, v: BV, centre: vec3<f32>, word: u32) {
  heap[at] = bitcast<vec4<f32>>(v.idx);
  heap[at + 1u] = v.wt;
  heap[at + 2u] = vec4<f32>(v.p - centre, bitcast<f32>(word));
}

// a thread a voxel: its cell's break faces into its part's mesh
@compute @workgroup_size(64)
fn partFaces(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_index) li: u32) {
  let i = pidx(wg.x, li);
  let L = parting(i);
  if (!L.ok || !alive(i)) { return; }
  let label = labelOf(i);
  let root = partAt(L.slot, label);
  if (verdictOf(root) != V_WRITE) { return; }
  let l = cellOf(L.k, L.dims);
  let s = slotAt(L.slot);
  let mh = hAt(dmeta[s + 2u]);
  let recs = mh + MODEL_HDR;
  let par = i32(bitcast<u32>(heap[mh + 1u].w) & 1u);
  if (bitcast<u32>(heap[mh + 1u].y) == 0u) { return; }
  let faces = breakFaces(L.slot, recs, par, l, L.dims, label);
  let tris = faceTris(faces);
  if (tris == 0u) { return; }
  let A = bitcast<vec4<u32>>(pw[3u * root + 1u]);
  let lo = unpack3(A.y);
  let bd = unpack3(A.z) - lo + vec3<u32>(1u);
  let first = atomicAdd(&vh[vhRec(root)], tris);
  if (first + tris > bitcast<u32>(px[2u * root + 1u].x)) { return; }
  let h = hAt(bitcast<u32>(pw[3u * root + 2u].y));
  let mesh = h + MODEL_HDR + bd.x * bd.y * bd.z;
  let centre = pw[3u * root].xyz;
  let frame = heap[mh + 3u];
  // (the look of a broken face: the cell's material, its own speckle — render.wgsl reads the word as the body mesh's)
  let word = (matOf(i) & 0xffu) | ((hash3(L.k, 0x51u, 0x9du) & 255u) << 8u) | 0x40000000u;
  var k: array<BV, 12>;
  for (var j = 0u; j < 6u; j++) {
    k[j] = breakVertex(L.slot, L.dims, recs, par, frame, l, j, l.z, label, lo, bd);
    k[6u + j] = breakVertex(L.slot, L.dims, recs, par, frame, l, j, l.z + 1, label, lo, bd);
  }
  var t = first;
  if ((faces & 1u) != 0u) {
    for (var f = 1u; f < 5u; f++) {
      let o = mesh + 3u * t * MESH_V;
      putVertex(o, k[6u], centre, word);
      putVertex(o + MESH_V, k[6u + f], centre, word);
      putVertex(o + 2u * MESH_V, k[7u + f], centre, word);
      t++;
    }
  }
  if ((faces & 2u) != 0u) {
    for (var f = 1u; f < 5u; f++) {
      let o = mesh + 3u * t * MESH_V;
      putVertex(o, k[0u], centre, word);
      putVertex(o + MESH_V, k[1u + f], centre, word);
      putVertex(o + 2u * MESH_V, k[f], centre, word);
      t++;
    }
  }
  for (var sd = 0u; sd < 6u; sd++) {
    if ((faces & (4u << sd)) == 0u) { continue; }
    let a = SIDE_A[sd];
    let b = SIDE_B[sd];
    var o = mesh + 3u * t * MESH_V;
    putVertex(o, k[a], centre, word);
    putVertex(o + MESH_V, k[b], centre, word);
    putVertex(o + 2u * MESH_V, k[6u + b], centre, word);
    o += 3u * MESH_V;
    putVertex(o, k[a], centre, word);
    putVertex(o + MESH_V, k[6u + b], centre, word);
    putVertex(o + 2u * MESH_V, k[6u + a], centre, word);
    t += 2u;
  }
}

// a thread a listed triangle: a face of the body's outer surface baked into its part's mesh, where the skin puts it by
// the part's own voxels, weighted to them from now on
@compute @workgroup_size(64)
fn triWrite(@builtin(global_invocation_id) id: vec3<u32>) {
  let T = triPart(id.x);
  if (!T.ok || verdictOf(T.root) != V_WRITE) { return; }
  let t = atomicAdd(&vh[vhRec(T.root)], 1u);
  if (t >= bitcast<u32>(px[2u * T.root + 1u].x)) { return; }
  let A = bitcast<vec4<u32>>(pw[3u * T.root + 1u]);
  let lo = unpack3(A.y);
  let bd = unpack3(A.z) - lo + vec3<u32>(1u);
  let s = slotAt(T.slot);
  let recs = hAt(dmeta[s + 2u]) + MODEL_HDR;
  let d = slotDims(T.slot);
  let h = hAt(bitcast<u32>(pw[3u * T.root + 2u].y));
  let mesh = h + MODEL_HDR + bd.x * bd.y * bd.z;
  let centre = pw[3u * T.root].xyz;
  for (var c = 0u; c < 3u; c++) {
    let v = T.v0 + c * MESH_V;
    let idx = bitcast<vec4<u32>>(heap[v]);
    let wt = heap[v + 1u];
    let rest = heap[v + 2u];
    var o: BV;
    o.idx = vec4<u32>(NONE);
    o.wt = vec4<f32>(0.0);
    var p = vec3<f32>(0.0);
    var ws = 0.0;
    var m = 0u;
    // (by its voxels that are the part's: every face of the part at this corner is placed by the same ones, and so
    // are the break faces — the part's mesh is closed. The deforming draw had it by the voxels its cell was still
    // bonded to, engine_deform.wgsl `carries`: where a bond inside the part had snapped, the hairline closes now.)
    for (var k = 0u; k < 4u; k++) {
      if (idx[k] == NONE || wt[k] <= 0.0) { continue; }
      let j = partAt(T.slot, idx[k]);
      if (!alive(j) || labelOf(j) != T.label) { continue; }
      p += (px[2u * j].xyz + eqrot(ps[3u * j + 2u], rest.xyz - heap[recs + idx[k]].xyz)) * wt[k];
      ws += wt[k];
      o.idx[m] = boxCell(cellOf(idx[k], d), lo, bd);
      o.wt[m] = wt[k];
      m++;
    }
    o.wt = o.wt / max(ws, 1e-6);
    o.p = p / max(ws, 1e-6);
    putVertex(mesh + (3u * t + c) * MESH_V, o, centre, bitcast<u32>(rest.w));
  }
}

// a thread a voxel: a crumb leaves (`deaths` lays it on the ground next tick); a voxel of a part gets its record in the
// part's compact model — where it lies about the part's centre, its material, the bonds that hold within the part
@compute @workgroup_size(64)
fn partRecs(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_index) li: u32) {
  let i = pidx(wg.x, li);
  let L = parting(i);
  if (!L.ok || !alive(i)) { return; }
  let label = labelOf(i);
  let root = partAt(L.slot, label);
  let v = verdictOf(root);
  if (v == V_CRUMB) {
    px[2u * i].w = PV_CRUMBLE;
    atomicAdd(&pool[EU.h.w + SUMS_W * L.slot + 3u], 1u);
    return;
  }
  if (v != V_WRITE) { return; }
  let l = cellOf(L.k, L.dims);
  var bonds = pb[i];
  for (var k = 0u; k < 26u; k++) {
    if ((bonds & (1u << k)) == 0u) { continue; }
    let j = partCell(L.slot, l + n26(k), L.dims, label);
    if (j < 0 || (pb[u32(j)] & (1u << (25u - k))) == 0u) { bonds &= ~(1u << k); }
  }
  let A = bitcast<vec4<u32>>(pw[3u * root + 1u]);
  let lo = unpack3(A.y);
  let bd = unpack3(A.z) - lo + vec3<u32>(1u);
  let h = hAt(bitcast<u32>(pw[3u * root + 2u].y));
  heap[h + MODEL_HDR + boxCell(l, lo, bd)] = vec4<f32>(px[2u * i].xyz - pw[3u * root].xyz, bitcast<f32>(matOf(i) | (bonds << 6u)));
}

// a thread a root, last: the part's row written, asleep where its particles stood (they are let go at the tick's end);
// or the whole body's own row given back
@compute @workgroup_size(64)
fn partRow(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_index) li: u32) {
  let i = pidx(wg.x, li);
  let L = parting(i);
  if (!L.ok || !alive(i) || labelOf(i) != L.k) { return; }
  let v = verdictOf(i);
  let s = slotAt(L.slot);
  let c = pw[3u * i];
  let B = bitcast<vec4<u32>>(pw[3u * i + 2u]);
  if (v == V_SHARED) {
    let row = dmeta[s + 1u];
    if (row != NONE) {
      let q = ps[3u * i];
      let im = pose[4u * row + 2u].w;
      pose[4u * row] = vec4<f32>(c.xyz, 0.0);
      pose[4u * row + 1u] = q;
      pose[4u * row + 2u] = vec4<f32>(c.xyz, im);
      pose[4u * row + 3u] = q;
      vel[2u * row] = vec4<f32>(0.0);
      vel[2u * row + 1u] = vec4<f32>(0.0, 0.0, 0.0, vel[2u * row + 1u].w);
      let fl = rowFlags(row);
      info[4u * row].w = bitcast<f32>((fl & ~(ROW_DEFORM | ROW_LISTED_ASLEEP | ROW_EXPAND | ROW_DENIED)) | ROW_ASLEEP | ROW_NEWSLEEP);
      // (the slot lets go of its pages, not of the row)
      dmeta[s + 1u] = NONE;
    }
    pw[3u * i + 2u] = bitcast<vec4<f32>>(vec4<u32>(B.x, B.y, B.z, V_DONE));
    return;
  }
  if (v != V_WRITE) { return; }
  let A = bitcast<vec4<u32>>(pw[3u * i + 1u]);
  let row = A.w;
  // its inertia about its centre, each voxel a unit cube's own and its offset's (engine.ts bakeBody), inverted
  var xx = 0.0;
  var yy = 0.0;
  var zz = 0.0;
  var xy = 0.0;
  var xz = 0.0;
  var yz = 0.0;
  let cells = L.dims.x * L.dims.y * L.dims.z;
  for (var k = 0u; k < cells; k++) {
    let j = partAt(L.slot, k);
    if (!alive(j) || labelOf(j) != L.k) { continue; }
    let x = px[2u * j];
    let m = 1.0 / max(x.w, 1e-3);
    let r = x.xyz - c.xyz;
    xx += m * (r.y * r.y + r.z * r.z + 1.0 / 6.0);
    yy += m * (r.x * r.x + r.z * r.z + 1.0 / 6.0);
    zz += m * (r.x * r.x + r.y * r.y + 1.0 / 6.0);
    xy -= m * r.x * r.y;
    xz -= m * r.x * r.z;
    yz -= m * r.y * r.z;
  }
  let det = xx * (yy * zz - yz * yz) - xy * (xy * zz - yz * xz) + xz * (xy * yz - yy * xz);
  let iv = vec3<f32>(yy * zz - yz * yz, xx * zz - xz * xz, xx * yy - xy * xy) / det;
  let io = vec3<f32>(xz * yz - xy * zz, xy * yz - xz * yy, xy * xz - xx * yz) / det;
  let idq = vec4<f32>(0.0, 0.0, 0.0, 1.0);
  pose[4u * row] = vec4<f32>(c.xyz, 0.0);
  pose[4u * row + 1u] = idq;
  pose[4u * row + 2u] = vec4<f32>(c.xyz, 1.0 / c.w);
  pose[4u * row + 3u] = idq;
  vel[2u * row] = vec4<f32>(0.0);
  var rad = 0.0;
  for (var k = 0u; k < cells; k++) {
    let j = partAt(L.slot, k);
    if (!alive(j) || labelOf(j) != L.k) { continue; }
    rad = max(rad, length(px[2u * j].xyz - c.xyz) + 0.87);
  }
  vel[2u * row + 1u] = vec4<f32>(0.0, 0.0, 0.0, rad);
  info[4u * row] = vec4<f32>(iv, bitcast<f32>(ROW_ALIVE | ROW_ASLEEP | ROW_NEWSLEEP));
  info[4u * row + 1u] = vec4<f32>(io, c.w);
  info[4u * row + 2u] = vec4<f32>(bitcast<f32>(B.z), bitcast<f32>(bitcast<u32>(px[2u * i + 1u].y)), bitcast<f32>(dmeta[s + 22u]), c.w / f32(A.x));
  info[4u * row + 3u] = bitcast<vec4<f32>>(vec4<u32>(B.y, 0u, 0u, 0u));
  pw[3u * i + 2u] = bitcast<vec4<f32>>(vec4<u32>(B.x, B.y, B.z, V_DONE));
}

// ---- for the collision branch (body against body, PE3): a row's occupancy at its model's resolution -------------------
// occ (u32): [0..2] its lattice box, [3] its voxels, then a word a lattice cell from OCC_AT: its material (0: none).
// The host gives the row and the buffer; a thread a cell, as many as the buffer holds (EU of the occupancy call: g.w
// the row, i.w the cells the buffer holds). An SDF bake can take it from there.
const OCC_AT: u32 = 4u;
@group(0) @binding(39) var<storage, read_write> occ: array<u32>;
@compute @workgroup_size(64)
fn occupancy(@builtin(global_invocation_id) id: vec3<u32>) {
  let r = EU.g.w;
  let model = bitcast<u32>(info[4u * r + 3u].x);
  if ((rowFlags(r) & ROW_ALIVE) == 0u || model == 0u) {
    if (id.x == 0u) { occ[3] = 0u; }
    return;
  }
  let mh = hAt(model);
  let d = bitcast<vec4<u32>>(heap[mh]);
  if (id.x == 0u) {
    occ[0] = d.x;
    occ[1] = d.y;
    occ[2] = d.z;
    occ[3] = d.w;
  }
  if (id.x >= d.x * d.y * d.z || id.x >= EU.i.w) { return; }
  occ[OCC_AT + id.x] = bitcast<u32>(heap[mh + MODEL_HDR + id.x].w) & 63u;
}
