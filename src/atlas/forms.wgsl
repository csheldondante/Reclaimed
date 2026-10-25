// ---- atlas/forms.wgsl -----------------------------------------------------
// What stands on the ground and what's cut into it (round 69): each region
// has up to two forms (compose.wgsl Form, regions.ts FormDef), of four kinds:
//  SPIRE    a solid of revolution on a jittered lattice: a profile up its
//           height (cone, column, a cap on a neck, bulb, hourglass, tiers, a
//           tilted top, a needle), a cross-section that's round, lobed (n
//           lobes) or a regular polygon, twisting as it rises, its axis bending
//           over as it climbs, hollow or not, a second material for its cap —
//           spires, pillars, towers, hoodoos, crystals, buttes, seracs;
//  ARCH     half an ellipse of rock standing on the ground, across a random way;
//  NETWORK  tubes along a network of lines over the region (a noise's zero set
//           that meanders, or the edges of a cellular noise that branch): with
//           no wall they're tunnels under the ground, open to the sky in
//           places (skylights), holding water or lava; with a wall they're
//           hollow vessels arching in and out of the ground;
//  ALCOVE   caves cut into a cliff's face: on the high side of a border that
//           drops away, openings into the wall in bands.
// formSeed places the lattice forms of a batch (and a margin) once; colFinish
// marches each column up through the ground, the caves and the forms as
// signed values (> 0 solid), so a surface between two samples lies where the
// value crosses zero (fractional heights, as the world keeps them), and writes
// the column's runs of material.

const FORM_SPIRE: u32 = 1u;
const FORM_ARCH: u32 = 2u;
const FORM_NETWORK: u32 = 3u;
const FORM_ALCOVE: u32 = 4u;

const PROF_CONE: u32 = 0u;
const PROF_COLUMN: u32 = 1u;
const PROF_CAP: u32 = 2u;
const PROF_BULB: u32 = 3u;
const PROF_HOURGLASS: u32 = 4u;
const PROF_TIERS: u32 = 5u;
const PROF_TILTED: u32 = 6u;
const PROF_NEEDLE: u32 = 7u;
/** (round 75: the giants) a prism to its point, its axis straight (it leans the same all the way up) */
const PROF_PRISM: u32 = 8u;

const MAT_SAND: u32 = 3u;
const MAT_WATER: u32 = 8u;
const MAT_SILT: u32 = 22u;
const MAT_LAVA: u32 = 24u;
const MAT_SNOW: u32 = 25u;
const MAT_BASALT_F: u32 = 23u;
/** a river's springs: water a tick at the middle of its channel (what comes down from upstream) */
const RIVER_SPRING: f32 = 0.0008;

/** world units around a batch whose lattice forms are placed (regions.ts FORM_REACH: no form reaches further) */
const MARGIN: f32 = 48.0;
const MAX_INST: u32 = 8192u;
/** forms a column considers, and runs it can hold */
const LI: u32 = 16u;
const MR: u32 = 24u;

/** the lattices forms are placed on (world units between them; regions.ts FORM_SPACINGS) */
fn spacingOf(i: u32) -> f32 {
  switch i {
    case 0u: { return 4.0; }
    case 1u: { return 6.0; }
    case 2u: { return 8.0; }
    case 3u: { return 12.0; }
    case 4u: { return 16.0; }
    case 5u: { return 24.0; }
    default: { return 32.0; }
  }
}

struct Inst {
  c: vec2<f32>,
  zb: f32,
  H: f32,
  r: f32,
  twist: f32,
  /** a spire's top offset a unit of height (its axis bends over as t²); a tilted top's slope */
  lean: vec2<f32>,
  kind: u32,
  pk: u32,
  lobeAmp: f32,
  shell: f32,
  ang: f32,
  reach: f32,
  top: f32,
  _p: f32,
}

