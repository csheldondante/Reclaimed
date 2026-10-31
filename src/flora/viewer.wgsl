// ---- the flora viewer page (round 117; src/flora/viewer.ts) -----------------------------------------------------
// Prepended: common.wgsl, materials.wgsl, the library's constants, floralook.wgsl (the game's plant look and wind —
// the same functions meshinst.wgsl draws with). Its own simple light: a sun and a sky, no shadows.

struct View {
  viewProj: mat4x4<f32>,
  eye: vec4<f32>,
  // xy the plants' lean (sway.wgsl's spring, run on the CPU here), z the time, w the ground's style
  lean: vec4<f32>,
  // xyz toward the sun, w the haze distance
  sun: vec4<f32>,
};
@group(0) @binding(1) var<uniform> V: View;
// instances: four vec4s each — three rows of the affine (translation in w), then (kind, seed, 0, 0)
@group(0) @binding(3) var<storage, read> inst: array<vec4<f32>>;
// falling leaves: two vec4s each — position, spin; colour, size
@group(0) @binding(4) var<storage, read> leaves: array<vec4<f32>>;

fn shade(c: vec3<f32>, n: vec3<f32>, wpos: vec3<f32>) -> vec4<f32> {
  let l = normalize(V.sun.xyz);
  let d = max(dot(n, l), 0.0);
  let sky = 0.42 + 0.18 * n.z;
  var col = c * (d * 0.85 + sky);
  // haze toward the distance (the game's far haze, simplified)
  let f = smoothstep(V.sun.w * 0.4, V.sun.w, length(wpos - V.eye.xyz));
  col = mix(col, vec3<f32>(0.72, 0.8, 0.86), f * 0.65);
  return vec4<f32>(col, 1.0);
}

struct PO {
  @builtin(position) pos: vec4<f32>,
  @location(0) wpos: vec3<f32>,
  @location(1) @interpolate(flat) info: vec4<u32>,
  @location(2) h: f32,
};

@vertex
fn vsPlant(@location(0) a: vec4<f32>, @builtin(instance_index) ii: u32) -> PO {
  let r0 = inst[ii * 4u];
  let r1 = inst[ii * 4u + 1u];
  let r2 = inst[ii * 4u + 2u];
  let p = inst[ii * 4u + 3u];
  let k = u32(p.x);
  let part = u32(floor(a.w));
  let sway = select(fract(a.w), 0.0, part >= 9u);
  var wp = vec3<f32>(dot(r0.xyz, a.xyz) + r0.w, dot(r1.xyz, a.xyz) + r1.w, dot(r2.xyz, a.xyz) + r2.w);
  if (part < 9u) {
    // (a gust passes over the scene as a wave: each plant leans a little more or less by its place)
    let at = vec2<f32>(r0.w, r1.w);
    let g = 0.75 + 0.35 * sin(dot(at, vec2<f32>(0.11, 0.07)) - V.lean.z * 0.9);
    wp = wp + floraSway(k, part, a.xyz, sway, at, V.lean.xy * g, p.y, V.lean.z);
  }
  var o: PO;
  o.pos = V.viewProj * vec4<f32>(wp, 1.0);
  o.wpos = wp;
  o.info = vec4<u32>(k, part, u32(p.y * 65535.0), 0u);
  o.h = sway;
  return o;
}

@fragment
fn fsPlant(in: PO) -> @location(0) vec4<f32> {
  var n = normalize(cross(dpdx(in.wpos), dpdy(in.wpos)));
  if (dot(n, V.eye.xyz - in.wpos) < 0.0) { n = -n; }
  if (in.info.y >= 9u) {
    // a host: stone (a ruin's wall, a boulder) for the plants instanced onto it
    let s = 0.5 + 0.12 * randv(vec3<i32>(floor(in.wpos * 2.0)));
    return shade(vec3<f32>(s, s * 0.98, s * 0.93), n, in.wpos);
  }
  let rnd = f32(in.info.z) / 65535.0;
  let fl = floraLook(in.info.x, in.info.y, in.wpos, n, in.h, rnd, in.info.z);
  if (fl.w < 0.0) { discard; }
  return shade(fl.rgb, n, in.wpos);
}

