// ---- shields.wgsl ---------------------------------------------------------------------------------------------------
// (loop round 14, docs/design/FRONTS.md "The shield as an energy barrier") What presses on each shield, measured on the
// GPU: one workgroup a shield (Globals.shields), over a band PRESS_BAND cells wide outside its rim —
//   [k*4 + 0] the liquid lava standing there (the flow model's open depth, cells x 1000)
//   [k*4 + 1] the fire burning there (fire intensity 0..1 a column, x 1000)
//   [k*4 + 2] the hostile units standing there (alive, combat word's hostile flag)
// Summed into `press` (cleared by the CPU before each dispatch: src/api/shields.ts ShieldPress), read back small.

@group(0) @binding(3) var<storage, read> fireB: array<f32>;
@group(0) @binding(4) var<storage, read> lavaOpen: array<f32>;
@group(0) @binding(5) var<storage, read> units: array<vec4<f32>>;
@group(0) @binding(6) var<storage, read> combat: array<vec4<u32>>;
@group(0) @binding(7) var<storage, read_write> pressed: array<atomic<u32>, 16>;
struct PressParams { units: u32, band: f32, _a: u32, _b: u32 };
@group(0) @binding(8) var<uniform> PP: PressParams;

const UNIT_V_S: u32 = 6u;
const CW_HOSTILE: u32 = 0x100u;

@compute @workgroup_size(64)
fn press(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_index) li: u32) {
  let k = wg.x;
  if (k >= 4u) { return; }
  let s = G.shields[k];
  if (s.z <= 0.0) { return; }
  let R = s.z + PP.band;
  let c0 = cellAt(s.xy - vec2<f32>(R + 1.0));
  let c1 = cellAt(s.xy + vec2<f32>(R + 1.0));
  let w = u32(c1.x - c0.x + 1);
  let h = u32(c1.y - c0.y + 1);
  var lava = 0.0;
  var fire = 0.0;
  for (var j = li; j < w * h; j += 64u) {
    let p = c0 + vec2<i32>(i32(j % w), i32(j / w));
    if (p.x < 0 || p.y < 0 || p.x >= i32(G.mapW) || p.y >= i32(G.mapH)) { continue; }
    let d = distance(cellPos(p), s.xy);
    if (d < s.z || d > R) { continue; }
    let i = colIdxI(p);
    lava += lavaOpen[i];
    fire += fireB[i];
  }
  if (lava > 0.0) { atomicAdd(&pressed[k * 4u], u32(min(lava * 1000.0, 4e9))); }
  if (fire > 0.0) { atomicAdd(&pressed[k * 4u + 1u], u32(min(fire * 1000.0, 4e9))); }
  var n = 0u;
  for (var u = li; u < PP.units; u += 64u) {
    let a = units[u * UNIT_V_S];
    if (((bitcast<u32>(a.w) >> 8u) & 1u) == 0u) { continue; }
    if ((combat[u].x & CW_HOSTILE) == 0u) { continue; }
    let d = distance(a.xy, s.xy);
    if (d >= s.z - 0.75 && d <= R) { n++; }
  }
  if (n > 0u) { atomicAdd(&pressed[k * 4u + 2u], n); }
}
