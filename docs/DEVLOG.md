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

## 2026-10-07 — phase 4: fire and the industrial cascade

- **Fire system** (`fire.wgsl`, every tick — at period 2 it missed one-tick
  lightning events on odd ticks): intensity per column; fuel = oil (best),
  vegetation (grass fast, forest hot), loose waste. Race-free gather spread:
  a column catches from burning neighbours with chance ∝ their intensity ×
  own fuel × dryness × wind blowing *from* them. Water, rain and wet soil
  damp it. Lightning ignites fuel within 2.5 cells of the strike.
- **Consumers burn their own resource** (contract: `fire` buffer): oil system
  burns oil (that's how fire clears a slick); ecology burns plants (grass
  instantly, trees slowly); structure takes heat damage near flames (steel
  more than concrete) and burns loose waste down a cell at a time; particles
  emit flames, smoke and embers (`fireEmit` kernel); render fields carry a
  blurred fire glow that lights nearby walls with flickering orange.
- **Render fields**: shadow, moisture, fire glow and net-flow speed are packed
  into one vec4 per column (`renderfields.wgsl`, replaces `shadow.wgsl`) so
  the draw shaders use 6 of 8 storage slots instead of 8+.
- **Measured cascade** (strike into a full tank at dusk, no other input):
  tank ignites → ~90 burning cells, smoke plume, embers → heat ruptures the
  wall (collapses 15 → 167) → burning oil spills → oil 806 → 447 in 20 s →
  burnt-out shell at 40 s. First pass burned out before heat could rupture
  the tank; oil burn halved, steel heat damage ×2.7.
- Litter now only lifts in storm/gust-strength wind (> 5.5 cells/s): at
  normal breezes the landfill was emptying itself into the air (~3k litter
  particles), cleaning itself with no leverage.
- Audio: crackles and pops scale with burning cells.

## 2026-10-07 — phase 5a: sub-voxel canopies, sway, grass tufts and flowers

- **Canopies** keep their 3×3 box instance, but the fragment shader marches
  the view ray through a 4×4×4-per-cell grid inside the box (DDA, ≤40 steps)
  with hashed occupancy thinning toward an ellipsoid edge — lumpy crowns with
  real gaps that show what's behind (discard). This is the user's "render it
  like a sprite from the fixed view" idea done procedurally; depth stays at
  the box face (small error, invisible so far). Derivatives (grid lines) are
  now taken before any discard.
- **Sway** in the vertex shader from the shared wind field (prevailing,
  storms, gusts, cursor breeze): canopies shift rigidly, stems/shrubs/tufts
  bend from the top; plus a speed-dependent flutter. Hovering over trees now
  makes them lean with the cursor's motion.
- **Grass waves**: bright bands travel downwind across grass cover.
- **Detail instances** (flag 128: x/y/size in quarter cells): half-cell tree
  trunks (full-cell trunks read as pillars), grass tufts (1–3 per grassy
  column) and wildflowers (white, yellow, violet, red). Trees thinned (7 % →
  4.5 % of mature columns). Instance budget per column raised to slots + 6.
- Measured (iGPU, 1280×720, regrown forest): 85k instances, draw 3.5 ms.
- Falling-leaf emission cut ×10 (a mature forest was shedding ~600/s).

## 2026-10-07 — phase 5b: vines, life lens (growth blockers)

- **Vines** climb wall faces from living ground in front of them; reach grows
  with that ground's succession stage (up to ~16 cells), drawn as hashed
  vertical strands with leafy gaps. Stateless — derived from `veg` + surface
  at draw time, so no new storage.
