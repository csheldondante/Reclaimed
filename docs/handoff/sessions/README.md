# Handoffs for fresh sessions (2026-11-10, from the Track A street-lab/citygen session)

Each file is a self-contained brief for one fresh Claude Code session in `C:\Projects\Reclaimed`. Start a session, point it
at its file, and tell it to read `ADDENDUM.md` first: that file collects anything decided after these were written.

| File | Session | Depends on |
|---|---|---|
| `CITYGEN_CONTINUE.md` | Finish the GPU city generator in the game: routes and riders, opportunities growing districts, delete the old generator | — |
| `STREAMING_PHONE.md` | Panning keeps up on the phone: the light height layer (SF5), the city cache (DA-P2), sim asleep unless woken (SF6) | — |
| `BUILDING_GENERATOR.md` | Procedural architecture: building shape and style, editors, cutaways, visibility rules (rewritten 2026-11-11) | citygen contract (on fortress) |
| `CONSTRUCTION_SHADER.md` | The construction time-lapse shader (FONDACO technique) driven by per-lot progress | citygen contract |
| `GPU_AGENTS_FLORA.md` | Agents and plants fully on the GPU as designed: brains as GPU states, no per-frame unit sync, one crowd, no CPU flora mirror | Track B's GPU_UNIT_AI_PLAN |
| `LIQUIDS_IN_INTERVALS.md` | One liquid model in the column gaps (the §7 flow model): water under bridge decks, lava, sand, magma | — |
| `BUILDING_PHYSICS.md` | Generated buildings as physical structures: integrity, collapse, rigid bodies | citygen claims; best alongside the building generator |

## Rules every session follows (the user's, 2026-11-10)

- Read `.claude/docs/design/DESIGN.md` (the design authority) and `docs/DECISIONS.md` before proposing anything. Check
  `docs/BACKLOG.md` for existing items and parked work before building something "new" — work has been lost before by
  not finding parked steps (e.g. SF5).
- **Design review first.** Talk, then design with the user, then build. Present a design (the user's words quoted,
  systems reused, GPU ops and cost targets, a mock-up or shot) before any agent builds. Cheap-model subagents for
  research; fast small steps with quick visual checks (lab scenes, shots at play zoom); no full test suites.
- **GPU only.** "If it can't be instantly generated on the GPU or easily modified and recomputed locally then the design
  is wrong — come back to me." "If something is going on the CPU escalate and tell me why." The CPU passes inputs
  (choices, taps, seeds, small uploads); readbacks are a few words, async, after an edit. GPU timestamps, not wall time.
- **Phone first.** The Pixel 9a is the floor; perf claims need the user's phone bench (toggle diffs), desktop is a proxy.
  Phone links need https (WebGPU needs a secure context): a local self-signed config (`vite.https.local.mts`, git-
  excluded; see `CITYGEN_CONTINUE.md`) or GitHub Pages.
- **No merges or integration the user hasn't signed off.** Ask before pushing `main`. Each session gets its own worktree
  and its own `npm ci` (never junction or symlink node_modules); don't touch other worktrees or stop processes you
  didn't start. Track A dev ports 5600–5699.
- Every report to the user ends with **"Hacks and limits"** (thresholds, caps, nudges, approximations, coupling,
  CPU work), even if none.
- Camera: 60° pitch is the street-lab default and reads best; the game's default is still 30° (decide with the user).

## Where things are (2026-11-10)

- `fortress` (origin, 75140bd0): the street lab (M3a–M3i), the Next-season code reverted (30693c26).
- `trackA-citygen` (worktree `C:\Projects\Reclaimed-trackA-citygen`, NOT merged): the city generator in the game,
  `src/citygen/`, contract `src/api/contracts/citygen.ts`, design `docs/design/CITYGEN.md`, BACKLOG CG1–CG21. These
  handoffs live on this branch until it merges.
- `trackA-legible` (pushed, NOT merged): the GPU route graph with bridge decks (DA-A22: 1a6780eb, ace9c803, 0494bf80).
- Lab: `?skipmenu=1&level=streetlab&site=muru|river|mesa|mountain|coast`. Game:
  `?skipmenu=1&level=atlas&town=1&fresh=1&citygen=fields`.
