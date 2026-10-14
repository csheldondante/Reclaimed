# Level design: tools, puzzles, variants

How Reclaimed's levels are built, the catalogue of obstacles and puzzles to
build them from, and the spin-off variants worth trying. The user's rules
(DECISIONS round 31) come first; everything else is a proposal to try.

## Rules (DECISIONS round 31)

- A level is a DAG of regions joined by **gates**: ground green can't take
  until something clears it. Reach only grows through green (round 30), so a
  gate needs no invisible wall — the seed rule is the wall.
- **Abilities are never locked.** Everything works from the start; the
  player just doesn't know it all yet. It's a toolkit of fun abilities, and
  obstacles teach the mechanics.
- **Any ability that physically clears an obstacle opens it** (a flood
  washes away what wind blows away). An ability is taught by an obstacle only
  it can clear. A gate must never open by itself (ambient weather alone)
  — though the weather may slowly wear it down: a gate only has to slow
  the player on the way to an objective (round 32).
- **Obstacles are the ruin, never nature** (no thickets). They're hard to
  break and hard to get past. Concrete is the canvas — green covers it; it
  isn't something the player must destroy.
- Ambient game: not hard, just fun and visually satisfying. Gates can block
  the way (puzzle levels) or hide easter eggs in tough patches.

## What clears what (the sim today)

Read from the shaders, then measured with the validator (below) on the
Trial Grounds — the measurements corrected several of the first guesses
(DEVLOG round 31).

| Obstacle | Cleared by | Notes |
|---|---|---|
| Blown dust (drift, mat 0) | wind lifts it; water carries it | resettles downwind — it must be blown somewhere it can't come back from (water, off the map) |
| Litter | a gale (wind > 5 strips a cell at a time, `litterStrip`); water carries it | |
| Compacted trash | fire (burns to ash); a cyclone (strips it to litter); moving water (tears it into litter) | measured: cyclone 92%, lightning 96% in a minute; one storm's runoff wears off 8–24% (fine: gates only slow, round 32) |
| Ash | wind; water | very fertile once clean (growth cap 3) — the payoff of a burn |
| Soil poison | rain leaches it; flowing water dissolves it faster; plants slowly | standing water takes it up (and drops it as it dries): a poisoned hollow is cleaned by rain, a gully by its own runoff — flood-only poison has to lie on an open slope — and even there one passing storm takes it all today (BACKLOG R10) |
| Oil | fire (burns even in rain); it kills the shore it lies on | on bare ground it soaks in as soil poison; a storm's water carries a slick off (one storm clears the lake, R10); measured: lightning 61%, a flood 93% |
| Concrete, brick | taps chip it (a dozen taps bring a piece down); lightning craters it; water pressure on a cracked wall breaches it; heat cracks it | measured on a 6-high yard wall in a minute: taps 21%, lightning (a strike per 2 s) 95%, a cyclone 33% |
| Stone | lightning only (craters) | effectively permanent |
| Steel, rust | heat weakens it; lightning craters it | effectively permanent at gate scale |
| Dry ground | water (rain, a river re-routed) | fertility needs moisture ≥ 0.04 — but moisture evens out within seconds, so it can't be a gate as things stand |
| Height (a ridge, a wall) | a cyclone lifts seeds over; a slump builds a ramp | seeds blown into a wall fall back |

Abilities: tap (grow / chip / splash), drag (wind; stacked strokes make a
gale), swirl (cyclone; over water a storm), tap under a storm (lightning,
which lights fuel), and the environment's own: a dam to breach (flood),
burning tanks (embers on the wind), slopes that slump, rivers that carry.

## The tools

The goal is to churn out levels: write one in an afternoon, see it in
seconds, know it works without playing it through.

1. **Level kit** (`src/world/kit.ts`): a level is a short script against a
   builder, not 700 lines of mapgen. Shapes are signed-distance functions
   (`disc`, `band` along a path, `rect`, `blob` with noise wobble; union,
   subtract, grow). Features stamp onto the grid and the fields: terrain,
   river, pond, spring, green patch, dust blanket, litter, trash heap or wall,
   poison, oil, tank, wall, ridge, voxel models (cars, the barricade), and
   seed caches. A **gate** is a named shape with what it's made of and the
   ability it's meant to teach; the kit returns the gates with the map.
