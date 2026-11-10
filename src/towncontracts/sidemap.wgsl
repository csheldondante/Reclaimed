// ---- sidemap.wgsl: which side of each town's wall every window column is on (towncontracts/contracts.ts) ----------
// Appended to common.wgsl, layers.wgsl, materials.wgsl. Written into Track B's `agentSides` (agents/notice.ts; notice.wgsl `sides`): a u32 a window
// column in window order (y * W + x), 0 open, else the town's slot + 1. A column is on a town's side when it is in the
// town's region (inside its ring, or on the wall's band) and its walkable component reaches no column outside every
// region. Components: walkable columns (the water no deeper than SP.f.x; a gate closed when SP.misc.y — its segment a
// barrier) joined to a hex neighbour when their tops (the surface's: the wall's claimed spans are in it) are within a
// step (SP.f.y) — the tops read from the columns' slots; the wall's 4.5 units stand between the inside and the outside where they've risen; a breach (a
// dug piece) or a gap joins them. Labels: every walkable column outside the regions is 0 (the outside), the others their
// index + 1, hooked to the least label round them and pointer-jumped until nothing changes (the atlas's GPU flood fill,
// fortreach.wgsl's) — a component holding a 0 is open. A segment the ring leaves open over water or a cliff (WALL kind
// 2: no piece) is a barrier too, as citygen meant it: the water there is the wall (its banks would let a walker round
// the last tower otherwise — Muru's river does).
//
// Woken on the GPU, never by the CPU's reading anything:
//   sideWatch (a town: a thread a chunk)  the newest shape version of the chunks over its ring's box (a piece risen, a
//                                         breach) and their water class's, a hash of its ring's words, its ring's box
//   sideWake (one thread)                 a shape version newer than the last solve's, a hash moved, the window slid
//                                         (G.org, G.ring), the CPU's input epoch moved (towns made or let go, the gate
//                                         rule), or (at most every WATER_GAP frames) a newer water class → a solve starts
//                                         when none is running (a change mid-solve waits for the next)
// A solve: sideClear, sideRaster (a town), sidePrep, then rounds of sideHook + sideJump + sideRound (indirect: 0
// workgroups once settled) until a round changes nothing, then sideFinal writes the map and sideDone counts the solve.

// (the chunk table, binding 1: layers.wgsl's, prepended — and materials.wgsl after it)
@group(0) @binding(3) var<storage, read> layers: array<vec4<u32>>;
@group(0) @binding(4) var<storage, read> water: array<f32>;
@group(0) @binding(5) var<storage, read> WALLW: array<u32>;
@group(0) @binding(6) var<storage, read_write> MASK: array<atomic<u32>>;
@group(0) @binding(7) var<storage, read_write> LABEL: array<atomic<u32>>;
@group(0) @binding(8) var<storage, read_write> TOP: array<f32>;
@group(0) @binding(9) var<storage, read_write> CTL: array<atomic<u32>>;
@group(0) @binding(10) var<storage, read_write> SIDES: array<u32>;
/** the solve's indirect dispatches (SC_ARG_*): bound only by the one-thread kernels that set them — a buffer read as
 *  indirect args can't be bound writable in the dispatch it sizes */
@group(0) @binding(12) var<storage, read_write> ARGS: array<u32>;

struct SideP {
  /** the town's grid in the window: x, y (world units), z (window z less world z), unused */
  place: vec4<f32>,
  /** x the town's slot (NONE: the global kernels'), y 1 gates closed, z the CPU's input epoch, w the window's columns
   *  dispatch (workgroups of 64) */
  misc: vec4<u32>,
  /** x the deepest water walked (a deeper column is a barrier), y the highest step between neighbours, zw unused */
  f: vec4<f32>,
};
@group(0) @binding(11) var<uniform> SP: SideP;

