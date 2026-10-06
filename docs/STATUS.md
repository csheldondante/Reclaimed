# Reclaimed — status & stock-take (2026-10-06)

A snapshot for review: what exists, how to try it, how it's built, what's
hard, and where your guidance would change what happens next. Questions for
you are marked **❓Qn**; places where I made a call you may want to overrule
are marked **⚖️**.

Companion docs: `docs/ARCHITECTURE.md` (contracts, kept current),
`docs/DEVLOG.md` (why every change was made, with measurements).

---

## 1. Trying it yourself

```
npm install        # once
npm run dev        # → http://localhost:5173  (Chrome/Edge; WebGPU required)
```

URL options: `?perf=1` perf overlay · `?q=low|medium|high` quality tier
(default high) · `?speed=4` fast-forward the simulation (debug).

**Controls**

| input | action |
|---|---|
| left-drag on land / WASD / arrows | pan |
| wheel / pinch | zoom |
| Q / E | rotate 90° (⚠ least-tested path) |
| `1` or **Storm** button, then tap land | summon a storm (30 Nature); it forms upwind of the tap and drifts over it |
| drag a storm's dashed ring | nudge it (arrow shows intent; nudge is bounded and fades) |
| tap a storm's ring | downpour (8 Nature) |
| `2` or **Lightning**, then tap under a storm | strike (10 Nature); seeks the tallest point within ~7 cells |
| `` ` `` | perf overlay · `Esc` cancel tool |

**A 3-minute test script**
1. Click to start (audio begins). Listen: wind, debris rattle, a distant dam groan now and then.
2. Storm over the industrial site (top-left of the river). Watch the cloud shadow, rain, runoff, and stains on the pad fading.
3. While it rains, Lightning on the tall warehouse walls: collapse, rubble, thunder, crumble sounds.
4. Storm toward the **dam** (where the reservoir narrows), then Lightning on the dam. Wait 10–30 s: piping → breach → flood scours the landfill (the speckled heap below the dam).
5. Watch moss and grass appear where rain cleaned the ground and soil stays moist; Nature regenerates faster as land comes alive.

**Debug from devtools**: `reclaimed.probe('contam', x, y, r, 2, 0)`,
`reclaimed.readBuffer('veg')`, `reclaimed.weather.spawn(x, y)`,
`reclaimed.globals.events.push({kind:1, x, y, radius:5, strength:20})`.

### Connecting Claude in Chrome
So that I can drive *your* Chrome (real GPU, real audio context) instead of
headless screenshots:
1. Install the **Claude** extension from the Chrome Web Store and sign in with the same Claude account you use for Claude Code.
2. In this Claude Code session run **`/chrome`** (or start with `claude --chrome`) and follow the prompt to connect. `/chrome` also shows connection status. If the command isn't recognised, update Claude Code first.
3. Keep Chrome open. I'll work in my own tab and you'll be asked to allow `localhost`.

Even connected, I can't *hear* audio. Sound judgments need you.

---

## 2. What exists (milestones 0–4 + first profile)

| system | status | how it works (one line) |
|---|---|---|
| World representation | ✅ | XY columns of ordered material intervals, chunked 16×16 with per-chunk slot count K |
| Rendering | ✅ | render-prep compute → instanced boxes (3 visible faces), translucent water, rain streaks, heightfield sun shadows, cloud shadows |
| Material physics | ✅ | granular gravity, angle of repose (lower when wet → slumps), flow erosion, piping |
| Structure | ✅ | per-interval support (propagates 1 cell/tick) + damage → collapse to rubble |
| Water | ✅ | column-volume "virtual pipes"; edges drain; springs |
| Contamination | ✅ | soil-bound + dissolved; dissolve, advect with water, redeposit, rain leaching, plant remediation |
| Moisture | ✅ | rain/water wet the soil; diffuses; plants retain it |
| Ecology | ✅ | succession stage 0–5, conditions-driven growth + probabilistic spread |
| Weather | ✅ | ≤4 CPU storms → analytic rain/cloud fields in a uniform |
| Lightning / events | ✅ | one-tick event list consumed by the structure system |
| Nature resource | ✅ (untuned) | base regen + living area; storm 30, lightning 10, downpour 8 |
| Audio | ⚠️ unverified by ear | fully procedural WebAudio driven by aggregate world state |
| Menu skull scene (§4) | ❌ | not started |
| Fire, quake, cyclone | ❌ | not started (event channel and structure system are ready for quakes) |
| Win/level structure | ❌ | none; the valley simply recovers |

**Measured** (Intel Xe-LPG integrated GPU, 1600×900): draw ≈ 3 ms; all
simulation passes ≈ 1–2 ms per tick (60 Hz); ~67k box instances; ~30 MB GPU
memory. Nothing beyond this laptop's iGPU has been measured.

---

## 3. Architecture in one page

```
            CPU (TypeScript)                          GPU (WGSL compute + render)
 ┌──────────────────────────────┐         ┌────────────────────────────────────────────────┐
 │ input · camera · HUD · audio │ uniforms│ per tick (60 Hz fixed):                          │
 │ weather (storms) · Nature    │────────▶│ structure → material → surface → water →        │
 │ event queue (lightning)      │         │ contamination → moisture → ecology(/15) →        │
 │                              │◀────────│ shadow(/6) → stats(/20, async readback)          │
 │ reads ONLY aggregate stats   │  stats  │ per frame: render-prep → draw                    │
 └──────────────────────────────┘         └────────────────────────────────────────────────┘
