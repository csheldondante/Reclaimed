// look (the game's rule, LW1): what the draw shows, derived from the traits each tick. Rows MT[0..15] in priority order:
// x a trait mask (any of it); y the tint (torso material | head material << 8; the first row with one wins); z the
// effects it adds (units.wgsl LOOK_HALO, LOOK_SPARKS, LOOK_CORPSE, a halo's material << 16). 0: unused.
fn module_main(u: u32) {
  let w = tWord(u);
  var look = 0u;
  var tinted = false;
  for (var i = 0u; i < 16u; i++) {
    let r = MT[i];
    if (r.x == 0u || !hasAny(w, r.x)) { continue; }
    if (!tinted && (r.y & 0xffffu) != 0u) {
      look = look | (r.y & 0xffffu);
      tinted = true;
    }
    look = look | r.z;
  }
  setLook(u, look);
}