// ---- ARGS: three indirect dispatches (x, y, z, pad) ----
const SC_ARG_PREP: u32 = 0u;
const SC_ARG_ROUND: u32 = 4u;
const SC_ARG_FINAL: u32 = 8u;
// ---- CTL (towncontracts/contracts.ts SC — keep in step) ----
const SC_STATE: u32 = 12u;
const SC_CHANGED: u32 = 13u;
const SC_DIRTY: u32 = 14u;
const SC_SEENV: u32 = 15u;
const SC_NEWV: u32 = 16u;
const SC_ORGX: u32 = 17u;
const SC_ORGY: u32 = 18u;
const SC_RING: u32 = 19u;
const SC_EPOCH: u32 = 20u;
const SC_SOLVES: u32 = 21u;
const SC_LAST_ROUNDS: u32 = 22u;
const SC_ROUNDS: u32 = 23u;
const SC_HNEW: u32 = 24u;
const SC_HSEEN: u32 = 28u;
/** each town's ring's box (the grid's frame: lo x, lo y, hi x, hi y, f32 bits; lo > hi none) */
const SC_BOX: u32 = 32u;
const SC_NEWCOL: u32 = 48u;
const SC_NEWCLASS: u32 = 49u;
const SC_SEENW: u32 = 50u;
const SC_FRAME: u32 = 51u;
const SC_LASTW: u32 = 52u;
/** frames at least between solves the water's class alone wakes */
const WATER_GAP: u32 = 120u;
const ST_IDLE: u32 = 0u;
const ST_PREP: u32 = 1u;
const ST_ROUNDS: u32 = 2u;
const ST_FINAL: u32 = 3u;

const NONE: u32 = 0xffffffffu;
const M_TOWN: u32 = 15u;
const M_GATE: u32 = 16u;
/** a wall piece's column (bits 8–31 its foot's window z: (z + 64) × 8) */
const M_WALL: u32 = 32u;
/** a standing wall piece's label: not walkable, not hooked, its town's side */
const WALL_L: u32 = 0xfffffffeu;
/** a piece stands (a barrier) once its column is this far over its foot */
const WALL_STAND: f32 = 2.0;
const WALL_HW: f32 = 1.35;
const WB_Z: u32 = 296u;
// (streets.wgsl WALL)
const NB: u32 = 72u;
const WB_V: u32 = 80u;
const WB_KIND: u32 = 368u;
/** the wall's band: a column this near the ring's line is in its town's region (the wall-walk's outer half) */
const BAND: f32 = 2.5;
/** a closed gate: its segment, this wide each side and this far past its corners, a barrier */
const GATE_HW: f32 = 1.25;
const GATE_PAST: f32 = 1.0;
/** a chunk's version vec2s (chunkver.wgsl VER_VEC2) */
const VER_VEC2: u32 = 10u;

fn N() -> u32 { return G.mapW * G.mapH; }
fn ctl(i: u32) -> u32 { return atomicLoad(&CTL[i]); }
fn setCtl(i: u32, v: u32) { atomicStore(&CTL[i], v); }
fn args(at: u32, n: u32) { ARGS[at] = n; ARGS[at + 1u] = 1u; ARGS[at + 2u] = 1u; }

fn corner(b: u32) -> vec2<f32> { let o = WB_V + 2u * (b % NB); return vec2<f32>(bitcast<f32>(WALLW[o]), bitcast<f32>(WALLW[o + 1u])); }
fn segDist(p: vec2<f32>, a: vec2<f32>, b: vec2<f32>, past: f32) -> f32 {
  let ab = b - a;
  let L = max(length(ab), 1e-4);
  let t = clamp(dot(p - a, ab) / (L * L), -past / L, 1.0 + past / L);
  return distance(p, a + ab * t);
}

