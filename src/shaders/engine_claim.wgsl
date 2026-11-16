// ---- a row at rest claims its space in the columns (DESIGN §3 "External is a material, in the terrain's own
// intervals", §10 "At rest"; docs/design/PHYSICS_ENGINE.md "Rest claims External") -------------------------------------
// `compact` gives a row that fell asleep a write job a chunk of its footprint, and a row that woke a clear job
// (engine_compact.wgsl claimStep; the table's layout is in engine.wgsl). `claimCols` does them: a workgroup row a job,
// a thread a column of the job's chunk. No two jobs of a tick write one chunk (the table's locks), so a column has one
// writer.
//   write: the column's centre line is walked through the row's distance field (its one baked model, the store's:
//          DESIGN §10 "the same model serves ... projection into the terrain"), from under its bound to over it in
//          steps of half a voxel, each crossing placed by the field's own distance. Each span inside the body becomes
//          an External interval where the column is air (where there is matter already the body is buried in it, and
//          that part is not claimed: sim/external.ts claimFree's rule, but a liquid's interval is left too), aux the
//          row's material (what it becomes if it is ever baked into the ground: the orphan pass), word 3 its owner
//          (engine.wgsl ownWord). A span whose underside is within CLAIM_SNAP of what lies under it is brought down
//          onto it and marked as standing on it (OWN_SUP): the support watch (engine_ground.wgsl) wakes the row when
//          that is no longer so.
//          A column with no free slot for a span leaves it out (counted: P_CLAIM_FULL — the pages' question, DA-P3):
//          there the body is not in the columns, so loose ground passes through that part of it and nothing under
//          that column is watched.
//   clear: the column's External intervals that name the row and the generation are taken out (air).
// `claimWipe`, a thread a window column: every interval a row owns taken out — the host's `Engine.clear()`.
@group(0) @binding(75) var<storage, read_write> layersW: array<vec4<u32>>;
@group(0) @binding(74) var<storage, read> claimT: array<u32>;
@group(0) @binding(18) var<storage, read_write> poolK: array<atomic<u32>>;
@group(0) @binding(59) var<storage, read> rowModelK: array<u32>;
struct ClaimModel { fieldBase: u32, dims: u32, sampleBase: u32, sampleCount: u32, com: vec3<f32>, voxel: f32 };
@group(0) @binding(60) var<storage, read> modelsK: array<ClaimModel>;
@group(0) @binding(58) var<storage, read> fieldK: array<u32>;

/** a span's underside this near what lies under it stands on it (cells): the fields are up to a quarter cell fat and
 *  a body rests within its slop of the ground */
const CLAIM_SNAP: f32 = 0.3;
/** spans a column's line through a body may have (a leg, a tank's floor, its roof); more are left out, counted */
const CLAIM_SPANS: u32 = 4u;
/** the thinnest interval written (sim/external.ts: 0.05) */
const CLAIM_MIN: f32 = 0.05;

/** the store's field (grad8) at qc, inside the hull of the voxel centres: its distance (voxels). As engine_meet.wgsl
 *  meetField. */
fn claimField(base: u32, dims: vec3<u32>, qc: vec3<f32>) -> f32 {
  let i0 = min(vec3<u32>(qc), dims - vec3<u32>(2u));
  let fr = qc - vec3<f32>(i0);
  let i = base + i0.x + dims.x * (i0.y + dims.y * i0.z);
  let sy = dims.x;
  let sz = dims.x * dims.y;
  let v = mix(
    mix(mix(unpack4x8snorm(fieldK[i]).x, unpack4x8snorm(fieldK[i + 1u]).x, fr.x), mix(unpack4x8snorm(fieldK[i + sy]).x, unpack4x8snorm(fieldK[i + sy + 1u]).x, fr.x), fr.y),
    mix(mix(unpack4x8snorm(fieldK[i + sz]).x, unpack4x8snorm(fieldK[i + sz + 1u]).x, fr.x), mix(unpack4x8snorm(fieldK[i + sz + sy]).x, unpack4x8snorm(fieldK[i + sz + sy + 1u]).x, fr.x), fr.y),
    fr.z,
  );
  return v * (127.0 / 16.0);
}

