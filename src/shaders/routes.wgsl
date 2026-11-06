// ---- the riders on their routes (round 128p, DA-A13; agents/routeride.ts drives it, agents/routes.ts makes the routes)
// The user: "I expect units to share routes. They should be cached and parameterized so it is just a queue with dt
// interpolation". A route is its points (the town's frame: x, y, z world, the length along it to there), shared by every
// rider on it; a rider is an entry: its unit, its route, how far along it is (t, metres; < 0: still on its way to the
// route's first point from where it joined, `lead` metres off), its speed, the entry ahead of it on its route.
//  * routeAdvance (an agents stage, a thread an entry): t += dt × speed, kept GAP behind the one ahead (a queue: no
//    passing yet — traffic is for looks, DESIGN §12); the unit placed at f(route, t) — x, y, its height the route's (a
//    bridge's deck, a stair's step), heading along it — and its steer word RIDE_TRIP (units.wgsl moves it no further);
//    at the end it stands (STAND: units.wgsl tells its arrival once). A unit knocked down, thrown or swinging isn't
//    placed: when it walks again it rejoins its route where it's nearest (once). Nothing else a tick: no search, no
//    field, nothing O(network).
// Includes common.wgsl (Globals: dt).

const RT_UNIT_V: u32 = 6u;
const RT_STAND: f32 = -1.0;
const RT_TRIP: f32 = -2.0;

struct RouteParams {
  /** x entries (the high-water mark), y the units' slots, zw unused */
  n: vec4<u32>,
  /** xy the routes' frame in the window (world units), z the window's oz (window z = world z − oz), w the queue's gap (m) */
  off: vec4<f32>,
};

@group(0) @binding(52) var<storage, read_write> rtUnits: array<vec4<f32>>;
/** per point: x, y (the routes' frame), z (world), the length along its route to it */
@group(0) @binding(53) var<storage, read> rtPts: array<vec4<f32>>;
/** per route: its first point, its points, its group, its length (f32 bits) */
@group(0) @binding(54) var<storage, read> rtRoutes: array<vec4<u32>>;
/** per entry two vec4: (t, speed, route as bits, unit slot as bits), (start x, y, z world, lead) */
@group(0) @binding(55) var<storage, read_write> rtEntries: array<vec4<f32>>;
/** per entry: x the entry ahead on its route (-1 none: as u32 0xffffffff), y its state (0 free, 1 riding, 2 off it) */
@group(0) @binding(56) var<storage, read_write> rtState: array<vec2<u32>>;
@group(0) @binding(57) var<uniform> RT: RouteParams;

const RT_NONE: u32 = 0xffffffffu;

/** the point at t along route r (t ≥ 0) and the direction there */
fn rtAt(r: vec4<u32>, t: f32) -> array<vec4<f32>, 2> {
  // (binary search: the last point whose length along ≤ t)
  var lo = r.x;
  var hi = r.x + r.y - 1u;
  while (lo < hi) {
    let m = (lo + hi + 1u) / 2u;
    if (rtPts[m].w <= t) { lo = m; } else { hi = m - 1u; }
  }
  let a = rtPts[lo];
  let b = rtPts[min(lo + 1u, r.x + r.y - 1u)];
  let L = max(b.w - a.w, 1e-6);
  let u = clamp((t - a.w) / L, 0.0, 1.0);
  let d = b.xy - a.xy;
  let dl = length(d);
  return array<vec4<f32>, 2>(vec4<f32>(mix(a.xyz, b.xyz, u), 0.0), vec4<f32>(select(vec2<f32>(0.0), d / dl, dl > 1e-6), 0.0, 0.0));
}

@compute @workgroup_size(64)
fn routeAdvance(@builtin(global_invocation_id) id: vec3<u32>) {
  let i = id.x;
  if (i >= RT.n.x) { return; }
  var st = rtState[i];
  if (st.y == 0u) { return; }
  var e0 = rtEntries[i * 2u];
  let e1 = rtEntries[i * 2u + 1u];
  let slot = bitcast<u32>(e0.w);
  let r = rtRoutes[bitcast<u32>(e0.z)];
  let len = bitcast<f32>(r.w);
  let a = rtUnits[slot * RT_UNIT_V];
  let info = bitcast<u32>(a.w);
  let alive = ((info >> 8u) & 1u) != 0u;
  let walking = ((info >> 12u) & 7u) <= 1u;
  // (its group not the route's — moved on by the game this tick: the CPU frees the entry; nothing placed meanwhile)
  if (!alive || (info & 0xffu) != r.z) { return; }
  var steerW = rtUnits[slot * RT_UNIT_V + 4u];
  if (!walking) {
    // (knocked off: the physics has it; rejoined where it's nearest when it walks again)
    if (st.y == 1u) {
      st.y = 2u;
      rtState[i] = st;
    }
    if (steerW.w != 0.0) {
      steerW.w = 0.0;
      rtUnits[slot * RT_UNIT_V + 4u] = steerW;
    }
    return;
  }
  let off = RT.off.xy;
  if (st.y == 2u) {
    // (back on its feet: on at the route's point nearest it — once)
    let p = a.xy - off;
    var best = 0.0;
    var bd = 1e30;
    for (var k = r.x; k < r.x + r.y; k++) {
      let d = length(rtPts[k].xy - p);
      if (d < bd) {
        bd = d;
        best = rtPts[k].w;
      }
    }
    e0.x = best;
    st.y = 1u;
    rtState[i] = st;
  }
  // (on: dt × speed, a gap behind the one ahead while it's on its way — the queue's order is the order they joined in,
  // so two that joined together part by the gap; one at the goal stands there, off the queue: each comes to the goal)
  var t = min(e0.x + G.dt * e0.y, len);
  if (st.x != RT_NONE) {
    let ta = rtEntries[st.x * 2u].x;
    if (ta < len) { t = min(t, ta - RT.off.w); }
  }
  t = max(t, e0.x);
  e0.x = t;
  rtEntries[i * 2u] = e0;
  // (where that puts it: on its way to the route — straight from where it joined — or along the route)
  var q: vec3<f32>;
  var dir: vec2<f32>;
  if (t < 0.0) {
    let p0 = rtPts[r.x];
    let u = clamp((t + e1.w) / max(e1.w, 1e-6), 0.0, 1.0);
    q = mix(e1.xyz, p0.xyz, u);
    let d = p0.xy - e1.xy;
    dir = select(vec2<f32>(0.0), d / length(d), length(d) > 1e-6);
  } else {
    let at = rtAt(r, t);
    q = at[0].xyz;
    dir = at[1].xy;
  }
  let done = t >= len;
  rtUnits[slot * RT_UNIT_V] = vec4<f32>(q.xy + off, q.z - RT.off.z, a.w);
  let b = rtUnits[slot * RT_UNIT_V + 1u];
  rtUnits[slot * RT_UNIT_V + 1u] = vec4<f32>(select(dir * e0.y, vec2<f32>(0.0), done), 0.0, b.w);
  let want = select(RT_TRIP, RT_STAND, done);
  if (steerW.w != want) {
    steerW.w = want;
    rtUnits[slot * RT_UNIT_V + 4u] = steerW;
  }
}