```

The design rule from §9/§23: **systems talk only through contract buffers**
(`src/sim/world-gpu.ts`, table in `ARCHITECTURE.md`): `layers`, `surface`,
`water / waterPrev / flux`, `contam`, `moisture`, `veg`, `shadow`, `stats`.
A replacement water solver only has to publish `water`, `waterPrev` and
`flux` with the same meaning. Gameplay, HUD and audio never touch GPU
internals; they read aggregates (`soilContam`, `vegCells`, `flow`,
`collapsed`, …).

Key choices and why (details in DEVLOG):
- **Everything emergent goes through shared mechanisms.** The dam breach is
  lightning damage + hydraulic loading + piping + flow erosion, the same rules
  any wall or embankment obeys. No dam script.
- **Rubble is just granular material**, so collapse needs no debris system.
- **Net flow** (outflow − inflow) drives erosion, damage, scour and foam,
  because the pipe model sloshes heavily even in still water.
- **No fallbacks.** WebGPU missing, or a limit not met → clear message; GPU
  validation errors → fatal overlay.

⚖️ **Per-chunk variable slot count (K)** follows your suggestion; it costs one
extra lookup per column. Overflow (material piling past K) is counted and
shown in the perf overlay. Deposits merge into loose tops to avoid it.

---

## 4. Challenges, known issues, risks

**Visual**
1. **Water on slopes looks stair-stepped.** Flowing water shows dark vertical stripes, because each column's water box exposes side faces against lower neighbours. Options: slope the water top surface between neighbours (vertex-shader trick, cheap), or render water as a heightfield surface instead of boxes. → **❓Q1**
2. **Terrain "dashes".** Gentle slopes produce 1-cell staircase edges whose shaded side faces read as dark dashes. It's the honest voxel look but busy. Options: soften side-face contrast more, add per-vertex AO, or bias terrain toward flat terraces.
3. **Rubble falls at 60 cells/s**: effectively instant. A visual-only fall interpolation (or 1 cell per N ticks) would make collapses readable.
4. **Dam wings** still look like a comb from some angles (a diagonal wall in a grid).
5. Vegetation is mostly a top-surface tint plus box shrubs/trees. Ruins only get dithered moss on walls; no vines or roots yet, and §2's "forests over recognisable ruins" isn't there yet.

**Simulation / gameplay**
6. **Nature economy is untuned.** At start you can afford exactly storm + lightning. Regeneration: 0.35/s base + living-area term. → **❓Q3**
7. **Rain is now fairly strong** (≈0.4 contamination removed per storm). Light pollution clears in one storm; the landfill and site need leverage. That's a pacing decision. → **❓Q4**
8. **Spontaneous spores**: any clean, moist cell can sprout moss with tiny probability, so recovery isn't purely spread-from-seed. Easy to remove if you want recovery to radiate only from living patches.
9. **Rotation (Q/E)** hasn't been visually verified since culling and lightning targeting landed.
10. **Mobile** is untested beyond having touch handlers (pan, pinch, tap).
11. **The site's heavy contamination** has no strong lever yet except repeated storms. Fire, tank ruptures or the river are the natural next levers.

**Engineering**
12. Headless testing only proves GPU behaviour on this machine. No discrete-GPU, Mac or mobile data.
13. The simulation is deterministic per device but not bit-identical across GPUs (float math). Fine for single-player; matters only for replays/sharing.
14. One hard-coded map in code. There's no level format yet; making levels data-driven is a choice point. → **❓Q6**

---

## 5. Questions where your guidance would help most

**❓Q1 — Water look.** Keep honest voxel water boxes (blocky, stepped
waterfalls), or smooth the water surface between cells (reads as liquid, less
"voxel")? A middle option: smooth top surface, blocky sides.

**❓Q2 — Next big thing.** Candidates, roughly in my order of value:
(a) **fire + industrial cascade** (lightning → fire → tank rupture →
contaminated spill → rain/flood cleanup; the §8 example chain);
(b) **menu skull scene** with persistent progression (§4); (c) **vegetation
reclaiming ruins** visually (vines, roots, trees on rooftops); (d) earthquake
(event channel + structure system make this cheap); (e) a second map / level
format.

**❓Q3 — Economy feel.** Should the opening be tight (one meaningful move,
then wait) or generous (experiment freely, learn the systems)? I lean
generous early, since the leverage lesson works better with room to fail.

**❓Q4 — Pacing.** Currently: storm ≈ 1 min, moss within ~30 s of rain,
trees in a few minutes, dam breach 10–30 s. Is a level a 10-minute or a
45-minute experience?

**❓Q5 — Goal / end state.** Is a level "done" at a health threshold
(e.g. 60 % living, contamination below X), or is it open-ended with the menu
scene as the only progression signal? This changes the HUD (currently just
the Nature bar).

**❓Q6 — Content pipeline.** Keep generating maps in code, or move to data
(heightmap + placed prefabs, maybe voxelised meshes as you mentioned) soon?

**❓Q7 — Control granularity.** Lightning auto-targets the high point near
your tap, and storms only nudge. Does that feel like "nudging nature" or like
lost control? Should downpour stay (tap the storm), or become a separate tool?

**❓Q8 — Audio direction.** Once you've listened: is procedural synthesis the
right base, or should we bring in recorded field audio (wind, birds, water)
and keep synthesis for dynamic events?

**❓Q9 — Device targets.** Which devices must work for you (phone model,
other laptops)? That decides whether `low` needs more aggressive scaling.

---

## 6. Feedback that is easiest for me to act on

- Screenshots/screen recordings with "this looks wrong / this feels good".
- Where your attention went in the first 30 s, and what you *expected* a tap to do.
- Anything that felt like a scripted animation rather than a system (§6).
- Perf overlay numbers (`?perf=1`) from any other device.
