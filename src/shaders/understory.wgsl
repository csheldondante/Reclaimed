// ---- the understory's look (round 125, `forest`; BACKLOG FLO32; api/contracts/understory.ts) ----------------------
// Appended to render.wgsl wherever it goes (renderer.ts RENDER): its Camera's `under` block, written by
// render/camera.ts from forest/understory.ts. All of it multiplies by the weight CAM.under[0].w, 0 outside a wood: the
// draw as it was. The sun's camera has a zero block, so its shadow map keeps every leaf (the dither only leaves the
// eye's fragments out, the user's handoff: absent on screen must not mean absent in the world).

fn underWeight() -> f32 { return CAM.under[0].w; }

/** the hero's feet, the hole's radius */
fn underHero() -> vec3<f32> { return CAM.under[0].xyz; }

/**
 * How far a tree's fragment at p (its tree's foot `foot`) is into the dither, 0 kept .. 1 left out (compared with the
 * 4 x 4 ordered dither, so it thins out stably in pixel-art steps). With the canopy left out under it (meshinst.wgsl),
 * only what would hide the hero goes: a keyhole round the hero on screen through the trunks and roots in front of it,
 * over a stump's height — the massive trunks round it stay whole and frame the scene, as in the reference (main's
 * review of the first shots: "no trunks in frame"). With the canopy kept (its treatment off), the crowns in front of
 * the hero go too, so the floor still shows.
 */
fn underHide(p: vec3<f32>, foot: vec3<f32>) -> f32 {
  let w = CAM.under[0].w * CAM.under[2].x;
  if (w <= 0.0) { return 0.0; }
  let hero = CAM.under[0].xyz;
  let R = max(CAM.under[1].y, 1.0);
  let e = toEye(p);
  let ex = normalize(e.xy + vec2<f32>(1e-5, 0.0));
  // the keyhole: near the hero's figure on screen (its middle a cell and a bit up), and nearer the eye than it
  let c = hero + vec3<f32>(0.0, 0.0, 2.2);
  let v = p - c;
  let along = dot(v, e);
  let d = length(v - along * e);
  let key = (1.0 - smoothstep(R * 0.3, R * 0.45, d)) * smoothstep(0.5, 1.5, along) * smoothstep(1.0, 1.8, p.z - foot.z);
  // (the canopy kept: the crowns whose line from the eye comes down in front of the hero)
  let t = (p.z - hero.z) / max(e.z, 0.05);
  let g = p.xy - e.xy * t;
  let cz = CAM.under[1].x;
  let crownH = smoothstep(cz - 3.0, cz - 1.0, p.z) * (1.0 - CAM.under[1].z);
  let ahead = smoothstep(-R * 0.7, -R * 0.2, dot(g - hero.xy, ex));
  return w * max(key, crownH * ahead);
}

/** sun flecks: the sun through the canopy's holes as small ellipses on the ground (a pinhole image of the sun is a
 *  disc, stretched along the sun's way on the floor), 0..1; `q` the point projected up the sun's ray to the canopy */
fn underFlecks(q: vec2<f32>, stretch: vec2<f32>, open: f32) -> f32 {
  var best = 0.0;
  // (two layers: big patches where the canopy opens a little, small flecks between)
  for (var l = 0; l < 2; l++) {
    let s = select(2.6, 1.15, l == 1);
    let p = q / s;
    let c = floor(p);
    for (var j = -1; j <= 1; j++) {
      for (var i = -1; i <= 1; i++) {
        let cc = c + vec2<f32>(f32(i), f32(j));
        let h = randv(vec3<i32>(i32(cc.x), i32(cc.y), 9133 + l * 17));
        let h2 = randv(vec3<i32>(i32(cc.x), i32(cc.y), 9134 + l * 17));
        let h3 = randv(vec3<i32>(i32(cc.x), i32(cc.y), 9135 + l * 17));
        // (not every cell has a hole)
        // (`open` 0..1: a dark grove's few holes .. a bright glade's many)
        if (h3 > select(0.42, 0.55, l == 1) * mix(0.35, 1.5, open)) { continue; }
        let o = cc + vec2<f32>(h, h2) * 0.8 + 0.1;
        var dv = (p - o) * s;
        // the ellipse: shorter across the sun's way
        let along = dot(dv, stretch) / max(dot(stretch, stretch), 1e-4);
        let across = dv - stretch * along;
        let r = (0.25 + 0.55 * h3) * s * 0.55;
        let dd = length(vec2<f32>(along, length(across))) / r;
        best = max(best, 1.0 - smoothstep(0.75, 1.0, dd));
      }
    }
  }
  return best;
}

