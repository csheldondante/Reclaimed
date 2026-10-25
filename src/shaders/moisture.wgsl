// ---- soil moisture field -------------------------------------------------
// Wetted by rain and standing/flowing water, diffuses to neighbours (green
// riverbanks), dries slowly. Vegetation shades and holds soil moisture, so
// established life sustains itself between storms (a positive feedback that
// makes recovery self-propagating). Read by ecology (growth) and material
// (repose).
@group(0) @binding(3) var<storage, read> water: array<f32>;
@group(0) @binding(4) var<storage, read> moistIn: array<f32>;
@group(0) @binding(5) var<storage, read_write> moistOut: array<f32>;
@group(0) @binding(6) var<storage, read> veg: array<f32>;
// flat ground holds water (slopes drain): the basis of the woodland/meadow biomes
@group(0) @binding(7) var<storage, read> surface: array<u32>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= G.mapW || id.y >= G.mapH) { return; }
  // (a sleeping chunk, round 80: what it holds carried through — the next buffer is copied back over this one)
  if (asleep(id.xy)) {
    let ia = colIdx(id.x, id.y);
    moistOut[ia] = moistIn[ia];
    return;
  }
  let p = vec2<i32>(id.xy);
  let i = colIdxI(p);
  let m = moistIn[i];
  var avg = 0.0;
  for (var k = 0u; k < NDIR; k++) { avg += moistIn[colIdxI(clampCell(nbr(p, k)))]; }
  avg /= f32(NDIR);
  var nm = m + (avg - m) * 0.06;
  nm += rainAt(cellPos(p)) * 0.006;
  if (water[i] > 0.01) { nm += 0.02; }
  // drying: ~3 minutes for bare soil, much slower under established plants
  let retain = 1.0 - 0.85 * smoothstep(0.5, 3.0, veg[i]);
  let hold = mix(1.0, 0.35, flatness(p));
  nm -= (0.00003 + 0.00012 * m) * retain * hold;
  moistOut[i] = clamp(nm, 0.0, 1.0);
}