/** the row's field at world point p (voxels; > 0 outside; 1e9 off its grid) */
fn claimDist(M: ClaimModel, x: vec3<f32>, q: vec4<f32>, p: vec3<f32>) -> f32 {
  let dims = vec3<u32>(M.dims & 0xffu, (M.dims >> 8u) & 0xffu, (M.dims >> 16u) & 0xffu);
  let c = eqrot(eqinv(q), p - x) / M.voxel + M.com - vec3<f32>(0.5);
  let hi = vec3<f32>(dims) - vec3<f32>(1.0);
  if (any(c < vec3<f32>(0.0)) || any(c > hi)) { return 1e9; }
  return claimField(M.fieldBase, dims, c);
}

/** the column written back: slots changed are bumped (the chunk's versions: the mesh, the ground tops). No owner is
 *  told (chunkver.wgsl bumpColumnOwn): these writes cut no claim, they put one in or take the row's own out */
fn claimStore(q: vec2<u32>, sl: vec2<u32>, a: ptr<function, array<vec4<u32>, MAX_K>>, n: u32) {
  for (var s = 0u; s < sl.y; s++) {
    var v = vec4<u32>(0u);
    if (s < n) { v = (*a)[s]; }
    let old = layersW[sl.x + s];
    if (any(old != v)) {
      layersW[sl.x + s] = v;
      bumpColumnOwn(q, old, v);
    }
  }
}

fn claimLoad(sl: vec2<u32>, a: ptr<function, array<vec4<u32>, MAX_K>>) -> u32 {
  var n = 0u;
  for (var s = 0u; s < sl.y; s++) {
    let v = layersW[sl.x + s];
    if (ivEmpty(v)) { break; }
    (*a)[n] = v;
    n++;
  }
  return n;
}

/** the column with every interval row `row` owns (generation `gen`; 0: any row's, any generation) taken out */
fn claimClear(q: vec2<u32>, row: u32, gen: u32) {
  let sl = colSlots(q.x, q.y);
  var a: array<vec4<u32>, MAX_K>;
  let n = claimLoad(sl, &a);
  var m = 0u;
  for (var s = 0u; s < n; s++) {
    let v = a[s];
    let mine = ivMat(v) == MAT_EXTERNAL && ownIsRow(v.w) && (gen == 0u || (ownRowOf(v.w) == row && ownGenOf(v.w) == gen));
    if (!mine) {
      a[m] = v;
      m++;
    }
  }
  if (m != n) { claimStore(q, sl, &a, m); }
}

