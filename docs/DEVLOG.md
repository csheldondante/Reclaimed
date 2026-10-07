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

## 2026-10-06 — M2 polish: readable barren world, storm feedback

- **Bug: intro swallowed clicks for 1.3 s** after dismissal: `#ui > *`
  (id specificity) overrode `.intro.gone { pointer-events: none }`. Found via
  scripted UI test (`shot.mjs --clicks`) — the Storm button never activated.
- **Surface debris + rock outcrops.** Barren ground read as one flat beige.
  Added ~600 scattered concrete/rust/brick/rubble chunks (denser near the
  industrial site) and fbm-driven bare-stone patches. This sells "remains of
  an old world" (§2) for almost no cost: +~1k instances.
- **Dam wings trimmed** to the valley (|across| ≤ 19); the wall used to poke
  above lower ground on both sides.
- **Stone darkened** (outcrops read as snow), **fill light raised** so shaded
  step faces aren't near-black.
- **Storm handles + nudge arrow** (SVG overlay): storms show a faint dashed
  ring; dragging shows the nudge direction. §6 asks for influence that feels
  responsive without feeling unconstrained — the arrow makes the player's
  intent visible while the storm's actual path stays the simulation's.
- Verified via scripted input: storm spawn through the real UI (pick target →
  spawn upwind, −30 Nature), drag-nudge (screen-left drag → +x,−y nudge, no
  camera pan).

## 2026-10-06 — M3: lightning + structural failure + rubble

