# Handoff: procedural architecture — building shape, style, editors and cutaways

You are the orchestrator for a fresh session. Read `README.md` (rules) and `ADDENDUM.md` in this folder first.

## Goal (the user)
"I want a separate session to work on our procedural building and architecture style generator. It's an independent
body of work" (2026-11-10). The city generator lays out lots and draws each as a plain extrusion. This session makes the
**buildings themselves**: the full architectural style and building shape, dramatic and pretty, customizable through
**interactive editors**, with **cutaways** into towers and rooms. It's the priority after the town and season work.

## Read first (in this order)
1. **`.claude/docs/design/DESIGN.md`**: the design authority, agreed system by system with the user. These sections bind
   this work:
   - §3 Grids and External intervals: a building is its own grid (tile system), turned about z, and claims its space as
     External intervals. Exchange through open faces, buried ruins, and its own material tick later.
   - §5 Rendering: static geometry uploaded once in its grid's frame and drawn instanced. LOD swaps only off screen.
     Occlusion is handled by dither, slicing under a roof and orbiting. Later: zoom into a tower and cut away to a
     room during an opportunity's dialog.
   - §9 Structural integrity and §10 Physics: one baked voxel model per object serves deformation, fracture and
     projection into the terrain.
   - §17 Towns, one plan: one building system for generated and player buildings, and the generator never does what the
     plan API can't express.
   - §18 shape rules: a lone stack becomes a tower with a spire, 2×2 becomes a domed drum, enclosed cells become a
     courtyard, and walls get towers at the bends. Also the fortress that "can grow huge and impressive with spires and
     bridges and fountains and crystals and floating stones".
   - §22 UX: inspect a structure, close-up cutaways.
   - §23 Persistence: derived buildings are never saved; only the player's edits are saved, keyed by world position.
   - §24 Performance: the Pixel 9a is the floor.
2. `docs/DECISIONS.md`: the user's answers. Search it for look, camera, towns and fortress.
3. `docs/design/CITYGEN.md` and `src/api/contracts/citygen.ts`: the input contract (below).
4. `docs/design/SEASON_LOOP.md`, especially "Town moods", and `docs/design/LIVING_TOWN.md` (routes and riders).
5. `docs/BACKLOG.md`:
   - ST11 (trees and doodads in the gaps)
   - ST12 (superstructures)
   - TM1–TM10 (town moods, especially TM6 disrepair and TM7 banners)
   - SW-G6 (night lights)
   - CG items about lots

## Inputs: the citygen contract (on fortress)
- **`src/api/contracts/citygen.ts`:** one 24-word GPU record per lot and landmark site. A record holds:
  - parcel and footprint polygon;
  - frontage edge;
  - kind: building / park / plaza / landmark / field;
  - district and purpose id;
  - storeys, height and base z;
  - growth key;
  - a stable seed.

  Alongside the records are:
  - a count buffer;
  - a per-lot progress buffer (0–1), which drives construction and the time-lapse;
  - the town's placement transform.

  Claims are per record, so this session can take over a building's intervals from the town.
- **The town's named places** (`src/shaders/townplace.wgsl`, `src/api/contracts/townplaces.ts`): muster yard, keep,
  barracks, market and gates, plus `houseAt` / `lotAt` by rank.
- **This is the starting point, not the whole input.** The full style needs more:
  - a per-district style;
  - a per-lot condition (prosperous / worn / ruined / destroyed, BACKLOG TM6), which opportunities change;
  - the player's customizations;
  - neighbour context: the street side, corner lots, what stands next door.

  Propose the contract additions in your design; citygen (Track A) adds the fields.

## What to build (to be designed with the user first)
- **The style system:**
  - an architectural style as data: a vocabulary of parts and rules (massing, roofs, openings, ornament, materials,
    palette);
  - per district and purpose: port warehouses and quays, the keep and the growing fortress megastructure, a university
    on a hill, homes, markets, walls;
  - per condition: prosperous, worn, ruined, destroyed.
- **Building shape:**
  - massing from the footprint;
  - superstructures for large or irregular lots: a perimeter block with a courtyard following any outline, corner
    towers at sharp turns, and on round landmark sites a ring building with a central tower;
  - towers, spires and bridges between structures.
- **Interactive editors:**
  - a lab page to author and tune styles and see them on real Muru lots at play zoom;
  - later, player customization of a building, the only painting left in the game (DESIGN §17, 2026-11-10).
- **Cutaways:**
  - towers and rooms opened for the camera (slice under a roof, cut away a wall);
  - interiors as a zoom LOD, not separate scenes (DESIGN §5, §22).
- **Construction look:** the construction shader is its own session (`CONSTRUCTION_SHADER.md`, FONDACO technique).
  Agree the vertex inputs it needs: local height within the building, floor index, roof flag.

## Visibility and scale: the rules (the user, 2026-11-11)
- **Height follows footprint, not the reverse.** A wide plot can carry a taller building than a narrow one. A tall
  building on a wide plot occludes less outside its own plot, not more.
