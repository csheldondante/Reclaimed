# Handoff: panning keeps up on the phone (light streaming first)

Read `README.md` (rules) and `ADDENDUM.md` in this folder first.

## The problem (the user, 2026-11-10, on the Pixel 9a)
"Panning doesn't seem to be able to keep up and it definitely could in a previous build … it seems to be behind in tile
streaming even away from the city." Production build (vite preview) is "still slow but maybe a little better".

## What the user expects (their words)
"We had a whole series of sessions dedicated to fixing that so the streaming starts light and then pulls in heavier data
with latency based on what is noticeable. It is supposed to stream basic tiles in from raw column heights and material
and make a lightweight render mesh while depth loads in. Simulation is allowed to lag that and is sleeping by default
unless woken by the player." "Even flowing liquid was supposed to be cached as steady state."
Also remembered: a branch where "the simulation paused during panning on phone and aggressively precached tiles and
cached a large region around the fortress" — find it (search all branches' commits and BACKLOG/DEVLOG) before building.

## What the code does today (checked 2026-11-10 on fortress; DESIGN §2, §5)
- In place (`tilesfirst`, merged): stand-in far land always drawn (SF2); baked tiles cover what the window doesn't draw
  (SF3); the planner (`src/scenes/planner.ts`) — look-ahead = speed × measured latency per layer, holes first, sim cut
  to 1 tick a frame while holes show (SF4); held river table for steady water on tiles (`riverheld.wgsl`).
- A tile is NOT made from raw heights: it generates the region's full columns on the GPU (`Atlas.regionInto`), runs the
  surface and render-fields passes (`render/tileworld.ts`), and bakes a G-buffer impostor (`render/tilecache.ts`).
- Parked / not built: **SF5** the light height layer from column tops (parked after 5.1 on a desktop measurement — tiles
  50–70 ms, saving "about a frame"; never measured on the phone), **DA-P2** city-centred residency keeping a large area
  cached (DESIGN §5 decided), **SF6** simulation only where visible + small buffer, asleep unless woken, **DA-B27**
  fast-pan holes on the phone (gate nondeterministic).

## Plan to propose to the user
1. Measure on the phone first: a tile's wanted→drawn split (generation / render prep / bake) and the pan bench's
   undrawn %, with and without `?citygen=fields` (a side-by-side bisect may already be in ADDENDUM.md).
2. Finish SF5 (light height+material layer the moment generation's first pass lands, drawn as a cheap grid), then
   DA-P2 (keep a large region around the city resident, phone memory permitting), then SF6.
3. Judge every step on the user's phone bench; desktop numbers are only a proxy.
