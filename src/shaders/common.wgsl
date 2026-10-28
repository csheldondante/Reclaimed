// ---- common.wgsl -------------------------------------------------------
// Shared by every shader. Binding conventions (group 0):
//   0 = Globals (uniform)        — always present
//   1 = chunk table (storage)    — layers.wgsl
//   2 = material table (uniform) — materials.wgsl
//   3+ = per-shader buffers
// Keep in sync with src/sim/globals.ts.

// a cyclone (round 12; several at once since round 14): a = x, y, radius,
// strength × spin sign (0 = none); b = velocity x, y, dust-dropping rate as
// it dies, unused; spine = the funnel's nodes (Weather.spine): x, y, z, radius
struct CycloneU {
  a: vec4<f32>,
  b: vec4<f32>,
  spine: array<vec4<f32>, 6>,
};
const MAX_CYCLONES: u32 = 4u;

struct Globals {
  mapW: u32, mapH: u32, tick: u32, chunkSize: u32,
  chunksX: u32, zMax: u32, numStorms: u32, seed: u32,
  time: f32, dt: f32, windX: f32, windY: f32,
  sunX: f32, sunY: f32, sunZ: f32, pollution: f32,
  // per storm: x, y, radius, intensity(0..1)
  storms: array<vec4<f32>, 4>,
  // per storm: velocity x, y, downpour boost, lightning flash 0..1
  stormsB: array<vec4<f32>, 4>,
  // one-tick world events: x, y, radius, strength
  events: array<vec4<f32>, 4>,
  // per event kind (EV_*), as f32
  eventKind: vec4<f32>,
  // x: event count, y: structural collapse (0 off, 1 on, 2 damage only — the
  // sandbox's rigid bodies take the rest), z: lightning flash 0..1,
  // w: fine plants (1 = diorama-scale plants, the title screen)
  misc: vec4<f32>,
  // wind impulses (player gusts, cursor breeze): x, y, radius, strength
  gusts: array<vec4<f32>, 4>,
  // per gust: direction x, y (unit), falloff shape, unused
  gustDir: array<vec4<f32>, 4>,
  // sky / day-night: rgb ambient sky colour, w = night factor 0..1
  sky: vec4<f32>,
  // rgb sun colour × intensity, w = time of day 0..1
  sunCol: vec4<f32>,
  // life lens around the cursor: x, y, radius, strength 0..1 (0 = off)
  lens: vec4<f32>,
  // per storm shape: two outline phases, the smoothed heading (radians) the
  // outline is stretched along, and the elongation
  stormsC: array<vec4<f32>, 4>,
  // x, y: prevailing wind integrated over time (cells) — advects gust patches
  // and ripples so they travel smoothly downwind; z: debris seeding boost;
  // w: difficulty 0 easy, 1 medium, 2 hard
  env: vec4<f32>,
  // dust storms: x, y, radius, strength (0 = none)
  dusts: array<vec4<f32>, 2>,
  // the cyclones (no cap on summoning them: round 14)
  cyclones: array<CycloneU, 4>,
  // x: story rules (round 30: green spreads only by seeds and sheds them);
  // y: air temperature (°C) at height 0 by day, z: its fall per cell up
  // (round 50, the climate: sim/climate.ts); w: the season, 0..1 through
  // the year from midsummer (round 51)
  rules: vec4<f32>,
  // the window's world origin (a streamed world, round 66: scenes/streamer.ts):
  // xy in world units (noise of positions: wo()), zw in cells (hash3)
  org: vec4<f32>,
  // x: the sea's level in window z (round 79: past the window's edge the world is sea at it, so the sea in
  // the window doesn't drain out of it; −1e9 none); (hybrid) y the mesh chunks across (0: no heightfield
  // chunks), z a mesh chunk's side (cells; as many rows down) — the hfield mask's; w (round 84) the rivers'
  // wetness (sim/world-gpu.ts riverFlow)
  ocean: vec4<f32>,
  // (round 80, sim/sleep.ts) a bit a chunk (16 × 16 columns), set: asleep — the systems that change the
  // ground skip it; its water and lava keep their depth and flow (drawn moving). 2 048 chunks at most.
  sleep: array<vec4<u32>, 16>,
  // (round 80) a bit a chunk, set: just fallen asleep (a quarter second) — the passes that write the next
  // layers carry its slots through once, so the next layers hold what its last awake tick left
  drowse: array<vec4<u32>, 16>,
  // (hybrid, scenes/hybrid.ts) a bit a mesh chunk, set: the heightfield's — the LOD rings draw its land; the
  // window's water, plants and sheets aren't drawn there (renderprep, vegprep)
  hfield: array<vec4<u32>, 16>,
  // (round 105, `ringwin`) the window on a ring: every per-column buffer and texture holds window column (x, y) at
  // ((x + ring.x) mod W, (y + ring.y) mod H) — the world cell's place mod the window's size — so a slide moves
  // nothing; xy the offset (cells), zw unused. Window coordinates stay what every caller uses: index only through
  // colIdx / colIdxI / texCol / texCol2 / texColK, and back through colXY.
  ring: vec4<u32>,
  // (round 107, `pages`: docs/PAGES.md P2.1) the page table: window chunk (cy * chunks across + cx) -> the page its
  // data is in (P2.2: its slot), two u16 entries a u32 (sim/pages.ts Pages.table). Read by colSlot with ?pages=table.
  pages: array<vec4<u32>, 512>,
  // (round 107, P2.2) the table backwards: slot -> the window chunk in it, cx | cy << 8 (Pages.inv; colXY)
  pageInv: array<vec4<u32>, 512>,
};

