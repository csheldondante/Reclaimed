// ---- field mesh (G13 h) -----------------------------------------------------------
// The terrain drawn as one surface: a signed field is evaluated on the fly
// from what's stored — the columns' intervals and the structures' voxels —
// and meshed with surface nets. Nothing new is stored but the mesh itself
// (and a scratch grid per chunk while it's rebuilt). The field is negative
// inside:
//   terrain   each column's vertical distance to its nearest solid boundary
//             (touching intervals are one solid; below 0 is bedrock; off the
//             map is air; what's built isn't in it: renderprep draws it as
//             prisms, sharp), blended over the three nearest columns (the
//             triangle lattice of centres), so slopes run smooth and caves
//             and overhangs stay
//   structure the distance to its voxels' boxes in its own rotated frame
//             (outside: to the nearest solid voxel; inside: to the nearest
//             air)
//   both      a smooth minimum, so sand against a wall makes a fillet
// The structures themselves stay their cubes (structprep.wgsl: sharp edges,
// which surface nets would bevel): a quad whose four vertices are all
// structure is left out, so the mesh keeps only the ground and the fillets.
// The look comes from the intervals per fragment (meshdraw.wgsl): the field
// gives the shape, the intervals the layers.
//
// The map is meshed in square chunks of the world (meshregion.wgsl), each
// with room for its own vertices and indices and drawn by its own indexed
// indirect draw. Every frame hashChunks hashes each chunk's columns (and the
// structure frames over it); a chunk whose hash changed is rebuilt, a few per
// frame (MR.k.y slots), by three passes over its samples: sampleField (the
// field at every sample), makeVerts (a vertex per sample cell the surface
// crosses, at the mean of its edge crossings, with the field's gradient for
// its normal) and makeQuads (two triangles per crossed sample edge, joining
// the four cells around it). Samples lie on one lattice over the whole map
// (world i·h, j·h, (k − 1)·h), and a chunk computes the cells one sample past
// its low edges, so neighbours compute their shared vertices identically and
// the seams close. A chunk owns the edges whose base sample is its own.
@group(0) @binding(3) var<storage, read> layers: array<vec4<u32>>;
@group(0) @binding(4) var<storage, read> frames: array<Frame>;
@group(0) @binding(5) var<storage, read> vox: array<u32>;
// per rebuild slot: the field at each of its chunk's samples (f32 bits), then
// each sample cell's vertex (NONE: none; else its index in the chunk)
@group(0) @binding(6) var<storage, read_write> scratch: array<u32>;
// per chunk MR.k.z vertices, two vec4<u32> each: (x, y, z as f32 bits,
// structure voxel word), (normal xyz as f32 bits, structure share 0..1)
@group(0) @binding(7) var<storage, read_write> verts: array<vec4<u32>>;
// per chunk MR.k.w indices (local to the chunk: its draw's base vertex)
@group(0) @binding(8) var<storage, read_write> indices: array<u32>;
// [0] chunks found changed this frame, [1..15] the first MR.k.y of them; then
// per chunk (from CHUNK0, CSTRIDE each): [0..4] its drawIndexedIndirect args
// (index count, 1, first index, base vertex, 0), [5] the hash it was built
// from, [6] the hash it will be, [7] vertices so far, [8] its top (f32 bits),
// [9] 1 when it ran out of room, [12] (round 81) its lowest boundary over the bedrock's top (f32 bits: the
// top of the solid joined to the bedrock, the least of its columns' — the samples under it, less 3, are
// solid without the field); after the chunks, one word each: 1 when it's
// near the view (the CPU writes them; only those are rebuilt, the rest when
// they come into view)
@group(0) @binding(9) var<storage, read_write> state: array<atomic<u32>>;

const NONE: u32 = 0xffffffffu;
/** How far either field reaches (cells): past it, it's just "far". */
const FAR: f32 = 3.0;
/** The smooth minimum's reach (the fillet where terrain meets a structure). */
const FILLET: f32 = 0.6;

