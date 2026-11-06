// water.wgsl: glow and flow, water, streams, runs, glass and oil shading (part 6 of 7 of the renderWgsl shader, joined in order by render.ts)
/** (round 112, tilefix3) the render fields' z as the glow (0..1): a lava column's holds 2 + its heat (renderfields.wgsl) */
fn glowOf(z: f32) -> f32 { return select(z, z - 2.0, z >= 2.0); }

/** The water's flow at column j: with the field mesh renderfields stores
 *  it in x, w; without, packed in w (round 84: its heading and size — renderfields.wgsl packFlow). */
fn flowOf(j: u32) -> vec2<f32> {
  if ((u32(CAM.eye.w) & 2u) != 0u) { return vec2<f32>(fields[j].x, fields[j].w); }
  let w = fields[j].w;
  let a = floor(w) / 1024.0 * 6.2831853;
  return vec2<f32>(cos(a), sin(a)) * fract(w) * 8.0;
}

/**
 * Streaks carried along by the flow v (column flux, blended) at p, 0..1:
 * noise stretched along the flow and moved down it, in two phases half a
 * cycle apart that take turns (a flow map: each phase is pulled back before
 * it smears). The pace follows the water's speed, the flux over its depth.
 */
fn flowStreaks(p: vec2<f32>, v: vec2<f32>, d: f32) -> f32 {
  let sp = length(v);
  if (sp < 1e-4) { return 0.0; }
  let dir = v / sp;
  // cells a cycle: speed (flux / depth), held to a believable range
  let pace = min(sp / max(d, 0.06) * 6.0, 5.0);
  var s = 0.0;
  for (var k = 0; k < 2; k++) {
    let ph = fract(G.time * 0.5 + f32(k) * 0.5);
    let q = p - dir * pace * ph;
    let u = vec2<f32>(dot(q, dir), dot(q, vec2<f32>(-dir.y, dir.x)));
    s += (1.0 - abs(2.0 * ph - 1.0)) * vnoise(u * vec2<f32>(0.6, 1.9) + f32(k) * 17.0);
  }
  return s;
}

/**
 * Water's surface normal under the wind: a few travelling waves round the
 * local wind's direction (crests across it, longer ones faster), their
 * phases broken by noise, plus the catspaws of gusts (noise advected
 * downwind). Calm air or shallow water lies flatter (rough).
 */
fn windWaves(p: vec2<f32>, z: f32, rough: f32) -> vec3<f32> { return windWavesIn(p, windAt(vec3<f32>(p, z + 0.5)), rough); }
/** windWaves in the wind wv already looked up */
fn windWavesIn(p: vec2<f32>, wv: vec2<f32>, rough: f32) -> vec3<f32> {
  let lw = length(wv);
  let pw = vec2<f32>(G.windX, G.windY) + vec2<f32>(1e-4, 0.0);
  let wd = select(normalize(pw), wv / max(lw, 1e-4), lw > 0.05);
  let wp = vec2<f32>(-wd.y, wd.x);
  let t = G.time;
  // (in the wind's frame: a along it, c across)
  let a = dot(p, wd);
  let c = dot(p, wp);
  var g = vec2<f32>(0.0);
  let ang = vec3<f32>(-0.22, 0.0, 0.25);
  let kk = vec3<f32>(1.3, 2.3, 3.9);
  let amp = vec3<f32>(1.0, 0.6, 0.35);
  for (var i = 0; i < 3; i++) {
    let dir = vec2<f32>(cos(ang[i]), sin(ang[i]));
    // crests broken into lengths along themselves, set in patches
    let warp = vnoise(vec2<f32>(a * 0.25, c * 0.5) + f32(i) * 13.0) * 2.5;
    let gang = smoothstep(0.25, 0.75, vnoise(vec2<f32>(a * 0.3 - t * 0.4, c * 0.6) + f32(i) * 29.0));
    let ph = (a * dir.x + c * dir.y) * kk[i] - t * sqrt(kk[i]) * 2.2 + warp;
    g += (wd * dir.x + wp * dir.y) * kk[i] * amp[i] * gang * cos(ph);
  }
  let rp = windDrift(p) * 1.7;
  let cat = vec2<f32>(
    vnoise(rp + vec2<f32>(t * 0.7, 0.0)) - vnoise(rp + vec2<f32>(0.0, t * 0.6) + 31.0),
    vnoise(rp + vec2<f32>(0.0, -t * 0.8) + 7.0) - vnoise(rp + vec2<f32>(-t * 0.5, 0.0) + 19.0));
  return normalize(vec3<f32>(-g * 0.11 * rough + cat * rough * 0.15, 1.4));
}