/** (hybrid) Is column q in a heightfield chunk (drawn by the LOD rings, not the window's own draws)? */
fn heightfieldCol(q: vec2<u32>) -> bool {
  if (G.ocean.y < 0.5) { return false; }
  let side = G.ocean.z;
  let wx = f32(q.x) + 0.5 + 0.5 * f32(q.y & 1u);
  let c = u32(wx / side) + (q.y / u32(side)) * u32(G.ocean.y);
  if (c >= 2048u) { return false; }
  return ((G.hfield[c >> 7u][(c >> 5u) & 3u] >> (c & 31u)) & 1u) != 0u;
}

/** Has column q's chunk just fallen asleep (round 80)? */
fn drowsy(q: vec2<u32>) -> bool {
  let c = (q.y / G.chunkSize) * G.chunksX + q.x / G.chunkSize;
  if (c >= 2048u) { return false; }
  return ((G.drowse[c >> 7u][(c >> 5u) & 3u] >> (c & 31u)) & 1u) != 0u;
}

/** Is column q's chunk asleep (round 80)? Past the mask's 2 048 chunks: awake. */
fn asleep(q: vec2<u32>) -> bool {
  let c = (q.y / G.chunkSize) * G.chunksX + q.x / G.chunkSize;
  if (c >= 2048u) { return false; }
  return ((G.sleep[c >> 7u][(c >> 5u) & 3u] >> (c & 31u)) & 1u) != 0u;
}

// ---- the season (round 51): leaves turn, fall, and come back -------------------
/** 0..1 how far the deciduous leaves have turned (autumn; gone again by spring). */
fn seasonColour() -> f32 { let s = G.rules.w; return smoothstep(0.35, 0.55, s) * (1.0 - smoothstep(0.85, 0.92, s)); }
/** 0..1 how bare the deciduous crowns are (winter; they green again toward 1). */
fn seasonBare() -> f32 { let s = G.rules.w; return smoothstep(0.55, 0.78, s) * (1.0 - smoothstep(0.9, 1.0, s)); }
/** 0..1 how fast the leaves are coming down (the fall). */
fn seasonShed() -> f32 { let s = G.rules.w; return smoothstep(0.46, 0.56, s) * (1.0 - smoothstep(0.72, 0.8, s)); }
/**
 * Grass through the year (round 51): green in summer, gold and straw in the
 * fall (patches at their own pace, by h 0..1), a dull dry brown in winter,
 * green again in spring.
 */
fn seasonGrass(g: vec3<f32>, h: f32) -> vec3<f32> {
  let straw = mix(vec3<f32>(0.62, 0.52, 0.22), vec3<f32>(0.7, 0.6, 0.3), h);
  var c = mix(g, straw, seasonColour() * (0.45 + 0.4 * h));
  return mix(c, vec3<f32>(0.46, 0.39, 0.24) * (0.9 + 0.2 * h), seasonBare() * 0.75);
}
/** An autumn leaf's colour: birches (species 2) gold to yellow; the others red, orange or amber by h (0..1). */
fn autumnLeaf(species: u32, h: f32) -> vec3<f32> {
  if (species == 2u) { return mix(vec3<f32>(0.84, 0.62, 0.14), vec3<f32>(0.93, 0.83, 0.3), h); }
  if (h < 0.35) { return mix(vec3<f32>(0.62, 0.12, 0.07), vec3<f32>(0.78, 0.2, 0.08), h / 0.35); }
  if (h < 0.75) { return mix(vec3<f32>(0.85, 0.36, 0.08), vec3<f32>(0.92, 0.5, 0.12), (h - 0.35) / 0.4); }
  return mix(vec3<f32>(0.82, 0.58, 0.16), vec3<f32>(0.62, 0.42, 0.18), (h - 0.75) / 0.25);
}

/** The air's temperature (°C) at height z: colder up high, and at night. */
fn airTempAt(z: f32) -> f32 { return G.rules.y - G.rules.z * max(z, 0.0) - 4.0 * G.sky.w; }
/** 0..1 how much of what a storm drops at temperature t is snow (all of it a degree under freezing). */
fn snowShare(t: f32) -> f32 { return 1.0 - smoothstep(-1.0, 1.0, t); }

/** Point on cyclone c's funnel spine at t in 0..1 (Catmull-Rom through the nodes); w = radius. */
fn spineAt(c: u32, t: f32) -> vec4<f32> {
  let u = clamp(t, 0.0, 1.0) * 5.0;
  let i = min(u32(floor(u)), 4u);
  let f = u - f32(i);
  let p0 = G.cyclones[c].spine[max(i, 1u) - 1u];
  let p1 = G.cyclones[c].spine[i];
  let p2 = G.cyclones[c].spine[i + 1u];
  let p3 = G.cyclones[c].spine[min(i + 2u, 5u)];
  let f2 = f * f;
  let f3 = f2 * f;
  return 0.5 * ((2.0 * p1) + (-p0 + p2) * f + (2.0 * p0 - 5.0 * p1 + 4.0 * p2 - p3) * f2 + (-p0 + 3.0 * p1 - 3.0 * p2 + p3) * f3);
}

/** 0..1 how deep in a cyclone p is (1 inside an eye wall, 0 beyond ~2 radii). */
fn cycloneAt(p: vec2<f32>) -> f32 {
  var k = 0.0;
  for (var i = 0u; i < MAX_CYCLONES; i++) {
    let c = G.cyclones[i].a;
    if (c.w == 0.0) { continue; }
    k = max(k, abs(c.w) * smoothstep(2.0, 0.8, length(p - c.xy) / c.z));
  }
  return k;
}

