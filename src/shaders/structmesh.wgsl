// ---- structures: warped module instances (src/structures/gpu.ts; contracts/structures.ts StructurePieces) --------
// Shared by every host that draws a city (the structures viewer, the game's renderer). The host declares:
//   `fn spFetch(i: u32) -> vec4<f32>` — its data buffer's vec4 i: the palette (SP_PAL vec4s: styles × parts × variants) then 4 vec4s a piece:
//      (x0 y0 x1 y1) (x2 y2 x3 y3) (foot z0 z1 z2 z3) (top, look, seed, flags)
//   `fn hostNight() -> f32` — 0 by day, 1 at night (the windows and lamps glow)
// and its own entry points, which call spVertex / spAlbedo / spEmit. A module vertex is (u, v, w, part) in the unit
// frame; the piece warps it: x, y bilinear over the four corners (Townscaper's deformed modules), z from the foot's
// bilinear height up to the top (flags & 1: the top is a height over the foot — paving that follows the ground).

// (SP_PAL, SP_PARTS, SP_VARIANTS: from src/structures/gpu.ts wgsl(), the TS tables' sizes)

struct SpVert {
  wpos: vec3<f32>,
  // the module's own w (0 its foot, 1 its top): grime low on walls
  w: f32,
  part: u32,
  look: u32,
  seed: f32,
  // the piece's palette colour for this part (linear)
  base: vec3<f32>,
};

fn spRow(i: u32, r: u32) -> vec4<f32> { return spFetch(SP_PAL + i * 4u + r); }

fn spHash(x: u32) -> u32 {
  var h = x;
  h ^= h >> 16u;
  h *= 0x7feb352du;
  h ^= h >> 15u;
  h *= 0x846ca68bu;
  h ^= h >> 16u;
  return h;
}

fn spVertex(a: vec4<f32>, piece: u32) -> SpVert {
  let c01 = spRow(piece, 0u);
  let c23 = spRow(piece, 1u);
  let foot = spRow(piece, 2u);
  let tp = spRow(piece, 3u);
  let u = a.x;
  let v = a.y;
  let xy = (1.0 - u) * (1.0 - v) * c01.xy + u * (1.0 - v) * c01.zw + u * v * c23.xy + (1.0 - u) * v * c23.zw;
  let zf = (1.0 - u) * (1.0 - v) * foot.x + u * (1.0 - v) * foot.y + u * v * foot.z + (1.0 - u) * v * foot.w;
  let rel = (u32(tp.w) & 1u) != 0u;
  var z = mix(zf, tp.x, a.z);
  if (rel) { z = zf + tp.x * a.z; }
  var o: SpVert;
  o.wpos = vec3<f32>(xy, z);
  o.w = a.z;
  o.part = u32(a.w + 0.5);
  o.look = u32(tp.y);
  o.seed = tp.z;
  // the palette: the style's slot, its variant picked per building (look's low bits, hashed per part)
  let style = o.look >> 16u;
  let pick = spHash((o.look & 0xffffu) * 31u + o.part * 7919u);
  let nVar = u32(spFetch((style * SP_PARTS + o.part) * SP_VARIANTS).w);
  var vi = pick % max(nVar, 1u);
  // (roofs by district: look bit 15 set → bits 12-14 are the district's roof colour, so a quarter reads from afar)
  if (o.part == 2u && (o.look & 0x8000u) != 0u) { vi = ((o.look >> 12u) & 7u) % max(nVar, 1u); }
  o.base = spFetch((style * SP_PARTS + o.part) * SP_VARIANTS + vi).rgb;
  return o;
}

fn spH2(p: vec2<f32>) -> f32 { return fract(sin(dot(p, vec2<f32>(127.1, 311.7))) * 43758.5453); }
fn spN2(p: vec2<f32>) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let s = f * f * (3.0 - 2.0 * f);
  return mix(mix(spH2(i), spH2(i + vec2<f32>(1.0, 0.0)), s.x), mix(spH2(i + vec2<f32>(0.0, 1.0)), spH2(i + vec2<f32>(1.0, 1.0)), s.x), s.y);
}

/** a face's horizontal coordinate along it (for courses of stone and tile) */
fn spAlong(p: vec3<f32>, n: vec3<f32>) -> f32 { return select(p.x, p.y, abs(n.x) > abs(n.y)); }