**Structure system (new, runs before material each tick).** Per solid
interval, aux bits hold support (4 bits) and damage (4 bits). Resting
intervals inherit the support of what's below (ground = 15); floating ones
take the best overlapping neighbour's support minus a span cost
(`(1−strength)·10`, concrete 2, brick 4) minus damage/4. Support relaxes one
cell per tick, so losing a pillar makes a slab's support bleed away over
several ticks — progressive, readable collapse with no global connectivity
solve, and the count-to-infinity problem resolves itself because every hop
costs ≥1. Failed intervals become **rubble**, which is granular, so falling,
piling and sliding come free from the existing material system (§15 "grid-
aligned falling rubble first"). No rigid bodies.

Support starts at 0 for everything, so collapse is disabled for the first
120 warmup ticks while support converges; anything genuinely unsupported in
the generated ruins falls during warmup, off-screen.

**Events.** Globals grew a small one-tick event list (≤4: x, y, radius,
strength, kind). Simulation clears it after the tick that consumes it.
Structure reads lightning events as damage (√ falloff with distance,
e^(−depth/8) below the column top). The same channel will carry quakes.

**Lightning seeks high points.** First version damaged the tapped column;
tapping a roof only broke interior slabs — 135 collapses, visually nothing
(measured via the cumulative `collapsed` stat). Now the strike target is the
best `height − 0.4·distance` within 7 cells of the tap (one-off 256 KB
surface readback on strike — rare, async, acceptable per §10). Lightning
needs a storm overhead (rain ≥ 0.15 at the tap), costs 10 Nature, 0.8 s
cooldown. Result after 5 strikes on the warehouse: 288 intervals collapsed,
upper walls visibly torn down into rubble heaps.

**Feedback.** SVG bolt (jagged + fork, flicker-fade), global flash term in
lighting, procedural thunder (crack + layered low rumble) and a crumble
sound driven by the collapsed-count delta from stats readback (so it also
plays for collapses the player didn't directly cause). Rubble darkened so
collapse reads against intact concrete.

## 2026-10-06 — M4: dam breach leverage (hydraulics, erosion, piping, landfill)

Goal (§7, §25 M4): spending a little Nature on the right lever beats brute
force. Result, measured at 2× speed: one 10-Nature lightning strike on the
dam → reservoir mean depth 9.8 → 6.2, flood down the valley, landfill soil
contamination 2.0 → 0.07 within ~12 s real time. Rain alone removes ≤0.4 per
storm (30 Nature), so the same cleanup would cost ~5 storms (~150 Nature).
Baseline without the strike is stable (reservoir 9.87 → 9.78 over 20 s,
landfill unchanged).

**Net flow, not gross flux.** First erosion attempt keyed off total outflow
and produced 7.5k slot overflows and a constantly "eroding" lake: the pipes
model sloshes volume back and forth (mean gross flux 0.52/tick in still
water). `flow.wgsl::netFlow` (outflow − inflow per face) is ~0.04 in still
water; erosion, flood damage, flow-driven dissolving and foam all use it.

**Generic mechanisms (no dam script):**
- *Hydraulic loading* (structure): cracked solids holding back water head
  > 2 gain damage stochastically ∝ head; fast net flow damages cracked solids
  (>0.1) and even intact weak ones in floods (>0.5). Intact structures hold
  forever — the player has to crack one first.
- *Bedrock is not structure*: stone (strength 1) is never damaged. Found when
  a probe showed the stone under the dam at damage 13 from lightning +
  pressure — the whole valley floor would eventually have turned to rubble.
- *Piping* (material): loose top material with a water-level difference > 2.5
  across it is pushed to the low side. Without it the collapsed dam became an
  8-high rubble plug that held the reservoir just below its crest.
- *Flow erosion* (material): net flow > 0.15 drags loose top material one cell
  downstream (off the map at edges). Deposits onto loose material merge into
  the top interval when a column is near its slot limit — overflow back to 0.

**Map.** Reservoir enlarged/deepened and dam raised (+3) so a breach carries
real volume; a basin rim (except the dam valley) and taller dam shoulders
stop it leaking around the dam — the first enlarged version pre-flooded the
industrial site during warmup. New *landfill* (trash material, granular,
rendered as multicoloured specks; contamination 1.8) on a low floodplain bench
just below the dam — first placed 80 cells downstream, where the flood never
left the channel.

**Rain leaching made absolute** (0.00012/tick at rain 1, ≈0.4 per storm) so
heavy deposits genuinely need leverage while light ground still clears in one
storm.

**Dam groan.** Occasional low structural groan whose volume scales with camera
proximity to the dam and stored water — the sparse attention cue §3 asks for.

## 2026-10-06 — M5 (first profile): render-prep visibility culling

Measured draw-pass GPU time (Intel Xe-LPG iGPU, headless Chrome/D3D11):

| render size | draw before | draw after |
|---|---|---|
| 800×450 (low) | 5.8 ms | 2.0 ms |
| 1600×900 (high) | 12.3 ms | 3.0 ms |

Before: the low/high split showed ~4.5 ms resolution-independent cost
(vertex/raster for ~430k faces) plus ~7.5 ms of per-pixel cost at high.

Changes, both behind the existing render-prep → draw contract:
1. **Visibility in render-prep.** A side face is hidden when the neighbour's
   contiguous ground stack reaches the interval's top; a top face is hidden
   when the next interval sits directly on it. Per-face hide bits ride in the
   instance flags; intervals with everything hidden are not emitted. This is
   camera-independent (rotation stays correct) and removed ~50 % of instances
   (131k → 67k) — every column's buried bedrock interval, mostly.
2. **Large-scale ground tint per vertex** instead of per pixel (it's
   low-frequency; 12 hashes/pixel saved).

No visual change. Remaining per-pixel cost is the sub-cell texture hashes and
storm cloud/rain noise; not worth touching at 3 ms.

## 2026-10-06 — onboarding hints, end-to-end smoke test

Two one-time contextual hints (after the first storm: lightning; after the
first strike: cascades) — the minimum to make the leverage discoverable
without a tutorial. `shot.mjs --clicks` gained `wait:ms` tokens; a real-mouse
run (intro → Storm → tap → wait → Lightning → tap) spends 30 + 10 Nature with
no page errors and audio running (audio itself still not verified by ear).

## 2026-10-06 — feedback round 1: foundations, crisp cloud shadows, rain visibility

User feedback from screenshots: land under buildings too flat; buildings
should have substructure sitting into the ground; cloud shadow should be
sharper and more pronounced; wants to see rain in motion.

- **Foundations.** The industrial pad now only partly levels the land
  (45 % toward pad height + 4.5-cell fbm undulation), so the site has
  terraces. `foundation()` seats every structure: base = mean ground over the
  footprint, higher ground is excavated (`ColumnGrid.cut`), and each footprint
  column gets concrete from 3 cells below base (2 for tanks) — on the downhill
  side this shows as an exposed plinth/basement wall. Previously buildings
  filled up to the *max* ground height, which looked like floating slabs.
- **Cloud shadow.** Replaced the soft cover×noise product with one ragged-
  edged mass per storm (`edge = 1.08 − d + noise`, 0.05-wide smoothstep).
  Darkening raised: direct sun ×(1−0.93c), ambient and fill ×(1−0.5c).
- **Rain.** Streaks 45 % longer, 50 % wider, more opaque. Motion can't be
  judged from stills, so `shot.mjs --gif` now records animated captures
  (gifenc + pngjs).

## 2026-10-07 — round 2, phase 1: quick wins (see DECISIONS.md)

- **Rotation removed** (Camera.azimuth fixed at 45°). Nothing else needed to
  change: face choice and culling already used the eye direction.
- **Water glint from the fixed view.** Diagnosis: ripple normals tilt ≤7°
  while the sun/eye half-vector sat ~50° off vertical, so highlights only
  appeared at the one rotation where they lined up. Now: ripple slopes facing
  the sun brighten (diffuse-style ripple shading), and the half-vector is
  biased toward vertical so ordinary ripples glint. First pass was far too
  sparkly; toned down (exponent 160, ×0.7).
- **Stone/dirt colour variation**: per-voxel warm/cool hue drift, fbm mineral
  bands on stone and iron/clay patches on soil, sparse light/dark pebbles.
- **Continuous river.** Inflow moved to the far map edge (15 cells ×
  0.01/tick); the spillway is now 3 deep × 7 wide and the reservoir starts at
  spill level, so inflow and spill balance from the start. Bug found:
  evaporation (3e-5/tick on *every* wet cell) consumed the entire inflow over
  the ~2.5k-cell lake, leaving the river dry. Deep water now evaporates 15×
  slower than thin films. Warmup lengthened to 1800 ticks so the river
  reaches equilibrium before the player looks. Measured: reservoir mean depth
  8.77 → 8.80 over 20 s; river flowing below the dam.
- **Stains wash under any water**: base dissolve rate saturates at 0.2 depth
  instead of 1.0.

## 2026-10-07 — phase 2a: GPU particles + shared wind field

- **Wind field** (`common.wgsl::windAt`): analytic — prevailing wind, storm
  swirl/outflow, up to 4 gust impulses (player gusts, cursor breeze; Globals
  grew `gusts`/`gustDir`), low-frequency gustiness and turbulence. It is the
  contract for anything wind-driven (particles now; sway, fire spread later).
- **Particles**: fixed-capacity ring (16k/32k/64k by quality) with an atomic
  head — oldest overwritten when full; no free list, no readback. Three
  kernels: `emit` (one thread per column, rare probabilistic spawns: dust,
  litter from trash, leaves from trees, cloud puffs inside storms), `bursts`
  (≤64 CPU requests per tick via a uniform: clicks, strikes, birds), `update`
  (integration in the wind field, ground collision against surface+water).
- **Pollution as matter**: dust and litter carry a contamination payload. A new
  fixed-point `contamDelta` buffer (atomic i32 ×1e5 per column) is the
  exchange: emit subtracts, landing adds, and the contamination system folds
  it in with `atomicExchange(…, 0)`. A particle that leaves the map takes its
  payload out of the world; litter swept into water washes its payload into
  the stream; rain knocks dust out of the air.
- Kernels that don't read layers no longer bind the chunk table (frees one of
  the 8 storage slots — particles use exactly 8).
- **Drawing**: screen-aligned squares sized in world units (≥1 px), clouds as
  soft puffs. First pass was invisible: dust ~2 px tan-on-tan; clouds spawned
  at z≈70, which projects ~360 px above their shadow (off-screen). Dust made
  bigger/lighter; cloud deck lowered to z 34–42 and rain now falls from it.
- Cost (iGPU): emit 0.03 ms + update 0.09 ms per tick at 64k capacity.

## 2026-10-07 — phase 2b: oil, the second liquid; open tanks that rupture

- **Oil system** (`oil_flux.wgsl`, `oil_depth.wgsl`): the same virtual-pipes
  model as water, run on H = ground + water + oil, with lower gain/higher
  friction (viscous), plus a *current drag* term — the share of the water
  column moving each way pulls oil with it, so a river carries a slick. Water
  feels oil's weight (density 0.88). Edges drain oil off the map like water.
- **Oil is pollution**: on loose porous ground (granular top material) without
  water it soaks in and becomes soil stain via `contamDelta`; ecology treats
  oil > 0.02 as smothering (dieback, no colonisation). Stats gained oil
  volume. Bug caught: soaking first applied everywhere, so during warmup the
  tanks drained into their own steel floors (oil volume 0 at load).
- **Tanks** are now open rust rings on foundations with oil standing inside
  (70 % full). Lightning that breaches a wall spills the oil across the pad
  (measured: 806 → 786 volume after a strike, the rest pooling on asphalt and
  soaking into rubble).
- **Rendering**: liquids derive depth from the instance z-range (one less
  storage binding); oil is near-black with a faint thin-film sheen. Render-prep
  was split — vegetation emission moved to `vegprep.wgsl` — so terrain/liquid
  prep stays within 8 storage buffers.
- Dust emission halved (visually noisy at close zoom).

## 2026-10-07 — phase 3a: diegetic controls, rolling storms, gusts, tactile clicks

- **No tool buttons.** `input/controls.ts` only classifies gestures: LMB tap,
  LMB drag (gesture if it starts beneath a storm; on touch otherwise pans),
  RMB drag pan, MMB drag zoom, wheel/pinch zoom, hover. `game/powers.ts`
  decides what they mean. HUD shows only the Nature meter and a summon
  control (☁ / R) with a recharge ring (25 s cooldown + 30 Nature).
- **Weather reworked.** Storms are large (r 48) and roll across the map on a
  prevailing wind that wanders ±35° / ±30 % over minutes. Natural storms roll
  in from the map edge every 150–260 s; summoned ones form ~55 cells upwind of
  the cursor (≈15 s to arrive — forming at the map edge took over a minute).
  They fade as they leave the map. No direct steering: gusts push them.
- **Lightning** = tap anywhere under a storm's cloud cover (takes precedence
  over touching things). Not enough Nature → metal-strain sound and a hard
  local breeze instead of an error message.