const EV_LIGHTNING: u32 = 1u;
// a tap on masonry: small damage to the interval at height evZ(e)
const EV_CHIP: u32 = 2u;
// a tap on a tree: perched birds within the radius take off
const EV_SCARE: u32 = 3u;
// a tap on the ground: growth boost (or a wilt where nothing can take)
const EV_GROW: u32 = 4u;
// a click: a ring of wind pushing outward from it (windfield.wgsl)
const EV_RIPPLE: u32 = 6u;
// set alight (the world API's fire.ignite): fuel within the radius catches,
// at intensity w (fire.wgsl only; no damage, no flash)
const EV_IGNITE: u32 = 7u;
// eventKind packs kind (low 4 bits) and a z height (above): kind + 16·z
fn evKind(e: u32) -> u32 { return u32(G.eventKind[e]) & 15u; }
fn evZ(e: u32) -> u32 { return u32(G.eventKind[e]) >> 4u; }
fn numEvents() -> u32 { return u32(G.misc.x); }

@group(0) @binding(0) var<uniform> G: Globals;

// ---- the hex lattice (docs/GRIDS.md; mirrored in src/world/lattice.ts) ----
// Pointy-top hexes, centre to centre 1, rows √3/2 apart, odd rows shifted
// half a cell right ("odd-r" offset). Storage stays a w × h array indexed
// (x, y) = (column, row); world positions are cellPos(). The six directions
// come in opposite pairs, so k ^ 1 is the way back: E, W, NE, SW, NW, SE.
const NDIR: u32 = 6u;
const ROW_H: f32 = 0.8660254;
/** unit vector of each direction in the world plane */
const DIRV = array<vec2<f32>, 6>(
  vec2<f32>(1.0, 0.0), vec2<f32>(-1.0, 0.0),
  vec2<f32>(0.5, ROW_H), vec2<f32>(-0.5, -ROW_H),
  vec2<f32>(-0.5, ROW_H), vec2<f32>(0.5, -ROW_H));
// storage offsets to each neighbour, from an even row and from an odd row
const DOFF_E = array<vec2<i32>, 6>(vec2<i32>(1, 0), vec2<i32>(-1, 0), vec2<i32>(0, 1), vec2<i32>(-1, -1), vec2<i32>(-1, 1), vec2<i32>(0, -1));
const DOFF_O = array<vec2<i32>, 6>(vec2<i32>(1, 0), vec2<i32>(-1, 0), vec2<i32>(1, 1), vec2<i32>(0, -1), vec2<i32>(0, 1), vec2<i32>(1, -1));
/** the neighbour of cell p in direction k */
fn nbr(p: vec2<i32>, k: u32) -> vec2<i32> {
  if ((p.y & 1) == 0) { return p + DOFF_E[k]; }
  return p + DOFF_O[k];
}
/** world position (x, y) of a cell's centre */
fn cellPos(p: vec2<i32>) -> vec2<f32> {
  return vec2<f32>(f32(p.x) + 0.5 + 0.5 * f32(p.y & 1), (f32(p.y) + 0.5) * ROW_H);
}
/** world position → fractional axial coordinates (q, r) on the triangle
 *  lattice the cell centres form (cell (0, 0)'s centre at the origin) */
fn axialOf(w: vec2<f32>) -> vec2<f32> {
  let r = (w.y - 0.5 * ROW_H) / ROW_H;
  return vec2<f32>(w.x - 0.5 - 0.5 * r, r);
}
/** integer axial (q, r) → storage cell */
fn axialCell(a: vec2<i32>) -> vec2<i32> { return vec2<i32>(a.x + (a.y - (a.y & 1)) / 2, a.y); }
/** the cell whose hexagon contains world point w (cube rounding) */
fn cellAt(w: vec2<f32>) -> vec2<i32> {
  let a = axialOf(w);
  let c = vec3<f32>(a.x, a.y, -a.x - a.y);
  var r = round(c);
  let d = abs(r - c);
  if (d.x > d.y && d.x > d.z) { r.x = -r.y - r.z; } else if (d.y > d.z) { r.y = -r.x - r.z; }
  return axialCell(vec2<i32>(i32(r.x), i32(r.y)));
}
/** The three cell centres around world point w and their barycentric
 *  weights: smooth interpolation of a per-cell field over the triangle
 *  lattice of centres (exact at every centre). */
struct Tri { c: array<vec2<i32>, 3>, w: vec3<f32> }
fn triAt(w: vec2<f32>) -> Tri {
  let a = axialOf(w);
  let b = vec2<i32>(floor(a));
  let f = a - floor(a);
  var t: Tri;
  if (f.x + f.y < 1.0) {
    t.c = array<vec2<i32>, 3>(axialCell(b), axialCell(b + vec2<i32>(1, 0)), axialCell(b + vec2<i32>(0, 1)));
    t.w = vec3<f32>(1.0 - f.x - f.y, f.x, f.y);
  } else {
    t.c = array<vec2<i32>, 3>(axialCell(b + vec2<i32>(1, 1)), axialCell(b + vec2<i32>(0, 1)), axialCell(b + vec2<i32>(1, 0)));
    t.w = vec3<f32>(f.x + f.y - 1.0, 1.0 - f.x, 1.0 - f.y);
  }
  return t;
}

// Per-direction quantities (flux, sediment lanes): one f32 per direction.
// Arrays have no arithmetic, so the few operations needed are functions.
alias Dirs = array<f32, 6>;
/**
 * (perfopt, ?simhz=30|15 — DECISIONS round 83) The 60 Hz ticks of world time one tick stands for: 1 at 60 Hz, 2
 * at 30, 4 at 15. The systems' rates were written per 60 Hz tick; they scale by it so the world runs at the same
 * speed in its time whatever the tick rate: an increment × simStep(), a chance perTick(p), a decay or a
 * relaxation relaxTick(k).
 */
fn simStep() -> f32 { return G.dt * 60.0; }
/** a chance p a 60 Hz tick, over this tick */
fn perTick(p: f32) -> f32 { return 1.0 - pow(1.0 - clamp(p, 0.0, 1.0), simStep()); }
/** a fraction k a 60 Hz tick (a relaxation toward, a decay by), over this tick */
fn relaxTick(k: f32) -> f32 { return 1.0 - pow(1.0 - clamp(k, 0.0, 1.0), simStep()); }

