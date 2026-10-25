// ---- atlas/coarse.wgsl ----------------------------------------------------
// The coarse world (round 71): the whole torus at cn × cn cells (32 world
// units each by default), holding what has changed from the atlas — rock taken
// away or added, loose ground lying on top (ash, rubble, silt), water, the
// sediment it carries, lava — so the world changes at its own scale out of
// sight: a meteor's crater many chunks across, an eruption's ash over a
// country, rivers wearing their valleys. The fine columns are made from the
// atlas and this (compose.wgsl coarseAt); a region seen before gets what
// changed since it was left (coarse.ts).
//   cFlux   per cell: water, lava and loose ground leaving it for each of its
//           four neighbours (heads downhill; loose past its angle of repose)
//   cDepth  per cell: what came in and went out; rain, evaporation, the sea;
//           the water's sediment (it erodes where it runs fast and steep,
//           drops it where it slows); lava cools and sets to basalt; vents
//   cEvent  an event over the grid: a meteor (a crater, its rim, an ejecta
//           blanket), an eruption's ash fall (downwind), a cone rising

struct CCell {
  /** x rock added (+) or taken away (−), y loose ground on top, z water, w sediment the water carries */
  s: vec4<f32>,
  /** x lava, y its temperature, z the loose ground's material, w what added rock is made of */
  l: vec4<f32>,
}

struct CP {
  cn: u32,
  step: u32,
  nVents: u32,
  kind: u32,
  /** world units a cell, and the world (it wraps) */
  cs: f32,
  worldW: f32,
  worldH: f32,
  dt: f32,
  rain: f32,
  evap: f32,
  erode: f32,
  /** an event: where (world), its size, how much, the wind (ash) */
  ex: f32,
  ey: f32,
  er: f32,
  ea: f32,
  wx: f32,
  wy: f32,
  _p0: f32,
  _p1: f32,
  _p2: f32,
  /** vents: x, y (world), lava a step, radius */
  vents: array<vec4<f32>, 8>,
}

@group(0) @binding(0) var<uniform> CQ: CP;
/** per cell: x the atlas's ground (macro, averaged), y 1 where it's the sea (or a lake) */
@group(0) @binding(1) var<storage, read> base: array<vec2<f32>>;
@group(0) @binding(2) var<storage, read> cin: array<CCell>;
@group(0) @binding(3) var<storage, read_write> cout: array<CCell>;
@group(0) @binding(4) var<storage, read_write> fW: array<vec4<f32>>;
@group(0) @binding(5) var<storage, read_write> fL: array<vec4<f32>>;
@group(0) @binding(6) var<storage, read_write> fT: array<vec4<f32>>;

const MAT_RUBBLE_C: u32 = 4u;
const MAT_ASH_C: u32 = 17u;
const MAT_SILT_C: u32 = 22u;
const MAT_BASALT_C: u32 = 23u;
const LAVA_HOT_C: f32 = 1250.0;
const LAVA_SET_C: f32 = 750.0;

fn cidx(i: vec2<i32>) -> u32 {
  let n = i32(CQ.cn);
  let w = ((i % n) + n) % n;
  return u32(w.y) * CQ.cn + u32(w.x);
}
// E, W, N, S (k ^ 1 is the way back)
fn dirOf(k: u32) -> vec2<i32> {
  switch k {
    case 0u: { return vec2<i32>(1, 0); }
    case 1u: { return vec2<i32>(-1, 0); }
    case 2u: { return vec2<i32>(0, 1); }
    default: { return vec2<i32>(0, -1); }
  }
}
fn solidH(i: u32) -> f32 { return base[i].x + cin[i].s.x + cin[i].s.y; }
/** a cell's middle (world) */
fn cellMid(p: vec2<i32>) -> vec2<f32> { return (vec2<f32>(p) + 0.5) * vec2<f32>(CQ.worldW, CQ.worldH) / f32(CQ.cn); }

