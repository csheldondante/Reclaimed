// ---- the living town's works: the quarry, the clearing, the stockpile (docs/design/LIVING_TOWN.md §4–§6) ----------
// World operations on the window's own buffers, from what the riders (routes.wgsl) leave in the state words: the dig
// budget the quarrymen at the face add, the stone the carts bring to the stores' inbox, the fells the woodcutters ask.
//  - dig: the pit taken out of the columns bench by bench (an interval take, in place, never External, never under z
//    2); what's taken goes to the face's pile (a counter, litres);
//  - pile: the stores' inbox put on the yard's columns as rubble (an exact put, edit.wgsl OP_PUT's rule) in a cone at
//    its angle of repose — the loose ground's own passes slump it from there;
//  - fellApply: a fell cuts the column's succession to the stump band (vegplan.wgsl VEG_STUMP) and gives the
//    woodcutter its logs; regrow (replant on) sets it back to young woods after the regrow time;
//  - campPick / treeList: the clearing's site and its trees (vegPlan's), from the flora field;
//  - groundZ: riders off the routes stand on the live ground.
// Appended after common.wgsl, layers.wgsl, materials.wgsl, vegplan.wgsl (binding 0 G, 1 chunks, 2 materials).
// The state words' layout and struct P are routes.wgsl's (keep them the same: test/unit/citylife-layout.test.ts).

struct P {
  n: vec4<u32>,
  m: vec4<u32>,
  j0: vec4<u32>,
  j1: vec4<u32>,
  t: vec4<f32>,
  r: vec4<f32>,
  q: vec4<f32>,
  q2: vec4<f32>,
  f: vec4<f32>,
  pl: vec4<i32>,
  pz: vec4<f32>,
};

@group(0) @binding(40) var<storage, read_write> LT: array<atomic<u32>>;
@group(0) @binding(41) var<storage, read_write> WALK: array<atomic<u32>>;
@group(0) @binding(42) var<storage, read_write> RID: array<vec4<f32>>;
@group(0) @binding(43) var<uniform> u: P;
@group(0) @binding(44) var<storage, read_write> QG: array<f32>;
@group(0) @binding(45) var<storage, read_write> vegW: array<f32>;
@group(0) @binding(46) var<storage, read_write> vegNextW: array<f32>;
@group(0) @binding(47) var<storage, read_write> layersW: array<vec4<u32>>;
@group(0) @binding(48) var<storage, read> HT: array<f32>;
@group(0) @binding(49) var<storage, read> REC: array<u32>;
@group(0) @binding(50) var<storage, read> CNT: array<u32>;
@group(0) @binding(53) var<storage, read_write> VOXW: array<vec4<u32>>;
@group(0) @binding(54) var<storage, read_write> VARGSW: array<atomic<u32>>;
@group(0) @binding(55) var<storage, read_write> PUT: array<f32>;

