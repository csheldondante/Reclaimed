# Reclaimed — status & stock-take (updated 2026-10-07, after round 3)

What exists, how to try it, how it's built, and where your judgement is
needed. Items needing a decision are marked **❓**. `docs/DECISIONS.md`
records your answers so far; `docs/DEVLOG.md` explains every change with
measurements; `docs/ARCHITECTURE.md` has the contracts.

---

## 1. Trying it

```
npm install && npm run dev      # → http://localhost:5173 (Chrome/Edge; WebGPU)
```
The game opens on the **menu diorama** (skull scene; its state follows your saved
progress). **Begin/Continue** starts the valley. URL options: `?skipmenu=1` straight
in · `?progress=0..1` preview a menu stage · `?perf=1` overlay · `?q=low|medium|high` · `?speed=8` fast-forward
· `?day=60` day length in seconds · `?tod=0.75` start time of day (0.25 sunrise,
0.5 noon, 0.75 sunset).

**Controls (no tool buttons)**

| input | does |
|---|---|
| **LMB tap** under a storm's shadow | lightning: the tallest thing within ~6 cells of the voxel tapped, drawn to metal (free, 1 s cooldown) |
| **LMB tap** elsewhere | touch: trees shed leaves / birds flee, tanks clang, concrete chips, water splashes, ground puffs dust |
| **LMB drag** under a storm | gust along the drag; also shoves the storm (6 Nature) |
| hover | a light breeze follows the cursor (trees lean, dust lifts, deer bolt) |
| **RMB drag** / WASD | pan |
| **MMB drag** / wheel / pinch | zoom |
| **swirl** (tight circles) | a cyclone; over water, a lightning storm |
| hold **Space** | life lens: what keeps plants out around the cursor |
| `` ` `` | perf overlay |

Touch: tap = touch/lightning, one-finger drag = pan (or gust if it starts
under a storm), pinch = zoom. No hover breeze on touch.

**A 5-minute tour**
1. Hover over the land and tap things: listen for the clang, chips, splashes.
2. Swirl over the reservoir to raise a storm; watch dust and clouds,
   rain, stains washing off the pad.
3. Under the storm, tap an oil tank → it ignites; heat ruptures the wall;
   burning oil spreads and burns off (smoke, embers, firelight; best at dusk:
   `?tod=0.75`).
4. Tap the dam (under a storm) → piping breach → flood scours the landfill.
5. Hold **Space** to see blockers; watch moss → grass → flowers → trees, vines
   climbing ruins, birds and the occasional deer. Stay for the night: fireflies.

---

## 2. What exists

| area | state |
|---|---|
| World | layered column intervals, chunked K, procedural valley: dam/reservoir, continuous river (edge inflow → spillway → edge outflow), ruins on foundations, open oil tanks, landfill, debris |
| Water | virtual pipes; edges drain; evaporation mostly from thin films |
| Oil | second liquid: floats, viscous, carried by currents, soaks into loose ground as stain, smothers plants, burns, drains off-map |
| Pollution | soil stain (washes under any water; plants remediate), dissolved in water, oil, dust/litter particles carrying it off the map |
| Structure | support + damage, collapse → rubble; lightning, hydraulic loading, flood flow, **fire heat** |
| Fire | fuel = oil/plants/waste; downwind gather-spread; rain/water/wet ground extinguish; burns oil, plants, waste |
| Particles | GPU ring (16k–64k): dust, litter, leaves, clouds, rain splashes, chips, smoke, flames, embers, fireflies, birds, deer |
| Wind | analytic field: wandering prevailing wind + storm swirl + gusts + cursor breeze |
| Weather | big rolling storms (natural every 2.5–4.5 min + summoned), cloud deck particles, crisp cloud shadow, rain |
| Day/night | 8-minute day, golden hour, moonlight, fireflies, insect/bird soundscape |
| Ecology | succession 0–5; birds plant seeds |
| Look | sub-voxel canopies with gaps, wind sway, grass waves, tufts, wildflowers, vines, stone/dirt variation |
| Audio | procedural: wind, rain, water, leaves, insects, birds, thunder, crumble, dam groan, fire crackle, clang/chip/splash/flutter/strain — **still not heard by me** |
| Menu | live skull diorama driven by saved progress: trash → moss on bone → grass/flowers → a tree through the skull |
| Goal | reclamation bar (living share of the map); level ends at 60 % (“The valley breathes”) |
| Biomes | woodland (conifer, broadleaf, birch, old giants) on flat wet ground; meadows with flowers and fireflies elsewhere |
| Not yet | earthquake/tornado, a second level, mobile verification |

**Performance** (Intel Xe-LPG iGPU, 1600×900, storm + fire active): GPU ≈ 6.3 ms
(draw 5.2 ms, all simulation ≈ 1 ms), 100 fps. A fully grown forest: ~85k
instances, draw 3.5 ms at 1280×720.

---

## 3. Architecture (one page)

```
CPU: controls → powers (tap/gust/summon/hover) → weather + day/night → Nature
     reads only aggregate stats; writes Globals (storms, gusts, events, light, lens)
