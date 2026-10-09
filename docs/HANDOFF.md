# Handoff — 2026-10-09 (end of session 2)

For the next agent session. Read in this order: `CLAUDE.md` (rules,
commands, gotchas) → **`docs/BACKLOG.md`** (every open suggestion, with
status — the source of truth for "what's next") → `docs/DECISIONS.md` (the
user's own words, rounds 1–12) → `docs/ARCHITECTURE.md` (contracts) →
`docs/DEVLOG.md` (why each change was made, with measurements).

## Where things stand

`main` on github.com/csheldondante/Reclaimed, all pushed. Session 2 worked
through user feedback rounds 4–12 (≈ 60 commits). The user's last verdict:
"this is all much improved… it's looking great overall."

What exists now (beyond session 1's valley, water, oil, fire, ecology,
structures, storms, day/night):

- **Wind:** one wind field texture (map wind + painted wind). Drags paint
  stacking strokes (breeze → gust → gale) that relax back over ~7 s; storms
  and the cyclone ride the field. Map wind is calm (30 %) unless a storm or
  dust storm is about. Tight circular drag → **cyclone**: a spline funnel
  that bends with the wind, made only of real debris it catches (dust
  coloured by the ground it came from), spat out at the top; batters ruins
  and junk, spares plants. Free, 20 s cooldown.
- **Ground:** soft materials and water drawn as smooth slopes (corner
  heights precomputed into a texture), rounded drift/water outlines. **Dust
  drifts** (fractional dust layer) that wind moves and shelter piles up;
  lost gardens and junk buried under them, uncovered by wind. Litter, ash
  and grime the wind strips and carries; grime blown into water washes away.
- **Life:** wilt/hostility per column (withering on bad ground), tap tiers
  (grass → flowers/shrub → tree; doomed versions wither on bad ground),
  seeds on the wind that green and clean, perching birds, petals shed in
  gusts, withered plants blowing away as flakes. Difficulty easy/medium/hard.
- **Consequences/score:** spilled oil and drowning drain Nature; burning oil
  makes smoke that pays back when dispersed; reclamation = ½ clean land +
  ½ staged life; Nature pays for deeds. Fire on oil films / oil on water /
  forests; trash only yields to fire or lightning (→ ash).
- **Intro/tutorial** (valley, first play): camera director with limits and
  flights; staged lessons ending in "a storm comes — strike the heap".
- **Title screen:** skull, ribcage and bones on a dust mound with
  diorama-scale plants; the same hands as the game; difficulty, reset;
  **a clickable model per level** (dam, car, tent, tanker, signpost).
- **Levels:** registry with per-level progress — the Dam Valley (built),
  Sandbox (built: editor brushes, weather placement, pause/speed), Highway,
  City, Port (shown as "coming"). `?skipmenu=1&level=sandbox`.
- **Audio:** ambient vs click buses, positional/zoom falloff, desolate howl,
  deep drag whoosh, unfurling grow, cyclone roar; `?audio=1` debug panel
  (levels, mutes, one-shot log). **No agent has heard any of it.**

Perf (Xe-LPG iGPU, 1400×800): ~3–4.6 ms draw depending on drifts on screen,
GPU total ~5.5 ms, 120 fps.

## What's next (agreed order, BACKLOG)

1. **C7 Highway** level — ruined cars along a road, half-buried in drifts
   (use the drift system and litter); oil from wrecks.
2. **C9 City** — blast crater, ruined blocks, field-hospital tents (an
   outbreak; theme handled with restraint).
3. **C8 Port** — tankers ashore, a seawall, **ocean waves and swell** (needs
   new water tech: a tide/swell boundary + wave shading/height; ties to B4).
Then the loose ends E1–E8 and the deferred B-items (phone hosting B1 is the
user's call — they said "later").

## Things to check with the user

- Every sound (B9): howl, drag whoosh, grow, wash plops, rain patter (the
  squeak was the old wash plink — fixed in `cea9df4`), cyclone roar.
- Cyclone look: deliberately subtle ("the motion will make it readable").
- Whether the sandbox editor covers what they want (undo/save are E8).

## Process notes (session 2)

- The user gives feedback in batches, often mid-task; record each in
  DECISIONS and BACKLOG, ask only when a choice is genuinely theirs, then
  work through autonomously with screenshots/GIFs (SendUserFile).
- Measure before claiming: many fixes this session came from probing
  buffers (particle kind counts, drift totals, wind field readbacks). Visual
  checks alone missed several (e.g. the dust ring hiding the funnel).
- Windows shell: inline `node -e` with backticks or `${}` mangles silently —
  write scripts to the scratchpad and run them, or use Edit/Write. Twice this
  session ARCHITECTURE.md got mangled code spans this way.
- Storage-buffer budget: fields added late are textures (wind field, drift,
  corners) bound at 14–17, to stay within 8 storage buffers per stage.
