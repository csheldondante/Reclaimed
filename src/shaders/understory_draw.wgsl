// ---- the understory's own draw (round 125, `forest`; BACKLOG FLO32): light shafts and falling leaves -------------
// Appended after render.wgsl + understory.wgsl (renderer.ts: the draw layout and its bind group, so the camera, the
// Globals, the land's surface and the shadow map are the same as every draw's). Nothing is stored: every shaft and leaf
// is a hash of its instance index and the time, anchored to the world (they don't swim as the hero moves). Drawn only
// while CAM.under's weight is over 0 (renderer.ts skips the draws otherwise).
//
//   shafts (vsRay / fsRay, additive): crepuscular rays — a slanted beam from the canopy down the sun's way to a lit
//          spot on the floor (the shadow map says the sun gets there: a gap), its light the sun's, banded by drifting
//          mist and stepped in the 4 x 4 dither (pixel art); 16 instances on a world-fixed 7-cell lattice round the hero.
//   leaves (vsLeaf / fsLeaf, opaque cut-out): leaves falling from the crowns round the hero — tumbling, fluttering,
//          carried by the prevailing wind; a 7 x 7 pixel leaf; 160 instances in a world-fixed box that wraps round
//          the hero.

const LEAF_BOX: vec2<f32> = vec2<f32>(28.0, 30.0);

struct RayOut {
  @builtin(position) pos: vec4<f32>,
  // x across the beam (-1..1), y down it (0 the canopy .. 1 the floor), z its strength, w its seed
  @location(0) uv: vec4<f32>,
};

fn underRand(i: u32, salt: u32) -> f32 { return f32(pcg((i * 2654435761u) ^ pcg(salt)) >> 8u) / 16777216.0; }
fn cellRand(c: vec2<i32>, salt: u32) -> f32 { return f32(pcg(bitcast<u32>(c.x) ^ pcg(bitcast<u32>(c.y) ^ pcg(salt))) >> 8u) / 16777216.0; }

/** the land's top at a window point (the nature grid's surface) */
fn underGround(w: vec2<f32>) -> f32 { return f32(sfZ(surface[colIdxI(clampCell(cellAt(w)))])); }