/**
 * (perfopt, ?flowhz= — sim/flow.ts) Is this tick a sleeping chunk's turn to update a flow that runs every n ticks
 * asleep (0: never — frozen, drawn moving from its frozen flux)? Staggered over the chunks.
 */
fn slowTick(q: vec2<u32>, n: u32) -> bool {
  if (n == 0u) { return false; }
  return ((G.tick + chunkStagger(q / G.chunkSize)) % n) == 0u;
}
/** (round 107, pages: P2.3a) window chunk c's slow turn's offset, keyed by its world chunk (the window's origin, in
 *  cells, is whole chunks): the same chunk of the world takes the same turn wherever the window is — sim/cull.ts stagger */
fn chunkStagger(c: vec2<u32>) -> u32 {
  let w = vec2<i32>(c) + vec2<i32>(G.org.zw) / i32(G.chunkSize);
  return (u32(w.x) & 4095u) * 7u + (u32(w.y) & 4095u) * 29u;
}
/** (round 104, simscale — sim/cull.ts NEAR) is chunk (cx, cy) live: awake, or drowsy? Past the mask: awake. */
fn chunkLive(cx: i32, cy: i32) -> bool {
  if (cx < 0 || cy < 0 || u32(cx) >= G.chunksX) { return false; }
  let c = u32(cy) * G.chunksX + u32(cx);
  if (c >= 2048u) { return true; }
  let w = c >> 5u;
  let b = 1u << (c & 31u);
  return (G.sleep[w >> 2u][w & 3u] & b) == 0u || (G.drowse[w >> 2u][w & 3u] & b) != 0u;
}
/** is column q's chunk live or next to a live one (the 3 x 3 round it)? — sim/cull.ts NEAR's list */
fn nearLive(q: vec2<u32>) -> bool {
  let cx = i32(q.x / G.chunkSize);
  let cy = i32(q.y / G.chunkSize);
  let rows = i32((G.mapH + G.chunkSize - 1u) / G.chunkSize);
  for (var dy = -1; dy <= 1; dy++) {
    for (var dx = -1; dx <= 1; dx++) {
      if (cy + dy < 0 || cy + dy >= rows) { continue; }
      if (chunkLive(cx + dx, cy + dy)) { return true; }
    }
  }
  return false;
}
/** a flow's column frozen this tick: asleep, and not its slow turn */
fn flowFrozen(q: vec2<u32>, n: u32) -> bool { return asleep(q) && !slowTick(q, n); }

fn dZero() -> Dirs { return Dirs(0.0, 0.0, 0.0, 0.0, 0.0, 0.0); }
fn dSum(a: Dirs) -> f32 { return a[0] + a[1] + a[2] + a[3] + a[4] + a[5]; }
fn dScale(a: Dirs, s: f32) -> Dirs { var o = a; for (var k = 0u; k < NDIR; k++) { o[k] = a[k] * s; } return o; }
fn dAdd(a: Dirs, b: Dirs) -> Dirs { var o = a; for (var k = 0u; k < NDIR; k++) { o[k] = a[k] + b[k]; } return o; }
fn dAny(a: Dirs) -> bool { return a[0] > 0.0 || a[1] > 0.0 || a[2] > 0.0 || a[3] > 0.0 || a[4] > 0.0 || a[5] > 0.0; }
/** a vector's share along each direction (its positive projections) */
fn dSplit(v: vec2<f32>) -> Dirs { var o = dZero(); for (var k = 0u; k < NDIR; k++) { o[k] = max(dot(v, DIRV[k]), 0.0); } return o; }

// ---- (round 105, ringwin; round 107, pages) where a window column's data lies: chunk -> slot -> offset in the page --
// Every per-column buffer and texture is found the same way, the layers' way (layers.wgsl: a chunk's page from the
// chunk table): the column's chunk (COLS_PAGE columns a side), the slot of the page that chunk's data is in
// (`colSlot`: the page table, Globals.pages — docs/PAGES.md), the column's offset inside the page. A per-column
// buffer is page-major: a slot's 256 columns one after another, row-major (`colIdx`). A texture is a page atlas: a
// slot's 16 x 16 texels at (slot % chunks across, slot / chunks across) * 16 (`texPage`), the atlas the window's size.
// Index a column only through colIdx / colIdxI / texCol / texCol2 / texColK; back through colXY; hand the CPU winIdx.
/** columns a page side (world/layout.ts CHUNK; the ring's offset is whole pages) */
const COLS_PAGE: u32 = 16u;
/** chunks across and down the window */
fn pagesX() -> u32 { return G.mapW / COLS_PAGE; }
fn pagesY() -> u32 { return G.mapH / COLS_PAGE; }
/** window chunk c's page's slot. (Round 107, pages: which way is the build's — ?pages=, src/gpu/pages-mode.ts swaps
 *  the call below when a module is made: the ring's wrap computed (its places are the slots: identity only), or the
 *  table looked up) */