@fragment
fn fsWater(in: VOut) -> FOut { return shadeWater(in); }

/** (watersurf) the surface's water: lit by its triangle's own normal (flat over it, as the sheet's was) */
@fragment
fn fsWaterSurf(in: VOut) -> FOut {
  var v = in;
  var n = normalize(cross(dpdx(in.wpos), dpdy(in.wpos)));
  if (n.z < 0.0) { n = -n; }
  v.nrm = n;
  return shadeWater(v);
}

/** the water's look (the prisms', the sheets', the surface's): called in uniform control flow (it takes derivatives) */
fn shadeWater(in: VOut) -> FOut {
  let cell = fragCell(in.wpos, in.nrm);
  let ci = colIdxI(cell);
  // smooth depth: rounded shorelines (round 12)
  let d = sheetDepth(in.wpos.xy, 1u);
  // derivatives must be taken in uniform control flow, before any branch
  let gl = gridLines(in.wpos, in.nrm);
  // the depth's slope across the map (it's linear over each triangle of
  // the centres): which way the shore is, and how far
  let ex = dpdx(in.wpos.xy);
  let ey = dpdy(in.wpos.xy);
  let ddx = dpdx(d);
  let ddy = dpdy(d);
  if (in.info.x == MAT_OIL) { return shadeOil(in, ci); }
  if ((in.info.y & FLAG_RUN) != 0u) { return shadeRun(in, ci); }
  if (MATS[in.info.x].look.y > 0.0) { return shadeGlass(in, ci); }
  if (in.nrm.z > 0.5 && d < 0.02) { discard; }
  let det = ex.x * ey.y - ex.y * ey.x;
  let dg = select(vec2<f32>(0.0), vec2<f32>(ddx * ey.y - ddy * ex.y, ddy * ex.x - ddx * ey.x) / det, abs(det) > 1e-9);
  let fv = flowOf(ci);
  let flow = length(fv);
  let deep = 1.0 - exp(-d * 0.45);
  var c = mix(vec3<f32>(0.30, 0.45, 0.44), vec3<f32>(0.07, 0.19, 0.25), deep);
  let conc = contam[ci].y / max(d, 0.05);
  c = mix(c, vec3<f32>(0.40, 0.37, 0.11), smoothstep(0.03, 0.8, conc) * 0.85);
  // sludge: thick, opaque, sickly olive-brown with a scummy mottle (an
  // obvious thing to wash away); fades back to water as it is diluted
  let sludge = smoothstep(0.9, 2.2, conc);
  // (watersurf: each term below is worked out only where it shows — the same picture, less of the cost: the
  // water's shading is most of its draw, a pixel at a time over the screen's water)
  if (sludge > 0.0) {
    let scum = smoothstep(0.55, 0.75, vnoise(wo(in.wpos.xy) * 1.3 + vec2<f32>(G.time * 0.03, 0.0)));
    let murk = vnoise(wo(in.wpos.xy) * 0.4 + 9.0);
    c = mix(c, mix(mix(vec3<f32>(0.13, 0.11, 0.06), vec3<f32>(0.2, 0.16, 0.08), murk), vec3<f32>(0.44, 0.42, 0.1), scum * 0.8), sludge);
  }
  var col = toLinear(c) * lighting(in.wpos, in.nrm);
  var alpha = mix(mix(0.5, 0.9, deep), 0.97, sludge) * smoothstep(WATER_MIN_R, 0.08, d);

  if (in.nrm.z > 0.5) {
    // ripples + sun glint
    let t = G.time;
    // ripples ride the wind: the pattern is advected downwind and roughens
    // with the local wind, so gusts and drags send catspaws across the water
    let wv = windAt(vec3<f32>(in.wpos.xy, in.wpos.z + 0.5));
    let lw = length(wv);
    // (shallow puddles lie still: the ripples fade out below ~0.7 deep)
    let rough = (0.5 + clamp(lw / 5.0, 0.0, 2.0)) * smoothstep(0.1, 0.7, d);
    // (the waves' crests lie across the wind: round 41)
    var nn = vec3<f32>(0.0, 0.0, 1.0);
    if (rough > 0.0) { nn = windWavesIn(in.wpos.xy, wv, rough); }
    // (round 83) the swell off the shore: its slope across the crests tilts the surface
    let sw = swellAt(in.wpos.xy, cell, flow, clamp(lw / 4.0, 0.0, 1.0));
    nn = normalize(nn + vec3<f32>(sw.dir * sw.amp * 0.3 * sw.slope, 0.0));
    // Stylised for the fixed view: ripple slopes facing the sun brighten, and the
    // half-vector is biased toward vertical so glints appear on ordinary
    // ripples instead of only at one viewing angle.
    let sunL = sunDir();
    let shade = 1.0 + dot(nn.xy, normalize(sunL.xy)) * 0.45;
    let h = normalize(normalize(sunL + toEye(in.wpos)) + vec3<f32>(0.0, 0.0, 1.6));
    let spec = pow(max(dot(nn, h), 0.0), 160.0) * (1.0 - cloudShade(in.wpos.xy)) * (1.0 - sludge * 0.8);
    col *= mix(shade, 1.0, sludge * 0.7);
    col += G.sunCol.rgb * (1.0 / 2.4) * spec * 0.7;
    // slow bubbles rising through the sludge
    if (sludge > 0.0) {
    let bub = vec3<i32>(vec2<i32>(floor(wo(in.wpos.xy) * 2.5)), i32(floor(t * 0.8 + randv(vec3<i32>(vec2<i32>(floor(wo(in.wpos.xy) * 2.5)), 3)) * 7.0)));
    let bf = fract(wo(in.wpos.xy) * 2.5) - 0.5;
    col += vec3<f32>(0.05, 0.05, 0.01) * sludge * step(0.93, randv(bub)) * step(length(bf), 0.32) * (1.0 - 0.8 * G.sky.w);
    }
    // foam where flowing fast
    // (on the field mesh smooth, in streaks down the flow; on the prisms in cells)
    let meshOn = (u32(CAM.eye.w) & 2u) != 0u;
    // (round 84, ?rivers=table: by the water's speed, not its net flow — a deep river held at the atlas's table
    // carries a lot without being fast; it foams where it runs fast, at its rapids)
    var foam = smoothstep(0.03, 0.25, select(flow, flow / max(d, 0.15) * 0.4, RIVER_FOAM_SPEED));
    if (foam > 0.0) {
      let sub = vec3<i32>(floor(vec3<f32>(wo(in.wpos.xy) * 4.0, t * 6.0)));
      var fleck = step(0.72, randv(sub));
      // (round 84: the flow's heading is known without the field mesh too — renderfields.wgsl packFlow)
      if (meshOn || flow > 1e-4) { fleck = smoothstep(0.62, 0.85, flowStreaks(wo(in.wpos.xy) * 1.7, fv, d)); }
      foam *= fleck;
    }
    col = mix(col, vec3<f32>(0.85, 0.85, 0.8), foam * 0.6);
    alpha = max(alpha, foam * 0.7);
    // a fall (round 69: the atlas's rivers over cliffs): water steep down a face is white water,
    // streaks of it running down
    let steepW = 1.0 - smoothstep(0.25, 0.7, in.nrm.z);
    if (steepW > 0.0) {
      let lane = randv(vec3<i32>(vec2<i32>(floor(wo(in.wpos.xy) * 1.5)), 9));
      let streak = smoothstep(0.3, 0.85, fract(in.wpos.z * 0.22 + t * 1.6 + lane)) * (0.6 + 0.4 * vnoise(wo(in.wpos.xy) * 3.0 + vec2<f32>(0.0, in.wpos.z * 0.5 + t * 4.0)));
      col = mix(col, vec3<f32>(0.88, 0.9, 0.9) * (1.0 - 0.7 * G.sky.w), steepW * (0.5 + 0.45 * streak));
      alpha = max(alpha, steepW * (0.72 + 0.25 * streak));
    }
    // the flow's streaks (round 84: with or without the field mesh — both know its heading)
    if (flow > 0.005) {
      let st = flowStreaks(in.wpos.xy, fv, d) * smoothstep(0.005, 0.06, flow) * (1.0 - sludge);
      col += vec3<f32>(0.10, 0.12, 0.12) * smoothstep(0.55, 0.9, st) * (1.0 - 0.7 * G.sky.w);
    }
    // the shore (round 83: the shore field): the swell's crests catch the light, and break into foam in the
    // last few cells — more in the wind
    col *= 1.0 + 0.12 * sw.amp * sw.h;
    let brk = sw.amp * smoothstep(7.0, 1.0, sw.dist) * smoothstep(0.55, 0.95, sw.crest) * smoothstep(0.012, 0.03, d);
    if (brk > 0.0) {
      let froth = smoothstep(0.3, 0.65, vnoise(wo(in.wpos.xy) * 2.2 + vec2<f32>(t * 0.35, -t * 0.2)));
      let sf = brk * (1.0 - sludge * 0.7) * (0.55 + 0.45 * froth);
      col = mix(col, vec3<f32>(0.82, 0.84, 0.82) * (1.0 - 0.75 * G.sky.w), sf * 0.75);
      alpha = max(alpha, sf * 0.85);
    }
    // rain rings (none where no rain falls: a drop shows where a random under the rain's share falls)
    let rain = rainAt(in.wpos.xy);
    if (rain <= 0.0) {
    } else if (meshOn) {
      // (on the field mesh: rings spreading from each drop, a third of a
      // cell apart, each cell's drops at its own times)
      let rc = vec2<i32>(floor(wo(in.wpos.xy) * 3.0));
      let rf = fract(wo(in.wpos.xy) * 3.0) - 0.5;
      let rt = t * 2.5 + randv(vec3<i32>(rc, 5));
      let rr = fract(rt) * 0.5;
      let ring = smoothstep(0.07, 0.0, abs(length(rf) - rr)) * (1.0 - rr * 2.0);
      col += vec3<f32>(0.3) * (1.0 - 0.8 * G.sky.w) * ring * step(1.0 - 0.25 * min(rain, 3.0), randv(vec3<i32>(rc, i32(floor(rt)))));
    } else {
      let rsub = vec3<i32>(floor(vec3<f32>(wo(in.wpos.xy) * 3.0, t * 10.0)));
      col += vec3<f32>(0.25) * (1.0 - 0.8 * G.sky.w) * step(1.0 - 0.06 * rain, randv(rsub));
    }
  }
  // (round 50) in the freezing cold a skin of ice over it: frosted, pale,
  // still, cracked — climate.wgsl freezes the water itself from its bed up
  let frost = smoothstep(-0.5, -3.0, airTempAt(in.wpos.z)) * select(0.6, 1.0, in.nrm.z > 0.5);
  if (frost > 0.0) {
    let cr = vnoise(wo(in.wpos.xy) * 1.7 + 3.0);
    let crack = smoothstep(0.03, 0.0, abs(cr - 0.5)) * 0.6;
    let frosted = toLinear(vec3<f32>(0.78, 0.86, 0.9) * (0.88 + 0.12 * vnoise(wo(in.wpos.xy) * 4.0))) * lighting(in.wpos, in.nrm);
    col = mix(col, frosted * (1.0 - crack * 0.35), frost * 0.85);
    alpha = mix(alpha, 0.92, frost);
  }
  col *= 1.0 - gl * 0.3;
  col = haze(col, in.wpos);
  var o: FOut;
  o.color = vec4<f32>(toSrgb(col), alpha);
  o.pick = vec2<u32>(pickCol(ci), pickInfo(in.info.x, in.wpos.z, in.info.y));
  return o;
}