GPU per tick: structure → material → surface → water → oil → contamination
     → moisture → fire → ecology(/15) → particles(emit, fire, bursts, update)
     → renderfields(/2) → stats(/20)
GPU per frame: renderprep (terrain + liquids) + vegprep → draw
     (opaque boxes incl. sub-voxel canopies, liquids, particles, rain)
```
Contracts are documented in `ARCHITECTURE.md`. Every system writes only its
own buffers. Two exchange buffers keep that true across boundaries:
- `contamDelta` (atomic) for particles and oil adding or removing soil stain;
- the fire field, which each consumer burns its own resource from.

The draw shaders read one packed `renderFields` vec4 (shadow, moisture, fire
glow, flow), which keeps them within 8 storage buffers.

---

## 4. Known issues / risks

1. Water flowing down slopes still shows stair-stepped side faces.
2. Rubble falls effectively instantly (60 cells/s).
3. Rainwater fills roofless building shells and stays (realistic; maybe not wanted).
4. The canopy march keeps depth at the box face. Intersections are slightly off (not noticed yet).
5. Litter only lifts at storm/gust strength, so cleaning the landfill by wind needs gusts.
6. Fire burns spilled oil away completely (no soot residue). That makes fire a strong cleanup tool.
7. Particles (rain, clouds, smoke) are alpha-blended unsorted: fine so far.
8. Mobile and discrete GPUs are unmeasured; audio is unheard.

---

## 5. Judgement calls I made — please review

- ❓ **Rain and cloud look.** At storm scale the rain reads as a tall translucent column with a soft cloud deck above it. Too heavy? Too subtle? Should clouds be thicker but hide less of the land?
- ❓ **Economy.** Storm 30 + 25 s recharge, lightning 10, gust 6; regen 0.35/s + living land. Natural storms every 150–260 s. Too stingy or too generous?
- ❓ **Storms.** Radius 48. Summoned storms form about 55 cells upwind and arrive in about 15 s. The wind wanders ±35°.
- ❓ **Day length** of 8 minutes, and how dark night gets (currently quite dark, moonlit blue).
- ❓ **Fire strength.** It spreads readily through dry grass downwind and burns oil to nothing. Should it leave soot (stain) or ash (a fertile boost to regrowth)?
- ❓ **Chipping** is purely cosmetic right now (particles + sound, no damage). Should repeated chipping slowly decay a structure?
- ❓ **Lightning auto-targets** the tallest point within 7 cells. Keep, or strike exactly where tapped?
- ❓ **Animal density**: about 4 deer per mature forest and a few dozen birds. Birds planting seeds is the only gameplay effect.
- ❓ **Life lens** on Space with 5 categories. Colours and patterns OK? Should it be always-on near the cursor instead of held?
- ❓ **Forest look.** Trees are fairly uniform in height and density; should mature forests vary more (clearings, old giants)?
- ❓ **Touch**: one-finger drag pans unless it starts under a storm.

## 6. Suggested next steps

- The main-menu skull scene with persistent progression (§4). It's the last big piece of the handoff.
- An earthquake (cheap: the event channel and structure system exist), then drag-to-tornado.
- Level goal / end state, and a second map or data-driven map format.
- A pass over water-on-slope rendering and a rubble fall animation.