fn colSlot(c: vec2<u32>) -> u32 { return colSlotRing(c); } // PAGE_ADDR
/** the ring's place computed: c + ring mod the window's chunks, row-major (the identity's slot) */
fn colSlotRing(c: vec2<u32>) -> u32 {
  let x = c.x + G.ring.x / COLS_PAGE;
  let y = c.y + G.ring.y / COLS_PAGE;
  return select(y, y - pagesY(), y >= pagesY()) * pagesX() + select(x, x - pagesX(), x >= pagesX());
}
/** a u16 entry of a table of 512 vec4 (two a u32) */
fn pageWord(t: u32, i: u32) -> u32 {
  var w: u32;
  if (t == 0u) { w = G.pages[i >> 3u][(i >> 1u) & 3u]; } else { w = G.pageInv[i >> 3u][(i >> 1u) & 3u]; }
  return (w >> ((i & 1u) * 16u)) & 0xffffu;
}
/** (round 107) the table looked up: window chunk c's slot (Globals.pages) */
fn colSlotTable(c: vec2<u32>) -> u32 { return pageWord(0u, c.y * pagesX() + c.x); }
/** the window chunk in slot s (the table backwards: Globals.pageInv, or the ring's wrap backwards) */
fn slotChunk(s: u32) -> vec2<u32> {
  if (PAGE_TABLE) { let e = pageWord(1u, s); return vec2<u32>(e & 0xffu, e >> 8u); }
  let pg = vec2<u32>(s % pagesX(), s / pagesX());
  let rx = G.ring.x / COLS_PAGE;
  let ry = G.ring.y / COLS_PAGE;
  return vec2<u32>(select(pg.x + pagesX() - rx, pg.x - rx, pg.x >= rx), select(pg.y + pagesY() - ry, pg.y - ry, pg.y >= ry));
}
/** is colSlot the table's (pages-mode.ts sets it with the call above) */
const PAGE_TABLE: bool = false; // PAGE_TABLE
/** window chunk c's slot as an index: a per-chunk buffer's slot for it (the agents' dirty marks) */
fn pageIdx(c: vec2<u32>) -> u32 { return colSlot(c); }
/** a slot's first texel in a texel-a-column texture (the atlas, chunks-across pages wide) */
fn texPage(s: u32) -> vec2<u32> { return vec2<u32>(s % pagesX(), s / pagesX()) * COLS_PAGE; }
/** window column (x, y)'s index in a per-column buffer (x < W, y < H): page-major */
fn colIdx(x: u32, y: u32) -> u32 { return colSlot(vec2<u32>(x, y) / COLS_PAGE) * (COLS_PAGE * COLS_PAGE) + (y % COLS_PAGE) * COLS_PAGE + x % COLS_PAGE; }
fn colIdxI(p: vec2<i32>) -> u32 { return colIdx(u32(p.x), u32(p.y)); }
/** window column p's index in window order (y * W + x): what's handed to the CPU (a readback's column) — never a buffer's index */
fn winIdx(p: vec2<i32>) -> u32 { return u32(p.y) * G.mapW + u32(p.x); }
/** a pick's column word (x + 1 of the pick: renderer.ts) from a per-column buffer's index: window order, + 1 */
fn pickCol(i: u32) -> u32 { return winIdx(vec2<i32>(colXY(i))) + 1u; }
/** a window-order index (winIdx's, or the CPU's y * W + x) back to its window column */
fn winXY(i: u32) -> vec2<u32> { return vec2<u32>(i % G.mapW, i / G.mapW); }
/** a per-column buffer's index back to its window column (colIdx's inverse) */
fn colXY(i: u32) -> vec2<u32> {
  let l = i % (COLS_PAGE * COLS_PAGE);
  return slotChunk(i / (COLS_PAGE * COLS_PAGE)) * COLS_PAGE + vec2<u32>(l % COLS_PAGE, l / COLS_PAGE);
}
/** window column p's texel in a texel-a-column texture */
fn texColU(p: vec2<u32>) -> vec2<u32> { return texPage(colSlot(p / COLS_PAGE)) + p % COLS_PAGE; }
fn texCol(p: vec2<i32>) -> vec2<i32> { return vec2<i32>(texColU(vec2<u32>(p))); }
/** a texel a 2 x 2 columns (the wind field: W / 2 across): window texel t's — a page is COLS_PAGE / 2 texels a side */
fn texCol2(t: vec2<i32>) -> vec2<i32> {
  let h = COLS_PAGE / 2u;
  let u = vec2<u32>(t);
  return vec2<i32>(texPage(colSlot(u / h)) / 2u + u % h);
}
/** k texels a column (the structures' projection: PROJ_K): window column p's j-th texel */
fn texColK(p: vec2<i32>, k: u32, j: u32) -> vec2<i32> {
  let q = texColU(vec2<u32>(p));
  return vec2<i32>(i32(q.x * k + j), i32(q.y));
}
fn inMap(p: vec2<i32>) -> bool { return p.x >= 0 && p.y >= 0 && p.x < i32(G.mapW) && p.y < i32(G.mapH); }
fn clampCell(p: vec2<i32>) -> vec2<i32> { return clamp(p, vec2<i32>(0), vec2<i32>(i32(G.mapW) - 1, i32(G.mapH) - 1)); }

// ---- interval packing (see src/world/layout.ts) ----
// A slot is vec4<u32>: x z0 and y z1 (f32 bits, fractional heights), z
// material | aux << 8, w spare. An empty slot has y == 0 (no interval ends
// at 0). Valid slots are contiguous from slot 0, bottom to top.
fn ivZ0(v: vec4<u32>) -> f32 { return bitcast<f32>(v.x); }
fn ivZ1(v: vec4<u32>) -> f32 { return bitcast<f32>(v.y); }
fn ivMat(v: vec4<u32>) -> u32 { return v.z & 0xffu; }
fn ivAux(v: vec4<u32>) -> u32 { return (v.z >> 8u) & 0xffu; }
fn ivEmpty(v: vec4<u32>) -> bool { return v.y == 0u; }
fn ivPack(z0: f32, z1: f32, mat: u32, aux: u32) -> vec4<u32> {
  return vec4<u32>(bitcast<u32>(z0), bitcast<u32>(z1), (mat & 0xffu) | ((aux & 0xffu) << 8u), 0u);
}
const IV_NONE: vec4<u32> = vec4<u32>(0u);