// ---- the watch: what a solve depends on, as GPU words ----
/** the version vec2s of window chunk (cx, cy): its columns' and its water class's newest (chunkver.wgsl chunkVerAt) */
fn chunkVer(cx: u32, cy: u32) -> vec3<u32> {
  let cs = G.chunkSize;
  let t = chunks[cy * G.chunksX + cx];
  if (t.y == 0u) { return vec3<u32>(0u); }
  let at = G.chunksX * (G.mapH / cs) + VER_VEC2 * (t.x / (cs * cs * t.y));
  // (its shape's newest: the 4 x 4 blocks' words, [2..9])
  var sh = 0u;
  for (var k = 2u; k < VER_VEC2; k++) { sh = max(sh, max(chunks[at + k].x, chunks[at + k].y)); }
  return vec3<u32>(chunks[at].x, chunks[at].y, sh);
}
@compute @workgroup_size(64)
fn sideWatch(@builtin(global_invocation_id) g: vec3<u32>) {
  let s = SP.misc.x;
  let cs = G.chunkSize;
  let cw = G.mapW / cs;
  let ch = G.mapH / cs;
  if (g.x == 0u) {
    var h = (WALLW[0] * 2654435761u) ^ WALLW[2];
    var lo = vec2<f32>(1e9);
    var hi = vec2<f32>(-1e9);
    if (WALLW[0] == 1u) {
      for (var b = 0u; b < NB; b++) {
        h = (h ^ WALLW[WB_KIND + b] ^ WALLW[WB_V + 2u * b] ^ (WALLW[WB_V + 2u * b + 1u] << 7u)) * 16777619u;
        lo = min(lo, corner(b));
        hi = max(hi, corner(b));
      }
    }
    setCtl(SC_HNEW + s, h | 1u);
    setCtl(SC_BOX + 4u * s, bitcast<u32>(lo.x));
    setCtl(SC_BOX + 4u * s + 1u, bitcast<u32>(lo.y));
    setCtl(SC_BOX + 4u * s + 2u, bitcast<u32>(hi.x));
    setCtl(SC_BOX + 4u * s + 3u, bitcast<u32>(hi.y));
  }
  if (g.x >= cw * ch || WALLW[0] != 1u) { return; }
  let cx = g.x % cw;
  let cy = g.x / cw;
  // (the ring's box in the window's columns, a few columns' margin: the chunk overlapping it watched)
  var lo = vec2<f32>(1e9);
  var hi = vec2<f32>(-1e9);
  for (var b = 0u; b < NB; b++) { lo = min(lo, corner(b)); hi = max(hi, corner(b)); }
  lo += SP.place.xy - vec2<f32>(BAND + 2.0);
  hi += SP.place.xy + vec2<f32>(BAND + 2.0);
  let x0 = f32(cx * cs);
  let y0 = f32(cy * cs) * ROW_H;
  if (x0 + f32(cs) + 1.0 < lo.x || x0 - 1.0 > hi.x || y0 + f32(cs) * ROW_H < lo.y || y0 > hi.y) { return; }
  let v = chunkVer(cx, cy);
  // (the shape — a slot's ends, its material: a piece risen, a breach — wakes a solve at once; the water's class, which
  // flickers every tick where a river runs, at most every WATER_GAP frames; the columns' own word only for the debug
  // reads — it moves every tick there too)
  atomicMax(&CTL[SC_NEWV], v.z);
  atomicMax(&CTL[SC_NEWCLASS], v.y);
  atomicMax(&CTL[SC_NEWCOL], v.x);
}

@compute @workgroup_size(1)
fn sideWake() {
  var dirty = ctl(SC_DIRTY);
  let v = ctl(SC_NEWV);
  if (v != ctl(SC_SEENV)) { setCtl(SC_SEENV, v); dirty = 1u; }
  let frame = ctl(SC_FRAME) + 1u;
  setCtl(SC_FRAME, frame);
  let wv = ctl(SC_NEWCLASS);
  if (wv != ctl(SC_SEENW) && frame - ctl(SC_LASTW) >= WATER_GAP) { setCtl(SC_SEENW, wv); setCtl(SC_LASTW, frame); dirty = 1u; }
  let ox = bitcast<u32>(G.org.z);
  let oy = bitcast<u32>(G.org.w);
  if (ox != ctl(SC_ORGX) || oy != ctl(SC_ORGY)) { setCtl(SC_ORGX, ox); setCtl(SC_ORGY, oy); dirty = 1u; }
  let rg = G.ring.x | (G.ring.y << 16u);
  if (rg != ctl(SC_RING)) { setCtl(SC_RING, rg); dirty = 1u; }
  if (SP.misc.z != ctl(SC_EPOCH)) { setCtl(SC_EPOCH, SP.misc.z); dirty = 1u; }
  for (var s = 0u; s < 4u; s++) {
    if (ctl(SC_HNEW + s) != ctl(SC_HSEEN + s)) { setCtl(SC_HSEEN + s, ctl(SC_HNEW + s)); dirty = 1u; }
  }
  if (ctl(SC_STATE) == ST_IDLE && dirty == 1u) {
    setCtl(SC_STATE, ST_PREP);
    dirty = 0u;
    args(SC_ARG_PREP, SP.misc.w);
  } else {
    args(SC_ARG_PREP, 0u);
  }
  setCtl(SC_DIRTY, dirty);
}

