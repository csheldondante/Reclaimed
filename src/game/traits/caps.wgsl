// caps (the game's rule, LW1): what the agents' step honours, derived from the traits each tick (round 85: "derived
// capabilities as separate rules"). Rows MT[0..15]: x a trait mask (any of it), y the caps it gives (CAP_*). 0: unused.
fn module_main(u: u32) {
  let w = tWord(u);
  var caps = 0u;
  for (var i = 0u; i < 16u; i++) {
    let r = MT[i];
    if (r.x != 0u && hasAny(w, r.x)) { caps = caps | r.y; }
  }
  setCaps(u, caps);
}
