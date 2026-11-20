# Nested scales lab: handoff index (2026-11-20)

Written by the orchestrating session at the end of a long context, so a new session can pick up any thread
without the conversation. One document per thread. Each says: what it is, what was built or measured, what
was decided, what is open, and what to do next. The record of each round is in `docs/design/NESTED_SCALES.md`
("As built (round N)"), `docs/DEVLOG.md` and `docs/BACKLOG.md` (items NS-…); these documents point there and
do not repeat it.

| Thread | Document | State |
|---|---|---|
| Stylized cliff columns (the active thread) | [CLIFF_COLUMNS.md](CLIFF_COLUMNS.md) | active, rounds 31-32 |
| Storage ideas: edge lines, slopes, fewer columns, hexes | [COLUMN_STORAGE_EXPERIMENTS.md](COLUMN_STORAGE_EXPERIMENTS.md) | measured, parked |
| Integer heights and exact means (quota idea) | [INTEGER_HEIGHTS_AND_MEANS.md](INTEGER_HEIGHTS_AND_MEANS.md) | agreed in principle, not built |
| Tiles: pregenerated and runtime, in the simulation | [TILES.md](TILES.md) | design talk only |
| Simulation and generator rulings | [SIMULATION_AND_GENERATORS.md](SIMULATION_AND_GENERATORS.md) | not started; the owner's top interest |
| Field mesh (surface nets) and the sheet draw | [FIELD_MESH_AND_SHEETS.md](FIELD_MESH_AND_SHEETS.md) | built, not default, open faults |
| Textures and the painted look | [TEXTURES.md](TEXTURES.md) | waiting |
| Gates, phone link, performance, process | [GATES_PHONE_PROCESS.md](GATES_PHONE_PROCESS.md) | several gaps |

## The owner's objectives (restated by the orchestrator, not disputed)
1. A huge world editable at every scale, tens of km down to 0.25 m.
2. Fast: 60 fps on a phone, streaming ahead at cruise, instant edits.
3. Interactive simulation at every scale (water, slumping, lava, wind as materials in the columns). What
   the owner cares about most. Not started.
4. Looks good enough: readable, painted, no pop-in, no distracting artifacts.

## Where things are
- Worktree `C:/Projects/Reclaimed-nested`, branch `nested-scales` (pushed). Page `nested.html`.
- Frozen phone copy: `C:/Projects/Reclaimed-nested-stable`, detached at d364fc8a (round 28), served on https
  port 5462 (`npx vite --config local/vite.https.mts --host --port 5462 --strictPort` from that folder).
  Link `https://192.168.1.3:5462/nested.html?smooth=1`. It does NOT have rounds 29-32.
- Builders start their own dev server on 5461 and stop it at each hand-back.
- Experiments kept and not used: branches `exp/nested-snap`, `exp/nested-edge-enhance`,
  `exp/nested-cliff-levels`, `exp/nested-b3-low` (each commit message says why).

## How the owner wants the work run (their words where quoted)
- "do more frequent updates with pictures. I want to see the failures along the way so I can learn with you."
  Builders hand back at the first still, good or bad; the orchestrator sends it on at once with what is wrong.
- Small single-goal rounds; one builder at a time on this machine (memory); derisk the riskiest part first.
- "I want to see screens before any changes": new looks go behind a switch, default off.
- Every report ends with "Hacks and limits"; every hack is a BACKLOG item.
- Design departures are flagged before a builder runs them. Check existing design first.
- Unused work goes on a pushed `exp/` branch with the reason in the commit.
- Builder rules that have mattered: one headless browser at a time, never unit tests while a browser runs, no
  source edits during a browser run, hard timeouts on browser scripts, Edit/Write tools only (no sed, no
  `node -e`, no heredocs), never stash, commit with `git commit -F` and the session trailers, never touch
  port 5462 or the stable worktree, nothing per frame on the CPU, no per-frame readbacks, at most 8 storage
  buffers per shader stage.
