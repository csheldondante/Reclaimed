// typed_damage (the game's rule, LW1): damage of a type, scaled by what the unit is — the resist table (Master of
// Magic's lesson: the type decides whom it reaches). "fire on fire_immune does nothing" is a row: fire_immune × fire 0.
// Rows r = 0..7, two vec4 each:
//   MT[2r]:     x the traits a row applies to (all; 0: an empty row)
//   MT[2r + 1]: the multipliers for fire, life, necrotic, physical (contracts/traits.ts DAMAGE_TYPES)
// Every row that applies multiplies in. A negative result heals (necrotic on the undead), up to its max.
fn module_main(u: u32) {
  if (!uAlive(u)) { return; }
  let w = tWord(u);
  let p = uPos(u);
  var dmg = 0.0;
  for (var e = 0u; e < TP.n.y; e++) {
    if (effOp(e) != OP_DAMAGE || !effCovers(e, p)) { continue; }
    let ty = min(TP.effects[e].c.z, 3u);
    var m = 1.0;
    for (var r = 0u; r < 8u; r++) {
      let mask = MT[r * 2u].x;
      if (mask != 0u && hasAll(w, mask)) { m *= mtf(r * 2u + 1u)[ty]; }
    }
    dmg += effAmount(e) * m;
  }
  if (dmg == 0.0) { return; }
  let hp = uHp(u);
  setHp(u, min(hp - dmg, max(uMaxHp(u), hp)));
  if (dmg > 0.0) { uFlash(u, 0.12); }
}
