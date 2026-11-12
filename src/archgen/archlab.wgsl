// (archgen) The lab's host for draw.wgsl: its own view uniform and light (not the game's: the wire-in's host is
// archgame.wgsl, appended to render.wgsl). Prepended to draw.wgsl (after arch.wgsl's constants).

struct View {
  viewProj: mat4x4<f32>,
  /** xyz towards the sun, w its strength */
  sun: vec4<f32>,
  /** xyz towards the camera, w world units a pixel */
  eye: vec4<f32>,
  /** x time, y night (0–1), z detail (0 phone … 1 PC) */
  p: vec4<f32>,
};

@group(0) @binding(0) var<uniform> V: View;
@group(0) @binding(1) var<storage, read> instances: array<vec4<u32>>;

fn archClip(w: vec3<f32>) -> vec4<f32> { return V.viewProj * vec4<f32>(w, 1.0); }
fn archPlace() -> vec3<f32> { return vec3<f32>(0.0); }
fn archNight() -> f32 { return V.p.y; }
fn archTime() -> f32 { return V.p.x; }
fn archDetail() -> f32 { return V.p.z; }

// ---- fragment (appended after draw.wgsl) ----
@fragment
fn fsLab(in: VO) -> @location(0) vec4<f32> {
  let sf = archSurface(in);
  let n = bumpN(sf.n, in.wpos, sf.h);
  var lit: vec3<f32>;
  if (V.p.w > 0.5) {
    // (the old light, ?oldlight=1: a warm sun with wrap, a grey-blue sky)
    let sunC = vec3<f32>(1.0, 0.93, 0.8) * V.sun.w;
    let diff = max(dot(n, normalize(V.sun.xyz)) * 0.85 + 0.15, 0.0);
    let sky = mix(vec3<f32>(0.42, 0.40, 0.38), vec3<f32>(0.55, 0.65, 0.8), n.z * 0.5 + 0.5);
    lit = sf.col * (sunC * diff + sky * 0.55) * sf.ao;
  } else {
    // Townscaper's light (the user's reference, 2026-11-12): a peach key with no wrap, the shade a cool teal sky rather
    // than a darker grey (the hue's turn reads as volume), a little bounce warm from the ground; the street's foot dark
    let L = normalize(V.sun.xyz);
    let ndl = max(dot(n, L), 0.0);
    let sunC = vec3<f32>(1.0, 0.78, 0.62) * V.sun.w * 1.25;
    let sky = mix(vec3<f32>(0.2, 0.3, 0.36), vec3<f32>(0.34, 0.48, 0.6), n.z * 0.5 + 0.5);
    let bounce = vec3<f32>(0.16, 0.11, 0.08) * max(-n.z, 0.0);
    let above = max(in.wpos.z - in.zs.y, 0.0);
    let foot = mix(0.55, 1.0, smoothstep(0.0, 4.5, above));
    lit = sf.col * (sunC * ndl + (sky * foot + bounce) * 0.9) * sf.ao;
  }
  lit = mix(lit, lit + vec3<f32>(0.1, 0.13, 0.16) * (1.0 - V.p.y), sf.glass * 0.6);
  return vec4<f32>(pow(lit, vec3<f32>(1.0 / 1.1)), 1.0);
}