- **Life lens** (hold Space): within 24 cells of the cursor, top surfaces are
  tinted by what limits life there, with a distinct pattern each:
  green = growing, magenta = toxic soil, grey hatch = sealed (concrete,
  asphalt, steel — low growth cap), amber dots = too dry, blue = ready for
  life. Oil needs no lens (it's visibly black). This is the "indicate what
  prevents plant growth so it can be cleared" request; shapes, not only
  colours, so it reads for colour-blind players. Globals gained `lens`.
- Seen in testing: after a long storm over the ruins, rainwater pools inside
  the warehouse shell and vines + trees take over the site — the §2 "forest
  over recognisable ruins" look emerging from the systems.

## 2026-10-07 — phase 5c: birds and deer (theme, plus one small systemic touch)

- **Birds** lift out of mature trees by day (and from tapped trees), climb to
  cruising height, wheel about and land again. Landing on clean, moist, bare
  ground plants a pioneer (veg 0 → 0.3): seed dispersal. The particle update
  binds `veg` read-write for exactly this "plant only" write (documented
  exception to single-writer ownership; the only possible race is two birds
  writing the same 0.3).
- **Deer** are ground-bound particles: wander, pause to graze, turn back from
  barren ground, water and cliffs, and bolt from a fast-moving cursor (the
  cursor-breeze gust). Drawn as small 1.7:0.9 brown blocks.
- Bug: rare spawns used 16-bit randoms, whose smallest non-zero chance is
  1/65536 — ~250× the intended deer rate (675 deer in a grown forest). Rare
  events now use a full 32-bit draw (`rare()`); measured 4 deer and 37 birds in
  the same forest.

## 2026-10-07 — round 3, batch 1: audio, cracking taps, splashes, sealed tanks

User feedback: audio too loud; a hiss "that doesn't sound like rain"; rain
should be heard only under storms, otherwise wind and distant thunder; taps on
structures neither cracked them nor made a falling-stone sound; no splash on
water; tank tap should be deeper/more hollow; tanks should be closed so oil
only shows when they break.

- **Audio**: master 0.8 → 0.42. The constant "rain-like" noise was the river
  layer (bandpassed pink noise at 650 Hz, loud): now a quiet low murmur. Rain
  is heard only under a storm: a softer hiss plus individual drop ticks.
  Fair weather: wind (softer) and a far-off thunder roll every 35–85 s.
- **Taps on masonry** now do real, small decay: an `EV_CHIP` event (kind
  packed with the tapped height: `kind + 16·z`) adds 1 damage to intervals at
  that height within 1.8 cells; ~12 taps bring a piece down. **Cracks**:
  render-prep passes structural damage in instance bits 16..19 and the draw
  shader draws noise-traced cracks and chipped sub-voxels that grow with
  damage — lightning, heat and water pressure now show too. Sound: sharp crack,
  stones bouncing down (shortening intervals, falling pitch), grit trickle.
  (Picking was fine — the response was just too subtle to notice.)
- **Splash bug**: the picked height is floored, so spray spawned *below* the
  water surface and died on its first frame. Now starts 1.4 above; bigger
  droplets; plop + spray sound.
- **Clang**: ~50 Hz fundamental with inharmonic partials up to 3 s, through a
  short feedback delay (the tank's cavity) and a dull knuckle thump.
- **Sealed tanks**: domed rust roofs; oil lives in a new `oilStored` (amount,
  roof z) owned by the oil system and is released into the oil field when the
  column top drops below the roof or a neighbouring wall falls. Sealed oil
  counts as fire fuel (a strike lights the tank from inside; fire slowly
  consumes it; heat ruptures the shell; burning oil spills). Rust strength
  0.7 → 0.85 — at 0.7 the wide roofs couldn't span to the centre and
  collapsed during warmup (80 units of oil free at load).

## 2026-10-07 — round 3, batch 2: settling dust, white birds, rabbits, startle

- **Dust settles**: heavier (falls within seconds), lands, drops its payload
  and lies on the ground (faint) for 20–45 s; strong wind (> 4.5 cells/s, e.g.
  gusts, storm edges) occasionally sweeps it up again — and it picks up fresh
  pollution from where it lay. Measured ~10k settled vs ~6k airborne. Rarer
  and less yellow (it read as pollen).
- **Birds** are white with V-shaped wings that flap (fragment-shader V with a
  flapping wing angle); they lift from shrubs too, not only mature trees.
- **Rabbits** (small, hopping, faster) on grassland; deer in woodland. A few
  rabbits, deer and birds start in the healthy corner so life is visible from
  the first minute. **Every tap startles** animals nearby (taps emit a short
  breeze impulse; animals flee it — deer within 9 cells, rabbits within 7).

## 2026-10-07 — round 3, batch 3: bigger, irregular storms; higher cloud deck

- `stormDist()` (WGSL, mirrored on the CPU in `Weather.stormDist`): storms are
  no longer discs — the outline wobbles with three slowly drifting angular
  harmonics (per-storm random phases) and is stretched 1.2–1.65× along the
  direction of travel. Cloud shadow, rain field, cloud-puff emission, rain
  streak placement and the CPU's lightning cover / audio rain all use it.
  Globals gained `stormsC` (528 bytes).
- Radius 48 → 60–85. Cloud deck 34 → 44–52, rain falls from 48.
- Clouds slightly thinner (alpha 0.24 → 0.19) — at the new size two storms
  can cover most of the view. Taste call; flagged for review.

## 2026-10-07 — round 3, batch 4: biomes and tree variety

- **Biomes**: `slope.wgsl` (flatness from ±2-cell height differences). Flat
  ground holds moisture (dries at 35 %), slopes drain. Succession past stage
  3.3 (trees) requires woodland conditions: flat × wet × a large-scale natural
  patch noise; elsewhere it stops at **meadow** (grass, shrubs, ~30 % flowers).
  First pass gated only on flatness + wetness and produced forest everywhere
  — on this map almost everything is "gently sloped", so the patch noise
  carries most of the variety. **Fireflies** now only appear over meadow.
- **Tree species** (bits 16..19 of vegetation instances): broadleaf (varied
  height and crown), **conifer** (short trunk, tall cone-shaped sub-voxel
  crown, dark blue-green), **birch** (slender pale barked trunk, airy light
  crown), **old giant** (on the oldest woodland: 4×4-quarter trunk, 5×5 crown,
  tall). Heights vary per tree.

## 2026-10-07 — round 3, batch 5: menu diorama, reclamation goal, scenes

- **Scenes.** `main.ts` is now a thin boot + scene switcher. `scenes/world-core.ts`
  bundles one live world (WorldGpu, Simulation, Renderer, Weather, DayNight,
  Camera, Globals, warmup/advance/render, readbacks). `LevelScene` is the old
  main loop; `MenuScene` is new. Scenes dispose cleanly: WorldGpu frees every
  buffer allocated through `buf()`, renderer frees its textures, Controls/keys
  use AbortControllers, HUD removes its DOM. Readbacks still in flight when a
  world is destroyed reject with AbortError — `ignoreTeardown` swallows only
  that (seen in the first scene-switch test), anything else still throws.
- **Menu** (design doc §4): a 48×48 live diorama — a voxel skull lying on its
  side (hollow cranium, eye sockets, nose, teeth), jaw, femur, arm bone, ribs,
  trash and debris. Its state is a pure function of persistent progress p:
  trash and contamination fade, moss/lichen on bone (~0.45), grass and
  flowers (~0.7), and at p ≥ 0.95 a tree grows up through the eye socket.
  Wind is strong when dead (scraps and dust blow across), calm when alive;
  birds visit once alive; the cursor stirs a breeze. Only surface, particles,
  render fields and stats run — a tableau, not a simulation. One line of text
  per stage. `?progress=0..1` previews any stage.
- **Reclamation goal**: HUD bar = living land ÷ land not under water, goal
  40 % (marked at 80 % of the track). Progress (best fraction ÷ goal) is saved
  to localStorage every 5 s and drives the menu; reaching the goal shows
  "THE VALLEY BREATHES" with *Keep watching* / *Return*. `?skipmenu=1` jumps
  straight into the level (scripted tests).

## 2026-10-07 — goal tuning

Measured at 8× with a storm summoned every ~4 game-minutes: living share of
the map 0.01 → 0.43 after ~4 game-minutes, 0.6–0.8 after ~10 (it dips when
fires or floods hit). 40 % ended the level in a few minutes; goal raised to
60 % (~10 minutes of play). Moss counts as living (v ≥ 0.5), which is why it
moves fast — a stricter definition (grass+) is a design option.

## 2026-10-07 — session 2, round 4 batch 1: wind, weather, light, debris, birds, audio

User feedback round 4 (DECISIONS). This batch:

- **Wind jitter.** Two causes, both "phase = time × varying speed": the grass
  wave `sin(... - time·(1.5 + ws·0.6))` and the sway flutter
  `sin(time·(2.5 + amp·5))`. With time in the hundreds of seconds, any change
  of local wind speed jumped the phase. Also the gust-strength noise scrolled
  diagonally regardless of wind direction. Now every wind noise term is
  sampled in a frame moving with the integrated prevailing wind
  (`Globals.env.xy`, integrated on the CPU), so gust patches roll downwind
  smoothly; flutter has a fixed frequency; grass shows gust patches plus fine
  bands that travel with the same integral. Water ripples are advected the
  same way and roughen with local wind (drags send catspaws across).
- **Drag = wind, everywhere.** Any LMB drag is a gust following the cursor
  (strength = smoothed cursor speed × 0.12, cap 14; radius 11). While the
  drag lasts it leans on storms within 1.2 radii (`Weather.gust` with
  strength × dt; storm push capped at 7 cells/s). No arrow, no hint, no
  Nature cost — steering is for players to discover. Measured: a scripted
  90 cells/s circular drag gives strength 7.1 and lifted ~700 dust / 100
  litter particles plus haze within 1.5 s.
- **Ground debris.** Dust, litter and leaves are now born resting on the
  ground (dry dusty soil; dumps; woodland floor) and only wind over a per-kind
  threshold lifts them (dust 4.5, litter 4.0, leaves 3.5 cells/s; chance per
  tick ∝ excess). Nothing spawns in the air. Lifted dust/litter takes soil
  contamination with it. The level seeds debris during warmup (`env.z` = 10).
  First try spawned 37 k resting dust (speckled the whole map like noise);
  rate cut 5× → ~6.5 k, drawn smaller and fainter.
- **Dust storms.** `Weather.dusts` (≤2): patches of strong gusty wind rolling
  downwind at 1.4× the prevailing wind. Two cross the map as the level opens;
  more arrive while the land is dusty (`dustiness` = pollution). They lift
  ground debris and raise haze puffs (new particle kind 15, tan, soft); strong
  wind anywhere over dusty ground raises haze too.
- **Storm clouds.** Deck moved from z 44 to 80, half the puffs, 0.075 alpha;
  rain now falls from the deck base (span 78). The cloud shade was the main
  thing hiding the land: sun reduction 0.93 → 0.72, ambient 0.5 → 0.25 — still
  an obvious shadow (it marks where lightning works) but readable.
- **Lightning flash.** Whole-scene cold light (≈2.6× on every face, all
  particles, and the clear colour) with a stroke–dip–restrike flicker over
  ~1 s (`flashEnvelope` in world-core).
- **Day/night.** The moon now has its own arc and only rises once the sun's
  light is gone (before, the light jumped from the sun's direction to a fixed
  moon direction with a visible colour step at dusk). Wider fades. Sun shadows
  on tops blend the four nearest columns' shadow tests (same level or a bit
  lower only — including higher neighbours drew dark contour bands along every
  terrace), so shadow edges slide smoothly as the sun moves.
- **Birds.** Flocks fly in from a random map edge by day once there is
  woodland (interval ~12–40 s depending on mature cover), glance around for
  woods, pick a crown (`vegPlan`, shared with vegprep via `vegplan.wgsl`) and
  perch with folded wings for minutes, dropping the odd seed nearby. A tap on
  a tree sends `EV_SCARE`; perched birds within 3.2 cells flush (lightning
  nearby too). Trees without birds give only leaves. Test: forced 29×29
  woodland, 8 arrivals → 12 perched after 25 s; a scare flushed all 12
  (counter 0 → 12).
- **Audio.** Ambient and click buses. The ambient bed is quieter (0.5 × master)
  and falls to 30 % when zoomed out; rain is heard from storms near the view
  (panned toward them), water from wet columns near the view centre and the
  dam, birdsong/insects/leaves from living land near the view (1 Hz veg/water
  readbacks). Click responses are full volume and panned to the click; drags
  have their own whoosh. **Unverified by ear** — the user should check.

Perf (Xe-LPG, 1600×900, storm + dust storm in view): GPU 5.7 ms (was ~6 ms
with storm + fire).

## 2026-10-07 — round 4 batch 2: starting pollution, pacing

- **Sludge pools.** Five hollows carved near the site (flat ground, away from
  the river/healthy patch/landfill), filled to 0.3 below their lowest rim with
  water carrying 3× its depth in dissolved waste over a fouled bed (soil 2.2);
  two carry an oil film. First version dug only the top interval and four of
  five pools came out dry (thin soil over stone); now `grid.cut` digs through
  layers. Probed after 60 s: all five hold (depth 0.7–2.7, concentration
  6–10); one seeps slowly downhill, spreading its stain.
  Dissolved waste used to decay with a ~1-minute half-life, so any pool
  would clean itself before the player saw it. Decay is now divided by
  (1 + 6·conc²): thick sludge persists until diluted and flushed (rain,
  floods); thin solutions still degrade as before. Rendered opaque, dark
  murky brown with sickly yellow scum, slow bubbles, dull glints (first
  try was olive-green and read as a lawn).
- **Oil slicks** on the asphalt pad (asphalt doesn't soak oil), four blobs.
- **Trash heaps:** twelve low mounds of waste (with the odd rusted drum) over
  fouled ground, mostly around the site; their resting litter blows off in
  strong wind.
- **Pacing.** Measured at 8× with storms every 3 game-minutes: 45 % at 3.6
  min, plateau, 60 % at 8 min. Storms every 5 min: 47 % at 3.2 min, 50 % at
  3.6, then a plateau around 50 until the next storm. Goal lowered 60 % → 45 %
  — reachable in ~3–5 minutes of reasonable play (DECISIONS: ~5 min).

## 2026-10-07 — round 4 batch 3: menu skull

The old skull lay on its side and read as a lump (user: "doesn't really look
like a skull and bones"). New figure (`menumap.ts`): an upright skull facing
the camera — domed cranium, brow ridge, big tilted eye sockets, a nasal hole,
cheekbones, a row of teeth and an open lower jaw — half sunk in a mound of
reddish-grey dust (new `ash` material, 17). The cranium is filled with dark
matter (asphalt) so the sockets and nose read as black holes; with a hollow
interior they were only mid-grey. A ribcage lies on its back to the right
(spine with vertebrae, six arched ribs, open where the breastbone was): first
laid diagonally in the camera frame, its hoops broke into disconnected voxel
stair-steps, so it now runs along the grid's x axis and each rib is one voxel
plane. Two crossed long bones in front, an arm bone by the ribs. At full
progress the tree grows out of the cranium (it used to rise up the face and
hide it). Menu wind lowered (6.2 → 4.4 at p = 0) so the new haze threshold
doesn't fog the figure.

User follow-up: "use more voxels, make the ribs arc more, tilt the skull and
sink it a bit". The figure is now defined in figure units and sampled 1.6×
finer (`MENU_SCALE`; map 80×80, zMax 64; the menu camera scales with it).
Skull yawed 0.18, rolled 0.24, pitched 0.1 and sunk 2.6 units into the
mound, with a bone floor (the tilt exposed the dark-filled cranium from
below). Ribs: seven tall elliptical arcs (height 1.3× width) leaning back as
they rise, open only at the very top. Trash density halved (finer voxels
doubled the speckle). The final-stage canopy is a solid lumpy crown with a
few branches — per-voxel random leaves needed 17 layers in a column (> MAX_K).

## 2026-10-07 — round 5: springy relaxed motion, lingering drag wind, consequences

DECISIONS round 5.

- **Sway with memory.** New `sway` system: a damped spring per column
  (`bend` buffer) driven by the wind at canopy height. Pushing into the lean
  it is stiff and well damped (k 7, c 4.2) so plants bend readily and hold;
  easing back it is soft and lightly damped (k 1.6, c 1.1) so they spring
  back slowly with a little overshoot. Draw shaders read the spring instead
  of evaluating wind per vertex; flutter slowed (3.4 → 2.2 rad/s). Measured
  at one column through a 1 s drag: lean 0.23 (calm) → 0.41 → 0.46 held for
  ~1 s after release → back to 0.21 by 2.4 s, settling at 0.22.
- **Drag wind lingers.** Strength builds with speed (0.16 × cursor speed, cap
  18) and eases off slowly when the cursor stops. The stroke leaves gust
  puffs every 0.3 s and on release, each living 1–2.5 s (longer for faster
  drags). All of it leans on nearby storms while it blows.
- **Storms.** Cloud puffs removed; rain streaks fade in over the top 26 of a
  56-cell fall. Storm shade darker again (sun −90 %, ambient −42 %).
- **Oil was effectively unburnable** (pre-existing): a spill spreads into a
  film within a second, and fuel was 3 × depth, so a thin film couldn't
  sustain fire (trace: lit at 0.9, out in ~25 ticks with oil 0.08 → 0).
  Any film over 0.004 is now strong fuel. Lightning ignites within its
  radius (≤ 4) rather than 2.5 cells, since it lands on the highest point
  near the tap, not necessarily on the slick. Oil on water burns (the water
  no longer damps or blocks fire where oil floats).
- **Oil consequences.** Free oil drains Nature (0.004 per unit volume per
  second; the starting slicks ≈ 33 → −0.13/s; a 13×13 spill ≈ 277 → −0.7/s,
  the HUD meter turns rust-coloured while net-negative). Burning oil makes
  oil smoke: long-lived dark puffs that hover 8–14 cells up and drift. Wind
  over 4 cells/s tears them apart faster; each dispersed puff gives 0.012
  Nature; puffs that die in calm air fall as soot (contamination). Test: a
  burned spill + one 4 s drag dispersed 139 puffs (+1.7 Nature).
- **Forests burn.** Woodland grows on wet ground, which used to make it
  nearly fireproof (dryness factor and wet-ground damping). Under a canopy
  both are mostly ignored. Spread was then far too fast (a 29×29 wood
  burned out in < 10 s); plant ignition is now 0.006 × heat (oil 0.11, waste
  0.05) and trees lose stage at 0.12 × fire per ecology update: the test wood
  burns with 30–50 cells alight at a time and loses ~60 % in 30 s.
- **Drowning** living cells (under > 0.4 water; new stat) drain 0.02 Nature
  each per second.
- **Burn-only trash.** Trash is now solid (strength 1: never structural) —
  floods no longer scour dumps; fire burns a heap down a cell at a time and
  leaves loose ash (material 17), which counts as very dusty ground (wind
  lifts it with its contamination) and which water can carry. Waste fire
  spread 0.05. Test: one strike on the landfill turned 296 of 355 trash
  surface cells to ash in 16 s; the wind then lifted ash plumes.

Perf (Xe-LPG, 1600×900, storm in view): GPU 5.9 ms.

## 2026-10-07 — round 6 batch 1: withering, seeds, grow-tap, litter

Goal (DECISIONS round 6): give the wind and taps a clearer purpose and let
the world show what has to be cleared.

- **Withering.** New `wilt` system/buffer (x hostility, y brownness).
  Hostility = soil poison (contam / 0.2), oil, trash or litter underfoot,
  drowning (> 0.5 water), drought (moisture < 0.04 → 0.8). Brownness rises
  while plants stand on ground with hostility > 0.7 (oil fast, fire at once),
  fades otherwise. Ecology no longer reads contamination/oil directly: fresh
  sprouts (< 0.9) grow regardless, then stall by hostility; anything browned
  past 0.4 dies back. Plants spreading from neighbours now also try hostile
  ground (at 30 % of the rate), so the edge of what life can reach shows as
  a brown fringe. First threshold (browning from hostility 0.5, i.e. contam
  0.1) killed plants on lightly polluted ground that used to grow slowly; it
  now starts where growth stops (0.7). Plants render toward straw/brown.
  Ecology freed two storage bindings (contam, oil → wilt).
- **Seeds.** Trees release floating seed fluff in pulses (own rhythm per
  tree) and more in wind over 4 cells/s; seeds ride the wind, sink slower the
  stronger it blows, and sprout on bare dry land wherever they land — taking
  or withering. Flushed birds shed seeds as they fly; perched birds drop
  them visibly. Test (21×21 forced wood, 60 s at 2×): ~30 seeds in flight per
  pulse; 26–33 sprouts beyond the wood, the ones on hostile ground browning.
- **Grow-tap.** Tapping plants or open ground sends `EV_GROW` (r 2.5): living
  or bare clean ground gets +0.35 (a sprout if bare) with green sparkles and a
  soft rising chime; hostile ground only gives brown flecks. Test: clean soil
  0 → 0.51.
- **Litter.** New loose material 18 scattered over dead ground (≈3000
  cells), thickest near the site/roads and in a ring around the healthy
  patch. Nothing grows on it; wind over 5 cells/s strips it a cell at a time
  (material system) and throws the scrap into the air (particles, same
  deterministic roll one tick ahead) carrying some contamination. Test: a
  5 s drag over the ring stripped 726 → 280 litter cells.
- Pacing re-measured (8×, storm every 5 game-min): 44 % at 3.2 min, 51 % at
  4.0 — unchanged.

## 2026-10-07 — round 6 batch 2: phone-ready controls (no hosting yet)

Touch already mapped one finger to the gesture (tap = touch/grow, drag =
wind) and two fingers to pan + pinch zoom; the page blocks browser gestures
(`touch-action: none`). Added for phones: a hold-to-see life-lens button on
coarse pointers (Space has no touch equivalent), a touch-specific opening hint
(no keys, "two fingers to look around"), hints that wrap instead of being cut
off, and a closer opening zoom in portrait (min(w·1.9, h·1.6)/300 — at
412×900 the valley went from a small diamond to filling the width). Quality
stays explicit (`?q=low` on phones; no auto-detection, design doc §10).
Hosting (WebGPU needs https off localhost) is for the morning.

## 2026-10-08 — round 7: wind field, the cleaning game, immediate plant feedback

User: wind too weak; how does the wind work and how long do strokes last?
Polluted ground should look grimy and blow away like a cleaning game. Plants
too slow / not obvious; a tap should grow something at once. Taps must never
cost Nature. Pacing is not the focus — fun mechanics are.

- **Wind field.** Before: strokes were three Gaussian stamps (live gust + two
  trail puffs, radius ~11, ~1–2.5 s) added analytically in `windAt`. Now the
  player paints into a persistent texture field (see ARCHITECTURE): every
  frame the segment the cursor moved along is stamped (radius 7, strength
  0.22 × cursor speed, cap 24 cells/s), and the field carries itself along,
  spreads and fades over ~3 s. Measured with plant lean along a 1 s stroke:
  the whole path stays windy 3–4 s after release, the gust rolls on
  downwind, gone by ~5 s. Plant lean cap raised (2.6 × 0.3) so strong wind
  bends harder. Haze from player wind cut to a wisp (it hid the action).
  Cost: windfield 0.024 ms.
- **Taps never need Nature.** A tap under a storm is lightning only if Nature
  can pay; otherwise it is the ordinary touch (clink, crack, grow).
- **Grime (the cleaning game).** Polluted ground (contam > 0.25) forms
  clumps of grime — resting dust particles that *hold* some of the ground's
  pollution (up to 0.06 each) — and the ground under them shows tarry blobs
  and sickly/rusty flecks. Wind lifts grime (lighter than dust, so it
  sails); where it lands it keeps its pollution, and in water it washes away
  (splash, plinks, +0.04 Nature each, `particleCounters[3]`). ≈3000 grime at
  start. Six strokes from the landfill toward the river washed 5–23 clumps
  (the channel below the dam carries little water there; pools/reservoir
  take it too).
- **Immediate plant feedback.** `wilt` became vec4 and runs every tick. A
  grow-tap on good ground raises grass at once (veg ≥ 1.5 near the tap) and
  opens flowers (half-cell, 0.9 tall) that last ~90 s; on hostile ground a
  sprout shoots up in ~1 s, browns by ~4 s and droops away by 7 s.
  Woody growth ×3 faster (trees from bare ground in ~1.5–2 min instead of
  4–5).

Perf: GPU 5.5 ms with a storm in view (Xe-LPG, 1600×900).

## 2026-10-08 — round 8: stacking wind, storms on the field, score tied to deeds

- **Strokes stack.** A pass now *adds* to the field (≈ 0.7 × 4.5–8 along
  its centre line; normalised by segment length / stroke width so speed
  doesn't change it). Measured at a point after repeated passes: 7.0 → 12.2
  → 15.9 → 18.8 cells/s on top of the map wind — breeze, gust, gale (the HUD
  shows the word; the whoosh follows a CPU estimate of how many recent
  strokes overlap). Stroke segments became one-tick impulses: at 120 fps
  only ~half the frames run a tick, so per-frame segments were half lost.
- **Relaxes slowly.** The field decays toward the map wind (e-folding 7 s)
  and only drifts at 30 % of its own speed — at full speed it carried itself
  off the painted spot within ~2 s (field at the point 5.1 after 2 s; now
  8.1 after 2 s with 5 s decay, longer with 7 s).
- **Storms on the field.** The CPU reads the field back at ~4 Hz; each
  storm adds 1.4 × the field's mean over 60 % of its radius to its target
  velocity. Test: five passes × five lanes across a storm turned its
  velocity from (3.0, 2.8) to (−4.3, 9.6) and carried it ~65 cells off its
  course before it eased back to the map wind. The old direct "push" on
  storms is gone; steering is through the field only.
- **Storms always form at the upwind map edge** (summoned ones too) and
  drift across.
- **Score tied to deeds.** Reclamation = ½ clean land + ½ life weighted by
  stage (woodland counts fully, moss a little). Nature pays out on
  pollution removed (0.015/unit), litter stripped (0.04/cell), new mature
  woodland (0.06/cell), grime washed, oil smoke dispersed, with a "+N" on the
  meter. Starting score 6.7 % (clean 13 %, almost no life). 8× with a storm
  every 5 game-min: 25 % at 1.2 min, 47 % at 2.8, 59 % at 5 — goal 55 %.

## 2026-10-08 — one wind field; storms that reliably arrive

- **One wind field.** The field texture now holds the whole wind (rgba: painted
  part + map wind + painted), written by the windfield system; `windAt` reads
  it (cheaper too: the gust/eddy noise is evaluated once per texel per tick
  instead of per caller). Storms take their target velocity from the field's
  mean over their body — the map's own gust patches move them, and painted
  wind steers them through the same field. Measured: painted 7.1 / 12.6 /
  16.9 / 20.2 → whole wind 10.6 / 15.7 / 19.8 / 23.1 cells/s after 1–4
  passes; relaxes to 8.0 after 6 s. A painted push across a storm turned it
  from (2.8, 2.8) to (−2.2, 7.8).
- **Storms reliably arrive.** User: "storms do not seem to reliably form".
  They did form, but beyond the map corner (spawned 20 cells outside), with
  no sign for ~40 s. Now they gather just inside the upwind edge (full
  strength in ~6 s, half on the map at once) and summoning plays distant
  thunder immediately, panned toward that edge; summoned storms aim at the
  middle of the view (the cursor sits on the button when it's clicked).
  Tracked: formed at (8, 4), over the middle by ~30 s.

## 2026-10-08 — round 9 part 1: tap tiers

DECISIONS round 9: one tap grass, two flowers or a shrub, three a tree; on
bad ground each grows and then withers (the tree darkens and shrinks).
`wilt.z`/`wilt.w` now hold tier + growth (good ground; stays while the
ground stays good — player-planted trees persist) and tier + phase (hostile
ground; 6 / 8 / 11 s by tier, browning from 25 % of the phase, shrinking
from 60 %). A tap steps a cell up one tier: the tree only at the tap's own
cell, flowers/shrubs within ~1.4 cells, grass to 2.5. Established green
ground tolerates more poison (limit 0.2 → 0.5 as grass takes hold) so a
cleared patch holds when a little grime drifts in. Vegprep draws plantings
(grass tufts and flowers half a cell wide, a sub-voxel shrub, trunk +
crown); the short-lived sprout material is gone. Checked on clean soil
(grass / flowers / a lasting tree) and on the landfill (a tree at 2 s,
browned and shrunk at 6 s, gone at 11 s).

## 2026-10-08 — round 9 part 2: camera director + first-play intro

`game/director.ts`: camera limits (zoom range + target box, applied each
frame after input), eased camera flights (zoom in log space), holds and
waits on predicates — a tiny step-script runtime. It drives only the camera
and simulates the player through Powers (`scriptTap`, `scriptStroke`, which
draw real wind strokes); Powers gained hooks (`onGrowTap`, `onStroke`) so the
script can wait on what the player does. Esc cancels (`cancel()` frees the
camera).

The intro (first play: progress 0 and not `?skipmenu`; force with
`?tutorial=1`, suppress with `?tutorial=0`), on a guaranteed spot — a litter
patch on clean, moist soil just beside the healthy patch (`poi.tutorial`):
whole valley (3 s) → fly in (3 s) → two scripted taps: flowers sprout from
the litter and brown away → three scripted wind strokes strip the litter →
two taps: grass and flowers take and hold → the player's turn, confined to a
32-cell box, zoom 9–20: touch the green (2 grow taps), touch the dust (a
tap on hostile ground), drag (a stroke; "again for a gust, again for a
gale") — each step times out after 25 s → fly out, camera free, dust storms
roll in and natural weather resumes (held back during the intro).

Bug found while testing: when a flight landed, the previous lock clamped the
camera straight back before the script set the new one — flights now drop
the old limits. The intro also waits for the first resize (it is attached
before the viewport has a size).

## 2026-10-08 — round 9 part 3: the title screen has hands

The menu runs the level's gestures through the same Powers/Controls (taps
grow or wither, drags paint wind; the view stays fixed) plus the systems they
need (windfield, material for litter stripping, wilt) — still no ecology,
water or structure. Its loose scraps are now litter the wind strips. It opens
by showing what the dust does: a tree grows beside the skull and withers,
then flowers try a little further off. A "touch the ground · drag to make
wind" line, and a "reset progress" link (when there is progress) that clears
it and reloads to the dusty start. Bones and dark matter carry no pollution
(grime had speckled the skull). Powers' HUD dependency became optional.

## 2026-10-08 — round 10 batch 1 (A1–A5, A8, A12, A13)

- **A1/A2 desolate wind.** New ambient voice: noise through two narrow
  resonances (430 / 660 Hz, Q 11–14) whose pitch drifts on slow LFOs — a
  hollow howl — swelling in periodic gusts (rise 2–4.5 s, lull 3–9 s). Its
  level is barrenness² × (0.05 + 0.06 × wind): title screen barrenness =
  1 − progress; level = 0.7 × (1 − living land in view) + 0.3 × pollution.
  Unheard by an agent.
- **A3/A4 drag sound.** The whoosh starts with the drag (not after the first
  stroke tier registers) and the rustle "snap" at mouse-up is gone; the
  whoosh is lower (bandpass 110–350 Hz, was 300–1000) so it sits under the
  howl.
- **A5.** No birds on the title screen.
- **A8.** Painted wind under a storm stamps up to 1.8× stronger (by storm
  cover at the texel).
- **A12.** Prevailing wind wanders ±10° and 88–112 % (was ±35°, 70–130 %);
  gust patches 0.8–1.2× (was 0.55–1.45×); eddies halved. Painted strokes get
  a little noise: ±14° and 85–115 % strength from a slow noise field.
  Stacking re-measured: whole wind 11.2 / 16.7 / 21.0 / 24.1 after 1–4
  passes.
- **A13 storm shadow swirl.** The ragged edge was fbm scrolled by
  `time × current wind` — every wind shift jumped the pattern (the same bug
  class as the round-4 jitter). It now lives in the storm's own frame and
  evolves slowly; the outline lobes drift at 0.015 rad/s (was 0.05). Two
  shots 6 s apart: same shape, translated.

## 2026-10-08 — round 10 batch 2 (A10, A11, A14)

- **A10 seeds that clean.** A landing seed now raises its cell to at least
  0.5 (or +0.15 if already growing), breaks down a quarter of the poison
  (≤ 0.05) in its cell and the four neighbours, and gives a green sparkle.
  Wind over trees and flowering plants, and birds, now slowly clean.
- **A11 petals.** New `petals` buffer (1 = in bloom). A gust over 9 cells/s
  across flowering cells (plan flowers or player-planted tier ≥ 2) strips
  them: four petal particles in flower colours flutter away and the flowers
  stand as bare stems (vegprep draws them as grass) until they regrow over
  ~45 s. Test: three gust passes over freshly planted flowers shed 8 cells,
  32 petals in the air.
- **A14 fair-weather clouds.** Light, soft shadows (≤ 22 % sun reduction,
  storms 90 %) advected 1.3× with the integrated prevailing wind, so the sky
  shows the wind direction. First scale gave ~3 clouds across the map
  (invisible in practice); now ~6–8. They are not storm cover (no
  lightning, no rain).

## 2026-10-08 — round 10 batch 3 (A9 difficulty)

`Globals.env.w` = difficulty (0 easy, 1 medium, 2 hard), chosen on the title
screen (three quiet buttons under Begin, remembered; `?difficulty=` overrides
for testing). The wilt system keeps an "established" flag (+2 on wilt.x,
read through `wiltHostility()`) once a column has been green (veg ≥ 0.6):
- easy: established ground ignores poison, oil and litter for good;
- medium: established ground tolerates poison up to 0.55 (fresh 0.2);
- hard: no extra tolerance, water over 0.25 (not 0.5) drowns, and gales
  (> 15 cells/s) brown what grows.
Test: the healthy patch (veg 1.12) dosed with 0.4 poison for 25 s — easy
1.29 (kept growing), medium 1.06 (held), hard 0.01 (died); medium at 0.9 →
0.01. First medium rule (tolerance by grass stage) let the mossy patch die
at 0.4; it now keys off the established flag.

## 2026-10-08 — round 10 batch 4 (A7 staged tutorial)

The intro now builds skills (DECISIONS round 10): growth/withering →
wind → the player's first taps and drag → **show you've got it**: clear the
scraps around the green (≥ 55 % of the litter within 13 cells gone) and grow
something on cleared ground → **something new**: a heap of compacted waste
(fixed spot `poi.heap` beside the tutorial patch) the wind can't move — "try
it" → a storm is called in from the upwind edge (thunder first; free), the
camera widens to watch it come → "tap beneath the storm" — the player's
lightning → "fire leaves ash; blow it away" (half the ash gone) → out to the
valley. Each step times out so nobody gets stuck.

Two mechanics changed to make the lesson true:
- **Wind strips ash** like litter (`isStrippable`): ash cells go up in grey
  puffs. (Ash used to be permanent unless water carried it.) The menu's
  reddish mound is ash too, so gales on the title screen can wear it down.
- **Lightning blasts compacted waste to ash** where it strikes (structure
  kernel, strike strength > 8 ≈ within ~4 cells). Fire alone burns a heap
  slowly — and under the storm the rain kept damping it (the first run
  waited the full 45 s).

Driven headlessly end to end with a script that reads each hint and plays
the move: complete in 86 s (lightning → ash in 2 s; four drags cleared it).

## 2026-10-08 — round 10 batch 5 (A15 smooth soft surfaces, render part)

Column heights stay whole cells; soft materials are *drawn* sloped. New
material property `smooth` (cells; soil/sand/ash 2, litter 1.5, rubble 1,
others 0 — `MATS[m].look.x`; the material uniform grew to 4 vec4s).
`terrainshape.wgsl`: each grid corner gets one height shared by the four
columns touching it — a tent-weighted mean over the 4×4 columns around it —
when the four are all soft and within the smallest threshold of each other
(else each keeps its own height there: a sheer step). Shared corners keep
the surface watertight; side faces still cover real steps. The top box of a
soft column takes its corners from this (and a flat face normal from them),
its visible side faces' top edges follow, plants sit on the sloped surface
(vegprep, cell centre).

Measured/iterated:
- 2×2-column corners only bevelled step edges (flat terraces remained,
  banding at low sun) → 4×4 tent kernel.
- Evaluating corners per vertex doubled draw time (3.3 → 6.1 ms at
  1400×800) → they are computed once per render-fields pass into a
  `corners` texture (rgba32f, binding 14) and looked up: draw 2.6 ms.
- Sun shadows: slopes dip up to ~1 cell below the whole-cell shadow field,
  which drew dark bands; the shadow test has 0.9 cells of slack on tops and
  soft occluders cast from 0.9 lower.
Not yet: water surfaces (still boxes; B8), particles resting on slopes
(they sit at whole-cell height), the fractional sediment layer (A6).

## 2026-10-08 — round 11 batch 1 (C3, C4, C5; howl)

- **C4 audio debug** (`?audio=1`): every continuous voice is routed through a
  named mute gain and listed with its live level (dB bar) and a mute box;
  every one-shot is logged by name (repeats counted) and can be muted by
  name too. For the user's "high-pitched sound under storms or on Nature
  gains": candidates are raindrops (2.5–7.5 kHz bursts), the pollution
  whistle (1.1 kHz, Q 12), insects (4.3 kHz), wash plinks, the grow chime.
- **C3 grow sound:** a wet sprouting "opening" first — a squelch (noise with a
  band sweeping 220 → 1400 Hz) and a little rising plip — then the airy
  shimmer (a touch quieter).
- **C5 light:** a brief soft glow (particle 19, unlit, swells and fades
  ~1.3 s) at grow taps (green-gold), where seeds take (smaller), and where a
  drag begins (pale blue).
- **Howl** (user: "should sound more like a howl"): three narrow resonances
  (300 / 452 / 610 Hz, Q 26–34 — tonal, not hissy), whose pitch bends up as
  each gust rises and sags as it falls (0.82–1.22×), louder overall.

## 2026-10-08 — round 11 batch 2 (C2 smooth water)

The render-fields pass also writes a water corner height into the corners
texture (`.y`): the mean water level (ground + depth) of the wet columns
touching each grid corner, or −1 if none. Water boxes take their top corners
(and a flat face normal) from it, and their visible sides' top edges follow,
so rivers run down slopes as one sheet instead of stair-steps and pool edges
round off. Ripples, glints, foam and the rain rings under storms are
unchanged (fragment shader). Draw 2.9 ms at 1400×800 (+0.3 ms).

## 2026-10-08 — round 11 batch 3 (C1 drifts and burial; calm wind)

- **Drift layer** (see ARCHITECTURE): fractional loose-dust depth in a
  texture (no storage slot left), moved by a race-free gather kernel every
  other tick. Mapgen lays dunes over open dead ground (fbm, 0–2.6 deep),
  banks dust over scattered wrecks, and buries three **lost gardens** (grass
  and flowers, veg 1.8–3.0) under 1.6–2.7 cells of dust. Plants under > 0.5
  dust are dormant; uncovered, they are alive. Drifting dust streams off as
  dust particles; drift tops show no stains or plant cover.
- **Tuning by measurement.** First carry rate (0.06) — 24 gale strokes moved
  a garden's cover 2.23 → 1.91 (in a solid dune what leaves a cell is
  replaced from upwind). With carry 0.25 and 40 % of what is lifted going
  airborne: 8 strokes cleared it — but natural weather then erased half of
  all drifts in the first minute (opening dust storms + the first storm:
  15 k → 6 k cells·depth). Lift threshold 5 → 9 cells/s (a gust, not a
  breeze) and dust storms now drop dust in sheltered spots as they pass:
  ~70 % of drifts survive two minutes of weather (15 k → 10.5 k), and a
  garden takes 10–16 strokes to uncover (2.23 → 0.82 after 8, 0.02 after 16;
  veg 2.62 underneath).
- **Calm wind** (user): the map wind's magnitude scales 0.3 (calm) → 1 as
  storms/dust storms arrive (6 s smoothing); direction unchanged.
- Draw cost with drifts on screen: 4.6 ms at 1400×800 (+~1.5 ms: ~24 k drift
  boxes).

## 2026-10-08 — round 12 batch 1 (D4, D5, D6 audio)

- **D4 squeaks:** raindrops were 20 ms bursts through a narrow (Q 6)
  2.5–7.5 kHz band — squeaky ticks. Now soft broad patters (Q 0.8,
  0.9–2.3 kHz, 30 ms). Birdsong (sine chirps) now stops entirely while it
  rains instead of thinning to 20 %.
- **D5 grow:** the rising sine shimmer read as "charging". Now an unfurling
  rustle: noise whose band opens from 500 Hz to 2.6 kHz over half a second,
  swelling and fading (0.8 s), with six faint leafy crinkles.
- **D6:** the drag whoosh is 2.5× louder relative to everything else.
Unheard by an agent (`?audio=1` to compare).

## 2026-10-08 — round 12 batch 2 (D7 rounder edges)

Drift and water sheets: corner levels now taper toward nearby dry ground
(uncovered columns within 1.5 of the sheet's level count at their ground
height) instead of holding the sheet's height to the cell edge, and the
fragment shaders take a smooth depth — bilinear over the four nearest
column centres (`sheetDepth`) — and discard below a threshold (drift: 0.07
± a little per-sub-voxel raggedness; water: 0.02). The outline is an
isoline of a smooth field — rounded blobs and shorelines rather than
squares, at no measurable cost. Drift boxes no longer draw side faces (the
sheet tapers into the ground). Water alpha uses the smooth depth too.

## 2026-10-08 — round 12 batch 3 (D2 withered plants blow away)

Gusts (> 7 cells/s) over withered growth — browned vegetation (wilt.y > 0.5)
or a doomed tap-planting past its browning point — break it up: dry brown
flakes (leaf particles flagged by seed) blow off, browned vegetation loses
0.2 stage per break, and a doomed planting's remaining life runs out faster
(wilt.wgsl). Test: four gusts over withering plantings on the landfill — all
gone, 51 flakes in the air.

## 2026-10-08 — round 12 batch 4 (D3 cyclones)

DECISIONS round 12 (free with a cooldown; ruins and junk, not grown plants).
- **Spin-up:** Powers watches the drag's path over the last 2.5 s; ≥ 2 full
  turns the same way around a centre 2–14 cells away spawns a cyclone there
  (one at a time, 20 s cooldown, a distant thunder clap).
- **Entity:** `Weather.cyclone` — radius ~6, spins up in 1.5 s, lives 20 s,
  fades over the last 3 s; travels with the wind field's mean over its
  body (+ a little wander). Globals `cyclone`/`cycloneB` (608 bytes).
- **Wind:** `windAt` adds a Rankine-like vortex (peak ~26 cells/s at the
  eye wall, slight inflow) that also damps the ambient wind inside and
  drags along at the cyclone's velocity — so everything that reads wind
  responds: drifts erode (gust threshold 9), litter strips, petals and
  withered plants go, storms nearby get shoved.
- **Column:** particles emit dust/haze off the ground under it; loose
  particles inside rise in a spiral (updraft to ~14 cells).
- **Damage:** structure kernel adds damage to structural intervals inside
  it (scaled by weakness) — ruins and wrecks crack and topple; compacted
  waste on top breaks into litter (which it then strips). Plants: untouched.
- **Drop:** as it dies it lays down dust around its eye (drift).
- **Roar:** a low filtered-noise voice on the fx bus following its level ×
  nearness and pan.
Test: three scripted turns (r 6, 2 s) beside the factory ruins → cyclone at
the circle's centre; it crossed the ruins in 16 s; 66 cells collapsed (the
brick building in its path came down).

## 2026-10-08 — round 12 batch 5 (D1 title-screen plants)

The title screen sets `Globals.misc.w` (fineVeg): vegprep then draws plants
at diorama scale instead of the level's tufts/shrubs — four grass blades a
quarter-cell wide; flowers (55 % of meadow cells) with a stem, two leaves,
four petals and a yellow heart (render.wgsl: one colour per plant, the
centre box yellow); low moss cushions on bone. At full progress roots creep
down the cranium from the tree: five wavy strands hugging its surface around
the back and sides (skull frame), clear of the face.

## 2026-10-08 — cyclone funnel

User: "cyclones should make a visible narrow cone that meanders with wind".
- **Funnel particles** (kind 20, kinematic): born at the cyclone's centre,
  they ride a cone — radius 0.5 + 0.2·height, up to 20 cells — spinning
  with the cyclone's sense (faster near the tip) and climbing ~3 cells/s.
  The cone's centre at each height leans downwind (0.07·wind·h) and snakes
  with two slow sines, so the column sways as it travels. Darker grey-tan,
  thicker low down. ~2900 puffs; mean radius 2.1, max 5.4.
- The broad cloud that hid it (≈2300 airborne dust at ~16 cells out) came
  from the vortex's wide wind profile (r·e^(1−r): still ~14 cells/s at 2.5
  radii, lifting resting dust and drift streams in a ring). Profile is now
  r·e^((1−r²)/2) (≈11 at 2 r, ~1.5 at 3 r); updraft only in the core, a low
  debris skirt around it; loose dust in the vortex is drawn into the funnel
  (fades); drift streams don't emit inside its reach.

## 2026-10-08 — cyclone: spline funnel + caught debris

User: "a funnel controlled with a spline, and particles swirl about it and
gather in as a separate system that interacts with wind"; "particles get
caught in it and constrained into the cone with some chance of falling out".
- **Spine** (Weather, CPU): 6 nodes, 4.4 cells apart. Node 0 is the cyclone;
  each node above is pushed by the wind field at its height (relative to
  the cyclone's travel; more strongly higher up) and springs back over the
  node below (stiffer low down), damped, sideways offset capped. So the
  column bends, lags and meanders with the wind — painted strokes included.
  Uploaded as `Globals.spine` (x, y, z, funnel radius; 704 bytes);
  `spineAt(t)` = Catmull-Rom through it.
- **Funnel puffs** (kind 20): born wide at the base (2.5–6 funnel radii),
  creep in along the ground, then climb the spine (~5–7 s) while spiralling
  in to the funnel radius (narrow at the base, flaring up); outer puffs are
  smeared by the local crosswind. First radii (0.6 + 0.85·i) spread them
  too thin to read; 0.35 + 0.5·i and darker puffs make a clear cone.
- **Caught debris:** loose dust, grime, litter, leaves, petals, ash and haze
  within ~9 cells of the base (low down) are caught (15 %/tick × closeness),
  flagged, and held on the cone — climbing, spiralling in, carried along —
  with a 25 %/s chance of being flung out tangentially (and always at the
  top); when the cyclone dies, whatever it holds falls. Dust stripped from
  drifts inside the vortex now rises as particles again (to be caught). Test:
  ~180 caught at once (154 dust, 21 haze, 4 litter).

## 2026-10-08 — cyclone made of what it carries

User: only dust and debris in the funnel should make it visible; it should
pull in more as it goes and spit it out high up; particles evenly spread;
the dust fog (as under normal wind) only in a tighter cone; subtle is fine.
- The synthetic funnel puffs are gone. Under the cyclone, dusty or drifted
  ground is lifted as dust/haze (rate ∝ dustiness or drift depth), and
  loose debris within ~13 cells of the base is caught (25 %/tick ×
  closeness), so it fills up as it travels over dusty ground.
- On the cone: haze (the fog) settles to a tight core (0.35–0.65 funnel
  radii, drawn fainter); dust, litter, leaves, petals, ash ride the outer
  cone (1–1.6 radii) as crisp motes, a little larger and darker than loose.
  Caught from up to 4 radii out, gathering in at 1.8/s.
- Out at the top (rarely sooner, 3 %/s): flung wide (tangential 8 +
  outward 6, up 3 cells/s) to fall downwind.
- Tries along the way: dark soft motes read as a fat blob; radii scaled by
  the base radius caught debris ~37 radii out.
Typical load ~1900 caught (mostly dust, ~200 fog, dozens of litter).

## 2026-10-08 — levels and the sandbox (C6, B2)

- **Level registry** (`game/levels.ts`): the Dam Valley (built), the
  Highway, the City, the Port (coming), and the Sandbox. LevelScene builds
  whichever is chosen; goals, intro and progress are per level (the valley
  keeps its old save key). `?skipmenu=1&level=sandbox` for testing.
- **Title screen:** a small model per level stands around the diorama — a
  curved dam with water behind it, a rusted car, a field-hospital tent with
  a red stripe, a beached tanker, a wooden signpost. Clicking one selects it
  (a glow on the model; name, blurb, its own progress; Begin / Continue /
  Play / "coming"). First placed along the front edge they hid behind the
  title text; moved round the sides, 1.35× larger; car and tanker side-on.
- **Sandbox:** open rolling ground with a pond, a ruin, a trash heap, an oil
  pool, a poisoned patch with litter, dunes and a green patch. Editor panel:
  ✋ hands (normal gestures), raise (chosen material: soil, sand, stone,
  concrete, brick, rubble, trash, litter, ash, rust), dig, water, drain, oil,
  drift dust, poison, clean, plant, place storm / dust storm / cyclone; brush
  size and strength; pause, 1–8×. Natural weather is off. Edits go through
  a new edit system (see ARCHITECTURE). First rates were absurd (a 1.5 s
  raise built a 49-cell tower); ground edits are now ~2–3 cells/s at the
  centre at half strength, water ~0.6 depth/s.

## 2026-10-09 — cyclone motes

User: particles in the funnel smaller (not resized), slightly more
transparent, matching the dust colour. Caught debris is now drawn at its
loose size and colour, 80 % of its alpha (fog 60 %). Very subtle in a still;
it reads through the swirling motion.

## 2026-10-09 — dust the colour of its ground; real pull-in

User: are the column's particles real, pulled in from the ground? Their
colour should match what the cyclone picks up. (Yes, since a175238 — but
all dust was one generic tan, and a caught grain jumped onto the cone.)
- Dust and haze carry their source material in `Particle.m.w` bits 8..15
  (low byte keeps the kind's state; the update loop masks/preserves it):
  the ground's top material, or drift where dust lies deep. The draw shader
  (now with the material table bound) colours them from it, a touch lighter
  than the ground. Resting dust, wind-lifted dust and haze everywhere follow
  the ground they came from; a cyclone over drifts is pale sand, over ash
  reddish-grey, over soil brown.
- Capture keeps the grain's real angle, distance (cells) and height (the
  spine is ~22 cells tall): it is dragged in along the ground, then climbs
  as it nears the cone — no jump. The dead synthetic funnel kind is gone.

## 2026-10-09 — the squeak (water)

User: the squeak comes with water — flooding some areas in the sandbox, and
worse in storms. Cause: the wash sound (grime into water) — falling sine
plinks at 0.9–1.6 kHz — fired for *resting* grime whenever water reached it,
so floods and rain films washed hundreds at once. Now only grime blown into
water counts (splash, sound, Nature); grime under rising water dissolves
silently (test: 3 s of flooding a grime patch → 0 counted). And the sound
is a soft low watery plop (filtered noise, 260–440 Hz), at most three per
readback. Debug name: "wash plops".

## 2026-10-09 — session 3: dust sinks under water (F1)

User (round 13): dust can sit on top of water; water and oil should lie
above the other layers, which sink. Cause: liquids measured their level
from the column's solid top (`sfZ`) and ignored the drift layer, so a drift
under a pond was drawn up through the water. Now drift is part of the bed
for both liquids: water/oil flux heads, the water/oil boxes (renderprep),
inner water side-face culling, water corner heights (and their taper to the
shore), and the height particles rest/float at all use `sfZ + driftAt`.
Dust that blows into a pond displaces it (the level rises) and lies on the
bottom. Still water no longer dissolves it (it used to lose 3 % per pass
under any water); moving water scours it in proportion to the net flow
(`netFlow`, max 5 %/pass), so rivers still carry drifts off.
Check (sandbox pond, 0.8 s dust brush): a submerged mound under clear
water; a 4 s pour makes an island and pushes the pond outward.

## 2026-10-09 — softer dust (F8)

User: dust particles would look better more transparent or rounded. Dust
and grime were opaque screen-aligned squares (alpha 0.7 / 0.95), which at
close zoom read as gravel — the grime especially, as black pixels. Both are
now round motes (fragment: alpha × smoothstep(1, 0.3, r), discard the
corners), slightly larger to keep the same visual weight: dust alpha 0.42
(settled 0.2), grime 0.78. Litter, leaves, petals and seeds keep the crisp
sub-voxel squares (they are things, not powder).

## 2026-10-09 — longer, warmer dawn and dusk (F9)

User: the day/night transition is still jarring and should be interpolated
for longer; dawn and dusk redder / more golden. On the default 480 s day the
sun's elevation changes ~0.014 rad/s near the horizon, so the old fade bands
(sun −0.04…0.22 rad, night −0.22…0.08) lasted ~20 s each. Now the sun fades
over −0.12…0.45 (~40 s), night over −0.62…0.15 (~55 s) and the golden hour
over 0…0.75. The sun's colour goes noon → gold (1, 0.66, 0.32) through the
low hours → red (1, 0.36, 0.18) as it touches the horizon; the sky ambient
and the background go rosy gold, deepening to red-violet. Stills at
tod 0.25/0.29/0.70/0.74/0.78 checked.

## 2026-10-09 — layer brushes: pour, build, bedrock, dig (F2, F3, F4)

User: sandbox drawing is too noisy (weird landscapes); treat drawing as
layers with a soft edge — a press raises the land a unit, each click the
centre by as much, and painting over the same place adds nothing until the
next press. Brushes should drop material from above and let it settle, so
you can make strata of stone, dust and dirt; another brush raises bedrock
from below.
Cause of the noise: the old brush deposited a whole cell per column at
random (chance ∝ falloff) every tick while held.
- Each column remembers what the current press gave it (`editState.x`, reset
  by a press-start flag on the event), so a press lays at most `layers`
  cells (smoothstep(1, 0.5, d): full over the inner half, soft at the rim);
  the fraction at the rim accumulates (`.y`), so repeated clicks build a
  smooth mound — deterministic rings, no per-cell dice.
- Tools: **pour** (dirt, sand, gravel, dust, ash, litter) drops grains from
  12 cells up; the cells land 0.8 s later at 4 cells/s and the material
  system's repose rules settle them (dust goes into the drift layer).
  **Build** (stone, concrete, brick, asphalt, rust, trash) lays at once.
  **Bedrock** grows stone at the bottom at 3 cells/s, lifting everything on
  it. **Dig** takes a layer off. Liquids/fields keep per-tick strength.
- The brush state is a texture (the edit kernel already uses 8 storage
  buffers incl. the chunk table); the particle emit pass reads it and spawns
  K_GRAIN particles only while material that will land after a full fall
  remains, so the falling cloud and the landing agree.
- The edit pass now runs every tick in the sandbox (pours land after the
  press): 0.076 ms GPU at 256² (Xe-LPG).
- Sandbox base map: sand/soil patches 3× larger (fbm /55 instead of /18).
Measured (row of 17 columns through the brush, radius 6): one dirt tap
+1 over the middle 6; four taps a +4 mound with sloped sides (repose); a
1.5 s drag scrubbing one spot with build = exactly +1; bedrock ×2 lifts
the mound by 2. 840 grains in flight 0.4 s into a radius-7 two-layer pour.

## 2026-10-09 — map building: save/load, undo, brush ring (F6, E8)

User: wants time to just build cool maps and play with the physics. Making
that real needs keeping what you build and taking back mistakes.
- **Save/load**: the editor's map row — save (IndexedDB, named), load…
  (list), ⤓ download / ⤒ open a `.reclaimed` file, new (fresh sandbox).
  The file is gzip of a JSON header + the raw arrays; a loaded map plays
  as-is (30-tick prime instead of the 30 s settling warmup). A file format
  also means maps the user builds can become levels (B7).
- **Undo** (↶ or Ctrl+Z): a GPU snapshot of the editable state at the start
  of every brush press, ring of 8 (~4.5 MB each at 256²); undo copies it
  back and drops pours still in flight.
- **Brush ring**: a dashed SVG outline of the brush radius, projected onto
  the terrain under the cursor, for every brush tool.
Measured: build 3 layers + pour, undo → the row of heights returns exactly
to the post-build state; capture+encode+decode 71 ms, 242 KB, 0 columns and
0 field values differ after the round trip; loading into a new scene shows
the same heights.

## 2026-10-09 — model atlas: placeable voxel models (F5)

User: did you build an atlas of layered models that can be instanced? (No —
everything was authored procedurally into the grid.) Wants thumbnails of
ruins, tankers and ruined cars to place.
- `world/models.ts`: ruined car, burnt-out car, bus, tanker truck, beached
  tanker ship (48×12, bridge and funnel), ruined house, broken wall,
  field-hospital tent (ridged canvas, red cross), pylon, oil tank, barrels,
  seawall. Two new materials: steel (faded paint) and canvas.
- They become real matter (column intervals): drifts bury them, cyclones
  batter them, lightning breaks them. The sandbox "place" tool (🚗) has a
  thumbnail palette, E rotates, "bury" sinks them; undo works. Map
  generators get the same models through `stampGrid` (for C7/C9/C8).
- Two things the structure rule taught us: placed runs must start at full
  support (at 0 every roof collapsed on the first tick, before support could
  spread), and models must be seated, not perched — the tanker rested on the
  highest sand under its footprint (z 13 over z 11) and its hull, hanging
  over the dips, correctly collapsed into a rubble heap. Now: base = mean
  ground height, dips filled with the local ground material. The pylon's
  legs and the tent's roof were reshaped so their parts touch face to face
  (support only flows between 4-neighbours overlapping in z).
Measured: all twelve placed side by side, 8 s later 16 cells had collapsed
in total (the ruined house's broken corner); the rest stand.

## 2026-10-09 — title screen: life at the skull's scale; buried level models (F10, F11)

User: the tree and plants on the title screen don't make sense with the size
of the bones; it's a human skull — grass blades (sub-voxel) reach about half
way up it, flowers about the size of its eye sockets. And the level models
aren't recognisable: bury them in dust, one uncovered at the start, the rest
uncovered by finishing the level before — or by the player blowing the dust
off with the wind (to encourage exploring).
- F10 (vegprep fine mode): grass blades 3–8 cells tall, a quarter cell
  wide, each three stacked boxes stepping over so the blade curves; flowers
  (3 % of grassy columns) on 5–9-cell stems with two long leaves and a head
  five cells across (eight petals round a yellow heart), one colour per
  flower via the instance species bits. Tap plantings on the diorama scale
  ×5 (grass/flowers) and ×2.5 (shrub/tree). The final-stage tree is now a
  sapling: a one-cell stem out of the cranium, four twigs and flattened
  leaf clusters an eye socket across.
- F11: the diorama shows the atlas models (ruined car, hospital tent, a
  half-scale tanker via `halfScale`); the dam stays; the sandbox's sign is
  replaced by a small "sandbox" link. A locked model lies under drift dust
  that follows its shape about a cell deep and falls away at 0.72 (under
  the dust's repose, so it holds). The drift system now runs on the title
  screen, with diorama-scale lift/carry (a cell there is ~1 cm: lift 4
  instead of 9 cells/s, carry ×4.8). The menu reads the drift back once a
  second; when the mean dust over a model's footprint drops under 0.35 it
  is uncovered for good (`saveUncovered`) and its level selected. Clicking a
  buried one says what lies there and how to free it. `?unlock=all` shows
  everything; reset progress re-buries.
Measured: idle 40 s on the windiest (barren) title: dust over the car and
tent unchanged (1.75 / 2.84), tanker −0.1. Seventy fast strokes over the
car: 1.75 → 0.39 in 3 s → uncovered (saved, selected) at ~4 s.

## 2026-10-09 — fireflies in small patches (G1)

User: fireflies should be less dense and only pop up in small patches.
Emission over meadow is now gated by a slowly wandering patch mask
(value noise at 9-cell scale, smoothstep 0.84–0.92: a few percent of the
meadow, a few cells across each). Measured with the whole sandbox set to
meadow at night (worst case): 11 748 fireflies before, 885 with the
0.8–0.9 mask (then tightened further), in visible clusters.

## 2026-10-09 — Sandbox button on the title screen (G2)

User: wants the sandbox visible from the start to test the physics. It was
a small footnote link under the instructions; now a "Sandbox" button sits
beside Begin/Continue, whatever level is selected or buried.

## 2026-10-09 — no cap on cyclones (G3)

User: remove the cap on summoning tornadoes — it is very fun to do. The cap
was a 20 s cooldown plus one cyclone at a time (one slot in Globals). Now:
no cooldown (a 1 s guard so one swirl can't spawn two), and up to four
cyclones at once (a fifth replaces the oldest). Globals carries
`cyclones: array<CycloneU, 4>` (704 → 1088 bytes); wind, drift drop-off,
structure battering (`cycloneAt`), lofting and the debris capture all loop
over them; a caught grain remembers which funnel holds it (m.z bits 4..5).
The roar follows the loudest one.
Measured: five spawned in the sandbox → four alive, each holding its own
debris (133 / 1075 / 198 / 262 caught particles), no GPU errors.

## 2026-10-09 — title screen: taps grow a sapling (G4)

User: on the title screen, tapping several times still grows the normal
tree, which looks silly. A third tap on the diorama now grows a sapling at
the skull's scale — a quarter-cell stem ~7 cells tall with three small leaf
clusters — instead of the level's trunk and 3×3 crown; it browns and
shrinks the same way on bad ground. (Instance count per planting: +4 on
the diorama, +2 in levels.)

## 2026-10-09 — F7 step A: the smash tool

The physics playground (G5) needs a way to break things exactly where you
mean to. 💥 Smash (sandbox): a tap or drag picks the exact point under the
cursor (pick buffer: column + height) and removes structural solids
(solid, strength < 1) inside a sphere of the brush radius there, leaving
terrain alone, with a spray of chips; each press is an undo step. The edit
kernel splits intervals around the hole (op 12, height in the event's w).
Check: a placed pylon with two legs cut at the foot — the cut columns lose
exactly the sphere; the pylon still stands (the span rule lets the other
legs carry it through the braces: 11 cells collapsed). Making it topple is
F7's torque/rigid-body work, next.

## 2026-10-09 — F7 step B: pieces break free, tumble and land as voxels

The design the user agreed (round 13/14): Noita-style rigid chunks; break
where a cheap torque estimate beats strength × thickness (a distance field
in place of a medial axis); bodies back to voxels at rest; terrain keeps
its column rule. In the sandbox (the physics playground, G5):
- `fracture.ts`: islands fall; tipping (centre of mass outside the
  footprint hull) drops the whole piece; snapping crumbles the cross-section
  where moment > 40 · strength · thickness³. First version routed every
  voxel's load to the nearest ground contact, which made intact models
  "snap" (the pylon's leg joint, the tent's eaves, the tanker's keel took
  the whole hull's load sideways). Fixed by counting voxels on an unbroken
  stack down to the ground as anchors: walls carry their load straight down,
  only overhangs bend. Check: every atlas model placed intact → nothing
  breaks except the ruined house's genuinely loose 8-voxel fragment.
- `bodies.ts`: impulse-based rigid bodies on exposed voxel corners against
  the voxel world (CPU mirror of the layers), restitution 0.15, friction
  0.6, 22 cells/s² gravity; when slow, a nudge toward the nearest face-down
  orientation; at rest, inverse sampling back into voxels.
- `integrity.ts`: dirty boxes (each looked at in two passes, since an edit
  reaches the GPU a tick after it's queued), passes every 0.35 s, chips and
  a chip sound where things crumble or hit hard.
- Rendering: rotated cubes lit like the world (no new storage slot: the
  body buffer binds where box instances do).
Measured: a pylon with two legs cut at the foot tips over its remaining
legs as one body within ~2 s and lands lying on the sand as voxels;
analysis passes 1–4 ms.

## 2026-10-09 — fix: sandbox clicks swallowed; place at the mouse pick

User: the sandbox is broken, it doesn't let me place objects; it should
spawn the voxels at the height of the mouse pick.
- Cause: the brush ring (F6) is a full-screen SVG in #ui, and `#ui > *`
  gives every direct child pointer events — so once the ring first showed,
  it swallowed every later click for every brush tool (only the first press
  worked). My scripted tests called the functions directly and missed it;
  this time it was reproduced with real clicks (one of four landed). Now the
  ring sets pointer-events: none inline; four clicks → four placements.
- The place tool now picks: the model goes on the clicked column at the
  picked surface height (a roof, a wreck, the ground), minus "bury".

## 2026-10-09 — Break tool and the physics garden (F7, G5)

User: wants a simple break tool to punch holes and make things collapse,
and something with an overhang to break off, or a tall thing with a base to
destroy. 💥 is now **Break**: it punches a hole in anything (structures and
terrain; only the bottom two cells of bedrock stay). The sandbox map has a
physics garden, bottom left: a 3×3×24 concrete tower, a 4×4×18 brick
chimney, a pillar with a 6-cell diving-board slab, and a 16-cell concrete
bridge on two brick pillars, each on a levelled stone plinth.
Measured: analysing the untouched garden → nothing breaks. Breaking the
tower's foot → it topples and lands in two pieces; the slab's root → the
board snaps and falls; a bridge pillar → the deck tips and comes to rest
leaning on the other pillar (7 bodies, all settled within ~7 s).

## 2026-10-09 — oil burns in the rain (H5)

User: oil should burn even in the rain, though trees go out. Rain and damp
ground no longer damp a fire where oil is burning (scaled by the slick's
depth), and rain doesn't stop flames spreading across oil; the water-under-
oil rule (a slick on water burns) was already there.
Measured (sandbox pond, a thick slick beside a grove, both struck): under a
storm the oil still burns at 10 s (fire 0.15) while the grove's fire is out
by 4 s (stage 4.0 → 3.6); without rain the grove burns down (→ 0.4).
Noticed: a spill on sand spreads into a film and soaks in within ~2 s
(SOAK, by design — it stains the ground); slicks last on water, concrete
and asphalt. Flagged for the user rather than changed.
