// light.wgsl: FOut, colour space, the sun and the cover, lighting, haze, the grid lines, the canopy march (part 3 of 7 of the renderWgsl shader, joined in order by render.ts)
struct FOut {
  @location(0) color: vec4<f32>,
  // pick: x = column+1 (0 = nothing), y = material | z<<8 | flags<<16
  @location(1) pick: vec2<u32>,
};

fn toLinear(c: vec3<f32>) -> vec3<f32> { return pow(c, vec3<f32>(2.2)); }

/**
 * Snow or dust lying on a structure's face (round 52; structtick.wgsl keeps
 * it): cover 0..1, over the faces that look up, ragged at its thin edge
 * (sub: a 0..1 per-fragment dither), with a lip of it hanging over the
 * sides near the top (ztop: the voxel's top, roughly). The albedo in, out.
 */
fn coverLook(alb: vec3<f32>, nrm: vec3<f32>, wpos: vec3<f32>, ztop: f32, cover: f32, dusty: bool, sub: f32) -> vec3<f32> {
  if (cover <= 0.0) { return alb; }
  let onTop = nrm.z > 0.5 && cover > 0.03 + 0.5 * sub * (1.0 - cover);
  let lip = nrm.z > -0.2 && nrm.z <= 0.5 && cover > 0.45 && wpos.z > ztop - 0.18 * cover * (0.6 + 0.8 * sub);
  if (!onTop && !lip) { return alb; }
  let c = select(vec3<f32>(0.86, 0.88, 0.93), vec3<f32>(0.6, 0.53, 0.43), dusty);
  // (dust thin over it lets the face show through)
  let k = select(1.0, smoothstep(0.03, 0.4, cover), dusty);
  return mix(alb, toLinear(c) * (0.94 + 0.12 * sub), k);
}

fn toSrgb(c: vec3<f32>) -> vec3<f32> { return pow(clamp(c, vec3<f32>(0.0), vec3<f32>(1.0)), vec3<f32>(1.0 / 2.2)); }

/** Column whose fields describe this fragment (step slightly into the surface). */
fn fragCell(wpos: vec3<f32>, nrm: vec3<f32>) -> vec2<i32> {
  return clampCell(cellAt(wpos.xy - nrm.xy * 0.01));
}

/** A face's own 2D coordinates: tops their xy, sides along the wall and up. */
fn faceUV(wpos: vec3<f32>, nrm: vec3<f32>) -> vec2<f32> {
  if (abs(nrm.z) > 0.5) { return wpos.xy; }
  return vec2<f32>(dot(wpos.xy, normalize(vec2<f32>(-nrm.y, nrm.x))), wpos.z);
}

/** The box offset used by the sub-voxel march (only meaningful for rigid canopies). */
fn swayOffsetRigid(b: Box, off: vec3<f32>) -> vec3<f32> {
  if (b.mat == MAT_LEAVES && b.sx > 1.5) { return off; }
  return vec3<f32>(0.0);
}

/**
 * A smooth top's normal at xy: the fitted planes (renderfields.wgsl) of the
 * three cells round it, blended barycentrically over the triangle lattice of
 * centres — so light runs smoothly across the cells instead of each hexagon
 * taking its own flat normal (which is what made the hexes read). A cell
 * whose top of this kind stands far from mine (a step, another level) is left
 * out: its slope isn't this surface's.
 */
fn smoothNormal(xy: vec2<f32>, cell: vec2<i32>, kind: u32) -> vec3<f32> {
  let own = planeAt(cell, kind);
  let t = triAt(xy);
  var g = vec2<f32>(0.0);
  var ws = 0.0;
  for (var k = 0; k < 3; k++) {
    let pl = planeAt(clampCell(t.c[k]), kind);
    if (abs(pl.c - own.c) > 1.2) { continue; }
    g += t.w[k] * pl.g;
    ws += t.w[k];
  }
  if (ws < 1e-3) { return normalize(vec3<f32>(-own.g, 1.0)); }
  return normalize(vec3<f32>(-g / ws, 1.0));
}

fn sunDir() -> vec3<f32> { return normalize(vec3<f32>(G.sunX, G.sunY, G.sunZ)); }