/** per column: its surface, cover, materials (top | rock << 8), water, moisture, plants, lava, region, kind, runs, flags, the ground's own top */
struct ColOut {
  top: f32,
  cover: f32,
  mats: u32,
  water: f32,
  moisture: f32,
  veg: f32,
  lava: f32,
  region: u32,
  kind: u32,
  n: u32,
  /** 1: more forms near it than a column considers, 2: more runs than it holds */
  flags: u32,
  ground: f32,
  /** water a tick from a spring (a river's: what flows in from upstream) */
  spring: f32,
  _p0: f32,
  _p1: f32,
  _p2: f32,
}

@group(0) @binding(31) var<storage, read_write> colOut: array<ColOut>;
@group(0) @binding(32) var<storage, read_write> insts: array<Inst>;
@group(0) @binding(33) var<storage, read_write> instN: array<atomic<u32>>;
/** MR runs a column: z0 and z1 in 1/256 of a cell, the material in z1's top byte, z0's top bit set for a form's run */
@group(0) @binding(34) var<storage, read_write> colRuns: array<vec2<u32>>;
fn zq(z: f32) -> u32 { return u32(round(clamp(z, 0.0, 65535.0) * 256.0)); }

/** a world cell's centre, not wrapped (the batch's frame: forms and columns measured in it) */
fn cellU(x: i32, y: i32) -> vec2<f32> {
  return vec2<f32>(f32(x) + 0.5 + 0.5 * f32(y & 1), (f32(y) + 0.5) * ROW_H_A);
}

fn formOf(R: Region, k: u32) -> Form {
  if (k == 0u) { return R.f0; }
  return R.f1;
}

@compute @workgroup_size(8, 8, 1)
fn formSeed(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.z >= 7u) { return; }
  let S = spacingOf(id.z);
  let N = perOf(S);
  let cs = vec2<f32>(AP.worldW, AP.worldH) / f32(N);
  let bLo = vec2<f32>(f32(AP.x0), f32(AP.y0) * ROW_H_A);
  let bHi = vec2<f32>(f32(AP.x0 + i32(AP.w)) + 1.0, f32(AP.y0 + i32(AP.h)) * ROW_H_A);
  let c = vec2<i32>(floor((bLo - MARGIN) / cs)) + vec2<i32>(id.xy);
  if (any(vec2<f32>(c) * cs > bHi + MARGIN)) { return; }
  let cw = wrapi(c, vec2<i32>(N));
  let h0 = hash2u(cw.x, cw.y, AP.seed + 900u + id.z * 7u);
  let ctr = (vec2<f32>(c) + 0.1 + 0.8 * vec2<f32>(hf(h0), hf(pcg(h0)))) * cs;
  // the region there, as ground() finds it
  let u = torusU(ctr);
  let wq = vec2<f32>(pfbm(u, perOf(48.0), 3u, AP.seed + 21u), pfbm(u, perOf(48.0), 3u, AP.seed + 22u));
  let R = regs[macroAt(ctr + wq * AP.warpCell).a];
  for (var k = 0u; k < 2u; k++) {
    let f = formOf(R, k);
    if ((f.kind != FORM_SPIRE && f.kind != FORM_ARCH) || abs(f.spacing - S) > 0.01) { continue; }
    let hh = pcg(h0 ^ (R.seed + k * 7919u));
    // (spires clump: zOff is how much a coarser noise gathers them)
    var ch = f.chance;
    if (f.kind == FORM_SPIRE) { ch *= clamp(1.0 + f.zOff * pfbm(u, perOf(S * 5.0), 2u, R.seed + k), 0.0, 2.5); }
    if (hf(hh) >= ch) { continue; }
    let r1 = hf(pcg(hh + 1u));
    let r2 = hf(pcg(hh + 2u));
    let r3 = hf(pcg(hh + 3u));
    let r4 = hf(pcg(hh + 4u));
    let r5 = hf(pcg(hh + 5u));
    let r6 = hf(pcg(hh + 6u));
    let g = ground(ctr);
    var I: Inst;
    I.c = ctr;
    I.kind = f.kind;
    I.pk = f.pk;
    I.H = mix(f.hLo, f.hHi, r1);
    I.r = f.radius * (0.75 + 0.5 * r2);
    let la = 6.2831853 * r3;
    I.lean = vec2<f32>(cos(la), sin(la)) * f.lean * (0.4 + 0.6 * r4);
    I.twist = f.twist * select(-1.0, 1.0, r5 < 0.5);
    I.ang = 6.2831853 * r6;
    I.lobeAmp = f.lobeAmp;
    I.shell = f.shell;
    let prof = (f.pk >> 16u) & 0xffu;
    if (f.kind == FORM_SPIRE) {
      I.zb = g.h - 2.0;
      I.top = I.zb + I.H;
      I.reach = I.r * 1.7 + 1.0;
      if (prof == PROF_TILTED) {
        I.top += length(I.lean) * I.r * 1.7 * I.H / max(I.r, 1.0);
      } else {
        I.reach += length(I.lean) * I.H;
      }
    } else {
      I.zb = g.h - 1.5;
      I.top = I.zb + I.H + I.shell;
      I.reach = I.r + I.shell + 1.0;
    }
    if (any(ctr + I.reach < bLo) || any(ctr - I.reach > bHi)) { continue; }
    let at = atomicAdd(&instN[0], 1u);
    if (at < MAX_INST) { insts[at] = I; }
  }
}