// (watersurf, ?skip=waterflat) the water's shading left out, its geometry kept: what the water's draw costs without
// fsWater's look (vertices, raster, blend) — a measuring aid
@fragment
fn fsWaterFlat(in: VOut) -> FOut {
  var o: FOut;
  o.color = vec4<f32>(0.1, 0.3, 0.4, 0.7);
  o.pick = vec2<u32>(0u, 0u);
  return o;
}

const WATER_MIN_R: f32 = 0.012;

// (?flow=1, flow/liquid.ts) a liquid run of the flow module: flat prisms under rock, narrow boxes for the falling
// streams (FLAG_DETAIL), drawn blended
const FLAG_RUN: u32 = 2048u;

/** the simulation's time (s): what the flows' looks scroll by - paused, they stand; at any tick rate, as the sim */
fn simTime() -> f32 { return f32(G.tick) * G.dt; }

/**
 * (round 86) A stream's sheet: its pattern rides the water - a point of it is (time along the path - the sim's
 * time), constant for a parcel of water - so the streaks fall at the fall's own speed and stretch as it speeds up.
 * Glassy where it leaves the lip, aerated white the longer it falls, ragged at its edges and breaking up below.
 */
fn shadeStream(in: VOut, ci: u32) -> FOut {
  let e = in.bmin;
  let u = in.boff.xy;
  let vz = in.boff.z;
  let t = in.tint;
  let tl = in.zr.x + t;
  let axis = streamAt(e, u, vz, t);
  let side = vec3<f32>(streamSide(u), 0.0);
  let tg = normalize(vec3<f32>(u, vz - worldG() * t) + vec3<f32>(0.0, 0.0, -1e-4));
  let band = in.bsize.z > 0.5;
  let nArc = normalize(cross(tg, side));
  let acr = select(side, nArc, band);
  let wd = streamWidth(in.zr.y, tl);
  let hw = select(wd.x, wd.y, band) * 0.5;
  let x = dot(in.wpos - axis, acr);
  let xn = x / max(hw, 1e-3);
  // (lit by the path's own normal, not the triangles': no facets along it)
  var nrm = select(nArc, side, band);
  if (dot(nrm, toEye(in.wpos)) < 0.0) { nrm = -nrm; }
  // (faded in and out over the bits drawn before its entry and past its exit: neighbours' sum to one)
  let ext = in.bsize.y;
  let lead = smoothstep(-ext, ext, t) * (1.0 - smoothstep(in.bsize.x - ext, in.bsize.x + ext, t));
  let ph = tl - simTime();
  // (lanes across it in world units: the curtain's neighbours line up)
  let lx = select(dot(in.wpos.xy, side.xy), x, band);
  let n1 = vnoise(vec2<f32>(lx * 2.5, ph * 5.0));
  let n2 = vnoise(vec2<f32>(lx * 7.0 + 3.1, ph * 11.0));
  let st = n1 * 0.6 + n2 * 0.4;
  var col: vec3<f32>;
  var alpha: f32;
  if (in.info.x == MAT_LAVA_M) {
    let glow = 0.5 + 0.5 * vnoise(vec2<f32>(lx * 3.0, ph * 4.0));
    col = toLinear(vec3<f32>(1.0, 0.4, 0.07)) * (1.4 + 1.4 * glow) + toLinear(vec3<f32>(0.25, 0.05, 0.02)) * lighting(in.wpos, nrm);
    alpha = 0.97 * (1.0 - smoothstep(0.75, 1.0, abs(xn))) * lead;
  } else {
    let aer = smoothstep(0.0, 0.9, tl);
    let glassy = toLinear(vec3<f32>(0.33, 0.52, 0.58));
    let white = toLinear(vec3<f32>(0.93, 0.95, 0.96));
    let streak = smoothstep(0.45, 0.8, st);
    col = mix(glassy, white, clamp(0.2 + 0.55 * aer + 0.4 * streak, 0.0, 1.0)) * (0.72 + 0.4 * n1) * lighting(in.wpos, nrm);
    // (a glint down the glassy part, where it's smooth)
    col += toLinear(vec3<f32>(0.5, 0.55, 0.6)) * (1.0 - aer) * smoothstep(0.72, 0.9, n2) * 0.5 * (1.0 - 0.8 * G.sky.w);
    let ragged = abs(xn) + (n1 - 0.5) * 0.5;
    let edge = 1.0 - smoothstep(0.6, 1.0, ragged);
    // (breaking up as it falls: gaps open in the sheet lower down)
    let holes = smoothstep(0.15, 0.4, st + 0.45 * (1.0 - aer));
    // (a trickle faint: what a column carries decides how much it shows)
    alpha = (0.6 + 0.3 * streak) * edge * mix(1.0, holes, 0.3 * aer) * smoothstep(0.03, 0.8, in.zr.y) * lead;
  }
  if (alpha < 0.01) { discard; }
  col = haze(col, in.wpos);
  var o: FOut;
  o.color = vec4<f32>(toSrgb(col), alpha);
  o.pick = vec2<u32>(pickCol(ci), pickInfo(in.info.x, in.wpos.z, in.info.y));
  return o;
}