/**
 * Direct-light visibility 0..1. Tops blend the shadow test of the three
 * nearest columns of similar height (barycentric), so shadow edges are soft and
 * slide smoothly across the ground as the sun moves instead of stepping a
 * whole cell at a time. Side faces use their own column.
 */
fn sunLit(wpos: vec3<f32>, nrm: vec3<f32>, sc: vec2<i32>) -> f32 {
  let own = select(0.0, 1.0, wpos.z >= fields[colIdxI(sc)].x - 0.05);
  if (nrm.z < 0.5) { return own; }
  let t = triAt(wpos.xy);
  var acc = 0.0;
  var wsum = 0.0;
  for (var k = 0; k < 3; k++) {
    let q = clampCell(t.c[k]);
    let j = colIdxI(q);
    // only neighbours at or a little below this height: a higher neighbour is
    // a step/wall beside us (its own top is no shadow test for this point),
    // and one far below is a different level
    let nz = f32(sfZ(surface[j]));
    // (slack: soft ground is drawn sloped up to ~1 cell from its whole-cell top)
    if (nz > wpos.z + 1.05 || nz < wpos.z - 1.5) { continue; }
    let wgt = t.w[k];
    acc += wgt * select(0.0, 1.0, wpos.z >= fields[j].x - 0.9);
    wsum += wgt;
  }
  if (wsum < 1e-3) { return own; }
  return smoothstep(0.1, 0.9, acc / wsum);
}

/**
 * (round 117, terrain track — a shared-renderer tweak for consolidation) How far under cover a point is: 0 under the
 * open sky; toward 1 deep in a cave. A point is under cover when its column (the one its face looks out to) has its top
 * above it — a cave's floor or wall, the ground under an overhang or a deck; how deep, by how many of eight columns
 * round it, 3 and 7 cells out, are roofed over it too. The sky's light and the bounce fade with it, so a cave's mouth
 * reads dark from above instead of lit like open ground (the user: "Caves should have ground level openings", "vast
 * chambers … crumbling ceilings with beams of light" — the shafts later). One surface read for open ground; nine under a
 * roof. Past the window (the tiles): none (they're tops).
 */
fn underCover(wpos: vec3<f32>, nrm: vec3<f32>) -> f32 {
  let c = cellAt(wpos.xy + nrm.xy * 0.6);
  if (!inMap(c)) { return 0.0; }
  if (wpos.z > sfZ(surface[colIdxI(c)]) - 1.0) { return 0.0; }
  var n = 1.0;
  for (var k = 0; k < 8; k++) {
    let a = f32(k) * 0.7853982;
    let r = select(3.0, 7.0, (k & 1) == 1);
    let q = cellAt(wpos.xy + vec2<f32>(cos(a), sin(a)) * r);
    if (inMap(q) && sfZ(surface[colIdxI(q)]) > wpos.z + 1.0) { n += 1.0; }
  }
  return n / 9.0;
}

/** (ground branch) the light falling on a point, in parts: what lights it from all round (the sky, the bounce: the
 *  ambient occlusion's to darken), what comes on its own (lightning, fire), and the sun's colour as it arrives here
 *  (shadow, cloud, cover) — its angle not yet in (lightSurf, lighting) */
struct Light { amb: vec3<f32>, own: vec3<f32>, sun: vec3<f32> };