@vertex
fn vsRay(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> RayOut {
  var o: RayOut;
  o.pos = vec4<f32>(2.0, 2.0, 2.0, 1.0);
  let w = CAM.under[0].w * CAM.under[2].z;
  let sun = sunDir();
  if (w <= 0.0 || sun.z < 0.08) { return o; }
  let hero = CAM.under[0].xyz;
  let cz = CAM.under[1].x;
  // (a beam comes down through one of the canopy stencil's big holes — understory.wgsl underFlecks' first layer, the
  // same hashes — so it lands on the floor's big fleck: the stencil's lattice in the canopy's plane round the hero's,
  // every other cell of a 7 x 7 block)
  let up = max(cz - hero.z, 0.0) / max(sun.z, 0.2);
  let S = 2.6;
  let hq = wo(hero.xy + sun.xy * up);
  let c = floor(hq / S) + vec2<f32>(f32(i32(ii % 4u) - 2), f32(i32(ii / 4u) - 2)) * 2.0;
  let h = randv(vec3<i32>(i32(c.x), i32(c.y), 9133));
  let h2 = randv(vec3<i32>(i32(c.x), i32(c.y), 9134));
  let h3 = randv(vec3<i32>(i32(c.x), i32(c.y), 9135));
  let oq = (c + vec2<f32>(h, h2) * 0.8 + 0.1) * S;
  let foot = oq - G.org.xy - sun.xy * up;
  if (h3 > 0.42 * mix(0.35, 1.5, underGrove(foot))) { return o; }
  let gz = underGround(foot);
  // (only where the sun reaches the canopy over it: no beam in a storm's shade or at night)
  let s = w * (0.6 + 0.4 * h) * (1.0 - smoothstep(10.0, 16.0, length(foot - hero.xy))) * smoothstep(0.08, 0.25, sun.z);
  if (s < 0.02) { return o; }
  let top = vec3<f32>(foot, gz) + sun * ((cz + 2.0 - gz) / max(sun.z, 0.2));
  let bot = vec3<f32>(foot, gz);
  let axis = normalize(top - bot);
  let side = normalize(cross(axis, CAM.eye.xyz) + vec3<f32>(1e-5, 0.0, 0.0));
  // (as wide as its hole: underFlecks' radius)
  let wid = (0.25 + 0.55 * h3) * S * 0.4;
  let q = array<vec2<f32>, 6>(vec2<f32>(-1.0, 0.0), vec2<f32>(1.0, 0.0), vec2<f32>(1.0, 1.0), vec2<f32>(-1.0, 0.0), vec2<f32>(1.0, 1.0), vec2<f32>(-1.0, 1.0))[vi];
  let p = mix(top, bot, q.y) + side * q.x * wid * mix(0.8, 1.2, q.y);
  o.pos = CAM.viewProj * vec4<f32>(p, 1.0);
  o.uv = vec4<f32>(q.x, q.y, s, h2);
  return o;
}

@fragment
fn fsRay(in: RayOut) -> FOut {
  let u = in.uv.x;
  let v = in.uv.y;
  // the beam's body: soft across (no edge), brightest under the canopy's hole and fading out down its length before
  // the floor — main's review: "soft, faint and additive, fading along their length, like the reference's misty shafts"
  let across = 1.0 - u * u;
  var a = across * across * smoothstep(0.0, 0.2, v) * (1.0 - smoothstep(0.35, 1.0, v));
  // banded by the mist drifting through it
  let n = vnoise(vec2<f32>(u * 1.3 + in.uv.w * 40.0, v * 5.0 - G.time * 0.25)) * 0.6 + vnoise(vec2<f32>(u * 3.0 - G.time * 0.1, v * 11.0 + in.uv.w * 9.0)) * 0.4;
  a *= (0.35 + 0.85 * n) * in.uv.z * 0.16;
  // (pixel art without bars: eight faint steps, dithered between — each pixel adds a little light, never a slab)
  let st = a * 8.0;
  let qa = (floor(st) + select(0.0, 1.0, fract(st) > bayer4(in.pos.xy))) / 8.0;
  if (qa <= 0.0) { discard; }
  // (added to the target as it is — sRGB — so a faint beam stays faint: toSrgb would lift it into a bar)
  let col = G.sunCol.rgb * vec3<f32>(0.95, 0.76, 0.52) * qa;
  var o: FOut;
  o.color = vec4<f32>(col, 1.0);
  o.pick = vec2<u32>(0u, 0u);
  return o;
}

struct LeafOut {
  @builtin(position) pos: vec4<f32>,
  // xy the leaf's own coordinates (-1..1), z its light, w its shade
  @location(0) uv: vec4<f32>,
};

@vertex
fn vsLeaf(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> LeafOut {
  var o: LeafOut;
  o.pos = vec4<f32>(2.0, 2.0, 2.0, 1.0);
  let w = CAM.under[0].w * CAM.under[3].x;
  if (w <= 0.0 || underRand(ii, 0x1e1u) > w) { return o; }
  let hero = CAM.under[0].xyz;
  let cz = CAM.under[1].x;
  // (world-fixed: its place in a box that wraps round the hero, drifted along by the prevailing wind)
  let base = vec2<f32>(underRand(ii, 0x1e2u), underRand(ii, 0x1e3u)) * LEAF_BOX;
  let t = G.time;
  let fall = 0.7 + 0.6 * underRand(ii, 0x1e4u);
  let span = max(cz - hero.z + 2.0, 4.0);
  let ph = fract(t * fall / span + underRand(ii, 0x1e5u));
  let drift = G.env.xy * 0.6;
  let rel = base + drift - (hero.xy + G.org.xy) + LEAF_BOX * 0.5;
  var xy = hero.xy + (rel - floor(rel / LEAF_BOX) * LEAF_BOX) - LEAF_BOX * 0.5;
  // flutter: a leaf swings side to side as it falls
  let sw = underRand(ii, 0x1e6u) * 6.28;
  xy += vec2<f32>(sin(t * 1.9 + sw), cos(t * 1.4 + sw * 1.3)) * 0.55;
  let gz = underGround(xy);
  let z = mix(cz + 1.5, gz + 0.1, ph);
  // (it grows in at the top and shrinks out as it lands)
  let size = 0.24 * smoothstep(0.0, 0.05, ph) * (1.0 - smoothstep(0.95, 1.0, ph)) * (0.8 + 0.4 * underRand(ii, 0x1e7u));
  if (size <= 0.0) { return o; }
  // tumbling: turning round, and flipping (its width by the cosine of its spin)
  let spin = t * (2.0 + 2.0 * underRand(ii, 0x1e8u)) + sw;
  let turn = t * (0.8 + underRand(ii, 0x1e9u)) + sw * 2.0;
  let q = array<vec2<f32>, 6>(vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, -1.0), vec2<f32>(1.0, 1.0), vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, 1.0), vec2<f32>(-1.0, 1.0))[vi];
  let cs = cos(turn);
  let sn = sin(turn);
  let lq = vec2<f32>(q.x * max(abs(cos(spin)), 0.25), q.y);
  let r = vec2<f32>(lq.x * cs - lq.y * sn, lq.x * sn + lq.y * cs);
  // (a square on screen: the camera's right and up)
  let e = CAM.eye.xyz;
  let right = normalize(vec3<f32>(-e.y, e.x, 0.0) + vec3<f32>(1e-5, 0.0, 0.0));
  let up = normalize(cross(e, right));
  let p = vec3<f32>(xy, z) + (right * r.x + up * r.y) * size;
  o.pos = CAM.viewProj * vec4<f32>(p, 1.0);
  let lit = shadowLit(vec3<f32>(xy, z), vec3<f32>(0.0, 0.0, 1.0));
  o.uv = vec4<f32>(q.x, q.y, lit, underRand(ii, 0x1eau));
  return o;
}