/** Courses of blocks: (mortar 0..1, the block's id hash) for rows `rh` high, blocks `bl` long, on a face. */
fn spCourses(along: f32, up: f32, rh: f32, bl: f32) -> vec2<f32> {
  let row = floor(up / rh);
  let off = select(0.0, 0.5, (i32(row) & 1) != 0);
  let col = floor(along / bl + off);
  let fu = fract(along / bl + off);
  let fv = fract(up / rh);
  let e = min(min(fu, 1.0 - fu) * bl, min(fv, 1.0 - fv) * rh);
  return vec2<f32>(1.0 - smoothstep(0.015, 0.035, e), spH2(vec2<f32>(row, col)));
}

/** The albedo of a part at a point (linear), from its palette colour and a pattern made in world space. */
fn spAlbedo(sv: SpVert, n: vec3<f32>) -> vec3<f32> {
  let p = sv.wpos;
  var c = sv.base;
  switch (sv.part) {
    case 0u: {
      // plaster: limewash, uneven; a little grime low on the storey
      c *= 0.9 + 0.14 * spN2(p.xy * 0.9 + vec2<f32>(p.z * 0.7, 0.0)) + 0.04 * spN2(p.xy * 6.0 + p.z * 5.0);
      c *= 1.0 - 0.1 * smoothstep(0.25, 0.0, sv.w);
    }
    case 4u: {
      // stone: coursed blocks, each its own shade, mortar between (tops: a grid)
      var m: vec2<f32>;
      if (abs(n.z) > 0.7) { m = spCourses(p.x, p.y, 0.55, 0.8); } else { m = spCourses(spAlong(p, n), p.z, 0.36, 0.7); }
      c *= (0.88 + 0.2 * m.y) * (1.0 - 0.38 * m.x);
      c *= 0.94 + 0.08 * spN2(p.xy * 2.0 + p.z);
    }
    case 2u: {
      // roof tiles: courses down the slope, each tile its own shade; moss where it's damp
      let row = floor(p.z * 4.2);
      let tile = floor(spAlong(p, vec3<f32>(n.x, n.y, 0.0)) * 3.0 + row * 0.5);
      let lap = fract(p.z * 4.2);
      c *= (0.78 + 0.24 * lap) * (0.9 + 0.16 * spH2(vec2<f32>(row, tile)));
      let moss = smoothstep(0.66, 0.86, spN2(p.xy * 0.6 + vec2<f32>(sv.seed * 17.0, 0.0)) * 0.6 + spN2(p.xy * 3.1) * 0.4);
      c = mix(c, vec3<f32>(0.045, 0.07, 0.02), moss * 0.5 * smoothstep(0.2, 0.7, n.z));
    }
    case 7u: {
      // cobbles: rows of rounded setts, dark joints
      let m = spCourses(p.x * 0.8 + p.y * 0.6, p.y * 0.8 - p.x * 0.6, 0.32, 0.42);
      c *= (0.82 + 0.3 * m.y) * (1.0 - 0.45 * m.x);
      c = mix(c, vec3<f32>(0.18, 0.24, 0.1), smoothstep(0.7, 0.9, spN2(p.xy * 0.6)) * 0.4);
    }
    case 3u: {
      // glass: dark, the sky in it by day
      c = mix(c, vec3<f32>(0.35, 0.45, 0.55), 0.25 + 0.2 * spN2(p.xy * 3.0 + p.z * 2.0));
    }
    case 1u, 5u, 6u: {
      // timber: grain along it
      c *= 0.86 + 0.16 * spN2(vec2<f32>(spAlong(p, n) * 0.8, p.z * 9.0));
    }
    case 12u: {
      c *= 0.75 + 0.4 * spN2(p.xy * 1.7);
    }
    default: {}
  }
  return c;
}

/** What glows (linear, added after lighting): windows lit at dusk and night (not all of them), lamps. */
fn spEmit(sv: SpVert) -> vec3<f32> {
  let night = hostNight();
  if (night <= 0.0) { return vec3<f32>(0.0); }
  if (sv.part == 3u) {
    let h = spHash(u32(sv.seed * 1048576.0));
    if ((h & 255u) < 150u) {
      let warm = vec3<f32>(1.0, 0.5, 0.17) * (0.8 + 0.5 * f32((h >> 8u) & 255u) / 255.0);
      return warm * night * 1.4;
    }
  }
  if (sv.part == 13u) { return vec3<f32>(1.0, 0.78, 0.45) * night * 3.0; }
  return vec3<f32>(0.0);
}
