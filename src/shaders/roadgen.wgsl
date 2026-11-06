// ---- the road generator on the GPU (round 128p, DA-A13 step 0; roadgen/gpu.ts drives it) -------------------------
// Roads first, as evenly spaced streamlines of a direction (tensor) field over the town's land. The rules are
// roadgen/roadgen.ts's (the field) and roadgen/cpu.ts's (the rounds) — keep them in step; cpu.ts is the reference.
//  * rgField   one thread a lattice node (in the field rectangle): (a, b) = Σ m (cos 2φ, sin 2φ) of the bases
//  * rgTrace   one thread a seed: both ways along its family's direction, against the committed lines (ending on one
//              that lies straight ahead: a T-junction)
//  * rgCommit  one thread: the round's traces in seed order, truncated on each other (the round grid: rgClearRound
//              empties it first), appended; the next dispatches'
//              sizes written (indirect)
//  * rgSeed*   candidates into seed buckets, two passes (A: the least key wins a bucket; B: the winner writes where)
//  * rgCompact one thread: the buckets in order into the next round's seeds, the buckets cleared
//  * rgKill / rgClearHeads / rgInsert  an edit: the lines through its rectangle dead, the grids rebuilt from the living
//  * rgClaim / rgOffsets  the town's base lattice: a cell claimed by a road whose line passes within half a cell of its
//              middle; a vertex between a claimed and an unclaimed cell moved (at most 0.45 of a cell) onto the road's edge
//              on the open cells' side
// Self-contained (no common.wgsl). Bindings 20-33.

struct Params {
  W: f32, H: f32, S: f32, step: f32,
  cx: f32, cy: f32, radius: f32, theta: f32,
  sigmaR: f32, sigmaC: f32, major: f32, minor: f32,
  cell: f32, roadGrade: f32, degenerate: f32, maxOff: f32,
  nx: u32, ny: u32, N: u32, seedCap: u32,
  ptsCap: u32, linesCap: u32, nSegs: u32, latN: u32,
  gw0: u32, gh0: u32, gw1: u32, gh1: u32,
  sbw0: u32, sbh0: u32, sbw1: u32, sbh1: u32,
  fi0: u32, fj0: u32, fi1: u32, fj1: u32,
  jitter: f32, seed: u32, boxW: u32, boxH: u32,
};

// (roadgen/gpu.ts ST_*: keep the order) rect first (16-byte aligned), then words
struct State {
  rect: vec4<f32>,
  family: u32, round: u32, seedCount: u32, ptsEnd: u32,
  linesEnd: u32, roundLine0: u32, roundPt0: u32, err: u32,
  listN: u32, _a: u32, _b: u32, _c: u32,
};

@group(0) @binding(20) var<uniform> P: Params;
/** per node: a, b (the field), wet (0/1), ground */
@group(0) @binding(21) var<storage, read_write> field: array<vec4<f32>>;
/** constraint segments: two vec4 each — (ax, ay, bx, by), (its polyline, 0, 0, 0) */
@group(0) @binding(22) var<storage, read> cons: array<vec4<f32>>;
@group(0) @binding(23) var<storage, read_write> st: State;
@group(0) @binding(24) var<storage, read_write> seeds: array<vec2<f32>>;
/** per seed 2N + 2 slots: [0] (nb, nf) (exact in f32; nb −1: no trace), [1 + N] the seed, forward up, backward down */
@group(0) @binding(25) var<storage, read_write> scratch: array<vec2<f32>>;
@group(0) @binding(26) var<storage, read_write> points: array<vec2<f32>>;
/** per point: its line, the next in its round-grid bucket (-1 none), the next in its grid bucket (-1 none), its index on its line */
@group(0) @binding(27) var<storage, read_write> pinfo: array<vec4<i32>>;
/** per separation bucket (family 0's, then family 1's; half the family's spacing square) the first point in it (-1 none) */
@group(0) @binding(28) var<storage, read_write> heads: array<atomic<i32>>;
/** two vec4 a line: (start, count, flags: family | DEAD | FIXED, round), (seed x, seed y bits, 0, 0) */
@group(0) @binding(29) var<storage, read_write> lines: array<vec4<u32>>;
/** per seed bucket three words: the least key (0xffffffff none), the winner's x and y (f32 bits) */
@group(0) @binding(30) var<storage, read_write> sb: array<atomic<u32>>;
@group(0) @binding(31) var<storage, read> seedList: array<vec2<f32>>;
/** per lattice cell: 0 open, 1 a major road's, 2 a minor road's, 3 off the town, 4 water (a road over it: a bridge, later) */
@group(0) @binding(32) var<storage, read_write> claims: array<u32>;
/** per lattice vertex its offset (m) */
@group(0) @binding(33) var<storage, read_write> offsets: array<vec2<f32>>;
/** the indirect dispatches' sizes (a buffer of its own: a dispatch can't read its args from a buffer it writes):
 *  [0] the trace's (a thread a seed), [1] this round's points', [2] all points', [3] all lines' */
