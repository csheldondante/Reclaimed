// ---- what the engine's bodies lost to erosion, onto the ground (engine.wgsl; a thread an event of the tick) ---------
// Dispatched by the events' own count (indirect: no events, no threads). Several events may name one column: the
// first of them writes the column's sum, so no two threads write one cell and nothing is lost.
@group(0) @binding(15) var<storage, read> evIn: array<u32>;
@group(0) @binding(14) var<storage, read_write> deposit: array<vec4<f32>>;

@compute @workgroup_size(64)
fn fold(@builtin(global_invocation_id) id: vec3<u32>) {
  let n = min(evIn[3], u32(EU.f.y));
  let e = id.x;
  if (e >= n) { return; }
  let b = EV_AT + e * EV_WORDS;
  if (evIn[b] != EV_ERODE) { return; }
  let col = evIn[b + 2u];
  var sum = 0.0;
  for (var j = 0u; j < n; j++) {
    let c = EV_AT + j * EV_WORDS;
    if (evIn[c] != EV_ERODE || evIn[c + 2u] != col) { continue; }
    if (j < e) { return; }
    sum += bitcast<f32>(evIn[c + 7u]);
  }
  let d = deposit[col];
  deposit[col] = vec4<f32>(d.x, d.y + sum, f32(evIn[b + 3u]), d.w);
}
