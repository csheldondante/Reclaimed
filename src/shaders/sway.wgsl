// ---- vegetation sway (render-only state) ------------------------------------
// (round 128p) Run where a gust wakes the plants, or a spring is still swinging (swaylist.wgsl: the chunks listed on
// the GPU); under the map's own breeze the plants keep the lean they have — the sway sleeps where the wind is low.
// One damped spring per column: bend.xy = how far the plants here lean
// (cells at canopy height), bend.zw = its velocity. Wind pushes the lean
// toward a target quickly, and the plants hold it while the wind holds; when
// the wind drops they spring back slowly and loosely, overshooting a little
// (DECISIONS round 5: "springier but slower to bounce back", "trees bend and
// stay bent, then spring back"). The draw shaders read it instead of
// evaluating the wind per vertex, so sway has memory.
@group(0) @binding(3) var<storage, read> surface: array<u32>;
@group(0) @binding(4) var<storage, read_write> bend: array<vec4<f32>>;
// (round 128p) per window chunk: 1 while a spring of its hasn't settled — it stays on the sway's list (swaylist.wgsl)
@group(0) @binding(5) var<storage, read_write> restless: array<u32>;
/** a spring this slow (cells/s of lean) has stopped swinging */
const SETTLED_SPEED: f32 = 0.01;

const DT_S: f32 = 1.0 / 60.0;
/** (perfopt, simhz) the world time a tick stands for */
fn dtS() -> f32 { return DT_S * simStep(); }

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= G.mapW || id.y >= G.mapH) { return; }
  let i = colIdx(id.x, id.y);
  let c = vec3<f32>(cellPos(vec2<i32>(id.xy)), f32(sfZ(surface[i])) + 2.5);
  let w = windAt(c);
  let ws = length(w);
  // strong player wind bends plants hard (cap raised in round 7)
  let aim = w / max(ws, 1e-3) * clamp(ws / 6.0, 0.0, 2.6) * 0.3;
  let b = bend[i];
  let pos = b.xy;
  let vel = b.zw;
  // pushing further into the lean: stiff and well damped (bends readily, no
  // wobble); easing back: soft and lightly damped (a slow, springy return)
  let pushing = dot(aim - pos, aim) > 0.0 && length(aim) > length(pos) * 0.9;
  let k = select(1.6, 7.0, pushing);
  let damp = select(1.1, 4.2, pushing);
  let acc = (aim - pos) * k - vel * damp;
  let v2 = vel + acc * dtS();
  let p2 = pos + v2 * dtS();
  bend[i] = vec4<f32>(p2, v2);
  if (length(v2) > SETTLED_SPEED) { restless[(id.y / G.chunkSize) * G.chunksX + id.x / G.chunkSize] = 1u; }
}
