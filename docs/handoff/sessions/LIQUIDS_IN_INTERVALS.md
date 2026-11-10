# Handoff: one liquid model in the column intervals (water under bridges, lava, sand, magma)

Read `README.md` (rules) and `ADDENDUM.md` in this folder first.

## Why now (2026-11-10)
The city generator's bridge decks can't be claimed into the world's columns: the water model takes a column's top as its
floor, so a deck claimed over a river lifted the river onto the deck (BACKLOG CG15). Today riders ride decks as route
segments, but people on foot and physics can't use them. The user: "Yet another handoff unless it's easy. I know there
was an effort to make a liquid model that uses intervals for lava, flowing sand or magma etc."

## The design (DESIGN §7, agreed and decided 2026-11-05)
- Steady state is the default: rivers/lakes from the atlas at steady state, held water drawn from frozen flux, woken
  only by breaches, spells, dam breaks; the steady state is baked at page resolution from a rain quantity.
- "Water is part of the column model": liquid lies in a column's **gaps** (on top, in a cave, a tunnel, **under an
  overhang** — i.e. under a deck), stored as intervals in the layers or as runs in a parallel buffer.
- **Migrate to the flow model** (round 84): runs in any gap, momentum, arcing falls, **water and lava as two kinds of one
  kernel**; its steady state is what's baked; the pipes model is retired once the flow model bakes and holds the phone
  budget. Basin flood fill with water, sand, ash or magma; lava sets into basalt; sea level per basin.
- Rule: liquids talk to the world only through their contract (depth, level, flux per column gap).

## What to find first
BACKLOG DA-P5 ("Flow model the only liquid; rain-level bake; sea per basin"), DA-P6 (loose material in the flow model);
round 84's flow model and its branch; `lava.wgsl`; the river held table (`riverheld.wgsl`); round 112 meteorfix (magma
seas, per-page datum and basins); `terrain/basin.ts` (on trackA-season, reverted from fortress). Check what was built and
parked before writing anything new — the user is frustrated by lost work.

## First visible goal
A river under a claimed bridge deck in a field town (`?citygen=fields`, Muru): water flows in the gap under the deck,
people walk the deck, the reach counts it. Then lava and sand through the same kernel in a lab scene. Phone bench.