// (routes.wgsl's — keep the same)
const F_QUARRY: u32 = 2u;
const F_FOREST: u32 = 4u;
const F_REPLANT: u32 = 8u;
const NONE: u32 = 0xffffffffu;
const RECW: u32 = 24u;
const L_PHASE: u32 = 0u;
const L_PICK: u32 = 16u;
const L_HUBCOL: u32 = 32u;
const L_C: u32 = 48u;
const L_Q: u32 = 96u;
const L_F: u32 = 128u;
const L_TREES: u32 = 160u;
const TREE_ROOM: u32 = 1024u;
const L_FELL: u32 = 1248u;
const FELL_ROOM: u32 = 64u;
const L_REGROW: u32 = 52520u;
const REGROW_ROOM: u32 = 256u;
const C_DUG: u32 = 0u;
const C_FACE: u32 = 1u;
const C_INBOX: u32 = 3u;
const C_DEPOSITED: u32 = 4u;
const C_FELLED: u32 = 5u;
const C_LOG_CAMP: u32 = 6u;
const C_LOG_STORES: u32 = 8u;
const C_PRODUCE: u32 = 9u;
const C_DIGBUDGET: u32 = 16u;
const C_TREES: u32 = 18u;
const C_TREECUR: u32 = 19u;
const C_LOGS_CUT: u32 = 22u;
const C_REGROWN: u32 = 23u;
const Q_X0: u32 = 0u;
const Q_Y0: u32 = 1u;
const Q_BENCH: u32 = 2u;
const Q_PROG: u32 = 3u;
const Q_FACEX: u32 = 5u;
const Q_FACEY: u32 = 6u;
const Q_DONE: u32 = 14u;
const Q_YARDPICK: u32 = 15u;
const Q_YARD: u32 = 16u;
const Q_APEX: u32 = 17u;
const F_PICK: u32 = 0u;
const F_CAMP: u32 = 1u;
const F_YARD: u32 = 2u;
/** (works') the regrow ring's head, the tree list being made */
const F_RHEAD: u32 = 4u;
const F_LISTING: u32 = 5u;
const H_STORES: u32 = 0u;
const H_GRANARY: u32 = 1u;
const W_CLAIM: u32 = 0x10000u;
const J_WOOD: u32 = 4u;
const LEG_FWD: u32 = 1u;
const LEG_BACK: u32 = 2u;
const ROWH: f32 = 0.8660254;
/** a column's area (m²): the hex cell's */
const CELL_AREA: f32 = 0.8660254;
const M_RUBBLE_W: u32 = 4u;
const M_LOG_W: u32 = 29u;
const M_SAND_W: u32 = 3u;
/** the pile's angle of repose (rubble's, about), and a column's most a frame */
const REPOSE: f32 = 0.7;
const DIG_STEP: f32 = 0.25;
const PUT_STEP: f32 = 0.2;

fn lt(i: u32) -> u32 { return atomicLoad(&LT[i]); }
fn ltf(i: u32) -> f32 { return bitcast<f32>(atomicLoad(&LT[i])); }
fn setLt(i: u32, v: u32) { atomicStore(&LT[i], v); }
fn setLtf(i: u32, v: f32) { atomicStore(&LT[i], bitcast<u32>(v)); }
fn bumpC(c: u32, v: u32) { atomicAdd(&LT[L_C + c], v); }
fn BW() -> i32 { return i32(u.n.x); }
fn BH() -> i32 { return i32(u.n.y); }
fn inBoxW(c: vec2<i32>) -> bool { return c.x >= 0 && c.y >= 0 && c.x < BW() && c.y < BH(); }
fn bix(c: vec2<i32>) -> u32 { return u32(c.y * BW() + c.x); }
fn bxy(i: u32) -> vec2<i32> { return vec2<i32>(i32(i % u.n.x), i32(i / u.n.x)); }
fn bpos(c: vec2<i32>) -> vec2<f32> { return vec2<f32>(f32(c.x) + 0.5 + 0.5 * f32(c.y & 1), (f32(c.y) + 0.5) * ROWH); }
/** the grid column in the window (dy even: the rows' offsets agree); none past it */
fn toWin(c: vec2<i32>) -> vec2<i32> { return c + u.pl.xy; }
fn winIn(w: vec2<i32>) -> bool { return w.x >= 0 && w.y >= 0 && w.x < i32(G.mapW) && w.y < i32(G.mapH); }
fn hashW(x: u32) -> u32 {
  var s = x * 747796405u + 2891336453u;
  s = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (s >> 22u) ^ s;
}
/** a window column's top (window z; the floor 0 when empty) */
fn winTop(w: vec2<i32>) -> f32 {
  let cs = colSlots(u32(w.x), u32(w.y));
  var t = 0.0;
  for (var k = 0u; k < cs.y; k++) {
    let v = layersW[cs.x + k];
    if (ivEmpty(v)) { break; }
    t = ivZ1(v);
  }
  return t;
}

