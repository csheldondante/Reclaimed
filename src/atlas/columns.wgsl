// ---- atlas/columns.wgsl ---------------------------------------------------
// Columns for the streamer from the atlas (round 67): a batch of w × h world
// cells from (AP.x0, AP.y0), wrapped round the torus.
//  colHeight  the ground (compose.wgsl) of the batch and a margin of one
//  caves      layers of tunnels and chambers as intervals (caveVoids,
//             round 80): the viewer's map of them, forms.wgsl's columns
// Each column's finish and solid (what lies on it, what stands on it, what's
// cut out of it) is forms.wgsl's colFinish.

struct ColG {
  h: f32,
  w: f32,
  coast: f32,
  pv: f32,
  a: u32,
  b: u32,
  /** the border: distance (signed towards a), the lower side's height */
  s: f32,
  hlo: f32,
  /** a river: its level (−1: none), distance from its line in half-widths, 1 lava */
  rl: f32,
  rx: f32,
  rflags: u32,
  /** the coarse world: loose ground's material, its depth, water, lava, what added rock is */
  lmat: u32,
  loose: f32,
  cw: f32,
  clava: f32,
  cap: u32,
  /** a great cavern under it (round 78, compose.wgsl cavernAt): floor, roof (none when roof ≤ floor) */
  cf: f32,
  cr: f32,
  /** an oddity's material (compose.wgsl Ground.smat) */
  smat: u32,
  /** (round 84) a river's flow at the reference wetness (cells a tick) and its depth at the line (atlas.ts COLG_BYTES) */
  rvx: f32,
  rvy: f32,
  rd: f32,
  /** (round 90) a lake's level here (0: none) and 1 where its water may stand (compose.wgsl Ground.lk, lkw) */
  lk: f32,
  lkw: f32,
}

@group(0) @binding(30) var<storage, read_write> colG: array<ColG>;

/** the world cell (x, y) wrapped, and its centre */
fn cellW(x: i32, y: i32) -> vec2<f32> {
  let cols = i32(round(AP.worldW));
  let rows = i32(round(AP.worldH / ROW_H_A));
  let w = wrapi(vec2<i32>(x, y), vec2<i32>(cols, rows));
  return vec2<f32>(f32(w.x) + 0.5 + 0.5 * f32(w.y & 1), (f32(w.y) + 0.5) * ROW_H_A);
}

@compute @workgroup_size(8, 8)
fn colHeight(@builtin(global_invocation_id) id: vec3<u32>) {
  let mw = AP.w + 2u;
  if (id.x >= mw || id.y >= AP.h + 2u) { return; }
  let p = cellW(AP.x0 - 1 + i32(id.x), AP.y0 - 1 + i32(id.y));
  let g = ground(p);
  var cav = cavernAt(p, g);
  var h = g.h;
  var loose = g.loose;
  // a mesa's overhang (round 78): the lip raises the column, the open under it carved as a cavern's is
  // (under a lip, the talus there is the open's floor: what's loose lies on a column's top)
  if (cav.y <= cav.x && g.ov.z > g.ov.y) {
    cav = g.ov.yz;
    if (g.ov.x > h) {
      cav.x += loose;
      loose = 0.0;
      h = g.ov.x;
    }
  }
  // (round 84, ?rivers=table — the user: "the generator make things start in steady state"): a water river's banks
  // stand at least a little over its level, so what it holds stays in its channel — where the ground beside it lies
  // lower (the river's level is the filled ground's: it crosses hollows) up to RIVER_LEVEE under it, a levee
  // (round 90: not in a lake — its water stands over the river's banks)
  if (RIVER_TABLE && g.rflags == 0u && g.rl > 0.0 && g.rx >= 0.95 && g.rx < 1.9 && h < g.rl + 0.2 && h > g.rl - RIVER_LEVEE && !g.lkw) {
    h = g.rl + 0.2 * smoothstep(1.9, 1.3, g.rx);
  }
  colG[id.y * mw + id.x] = ColG(h, g.w, g.coast, g.pv, g.a, g.b, g.s, g.hlo, g.rl, g.rx, g.rflags, g.lmat, loose, g.cw, g.clava, g.cap, cav.x, cav.y, g.smat, g.rvel.x, g.rvel.y, g.rd, g.lk, select(0.0, 1.0, g.lkw));
}

