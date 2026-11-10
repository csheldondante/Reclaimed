# Unit minds U2 — the GPU decides (Track B, 2026-11-10)

Spec: `UNIT_MINDS.md` (U0). Plan: `docs/handoff/GPU_UNIT_AI_PLAN.md` U2 and U8. DESIGN §11, §12 and §19. Docs and failing
tests only. No implementation until main reviews this note.

## 0. Corrections to U0, found reading the code

| U0 says | The code says | Consequence |
|---|---|---|
| `f.w` is unused and becomes the behaviour word | `f.w` is the side of the wall + 1, written by notice (`notice.wgsl:214-226`). `f.x` is the latch, `f.y` the target, `f.z` hunted (`units.wgsl:58-60`). Row `e` is full too. | **The row grows to 7 vec4 (112 B).** Row `g` = behaviour word, pool slot, order argument, timer (§1). |
| The step can add a few reads | `unitStep` already binds 8 storage buffers: nav, dist, units, occ, events, fire, lava, shove (`agents.ts:635`). 8 is the device floor (`gpu/device.ts:18`). | `occ` and `shove` merge into one per-column buffer (both are agents-owned with the same halves). The freed binding becomes `mail`: per-slot target positions, the strike accumulators and pool status (§3). |
| The fight is on the GPU | Only kinds with `notice > 0` swing: `worker = kind.b.w <= 0` gates it (`units.wgsl:658,677`). Defenders strike on a CPU timer (`agent-units.ts:947-967`). | FIGHT is gated on "has a target (`f.y≠0`) and the kind can fight (reach > 0, damage > 0)", not on the notice radius. |

## 1. Row `g` and the state