// ---- the quarry ----
fn benchRunW() -> f32 { return u.q2.y + u.q.y / tan(radians(clamp(u.q.w, 20.0, 80.0))); }
fn faceRunW() -> f32 { return u.q.y / tan(radians(clamp(u.q.w, 20.0, 80.0))); }
fn rampWidth() -> f32 { return max(faceRunW(), 2.0); }
fn benchesW() -> u32 { return u32(clamp(floor(u.q.z / max(u.q.y, 0.5)), 1.0, 40.0)); }
fn pitOrigin() -> vec2<f32> { return bpos(vec2<i32>(i32(lt(L_Q + Q_X0)) - 1, i32(lt(L_Q + Q_Y0)) - 1)) - vec2<f32>(0.5, 0.5 * ROWH); }
/** the pit's depth at a point (local to its corner): the benches' steps, the ramp down bench k's face on side k mod 4 */
fn pitDepth(l: vec2<f32>) -> f32 {
  let s = u.q.x;
  let ds = array<f32, 4>(l.y, s - l.x, s - l.y, l.x);
  var side = 0u;
  var d = ds[0];
  for (var k = 1u; k < 4u; k++) { if (ds[k] < d) { d = ds[k]; side = k; } }
  let run = benchRunW();
  let fr = faceRunW();
  let bh = u.q.y;
  let nb = benchesW();
  let k = u32(floor(d / run));
  if (k >= nb) { return f32(nb) * bh; }
  let f = d - f32(k) * run;
  var z = f32(k) * bh + bh * clamp(f / max(fr, 0.01), 0.0, 1.0);
  if (side == k % 4u && f < rampWidth()) {
    let len = max(s - 2.0 * f32(k) * run, 1.0);
    let along = array<f32, 4>(l.x, l.y, s - l.x, s - l.y);
    let t = clamp((along[side] - f32(k) * run) / len, 0.0, 1.0);
    z = f32(k) * bh + bh * t;
  }
  return z;
}
/** (one thread a frame) the dig budget into the working bench's progress; the face where the sweep is */
@compute @workgroup_size(1)
fn quarryStep() {
  if ((u.m.z & F_QUARRY) == 0u || lt(L_Q + Q_X0) == 0u) { atomicStore(&LT[L_C + C_DIGBUDGET], 0u); return; }
  let budget = f32(atomicExchange(&LT[L_C + C_DIGBUDGET], 0u)) / 1000.0;
  var b = lt(L_Q + Q_BENCH);
  let nb = benchesW();
  let run = benchRunW();
  let s = u.q.x;
  if (b >= nb) { setLt(L_Q + Q_DONE, 1u); return; }
  let inner = max(s - 2.0 * f32(b) * run, 0.0);
  let vol = max(inner * inner * u.q.y, 1.0);
  var pr = ltf(L_Q + Q_PROG) + budget / vol;
  if (pr >= 1.0 || inner < 2.0) {
    b++;
    pr = 0.0;
    setLt(L_Q + Q_BENCH, b);
  }
  setLtf(L_Q + Q_PROG, pr);
  let o = pitOrigin();
  let lo = f32(b) * run + rampWidth();
  let hi = s - f32(b) * run;
  setLtf(L_Q + Q_FACEX, o.x + mix(lo, max(hi, lo), clamp(pr, 0.0, 1.0)));
  setLtf(L_Q + Q_FACEY, o.y + s * 0.5);
}
/** (a thread a column of the footprint) the column taken down toward what the pit allows now: the benches done to
 *  their depth, the working bench where the sweep has passed; DIG_STEP a frame at most; the volume to the face's pile */