// (round 84) RIVER_LEVEE: the deepest hollow beside a river its bank is raised over (columns more below it are left: a
// lake's) — (round 110) from world/rivertable.ts, the atlas's prefix (atlas.ts parts())

/** a cave noise's height scale: its scale at caveScale 40, grown with it (round 79: bigger caves both ways) */
fn caveZ(z40: f32) -> f32 { return z40 * AP.caveScale / 40.0; }

/**
 * The caves under a column as intervals (round 80, the user: "Do we need to walk every cell of the column? …
 * 2d noise with two thresholds … then vary the height of those caves with noise and optionally have layers
 * for more 3D caves"): up to three layers, each a network of tunnels (where a noise is near zero: winding,
 * like rivers underground) and chambers (where another is high, domed by how far in), its floor between the
 * sea and the ground swelling with a slow noise, its roof under the rock kept over the caves (caveDepth); a
 * shaft joins a layer to the one under it where a third noise says. No walk up the column: a few 2D noises
 * a layer. (They were three 3D noises at every cell of height — most of a streamed region's cost.)
 */
struct CaveVoids {
  n: u32,
  v: array<vec2<f32>, 4>,
}

fn caveVoids(p: vec2<f32>, top: f32, r: Region) -> CaveVoids {
  var o: CaveVoids;
  o.n = 0u;
  if (r.cave <= 0.0) { return o; }
  let u = torusU(p);
  let roofMax = top - AP.caveDepth;
  if (roofMax < AP.sea - 30.0) { return o; }
  let sc = AP.caveScale;
  let t = 0.03 + 0.035 * r.cave;
  var below = vec2<f32>(0.0);
  for (var k = 0u; k < 3u; k++) {
    let fk = f32(k);
    let s = AP.seed + 61u + k * 17u;
    let tun = 1.0 - smoothstep(t * 0.55, t, abs(pfbm(u, perOf(sc * (1.0 + 0.35 * fk)), 2u, s)));
    let ch = smoothstep(0.4 - 0.05 * r.cave, 0.56 - 0.05 * r.cave, pfbm(u, perOf(sc * 1.6), 2u, s + 5u));
    let open = max(tun, ch);
    if (open <= 0.02) {
      below = vec2<f32>(0.0);
      continue;
    }
    // (the floor a share of the way from the sea's level to the rock kept over the caves, deeper layers lower)
    let span = max(roofMax - (AP.sea - 24.0), 0.0);
    let fl = AP.sea - 24.0 + span * (0.18 + 0.27 * fk) + 7.0 * pfbm(u, perOf(sc * 0.8), 2u, s + 9u);
    let h = open * (2.5 + 2.0 * tun) + ch * ch * (7.0 + 12.0 * r.cave) * (0.7 + 0.3 * pfbm(u, perOf(sc * 0.5), 2u, s + 7u));
    var lo = max(fl, 1.0);
    let hi = min(fl + h, roofMax);
    if (hi - lo < 2.0) {
      below = vec2<f32>(0.0);
      continue;
    }
    // a shaft down to the layer under it
    if (below.y > below.x && pfbm(u, perOf(sc * 0.35), 2u, s + 11u) > 0.45) { lo = below.x; o.n -= 1u; }
    o.v[o.n] = vec2<f32>(lo, hi);
    o.n += 1u;
    below = vec2<f32>(lo, hi);
  }
  return o;
}

/** the first two caves under a column (the viewer's cave map): (z0, z1, z0, z1), none 0 */
fn caves(p: vec2<f32>, top: f32, r: Region) -> vec4<f32> {
  let c = caveVoids(p, top, r);
  var out = vec4<f32>(0.0);
  if (c.n > 0u) { out = vec4<f32>(c.v[0], 0.0, 0.0); }
  if (c.n > 1u) { out = vec4<f32>(c.v[0], c.v[1]); }
  return out;
}