/** A flow-module liquid run under rock: dark water; lava glowing. (Streams: shadeStream.) */
fn shadeRun(in: VOut, ci: u32) -> FOut {
  if ((in.info.y & FLAG_DETAIL) != 0u) { return shadeStream(in, ci); }
  var col: vec3<f32>;
  var alpha: f32;
  if (in.info.x == MAT_LAVA_M) {
    let glow = 0.5 + 0.5 * vnoise(wo(in.wpos.xy) * 2.0 + vec2<f32>(0.0, simTime() * 2.0));
    col = toLinear(vec3<f32>(1.0, 0.4, 0.07)) * (1.4 + 1.4 * glow) + toLinear(vec3<f32>(0.25, 0.05, 0.02)) * lighting(in.wpos, in.nrm);
    alpha = 0.97;
  } else {
    col = toLinear(vec3<f32>(0.1, 0.24, 0.29)) * lighting(in.wpos, in.nrm);
    alpha = 0.82;
  }
  col = haze(col, in.wpos);
  var o: FOut;
  o.color = vec4<f32>(toSrgb(col), alpha);
  o.pick = vec2<u32>(pickCol(ci), pickInfo(in.info.x, in.wpos.z, in.info.y));
  return o;
}


/**
 * See-through solids (round 50): ice and crystal, drawn blended with the
 * liquids. Each face is broken into tilted triangular facets (a coarse
 * lattice across it, a random tilt each), so the light catches them one by
 * one: a sharp sun glint, a rim brighter at grazing angles, darker toward
 * the base (the depth of the body seen through), bright facet edges.
 * Crystal glows faintly of its own, more at night, each column a shade of
 * violet, cyan or rose.
 */