- **Gust** = drag beneath a storm: a wind impulse along the drag (≤16
  cells/s, r 26, decays over 2.5 s) that also shoves the storm; costs 6 Nature
  (a weak gust + strain if short). Arrow shows the gust while dragging.
- **Cursor breeze**: a small wind impulse that follows cursor motion (≤4
  cells/s, r 7) — it already lifts dust; plant sway will use it in phase 5.
- **Touch responses** (cosmetic): rust → hollow clang + flakes; concrete,
  brick, asphalt → chip particles + dry tile ticks; water/oil → splash;
  plants → leaves (+ birds and wing flutter from tall canopy); ground → dust.
- **Pick target** is now `rg32uint`: column + material/height/flags, so a tap
  knows what it touched. Cursor→ground mapping is a CPU fixed-point solve
  against a ~1 Hz async copy of surface heights.
- Rain at storm scale became a white wall (~20k streaks); now density scales
  with radius (not area) and streaks are dimmer. Clouds puffier and sparser.
  Both remain taste calls for review.

## 2026-10-07 — phase 3b: day/night cycle

- `weather/daynight.ts` drives the light: sun sweeps from front-left
  (morning) through the hand-tuned M0 noon direction to back-right (evening);
  golden-hour warmth at low elevation; at night a dim cool moon from a fixed
  high angle so shadows still read. Outputs sun direction, sun colour ×
  intensity, ambient sky and a night factor into Globals (`sunCol`, `sky`);
  the renderer no longer hard-codes light. Pollution still warms/dims daylight.
- Default day = 8 minutes, starting mid-morning. Debug: `?day=60`, `?tod=0.9`.
- Night: background, haze and lit particles darken; glints scale with the
  current light (first pass left white sparkles on water/oil at night);
  **fireflies** (glowing, unlit particles) drift over living land; audio
  shifts from birds to insects.
