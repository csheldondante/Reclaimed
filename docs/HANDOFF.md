# Handoff — 2026-10-08 morning (session 2, overnight)

## Overnight (round 6 batch) — for the morning

Done (DECISIONS round 6, DEVLOG): withering plants (wilt system), tree seeds
on the wind + birds shedding seeds, free grow-tap (sparkles / brown flecks),
wind-strippable litter (ring around the healthy patch), phone-ready touch
controls and layout.

To decide together:
- **Phone hosting** (Android Chrome): WebGPU needs a secure context, so
  `http://192.168.1.3:5173` won't work from the phone. Options: GitHub Pages
  (public https build), local HTTPS dev server (self-signed cert, home Wi-Fi
  only), or a tunnel (cloudflared/ngrok). Then open with `?q=low`.
- **Next features (deferred by agreement):** event camera that pans/zooms to
  firsts + a diegetic tutorial built on withering/seeds/litter; sandbox mode
  (deposit/remove-layer brushes — fits the column-interval format; needs
  same-material merging and occasional CPU repack because chunk K is fixed
  at load + 2 headroom); water life (fish, reeds/lilies); wind waves
  (shaded cheap, true height harder).
- Tuning to confirm by eye: wither speed, seed amounts, grow-tap strength,
  litter density, fire spread.


## Session 2 (round 4 feedback) — done, needs the user's eyes/ears

All twelve round-4 items are implemented (DECISIONS round 4; DEVLOG has the
measurements): advected smooth wind; drag-wind everywhere that steers storms
(no arrow); ground debris lifted by wind; dust storms + haze; a high, thin
storm deck with rain from its base and a lighter storm shade; whole-scene
lightning flash; moon arc + soft sliding shadows; perching birds that flush
only from trees they're in; ambient/click audio buses with zoom and
distance falloff; sludge pools, oil slicks and trash heaps; goal 45 %; a new
higher-resolution menu skull, ribcage and dust mound.

To check with the user:
- **Audio** (never heard by an agent): ambient level vs. clicks, zoom
  falloff, drag whoosh, flutter only when birds really leave.
- Wind feel: is the drag gust strong enough? (strength = cursor speed × 0.12)
- Shadows do move with the sun, but an 8-minute day makes it slow to notice;
  a shorter day (`?day=`) is a design call.
- Dust storms at the start: two cross the map in the first ~minute.
- Sludge is persistent until diluted/flushed; is the cleanup loop clear?


For the next agent session. Read `CLAUDE.md` first (rules, commands, gotchas).

## Where things stand

The design doc's milestones M0–M4, plus three rounds of user feedback, are
implemented, committed and pushed (`main` on github.com/csheldondante/Reclaimed).
The user called the current state "a good checkpoint, but it still has issues",
and has **new feedback ready for the next session**. Start by asking for it.
Don't assume the open questions below are the priority.

What's playable (details in `docs/STATUS.md` §2):

- **Menu:** a skull diorama whose state follows saved progress. Begin/Continue
  opens the 256×256 valley.
- **Controls** (diegetic, no tool buttons):
  - LMB tap under a storm's shadow → lightning; elsewhere → tactile responses
    (cracks + stone sounds on masonry, clang on tanks, splash, leaves/birds).
  - LMB drag under a storm → gust. Hover → breeze.
  - RMB pan, MMB/wheel zoom, **R**/☁ summon a storm, **Space** life lens.
- **Systems:** layered voxel columns; granular material + structural collapse;
  water; oil (sealed in tanks until breached); contamination; moisture; fire;
  ecology with biomes; GPU particles; analytic wind and storms; day/night;
  procedural audio.
- **Goal:** reclamation bar (living share of the map). The level ends at 60 %,
  and progress is saved for the menu.

Performance (Intel Xe-LPG iGPU, 1600×900, storm + fire): ~6 ms GPU, ~100 fps.

## Verification you can do (and can't)

- `node scripts/shot.mjs` with `?skipmenu=1` gives screenshots, GIFs, scripted
  clicks/drags and buffer probes (see CLAUDE.md). Claude in Chrome was never
  connected in session 1.
- **Audio has never been heard by an agent.** Every sound decision is unverified
  except through the user's comments.
- Mobile/touch and discrete GPUs are untested.

## Known issues and rough edges

1. Water running down slopes renders stair-stepped (box side faces).
2. Rubble falls effectively instantly (one cell per tick at 60 Hz).
3. Rainwater fills roofless building shells and stays there.
4. The canopy sub-voxel march keeps depth at the box face (intersections are slightly off).
5. The menu skull is low-fidelity voxel art; its readability is unconfirmed.
6. Big storms (r 60–85) can dominate the view; cloud density is a taste call.
7. Living share counts moss (veg ≥ 0.5), so the bar moves fast early. The goal
   is 60 % (~10 game-minutes with regular storms).
8. Fire burns spilled oil away completely (no soot/ash residue).
9. Tap-chipping now really damages masonry (~12 taps topple a piece). The user
   asked for cosmetic decay plus a falling-stone feel; check this is wanted.
10. A few judgement calls are still open in `docs/STATUS.md` §5 (economy, storm
    size, day length, lightning auto-targeting, lens UX).

## Suggested next steps (if the user's feedback doesn't redirect)

- Act on the user's new feedback first.
- Earthquake (event channel + structure system make it cheap), then
  drag-to-tornado (DECISIONS round 2).
- A second level / data-driven map format; the menu's progress already
  supports more levels.
- Water-on-slope rendering, and a rubble fall animation.
- Touch-specific controls pass (DECISIONS: may differ from PC).

## Process notes from session 1

- The user prefers being asked clarifying questions before big pivots, then
  autonomous work while they're away, with screenshots/GIFs sent as progress.
- Every change is explained in `docs/DEVLOG.md` in the same commit. Keep that up.
- Several bugs were only caught by measuring (probes, particle counts, stats).
  Visual inspection alone missed them. Measure.
