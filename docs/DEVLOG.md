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

## 2026-10-09 — steadier storm outlines (H6)

User: storms' outlines still change erratically, too quickly; they should
be more stable in shadow. Cause: the outline is stretched along the storm's
travel direction, taken from its instantaneous velocity — which swings every
time the wind field (or a player stroke) steers it, spinning the whole
shape. The lobes themselves were already slow. Now each storm keeps a
heading smoothed over ~10 s (CPU), sent in stormsC.z in place of the third
lobe phase (that lobe now derives its phase from the first).
Measured (16 rays round one storm, sampled every 0.5 s for 12 s while
random strong gusts push it): mean outline change 22 % of the radius per
half second before → 3.8 % after; worst 54 % → 8.6 %.

## 2026-10-09 — title screen: low gusts now and then (H1)

User: the title should have random wind in low gusts periodically so the
grass waves or dust blows. Every 7–13 s (unless the player is dragging) a
slow, slightly curved stroke crosses the diorama roughly with the prevailing
wind — painted into the same wind field the player's drags use, so the
grass sways, litter and specks lift — but gentle: peak painted wind
4.2 cells/s. Measured over 60 s on the barren title: the dust over the
three buried models is unchanged (1.17 / 1.69 / 1.76), so gusts don't
uncover them for the player.

## 2026-10-09 — green binds the dust it grows through (H8)

User: when green grows over loose things like dust it should turn them into
soil, or at least stop them being swept out from under the green. The drift
pass now reads the plants: where growth ≥ ~1.5 (established) dust is not
lifted, carried or slumped, and it turns to soil at 0.03 cells/s (the drift
thins; the plants grow on in the ground below).
Measured (sandbox, 0.8 cells of dust over the green patch and over bare
sand, then twelve strong strokes across both): bare 0.86 → 0 (stripped);
green 0.8 → 0.41 during the wind (all of it binding, none blown) → 0.04
twenty seconds later.

## 2026-10-09 — airborne dust comes back down (H2)

User: do dust particles ever settle back down and pile up like the other
loose materials? They didn't: of the dust the wind lifts off a drift, 40 %
"went airborne" (shown as particles) and simply left the world, so any
sustained wind ate drifts away. Now the airborne share lands HOP = 5 cells
downwind of where it rose: each cell gathers from the senders around the
spot upwind of it whose own wind lands their dust on it (a 3×3 search, so
senders whose wind differs a little from the receiver's aren't missed).
Measured (a 65-cell dust pile in the sandbox, eight strong strokes across
it): before, 65 → 0.2 inside the region — it vanished; now 65 → 65 with
its centre of mass carried 35 cells downwind. Drift pass 0.10 → 0.11 ms.

## 2026-10-09 — water washes trash heaps; concrete needs cracking first (H4)

User: water should loosen loose materials and carry them away — wash away
the packed trash heaps or dirt; blow away dust; asphalt and concrete need
lightning or tornadoes to crack them and break them down first.
- Already so: moving water erodes loose ground (soil, sand, rubble, ash,
  litter) and carries it downstream; dust is the wind's.