@compute @workgroup_size(8, 8)
fn dig(@builtin(global_invocation_id) g: vec3<u32>) {
  if ((u.m.z & F_QUARRY) == 0u || lt(L_Q + Q_X0) == 0u) { return; }
  let s = u.q.x;
  let nx = u32(ceil(s)) + 2u;
  let ny = u32(ceil(s / ROWH)) + 2u;
  if (g.x >= nx || g.y >= ny) { return; }
  let c = vec2<i32>(i32(lt(L_Q + Q_X0)) - 1 + i32(g.x), i32(lt(L_Q + Q_Y0)) - 1 + i32(g.y));
  let l = bpos(c) - pitOrigin();
  if (l.x < 0.0 || l.y < 0.0 || l.x > s || l.y > s || !inBoxW(c)) { return; }
  let w = toWin(c);
  if (!winIn(w)) { return; }
  let qi = g.y * nx + g.x;
  // (the ground as it was: snapshot the first time the column is seen — world z + 4096, 0 unset)
  if (QG[qi] == 0.0) { QG[qi] = winTop(w) - u.pz.x + 4096.0; }
  let g0 = QG[qi] - 4096.0;
  let full = pitDepth(l);
  let b = lt(L_Q + Q_BENCH);
  let bh = u.q.y;
  var allowed = min(full, f32(b) * bh);
  let run = benchRunW();
  let lo = f32(b) * run + rampWidth();
  let hi = s - f32(b) * run;
  let key = clamp((l.x - lo) / max(hi - lo, 1.0), 0.0, 1.0);
  if (key <= ltf(L_Q + Q_PROG) || lt(L_Q + Q_DONE) != 0u) { allowed = min(full, f32(b + 1u) * bh); }
  let tgt = max(g0 - allowed + u.pz.x, 2.0);
  // (worldops.wgsl opTake, the edit pass's own take: off the top, never External, never under z 2 — down to the target,
  // DIG_STEP a frame at most)
  let cs = colSlots(u32(w.x), u32(w.y));
  var arr: array<vec4<u32>, MAX_K>;
  var old: array<vec4<u32>, MAX_K>;
  var n = 0u;
  for (var k = 0u; k < cs.y; k++) { let v = layersW[cs.x + k]; old[k] = v; arr[k] = v; if (ivEmpty(v)) { break; } n = k + 1u; }
  let n0 = n;
  var left = DIG_STEP;
  var taken = 0.0;
  var mt = 0u;
  for (var k = 0u; k < MAX_K && n > 0u && left > 1e-4; k++) {
    let z1 = ivZ1(arr[n - 1u]);
    if (z1 <= tgt + 1e-3) { break; }
    let got = opTake(&arr, &n, min(left, z1 - tgt), &mt);
    if (got <= 0.0) { break; }
    taken += got;
    left -= got;
  }
  for (var k = 0u; k < n0; k++) {
    if (any(arr[k] != old[k])) { layersW[cs.x + k] = arr[k]; bumpColumn(vec2<u32>(w), old[k], arr[k]); }
  }
  if (taken > 0.0) {
    let lit = u32(taken * CELL_AREA * 1000.0);
    bumpC(C_DUG, lit);
    bumpC(C_FACE, lit);
    // (the pit's floor bare: no plants on fresh-cut rock)
    let vi = colIdx(u32(w.x), u32(w.y));
    vegW[vi] = 0.0;
    vegNextW[vi] = 0.0;
  }
}

