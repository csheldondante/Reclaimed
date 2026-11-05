// vertex.wgsl: the vertex stages: instances, prisms, boxes, lava and water sheets, streams (part 2 of 7 of the renderWgsl shader, joined in order by render.ts)
// An instance: column intervals (water, oil, the loose sheet too) are hex
// prisms on their cell; plants are axis-aligned boxes. x, y: a box's world
// minimum corner; a prism's cell centre - 0.5.
struct Box { x: f32, y: f32, sx: f32, sy: f32, z0: f32, z1: f32, mat: u32, flags: u32, cell: vec2<i32>, sides: u32, hex: bool };

fn unpackBox(v: vec4<u32>) -> Box {
  var b: Box;
  let gx = f32(v.x & 0xfffu);
  let gy = f32((v.x >> 12u) & 0xfffu);
  b.sx = f32(((v.x >> 24u) & 0xfu) + 1u);
  b.sy = f32(((v.x >> 28u) & 0xfu) + 1u);
  b.z0 = bitcast<f32>(v.y);
  b.z1 = bitcast<f32>(v.z);
  b.mat = v.w & 0xffu;
  b.flags = (v.w >> 8u) & 0xfffu;
  b.sides = (v.w >> 20u) & 63u;
  b.hex = (b.flags & (FLAG_VEG_R | FLAG_DETAIL)) == 0u;
  // packed in storage cells (detail instances in quarter cells): place the
  // box by its centre - the cell it's in, then that cell's world centre
  let q = select(1.0, 0.25, (b.flags & FLAG_DETAIL) != 0u);
  b.sx *= q;
  b.sy *= q;
  let cs = vec2<f32>(gx * q + b.sx * 0.5, gy * q + b.sy * 0.5);
  b.cell = vec2<i32>(floor(cs));
  let wc = cellPos(b.cell) + (fract(cs) - 0.5) * vec2<f32>(1.0, ROW_H);
  b.x = wc.x - b.sx * 0.5;
  b.y = wc.y - b.sy * 0.5;
  return b;
}

/**
 * Vegetation sway in the shared wind field (prevailing wind, storms, gusts and
 * the cursor breeze): canopies shift rigidly, stems/shrubs/tufts bend (only
 * their top moves). Returns the offset for a vertex at height fraction h.
 */
fn swayOffset(b: Box, h: f32) -> vec3<f32> {
  let c = vec2<f32>(b.x + b.sx * 0.5, b.y + b.sy * 0.5);
  // the lean is a per-column spring (sway.wgsl): plants bend with the wind,
  // hold it, and spring back slowly when it drops
  let lean = bend[colIdxI(clampCell(b.cell))].xy;
  let amp = length(lean) / 0.3;
  let dir = lean / max(length(lean), 1e-4);
  let seed = fract(sin(dot(c, vec2<f32>(12.9898, 78.233))) * 43758.5453);
  // a slow, relaxed flutter on top (fixed frequency: no phase jumps)
  let flutter = dir * sin(G.time * 2.2 + seed * 30.0) * 0.05 * (0.3 + amp);
  var k = h;
  if (b.mat == MAT_LEAVES && b.sx > 1.5) { k = 1.0; } // canopy: rigid
  return vec3<f32>((lean + flutter) * k, 0.0);
}

/** Corner height of a smooth sheet (water or drift prism) at corner j of p. */
fn sheetOr(m: u32, p: vec2<i32>, j: u32, z: f32) -> f32 {
  let c = select(waterCornerAt(p, j), driftCornerAt(p, j), m == MAT_DRIFT);
  return select(c, z, c < 0.0);
}


/** Drawn top height of a prism at its corner j. */
fn prismCornerZ(b: Box, j: u32, soft: bool, liquid: bool) -> f32 {
  if (liquid) { return sheetOr(b.mat, b.cell, j, b.z1); }
  if (soft) { return cornerOr(b.cell, j, b.z1); }
  return b.z1;
}

/** The top of a prism as four triangles over its corners (symmetric: the three ears and the middle). */
const TOP_TRI = array<u32, 12>(0u, 1u, 2u, 2u, 3u, 4u, 4u, 5u, 0u, 0u, 2u, 4u);