/** Vertical signed distance to column q's solid at height z (negative inside). */
fn colDist(q: vec2<i32>, z: f32) -> f32 {
  // (off the map is air: the map's edge closes in a wall)
  if (!inMap(q)) { return FAR; }
  // (round 79: the bedrock's top is MR.zb.y — 0 in the window, the world's floor in the band under it)
  let bz = MR.zb.y;
  if (z < bz) { return max(z - bz, -FAR); }
  var d = z - bz;
  let cs = colSlots(u32(q.x), u32(q.y));
  // the solid runs: touching intervals are one (a boundary between two
  // layers isn't a surface)
  var lo = bz;
  var hi = bz;
  for (var i = 0u; i < cs.y; i++) {
    let v = layers[cs.x + i];
    if (ivEmpty(v)) { break; }
    // (what's built is drawn as prisms: meshregion.wgsl fieldMat)
    if (!fieldMat(ivMat(v))) { continue; }
    let z0 = ivZ0(v);
    let z1 = ivZ1(v);
    if (z0 - hi > 1e-3) {
      // a gap: the run so far is done
      if (z >= lo && z <= hi) { return max(-min(select(z - lo, FAR, lo <= bz), hi - z), -FAR); }
      d = min(d, min(abs(z - lo), abs(z - hi)));
      lo = z0;
    }
    hi = z1;
  }
  // (a run cut at the window's top goes on up: the band over the window draws the rest, round 79)
  let he = select(hi, 1e9, hi > lo && hi >= MR.zb.z - 1e-3);
  if (z >= lo && z <= he) { return max(-min(select(z - lo, FAR, lo <= bz), he - z), -FAR); }
  d = min(d, min(abs(z - lo), abs(z - he)));
  return min(d, FAR);
}

fn terrainField(p: vec3<f32>) -> f32 {
  let t = triAt(terrainWarp(p));
  var d = 0.0;
  for (var k = 0; k < 3; k++) { d += t.w[k] * colDist(t.c[k], p.z); }
  return d;
}

/** The structures' field at p (x) and the word of the solid voxel nearest it (y as bits; 0 none). */
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

fn cbase(c: u32) -> u32 { return CHUNK0 + c * CSTRIDE; }
/** the mesh range a chunk's vertices and indices are in (word 10: its own at first; a slide hands them on) */
fn rangeOf(c: u32) -> u32 { return atomicLoad(&state[cbase(c) + 10u]); }

// ---- change detection -------------------------------------------------------

var<workgroup> wgHash: atomic<u32>;
var<workgroup> wgTop: atomic<u32>;
var<workgroup> wgBot: atomic<u32>;

fn mixHash(h: u32, v: u32) -> u32 { return (h ^ v) * 16777619u; }

/** A chunk's world rectangle. */
fn chunkRect(c: u32) -> vec4<f32> {
  let cx = f32(c % MR.n.x);
  let cy = f32(c / MR.n.x);
  // (round 73: a row of samples a row of cells, so a slide is whole chunks both ways)
  let s = vec2<f32>(MR.o.x, MR.o.z);
  return vec4<f32>(cx * s.x, cy * s.y, (cx + 1.0) * s.x, (cy + 1.0) * s.y);
}

/** a chunk with nothing built (new, or come in fresh with a slide): its built hash */
const FRESH: u32 = 0x9e3779b9u;

// (round 73) two passes a frame: the chunks with nothing built claim the rebuild slots first — a
// strip that slid in fresh mustn't wait behind chunks whose leaf litter moved a sixteenth
@compute @workgroup_size(64)
fn hashFresh(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_index) li: u32) { hashChunk(wid.x, li, true); }
@compute @workgroup_size(64)
fn hashChunks(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_index) li: u32) { hashChunk(wid.x, li, false); }

