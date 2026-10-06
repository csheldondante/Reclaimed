// ---- flow.wgsl -----------------------------------------------------------------
// Net water flow through a column (volume per tick), derived from the water
// contract's `flux`. The including shader must declare
//   var<storage, read> flux: array<vec4<f32>>;
// Gross flux is large even in still water (the pipe model exchanges volume
// back and forth), so anything that should react to *moving* water — erosion,
// flood damage, scouring, foam — must use this instead.
fn netFlow(p: vec2<i32>) -> vec2<f32> {
  let f = flux[colIdxI(p)];
  var xp = f.x;
  var xm = f.y;
  var yp = f.z;
  var ym = f.w;
  let a = p + vec2<i32>(1, 0);
  let b = p - vec2<i32>(1, 0);
  let c = p + vec2<i32>(0, 1);
  let d = p - vec2<i32>(0, 1);
  if (inMap(a)) { xp -= flux[colIdxI(a)].y; }
  if (inMap(b)) { xm -= flux[colIdxI(b)].x; }
  if (inMap(c)) { yp -= flux[colIdxI(c)].w; }
  if (inMap(d)) { ym -= flux[colIdxI(d)].z; }
  return vec2<f32>(xp - xm, yp - ym) * 0.5;
}