/**
 * The sun's visibility under the canopy (lighting()'s `lit`, 0..1): where the shadow map says shaded and the point is
 * under the canopy, the sun comes through as leaf-light flecks drifting with the canopy's sway; where it's lit (a gap)
 * it stays lit; the canopy's own crowns and anything over its underside are left as they are. A stencil, not the
 * shadow map's soft blur: the user's "make leave shadows stencil".
 */
fn underDapple(wpos: vec3<f32>, lit: f32) -> f32 {
  let w = CAM.under[0].w * CAM.under[2].y;
  if (w <= 0.0) { return lit; }
  let hero = CAM.under[0].xyz;
  let cz = CAM.under[1].x;
  // (round the hero, under the canopy's underside)
  let k = w * (1.0 - smoothstep(34.0, 44.0, length(wpos.xy - hero.xy))) * (1.0 - smoothstep(cz - 2.0, cz + 1.0, wpos.z));
  if (k <= 0.0) { return lit; }
  let sun = sunDir();
  let up = max(cz - wpos.z, 0.0) / max(sun.z, 0.2);
  // (the canopy's sway: the pattern drifts a little with the wind and the gusts; world-fixed otherwise)
  let sway = vec2<f32>(sin(G.time * 0.7 + wpos.y * 0.05), cos(G.time * 0.55 + wpos.x * 0.04)) * 0.25 + vec2<f32>(G.windX, G.windY) * 0.04 * sin(G.time * 1.3);
  let q = wo(wpos.xy + sun.xy * up) + sway;
  let stretch = -sun.xy / max(sun.z, 0.25);
  let f = underFlecks(q, normalize(stretch + vec2<f32>(1e-4, 0.0)) * (1.0 + length(stretch) * 0.6), underGrove(wpos.xy));
  // (pixel-art steps: three levels)
  let fq = floor(f * 2.99) / 2.0;
  // under the crowns (the shadow map's shade): the sun only through the stencil's holes, flecks in deep shade — main's
  // review: the dapple must be the floor's dominant light shapes; in a gap or a clearing (lit): kept, its edge broken
  var res = mix(mix(0.04, 1.0, fq), lit * (0.8 + 0.2 * fq), smoothstep(0.35, 0.75, lit));
  // (a pool of light round the hero, so its figure reads against the dark floor — the stage's spot)
  let pool = 1.0 - smoothstep(1.2, 2.6, length(wpos.xy - hero.xy));
  res = max(res, pool * 0.85 * lit);
  return mix(lit, res, k);
}

/**
 * (round 125, the user: "we can make darker areas ... that will feel varied and interesting") How open the canopy is
 * over a stretch of the wood, 0 a dark grove .. 1 a bright glade: slow world-fixed noise (~40 cells across), so walking
 * through the wood passes from shade into sunlit patches and back.
 */
fn underGrove(xy: vec2<f32>) -> f32 { return smoothstep(0.25, 0.75, vnoise(wo(xy) * 0.025 + vec2<f32>(31.0, 7.0))); }

/** the ambient under the canopy: the sky's light is the leaves' (a little red-warm from the copper crowns), deeper */
fn underAmbient(wpos: vec3<f32>) -> f32 {
  let w = CAM.under[0].w;
  if (w <= 0.0) { return 1.0; }
  let cz = CAM.under[1].x;
  let k = w * (1.0 - smoothstep(34.0, 44.0, length(wpos.xy - CAM.under[0].xy))) * (1.0 - smoothstep(cz - 2.0, cz + 1.0, wpos.z));
  // (deeper in a dark grove, lighter in a glade)
  return 1.0 - mix(0.7, 0.45, underGrove(wpos.xy)) * k;
}

/**
 * The mist under the canopy (haze()): low over the floor, thicker away behind the hero (aerial perspective: the
 * reference's far trunks fade into it), lit by the sun's colour — a world within the world.
 */
fn underMist(c: vec3<f32>, wpos: vec3<f32>) -> vec3<f32> {
  let w = CAM.under[0].w * CAM.under[2].w;
  if (w <= 0.0) { return c; }
  let hero = CAM.under[0].xyz;
  let e = toEye(wpos);
  let behind = max(-dot(wpos - hero, e), 0.0);
  let low = 1.0 - smoothstep(hero.z + 1.0, hero.z + 9.0, wpos.z);
  let drift = vnoise(wo(wpos.xy) * 0.12 + vec2<f32>(G.time * 0.05, G.time * 0.02));
  // (main's review: the haze washed the scene into one value — the mist only far behind, and thin)
  let k = w * 0.32 * smoothstep(14.0, 50.0, behind) * (0.45 + 0.55 * low) * (0.7 + 0.5 * drift);
  let mistC = toLinear(G.sunCol.rgb * vec3<f32>(0.55, 0.42, 0.36) + G.sky.rgb * 0.25);
  return mix(c, mistC, clamp(k, 0.0, 0.7));
}