fn shadeGlass(in: VOut, ci: u32) -> FOut {
  let m = in.info.x;
  let crystal = m == MAT_CRYSTAL;
  var alb = toLinear(MATS[m].albedo.rgb);
  let hc = randv(vec3<i32>(i32(ci), 11, 3));
  if (crystal) { alb = mix(mix(alb, toLinear(vec3<f32>(0.45, 0.85, 0.92)), smoothstep(0.4, 0.7, hc)), toLinear(vec3<f32>(0.95, 0.55, 0.75)), smoothstep(0.75, 0.95, hc)); }
  let n0 = normalize(in.nrm);
  let t = normalize(cross(n0, select(vec3<f32>(0.0, 0.0, 1.0), vec3<f32>(1.0, 0.0, 0.0), abs(n0.z) > 0.9)));
  let bt = cross(n0, t);
  let fp = in.wpos * select(1.4, 2.2, crystal);
  let uv = vec2<f32>(dot(fp, t), dot(fp, bt));
  // (a triangle lattice: skewed square cells, each cut in two)
  let sk = vec2<f32>(uv.x + uv.y * 0.57735, uv.y * 1.1547);
  let cid = vec2<i32>(floor(sk));
  let fr = fract(sk);
  let tri = select(0, 1, fr.x + fr.y > 1.0);
  let h1 = randv(vec3<i32>(cid, tri + i32(ci % 97u) * 2));
  let h2 = randv(vec3<i32>(cid + vec2<i32>(17, 5), tri));
  let tilt = (vec2<f32>(h1, h2) - 0.5) * select(0.5, 0.9, crystal);
  let n = normalize(n0 + t * tilt.x + bt * tilt.y);
  let V = normalize(toEye(in.wpos));
  let fres = pow(1.0 - clamp(dot(n, V), 0.0, 1.0), 3.0);
  let L = sunDir();
  let hv = normalize(L + V);
  let spec = pow(max(dot(n, hv), 0.0), 80.0) * (1.0 - cloudShade(in.wpos.xy));
  let depth = clamp((in.zr.y - in.wpos.z) / max(in.zr.y - in.zr.x, 0.3), 0.0, 1.0);
  var col = alb * lighting(in.wpos, n) * mix(1.0, 0.6, depth) * (0.8 + 0.4 * h1);
  col += alb * MATS[m].albedo.w * (0.7 + 0.3 * sin(G.time * 1.3 + h1 * 6.28)) * (0.5 + 0.8 * G.sky.w);
  col += G.sunCol.rgb * (1.0 / 2.4) * spec * 1.4;
  col += vec3<f32>(0.75, 0.85, 1.0) * fres * 0.3 * (1.0 - 0.6 * G.sky.w);
  // (the facets' edges catch the light)
  let edge = min(min(fr.x, fr.y), abs(1.0 - fr.x - fr.y));
  col += alb * smoothstep(0.05, 0.0, edge) * 0.3;
  let alpha = clamp(select(0.4, 0.55, crystal) + fres * 0.35 + spec * 0.5, 0.0, 0.95);
  col = haze(col, in.wpos);
  var o: FOut;
  o.color = vec4<f32>(toSrgb(col), alpha);
  o.pick = vec2<u32>(pickCol(ci), pickInfo(m, in.wpos.z, in.info.y));
  return o;
}