// ---- the ground: a disc, its look by the scene's style (0 meadow, 1 forest floor in leaf litter, 2 riverbank) ----
struct GO {
  @builtin(position) pos: vec4<f32>,
  @location(0) wpos: vec3<f32>,
};

@vertex
fn vsGround(@builtin(vertex_index) vi: u32) -> GO {
  let q = array<vec2<f32>, 6>(vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, -1.0), vec2<f32>(1.0, 1.0), vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, 1.0), vec2<f32>(-1.0, 1.0));
  let w = vec3<f32>(q[vi] * 400.0, 0.0);
  var o: GO;
  o.pos = V.viewProj * vec4<f32>(w, 1.0);
  o.wpos = w;
  return o;
}

@fragment
fn fsGround(in: GO) -> @location(0) vec4<f32> {
  // per cell, as the game's ground is (the per-cell look), with a little noise within
  let c = vec3<i32>(vec3<f32>(floor(in.wpos.xy), 0.0));
  let r = randv(c);
  let r2 = randv(vec3<i32>(vec2<i32>(floor(in.wpos.xy * 4.0)), 7));
  let style = u32(V.lean.w);
  var col = mix(vec3<f32>(0.33, 0.52, 0.18), vec3<f32>(0.42, 0.6, 0.22), r) * (0.92 + 0.12 * r2);
  if (style == 1u) {
    // leaf litter: the forest floor in fallen birch and broadleaf leaves — yellows, ochres, browns, a little moss
    // (muted: the litter is the ground the trees stand out from, not the show)
    let pal = array<vec3<f32>, 5>(vec3<f32>(0.6, 0.47, 0.24), vec3<f32>(0.47, 0.34, 0.2), vec3<f32>(0.66, 0.56, 0.3), vec3<f32>(0.4, 0.31, 0.2), vec3<f32>(0.36, 0.4, 0.22));
    let q = randv(vec3<i32>(vec2<i32>(floor(in.wpos.xy * 2.0)), 3));
    col = mix(pal[min(u32(q * 5.0), 4u)], vec3<f32>(0.5, 0.42, 0.28), 0.3 * r) * (0.9 + 0.15 * r2);
  } else if (style == 2u) {
    // a riverbank: mud along the water's edge (x < 0 the water)
    let x = in.wpos.x;
    if (x < -2.0) {
      col = mix(vec3<f32>(0.18, 0.32, 0.38), vec3<f32>(0.3, 0.45, 0.5), 0.5 + 0.5 * sin(in.wpos.y * 0.7 + V.lean.z * 1.5 + r2));
    } else if (x < 1.5) {
      col = mix(vec3<f32>(0.32, 0.26, 0.18), vec3<f32>(0.4, 0.33, 0.22), r);
    }
  }
  let n = vec3<f32>(0.0, 0.0, 1.0);
  return shade(col, n, in.wpos);
}

// ---- falling leaves (the viewer's own few hundred: the game's are particles.wgsl K_LEAF, carried by the wind) ----
struct LO {
  @builtin(position) pos: vec4<f32>,
  @location(0) @interpolate(flat) col: vec4<f32>,
};

@vertex
fn vsLeaf(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> LO {
  let p = leaves[ii * 2u];
  let c = leaves[ii * 2u + 1u];
  let q = array<vec2<f32>, 6>(vec2<f32>(0.0, -1.0), vec2<f32>(1.0, 0.0), vec2<f32>(0.0, 1.0), vec2<f32>(0.0, -1.0), vec2<f32>(0.0, 1.0), vec2<f32>(-1.0, 0.0));
  let s = c.w;
  // spinning about a tilted axis as it flutters down
  let a = p.w;
  let u = vec3<f32>(cos(a), sin(a), 0.4 * sin(a * 1.7));
  let v = vec3<f32>(-sin(a) * 0.6, cos(a) * 0.6, 0.8 * cos(a * 1.3));
  let w = p.xyz + (u * q[vi].x * 0.6 + v * q[vi].y) * s;
  var o: LO;
  o.pos = V.viewProj * vec4<f32>(w, 1.0);
  // (lit by how it faces the sun as it turns: a flicker as it spins)
  o.col = vec4<f32>(c.rgb * (0.65 + 0.45 * abs(sin(a * 1.3))), 1.0);
  return o;
}

@fragment
fn fsLeaf(in: LO) -> @location(0) vec4<f32> {
  return in.col;
}