2. **Map preview** (`scripts/mapview.mjs`): runs a level's generator on the
   CPU (Vite's SSR loader, no GPU) and writes a top-down PNG — height
   shading, materials, water, poison, dust, green, gate outlines with labels,
   the start and the goal. Seconds per iteration.
3. **Gate validator** (`scripts/gates.mjs` + the page's `reclaimed.trial`):
   for each ability, a fresh world in headless Chrome applies it to every gate
   at once (they're far apart), fast-forwards, and measures how much of each
   gate is cleared. Prints a matrix (gate × ability → % cleared) and flags
   gates that open to ambient weather alone, or that no ability opens.
4. **Story harness**: the same page API reports the reach, so a scripted
   playthrough can check the reach can't cross a closed gate.
5. **Sandbox**: built levels already load in the sandbox (round 30), for
   hand-tuning a gate in place.

## Puzzle catalogue

Each is an obstacle that's hard to clear plus the feature that makes it
clearable. Teaching ones (one key) are marked ★.

1. **Dust sea.** Dunes bury good soil. Wind clears it — but it resettles
   downwind until it's blown into the river, which carries it off.
2. **Ember relay** ★fire. A trash wall across a gully; upwind a tank burns
   for ever. Gust its embers onto the heap. The ash beyond is the richest
   ground in the level.
3. **Lightning rod** ★lightning. A trash heap ringed by steel pylons. Swirl
   a storm over the pond, strike a pylon — the chain lights the heap.
4. **Toxic basin flush** ★flood. A poisoned basin below a cracked reservoir
   wall. Tap the wall until the water's pressure takes it; the flood flushes
   the basin into a wetland downstream.
5. **Retaining wall slump.** A concrete wall holds a soil terrace above a
   poisoned yard. Crack it and the good soil slumps over the poison: new
   ground in one satisfying collapse.
6. **The quarantine line.** A row of wrecked military trucks: unbreakable.
   Swirl a cyclone to lift seeds over, or breach the dam upstream so the
   flood's silt buries them.
7. **The plateau** ★cyclone. Fertile ground above a cliff. Seeds blown
   at it fall back; a cyclone carries them up.
8. **Oil lake.** Oil on a pond kills its shore. Lightning on the film sets
   the lake alight — it burns even in the rain — then rain heals the shore.
9. **Litter fields** ★gale. Litter that a breeze can't move: stack strokes
   into a gale.
10. **Drought.** Good soil, bone dry. A rubble plug diverted the river; break
    it and the old channel runs again.
11. **Wind tunnel.** Dust trapped in courtyards the wind can't reach. Break
    one wall and the wind funnels through, scouring the yards.
12. **Firebreak.** A tank farm fire will spread to your green. Rain on your
    side, embers on theirs — burn what must burn, save what lives.
13. **Cascade.** One dam breach floods three gates downstream at once — the
    big payoff after a run of small ones.
14. **Windbreak.** Dust storms roll in and re-bury the flats. Grow trees
    upwind first (green as defence), then clear behind them.
15. **Bird bridge.** A barrier too wide for any gust. Grow a tall tree on
    your side: birds perch in it and carry seeds across (systemic, slow).
16. **The lab shell.** The goal: a concrete dome over the lab. Crack it open
    and green the seed vault inside.

### Easter eggs

Hidden in tough patches off the main path, a reward for curiosity:

- **Seed caches** (BACKLOG R4/N5): ancient seeds under a trash heap or deep
  dust. Uncovered, they burst into flowers; washed downstream they seed the
  next level's river.
- **A buried spring** under trash: clear it and it waters the dry flats.
- **A hidden meadow** in a walled courtyard: open it and a deer family
  wanders out.
- **Ruins with a story**: a burnt-out car with a flower bed inside, a
  child's swing, the last tent of the plague camp.

## Variants to try

Same engine, different games — each a fork in its own repo (BACKLOG X1, X2).

- **FEMA Mayhem** (X1, working title): the arcade version — fun mayhem
  where Reclaimed is chill. A full city that reacts: buildings that topple,
  burn and flood, people and traffic, emergency services responding, damage
  counters. Meteors (crater, ejecta, fire), floods, volcanoes (lava: a hot
  liquid that cools to stone), wind, fire, earthquakes, maybe killer aliens.
- **Townscaper-style builder** (X2): a free-form terrain and weather tool
  for setting up little towns. People behave like the animals: they clear
  trees and build houses where the land suits (flat, dry, near water).
  Houses come from wave-function collapse on an irregular grid (relaxed
  quads, Townscaper-style), stacking on each other where the town is dense —
  so density grades from city to village to farmland to forest. Weather and
  terrain shape where it grows: rivers bring farms, floods move towns.
- **Zen mode**: no goal, weather on autopilot, a photo mode — a living
  screensaver of the reclaimed valley.
- **River relay**: the story levels joined by one river — what you send
  downstream (seeds, silt, poison) arrives in the next level.

## Build order

1. ✓ Kit + preview, and a trials level built with it: one gate of each kind
   around a start oasis (the validator's test bed, and a playable level).
2. ✓ Validator; tuning the gates it flags is under way.
3. Seed caches (easter eggs) in the kit and the level.
4. The valley's DAG towards the lab (R3), then the re-theme (N6/R5).