fn lightAt(wpos: vec3<f32>, nrm: vec3<f32>) -> Light {
  let sun = sunDir();
  let sc = clampCell(cellAt(wpos.xy + nrm.xy * 0.5));
  // (with the field mesh, from the shadow map; without, the heightfield march)
  var lit: f32;
  // (perfopt, ?nodetail=shadow: eye.w bit 7 — no shadow lookups, every draw's)
  if (((u32(CAM.eye.w) >> 2u) & 32u) != 0u) { lit = 1.0; }
  else if ((u32(CAM.eye.w) & 2u) != 0u) { lit = shadowLit(wpos, nrm); } else { lit = sunLit(wpos, nrm, sc); }
  // storm shade, and the light shadow of passing fair-weather clouds
  let cloud = max(cloudShade(wpos.xy), fairCloud(wpos.xy) * 0.22);
  // light comes from the day/night cycle (src/weather/daynight.ts)
  let sunCol = G.sunCol.rgb;
  let sky = G.sky.rgb;
  let day = 1.0 - G.sky.w;
  // storm shade: a dark, unmistakable shadow (it marks where lightning can
  // strike; DECISIONS round 5 asked for it darker again)
  let ambient = sky * (0.5 + 0.5 * nrm.z) * (1.0 - cloud * 0.42);
  // warm bounce light from the opposite side keeps shaded faces readable
  let fill = max(dot(nrm, normalize(vec3<f32>(-sun.x, -sun.y, 0.4))), 0.0) * vec3<f32>(0.42, 0.36, 0.29) * (1.0 - cloud * 0.42) * (0.15 + 0.85 * day);
  // lightning lights the whole scene, cold blue-white, every face
  let flash = G.misc.z * vec3<f32>(2.4, 2.6, 3.3) * (0.75 + 0.25 * nrm.z);
  // firelight: flickering orange from nearby flames (render fields .z)
  // (round 103, tilecache: a point past the window — a frozen tile's — has no fire field of its own; the edge
  // column's clamped lookup isn't its)
  let glow = select(0.0, glowOf(fields[colIdxI(sc)].z), inMap(cellAt(wpos.xy + nrm.xy * 0.5)));
  // (watersurf: the flicker's noise only where there's firelight to flicker — the same light)
  var flick = 0.0;
  if (glow > 0.0) { flick = 0.75 + 0.25 * vnoise(vec2<f32>(G.time * 9.0, wpos.x + wpos.y)); }
  let firelight = vec3<f32>(1.8, 0.75, 0.25) * glow * flick;
  // (round 117: under a roof the sky's light and the bounce fade, deeper darker; the sun too — the shadow map sees most
  // roofs, the heightfield march not all)
  let cov = underCover(wpos, nrm);
  let shade = mix(1.0, 0.1, cov);
  return Light((ambient + fill) * shade, flash + firelight, sunCol * lit * (1.0 - cloud * 0.9) * mix(1.0, 0.2, cov));
}

/** Direct + ambient light with heightfield shadow and storm cloud shade (what an albedo is multiplied by). */
fn lighting(wpos: vec3<f32>, nrm: vec3<f32>) -> vec3<f32> {
  let l = lightAt(wpos, nrm);
  return l.amb + l.own + l.sun * max(dot(nrm, sunDir()), 0.0);
}

/**
 * (ground branch, AG18; the user: "we should be using a stronger lighting model") A surface's colour lit: the light
 * of lightAt on its albedo (the ambient occlusion on what comes from all round), and the sun's glint off it — a
 * microfacet highlight (GGX, Schlick's Fresnel, a dielectric's 4%) as rough as the surface is (its texture's) — and
 * the sky in it at a grazing angle. nGeo: the surface's own normal (the shadow's test), n: the detail's (the light's).
 * With ?light=old, the old: the albedo times lighting(), no highlight.
 */
fn lightSurf(alb: vec3<f32>, wpos: vec3<f32>, nGeo: vec3<f32>, n: vec3<f32>, rough: f32, ao: f32) -> vec3<f32> {
  if (!LIGHT_NEW) { return alb * lighting(wpos, n) * ao; }
  let l = lightAt(wpos, nGeo);
  let sd = sunDir();
  let v = toEye(wpos);
  let nl = max(dot(n, sd), 0.0);
  var col = alb * (l.amb * ao + l.own + l.sun * nl);
  // the sun's highlight
  let h = normalize(v + sd);
  let a = max(rough * rough, 0.03);
  let a2 = a * a;
  let nh = max(dot(n, h), 0.0);
  let nv = max(dot(n, v), 1e-3);
  let dd = nh * nh * (a2 - 1.0) + 1.0;
  let D = a2 / (3.14159265 * dd * dd);
  let k = a * 0.5;
  let vis = 0.25 / ((nl * (1.0 - k) + k) * (nv * (1.0 - k) + k));
  let F = 0.04 + 0.96 * pow(1.0 - max(dot(v, h), 0.0), 5.0);
  col += l.sun * (D * vis * F * nl * 3.14159265);
  // the sky in it, toward the grazing (rough surfaces: little)
  let Fs = 0.04 + 0.96 * pow(1.0 - nv, 5.0);
  col += G.sky.rgb * Fs * (1.0 - rough) * (1.0 - rough) * 0.6 * ao * (0.5 + 0.5 * n.z);
  return col;
}