// a pixel leaf, 7 x 7 (rows from the top; 1 a pixel of leaf): a maple's five points and its stalk
const LEAF_MASK = array<u32, 7>(0x08u, 0x2au, 0x3eu, 0x7fu, 0x3eu, 0x1cu, 0x08u);

@fragment
fn fsLeaf(in: LeafOut) -> FOut {
  let g = vec2<i32>(clamp(floor((in.uv.xy * 0.5 + 0.5) * 7.0), vec2<f32>(0.0), vec2<f32>(6.0)));
  if (((LEAF_MASK[6 - g.y] >> u32(g.x)) & 1u) == 0u) { discard; }
  // (the copper-red of the crowns over the hero, by the season: understory.wgsl's leaf colour from CAM.under[3])
  var c = CAM.under[3].yzw;
  c = mix(c * 0.62, c, in.uv.w);
  // (a vein: the middle column a little darker)
  if (g.x == 3) { c *= 0.82; }
  let col = toLinear(c) * (0.45 + 0.75 * in.uv.z) * G.sunCol.rgb * 0.9 + toLinear(c) * G.sky.rgb * 0.25;
  var o: FOut;
  o.color = vec4<f32>(toSrgb(haze(col, CAM.under[0].xyz)), 1.0);
  o.pick = vec2<u32>(0u, 0u);
  return o;
}

// ---- (round 125) the litter: fallen leaves lying on the floor round the hero, blown along by the wind --------------
// The user: "leafs on the ground (already in the engine) blowing with wind". The engine's own (particles.wgsl K_LEAF,
// MAT_LEAFLIT) stay; these are the carpet's loose top leaves round the hero, many more than the particles can afford
// over a whole wood. Stateless: each leaf's place is its home plus the prevailing wind integrated over time (G.env.xy,
// the same drift that carries the gust patches) times its own looseness — so they slide when the wind blows and lie
// still when it drops, all one way, as the real wind goes; a hop and a tumble while the wind at it (windAt: the
// player's gusts too) is strong.
const LITTER_BOX: vec2<f32> = vec2<f32>(24.0, 26.0);

@vertex
fn vsLitter(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> LeafOut {
  var o: LeafOut;
  o.pos = vec4<f32>(2.0, 2.0, 2.0, 1.0);
  let w = CAM.under[0].w * CAM.under[3].x;
  if (w <= 0.0 || underRand(ii, 0x117u) > w) { return o; }
  let hero = CAM.under[0].xyz;
  let loose = 0.25 + 0.75 * underRand(ii, 0x118u);
  let home = vec2<f32>(underRand(ii, 0x119u), underRand(ii, 0x11au)) * LITTER_BOX;
  let rel = home + G.env.xy * loose - (hero.xy + G.org.xy) + LITTER_BOX * 0.5;
  let xy = hero.xy + (rel - floor(rel / LITTER_BOX) * LITTER_BOX) - LITTER_BOX * 0.5;
  // (fades out at the box's rim, where it wraps)
  let edge = (rel - floor(rel / LITTER_BOX) * LITTER_BOX) / LITTER_BOX;
  let rim = smoothstep(0.0, 0.08, min(min(edge.x, 1.0 - edge.x), min(edge.y, 1.0 - edge.y)));
  let wnd = windAt(vec3<f32>(xy, hero.z + 0.3));
  let ws = length(wnd);
  let gz = underGround(xy);
  // (a hop and a tumble in a strong wind: lifted off the floor, turning over)
  let lift = smoothstep(2.5, 7.0, ws * loose);
  let ph = G.time * (4.0 + 3.0 * loose) + underRand(ii, 0x11bu) * 6.28;
  let z = gz + 0.06 + lift * abs(sin(ph)) * 0.45;
  let size = 0.2 * (0.8 + 0.4 * underRand(ii, 0x11cu)) * rim;
  if (size <= 0.0) { return o; }
  let turn = underRand(ii, 0x11du) * 6.28 + dot(G.env.xy, vec2<f32>(0.7, 0.5)) * loose + lift * ph;
  let q = array<vec2<f32>, 6>(vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, -1.0), vec2<f32>(1.0, 1.0), vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, 1.0), vec2<f32>(-1.0, 1.0))[vi];
  let cs = cos(turn);
  let sn = sin(turn);
  // (lying flat on the floor, tipped up a little as it hops)
  let r = vec2<f32>(q.x * cs - q.y * sn, q.x * sn + q.y * cs) * size;
  let p = vec3<f32>(xy + r, z + q.y * lift * 0.12);
  o.pos = CAM.viewProj * vec4<f32>(p, 1.0);
  let lit = underDapple(vec3<f32>(xy, gz), shadowLit(vec3<f32>(xy, gz + 0.1), vec3<f32>(0.0, 0.0, 1.0)));
  o.uv = vec4<f32>(q.x, q.y, lit, underRand(ii, 0x11eu));
  return o;
}