@group(0) @binding(34) var<storage, read_write> ind: array<vec4<u32>>;
/** the round grid: as `heads`, only the points committed this round (the commit's: a round's lines against each other) */
@group(0) @binding(35) var<storage, read_write> rheads: array<atomic<i32>>;
/** per box column (boxW × boxH) the lattice cell it's in (j × latN + i; -1 none) — rgColumns */
@group(0) @binding(36) var<storage, read_write> colCell: array<i32>;

const NONE: u32 = 0xffffffffu;
const DEAD: u32 = 256u;
const FIXED: u32 = 512u;

fn spacingOf(f: u32) -> f32 { return select(P.minor, P.major, f == 0u); }
fn insideTown(q: vec2<f32>) -> bool {
  return q.x >= 0.0 && q.y >= 0.0 && q.x <= P.W && q.y <= P.H && length(q - vec2<f32>(P.cx, P.cy)) <= P.radius;
}

// ---- the field

@compute @workgroup_size(8, 8)
fn rgField(@builtin(global_invocation_id) id: vec3<u32>) {
  let i = P.fi0 + id.x;
  let j = P.fj0 + id.y;
  if (i > P.fi1 || j > P.fj1 || i >= P.nx || j >= P.ny) { return; }
  let n = j * P.nx + i;
  let gR = field[j * P.nx + min(P.nx - 1u, i + 1u)].w;
  let gL = field[j * P.nx + select(i - 1u, 0u, i == 0u)].w;
  let gU = field[min(P.ny - 1u, j + 1u) * P.nx + i].w;
  let gD = field[select(j - 1u, 0u, j == 0u) * P.nx + i].w;
  let gx = (gR - gL) / (2.0 * P.S);
  let gy = (gU - gD) / (2.0 * P.S);
  let slope2 = gx * gx + gy * gy;
  var a = 0.0;
  var b = 0.0;
  if (slope2 > 0.0) {
    let m = sqrt(slope2) / P.roadGrade;
    a -= m * (gx * gx - gy * gy) / slope2;
    b -= m * (2.0 * gx * gy) / slope2;
  }
  a += cos(2.0 * P.theta);
  b += sin(2.0 * P.theta);
  let x = f32(i) * P.S;
  let y = f32(j) * P.S;
  let rx = x - P.cx;
  let ry = y - P.cy;
  let r2 = rx * rx + ry * ry;
  if (r2 > 0.0) {
    let m = exp(-r2 / (2.0 * P.sigmaR * P.sigmaR));
    a -= m * (rx * rx - ry * ry) / r2;
    b -= m * 2.0 * rx * ry / r2;
  }
  // constraints: the nearest segment of each polyline (segments of one polyline are consecutive)
  var bestD = 1e30;
  var bt = vec2<f32>(1.0, 0.0);
  var cur = -1.0;
  for (var s = 0u; s < P.nSegs; s++) {
    let sa = cons[s * 2u];
    let poly = cons[s * 2u + 1u].x;
    if (poly != cur) {
      if (cur >= 0.0) {
        let w = exp(-(bestD * bestD) / (2.0 * P.sigmaC * P.sigmaC));
        a = (1.0 - w) * a + w * (bt.x * bt.x - bt.y * bt.y);
        b = (1.0 - w) * b + w * 2.0 * bt.x * bt.y;
      }
      cur = poly;
      bestD = 1e30;
    }
    let e = sa.zw - sa.xy;
    let L2 = dot(e, e);
    var t = 0.0;
    if (L2 > 0.0) { t = clamp(dot(vec2<f32>(x, y) - sa.xy, e) / L2, 0.0, 1.0); }
    let d = length(vec2<f32>(x, y) - sa.xy - e * t);
    if (d < bestD) {
      bestD = d;
      bt = e / max(sqrt(L2), 1e-30);
      if (L2 == 0.0) { bt = vec2<f32>(1.0, 0.0); }
    }
  }
  if (cur >= 0.0) {
    let w = exp(-(bestD * bestD) / (2.0 * P.sigmaC * P.sigmaC));
    a = (1.0 - w) * a + w * (bt.x * bt.x - bt.y * bt.y);
    b = (1.0 - w) * b + w * 2.0 * bt.x * bt.y;
  }
  field[n].x = a;
  field[n].y = b;
}

