// ---- atlas/view.wgsl ------------------------------------------------------
// The atlas viewer (round 67): every pixel evaluates the same ground as the
// streamer's columns (compose.wgsl), from the whole world down to a cell, in
// one of several modes (AP.mode): 0 the ground (hillshade, height colours),
// 1 regions, 2 kinds, 3 the regions' borders (their distance field), 4 the
// coast's distance field, 5 climate, 6 the pattern alone, 7 caves, 8 the
// landforms (round 78: lowland green, upland olive, plateau ochre, massif
// grey; contours every 20, the landforms' edges dark).

/** the viewer's colour for each kind (regions.ts KINDS) */
@group(0) @binding(24) var<storage, read> kcol: array<vec4<f32>>;

struct VOut {
  @builtin(position) pos: vec4<f32>,
}

@vertex
fn vs(@builtin(vertex_index) i: u32) -> VOut {
  let uv = vec2<f32>(f32((i << 1u) & 2u), f32(i & 2u));
  var o: VOut;
  o.pos = vec4<f32>(uv * 2.0 - 1.0, 0.0, 1.0);
  return o;
}

fn hue(h: u32) -> vec3<f32> {
  let a = hf(pcg(h + 1u));
  return 0.35 + 0.55 * vec3<f32>(hf(pcg(h * 3u + 7u)), hf(pcg(h * 5u + 11u)), a);
}

/** round 78: the land's colour up the whole height (the landforms reach ~300 over the sea), snow where it's
 *  below freezing (compose.wgsl temperature) */
fn terrainColourAt(h: f32, p: vec2<f32>) -> vec3<f32> {
  let d = h - AP.sea;
  if (d < 0.0) { return mix(vec3<f32>(0.2, 0.42, 0.62), vec3<f32>(0.04, 0.12, 0.3), clamp(-d / 20.0, 0.0, 1.0)); }
  if (temperature(p, h) < 0.0) { return vec3<f32>(0.93, 0.94, 0.97); }
  if (d < 2.0) { return vec3<f32>(0.82, 0.76, 0.56); }
  if (d < 40.0) { return mix(vec3<f32>(0.4, 0.58, 0.3), vec3<f32>(0.56, 0.6, 0.34), d / 40.0); }
  if (d < 120.0) { return mix(vec3<f32>(0.56, 0.6, 0.34), vec3<f32>(0.66, 0.54, 0.38), (d - 40.0) / 80.0); }
  return mix(vec3<f32>(0.66, 0.54, 0.38), vec3<f32>(0.6, 0.58, 0.58), clamp((d - 120.0) / 120.0, 0.0, 1.0));
}
fn terrainColour(h: f32) -> vec3<f32> { return terrainColourAt(h, vec2<f32>(0.0, AP.worldH * 0.25)); }

/** light on the ground from its slope across the pixel (screen derivatives: ground() once a pixel) */
fn shadeOf(h: f32, dhx: f32, dhy: f32) -> f32 {
  let e = AP.vscale;
  let n = normalize(vec3<f32>(-dhx / e, -dhy / e, 1.0));
  return clamp(dot(n, normalize(vec3<f32>(-0.6, -0.5, 0.8))), 0.0, 1.0) * 0.75 + 0.3;
}