/**
 * A hex prism (a column interval): 30 vertices - the top as four triangles
 * over its corners (soft ground and sheets slope through their shared corner
 * heights), then the three sides facing the camera. The top takes one flat
 * normal, the plane fitted through its corners (renderfields.wgsl caches it
 * per cell): per-triangle normals showed every hexagon's facets wherever the
 * smoothed corners aren't coplanar. (A fan from the centre cost six more
 * vertices for nothing the flat normal shows; draw is vertex-bound.)
 */
fn prismVertex(b: Box, vi: u32, out: ptr<function, VOut>) -> bool {
  let c = cellPos(b.cell);
  // soft ground: the column's top is drawn sloped (terrainshape.wgsl)
  let soft = (b.flags & FLAG_TOP_R) != 0u && MATS[b.mat].look.x > 0.0;
  // water and drifted dust: smooth sheets through their corner levels
  // ((?flow=1) a liquid run of the flow module, FLAG_RUN: flat, shaded by shadeRun)
  let liquid = (b.mat == MAT_WATER || b.mat == MAT_DRIFT) && (b.flags & FLAG_RUN) == 0u;
  var p: vec3<f32>;
  var n: vec3<f32>;
  var shown = true;
  if (vi < 12u) {
    let j = TOP_TRI[vi];
    var g = vec2<f32>(0.0);
    if (soft || liquid) {
      g = planeAt(b.cell, select(select(0u, 1u, b.mat == MAT_WATER), 2u, b.mat == MAT_DRIFT)).g;
    }
    p = vec3<f32>(c + cornerOffset(j), prismCornerZ(b, j, soft, liquid));
    n = normalize(vec3<f32>(-g, 1.0));
    shown = (b.flags & 64u) == 0u;
  } else {
    let s = (vi - 12u) / 6u;
    let uv = QUAD[(vi - 12u) % 6u];
    // the three sides facing the eye: the one most squarely toward it, and
    // the one either side
    let te = toEye(vec3<f32>(c, (b.z0 + b.z1) * 0.5));
    let m0 = i32(round(atan2(te.y, te.x) / 1.0471976));
    let m = u32((m0 - 1 + i32(s) + 12) % 6);
    // side m runs from corner m - 1 to corner m
    let j = select((m + 5u) % 6u, m, uv.x > 0.5);
    let k = SIDE_DIR[m];
    var top = b.z1;
    if (soft) { top = cornerOr(b.cell, j, b.z1); }
    if (liquid) { top = max(sheetOr(b.mat, b.cell, j, b.z1), b.z0); }
    p = vec3<f32>(c + cornerOffset(j), mix(b.z0, top, uv.y));
    n = vec3<f32>(DIRV[k], 0.0);
    shown = ((b.sides >> k) & 1u) == 0u;
    // a drift sheet tapers into the ground where it can (its corners meet the
    // neighbour's: no side there); where it stops at a step (a corner left at
    // the prism's height) it shows that side, up to its corner levels - without
    // it the background showed through under the sheet's edge (round 30)
    if (b.mat == MAT_DRIFT) {
      let nb = nbr(b.cell, k);
      if (!sheetGap(b.cell, (m + 5u) % 6u, nb) && !sheetGap(b.cell, m, nb)) { shown = false; }
    }
    // water: no side inside a continuous body of water
    if (b.mat == MAT_WATER && (b.flags & FLAG_RUN) == 0u) {
      let q = nbr(b.cell, k);
      if (inMap(q)) {
        let jq = colIdxI(q);
        if (f32(sfZ(surface[jq])) + driftAt(q) + water[jq] >= b.z1 - 0.02) { shown = false; }
      }
    }
  }
  (*out).pos = CAM.viewProj * vec4<f32>(p, 1.0);
  (*out).wpos = p;
  (*out).bmin = vec3<f32>(c - 0.5, b.z0);
  (*out).bsize = vec3<f32>(1.0, 1.0, b.z1 - b.z0);
  (*out).boff = vec3<f32>(0.0);
  (*out).nrm = n;
  (*out).tint = 0.82 + 0.36 * fbm2(wo(p.xy) * 0.045 + vec2<f32>(p.z * 0.02));
  (*out).info = vec2<u32>(b.mat, b.flags);
  (*out).zr = vec2<f32>(b.z0, b.z1);
  (*out).sides = b.sides | PRISM;
  return b.z1 > b.z0 && shown;
}

