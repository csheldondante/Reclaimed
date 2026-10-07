// ---- water transport: flux pass ---------------------------------------
// Column-volume "virtual pipes" model. flux[i] holds the volume (cells^3)
// leaving column i this tick toward +x, -x, +y, -y (DIRS order).
// Columns at the map edge drain outward (the world continues downhill).
@group(0) @binding(3) var<storage, read> surface: array<u32>;
@group(0) @binding(4) var<storage, read> water: array<f32>;
@group(0) @binding(5) var<storage, read_write> flux: array<vec4<f32>>;
// oil floating on the water adds (lighter) weight to the water head
@group(0) @binding(6) var<storage, read> oil: array<f32>;
const OIL_DENSITY: f32 = 0.88;

const GAIN: f32 = 0.12;
const FRICTION: f32 = 0.985;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= G.mapW || id.y >= G.mapH) { return; }
  let p = vec2<i32>(id.xy);
  let i = colIdxI(p);
  let d = water[i];
  if (d <= 1e-5) { flux[i] = vec4<f32>(0.0); return; }
  let g = f32(sfZ(surface[i]));
  let H = g + d + oil[i] * OIL_DENSITY;
  var f = flux[i];
  for (var k = 0u; k < 4u; k++) {
    let q = p + DIRS[k];
    var Hn = g;
    if (inMap(q)) {
      let j = colIdxI(q);
      Hn = f32(sfZ(surface[j])) + water[j] + oil[j] * OIL_DENSITY;
    }
    f[k] = max(0.0, f[k] * FRICTION + GAIN * (H - Hn));
  }
  let total = f.x + f.y + f.z + f.w;
  if (total > d) { f *= d / total; }
  flux[i] = f;
}