@fragment
fn fs(v: VOut) -> @location(0) vec4<f32> {
  let size = vec2<f32>(AP.worldW, AP.worldH);
  var p = AP.vc + (v.pos.xy - AP.vsize * 0.5) * AP.vscale;
  p = p - floor(p / size) * size;
  let g = ground(p);
  // (derivatives in uniform control flow, before the modes branch)
  let sh = shadeOf(g.h, dpdx(g.h), dpdy(g.h));
  let fwh = fwidth(g.h);
  var c = vec3<f32>(0.0);
  switch AP.mode {
    case 0u: {
      c = terrainColourAt(g.h, p) * select(1.0, sh, g.h >= AP.sea);
      // (round 78: an oddity in its own colour — quartz, granite, coral, flesh)
      if (g.smat == 36u) { c = vec3<f32>(0.82, 0.78, 0.98) * sh; }
      if (g.smat == 1u) { c = vec3<f32>(0.62, 0.6, 0.58) * sh; }
      if (g.smat == 34u) { c = vec3<f32>(0.9, 0.55, 0.6) * sh; }
      if (g.smat == 33u) { c = vec3<f32>(0.75, 0.32, 0.3) * sh; }
      // (rivers: blue, lava: orange)
      if (g.rx < 1.0 && g.h >= AP.sea) { c = select(vec3<f32>(0.2, 0.42, 0.7), vec3<f32>(1.0, 0.45, 0.1), g.rflags == 1u) * mix(1.0, sh, 0.5); }
      // (round 71: the coarse world — set lava's basalt dark, ash grey, rubble brown, running lava glowing)
      if (g.cap != 0u) { c = vec3<f32>(0.16, 0.15, 0.16) * sh; }
      if (g.loose > 0.05) {
        let lc = select(vec3<f32>(0.5, 0.44, 0.38), vec3<f32>(0.62, 0.6, 0.58), g.lmat == 17u);
        c = mix(c, lc * sh, clamp(g.loose * 1.5, 0.0, 1.0));
      }
      if (g.clava > 0.05) { c = mix(c, vec3<f32>(1.0, 0.4, 0.06), clamp(g.clava, 0.0, 1.0)); }
    }
    case 1u: {
      c = hue(g.a) * sh;
    }
    case 2u: {
      c = kcol[regs[g.a].kind].rgb * sh;
    }
    case 3u: {
      let s = macroAt(p).s;
      let band = 0.5 + 0.5 * cos(s / 12.0 * 6.2831853);
      c = mix(hue(g.a) * 0.6, vec3<f32>(1.0), band * 0.35);
      if (abs(s) < max(AP.vscale, 0.6)) { c = vec3<f32>(0.05); }
    }
    case 4u: {
      let s = g.coast;
      let band = 0.5 + 0.5 * cos(s / 40.0 * 6.2831853);
      c = select(vec3<f32>(0.15, 0.3, 0.6), vec3<f32>(0.5, 0.6, 0.3), s > 0.0) * (0.7 + 0.3 * band);
    }
    case 5u: {
      let t = clamp((temperature(p, g.h) + 10.0) / 40.0, 0.0, 1.0);
      let m = moistureAt(p, g.coast, regs[g.a].moist);
      c = vec3<f32>(t, 0.25 + 0.4 * m * (1.0 - t * 0.5), m) * select(0.55, 1.0, g.h >= AP.sea);
    }
    case 6u: {
      c = vec3<f32>(0.5 + 0.5 * g.pv) * select(0.5, 1.0, regs[g.a].pattern != 0u);
    }
    case 7u: {
      let cv = caves(p, g.h - 1.0, regs[g.a]);
      let cav = cavernAt(p, g);
      let open = (cv.y - cv.x) + (cv.w - cv.z) + max(cav.y - cav.x, 0.0);
      c = mix(terrainColour(g.h) * 0.4, vec3<f32>(1.0, 0.8, 0.3), clamp(open / 12.0, 0.0, 1.0));
    }
    default: {
      let A = regs[g.a];
      if (!isLand(A)) {
        c = vec3<f32>(0.16, 0.3, 0.5);
      } else {
        var tc = array<vec3<f32>, 4>(vec3<f32>(0.45, 0.62, 0.36), vec3<f32>(0.62, 0.62, 0.38), vec3<f32>(0.82, 0.6, 0.36), vec3<f32>(0.66, 0.64, 0.66));
        c = tc[min(A.tier, 3u)] * sh;
        // contours every 20 above the sea
        let cl = (g.h - AP.sea) / 20.0;
        let fw = max(fwh / 20.0, 1e-4);
        // (only where the lines are resolved: a contour every few pixels at least)
        if (fw < 0.12) { c *= 1.0 - 0.35 * (1.0 - smoothstep(0.0, fw * 1.5, abs(cl - round(cl)))); }
        if (macroAt(p).dl < max(AP.vscale * 1.5, 1.0)) { c *= 0.35; }
      }
    }
  }
  return vec4<f32>(c, 1.0);
}
