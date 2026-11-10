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

### 2b. Fixed fields (NFIELDS 13 → 20)

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

## 2c. The field pool (replaces GOALS=3 and TARGETS=8)

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

## 6. Interface tests both tracks run (`test/gpu/unitminds-u2.test.ts`)

Through the `Units` contract only, with AgentUnits on Dawn. `update()` drains events and decides nothing.

| Test | Setup | Pass |
|---|---|---|
| an order for group g produces an arrival event | 12 units, `order(ids, go p)`, 40 cells away on open stone | each id gets `arrived` once within 30 s of simulated time; no `observe` is called |
| a hit in the step produces hurt/death with `by` | a guard and a raider (hp 3, damage 1) facing each other; no CPU `hit` | `hurt` with `by` = the striker's id, then `died` with `by` = the striker's id |
| a soldier ordered to guard p, knocked down, returns to p | guard at p, `strike` it 6 cells off with a lift | within 15 s, `query(p, 1.6)` finds it; `arrived` fires again for the guard |

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

## Rejected

| Alternative | Why rejected |
|---|---|
| A GPU-side pool allocator (atomic free list) | Every allocation follows a CPU order. A second allocator would be a second copy of who holds what. |
| Each attacker writes the target's hp | A cross-row write race: the target's own thread writes the same word in the same dispatch. |
| A per-strike EV_HURT from the attacker | Event volume grows with blows, not units (5,000-unit battles), and the hurt would arrive before it is applied. |
| One field per guard post | Exhausts the pool for wall posts. Posts ride ROUTE (U5), or share a group slot. Open question 2. |