/**
 * (ground branch) One screen pixel's step across a surface at p (normal n), in world units: where the pixel to the
 * right and the pixel below land on its plane — from the camera's own projection, so it holds in a full-screen pass
 * (the deferred resolve, a tile's bake: no derivatives there) as in a forward one. A texture's gradients from it
 * (textureSampleGrad: its mip and its anisotropy right).
 */
struct PixStep { dx: vec3<f32>, dy: vec3<f32> };
fn pixStep(p: vec3<f32>, n: vec3<f32>) -> PixStep {
  // the plane's two directions
  let flat = abs(n.z) >= 0.7;
  let a0 = select(vec3<f32>(0.0, 0.0, 1.0), vec3<f32>(1.0, 0.0, 0.0), flat);
  let t1 = normalize(a0 - n * dot(n, a0));
  let t2 = cross(n, t1);
  let c = CAM.viewProj * vec4<f32>(p, 1.0);
  let A = CAM.viewProj * vec4<f32>(t1, 0.0);
  let B = CAM.viewProj * vec4<f32>(t2, 0.0);
  let half = CAM.viewport.xy * vec2<f32>(0.5, -0.5);
  // pixels moved per unit along each
  let ja = (A.xy * c.w - c.xy * A.w) / (c.w * c.w) * half;
  let jb = (B.xy * c.w - c.xy * B.w) / (c.w * c.w) * half;
  var det = ja.x * jb.y - jb.x * ja.y;
  if (abs(det) < 1e-6) { det = select(-1e-6, 1e-6, det >= 0.0); }
  // the inverse: units along t1, t2 per pixel in x and in y
  let ix = vec2<f32>(jb.y, -ja.y) / det;
  let iy = vec2<f32>(-jb.x, ja.x) / det;
  return PixStep(t1 * ix.x + t2 * ix.y, t1 * iy.x + t2 * iy.y);
}

/** a texture sample: colour, the normal's tilt (tangent xy, −1..1), roughness */
struct GTex { col: vec3<f32>, tn: vec2<f32>, rough: f32 };
fn gtexAt(layer: i32, uv: vec2<f32>, gx: vec2<f32>, gy: vec2<f32>) -> GTex {
  let c = textureSampleGrad(archTexC, archSamp, uv, layer, gx, gy);
  let nr = textureSampleGrad(archTexN, archSamp, uv, layer, gx, gy);
  return GTex(c.rgb, nr.xy * 2.0 - 1.0, nr.z);
}

/** (ground branch) a set's look on the ground at p (normal n), one repeat `size` units: projected from above where it
 *  lies flat; on a slope from above and from the side it faces most (two projections, blended — biplanar); colour,
 *  the normal it gives, roughness. World-anchored (wo): it doesn't slide with the window */
struct GLook { col: vec3<f32>, n: vec3<f32>, rough: f32 };
fn groundTex(layer: i32, p: vec3<f32>, n: vec3<f32>, size: f32) -> GLook {
  let ps = pixStep(p, n);
  let q = vec3<f32>(wo(p.xy), p.z) / size;
  let dx = ps.dx / size;
  let dy = ps.dy / size;
  let w = pow(abs(n), vec3<f32>(4.0));
  let wz = w.z / (w.x + w.y + w.z);
  var col = vec3<f32>(0.0);
  var rough = 0.0;
  var nn = vec3<f32>(0.0);
  var tw = 0.0;
  if (wz > 0.02) {
    let t = gtexAt(layer, q.xy, dx.xy, dy.xy);
    let k = select(wz, 1.0, wz > 0.98);
    col += t.col * k;
    rough += t.rough * k;
    nn += vec3<f32>(t.tn * sign(n.z) + n.xy, n.z) * k;
    tw += k;
  }
  if (wz <= 0.98) {
    let side = 1.0 - select(wz, 0.0, wz <= 0.02);
    // (the side it faces most: x or y)
    if (w.x > w.y) {
      let t = gtexAt(layer, q.yz, dx.yz, dy.yz);
      col += t.col * side;
      rough += t.rough * side;
      nn += vec3<f32>(n.x, t.tn.x * sign(n.x) + n.y, t.tn.y + n.z) * side;
    } else {
      let t = gtexAt(layer, q.xz, dx.xz, dy.xz);
      col += t.col * side;
      rough += t.rough * side;
      nn += vec3<f32>(t.tn.x * sign(n.y) + n.x, n.y, t.tn.y + n.z) * side;
    }
    tw += side;
  }
  return GLook(col / tw, normalize(nn / tw), rough / tw);
}