/** the family's direction at q (bilinear); (0, 0) where the field has none */
fn dirAt(f: u32, q: vec2<f32>) -> vec2<f32> {
  let fx = clamp(q.x / P.S, 0.0, f32(P.nx - 1u) - 0.000001);
  let fy = clamp(q.y / P.S, 0.0, f32(P.ny - 1u) - 0.000001);
  let i = u32(floor(fx));
  let j = u32(floor(fy));
  let u = fx - f32(i);
  let v = fy - f32(j);
  let f00 = field[j * P.nx + i].xy;
  let f10 = field[j * P.nx + i + 1u].xy;
  let f01 = field[(j + 1u) * P.nx + i].xy;
  let f11 = field[(j + 1u) * P.nx + i + 1u].xy;
  let ab = mix(mix(f00, f10, u), mix(f01, f11, u), v);
  if (dot(ab, ab) < P.degenerate) { return vec2<f32>(0.0); }
  var ang = 0.5 * atan2(ab.y, ab.x);
  if (f == 1u) { ang += 1.5707963; }
  return vec2<f32>(cos(ang), sin(ang));
}

fn wetAt(q: vec2<f32>) -> bool {
  let i = min(P.nx - 1u, u32(max(0.0, round(q.x / P.S))));
  let j = min(P.ny - 1u, u32(max(0.0, round(q.y / P.S))));
  return field[j * P.nx + i].z != 0.0;
}

fn align(d: vec2<f32>, prev: vec2<f32>) -> vec2<f32> { return select(d, -d, dot(d, prev) < 0.0); }

// ---- the separation grids

fn gridW(f: u32) -> u32 { return select(P.gw1, P.gw0, f == 0u); }
fn gridH(f: u32) -> u32 { return select(P.gh1, P.gh0, f == 0u); }
fn gridBase(f: u32) -> u32 { return select(P.gw0 * P.gh0, 0u, f == 0u); }
fn bucketOf(f: u32, q: vec2<f32>) -> u32 {
  let d = spacingOf(f) * 0.5;
  let bx = min(gridW(f) - 1u, u32(max(0.0, floor(q.x / d))));
  let by = min(gridH(f) - 1u, u32(max(0.0, floor(q.y / d))));
  return gridBase(f) + by * gridW(f) + bx;
}

/** the first point of bucket b in grid g (0 the grid, 1 the round grid) and the next after e */
fn headOf(g: u32, b: u32) -> i32 { return select(atomicLoad(&rheads[b]), atomicLoad(&heads[b]), g == 0u); }
fn nextOf(g: u32, e: i32) -> i32 { return select(pinfo[e].y, pinfo[e].z, g == 0u); }

/** whether a committed point of family f lies within r (at most half its spacing) of q, in grid g */
fn anyNear(f: u32, q: vec2<f32>, r: f32, g: u32) -> bool {
  let d = spacingOf(f) * 0.5;
  let bx = i32(floor(q.x / d));
  let by = i32(floor(q.y / d));
  for (var j = by - 1; j <= by + 1; j++) {
    for (var i = bx - 1; i <= bx + 1; i++) {
      if (i < 0 || j < 0 || i >= i32(gridW(f)) || j >= i32(gridH(f))) { continue; }
      var e = headOf(g, gridBase(f) + u32(j) * gridW(f) + u32(i));
      loop {
        if (e < 0) { break; }
        if (dot(points[e] - q, points[e] - q) < r * r) { return true; }
        e = nextOf(g, e);
      }
    }
  }
  return false;
}

/** the nearest committed point of family f within r (at most half its spacing) of q in grid g: its index, or -1 —
 *  least distance, then least index */
fn nearest(f: u32, q: vec2<f32>, r: f32, g: u32) -> i32 {
  let d = spacingOf(f) * 0.5;
  let bx = i32(floor(q.x / d));
  let by = i32(floor(q.y / d));
  var best = -1;
  var bd = r * r;
  for (var j = by - 1; j <= by + 1; j++) {
    for (var i = bx - 1; i <= bx + 1; i++) {
      if (i < 0 || j < 0 || i >= i32(gridW(f)) || j >= i32(gridH(f))) { continue; }
      var e = headOf(g, gridBase(f) + u32(j) * gridW(f) + u32(i));
      loop {
        if (e < 0) { break; }
        let dd = dot(points[e] - q, points[e] - q);
        if (dd < bd || (dd == bd && best >= 0 && e < best)) { bd = dd; best = e; }
        e = nextOf(g, e);
      }
    }
  }
  return best;
}

