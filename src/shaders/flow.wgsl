// ---- flow.wgsl -----------------------------------------------------------------
// Net water flow through a column (volume per tick), derived from the water
// contract's `flux`. The including shader must declare
//   var<storage, read> flux: array<Dirs>;
// Gross flux is large even in still water (the pipe model exchanges volume
// back and forth), so anything that should react to *moving* water — erosion,
// flood damage, scouring, foam — must use this instead.
fn netFlow(p: vec2<i32>) -> vec2<f32> {
  let f = flux[colIdxI(p)];
  var v = vec2<f32>(0.0);
  for (var k = 0u; k < NDIR; k++) {
    var net = f[k];
    let q = nbr(p, k);
    if (inMap(q)) { net -= flux[colIdxI(q)][k ^ 1u]; }
    v += net * DIRV[k];
  }
  // a uniform flow v sends dot(v, e_k) down each pipe; summed over the six
  // directions that is (NDIR / 2) v
  return v * (2.0 / f32(NDIR));
}