// ---- surface packing (written by the surface system) ----
// bits 0..16 top z (9.8 fixed point: to 511.99 — round 100, the window holds the atlas's whole height), 17..24
// top material, 25..29 valid slot count, 30 there's loose ground buried under something else, 31 the column has
// air between two of its intervals (an overhang). Mirrored in world/layout.ts (sfZ, sfMat, sfPack).
fn sfZ(s: u32) -> f32 { return f32(s & 0x1ffffu) / 256.0; }
fn sfMat(s: u32) -> u32 { return (s >> 17u) & 0xffu; }
fn sfCount(s: u32) -> u32 { return (s >> 25u) & 0x1fu; }
fn sfBuried(s: u32) -> bool { return ((s >> 30u) & 1u) != 0u; }
fn sfGap(s: u32) -> bool { return (s >> 31u) != 0u; }
fn sfPack(z: f32, mat: u32, n: u32) -> u32 {
  return min(u32(round(max(z, 0.0) * 256.0)), 0x1ffffu) | ((mat & 0xffu) << 17u) | ((n & 0x1fu) << 25u);
}
/** (round 100) a pick's info word: material (8 bits), z (9: to 511), flags (15) — renderer.ts afterSubmit decodes it */
fn pickInfo(mat: u32, z: f32, flags: u32) -> u32 { return (mat & 0xffu) | (min(u32(max(z, 0.0)), 511u) << 8u) | (flags << 17u); }
/** (round 100) u32 words a column of the physics voxels' occupancy (world-gpu.ts physCols: a bit a cell of z) */
const PHYS_COL_WORDS: u32 = 16u;

// ---- hashing / noise ----
fn pcg(v: u32) -> u32 {
  let s = v * 747796405u + 2891336453u;
  let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}
// (x, y are cells: the window's origin goes in, so a cell's randoms stay with the land when a streamed window slides)
fn hash3(x: u32, y: u32, z: u32) -> u32 { return pcg((x + bitcast<u32>(i32(G.org.z))) ^ pcg((y + bitcast<u32>(i32(G.org.w))) ^ pcg(z))); }
/** A world position in the frame that stays with the land (a streamed window's origin added): noise of positions. */
fn wo(p: vec2<f32>) -> vec2<f32> { return p + G.org.xy; }
fn rand3(x: u32, y: u32, z: u32) -> f32 { return f32(hash3(x, y, z) >> 8u) / 16777216.0; }
fn randv(p: vec3<i32>) -> f32 { return rand3(bitcast<u32>(p.x), bitcast<u32>(p.y), bitcast<u32>(p.z)); }