/** a line ending near another meets it straight on from `o` along `dir` within r: the first committed point within
 *  a step of the ray (a T-junction), or -1 (a line alongside isn't joined) — cpu.ts ahead */
fn ahead(f: u32, o: vec2<f32>, dir: vec2<f32>, r: f32, g: u32) -> i32 {
  var t = P.step;
  loop {
    if (t > r + 1e-6) { break; }
    let h = nearest(f, o + dir * t, P.step, g);
    if (h >= 0) { return h; }
    t += P.step;
  }
  return -1;
}

fn insertPoint(f: u32, q: u32) {
  let old = atomicExchange(&heads[bucketOf(f, points[q])], i32(q));
  pinfo[q].z = old;
}

// ---- tracing

@compute @workgroup_size(64)
fn rgTrace(@builtin(global_invocation_id) id: vec3<u32>) {
  let s = id.x;
  if (s >= st.seedCount) { return; }
  let f = st.family;
  let d = spacingOf(f);
  let dt = d * 0.5;
  let base = s * (2u * P.N + 2u);
  let mid = base + 1u + P.N;
  let seed = seeds[s];
  scratch[base] = vec2<f32>(-1.0, 0.0);
  scratch[mid] = seed;
  if (!insideTown(seed) || wetAt(seed) || anyNear(f, seed, dt, 0u)) { return; }
  let d0 = dirAt(f, seed);
  if (all(d0 == vec2<f32>(0.0))) { return; }
  var counts = vec2<u32>(0u);
  for (var side = 0u; side < 2u; side++) {
    let sg = select(1.0, -1.0, side == 1u);
    var cur = seed;
    var prev = d0 * sg;
    var n = 0u;
    loop {
      if (n >= P.N) { break; }
      let a = dirAt(f, cur);
      if (all(a == vec2<f32>(0.0))) { break; }
      let d1 = align(a, prev);
      let m = cur + d1 * P.step * 0.5;
      let b = dirAt(f, m);
      if (all(b == vec2<f32>(0.0))) { break; }
      let d2 = align(b, d1);
      let nxt = cur + d2 * P.step;
      if (!insideTown(nxt) || wetAt(nxt)) { break; }
      let slot = select(mid - (n + 1u), mid + (n + 1u), side == 0u);
      if (anyNear(f, nxt, dt, 0u)) {
        let j = ahead(f, cur, d2, dt, 0u);
        if (j >= 0) {
          scratch[slot] = points[j];
          n++;
        }
        break;
      }
      if (f32(n + 1u) * P.step > 2.0 * d && length(nxt - seed) < dt) {
        scratch[slot] = seed;
        n++;
        break;
      }
      scratch[slot] = nxt;
      n++;
      prev = d2;
      cur = nxt;
    }
    counts[side] = n;
  }
  // (nb, nf)
  scratch[base] = vec2<f32>(f32(counts.y), f32(counts.x));
}

// ---- committing (one thread)

fn inBox(q: vec2<f32>, lo: vec2<f32>, hi: vec2<f32>, r: f32) -> bool { return all(q >= lo - vec2<f32>(r)) && all(q <= hi + vec2<f32>(r)); }

fn args(n: u32) -> vec4<u32> { return vec4<u32>((n + 63u) / 64u, 1u, 1u, 0u); }