fn hashChunk(c: u32, li: u32, freshOnly: bool) {
  if (li == 0u) {
    atomicStore(&wgHash, 0u);
    atomicStore(&wgTop, 0u);
    atomicStore(&wgBot, bitcast<u32>(1e9));
  }
  workgroupBarrier();
  // the columns whose fields reach its samples (two cells of margin)
  let rc = chunkRect(c);
  let j0 = max(i32(floor((rc.y - 2.0) / ROW_H)) - 1, 0);
  let j1 = min(i32(ceil((rc.w + 2.0) / ROW_H)) + 1, i32(G.mapH) - 1);
  let i0 = max(i32(floor(rc.x - 2.0)) - 1, 0);
  let i1 = min(i32(ceil(rc.z + 2.0)) + 1, i32(G.mapW) - 1);
  let w = u32(max(i1 - i0 + 1, 0));
  // (out of view: not looked at; its hash stays old, so it's rebuilt once it's in view)
  let b0 = cbase(c);
  let built = atomicLoad(&state[b0 + 5u]);
  // (this frame's first pass took it already; the second only takes the rest)
  let taken = atomicLoad(&state[b0 + 11u]) == atomicLoad(&state[15]);
  // (round 80: the window's mesh — MR.zb.w 1 — leaves a chunk whose columns all sleep: they can't have changed;
  // the phone's frame had this pass near its top. Fresh ones are built anyway; one just fallen asleep is looked at.)
  // (and only a chunk that was near the view already — one just come near is looked at once: it may have
  // changed out of sight before it fell asleep)
  let nearW = atomicLoad(&state[CHUNK0 + MR.n.x * MR.n.y * CSTRIDE + c]);
  var still = false;
  if (MR.zb.w > 0.5 && nearW == 1u && built != FRESH && built != 0u) {
    still = true;
    for (var k = 0u; k < 9u; k++) {
      let q = vec2<u32>(u32(clamp(mix(rc.x, rc.z, f32(k % 3u) * 0.5), 0.0, f32(G.mapW - 1u))), u32(clamp(mix(rc.y, rc.w, f32(k / 3u) * 0.5) / ROW_H, 0.0, f32(G.mapH - 1u))));
      if (!asleep(q) || drowsy(q)) { still = false; }
    }
  }
  let vis = atomicLoad(&state[CHUNK0 + MR.n.x * MR.n.y * CSTRIDE + c]) != 0u && !taken && !still && (!freshOnly || built == FRESH || built == 0u);
  let n = select(0u, w * u32(max(j1 - j0 + 1, 0)), vis);
  var sum = 0u;
  var top = 0.0;
  for (var t = li; t < n; t += 64u) {
    let q = vec2<i32>(i0 + i32(t % w), j0 + i32(t / w));
    let cs = colSlots(u32(q.x), u32(q.y));
    // (where it is in the world, not the window: what a slide moved still hashes the same)
    var h = 2166136261u ^ (bitcast<u32>(q.x + i32(G.org.z)) * 73856093u) ^ (bitcast<u32>(q.y + i32(G.org.w)) * 19349663u);
    for (var i = 0u; i < cs.y; i++) {
      let v = layers[cs.x + i];
      if (ivEmpty(v)) { break; }
      // (heights to a sixteenth of a cell: sediment creeping by less than
      // that doesn't rebuild the chunk; the mesh catches up when it adds up)
      h = mixHash(mixHash(mixHash(h, u32(ivZ0(v) * 16.0 + 0.5)), u32(ivZ1(v) * 16.0 + 0.5)), v.z & 0xffu);
      top = max(top, ivZ1(v));
    }
    // (the top of the solid joined to the bedrock, as colDist sees it: field materials, touching runs one)
    var hb = MR.zb.y;
    for (var i = 0u; i < cs.y; i++) {
      let v = layers[cs.x + i];
      if (ivEmpty(v)) { break; }
      if (!fieldMat(ivMat(v))) { continue; }
      if (ivZ0(v) - hb > 1e-3) { break; }
      hb = max(hb, ivZ1(v));
    }
    atomicMin(&wgBot, bitcast<u32>(max(hb - MR.zb.y, 0.0)));
    sum += h;
  }
  atomicAdd(&wgHash, sum);
  atomicMax(&wgTop, bitcast<u32>(top));
  workgroupBarrier();
  if (li != 0u || !vis) { return; }
  var h = atomicLoad(&wgHash);
  // and the structures over it (placed, moved) — and none skipped under them (a buried one's faces are the field's)
  var bot = atomicLoad(&wgBot);
  for (var s = 0u; s < MAX_STRUCTS; s++) {
    let f = frames[s];
    if (f.d.x == 0u || f.b.z < rc.x - 2.0 || f.b.x > rc.z + 2.0 || f.b.w < rc.y - 2.0 || f.b.y > rc.w + 2.0) { continue; }
    bot = 0u;
    h = mixHash(h, s + 1u);
    for (var k = 0u; k < 4u; k++) { h = mixHash(mixHash(h, bitcast<u32>(f.a[k])), bitcast<u32>(f.q[k])); }
  }
  let b = cbase(c);
  if (h == atomicLoad(&state[b + 5u])) { return; }
  let at = atomicAdd(&state[0], 1u);
  if (at >= MR.k.y) { return; }
  atomicStore(&state[1u + at], c);
  atomicStore(&state[b + 11u], atomicLoad(&state[15]));
  atomicStore(&state[b + 6u], h);
  // (its range is made again where it is now: no translation)
  let ob = offBase() + rangeOf(c) * 4u;
  for (var k = 0u; k < 3u; k++) { atomicStore(&state[ob + k], 0u); }
  atomicStore(&state[b + 8u], atomicLoad(&wgTop));
  atomicStore(&state[b + 12u], bot);
  atomicStore(&state[b], 0u);
  atomicStore(&state[b + 7u], 0u);
  atomicStore(&state[b + 9u], 0u);
}

