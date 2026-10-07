// ---- ecology / succession -------------------------------------------------
// veg = continuous succession stage per column:
//   0 bare · 1 lichen/moss · 2 grass · 3 shrubs · 4 young trees · 5 mature
// Growth depends on local conditions (substrate, contamination, moisture,
// flooding) — not on a timer. Bare cells are colonised probabilistically
// from neighbours, plus a tiny spore rain so isolated clean areas recover.
@group(0) @binding(3) var<storage, read> surface: array<u32>;
@group(0) @binding(4) var<storage, read> contam: array<vec2<f32>>;
@group(0) @binding(5) var<storage, read> moisture: array<f32>;
@group(0) @binding(6) var<storage, read> water: array<f32>;
@group(0) @binding(7) var<storage, read> vegIn: array<f32>;
@group(0) @binding(8) var<storage, read_write> vegOut: array<f32>;
// oil smothers plants and blocks colonisation
@group(0) @binding(9) var<storage, read> oil: array<f32>;
@group(0) @binding(10) var<storage, read> fire: array<f32>;

const TOX_LIMIT: f32 = 0.2;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= G.mapW || id.y >= G.mapH) { return; }
  let p = vec2<i32>(id.xy);
  let i = colIdxI(p);
  let m = sfMat(surface[i]);
  let cap = MATS[m].eco.x;
  let suit = MATS[m].eco.y;
  let c = contam[i].x;
  let oiled = oil[i] > 0.02;
  let tox = select(clamp(1.0 - c / TOX_LIMIT, 0.0, 1.0), 0.0, oiled);
  let wet = moisture[i];
  let mf = smoothstep(0.06, 0.35, wet);
  let d = water[i];
  var v = vegIn[i];
  let r = rand3(id.x, id.y, G.tick ^ 0x5eedu);

  if (fire[i] > 0.15) {
    // burning: grass goes in a moment, trees take longer
    v = max(0.0, v - fire[i] * mix(0.6, 0.25, smoothstep(2.0, 4.0, v)));
  } else if (oiled) {
    v = max(0.0, v - 0.06);
  } else if (d > 0.5) {
    v = max(0.0, v - 0.04);
  } else if (v > 0.0) {
    // pioneers (moss, grass) establish quickly; woody stages take much longer
    let rate = 0.012 * suit * tox * mf * mix(1.2, 0.18, smoothstep(1.5, 3.5, v));
    v += rate;
    if (v > cap) { v = max(cap, v - 0.02); }
    if (c > TOX_LIMIT * 2.5) { v -= 0.02; }
    if (wet < 0.04) { v -= 0.003; }
    if (v < 0.05) { v = 0.0; }
  } else {
    var neigh = 0.0;
    for (var k = 0u; k < 4u; k++) {
      let q = p + DIRS[k];
      if (inMap(q)) { neigh += smoothstep(0.4, 1.2, vegIn[colIdxI(q)]); }
    }
    // occasional long-distance seed from established plants (wind / animals)
    let o = vec2<i32>(i32(hash3(id.x, id.y, G.tick) % 9u) - 4, i32(hash3(id.y, id.x, G.tick + 7u) % 9u) - 4);
    let q2 = clampCell(p + o);
    neigh += 0.6 * smoothstep(2.5, 4.0, vegIn[colIdxI(q2)]);
    let chance = (neigh * 0.1 + 0.0003) * suit * tox * mf;
    if (cap > 0.0 && r < chance) { v = 0.25; }
  }
  vegOut[i] = clamp(v, 0.0, 5.0);
}