| Word | Meaning |
|---|---|
| `g.x` (u32) | The behaviour word, as agreed with Track A: byte0 the job, byte1 the job's state, byte2 leg/mode (SURFACE, ROUTE), byte3 reserved |
| `g.y` (u32) | The pool slot it follows (0xff: none); bits 8-11 hold a patrol's waypoint count |
| `g.z` (f32) | The order's argument: follow distance, guard radius |
| `g.w` (f32) | The override timer: seconds since a threat was last within fear (FLEE's exit) |

The override stays in info bits 12-14: WANDER(0)=NONE, CHASE, SWING, TUMBLE, HELD, and the new **FLEE(5)**.
`unitstate.wgsl` exports `overridden(info)`, `jobOf(g)` and `stateOf(g)`. It replaces the `routes.wgsl:1101` stub at U5.

Jobs (byte0): IDLE 0, GO 1, GUARD 2, PATROL 3, FOLLOW 4, ATTACK 5, FLEE_FROM 6, WORK 7 (the CPU routine: TownLife,
unchanged). Track A's haul jobs are numbered from 16.

## 2. think()'s decisions → GPU transitions

All of these run in `unitStep` (`units.wgsl:330`) unless a row says otherwise. A **new event**, `EV_JOB = 11`
(`other` = its reason: ARRIVED / TARGET_GONE / SAFE), ends a CPU-visible job. Routine transitions emit nothing.

| # | Today (agent-units.ts) | GPU signal | State change | Kernel / pass | Reads |
|---|---|---|---|---|---|
| 1 | go ends by arrival (`goalOf` :625-626, `absorb` :831-842) | arrival latch on its slot's field (`units.wgsl:648-656`) | GO WALK→THERE; slot released; EV_JOB(ARRIVED) | step | dist[slot], arrive radii |
| 2 | guard: walk to the post, stand there (:623-624) | latch in → POSTED; slot distance at its feet > the leave radius → WALK | GUARD WALK⇄POSTED (failure 5) | step | dist[slot] |
| 3 | patrol's next point, `Math.random` (:627-635) | latch on waypoint k | PATROL state k → (k+1) mod n. The first k is `hash(uid) mod n`. Waypoints are n ≤ 4 pool slots allocated with the order. | step | dist[slot+k] |
| 4 | flee goal = position + 18·dir (:636-644), by observing the unit | FLEE_FROM: the threat field distance at its feet > SAFE (30, today's number) | walks the FLEE field (§2b); then EV_JOB(SAFE), job IDLE | step | dist[FLEE], dist[THREAT] |
| 5 | follow/attack goal re-seeded when the target moves (:645-653, :730-735), both observed (`auto` :869-875) | the seed kernel moves the slot's seed to the target row's position each frame | FOLLOW WALK⇄NEAR by distance vs `g.z`, ×1.5 hysteresis; target gone → EV_JOB(TARGET_GONE), IDLE | `poolSeed` (new, before relax) + step | target row (generation-checked), mail pool status |
| 6 | attack: aim the target, idle when it dies (:924-935, :879-882) | ATTACK sets `f.y` at order time (`NP.sets`, as today); FIGHT takes over in sight | as 5, plus FIGHT | notice + step | f.y |
| 7 | hunt: 8 ranked targets, uploaded, field re-seeded (:892-916) | every hostile fighter's `f.y` | HUNT_H is seeded at each target's position. No ranking, no cap of 8. huntTop and the 128 B read go. | `huntSeed` (new, after notice) | f.y, target row |
| 8 | swing → CPU applies damage (:762-771) | swing lands at SWING_HIT, in reach and seen | the strike accumulates into the target's mail; the target applies it next step (§3) | step | mail |
| 9 | defenders: REACH/STRIKE timer, F.foes ≤ 6 seeds (:917-975) | `f.y≠0`, the kind fights | the same CHASE/SWING machine, down HUNT_D (seeded at defenders' targets) | step + huntSeed | f.y, mail |
| 10 | struck → turn on the striker (:781-785, CPU `aim`) | the strike's `by` is a unit, `f.y==0` and the kind fights | `f.y = by+1`, EV_NOTICED | step (own row; notice runs later, in sequence) | mail.by |
| 11 | hostile: hunt / work / wander regroup (:877-890) | override bits | no regroup: the step picks the field. FLEE→FLEE, FIGHT→HUNT_H/D, else the job's slot or group field | step | info, g |
| 12 | FLEE entry, new (U0) | hp < kind.fleeFrac·maxhp, or `f.z` (nearest hunter) < kind.fear while it can't fight | → FLEE; `g.w` reset while `f.z` < fear; out after 3 s with `f.z` > 1.5·fear | step | f.z, kind |
| 13 | combat words, actors, side map (:860-863) | — | unchanged: CPU orders written on change. Actors are written each frame (the hero moves). | — | — |

### 2b. Fixed fields (NFIELDS 13 → 20). *HUNT/THREAT/FLEE become per side: §9e*

| Field | Seeds | Written by |
|---|---|---|
| 0-6 | rounds (TownLife) | CPU, unchanged |
| 7 HUNT_H (was `targets`) | each hostile fighter's target | `huntSeed` |
| 8 HUNT_D (was `foes`) | each defender's target | `huntSeed` |
| 9 THREAT | each hostile with `f.y≠0`, plus CPU danger places (FLEE_FROM `from`, ≤ 8) | `huntSeed` + CPU |
| 10 FLEE | none: each surface's source value is −1.2·THREAT (a Brogue-style safety map: walk down it, toward open space, not into dead ends) | relax |
| 11-18 POOL (8 slots) | a place (≤ 4 seeds, CPU) or a target code (GPU) | CPU / `poolSeed` |
| 19 ROAD | the network | unchanged |

**Seeds are scattered, not gathered.** Today each surface loops over all 48 seeds for each field
(`agents.wgsl:367-372`). The new design is a `seedMask` plane (u32 per surface, one bit per field ≤ 32, 4 B × surfaces
≈ 1.6 MB at today's window). The seed kernels `atomicOr` it, relax tests a bit, and the kernels clear last frame's bits
from their own previous-seed lists. A field's "has seeds" bit and its restart bit become GPU words. Today they are CPU
uniforms (`AP.n2.w`, `n3.w`).

## 2c. The field pool (replaces GOALS=3 and TARGETS=8). *Superseded by §9b, the paged field atlas*

| Question | Answer |
|---|---|
| Who allocates | **The CPU only**, at order time. Orders are already the CPU's. The GPU never allocates, so no GPU allocator or atomics are needed. Place goals are keyed as today (`goalKey`, 2 cells) and shared by refcount. |
| Seeds | PLACE: ≤ 4 world points written once (48 B). UNIT: a target code. `poolSeed`, one thread a slot, reads the target row each frame and moves the seed. A move > RESEED_NEAR sets the slot's restart bit. A generation mismatch or death marks the slot DEAD in `mail`. |
| Follow / attack | one UNIT slot per target (shared by everyone following that target) |
| Flee | no slot: the THREAT and FLEE fields (2b) |
| Patrol | n ≤ 4 PLACE slots per patrol order (shared by key); the next point is a state change on arrival (row 3) |
| Who frees | the CPU decrements the refcount on the events that end a holder's job: EV_JOB, death, a new order, remove. At 0 the slot's seeds clear (`seed(f, [])`, as today). A DEAD slot's holders end their job on the GPU and emit EV_JOB(TARGET_GONE), so its refcount reaches 0 the same frame the events are read. |
| Initial size | **8.** Today's dynamic fields are GOALS 3 + targets + foes = 5. A fortress battle needs a muster point, a march target, ≤ 2 hero follow/attack orders and one 4-point patrol = 8. Measured in U8 and U4, then fixed. |
| Exhausted (failure 6) | `order()` throws `FieldPoolFull`, naming the keys held and by how many units. It surfaces as the fatal overlay (CLAUDE.md: no fallbacks). No unit is left standing silently. The test asserts the throw and that no unit is left half-ordered. |
| Memory | +7 fields × ~1.57 MB (agentDist is 18.8 MB for 12 at today's window, DEVLOG WM4) ≈ +11 MB, plus seedMask ~1.6 MB |

**Field cost on the dirty front (§11).** A settled field costs nothing. A field whose seeds move keeps its basin
dirty: a seed that moves δ changes values ≤ δ across its whole basin, above DIST_EPS (0.05). Today the front is shared:
`relax` runs every used field on every front chunk (`agents.wgsl:354`). So one moving follow seed makes every static
place field pay too. **U2 makes the front per field.** `dirty[ch]` becomes a field bitmask
(`atomicOr(dirty, 1<<f)`, the same word), and relax skips the fields whose bit is clear. That is FC10 (FRAMECOST §C)
for the cost of changing one constant. Expected cost: Σ over moving fields of (their dirty chunks, ≤ FRONT_CAP 32 a
sweep) × 64 columns × NAV_K, the same as today's worst case but no longer × all fields.

## 3. Strikes in the step (DA-B32)

| Step | Where | What |
|---|---|---|
| Wind-up | step, attacker | CHASE + reach + seen + cool ≤ 0 → SWING, EV_WINDUP (as today, `units.wgsl:680-684`). Reach and sight use the target's position from `mail.tpos[rd][slot]`, not `AP.targets` (which goes). |
| Hit | step, attacker, at SWING_HIT | still in reach and seen → `atomicAdd(mail.strike[wr][t].dmg, u32(damage·256))`, `atomicMax(.by, attackerId+1)`, `atomicAdd(.px/.py, push·SHOVE_FIX)`. Actor targets (`f.y & ACTOR`) emit EV_SWING as today: their hp is the CPU's. |
| Apply | step, the target's own thread, next step | read `mail.strike[rd][u]`, then zero it (the owner is its only reader; this step's writers use `wr`). Apply `hp -= dmg/256` and the push, the same as the AP.hits path (`units.wgsl:402-434`). Emit **one** EV_HURT with `other = BY_UNIT | by`, amount the sum. Death emits EV_DEATH with the same `by`. A dead or empty slot also zeroes its `rd` mail before it returns. |
| Positions | step tail | each unit writes `mail.tpos[wr][u] = (np, id+1)`. Dead units write 0, so a target that died last step can't be struck, and its generation is checked (failure 7). |

**The hp race.** No thread writes another unit's row. Two attackers striking one unit in the same tick both `atomicAdd`
into its accumulator. The integer sum doesn't depend on order, so no damage is lost. It is applied once, by the owner,
one step later, the same double-buffering `occ` and `shove` already use. `by` for that tick is the highest attacker id:
deterministic, but the same-tick co-attackers go unnamed (in Hacks and limits). One hurt event per unit per step from
strikes bounds the event volume by unit count, not by blow count (failure 3 pressure). CPU hits and traits still write
only their own rows, as today.

`mail` = one storage buffer: tpos 2×16 B, strike 2×16 B a slot (512 KB at 8,192 slots), plus pool status 8×16 B. It is
bound in the slot freed by merging occ and shove (§0). The tpos write is an extra 16 B store per unit per step. It is
needed because reading another unit's row inside the same dispatch is a data race.

## 4. AgentUnits becomes an order/event adapter

**Deleted:** `think`, `goalOf`, `holdGoal`, `releaseGoal`, `reseedGoals`, `assign`'s field choice, `targetsNow/Prev`,
`hunt`, `auto`, REACH/STRIKE/`cool`, `patrolAt`, and the swing→hit translation. **Kept:** the views, byGpu/fallen,
`hitBy`, combat words, the side map, the routine bridge, and event → contract translation.

| CPU → GPU | Bytes | When |
|---|---|---|
| order (job word, slot, arg) through an order queue drained by `applyOrders` (a storage list, no uniform cap) | 16 B a unit | on `order()` |
| pool slot (kind, ≤ 4 seeds or a code) | 48 B | on allocate / free |
| spawn, remove, rekind, regroup, hits, holds | as today | on the call |
| combat word | 16 B a unit | when it changes |
| side map | 4 B a column | when the rules change |
| actors + factions | 160 B | every frame (the hero moves) |

| GPU → CPU | Bytes | When |
|---|---|---|
| event ring head | 16 B | each frame |
| events | 32 B each | when the head says there are some |
| watched rows | 112 B × ≤ 32 | only while the game observes them; AgentUnits observes none of its own |

Steady play: **16 B read + 160 B written a frame.** Today, with U1: 752 B read.

## 5. Riskiest part: moving-seed fields

**HUNT, THREAT and UNIT slots have seeds that move, appear and vanish every tick in a battle.** A vanished seed leaves
values too low, which then count up across its whole basin (FC4: hundreds of sweeps, a front that never empties). A
whole-field restart on every death would leave the field empty while it refills. If this doesn't hold, fighters walk
stale gradients or the agents' frame spikes. That decides whether "fields for combat" (§11) works at 1,000 units.

**Build first:** `huntSeed` with seedMask for HUNT_H only, plus the per-field front. Then:

| Measure | How |
|---|---|
| Toggle diff | `?huntgpu=0/1` (today's CPU setTargets vs. GPU seeds) at 412×915, `?q=low`, the `town` recipe with a 200 vs 200 fight; then the U8 scene at 1,000. agents-relax ms mean/p95 (`?agentprof=1`), front chunks a sweep and carried past FRONT_CAP, recorded in the DEVLOG. |
| Correctness | a GPU test: after k sweeps, HUNT_H at each fighter's feet vs. a CPU BFS on the same tiny world; > 2 cells stale counts as a failure. Run while targets die at 10 a second. |
| If stale | the candidate (decided by the numbers, not now): **a source label per dynamic field** (u32 per surface: the seed it came from). When a seed vanishes, the surfaces labelled with it reset to FAR locally and refill from their neighbours. That is local, with no whole-field restart. It costs a plane per dynamic field (HUNT_H/D, THREAT: +4.7 MB). |

### 5b. Measured (round 2, 2026-11-10; the DEVLOG has the tables)

Built: `huntReset/Unmark/Set/Gone/Flip` (units.wgsl), seeds scattered into seedMask and read by relax (agents.wgsl),
the per-field front (FC10: a dirty word's low half is a bit per field, the high half carried), `?huntgpu=0/1`, the
seed-id fix behind `?huntsrc=1` (seedMask's second plane; `bySource` on `Agents.gpuHunt`), and `?fieldfront=0` (FC10
off). No row growth and no occ/shove merge: the seed kernels are their own pipelines (5 storage buffers), and relax
reaches exactly 8 with seedMask.

| Finding | Number |
|---|---|
| Correctness vs. a CPU BFS while targets die (`test/gpu/huntseed.test.ts`, 128² flat, 5 waves) | CPU seeds, GPU seeds, and GPU seeds + seed-id all match the BFS again in 45–54 frames a wave. It is the same in every mode: the propagation sets it (5c), not the count-up. |
| The last target dies (no seeds left) | CPU: empty in 3 frames (its restart). GPU: **never** within 240 frames (the FC4 count-up). GPU + seed-id: 4 frames. |
| Town, 200 v 200, 1x: relax ms, mean / p95 (two runs each) | huntgpu=0: 0.29–0.38 / 0.48–0.61. huntgpu=1: 0.23–0.31 / 0.34–0.47. +huntsrc: 0.25–0.31 / 0.46–0.52. fieldfront=0: 0.34–0.37 / 0.61–0.65. The run-to-run spread is as large as the differences. |
| Seed kernels | 0.02–0.03 ms a frame |
| Front | **Saturated in every mode**: 32 chunks a sweep (the cap), 90–110 asking, 58–78 carried, 99% of sweeps carrying. |

**Conclusion.** GPU seeding costs nothing measurable, and the field is correct while it has seeds. It needs the
seed-id fix, or an equivalent, to empty. The cost risk has moved: in a 400-unit fight the front sits at FRONT_CAP
whichever way the field is seeded, so fields lag by the cap, not by the seeding. FC4's "what is left" is the next thing
to examine before 1,000 units. Notice (0.5–1.1 ms) is the largest agents stage, ahead of relax.

*(Corrected by 5c: the 45–54 frames on the tiny map are the relaxation's propagation at the low tier's 2 sweeps a
frame, not the cap. That map never fills the cap.)* The seed-id fix is now the only GPU path (`?huntsrc` is gone).

### 5c. FC11: why the front is saturated, and what to change (round 3, 2026-11-10)

**What asks** (town, 200 v 200, `?huntgpu=1`, q=low: 2 sweeps a tick; chunk asks summed over a tick's sweeps; one run
each, see the DEVLOG for every run):

| Field | Asks a tick (changed / carried) | Its CPU seeds changed | Why |
|---|---|---|---|
| foes (defenders' targets, CPU-seeded ≤ 6) | 80 / 67 | 1,189 of 1,200 ticks | moving seeds re-marked every tick: the whole basin shifts by more than DIST_EPS |
| goal0–2 (AgentUnits' 3 shared goals) | up to 80–100 / 70–80 for whichever goal churns | 114–1,192 ticks, by run | goals handed between guards' posts, seeds moved within RESEED_NEAR: relaxed in place (count-up) |
| hunt (GPU-seeded, every raider's target) | 12–25 / 16–21 | — (0.04–0.23 seeds new a tick) | its seeds (guards) mostly stand, and only a cell change marks |
| each static field (rounds 0–6, road) | 12–16 / 12–14 | never | **the CPU's marks mark every field** (markChunks: ALL_FIELDS) |

There are no peel or column changes to speak of (1–5 peel ticks in 1,200).

**The hypotheses, each a toggle:**

| | Toggle | Result |
|---|---|---|
| (a) direct steering near the target | `?direct=R` (measured, then removed) | **Rejected.** Only 3–8% of hunters are within 10 cells of their target at any moment (hunter-to-target: <10 cells 116–315 of ~3,900 samples; 15–40 cells for 80%). Near a target the field is fresh anyway: reaction at gap 6 is 9–12 frames with or without it. It also read another unit's row in the step's own dispatch (a race). |
| (b) the cap | `?frontcap=64/128` | At 128 the demand fits: 92 chunks a sweep (the whole scope), 0 carried. relax ms (desktop, mean/p95): cap 32: 0.46/0.65; 64: 0.71/1.21 (a noisy run: notice was up too); 128: 0.53/0.65. On desktop relax is not bound by chunks; the phone's slope is unknown and must be benched. |
| (c) seeds that stay in a cell | `?seedcell=1` (a CPU seed that stays in its cell is no change; marks only for the fields whose seeds changed) | foes' seed changes fall from 1,189 to 116 ticks. The static fields' asks fall from 12–16 to 0.1, **but the total doesn't fall** (105 asked a sweep): the moving goal and foes basins fill the freed room. GPU seeds already behave this way (a seed marks only on a cell change). |

**Reaction latency, the acceptance number** (`test/gpu/huntreact.test.ts`: one hunter between two prey, its target
dies; frames until its velocity has any part toward the new one):

| Gap to the new target | 2 sweeps (phone tier) | 8 sweeps | 16 sweeps |
|---|---|---|---|
| 6 cells | 9–12 | — | — |
| 40 cells | 11–27 | 10–12 | 9–10 |

- Notice retargets in 1 frame.
- About 7–9 frames is the steering's own floor: velocity eases at 6/s, and a unit walking at 3 cells/s must cross zero.
- The cap made no difference here (32/64/128 the same), because one seed never fills it.
- Far reaction is set by how far a change travels per sweep, about 1–2 cells, times the sweeps per frame.

**Recommendation** (to build next, each with its toggle diff and the reaction test as the gate):
1. **Relax a chunk several times in workgroup memory per sweep** (a block Gauss–Seidel / fast-iterative relax: the 16×16
   chunk plus halo loaded once, K inner iterations, written once). A change then crosses a chunk per sweep instead of
   1–2 cells. At the phone's 2 sweeps this should bring 40-cell reaction from 11–27 frames to the floor, as 16 sweeps do
   today, with the same memory traffic per chunk. This addresses the acceptance number directly.
2. **Retire the CPU's moving-seed fields:** foes becomes HUNT_D, seeded on the GPU like hunt, and the 3 goals become the
   pool (§2c). They are the measured demand. The GPU-seeded field with 200 seeds asks ~¼ of what foes with ≤ 6 does.
3. **Mark per field** (seedcell's second half) by default: correct, and static fields stop paying for others' seeds.
   The cell quantisation of CPU seeds becomes moot once foes and goals are GPU-seeded.
4. **The cap:** keep 32 until (1) lands, then size it to the scope (128 fit this fight) and run the phone bench. A
   per-chunk ms slope on the phone decides it, not desktop.
5. Not (a).

**Notice spikes:** one run caught one. In that run every agents stage had a spike (maxima: notice 122 ms, relax 40,
step 33, hunt 8.9, against means of 1.6/0.75/0.12/0.04). That points at a whole-GPU stall rather than notice's own
work. Whether it was one frame wasn't isolated; not chased further.

## 6. Interface tests both tracks run (`test/gpu/unitminds-u2.test.ts`)

Through the `Units` contract only, with AgentUnits on Dawn. `update()` drains events and decides nothing.

| Test | Setup | Pass |
|---|---|---|
| an order for group g produces an arrival event | 12 units, `order(ids, go p)`, 40 cells away on open stone | each id gets `arrived` once within 30 s of simulated time; no `observe` is called |
| a hit in the step produces hurt/death with `by` | a guard and a raider (hp 3, damage 1) facing each other; no CPU `hit` | `hurt` with `by` = the striker's id, then `died` with `by` = the striker's id |
| a soldier ordered to guard p, knocked down, returns to p | guard at p, `strike` it 6 cells off with a lift | within 15 s, `query(p, 1.6)` finds it; `arrived` fires again for the guard |
| a march to an arterial with no gate yet fails with `orderFailed` (§9a) | 6 guards, `march(ids, {town 0, arterial 0, leave})` on a world with no town | `orderFailed(ids, 'no-gate')` once; nobody moves more than 0.5 cells |

## 7. Failure modes as GPU tests (same file, `test.fails` until U2 lands)

| # | U0 failure | Assertion |
|---|---|---|
| 1 | override preempts a job, the job resumes | a hauler (GO, WALK) is hit to flee hp; its state is FLEE and byte1 is unchanged; after it recovers, its job state is still WALK and it reaches its goal |
| 2 | threat reaches a worker in ≤ 2 ticks | a raider spawned in sight; the ticks from its notice to the worker's FLEE bits are ≤ 2 frames |
| 3 | ring overflow | more events than EVENT_CAP in one step → the overflow is counted in `Units.errors.lost`, and a contract `lost` event fires; no throw and no silent drop |
| 4 | dropped or stale target | a target removed with no event read: the next notice clears `f.y`; the attacker returns to its job; no swing at the empty slot |
| 5 | guard knocked off its post | (the third interface test, at the GPU-row level) after DOWNED clears, GUARD state is WALK, then POSTED |
| 6 | all fields in use | 9 distinct `go` places with 8 slots → `order` throws `FieldPoolFull`; the first 8 still walk |
| 7 | slot reuse during an in-flight event | A strikes B; B dies and its slot is respawned as C before the events are read → the hurt/death name B's id, C is untouched (hp full), and A doesn't strike C |

## 8. Calls Track A will likely need (proposed shapes, all optional on `Units`; nothing existing changes)

```ts
/** a unit's job ended on the GPU: it arrived (go, guard's first arrival, a waypoint never), its target is gone, it's safe */
readonly jobDone?: ((u: UnitView, job: UnitJob, why: 'arrived' | 'target-gone' | 'safe') => void)[];
/** overflowed events (failure 3), surfaced, not thrown */
readonly lost?: ((count: number) => void)[];
/** march: ride route r (U5 ROUTE mode), then walk to p; each unit's jobDone on arrival, `whole` once all have */
march?(ids: UnitId[], route: RouteId, to: V2, whole?: () => void): void;
/** a formation at p facing dir: rows × spacing; rank in the group by a GPU prefix over its members, one pool slot at p,
 *  then each steers to its offset locally (§19's "line up inside walls") */
formation?(ids: UnitId[], at: V2, facing: V2, shape: { rows: number; spacing: number }): void;
```

## 9. The user's answers (2026-11-10): design only, not built this round

### 9a. Every order argument comes from the CPU's own state (the GPU-resident rule)

Soldier orders carry intent by index, never GPU-derived data. If the CPU would have to read an argument back from the
GPU first, it becomes an index the GPU resolves. **A row whose source is a GPU read is a design bug.**

| Order (CPU → GPU) | Argument | Where the CPU got it |
|---|---|---|
| spawn | kind, place, side, hp | the game's own: the plan, a scenario, a raid |
| go / guard | a place (x, y) | The plan, authored on the CPU, or a tap (the camera's ray on the CPU's ground). The GPU picks the surface. |
| follow / attack | a unit id | the CPU's spawn result, or an event (noticed, hurt, death) |
| patrol | centre, radius, ≤ 4 points | authored |
| flee_from | a place or a unit id | authored (a spell's aim) or an event |
| **man** | town index, side? | The town's index in the CPU's plan. The GPU builds the slots from the town's wall-walk routes in routeread (a per-town table, asked of Track A). |
| **march** | town index, **arterial index**, leave | The plan's arterial number. The GPU reads routeread's header table (by arterial; filler gates after the arterials) and checks the entry and its generation (`routeValid`). An empty or stale entry rejects the order with **`orderFailed(g, why)`** on the event ring. |
| formation | rows, spacing; rank k = the unit's place in the order's id list | authored, and the CPU's own list |
| side relations | the side × side matrix (9e) | the game's diplomacy, authored |
| combat word, side map | a unit's side and flags; a column's side of the wall | the CPU's records; the plan's walls |
| hits, strikes | place, radius, push | the player's aim, or the game's spell |
| actors | the hero's position | the CPU simulates the hero |

**Bugs found, to remove:**
- Track A's order-facing readbacks go: `LivingTowns.marchRoutes` (route ids and generations read back), `askRoute`
  polling, and the `wallPosts`/`unreachablePosts` reads. Route ids stay on the GPU.
- Unreachable wall posts show as a **red in-world marker** drawn from Track A's GPU label, not as an error.
- Any game code that turns `Units.query` or an observed `UnitView.at` into an order's place should order by unit id
  (follow/attack) or by an authored place instead.

**`orderFailed(g, why)`** is a new event, EV_ORDER_FAILED; its `other` is the reason: NO_GATE, ROUTE_STALE or POOL_FULL.
- The contract gains `readonly orderFailed?: ((ids: UnitId[], why: 'no-gate' | 'route-stale' | 'pool-full') => void)[]`.
- Interface test: march to an arterial with no gate yet → `orderFailed(ids, 'no-gate')`, and no unit moves.

### 9b. The paged field atlas (replaces §2c's fixed pool of 8; the user: "yes move to pages for the fields")

| Part | Design |
|---|---|
| Page | One field over one chunk: 16×16 columns × NAV_K surfaces × f32 = **4 KB**. A dynamic field (GPU-seeded: hunt, threat, unit-target goals) has a second 4 KB plane for the seed-id (§5b). |
| Pool | One buffer of P pages and a GPU free stack (an atomic count and a list). Sized by measurement. 2,048 pages = 8 MB; today's 13 window-wide planes are 18.8 MB. |
| Page table | Per field id, chunk → page + 1 (0: no page, which reads as FAR): `u32 pageOf[f * nChunks + chunk]`. At today's window (~400 chunks) that is 1.6 KB a field; 256 field ids cost 410 KB. Field ids are what the CPU allocates (a goal, an order, a side's hunt): many, cheap, no fixed 8. |
| Who allocates pages | **The GPU, as the field grows.** When relax finds a finite value at a page's border toward a chunk with no page for that field, it pops one. The table entry is claimed with atomicCAS, so there is one pop per chunk. Growth is bounded by the field's reach budget: set by the order, default the scope. The CPU can't allocate pages, because where a field reaches isn't known without a readback (9a). The CPU allocates only field ids, and releases them on the events that end the last holder's job. |
| Freeing | A released field id's pages go back to the stack (a kernel over its table row). So do pages whose chunk leaves the scope. |
| Front | **Per page.** A dirty word per page replaces a bit per field in a chunk's word, so the 16-field limit of FC10 goes. frontBuild lists dirty pages and their same-field neighbour pages (through the table). relax runs one workgroup per page. FRONT_CAP becomes a page cap. FC12's block relaxation (tile + halo in workgroup memory) loads the 8 neighbour pages' borders once a workgroup. |
| Indirection cost | Relax: one table read per neighbour page per workgroup (9 per page), not per cell. Steer (`downField`): one table read for the unit's chunk, and one per neighbour across a chunk border (on average under one a step). Expected to be noise next to the 6 neighbour distance reads. To be measured by a toggle diff in the battle scene. |
| Pool full | A failed pop sets `pageFails` and emits EV_ORDER_FAILED(POOL_FULL) once a frame. The CPU shows it as the **fatal overlay**. The field still works where it has pages. |

### 9c. Manning walls: a formation along the wall-walk

`man {town, side?}`:
- The group marches by the town's routes to the stairs, then spreads along the wall-walk.
- Slot k sits at `s = k · spacing` along the town's wall-walk routes, concatenated and filtered by side. They come from
  a per-town table of wall-walk route ids in routeread, asked of Track A.
- There is no field per post.
- Arrival is the group's: one EV_ARRIVED when its last slot is filled.
- Unreachable posts are Track A's GPU label (the red marker).

### 9d. Formations on every march (road route or flow field)

| Part | Design |
|---|---|
| Anchor | One record per group on the GPU: a route position `s` (through `routeAt`), or on a field march a unit-like point steering down the group's field. It moves at its slowest soldier's speed, held back while the rear slots lag. |
| Trail | A field march keeps a ring of the anchor's last N positions with their distance along, so a rank is placed on the path behind it, not in a straight line. A route march uses `routeAt` itself. |
| Slots | Rank k (from the order's id list) gives row r and column c. `cols = clamp(floor(width(s_r) / spacing), 1, maxCols)`; rows follow from cols. The slot is pathAt(s_anchor − r·spacing) + normal · (c − (cols − 1)/2) · spacing. Where the way narrows, cols drop and the column lengthens. |
| Width | From routes, if Track A supplies it per point (asked). Otherwise a **clearance field**: a static paged field seeded at every surface edge a walker can't cross (a missing link, a drop, deep water), relaxed only on the dirty front (terrain changes). width = 2 × clearance at the path point. |
| Units | Each soldier's step reads the anchor and trail, written by an anchor kernel before the step, so there is no race. It steers straight to its slot when within a few cells and `sightClear`; otherwise it follows the group's route or field. |
| Cost | One anchor kernel per group per tick, plus one static clearance field. |

### 9e. Sides: a hunt field and a threat field per army (replaces "one threat field in v1")

| Part | Design |
|---|---|
| Side | A unit's side (army) is a small number in its combat word (today's faction byte, ≤ 255). |
| A side's fields | Two field ids in the atlas: **hunt[s]**, seeded at every unit side s's fighters target (§5b's kernels, filtered by side), and **threat[s]**, seeded at every unit side s's hostile fighters are, for others to flee. Being paged, each covers only the ground around its own army. |
| Finding them | A small table, `sideFields[side] = (hunt id, threat id, flee id)`, written by the CPU when a side is made (an order). A unit reads its side from its combat word, and its side's ids from the table: one uniform-sized lookup, no field index in the row. |
| Who is an enemy | The CPU writes a **side relation matrix** (≤ 16 × 16 bits: hostile, ally, neutral) once, as an order, and again when diplomacy changes. notice reads it in place of today's faction test (`mayFight`). FIGHT closes in down its own side's hunt field, which is seeded only at its targets, already enemies. FLEE reads one flee field per side, relaxed from the min over its enemies' threat fields. |
| Scaling | Pages grow with the ground each army covers, not with the number of sides: a side whose army stands in one corner costs that corner's pages. Relax work grows with the dirty pages of moving armies. Seeds: one pass over the units per frame for all sides (a unit adds to its side's hunt and threat fields), and only cell changes mark. Flee fields: one per side that can flee, each reading its enemies' threat pages where they overlap its own. |
| Dirty bits | The front is per page (9b), so the 16-field bit limit of FC10's dirty word goes; FC10 was a step on the way. |

## Rejected

| Alternative | Why rejected |
|---|---|
| A GPU-side pool allocator (atomic free list) | Every allocation follows a CPU order. A second allocator would be a second copy of who holds what. |
| Each attacker writes the target's hp | A cross-row write race: the target's own thread writes the same word in the same dispatch. |
| A per-strike EV_HURT from the attacker | Event volume grows with blows, not units (5,000-unit battles), and the hurt would arrive before it is applied. |
| One field per guard post | Exhausts the pool for wall posts. Walls are manned as a formation along the wall-walk (§9c). |
| A fixed pool of 8 field slots (§2c) | Replaced by the paged field atlas (§9b): the limit is pages, and memory follows the ground covered. |
| The CPU allocating pages for an order's reach | It can't know where a field reaches without a readback (§9a). |
| One threat field for everyone | Replaced by a hunt and a threat field per side (§9e). |
