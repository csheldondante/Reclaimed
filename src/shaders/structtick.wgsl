// ---- structure grids: their own tick (docs/GRIDS.md) ---------------------------
// One thread per voxel of the pool. What a structure sees of the nature grid
// is sampled at each voxel's world centre (the nature → structure direction):
//  * sand cover: the voxel lies inside the nature column's loose run there
//    (below its top, above its base) — eased, so the drape creeps up and down;
//  * moss: growth on the voxel's faces open to the air (the structure owns the
//    growth on its faces: plants rooted in loose ground belong to the nature
//    grid), where the ground there is damp; up-facing faces fastest, but
//    undersides too. It spreads from green ground beneath and from mossy
//    neighbours, rarely starts on its own (spores), and lies dormant under sand;
//  * cover (round 52): snow, or dust, on the faces that look up — snow while
//    it snows there (rain cold enough at that height), dust under a dust
//    storm or where the wind lifts grit nearby (the air texture); snow melts
//    in the warmth and a gale sweeps it off, rain washes dust away. 31 levels
//    in bits 24..28 (grids.wgsl voxCoverLv), stepped one level at a time with
//    a chance per pass, bit 29 which it is (the last to settle).
// Each thread writes only its own voxel; neighbours' moss may be read a tick
// old or new (harmless: growth only spreads).
@group(0) @binding(3) var<storage, read> frames: array<Frame>;
@group(0) @binding(4) var<storage, read_write> vox: array<u32>;
@group(0) @binding(5) var<storage, read> surface: array<u32>;
@group(0) @binding(6) var<storage, read> moisture: array<f32>;
@group(0) @binding(7) var<storage, read> veg: array<f32>;
// the air (sediment.wgsl airOut): x the dust the wind lifted at a column this pass
@group(0) @binding(19) var airTex: texture_2d<f32>;

// (per pass, every 4 ticks: bare to full in about four minutes of damp weather)
const MOSS_RATE: f32 = 0.0003;
const SAND_EASE: f32 = 0.05;
// cover, in levels a pass (15 passes a second): full snow cover in ~40 s of
// steady snow, dust in ~20 s of a storm; snow gone in ~30 s at 10 °C,
// dust in ~25 s of rain
const COVER_SNOW: f32 = 0.06;
const COVER_DUST: f32 = 0.1;
const COVER_MELT: f32 = 0.007;
const COVER_WASH: f32 = 0.08;
const COVER_SWEEP: f32 = 0.02;

fn locate(v: u32) -> vec4<i32> {
  for (var s = 0u; s < MAX_STRUCTS; s++) {
    let f = frames[s];
    if (f.d.x == 0u) { continue; }
    let n = f.d.x * f.d.y * f.d.z;
    if (v < f.d.w || v >= f.d.w + n) { continue; }
    let k = v - f.d.w;
    return vec4<i32>(i32(k % f.d.x), i32((k / f.d.x) % f.d.y), i32(k / (f.d.x * f.d.y)), i32(s));
  }
  return vec4<i32>(-1);
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let v = id.x;
  if (v >= arrayLength(&vox)) { return; }
  let at = locate(v);
  if (at.x < 0) { return; }
  let f = frames[u32(at.w)];
  let c = at.xyz;
  let w = vox[v];
  let mat = voxMat(w);
  if (mat == 0u) { return; }
  let wc = toWorld(f, vec3<f32>(c) + 0.5);
  let cell = clampCell(cellAt(wc.xy));
  let i = colIdxI(cell);
  let base = f32(sfZ(surface[i]));
  let top = base + driftAt(cell);
  // inside the loose run there: covered
  let inside = wc.z < top - 0.2 && wc.z > base - 0.6;
  var sand = voxSand(w);
  sand += (select(0.0, 1.0, inside) - sand) * SAND_EASE;
  // moss on the faces open to the air
  var moss = voxMoss(w);
  var open = 0.0;
  var nearMoss = 0.0;
  // how much its most upward open face looks up
  var lookUp = -1.0;
  for (var k = 0u; k < 6u; k++) {
    let q = c + FACE6[k];
    if (inGrid(f, q)) {
      let u = vox[voxIndex(f, q)];
      if (voxMat(u) != 0u) { nearMoss = max(nearMoss, voxMoss(u)); continue; }
    }
    // up-facing faces catch the rain best; undersides stay damp in the shade
    let up = qrot(f.q, vec3<f32>(FACE6[k])).z;
    open = max(open, 0.5 + 0.5 * max(up, 0.0));
    lookUp = max(lookUp, up);
  }
  let damp = smoothstep(0.03, 0.25, moisture[i]) + rainAt(wc.xy) * 0.5;
  // (spores: about once a few hours per voxel; otherwise it creeps from green
  // ground and from mossy neighbours)
  let seeded = veg[i] > 1.0 || nearMoss > 0.4 || moss > 0.0 || rand3(v, G.tick, 0x5f0eu) < 0.000002;
  // stone, concrete, asphalt, rust, brick and bone take moss; steel, wood,
  // canvas and the rest barely
  let takes = select(0.3, 1.0, mat == 1u || (mat >= 5u && mat <= 7u) || mat == 11u || mat == 16u);
  if (open > 0.0 && seeded && sand < 0.5) {
    // (round 108, simtiers: moss is the vegetation's growth — baked, none in play; a bake's gain speeds it)
    moss += MOSS_RATE * tierRate(TIER_VEG, cell) * open * clamp(damp, 0.0, 1.0) * takes * (0.5 + 0.5 * max(nearMoss, moss));
  }
  // cover on the faces that look up
  var lv = voxCoverLv(w);
  var dusty = voxDusty(w);
  let t = airTempAt(wc.z);
  let snowing = rainAt(wc.xy) * snowShare(t);
  var dust = min(textureLoad(airTex, texCol(vec2<i32>(cell)), 0).x * 20.0, 1.0);
  for (var k = 0u; k < 2u; k++) {
    let ds = G.dusts[k];
    if (ds.w <= 0.0) { continue; }
    dust += ds.w / 8.0 * smoothstep(1.2, 0.4, length(wc.xy - ds.xy) / ds.z);
  }
  let gainS = snowing * COVER_SNOW;
  let gainD = min(dust, 1.0) * COVER_DUST;
  if (lookUp > 0.5 && sand < 0.5 && lv < 31u && rand3(v, G.tick, 0xc0e1u) < (gainS + gainD) * lookUp) {
    lv += 1u;
    dusty = gainD > gainS;
  }
  let gale = max(length(windAt(wc)) - 8.0, 0.0);
  var loss = select(max(t, 0.0) * COVER_MELT + gale * COVER_SWEEP, rainAt(wc.xy) * (1.0 - snowShare(t)) * COVER_WASH, dusty);
  // (nothing holds it where no face looks up any more: a toppled wall)
  if (lookUp <= 0.5) { loss = 1.0; }
  if (lv > 0u && rand3(v, G.tick, 0xc0e2u) < loss) { lv -= 1u; }
  vox[v] = voxPack(mat, moss, sand) | (lv << 24u) | (select(0u, 1u, dusty) << 29u);
}