@compute @workgroup_size(1)
fn rgCommit() {
  let f = st.family;
  let d = spacingOf(f);
  let dt = d * 0.5;
  let r = i32(st.round);
  st.roundLine0 = st.linesEnd;
  st.roundPt0 = st.ptsEnd;
  // (the box round this round's committed points: a point outside it, grown by dt, is near none — no look)
  var bmin = vec2<f32>(1e30);
  var bmax = vec2<f32>(-1e30);
  for (var s = 0u; s < st.seedCount; s++) {
    let base = s * (2u * P.N + 2u);
    let mid = base + 1u + P.N;
    let hd = scratch[base];
    if (hd.x < 0.0) { continue; }
    let nb = u32(hd.x);
    let nf = u32(hd.y);
    if (inBox(scratch[mid], bmin, bmax, dt) && anyNear(f, scratch[mid], dt, 1u)) { continue; }
    // (ended where it comes too near one: on it if it lies straight ahead — cpu.ts commit)
    var hi = nf;
    for (var k = 1u; k <= nf; k++) {
      if (inBox(scratch[mid + k], bmin, bmax, dt) && anyNear(f, scratch[mid + k], dt, 1u)) {
        let a = scratch[mid + k - 1u];
        var b = a;
        if (k >= 2u || nb > 0u) { b = scratch[mid + k - 2u]; }
        let dl = max(length(a - b), 1e-30);
        let j = ahead(f, a, select((a - b) / dl, vec2<f32>(0.0), length(a - b) == 0.0), dt, 1u);
        if (j >= 0) { scratch[mid + k] = points[j]; hi = k; } else { hi = k - 1u; }
        break;
      }
    }
    var lo = nb;
    for (var k = 1u; k <= nb; k++) {
      if (inBox(scratch[mid - k], bmin, bmax, dt) && anyNear(f, scratch[mid - k], dt, 1u)) {
        let a = scratch[mid - k + 1u];
        var b = a;
        if (k >= 2u || nf > 0u) { b = scratch[mid - k + 2u]; }
        let dl = max(length(a - b), 1e-30);
        let j = ahead(f, a, select((a - b) / dl, vec2<f32>(0.0), length(a - b) == 0.0), dt, 1u);
        if (j >= 0) { scratch[mid - k] = points[j]; lo = k; } else { lo = k - 1u; }
        break;
      }
    }
    var arc = 0.0;
    for (var k = mid - lo + 1u; k <= mid + hi; k++) { arc += length(scratch[k] - scratch[k - 1u]); }
    if (arc < d) { continue; }
    let cnt = lo + hi + 1u;
    if (st.ptsEnd + cnt > P.ptsCap || st.linesEnd + 1u > P.linesCap) { st.err = 1u; break; }
    let line = st.linesEnd;
    let start = st.ptsEnd;
    for (var k = 0u; k < cnt; k++) {
      let q = start + k;
      points[q] = scratch[mid - lo + k];
      bmin = min(bmin, points[q]);
      bmax = max(bmax, points[q]);
      pinfo[q] = vec4<i32>(i32(line), atomicExchange(&rheads[bucketOf(f, points[q])], i32(q)), -1, i32(k));
      insertPoint(f, q);
    }
    lines[line * 2u] = vec4<u32>(start, cnt, f, u32(r));
    lines[line * 2u + 1u] = vec4<u32>(bitcast<u32>(scratch[mid].x), bitcast<u32>(scratch[mid].y), 0u, 0u);
    st.ptsEnd = start + cnt;
    st.linesEnd = line + 1u;
  }
  ind[1] = args(st.ptsEnd - st.roundPt0);
  ind[2] = args(st.ptsEnd);
  ind[3] = args(st.linesEnd);
}

// ---- seeds

fn seedBucket(q: vec2<f32>) -> u32 {
  let b = spacingOf(st.family) * 0.5;
  let w = select(P.sbw1, P.sbw0, st.family == 0u);
  let h = select(P.sbh1, P.sbh0, st.family == 0u);
  let bx = min(w - 1u, u32(max(0.0, floor(q.x / b))));
  let by = min(h - 1u, u32(max(0.0, floor(q.y / b))));
  return by * w + bx;
}

fn candidate(q: vec2<f32>, key: u32, phase: u32) {
  // (only candidates a trace would start from compete: in the town, clear of the family's lines — cpu.ts dedup)
  if (!insideTown(q) || anyNear(st.family, q, spacingOf(st.family) * 0.5, 0u)) { return; }
  let b = seedBucket(q) * 3u;
  if (phase == 0u) {
    atomicMin(&sb[b], key);
  } else if (atomicLoad(&sb[b]) == key) {
    atomicStore(&sb[b + 1u], bitcast<u32>(q.x));
    atomicStore(&sb[b + 2u], bitcast<u32>(q.y));
  }
}

/** a point's tangent on its line */
fn tangentAt(q: u32) -> vec2<f32> {
  let inf = pinfo[q];
  let ln = lines[u32(inf.x) * 2u];
  let k = u32(inf.w);
  let a = points[ln.x + select(k - 1u, 0u, k == 0u)];
  let b = points[ln.x + min(ln.y - 1u, k + 1u)];
  let t = b - a;
  return t / max(length(t), 1e-30);
}

/** from the lines committed this round: every spacing along, a spacing to either side */
fn seedLines(q0: u32, phase: u32) {
  let q = st.roundPt0 + q0;
  if (q >= st.ptsEnd) { return; }
  let inf = pinfo[q];
  let d = spacingOf(st.family);
  let every = max(1u, u32(round(d / P.step)));
  if (u32(inf.w) % every != 0u) { return; }
  let t = tangentAt(q);
  let n = vec2<f32>(-t.y, t.x);
  let li = u32(inf.x) - st.roundLine0;
  for (var side = 0u; side < 2u; side++) {
    let sg = select(1.0, -1.0, side == 1u);
    candidate(points[q] + n * d * sg, (li * 65536u + u32(inf.w)) * 2u + side, phase);
  }
}
@compute @workgroup_size(64)
fn rgSeedLinesA(@builtin(global_invocation_id) id: vec3<u32>) { seedLines(id.x, 0u); }
@compute @workgroup_size(64)
fn rgSeedLinesB(@builtin(global_invocation_id) id: vec3<u32>) { seedLines(id.x, 1u); }

