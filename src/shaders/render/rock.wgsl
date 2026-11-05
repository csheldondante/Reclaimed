// rock.wgsl: soft material borders, faceted and carved rock (part 4 of 7 of the renderWgsl shader, joined in order by render.ts)
// ---- soft borders between ground materials (round 26) ----------------------
// A top face doesn't switch material at the cell edge: each point takes the
// material that wins a vote over the three nearest columns (barycentric weights,
// like the rounded shorelines), nudged by world-space noise and by each
// material's relief (pebbly rubble pokes up through sand, sand fills the
// low spots of dirt). Both sides of an edge see the same columns and the same
// noise, so the border is seamless. Only ground materials at about the same
// height take part: cliffs, concrete and brick keep crisp edges.

/** What a column's top is made of and how high it is (the loose sheet's material where there's a fair depth of it). */
fn topLookAt(q: vec2<i32>) -> vec2<f32> {
  let s = surface[colIdxI(q)];
  let t = textureLoad(driftTex, texCol(vec2<i32>(q)), 0); // (one load: driftAt + driftMatAt)
  if (t.x >= 0.07) {
    let m = u32(t.z + 0.5);
    return vec2<f32>(f32(select(m, MAT_DRIFT, m == 0u)), sfZ(s) + t.x);
  }
  return vec2<f32>(f32(sfMat(s)), sfZ(s));
}

/** Ground that blends with its neighbours: the soft materials and natural stone. */
fn blends(m: u32) -> bool { return MATS[m].look.x > 0.0 || m == MAT_STONE; }

/** A material's relief at p, centred on 0: who shows where two meet. */
fn relief(m: u32, p: vec2<f32>) -> f32 {
  if (m == 4u || m == 18u) { return 0.4 * (randv(vec3<i32>(vec2<i32>(floor(p * 4.0)), 41)) - 0.5); } // rubble, litter: pebbles, scraps
  if (m == 3u || m == MAT_DRIFT) { return 0.1 * (vnoise(p * 0.9 + 3.0) - 0.5); } // sand, dust: smooth, fills hollows
  if (m == MAT_STONE) { return 0.3 * (vnoise(p * 1.6 + 11.0) - 0.5); }
  return 0.2 * (vnoise(p * 2.3 + 5.0) - 0.5); // soil, ash, silt
}

/** Albedo a top of material m is drawn in (blown dust: a greyer silt). */
fn topAlbedo(m: u32) -> vec3<f32> {
  if (m == MAT_DRIFT) { return toLinear(vec3<f32>(0.52, 0.46, 0.39)); }
  return toLinear(MATS[m].albedo.rgb);
}

struct EdgeLook { m: u32, v: f32 };

/**
 * The material shown at a point of a top face whose own material is `own`,
 * and the plant cover there smoothed the same way (so grass edges aren't
 * square either). Columns that don't take part count as `own`.
 */
fn edgeLook(p: vec3<f32>, own: u32, ownV: f32) -> EdgeLook {
  // (render-fields marks the corners where anything differs: elsewhere, one
  // texture read and done)
  // (a point lies in the triangles around its own cell: unless that cell
  // differs from a neighbour, there is nothing to vote on)
  let own0 = clampCell(cellAt(p.xy));
  if (textureLoad(cornerTex, texColK(vec2<i32>(own0.x, own0.y), u32(CT), 0u), 0).w < 0.5) { return EdgeLook(own, ownV); }
  let t = triAt(p.xy);
  var ms: array<u32, 3>;
  var ws: array<f32, 3>;
  var vs = 0.0;
  for (var k = 0; k < 3; k++) {
    let q = clampCell(t.c[k]);
    let tl = topLookAt(q);
    var m = u32(tl.x + 0.5);
    var v = veg[colIdxI(q)];
    if (!blends(m) || abs(tl.y - p.z) > 0.9) { m = own; v = ownV; }
    ms[k] = m;
    ws[k] = t.w[k];
    vs += ws[k] * v;
  }
  // (most of the ground: one material all round, nothing to vote on)
  if (ms[0] == own && ms[1] == own && ms[2] == own) { return EdgeLook(own, vs); }
  var best = own;
  var bestS = -1e9;
  for (var k = 0; k < 3; k++) {
    let m = ms[k];
    // each material once
    var seen = false;
    for (var j = 0; j < k; j++) { if (ms[j] == m) { seen = true; } }
    if (seen) { continue; }
    var w = 0.0;
    for (var j = 0; j < 3; j++) { if (ms[j] == m) { w += ws[j]; } }
    let s = w + 0.28 * (vnoise(wo(p.xy) * 1.1 + vec2<f32>(f32(m) * 7.3, f32(m) * 3.1)) - 0.5) + relief(m, wo(p.xy));
    if (s > bestS) { bestS = s; best = m; }
  }
  return EdgeLook(best, vs);
}