@compute @workgroup_size(8, 8)
fn cFlux(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= CQ.cn || id.y >= CQ.cn) { return; }
  let p = vec2<i32>(id.xy);
  let i = cidx(p);
  let c = cin[i];
  let g = solidH(i);
  let hw = g + c.s.z;
  let hl = g + c.l.x;
  var w = vec4<f32>(0.0);
  var l = vec4<f32>(0.0);
  var t = vec4<f32>(0.0);
  for (var k = 0u; k < 4u; k++) {
    let j = cidx(p + dirOf(k));
    let gj = solidH(j);
    w[k] = max(hw - (gj + cin[j].s.z), 0.0) * 0.2;
    // (lava is thick: it moves on a head over a cell's worth of yield)
    l[k] = max(hl - (gj + cin[j].l.x) - 0.1, 0.0) * 0.15;
    // (loose ground slumps past about 1 in 2 over a cell)
    t[k] = max(g - gj - 0.5 * CQ.cs, 0.0) * 0.1;
  }
  let sw = w.x + w.y + w.z + w.w;
  if (sw > c.s.z * 0.9) { w *= c.s.z * 0.9 / max(sw, 1e-6); }
  let sl = l.x + l.y + l.z + l.w;
  if (sl > c.l.x * 0.7) { l *= c.l.x * 0.7 / max(sl, 1e-6); }
  let st = t.x + t.y + t.z + t.w;
  if (st > c.s.y * 0.5) { t *= c.s.y * 0.5 / max(st, 1e-6); }
  fW[i] = w;
  fL[i] = l;
  fT[i] = t;
}

@compute @workgroup_size(8, 8)
fn cDepth(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= CQ.cn || id.y >= CQ.cn) { return; }
  let p = vec2<i32>(id.xy);
  let i = cidx(p);
  var c = cin[i];
  let ow = fW[i];
  let ol = fL[i];
  let ot = fT[i];
  let outW = ow.x + ow.y + ow.z + ow.w;
  let outL = ol.x + ol.y + ol.z + ol.w;
  let outT = ot.x + ot.y + ot.z + ot.w;
  var inW = 0.0;
  var inS = 0.0;
  var inL = 0.0;
  var inLT = 0.0;
  var inT = 0.0;
  var inTmat = 0u;
  var inTbest = 0.0;
  var slope = 0.0;
  let g = solidH(i);
  for (var k = 0u; k < 4u; k++) {
    let j = cidx(p + dirOf(k));
    let cj = cin[j];
    let back = k ^ 1u;
    let fw = fW[j][back];
    inW += fw;
    inS += cj.s.w * fw / max(cj.s.z, 1e-4);
    let fl = fL[j][back];
    inL += fl;
    inLT += fl * cj.l.y;
    let ft = fT[j][back];
    inT += ft;
    if (ft > inTbest) {
      inTbest = ft;
      inTmat = u32(cj.l.z);
    }
    slope = max(slope, (g - solidH(j)) / CQ.cs);
  }
  // water, and the sediment going with it (in proportion)
  let w0 = c.s.z;
  let keep = select(1.0 - outW / w0, 1.0, w0 < 1e-5);
  var sed = c.s.w * keep + inS;
  var w = w0 - outW + inW;
  // loose ground slumping
  let loose0 = c.s.y;
  var loose = loose0 - outT + inT;
  if (loose0 < 0.05 && inT > 0.0) { c.l.z = f32(inTmat); }
  // lava, its heat mixing as it runs together
  let l0 = c.l.x;
  var lava = l0 - outL + inL;
  var T = select((c.l.y * (l0 - outL) + inLT) / lava, 0.0, lava < 1e-5);
  // rain and evaporation
  if (base[i].y < 0.5) { w += CQ.rain * CQ.dt; }
  w = max(w - CQ.evap * CQ.dt, 0.0);
  // the water wears the ground where it runs fast and steep, drops what it carries where it slows
  if (CQ.erode > 0.0 && w > 0.01) {
    let speed = (outW + inW) * 0.5 / max(w, 0.05);
    let cap = CQ.erode * speed * clamp(slope, 0.0, 1.0) * w;
    if (sed < cap) {
      var e = (cap - sed) * 0.2;
      let fromLoose = min(e, loose);
      loose -= fromLoose;
      e -= fromLoose;
      // (rock wears slower than loose ground)
      c.s.x -= e * 0.25;
      sed += fromLoose + e * 0.25;
    } else {
      let d = (sed - cap) * 0.3;
      if (loose < 0.05) { c.l.z = f32(MAT_SILT_C); }
      loose += d;
      sed -= d;
    }
  }
  // lava cools (thin lava fastest) and sets to basalt; vents pour
  for (var v = 0u; v < CQ.nVents; v++) {
    let vv = CQ.vents[v];
    let cp = cellMid(p);
    var d = cp - vv.xy;
    d -= round(d / vec2<f32>(CQ.worldW, CQ.worldH)) * vec2<f32>(CQ.worldW, CQ.worldH);
    if (length(d) < vv.w) {
      T = (T * lava + LAVA_HOT_C * vv.z) / (lava + vv.z);
      lava += vv.z;
    }
  }
  if (lava > 1e-4) {
    T -= CQ.dt * 3.0 / max(lava, 0.3);
    if (T < LAVA_SET_C || base[i].y > 0.5) {
      c.s.x += lava;
      c.l.w = f32(MAT_BASALT_C);
      lava = 0.0;
      T = 0.0;
    }
  }
  // the sea takes what reaches it
  if (base[i].y > 0.5) {
    w = 0.0;
    sed = 0.0;
  }
  c.s = vec4<f32>(c.s.x, max(loose, 0.0), max(w, 0.0), max(sed, 0.0));
  c.l = vec4<f32>(max(lava, 0.0), T, c.l.z, c.l.w);
  if (c.s.y < 0.01) { c.l.z = 0.0; }
  cout[i] = c;
}