/** a list the CPU wrote: the major roads' first seeds (the centre, the constraints'), an edit's dropped lines' seeds */
fn seedList_(i: u32, phase: u32) {
  if (i >= st.listN) { return; }
  candidate(seedList[i], i, phase);
}
@compute @workgroup_size(64)
fn rgSeedListA(@builtin(global_invocation_id) id: vec3<u32>) { seedList_(id.x, 0u); }
@compute @workgroup_size(64)
fn rgSeedListB(@builtin(global_invocation_id) id: vec3<u32>) { seedList_(id.x, 1u); }

/** the minor roads' first seeds: the major roads' points every minor spacing (in the state's rectangle, an edit's);
 *  keys after the list's */
fn seedOnline(q: u32, phase: u32) {
  if (q >= st.ptsEnd) { return; }
  let inf = pinfo[q];
  let ln = lines[u32(inf.x) * 2u];
  if ((ln.z & 255u) != 0u || (ln.z & DEAD) != 0u) { return; }
  let every = max(1u, u32(round(P.minor / P.step)));
  if (u32(inf.w) % every != 0u) { return; }
  let p = points[q];
  if (p.x < st.rect.x || p.y < st.rect.y || p.x > st.rect.z || p.y > st.rect.w) { return; }
  candidate(p, st.listN + q, phase);
}
@compute @workgroup_size(64)
fn rgSeedOnlineA(@builtin(global_invocation_id) id: vec3<u32>) { seedOnline(id.x, 0u); }
@compute @workgroup_size(64)
fn rgSeedOnlineB(@builtin(global_invocation_id) id: vec3<u32>) { seedOnline(id.x, 1u); }

/** (one workgroup) the buckets in order into the seeds, cleared: each thread a run of buckets, its count, a scan */
const CT: u32 = 256u;
var<workgroup> ctSum: array<u32, 256>;
@compute @workgroup_size(256)
fn rgCompact(@builtin(local_invocation_index) t: u32) {
  let w = select(P.sbw1, P.sbw0, st.family == 0u);
  let h = select(P.sbh1, P.sbh0, st.family == 0u);
  let nb = w * h;
  let per = (nb + CT - 1u) / CT;
  let b0 = min(nb, t * per);
  let b1 = min(nb, b0 + per);
  var c = 0u;
  for (var b = b0; b < b1; b++) { if (atomicLoad(&sb[b * 3u]) != NONE) { c++; } }
  ctSum[t] = c;
  workgroupBarrier();
  // (Hillis-Steele inclusive scan)
  for (var o = 1u; o < CT; o *= 2u) {
    var v = 0u;
    if (t >= o) { v = ctSum[t - o]; }
    workgroupBarrier();
    ctSum[t] += v;
    workgroupBarrier();
  }
  var n = ctSum[t] - c;
  for (var b = b0; b < b1; b++) {
    if (atomicLoad(&sb[b * 3u]) != NONE) {
      if (n < P.seedCap) {
        seeds[n] = vec2<f32>(bitcast<f32>(atomicLoad(&sb[b * 3u + 1u])), bitcast<f32>(atomicLoad(&sb[b * 3u + 2u])));
      }
      n++;
      atomicStore(&sb[b * 3u], NONE);
    }
  }
  if (t == CT - 1u) {
    let total = ctSum[CT - 1u];
    if (total > P.seedCap) { st.err = 2u; }
    st.seedCount = min(total, P.seedCap);
    ind[0] = args(min(total, P.seedCap));
  }
}

/** (one thread) a new family or an edit's start: round 0, the list's count */
@compute @workgroup_size(1)
fn rgBegin() {
  st.round = 0u;
  st.seedCount = 0u;
  ind[0] = args(0u);
  ind[1] = args(0u);
  ind[2] = args(st.ptsEnd);
  ind[3] = args(st.linesEnd);
}

/** (one thread) after a round's seeds: the round advanced */
@compute @workgroup_size(1)
fn rgNextRound() {
  st.round += 1u;
}

// ---- an edit: the lines through its rectangle dead, the grids rebuilt

