# Current state — 2026-11-09 (pivot handoff)

Written by the incumbent orchestrator for the two successor orchestrators (Track A, Track B). Everything below was verified
in the repository or measured in this session unless marked *unverified*. The pivot brief is
[PIVOT_ORCHESTRATOR_HANDOFF.md](PIVOT_ORCHESTRATOR_HANDOFF.md); the track memos are
[TRACK_A_STRATEGY_WORLD_ORCHESTRATOR.md](TRACK_A_STRATEGY_WORLD_ORCHESTRATOR.md) and
[TRACK_B_ART_ASSETS_ORCHESTRATOR.md](TRACK_B_ART_ASSETS_ORCHESTRATOR.md).

## Authority

- **Design:** `.claude/docs/design/DESIGN.md` (25 sections, agreed with the user 2026-11-05). It wins over the long
  "design of record" (claude.ai artifact B6JhsBFZrWGQtfn78TkJ7T) and over older docs in `docs/design/`.
- **The user's words:** `docs/DECISIONS.md` (newest first; rounds 128o/128p are this pivot's lead-up).
- **How work is done:** `docs/AGENT_RULES.md` (binding for every agent: design note first, riskiest part first, no patches,
  data movement and representations justified (§1b/§1c), gates that match the game, Hacks and limits in every report).
- **Open work:** `docs/BACKLOG.md` — the round-128o "DA-*" table is the current plan; everything in it is now **provisional**
  under this pivot (see "Paused" below).
- **Code map:** `docs/MODULES.md` (generated: `node scripts/modules-map.mjs > docs/MODULES.md`), `docs/ARCHITECTURE.md`
  (contracts), `docs/TESTING.md`, `docs/TOOLING.md`.

## User decisions for the pivot (2026-11-09)

