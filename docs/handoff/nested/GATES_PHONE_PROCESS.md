# Thread: gates, the phone link, performance, process — SEVERAL GAPS

## Gaps a new orchestrator must know first
1. **The self-test has not completed since round 28.** `node scripts/nested-selftest.mjs --chromeargs
   ignore-certificate-errors --port 5461` was killed for low memory in round 29 and stopped at a 10 minute
   limit in round 31 (last stage logged: "smooth coverage in the rim shaft"; no errors, holes or bad edges up
   to there). Rounds 29-32 are ungated by it. Step B3 was asked to run it with a 25 minute limit.
2. **No phone measurement exists for anything after round 27.** The owner's screenshots of round 27 showed
   17-43 ms frames; round 28's level-thrash fix probably explains them, unverified. Every frame time since is
   desktop, headless, capped at the display rate (read the GPU pass ms, `?gputime=1`).
3. **The phone link is at round 28** (see README.md). It moves forward only when a round passes its gates.
   The owner: "Definitely don't give me something with crappy performance that still has holes."
4. **A phone bench page for the lab was proposed and never built.** The owner's rule: every perf test is a
   phone bench they run (screen awake, downloadable report); toggle a system and diff frame time, do not trust
   per-system timestamps on tiler GPUs.
5. **Shader compile timing on this machine swings 1.5-2.5x between runs.** `test/gpu/nested-compile.test.ts`
   fails some runs on untouched code (`sheetBake` 1020-1177 ms against 1000; NS-251, NS-253, NS-262). Use
   medians of alternating runs. New looks go in separate module variants so default pipelines do not pay
   (an override alone still cost the defaults ~12 %, NS-260).
6. **The boot gate has crept** (512 MB reload line 18.1 -> 20.0 s against 19.0; derive compiles in 7.6-9.1 s;
   NS-229). Generated terrain arrives 43-45 s after a cold load. The owner said not to optimise load time yet.
7. `scripts/nested-perf.mjs` thresholds fail before and after round 25 on this machine (shared GPU).

## Machine
32 GB, often short of memory; a background server was killed by the low-memory reaper once (do not restart a
reaped command without being asked). One builder and one headless browser at a time.

## Process corrections the owner gave during this stretch
- "Can you pause and think for a sec? What are our objectives and what's in the way?" (too many rendering
  rounds, oversized multi-goal rounds, no phone bench, piling options).
- "do more frequent updates with pictures. I want to see the failures along the way so I can learn with you."
- "What happened to faster more frequent updates? With intermediary results and you breaking things into
  smaller faster chunks?" (the orchestrator had again stacked five tasks on one builder). One small result per
  hand-back.
- The orchestrator misread the owner's intent several times in the cliff thread (random-height tops, sunk
  columns, shifted rows). When a message is ambiguous, state the reading in one line and build the cheapest
  version; do not stack more work on the guess.

## Small leftovers
- Empty folder `C:/Projects/Reclaimed-nested-r25base` could not be deleted.
- `docs/design/NESTED_SCALES.md` has a stray "(round 3; the owner's ruling …)" fragment after "As built
  (round 29)"; a heading looks lost (NS-240).
- Round 28's builder used an Opus 5.5 trailer on its commits instead of the specified one.
- Older: carry DESIGN.md §1 air correction to the terrain/loop branches (fortress needs the owner's sign-off).
