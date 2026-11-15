// ---- the engine's substep: fine collision against the columns, then the contact solve (engine.wgsl) -----------------
@group(0) @binding(10) var<storage, read> list: array<u32>;
@group(0) @binding(11) var<storage, read> layersIn: array<vec4<u32>>;
@group(0) @binding(12) var<storage, read> surfaceIn: array<u32>;
@group(0) @binding(13) var driftIn: texture_2d<f32>;
@group(0) @binding(15) var<storage, read_write> events: array<atomic<u32>>;

// The ground in a column at height z: the top of what lies at or below z, whether z is inside it, whether that is
// loose ground, its material.
struct Ground { top: f32, inside: bool, gran: f32, mat: u32 };

/** the column's intervals walked (the truth; what the fast path falls back to) */
fn groundWalk(c: vec2<i32>, z: f32) -> Ground {
  var g = Ground(-1e9, false, 0.0, 0u);
  let cs = colSlots(u32(c.x), u32(c.y));
  for (var s = 0u; s < cs.y; s++) {
    let v = layersIn[cs.x + s];
    if (ivEmpty(v)) { break; }
    if (ivZ0(v) > z) { break; }
    g.top = ivZ1(v);
    g.mat = ivMat(v);
    g.gran = select(0.0, 1.0, matState(g.mat) == ST_GRANULAR);
    if (z < g.top) {
      g.inside = true;
      return g;
    }
  }
  return g;
}

/**
 * The heightfield first (the surface pass's word and its loose run's depth: two reads): a column with no air between
 * its intervals is one solid run up to its top, so the top answers for any z. Only a column with a gap (a cave, an
 * overhang, a room) has its intervals walked. Derived state: the columns stay the truth.
 */
fn groundAtE(c: vec2<i32>, z: f32) -> Ground {
  if (!inMap(c)) { return Ground(-1e9, false, 0.0, 0u); }
  if ((EU.e.w & 1u) != 0u) {
    let s = surfaceIn[colIdxI(c)];
    if (!sfGap(s)) {
      let d = textureLoad(driftIn, texCol(c), 0);
      let top = sfZ(s) + d.x;
      if (d.x > 0.0) { return Ground(top, z < top, 1.0, u32(d.z)); }
      return Ground(top, z < top, 0.0, sfMat(s));
    }
  }
  return groundWalk(c, z);
}

// A workgroup a row awake: its 64 threads share its samples out.
@compute @workgroup_size(64)
fn fine(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_index) li: u32) {
  if (wg.x >= list[3]) { return; }
  let r = list[LIST_AT + wg.x];
  let m = bitcast<vec4<u32>>(info[4u * r + 2u]);
  if ((rowFlags(r) & ROW_EXPAND) != 0u) { return; }
  let x = pose[4u * r + 2u].xyz;
  let q = pose[4u * r + 3u];
  let nearGap = EU.f.x;
  let s0 = sAt(m.x);
  for (var s = li; s < m.y; s += 64u) {
    let si = s0 + s;
    let sm = samples[si];
    var c0 = vec4<f32>(0.0, 0.0, 1.0, NO_CONTACT);
    var m0 = vec4<f32>(0.0);
    var c1 = c0;
    var m1 = m0;
    if (sm.w > 0.0) {
      let p = x + eqrot(q, sm.xyz);
      let rad = sm.w;
      let c = cellAt(p.xy);
      // the ground under it
      let g = groundAtE(c, p.z);
      let depth = g.top - (p.z - rad);
      if (depth > -nearGap) {
        c0.w = depth;
        m0 = vec4<f32>(f32(g.mat), g.gran, 0.0, 0.0);
      }
      // The columns around: a wall is one standing higher than a step up. The faces of the walls round a sample are
      // taken as one: their mean normal and the sample's mean distance to them. A straight cliff is a zigzag of hex
      // faces, and a body's own cells are a zigzag too; face by face the two mesh like teeth and it hangs on the
      // cliff (test/gpu/engine.test.ts, the block off the shelf). Walls on opposite sides (a slot): the nearest face.
      if (inMap(c)) {
        let cp = cellPos(c);
        var sumN = vec2<f32>(0.0);
        var sumD = 0.0;
        var cnt = 0.0;
        var bestD = NO_CONTACT;
        var bestN = vec2<f32>(0.0);
        var wm = vec4<f32>(0.0);
        for (var k = 0u; k < NDIR; k++) {
          let gn = groundAtE(nbr(c, k), p.z + rad);
          if (gn.top - (p.z - rad) <= EU.d.z * 2.0 * rad) { continue; }
          let dist = 0.5 - dot(p.xy - cp, DIRV[k]);
          sumN -= DIRV[k];
          sumD += dist;
          cnt += 1.0;
          wm = vec4<f32>(f32(gn.mat), gn.gran, 0.0, 0.0);
          if (rad - dist > bestD) {
            bestD = rad - dist;
            bestN = -DIRV[k];
          }
        }
        if (cnt > 0.0) {
          let l = length(sumN);
          var wn = bestN;
          var dw = bestD;
          if (l > 0.3) {
            wn = sumN / l;
            dw = rad - sumD / cnt;
          }
          if (dw > -nearGap) {
            c1 = vec4<f32>(wn, 0.0, dw);
            m1 = wm;
          }
        }
      }
    }
    contacts[4u * si] = c0;
    contacts[4u * si + 1u] = m0;
    contacts[4u * si + 2u] = c1;
    contacts[4u * si + 3u] = m1;
  }
}