- **Track A starts now and is not gated by Phase 0** (the user: "I would not delay the instant mutation track for the art
  track's requirement for the private repo").
- **Economy:** "Turns plus abstract resources for now with the plan that we might experiment with tracking physical goods
  instead in the future (it's better simulation but worse game design)". This supersedes DESIGN §18's "every good is
  physical" for the strategic layer; physical carrying becomes presentation. DESIGN §18/§21 need updating by Track A
  (flagged, not yet edited).
- **Baseline:** merge in-flight work only if green (it wasn't — see Branches).
- **Phase 0 owner:** Track B, with the user doing the account steps; Cloudflare Pages must be live before the repo goes
  private (GitHub Pages carries the phone test links today).
- **Launch:** each orchestrator starts in its own fresh Claude Code session with its package.

## Repository, branches, worktrees

- **Repo:** github.com/csheldondante/Reclaimed (public today). Integration branch: **`fortress`** at **437f6210**
  (worktree `C:\Projects\Reclaimed-fortress`). `main` is ~1,100+ commits behind and not used; ask before pushing it.
- **Line endings:** LF everywhere, pinned by `.gitattributes`; merge old branches with `-X renormalize`.
- **Worktrees:** many `C:\Projects\Reclaimed-*` folders exist. **Several `node_modules` are Windows junctions to another
  worktree's** — `git worktree remove` follows them and deletes the target's packages (this broke
  `Reclaimed-places\node_modules`, which `Reclaimed-fortress` links to; it needs `npm ci` after stopping stale Vite servers).
  Give every new worktree its own `npm ci`. Check `(Get-Item <wt>\node_modules).LinkType` before removing a worktree.
- **Branches with live work** (all pushed to origin):

| Branch | Head | State |
|---|---|---|
| `fortress` | 437f6210 | Integration baseline. Full suite green (1035 tests). On Pages. |
| `onetown` | c0ff931f | **Roads/reach/routes rewrite (DA-A13), green on its own** (842 unit, 182 GPU, all lab gates) but **not merged**: it predates fortress's fast-forward work. |
| `onetown-merge-wip` | d5a0333c | Merge of fortress 437f6210 into onetown. Typecheck, unit (846), GPU (189), most lab gates pass; **two gates fail every run**: `unitsonground` (a person stands inside warehouse #18 near the stores point from ~41 s) and `fortressallbuilt` with `&ffwd=0` (house at cell 1666 never built). Undiagnosed. Track A's first task. |
| `phonefix` | 9e87c16a | Already merged into fortress. |
| `phonefix-observe-wip` | 322962a3 | Unfinished Units-contract cutover (observe/release, `at: V3 \| null`, async query, watched-only sync). **Does not typecheck (131 errors)**; commit message lists what's left. Track A or the speed work owns it. |
| `onetown-roadgen` | — | Parked streamline road generator (the user rejected its look). Reference only. |
| `onetown-wip-grade` | 33f7bf18 | Parked "graded at generation" attempt. Reference only. |
| `forest` | beb2a51 | Paused flora "forests as worlds" epic (canopy presentation, forest floor) from before the pivot; pushed. Review with the user before resuming (Track B for looks, Track A for gameplay). |

## Build, run, test

- `npm ci` (own `node_modules`), `npm run dev` (Vite), `npm run typecheck`, `npm run build`.
- Tests: `npx vitest run --project unit`, `npx vitest run --project gpu` (Dawn, real GPU), or `npx vitest run` for both.
  Run **both tiers** before any hand-off (a unit-only run missed a GPU regression this week).
- Lab (fast scripted scenes, prefer over full-game runs): `node scripts/lab.mjs run scripts/lab/<scenario>.mjs --recipe town`
  (`RECLAIMED_PORT` to pick a port; each worktree its own). Scenarios: `fortressallbuilt`, `fortressharvest`,
  `fortressrecipes`, `fortresscarts`, `fortressraid`, `fortressfollow`, `fortresslanes`, `fortressoutside`, `unitsonground`,
  `quarry`, `ridespeed`, `stepbound`, `throwwall`, `speedcost`, `placebench`, … (`scripts/lab/`). The start-town fixture is
  `data/lab/town.rclt`; recapture with `node scripts/labtown.mjs capture` whenever the land generator's version moves.
- Merge gate for drawing: `node scripts/tilegate.mjs` (goldens are stale — DA-G7; fill rate pinned per adapter).
- Headless shots: `node scripts/shot.mjs` (see CLAUDE.md); it fails if a debug overlay blocks map input.
- GPU timing lease: timing runs (tilegate, benches) take a lease; behaviour runs can share the GPU but may lose the device
  if two runs collide.

## Phone (Pixel 9a, Mali) — the target device

- Pages URL pattern: `https://csheldondante.github.io/Reclaimed/<branch>/?skipmenu=1&level=atlas&town=1&fortress=1&fresh=1&q=low`
  (`&fresh=1` clears saved worlds; drop it only to test persistence).
- Benches: add `&perf=1&agentprof=1&speed=16&hitch=1` (perf overlay + hitch recorder with a per-pass table; overlays start
  folded and never block input), or `&speedbench=1` (one-link 16x toggle-diff bench, ~2.5 min, downloadable report —
  **not run on the phone yet**).
- Measured on the phone (fortress, 2026-11-06): planning holds the 30 fps cap; **16x after Build 12–20 fps**. Per-pass GPU
  timestamps on Mali are unreliable — attribute cost with toggle diffs (the speedbench), not per-pass timings.
- The user confirmed: building works on the phone; perf "looks great" at 1x.

## Working / partial / broken / not started

**Working (fortress 437f6210)**
- One town plan for generated and player-built towns (`src/build/plan.ts`, `site.ts`, `town.ts`); painting structures
  Townscaper-style; builders build the whole start town (lab: all blocks).
- One crowd, event-driven: `src/town/life.ts` (TownLife) with adapters `src/fortress/townwork.ts`, `src/settle/work.ts`;
  wired via `src/fortress/crowd.ts`, `src/settle/crowd.ts`.
- GPU agents (`src/agents/agents.ts`, `src/shaders/units.wgsl`): fast-forward (`src/agents/stepplan.ts`; relax/peel/draw/ride
  once a frame, units in strides with sub-moves), combat targeting on the GPU (`src/agents/notice.ts`,
  `src/shaders/notice.wgsl`, fight rules as data), tap pick on the GPU (`src/agents/pick.ts`), event ring sync.
- Readback discipline: `src/gpu/transfers.ts` + `test/unit/transfers.test.ts` (every read/large copy listed; violations
  named with BACKLOG rows). World API mirror reads pages on demand (`src/api/mirror.ts`). Per-chunk versions
  (`src/sim/chunkver.ts`) drive the agents' re-peel and the field mesh's rebuilds.
- Gates: import boundaries (`test/unit/boundaries.test.ts`), material tables, writing lint over every player-facing string,
  source encoding.
- Raids exist (button-only, `src/fortress/raid.ts`, `raiders.ts`, `defence.ts`), as a separate loop (see Broken).

**Partial / on branches**
- Roads/reach/routes rewrite (DA-A13) — `onetown`: grid-edge paths, curve main roads with tiles adapting
  (`src/build/curveroad.ts`, `edgenet.ts`, `edgeview.ts`, `townroads.ts`, `terrace.ts`), union-find reach with plain-word
  refusals, route queues (`src/agents/routes.ts`, `routeride.ts`, `src/shaders/routes.wgsl`), bridges drawn and claimed,
  incremental relay (~1.3 ms desktop). Merge with fast-forward unfinished (two failing gates, above).
- Units contract cutover — `phonefix-observe-wip`, does not typecheck.
- Opportunity system, living world, GM exist on the run path (`src/opps/*`, `src/living/*`, `src/gm/*`) **but nothing in
  the fortress uses them**.
- Traits on units exist (`src/traits/*`); no traits on places/fields; no mana spending, no spell UI.

**Broken / known problems**
- **City legibility:** the dense core hides streets at play zoom; paving between set-back houses reads as shadow
  (onetown). The user: visuals pass later; "Feel free to lighten it".
- **Passive simulation vs routes:** no GPU world check yet — erosion/flood/quarry changes after planning can cut a road
  unnoticed (designed as a "blocked" event + detour, DESIGN §12, not built).
- Riders on different routes overlap (DA-A12); bridges are drawn but not built or paid for; the start town shrank to 670
  blocks once roads went first (DA-A15); relay of an edit touching walls/gates/main streets is whole-town (DA-A16).
- Raids are a separate loop with combat-only rules (hit-point walls, `Fortress.breakBlock`, timed house burns, CPU strikes
  landing on whoever stands at the target) — DESIGN §19 forbids these; DA-E4, DA-B32.
- Five day/turn clocks coexist (economy 60 s, day/night 480 s, settlements 600 s, living 3 days a turn, run minutes) —
  DA-L1.
- World doesn't persist between runs (each run is a fresh world, earlier runs pruned) — DA-L5; DESIGN §23 says it must.
- Rendering: tile specks during fast pans (DA-B27; user's hypotheses: first bake top layer only, or cutaway); an
  unexplained 129 ms phone spike; tilegate goldens stale (DA-G7).
- 16x on the phone: 12–20 fps; the wind field recomputes a band of map wind every tick (whole field per frame at 16x);
  particle visuals run every tick (DA-B30).
- `Reclaimed-places\node_modules` (and the junctioned `Reclaimed-fortress`, `townlab`) are broken; the user must stop stale
  Vite servers (ports 5231, 5211, 5241, 5333, 5341, 5391, 5347, 5350) and run `npm ci` there.

**Not started**
- Turn controller / opportunity loop in the City POV; resources (Magic, Might, Labor, Resources, Intel, Unrest);
  instant validated mutations; modifiers; spells (wheel/runes); persistence across runs; GPU destruction trigger and one
  physics solver (DA-E*); page system rewrite (DA-P*).

## Paused by this pivot (provisional, review before resuming)

All BACKLOG round-128o rows not named in a track's first slices. In particular: DA-P* (pages), DA-E* (engine), DA-B27
speck, DA-A12 queueing/passing, art polish. Keep them as context; don't resume without the user.

## Warnings

- `src/build/*` and `src/agents/*` are shared and hot (roads, routes, agents, fast-forward all touch them). See
  CROSS_TRACK_CONTRACT.md.
- Generated land is per-device (floating point); the phone generates a different world than the desktop (TL-15). Lab
  fixtures are desktop-generated.
- Any file counted by `GEN_VERSION` (land generator sources, currently too broad — DA-A9) forces a fixture recapture and a
  one-time regeneration of saved regions.
- Unity Asset Store packs (`C:\Users\cshel\AppData\Roaming\Unity\Asset Store-5.x\`, including Synty Studios) must never be
  committed to this public repo or put in the Pages build.