// ---- a chunk's samples --------------------------------------------------------
// A workgroup is 4 × 4 × 4 samples of one rebuild slot (z packs the slots in
// whole workgroups), so its first thread reads the slot's job for all of it,
// and each workgroup claims its vertices and indices with one atomic: atomics
// on the shared state go past the caches, and one per thread made these
// passes ten times slower.

/** Samples along a chunk's side: its N cells', one more before, and two after (the last cell and edge). */
fn sideN() -> u32 { return MR.k.x + 3u; }
fn slotSamples() -> u32 { return sideN() * sideN() * MR.n.z; }

struct Job { ok: bool, c: u32, slot: u32, l: vec3<u32>, top: f32, r: u32, bot: f32 };

var<workgroup> wgJob: vec4<u32>;
var<workgroup> wgN: atomic<u32>;
var<workgroup> wgBase: u32;

/** The rebuild slot and local sample a thread is for (call in uniform control flow: it syncs the workgroup). */
fn job(id: vec3<u32>, li: u32) -> Job {
  let zs = (MR.n.z + 3u) / 4u * 4u;
  var j: Job;
  j.slot = id.z / zs;
  j.l = vec3<u32>(id.xy, id.z % zs);
  if (li == 0u) {
    var c = NONE;
    if (j.slot < min(atomicLoad(&state[0]), MR.k.y)) { c = atomicLoad(&state[1u + j.slot]); }
    var top = 0u;
    var r = 0u;
    var bot = 0u;
    if (c != NONE) {
      top = atomicLoad(&state[cbase(c) + 8u]);
      r = rangeOf(c);
      bot = atomicLoad(&state[cbase(c) + 12u]);
    }
    wgJob = vec4<u32>(c, top, r, bot);
    atomicStore(&wgN, 0u);
  }
  workgroupBarrier();
  let w = workgroupUniformLoad(&wgJob);
  j.c = w.x;
  j.top = bitcast<f32>(w.y);
  j.r = w.z;
  j.bot = MR.zb.y + bitcast<f32>(w.w);
  j.ok = j.c != NONE && all(j.l < vec3<u32>(sideN(), sideN(), MR.n.z));
  return j;
}

