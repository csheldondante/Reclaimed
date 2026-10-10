# Handoff — 2026-10-10 (end of session 3)

For the next agent session. Read in this order: `CLAUDE.md` (rules,
commands, gotchas) → **`docs/BACKLOG.md`** (every open suggestion, with
status — the source of truth for "what's next") → `docs/DECISIONS.md` (the
user's own words, rounds 1–20) → `docs/ARCHITECTURE.md` (contracts) →
`docs/DEVLOG.md` (why each change was made, with measurements).

## Where things stand

Session 3 worked through feedback rounds 13–20 (~90 commits). The user's
latest verdict: "Overall I do think this current state is very good."
**Unpushed at the end of session 3 (local `main`, awaiting the user's
check — do not push until they say so):** `78deeb6` lightning craters (L1),
`adc7e32` round-20 notes, `d81ad6e` body feel (M1), `6c1b7d8` click ripple
(M2), `533c384` lightning targeting + chain (M3), `a783c51` night sounds +
frogs (M4/M5), `3ab876b` pitched metal (M6), and this handoff. The user has
**not checked lightning yet** (L1 + M3) nor the body feel / click ripple.
First thing next session: ask them to try these, then push
(`git push`). Everything before `78deeb6` is on
github.com/csheldondante/Reclaimed.

New this session, on top of session 2:

- **Sandbox = physics playground.** Layer brushes (pour from above, build,
  bedrock from below, dig), save/load (IndexedDB + `.reclaimed` files),
  undo, brush ring; a model atlas (`world/models.ts`: cars, bus, tanker
  truck/ship, ruins, tent, pylon, oil/water tower, smokestack, apartments,
  office tower) with thumbnails, placed at the mouse pick; 💥 Break (holes
  in anything); a physics garden (tower, chimney, diving board, bridge).
- **Loose ground (sandbox only so far).** All soft material is a stack of up
  to four fractional layers per column (dust, sand, ash, dirt, gravel) on
  whole-cell solid ground: smooth, strata, per-material wind threshold /
  repose / water mobility; wind-blown dust travels as particles that carry
  it and settle where they land; water carries it downstream; plants bind
  it. Converted from soft cells when the sandbox loads (`world/loose.ts`).
- **Rigid bodies.** Broken-off structure pieces are rigid voxel bodies in
  their own frame (CPU, `game/bodies.ts`); at rest they sleep where they lie
  (skewed), projected into the grid (`bodyProj`) so drifts bury them and
  water flows round them; they wake when hit, undermined or caught by a
  cyclone; Break and lightning split them; a budget crumbles the oldest
  into loose ground. Break detection: `game/fracture.ts` (islands, tipping,
  torque vs thickness). Feel: slow, heavy, soft contacts.
- **Weather/powers.** Up to four cyclones, no cooldown; lightning listens
  closely but tall metal within 40 cells draws it, chains back to the tap
  and sets it alight, and blasts a crater in whatever it strikes; every
  click is a ring of wind; storm outlines steady.
- **Title screen.** Human-skull-scale plants (tall grass, eye-socket
  flowers, a sapling), level models buried in dust (uncovered by finishing
  the previous level or blowing them clear), gentle gusts, a Sandbox button.
- **Sound (never heard by an agent).** Crickets/owls at night, frogs by
  greened water, metal rings by its size on a pentatonic scale, the chip
  sound on crumbles.

Perf (Xe-LPG iGPU): valley ~120 fps; sandbox ~60 fps at 1200×800 (draw
~4.5 ms: the loose sheet covers everything — worth optimising, ties to E5).
Levels take ~20–30 s to settle on load here (warmup), so headless shots
need `--wait 30000`.

## What's next (agreed with the user, round 20)

1. **N1 — architecture review first** (the user asked to revisit before the
   next big push): consolidate to one model — solid intervals; one loose
   stack for everything soft (move rubble, litter, ash particles' landing,
   and the valley's soil into it); liquids that carry it; wind particles
   that settle into it. Remove the remaining cell-level granular rules
   (`material.wgsl` slumping/erosion of soft cells) once nothing uses them.
   Write the outcome into ARCHITECTURE.md and talk it through with the user.
2. **N2 — the valley onto the loose ground.** Converting it naively showed
   its terraced rock through as contour stripes and the river carved a
   canyon during warmup: reshape the rock under soft ground (real-valued
   heights like the sandbox) and match river erosion to the old rates.
3. **N3/N4/N5 — the growth redesign** (talk first; the user liked it):
   taps grow only from existing green or seeded fertile ground (fertile =
   clean + moist + uncovered); seeds blown by wind spread it; puzzle-mode
   opening on the camera director; barriers to growth as level gates; wind
   strength, cyclones, storms unlocked by green; ancient seeds buried to
   find, plant or send down the river to the next level; every level has a
   river. Open questions for the user: what a tap on non-green does (only
   the wind ripple? a "why not" cue?); sandbox keeps free growth (agent:
   yes).
4. **N6 — story through environment:** the valley re-themed as a
   biological research base (biohazard sign, a lab), the highway's
   barricades (failed quarantine), the city's tents (plague). With C7/C9/C8
   (Highway, City, Port) still to build.
5. **F7c** (bodies step 3: impacts split bodies; structures resting on
   fallen bodies are held by them), **F12** (Creative Commons models
   voxelized by ray casting), **N7** red sludge, **N8** deformation (later).

## Things to check with the user

- Every sound (B9 + this session): howl, drag whoosh, grow, wash plops,
  rain, cyclone roar, chips on crumbles, crickets, owls, frogs, pitched
  metal.
- Body shattering after O1/O2 (session 4): impacts break bodies into
  pieces + rubble with dust; speeds capped at ~1.5× the topple. Knobs:
  SHATTER / IMPACT_* in `game/integrity.ts`, MAX_* in `game/bodies.ts`.
- Lightning: the metal pull (bonus 6 − 0.15·distance within 40 cells).

## Known issues

- A structure placed on a fallen body isn't held by it in the fracture
  analysis (F7c).
- Oil spilled on sand soaks in within ~2 s (by design; may be too fast).
- One headless test froze the page when it pushed bursts of synthetic dig
  events every frame; the real Dig tool and lightning ran fine — unexplained,
  watch for it.
- The valley and title still use whole-cell soft ground.

## Process notes (session 3)

- The user gives feedback in batches, often mid-task; record each in
  DECISIONS and BACKLOG first, ask only what's genuinely theirs, then work
  through. **Commit after every item** (the user stressed it, for reverts);
  push only after the user validates larger changes.
- Verify UI with real input (shot.mjs `--clicks`), not just function calls:
  a full-screen overlay once swallowed every click and scripted tests
  missed it.
- Measure, then claim: checkerboard, mass conservation, burial coverage,
  fall timings were all checked numerically (scripts in DEVLOG entries).
- WGSL: `target` and `patch` are reserved; a kernel that references a
  shared texture (e.g. `driftTex`, `bodyProjTex`, `editTex`, `strataTexR`)
  must bind it; storage-buffer budget is 8 per stage — use textures for new
  per-column fields.
- Windows shell: write test scripts to the scratchpad with the Write tool
  and pass them via `--eval "$(cat file)"`; inline `node -e` with backticks
  or `${}` gets mangled.
