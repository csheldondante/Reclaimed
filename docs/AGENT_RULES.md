# Agent rules: how work gets built here

Every agent working in this repo follows these rules (they are imported into CLAUDE.md). The user, 2026-11-05: "A pattern
I'm seeing emerge is agents are building systems poorly then wasting cycles debugging bad design and hacky patches. It
also seems like they are not desrisking things like visuals, performance or edge cases during development."
The goal is to build things that work, quickly, without a trail of patches.

## 1. Design before code
Before writing a system, send main a design note of 15 lines or fewer, and wait for an answer if main asked for one:
- **Data flow:** where the state lives (GPU or CPU, which buffer or contract), and who writes and who reads it.
- **Readbacks:** what crosses GPU to CPU, how many bytes, and how often. The default is nothing per frame (the user: "I find
  CPU round trips are stupidly expensive on mobile").
- **Failure modes and edge cases** you can name now. Each becomes a test.
- **The cost on the phone:** the per-frame budget you expect, and how you'll measure it.
- **The alternative you rejected,** and why.
State lives in one place: derive it, don't copy it. Two copies that can disagree count as a design bug.

## 1b. Data movement and work are costs to justify
The user: "flag and scrutinize any large data readbacks or copies and try to come up with a way to avoid them and to avoid
computation when possible." And: "if you get rid of the CPU readback, properly engineer the GPU simulation to be intelligent
and parallel and follow the design performance will be fine. All the past slowdowns have been implementation issues not
design."
- **Flag every large transfer** in the design note and the report: GPU to CPU reads, CPU to GPU uploads, and GPU to GPU
  copies of whole buffers or textures. Give bytes, rate, and why it can't be avoided.
- **Prefer, in order:** no transfer (the consumer runs on the GPU where the data is); events or a small query result;
  dirty regions only; a whole copy only with a measured reason.
- **Avoid work:** a kernel runs only where something changed or is awake (sleep, dirty flags, indirect dispatch sized by
  the work), never over the whole window by default. Compute once and reuse (bakes, caches with versions) over
  recomputing each tick.
- Never trim a rate, add a cap or skip frames to hide a cost: remove the cause.

## 2. The riskiest part first
In the first hour, before the rest of the feature:
- **Performance:** a toggle diff (frame time with the feature on and off) at 412x915, `?q=low`, in the `town` lab recipe
  (the user's start town). Record it in the DEVLOG. Desktop is a proxy; at a milestone, the user runs the phone bench.
- **Visuals:** one shot at play zoom in the real game or the `town` recipe. LOOK at it, and read every on-screen string
  (docs/WRITING.md).
- **Edge cases:** the list from the design note, written as failing tests.
If one of these shows the design is wrong, stop and tell main. Don't build on a design you know is broken.

## 3. No patches
- Add no give-up timers, retries, "if stuck then teleport", clamps or special cases to hide a symptom. A stuck unit means
  finding what it's stuck on.
- Every bug fix comes with a test that fails before it and passes after.
- If the real fix is bigger than the task, say so to main with the evidence. Don't patch around it.

## 3b. Reach is an invariant
The user: "if they keep getting stuck in walls an obvious fix is to modify things along their path to be passable. Add a
gate or a bridge. The expectation is that they can get anywhere in or around the city." Every open place in and around the
city stays in the stores' connected component (the GPU reach). Town generation and every edit keep that true by changing
the world: a gate, a bridge, a ramp or stairs. A unit that can't get somewhere in the city is a bug in the world, never
something for the unit to work around.

## 4. Gates that match the game
- Behaviour gates run in a setting as real as the bug: the `town` recipe (the user's land, the real fortress claims) or
  the user's link at phone size. A scenario that passes in a world the player never sees proves little.
- A gate that passed while the game was broken is itself a bug: find out why it missed, and fix the gate.
- Before you report: the full unit suite, hallcheck, the lab scenarios you touched, the toggle-diff numbers, and the shot.

## 5. Small, finished slices
- One deliverable per brief, finished end to end in the real game: playable, measured, looked at.
- Iterate in unit tests and the lab, and run full-game scripts only at the gate (docs/TOOLING.md).
- Find code with docs/MODULES.md, and read only the lines you need.

## 6. Reporting
- Every report ends with **Hacks and limits**: each threshold, cap, nudge, timer, special case, mutable global, extra
  readback, or coupling between systems you added or kept, and each limit the design has (sizes, counts, what it can't do).
  Write "none" only if there are none. Main passes the list to the user.
- Report what's true: say what failed, what wasn't run, and the judgement calls you made.
- Main reviews every commit's diff for patches before it merges.