// ---- the stockpile ----
fn lotCountW() -> u32 { return min(CNT[0], u.m.x); }
fn fcornerW(r: u32, k: u32) -> vec2<f32> { let o = r * RECW + 8u + (k & 3u) * 2u; return vec2<f32>(bitcast<f32>(REC[o]), bitcast<f32>(REC[o + 1u])); }
fn lotMidW(r: u32) -> vec2<f32> { return 0.25 * (fcornerW(r, 0u) + fcornerW(r, 1u) + fcornerW(r, 2u) + fcornerW(r, 3u)); }
/** the yard's radius: the footprint's inscribed circle, roughly (at most 8) */
fn yardR(r: u32) -> f32 {
  let m = lotMidW(r);
  var d = 8.0;
  for (var k = 0u; k < 4u; k++) { d = min(d, distance(m, 0.5 * (fcornerW(r, k) + fcornerW(r, k + 1u)))); }
  return max(d - 0.5, 1.5);
}
@compute @workgroup_size(1)
fn worksInit() {
  if (lt(L_Q + Q_YARD) == 0u && lt(L_Q + Q_YARDPICK) == 0u) { setLt(L_Q + Q_YARDPICK, NONE); }
  if (lt(L_FELL) > FELL_ROOM) { setLt(L_FELL, FELL_ROOM); }
}
/** (a thread a lot, until a yard is found) the stores' yard: the open lot (park or plaza) nearest the stores' door */
@compute @workgroup_size(64)
fn yardPick(@builtin(global_invocation_id) g: vec3<u32>) {
  let r = g.x;
  if (lt(L_Q + Q_YARD) != 0u || r >= lotCountW() || r >= 32768u) { return; }
  let st = lt(L_HUBCOL + H_STORES);
  if (st == 0u) { return; }
  let kind = REC[r * RECW + 17u];
  if (kind != 2u && kind != 3u) { return; }
  if (yardR(r) < 2.5) { return; }
  let d = u32(min(distance(lotMidW(r), bpos(bxy(st - 1u))), 4000.0));
  atomicMin(&LT[L_Q + Q_YARDPICK], (d << 15u) | r);
}
@compute @workgroup_size(1)
fn yardFix() {
  let p = lt(L_Q + Q_YARDPICK);
  if (lt(L_Q + Q_YARD) == 0u && p != NONE && p != 0u) { setLt(L_Q + Q_YARD, (p & 0x7fffu) + 1u); }
  // (the pile's apex: the cone holding everything brought so far, in the yard's radius)
  let y = lt(L_Q + Q_YARD);
  if (y == 0u) { return; }
  let V = f32(lt(L_C + C_DEPOSITED) + lt(L_C + C_INBOX)) / 1000.0;
  let R = yardR(y - 1u);
  var h = pow(3.0 * V * REPOSE * REPOSE / 3.14159, 1.0 / 3.0);
  if (h > R * REPOSE) { h = R * REPOSE + (V - 3.14159 * R * R * R * REPOSE / 3.0) / (3.14159 * R * R); }
  setLtf(L_Q + Q_APEX, h);
}
/** (a thread a column of the yard's square) the inbox put on the yard's columns up to the cone (an exact put: onto the
 *  top interval if it's rubble, else a new one) */
@compute @workgroup_size(8, 8)
fn pile(@builtin(global_invocation_id) g: vec3<u32>) {
  let y = lt(L_Q + Q_YARD);
  if (y == 0u || g.x >= 20u || g.y >= 22u) { return; }
  let m = lotMidW(y - 1u);
  let R = yardR(y - 1u);
  let c = vec2<i32>(i32(floor(m.x)) - 10 + i32(g.x), i32(floor(m.y / ROWH)) - 11 + i32(g.y));
  if (!inBoxW(c)) { return; }
  let d = distance(bpos(c), m);
  if (d > R) { return; }
  let w = toWin(c);
  if (!winIn(w)) { return; }
  let pi = g.y * 20u + g.x;
  let want = min(ltf(L_Q + Q_APEX) - d * REPOSE - PUT[pi], PUT_STEP);
  if (want < 0.01) { return; }
  // (litres from the inbox: a whole share or none)
  let lit = u32(want * CELL_AREA * 1000.0);
  var have = lt(L_C + C_INBOX);
  var got = false;
  for (var k = 0u; k < 8u && !got; k++) {
    if (have < lit) { return; }
    let r = atomicCompareExchangeWeak(&LT[L_C + C_INBOX], have, have - lit);
    if (r.exchanged) { got = true; } else { have = r.old_value; }
  }
  if (!got) { return; }
  // (worldops.wgsl opPut, the edit pass's own put)
  let cs = colSlots(u32(w.x), u32(w.y));
  var arr: array<vec4<u32>, MAX_K>;
  var n = 0u;
  for (var k = 0u; k < cs.y; k++) { let v = layersW[cs.x + k]; arr[k] = v; if (ivEmpty(v)) { break; } n = k + 1u; }
  let n0 = n;
  let put = opPut(&arr, &n, cs.y, M_RUBBLE_W, want, f32(G.zMax) - 2.0) > 0.0;
  if (put) {
    for (var k = max(n0, 1u) - 1u; k < n; k++) {
      let ov = layersW[cs.x + k];
      layersW[cs.x + k] = arr[k];
      bumpColumn(vec2<u32>(w), ov, arr[k]);
    }
    PUT[pi] += want;
    bumpC(C_DEPOSITED, lit);
  } else {
    // (no room in the column: back to the inbox, counted again next frame)
    atomicAdd(&LT[L_C + C_INBOX], lit);
  }
}