/** a spire's radius a unit of its own (at its base) up its height t ∈ [0, 1] */
fn profileAt(prof: u32, t: f32) -> f32 {
  switch prof {
    case PROF_CONE: { return 1.0 - 0.88 * t; }
    case PROF_COLUMN, PROF_TILTED: { return 1.0 - 0.12 * t; }
    case PROF_CAP: { return mix(0.55 + 0.08 * t, 1.45, smoothstep(0.7, 0.8, t)); }
    case PROF_BULB: { return 0.12 + 1.05 * sin(3.14159265 * pow(t, 0.75)); }
    case PROF_HOURGLASS: { return 0.42 + 0.58 * abs(2.0 * t - 1.0); }
    case PROF_TIERS: { return 1.0 - 0.72 * floor(t * 4.0) / 4.0; }
    case PROF_PRISM: { return min(1.0, (1.0 - t) / 0.16); }
    default: { return pow(1.0 - t, 1.35); }
  }
}

struct FormV {
  v: f32,
  mat: u32,
}

/** an instance's value at (p, z): > 0 inside it */
fn instAt(I: Inst, p: vec2<f32>, z: f32) -> FormV {
  let mat = I.pk & 0xffu;
  let mat2 = (I.pk >> 8u) & 0xffu;
  let prof = (I.pk >> 16u) & 0xffu;
  let lobes = (I.pk >> 24u) & 0xffu;
  var o: FormV;
  o.mat = mat;
  if (I.kind == FORM_ARCH) {
    // half an ellipse (span 2r, height H) in the plane across `ang`, a tube of radius `shell` along it
    let d = p - I.c;
    let a = vec2<f32>(cos(I.ang), sin(I.ang));
    let along = dot(d, a);
    let across = dot(d, vec2<f32>(-a.y, a.x));
    let e = length(vec2<f32>(along / I.r, (z - I.zb) / I.H));
    let off = (e - 1.0) * min(I.r, I.H);
    o.v = min(I.shell - length(vec2<f32>(off, across)), z - I.zb + 3.0);
    return o;
  }
  let t = clamp((z - I.zb) / I.H, 0.0, 1.0);
  var axis = I.c;
  var topZ = I.zb + I.H;
  if (prof == PROF_TILTED) {
    topZ += dot(I.lean, p - I.c) * I.H / max(I.r, 1.0);
  } else if (prof == PROF_PRISM) {
    // (straight: lean is the offset a cell up; the top is where the point is, along the axis)
    axis += I.lean * max(z - I.zb, 0.0);
  } else {
    axis += I.lean * I.H * t * t;
  }
  let d = p - axis;
  let dist = length(d);
  var rm = 1.0;
  if (lobes >= 3u) {
    let th = atan2(d.y, d.x) - I.twist * (z - I.zb) - I.ang;
    let n = f32(lobes);
    if (I.lobeAmp < 0.0) {
      // a regular polygon (its inradius r)
      let k = 6.2831853 / n;
      let a = th - k * floor(th / k) - k * 0.5;
      rm = cos(3.14159265 / n) / cos(a);
    } else {
      rm = 1.0 + I.lobeAmp * cos(n * th);
    }
  }
  let rad = I.r * profileAt(prof, t) * rm;
  o.v = min(rad - dist, topZ - z);
  if (I.shell > 0.0) {
    // hollow above its foot, open at the top
    o.v = min(o.v, max(dist - (rad - I.shell), I.zb + 3.0 - z));
  }
  if (mat2 != 0u && t > select(0.85, 0.74, prof == PROF_CAP)) { o.mat = mat2; }
  return o;
}