// ---- a solve ----
@compute @workgroup_size(64)
fn sideClear(@builtin(global_invocation_id) g: vec3<u32>) {
  if (g.x < N()) { atomicStore(&MASK[g.x], 0u); }
}

/** a town's region (inside its ring, or on the wall's band) and, with gates closed, its gates' barriers */
@compute @workgroup_size(64)
fn sideRaster(@builtin(global_invocation_id) g: vec3<u32>) {
  let i = g.x;
  let s = SP.misc.x;
  if (i >= N() || WALLW[0] != 1u) { return; }
  let lo = vec2<f32>(bitcast<f32>(ctl(SC_BOX + 4u * s)), bitcast<f32>(ctl(SC_BOX + 4u * s + 1u))) - vec2<f32>(BAND + 1.0);
  let hi = vec2<f32>(bitcast<f32>(ctl(SC_BOX + 4u * s + 2u)), bitcast<f32>(ctl(SC_BOX + 4u * s + 3u))) + vec2<f32>(BAND + 1.0);
  let p = cellPos(vec2<i32>(winXY(i))) - SP.place.xy;
  if (any(p < lo) || any(p > hi)) { return; }
  var inside = false;
  var near = 1e9;
  var gate = false;
  var wallD = 1e9;
  var wallBase = 0.0;
  for (var b = 0u; b < NB; b++) {
    let a = corner(b);
    let q = corner(b + 1u);
    if ((a.y > p.y) != (q.y > p.y)) {
      let x = a.x + (p.y - a.y) / (q.y - a.y) * (q.x - a.x);
      if (p.x < x) { inside = !inside; }
    }
    let d = segDist(p, a, q, 0.0);
    near = min(near, d);
    // (a wall piece's own columns — citygen's wallCols: within its half width + 0.35 — with its foot's z there)
    if (WALLW[WB_KIND + b] == 0u && d <= WALL_HW && d < wallD) {
      wallD = d;
      let ab = q - a;
      let t = clamp(dot(p - a, ab) / max(dot(ab, ab), 1e-6), 0.0, 1.0);
      wallBase = mix(bitcast<f32>(WALLW[WB_Z + b]), bitcast<f32>(WALLW[WB_Z + (b + 1u) % NB]), t) - 0.4 + SP.place.z;
    }
    // (a gate closed by the rule; a gap the ring leaves over water or a cliff always: citygen left it to the water)
    let kind = WALLW[WB_KIND + b];
    if (((SP.misc.y == 1u && kind == 1u) || kind == 2u) && segDist(p, a, q, GATE_PAST) < GATE_HW) { gate = true; }
  }
  if (!inside && near > BAND && !gate) { return; }
  var m = select(0u, s + 1u, inside || near <= BAND);
  if (gate) { m |= M_GATE; }
  if (wallD < 1e8) { m |= M_WALL | (u32(clamp((wallBase + 64.0) * 8.0, 0.0, 16777215.0)) << 8u); }
  atomicOr(&MASK[i], m);
}

@compute @workgroup_size(64)
fn sidePrep(@builtin(global_invocation_id) g: vec3<u32>) {
  let i = g.x;
  if (i >= N()) { return; }
  let c = winXY(i);
  let ci = colIdx(c.x, c.y);
  // (the column's top from its own slots — what the versions follow — not the surface pass's copy, which lags a tick)
  let cs = colSlots(c.x, c.y);
  var top = -1e9;
  for (var k = 0u; k < cs.y; k++) {
    let v = layers[cs.x + k];
    if (ivEmpty(v)) { break; }
    top = ivZ1(v);
  }
  let m = atomicLoad(&MASK[i]);
  let walk = water[ci] <= SP.f.x && (m & M_GATE) == 0u && top > -1e8;
  TOP[i] = top;
  // (a wall piece standing — WALL_STAND over its foot — is the wall: no one's way across, its town's own side; dug
  // down or not risen it's ground again, and a way through)
  let standing = (m & M_WALL) != 0u && top >= f32(m >> 8u) / 8.0 - 64.0 + WALL_STAND;
  atomicStore(&LABEL[i], select(select(NONE, select(i + 1u, 0u, (m & M_TOWN) == 0u), walk), WALL_L, standing));
}