fn vnoise(p: vec2<f32>) -> f32 {
  let i = vec2<i32>(floor(p));
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  let a = randv(vec3<i32>(i, 911));
  let b = randv(vec3<i32>(i + vec2<i32>(1, 0), 911));
  let c = randv(vec3<i32>(i + vec2<i32>(0, 1), 911));
  let d = randv(vec3<i32>(i + vec2<i32>(1, 1), 911));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
fn fbm2(p: vec2<f32>) -> f32 {
  return vnoise(p) * 0.55 + vnoise(p * 2.03 + 17.0) * 0.3 + vnoise(p * 4.1 + 41.0) * 0.15;
}

// ---- weather fields (analytic from storm uniforms; see src/weather) ----
/**
 * Normalised distance from storm i's centre (1 = its edge). Storms are not
 * discs: the outline wobbles with three slowly drifting angular harmonics and
 * stretches along the direction of travel. Mirrored on the CPU in
 * src/weather/weather.ts (stormDist).
 */
fn stormDist(p: vec2<f32>, i: u32) -> f32 {
  let s = G.storms[i];
  let c = G.stormsC[i];
  // stretched along its smoothed heading (stormsC.z; Weather.Storm.heading)
  let fwd = vec2<f32>(cos(c.z), sin(c.z));
  let o = p - s.xy;
  let along = dot(o, fwd) / c.w;
  let across = dot(o, vec2<f32>(-fwd.y, fwd.x));
  let th = atan2(across, along);
  // the outline's lobes drift slowly (CPU twin: Weather.stormDist)
  let t = G.time * 0.015;
  let lobe = 1.0 + 0.22 * sin(2.0 * th + c.x + t) + 0.15 * sin(3.0 * th + c.y - t * 1.3) + 0.08 * sin(5.0 * th + c.x * 1.7 + t * 0.7);
  return length(vec2<f32>(along, across)) / (s.z * lobe);
}

fn stormCover(p: vec2<f32>) -> f32 {
  var c = 0.0;
  for (var i = 0u; i < G.numStorms; i++) {
    let s = G.storms[i];
    let d = stormDist(p, i);
    c = max(c, s.w * smoothstep(1.25, 0.55, d));
  }
  return c;
}

/** Rain intensity 0..~2 at a world position. */
fn rainAt(p: vec2<f32>) -> f32 {
  var r = 0.0;
  for (var i = 0u; i < G.numStorms; i++) {
    let s = G.storms[i];
    let b = G.stormsB[i];
    let d = stormDist(p, i);
    let n = fbm2(wo(p) * 0.045 + vec2<f32>(G.time * 0.05, -G.time * 0.03) + f32(i) * 13.0);
    r += s.w * (1.0 + b.z) * smoothstep(1.0, 0.35, d) * (0.45 + 0.9 * n);
  }
  return r;
}

/**
 * Cloud shadow 0..1: one ragged-edged cloud mass per storm, drifting with the
 * wind. Deliberately crisp-edged (narrow smoothstep) so storms read clearly
 * from above even though we never render the cloud itself.
 */
fn cloudShade(p: vec2<f32>) -> f32 {
  var c = 0.0;
  for (var i = 0u; i < G.numStorms; i++) {
    let s = G.storms[i];
    let d = stormDist(p, i);
    // the ragged edge lives in the storm's own frame (it travels with the
    // storm and evolves slowly); scrolling it by time × wind made the shadow
    // jump whenever the wind shifted (round 10)
    let n = fbm2((p - s.xy) * 0.035 + f32(i) * 7.0 + vec2<f32>(G.time * 0.01, 0.0));
    let edge = 1.08 - d + (n - 0.5) * 0.7;
    c = max(c, s.w * smoothstep(0.0, 0.05, edge));
  }
  return c;
}

/**
 * Fair-weather clouds (round 10): large, soft, *light* shadows drifting with
 * the prevailing wind (advected by the integrated wind, a little faster than
 * the ground wind), so the sky shows which way the wind blows. 0..1 cover;
 * the renderer dims sunlight by ~15 % under them. They are not storms: no
 * rain, no lightning.
 */
fn fairCloud(p: vec2<f32>) -> f32 {
  let q = (wo(p) - G.env.xy * 1.3) * 0.022 + vec2<f32>(G.time * 0.004, 31.0);
  return smoothstep(0.47, 0.6, fbm2(q));
}

// ---- wind field (shared contract: particles, sway, dust pickup, fire) ----
// Analytic: prevailing wind + storm swirl/outflow + dust storms + player
// gusts + cursor breeze + gentle turbulence.
//
// Every noise term is sampled in a frame that moves with the integrated
// prevailing wind (G.env.xy), so gust patches roll smoothly downwind instead
// of flickering. (Before, noise was scrolled by time along fixed axes and
// phases were time × a varying speed, which read as jitter.)
fn windDrift(p: vec2<f32>) -> vec2<f32> { return wo(p) - G.env.xy; }

/** Smooth 0..1 gust patches travelling with the wind (also drives grass and water ripples). */
fn gustField(p: vec2<f32>) -> f32 {
  let q = windDrift(p) * 0.045;
  return fbm2(q + vec2<f32>(G.time * 0.02, 0.0));
}

// The wind field (windfield.wgsl): rgba32float, one texel per 2×2 columns.
//   rg = the wind the player has painted (relaxes back to zero)
//   ba = the whole wind there: the map's own wind + the painted wind.
// Everything that feels wind reads ba (storms too, via a CPU readback); only
// pipelines whose entry points sample the wind bind it (binding 15).
@group(0) @binding(15) var windTex: texture_2d<f32>;

/** Bilinear sample of the wind texture (all four channels). */
fn windSample(p: vec2<f32>) -> vec4<f32> {
  let dims = vec2<i32>(textureDimensions(windTex));
  let t = p * 0.5 - 0.5;
  let i0 = vec2<i32>(floor(t));
  let f = fract(t);
  let a = textureLoad(windTex, texCol2(vec2<i32>(clamp(i0, vec2<i32>(0), dims - 1))), 0);
  let b = textureLoad(windTex, texCol2(vec2<i32>(clamp(i0 + vec2<i32>(1, 0), vec2<i32>(0), dims - 1))), 0);
  let c = textureLoad(windTex, texCol2(vec2<i32>(clamp(i0 + vec2<i32>(0, 1), vec2<i32>(0), dims - 1))), 0);
  let d = textureLoad(windTex, texCol2(vec2<i32>(clamp(i0 + vec2<i32>(1, 1), vec2<i32>(0), dims - 1))), 0);
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

/** The painted part of the wind (cells/s). */
fn windField(p: vec2<f32>) -> vec2<f32> { return windSample(p).xy; }

/**
 * The map's own wind, before the player touches it: prevailing wind in
 * advected gust patches, dust storms, small eddies. Evaluated by the wind
 * field system; everyone else reads the field.
 */
fn mapWind(p: vec2<f32>) -> vec2<f32> {
  let prevail = vec2<f32>(G.windX, G.windY);
  let gf = gustField(p);
  // a steady flow one way with gentle gust patches (round 10)
  var w = prevail * (0.8 + 0.4 * gf);
  for (var i = 0u; i < 2u; i++) {
    let d = G.dusts[i];
    if (d.w <= 0.0) { continue; }
    let r = length(p - d.xy) / d.z;
    if (r < 1.6) {
      let dir = prevail / max(length(prevail), 1e-3);
      w += dir * d.w * smoothstep(1.4, 0.3, r) * (0.5 + gf);
    }
  }
  // small eddies, carried with the wind and slowly evolving
  let q = windDrift(p) * 0.07;
  let tn = G.time * 0.08;
  let turb = vec2<f32>(vnoise(q + vec2<f32>(tn, 0.0)), vnoise(q + vec2<f32>(0.0, tn) + 50.0)) - 0.5;
  return w + turb * 0.8;
}

/** Wind felt at a point: the wind field + storm swirl + the cursor/tap breeze. */
// Drifts (drift.wgsl): loose dust depth per column (.x), dust lost to the
// wind this pass (.y). A texture so it doesn't use a storage slot; bound at 17
// by the pipelines that read it.
@group(0) @binding(17) var driftTex: texture_2d<f32>;

// Where one covered column's solid top (or wet bed) stands more than this
// over another's surface at a corner (a dust skin or puddle on a tower top
// beside the ground at its foot) they don't share a sheet
// (renderfields.wgsl): each keeps its own level there. Averaging them drew a
// slanted wall from the top to the base that popped as the skin came and
// went (round 25); steep sand still shares one. Water boxes hide the sides
// the sheet joins (renderprep.wgsl).
const SHEET_STEP: f32 = 3.0;

/** Depth of drifted dust on column q (0 off the map). */
fn driftAt(q: vec2<i32>) -> f32 {
  if (!inMap(q)) { return 0.0; }
  return textureLoad(driftTex, texCol(vec2<i32>(q)), 0).x;
}

// Sleeping rigid bodies projected into the terrain grid (game/integrity.ts):
// per column the top (x; < 0 = none) and bottom (y) of any body over it. The
// loose ground, water and particles treat a body's top as ground (round 17).
@group(0) @binding(21) var bodyProjTex: texture_2d<f32>;

/** Top of a sleeping body over column q, or −1. */
fn bodyTopAt(q: vec2<i32>) -> f32 {
  if (!inMap(q)) { return -1.0; }
  return textureLoad(bodyProjTex, texCol(vec2<i32>(q)), 0).x;
}

// The structure grids (and sleeping bodies) as each nature column sees them
// (project.wgsl): up to PROJ_K solid intervals, top first, in the layers' own
// interval form — so a structure's floors and the air between them read like
// any other intervals of the column. Kernels that call projAt bind 28.
@group(0) @binding(28) var projTex: texture_2d<f32>;
const PROJ_K: u32 = 3u;

/** Column q's k-th projected interval from the top (IV_NONE past the last; aux = structure + 1). */
fn projAt(q: vec2<i32>, k: u32) -> vec4<u32> {
  if (!inMap(q)) { return IV_NONE; }
  let t = textureLoad(projTex, texColK(vec2<i32>(q.x, q.y), PROJ_K, u32(i32(k))), 0);
  if (t.y <= t.x) { return IV_NONE; }
  return ivPack(t.x, t.y, u32(t.z + 0.5), u32(t.w + 0.5));
}

/** Depth of the top loose layer on q (drift .y; part of driftAt). */
fn driftTopAt(q: vec2<i32>) -> f32 {
  if (!inMap(q)) { return 0.0; }
  let t = textureLoad(driftTex, texCol(vec2<i32>(q)), 0);
  return clamp(t.y, 0.0, t.x);
}

/** Depth of blown dust or ash lying on top of q (0 if the top layer is something else). */
fn driftFilmAt(q: vec2<i32>) -> f32 {
  let m = driftMatAt(q);
  return select(0.0, driftTopAt(q), m == 19u || m == 17u);
}

/** Plants are buried (dormant) under more than half a cell of blown dust or
 *  ash on top; sand and dirt are ground they grow in (rounds 15–16). */
fn buriedAt(q: vec2<i32>) -> bool { return driftFilmAt(q) > 0.5; }

/** What the ground under q is made of for life and soaking: the top loose
 *  layer's material where there's a fair depth of it, else the top cell's. */
fn groundMatAt(q: vec2<i32>, cellMat: u32) -> u32 {
  return select(cellMat, driftMatAt(q), driftAt(q) > 0.3);
}

/** The loose layer's material on column q (drift .z; 0 = dust → 19, MAT_DRIFT —
 *  a literal here: not every kernel includes materials.wgsl). */
fn driftMatAt(q: vec2<i32>) -> u32 {
  if (!inMap(q)) { return 19u; }
  let m = u32(textureLoad(driftTex, texCol(vec2<i32>(q)), 0).z + 0.5);
  return select(m, 19u, m == 0u);
}

// The sandbox brush state per column (edit.wgsl writes it; the particle
// system reads it to show poured grains falling). Bound at 18 by those two.
@group(0) @binding(18) var editTex: texture_2d<f32>;
const POUR_FALL: f32 = 0.8; // s from release to landing (grains drop ~12 cells)
const POUR_RATE: f32 = 4.0; // cells/s a pour lands at

fn windAt(p: vec3<f32>) -> vec2<f32> {
  var w = windSample(p.xy).zw;
  for (var i = 0u; i < G.numStorms; i++) {
    let s = G.storms[i];
    let d = p.xy - s.xy;
    let r = length(d) / s.z;
    if (r < 2.0) {
      let t = vec2<f32>(-d.y, d.x) / max(length(d), 0.001);
      let out = d / max(length(d), 0.001);
      w += (t * 2.5 + out * 1.2) * s.w * exp(-r * r * 1.5) * r * 2.0;
    }
  }
  let g0 = G.gusts[0];
  if (g0.w > 0.0) {
    let d = length(p.xy - g0.xy) / g0.z;
    w += G.gustDir[0].xy * g0.w * exp(-d * d * 2.0);
  }
  // the cyclones: fierce vortices (peak ~26 cells/s at the eye wall) that
  // pull a little inward; each carries everything it spins along with it
  for (var i = 0u; i < MAX_CYCLONES; i++) {
    let cy = G.cyclones[i].a;
    if (cy.w == 0.0) { continue; }
    let o = p.xy - cy.xy;
    let dist = max(length(o), 1e-3);
    let r = dist / cy.z;
    if (r < 3.5) {
      let tang = vec2<f32>(-o.y, o.x) / dist * sign(cy.w);
      // tight: full strength at the eye wall, fading fast beyond it (a wide
      // profile lifted a ring of dust that hid the funnel)
      let prof = r * exp((1.0 - r * r) * 0.5);
      w = w * (1.0 - 0.6 * smoothstep(1.5, 0.5, r)) + (tang * 26.0 - o / dist * 4.0) * abs(cy.w) * prof + G.cyclones[i].b.xy * smoothstep(2.0, 0.5, r);
    }
  }
  return w;
}

/** Hostility 0..1 from wilt.x (which carries +2 when the column is established). */
fn wiltHostility(x: f32) -> f32 { return select(x, x - 2.0, x >= 2.0); }

// ---- litter stripping (shared contract: material system ↔ particles) ----
// Strong wind tears loose litter off the ground one cell at a time. The
// material system removes the cell at tick t; the particle system evaluates
// the same roll for tick t + 1 while the litter is still there and throws up
// the flying scrap — so what you see leave is what was removed.
const MAT_LITTER: u32 = 18u;
const MAT_ASH_C: u32 = 17u;
/** Loose enough for a strong wind to strip a cell at a time: litter, ash (round 10). */
fn isStrippable(m: u32) -> bool { return m == MAT_LITTER || m == MAT_ASH_C; }
fn litterStrip(p: vec2<i32>, tick: u32) -> bool {
  let ws = length(windAt(vec3<f32>(cellPos(p), 0.0)));
  return ws > 5.0 && rand3(u32(p.x), u32(p.y), tick ^ 0x1177u) < (ws - 5.0) * 0.004;
}
