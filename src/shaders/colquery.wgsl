// ---- colquery.wgsl ------------------------------------------------------------------------------------------------
// (round 120, JB6: "no CPU readback on the hot path") Small questions asked of the GPU's columns in place, so the
// integrity system needn't read them back to know whether it needs to: does a box hold any of these materials (the
// structures' analyse — fracture.ts analyse — only looks at a box with something built in it).
//
//   count   a thread a column of the boxes (laid end to end): its box's counter + 1 when one of its intervals is of a
//           material in the mask
//
// `inp` (u32): boxes 4 words each (x0, y0, x1, y1: window columns, inclusive), then each box's first thread (a prefix
// sum, nBoxes + 1 words), then the material mask (8 words: a bit a material).

struct Params {
  mapW: u32, mapH: u32, chunksX: u32, chunkSize: u32,
  nBoxes: u32, nThreads: u32, startOff: u32, maskOff: u32,
}

@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read> chunks: array<vec2<u32>>;
@group(0) @binding(2) var<storage, read> slots: array<vec4<u32>>;
@group(0) @binding(3) var<storage, read> inp: array<u32>;
@group(0) @binding(4) var<storage, read_write> counts: array<atomic<u32>>;

fn colBase(x: u32, y: u32) -> vec2<u32> {
  let cs = P.chunkSize;
  let ch = chunks[(y / cs) * P.chunksX + (x / cs)];
  return vec2<u32>(ch.x + ((y % cs) * cs + (x % cs)) * ch.y, ch.y);
}

@compute @workgroup_size(64)
fn count(@builtin(global_invocation_id) gid: vec3<u32>) {
  let t = gid.x + gid.y * 65535u * 64u;
  if (t >= P.nThreads) { return; }
  // (the box this thread is in: the last whose first thread is at or before it)
  var lo = 0u;
  var hi = P.nBoxes;
  while (hi - lo > 1u) {
    let mid = (lo + hi) / 2u;
    if (inp[P.startOff + mid] <= t) { lo = mid; } else { hi = mid; }
  }
  let b = lo;
  let x0 = inp[b * 4u];
  let y0 = inp[b * 4u + 1u];
  let x1 = inp[b * 4u + 2u];
  let w = x1 - x0 + 1u;
  let l = t - inp[P.startOff + b];
  let x = x0 + l % w;
  let y = y0 + l / w;
  let c = colBase(x, y);
  for (var s = 0u; s < c.y; s++) {
    let v = slots[c.x + s];
    if (v.y == 0u) { break; }
    let m = v.z & 255u;
    if ((inp[P.maskOff + m / 32u] & (1u << (m % 32u))) != 0u) {
      atomicAdd(&counts[b], 1u);
      return;
    }
  }
}
