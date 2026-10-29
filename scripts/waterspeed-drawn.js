// (round 112, waterscale) the drawn scroll as it is now — renderfields.wgsl flowLook, render.wgsl flowStreaks — for
// scripts/waterspeed.mjs (evaluated in the page). nf: the pipes' net flow (flow.wgsl netFlow, PIPE_FACE · dt · d · u);
// a held river's table speed tv (cells a 60 Hz step) is turned into the same.
window.__heldFv = (tv, d) => (2 / 3) * tv * d;
window.__drawn = (nf, d) => {
  const T = { refSpeed: 1.5, refScroll: 1, curve: 0.5, minScroll: 0.25, still: 0.02 };
  const live = window.reclaimed?.tuning?.values?.flowLook;
  const L = live ?? T;
  const u = (1.5 * nf * 60) / Math.max(d, 0.005);
  if (u <= L.still) return 0;
  const scroll = Math.max(L.refScroll * Math.pow(u / L.refSpeed, L.curve), L.minScroll);
  return Math.min(scroll * 2, 5) / 2;
};