/** an event (CQ.kind: 1 meteor, 2 ash fall, 3 a cone), in place (cin and cout the same buffer here: binding 3) */
@compute @workgroup_size(8, 8)
fn cEvent(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= CQ.cn || id.y >= CQ.cn) { return; }
  let p = vec2<i32>(id.xy);
  let i = cidx(p);
  var c = cout[i];
  let W = vec2<f32>(CQ.worldW, CQ.worldH);
  var d = cellMid(p) - vec2<f32>(CQ.ex, CQ.ey);
  d -= round(d / W) * W;
  let r = length(d);
  let R = CQ.er;
  let D = CQ.ea;
  if (CQ.kind == 1u) {
    // the bowl, its raised rim, the ejecta thinning outward (rubble)
    if (r < R) { c.s.x -= D * (1.0 - (r / R) * (r / R)); }
    c.s.x += D * 0.22 * exp(-pow((r - R) / (0.25 * R), 2.0));
    if (r > 0.85 * R && r < 3.0 * R) {
      let ej = D * 0.12 * pow(R / max(r, R), 3.0);
      if (c.s.y < 0.05 || u32(c.l.z) != MAT_ASH_C) { c.l.z = f32(MAT_RUBBLE_C); }
      c.s.y += ej;
    }
    // (what was in the bowl is thrown out)
    if (r < R) {
      c.s.y *= r / R;
      c.s.z = 0.0;
      c.l.x = 0.0;
    }
  } else if (CQ.kind == 2u) {
    // ash: thickest near, carried downwind (a plume, a gaussian along the wind and across it)
    let wl = length(vec2<f32>(CQ.wx, CQ.wy));
    let wd = select(vec2<f32>(1.0, 0.0), vec2<f32>(CQ.wx, CQ.wy) / wl, wl > 1e-3);
    let along = dot(d, wd) - R * 0.6;
    let across = dot(d, vec2<f32>(-wd.y, wd.x));
    let a = D * exp(-(along * along) / (R * R * 1.6) - (across * across) / (R * R * 0.35));
    if (a > 0.01) {
      c.s.y += a;
      c.l.z = f32(MAT_ASH_C);
    }
  } else if (CQ.kind == 3u) {
    let k = max(1.0 - r / R, 0.0);
    if (k > 0.0) {
      c.s.x += D * k * k;
      c.l.w = f32(MAT_BASALT_C);
    }
  }
  cout[i] = c;
}