/** the world's inverse inertia of a row times v (d the body frame's diagonal, o its xy, xz, yz) */
fn invInertia(q: vec4<f32>, d: vec3<f32>, o: vec3<f32>, v: vec3<f32>) -> vec3<f32> {
  let b = eqrot(eqinv(q), v);
  let ib = vec3<f32>(d.x * b.x + o.x * b.y + o.y * b.z, o.x * b.x + d.y * b.y + o.z * b.z, o.y * b.x + o.z * b.y + d.z * b.z);
  return eqrot(q, ib);
}

/**
 * The step a row takes this substep (s). One place, so a row's time can differ from the world's later (BACKLOG PE12,
 * a time distortion field); today every row takes the substep.
 */
fn rowDt(r: u32, x: vec3<f32>) -> f32 { return EU.a.x; }

fn pushEvent(kind: u32, row: u32, col: u32, mat: u32, p: vec3<f32>, val: f32) {
  let k = atomicAdd(&events[3], 1u);
  if (k >= u32(EU.f.y)) { return; }
  if (k % 64u == 0u) { atomicAdd(&events[0], 1u); }
  let b = EV_AT + k * EV_WORDS;
  atomicStore(&events[b], kind);
  atomicStore(&events[b + 1u], row);
  atomicStore(&events[b + 2u], col);
  atomicStore(&events[b + 3u], mat);
  atomicStore(&events[b + 4u], bitcast<u32>(p.x));
  atomicStore(&events[b + 5u], bitcast<u32>(p.y));
  atomicStore(&events[b + 6u], bitcast<u32>(p.z));
  atomicStore(&events[b + 7u], bitcast<u32>(val));
}