/** Oil: near-black, glossy, with a slow thin-film rainbow sheen on top. */
fn shadeOil(in: VOut, ci: u32) -> FOut {
  let d = in.zr.y - in.zr.x;
  var c = toLinear(vec3<f32>(0.08, 0.065, 0.05));
  var col = c * lighting(in.wpos, in.nrm);
  if (in.nrm.z > 0.5) {
    let n = vnoise(wo(in.wpos.xy) * 0.45 + vec2<f32>(G.time * 0.04, -G.time * 0.03)) * 2.0 + vnoise(wo(in.wpos.xy) * 1.3) * 0.6;
    // cosine palette ≈ thin-film interference colours
    let film = 0.5 + 0.5 * cos(6.2831 * (vec3<f32>(n) + vec3<f32>(0.0, 0.33, 0.67)));
    col += toLinear(film) * 0.035 * (1.0 - cloudShade(in.wpos.xy));
    let h = normalize(normalize(sunDir() + toEye(in.wpos)) + vec3<f32>(0.0, 0.0, 1.6));
    let spec = pow(max(h.z, 0.0), 30.0) * 0.25;
    col += G.sunCol.rgb * (1.0 / 2.4) * spec;
  }
  col = haze(col, in.wpos);
  var o: FOut;
  o.color = vec4<f32>(toSrgb(col), clamp(0.55 + d * 3.0, 0.55, 0.96));
  o.pick = vec2<u32>(pickCol(ci), pickInfo(in.info.x, in.wpos.z, in.info.y));
  return o;
}