// the player's reach on a story level (game/reach.ts): 1 inside, 0.5 at
// its edge, 0 in the fog beyond; 1 everywhere elsewhere
@group(0) @binding(23) var reachTex: texture_2d<f32>;
/** (round 83) the nearest shore to each column (render/shore.ts, shore.wgsl): xy its point, z 1 when there is one */
@group(0) @binding(24) var shoreTex: texture_2d<f32>;

/**
 * The swell off the shore field at p (round 83, the user: "use SDF for the water to make waves from large
 * bodies come into the shore"; "water in the ocean should be waves coming into the shore"): the distance to
 * the nearest shore and the way to it; crests parallel to the shore running in (their phase falls toward it
 * as time goes), steeper in the shallows; only open water swells — a wide body (far from shore a little way
 * out to sea), not a river (its flow) or a pond: its height and slope (−1..1), strength, the crest's
 * sharpness 0..1, the distance (cells; 1e3 none) and the way to the shore.
 */
struct Swell { h: f32, slope: f32, amp: f32, crest: f32, dist: f32, dir: vec2<f32> };
fn swellAt(p: vec2<f32>, cell: vec2<i32>, flow: f32, wind: f32) -> Swell {
  var o = Swell(0.0, 0.0, 0.0, 0.0, 1e3, vec2<f32>(0.0));
  let sh = textureLoad(shoreTex, texCol(vec2<i32>(clampCell(cell))), 0);
  if (sh.z < 0.5) { return o; }
  let toS = sh.xy - p;
  let dist = length(toS);
  let dir = toS / max(dist, 1e-3);
  // (how open: the shore's distance six cells out to sea)
  let q = p - dir * 6.0;
  let so = textureLoad(shoreTex, texCol(vec2<i32>(clampCell(cellAt(q)))), 0);
  let dOut = select(0.0, length(so.xy - q), so.z > 0.5);
  let open = smoothstep(3.0, 10.0, dOut) * (1.0 - smoothstep(0.01, 0.06, flow));
  if (open <= 0.0) { return o; }
  // (along the shore a slow wobble: the crests not ruled lines)
  let along = dot(p, vec2<f32>(-dir.y, dir.x));
  let wob = vnoise(vec2<f32>(along * 0.06, dist * 0.04) + 3.0) * 2.4;
  let ph = dist * 0.7 - G.time * (1.5 + 0.3 * wind) + wob;
  let shoal = smoothstep(16.0, 2.0, dist);
  o.amp = open * (0.3 + 0.7 * shoal) * (0.7 + 0.3 * wind);
  o.h = sin(ph);
  o.slope = cos(ph);
  // (a crest sharpens as it nears the shore: the wave's front steepens)
  o.crest = pow(0.5 + 0.5 * sin(ph), mix(2.0, 6.0, shoal));
  o.dist = dist;
  o.dir = dir;
  return o;
}

fn reachAt(p: vec2<f32>) -> f32 {
  let t = triAt(p);
  var r = 0.0;
  for (var k = 0; k < 3; k++) { r += t.w[k] * textureLoad(reachTex, texCol(vec2<i32>(clampCell(t.c[k]))), 0).x; }
  return r;
}