// A thread a row awake. Against terrain alone the rows don't meet each other, so each solves its own contacts in turn
// (Gauss-Seidel over its samples). The rules (DESIGN §10.5):
//  - separation adds no speed: an impulse only ever stops the approach at a contact (never a bias out of an overlap);
//    an overlap past the slop is moved out at pushV at most, as a change of position that the velocity never sees
//  - overlap up to a mass-scaled slop is allowed
//  - erode, don't push: a sample deeper than slop + erode depth into solid ground is lost (the body is the smaller
//    of the two): its mass leaves the row and lands on the column as loose ground (an event; engine_fold.wgsl)
//  - deflect and topple, don't bounce: the normal speed out is at most restitution x the speed in
//  - sleepers: still for the rest time while touching, the row sleeps here, and no kernel visits it again
@compute @workgroup_size(64)
fn solve(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x == 0u) {
    atomicStore(&events[1], 1u);
    atomicStore(&events[2], 1u);
  }
  if (id.x >= list[3]) { return; }
  let r = list[LIST_AT + id.x];
  let P = pose[4u * r + 2u];
  let dt = rowDt(r, P.xyz);
  var x = P.xyz;
  var invM = P.w;
  var q = pose[4u * r + 3u];
  var v = vel[2u * r].xyz;
  var still = vel[2u * r].w;
  var w = vel[2u * r + 1u].xyz;
  let bound = vel[2u * r + 1u].w;
  var I0 = info[4u * r];
  var I1 = info[4u * r + 1u];
  let m = bitcast<vec4<u32>>(info[4u * r + 2u]);
  let cellMass = info[4u * r + 2u].w;
  let s0 = sAt(m.x);
  let fl0 = bitcast<u32>(I0.w);
  // (it deforms this tick: `expand` takes it as it came in — engine_deform.wgsl)
  if ((fl0 & ROW_EXPAND) != 0u) { return; }
  if ((EU.e.w & 2u) != 0u) {
    pose[4u * r] = P;
    pose[4u * r + 1u] = q;
  }
  // (build step 2, DESIGN §10.4: "only for bodies in a true collision") the hardest stop among its contacts as it comes
  // in, before anything is solved: its energy over the body's mass past the material's threshold, the row is not
  // solved — it keeps the velocity it came with, and `expand` hands it to its particles, which take the hit themselves
  let thr = expandAt(m.z & 0xffu);
  if ((EU.e.w & 4u) != 0u && thr > 0.0 && (fl0 & ROW_DENIED) == 0u && bitcast<u32>(info[4u * r + 3u].x) != 0u) {
    let vg = v - vec3<f32>(0.0, 0.0, worldG() * dt);
    // (a contact's stop takes 1/2 stop^2 / k, k its inverse effective mass: at most 1/2 stop^2 x the mass, so only
    // contacts closing fast enough are weighed — a flat landing's hardest is the one under the centre of mass)
    var worst = 0.0;
    for (var s = 0u; s < m.y; s++) {
      let sm = samples[s0 + s];
      if (sm.w <= 0.0) { continue; }
      let rl = eqrot(q, sm.xyz);
      for (var k = 0u; k < 2u; k++) {
        let c = contacts[4u * (s0 + s) + 2u * k];
        if (c.w <= NO_CONTACT) { continue; }
        let rc = rl - c.xyz * sm.w;
        let stop = min(c.w, 0.0) / dt - dot(vg + cross(w, rc), c.xyz);
        if (stop <= 0.0 || 0.5 * stop * stop <= thr) { continue; }
        let rn = cross(rc, c.xyz);
        let kn = invM + dot(rn, invInertia(q, I0.xyz, I1.xyz, rn));
        worst = max(worst, 0.5 * stop * stop / kn);
      }
    }
    if (worst > thr * I1.w) {
      info[4u * r].w = bitcast<f32>(fl0 | ROW_EXPAND);
      return;
    }
  }
  // gravity and the air
  v.z -= worldG() * dt;
  v *= max(0.0, 1.0 - EU.d.x * dt);
  w *= max(0.0, 1.0 - EU.d.y * dt);

  let cells = max(I1.w / max(cellMass, 1e-6), 1.0);
  let slop = EU.b.x + min(EU.b.w, EU.b.y * pow(cells, EU.b.z));
  var touching = false;
  var hitE = 0.0;
  var hitP = x;
  var hitMat = 0u;
  for (var it = 0u; it < EU.e.z; it++) {
    for (var s = 0u; s < m.y; s++) {
      let si = s0 + s;
      let sm = samples[si];
      if (sm.w <= 0.0) { continue; }
      let rl = eqrot(q, sm.xyz);
      for (var k = 0u; k < 2u; k++) {
        let c = contacts[4u * si + 2u * k];
        if (c.w <= NO_CONTACT) { continue; }
        let n = c.xyz;
        let rc = rl - n * sm.w;
        let vn = dot(v + cross(w, rc), n);
        // (a gap may close this substep and no further; an overlap may not deepen)
        let allowed = min(c.w, 0.0) / dt;
        if (c.w > -0.02) { touching = true; }
        let rn = cross(rc, n);
        let kn = invM + dot(rn, invInertia(q, I0.xyz, I1.xyz, rn));
        // (its impulse so far this substep, and the speed out a real hit is given: kept with the contact, so the
        // passes converge on one answer — an impulse may be taken back, never below nothing)
        var acc = contacts[4u * si + 2u * k + 1u].zw;
        if (it == 0u && vn < allowed) {
          // (what the stop takes: the energy an impact loses, for the events and — later — stage 4)
          let e = 0.5 * (allowed - vn) * (allowed - vn) / kn;
          if (e > hitE) {
            hitE = e;
            hitP = x + rc;
            hitMat = u32(contacts[4u * si + 2u * k + 1u].x);
          }
          // (a bounce only off a real hit: resting contacts never ring)
          if (c.w >= 0.0 && vn < -1.5) { acc.y = EU.a.z * -vn; }
        }
        let want = select(allowed, acc.y, acc.y > 0.0);
        let total = max(0.0, acc.x + (want - vn) / kn);
        let jn = total - acc.x;
        acc.x = total;
        contacts[4u * si + 2u * k + 1u] = vec4<f32>(contacts[4u * si + 2u * k + 1u].xy, acc);
        if (jn == 0.0) { continue; }
        v += n * (jn * invM);
        w += invInertia(q, I0.xyz, I1.xyz, rn * jn);
        if (jn <= 0.0) { continue; }
        // Coulomb friction at the contact, by what this pass added
        let vr = v + cross(w, rc);
        let vt = vr - n * dot(vr, n);
        let vtl = length(vt);
        if (vtl > 1e-5) {
          let t = vt / vtl;
          let rt = cross(rc, t);
          let kt = invM + dot(rt, invInertia(q, I0.xyz, I1.xyz, rt));
          let jt = min(EU.a.y * jn, vtl / kt);
          v -= t * (jt * invM);
          w -= invInertia(q, I0.xyz, I1.xyz, rt * jt);
        }
      }
    }
  }
  if (touching) {
    v *= max(0.0, 1.0 - EU.f.z * dt);
    w *= max(0.0, 1.0 - EU.f.z * dt);
  }
  // the move
  x += v * dt;
  let dq = vec4<f32>(w * (0.5 * dt), 0.0);
  q = normalize(q + vec4<f32>(dq.w * q.xyz + q.w * dq.xyz + cross(dq.xyz, q.xyz), dq.w * q.w - dot(dq.xyz, q.xyz)));

  // overlaps: past the slop, out at pushV (position only); past the erode depth in solid ground, the sample goes
  var over = 0.0;
  var overN = vec3<f32>(0.0, 0.0, 1.0);
  var mass = I1.w;
  let mass0 = mass;
  for (var s = 0u; s < m.y; s++) {
    let si = s0 + s;
    let sm = samples[si];
    if (sm.w <= 0.0) { continue; }
    var gone = false;
    for (var k = 0u; k < 2u; k++) {
      let c = contacts[4u * si + 2u * k];
      if (c.w <= slop) { continue; }
      let gran = contacts[4u * si + 2u * k + 1u].y;
      if (c.w > slop + EU.c.x && gran < 0.5) { gone = true; }
      if (c.w - slop > over) {
        over = c.w - slop;
        overN = c.xyz;
      }
    }
    if (gone) {
      samples[si] = vec4<f32>(sm.xyz, -sm.w);
      contacts[4u * si].w = NO_CONTACT;
      contacts[4u * si + 2u].w = NO_CONTACT;
      let p = x + eqrot(q, sm.xyz);
      let c = cellAt(p.xy);
      let vol = 8.0 * sm.w * sm.w * sm.w;
      mass -= cellMass * vol;
      if (inMap(c)) { pushEvent(EV_ERODE, r, colIdxI(c), (m.z >> 8u) & 0xffu, p, vol); }
    }
  }
  x += overN * min(over, EU.a.w * dt);

  var fl = bitcast<u32>(I0.w);
  if (mass != mass0) {
    if (mass < 0.5 * cellMass) {
      // (all of it gone to the ground: the row ends)
      fl = 0u;
      mass = 0.0;
      // (freed: no kernel visits it again, and its mesh draws nothing — bodymesh.wgsl reads the inverse mass)
      invM = -1.0;
    } else {
      // (its inertia by its mass: the shape's change isn't followed — docs/design/PHYSICS_ENGINE.md, limits)
      let k = mass0 / mass;
      invM = 1.0 / mass;
      I0 = vec4<f32>(I0.xyz * k, I0.w);
      I1 = vec4<f32>(I1.xyz * k, mass);
    }
  }
  // sleep, decided here
  if (touching && length(v) < EU.c.y && length(w) < EU.c.z) { still += dt; } else { still = 0.0; }
  var slept = false;
  if (still > EU.c.w && fl != 0u) {
    fl = fl | ROW_ASLEEP;
    v = vec3<f32>(0.0);
    w = vec3<f32>(0.0);
    slept = true;
  }
  if (hitE > EU.d.w) { pushEvent(EV_IMPACT, r, 0u, hitMat, hitP, hitE); }
  pose[4u * r + 2u] = vec4<f32>(x, invM);
  pose[4u * r + 3u] = q;
  if (slept) {
    // (what it sleeps on: the surface pass's word of the column under its centre, kept with the row — `compact`
    // wakes it when that word changes: DESIGN §10 "sleepers stay put unless … their support goes")
    let c = cellAt(x.xy);
    var word = 0u;
    if (inMap(c)) { word = surfaceIn[colIdxI(c)]; }
    pose[4u * r] = vec4<f32>(x, bitcast<f32>(word));
    pose[4u * r + 1u] = q;
  }
  vel[2u * r] = vec4<f32>(v, still);
  vel[2u * r + 1u] = vec4<f32>(w, bound);
  info[4u * r] = vec4<f32>(I0.xyz, bitcast<f32>(fl));
  info[4u * r + 1u] = vec4<f32>(I1.xyz, mass);
}