@compute @workgroup_size(64)
fn rgKill(@builtin(global_invocation_id) id: vec3<u32>) {
  let l = id.x;
  if (l >= st.linesEnd) { return; }
  let ln = lines[l * 2u];
  if ((ln.z & (DEAD | FIXED)) != 0u) { return; }
  for (var k = 0u; k < ln.y; k++) {
    let p = points[ln.x + k];
    if (p.x >= st.rect.x && p.y >= st.rect.y && p.x <= st.rect.z && p.y <= st.rect.w) {
      lines[l * 2u].z = ln.z | DEAD;
      return;
    }
  }
}

/** the round grid emptied (before a commit) */
@compute @workgroup_size(64)
fn rgClearRound(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x < P.gw0 * P.gh0 + P.gw1 * P.gh1) { atomicStore(&rheads[id.x], -1); }
}

@compute @workgroup_size(64)
fn rgClearHeads(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x < P.gw0 * P.gh0 + P.gw1 * P.gh1) { atomicStore(&heads[id.x], -1); }
}

/** every point of a living line into its family's grid, as kept (round -1) */
@compute @workgroup_size(64)
fn rgInsert(@builtin(global_invocation_id) id: vec3<u32>) {
  let q = id.x;
  if (q >= st.ptsEnd) { return; }
  let ln = lines[u32(pinfo[q].x) * 2u];
  if ((ln.z & DEAD) != 0u) { return; }
  insertPoint(ln.z & 255u, q);
}

// ---- the base lattice

fn latCentre(i: u32, j: u32) -> vec2<f32> {
  let half = f32(P.latN) * 0.5;
  let u = (f32(i) - half + 0.5) * P.cell;
  let v = (f32(j) - half + 0.5) * P.cell;
  let c = cos(P.theta);
  let s = sin(P.theta);
  return vec2<f32>(P.cx + c * u - s * v, P.cy + s * u + c * v);
}
fn latVertex(i: u32, j: u32) -> vec2<f32> {
  return latCentre(i, j) - vec2<f32>(cos(P.theta) - sin(P.theta), sin(P.theta) + cos(P.theta)) * P.cell * 0.5;
}

/** the nearest road centreline to q within r over both families: (distance, the point's index) — the segment to
 *  the next point on its line counted */
fn nearestRoad(q: vec2<f32>, r: f32) -> vec2<f32> {
  var bd = r;
  var bq = -1.0;
  for (var f = 0u; f < 2u; f++) {
    let d = spacingOf(f) * 0.5;
    let bx = i32(floor(q.x / d));
    let by = i32(floor(q.y / d));
    for (var j = by - 1; j <= by + 1; j++) {
      for (var i = bx - 1; i <= bx + 1; i++) {
        if (i < 0 || j < 0 || i >= i32(gridW(f)) || j >= i32(gridH(f))) { continue; }
        var e = atomicLoad(&heads[gridBase(f) + u32(j) * gridW(f) + u32(i)]);
        loop {
          if (e < 0) { break; }
          let inf = pinfo[e];
          let ln = lines[u32(inf.x) * 2u];
          let a = points[e];
          var b = a;
          if (u32(inf.w) + 1u < ln.y) { b = points[e + 1]; }
          let ex = b - a;
          let L2 = dot(ex, ex);
          var t = 0.0;
          if (L2 > 0.0) { t = clamp(dot(q - a, ex) / L2, 0.0, 1.0); }
          let dd = length(q - a - ex * t);
          if (dd < bd) { bd = dd; bq = f32(e); }
          e = inf.z;
        }
      }
    }
  }
  return vec2<f32>(bd, bq);
}

@compute @workgroup_size(8, 8)
fn rgClaim(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= P.latN || id.y >= P.latN) { return; }
  let c = latCentre(id.x, id.y);
  var k = 0u;
  if (!insideTown(c)) {
    k = 3u;
  } else if (wetAt(c)) {
    k = 4u;
  } else {
    // the nearest road within half a cell: its family's
    let n = nearestRoad(c, P.cell * 0.5);
    if (n.y >= 0.0) {
      let q = u32(floor(n.y));
      k = 1u + (lines[u32(pinfo[q].x) * 2u].z & 255u);
    }
  }
  claims[id.y * P.latN + id.x] = k;
}

fn hash3(i: u32, j: u32, s: u32) -> u32 {
  var h = (i * 73856093u) ^ (j * 19349663u) ^ (s * 83492791u);
  h ^= h >> 16u;
  h *= 0x7feb352du;
  h ^= h >> 15u;
  h *= 0x846ca68bu;
  h ^= h >> 16u;
  return h;
}