// ---- the clearing ----
fn campCentre() -> vec2<f32> { return bpos(bxy(lt(L_F + F_CAMP) - 1u)); }
/** a tree stands at the grid column (vegPlan's, at its window column), not claimed */
fn treeAt(c: vec2<i32>) -> bool {
  let w = toWin(c);
  if (!winIn(w)) { return false; }
  let v = vegW[colIdx(u32(w.x), u32(w.y))];
  return v >= 3.6 && vegPlan(u32(w.x), u32(w.y), v, 0u).tree;
}
/** (a thread a column, until a camp's found) the clearing's site: outside the town, the most trees round it */
@compute @workgroup_size(64)
fn campPick(@builtin(global_invocation_id) g: vec3<u32>) {
  let i = g.x;
  if (i >= u.n.x * u.n.y || lt(L_F + F_CAMP) != 0u || (u.m.z & F_FOREST) == 0u) { return; }
  let c = bxy(i);
  if ((c.x & 1) != 0 || (c.y & 1) != 0) { return; }
  let p = bpos(c);
  let dc = distance(p, u.t.zw);
  let rr = u.f.x;
  if (dc < 0.6 * u.r.x + rr * 0.5 || dc > 1.3 * u.r.x + rr) { return; }
  if (c.x < 8 || c.y < 8 || c.x >= BW() - 8 || c.y >= BH() - 8) { return; }
  if ((atomicLoad(&WALK[i]) & 0xfu) != 0u) { return; }
  var n = 0u;
  for (var dy = -7; dy <= 7; dy++) {
    for (var dx = -7; dx <= 7; dx++) {
      if (treeAt(c + vec2<i32>(dx, dy))) { n++; }
    }
  }
  if (n < 4u) { return; }
  atomicMax(&LT[L_F + F_PICK], (min(n, 8191u) << 18u) | (i & 0x3ffffu));
}
/** (one thread) the camp from its pick: the yard toward the town at the clearing's edge; the graph made again */
@compute @workgroup_size(1)
fn campFix() {
  if (lt(L_F + F_CAMP) != 0u || (u.m.z & F_FOREST) == 0u) { return; }
  let p = lt(L_F + F_PICK);
  if ((p >> 18u) < 4u) { return; }
  let ci = p & 0x3ffffu;
  setLt(L_F + F_CAMP, ci + 1u);
  let cp = bpos(bxy(ci));
  let to = normalize(u.t.zw - cp + vec2<f32>(1e-3, 0.0));
  let yp = cp + to * (u.f.x * 0.6 + 3.0);
  let r = (yp.y - 0.5 * ROWH) / ROWH;
  let a = vec2<f32>(yp.x - 0.5 - 0.5 * r, r);
  let cc = vec3<f32>(a.x, a.y, -a.x - a.y);
  var o = round(cc);
  let e = abs(o - cc);
  if (e.x > e.y && e.x > e.z) { o.x = -o.y - o.z; } else if (e.y > e.z) { o.y = -o.x - o.z; }
  let yc = vec2<i32>(i32(o.x) + (i32(o.y) - (i32(o.y) & 1)) / 2, i32(o.y));
  if (!inBoxW(yc)) { return; }
  setLt(L_F + F_YARD, bix(yc) + 1u);
  // (a new hub: the graph made again with the yard's track and seed — routes.wgsl's build)
  setLt(L_PHASE, 0u);
}
/** (one thread) the tree list made again when it's used up (its trees all taken) */
@compute @workgroup_size(1)
fn treeListClear() {
  let n = min(lt(L_C + C_TREES), TREE_ROOM);
  if (lt(L_F + F_CAMP) != 0u && lt(L_C + C_TREECUR) >= n) {
    setLt(L_C + C_TREES, 0u);
    setLt(L_C + C_TREECUR, 0u);
    setLt(L_F + F_LISTING, 1u);
  }
}
/** (a thread a column of the clearing's square) its standing trees listed and claimed */
@compute @workgroup_size(8, 8)
fn treeList(@builtin(global_invocation_id) g: vec3<u32>) {
  if (lt(L_F + F_LISTING) == 0u) { return; }
  let rr = u.f.x;
  let span = u32(ceil(rr)) * 2u + 1u;
  if (g.x >= span || g.y >= u32(ceil(f32(span) / ROWH))) { return; }
  let cc = bxy(lt(L_F + F_CAMP) - 1u);
  let c = cc + vec2<i32>(i32(g.x) - i32(ceil(rr)), i32(g.y) - i32(ceil(rr / ROWH)));
  if (!inBoxW(c) || distance(bpos(c), campCentre()) > rr) { return; }
  let i = bix(c);
  // (on the clearing's pad only: its route to the yard is traced over it)
  if ((atomicLoad(&WALK[i]) & W_CLAIM) != 0u || (atomicLoad(&WALK[i]) & 0xfu) == 0u || !treeAt(c)) { return; }
  let k = atomicAdd(&LT[L_C + C_TREES], 1u);
  if (k >= TREE_ROOM) { return; }
  atomicOr(&WALK[i], W_CLAIM);
  setLt(L_TREES + k, i + 1u);
}
@compute @workgroup_size(1)
fn treeListDone() { setLt(L_F + F_LISTING, 0u); }

