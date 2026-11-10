# GPU unit AI — plan (DA-B2 finished, DA-B32, DESIGN §11/§12)

Status: **owned by Track B (2026-11-10)**; code waits on Track A's citygen/haul landing in fortress.

The user (2026-11-10, relayed by Track A): "tell track B to move the agents and plants to the GPU. I'm ok with async
readback for state changes if needed (like a behavior tree or something) but I prefer it's lightweight and that a lot
of routine behaviors like hauling between locations don't need it." They also asked:
- whether a state can shift flow-field priority (fleeing over a job);
- whether behaviours are bundled by group.

Reactions must come within a few frames; about 2 s is too slow.

**Scope, extended** (Track A brief `docs/handoff/sessions/GPU_AGENTS_FLORA.md` on trackA-citygen 5081e6b4):
- the units and combat below;
- work crews (`agents/crew.ts`, `buildcrew.ts`);
- one crowd: the inhabitants (`src/inhabitants/system.ts`) and trackA-haul's riders (`src/citylife/`) merge into it;
- flora with no CPU mirror: `flora/placement.ts standsAt`, `api/plants.ts planTree` and CPU felling go.

**Formats agreed with Track A** (sent 2026-11-10). One behaviour word per unit, trackA-haul's RID word 1, generalised:

| Byte | Meaning |
|---|---|
| byte0 | job: the behaviour bundle that picks the state machine |
| byte1 | state |
| byte2 | leg/mode: ROUTE trip or SURFACE field |
| byte3 | override (FLEE / FIGHT / DOWNED) plus the preempted state to resume |

- Overrides preempt job states in the same tick on the GPU, so reaction takes 1–2 ticks.
- A group is a shared goal field or route that units of any job may follow.
- Events reuse units.wgsl EV_*; haul events are numbered above 32.
- Routine hauling emits no events; totals are GPU counters, read async on demand.
- `src/shaders/unitstate.wgsl` holds all of this (U0).
- trackA-haul keeps the haul job states. Track B owns the crowd, the overrides, combat, the inhabitants merge and flora.
- Added slices:
  - **U5:** riders become unit rows (after haul lands);
  - **U6:** crews onto job states;
  - **U7:** the inhabitants merged;
  - **F1:** the flora mirror removed.
The user: "The whole point of flow fields was to make the AI entirely GPU and let units path and target based on their
state. So yes I would like that explicitly planned and half finished work merged if applicable but make sure you aren't
stepping on other agents."

## Where it stands (fortress fdaa3f34, verified)

`AgentUnits.update` (`src/units/agent-units.ts:463`) calls `agents.sync()` without `watch`. Every sync copies every
unit (96 B each) plus the events. That is one sync in flight at a time, so in practice every frame (transfers.ts:
`violates F24`). `think()` then decides on the CPU, unit by unit.

These are decided on the CPU from positions:
- the end of a go/guard/patrol job, by distance;
- the patrol's next point (`Math.random`);
- the flee goal (position + 18·dir);
- follow/attack goals, re-seeded when the target moves;
- hunt targets: 8 ranked, uploaded, the field re-seeded;
- damage from a swing (the GPU swings, the CPU applies the damage);
- defenders' strikes: a CPU timer and reach that bypass the GPU's wind-up and sight test;
- the parallel raid loop's distances and gate checks (DA-L4 deletes it).

The scope box is read back every 8 agent ticks; it lags, so units can walk out of the scope.

Already on the GPU:
- walking down shared fields, push, wading, drowning, fire, wind, tumbling;
- WANDER/CHASE/SWING/TUMBLE/HELD;
- notice targeting (notice.wgsl);
- arrival latches per field and per ride;
- road trips (roadride.wgsl);
- the event ring.

## Target design (one line each)

- **Every unit's behaviour is a state on its GPU row.** Transitions come from GPU signals: arrived, target noticed or
  lost, hp dropped, wind knock, flee threshold.
- **Goals are shared fields or routes, seeded on the GPU:**
  - follow, attack and hunt fields are seeded from target codes;
  - flee is a smoothed negative field;
  - a patrol picks its next point on arrival.
- **Fighting is one path for everyone.** Notice → close in → wind-up → hit applied in the step (DA-B32) → hurt/death
  events carrying `by`.
- **CPU→GPU traffic is orders only, written when they change:** spawn, remove, rekind, set group/leg/ride, seed a field,
  the combat word, aim, hits, side map, actors.
- **GPU→CPU is events plus watched units only:** arrived, noticed/lost, hurt/death, side-changed, raised/decayed; the
  followed or selected units (≤32).
- **The scope is built on the GPU:** units mark chunks, a compaction pass, indirect args. The box readback goes.
- **TownLife and the strategic layer stay on the CPU**, driven by events. They already are.