@compute @workgroup_size(8, 8)
fn rgOffsets(@builtin(global_invocation_id) id: vec3<u32>) {
  let N1 = P.latN + 1u;
  if (id.x >= N1 || id.y >= N1) { return; }
  var road = false;
  var open = false;
  for (var dj = 0u; dj < 2u; dj++) {
    for (var di = 0u; di < 2u; di++) {
      if (id.x + di < 1u || id.y + dj < 1u) { continue; }
      let ci = id.x + di - 1u;
      let cj = id.y + dj - 1u;
      if (ci >= P.latN || cj >= P.latN) { continue; }
      let k = claims[cj * P.latN + ci];
      road = road || k == 1u || k == 2u;
      open = open || k == 0u;
    }
  }
  // (the Townscaper irregularity: a bounded jitter a vertex, roadgen/lattice.ts jitterOf — overridden by a road's edge)
  let h0 = hash3(id.x, id.y, P.seed);
  let h1 = hash3(id.x, id.y, P.seed + 1u);
  var off = (vec2<f32>(f32(h0 >> 8u), f32(h1 >> 8u)) / 16777216.0 * 2.0 - 1.0) * P.jitter * P.cell;
  if (road && open) {
    let v = latVertex(id.x, id.y);
    let n = nearestRoad(v, P.cell);
    if (n.y >= 0.0) {
      let q = u32(floor(n.y));
      let t = tangentAt(q);
      let nrm = vec2<f32>(-t.y, t.x);
      let s = dot(v - points[q], nrm);
      // (to the edge on the open cells' side: the block's)
      var side = 0.0;
      for (var dj = 0u; dj < 2u; dj++) {
        for (var di = 0u; di < 2u; di++) {
          if (id.x + di < 1u || id.y + dj < 1u) { continue; }
          let ci = id.x + di - 1u;
          let cj = id.y + dj - 1u;
          if (ci >= P.latN || cj >= P.latN || claims[cj * P.latN + ci] != 0u) { continue; }
          side += dot(latCentre(ci, cj) - points[q], nrm);
        }
      }
      if (side == 0.0) { side = s; }
      let target_ = select(-1.0, 1.0, side >= 0.0) * P.cell * 0.5;
      off = nrm * (target_ - s);
      let L = length(off);
      if (L > P.maxOff * P.cell) { off = off * (P.maxOff * P.cell / L); }
    }
  }
  offsets[id.y * N1 + id.x] = off;
}

// ---- (the user: "converting into terrain columns might be slower without a GPU resident regular grid") which lattice
// cell each box column is in: its lattice coordinates' floor (math), then the 3 x 3 round it (the vertices moved at
// most MAX_OFFSET of a cell) by point-in-quad — roadgen/lattice.ts latticeCellAt; QuadGrid's cellOf on the CPU

fn vertexAt(i: u32, j: u32) -> vec2<f32> { return latVertex(i, j) + offsets[j * (P.latN + 1u) + i]; }

fn inCell(i: u32, j: u32, q: vec2<f32>) -> bool {
  let a = array<vec2<f32>, 4>(vertexAt(i, j), vertexAt(i + 1u, j), vertexAt(i + 1u, j + 1u), vertexAt(i, j + 1u));
  for (var e = 0u; e < 4u; e++) {
    let p0 = a[e];
    let p1 = a[(e + 1u) & 3u];
    if ((p1.x - p0.x) * (q.y - p0.y) - (p1.y - p0.y) * (q.x - p0.x) < 0.0) { return false; }
  }
  return true;
}

@compute @workgroup_size(8, 8)
fn rgColumns(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= P.boxW || id.y >= P.boxH) { return; }
  let q = vec2<f32>(f32(id.x) + 0.5 + 0.5 * f32(id.y & 1u), (f32(id.y) + 0.5) * 0.8660254);
  let c = cos(P.theta);
  let s = sin(P.theta);
  let d = q - vec2<f32>(P.cx, P.cy);
  let half = f32(P.latN) * 0.5;
  let ci = i32(floor((c * d.x + s * d.y) / P.cell + half));
  let cj = i32(floor((-s * d.x + c * d.y) / P.cell + half));
  var out = -1;
  for (var dj = -1; dj <= 1 && out < 0; dj++) {
    for (var di = -1; di <= 1; di++) {
      let i = ci + di;
      let j = cj + dj;
      if (i < 0 || j < 0 || i >= i32(P.latN) || j >= i32(P.latN)) { continue; }
      if (claims[u32(j) * P.latN + u32(i)] >= 3u) { continue; }
      if (inCell(u32(i), u32(j), q)) { out = j * i32(P.latN) + i; break; }
    }
  }
  colCell[id.y * P.boxW + id.x] = out;
}
