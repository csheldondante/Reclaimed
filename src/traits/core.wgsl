// ---- traits: the core's bookkeeping (LW1), around the game's modules ---------------------------------------------
// traitPre (before every module), one thread a slot:
//   * a slot taken by a new unit (its generation isn't the record's occupant): its kind's traits, no statuses; then
//     the game's assignments (traits.assign);
//   * a slot emptied (agents.remove zeroed it): the record cleared;
//   * statuses past their expiry go; `burning` follows the agents' own fire;
//   * a unit fallen (the step cleared its alive bit): a corpse, for TP.n.w ticks — a body to raise. When it decays the
//     unit's record is zeroed here and a decayed event frees its slot (agents.ts: corpse mode keeps it till then).
// traitPost (after every module): a live unit a module brought to 0 hit points dies (a death event, 'effect').

@compute @workgroup_size(64)
fn traitPre(@builtin(global_invocation_id) id: vec3<u32>) {
  let u = id.x;
  if (u >= TP.n.x) { return; }
  let info = uInfo(u);
  var r0 = traits[u * TRAIT_V];
  if (info == 0u) {
    if (r0.z != 0u) {
      traits[u * TRAIT_V] = vec4<u32>(0u);
      traits[u * TRAIT_V + 1u] = vec4<u32>(0u);
      traits[u * TRAIT_V + 2u] = vec4<u32>(0u);
    }
    return;
  }
  let gen = info >> 16u;
  if (r0.z != gen + 1u) {
    let k = (info >> 9u) & 7u;
    r0 = vec4<u32>(TP.kindSeed[k / 4u][k % 4u], 0xffffffffu, gen + 1u, 0u);
    traits[u * TRAIT_V + 1u] = vec4<u32>(0u);
    traits[u * TRAIT_V + 2u] = vec4<u32>(0u);
  }
  // the game's assignments (a unit spawned as a walking dead): its intrinsic traits replaced, its statuses kept
  for (var i = 0u; i < TP.m.x; i++) {
    let s = TP.assigns[i];
    if (s.x == u && s.y == gen) { r0.x = (r0.x & 0xffff0000u) | (s.z & 0xffffu); }
  }
  // statuses run out
  let r1 = traits[u * TRAIT_V + 1u];
  let r2 = traits[u * TRAIT_V + 2u];
  var decayed = false;
  for (var s = 0u; s < 8u; s++) {
    let b = statusBit(s);
    if ((r0.x & b) == 0u) { continue; }
    let ex = select(r2[s - 4u], r1[s], s < 4u);
    if (ex != PERM && ex <= G.tick) {
      r0.x = r0.x & ~b;
      if (s == S_CORPSE) { decayed = true; }
    }
  }
  let alive = ((info >> 8u) & 1u) != 0u;
  if (alive) {
    // (the agents' own fire: burning while alight)
    let lit = ((info >> 15u) & 1u) != 0u;
    r0.x = select(r0.x & ~statusBit(S_BURNING), r0.x | statusBit(S_BURNING), lit);
    // (a corpse raised by the CPU's hand, or a slot respawned: no longer a body)
    r0.x = r0.x & ~statusBit(S_CORPSE);
    traits[u * TRAIT_V] = r0;
    return;
  }
  if (decayed) {
    // gone to dust: the slot is free (agents.ts frees it on the event, or on seeing it zeroed)
    let p = units[u * UNIT_V].xyz;
    for (var v = 0u; v < UNIT_V; v++) { units[u * UNIT_V + v] = vec4<f32>(0.0); }
    traits[u * TRAIT_V] = vec4<u32>(0u);
    traits[u * TRAIT_V + 1u] = vec4<u32>(0u);
    traits[u * TRAIT_V + 2u] = vec4<u32>(0u);
    emit(TEV_DECAYED, gen * 8192u + u, 0u, 0.0, p);
    return;
  }
  r0.x = r0.x & ~statusBit(S_BURNING);
  if ((r0.x & statusBit(S_CORPSE)) == 0u) {
    // just fell: a body now, for TP.n.w ticks
    r0.x = r0.x | statusBit(S_CORPSE);
    var t = traits[u * TRAIT_V + 1u + S_CORPSE / 4u];
    t[S_CORPSE % 4u] = G.tick + TP.n.w;
    traits[u * TRAIT_V + 1u + S_CORPSE / 4u] = t;
  }
  traits[u * TRAIT_V] = r0;
}

@compute @workgroup_size(64)
fn traitPost(@builtin(global_invocation_id) id: vec3<u32>) {
  let u = id.x;
  if (u >= TP.n.x) { return; }
  let a = units[u * UNIT_V];
  let info = bitcast<u32>(a.w);
  if (((info >> 8u) & 1u) == 0u) { return; }
  if (uHp(u) > 0.0) { return; }
  units[u * UNIT_V] = vec4<f32>(a.xyz, bitcast<f32>(info & ~(1u << 8u)));
  emit(TEV_DEATH, (info >> 16u) * 8192u + u, BY_EFFECT, 0.0, a.xyz);
}
