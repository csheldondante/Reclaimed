# Unit minds on the GPU — U0 design note (Track B, 2026-11-10)

Plan: docs/handoff/GPU_UNIT_AI_PLAN.md. DESIGN §11/§12/§15/§24. Docs only; code starts at U1 once Track A's
citygen/haul line lands in fortress.

## State lives in one place: the unit row

Today's row is 6 vec4 (96 B, `units.wgsl` header). Two words carry the mind.

**The body/override state: `info` bits 12–14, as today, plus one value.**

| Value | Meaning | Status |
|---|---|---|
| WANDER (0) | No override: the job runs | Rename to NONE |
| CHASE (1), SWING (2) | FIGHT | Exists |
| TUMBLE (3), HELD (4) | DOWNED | Exists |
| FLEE (5) | Flee | New |

FIGHT and DOWNED transitions already happen in `unitStep` from GPU signals: notice's target, reach, hits, wind and
pushes. There is no second copy: the override is these bits, read through `overridden(info)` in `unitstate.wgsl`.

**The behaviour word: `f.w`, unused today, as u32 bits.**

| Byte | Meaning |
|---|---|
| byte0 | job: the behaviour bundle |
| byte1 | the job's state |
| byte2 | leg/mode: SURFACE (steer down group field) or ROUTE (a trip; trackA-haul's rider) |
| byte3 | reserved |

The job's state is never overwritten by an override, so when the override clears the job resumes where it was. No save
or restore is needed. *(Amends what was sent to Track A: the override lives in info, not byte3. Job kernels call
`overridden()`, so they don't depend on where it lives.)*

## Priority

The user asked whether fleeing can outrank a job. It can, as a fixed order of precedence:

DOWNED > FLEE > FIGHT > job.

| Override | Entered when | Cleared when |
|---|---|---|
| FLEE | hp < the kind's flee fraction, or notice sees a hostile within the kind's fear radius while the unit can't fight (CAP_FLEE, or a worker kind) | the threat has been out of notice for T seconds |
| FIGHT | notice gives a target and the kind fights | the target is lost |

All of this happens in `unitStep` in the same tick as the signal: 1–2 ticks of reaction, with no CPU involved.

## Goals and groups

The user asked whether behaviours are bundled by group. The bundle is the **job** (byte0), per unit. A **group** is a
goal that many units share, and units of any job may follow it:

- SURFACE mode follows a group's field;
- ROUTE mode follows a cached route.

The goals per override:
- **Flee:** walk up the threat field. One shared field is seeded on the GPU each tick from every unit that is hunting
  (notice's `f.y`) and relaxed only on the dirty front (§11).
- **Fight:** the hostile field (the existing hunt field), seeded on the GPU from target codes.
- **Follow/attack orders:** a field seeded from the target's row each tick by a seed kernel.

GOALS=3 and TARGETS=8 go. Their replacement: a field pool sized by measurement, with seeds written by kernels, not
uploaded.

## CPU ↔ GPU

**Orders, CPU → GPU, written when they change:**
- spawn, remove, rekind;
- set job, set group;
- field seeds for *places* (the stores, a site);
- the combat word;
- aim;
- a hit on one unit or an area;
- the side map;
- actors ≤ 8.

**Events, GPU → CPU:** the existing ring (`EV_*`), read async a few words at a time. Arrivals that end CPU-visible jobs
(TownLife phases), hurt and death with `by`, noticed/lost, side.

Routine work (haul, patrol, wander, guard return) emits nothing. Totals are GPU counters, read on demand.

**Watched rows:** ≤ 32 (the follow card, the selection), via `observe`.

**Removed:**
- `sync()` of every unit;
- `think()`;
- the CPU strike timers;
- the scope box read (U3).

The CPU strike timers go because damage applies in the step (DA-B32).

## Readbacks after U2

| Read | Size | When |
|---|---|---|
| Events | 16 B head + 32 B an event | when the head says there are some |
| Watched rows | ≤ 32 × 96 B | only while watched |
| Totals | 16 B | on demand |

There are no per-frame or timed reads in play.

## Representations

No new ones: the row, the existing field buffers, the event ring.

The inhabitants (U7) currently regenerate every creature's triangles every frame (up to 80 MB). As one crowd they become
unit rows drawn through Track B's instanced units path (the draw bench). Their rigs pose per instance; no triangle
rebuild.

## Cost on the phone

These are estimates, to be checked against the U4 toggle diff:
- **Decision branches:** add a few reads per unit in `unitStep`.
- **Field pool seeding:** one small kernel a tick.
- **Removed:** the full sync. That is 96 B × n plus a CPU pass per frame; at 1,000 units, 96 KB a frame mapped and
  parsed.

Expected: a net gain.

## Failure modes, each a test (unit or GPU tier) before code

1. An override preempts a job, then the job resumes from byte1 (GPU test: a hauler hit → FLEE → back to its leg).
2. A threat reaches a worker within 2 ticks (GPU test: the tick count from the threat's spawn to FLEE).
3. Event ring overflow. Today TownLife throws: the ring is 2,048 and a sync reads 256. New: every event is read in order,
   and an overflow is a counted, surfaced error, not dropped.
4. A dropped or stale target. The target is re-validated by notice each tick on the GPU; it doesn't depend on a CPU copy.
5. A guard knocked off its post walks back: after DOWNED clears, the job state GUARD steers to its post field.
6. All fields in use. The pool is sized by measurement; when it is exhausted that is a visible error, and nobody silently
   stands still.
7. Rekind, death or slot reuse during an in-flight event (the generation in the id; the test exists for spawn).

## Rejected

| Alternative | Why rejected |
|---|---|
| Keep the brain on the CPU with a smaller sync (the WIP's watched + queries approach) | It still polls per frame for raids and archers, and reaction waits on async reads |
| A behaviour tree interpreted on the GPU | Bigger than needed. Fixed job state machines plus an override precedence cover every behaviour listed (haul, guard, patrol, fight, flee, follow), with one switch per unit |
| A separate crowd for riders (trackA-haul today) | DESIGN §11 asks for one crowd. Riders merge as ROUTE mode (U5) |
