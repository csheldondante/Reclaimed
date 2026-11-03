// ---- the fire's hold on sleep (round 128, treegen; sim/sleep.ts holdBurning) ----
// A burning chunk stays awake, and the chunks a fire is about to reach wake: per chunk slot, the strongest fire in it
// or within FIRE_REACH columns of its edge, as an f32's bits (atomicMax: positive floats order as their bits). Every
// column, asleep or not — a fire carried into a sleeping chunk (a slide, a stored region) wakes it. The level reads
// and clears it twice a second (world-gpu fireChunks). Why: a woken chunk slept 8 s after the event that woke it and
// a sleeping chunk's fire is carried through unchanged — a lightning-set wood fire froze where it stood 8 s on.
@group(0) @binding(3) var<storage, read> fire: array<f32>;
@group(0) @binding(4) var<storage, read_write> fireChunks: array<atomic<u32>>;

/** a column burning at least this keeps its chunk awake (embers below it go out on their own) */
const FIRE_HOLD: f32 = 0.02;
/** columns from a chunk's edge within which the neighbour chunk wakes too (the fire spreads a column a step at most) */
const FIRE_REACH: i32 = 3;

fn mark(q: vec2<i32>, f: f32) {
  if (q.x < 0 || q.y < 0 || q.x >= i32(G.mapW) || q.y >= i32(G.mapH)) { return; }
  let c = colSlot(vec2<u32>(q) / COLS_PAGE);
  if (c < 2048u) { atomicMax(&fireChunks[c], bitcast<u32>(f)); }
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= G.mapW || id.y >= G.mapH) { return; }
  let f = fire[colIdx(id.x, id.y)];
  if (f < FIRE_HOLD) { return; }
  let p = vec2<i32>(id.xy);
  mark(p, f);
  // (near an edge: the chunk across it, and across a corner)
  let lp = vec2<i32>(id.xy % COLS_PAGE);
  let n = i32(COLS_PAGE);
  var dx = 0;
  var dy = 0;
  if (lp.x < FIRE_REACH) { dx = -FIRE_REACH; } else if (lp.x >= n - FIRE_REACH) { dx = FIRE_REACH; }
  if (lp.y < FIRE_REACH) { dy = -FIRE_REACH; } else if (lp.y >= n - FIRE_REACH) { dy = FIRE_REACH; }
  if (dx != 0) { mark(p + vec2<i32>(dx, 0), f); }
  if (dy != 0) { mark(p + vec2<i32>(0, dy), f); }
  if (dx != 0 && dy != 0) { mark(p + vec2<i32>(dx, dy), f); }
}