/** A plant box: its top and the two sides toward the eye (18 vertices). */
fn boxVertex(b: Box, vi: u32, out: ptr<function, VOut>) -> bool {
  let face = vi / 6u;
  let uv = QUAD[vi % 6u];
  let te = toEye(vec3<f32>(b.x + b.sx * 0.5, b.y + b.sy * 0.5, (b.z0 + b.z1) * 0.5));
  let sxn = select(-1.0, 1.0, te.x > 0.0);
  let syn = select(-1.0, 1.0, te.y > 0.0);
  var p: vec3<f32>;
  var n: vec3<f32>;
  if (face == 0u) {
    p = vec3<f32>(b.x + uv.x * b.sx, b.y + uv.y * b.sy, b.z1);
    n = vec3<f32>(0.0, 0.0, 1.0);
  } else if (face == 1u) {
    let fx = select(b.x, b.x + b.sx, sxn > 0.0);
    p = vec3<f32>(fx, b.y + uv.x * b.sy, mix(b.z0, b.z1, uv.y));
    n = vec3<f32>(sxn, 0.0, 0.0);
  } else {
    let fy = select(b.y, b.y + b.sy, syn > 0.0);
    p = vec3<f32>(b.x + uv.x * b.sx, fy, mix(b.z0, b.z1, uv.y));
    n = vec3<f32>(0.0, syn, 0.0);
  }
  var off = vec3<f32>(0.0);
  if ((b.flags & FLAG_VEG_R) != 0u) {
    let h = clamp((p.z - b.z0) / max(b.z1 - b.z0, 1e-3), 0.0, 1.0);
    off = swayOffset(b, h);
    p += off;
  }
  (*out).pos = CAM.viewProj * vec4<f32>(p, 1.0);
  (*out).wpos = p;
  (*out).bmin = vec3<f32>(b.x, b.y, b.z0);
  (*out).bsize = vec3<f32>(b.sx, b.sy, b.z1 - b.z0);
  (*out).boff = swayOffsetRigid(b, off);
  (*out).nrm = n;
  (*out).tint = 0.82 + 0.36 * fbm2(wo(p.xy) * 0.045 + vec2<f32>(p.z * 0.02));
  (*out).info = vec2<u32>(b.mat, b.flags);
  (*out).zr = vec2<f32>(b.z0, b.z1);
  (*out).sides = 0u;
  return b.z1 > b.z0;
}

fn instVertex(b: Box, vi: u32, out: ptr<function, VOut>) -> bool {
  if (b.hex) { return prismVertex(b, vi, out); }
  return boxVertex(b, vi, out);
}