fn haze(c: vec3<f32>, wpos: vec3<f32>) -> vec3<f32> {
  let dirty = vec3<f32>(0.62, 0.57, 0.48);
  let clean = vec3<f32>(0.62, 0.70, 0.78);
  // haze darkens with the sky at night
  let h = mix(clean, dirty, G.pollution) * mix(1.0, 0.15, G.sky.w);
  let lowFog = smoothstep(24.0, 0.0, wpos.z) * 0.06;
  var o = mix(c, toLinear(h), 0.03 + 0.1 * G.pollution + lowFog);
  // beyond the reach: a dim, colourless fog (the land not yet reached)
  let fog = 1.0 - smoothstep(0.05, 0.5, reachAt(wpos.xy));
  if (fog > 0.0) {
    let g = dot(o, vec3<f32>(0.3, 0.59, 0.11));
    o = mix(o, vec3<f32>(g) * 0.3 + toLinear(h) * 0.08, fog * 0.88);
  }
  return o;
}

/** Thin dark lines at cell boundaries so the grid reads (hex edges on tops; prism corners and whole heights on sides); fades out when cells are tiny. */
fn gridLines(wpos: vec3<f32>, nrm: vec3<f32>) -> f32 {
  let d = wpos.xy - cellPos(cellAt(wpos.xy - nrm.xy * 0.01));
  var e: f32;
  if (abs(nrm.z) > 0.5) {
    // distance to the hexagon's edge (inradius 0.5)
    e = 0.5 - max(abs(d.x), max(abs(dot(d, DIRV[2])), abs(dot(d, DIRV[4]))));
  } else {
    let along = dot(d, normalize(vec2<f32>(-nrm.y, nrm.x)));
    let fz = fract(wpos.z);
    e = min(HEX_R * 0.5 - abs(along), min(fz, 1.0 - fz));
  }
  let a = faceUV(wpos, nrm);
  let w = max(fwidth(a.x), fwidth(a.y));
  let line = 1.0 - smoothstep(0.0, w * 1.2, e);
  return line * 0.16 * smoothstep(0.45, 0.12, w);
}

/**
 * Sub-voxel canopy: march the view ray through a 4×4×4-per-cell grid inside
 * the (swayed) leaf box; occupancy is a hash thinning toward the edges of an
 * ellipsoid, so crowns are lumpy with gaps you can see through. Returns
 * vec4(hit position, axis of the face hit + 1) or w = 0 for a miss.
 */
fn canopyMarch(in: VOut) -> vec4<f32> {
  let res = 4.0;
  let species = (in.info.y >> 8u) & 15u;
  let dims = in.bsize * res;
  let local = (in.wpos - in.boff - in.bmin) * res;
  let dir = -toEye(in.wpos);
  var cell = floor(local - in.nrm * 0.01);
  let stepv = sign(dir);
  let tDelta = abs(1.0 / dir);
  var tMax = ((cell + max(stepv, vec3<f32>(0.0))) - local) / dir;
  var axis = select(select(1.0, 2.0, abs(in.nrm.y) > 0.5), 3.0, abs(in.nrm.z) > 0.5);
  let seed = vec3<i32>(floor(in.bmin * res));
  for (var i = 0; i < 40; i++) {
    if (any(cell < vec3<f32>(0.0)) || any(cell >= dims)) { break; }
    let c = (cell + 0.5) / dims - 0.5;
    var density: f32;
    if (species == 1u) {
      // conifer: a cone, wide at the bottom, a point at the top
      let zf = c.z + 0.5;
      let rr = length(c.xy) * 2.0;
      density = select(0.0, 0.92 - 0.3 * rr, rr < (1.0 - zf) * 0.95 + 0.08);
    } else {
      let d = length(c * vec3<f32>(2.0, 2.0, 2.2));
      density = 0.85 - 0.75 * d * d;
      if (species == 2u) { density -= 0.12; } // birch: airy
      // (round 51: the leaves fall in autumn, the crown thins to a few)
      density -= seasonBare() * 0.8;
    }
    if (randv(vec3<i32>(cell) + seed) < density) {
      let hit = in.bmin + in.boff + (cell + 0.5) / res;
      return vec4<f32>(hit, axis);
    }
    if (tMax.x < tMax.y && tMax.x < tMax.z) { cell.x += stepv.x; tMax.x += tDelta.x; axis = 1.0; }
    else if (tMax.y < tMax.z) { cell.y += stepv.y; tMax.y += tDelta.y; axis = 2.0; }
    else { cell.z += stepv.z; tMax.z += tDelta.z; axis = 3.0; }
  }
  return vec4<f32>(0.0);
}

