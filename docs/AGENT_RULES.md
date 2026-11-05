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
- Report what's true: say what failed, what wasn't run, and the judgement calls you made.
- Main reviews every commit's diff for patches before it merges.
