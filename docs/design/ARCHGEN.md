# ARCHGEN — the building generator (design note)

Handoffs: `docs/handoff/sessions/BUILDING_GENERATOR.md`, the user's procedural architecture handoff (2026-11-11:
families behind one contract, extrusion + grammar first), `CONSTRUCTION_SHADER.md`. Decisions: DECISIONS 2026-11-11
"building generator".

## Two deliverables

1. **The streaming generator (now).** GPU, per lot, in batch: lot records in, buildings out, as a town streams in.
2. **The editor (later).** Tiny Glade-style gestures (stroke a wall, drag a footprint, pull a height, tap a wall for a
   feature) over a style's palette. It edits the same **plan** the generator writes, so a generated building is
   editable and the generator never does what a gesture can't.

## The user's direction (2026-11-11)

- "Since our goal is streaming let's see what we can do quickly and cheaply and what gives the most bang for our buck.
  My guess is just a good extrusion shape, textures and architectural ornamentation will get us most of the way there
  and can be done very quickly for a whole batch of lots in parallel."
- Windows painted for now: "We can add a LOD for cutaways later (in general I want to be as lazy as possible in terms of
  our compute)."
- A style profile per district, driven by the districts' opportunity cards.
- "Build whatever is fastest to iterate first and get the visuals and speed where you want it then wire it in through
  the API you establish."
- Look: "I really like the style of tiny glade … Townscaper is also nice if a bit simple. The phone in general is lowfi
  … PC will be higher resolution and show more detail."

## The shape of it: parts, expanded in the vertex shader

The generator does not write triangles. One thread a lot writes a handful of **parts**, a compact semantic plan:

| Part kind | What it is | Its words |
|---|---|---|
| `BODY` | a quad prism: 4 footprint corners, a bottom z, a top z per corner (shed slopes), a wall material | walls, floors |
| `ROOF` | over a quad: 4 eave corners (with overhang), 2 ridge points (gable: on the end edges; hip: inset; pyramid: equal) | roofs |
| `TRIM` | a band round a body: plinth, cornice, string course; or a parapet / crenellated strip | ornament |
| `STACK` | small prisms: chimneys, turrets, spires (a tall pyramid roof on a narrow body) | ornament |

A part is 16 words (64 B): kind, lot index, surface and flags, 4 corners (xy), z0, per-corner tops or ridge, params.
A lot gets a fixed slot of `PARTS_PER_LOT` parts, so one lot can be regenerated alone (lazy: a condition or a card
changes one lot, not the town). A compact pass then appends live parts to a draw list per kind and writes the
instance counts of each kind's indirect draw (no readback). Each kind is one instanced draw; its vertex shader builds
the shape from `vertex_index` (no vertex buffers, nothing big uploaded or stored).

Why parts and not meshes:
- Memory and streaming: about 64 B × ~10 parts a lot, against kilobytes of triangles.
- Laziness: generation is ~10 writes a lot; style/condition changes that keep the massing don't regenerate at all
  (the fragment shader reads the style).
- The plan is the semantic representation the later work needs: cutaways (slabs and walls by part), claims and the
  physics bake (a part is a convex-ish solid), the editor (a gesture edits parts), routes (roofs and decks are parts).

## Surfaces: procedural materials in the fragment shader

Each face carries its part's surface (wall, trim, roof, plinth) and face-local coordinates (distance along the edge,
the edge's length, height above the base). The fragment shader draws, from the lot's style profile:
- the material: plaster, brick, ashlar, half-timber; clay tile, slate, thatch (patterns from the coordinates);
- windows and doors, painted: bays fitted exactly to each wall's length, a door on the frontage edge at the ground;
  night lights in the windows later (SW-G6) for free;
- condition (soot, moss, wear) and the district's palette — no geometry changes.

Phone: the patterns fade to flat colour with distance/pixel size (derivatives); PC shows the detail.

## Construction shader (CONSTRUCTION_SHADER.md)

Every part vertex can give the construction shader: the lot index (progress per frame), local height in the building,
floor index (height / storey), a roof flag, the eave height (the roof part's base). Floors pop in whole: a `BODY` can
emit its storey slabs when the construction shader asks (later). Shells are closed so a clipped wall shows a dark
inside with culling off.

## Style profiles

A profile is data (a TS table compiled to a GPU buffer): massing rules (setbacks, wings, roof kind odds and pitch,
overhang, plinth, cornice, parapet/crenels, chimneys, corner towers), materials and palette, window rhythm. Starting
three: **homes** (plaster and half-timber, clay tiles, steep gables), **port warehouses** (brick, gables to the street,
loading doors), **keep and walls** (ashlar, crenellations, towers). Picked per district by citygen's `districtStyle`
word (style id, wealth, condition, banner — Track A owns the buffer and its WGSL accessor), defaulting from the
district's purpose.

## GPU / CPU

- GPU: generation (one thread a lot), compaction, drawing, materials. Dispatched indirectly from the town's count
  buffer; a newly made town's lots generated in slices over frames (Track A: a whole town's pipeline is 10–16 ms on
  the phone).
- CPU: the profile table compiled at load; encoding dispatches on townMade / lotsChanged / townDropped (Track A's
  lifecycle hook); the lab.

## Interface with citygen (agreed with Track A, 2026-11-11)

1. `FieldTownIO.buildings?: TownBuildingsSink` — `townMade(id, lots, xform)`, `lotsChanged(id)`, `townDropped(id)`.
2. `drawBuildings` (default true): off, `lotMesh`/`lmMesh` skip buildings and landmark structures (not the wall).
3. Claims stay citygen's; v1 shapes stay inside footprint × height (narrow features excepted).
4. `districtStyle`: citygen's buffer, `setDistrictStyle(town, district, word)`, saved in the town log; a small WGSL
   accessor snippet.
5. Neighbour context derived by the generator from the records.

## Steps

1. **Lab** (`archlab.html`): the captured Muru lots (data/lab/lots-muru.json), parts + materials, orbit camera at
   play pitch, phone size. Fast reloads. Judge massing and materials.
2. Style profiles and ornament; per-lot timing.
3. Wire in: the interface above, the game renderer's lighting and shadows, the street lab at play zoom; phone toggle
   bench.
4. Construction-shader inputs with that session; cutaway LOD later.