/** (a thread an asked fell) the tree cut to its stump; the woodcutter given its logs (none if it's gone) */
@compute @workgroup_size(64)
fn fellApply(@builtin(global_invocation_id) g: vec3<u32>) {
  let q = g.x;
  if (q >= min(lt(L_FELL), FELL_ROOM)) { return; }
  let rider = lt(L_FELL + 1u + q) - 1u;
  let aux = bitcast<u32>(RID[rider * 4u + 3u].z);
  var logs = 0.0;
  if (aux != 0u) {
    let c = bxy(aux - 1u);
    let w = toWin(c);
    if (winIn(w)) {
      let vi = colIdx(u32(w.x), u32(w.y));
      let v = vegW[vi];
      let pl = vegPlan(u32(w.x), u32(w.y), v, 0u);
      if (v >= 3.6 && pl.tree) {
        logs = max(1.0, round(0.3 * pl.trunk + 0.15 * pl.crown));
        // (worldops.wgsl opFell: the edit pass's own fell — a tree's stump)
        vegW[vi] = opFell(v, true);
        vegNextW[vi] = opFell(v, true);
        bumpC(C_FELLED, 1u);
        bumpC(C_LOGS_CUT, u32(logs));
        let h = atomicAdd(&LT[L_F + F_RHEAD], 1u) % REGROW_ROOM;
        setLt(L_REGROW + h * 2u, aux);
        setLtf(L_REGROW + h * 2u + 1u, u.t.y);
      }
    }
    atomicAnd(&WALK[aux - 1u], ~W_CLAIM);
  }
  RID[rider * 4u + 2u].z = logs;
}
@compute @workgroup_size(1)
fn fellDone() { setLt(L_FELL, 0u); }

/** (a thread a felled column, replant on) young woods again after the regrow time */
@compute @workgroup_size(64)
fn regrow(@builtin(global_invocation_id) g: vec3<u32>) {
  let k = g.x;
  if (k >= REGROW_ROOM || (u.m.z & F_REPLANT) == 0u) { return; }
  let c1 = lt(L_REGROW + k * 2u);
  if (c1 == 0u || u.t.y - ltf(L_REGROW + k * 2u + 1u) < u.f.w) { return; }
  let w = toWin(bxy(c1 - 1u));
  if (winIn(w)) {
    let vi = colIdx(u32(w.x), u32(w.y));
    if (vegW[vi] < 2.5) { vegW[vi] = 3.0; vegNextW[vi] = 3.0; bumpC(C_REGROWN, 1u); }
  }
  setLt(L_REGROW + k * 2u, 0u);
}

