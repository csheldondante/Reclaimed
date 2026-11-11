# Track B — state at the stopping point (2026-11-11, fortress fce57e40)

The orchestrator stopped here at the user's request, after U2-FIELDREACH. This note says what landed, what is open and
what is waiting on the user. The design of record is `docs/design/UNIT_MINDS.md` (U0) and
`docs/design/UNIT_MINDS_U2.md` (U2 rounds, §5–§9). The plan is `docs/handoff/GPU_UNIT_AI_PLAN.md`.

## Landed in fortress (unit AI on the GPU)

| Step | What | Key numbers (desktop unless noted) |
|---|---|---|
| U1 | The Units contract went async; only watched units are read | sync 1,680 → 752 B/frame |
| FC12 | Block relaxation: a change crosses a chunk per sweep | 40-cell reaction 17–27 → 9–10 frames; phone cost within noise |
| Stage 2 | Line of sight on the obstacle-JFA clearance, seen-only targets, ranged units (`fire()` placeholder marked `REPLACE: GPU physics rigid bodies`), field bench `?fieldbench=1` | Pixel 9a: archers fire in 38 frames vs 119 with seen-only; LOS cost in noise |
| Round 5 | Place orders resolved on the GPU (`spawnAt`, `orderGroup`, `arrived`, `orderFailed`, PlaceRef with `else`/`also`); melee strikes on the GPU (DA-B32); LOS and seen-only by default; the GPU side map | — |
| Round 6 | `drill`, `man`, `march`; formations on any order; spawn opts; a failed spawn makes no units | — |
| Drillfix | Elastic chain-of-rows formations (squeeze, then spill rows past a threshold, with hysteresis); reassignment by position; alignment; `formation: 'loose'` (raiders); `discipline` jitter; dry spawn placement; `left(g)`; order groups ≥ 8 now processed; formation group set has no 32-bit limit | 15 through a 1.1 m gate: rows 10,5 → 1,1,1,5,5,2 → 10,5 |
| Round 7 | Every agents field on one GPU page pool; field rows and order groups sized from memory; per-side hunt and threat fields; side relation matrix | 40-cell reaction 8 frames; BFS-exact |
| Fieldcap | A full pool reports itself (`orderFailed('pool-full')`, a non-blocking warning, not fatal); pool budget 20 MB | — |
| Fieldreach | Fields take pages only in a box round seeds and walkers, growing on detours | 320²: 24 pages per field (was the whole window); about 100 order fields in 20 MB (was about 6) |

## Open (BACKLOG ids), in suggested order

1. **U2 round 8: route-mode riding.** Units on structures (walls, stairs, doors, floors, decks, roofs, bridges) are carried along baked routes (`routeAt`, z included), leaving the route only on an override (fight, flee, knocked off).
   - Track A bakes the paths (routeread, wall-walk first; the building generator bakes the rest).
   - `man` cannot arrive until this lands: 8–10 of 12 posts are reached by walking surfaces (U2-MAN6B).
2. **U2-CLEAR.** The obstacle plane treats any neighbour more than 0.25 m higher or lower as an obstacle. Use walking's step limit instead. Today in-town formations go single file where four fit.
3. **U2-RANKS.** 64 ranks per formation group is a fixed cap. It needs a rank count sized from memory and a per-group rank pool.
4. **U2-CHAIN.** Reassignment by position cuts crossings but doesn't remove them (9 pairs over 15 row changes in the gate test).
5. **Formation kernels** run over every order group while any group is in formation. Make them an indirect list of formed groups.
6. **U2-SIDEFLEE and U2-AUSIDES.**
   - Flee fields per side.
   - AgentUnits' fixed F.*/GOALS fields and factions onto sides and the relation matrix; they still use ids below 16 and the old hostile rule.
7. **U2-NAVWATER.** The deep-water link barrier reads the nav's lagging water, so an idle unit at a shore can wander in.
8. **Field-reach limits.**
   - The box never shrinks while a field lives.
   - A longer path inside the box wins over a shorter one outside it.
   - Threat fields and the old shared hunt and foes fields are unbounded.
9. **Small costs.**
   - The seed passes dispatch over full capacity.
   - A new page is filled by a single thread.
   - `ppMarkSlot` loops over every field row in use.
10. **Phone bench** for paged fields, formations and fieldreach. Only desktop has been measured since FC12.

## Units draw (parked by the user: "we proved meshes are viable")

- The Pixel 9a bench showed instanced meshes 3–5× cheaper than voxel figures at play size. Direction recorded: impostors at play size, models when zoomed in. The scene's 15 ms base is not this track's concern.
- Code: local-only branch `trackB-units-r2` (210df18b, design note `UNITS_DRAW.md`) and `trackB-units-local` in `C:\Projects\Reclaimed-trackB-units`. Round-2 WIP is in `stash@{0}` there and does not compile.
- Synty data lives only in `C:\Projects\Reclaimed-localassets\` and the worktree's git-ignored `public/local-assets/`.
- Those branches' push remote is deliberately invalid. Never push them, and never commit Synty-derived files.

## Waiting on the user (Phase 0, `docs/handoff/PHASE0.md` on branch `trackB`)

- Cloudflare Pages account steps; then the repo goes private.
- Licence: confirm each pack's listing is Standard EULA, and accept the "packed binary = embedded" reading, before any Synty asset ships.

## Worktrees (Track B)

| Worktree | Branch | Use |
|---|---|---|
| `C:\Projects\Reclaimed-trackB` | `trackB` | Phase 0 and audit docs |
| `C:\Projects\Reclaimed-trackB-u1` | handoff / u2 rounds | U2 rounds (ports 5710–5719) |
| `C:\Projects\Reclaimed-trackB-serve` | merges and fixes | Merges, the LAN phone server (5720), lab 5745 |
| `C:\Projects\Reclaimed-trackB-units` | `trackB-units-*` (local only) | Units draw with Synty (5730–5739) |

- Phone links are served over LAN https with a self-signed certificate. The config is in the orchestrator's scratchpad (`lanssl/vite.lan.mjs`), so it needs recreating in a new session.
- No servers are running at the stop.