@vertex
fn vsBox(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VOut {
  var o: VOut;
  let b = unpackBox(instances[ii]);
  var shown: bool;
  if ((u32(CAM.eye.w) & 2u) != 0u && b.mat == MAT_LAVA_M) { shown = lavaSheetVertex(b, ii, vi, &o); }
  else { shown = instVertex(b, vi, &o); }
  if (!shown) { o.pos = vec4<f32>(0.0, 0.0, -2.0, 1.0); }
  return o;
}

/**
 * Lava over the field mesh (round 48: smooth like the ground, not hex
 * prisms): as waterSheetVertex, the six triangles round the column's centre
 * over the cell-centre lattice, each drawn once (by its lowest lava corner).
 * The levels round it come from lava.wgsl prep, after the prisms in the
 * same buffer: by direction, a lava neighbour's level, a dry one's ground as
 * -1 - ground. A dry corner stands at the lava's level or its ground below
 * it, so the edge slopes down onto the ground.
 */
fn lavaSheetVertex(b: Box, ii: u32, vi: u32, out: ptr<function, VOut>) -> bool {
  if (vi >= 18u) { return false; }
  let t = vi / 3u;
  let p = b.cell;
  let da = SIDE_DIR[t];
  let db = SIDE_DIR[(t + 1u) % 6u];
  let qa = nbr(p, da);
  let qb = nbr(p, db);
  let o = arrayLength(&instances) / 3u + 2u * ii;
  let l0 = instances[o];
  let l1 = instances[o + 1u];
  let lv = array<f32, 6>(bitcast<f32>(l0.x), bitcast<f32>(l0.y), bitcast<f32>(l0.z), bitcast<f32>(l0.w), bitcast<f32>(l1.x), bitcast<f32>(l1.y));
  let me = b.z1;
  let ra = lv[da];
  let rb = lv[db];
  let wa = ra >= 0.0;
  let wb = rb >= 0.0;
  let ip = colIdxI(p);
  if (wa && colIdxI(qa) < ip) { return false; }
  if (wb && colIdxI(qb) < ip) { return false; }
  let level = (me + select(0.0, ra, wa) + select(0.0, rb, wb)) / (1.0 + f32(wa) + f32(wb));
  // (a dry corner dips under its ground: the ground's smoothed mesh then cuts
  // the edge along a curve, not the triangles' zigzag)
  let za = select(min(level, -1.0 - ra) - 0.12, ra, wa);
  let zb = select(min(level, -1.0 - rb) - 0.12, rb, wb);
  let pa = vec3<f32>(cellPos(qa), za);
  let pb = vec3<f32>(cellPos(qb), zb);
  let pm = vec3<f32>(cellPos(p), me);
  let k = vi % 3u;
  var v = pm;
  if (k == 1u) { v = pa; } else if (k == 2u) { v = pb; }
  var n = normalize(cross(pa - pm, pb - pm));
  if (n.z < 0.0) { n = -n; }
  (*out).pos = CAM.viewProj * vec4<f32>(v, 1.0);
  (*out).wpos = v;
  (*out).nrm = n;
  (*out).info = vec2<u32>(MAT_LAVA_M, b.flags);
  (*out).zr = vec2<f32>(b.z0, b.z1);
  (*out).tint = 1.0;
  (*out).bmin = vec3<f32>(cellPos(p) - 0.5, b.z0);
  (*out).bsize = vec3<f32>(1.0, 1.0, b.z1 - b.z0);
  (*out).boff = vec3<f32>(0.0);
  (*out).sides = 0u;
  return true;
}

@vertex
fn vsWater(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VOut {
  var o: VOut;
  let b = unpackBox(instances[ii]);
  var shown: bool;
  // ((?flow=1) a stream of the flow module: its sheet along its path; a run under rock: a flat prism)
  if ((b.flags & (FLAG_RUN | FLAG_DETAIL)) == (FLAG_RUN | FLAG_DETAIL)) { shown = streamVertex(ii, vi, &o); }
  else if ((b.flags & FLAG_RUN) != 0u) { shown = vi < 30u && instVertex(b, vi, &o) && (b.hex || vi < 18u); }
  else if ((u32(CAM.eye.w) & 2u) != 0u && b.mat == MAT_WATER) { shown = waterSheetVertex(b, vi, &o); }
  else { shown = instVertex(b, vi, &o); }
  if (!shown) { o.pos = vec4<f32>(0.0, 0.0, -2.0, 1.0); }
  return o;
}

// (?flow=1, round 86) a stream's sheet: liquid.wgsl prep's header (the column, z and vz it enters with, mat |
// flags) and two vec4 after the list's room (a third of the buffer): where it enters (world xy), its velocity xy;
// the front (how far along its path it's drawn, s), its time since the lip, the volume a second, heat.
// STREAM_G: the world's gravity (common.wgsl WORLD_G), as liquid.wgsl GF.
// STREAM_G (was WORLD_G): worldG() (round 108, src/tune/params.ts)
const STREAM_Q = array<vec2<f32>, 6>(vec2<f32>(0.0, -1.0), vec2<f32>(1.0, -1.0), vec2<f32>(1.0, 1.0), vec2<f32>(0.0, -1.0), vec2<f32>(1.0, 1.0), vec2<f32>(0.0, 1.0));

/** a stream's point and tangent t seconds along its path from where it enters */
fn streamAt(e: vec3<f32>, u: vec2<f32>, vz: f32, t: f32) -> vec3<f32> { return vec3<f32>(e.xy + u * t, e.z + vz * t - 0.5 * worldG() * t * t); }
fn streamSide(u: vec2<f32>) -> vec2<f32> {
  let us = length(u);
  return select(vec2<f32>(1.0, 0.0), vec2<f32>(-u.y, u.x) / us, us > 1e-3);
}
/** the sheet's width across the flow (curtain) and its thickness in the arc's plane, for its rate */
fn streamWidth(rate: f32, tl: f32) -> vec2<f32> {
  // (a column's water across a cell, so the neighbours' curtains overlap into one sheet; spreading as it falls)
  let spread = 1.0 + 0.6 * min(tl, 2.0);
  let w = mix(0.4, 1.5, smoothstep(0.05, 1.5, rate)) * spread;
  return vec2<f32>(w, w * 0.7);
}

/**
 * A stream over its column as two ribbons along its parabola, three segments each: a curtain across the flow
 * (as wide as the water a column carries, so neighbours' join into one sheet) and a band in the arc's plane (the
 * arc seen side on). Parameterised by the time along the path (tint: interpolated), so the shading scrolls with
 * the water at its own speed; flat: bmin the entry, boff (u, vz), bsize (width, thickness, ribbon), zr (time
 * since the lip, rate).
 */
fn streamVertex(ii: u32, vi: u32, out: ptr<function, VOut>) -> bool {
  let h = instances[ii];
  let cap = arrayLength(&instances) / 3u;
  let d0 = bitcast<vec4<f32>>(instances[cap + 2u * ii]);
  let d1 = bitcast<vec4<f32>>(instances[cap + 2u * ii + 1u]);
  let e = vec3<f32>(d0.xy, bitcast<f32>(h.y));
  let vz = bitcast<f32>(h.z);
  let u = d0.zw;
  let ribbon = vi / 18u;
  let c = STREAM_Q[vi % 6u];
  // (from a little before its entry to a little past its exit, along its own path, faded in and out there: a
  // column's stream enters where the streams it gathered left theirs - on average - so the segments cross-fade
  // into each other instead of leaving gaps)
  let ext = min(0.45 / max(length(vec3<f32>(u, vz)), 1.0), max(d1.x, 0.02));
  let t = -ext + (d1.x + 2.0 * ext) * (f32((vi % 18u) / 6u) + c.x) / 3.0;
  let side = vec3<f32>(streamSide(u), 0.0);
  let tg = normalize(vec3<f32>(u, vz - worldG() * t) + vec3<f32>(0.0, 0.0, -1e-4));
  let nArc = normalize(cross(tg, side));
  let wd = streamWidth(d1.z, d1.y + t);
  var across = side * wd.x * 0.5;
  var n = nArc;
  if (ribbon == 1u) { across = nArc * wd.y * 0.5; n = side; }
  let p = streamAt(e, u, vz, t) + across * c.y;
  if (dot(n, toEye(p)) < 0.0) { n = -n; }
  (*out).pos = CAM.viewProj * vec4<f32>(p, 1.0);
  (*out).wpos = p;
  (*out).nrm = n;
  (*out).tint = t;
  (*out).info = vec2<u32>(h.w & 0xffu, (h.w >> 8u) & 0xfffu);
  (*out).bmin = e;
  (*out).boff = vec3<f32>(u, vz);
  (*out).bsize = vec3<f32>(d1.x, ext, f32(ribbon));
  (*out).zr = vec2<f32>(d1.y, d1.z);
  (*out).sides = 0u;
  return true;
}

/** The water's level on q if it's wet (x; y 1), else its ground (x; y 0). */
fn waterLevelAt(q: vec2<i32>) -> vec2<f32> {
  let j = colIdxI(clampCell(q));
  let bed = f32(sfZ(surface[j])) + driftAt(clampCell(q));
  let d = water[j];
  if (inMap(q) && d > WATER_MIN_R) { return vec2<f32>(bed + d, 1.0); }
  return vec2<f32>(bed, 0.0);
}

/**
 * Water over the field mesh (?mesh=1): no prisms but one smooth sheet over
 * the triangle lattice of the cell centres. A wet column draws the six
 * triangles round its centre (18 vertices), each of them drawn once, by its
 * wet corner first in storage order (it's blended: twice would show). A dry
 * corner stands at the water's level, or at its own ground where that's
 * lower: the sheet runs on into a bank, and the opaque ground's depth cuts
 * the shore there; down a step it slopes to the ground below and thins out.
 */
fn waterSheetVertex(b: Box, vi: u32, out: ptr<function, VOut>) -> bool {
  if (vi >= 18u) { return false; }
  let t = vi / 3u;
  let p = b.cell;
  // the triangle's corners: me and the neighbours across sides t and t + 1
  let qa = nbr(p, SIDE_DIR[t]);
  let qb = nbr(p, SIDE_DIR[(t + 1u) % 6u]);
  let me = waterLevelAt(p);
  let la = waterLevelAt(qa);
  let lb = waterLevelAt(qb);
  let ip = colIdxI(p);
  if (la.y > 0.0 && colIdxI(qa) < ip) { return false; }
  if (lb.y > 0.0 && colIdxI(qb) < ip) { return false; }
  // the level of its wet corners; a dry corner at that level or its ground below it
  let level = (me.x + la.x * la.y + lb.x * lb.y) / (1.0 + la.y + lb.y);
  let za = select(min(level, la.x), la.x, la.y > 0.0);
  let zb = select(min(level, lb.x), lb.x, lb.y > 0.0);
  let pa = vec3<f32>(cellPos(qa), za);
  let pb = vec3<f32>(cellPos(qb), zb);
  let pm = vec3<f32>(cellPos(p), me.x);
  let k = vi % 3u;
  var v = pm;
  if (k == 1u) { v = pa; } else if (k == 2u) { v = pb; }
  var n = normalize(cross(pa - pm, pb - pm));
  if (n.z < 0.0) { n = -n; }
  (*out).pos = CAM.viewProj * vec4<f32>(v, 1.0);
  (*out).wpos = v;
  (*out).nrm = n;
  (*out).info = vec2<u32>(MAT_WATER, 0u);
  (*out).zr = vec2<f32>(b.z0, b.z1);
  (*out).tint = 1.0;
  (*out).bmin = vec3<f32>(cellPos(p) - 0.5, b.z0);
  (*out).bsize = vec3<f32>(1.0, 1.0, b.z1 - b.z0);
  (*out).boff = vec3<f32>(0.0);
  (*out).sides = 0u;
  return true;
}

/**
 * (watersurf, FC2) The water's top as one surface: watersurf.wgsl lists the lattice's triangles that have a wet
 * corner, as three window-order column indices, and this is the vertex of column vi (a column's vertex is shared
 * by its six triangles, worked out once). A wet column stands at its water's level; a dry one (a shore's or a
 * bank's corner) at the lowest level of the water beside it, or its own ground where that's lower: the sheet runs
 * flat into a bank and the opaque ground's depth cuts the shore there; down a step it slopes to the ground below
 * and thins out (waterSheetVertex's rule a vertex, not a triangle: by the lowest water, so a bank between a pool
 * and the river below it never stands up out of the ground). The normal is the triangle's own (fsWaterSurf).
 */
@vertex
fn vsWaterSurf(@builtin(vertex_index) vi: u32) -> VOut {
  let p = vec2<i32>(winXY(vi));
  let me = waterLevelAt(p);
  var z = me.x;
  if (me.y == 0.0) {
    var low = 1e9;
    for (var k = 0u; k < NDIR; k++) {
      let l = waterLevelAt(nbr(p, k));
      if (l.y > 0.0) { low = min(low, l.x); }
    }
    z = min(low, me.x);
  }
  let v = vec3<f32>(cellPos(p), z);
  var o: VOut;
  o.pos = CAM.viewProj * vec4<f32>(v, 1.0);
  o.wpos = v;
  o.nrm = vec3<f32>(0.0, 0.0, 1.0);
  o.info = vec2<u32>(MAT_WATER, 0u);
  o.zr = vec2<f32>(me.x, z);
  o.tint = 1.0;
  o.bmin = vec3<f32>(v.xy - 0.5, me.x);
  o.bsize = vec3<f32>(1.0, 1.0, 0.0);
  o.boff = vec3<f32>(0.0);
  o.sides = 0u;
  return o;
}

