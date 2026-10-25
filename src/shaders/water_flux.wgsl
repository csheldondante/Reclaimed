// ---- water transport: flux pass ---------------------------------------
// Column-volume "virtual pipes" model. flux[i] holds the volume (cells^3)
// leaving column i this tick toward each neighbour (NDIR order, common.wgsl).
// Columns at the map edge drain outward (the world continues downhill) — down to the sea's level where
// there is one (G.ocean.x, round 79: the sea in a streamed window stays).
// Loose dust (drift) is part of the bed: water lies on top of it (round 13).
@group(0) @binding(3) var<storage, read> surface: array<u32>;
@group(0) @binding(4) var<storage, read> water: array<f32>;
@group(0) @binding(5) var<storage, read_write> flux: array<Dirs>;
// oil floating on the water adds (lighter) weight to the water head
@group(0) @binding(6) var<storage, read> oil: array<f32>;
const OIL_DENSITY: f32 = 0.88;

// per pipe: the hex Laplacian weights each of the six neighbours 2/3 as much
// as the square grid's four (the same continuum spreading rate)
const GAIN: f32 = 0.12 * 2.0 / 3.0;
const FRICTION: f32 = 0.985;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= G.mapW || id.y >= G.mapH) { return; }
  let p = vec2<i32>(id.xy);
  let i = colIdxI(p);
  let d = water[i];
  if (d <= 1e-5) { flux[i] = dZero(); return; }
  // (a body lying here is ground to the water: round 17)
  let g = max(f32(sfZ(surface[i])) + driftAt(p), bodyTopAt(p));
  let H = g + d + oil[i] * OIL_DENSITY;
  var f = flux[i];
  for (var k = 0u; k < NDIR; k++) {
    let q = nbr(p, k);
    var Hn = max(g, G.ocean.x);
    if (inMap(q)) {
      let j = colIdxI(q);
      Hn = max(f32(sfZ(surface[j])) + driftAt(q), bodyTopAt(q)) + water[j] + oil[j] * OIL_DENSITY;
    }
    f[k] = max(0.0, f[k] * FRICTION + GAIN * (H - Hn));
  }
  let total = dSum(f);
  if (total > d) { f = dScale(f, d / total); }
  flux[i] = f;
}