- **Narrow tall features are allowed:** spires, towers, chimneys and masts. They don't occlude much behind them.
- **Large structures are allowed but must be spaced** so they don't stack up behind each other. They will occlude what is
  behind them. That is an intentional trade: impressive scale and recognizable landmarks in exchange for less view
  into the busy city life behind. Cutaways reduce the cost.
- **Large structures carry foot traffic.** Walkways, bridges, arcades, decks and roofs are walkable and join the town's
  route network, so the city-life simulation shows across them, not just around them.

## Buildings bake their own paths (the user, 2026-11-11)
"Buildings in general should precompute paths that units move along. No sense in pathing when we have relatively fixed
geometry. We can remake at mutation/destruction as needed."
- **Every building generates its paths with its geometry:** doors to stairs to floors, wall-walks, bridges, decks, roofs
  and arcades. They are baked once from the shapes it builds and claims, not found by pathing.
  - Each point sits on the claimed surface within the agents' step of 1.1, so nothing floats or clips.
  - Each point carries a `routeWidth`, so formations narrow.
  - The paths join the town's route graph at the building's doors and ends.
- **Units ride baked paths.** Track B's ROUTE mode moves a unit along the path, its position interpolated with z included,
  like the riders' `routeAt`. A unit drops to the surfaces and physics only on an override: a fight, fleeing, being
  knocked off. The surfaces must still exist and match the path, so a unit knocked off has ground under it.
- **Re-baked on change:** a building's paths are remade when it is mutated, damaged or destroyed. A path whose surface is
  gone fails visibly (`orderFailed`) until the re-bake.
- **The first case is the town wall:** each run's path goes from its stair foot up the stair and along the deck
  (`trackA-wallstair`, routeread `wallWalkRoute`). Follow its format.
- **Where the code is:** the town routes are in `src/citylife/routes.wgsl` and the route-read contract in
  `src/shaders/routeread.wgsl` / `src/api/contracts/routes.ts`. Propose how building paths are stored and exposed (per
  building record, stable ids with generations) in the design review.

## Where it runs: GPU vs CPU (the user, 2026-11-11)
- **On the GPU:** anything that must stream in or happen with low latency. A town's buildings appearing as the camera
  pans to it, a lot rising when a card resolves, a condition changing. Per lot in parallel (hash + neighbour types),
  with no sequential CPU picking. Streaming is bandwidth-sensitive, so nothing large travels there.
- **The CPU is fine** for work that isn't low latency and doesn't happen during streaming:
  - authoring and compiling styles in the editor;
  - baking a style's part library or meshes at load;
  - building a player's custom design;
  - a one-off generation behind a loading moment.

  Say in the design which side each piece runs on, and why.
- No per-frame readback in play (DESIGN §24).

## Rendering notes
- **Instanced meshes are viable.** Track B's units draw bench (2026-11-11) found instanced meshes work on the phone, with
  impostors likely for zoomed-out views. Reuse that path (coordinate with Track B, the art_improvements session) and
  `render/meshinst.ts`.
- **Art to check before inventing:**
  - `structures/modules.ts`
  - `structures/dressmodules.ts`
  - `structures/tiles/*` (kept for cliff cities)
  - `render/meshinst.ts`, `render/treemesh.ts`

  The old `pieces.ts` and WFC facades are deleted. Track B owns art direction and assets, so coordinate.
- **Assets:** built locally only. No Cloudflare or other hosting. The Unity Asset Store packs on this PC have unchecked
  licences: never put them in the public repo, and ask the user before any use.
- **Trees and doodads in the gaps (ST11):** can be this session or a small separate one. A GPU scatter off roads and lots
  with JFA clearance:
  - orchards and gardens in empty districts;
  - a well and stalls on plazas;
  - quays, cranes and boats on the shore;
  - sparse trees along arterials.

  It follows the growth.

## Expressive town states (later, design for them now)
Opportunities should visibly change the town (the user, 2026-11-10, BACKLOG TM1–TM10):
- prosperous, ruined and destroyed buildings;
- disrepair under undead labour;
- banners per district mood;
- lighting moods and night lights;
- checkpoints, curfews, parades and plague carts (those are units, Track A/B).

Make condition, banners and lighting inputs of the style from the start.

## Physics and future city kinds (kept from the first handoff)
- **Physics.** Building physics is a separate handoff (`BUILDING_PHYSICS.md`), but it "may make sense to do as part of the
  improved building generators". Design the output so it can feed the physics lattice: one baked voxel model per object
  (DESIGN §10), claims per record, support and collapse from column space (§9).
- **Future city kinds to keep in mind:**
  - cliff and mesa faces with irregular 3D grids (`structures/tiles/*` is kept for this);
  - Bulwark-style radial spires with bridges;
  - waterfall, lake, treehouse and termite-mound cities.

## Process
- **Design review with the user before any builder runs.** Present:
  - the user's words quoted;
  - the systems reused;
  - the contract additions;
  - the GPU/CPU split;
  - cost targets;
  - mock-ups or shots.
- Small steps, judged in the game at play zoom (60°, phone 412×915). A style lab with real lots comes before the game.
- Phone bench (toggle diffs) for any frame-path change.
- Every report ends with "Hacks and limits".
