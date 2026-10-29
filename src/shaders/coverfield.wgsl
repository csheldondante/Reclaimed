// ---- the weather's cover past the window: the field's shape (round 108, TC20; weather/cover.ts owns it) ----------
// The snow lying on the land, the ice on its water and how wet it is, at the atlas's scale: a ring of COVER_N x COVER_N texels round the
// window, COVER_CELL world cells a texel (a world texel t is ring texel t mod COVER_N), the land's tiles drawing it
// live (tiles.wgsl fsTile: as the lighting is) so a tile never goes stale with the weather. Shared by the field's
// owner (cover.wgsl) and its readers. (cover.ts COVER_N, COVER_CELL: keep the two the same.)

const COVER_N: i32 = 512;
const COVER_CELL: f32 = 8.0;

/** a world texel's ring texel */
fn coverRing(t: vec2<i32>) -> vec2<i32> { return ((t % vec2<i32>(COVER_N)) + vec2<i32>(COVER_N)) % vec2<i32>(COVER_N); }
/** which lap round the ring a world texel is on (4 bits a side: the atlas's world is a few laps across) */
fn coverLap(t: vec2<i32>) -> vec2<i32> { return vec2<i32>(floor(vec2<f32>(t) / f32(COVER_N))) & vec2<i32>(15); }
/** the lap as the drawn texel carries it (exact in a half float) */
fn coverLapCode(t: vec2<i32>) -> f32 { let l = coverLap(t); return f32(l.x + 16 * l.y); }