## Slices (each: design note, riskiest first, both test tiers, gates, toggle diff, phone bench at the end)

**U0 — design note** (docs only; can start now).
- The state table and the order/event formats.
- Field budget: today GOALS=3, 24 groups, TARGETS=8, 48 seeds; what replaces each fixed cap.
- Failure modes as tests:
  - an event ring overflow (TownLife throws today);
  - a dropped `noticed` leaving a stale target;
  - a guard knocked off its post;
  - all goal fields taken.

**U1 — salvage `phonefix-observe-wip`** (322962a3), rebased onto fortress after Track A lands.

Keep:
- arrivals ending go/guard/patrol;
- `noticed` on every target change;
- EV_SIDE;
- unit-addressed hits;
- rekind in place;
- huntTop on the GPU;
- observe/release with the watched-only sync;
- unitreads gather;
- `UnitView.at: V3 | null`.

Don't keep: the raid's per-frame `atPlaces` polling, the archers' queries, the defence timers. That loop is DA-L4's to
delete; give it the minimum it needs to compile.

Finish:
- the 131 type errors: lab snapshot async or observed; hero, runsit and play code observe what they follow;
- the unit and GPU tests;
- the lab gates `fortressraid`, `fortressfollow`, `fortressallbuilt`;
- the sync's KB/ms at 1x and 16x before and after.

Gate: `AgentUnits.update` leaves the transfers table's violations.

**U2 — the GPU decides.**
- Move think()'s per-unit logic into units.wgsl transitions (follow/attack/hunt seeding, flee field, patrol, the
  goal-field arrival).
- Strikes in the step (DA-B32).
- Defenders on the same fight state machine.
- AgentUnits shrinks to an order/event adapter.

**U3 — GPU scope.** Delete the box readback; indirect dispatch over the chunks the units mark.

**U4 — phone bench.** A crowd of 100 / 1,000 / 5,000 fighting and working, with the decision kernels toggled.
Shared with Track B's units draw bench (one link, one report).

## The gate: a battle playground (the user, 2026-11-10, relayed by Track A)

"Raids will be better when we have physics and agents working properly. I do want to test big agent battles and casting:
gusts, tornados, meteors, heat rays, lightning, raising the dead, Helsing [healing], hasting units, ensnaring in plants,
raising stone walls etc."

**U8 — `?level=battle`.**
- Built on the playground's station pattern (`src/levels/playground.ts`, `traitlab.ts`, `traitstation.ts`), not new
  infrastructure. The traits station already has a crowd, a lich and a sanctuary.
- Two armies of 100 / 1,000 / 5,000 and a spell bar.
- Each spell is a world operation or a trait/status (§14), never a CPU loop over units:
  - **weather (§6):** gust, tornado, lightning;
  - **impacts:** meteor, heat ray;
  - **raised by the trait system:** the dead;
  - **statuses:** heal, haste, ensnared (plants: a flora-field state plus a status);
  - **terrain put:** stone wall.
- Units become bodies on impact (§10, DA-E*; the physics lane is a dependency, not U-scope).
- Judged at play zoom on the Pixel 9a, with the U4 toggle-diff bench run in the same scene.
- It is the acceptance scene for U2 (fight/flee overrides), U4, U7 (creatures) and the units draw bench.
- The raid card (DA-L4) waits on it. Track A keeps raids out of its opportunity test.

## Not stepping on Track A

- **Ownership:** `src/agents/*`, `src/units/*` and `units.wgsl` are Track A's under CROSS_TRACK_CONTRACT. The user scoped
  Track A to "large visual instant modifiers and time lapse playback, not realtime simulation" (round 128r), so unit AI
  has no owner. Proposed: Track B owns the unit-mind lane:
  - `src/units/agent-units.ts`, `src/agents/{notice,reads}.ts`, the sync;
  - the decision kernels in `units.wgsl` and `notice.wgsl`;
  - `src/api/contracts/units.ts`.
- **What Track A keeps:**
  - routes, ride, `routes.wgsl` (DA-A22);
  - the plan;
  - TownLife and the crowd's orders (`fortress/crowd.ts`, `town/*`);
  - the raid loop's deletion (DA-L4).
- **Overlap:** `trackA-slice0` (active) and the WIP both change `agents.ts`, `fortress/crowd.ts`,
  `scenes/level/fortress.ts`, `agents.wgsl` and `units.wgsl`. **No unit-AI code starts until Track A has merged its
  onetown/slice0 line into fortress**, or the user names another branch point. U0 is docs only meanwhile.
- **Afterwards:** changes to the shared files go through the dependency log with a minimal interface test (the
  contract's rule 2): "an order for group g produces an arrival event", "a hit in the step produces hurt/death with
  `by`".
- **Worktree:** U1+ run in their own worktree with its own `npm ci`.