/** a network's tubes at a column: the horizontal distance to the nearest line, its centre height, radius */
struct Net {
  on: bool,
  d: f32,
  zc: f32,
  r: f32,
  shell: f32,
  sky: bool,
  mat: u32,
  liquid: u32,
}

fn netAt(f: Form, R: Region, k: u32, p: vec2<f32>, ground: f32, wgt: f32) -> Net {
  var n: Net;
  n.on = false;
  let u = torusU(p);
  let s = R.seed + 31u * k;
  let per = perOf(f.spacing);
  var d = 1e9;
  if (((f.pk >> 16u) & 0xffu) == 1u) {
    // cellular: the edges between cells (branching)
    let w = pworley(u * f32(per), vec2<i32>(per), 0.9, s);
    d = 0.5 * (w.f2 - w.f1) * AP.worldW / f32(per);
  } else {
    // a noise's zero set (meandering): |n| / |∇n|
    let e = 0.75;
    let n0 = pfbm(u, per, 2u, s);
    let nx = pfbm(torusU(p + vec2<f32>(e, 0.0)), per, 2u, s);
    let ny = pfbm(torusU(p + vec2<f32>(0.0, e)), per, 2u, s);
    let gl = length(vec2<f32>(nx - n0, ny - n0)) / e;
    d = abs(n0) / max(gl, 1e-5);
  }
  // (the tubes narrow to nothing at the region's edge)
  let r = f.radius * (0.8 + 0.4 * pfbm(u, perOf(f.spacing * 0.5), 2u, s + 3u)) * smoothstep(0.25, 0.75, wgt);
  if (d >= r + 1.0) { return n; }
  n.on = true;
  n.d = d;
  n.r = r;
  n.shell = f.shell;
  // (rock under it always: where the ground is low — a crater's floor — the tubes rise with it)
  n.zc = max(ground + f.zOff + f.hHi * pfbm(u, perOf(f.spacing * 1.5), 2u, s + 5u), r + 2.0);
  n.mat = f.pk & 0xffu;
  n.liquid = (f.pk >> 8u) & 0xffu;
  // skylights: where a coarser noise is high, the roof over a tunnel is open
  n.sky = f.shell == 0.0 && pfbm(u, perOf(f.spacing * 0.8), 2u, s + 9u) > 0.5 - f.chance && d < r * 0.85;
  return n;
}