- New: moving water over a trash heap tears its top cell off as loose
  litter (chance ∝ net flow above 0.02), which water and wind then carry.
  (Round 5's "trash only yields to fire" now also yields to water.)
- Changed: violent flow no longer damages intact concrete/asphalt/brick —
  only cracked solids wear in fast water; lightning, cyclones and heat do
  the cracking.
Measured: 10 s of heavy water poured on the sandbox heap → 73 of its 156
trash cells became litter; conversion stops when the water does.

## 2026-10-09 — tall buildings to place (H7)

User: larger structures like tall buildings to place. New atlas models: a
ruined apartment block (12×9×30: a floor every 4 cells, window bays, a
broken crown), an office tower (8×8×40, lift core, steel-and-concrete
skin), a water tower (a rust tank on four braced steel legs) and a brick
smokestack (36 tall, tapering hollow ring). Sandbox chunks now get 14 slots
per column (floors stack runs). Every model now drops voxels not connected
to its base when built (ruined tops left loose fragments that fell the
moment they were placed — the ruined house's too).
Check: all thirteen-plus models placed intact → nothing breaks free (one
overstrained voxel on the apartment block's broken crown crumbles). A
radius-3 notch in the smokestack's foot doesn't topple it — its weight is
still over the rest of the ring; a wider break does.

## 2026-10-09 — the loose layer: dust, sand, ash, dirt (H3, part a)

User: smooth/stepped surfaces make sense for stone, but loose surfaces
(dirt, ash, sand) should behave like dust — with a steeper angle of repose
and needing higher winds to be picked up (if at all). Answer to the design
question: a loose **top layer** per column; the ground below stays cells.
The drift layer now carries its material (drift .z; 0 = dust):
| material | wind to lift (cells/s) | repose | airborne | water |
|---|---|---|---|---|
| dust | 9 | 0.8 | 0.4 | 1.0 |
| ash | 10 | 0.9 | 0.5 | 1.0 |
| sand | 14 | 1.0 | 0.15 | 1.0 |
| dirt | never | 1.4 | — | 0.8 |
| gravel | never | 1.7 | — | 0.25 |
Moving water now carries the layer downstream (it used to dissolve dust
that sat under flowing water). A cell keeps its material unless almost all
of it left and something else arrived (largest inflow wins). The layer is
drawn in its material's colour; plants are buried under dust/sand/ash but
grow in a loose layer of dirt; particles take the layer's colour. Saved
maps carry the material (older files load as dust).
Measured (sandbox, 1-cell patches of each, 12×10): repeated single gusts
(~12 cells/s) → dust 116.6 → 10.1, sand 120 → 120, dirt unmoved; a
stacked gale moves sand too (120 → 88.7), dirt still unmoved.
Next: maps generate their loose surfaces as this layer (b), and a different
material arriving compacts the old one into strata (c).

## 2026-10-09 — loose surfaces in the sandbox; pours make strata (H3, parts b, c)

- The sandbox's ground is generated from real-valued heights: whole cells
  up to ~half a cell under the surface, the rest a loose layer of sand or
  dirt (the dunes are dust). The surface keeps its true height — no more
  stepped-and-smoothed loose ground. Things built on the ground (ruin,
  heap, plinths) have no layer over them; a placed model takes in the layer
  under its footprint.
- Pouring a loose material (dirt, sand, gravel, ash, dust) goes into the
  loose layer. A different material arriving packs the old layer into
  ground cells first; a layer deeper than 1.75 packs all but its top ~cell
  down (deep dust becomes "silt", packed dust — new material). So pours
  build strata. (The edit pass does this; it runs every tick in the sandbox.)
- Plants are buried only under blown dust or ash; on a sand or dirt layer
  they stand on top and the layer shows their ground cover and stains.
Measured (one column, radius-5 pours): start stone 0–10, sand 10–13, loose
sand 0.80 → sand ×3: sand to 16, loose 0.81 → dirt ×2: sand packed to 17,
dirt 17–18, loose dirt 0.87 → dust ×3: dirt packed to 19, silt 19–20,
loose dust (slumped thin at the centre).
Cost: the sheet now covers the whole sandbox — draw 2.3 → 4.2 ms at
1400×800 (Xe-LPG), still 120 fps; worth optimising (ties to E5). The valley
keeps its whole-cell ground for now (it's tuned; to be moved over later).

## 2026-10-09 — blown dust is carried by its particles and settles as a film

User: do the particles settle and become layers now? I'm having trouble
seeing that. They didn't, in a way anyone could see: the dust particles
were only a picture (they landed, rested and faded), the airborne share
"hopped" 5 cells inside the field, and dust arriving on a sand or dirt
column joined that layer — it turned into sand.
- The particles carry it now: the drift pass reports what went airborne
  (drift .w); the particle emit pass spawns dust grains, each holding a
  share (m.w bits 16..31, 1e-5 cells), and a grain that lands (or dies, or
  is spat out of a cyclone) adds its share to a second half of the exchange
  buffer, which the drift pass folds back in. What you see blowing is what
  piles up.
- Dust settles as a **film** on top of any loose layer (drift .y): the wind
  takes the film first, at dust's threshold; a film over 0.5 buries plants;
  it's drawn as a greyer, darker silt over the sand or dirt beneath; packing
  only packs the layer below it.
Measured (sandbox, a 12×12 dust film 1.2 deep on sand, five strong strokes):
the patch 170.9 → 123.4; dust in the box 647.5 before, 613.4 on the ground
+ 31.4 in the air mid-wind, 645.0 settled (−0.4 %); a visible film trail
downwind with grains settling at its tip.

## 2026-10-09 — landed dust fades into the layer (I2)

User: the particles settle and persist; they should fade and the dust
layer beneath form or grow. A dust grain coming down (with or without a
load) now puts its dust into the layer and fades out within 1.2–1.8 s,
instead of lying 20–45 s. (Dust born resting on dry ground as surface
debris is unchanged until the wind lifts it.)

## 2026-10-09 — soft ground all loose, smooth and layered; water carries it (I1, I3)

User: eight layers of dust made "a bunch of dirt underneath" with a thin
dust layer on top (the packing into silt cells); soft materials should be
smooth with no step drops — only solids stepped; dust and dirt should wash
into water, travel and settle under it or leave the map.
- Loose ground is a stack of up to four layers per column (drift: total,
  top depth, top material, airborne; strata texture: three layers beneath,
  packed material·1000 + depth). Wind, water and slumping take from the top
  layer; a different material arriving starts a new layer on top; a spent
  top uncovers the one beneath. No more packing into cells. Pours make
  strata; dig takes loose ground first; building on loose ground packs it
  under the new block (or it would ride up onto the roof).
- When the sandbox loads, the soft cells (soil, sand, ash, silt) on every
  column become that stack; only solid ground stays as cells. Plants, wilt,
  ecology and oil soaking read the loose layer's material (groundMatAt);
  shadows and slope measurement include its depth. The sheet's corners never
  sit below the rock top of a covered column (soft ground drapes over a step
  instead of the rock poking through) and the shadow pass gives loose
  columns the same soft margin as soft cells (otherwise the downhill half of
  every cell shadowed itself — a fish-scale pattern).
- Water carries the top layer when the net flow beats a per-material
  threshold (dust/ash 0.03, sand 0.08, dirt 0.12, gravel 0.3), settling
  where it slows; at the map edge it's gone.
- The valley keeps its cell ground for now: converted, its terraced rock
  showed through as contour stripes and its river carved a canyon during
  warmup — it needs reshaped rock and river erosion matched to the old
  rates first.
Measured (sandbox): 8 layers of dust → loose dust 7.03 over the sand 3.80
(no silt); sand ×2, dirt ×2, dust ×2 on one column → strata sand 4.23 /
dirt 2.00 / dust 1.52; 8 s of water poured above 2 layers of dust on the
pond's slope → dust on land 56.95 → 50.0, under the pond 0.71 → 3.26.

## 2026-10-09 — steadier loose ground in wind (J1)

User: loose layers "fight" into a checkered pattern, especially in wind.
Two sources: (1) a column could hand half its top to its neighbours in one
pass, all computed from the same snapshot, so neighbours over-corrected
each other; (2) any trace of a different material arriving started a new
top layer, which the wind then stripped — the colour flickered cell by cell.
- Wind takes at most a quarter of the top per pass.
- Where the wind is moving material, level differences ease out between
  neighbours (WIND_SMOOTH 0.15); that easing just blends into the receiving
  column's top layer, whatever it is. Still ground keeps its shape.
- A different material starts a new layer only from 0.01 cells per pass;
  less blends in. A thin top layer is drawn blended with the layer beneath
  (the draw shader now reads the strata texture).
Measured (sandbox dunes, sustained gale): columns whose top material differs
from both side neighbours 6.0 % → 1.2 % (calm 0.4 %); the surface roughness
number under the gale stays ~0.12 (it's mostly real ripples — a first try
that "fixed" it to 0.07 only did so by starving the wind with flicker). The
before/after images: the speckled dust/sand patch is now one coherent patch.

## 2026-10-09 — K1: bodies sleep in their own frame, projected into the grid

Agreed with the user (round 17): rigid bodies keep their own rotated frame;
the transition back to voxels was too finicky.
- A body that comes to rest stays a body, as it lies (no snapping to the
  grid, no nudge toward face-down), asleep: no physics, only drawn.
- Sleeping bodies are rasterised into the terrain grid: per column the top
  and bottom of any body voxel over it (each voxel's rotated-cube box), in
  the bodyProj texture (for K2: loose ground, water) and on the CPU, where
  moving bodies now collide with sleeping ones (they can pile up).
- Bodies also lie on the loose ground now (CPU read-back of its depth with
  the layers), settling 0.35 cells into it — not through it to the rock.
- Budget (user: a cap, oldest crumbles): over 64 sleeping bodies or 16k
  voxels the oldest small ones (< 200 voxels; else the oldest) crumble into
  loose ground where they lie — concrete, brick, stone, metal → gravel;
  wood, canvas → ash; bone → dust — through a CPU-written looseAdd buffer
  the drift pass folds in.
Measured: the garden tower with its foot broken topples and falls asleep
skewed (quaternion −0.69, −0.05, 0.10, 0.71), 189 voxels, projected over
92–104 columns (top 16); crumbling it adds 178 cells of loose gravel where
it lay.

## 2026-10-09 — breaking bodies in their own frame (K1b)

User: still be able to break the voxels of a body in its skewed frame.
Bodies are now pickable (the body fragment shader writes the column under
it, its height and a 0x8000 "body" flag), and Break on a body removes the
body voxels within the brush radius — in world space, so in the body's own
skewed frame — then splits what's left into its face-connected pieces on the
body's lattice; each piece becomes a new body in the parent's frame (awake:
it falls or settles again), pieces of three voxels or fewer crumble into
loose ground. Body creation is generalised to voxels in any frame
(`Bodies.build`).
Measured: the toppled garden tower (189 voxels, asleep) — a pick at its
centre reports a body; breaking its middle (radius 2.2) leaves two 80-voxel
pieces, which wake, shift and fall asleep again.

## 2026-10-09 — K2: the ground knows where bodies lie; bodies wake when disturbed

- The loose ground's level is the higher of its surface and a sleeping
  body's top (bodyProj): drifts bank against a fallen piece and slide off
  its top; loose ground under a body stays put; pour or blow enough and the
  level rises past the top — it's buried. Water and dust grains treat a body
  as ground too.
- Waking (user: when disturbed): a falling body landing hard (> 3 cells/s)
  on a sleeping one; nothing holding it up any more (each integrity pass
  checks a sleeping body's lowest points against the world, the loose
  surface and other bodies, ignoring its own projection; ~1 s when all are
  asleep); a cyclone over it — it's dragged round and up, the small pieces
  carried far, big wrecks only shifted.
Measured (sandbox, the garden tower toppled, 189 voxels, asleep):
- four 4-layer dust pours over it: 0 → 84 of its 107 columns covered, it
  stays asleep (the screenshot: a dust mound with both ends showing);
- a pit under its middle: it stays (both ends still hold it); the loose
  ground removed under its whole footprint: it wakes and drops 2 cells in 3 s;
- a cyclone on it: it wakes and is shifted 3.4 cells.

## 2026-10-10 — lightning blasts a crater in whatever it strikes (L1)

User: lightning should destroy even stone and whatever it strikes. A strike
now also sends the edit pass's break op: a sphere (radius 2.6) at the strike
point removes everything in it — stone and bedrock included (only the
bottom two cells stay) — and the break op now also takes the loose ground
inside its sphere (so Break digs into sand too). In the sandbox lightning
seeks the highest visible point (loose ground and fallen bodies count) and
breaks any fallen body it hits. (Its structural damage is as before: the
struck structure cracks and may collapse to rubble.)
Measured (sandbox): a strike on flat sand: loose 3.80 → 1.20; on a 4-layer
bedrock mound: stone top 14 → 11 and loose 3.80 → 1.70; struck beside the
garden tower it seeks the tower's top: concrete 11–35 → rubble 11–24 (the
cracked column collapses), chips flying.

## 2026-10-10 — heavier, softer rigid bodies; bigger crumbs (M1)

User: bodies should fall more slowly with much more inertia (feel bigger);
better to sink into each other slightly than spring back; the crumbling
threshold can be lower.
- Gravity 22 → 10 cells/s², air drag 0.35/s, rotational inertia ×3, no
  bounce; soft contacts: each iteration takes away 40 % of the approach
  speed, overlap pushed out 8 % per iteration past a 0.15-cell slop.
- Sleep only when really still (< 0.15 cells/s, < 0.06 rad/s for 1.5 s;
  the old 0.5/0.5/0.5 s froze slow tips half-way — a tower once fell asleep
  upright mid-tip); give up after 24 s.
- Pieces of up to 12 voxels (was 3) crumble into loose ground when broken.
Measured: the garden tower with one edge of its foot broken teeters ~7 s,
goes over in ~7 s more and comes to rest lying on its side at 21.6 s (it
used to slam down in ~2 s). A tower broken evenly at its foot stands.

## 2026-10-10 — every click is a breath of wind (M2)

User: clicking should always make a little ripple of wind pushing out from
the cursor (you are the wind/nature). A tap now also sends a one-tick
Ripple event (kind 6); the wind field pass adds an outward push in a ring
around it (radius 6, zero at the centre, strongest 2–3 cells out) into the
painted wind, which relaxes away like any stroke.
Measured (sandbox, one tap): painted wind 2.0–3.3 cells/s pointing outward
at 3–4 cells from the click on every side, nothing at 8 cells — a breath
(grass sways, light specks stir), well below dust's lifting threshold.

## 2026-10-10 — lightning listens closely, but metal draws it (M3)

User: a smaller radius around the click, but biased toward metal things
within ~40 m — so it mostly listens closely and in some places goes
elsewhere; and it should chain from the top thing it hits to near the
cursor (looks cool, sets fires).
- Target: the highest point within 4 cells of the tap; a metal top (rust,
  steel) within 40 cells scores a bonus of 6 − 0.15·distance, so tall metal
  nearby wins and far or low metal doesn't.
- Drawn off to something else (> 2.5 cells away), it chains back: a jagged
  arc from the strike to the tap (HUD), and a small strike at the tap that
  sets fuel there alight (no crater).
Measured (sandbox, a pylon placed): a tap 15 cells from the pylon strikes
the pylon's top (z 32) and arcs back; a tap 60 cells away strikes within 4
cells of the click.

## 2026-10-10 — night callers and frogs (M4, M5)

User: owls and crickets instead of birds at night; frogs near greened water.
- Birdsong fades out with the night (fully silent past half-dark; it used
  to keep a tenth of its daytime rate). After dark, crickets (bursts of 3–5
  short 4.6–5 kHz chirps) where there's life in view, and now and then an
  owl ("hoo … hoo-hoo", ~380 Hz, gliding down) where there are woods.
- Frogs: the level's audio sampling counts water with green (growth ≥ 1.5)
  two cells around it near the view centre; frogs croak (a low buzzy
  sawtooth through a low-pass, pulsing ~35 Hz, two pulses) by day, more at
  dusk/night and in rain.
Check (headless, audio started, sandbox pond greened, midnight, 20 s): the
debug log shows frogs ×5 and crickets, no birdsong. Unheard by an agent —
listed for the user.

## 2026-10-10 — metal rings by its size, in tune (M6)

User: the sound of clicking metal drums should depend on their volume —
not real computation, but something almost musical. A tap on rust or steel
(steel was silent before) asks the level how much metal is connected to the
tapped voxel (a flood fill on a read-back of the layers, capped at 3000);
the clang's fundamental is 330 / ∛size Hz (≈330 for a panel, ≈110 for a
barrel cluster, ≈45 for a tank, 30 floor), snapped to A major pentatonic,
with a longer ring and a deeper cavity echo for bigger bodies — so a row of
drums and tanks plays notes that sit together.
Check (sandbox): a placed oil tank → 337 voxels (≈47 Hz → A1 region), the
tanker ship → the 3000 cap (30 Hz floor). Unheard by an agent — listed for
the user.

## 2026-10-10 — bodies shatter on impact, with a speed limit (O1, O2)

User: speed much better, but crumble much more easily and break up more;
impacts should make dust; damp the collision response further; a max speed
about 50 % above today's topple.
- Measured first (garden tower, 216 voxels, foot cut on one side): the topple
  peaks at 2.6 cells/s at the centre, 0.36 rad/s, 6.7 cells/s at the tip.
  Contact impacts are only 1–3.5 cells/s, so the old chip threshold
  (10 cells/s) never fired: no chips or dust at all.
- Limits (`game/bodies.ts`): centre ≤ 4 cells/s, spin ≤ 0.55 rad/s, any
  point ≤ 10 cells/s, push out of an overlap ≤ 1.5 cells/s (the uncapped
  push could teleport a deep overlap ~0.9 cells in one frame, which is what
  read as "too fast"); softness 0.4 → 0.25.
- Impacts (`game/integrity.ts`): each body reports its hardest contact once
  a frame (0.35 s grace). ≥ 1 cell/s puffs dust. ≥ 1.2 cells/s shatters
  it into ⌊weakness·speed²·voxels/700⌋ pieces (≤ 8). Voronoi cells round
  seeds pulled toward the point hit, so the near pieces are small and the far
  ones big. Then a crater of radius 0.5 + 0.3·speed (≤ 2.5) round the
  contact. Metal reaches 0.4 of that, wood 0.7. Craters and pieces of ≤ 16
  voxels go to loose ground with chips and dust. Pieces keep their parent's
  motion (they used to start at rest, which also applied to Break-tool
  splits).
- Fixed in passing: `looseAdd` is overwritten, not added to, so two crumbles
  into one column before the drift pass (period 2) folded the first lost
  it. Crumbs now gather CPU-side and flush at most once per 2 ticks.
Measured (two runs): the tower breaks free, cracks at the foot, tips and
lands as one or two slabs (61–91 voxels, a 26-voxel piece in one run) with
~125 of its 216 voxels as a rubble heap at the foot; 19–22 impacts, 3–4
shatters; peaks 4 cells/s, 0.55 rad/s, ≤ 6.3 cells/s at a point. Tuning
went through 400 (the whole tower turned to rubble within 5 s) and 900
(2–3 chunks, few crumbs) before 700. Knobs: SHATTER, IMPACT_BREAK,
IMPACT_CRUMB, impactRadius in integrity.ts; MAX_* in bodies.ts.

## 2026-10-10 — planted columns no longer grow into spires (O3)

User: during storms, huge columns of material build up into the sky.
Reproduced in the sandbox (two rain storms, a cyclone, a dust storm at
4× speed): within 20 s single sand columns near the cyclone reached 15–18
cells deep beside neighbours of ~10, and stayed that way. All had plant
density 2.5 (fully rooted). Rooted columns turned off their own wind
erosion, wash, slumping and wind smoothing, but sand still arrived, so they
took in everything blown at them and shed nothing.
Fix (`drift.wgsl` held()): plants hold only what lies within their reach;
the hold fades as the top layer over them goes from 1 to 2 cells deep (it
has buried them), and beyond that it moves and slumps like any other.
Measured, same scenario, 80 s: the deepest column stays at the map's
pre-existing 6.9–7.4 (it was 17.7–18.1).

## 2026-10-10 — dust clouds at breaks; no jump when a piece breaks free (O4, O5)

User: better by a good bit; add see-through dust clouds and particles to
hide what's still janky; the static → rigid-body switch sometimes jumps.
- The jump, measured: tracking each new body's first 12 frames, the garden
  tower and the diving board rose steadily at exactly the 1.5 cells/s
  push-out cap from frame one. Their collision points (voxel corners) sat
  exactly on their outer faces, so floor() put them in the neighbouring
  column. Sand banked 3.5–4 cells deep against the structure there, and the
  points read as buried 0.15–0.8 deep. Before today's push cap that was an
  instant pop upward. Points now sit 0.04 cells inside their voxel. After
  the change: no false contacts at spawn, and all three pieces start from
  rest.
- Clouds: bursts can now spawn the wind-haze particle (big, soft,
  see-through; it swells, drifts and thins over 4–7 s), tinted by a
  material passed in the payload slot. One puff per five dust grains,
  wherever dust is made: every impact, every shatter or crater, the Break
  tool and lightning on bodies, and where a piece tears free (at its
  lowest cells).
- Chips now go out as one burst per column instead of one per voxel. The
  particle queue holds 64 bursts a tick and drops the rest; a crumble of
  dozens of voxels was filling it and crowding out its own dust cloud.
Checked headlessly (garden: tower, diving board and bridge pillar cut at
once): grey clouds round the shattering tower and the falling diving
board, a faint brick-red one at the bridge pillar.

## 2026-10-10 — pieces only fall; a bass crash; a cyclone cooldown (O6–O8)

User: chunks should only fall (downward motion only) so they read as
collapsing structures; the rigid-body collision response is too bouncy for
the scale. A deeper crumbling sound. A small cyclone cooldown that a fresh
press resets.
- `game/bodies.ts` is no longer a rigid-body solver: a body has a vertical
  speed only (gravity, air drag, ≤ 4 cells/s down) and keeps its frame, so
  nothing rotates, slides or bounces. Collision points find the deepest
  overlap below them (a solid run's top, loose ground, a sleeping body's
  top); in contact a piece loses 60 % of its falling speed per substep, so
  it settles slightly into what it lands on, and overlap past the 0.15
  slop is pushed out ≤ 1.5 cells/s. The impulse solver, inertia, friction
  and spin limits went with it. Cyclones no longer drag bodies (with
  falling only, that would just be lift); they still crack structures.
  The impact shattering (O1) does the rest: a cut tower now drops into its
  foot and crushes down into a rubble cone with its top resting on it, a
  demolition rather than a topple.
- `audio.collapse(amount, at)`: a sine thump falling from ~45–70 Hz to half
  that, a low-passed rumble (110–170 Hz, 1–3 s) and a few low-mid crunches,
  sized by √(voxels/60). It plays on shatters, hard landings and pieces
  tearing free, and calls within 0.15 s merge. Not heard by an agent.
- Cyclones: a second one within one drag needs 1.5 s (it was 1 s, kept
  across drags); a new press resets it.
Checked headlessly: garden tower, diving board and bridge cut at once; no
errors; 4 impacts, 2 shatters, 81 voxels to rubble in 14 s.

## 2026-10-11 — round 22: nothing pushes back up; dying cyclones scatter (P1, P2)

- `game/bodies.ts`: the overlap push-out was the only thing that could move
  a piece up (loose ground banking under a resting piece, or a landing
  deeper than the slop). It is gone: past the 0.15 slop a piece just stops
  (vz = 0) and stays sunk; vz itself never becomes positive. Measured on
  the garden (tower, diving board, bridge cut at once, 29 bodies over
  12 s): the largest per-update rise of any body is 0 (it was the source of
  the visible pops).
- `particles.wgsl`: a cyclone's spine radius shrinks with its strength, so
  over the 3 s fade the held dust was drawn into a tight column and then
  dropped with zero velocity. Now, while it dies (b.z), held particles ride
  a ring that widens up to 3.5× and are let go a little at a time
  (1.2·fade/s), flung outward faster and with less lift; anything still
  held when it ends is thrown out along its spin (4 cells/s tangential,
  5–9 outward) instead of dropped. Headless: a 9 s cyclone leaves a
  ~10-cell-wide haze cloud settling, not a column.


## 2026-10-11 — branch strata, stage 1: fractional intervals (P4)

First step of the consolidation (ARCHITECTURE "Consolidation in progress"):
a layer slot is now `vec4<u32>` — z0 and z1 as f32 bits, material | aux << 8,
one spare word — so loose ground can later live in the same intervals as
rock (it needs heights finer than a cell; fixed point 8.8 was considered and
dropped because small deposits — a grain of dust per pass — would round away
and break mass conservation). `surface` packs z as 8.8 fixed point (bits
0..15), material (16..23), slot count (24..31); `sfZ` returns f32. Kernels
that walk layers (surface, structure, material, renderprep, edit) and the CPU
side (layout, fracture, integrity, model placement, map files — version 2,
version-1 files still load) were ported; whole cells stay whole, so nothing
behaves differently yet. Fracture voxelises an interval into the cells whose
centres it covers.
Checked headlessly against main (a second checkout on port 5174): valley and
sandbox look identical, no errors; the garden cut (tower, diving board,
bridge) breaks, falls and shatters as before (25 bodies, 3 shatters, nothing
moves up). The layer buffers are 4× larger (16 B a slot).

## 2026-10-11 — branch strata, stage 2: the loose ground lives in the layers (P4)

The drift system's separate four-layer stack (drift + strata textures) is
gone as state: every granular interval in the layers is loose ground, and
`sediment.wgsl` (was drift.wgsl) works on the run of touching granular
intervals on top of each column — wind, water, slumping and now piping take
from its top interval, arrivals of a new material start an interval, and
granular intervals over air fall (2 cells a pass). `material.wgsl` (whole-cell
falling sand: gravity, repose, piping, erosion, litter stripping) is
removed; the sediment pass does all of it, for the valley and the title too.
- The surface pass derives a view from the layers each tick — `surface`
  z = the base of the loose run, the drift texture (run depth, top interval's
  depth and material, air) and strata (the intervals beneath the top; w =
  exact base) — so every reader of `sfZ + driftAt` is unchanged. Neighbours
  are read only through that view, so the sediment pass updates the layers
  in place (no copy) and stays within 8 storage buffers.
- Loose behaviour moved into the material table (`loose` vec4: wind lift,
  airborne share, water mobility, wash flow; repose dry/wet from `sim`,
  with moisture: rain lowers it). Repose values take the sandbox's (soil
  1.4, rubble 1.7, ash 0.9; they were 3, 4, 2 in the old whole-cell rules).
- Edit: pours, digs and cleaning go through one `deposit` vec4 per column
  (x editor, y/z a crumbled body from the CPU; was driftDelta + looseAdd);
  building on loose ground just stacks on it (the loose ground stays under
  the block); Break cuts loose intervals like any other.
- Render: renderprep skips the loose run (drawn as the sheet); the sheet
  now shows its top material's surface detail (litter specks, pebbles,
  hue drift) as the old whole-cell boxes did.
- Maps: a map's drift/strata stacks are folded into intervals on load
  (`looseIntoGrid`); saved maps no longer carry them.
- Bodies treat granular cells as not solid (they sink into loose ground as
  before, measured from the run's base).
Checked headlessly against main: sandbox and valley look the same (the
valley's soil is now the smooth sheet over its rock); the title diorama's
ash mound is drawn plain (deep ash counts as a film that buries plants —
a judgement call for the user). Cost (valley, Xe-LPG): sediment 1.40 ms a
pass (every other tick) vs drift 0.39 + material 0.13; structure 0.31 vs
0.12 and surface 0.18 vs 0.01 (bigger slots, the derived view). Next: split
the sediment pass so neighbours' outflows aren't recomputed five times.

## 2026-10-11 — strata stage 2b: sediment in two passes, still columns skipped; covered tops culled

Measured first (valley, Xe-LPG, 1600×900): sediment 1.40 ms/pass. Splitting
it into `outflow` (each column's outflows once, into `sedOut`: what reaches
each neighbour, the wind's easing, totals) and the gather barely helped
(0.26 + 1.07 ms): the cost was unpacking every column into registers. Now
the gather leaves a column's intervals alone when nothing leaves, arrives,
falls, is stripped or bound there (most of the map): 0.16 + 0.28 ms (old
drift + material: 0.52 ms). Renderprep hides the top face of the box under
a loose run at least 0.3 deep (the sheet covers it; it only shows at the
sheet's thinning edges), so rock under soil is culled again: instances
69k (main 93k, stage 2 121k), draw 4.42 ms (main 5.23), GPU span 5.98 ms
(main 6.93).
Mass: a 173-cell sand pour on the sandbox, calm weather — total loose
volume in the layers 267226.16 at every sample over 17.5 s after it landed.

## 2026-10-11 — strata stage 3: loose ground spills out of exposed faces (P4)

The rule the user agreed (round 22): loose ground buried under something —
sand under a cap rock, soil under a slab — with air beside it in a
neighbouring column runs out into that air, landing on the neighbour's
floor at that height (inserted mid-column when the air is under an
overhang), until the face stands at its angle of repose; what lies on top
doesn't hold it. `outflow` finds, per buried granular interval and
direction, the lowest air gap beside it that has a floor (or the open air
over a lower neighbour) and sends (height over the repose) × 0.08 a pass,
capped at a quarter of the interval and half the gap; `main` takes it off
the interval's top and lands what its neighbours send on the floor it was
aimed at (found by its height before this pass), then compacts and merges
touching loose intervals of one material. Two bits in `surface` (30: loose
ground buried under something; 31: air between intervals) let `outflow`
skip every column with nothing buried and every neighbour with no face.
Checked: a 20×12 concrete slab on 4 cells of sand on the sandbox plain —
the sand runs out at the edges into an apron, leaving an air pocket under
the slab 1.5 cells high at the edge and 0.4 a column in, and stops there
(the face at repose); more undercutting needs the apron carried away (wind,
water). The valley, settled: 1–3 columns spilling. Cost, averaged over 12 s
(perf overlay sampled every 0.5 s; single samples vary ±40% on this iGPU):
sediment 0.55 + outflow 0.33 ms a pass with spills, 0.53 + 0.29 without;
main's drift + material 0.57. Per tick the branch also pays structure +0.2
and surface +0.17 ms (bigger slots, the derived view) and saves ~0.7 ms of
draw.

## 2026-10-11 — shallow water lies still (Q1)

The ripple normal (wind-advected value noise) was the same strength at any
depth, so the thin puddles left after a flood shimmered like open water.
Its amplitude now scales by `smoothstep(0.1, 0.7, depth)`: puddles are flat
(their glint and shade go with it), ponds and the river are unchanged.
Checked headlessly on the sandbox pond (no errors; the rim calms).

## 2026-10-11 — strata: a sand basin to test the spill-out (Q2)

The user's test: a concrete basin full of sand — blow down a wall, does the
sand spill out? The sandbox garden now has one (`sandbox.ts`, 12×12 on a
plinth, walls 6 high, sand to the rim). Headless (scratchpad `basin.js`):
dropping a 4-wide section of the south wall, the middle row's profile goes
from a flat 20.0 to 19.2 18.2 17.2 16.2 15.2 14.2 over the ground at 13.8 —
a fan at the sand's repose (~1 per cell) — within ~3 s, ~25 cells of sand
out, then still (the same at 10 s and 20 s). The rest stays held by the
walls. Break (💥) on a wall also smashes the sand in its radius, so in play
the gap is a crater plus the fan.

## 2026-10-11 — strata: destroyed solids become rubble, same volume (Q3 step 1)

The user: destroyed blocks "turn into a new material (stone to gravel)" and
keep their volume. `rubbleOf()` (materials.wgsl, mirrored by integrity.ts
`looseFrom`): wood/canvas/leaves → ash, bone → dust, compacted waste →
litter, everything else → rubble.
- Break and lightning (edit.wgsl smash): a solid's share of the hole becomes
  its rubble in place — but only where the hole is open above. A first try
  kept it under what was left too, and the garden tower then stood on a
  pedestal of its own crushed base (granular ground anchors structures in
  the fracture analysis, rightly — a slab on sand rests). Under something,
  the hole is still emptied; that volume wants grains that carry it out
  (step 2).
- A cross-section that gives way (fracture `crumble`) used to vanish; its
  cells now squeeze out as rubble onto the lowest open column beside each
  one (`spillRubble`, through the deposit buffer), so what it held still
  falls.
Checked headlessly: Break into the stone under the sand plain leaves 2 cells
of rubble where 2 of stone were (sand around slumps onto it); Break at the
garden tower's base drops the tower into the hole as before.

## 2026-10-11 — strata: drop Rapier; loose ground doesn't brace structures (Q5)

The user tried branch `rapier` and decided against rigid-body physics for
this project (DECISIONS round 25): it jerks too much at times, and throwing
pieces in cyclones isn't worth it. `strata` keeps its grid-aligned bodies
(straight-down falls, shatter on landing); `rapier` stays unmerged. One fix
from it is independent of the solver and comes over: in fracture.ts
`analyse`, loose ground only holds what stands on it (`holds()`: island
anchoring, side anchoring and snap anchors), so sand drifted round a
tower's foot no longer keys it in. Checked: the garden tower with two of its
three foot columns cut breaks free, drops and shatters (7 impacts, 2
shatters), no errors.

## 2026-10-11 — strata: no sand walls off tall tops; no dark blocks in running water (Q4)

Two render bugs from the user's screenshots (DECISIONS round 25):
- Water and drift sheets give each grid corner one height, the mean of the
  covered columns touching it, and a drift corner is never below the solid
  top of a column it touches. So a dust skin (or puddle) on a tower top and
  the dust at its foot made a corner at the tower's top: a slanted sheet
  from top to base, popping as the thin skin came and went. Now a corner
  isn't shared where one covered column's solid top (water: its bed) stands
  more than SHEET_STEP = 3 over another's surface; each keeps its own level.
  A first try at 1.5 on the levels themselves broke steep sand gullies open
  (diagonal neighbours ~2 apart, and drift sheets have no sides).
- Every water box drew all four side walls. Running down a slope, a
  column's wall stood inside its neighbour's water and showed through it as
  a dark block. Render-prep now hides a water side where the neighbour is
  wet and the sheet joins them (same SHEET_STEP rule), or where the ground
  beside rises over the water. Foam and rain rings are unchanged (the user
  likes them).
Checked headlessly on the sandbox garden under two storms and dust (3×
speed, 25 s): the dark blocks in the run-off are gone, the eroded gully is
unchanged; a sand skin on the garden tower stays on its top.

## 2026-10-12 — strata: soft borders between ground materials (Q6)

The user found the square, on-the-grid borders between dirt, sand etc.
artificial and floated an SDF. Chosen instead (DECISIONS round 26): a
per-pixel vote. A top face's pixel takes the material that wins over the
four nearest columns — bilinear weights (the trick behind the rounded
shorelines), plus world-space value noise per material (0.28) and the
material's relief (rubble/litter pebbles 0.4, stone 0.3, soil/ash/silt 0.2,
sand/dust 0.1 — so pebbles poke through sand and sand fills hollows). Both
sides of an edge see the same columns and noise, so it's seamless; a lone
cell becomes a blob. Only ground takes part (soft materials and stone) at
within 0.9 of the pixel's height, so cliffs, concrete and brick stay crisp.
Plant cover on tops is smoothed the same way, so grass edges dither along a
rounded line. An SDF would need the material across the border too, and a
rebuild whenever erosion moves sand; the vote reads the live columns.
Cost: render-fields marks the grid corners where the four columns differ
(material or cover; corner texture .w), so most pixels do one texture read
and skip the vote. Draw on the valley's default view (Xe-LPG, 1600×900,
alternating runs, noisy): 4.0 → 4.8–4.9 ms; with the vote skipped
everywhere 4.4 — about half the cost is the vote, half the bigger shader.
Render-fields gains a veg read (binding 9). Not done: side walls under a
softened edge keep their own material; stains and wetness are still per
cell.

## 2026-10-12 — round 27: merge strata; lightning near the click; storms from water swirls (Q7–Q10)

Strata merged into main (the user validated it). Then:
- Lightning (Q7, Q8): it used to take the highest point within 4 cells or
  any metal within 40 (a bonus fading with distance), then arc back to the
  tap — so near a tanker it struck far across the view. Now the candidates
  are the column tops inside a bowl on the picked voxel (radius 6, lowest
  point at the voxel, open upward), score = top + material draw (steel 5,
  rust 4, water 1, stone −2, concrete/brick −0.5) − 0.25 per cell from the
  tap; the arc goes to the clicked voxel. Free, 1 s cooldown. Checked: 3
  cells from the garden tower it hits the tower's top (z 35 from a tap at
  8); 4 from the chimney, the chimney; valley metal 4 off draws it, 12 off
  doesn't.
- Storms (Q10): the swirl that spins up a cyclone raises a lightning storm
  at its centre when at least half its points are over water deeper than
  0.3 (the level's ~1 s water read-back). The summon button, R and the
  Nature meter are gone; the first cyclone over land hints at it. Checked
  in the sandbox: a swirl over the pond made a storm and no cyclone, one
  over sand a cyclone.
- Break highlight (Q9): the ring drawn on the ground round the cursor
  didn't match the smash, which is centred on the voxel picked. The Break
  tool now picks under the cursor as it hovers (one pick in flight) and
  draws the sphere: its outline (a circle, radius · zoom) and a dashed
  equator through the voxel.

## 2026-10-12 — round 28: smooth faceted stone, embers that light fires, smaller debris (Q11–Q14)

- Stone (Q11) joins the soft-surface smoothing with a threshold of 2: rises
  of 1–2 cells become slopes, taller ones stay sheer. Render-only (the
  smoothing reads `smooth`; nothing in the sim does).
- Rock facets (Q14, step 1): stone faces are split into Voronoi cells
  (scale 1.25 per cell, tops in xy, walls along-and-up) that each tilt the
  lighting normal by up to ±0.35 and vary the tone ±10 %, with a dark crack
  where two meet (F2 − F1 < 0.09). An outcrop that drew as stepped cubes now
  reads as a cracked rock slab. Silhouettes are unchanged; bumps that rise
  out of the surface would need a per-pixel height march (open).
- Draw (valley default view, alternating runs): 4.2 → 4.65 ms for both.
- Embers (Q13): drag was horizontal only, so an ember's launch speed was
  never damped and its buoyancy kept it climbing (sampled at z ~30, still
  rising 6–7 cells/s) until it died in the air — none ever landed. Now
  vertical drag 1.8/s; buoyant for the first 1–3 s, then they sink (3
  cells/s²) and ride the wind down (life 4–6 s). Particles and fire are
  both at the 8-storage-buffer limit, so a landing is written to a new
  storage texture `sparkTex` (x = tick + 1; idempotent, no atomics), and
  fire.wgsl lights fuel where one landed last tick with chance
  0.35 × fuel × dryness × (1 − rain). Checked: ~235 columns got embers
  around a valley woodland fire; a spark written onto planted, dry ground
  lit it at once. Not tuned against a real wildfire — watch for runaway
  forest fires.
- Debris (Q14): litter 0.28 → 0.18 half-size, grime clumps and ground dust
  about a third smaller.

## 2026-10-12 — round 29: carved rock silhouettes (Q15)

Facets shade rock but its outline was still the voxel box. Stone is now
carved in the fragment shader: the rock surface lies rockCut(p) inside the
box's *exposed* faces (top — following the smoothed slope — and the sides
not hidden by a neighbour), rockCut = 0.45 · smoothstep(0.2, 0.85,
value-noise3(p · 1.1)). Each stone fragment sphere-marches the view ray
from its face into the box (≤ 20 steps of 0.8 · depth); leaving through an
open face means it missed — discard, so what's behind shows and the edge
is jagged; leaving through a closed face or the bottom means it met a
neighbour or the ground (a hit). Only rock is ever removed, so everything
behind is already drawn and no frag_depth is needed (keeps the opaque pass
as it was; the face depth is ≤ 0.45 in front of the true surface). Normal:
forward differences of the depth (3 extra samples) where the surface was
cut; facets then tilt it 40 % as much as on uncut stone. Grid lines are
off on carved rock.
Cost (Xe-LPG 1600×900): the first version doubled the default valley view
(draw 5.2 → 11.4 ms — the map's stone skirt and gorge, at a few px per cell
where the jag can't be seen). Now it only carves above ROCK_ZOOM = 10 px
per cell (default view: unchanged within noise), with one noise octave and
3-sample normals: zoomed onto the river gorge cliffs, draw 7.7 → 9.4 ms
(two octaves + 6-sample normals: 13.8).

## 2026-10-13 — round 30: GitHub Pages, PolyForm Noncommercial license

- `.github/workflows/pages.yml` builds (`npm ci && npm run build`) and
  publishes `dist/` to GitHub Pages on every push to main.
- `vite.config.ts` `base: './'`: relative asset paths, so the build runs from
  the `/Reclaimed/` subpath (and any other folder). Nothing in the app needs
  cross-origin isolation headers (no SharedArrayBuffer), which Pages can't set.
- LICENSE: PolyForm Noncommercial 1.0.0, verbatim from the PolyForm repo
  (tag 1.0.0), with a `Required Notice:` copyright line. README updated
  (play link, current controls — the summon button and R key went in round
  27 — and the license in plain words).
- Checked: the build loads at http://localhost:4173/Reclaimed/ with every
  request served (only the absent favicon 404s). The scene itself couldn't
  be checked headlessly: requestAdapter() hung in headless Chrome this
  session, for the dev server too — a machine state after a low-memory
  episode, not the build.

## 2026-10-13 — round 30: rain spikes on planted columns (Q16)

The user saw sediment spike very high in rain storms on a phone; it
reproduces on desktop (4 storms over the valley for 60 s at speed 4). A
spiked column: soil 6.0–19.3, a dust sliver, soil 19.3–20.3 — 8–11 cells
over all four neighbours. Rain lays alternating thin layers (mud carried in,
dust rained out of the air), so the top interval stays about 1 deep;
held() lets go only when the *top interval* is 1–2 deep, so planted
columns kept their full hold: they took in what water and wind brought
and never slumped (round 21's spires, by another route). Roots now hold a
slope at most HOLD_STEEP = 1 cell steeper than the material's repose; past
that it slumps as if unplanted. Columns standing over all four neighbours
(pre-storm 13 by > 2.5, 3 by > 4, mostly built things): before 49 / 12,
after 38 / 4 and 21 / 3 (two runs).

## 2026-10-13 — round 30: holes through the ground (Q17)

Measured by drawing with a magenta clear colour (wrap `core.dayNight.light`)
and counting magenta pixels in four zoomed views (zoom 22, 900×700).
Before: 4127 / 4311 / 6386 / 7957. Two causes:

1. Dust/sand sheets (MAT_DRIFT boxes) drew no sides: they were assumed to
   taper into the ground. Where a sheet ends at a step (its corner left at
   the box height, SHEET_STEP) or beside ground drawn lower through its own
   soft corner, the strip under the sheet's edge was empty — the zigzag
   along cliff tops. Sheets now draw that side (`sheetGap`: corner -1, or the
   cell across has no sheet of its own deeper than 0.12 and its drawn corner
   is lower), up to the sheet's corner levels and never below its base.
   Drawing every sheet side fixed it but tripled draw (5.6 → 16.2 ms default
   view: hidden sides shaded at full cost); testing against the ground
   *under* the sheet instead of the neighbour's surface cost 28 ms.
2. Carved rock (round 29): a side is open if the neighbour is lower, but the
   carve ran the full height of it; a ray leaving below the neighbour's
   ground met that neighbour's facing side, which isn't drawn (hidden behind
   this box), and showed the background. Sides now open only above the
   neighbour's ground (`RockBox.nt`, from surface + driftTex), and a rise the
   smoothing draws as a slope (≤ stone `smooth`) isn't carved at all.

After: 210 / 58 / 461 / 235 (carving off: 197 / 43 / 452 / 235; the rest is
mostly sky past the map edge and a few seams between soft tops). Draw
(1600×900): default view 5.6 → 6.8 ms, zoomed gorge 6.8 → 8.1 ms.

## 2026-10-13 — round 30: story rules and reach (branch `story`; N3 step 1, R1, R2)

- `Globals.rules.x` (Globals 1088 → 1104 bytes) turns on story rules on a
  story level (`LevelDef.story`; Begin) — Free play and `?mode=free` keep the
  old rules. Ecology stops colonising bare ground; only seeds do. Green
  (veg >= 1.2) sheds a seed now and then (0.00025 per tick, more in wind;
  12 s flight), so a breeze carries green onto fertile ground nearby; a
  grow-tap on green lets go a puff of seeds and never sprouts bare ground.
- Reach (game/reach.ts, CPU ~1 Hz from veg + driftTex readbacks): patches
  of established green (veg >= 1, not buried under dust) touching the reach;
  each reaches max(8, ¼ × the width of a disc of its area) past its edge,
  flooded outward in a bucket queue (8-connected, √2 diagonals), with a
  4-cell soft edge; it never shrinks. It starts as a 12-cell disc around the
  valley's healthy oasis (`poi.healthy`). Only patches touching it count, so
  the valley's other green is found, not given (the first version counted
  everything and the reach spanned the map). reachTex fogs the draw (haze():
  desaturated, dim); the camera is confined to its box and can zoom out to
  about 2.5× its size; taps, drags and the hover breeze outside it do nothing.
- Checked headlessly: the reach opens at 595 cells; idle 40 s → green 121 →
  231 cells, reach 829; tapping the oasis and blowing east planted 73 new
  sprouts. Draw with the fog (1600×900): 4.5 ms (story view), 5.4 ms (free).
- Sandbox load list: "level: The Dam Valley" loads the built valley into the
  editor (the options are written at once; they used to wait for the saved-
  map list).


## 2026-10-13 — round 31: level tools — kit, map preview, gate validator, the Trial Grounds (branch `story`; R7)

Why: the user wants to churn out levels — regions joined by gates (ground
green can't take until something clears it), with abilities never locked,
any ability that physically clears an obstacle opening it, and obstacles the
ruin, never nature (DECISIONS round 31). A level should be an afternoon's
script, visible in seconds, and known to work without playing it through.

- `world/kit.ts`: a builder (land → ground() → features → build()) with SDF
  shapes; gates name an obstacle's columns, kind and what it should teach.
  `mapgen.ts` exports buildRuin / buildTank / foundation for it. Ponds can
  take a fixed level, filled last, so a `plug` wall can hold a reservoir;
  `freeboard` leaves room for a storm's rain; a river with no inflow is a
  dry gully.
- `scripts/mapview.mjs`: the generator on the CPU via Vite's SSR loader → a
  top-down PNG with the gates outlined and labelled (~150 ms per level).
- `game/trial.ts` + `scripts/gates.mjs`: per ability a fresh world (story
  rules), the ability applied the way a player would (wind strokes one after
  another, cyclones, parked storms, `Powers.scriptStrike` lightning, poured
  water, focused chips; 'ambient' = one natural storm + one dust storm),
  80 s of sim at speed 2, each gate measured from readbacks.
- `levels/trials.ts`: the Trial Grounds (hidden: `?skipmenu=1&level=trials`,
  and the sandbox's load list): six obstacles around a spring.

What the validator taught us (run 2; % of the gate cleared, 60 + 20 s):

| gate | ambient | wind | gale | cyclone | rain | lightning | flood | chip |
|---|---|---|---|---|---|---|---|---|
| dust (1.4 deep) | 0 | 0 | 18 | 77 | 63 | 21 | 0 | 0 |
| litter | 25 | 47 | 72 | 100 | 98 | 47 | 0 | 0 |
| trash | 24 | 0 | 0 | 82 | 2 | 20 | 0 | 0 |
| poison gully | 100 | 0 | 0 | 0 | 100 | 0 | 29 | 0 |
| oil lake | 100 | 46 | 45 | 52 | 100 | 44 | 45 | 47 |
| walled yard | 0 | 0 | 0 | 14 | 0 | 0 | 0 | 0 |

- The measures had to follow the sim, not my assumptions: blown dust is
  material 19 (Drift) in driftTex, and its depth is the top interval (y);
  litter is loose (driftTex), trash solid (surface); standing water takes
  soil poison up and drops it as it dries, so "closed" counts dissolved
  poison too; oil on bare ground soaks in as soil poison, so the oil gate
  counts its stain (fixed after run 2 — the 45% everywhere was the shore
  soaking). Binary "closed" hid progress: a gale removed 18% of the dust in
  12 s but no column dropped under the threshold — so the report also
  gives the share of the stuff removed.
- Scripted strokes: Powers holds one scripted stroke at a time, so strokes
  for six gates at once overwrote each other (run 1: wind did nothing).
  Wind, gale and cyclone are things a player does one place at a time:
  they now run a fresh world per gate. A gale's field reaches 18 over the
  dust (lift 9). Chips: 20 taps on one spot turn a wall cell to rubble; 240
  spread over 84 cells did nothing — a player hammers one spot, so the
  trial does.
- Leaks the sim really has: storm runoff tears trash heaps into litter
  (24% of the mound in one storm); a poisoned hollow is cleaned by rain
  (it pools, takes the poison up, and diluted, it decays), and a poisoned
  gully gathers every storm's runoff into a stream — a flood of its own.
  The toxic obstacle is now poison on an open slope below the reservoir's
  plug (no hollow, no channel). Moisture evens out within seconds of
  loading, so "parched ground" can't be a gate; the plateau stays as
  terrain with seeds hidden on top.
- Run 3 (the fixes above, per-gate serial runs, three worlds at once) was
  stopped by the system running low on memory before it reported; to rerun
  with `--parallel 1`.

## 2026-10-14 — round 32: gates only slow; events no longer dropped

The user: the weather may keep slowly wearing gates down (runoff eroding
trash is fine) — a gate only has to slow the player. The validator now
flags a leak only when the weather alone opens a gate within a run
(LEAK = OPENS), not when it wears it.

Runs 3 and 4 (`--parallel 1`, one world at a time) found that a tick
carries at most MAX_EVENTS = 4 events and `step()` dropped the rest
silently. With six gates, the oil and yard gates never got their chips or
flood water, and most scripted strikes (two events each) were lost. That
was why "chip opens nothing" in runs 2 and 3. It's a game bug too: fast
taps (chip + ripple + grow) could lose events. Now the overflow waits for
the next tick instead. The trial's per-tick abilities take turns round the
gates, one per frame. Rain joins wind, gale and cyclone as one-gate-at-a-
time (storms cap at 4). Chips aim at the ground as it stands now (the
surface is re-read every 2 s), since a player taps what they see.

Run 4 (% of the gate cleared / % of its stuff removed, 60 + 20 s, speed 2;
chip from the re-run after the aim fix):

| gate | ambient | wind | gale | cyclone | rain | lightning | flood | chip |
|---|---|---|---|---|---|---|---|---|
| dust | 0/4 | 52/64 | 62/73 | 90/93 | 3/15 | 15/14 | 0/2 | 0 |
| litter (soft) | 22 | 86 | 93 | 100 | 77 | 47 | 0 | 0 |
| trash | 8 | 0 | 0 | 92 | 1 | 96 | 0 | 0 |
| poison slope | 98/100 | 0 | 0 | 0 | 97/98 | 0 | 3/18 | 0 |
| oil lake | 100 | 1 | 0 | 1/6 | 100 | 61/74 | 93/95 | 0 |
| walled yard | 0 | 0 | 0 | 33/30 | 0 | 95 | 0 | 21/24 |

Dust, litter, trash and the yard behave as gates: none opens to the
weather; trash teaches fire (cyclone too); the yard opens to taps,
lightning and a cyclone. Poison and oil still leak. One passing storm takes
the whole slope's poison and the lake's oil and stain, because any water
film over 0.003 deep dissolves 0.16% of a cell's poison a tick
(contamination.wgsl). That's exponential, independent of the deposit's
depth, so a thicker deposit doesn't slow it and no layout can. The
shader's own comment (heavy deposits need floods or many storms) wants a
solubility limit; that's a balance change for the whole game, so it waits
for the user (BACKLOG R10).

## 2026-10-16 — grids: the nature grid goes hex (GRIDS plan steps 1–2)

Branch `grids` (docs/GRIDS.md, DECISIONS round 35). The interval columns
now sit on a hex lattice; every system runs on it, and it renders as hex
prisms. No square/hex switch: the square reference is the `ambient`
branch, run beside it (no fallback paths to keep alive).

- Lattice in common.wgsl (`nbr`, `cellPos`, `cellAt`, `triAt`, `Dirs`),
  mirrored for the CPU in world/lattice.ts. Directions in opposite pairs, so
  every `k ^ 1` (the flux coming back) carried over unchanged.
- Per-pipe rates × 2/3 (water and oil gain, slumping, wind easing): the
  hex Laplacian weights six neighbours 2/3 as much as the square grid's
  four, so things spread at the same continuum rate. `netFlow` normalises
  by 2/NDIR (a uniform flow v puts dot(v, e_k) down each pipe; summed over
  six directions that's 3v).
- Wind is split over the six faces by its positive projections (`dSplit`);
  upwind shelter walks world positions through `cellAt`.
- Hex corners for soft ground and sheets: each cell owns its 30° and 90°
  corners (`cornerTex` 2w × h); a corner's height is the three touching
  columns (weight 2) and the three beyond (weight 1), the hex form of the
  old 4 × 4 tent. Bilinear lookups (shadow, reach fog, shorelines, the
  soft-border vote) became three-centre barycentric (`triAt`).
- Prisms: top fanned from the centre, three sides toward the eye, 36
  vertices. Per-triangle normals showed every hexagon's fan wherever the
  smoothed corners weren't coplanar; the top takes one normal, the
  least-squares plane through its corners. Per-cell colour noise keyed to
  the hex cell (it was floor(world), a square pattern over the hexes).
- Rock carving ported to the prism (six slab tests, the fanned top). The
  map's edge zigzags on a hex grid, and carving rays left edge prisms
  through the notches into nothing: off-map counts as closed. The loose
  sheet's side at the map edge always shows (its corners there can belong
  to a cell on the map, which had hidden it).
- CPU: picks, taps, strikes and the trial's gates go through `cellPos`;
  weather lives in world extent (w + 0.5) × h·√3/2 and samples heights via
  `cellAt`; levels still author in cells (laid row by row: ~13 % shorter in
  y, slightly sheared), points of interest converted with `poiWorld`.

Measured (headless, real GPU, 1600 × 900, the Dam Valley story start;
scripts/perfpass.mjs, new): draw 7.7 ms hex vs 4.0 ms square; the sim's
passes 2.9 ms vs 2.3 ms (sediment 1.06 vs 0.80); 96 vs 120 fps. The sim
costs about what six neighbours should. Draw is 1.9×: every top vertex
reloads all six corner heights for the centre and the normal — next, a
per-cell top plane cached once per frame. The same 40 s storm at speed 6
leaves both at the same place (63 % vs 62 % green), water pooled in the
basin on both.

Draw, following up (same view): 69k instances on both grids, so it was
vertex-bound — 36 vertices a prism against 18 a box. Each cell's top plane
(centre and fitted gradient, per ground / water / drift) is now cached by
render-fields with its corners (cornerTex 5w × h: two corners and three
plane texels per cell): 7.7 → 7.3 ms. The top in four triangles over its
corners instead of a six-triangle fan (the flat normal shows nothing the
centre point added) and plants in their own list at 18 vertices (prisms
30): 6.7 ms against square's 4.0 — the ratio of the prism's vertices
(30/18). A top-only list for prisms with every side hidden would take most
of the rest; not now (the branch's point is the grids).

## 2026-10-16 — grids: structure grids (GRIDS plan steps 3–4, first pass)

A structure grid is a rigid voxel grid in its own frame — position and a
full rotation (yaw, pitch, roll) — over the hex nature grid
(src/grids/structures.ts, src/shaders/grids.wgsl). The CPU only places
structures: it uploads a model's voxels once into a GPU pool and writes
each frame (64 bytes: position, quaternion, dims + pool offset, world xy
bounds). Everything grid-shaped is a kernel:

- project.wgsl (structure → nature, every tick, first): each nature column
  casts its world-vertical line through each structure's rotated voxels (a
  3D DDA in local space) and keeps the top of the first solid run, the
  bottom of the last, and the world normal of the face the line entered by
  (exact for boxes: `foreign`, xy). Merged with the CPU's sleeping bodies
  (integrity.ts now writes `bodyCpu`, rasterised over hex centres), it is
  `bodyProj` — so every system that already respected bodies sees
  structures unchanged: water stands on them, loose ground banks against
  them, wind is sheltered by them. 0.05 ms.
- Sediment (the burial): sand above a structure's top falls only to it,
  and where a column's run is under a structure (or it has none), arrivals
  start a new run on the structure's top — so drifts climb over it instead
  of vanishing under it. Measured with a pour onto a 20°-tilted concrete
  slab: the sand piles on it, runs off its low edge and buries it in a cone
  — a round cone (the hex grid's repose relaxation; the square grid's are
  pyramid-ish).
- structtick.wgsl (the structure's own tick, every 4 ticks, 0.02 ms): per
  voxel, samples the nature grid at its world centre (nature → structure):
  sand cover (inside the loose run there), and moss on its faces open to
  the air where the ground is damp — up-facing faces fastest, undersides
  too; it creeps from green ground and mossy neighbours, rarely starts on
  its own. First tuning grew full cover in under 20 s; now about four
  minutes of damp weather.
- structprep.wgsl: exposed voxels → rotated-cube instances in the body
  format, drawn by the body pipeline (indirect). fsBody shades a structure
  voxel's moss, and the sand drape redundantly: a face point inside the
  nature grid's loose run there (interpolated over the three nearest
  centres, counting only columns whose run reaches down to that height)
  takes the sand's colour, so the sand line on a tilted wall follows the
  drift smoothly rather than the cells.
- Test hooks: `?structure=model,x,y,yaw,pitch,roll[,sink]` (cells,
  degrees) and `reclaimed.grids.place(...)`; scripts/timelapse.mjs (shots
  at marks of sim time after a JS setup).

Not yet: sliding by the projected normal (the normals are there; the
sediment doesn't use them), air inside a structure (one span per column:
an office tower's window grid reads as solid slabs; sand poured onto one
beam slides off — correct, but a solid slab was the clearer test),
structures that move (setPose exists; nothing drives it), breaking them.

## grids: a tilt slider on the sandbox's Place tool

The user found the structure demo hard to poke at (URL and console only).
The sandbox's Place tool now has a tilt slider: at 0 it stamps the model
into the columns as before; above 0 the model goes in as a structure grid
of its own, toppled that far over its quarter turn (E), with a little roll
so no face lines up with the hexes, resting on the ground (bury sinks it).
Then pour, rain, wind and the weather tools act on it. Not undoable (the
undo snapshot covers the layers, not the structure pool); 8 at most.
Placed into the ground, it overlaps: nothing is displaced yet.

## grids: air inside structures — projected intervals and the open air between them

The user: the building should be able to hold air (and other materials)
the way the terrain's columns do — use the same representation. The
projection now keeps every solid stretch a column's vertical line crosses
(project.wgsl), up to three per column, in the layers' own interval form
(`projAt` in common.wgsl reads them as intervals). The surface pass adds the
floor of each stretch of open air they leave (`levels`). The sediment pass
then moves loose ground within one level: a column's run lies in one
(`runLevel`); what a neighbour sends at height h comes into the level open at
h, or steps up onto the solid there (`openAt`) — so a wall is just higher
ground at that height, a doorway or the gap under a raised floor is open;
arrivals in a level other than the run's land on its floor (`landAt`); what
comes from the sky over a structure lands on its top; granular intervals fall
onto the highest projected interval beneath them. The old single-span rule
(everything arriving under a structure went onto its top) is gone.

Wind under a structure: shelter is measured at the run's own height (the
solid upwind at that height, not the tallest thing), and a run with a
structure over it feels wind only if the open air upwind (a column with
nothing over it) comes before a solid within 16 cells — inside a room it's
still, along the line of a doorway or under an overhang's edge it blows.
(The wind field itself doesn't see structures yet.) Nothing goes airborne
from under a structure (it would come down on the roof). Smoothing now needs
the wind to be felt (shelter applied, as for transport): a pile under a hole
in a roof was being spread over the whole floor by the wind outside.

Measured (scripts/roomtest.mjs: a 16 × 16 room, foundation, floor, roof with a
4 × 4 hole, a doorway, slightly tilted, in the sandbox):
- calm: 48 cells of sand dropped under the hole fall onto the floor and
  slump out under the roof into a round cone at repose (peak 3.1); all the
  sand within 26 cells goes 9515.7 → 9563.7 (exactly +48), then stays.
- wind (60 base, 18 felt) along the doorway's line: sand banks against the
  outside wall, blows into the gap under the raised floor (0 → 4.4 cells),
  climbs onto the sill; the jet along the doorway's line spreads the pile
  inside along that line. It stops at the sill when dust from the air
  crusts it into soil (plants bind it), which doesn't blow — sandbox
  behaviour, not the room's.
- cost (Dam Valley, nothing projected): sediment 0.62 → 0.70 ms,
  sediment-out 0.40 → 0.42, surface 0.16 → 0.18; project 0.05 (unchanged).
- also: placing a tilted model rested it on the loose run's base, sunk into
  the sand (heightAt is the base); the pick's height now says how deep the
  sand lies.

Known: water still has one sheet per column, on the top one; a column's
plants are one value, so the ground's plants under a room show on sand that
lands on its floor; nothing is displaced when a structure is placed into the
ground (it overlaps).

## 2026-10-22 — Pages publishes every pushed branch

The user wants to try branches on a phone as work lands. Pages holds one
site, so the workflow now builds each branch that is on origin and puts
main at the root and the others under /<branch>/ (base './' already makes
the build path-independent; checked by serving the build under /grids/ and
loading the level headlessly). A push to any of the branches rebuilds all of
them, so the root keeps showing origin/main whichever branch was pushed.

## 2026-10-22 — grids: tops alone (G13a)

Draw is vertex-bound (DEVLOG 2026-10-16: 69k instances, 30 vertices a
prism), and most of the map is a surface whose prisms' sides are buried. A
prism whose six sides are hidden is now drawn as its top alone, 12 vertices,
from a second list (the same vertex shader: the top is the prism's first 12).

First cut: only intervals whose neighbours' flat stacks reach their top —
7.4k of 69k instances on Dam Valley, and draw got slower (7.0 → 7.7 ms; an
extra draw for little). On slopes nearly every column has a lower neighbour,
but soft tops slope through corners shared with their neighbours, so a side
whose two corners are smoothed is covered by the neighbour's top: counted as
hidden (8.8k). Then the dust sheets, which cover most of this map: their
side test (`sheetGap`) moved from render.wgsl to terrainshape.wgsl so
vegprep can apply it — 57.8k tops, 11k prisms.

Measured (headless, real GPU, 1600 × 900, Dam Valley, scripts/perfpass.mjs
on production builds): draw 7.0 → 5.2 ms, 96 → 102 fps. renderprep +0.1 ms
(it reads the corners now). Checked against the previous build with the sim
stopped, three zooms on Dam Valley and the sandbox: the only differences are
particles and cloud shadows (they move while the sim is stopped), no holes.

## 2026-10-22 — grids: smooth-lit tops

Soft tops and drift sheets already pass through shared corner heights (a
continuous surface), but each was lit with its one fitted plane, so every
hexagon showed as a facet. Their normal is now blended per pixel from the
planes of the three cells round the point (barycentric over the lattice of
centres, `smoothNormal` in render.wgsl; a cell whose top stands > 1.2 from
mine is left out, so steps stay sharp). The dunes and slopes read as
terrain; the hex outlines that remain are the grid lines and the per-cell
colour variation. `?smooth=0` keeps the flat look to compare (Camera.eye.w).

Cost: none measurable (draw 6.4–6.6 ms smooth against 6.7–6.8 flat, run to
run noise ±0.3 ms on this machine; three plane reads per top pixel).

Also measured on the way (Dam Valley, 1600 × 900): at render scale 0.5
draw falls 5.7 → 2.6 ms, and with a flat-colour fragment shader to 2.4 ms —
draw is now bound by fragment shading (~3.3 ms), not vertices (~1.6 ms).
Emitting near cells first (front to back) didn't help (5.8 ms); storm and
fair-weather cloud shadows and the sun-shadow test are each below the noise.

## 2026-10-22 — grids: the field mesh, a prototype (G13 h, option C)

Round 38: the intervals are storage, not a constraint on drawing. The
"density field" is a function evaluated from them on the fly — nothing new
is stored but the mesh (and a scratch grid while it's built).

Behind `?mesh=1` (`?mesh=x,y,r` a region r cells each way round x, y;
`?meshh=` the sample spacing, 0.5; `?meshevery=N`), one square region is
drawn as a mesh instead of prisms, sheets and cubes. Three compute passes:
- sampleField: the field at every sample. Terrain: each column's vertical
  distance to its solid (touching intervals are one solid, below 0 is
  bedrock), blended barycentrically over the three nearest centres.
  Structures: the distance to their voxels' boxes in their own rotated frame
  (the nearest of the 27 round it: solid outside, air inside — an
  occupancy blend rounded the room's edges off). The two joined by a smooth
  minimum (0.6), so sand against a wall makes a fillet.
- makeVerts: surface nets — a vertex per crossed sample cell at the mean of
  its edge crossings, its normal the field's own gradient (central
  differences, so light runs smooth across cells), and how much it's
  structure.
- makeQuads: two triangles per crossed sample edge.
The fragment shader finds the interval the point lies in (a step into the
surface) and takes its material, so the layers and stains still come from
the intervals; a structure's share shows its voxel (moss, sand cover).

Measured (headless, real GPU, 1600 × 900, rebuilt every frame — the worst
case, no dirty tracking yet; scripts/meshtest.mjs):

| region (Dam Valley) | columns | rebuild | vertices | triangles |
|---|---|---|---|---|
| r 16, h 0.5 | ~1.2k | 0.43 ms | 6.3k | 12.2k |
| r 24, h 0.5 | ~2.7k | 0.96 ms | 13.8k | 27.0k |
| r 32, h 0.5 | ~4.7k | 1.77 ms | 24.1k | 47.6k |
| r 24, h 1.0 | ~2.7k | 0.19 ms | 3.4k | 6.5k |

So ~0.37 ms and ~5k vertices per 1000 columns at h 0.5 (~290 KB as stored
now: 32-byte vertices, 32-bit indices), a quarter of that at h 1, which
looks nearly the same at the default zoom. The sandbox room (r 24): 17k
vertices, 1.07 ms. Draw didn't move outside the noise (5.7–6.2 ms against
6.0 on the same view). Most samples lie above everything: skipping them, a
compact vertex and rebuilding only dirty chunks are next.

Seen: slopes read as terrain with no hex facets; the room keeps its edges
and the sand banks against it in a fillet; rubble heaps soften into mounds.
Not yet: the region's edge shows a faint seam against the prisms; plant
cover is still per cell; rock facets, soft material borders and grid lines
aren't drawn on the mesh.

## 2026-10-22 — grids: the field mesh over the whole map

Round 39: the meshed ground looked right, the room didn't (surface nets
bevel every edge by up to a sample), trash and rock wanted a rougher
surface, and the goal is a phone.

- Sharp things stay sharp: the structures are their cubes again, and the
  mesh drops the quads whose four vertices are all structure, so what's left
  of them in the mesh is the sand fillet against their walls. Built
  materials (concrete, brick, asphalt, steel, rust, bone, canvas: solids but
  rock and packed trash) aren't in the field at all; renderprep still draws
  them as prisms. (Meshed, the sandbox's ruin walls melted into cones.)
- A detail layer in the shading: rock takes the faceted normals of round 28,
  rubble, trash, litter and ruins chips a quarter cell across, each tilted
  its own way with a dark seam; sand, soil, ash and silt stay smooth. Only
  where a chip is a few pixels across.
- The whole map: 32-cell chunks of the world, each with room for its own
  vertices and indices and one indexed indirect draw, culled to the view on
  the CPU. A hash pass (0.12 ms) finds the chunks whose columns or
  structures changed; up to 8 a frame are rebuilt. Samples lie on one
  lattice over the map and a chunk computes the cells one sample past its
  low edges, so neighbours compute their shared vertices identically and
  there's no seam.
- The look follows the intervals more closely: a top-facing point takes its
  run's top layer however thin (looking a fixed step into the surface went
  through thin dust and showed what was under it, in patches), blended with
  the layer below as the sheets do; plants, stains and wetness blend over
  the three nearest cells (they were hexagons); the cell a point takes its
  material from is jittered a quarter cell, so borders between grounds are
  ragged rather than hexagons; the shadow test is lifted 0.6 (the smoothed
  surface dips under the columns' tops, and the heightfield shadow streaked
  the slopes).

Rebuilds were costlier than the region test suggested: every thread read
its job, and claimed its vertex or index slot, with an atomic on the shared
state, and atomics skip the caches — 8 chunks took 5.5 ms. The first thread
of each workgroup now reads the job for it and claims its vertices with one
atomic: 0.84 ms. The valley's sim changes 15–32 of its 64 chunks every
frame (sediment creeping in the water), so heights are hashed to 1/16 of a
cell: 0.38 ms on average.

Measured (headless, real GPU, 1600 × 900, Dam Valley, scripts/perfpass.mjs,
GPU time summed over passes, ms; fps is capped near 100 here):

| | draw | field mesh | all GPU |
|---|---|---|---|
| prisms, high | 6.07 | — | 9.58 |
| mesh, high | 3.01 | 0.92 | 7.34 |
| mesh, medium | 2.08 | 0.93 | 6.37 |
| mesh, low | 1.31 | 0.94 | 5.68 |
| prisms, low | 2.87 | — | 6.21 |

(field mesh before the 1/16 hash.) Mesh: 126k vertices, 221k triangles for
the valley, ~10 MB with room to spare (vertices 32 bytes). Of what's left,
the simulation is ~3.5 ms a frame: next for the phone.

## 2026-10-22 — grids: mesh water, warped cliffs, rebuilds near the view; a storm

Round 40.
- Water on the mesh is one smooth sheet over the triangle lattice of the
  cell centres instead of prisms: each wet column draws the six triangles
  round its centre, each drawn once (by its wet corner first in storage
  order — it's blended), a dry corner at the water's level or at its ground
  where that's lower. The opaque ground's depth cuts the shoreline.
- Cliffs: the terrain field is looked up up to 0.45 cells to the side by 3D
  value noise, so walls bulge and recede, differently up their height;
  flat ground is unchanged (moved sideways, it finds the same ground).
- Only chunks near the view are hashed and rebuilt (the CPU's culling now
  runs before the compute and writes a flag per chunk); the others keep
  their old hash and are rebuilt once they come into view.
- With the mesh on, renderprep skips the neighbours of columns with nothing
  built and no water (0.42 → 0.30 ms), renderfields only computes water's
  corners (0.45 → 0.32). (Marching a quarter of the columns' sun shadows a
  run saved nothing measurable: reverted. The march goes when the shadow
  pass comes.)

A storm over the water (scripts/stormtest.mjs: the camera on the deepest
water, a storm spawned over it, 10 s measured three seconds in; GPU summed
over passes, ms):

| | calm | storm | draw in the storm | field mesh in the storm |
|---|---|---|---|---|
| Dam Valley, prisms | 8.5 | 10.2 | 6.5 | — |
| Dam Valley, mesh | 6.8 | 7.9 | 3.7 | 0.50 (1.7 chunks a frame) |
| sandbox, prisms | 11.4 | 17.3 | 10.3 | — |
| sandbox, mesh | 8.2 | 10.8 | 5.1 | 0.41 (1.4 chunks a frame) |

The storm's cost is mostly draw (rain, water, its shade) and the water's
spread, not rebuilding. Known: a thin film in the valley's basin is hidden
under the smoothed floor (drawn as prisms it showed).

## 2026-10-22 — grids: the sun's shadow map

Round 40 asked whether a normal shadow pass would do instead of the sun
march. With the terrain a mesh it does, and better: the march cast from the
columns' whole tops, so shadows stepped a cell at a time, and needed a lift
on the smoothed surface to stop streaking the slopes. Now, with the mesh on,
a 2048² depth map over the whole map along the sun is drawn every frame by
the same vertex shaders (the field mesh's every built chunk, the prisms, the
plant boxes, the structures' cubes, the bodies), depth only, through a
camera buffer holding the sun's orthographic matrix; the draw shaders look
it up with four filtered comparison taps, nudged off the surface along the
normal. Shadows follow the real shapes — the tilted room, the arch, the
pillars, the plants — and the march is skipped (renderfields 0.32 → 0.21
ms).

Measured (Dam Valley, 1600 × 900, scripts/perfpass.mjs, ms):

| | draw | shadow | renderfields | all GPU |
|---|---|---|---|---|
| prisms, high | 5.60 | — | 0.41 | 8.87 |
| mesh, high | 3.13 | 0.20 | 0.21 | 6.64 |
| mesh, low | 1.54 | 0.22 | 0.25 | 5.36 |

Storm over the valley's water (scripts/stormtest.mjs, mesh): 7.15 ms GPU in
the storm (10.2 with prisms, before the shadow map). The map costs 16 MB.

## 2026-10-22 — grids: the water's film, shores, waves across the wind

Round 41: the film of water running over the ground was hidden under the
smoothed floor (the sheet sits at the columns' level, the mesh above it
where it rounds a slope), and flowing water was one of the best parts of
the original.
- The film is now a material on the mesh: where the water (blended over
  the three nearest cells) is thin, the ground takes a glaze of the water's
  colour, darker the wetter, smoothed of its rock and rubble detail, with
  the sun's glint and the sky in it, and streaks running with the flow.
  With the mesh on, renderfields stores the flow's direction (no march
  reads that slot any more); the streaks are noise stretched along it and
  moved down it in two phases that take turns (a flow map), at the water's
  speed. Fast water froths in the same streaks. Above the edge, a band of
  wet ground, and the swash running up it and back (higher in the wind)
  with a lip of foam.
- On the sheet: waves whose crests lie across the local wind (three
  travelling waves round its direction, broken into lengths by noise, set
  in patches), the old advected noise now only catspaws; swell lines
  running in to the shallows with foam where they break, more on a lee
  shore and in a stronger wind (not in running streams); rain lands as
  spreading rings. Foam on the mesh is smooth noise, not cells.
- scripts/watertest.mjs frames the fastest thin water (or the most thin
  water, or the deepest) in free mode, wide, close and closer, then a storm.

Cost (Dam Valley, 1600 × 900, mesh, two runs each): draw 3.26 → 3.50 ms,
all GPU 7.70 → 7.92 ms (the film's three water reads per fragment, and the
waves).

## 2026-10-22 — touch: a finger left over from a pinch pans

First phone test of `grids` (round 41): after a pinch, pan and zoom went
wrong. Lifting one finger of a pinch left the other as a fresh one-finger
press (Controls kept no memory of the pinch): moved, it started a gust from
where it had first landed; lifted, it tapped the world. A finger that took
part in a two-finger pan or pinch now only pans until it lifts, and the
pinch's span is measured afresh whenever a finger comes or goes (a third
finger no longer leaves it stale). scripts/touchtest.mjs drives it with CDP
touch events: before, the leftover finger gusted; now it pans. The story
valley's hint says "hold ◎" on a phone (Space on a keyboard).

## 2026-10-22 — grids: free play by default

Round 42: playing `grids` on a phone, the camera seemed to lock — the
story's reach fences it to the land round the green, and nothing shows the
fence or says the green's spread opens it. `grids` is the rendering branch,
so it now opens in free play (the whole valley, the old rules); the story's
rules are behind `?mode=story` (the menu's Free play button shows only
then; scripts/gates.mjs asks for it). Making the fence readable is R11.

## 2026-10-22 — physics: one GPU solver for every material

Round 43, a new branch `physics` cut from `grids`: the sandbox as a
destruction playground (and terrain for other games). The old CPU bodies
read the world back, worked in tens of bodies, and the user found the
sandbox worse than the valley. Now every voxel of a physics body is a
particle (docs/PHYSICS.md): lattice shape matching on the GPU, one solver
for every material, so steel bends (and stays bent past its yield) and
stone stays rigid until its bonds snap and it goes on as rigid pieces.
Heat softens and melts; the 🔥 beam tool cuts steel (white-hot, sagging,
gone in about 2 s held). The 🧱 drop tool drops test shapes or any model.

Energy, the user's rule: lose it, never gain it. First runs blew up:
bodies spawned inside the loose ground (heightAt is the run's base) and
were shoved out; then crumbled voxels dropped rubble into the column under
the body and the push out of it became speed (a 30 × 30 × 12 block
"exploded" to z = 100). Contacts now never push out: they only stop a
voxel moving further in, an overlap it already has stays, and one too deep
(or an impact over the material's crumble speed) crumbles it into its loose
material. Restitution is low (stone 0.1, steel 0.2): big things thud,
crack and settle. The same 30 × 30 × 12 concrete block dropped 4 cells:
10,563 of 10,800 voxels left after 6 s, nothing higher than where it
started. Voxels of one body that started close (a squeeze, a crack's two
faces) never crumble each other (they had been: interior pits).

Scenes (scripts/phystest.mjs): a steel beam over two stone posts arched
under a dropped concrete block; a stone pillar toppled on sloping sand and
lost its tip; the beam cut a steel bar on two stone blocks.

Cost (Xe-LPG, 1400 × 900): 24 bodies, 1.5k voxels, 1.3 ms GPU a frame;
10.8k voxels 1.5 ms (mostly the fixed ~60 dispatches a tick).

## 2026-10-22 — physics: ruins wake when touched; softer metal; a beam you can see

Round 44, the user's first try on a phone:
- The map's own ruins stood fast while dropped things fell apart: they were
  still the old layer structures. They stay terrain until something touches
  them (the user: convert under interaction, keep it working well with the
  terrain), then wake into physics bodies: the beam's hit, the break tool,
  or a body running into one (collide reports the column, the host reads the
  list four times a second). The wake floods through the cells they touch
  (up to 6,000; the edge of a bigger piece stays pinned to the rest), one
  body per connected piece, voxels where the cells stood; cells resting on
  the ground are pinned foundations until their bonds break (unpinned, thin
  walls on sand toppled the moment they woke). The break tool blasts bodies:
  what's inside its radius crumbles, what's near is thrown.
- Metal too springy and strong: steel yields at 0.04 (was 0.12), flows
  plastically faster (0.85), tears at 30 % strain (was 60 %); rust weaker
  still.
- The beam was under the finger and too weak, and it pointed the wrong way:
  camera.eye is the unit direction to the eye, not a position, so the beam
  ran nearly level and stopped heating once the top voxels melted. Now it
  runs down the view, heats everything along its line in front of the hit
  (through its own hole it keeps eating the sides), at three times the
  power, and is drawn: a glowing line from the sky to a dot, 80 px above the
  finger on touch screens. Held on a steel bar on two stone blocks it cut
  it in two in about 2 s, the hot ends sagging into the gap.

## 2026-10-22 — physics: the sandbox in the field mesh; softer steel; merged into grids

Round 45: the sandbox draws with the field mesh unless `?mesh=0` (WorldCore
passes the sandbox flag to the renderer; FieldMesh takes it as its default
when the URL says nothing); the rest of the game keeps the mesh opt-in.
Steel deforms more easily still (stiffness 0.6, yield 0.025, tears at 25 %;
rust 0.5, 0.02, 10 %): a concrete block dropped on a beam over two posts
leaves it dented. With the mesh, the beam scene's GPU time: draw 2.9 ms,
physics 1.0–1.2 ms. `physics` merged into `grids`.

## 2026-10-22 — physics: sand and water see the bodies

Round 46 (the user: proceed). The nature grid passed through physics
bodies: poured sand fell through them, and loose ground slumping from under
a body let it sink. Now prep marks, per column, the top and bottom of the
voxels over it (`physCols`, atomics on positive float bits), and the
projection pass merges that like a sleeping CPU body, so sand piles on a
slab and a table and water flows round them. One stretch per column is
enough for now (a body's inner air reads as solid). Headless: sand poured
on a concrete slab and a table stays on both; blowing the slab away drops
its sand. A jostled body rises a few hundredths into its sand, and the
sediment pass's hanging check then saw no floor and dropped the sand
through the table: a projected interval the sand starts inside now holds
it. Stress scene (24 bodies): physics 1.35 ms (1.3 before).

