# Handoff — 2026-10-07 (end of session 1)

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