// ---- faceted rock (round 28, a test) -----------------------------------------
// Stone doesn't read as rock when every face is one flat plane: each face is
// split into Voronoi facets (about a cell across) that catch the light at
// their own small tilt, with dark cracks between them. Shading only — the
// silhouette is still the voxels.

/** Voronoi on a face: x = distance to the nearest seed, y = to the second, zw = the nearest seed's cell. */
fn voronoi2(p: vec2<f32>, salt: i32) -> vec4<f32> {
  let i0 = vec2<i32>(floor(p));
  var f1 = 9.0;
  var f2 = 9.0;
  var id = vec2<f32>(0.0);
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      let c = i0 + vec2<i32>(x, y);
      let s = vec2<f32>(c) + vec2<f32>(randv(vec3<i32>(c, salt)), randv(vec3<i32>(c, salt + 17)));
      let d = length(p - s);
      if (d < f1) { f2 = f1; f1 = d; id = vec2<f32>(c); } else if (d < f2) { f2 = d; }
    }
  }
  return vec4<f32>(f1, f2, id);
}

/** Rock facets: the tilted normal and how much to darken (cracks, facet tone). */
fn rockFacet(wpos: vec3<f32>, nrm: vec3<f32>, tiltK: f32) -> vec4<f32> {
  // the face's own 2D coordinates (tops: xy; sides: along the wall and up)
  var a = faceUV(wpos, nrm);
  var salt = 301;
  if (abs(nrm.z) <= 0.5) { a.y *= 1.3; salt = 333 + i32(round(atan2(nrm.y, nrm.x) * 3.0)); }
  let v = voronoi2(a * 1.25, salt);
  let fid = vec3<i32>(vec2<i32>(v.zw), salt);
  let tilt = vec3<f32>(randv(fid + vec3<i32>(0, 0, 5)) - 0.5, randv(fid + vec3<i32>(0, 0, 9)) - 0.5, randv(fid + vec3<i32>(0, 0, 13)) - 0.5) * 0.7 * tiltK;
  let n = normalize(nrm + tilt - nrm * dot(tilt, nrm));
  // a crack where two facets meet; each facet a slightly different tone
  let crack = 1.0 - smoothstep(0.02, 0.09, v.y - v.x);
  let tone = 0.9 + 0.2 * randv(fid + vec3<i32>(0, 0, 21));
  return vec4<f32>(n, tone * (1.0 - 0.45 * crack));
}

// ---- carved rock (round 29) ----------------------------------------------------
// Faceted shading alone left rock dead straight in profile. Stone is carved:
// its surface lies a noisy depth (0..ROCK_CARVE) inside the prism's exposed
// faces — the top (smoothed slope included) and the sides open to the air;
// faces against a neighbour aren't carved, so stone columns join without
// gaps. Each stone fragment marches the view ray into its box to that
// surface; a ray that leaves through an exposed face missed the rock and is
// discarded, so what's behind shows through and the silhouette is jagged.
// Rock is only ever removed, so everything behind is already drawn and no
// depth needs writing (the face's depth is at most ROCK_CARVE in front).
const ROCK_CARVE: f32 = 0.45;
/** px per cell below which rock isn't carved (too small to see) */
const ROCK_ZOOM: f32 = 10.0;

fn vnoise3(p: vec3<f32>) -> f32 {
  let i = vec3<i32>(floor(p));
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  let a = mix(randv(i), randv(i + vec3<i32>(1, 0, 0)), u.x);
  let b = mix(randv(i + vec3<i32>(0, 1, 0)), randv(i + vec3<i32>(1, 1, 0)), u.x);
  let c = mix(randv(i + vec3<i32>(0, 0, 1)), randv(i + vec3<i32>(1, 0, 1)), u.x);
  let d = mix(randv(i + vec3<i32>(0, 1, 1)), randv(i + vec3<i32>(1, 1, 1)), u.x);
  return mix(mix(a, b, u.y), mix(c, d, u.y), u.z);
}

/** How deep the rock is cut away at p (0..ROCK_CARVE): lumpy, with sharper chips. */
fn rockCut(p: vec3<f32>) -> f32 {
  // (one octave: the facets add the fine detail; two cost too much)
  return ROCK_CARVE * smoothstep(0.2, 0.85, vnoise3((p + vec3<f32>(G.org.xy, 0.0)) * 1.1));
}

// nt: the top of the ground in each neighbour (NDIR order). A side is only
// open to the air above it: below, the neighbour's facing side isn't drawn
// (hidden behind this prism), so a ray leaving there would show the
// background through the rock (round 30: holes between stone columns)
struct RockBox { c: vec2<f32>, z0: f32, z1: f32, open: u32, top: bool, nt: Dirs, h: array<f32, 6>, hc: f32 };