/** Claim `n` of a chunk's vertices (state word `word`) for this thread, one atomic a workgroup; NONE: no room. */
fn claim(j: Job, n: u32, li: u32, word: u32, cap: u32) -> u32 {
  let off = atomicAdd(&wgN, n);
  workgroupBarrier();
  if (li == 0u) {
    let total = atomicLoad(&wgN);
    var base = NONE;
    if (j.c != NONE && total > 0u) {
      base = atomicAdd(&state[cbase(j.c) + word], total);
      if (base + total > cap) {
        atomicStore(&state[cbase(j.c) + 9u], 1u);
        base = NONE;
      }
    }
    wgBase = base;
  }
  let base = workgroupUniformLoad(&wgBase);
  if (base == NONE || n == 0u) { return NONE; }
  return base + off;
}

fn sampleIdx(j: Job, l: vec3<u32>) -> u32 { return j.slot * slotSamples() * 2u + l.x + sideN() * (l.y + sideN() * l.z); }
fn fieldAt(j: Job, l: vec3<u32>) -> f32 { return bitcast<f32>(scratch[sampleIdx(j, l)]); }
fn cellVert(j: Job, l: vec3<u32>) -> u32 { return scratch[sampleIdx(j, l) + slotSamples()]; }

/** World position of a chunk's local sample (one lattice over the map; local 0 is the sample before the chunk). */
fn samplePos(j: Job, l: vec3<u32>) -> vec3<f32> {
  let g = vec2<i32>(i32((j.c % MR.n.x) * MR.k.x + l.x) - 1, i32((j.c / MR.n.x) * MR.k.x + l.y) - 1);
  return vec3<f32>(f32(g.x) * MR.o.y, f32(g.y) * MR.o.w, MR.zb.x + (f32(l.z) - 1.0) * MR.o.y);
}