@compute @workgroup_size(1)
fn sideAfterPrep() {
  if (ctl(SC_STATE) != ST_PREP) { return; }
  setCtl(SC_STATE, ST_ROUNDS);
  args(SC_ARG_PREP, 0u);
  args(SC_ARG_ROUND, SP.misc.w);
  setCtl(SC_CHANGED, 0u);
  setCtl(SC_ROUNDS, 0u);
}

@compute @workgroup_size(64)
fn sideHook(@builtin(global_invocation_id) g: vec3<u32>) {
  let i = g.x;
  if (i >= N()) { return; }
  let l = atomicLoad(&LABEL[i]);
  if (l >= WALL_L || l == 0u) { return; }
  let c = vec2<i32>(winXY(i));
  let t = TOP[i];
  var best = l;
  for (var k = 0u; k < 6u; k++) {
    let n = nbr(c, k);
    if (n.x < 0 || n.y < 0 || n.x >= i32(G.mapW) || n.y >= i32(G.mapH)) { continue; }
    let j = u32(n.y) * G.mapW + u32(n.x);
    let ln = atomicLoad(&LABEL[j]);
    if (ln >= WALL_L || abs(TOP[j] - t) > SP.f.y) { continue; }
    best = min(best, ln);
  }
  if (best < l) {
    atomicMin(&LABEL[l - 1u], best);
    atomicMin(&LABEL[i], best);
    setCtl(SC_CHANGED, 1u);
  }
}

@compute @workgroup_size(64)
fn sideJump(@builtin(global_invocation_id) g: vec3<u32>) {
  let i = g.x;
  if (i >= N()) { return; }
  let l0 = atomicLoad(&LABEL[i]);
  var l = l0;
  for (var k = 0u; k < 8u; k++) {
    if (l == 0u || l >= WALL_L) { break; }
    let p = atomicLoad(&LABEL[l - 1u]);
    if (p >= l) { break; }
    l = p;
  }
  if (l < l0) {
    atomicMin(&LABEL[i], l);
    setCtl(SC_CHANGED, 1u);
  }
}

@compute @workgroup_size(1)
fn sideRound() {
  if (ctl(SC_STATE) != ST_ROUNDS) { return; }
  setCtl(SC_ROUNDS, ctl(SC_ROUNDS) + 1u);
  if (ctl(SC_CHANGED) == 0u) {
    setCtl(SC_STATE, ST_FINAL);
    args(SC_ARG_ROUND, 0u);
    args(SC_ARG_FINAL, SP.misc.w);
  }
  setCtl(SC_CHANGED, 0u);
}

@compute @workgroup_size(64)
fn sideFinal(@builtin(global_invocation_id) g: vec3<u32>) {
  let i = g.x;
  if (i >= N()) { return; }
  let m = atomicLoad(&MASK[i]) & M_TOWN;
  let l = atomicLoad(&LABEL[i]);
  SIDES[i] = select(0u, m, m != 0u && l != 0u && l != NONE);
}

@compute @workgroup_size(1)
fn sideDone() {
  if (ctl(SC_STATE) != ST_FINAL) { return; }
  setCtl(SC_STATE, ST_IDLE);
  args(SC_ARG_FINAL, 0u);
  setCtl(SC_SOLVES, ctl(SC_SOLVES) + 1u);
  setCtl(SC_LAST_ROUNDS, ctl(SC_ROUNDS));
}

// ---- (debug and tests only) the side map copied out: Track B's buffer isn't a copy source ----
@group(0) @binding(13) var<storage, read_write> DBG: array<u32>;
@compute @workgroup_size(64)
fn sideCopy(@builtin(global_invocation_id) g: vec3<u32>) {
  if (g.x < N()) { DBG[g.x] = SIDES[g.x]; }
}