// ---- riders on the ground; building sites; the piles' look ----
/** (a thread a rider) off a route (or on the quarry's ramp: the pit as dug), a rider stands on the live ground */
@compute @workgroup_size(64)
fn riderZ(@builtin(global_invocation_id) g: vec3<u32>) {
  let i = g.x;
  if (i >= u.n.z) { return; }
  let b = bitcast<vec4<u32>>(RID[i * 4u + 1u]);
  let leg = (b.x >> 16u) & 0xffu;
  let ramp = lt(L_Q + 4u);
  if ((leg == LEG_FWD || leg == LEG_BACK) && !(ramp != 0u && b.y == ramp - 1u)) { return; }
  let a = RID[i * 4u];
  let r = (a.y - 0.5 * ROWH) / ROWH;
  let ax = vec2<f32>(a.x - 0.5 - 0.5 * r, r);
  let cc = vec3<f32>(ax.x, ax.y, -ax.x - ax.y);
  var o = round(cc);
  let e = abs(o - cc);
  if (e.x > e.y && e.x > e.z) { o.x = -o.y - o.z; } else if (e.y > e.z) { o.y = -o.x - o.z; }
  let c = vec2<i32>(i32(o.x) + (i32(o.y) - (i32(o.y) & 1)) / 2, i32(o.y));
  let w = toWin(c);
  if (winIn(w)) { RID[i * 4u].z = winTop(w) - u.pz.x; }
  else if (inBoxW(c)) { RID[i * 4u].z = HT[bix(c)]; }
}

fn voxW(at: vec3<f32>, mat: u32, size: u32, yaw: f32) {
  let k = atomicAdd(&VARGSW[1], 1u);
  if (k * 2u + 1u >= arrayLength(&VOXW)) { return; }
  VOXW[k * 2u] = vec4<u32>(bitcast<u32>(at.x), bitcast<u32>(at.y), bitcast<u32>(at.z), (mat & 0xffu) | ((size & 63u) << 24u));
  VOXW[k * 2u + 1u] = vec4<u32>(0u, 0u, bitcast<u32>(sin(yaw * 0.5)), bitcast<u32>(cos(yaw * 0.5)));
}
fn toWinP(p: vec2<f32>, zw: f32) -> vec3<f32> { return vec3<f32>(p + vec2<f32>(f32(u.pl.x), f32(u.pl.y) * ROWH), zw + u.pz.x); }
/** a stack of n pieces (logs, sacks) by a point: rows of 5, layers of 3 rows */
fn stack(at: vec2<f32>, z: f32, n: u32, mat: u32, size: u32) {
  let sz = f32(size) / 16.0;
  for (var k = 0u; k < min(n, 90u); k++) {
    let x = f32(k % 5u) * sz;
    let y = f32((k / 5u) % 3u) * sz * 1.1;
    let h = f32(k / 15u) * sz;
    voxW(toWinP(at + vec2<f32>(x, y), z + sz * 0.5 + h), mat, size, 0.0);
  }
}
/** (one thread) the piles drawn: the camp's logs, the stores' logs, the granary's sacks */
@compute @workgroup_size(1)
fn pileVox() {
  atomicStore(&VARGSW[0], 36u);
  atomicStore(&VARGSW[1], 0u);
  atomicStore(&VARGSW[2], 0u);
  atomicStore(&VARGSW[3], 0u);
  let yard = lt(L_F + F_YARD);
  if (yard != 0u) {
    let p = bpos(bxy(yard - 1u)) + vec2<f32>(1.5, 0.5);
    stack(p, HT[yard - 1u], lt(L_C + C_LOG_CAMP), M_LOG_W, 8u);
  }
  let st = lt(L_HUBCOL + H_STORES);
  if (st != 0u) {
    let p = bpos(bxy(st - 1u)) + vec2<f32>(1.5, -2.5);
    stack(p, HT[st - 1u], lt(L_C + C_LOG_STORES) / 2u, M_LOG_W, 8u);
  }
  let gr = lt(L_HUBCOL + H_GRANARY);
  if (gr != 0u) {
    let p = bpos(bxy(gr - 1u)) + vec2<f32>(-2.5, -2.0);
    stack(p, HT[gr - 1u], lt(L_C + C_PRODUCE) / 4u, M_SAND_W, 6u);
  }
}