@compute @workgroup_size(64)
fn claimCols(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_index) li: u32) {
  if (wg.x >= min(claimT[0], CJ_MAX)) { return; }
  let j = CJ_AT + wg.x * CJ_WORDS;
  let r = claimT[j];
  let word = claimT[j + 1u];
  let op = word & 0xffu;
  let gen = (word >> 8u) & 0xffu;
  let cs = G.chunkSize;
  let k = wg.y * 64u + li;
  if (k >= cs * cs) { return; }
  let c = vec2<u32>(claimT[j + 2u] & 0xffffu, claimT[j + 2u] >> 16u);
  let q = c * cs + vec2<u32>(k % cs, k / cs);
  if (q.x >= G.mapW || q.y >= G.mapH) { return; }
  // (the claim's own columns only)
  let rec = CR_AT + r * CR_WORDS;
  let lo = vec2<u32>(claimT[rec + 2u] & 0xffffu, claimT[rec + 2u] >> 16u);
  let ext = vec2<u32>(claimT[rec + 3u] & 0xffffu, claimT[rec + 3u] >> 16u);
  if (any(q < lo) || any(q >= lo + ext)) { return; }
  if (op == CJ_CLEAR) {
    claimClear(q, r, gen);
    return;
  }
  if (op != CJ_WRITE) { return; }
  let mi = rowModelK[r];
  if (mi == 0xffffffffu) { return; }
  let M = modelsK[mi];
  let x = pose[4u * r + 2u].xyz;
  let rot = pose[4u * r + 3u];
  let dims = vec3<f32>(vec3<u32>(M.dims & 0xffu, (M.dims >> 8u) & 0xffu, (M.dims >> 16u) & 0xffu));
  let reach = 0.5 * length(dims) * M.voxel + 1.0;
  let w = cellPos(vec2<i32>(q));
  if (distance(w, x.xy) > reach) { return; }
  // the spans of the column's centre line inside the body, bottom to top
  var spans: array<vec2<f32>, CLAIM_SPANS>;
  var ns = 0u;
  var lost = 0u;
  let h = 0.5 * M.voxel;
  let steps = u32(ceil(2.0 * reach / h)) + 1u;
  var z0 = x.z - reach;
  var d0 = claimDist(M, x, rot, vec3<f32>(w, z0));
  var open = 0.0;
  var inside = false;
  for (var i = 1u; i <= steps; i++) {
    let z1 = x.z - reach + f32(i) * h;
    let d1 = claimDist(M, x, rot, vec3<f32>(w, z1));
    let in1 = d1 < 0.0;
    if (in1 != inside) {
      // (the crossing by the field's own distances; a neighbour off the grid has none: the step's middle)
      var t = 0.5;
      if (d0 < 1e8 && d1 < 1e8 && d0 != d1) { t = clamp(d0 / (d0 - d1), 0.0, 1.0); }
      let zc = z0 + (z1 - z0) * t;
      if (in1) { open = zc; } else {
        if (ns < CLAIM_SPANS) {
          spans[ns] = vec2<f32>(open, zc);
          ns++;
        } else { lost++; }
      }
      inside = in1;
    }
    z0 = z1;
    d0 = d1;
  }
  if (ns == 0u) { return; }
  let sl = colSlots(q.x, q.y);
  var a: array<vec4<u32>, MAX_K>;
  var n = claimLoad(sl, &a);
  let aux = (word >> 16u) & 0xffu;
  var wrote = false;
  for (var s = 0u; s < ns; s++) {
    // (the span's parts that are air: between the intervals, in order; `a` stays sorted as parts go in)
    var lo2 = max(spans[s].x, 0.0);
    let top = min(spans[s].y, f32(G.zMax) - 1.0);
    var i = 0u;
    while (lo2 < top - CLAIM_MIN) {
      // (the first interval ending above lo2)
      while (i < n && ivZ1(a[i]) <= lo2 + 1e-4) { i++; }
      var under = 0.0;
      if (i > 0u) { under = ivZ1(a[i - 1u]); }
      var p0 = lo2;
      var p1 = top;
      if (i < n) {
        if (ivZ0(a[i]) <= p0 + 1e-4) {
          // (inside matter: buried there)
          lo2 = ivZ1(a[i]);
          continue;
        }
        p1 = min(p1, ivZ0(a[i]));
      }
      lo2 = p1;
      var sup = false;
      if (p0 - under <= CLAIM_SNAP) {
        p0 = under;
        sup = true;
      }
      if (p1 - p0 < CLAIM_MIN) { continue; }
      if (n >= sl.y) {
        lost++;
        continue;
      }
      for (var m = n; m > i; m--) { a[m] = a[m - 1u]; }
      a[i] = vec4<u32>(bitcast<u32>(p0), bitcast<u32>(p1), MAT_EXTERNAL | (aux << 8u), ownWord(r, gen, sup));
      n++;
      i++;
      wrote = true;
    }
  }
  if (lost > 0u) { atomicAdd(&poolK[P_CLAIM_FULL], lost); }
  if (wrote) { claimStore(q, sl, &a, n); }
}

@compute @workgroup_size(64)
fn claimWipe(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= G.mapW * G.mapH) { return; }
  claimClear(vec2<u32>(id.x % G.mapW, id.x / G.mapW), 0u, 0u);
}