@compute @workgroup_size(8, 8)
fn colFinish(@builtin(global_invocation_id) gid: vec3<u32>) {
  // (round 80: a tile of the batch at a time, a frame apart, when streaming)
  let id = vec3<u32>(gid.x + u32(AP.tileX), gid.y + u32(AP.tileY), gid.z);
  if (id.x >= AP.w || id.y >= AP.h) { return; }
  let mw = AP.w + 2u;
  let x = AP.x0 + i32(id.x);
  let y = AP.y0 + i32(id.y);
  let rows = i32(round(AP.worldH / ROW_H_A));
  let odd = ((((y % rows) + rows) % rows) & 1) == 1;
  let g = colG[(id.y + 1u) * mw + id.x + 1u];
  let p = cellU(x, y);
  // the slope: the steepest step to a neighbour (odd-r offsets, lattice.ts)
  var dxs = array<i32, 6>(1, -1, 0, -1, -1, 0);
  var dys = array<i32, 6>(0, 0, 1, -1, 1, -1);
  if (odd) { dxs = array<i32, 6>(1, -1, 1, 0, 0, 1); }
  var slope = 0.0;
  for (var k = 0; k < 6; k++) {
    let n = colG[u32(i32(id.y) + 1 + dys[k]) * mw + u32(i32(id.x) + 1 + dxs[k])];
    slope = max(slope, abs(n.h - g.h));
  }
  // whose ground this is (dithered across a blend)
  let hsh = hf(hash2u(x, y, AP.seed + 71u));
  var ri = g.b;
  if (g.w + (hsh - 0.5) * 0.3 > 0.5) { ri = g.a; }
  let R = regs[ri];
  let wgt = select(1.0 - g.w, g.w, ri == g.a);
  let top = g.h;
  let wet = top < AP.sea + 1.2;
  let snowy = temperature(p, top) < 0.0;
  var cover = max(R.cover - slope * 0.5, 0.0);
  var topMat = R.topMat;
  if (slope > 1.6) {
    cover = 0.0;
  } else if (wet) {
    cover = 1.5;
    topMat = select(MAT_SAND, MAT_SILT, R.topMat == MAT_SILT);
  } else if (snowy) {
    cover = 0.8;
    topMat = MAT_SNOW;
  }
  // (only the peaks: at 0.7 the kaleido's domes were carpeted in crystal)
  if (R.accent != 0u && g.a == ri && g.pv > 0.9 && !wet) {
    topMat = R.accent;
    cover = max(cover, 1.0);
  }
  // a river's bed: sand and silt under water, the lava's own rock under lava
  let river = g.rx < 1.0;
  let lavaR = river && g.rflags == 1u;
  if (river) {
    if (lavaR) {
      topMat = MAT_BASALT_F;
      cover = 0.0;
    } else {
      topMat = select(MAT_SAND, MAT_SILT, g.rx < 0.5);
      cover = max(cover, 1.0);
    }
  }
  // set lava, a cone: the rock added is basalt at the top
  if (g.cap != 0u && !river) {
    topMat = g.cap;
    cover = 0.0;
  }
  // an oddity (round 78): a crystal or a dome of its own stuff, bare
  var rockMat = R.rockMat;
  if (g.smat != 0u && !river) {
    topMat = g.smat;
    rockMat = g.smat;
    cover = 0.0;
  }
  cover = min(cover, top - 1.0);
  let rockTop = top - cover;
  // the coarse world's loose ground over all of it (ash, a crater's rubble, silt)
  let lz = select(0.0, g.loose, g.loose > 0.05 && g.lmat != 0u);
  let topL = top + lz;
  var flags = 0u;

  // ---- what could be here: the lattice forms near, the network, the alcoves --
  var li: array<u32, 16>;
  var nl = 0u;
  var zEnd = topL;
  let ni = min(atomicLoad(&instN[0]), MAX_INST);
  for (var i = 0u; i < ni; i++) {
    let I = insts[i];
    let d = p - I.c;
    if (dot(d, d) >= I.reach * I.reach) { continue; }
    if (nl == LI) {
      flags |= 1u;
      break;
    }
    li[nl] = i;
    nl++;
    zEnd = max(zEnd, I.top);
  }
  var net: Net;
  net.on = false;
  var alc = false;
  var af: Form;
  for (var k = 0u; k < 2u; k++) {
    let f = formOf(R, k);
    if (f.kind == FORM_NETWORK && !net.on) {
      net = netAt(f, R, k, p, top, wgt);
      if (net.on) { zEnd = max(zEnd, net.zc + net.r); }
    }
    // alcoves: on the high side of a border that drops away
    if (f.kind == FORM_ALCOVE && top - g.hlo > 8.0 && abs(g.s) < f.radius) {
      alc = true;
      af = f;
    }
  }
  // the caves (as before: under the rock kept over them)
  let zLoC = 3.0;
  let zHiC = rockTop - AP.caveDepth;
  let per = perOf(AP.caveScale);
  let q = torusU(p) * f32(per);
  let perB = max(1, per / 3);
  let qb = torusU(p) * f32(perB);
  let alcPer = perOf(af.spacing);

  // ---- the march: samples a cell apart, surfaces where the value crosses zero --
  zEnd = min(zEnd, AP.zTop) + 1.0;
  var runs = 0u;
  let base = (id.y * AP.w + id.x) * MR;
  var zs = 0.0;
  var L = 0u;
  var pF = 0.0;
  var pM = 0.0;
  var pForm = false;
  var caveRuns = 0u;
  var inCave = false;
  var alcRuns = 0u;
  var formRuns = 0u;
  var inAlc = false;
  var surf = 0.0;
  var surfForm = false;
  let K = i32(ceil(zEnd));
  for (var k = 0; k <= K; k++) {
    let z = f32(k);
    var carve = -1e9;
    // caves: two at most in a column (each two cells or more), as before
    if (R.cave > 0.0 && z >= zLoC && z < zHiC && (caveRuns < 2u || inCave)) {
      let c = caveField(q, qb, per, perB, z, R.cave);
      if (c > 0.0 && !inCave) { inCave = true; }
      if (c <= 0.0 && inCave) {
        inCave = false;
        caveRuns++;
      }
      carve = max(carve, c);
    }
    // a great cavern (round 78)
    if (z > g.cf && z < g.cr) { carve = max(carve, min(z - g.cf, g.cr - z)); }
    var add = -1e9;
    var addMat = 0u;
    if (net.on) {
      let rr = length(vec2<f32>(net.d, z - net.zc));
      carve = max(carve, (net.r - net.shell) - rr);
      if (net.shell > 0.0) {
        let wall = min(net.r - rr, rr - (net.r - net.shell));
        if (wall > add) {
          add = wall;
          addMat = net.mat;
        }
      }
      if (net.sky && z > net.zc) { carve = max(carve, net.r * 0.85 - net.d); }
    }
    // (six openings a column at most: a tall wall's would run past what a column holds)
    var alcOpen = false;
    if (alc && z > g.hlo + 1.5 && z < top - 3.0 && (alcRuns < 6u || inAlc)) {
      let n3 = vfbm3(vec3<f32>(torusU(p) * f32(alcPer), z / max(af.hHi, 1.0)), vec2<i32>(alcPer), 2u, R.seed + 77u);
      let open = n3 - (0.5 - af.chance);
      let depth = af.radius * (0.4 + 0.6 * clamp(open * 4.0, 0.0, 1.0));
      let c = min(open * 6.0, depth - abs(g.s));
      alcOpen = c > 0.0;
      if (c > 0.0) { inAlc = true; } else if (inAlc) {
        inAlc = false;
        alcRuns++;
      }
      carve = max(carve, c);
    }
    // (round 78: none in an alcove, a great cavern's or an overhang's open — a crystal field's forms filled
    // a mesa's six alcoves, a band each, past what a column holds)
    let inOpen = alcOpen || (z > g.cf && z < g.cr);
    for (var j = 0u; j < nl && !inOpen; j++) {
      let fv = instAt(insts[li[j]], p, z);
      if (fv.v > add) {
        add = fv.v;
        addMat = fv.mat;
      }
    }
    // (nothing carves the world's floor: every column keeps its first cell)
    if (z < 1.0) { carve = -1e9; }
    let bc = min(topL - z, -carve);
    var F = max(bc, add);
    if (z >= AP.zTop) { F = min(F, AP.zTop - z); }
    // (four forms' runs a column at most, as the caves are two and the alcoves six: past them a form isn't
    // there — crystal clusters lining a tall cliff's caves and alcoves ran past what a column holds)
    var form = add >= bc;
    if (form && !pForm && k > 0) {
      if (formRuns >= 4u) {
        form = false;
        F = bc;
        if (z >= AP.zTop) { F = min(F, AP.zTop - z); }
      } else {
        formRuns++;
      }
    }
    var lab = 0u;
    if (F > 0.0) {
      if (form) { lab = addMat; } else if (z >= top) { lab = g.lmat; } else { lab = select(topMat, rockMat, z < rockTop); }
    }
    if (k > 0 && lab != L) {
      // where between the samples it changed
      var zb = z - 0.5;
      if ((L == 0u) != (lab == 0u)) {
        zb = z - 1.0 + pF / (pF - F);
      } else if (form != pForm) {
        let M = add - bc;
        zb = z - 1.0 + pM / (pM - M);
      } else if (!form) {
        // (the ground's own top under the loose, or the cover's bottom)
        if (lz > 0.0 && top > z - 1.0 && top <= z) { zb = top; } else { zb = clamp(rockTop, z - 1.0, z); }
      }
      if (L != 0u && zb - zs > 0.05) {
        if (runs < MR) {
          colRuns[base + runs] = vec2<u32>((zq(zs) & 0x7fffffffu) | select(0u, 1u << 31u, pForm), (zq(zb) & 0xffffffu) | (L << 24u));
          runs++;
          surf = zb;
          surfForm = pForm;
        } else {
          flags |= 2u;
        }
      }
      zs = zb;
    }
    L = lab;
    pF = F;
    pM = add - bc;
    pForm = form;
  }

  var o: ColOut;
  o.top = surf;
  o.ground = top;
  o.cover = cover;
  o.mats = topMat | (rockMat << 8u);
  o.n = runs;
  o.flags = flags;
  o.region = ri;
  o.kind = R.kind;
  o.water = 0.0;
  o.lava = 0.0;
  // the open ground (not a form's top, not a hole in it): below the sea, water
  let open = !surfForm && abs(surf - topL) < 0.01;
  if (open) { o.water = max(max(AP.sea - topL, 0.0), g.cw); }
  // the coarse world's lava, where it's still running
  if (open && g.clava > 0.05) { o.lava = g.clava; }
  // a skylight onto a tube: its water or lava, a little below the tube's middle
  if (net.on && net.sky && surf < net.zc && !surfForm) {
    let depth = max(net.zc - net.r * 0.3 - surf, 0.0);
    if (net.liquid == MAT_LAVA) { o.lava = depth; } else if (net.liquid == MAT_WATER) { o.water = max(o.water, depth); }
  }
  // a river: filled to its level, fed along its middle; lava kept molten by its springs
  o.spring = 0.0;
  if (river && open) {
    if (lavaR) {
      // (fed along its middle only: springs to its banks flooded the land round a fall's foot)
      if (g.rx < 0.5) { o.lava = max(g.rl - surf, 0.6); }
    } else {
      o.water = max(o.water, g.rl - 0.3 - surf);
      if (g.rx < 0.6) { o.spring = RIVER_SPRING; }
    }
  }
  var m = moistureAt(p, g.coast, R.moist);
  if (wet || (river && !lavaR)) { m = max(m, 0.8); }
  o.moisture = m;
  o.veg = 0.0;
  if (o.water == 0.0 && o.lava == 0.0 && !snowy && R.veg > 0.0 && surf < AP.sea + 70.0) {
    let woods = smoothstep(0.05, 0.35, pfbm(torusU(p), perOf(55.0), 3u, AP.seed + 6u)) * smoothstep(AP.sea + 60.0, AP.sea + 20.0, surf);
    let v = clamp(R.veg * (1.0 + m * 1.6 + woods * 2.2) + (hf(hash2u(x, y, AP.seed + 7u)) - 0.5) * 0.6, 0.0, 4.2);
    if (open && (o.cover > 0.0 || lz > 0.0)) { o.veg = v; } else if (surfForm) { o.veg = v * 0.35; }
    // (buried: under half a cell of ash or rubble nothing's left; thinner, it thins)
    o.veg *= clamp(1.0 - lz * 2.0, 0.0, 1.0);
  }
  colOut[id.y * AP.w + id.x] = o;
}