@compute @workgroup_size(4, 4, 4)
fn sampleField(@builtin(global_invocation_id) id: vec3<u32>, @builtin(local_invocation_index) li: u32) {
  let j = job(id, li);
  if (!j.ok) { return; }
  let p = samplePos(j, j.l);
  // (above everything in the chunk: air; round 81: 3 under its lowest boundary, solid — no field: the deep
  // rock under the ground was most of a rebuild's samples)
  var d = FAR;
  // (round 81: a band keeps no quads in the window's z — MR.ze.z 1 — so the samples deeper in it than the
  // field reaches can't change one it keeps: not evaluated. Its rebuild after a pack sampled the window's
  // whole height, 13 ms in a frame.)
  let inner = MR.ze.z > 0.5 && p.z > MR.ze.x + FAR + 2.0 * MR.o.y && p.z < MR.ze.y - FAR - 2.0 * MR.o.y;
  if (p.z < j.bot - 3.0) { d = -FAR; } else if (p.z <= j.top + 2.0 && !inner) { d = field(p); }
  scratch[sampleIdx(j, j.l)] = bitcast<u32>(d);
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
fn makeVerts(@builtin(global_invocation_id) id: vec3<u32>, @builtin(local_invocation_index) li: u32) {
  let j = job(id, li);
  var ci = 0u;
  var v: array<f32, 8>;
  var has = false;
  if (j.ok) {
    ci = sampleIdx(j, j.l) + slotSamples();
    scratch[ci] = NONE;
    if (all(j.l + 1u < vec3<u32>(sideN(), sideN(), MR.n.z))) {
      var inside = 0u;
      for (var k = 0u; k < 8u; k++) {
        v[k] = fieldAt(j, j.l + CORNER[k]);
        if (v[k] < 0.0) { inside |= 1u << k; }
      }
      has = inside != 0u && inside != 255u;
    }
  }
  let at = claim(j, select(0u, 1u, has), li, 7u, MR.k.z);
  if (at == NONE) { return; }
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
  let p = samplePos(j, j.l) + acc / n * vec3<f32>(MR.o.y, MR.o.w, MR.o.y);
  scratch[ci] = at;
  // the normal: the field's gradient (central differences of the field itself,
  // not the samples, so it's smooth across cells)
  let e = MR.o.y * 0.35;
  let g = vec3<f32>(
    field(p + vec3<f32>(e, 0.0, 0.0)) - field(p - vec3<f32>(e, 0.0, 0.0)),
    field(p + vec3<f32>(0.0, e, 0.0)) - field(p - vec3<f32>(0.0, e, 0.0)),
    field(p + vec3<f32>(0.0, 0.0, e)) - field(p - vec3<f32>(0.0, 0.0, e)));
  let nrm = normalize(g + vec3<f32>(0.0, 0.0, 1e-6));
  // which of the two it is: the terrain, a structure, or the fillet between
  let s = structField(p);
  let share = clamp(0.5 + (terrainField(p) - s.x) / FILLET, 0.0, 1.0);
  let o = (j.r * MR.k.z + at) * 2u;
  verts[o] = vec4<u32>(bitcast<u32>(p.x), bitcast<u32>(p.y), bitcast<u32>(p.z), bitcast<u32>(s.y));
  verts[o + 1u] = vec4<u32>(bitcast<u32>(nrm.x), bitcast<u32>(nrm.y), bitcast<u32>(nrm.z), bitcast<u32>(share));
}

fn shareOf(j: Job, v: u32) -> f32 { return bitcast<f32>(verts[(j.r * MR.k.z + v) * 2u + 1u].w); }

/** The four vertices round a crossed edge, or x NONE (a cell without one, or all structure: its cubes draw it). */
fn quadVerts(j: Job, a: vec3<u32>, b: vec3<u32>, c: vec3<u32>, d: vec3<u32>) -> vec4<u32> {
  let q = vec4<u32>(cellVert(j, a), cellVert(j, b), cellVert(j, c), cellVert(j, d));
  if (any(q == vec4<u32>(NONE))) { return vec4<u32>(NONE); }
  if (min(min(shareOf(j, q.x), shareOf(j, q.y)), min(shareOf(j, q.z), shareOf(j, q.w))) > 0.5) { return vec4<u32>(NONE); }
  return q;
}

@compute @workgroup_size(4, 4, 4)
fn makeQuads(@builtin(global_invocation_id) id: vec3<u32>, @builtin(local_invocation_index) li: u32) {
  let j = job(id, li);
  let l = j.l;
  // up to three quads: the edges from this sample along +x, +y, +z (two
  // triangles each, joining the four cells round the edge)
  var q: array<vec4<u32>, 3>;
  var n = 0u;
  // the edges whose base sample is the chunk's own (local 1..N along x and y)
  // (round 79: and whose base sample is in the mesh's z range — the window's, or the band's outside it)
  let bz0 = MR.zb.x + (f32(l.z) - 1.0) * MR.o.y;
  let inZ = (bz0 >= MR.ze.x && bz0 < MR.ze.y) != (MR.ze.z > 0.5);
  // (the chunk is built from the hash it was found with)
  if (j.ok && all(l == vec3<u32>(1u))) { atomicStore(&state[cbase(j.c) + 5u], atomicLoad(&state[cbase(j.c) + 6u])); }
  if (j.ok && inZ && l.x >= 1u && l.y >= 1u && l.x <= MR.k.x && l.y <= MR.k.x && l.z >= 1u && l.z + 2u <= MR.n.z) {
    let s0 = fieldAt(j, l) < 0.0;
    let X = vec3<u32>(1u, 0u, 0u);
    let Y = vec3<u32>(0u, 1u, 0u);
    let Z = vec3<u32>(0u, 0u, 1u);
    if (s0 != (fieldAt(j, l + X) < 0.0)) {
      let t = quadVerts(j, l - Y - Z, l - Z, l, l - Y);
      if (t.x != NONE) { q[n] = t; n += 1u; }
    }
    if (s0 != (fieldAt(j, l + Y) < 0.0)) {
      let t = quadVerts(j, l - X - Z, l - Z, l, l - X);
      if (t.x != NONE) { q[n] = t; n += 1u; }
    }
    if (s0 != (fieldAt(j, l + Z) < 0.0)) {
      let t = quadVerts(j, l - X - Y, l - Y, l, l - X);
      if (t.x != NONE) { q[n] = t; n += 1u; }
    }
  }
  let at = claim(j, n * 6u, li, 0u, MR.k.w);
  if (at == NONE) { return; }
  let o = j.r * MR.k.w + at;
  for (var k = 0u; k < n; k++) {
    let t = q[k];
    indices[o + k * 6u] = t.x;
    indices[o + k * 6u + 1u] = t.y;
    indices[o + k * 6u + 2u] = t.z;
    indices[o + k * 6u + 3u] = t.x;
    indices[o + k * 6u + 4u] = t.z;
    indices[o + k * 6u + 5u] = t.w;
  }
}

// ---- a slide (round 73: the streamed window moved, fieldmesh.ts shift) ----------
// What's built moves with the land instead of being built again: chunk c takes
// the record of the chunk the land came from (SH.d chunks along), so its hash
// (the world's) still matches and its range (word 10) still holds its mesh;
// every range's translation gains the slide; the chunks the land came into
// fresh take the ranges the leaving ones held (the chunks go round), empty
// and to be built.
struct Shift { d: vec4<i32>, t: vec4<f32> };
@group(0) @binding(31) var<uniform> SH: Shift;
@group(0) @binding(10) var<storage, read> stateOld: array<u32>;

@compute @workgroup_size(64)
fn shiftChunks(@builtin(global_invocation_id) id: vec3<u32>) {
  let n = MR.n.x * MR.n.y;
  let c = id.x;
  if (c >= n) { return; }
  let cx = i32(c % MR.n.x);
  let cy = i32(c / MR.n.x);
  let sx = cx + SH.d.x;
  let sy = cy + SH.d.y;
  let fresh = sx < 0 || sy < 0 || sx >= i32(MR.n.x) || sy >= i32(MR.n.y);
  let wx = (sx + i32(MR.n.x)) % i32(MR.n.x);
  let wy = (sy + i32(MR.n.y)) % i32(MR.n.y);
  let src = u32(wy) * MR.n.x + u32(wx);
  for (var k = 0u; k < CSTRIDE; k++) { atomicStore(&state[cbase(c) + k], stateOld[cbase(src) + k]); }
  if (fresh) {
    atomicStore(&state[cbase(c)], 0u);
    atomicStore(&state[cbase(c) + 5u], FRESH);
    atomicStore(&state[cbase(c) + 9u], 0u);
  }
  // (range c's translation: all that's built moved the same way)
  let ob = offBase() + c * 4u;
  for (var k = 0u; k < 3u; k++) { atomicStore(&state[ob + k], bitcast<u32>(bitcast<f32>(stateOld[ob + k]) + SH.t[k])); }
}

// ---- the rebuild's size (round 81) --------------------------------------------------
// The three rebuild passes are dispatched indirectly, for the chunks found changed only: dispatched for
// every slot every frame, their workgroups found no job most frames and returned — over a ride, most of
// the mesh's GPU time (each pass ~0.1 ms a frame on the desktop). Written after the change passes into
// the words after the ranges' translations, then copied to the dispatch's own buffer (fieldmesh.ts: a
// buffer bound for writing can't be a dispatch's indirect arguments in the same pass).
fn argsBase() -> u32 { return offBase() + MR.n.x * MR.n.y * 4u; }

@compute @workgroup_size(1)
fn rebuildArgs() {
  let n = min(atomicLoad(&state[0]), MR.k.y);
  let s = (sideN() + 3u) / 4u;
  atomicStore(&state[argsBase()], select(0u, s, n > 0u));
  atomicStore(&state[argsBase() + 1u], s);
  atomicStore(&state[argsBase() + 2u], (MR.n.z + 3u) / 4u * n);
}
