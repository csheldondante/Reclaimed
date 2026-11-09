# Design note: the town's route network on the GPU (DA-A22)

Status: draft for the user (2026-11-09). Supersedes the CPU parts of DA-A13 (the edge net's cuts, the reach union-find,
the Router's searches). The user: "Why is this not on the GPU that's crazy? Stop putting shit on the CPU this is a GPU
engine" and "we absolutely should not have different mechanisms so it isn't even possible for reach and routes to
diverge."

## What went wrong
DA-A13 (`onetown`) deleted the GPU reach (`build/reachgpu.ts`, `shaders/fortreach.wgsl`: walkable surfaces from the
**live** columns, connected components by hook-and-jump, a fix field by relax/trace) and put a CPU union-find and CPU
Dijkstra over a **frozen** copy of the land (`groundCols`) in its place. That is why: levelled roads read as cliffs; a
flood or erosion can never cut a route; reach and routes are two graphs that disagree (482 vertices).

## One graph, on the GPU
- **Authored input (CPU, small, event-driven):** the plan. Which cell holds which structure, its levels, doors, gates, and
  the drawn paths' kinds per edge. These are uploaded as edits: bytes per changed cell or edge, only on a plan edit.
- **The graph (GPU buffers, built once a grid change):** the town grid's vertices (xy) and edges (two ends, two cells). It
  is static per town, uploaded once.
- **Cuts (GPU kernel, per edge):** the edge's walkability from the **live** columns at its ends and its middle.
  - Ground is the top walkable surface as the world stands: levelled ground, roads, bridges' decks.
  - A cut is water deeper than wading, a drop past SLOPE (otherwise stairs, `steep`), a wall, or a structure's solid.
  - It runs only for edges in chunks whose version changed (`sim/chunkver.ts`; plan edits bump the same versions), so a
    flood or erosion re-cuts exactly the edges it touched.
- **Reach = components (GPU):** hook-and-jump over the uncut edges (the old fortreach kernels, re-aimed from surfaces to
  edges). Reached means "in the stores' component". There is no second reach anywhere.
- **Routes = distance fields (GPU):** one field per destination group (the stores, each workplace a group rides to), by
  relax sweeps over the same uncut edges (the old fixRelax pattern). Each sweep stops when converged, and only the fields
  whose edges changed are recomputed.
  - A rider's route is traced down its field on the GPU into the shared route-points buffer that `routes.wgsl` already
    rides (t += dt·speed). Riders keep the queues.
  - Because routes come from the same cuts as reach, they cannot diverge.
- **Readbacks (async, tiny, event-driven):**
  - After a plan edit or a cut change, one word per structure (reached, plus the reason bits for a refusal), for the
    placement refusal text and TownLife's job board.
  - Nothing per frame, and no route points to the CPU.

## Towns level their ground (the user, same day)
"And have cities level mostly flat ground and small noise" / "As care about large elevation changes but visually these
don't look large".
- **The pass:** inside a town's area a GPU levelling pass flattens the ground. It runs at generation and when the town
  grows.
  - Small noise and gentle slope go.
  - Only large elevation changes stay. These become terraces, joined by stairs or ramps where a path crosses them.
- **Threshold:** provisional, and to be judged in shots with the user.
  - A step under one storey (4 m) inside the town is levelled away.
  - Larger steps stay as terraces.
- **How it writes:** through the existing column edit path, so chunk versions bump and the cut kernel above re-reads it.
  There is no separate "levelled ground" copy.
- **The world is changed; no rule declares a step walkable.** The user: "Small stuff within 1 building height should not
  block walking in a developed area" and "Use stairs and build ramps or modify terrain to flatten this noise."
  - The cut kernel stays truthful: SLOPE on the live surface.
  - The town keeps its height differences and shows them. The user: "I would rather have cities build paths and
    switchbacks and stairs or ladders or structure to change heights so we can see the elevation differences within a
    city. As long as it doesn't mess up legibility."
  - Where a path crosses a step, the town builds a crossing as a plan structure that claims columns. The kind depends on
    the drop and the room available: a ramp, a switchback, stairs, or a stair tower (for steep drops in a tight space: one structure, a door at the bottom and a door at the top, walkable inside as one node).
    Retaining walls give terraces their edges.
  - Levelling happens only within a structure's own site. Rewrite `solid.ts` `rampShape`/`rampRun` and `terrace.ts`
    as GPU passes.
  - Roads get wider for legibility: today a lane is 2 m and a main street 3.2 m, on cells of about 3.3 m. Anno 117 draws
    streets slightly wider than a tile. Judge it in play-zoom shots.
- **Outside towns:** a drop counts as a cliff only when it's large. SLOPE is re-tuned against shots: the drops cut today
  (median 3 m) don't look large on screen.

## Edge cases → tests
- A levelled road is never a cliff.
- A flood across a lane cuts it, and riders re-route or stand with "blocked".
- A gate shut versus open.
- A bridge deck over water.
- A planned (unbuilt) block isn't solid yet.
- A structure is one node: inside is walkable door to door.
- The stores themselves are moved.
- A field's convergence on the largest town (sweeps ≤ graph diameter; measured, not capped).
- Reach and routes agree: a property test over random edits.

## Cost on the phone
- Kernels run only after an edit or a version bump. Idle costs nothing.
- Expected per change: edges in the dirty chunks (hundreds) plus component and field sweeps over ~9k edges, which is
  sub-millisecond on desktop.
- Measured as a toggle diff in the `town` recipe at 412x915 `?q=low`, then on the phone bench.

## Rejected
- Keeping the CPU graph and feeding it a GPU cut readback: it keeps two homes for the graph and a readback per change.
- A per-column surface flood (old fortreach): it is correct but wider than needed. The edge graph is the network riders
  use and is about 30× smaller.

## Still on the CPU after this (flagged, next)
Layout derived from the plan:
- curve-road growth (`curveroad.ts`);
- insets and claims (`edgeview.ts`, `solid.ts`), where the footprint bug lives.
These should move to the GPU as the next slice (claims rasterised from the drawn tiles on the GPU, with roads unclaimable
by definition). TownLife's job logic stays on the CPU as event-driven game logic, reading only the per-structure answers.
