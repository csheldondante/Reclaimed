// ---- sun shadows (render preparation) ------------------------------------
// Heightfield shadow: for each column the lowest z that receives sunlight,
// found by marching toward the sun over surface heights. Includes the column
// itself, so floors under a roof are shadowed.
@group(0) @binding(3) var<storage, read> surface: array<u32>;
@group(0) @binding(4) var<storage, read_write> shadow: array<f32>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= G.mapW || id.y >= G.mapH) { return; }
  let sun = normalize(vec3<f32>(G.sunX, G.sunY, G.sunZ));
  let horiz = length(sun.xy);
  let dir = sun.xy / horiz;
  let tanE = sun.z / horiz;
  let p0 = vec2<f32>(id.xy) + 0.5;
  var sz = f32(sfZ(surface[colIdx(id.x, id.y)]));
  for (var k = 1; k < 160; k++) {
    let drop = f32(k) * tanE;
    if (f32(G.zMax) - drop <= sz) { break; }
    let q = vec2<i32>(floor(p0 + dir * f32(k)));
    if (!inMap(q)) { break; }
    sz = max(sz, f32(sfZ(surface[colIdxI(q)])) - drop);
  }
  shadow[colIdx(id.x, id.y)] = sz;
}