fn rockBox(in: VOut, flags: u32) -> RockBox {
  var rb: RockBox;
  rb.c = in.bmin.xy + 0.5;
  let cell = cellAt(rb.c);
  rb.z0 = in.bmin.z;
  rb.z1 = in.bmin.z + in.bsize.z;
  // exposed: the top if it's the column's top and nothing sits on it; the sides not hidden
  rb.open = (~in.sides) & 63u;
  rb.top = (flags & 1u) != 0u && (flags & 64u) == 0u;
  // the top as drawn: the fan through the corner heights
  rb.hc = 0.0;
  for (var j = 0u; j < 6u; j++) {
    rb.h[j] = cornerOr(cell, j, rb.z1);
    rb.hc += rb.h[j] / 6.0;
  }
  // a rise the smoothing draws as a slope isn't a rock face: only sheer
  // rises are carved (carving the slopes opened seams between the tops)
  let sm = MATS[MAT_STONE].look.x;
  for (var k = 0u; k < NDIR; k++) {
    // (the map's edge is no rock face: on the hex grid it zigzags, and rays
    // left a prism through the notches into nothing)
    let q = nbr(cell, k);
    rb.nt[k] = select(1e9, groundTopR(q), inMap(q));
    if (rb.z1 - rb.nt[k] <= sm + 0.01) { rb.nt[k] = 1e9; }
  }
  return rb;
}

/** The drawn top's height at p (the triangle of the fan p is over). */
fn rockTopZ(rb: RockBox, p: vec2<f32>) -> f32 {
  let d = p - rb.c;
  let t = u32(floor((atan2(d.y, d.x) - 0.5235988) / 1.0471976) + 6.0) % 6u;
  let a = cornerOffset(t);
  let b = cornerOffset(t + 1u);
  // d = u a + v b
  let det = a.x * b.y - a.y * b.x;
  let u = (d.x * b.y - d.y * b.x) / det;
  let v = (a.x * d.y - a.y * d.x) / det;
  return rb.hc + u * (rb.h[t] - rb.hc) + v * (rb.h[(t + 1u) % 6u] - rb.hc);
}

/** Inside the carved rock by this much at p (< 0: in the air cut away). */
fn rockIn(rb: RockBox, p: vec3<f32>) -> f32 {
  var d = 1e3;
  if (rb.top) { d = min(d, rockTopZ(rb, p.xy) - p.z); }
  let r = p.xy - rb.c;
  for (var k = 0u; k < NDIR; k++) {
    if (((rb.open >> k) & 1u) != 0u && p.z > rb.nt[k]) { d = min(d, 0.5 - dot(r, DIRV[k])); }
  }
  return d - rockCut(p);
}

/** March into a stone prism from the face point: vec4(hit, 1) or w = 0 (missed: the air). */
fn rockMarch(in: VOut, flags: u32) -> vec4<f32> {
  let rb = rockBox(in, flags);
  let dir = -normalize(toEye(in.wpos));
  var t = 0.0;
  for (var i = 0; i < 20; i++) {
    let p = in.wpos + dir * t;
    // left the prism: into the air through an open side, or into solid stuff
    // (a neighbour, the ground) through a closed one (an open side only
    // leads into the air above the neighbour's ground)
    let r = p.xy - rb.c;
    for (var k = 0u; k < NDIR; k++) {
      if (dot(r, DIRV[k]) > 0.5) {
        if (((rb.open >> k) & 1u) != 0u && p.z > rb.nt[k]) { return vec4<f32>(0.0); }
        return vec4<f32>(p, 2.0);
      }
    }
    if (p.z < rb.z0) { return vec4<f32>(p, 2.0); }
    let s = rockIn(rb, p);
    if (s >= 0.0) { return vec4<f32>(p, select(1.0, 2.0, i > 0)); }
    t += max(-s * 0.8, 0.02);
  }
  return vec4<f32>(in.wpos + dir * t, 2.0);
}

/** The carved surface's normal at p (outward). */
fn rockNormal(in: VOut, flags: u32, p: vec3<f32>) -> vec3<f32> {
  let rb = rockBox(in, flags);
  let e = 0.04;
  let s0 = rockIn(rb, p);
  let g = vec3<f32>(rockIn(rb, p + vec3<f32>(e, 0.0, 0.0)) - s0, rockIn(rb, p + vec3<f32>(0.0, e, 0.0)) - s0, rockIn(rb, p + vec3<f32>(0.0, 0.0, e)) - s0);
  // (inside grows inward: the outward normal is against the gradient)
  let l = length(g);
  return select(in.nrm, -g / l, l > 1e-5);
}

