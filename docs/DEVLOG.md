# Dev log

Why things are the way they are. Newest entries at the bottom. Each entry is
committed together with the code it explains.

---

## 2026-10-06 — M0 + M1 + first pass of M2 (initial commit)

**Stack.** Vite + TypeScript, no framework, plain DOM UI. WebGPU only; missing
WebGPU / adapter / storage-buffer limit → `UnsupportedError` overlay (design
doc §10 "no fallbacks"). `timestamp-query` is requested only when present —
it's instrumentation, not gameplay.

**World representation: chunked variable-K column intervals.** Followed the
handoff's recommendation (§12 + reviewer note): per-column ordered intervals,
stored in 16×16 chunks whose slot stride K is chosen per chunk at load
(need + 2 headroom). Terrain chunks get K=4–5; ruin chunks up to ~11. Cost of
the indirection is one extra uniform-ish lookup per column. Rejected a uniform
K=16 because it would have quadrupled layer memory for terrain-only chunks
for no benefit.

**Surface buffer as the primary contract.** Most systems only need "top z +
top material", so a cheap `surface` pass derives it from the layers every
tick. This keeps water/ecology/shadow independent of the slot layout, so
the layer storage can change without touching them.

**Material physics: gather-only, race-free.** Each column recomputes its
neighbours' donor decisions from read-only inputs (radius-2 reads), so
donations and receipts always agree and mass is conserved without atomics.
Wet soil has a lower angle of repose → rain can trigger slumps (seed of
mudslides) through the shared moisture field instead of a special case.

**Water: virtual pipes on column volume.** Flux pass + depth pass (Mei et al.
style, simplified: gain 0.12, friction 0.985, outflow scaled to available
volume). Map edges drain. It publishes `water`, `waterPrev`, `flux`; the
contamination system transports dissolved mass using exactly those, so a
better water solver can drop in.

**Contamination.** Two scalars (soil-bound, dissolved). Water dissolves
(faster when flowing), flux carries, drying redeposits, map edges remove,
vegetation remediates. After testing: pure transport made light rain merely
*move* pollution around flat ground (it redeposited where films dried), so a
direct `RAIN_LEACH` term was added — a passing storm now visibly cleans lightly
polluted ground, while the heavy industrial deposit still needs sustained
water. Probe after one stationary storm (8× speed, ~200 s sim): contamination
0.22 → <0.01 out to r≈18 of a 26-radius storm.

**Moisture + vegetation feedback.** First tuning dried soil in ~30 s, so
moss never established after a storm (probe: contam cleaned to 0.01 but
moisture 0 and veg ≈ 0). Slowed drying to ~3 min for bare soil and made
established vegetation retain moisture (×0.15 drying at stage ≥3). Life is now
self-sustaining once started, which is the intended "recovery propagates"
feeling.

**Succession pacing.** Pioneers (moss/grass) grow ~6× faster than woody
stages; colonisation from neighbours 0.1/neighbour/eco-tick plus a tiny spore
rain. Result after one storm: grass front ~14 cells out, trees at the core.

**Rendering: one path, box instances.** Render-prep compute emits one box per
interval (+ shrubs/trees, + one water box per wet column) with workgroup-level
atomic aggregation into indirect args. Only the 3 camera-facing faces are
drawn. No meshing/culling yet. Measured on Intel Xe-LPG iGPU, 1600×900,
~137k opaque instances (~420k faces): draw pass ≈ 7 ms without rain, 10–13 ms
with storms active; all sim passes together < 2 ms at 1 tick/frame. Deferred
optimisations (face culling against neighbours, precomputed cloud/rain field
instead of per-pixel noise) until we see whether it's a real problem on target
devices.

**Lighting/look.** Sun from front-left (`[0.75,-0.3,0.62]`) so one visible
side face is lit and the other shaded and building shadows fall into view
(first attempt from behind hid every shadow). Haze and desaturation are driven
by the global pollution aggregate so the whole palette clears as the valley
recovers. First pass had far too much haze (washed out) — reduced to
3–13 %. Fine terrain noise removed: 1-cell jaggies produced noisy dark
"dashes" from side faces everywhere.

**Weather.** Storms are CPU entities (≤4) that become analytic fields in the
Globals uniform: rain intensity, cloud shade, rain streak volume. They drift
with prevailing wind, lose uphill velocity against high terrain, and player
drag adds a bounded, decaying nudge — influence, not control (§6).

**Audio.** Fully procedural WebAudio (wind, whistle, rain, water burble,
insects, bird calls, debris rattle) mixed from aggregate state only
(pollution, life, rain at camera, flow). Not yet verified by ear — headless
testing can't listen.

**Verification tooling.** Claude-in-Chrome wasn't connected, so
`scripts/shot.mjs` drives headless Chrome (D3D11 ANGLE, real GPU) for
screenshots + console capture; `?speed=N` fast-forwards simulation for
ecology tests; `window.reclaimed.probe` reads field means back.

**Known gaps.** Menu/skull scene (§4) not started. Lightning/structure failure
(M3) and dam breach (M4) not started (dam + reservoir already exist in the
map). Audio unverified. The dam shoulders render as a comb of concrete
columns where terrain dips below the dam top.
